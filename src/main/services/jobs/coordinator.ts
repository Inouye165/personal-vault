import { promises as fs } from 'node:fs'
import {
  type CatalogDatabase,
  type ScanJobRecord,
  type ScanJobStatus,
  type ScanJobPhase,
  type DiscoveryCandidateInput,
  getEffectiveRoots,
  MAX_BATCH_SIZE
} from '../catalog'
import { scanSourceRoots } from '../discovery'
import { hashFile } from '../hashing'
import type { HashCandidateExpectation } from '../hashing/types'
import type { ReadOnlyFsAdapter } from '../discovery/fs-adapter'
import type { ReadOnlyHashingFsAdapter } from '../hashing/fs-adapter'
import { ScanJobConflictError, ScanJobInvalidStateError, ScanJobNotFoundError } from './errors'
import type {
  ScanJobCoordinatorOptions,
  ScanJobProgress,
  ScanJobProgressCallback,
  ScanJobStructuredError,
  StartScanOptions
} from './types'

const MAX_RETAINED_ERRORS = 50

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function validateBatchSize(size: number | undefined): number {
  if (size === undefined) return 100
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_BATCH_SIZE) {
    throw new RangeError(
      `batchSize must be a positive safe integer between 1 and ${MAX_BATCH_SIZE}, got ${size}`
    )
  }
  return size
}

interface ActiveJobState {
  readonly jobId: number
  readonly roots: readonly string[]
  status: ScanJobStatus
  phase: ScanJobPhase
  discoveredCount: number
  hashedCount: number
  totalFilesToHash: number
  totalBytes: number
  hashedBytes: number
  skippedCount: number
  errorCount: number
  currentPath?: string
  errors: ScanJobStructuredError[]
  errorMessage?: string
  startedAtMs: number
  updatedAtMs: number
  completedAtMs: number | null
  abortController: AbortController
  pauseRequested: boolean
  completionPromise: Promise<ScanJobProgress>
  resolveCompletion: (progress: ScanJobProgress) => void
  rejectCompletion: (error: unknown) => void
}

export class ScanJobCoordinator {
  private readonly catalog: CatalogDatabase
  private readonly discoveryFsAdapter?: ReadOnlyFsAdapter
  private readonly hashingFsAdapter?: ReadOnlyHashingFsAdapter
  private readonly batchSize: number
  private readonly progressListeners = new Set<ScanJobProgressCallback>()
  private activeJob: ActiveJobState | null = null
  private isStarting = false

  constructor(options: ScanJobCoordinatorOptions) {
    this.catalog = options.catalog
    this.discoveryFsAdapter = options.discoveryFsAdapter
    this.hashingFsAdapter = options.hashingFsAdapter
    this.batchSize = validateBatchSize(options.batchSize)
  }

  public async initialize(): Promise<number> {
    const now = Date.now()
    return this.catalog.markRunningJobsAsInterrupted(now)
  }

  public onProgress(callback: ScanJobProgressCallback): () => void {
    this.progressListeners.add(callback)
    return () => {
      this.progressListeners.delete(callback)
    }
  }

  private notifyProgress(progress: ScanJobProgress): void {
    for (const listener of this.progressListeners) {
      try {
        listener(progress)
      } catch {
        // Suppress listener errors
      }
    }
  }

  public hasActiveJob(): boolean {
    if (this.isStarting) return true
    if (
      this.activeJob !== null &&
      (this.activeJob.status === 'running' || this.activeJob.status === 'paused')
    ) {
      return true
    }
    const dbJob = this.catalog.getActiveScanJob()
    return dbJob !== null && (dbJob.status === 'running' || dbJob.status === 'paused')
  }

  public getActiveJob(): ScanJobProgress | null {
    if (this.activeJob) {
      return this.toProgress(this.activeJob)
    }
    const dbJob = this.catalog.getActiveScanJob()
    if (!dbJob) return null
    return this.dbJobToProgress(dbJob)
  }

  public getLatestJob(options?: { unDismissedOnly?: boolean }): ScanJobProgress | null {
    if (this.activeJob) {
      return this.toProgress(this.activeJob)
    }
    const dbJob = this.catalog.getLatestScanJob(options)
    if (!dbJob) return null
    return this.dbJobToProgress(dbJob)
  }

  public dismissScanJob(jobId: number): void {
    this.catalog.dismissScanJob(jobId)
  }

  public async startScan(options: StartScanOptions): Promise<ScanJobProgress> {
    if (this.isStarting || this.hasActiveJob()) {
      throw new ScanJobConflictError('A scan job is already actively running or paused')
    }

    this.isStarting = true
    try {
      if (!Array.isArray(options.roots) || options.roots.length === 0) {
        throw new RangeError('options.roots must be a non-empty array of paths')
      }

      // Verify each root exists on disk
      for (const root of options.roots) {
        if (typeof root !== 'string' || root.trim() === '') {
          throw new TypeError('options.roots contains an invalid path entry')
        }
        const stat = await fs.stat(root)
        if (!stat.isDirectory()) {
          throw new Error(`Configured root path is not a directory: ${root}`)
        }
      }

      const now = Date.now()
      const jobRecord = this.catalog.createScanJob({ roots: options.roots, nowMs: now })

      return this.spawnJobExecution(jobRecord.id, options.roots, now)
    } finally {
      this.isStarting = false
    }
  }

  public async pauseScan(jobId: number): Promise<ScanJobProgress> {
    if (this.activeJob && this.activeJob.jobId === jobId) {
      if (this.activeJob.status === 'running') {
        this.activeJob.pauseRequested = true
        // Wait for active loop to acknowledge pause
        await Promise.race([
          this.activeJob.completionPromise,
          new Promise((resolve) => setTimeout(resolve, 2000))
        ])
      }
      if (this.activeJob && this.activeJob.jobId === jobId) {
        return this.toProgress(this.activeJob)
      }
      const job = this.catalog.getScanJob(jobId)
      if (job) return this.dbJobToProgress(job)
    }

    const job = this.catalog.getScanJob(jobId)
    if (!job) throw new ScanJobNotFoundError(jobId)
    if (job.status === 'paused' || job.status === 'completed' || job.status === 'cancelled') {
      return this.dbJobToProgress(job)
    }

    this.catalog.updateScanJobStatus(jobId, 'paused')
    const updated = this.catalog.getScanJob(jobId)!
    const progress = this.dbJobToProgress(updated)
    this.notifyProgress(progress)
    return progress
  }

  public async resumeScan(jobId: number): Promise<ScanJobProgress> {
    if (this.isStarting) {
      throw new ScanJobConflictError('Another scan job is currently starting')
    }

    if (this.activeJob !== null) {
      if (this.activeJob.jobId !== jobId || this.activeJob.status === 'running') {
        throw new ScanJobConflictError(
          'Cannot resume while another scan job is actively running or paused'
        )
      }
    } else {
      const activeDb = this.catalog.getActiveScanJob()
      if (
        activeDb !== null &&
        activeDb.id !== jobId &&
        (activeDb.status === 'running' || activeDb.status === 'paused')
      ) {
        throw new ScanJobConflictError(
          'Cannot resume while another scan job is actively running or paused'
        )
      }
    }

    const job = this.catalog.getScanJob(jobId)
    if (!job) throw new ScanJobNotFoundError(jobId)

    if (job.status !== 'paused' && job.status !== 'interrupted') {
      throw new ScanJobInvalidStateError(
        `Cannot resume scan job in status '${job.status}'. Only 'paused' or 'interrupted' jobs can be resumed.`
      )
    }

    const now = Date.now()
    this.catalog.updateScanJobStatus(jobId, 'running', { nowMs: now })
    return this.spawnJobExecution(jobId, job.roots, job.startedAtMs)
  }

  public async cancelScan(jobId: number): Promise<ScanJobProgress> {
    if (this.activeJob && this.activeJob.jobId === jobId) {
      const state = this.activeJob
      state.status = 'cancelled'
      state.abortController.abort()

      // Await active loop termination before clearing state and releasing ownership
      try {
        await state.completionPromise
      } catch {
        // Suppress
      }

      if (!this.catalog.isClosed()) {
        try {
          this.catalog.updateScanJobStatus(jobId, 'cancelled', { nowMs: Date.now() })
        } catch {
          // Suppress
        }
      }

      const progress = this.toProgress(state)
      this.notifyProgress(progress)
      if (this.activeJob?.jobId === jobId) {
        this.activeJob = null
      }
      return progress
    }

    const job = this.catalog.getScanJob(jobId)
    if (!job) throw new ScanJobNotFoundError(jobId)

    this.catalog.updateScanJobStatus(jobId, 'cancelled', { nowMs: Date.now() })
    const updated = this.catalog.getScanJob(jobId)!
    const progress = this.dbJobToProgress(updated)
    this.notifyProgress(progress)
    return progress
  }

  public async cancelActiveJob(): Promise<ScanJobProgress | null> {
    if (this.activeJob) {
      return this.cancelScan(this.activeJob.jobId)
    }
    return null
  }

  public async shutdown(): Promise<void> {
    if (this.activeJob && this.activeJob.status === 'running') {
      const state = this.activeJob
      state.status = 'interrupted'
      state.abortController.abort()

      try {
        await state.completionPromise
      } catch {
        // Suppress
      }

      if (!this.catalog.isClosed()) {
        try {
          this.catalog.updateScanJobStatus(state.jobId, 'interrupted', { nowMs: Date.now() })
        } catch {
          // Suppress
        }
      }

      if (this.activeJob?.jobId === state.jobId) {
        this.activeJob = null
      }
    } else if (this.activeJob && this.activeJob.status === 'paused') {
      if (this.activeJob?.jobId) {
        this.activeJob = null
      }
    }
  }

  public async waitForJob(jobId: number): Promise<ScanJobProgress> {
    if (this.activeJob && this.activeJob.jobId === jobId) {
      return this.activeJob.completionPromise
    }
    const dbJob = this.catalog.getScanJob(jobId)
    if (!dbJob) throw new ScanJobNotFoundError(jobId)
    return this.dbJobToProgress(dbJob)
  }

  private spawnJobExecution(
    jobId: number,
    roots: readonly string[],
    startedAtMs: number
  ): ScanJobProgress {
    let resolveFn!: (progress: ScanJobProgress) => void
    let rejectFn!: (error: unknown) => void
    const completionPromise = new Promise<ScanJobProgress>((resolve, reject) => {
      resolveFn = resolve
      rejectFn = reject
    })

    const abortController = new AbortController()

    // Load initial counts from DB
    const existing = this.catalog.getScanJob(jobId)
    const existingErrors = this.catalog
      .getScanJobErrors(jobId, { limit: MAX_RETAINED_ERRORS })
      .map((e) => ({
        path: e.path,
        code: e.code,
        message: e.message,
        phase: e.phase
      }))

    const state: ActiveJobState = {
      jobId,
      roots,
      status: 'running',
      phase: 'discovery',
      discoveredCount: existing?.discoveredCount ?? 0,
      hashedCount: existing?.hashedCount ?? 0,
      totalFilesToHash: existing?.totalFilesToHash ?? 0,
      totalBytes: existing?.totalBytes ?? 0,
      hashedBytes: existing?.hashedBytes ?? 0,
      skippedCount: existing?.skippedCount ?? 0,
      errorCount: existing?.errorCount ?? 0,
      errors: existingErrors,
      startedAtMs,
      updatedAtMs: Date.now(),
      completedAtMs: null,
      abortController,
      pauseRequested: false,
      completionPromise,
      resolveCompletion: resolveFn,
      rejectCompletion: rejectFn
    }

    this.activeJob = state
    const progress = this.toProgress(state)
    this.notifyProgress(progress)

    // Run execution loop asynchronously in background
    void this.executeJobLoop(state)

    return progress
  }

  private isCancelled(state: ActiveJobState): boolean {
    if (this.isInterrupted(state)) return false
    return state.abortController.signal.aborted || (state.status as string) === 'cancelled'
  }

  private isInterrupted(state: ActiveJobState): boolean {
    return (state.status as string) === 'interrupted'
  }

  private async executeJobLoop(state: ActiveJobState): Promise<void> {
    try {
      const pushError = (err: ScanJobStructuredError): void => {
        state.errorCount++
        if (state.errors.length >= MAX_RETAINED_ERRORS) {
          state.errors.shift()
        }
        state.errors.push(err)
        this.catalog.recordScanJobError(state.jobId, err)
      }

      // -----------------------------------------------------------
      // Phase 1: Discovery & Observation Revalidation
      // -----------------------------------------------------------
      state.phase = 'discovery'
      this.catalog.updateScanJobProgress(state.jobId, { phase: 'discovery' })
      this.notifyProgress(this.toProgress(state))

      // Clear any previously recorded scan job files for this job to support clean revalidation on resume/restart
      this.catalog.clearScanJobFiles(state.jobId)

      const candidateBatchesByRoot = new Map<string, DiscoveryCandidateInput[]>()
      let uncommittedCandidates = 0

      const commitCandidates = (): void => {
        for (const [sourceRoot, batch] of candidateBatchesByRoot) {
          if (batch.length > 0) {
            this.catalog.persistDiscoveryBatch(sourceRoot, batch, state.jobId)
            batch.length = 0
          }
        }
        uncommittedCandidates = 0
        const summary = this.catalog.countDiscoveredFilesForJob(state.jobId)
        state.discoveredCount = summary.count
        state.totalBytes = summary.totalBytes
        this.catalog.updateScanJobProgress(state.jobId, {
          discoveredCount: state.discoveredCount,
          totalBytes: state.totalBytes,
          skippedCount: state.skippedCount,
          errorCount: state.errorCount
        })
      }

      const effectiveRoots = getEffectiveRoots(state.roots)
      const discoveryGenerator = scanSourceRoots({
        roots: effectiveRoots,
        signal: state.abortController.signal,
        fsAdapter: this.discoveryFsAdapter
      })

      for await (const event of discoveryGenerator) {
        if (this.isInterrupted(state)) {
          commitCandidates()
          this.handleInterrupted(state)
          return
        }

        if (this.isCancelled(state)) {
          commitCandidates()
          this.handleCancelled(state)
          return
        }

        if (state.pauseRequested) {
          commitCandidates()
          this.handlePaused(state)
          return
        }

        if (event.kind === 'candidate') {
          state.currentPath = event.candidate.absolutePath

          let list = candidateBatchesByRoot.get(event.candidate.rootPath)
          if (!list) {
            list = []
            candidateBatchesByRoot.set(event.candidate.rootPath, list)
          }

          const birthtimeMs = event.candidate.filesystemCreatedAt
            ? Date.parse(event.candidate.filesystemCreatedAt)
            : null
          const mtimeMs = event.candidate.filesystemModifiedAt
            ? Date.parse(event.candidate.filesystemModifiedAt)
            : null

          list.push({
            originalPath: event.candidate.absolutePath,
            fileName: event.candidate.fileName,
            extension: event.candidate.extension,
            byteSize: event.candidate.byteSize,
            birthtimeMs,
            mtimeMs,
            discoveredAtMs: Date.now(),
            category: event.candidate.candidateKind,
            mediaKind: event.candidate.mediaKind,
            videoMetadata: event.candidate.videoMetadata
              ? {
                  containerFormat: event.candidate.videoMetadata.container,
                  videoCodec: event.candidate.videoMetadata.videoCodec,
                  audioCodec: event.candidate.videoMetadata.audioCodec,
                  durationMs: event.candidate.videoMetadata.durationMs,
                  widthPx: event.candidate.videoMetadata.widthPx,
                  heightPx: event.candidate.videoMetadata.heightPx,
                  isPlayableStructure: event.candidate.videoMetadata.isPlayableStructure,
                  structureError: event.candidate.videoMetadata.structureError,
                  inspectedAtMs: Date.now()
                }
              : null
          })
          uncommittedCandidates++

          if (uncommittedCandidates >= this.batchSize) {
            commitCandidates()
            state.updatedAtMs = Date.now()
            this.notifyProgress(this.toProgress(state))
            await yieldToEventLoop()
          }
        } else if (event.kind === 'skip') {
          state.skippedCount++
        } else if (event.kind === 'error') {
          pushError({
            path: event.error.path,
            code: event.error.code,
            message: event.error.message,
            phase: 'discovery'
          })
        }
      }

      commitCandidates()
      state.currentPath = undefined
      state.updatedAtMs = Date.now()
      this.notifyProgress(this.toProgress(state))

      if (this.isInterrupted(state)) {
        this.handleInterrupted(state)
        return
      }

      if (state.pauseRequested) {
        this.handlePaused(state)
        return
      }

      // -----------------------------------------------------------
      // Phase 2: Streaming SHA-256 Hashing of Unhashed Files
      // -----------------------------------------------------------
      state.phase = 'hashing'
      this.catalog.linkUnhashedFilesForRootsToJob(state.jobId, state.roots)
      const unhashedCounts = this.catalog.countUnhashedFilesForJob(state.jobId)
      const totalFilesInRoots = Math.max(state.discoveredCount, unhashedCounts.count)
      state.discoveredCount = totalFilesInRoots
      state.totalFilesToHash = totalFilesInRoots
      state.totalBytes = Math.max(state.totalBytes, unhashedCounts.totalBytes)
      state.hashedCount = Math.max(0, totalFilesInRoots - unhashedCounts.count)
      state.hashedBytes = Math.max(0, state.totalBytes - unhashedCounts.totalBytes)

      this.catalog.updateScanJobProgress(state.jobId, {
        phase: 'hashing',
        totalFilesToHash: state.totalFilesToHash,
        hashedCount: state.hashedCount,
        hashedBytes: state.hashedBytes
      })
      this.notifyProgress(this.toProgress(state))

      let lastSeenLocationId = 0
      while (true) {
        if (this.isInterrupted(state)) {
          this.handleInterrupted(state)
          return
        }

        if (this.isCancelled(state)) {
          this.handleCancelled(state)
          return
        }

        if (state.pauseRequested) {
          this.handlePaused(state)
          return
        }

        const unhashedBatch = this.catalog.getUnhashedFilesForJob(state.jobId, {
          limit: this.batchSize,
          afterId: lastSeenLocationId
        })

        if (unhashedBatch.length === 0) {
          break
        }

        for (const file of unhashedBatch) {
          lastSeenLocationId = file.fileLocationId

          if (this.isInterrupted(state)) {
            this.handleInterrupted(state)
            return
          }

          if (this.isCancelled(state)) {
            this.handleCancelled(state)
            return
          }

          if (state.pauseRequested) {
            this.handlePaused(state)
            return
          }

          state.currentPath = file.originalPath
          this.notifyProgress(this.toProgress(state))

          const expectation: HashCandidateExpectation = {
            byteSize: file.byteSize,
            ...(file.filesystemMtimeMs !== null ? { mtimeMs: file.filesystemMtimeMs } : {}),
            ...(file.filesystemBirthtimeMs !== null
              ? { birthtimeMs: file.filesystemBirthtimeMs }
              : {})
          }

          // Hash with retry behavior for transient errors
          let hashResult = await hashFile({
            filePath: file.originalPath,
            approvedRoots: state.roots,
            signal: state.abortController.signal,
            fsAdapter: this.hashingFsAdapter,
            expectation
          })

          if (hashResult.status === 'error' && !state.abortController.signal.aborted) {
            // Defined retry behavior: retry once for transient I/O
            await yieldToEventLoop()
            hashResult = await hashFile({
              filePath: file.originalPath,
              approvedRoots: state.roots,
              signal: state.abortController.signal,
              fsAdapter: this.hashingFsAdapter,
              expectation
            })
          }

          if (hashResult.status === 'success') {
            this.catalog.recordHashObservation({
              originalPath: file.originalPath,
              sha256: hashResult.sha256,
              observedByteSize: hashResult.byteSize,
              observedMtimeMs: hashResult.mtimeMs,
              hashedAtMs: Date.now()
            })
            state.hashedCount++
            state.hashedBytes += hashResult.byteSize
          } else if (hashResult.status === 'file_changed') {
            pushError({
              path: file.originalPath,
              code: 'file_changed',
              message: hashResult.message,
              phase: 'hashing'
            })
          } else if (hashResult.status === 'rejected' || hashResult.status === 'error') {
            const code = hashResult.status === 'rejected' ? hashResult.reason : hashResult.code
            pushError({
              path: file.originalPath,
              code,
              message: hashResult.message,
              phase: 'hashing'
            })
          }

          state.updatedAtMs = Date.now()
          this.catalog.updateScanJobProgress(state.jobId, {
            hashedCount: state.hashedCount,
            hashedBytes: state.hashedBytes,
            errorCount: state.errorCount
          })

          await yieldToEventLoop()
        }
      }

      // -----------------------------------------------------------
      // Phase 3: Completion
      // -----------------------------------------------------------
      state.status = 'completed'
      state.phase = 'completed'
      state.currentPath = undefined
      state.completedAtMs = Date.now()
      state.updatedAtMs = state.completedAtMs

      if (state.errorCount > 0) {
        state.errorMessage = `${state.errorCount} file(s) encountered errors during scan`
      }

      this.catalog.updateScanJobStatus(state.jobId, 'completed', {
        errorMessage: state.errorMessage,
        completedAtMs: state.completedAtMs,
        nowMs: state.completedAtMs
      })

      const finalProgress = this.toProgress(state)
      this.notifyProgress(finalProgress)
      state.resolveCompletion(finalProgress)
      if (this.activeJob?.jobId === state.jobId) {
        this.activeJob = null
      }
    } catch (error) {
      if (this.isInterrupted(state)) {
        this.handleInterrupted(state)
        return
      }
      if (this.isCancelled(state)) {
        this.handleCancelled(state)
        return
      }
      if (this.catalog.isClosed()) {
        state.status = 'interrupted'
        if (this.activeJob?.jobId === state.jobId) {
          this.activeJob = null
        }
        state.resolveCompletion(this.toProgress(state))
        return
      }
      state.status = 'failed'
      state.errorMessage = error instanceof Error ? error.message : String(error)
      state.updatedAtMs = Date.now()
      try {
        this.catalog.updateScanJobStatus(state.jobId, 'failed', {
          errorMessage: state.errorMessage,
          nowMs: state.updatedAtMs
        })
      } catch {
        // Suppress catalog write failure during error shutdown
      }
      const finalProgress = this.toProgress(state)
      this.notifyProgress(finalProgress)
      state.resolveCompletion(finalProgress)
      if (this.activeJob?.jobId === state.jobId) {
        this.activeJob = null
      }
    }
  }

  private handlePaused(state: ActiveJobState): void {
    state.status = 'paused'
    state.currentPath = undefined
    state.updatedAtMs = Date.now()
    if (!this.catalog.isClosed()) {
      try {
        this.catalog.updateScanJobStatus(state.jobId, 'paused', { nowMs: state.updatedAtMs })
      } catch {
        // Suppress catalog error on paused status update
      }
    }
    const progress = this.toProgress(state)
    this.notifyProgress(progress)
    state.resolveCompletion(progress)
    if (this.activeJob?.jobId === state.jobId) {
      this.activeJob = null
    }
  }

  private handleInterrupted(state: ActiveJobState): void {
    state.status = 'interrupted'
    state.currentPath = undefined
    state.updatedAtMs = Date.now()
    if (!this.catalog.isClosed()) {
      try {
        this.catalog.updateScanJobStatus(state.jobId, 'interrupted', { nowMs: state.updatedAtMs })
      } catch {
        // Suppress catalog error on interrupted status update
      }
    }
    const progress = this.toProgress(state)
    this.notifyProgress(progress)
    state.resolveCompletion(progress)
    if (this.activeJob?.jobId === state.jobId) {
      this.activeJob = null
    }
  }

  private handleCancelled(state: ActiveJobState): void {
    state.status = 'cancelled'
    state.currentPath = undefined
    state.updatedAtMs = Date.now()
    if (!this.catalog.isClosed()) {
      try {
        this.catalog.updateScanJobStatus(state.jobId, 'cancelled', { nowMs: state.updatedAtMs })
      } catch {
        // Suppress catalog error on cancelled status update
      }
    }
    const progress = this.toProgress(state)
    this.notifyProgress(progress)
    state.resolveCompletion(progress)
    if (this.activeJob?.jobId === state.jobId) {
      this.activeJob = null
    }
  }

  private toProgress(state: ActiveJobState): ScanJobProgress {
    return {
      jobId: state.jobId,
      status: state.status,
      phase: state.phase,
      roots: state.roots,
      discoveredCount: state.discoveredCount,
      hashedCount: state.hashedCount,
      totalFilesToHash: state.totalFilesToHash,
      totalBytes: state.totalBytes,
      hashedBytes: state.hashedBytes,
      skippedCount: state.skippedCount,
      errorCount: state.errorCount,
      currentPath: state.currentPath,
      errors: state.errors.slice(-MAX_RETAINED_ERRORS),
      errorMessage: state.errorMessage,
      startedAtMs: state.startedAtMs,
      updatedAtMs: state.updatedAtMs,
      completedAtMs: state.completedAtMs
    }
  }

  private dbJobToProgress(job: ScanJobRecord): ScanJobProgress {
    const errors = this.catalog
      .getScanJobErrors(job.id, { limit: MAX_RETAINED_ERRORS })
      .map((e) => ({
        path: e.path,
        code: e.code,
        message: e.message,
        phase: e.phase
      }))
    return {
      jobId: job.id,
      status: job.status,
      phase: job.phase,
      roots: job.roots,
      discoveredCount: job.discoveredCount,
      hashedCount: job.hashedCount,
      totalFilesToHash: job.totalFilesToHash,
      totalBytes: job.totalBytes,
      hashedBytes: job.hashedBytes,
      skippedCount: job.skippedCount,
      errorCount: job.errorCount,
      errors,
      errorMessage: job.errorMessage ?? undefined,
      startedAtMs: job.startedAtMs,
      updatedAtMs: job.updatedAtMs,
      completedAtMs: job.completedAtMs
    }
  }
}
