import { statSync } from 'node:fs'
import type { CatalogDatabase } from '../catalog/database'
import { resolveReadableFileLocation } from '../backup/recovered-file-resolver'
import type { SemanticIndexJobRecord } from '../catalog/types'
import type { ThumbnailCoordinator } from '../thumbnails/coordinator'
import type { SemanticModelManager } from './model-manager'
import type { SemanticIndexProgress, SemanticIndexJobItemRecord } from './types'
import { SEMANTIC_EMBEDDING_DIMENSIONS } from './manifest'

export type CustomEmbedSourceTaskResult =
  | {
      readonly ok: true
      readonly sha256: string
      readonly observedByteSize: number
      readonly observedMtimeMs: number
      readonly width: number
      readonly height: number
      readonly vector: Float32Array
    }
  | {
      readonly ok: false
      readonly category: 'unsupported' | 'error'
      readonly errorCode: string
      readonly errorMessage: string
    }

export type CustomEmbedSourceTask = (
  params: {
    fileLocationId: number
    sourcePath: string
    expectedByteSize: number
    expectedMtimeMs: number
    modelInstallDir: string
  },
  signal?: AbortSignal
) => Promise<CustomEmbedSourceTaskResult>

export interface SemanticIndexCoordinatorOptions {
  readonly catalog: CatalogDatabase
  readonly modelManager: SemanticModelManager
  readonly thumbnailCoordinator: ThumbnailCoordinator
  readonly embedSourceTask?: CustomEmbedSourceTask
  readonly batchSize?: number
}

const DEFAULT_BATCH_SIZE = 16

export class SemanticIndexCoordinator {
  private readonly catalog: CatalogDatabase
  private readonly modelManager: SemanticModelManager
  private readonly thumbnailCoordinator: ThumbnailCoordinator
  private readonly embedSourceTask?: CustomEmbedSourceTask
  private readonly batchSize: number

  private activeJobId: string | null = null
  private isStarting = false
  private abortController: AbortController | null = null
  private pauseRequested = false
  private cancelRequested = false
  private isShutdown = false
  private loopPromise: Promise<SemanticIndexProgress> | null = null
  private listeners = new Set<(progress: SemanticIndexProgress) => void>()

  constructor(options: SemanticIndexCoordinatorOptions) {
    this.catalog = options.catalog
    this.modelManager = options.modelManager
    this.thumbnailCoordinator = options.thumbnailCoordinator
    this.embedSourceTask = options.embedSourceTask
    this.batchSize = Math.max(1, Math.min(32, options.batchSize ?? DEFAULT_BATCH_SIZE))
  }

  public initialize(): SemanticIndexProgress {
    this.catalog.markRunningSemanticIndexJobsAsInterrupted()
    return this.getStatus()
  }

  public onProgress(listener: (progress: SemanticIndexProgress) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emitProgress(): void {
    const snapshot = this.getStatus()
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch {
        // ignore listener errors
      }
    }
  }

  public getStatus(): SemanticIndexProgress {
    const modelStatus = this.modelManager.getStatus()
    const coverage = this.catalog.getSemanticIndexCoverage({
      modelId: modelStatus.modelId,
      modelCommit: modelStatus.modelCommit,
      modelManifestSha256: modelStatus.modelManifestSha256,
      preprocessingVersion: modelStatus.preprocessingVersion
    })

    const job: SemanticIndexJobRecord | null = this.activeJobId
      ? this.catalog.getSemanticIndexJob(this.activeJobId)
      : this.catalog.getLatestSemanticIndexJob()

    if (!job) {
      return {
        jobId: null,
        status: 'idle',
        modelId: modelStatus.modelId,
        modelCommit: modelStatus.modelCommit,
        preprocessingVersion: modelStatus.preprocessingVersion,
        totalPhotos: 0,
        processedPhotos: 0,
        reusedPhotos: 0,
        unsupportedPhotos: 0,
        failedPhotos: 0,
        pendingPhotos: 0,
        totalCatalogPhotos: coverage.totalCatalogPhotos,
        currentIndexedPhotos: coverage.currentIndexedPhotos,
        startedAtMs: null,
        updatedAtMs: null,
        completedAtMs: null,
        lastError: null
      }
    }

    return {
      jobId: job.id,
      status: job.status,
      modelId: job.modelId,
      modelCommit: job.modelCommit,
      preprocessingVersion: job.preprocessingVersion,
      totalPhotos: job.totalPhotos,
      processedPhotos: job.processedPhotos,
      reusedPhotos: job.reusedPhotos,
      unsupportedPhotos: job.unsupportedPhotos,
      failedPhotos: job.failedPhotos,
      pendingPhotos: job.pendingPhotos,
      totalCatalogPhotos: coverage.totalCatalogPhotos,
      currentIndexedPhotos: coverage.currentIndexedPhotos,
      startedAtMs: job.startedAtMs,
      updatedAtMs: job.updatedAtMs,
      completedAtMs: job.completedAtMs,
      lastError: job.lastError
    }
  }

  public async startIndexing(): Promise<SemanticIndexProgress> {
    if (this.isShutdown) {
      throw new Error('Semantic index coordinator is shut down')
    }

    if (this.isStarting || (this.activeJobId && this.loopPromise)) {
      return this.getStatus()
    }

    this.isStarting = true
    try {
      const revalidation = await this.modelManager.revalidateForLoading()
      if (!revalidation.ok) {
        throw new Error(
          revalidation.error ?? 'Semantic model is not installed or failed verification'
        )
      }

      if (this.activeJobId && this.loopPromise) {
        return this.getStatus()
      }

      const modelStatus = this.modelManager.getStatus()
      const job = this.catalog.createSemanticIndexJob({
        modelId: modelStatus.modelId,
        modelCommit: modelStatus.modelCommit,
        modelManifestSha256: modelStatus.modelManifestSha256,
        preprocessingVersion: modelStatus.preprocessingVersion
      })

      if (job.totalPhotos === 0 || job.status === 'completed') {
        this.activeJobId = null
        this.emitProgress()
        return this.getStatus()
      }

      this.activeJobId = job.id
      this.pauseRequested = false
      this.cancelRequested = false
      const controller = new AbortController()
      this.abortController = controller

      this.loopPromise = this.runJobLoop(job.id, controller.signal).finally(() => {
        if (this.activeJobId === job.id) {
          this.activeJobId = null
          this.abortController = null
          this.loopPromise = null
        }
      })

      this.emitProgress()
      return this.getStatus()
    } finally {
      this.isStarting = false
    }
  }

  public async pauseIndexing(): Promise<SemanticIndexProgress> {
    const jobId = this.activeJobId ?? this.catalog.getLatestSemanticIndexJob()?.id ?? null
    if (!jobId) {
      return this.getStatus()
    }

    const job = this.catalog.getSemanticIndexJob(jobId)
    if (!job || job.status !== 'running') {
      return this.getStatus()
    }

    this.pauseRequested = true
    this.catalog.updateSemanticIndexJobStatus(jobId, 'paused')
    this.emitProgress()

    if (this.loopPromise) {
      try {
        await this.loopPromise
      } catch {
        // ignore
      }
    }

    this.thumbnailCoordinator.releaseSemanticModelSession()
    this.emitProgress()
    return this.getStatus()
  }

  public async resumeIndexing(): Promise<SemanticIndexProgress> {
    if (this.isShutdown) {
      throw new Error('Semantic index coordinator is shut down')
    }

    if (this.isStarting || (this.activeJobId && this.loopPromise)) {
      return this.getStatus()
    }

    this.isStarting = true
    try {
      const latest = this.catalog.getLatestSemanticIndexJob()
      if (!latest || (latest.status !== 'paused' && latest.status !== 'interrupted')) {
        throw new Error('No paused or interrupted semantic index job to resume')
      }

      const revalidation = await this.modelManager.revalidateForLoading()
      if (!revalidation.ok) {
        throw new Error(
          revalidation.error ?? 'Semantic model is not installed or failed verification'
        )
      }

      const modelStatus = this.modelManager.getStatus()
      if (
        latest.modelId !== modelStatus.modelId ||
        latest.modelCommit !== modelStatus.modelCommit ||
        latest.modelManifestSha256.toLowerCase() !==
          modelStatus.modelManifestSha256.toLowerCase() ||
        latest.preprocessingVersion !== modelStatus.preprocessingVersion
      ) {
        this.catalog.updateSemanticIndexJobStatus(
          latest.id,
          'failed',
          'Active model or preprocessing recipe changed since job was created'
        )
        this.emitProgress()
        throw new Error('Cannot resume job created under a different model or recipe version')
      }

      this.catalog.updateSemanticIndexJobStatus(latest.id, 'running')
      this.activeJobId = latest.id
      this.pauseRequested = false
      this.cancelRequested = false
      const controller = new AbortController()
      this.abortController = controller

      this.loopPromise = this.runJobLoop(latest.id, controller.signal).finally(() => {
        if (this.activeJobId === latest.id) {
          this.activeJobId = null
          this.abortController = null
          this.loopPromise = null
        }
      })

      this.emitProgress()
      return this.getStatus()
    } finally {
      this.isStarting = false
    }
  }

  public async cancelIndexing(): Promise<SemanticIndexProgress> {
    const jobId = this.activeJobId ?? this.catalog.getLatestSemanticIndexJob()?.id ?? null
    if (!jobId) {
      return this.getStatus()
    }

    const job = this.catalog.getSemanticIndexJob(jobId)
    if (
      !job ||
      (job.status !== 'running' && job.status !== 'paused' && job.status !== 'interrupted')
    ) {
      return this.getStatus()
    }

    this.cancelRequested = true
    if (this.abortController) {
      this.abortController.abort()
    }

    await this.thumbnailCoordinator.cancelSemanticRequests()
    this.catalog.updateSemanticIndexJobStatus(jobId, 'cancelled')

    if (this.loopPromise) {
      try {
        await this.loopPromise
      } catch {
        // ignore
      }
    }

    this.thumbnailCoordinator.releaseSemanticModelSession()
    this.emitProgress()
    return this.getStatus()
  }

  public async waitForCompletion(): Promise<SemanticIndexProgress> {
    if (this.loopPromise) {
      return await this.loopPromise
    }
    return this.getStatus()
  }

  public listJobItems(options: {
    jobId?: string | null
    status?: SemanticIndexJobItemRecord['status']
    page?: number
    pageSize?: number
  }): {
    jobId: string | null
    items: SemanticIndexJobItemRecord[]
    totalCount: number
    page: number
    pageSize: number
  } {
    const page = Math.max(1, Math.floor(options.page ?? 1))
    const pageSize = Math.max(1, Math.min(200, Math.floor(options.pageSize ?? 50)))
    const offset = (page - 1) * pageSize
    const targetJobId =
      options.jobId ?? this.activeJobId ?? this.catalog.getLatestSemanticIndexJob()?.id ?? null

    if (!targetJobId) {
      return {
        jobId: null,
        items: [],
        totalCount: 0,
        page,
        pageSize
      }
    }

    const res = this.catalog.listSemanticIndexJobItems({
      jobId: targetJobId,
      status: options.status,
      limit: pageSize,
      offset
    })

    return {
      jobId: targetJobId,
      items: res.items,
      totalCount: res.totalCount,
      page,
      pageSize
    }
  }

  public async shutdown(): Promise<void> {
    this.isShutdown = true
    this.pauseRequested = true
    if (this.abortController) {
      this.abortController.abort()
    }
    await this.thumbnailCoordinator.cancelSemanticRequests()
    if (this.loopPromise) {
      try {
        await this.loopPromise
      } catch {
        // ignore
      }
    }
    this.thumbnailCoordinator.releaseSemanticModelSession()
  }

  private async runJobLoop(jobId: string, signal: AbortSignal): Promise<SemanticIndexProgress> {
    const crashAfterEnv = process.env.PV_SEMANTIC_CRASH_AFTER_PROCESSED
      ? Number(process.env.PV_SEMANTIC_CRASH_AFTER_PROCESSED)
      : 0
    const itemDelayMs = process.env.PV_SEMANTIC_ITEM_DELAY_MS
      ? Number(process.env.PV_SEMANTIC_ITEM_DELAY_MS)
      : 0

    try {
      while (!signal.aborted && !this.pauseRequested && !this.cancelRequested && !this.isShutdown) {
        const pendingBatch = this.catalog.getNextPendingSemanticIndexJobItems(jobId, this.batchSize)
        if (pendingBatch.length === 0) {
          break
        }

        for (const item of pendingBatch) {
          if (signal.aborted || this.pauseRequested || this.cancelRequested || this.isShutdown) {
            break
          }

          if (itemDelayMs > 0) {
            await new Promise((r) => setTimeout(r, itemDelayMs))
            if (signal.aborted || this.pauseRequested || this.cancelRequested || this.isShutdown) {
              break
            }
          }

          // Yield to high-priority interactive browsing thumbnail work
          while (
            this.thumbnailCoordinator.hasInteractiveWorkPending() &&
            !signal.aborted &&
            !this.pauseRequested &&
            !this.cancelRequested
          ) {
            await new Promise((r) => setTimeout(r, 15))
          }

          if (signal.aborted || this.pauseRequested || this.cancelRequested || this.isShutdown) {
            break
          }

          await this.processSingleJobItem(jobId, item, signal)
          this.emitProgress()

          if (crashAfterEnv > 0) {
            const currentJob = this.catalog.getSemanticIndexJob(jobId)
            if (currentJob && currentJob.processedPhotos >= crashAfterEnv) {
              process.exit(99)
            }
          }
        }
      }

      const latest = this.catalog.getSemanticIndexJob(jobId)
      if (latest) {
        if (this.cancelRequested) {
          this.catalog.updateSemanticIndexJobStatus(jobId, 'cancelled')
        } else if (this.pauseRequested) {
          this.catalog.updateSemanticIndexJobStatus(jobId, 'paused')
        } else if (!this.isShutdown && latest.pendingPhotos === 0 && latest.status === 'running') {
          this.catalog.updateSemanticIndexJobStatus(jobId, 'completed')
        }
      }
    } catch (err) {
      if (!this.cancelRequested && !this.pauseRequested && !this.isShutdown) {
        this.catalog.updateSemanticIndexJobStatus(
          jobId,
          'failed',
          err instanceof Error ? err.message : String(err)
        )
      }
    } finally {
      this.thumbnailCoordinator.releaseSemanticModelSession()
      this.emitProgress()
    }

    return this.getStatus()
  }

  private async processSingleJobItem(
    jobId: string,
    item: SemanticIndexJobItemRecord,
    signal: AbortSignal
  ): Promise<void> {
    const job = this.catalog.getSemanticIndexJob(jobId)
    if (!job || job.status !== 'running') {
      return
    }

    const modelInstallDir = this.modelManager.getActiveModelInstallDir()
    if (!modelInstallDir) {
      throw new Error('Semantic model installation is not ready')
    }

    // Check current catalog record for this file location
    const loc = this.catalog.getFileLocationById(item.fileLocationId)
    if (!loc) {
      this.catalog.recordSemanticIndexJobItemOutcome({
        jobId,
        itemId: item.id,
        status: 'failed',
        errorCode: 'LOCATION_MISSING',
        errorMessage: 'Catalog file location no longer exists'
      })
      return
    }

    // Verify the catalog observation hasn't shifted since the job snapshotted this item
    if (
      loc.discoveryObservationId !== item.discoveryObservationId ||
      loc.byteSize !== item.expectedByteSize ||
      (loc.filesystemMtimeMs !== null &&
        Math.abs(loc.filesystemMtimeMs - item.expectedMtimeMs) > 1.0)
    ) {
      this.catalog.recordSemanticIndexJobItemOutcome({
        jobId,
        itemId: item.id,
        status: 'failed',
        errorCode: 'SOURCE_REVISION_CHANGED',
        errorMessage: 'Catalog observation changed since job scope was snapshotted'
      })
      return
    }

    const resolved = resolveReadableFileLocation(this.catalog, item.fileLocationId, {
      verifyPayloadHash: Boolean(this.embedSourceTask)
    })
    if (!resolved.ok) {
      this.catalog.recordSemanticIndexJobItemOutcome({
        jobId,
        itemId: item.id,
        status: 'failed',
        errorCode: resolved.errorCode,
        errorMessage: resolved.errorMessage
      })
      return
    }

    // 1. Check if a reusable verified embedding exists (either for this location or a duplicate with identical hash).
    // Even when a catalog hash exists, we MUST verify the live source file on disk before reusing!
    const existingForLoc = this.catalog.getPhotoSemanticEmbedding(
      loc.id,
      job.modelId,
      job.preprocessingVersion
    )
    const candidateSha =
      existingForLoc &&
      existingForLoc.isCurrent &&
      existingForLoc.modelCommit === job.modelCommit &&
      existingForLoc.modelManifestSha256.toLowerCase() === job.modelManifestSha256.toLowerCase()
        ? existingForLoc.contentSha256
        : loc.activeHash

    if (candidateSha) {
      const reusable = this.catalog.findReusableSemanticEmbedding({
        contentSha256: candidateSha,
        observedByteSize: resolved.expectedByteSize,
        modelId: job.modelId,
        modelCommit: job.modelCommit,
        modelManifestSha256: job.modelManifestSha256,
        preprocessingVersion: job.preprocessingVersion
      })

      if (reusable) {
        const liveVerification = await this.thumbnailCoordinator.verifySourceFile({
          sourcePath: resolved.filePath,
          expectedByteSize: resolved.expectedByteSize,
          expectedMtimeMs: resolved.expectedMtimeMs,
          expectedSha256: reusable.contentSha256,
          approvedRootsOverride: resolved.approvedRoots
        })

        if (signal.aborted || this.pauseRequested || this.cancelRequested || this.isShutdown) {
          return
        }

        if (!liveVerification.ok) {
          this.catalog.recordSemanticIndexJobItemOutcome({
            jobId,
            itemId: item.id,
            status: liveVerification.category === 'unsupported' ? 'unsupported' : 'failed',
            errorCode: liveVerification.errorCode,
            errorMessage: liveVerification.errorMessage
          })
          return
        }

        if (
          liveVerification.sha256.toLowerCase() === reusable.contentSha256.toLowerCase() &&
          liveVerification.observedByteSize === reusable.observedByteSize
        ) {
          if (
            !this.verifyPreCommitLiveStat(
              resolved.filePath,
              liveVerification.observedByteSize,
              liveVerification.observedMtimeMs
            )
          ) {
            this.catalog.recordSemanticIndexJobItemOutcome({
              jobId,
              itemId: item.id,
              status: 'failed',
              errorCode: 'SOURCE_MODIFIED',
              errorMessage: 'Source file changed on disk before commit'
            })
            return
          }

          try {
            const observedMtimeForCommit =
              resolved.mode === 'vault_copy' && item.expectedMtimeMs !== null
                ? item.expectedMtimeMs
                : liveVerification.observedMtimeMs
            const revision = `semrev:${item.discoveryObservationId}:${liveVerification.observedByteSize}:${observedMtimeForCommit}:${liveVerification.sha256}`
            this.catalog.completeSemanticIndexJobItemWithEmbedding({
              jobId,
              itemId: item.id,
              reused: true,
              embedding: {
                fileId: loc.id,
                fileLocationId: loc.id,
                discoveryObservationId: item.discoveryObservationId,
                contentSha256: liveVerification.sha256,
                contentRevision: revision,
                sourcePath: item.originalPath,
                observedByteSize: liveVerification.observedByteSize,
                observedMtimeMs: observedMtimeForCommit,
                modelId: job.modelId,
                modelCommit: job.modelCommit,
                modelManifestSha256: job.modelManifestSha256,
                preprocessingVersion: job.preprocessingVersion,
                embeddingDimensions: SEMANTIC_EMBEDDING_DIMENSIONS,
                vector: reusable.vector,
                width: reusable.width,
                height: reusable.height
              }
            })
          } catch (commitErr) {
            this.catalog.recordSemanticIndexJobItemOutcome({
              jobId,
              itemId: item.id,
              status: 'failed',
              errorCode: 'COMMIT_REJECTED',
              errorMessage: commitErr instanceof Error ? commitErr.message : String(commitErr)
            })
          }
          return
        }
      }
    }

    // 2. Full worker decode + ONNX vision inference
    let embedOutcome: CustomEmbedSourceTaskResult
    if (this.embedSourceTask) {
      try {
        embedOutcome = await this.embedSourceTask(
          {
            fileLocationId: item.fileLocationId,
            sourcePath: resolved.filePath,
            expectedByteSize: resolved.expectedByteSize,
            expectedMtimeMs: resolved.expectedMtimeMs ?? item.expectedMtimeMs ?? 0,
            modelInstallDir
          },
          signal
        )
      } catch (err) {
        if (signal.aborted || this.cancelRequested || this.pauseRequested || this.isShutdown) {
          return
        }
        embedOutcome = {
          ok: false,
          category: 'error',
          errorCode: 'WORKER_ERROR',
          errorMessage: err instanceof Error ? err.message : String(err)
        }
      }
    } else {
      const workerRes = await this.thumbnailCoordinator.requestSemanticEmbedding({
        locationId: item.fileLocationId,
        sourcePath: resolved.filePath,
        expectedByteSize: resolved.expectedByteSize,
        expectedMtimeMs: resolved.expectedMtimeMs,
        expectedSha256: resolved.expectedSha256 ?? loc.activeHash,
        modelInstallDir,
        priority: 'low',
        approvedRootsOverride: resolved.approvedRoots
      })

      if (workerRes.status === 'ready') {
        embedOutcome = {
          ok: true,
          sha256: workerRes.computedSha256,
          observedByteSize: workerRes.observedByteSize,
          observedMtimeMs: workerRes.observedMtimeMs,
          width: workerRes.width,
          height: workerRes.height,
          vector: workerRes.vector
        }
      } else if (workerRes.status === 'unsupported') {
        embedOutcome = {
          ok: false,
          category: 'unsupported',
          errorCode: 'UNSUPPORTED_FORMAT',
          errorMessage: workerRes.reason
        }
      } else {
        embedOutcome = {
          ok: false,
          category: 'error',
          errorCode: workerRes.code,
          errorMessage: workerRes.message
        }
      }
    }

    if (signal.aborted || this.pauseRequested || this.cancelRequested || this.isShutdown) {
      return
    }

    if (!embedOutcome.ok) {
      if (embedOutcome.errorCode === 'CANCELLED' || embedOutcome.errorCode === 'ABORTED') {
        return
      }
      this.catalog.recordSemanticIndexJobItemOutcome({
        jobId,
        itemId: item.id,
        status: embedOutcome.category === 'unsupported' ? 'unsupported' : 'failed',
        errorCode: embedOutcome.errorCode,
        errorMessage: embedOutcome.errorMessage
      })
      return
    }

    // Revalidate live file revision on disk right before committing the vector
    if (
      !this.verifyPreCommitLiveStat(
        resolved.filePath,
        embedOutcome.observedByteSize,
        embedOutcome.observedMtimeMs
      )
    ) {
      this.catalog.recordSemanticIndexJobItemOutcome({
        jobId,
        itemId: item.id,
        status: 'failed',
        errorCode: 'SOURCE_MODIFIED',
        errorMessage: 'Source file changed on disk during semantic processing'
      })
      return
    }

    try {
      const observedMtimeForCommit =
        resolved.mode === 'vault_copy' && item.expectedMtimeMs !== null
          ? item.expectedMtimeMs
          : embedOutcome.observedMtimeMs
      const revision = `semrev:${item.discoveryObservationId}:${embedOutcome.observedByteSize}:${observedMtimeForCommit}:${embedOutcome.sha256}`
      this.catalog.completeSemanticIndexJobItemWithEmbedding({
        jobId,
        itemId: item.id,
        reused: false,
        embedding: {
          fileId: loc.id,
          fileLocationId: loc.id,
          discoveryObservationId: item.discoveryObservationId,
          contentSha256: embedOutcome.sha256,
          contentRevision: revision,
          sourcePath: item.originalPath,
          observedByteSize: embedOutcome.observedByteSize,
          observedMtimeMs: observedMtimeForCommit,
          modelId: job.modelId,
          modelCommit: job.modelCommit,
          modelManifestSha256: job.modelManifestSha256,
          preprocessingVersion: job.preprocessingVersion,
          embeddingDimensions: SEMANTIC_EMBEDDING_DIMENSIONS,
          vector: embedOutcome.vector,
          width: embedOutcome.width,
          height: embedOutcome.height
        }
      })
    } catch (commitErr) {
      this.catalog.recordSemanticIndexJobItemOutcome({
        jobId,
        itemId: item.id,
        status: 'failed',
        errorCode: 'COMMIT_REJECTED',
        errorMessage: commitErr instanceof Error ? commitErr.message : String(commitErr)
      })
    }
  }

  private verifyPreCommitLiveStat(
    sourcePath: string,
    expectedByteSize: number,
    expectedMtimeMs: number
  ): boolean {
    try {
      const st = statSync(sourcePath)
      if (!st.isFile() || st.size !== expectedByteSize) {
        return false
      }
      if (Math.abs(st.mtimeMs - expectedMtimeMs) > 1.0) {
        return false
      }
      return true
    } catch {
      return false
    }
  }
}
