/**
 * Personal Vault — Stage 7B Bounded Document Extraction Coordinator
 *
 * Orchestrates explicit, resumable, cancelable local text extraction for
 * cataloged documents inside a dedicated Node worker thread (<= 1 live worker),
 * enforcing source preservation, identity revalidation, stale-commit rejection,
 * and bounded preview caching.
 */

import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { CatalogDatabase } from '../catalog/database'
import type { DocumentPreviewPayload } from '../../../shared/validation/document-schemas'
import { resolveMainWorkerScriptPath } from '../worker-path'
import { AppWorkerBudget, type WorkerBudgetReservation } from '../worker-budget'
import {
  DOCUMENT_EXTRACTION_LIMITS,
  DOCUMENT_EXTRACTION_RECIPE_VERSION,
  type DocumentExtractionOptions,
  type DocumentExtractionProgress,
  type DocumentExtractionWorkerRequest,
  type DocumentExtractionWorkerResponse
} from './types'

export interface DocumentExtractionCoordinatorOptions {
  readonly catalog: CatalogDatabase
  readonly workerScriptPath?: string
  readonly workerTimeoutMs?: number
  readonly extractionOptions?: DocumentExtractionOptions
  readonly itemDelayMs?: number
  readonly batchSize?: number
  readonly maxAppLiveWorkers?: number
  readonly getExternalLiveWorkers?: () => number
  readonly tryReleaseExternalIdleWorker?: () => Promise<boolean>
  readonly workerBudget?: AppWorkerBudget
}

interface PendingWorkerRequest {
  readonly id: number
  readonly worker: Worker
  readonly resolve: (res: DocumentExtractionWorkerResponse) => void
  readonly reject: (err: unknown) => void
  readonly timer: NodeJS.Timeout
}

export class DocumentExtractionCoordinator {
  private readonly catalog: CatalogDatabase
  private readonly customWorkerScriptPath?: string
  private readonly workerTimeoutMs: number
  private readonly extractionOptions?: DocumentExtractionOptions
  private readonly itemDelayMs: number
  private readonly batchSize: number
  private readonly maxAppLiveWorkers: number
  private readonly getExternalLiveWorkers?: () => number
  private readonly tryReleaseExternalIdleWorker?: () => Promise<boolean>
  private readonly workerBudget: AppWorkerBudget

  private worker: Worker | null = null
  private snapshotWorker: Worker | null = null
  private terminatingWorkers = new Set<Worker>()
  private spawningWorkerPromise: Promise<Worker> | null = null
  private nextRequestId = 1
  private activeWorkerRequest: PendingWorkerRequest | null = null

  private activeJobId: string | null = null
  private activeJobForceReextract = false
  private activeFileLocationId: number | null = null
  private isStarting = false
  private pauseRequested = false
  private cancelRequested = false
  private isShutdown = false
  private startPromise: Promise<DocumentExtractionProgress> | null = null
  private loopPromise: Promise<DocumentExtractionProgress> | null = null
  private listeners = new Set<(progress: DocumentExtractionProgress) => void>()

  private readonly previewCache = new Map<string, DocumentPreviewPayload>()

  public constructor(options: DocumentExtractionCoordinatorOptions) {
    this.catalog = options.catalog
    this.customWorkerScriptPath = options.workerScriptPath
    this.workerTimeoutMs = options.workerTimeoutMs ?? DOCUMENT_EXTRACTION_LIMITS.WORKER_TIMEOUT_MS
    this.extractionOptions = options.extractionOptions
    const envDelay = Number(process.env.PV_TEST_DOC_EXTRACTION_DELAY_MS ?? '0')
    this.itemDelayMs =
      options.itemDelayMs ?? (Number.isFinite(envDelay) && envDelay > 0 ? Math.floor(envDelay) : 0)
    this.batchSize = Math.max(
      1,
      Math.min(32, Math.floor(options.batchSize ?? DOCUMENT_EXTRACTION_LIMITS.JOB_FETCH_BATCH_SIZE))
    )
    this.maxAppLiveWorkers = Math.max(1, options.maxAppLiveWorkers ?? 3)
    this.getExternalLiveWorkers = options.getExternalLiveWorkers
    this.tryReleaseExternalIdleWorker = options.tryReleaseExternalIdleWorker
    this.workerBudget = options.workerBudget ?? new AppWorkerBudget(this.maxAppLiveWorkers)
  }

  public initialize(): DocumentExtractionProgress {
    const repo = this.catalog.getDocumentRepository()
    repo.markRunningDocumentExtractionJobsAsInterrupted()
    return this.getProgress()
  }

  public onProgress(listener: (progress: DocumentExtractionProgress) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emitProgress(): void {
    if (this.catalog.isClosed()) return
    const snapshot = this.getProgress()
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch {
        // Ignore listener error
      }
    }
  }

  public getProcessingFileLocationIds(): ReadonlySet<number> {
    if (this.activeFileLocationId === null) {
      return new Set<number>()
    }
    return new Set<number>([this.activeFileLocationId])
  }

  public getDiagnostics(): {
    activeWorkers: number
    liveWorkers: number
    terminatingWorkers: number
    activeJobId: string | null
    activeFileLocationId: number | null
  } {
    const active = (this.worker ? 1 : 0) + (this.snapshotWorker ? 1 : 0)
    return {
      activeWorkers: active,
      liveWorkers: active + this.terminatingWorkers.size,
      terminatingWorkers: this.terminatingWorkers.size,
      activeJobId: this.activeJobId,
      activeFileLocationId: this.activeFileLocationId
    }
  }

  public getPreview(fileLocationId: number): DocumentPreviewPayload | null {
    const repo = this.catalog.getDocumentRepository()
    const fresh = repo.getDocumentPreview(fileLocationId, {
      processingFileLocationIds: this.getProcessingFileLocationIds(),
      recipeVersion: DOCUMENT_EXTRACTION_RECIPE_VERSION
    })
    if (!fresh) {
      this.invalidatePreviewCacheForFile(fileLocationId)
      return null
    }
    if (fresh.previewStatus !== 'ready' && fresh.previewStatus !== 'truncated') {
      return fresh
    }
    const cacheKey = `${fileLocationId}:${fresh.contentRevision ?? 'none'}:${fresh.recipeVersion ?? 'none'}`
    const cached = this.previewCache.get(cacheKey)
    if (cached) {
      this.previewCache.delete(cacheKey)
      this.previewCache.set(cacheKey, cached)
      return cached
    }
    this.setPreviewCache(cacheKey, fresh)
    return fresh
  }

  private setPreviewCache(key: string, value: DocumentPreviewPayload): void {
    if (this.previewCache.has(key)) {
      this.previewCache.delete(key)
    } else if (this.previewCache.size >= DOCUMENT_EXTRACTION_LIMITS.PREVIEW_CACHE_MAX_ENTRIES) {
      const oldest = this.previewCache.keys().next().value
      if (oldest !== undefined) {
        this.previewCache.delete(oldest)
      }
    }
    this.previewCache.set(key, value)
  }

  private invalidatePreviewCacheForFile(fileLocationId: number): void {
    const prefix = `${fileLocationId}:`
    for (const key of this.previewCache.keys()) {
      if (key.startsWith(prefix)) {
        this.previewCache.delete(key)
      }
    }
  }

  public getProgress(): DocumentExtractionProgress {
    const repo = this.catalog.getDocumentRepository()
    const coverage = repo.getDocumentExtractionCoverage(DOCUMENT_EXTRACTION_RECIPE_VERSION)
    const job = this.activeJobId
      ? repo.getDocumentExtractionJob(this.activeJobId)
      : repo.getLatestDocumentExtractionJob()

    if (!job) {
      return {
        jobId: null,
        status: 'idle',
        scopeKind: null,
        recipeVersion: DOCUMENT_EXTRACTION_RECIPE_VERSION,
        totalDocuments: 0,
        processedDocuments: 0,
        extractedDocuments: 0,
        noTextDocuments: 0,
        passwordProtectedDocuments: 0,
        unsupportedDocuments: 0,
        failedDocuments: 0,
        truncatedDocuments: 0,
        reusedDocuments: 0,
        pendingDocuments: 0,
        activeFileLocationId: null,
        startedAtMs: null,
        updatedAtMs: null,
        completedAtMs: null,
        lastError: null,
        coverage
      }
    }

    return {
      jobId: job.id,
      status: job.status,
      scopeKind: job.scopeKind,
      recipeVersion: job.recipeVersion,
      totalDocuments: job.totalDocuments,
      processedDocuments: job.processedDocuments,
      extractedDocuments: job.extractedDocuments,
      noTextDocuments: job.noTextDocuments,
      passwordProtectedDocuments: job.passwordProtectedDocuments,
      unsupportedDocuments: job.unsupportedDocuments,
      failedDocuments: job.failedDocuments,
      truncatedDocuments: job.truncatedDocuments,
      reusedDocuments: job.reusedDocuments,
      pendingDocuments: job.pendingDocuments,
      activeFileLocationId: this.activeFileLocationId,
      startedAtMs: job.startedAtMs,
      updatedAtMs: job.updatedAtMs,
      completedAtMs: job.completedAtMs,
      lastError: job.lastError,
      coverage
    }
  }

  public extractSelected(input: {
    fileLocationIds: readonly number[]
    forceReextract?: boolean
  }): Promise<DocumentExtractionProgress> {
    if (this.isShutdown) {
      return Promise.reject(new Error('Document extraction coordinator is shut down'))
    }
    if (this.isStarting || this.startPromise || (this.activeJobId && this.loopPromise)) {
      return Promise.resolve(this.getProgress())
    }

    this.isStarting = true
    this.cancelRequested = false
    this.pauseRequested = false
    let startOp: Promise<DocumentExtractionProgress> | null = null
    startOp = (async () => {
      try {
        const repo = this.catalog.getDocumentRepository()
        const jobId = `doc-ext-${randomUUID()}`
        const job = await repo.createDocumentExtractionJob({
          jobId,
          scopeKind: 'selected',
          recipeVersion: DOCUMENT_EXTRACTION_RECIPE_VERSION,
          fileLocationIds: input.fileLocationIds,
          forceReextract: input.forceReextract === true,
          shouldCancel: () => this.cancelRequested || this.isShutdown || this.catalog.isClosed(),
          awaitWorkerAdmission: () => this.waitForWorkerAdmission(),
          snapshotWorkerHooks: this.createSnapshotWorkerHooks()
        })

        if (this.cancelRequested || this.isShutdown || this.catalog.isClosed()) {
          if (job.status === 'running' && !this.catalog.isClosed()) {
            repo.updateDocumentExtractionJobStatus(job.id, 'cancelled')
          }
          this.emitProgress()
          return this.getProgress()
        }

        if (this.pauseRequested && job.status === 'running') {
          repo.updateDocumentExtractionJobStatus(job.id, 'paused')
          this.emitProgress()
          return this.getProgress()
        }

        if (job.status === 'running') {
          this.launchJobLoop(job.id, input.forceReextract === true)
        }
        this.emitProgress()
        return this.getProgress()
      } finally {
        this.isStarting = false
        if (this.startPromise === startOp) {
          this.startPromise = null
        }
      }
    })()

    this.startPromise = startOp
    return startOp
  }

  public startExtraction(input?: {
    scope?: 'all' | 'filtered'
    extensionFilter?: string | null
    filenameQuery?: string
    retryFailed?: boolean
  }): Promise<DocumentExtractionProgress> {
    if (this.isShutdown) {
      return Promise.reject(new Error('Document extraction coordinator is shut down'))
    }
    if (this.isStarting || this.startPromise || (this.activeJobId && this.loopPromise)) {
      return Promise.resolve(this.getProgress())
    }

    this.isStarting = true
    this.cancelRequested = false
    this.pauseRequested = false
    let startOp: Promise<DocumentExtractionProgress> | null = null
    startOp = (async () => {
      try {
        const repo = this.catalog.getDocumentRepository()
        const jobId = `doc-ext-${randomUUID()}`
        const scopeKind = input?.scope ?? 'all'
        const job = await repo.createDocumentExtractionJob({
          jobId,
          scopeKind,
          recipeVersion: DOCUMENT_EXTRACTION_RECIPE_VERSION,
          extensionFilter: input?.extensionFilter,
          filenameQuery: input?.filenameQuery,
          retryFailed: input?.retryFailed,
          shouldCancel: () => this.cancelRequested || this.isShutdown || this.catalog.isClosed(),
          awaitWorkerAdmission: () => this.waitForWorkerAdmission(),
          snapshotWorkerHooks: this.createSnapshotWorkerHooks()
        })

        if (this.cancelRequested || this.isShutdown || this.catalog.isClosed()) {
          if (job.status === 'running' && !this.catalog.isClosed()) {
            repo.updateDocumentExtractionJobStatus(job.id, 'cancelled')
          }
          this.emitProgress()
          return this.getProgress()
        }

        if (this.pauseRequested && job.status === 'running') {
          repo.updateDocumentExtractionJobStatus(job.id, 'paused')
          this.emitProgress()
          return this.getProgress()
        }

        if (job.status === 'running') {
          this.launchJobLoop(job.id, false)
        }
        this.emitProgress()
        return this.getProgress()
      } finally {
        this.isStarting = false
        if (this.startPromise === startOp) {
          this.startPromise = null
        }
      }
    })()

    this.startPromise = startOp
    return startOp
  }

  public pauseExtraction(): DocumentExtractionProgress {
    if (this.isStarting || this.startPromise) {
      this.pauseRequested = true
      return this.getProgress()
    }
    if (!this.activeJobId || !this.loopPromise) {
      return this.getProgress()
    }
    this.pauseRequested = true
    return this.getProgress()
  }

  public resumeExtraction(): DocumentExtractionProgress {
    if (this.isShutdown) {
      throw new Error('Document extraction coordinator is shut down')
    }
    if (this.isStarting || (this.activeJobId && this.loopPromise)) {
      return this.getProgress()
    }

    this.isStarting = true
    try {
      const repo = this.catalog.getDocumentRepository()
      const latest = repo.getLatestDocumentExtractionJob()
      if (!latest || (latest.status !== 'paused' && latest.status !== 'interrupted')) {
        return this.getProgress()
      }

      if (latest.pendingDocuments === 0) {
        repo.updateDocumentExtractionJobStatus(latest.id, 'completed')
        this.emitProgress()
        return this.getProgress()
      }

      repo.updateDocumentExtractionJobStatus(latest.id, 'running')
      this.launchJobLoop(latest.id)
      this.emitProgress()
      return this.getProgress()
    } finally {
      this.isStarting = false
    }
  }

  public async cancelExtraction(): Promise<DocumentExtractionProgress> {
    this.cancelRequested = true
    if (this.startPromise) {
      try {
        await this.startPromise
      } catch {
        // Ignore start failure on cancel
      }
    }

    if (!this.activeJobId || !this.loopPromise) {
      const repo = this.catalog.getDocumentRepository()
      const latest = repo.getLatestDocumentExtractionJob()
      if (latest && (latest.status === 'paused' || latest.status === 'interrupted')) {
        repo.updateDocumentExtractionJobStatus(latest.id, 'cancelled')
        this.emitProgress()
      }
      return this.getProgress()
    }

    await this.terminateActiveWorker('Extraction cancelled by user')
    try {
      await this.loopPromise
    } catch {
      // Loop handles cancellation cleanly
    }
    return this.getProgress()
  }

  public async waitForIdle(): Promise<void> {
    if (this.startPromise) {
      try {
        await this.startPromise
      } catch {
        // Propagate or settle after startPromise completes
      }
    }
    if (this.loopPromise) {
      await this.loopPromise
    }
  }

  public async shutdown(): Promise<void> {
    this.isShutdown = true
    this.cancelRequested = true
    if (this.startPromise) {
      try {
        await this.startPromise
      } catch {
        // Ignore on shutdown
      }
    }
    await this.terminateActiveWorker('Coordinator shutting down')
    if (this.loopPromise) {
      try {
        await this.loopPromise
      } catch {
        // Ignore on shutdown
      }
    }
    await Promise.all(
      Array.from(this.terminatingWorkers).map(
        (w) =>
          new Promise<void>((resolveExit) => {
            w.once('exit', () => resolveExit())
            setTimeout(resolveExit, 500)
          })
      )
    )
    this.previewCache.clear()
    this.listeners.clear()
  }

  private launchJobLoop(jobId: string, forceReextract = false): void {
    this.activeJobId = jobId
    this.activeJobForceReextract = forceReextract
    this.pauseRequested = false
    this.cancelRequested = false
    this.loopPromise = this.runJobLoop(jobId).finally(() => {
      this.activeFileLocationId = null
      this.activeJobId = null
      this.activeJobForceReextract = false
      this.loopPromise = null
      this.emitProgress()
    })
  }

  private async runJobLoop(jobId: string): Promise<DocumentExtractionProgress> {
    const repo = this.catalog.getDocumentRepository()
    const initialJob = repo.getDocumentExtractionJob(jobId)
    const forceReextract = initialJob?.forceReextract ?? this.activeJobForceReextract

    try {
      while (!this.cancelRequested && !this.pauseRequested && !this.isShutdown) {
        if (this.catalog.isClosed()) {
          break
        }
        const pending = repo.getNextPendingDocumentExtractionJobItems(jobId, this.batchSize)
        if (pending.length === 0) {
          repo.updateDocumentExtractionJobStatus(jobId, 'completed')
          break
        }

        for (const item of pending) {
          if (
            this.cancelRequested ||
            this.pauseRequested ||
            this.isShutdown ||
            this.catalog.isClosed()
          ) {
            break
          }

          const candidate = repo.getDocumentExtractionCandidate(item.fileLocationId)
          if (
            !candidate ||
            candidate.discoveryObservationId !== item.discoveryObservationId ||
            candidate.contentRevision !== item.contentRevision
          ) {
            repo.recordDocumentExtractionJobItemResult({
              jobId,
              fileLocationId: item.fileLocationId,
              status: 'skipped_stale',
              errorMessage: 'Catalog observation changed before extraction'
            })
            this.emitProgress()
            continue
          }

          this.activeFileLocationId = candidate.fileLocationId
          this.emitProgress()

          const approvedRoots = this.catalog
            .listSources({ offset: 0, limit: 1000 })
            .items.map((s) => s.rootPath)
          const effectiveRoots =
            approvedRoots.length > 0 ? approvedRoots : [candidate.sourceRootPath]

          const reusableCandidate =
            !forceReextract && candidate.activeHash !== null
              ? repo.findReusableDocumentExtraction(
                  candidate.activeHash,
                  DOCUMENT_EXTRACTION_RECIPE_VERSION,
                  candidate.extension
                )
              : null

          if (reusableCandidate && candidate.activeHash !== null) {
            const verifyRes = await this.runWorkerRequest({
              action: 'verify_source',
              sourcePath: candidate.originalPath,
              approvedRoots: effectiveRoots,
              extension: candidate.extension,
              expectedByteSize: candidate.byteSize,
              expectedMtimeMs: candidate.filesystemMtimeMs,
              expectedSha256: candidate.activeHash,
              options: this.extractionOptions,
              delayMs: this.itemDelayMs > 0 ? this.itemDelayMs : undefined
            })

            this.activeFileLocationId = null

            if (this.cancelRequested || this.isShutdown || this.catalog.isClosed()) {
              break
            }

            if (verifyRes.ok && verifyRes.observedSha256 === candidate.activeHash) {
              const commitRes = repo.upsertDocumentExtraction({
                fileLocationId: candidate.fileLocationId,
                expectedDiscoveryObservationId: candidate.discoveryObservationId,
                expectedContentRevision: candidate.contentRevision,
                contentSha256: verifyRes.observedSha256,
                observedByteSize: verifyRes.observedByteSize,
                observedMtimeMs: verifyRes.observedMtimeMs,
                recipeVersion: DOCUMENT_EXTRACTION_RECIPE_VERSION,
                extractionStatus: reusableCandidate.extractionStatus,
                statusDetail: reusableCandidate.statusDetail,
                extractedText: reusableCandidate.extractedText,
                extractedCharCount: reusableCandidate.extractedCharCount,
                pageCount: reusableCandidate.pageCount,
                ocrCandidatePageCount: reusableCandidate.ocrCandidatePageCount,
                truncated: reusableCandidate.truncated,
                truncationReason: reusableCandidate.truncationReason,
                detectedEncoding: reusableCandidate.detectedEncoding
              })
              this.invalidatePreviewCacheForFile(candidate.fileLocationId)
              repo.recordDocumentExtractionJobItemResult({
                jobId,
                fileLocationId: candidate.fileLocationId,
                status: commitRes.committed ? 'reused' : 'skipped_stale',
                errorMessage: commitRes.committed
                  ? null
                  : 'Catalog revision changed during extraction'
              })
              this.emitProgress()
              continue
            }

            if (!verifyRes.ok && verifyRes.errorCode === 'FILE_CHANGED') {
              repo.recordDocumentExtractionJobItemResult({
                jobId,
                fileLocationId: candidate.fileLocationId,
                status: 'skipped_stale',
                errorMessage: verifyRes.errorMessage
              })
              this.emitProgress()
              continue
            }
          }

          const workerRes = await this.runWorkerRequest({
            action: 'extract_document',
            sourcePath: candidate.originalPath,
            approvedRoots: effectiveRoots,
            extension: candidate.extension,
            expectedByteSize: candidate.byteSize,
            expectedMtimeMs: candidate.filesystemMtimeMs,
            expectedSha256: candidate.activeHash,
            options: this.extractionOptions,
            delayMs: this.itemDelayMs > 0 ? this.itemDelayMs : undefined
          })

          this.activeFileLocationId = null

          if (this.cancelRequested || this.isShutdown || this.catalog.isClosed()) {
            break
          }

          if (!workerRes.ok) {
            const isStale = workerRes.errorCode === 'FILE_CHANGED'
            if (isStale) {
              repo.recordDocumentExtractionJobItemResult({
                jobId,
                fileLocationId: candidate.fileLocationId,
                status: 'skipped_stale',
                errorMessage: workerRes.errorMessage
              })
            } else {
              const commitRes = repo.upsertDocumentExtraction({
                fileLocationId: candidate.fileLocationId,
                expectedDiscoveryObservationId: candidate.discoveryObservationId,
                expectedContentRevision: candidate.contentRevision,
                contentSha256: candidate.activeHash ?? '0'.repeat(64),
                observedByteSize: candidate.byteSize,
                observedMtimeMs: candidate.filesystemMtimeMs,
                recipeVersion: DOCUMENT_EXTRACTION_RECIPE_VERSION,
                extractionStatus: 'corrupt_or_failed',
                statusDetail: workerRes.errorMessage,
                extractedText: null,
                extractedCharCount: 0,
                pageCount: null,
                truncated: false,
                truncationReason: null,
                detectedEncoding: null
              })
              this.invalidatePreviewCacheForFile(candidate.fileLocationId)
              repo.recordDocumentExtractionJobItemResult({
                jobId,
                fileLocationId: candidate.fileLocationId,
                status: commitRes.committed ? 'corrupt_or_failed' : 'skipped_stale',
                errorMessage: workerRes.errorMessage
              })
            }
            this.emitProgress()
            continue
          }

          const commitRes = repo.upsertDocumentExtraction({
            fileLocationId: candidate.fileLocationId,
            expectedDiscoveryObservationId: candidate.discoveryObservationId,
            expectedContentRevision: candidate.contentRevision,
            contentSha256: workerRes.observedSha256,
            observedByteSize: workerRes.observedByteSize,
            observedMtimeMs: workerRes.observedMtimeMs,
            recipeVersion: workerRes.outcome.recipeVersion,
            extractionStatus: workerRes.outcome.status,
            statusDetail: workerRes.outcome.statusDetail,
            extractedText: workerRes.outcome.text,
            extractedCharCount: workerRes.outcome.extractedCharCount,
            pageCount: workerRes.outcome.pageCount,
            ocrCandidatePageCount: workerRes.outcome.ocrCandidatePageCount ?? null,
            truncated: workerRes.outcome.truncated,
            truncationReason: workerRes.outcome.truncationReason,
            detectedEncoding: workerRes.outcome.detectedEncoding
          })

          this.invalidatePreviewCacheForFile(candidate.fileLocationId)

          repo.recordDocumentExtractionJobItemResult({
            jobId,
            fileLocationId: candidate.fileLocationId,
            status: commitRes.committed ? workerRes.outcome.status : 'skipped_stale',
            errorMessage: commitRes.committed
              ? workerRes.outcome.status === 'corrupt_or_failed'
                ? workerRes.outcome.statusDetail
                : null
              : 'Catalog revision changed during extraction'
          })
          this.emitProgress()
        }
      }

      if (!this.catalog.isClosed()) {
        if (this.cancelRequested) {
          repo.updateDocumentExtractionJobStatus(jobId, 'cancelled')
        } else if (this.pauseRequested) {
          repo.updateDocumentExtractionJobStatus(jobId, 'paused')
        }
      }
    } catch (err: unknown) {
      if (!this.catalog.isClosed()) {
        const msg = err instanceof Error ? err.message : String(err)
        repo.updateDocumentExtractionJobStatus(jobId, 'failed', msg)
      }
    } finally {
      await this.terminateActiveWorker('Document extraction job idle cleanup')
    }

    return this.getProgress()
  }

  private createSnapshotWorkerHooks(): {
    onSpawn: (worker: Worker, reservation?: WorkerBudgetReservation) => void
    onSpawnFailure: (reservation: WorkerBudgetReservation) => void
    onTerminating: (worker: Worker) => void
    onExit: (worker: Worker) => void
  } {
    return {
      onSpawn: (worker, reservation) => {
        if (reservation) {
          this.workerBudget.promote(reservation, worker)
        }
        this.snapshotWorker = worker
      },
      onSpawnFailure: (reservation) => {
        this.workerBudget.releaseReservation(reservation)
      },
      onTerminating: (worker) => {
        if (this.snapshotWorker === worker) {
          this.snapshotWorker = null
        }
        this.terminatingWorkers.add(worker)
      },
      onExit: (worker) => {
        this.terminatingWorkers.delete(worker)
        if (this.snapshotWorker === worker) {
          this.snapshotWorker = null
        }
      }
    }
  }

  private async waitForWorkerAdmission(): Promise<WorkerBudgetReservation> {
    // Never release capacity merely because a termination wait timed out:
    // wait until every terminating worker actually emits 'exit'.
    while (this.terminatingWorkers.size >= DOCUMENT_EXTRACTION_LIMITS.MAX_WORKERS) {
      if (this.isShutdown) {
        throw new Error('Document extraction coordinator is shut down')
      }
      await Promise.all(
        Array.from(this.terminatingWorkers).map(
          (w) =>
            new Promise<void>((resolveExit) => {
              w.once('exit', () => resolveExit())
            })
        )
      )
    }

    const admissionDeadline = Date.now() + this.workerTimeoutMs
    let reservation: WorkerBudgetReservation | null = null
    while (reservation === null) {
      if (this.isShutdown || this.cancelRequested || this.pauseRequested) {
        throw new Error('Document extraction cancelled before worker admission')
      }
      reservation = this.workerBudget.tryReserve(this.getExternalLiveWorkers)
      if (reservation !== null) {
        return reservation
      }
      const released = await this.tryReleaseExternalIdleWorker?.()
      if (released) {
        reservation = this.workerBudget.tryReserve(this.getExternalLiveWorkers)
        if (reservation !== null) {
          return reservation
        }
      }
      if (Date.now() >= admissionDeadline) {
        throw new Error(
          `Application worker budget (${this.maxAppLiveWorkers} live workers) is exhausted`
        )
      }
      await new Promise((r) => setTimeout(r, 25))
    }
    return reservation
  }

  private async ensureWorker(): Promise<Worker> {
    if (this.worker) return this.worker
    if (this.spawningWorkerPromise) return this.spawningWorkerPromise

    this.spawningWorkerPromise = (async () => {
      const reservation = await this.waitForWorkerAdmission()

      let w: Worker
      let promoted = false
      try {
        if (this.isShutdown || this.cancelRequested || this.pauseRequested) {
          throw new Error('Document extraction cancelled before worker spawn')
        }
        const scriptPath = resolveMainWorkerScriptPath({
          workerFileName: 'document_worker.js',
          sourceEntryPath: resolve(__dirname, 'worker.ts'),
          customPath: this.customWorkerScriptPath,
          moduleDir: __dirname,
          esbuildExternals: ['electron', 'pdfjs-dist', 'fflate', 'fast-xml-parser']
        })
        if (this.isShutdown || this.cancelRequested || this.pauseRequested) {
          throw new Error('Document extraction cancelled before worker spawn')
        }
        w = new Worker(scriptPath)
        this.workerBudget.promote(reservation, w)
        promoted = true
      } finally {
        if (!promoted) {
          this.workerBudget.releaseReservation(reservation)
        }
      }
      w.on('message', (res: DocumentExtractionWorkerResponse) => {
        const active = this.activeWorkerRequest
        if (active && active.worker === w && active.id === res.id) {
          clearTimeout(active.timer)
          this.activeWorkerRequest = null
          active.resolve(res)
        }
      })
      w.on('error', (err) => {
        if (this.worker === w) {
          this.worker = null
          this.terminatingWorkers.add(w)
        }
        const active = this.activeWorkerRequest
        if (active && active.worker === w) {
          clearTimeout(active.timer)
          this.activeWorkerRequest = null
          active.resolve({
            id: active.id,
            ok: false,
            errorCode: 'WORKER_CRASHED',
            errorMessage: err instanceof Error ? err.message : String(err)
          })
        }
      })
      w.on('exit', () => {
        this.terminatingWorkers.delete(w)
        if (this.worker === w) {
          this.worker = null
        }
        const active = this.activeWorkerRequest
        if (active && active.worker === w) {
          clearTimeout(active.timer)
          this.activeWorkerRequest = null
          active.resolve({
            id: active.id,
            ok: false,
            errorCode: 'WORKER_EXITED',
            errorMessage: 'Document extraction worker exited unexpectedly'
          })
        }
      })

      this.worker = w
      return w
    })().finally(() => {
      this.spawningWorkerPromise = null
    })

    return this.spawningWorkerPromise
  }

  private async terminateActiveWorker(reason: string): Promise<void> {
    const w = this.worker
    const active = this.activeWorkerRequest
    if (active && (!w || active.worker === w)) {
      clearTimeout(active.timer)
      this.activeWorkerRequest = null
      active.resolve({
        id: active.id,
        ok: false,
        errorCode: 'CANCELLED',
        errorMessage: reason
      })
    }

    if (w) {
      this.worker = null
      this.terminatingWorkers.add(w)
      try {
        await w.terminate()
      } catch {
        // Retain w in terminatingWorkers until actual 'exit' event confirms exit
      }
    }
  }

  private async runWorkerRequest(
    reqWithoutId: Omit<DocumentExtractionWorkerRequest, 'id'>
  ): Promise<DocumentExtractionWorkerResponse> {
    const worker = await this.ensureWorker()
    const id = this.nextRequestId++

    return new Promise<DocumentExtractionWorkerResponse>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        if (this.activeWorkerRequest?.id === id && this.activeWorkerRequest.worker === worker) {
          this.activeWorkerRequest = null
          void this.terminateActiveWorker(
            `Document extraction timed out after ${this.workerTimeoutMs}ms`
          )
          resolvePromise({
            id,
            ok: false,
            errorCode: 'TIMEOUT',
            errorMessage: `Document extraction timed out after ${this.workerTimeoutMs}ms`
          })
        }
      }, this.workerTimeoutMs)

      this.activeWorkerRequest = {
        id,
        worker,
        resolve: resolvePromise,
        reject: rejectPromise,
        timer
      }

      worker.postMessage({
        id,
        ...reqWithoutId
      } satisfies DocumentExtractionWorkerRequest)
    })
  }
}
