/**
 * Personal Vault — Bounded Thumbnail, Perceptual & Semantic Coordinator (Stages 5A, 5C, 6B)
 *
 * Coordinates decoding jobs with bounded concurrency, queue limits,
 * priority ordering, per-job timeouts, cache lookup/atomic store,
 * worker thread lifecycle management, cancellation, and strict source
 * file preservation.
 */

import { realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks'
import { ThumbnailDiskCache, readWebPDimensions } from './cache'
import { resolveMainWorkerScriptPath } from '../worker-path'
import { AppWorkerBudget } from '../worker-budget'
import {
  THUMBNAIL_LIMITS,
  type ThumbnailCoordinatorOptions,
  type ThumbnailRequestParams,
  type ThumbnailDiagnostics,
  type FingerprintJobResult,
  type SemanticEmbedRequestParams,
  type SemanticEmbedJobResult,
  type SourceVerificationJobResult,
  type MetadataExtractRequestParams,
  type MetadataExtractJobResult,
  type MetadataSourceVerifyResult
} from './types'
import type { ThumbnailResult } from '../../../shared/validation/ipc-schemas'
import type { SemanticModelArtifactSpec } from '../semantic/manifest'
import type { ExtractedPhotoMetadataResult } from '../metadata/types'

export { readWebPDimensions }

interface NormalizedThumbnailRequestParams {
  readonly locationId: number
  readonly sourcePath: string
  readonly expectedByteSize: number
  readonly expectedMtimeMs: number | null
  readonly expectedSha256: string | null
  readonly priority?: 'high' | 'normal' | 'low'
}

interface QueuedThumbnailItem {
  id: number
  action: 'decode' | 'validate_cache'
  params: NormalizedThumbnailRequestParams
  cacheKey: string
  cachedBuf?: Buffer
  resolve: (res: ThumbnailResult) => void
  reject: (err: unknown) => void
  priorityOrder: number
}

interface QueuedFingerprintItem {
  id: number
  action: 'fingerprint'
  params: NormalizedThumbnailRequestParams
  cacheKey: string
  cachedBuf?: Buffer
  resolve: (res: FingerprintJobResult) => void
  reject: (err: unknown) => void
  priorityOrder: number
}

interface QueuedSemanticEmbedItem {
  id: number
  action: 'semantic_embed'
  params: SemanticEmbedRequestParams
  cacheKey: string
  resolve: (res: SemanticEmbedJobResult) => void
  reject: (err: unknown) => void
  priorityOrder: number
}

interface QueuedVerifySourceItem {
  id: number
  action: 'verify_source'
  params: {
    sourcePath: string
    expectedByteSize?: number
    expectedMtimeMs?: number | null
    expectedSha256?: string | null
  }
  cacheKey: string
  resolve: (res: SourceVerificationJobResult) => void
  reject: (err: unknown) => void
  priorityOrder: number
}

interface QueuedVerifyModelItem {
  id: number
  action: 'verify_model'
  directoryPath: string
  specs: readonly SemanticModelArtifactSpec[]
  cacheKey: string
  resolve: (res: { ok: boolean; error?: string }) => void
  reject: (err: unknown) => void
  priorityOrder: number
}

interface QueuedExtractMetadataItem {
  id: number
  action: 'extract_metadata'
  params: MetadataExtractRequestParams
  cacheKey: string
  resolve: (res: MetadataExtractJobResult) => void
  reject: (err: unknown) => void
  priorityOrder: number
}

interface QueuedVerifyMetadataSourceItem {
  id: number
  action: 'verify_metadata_source'
  params: {
    sourcePath: string
    expectedByteSize?: number
    expectedMtimeMs?: number | null
    expectedSha256?: string | null
  }
  cacheKey: string
  resolve: (res: MetadataSourceVerifyResult) => void
  reject: (err: unknown) => void
  priorityOrder: number
}

type QueuedItem =
  | QueuedThumbnailItem
  | QueuedFingerprintItem
  | QueuedSemanticEmbedItem
  | QueuedVerifySourceItem
  | QueuedVerifyModelItem
  | QueuedExtractMetadataItem
  | QueuedVerifyMetadataSourceItem

interface ActiveWorkerEntry {
  worker: Worker
  jobId: number | null
  locationId: number | null
  item: QueuedItem | null
  timeoutTimer: NodeJS.Timeout | null
  isTerminating: boolean
  hasLoadedSemanticModel: boolean
}

export function resolveWorkerScriptPath(customPath?: string): string {
  const localWorkerSource = resolve(__dirname, 'worker.ts')
  return resolveMainWorkerScriptPath({
    workerFileName: 'thumbnail_worker.js',
    sourceEntryPath: localWorkerSource,
    customPath,
    moduleDir: __dirname,
    esbuildExternals: ['sharp', 'electron', 'onnxruntime-node']
  })
}

function normalizeRequestParams(params: ThumbnailRequestParams): NormalizedThumbnailRequestParams {
  const locationId = params.locationId ?? params.fileLocationId ?? params.photoId ?? 0
  return {
    locationId,
    sourcePath: params.sourcePath,
    expectedByteSize: params.expectedByteSize,
    expectedMtimeMs: params.expectedMtimeMs ?? null,
    expectedSha256: params.expectedSha256 ?? null,
    priority: params.priority
  }
}

export class ThumbnailCoordinator {
  private readonly cache: ThumbnailDiskCache
  private readonly approvedRoots?: readonly string[] | (() => readonly string[])
  private readonly maxActiveJobs: number
  private readonly maxQueuedJobs: number
  private readonly jobTimeoutMs: number
  private readonly maxSourceSizeBytes: number
  private readonly maxInputPixels: number
  private readonly workerScriptPath: string
  private readonly maxAppLiveWorkers: number
  private readonly getExternalLiveWorkers?: () => number
  private readonly workerBudget: AppWorkerBudget
  private readonly eventLoopMonitor: IntervalHistogram

  private workers: ActiveWorkerEntry[] = []
  private queue: QueuedItem[] = []
  private nextJobId = 1
  private isShuttingDown = false
  private inProgressLocationIds = new Set<number>()
  private cancelledLocationIds = new Set<number>()

  // Diagnostics counters
  private totalDecodes = 0
  private cacheHits = 0
  private cacheMisses = 0
  private workerIsolatePeakHeapUsedBytes = 0
  private workerIsolateLastHeapUsedBytes = 0
  private workerIsolatePeakExternalBytes = 0

  constructor(options: ThumbnailCoordinatorOptions) {
    this.cache = new ThumbnailDiskCache({
      cacheDir: options.cacheDir,
      maxSizeBytes: options.diskCacheBudget,
      sourceRoots: options.approvedRoots,
      vaultPath: options.vaultPath,
      validateBuffer: false
    })
    this.approvedRoots = options.approvedRoots
    this.maxActiveJobs = options.maxActiveJobs ?? THUMBNAIL_LIMITS.MAX_ACTIVE_JOBS
    this.maxQueuedJobs = options.maxQueuedJobs ?? THUMBNAIL_LIMITS.MAX_QUEUED_JOBS
    this.jobTimeoutMs = options.jobTimeoutMs ?? THUMBNAIL_LIMITS.JOB_TIMEOUT_MS
    this.maxSourceSizeBytes = options.maxSourceSizeBytes ?? THUMBNAIL_LIMITS.MAX_SOURCE_SIZE_BYTES
    this.maxInputPixels = options.maxInputPixels ?? THUMBNAIL_LIMITS.MAX_INPUT_PIXELS
    this.workerScriptPath = resolveWorkerScriptPath(options.workerScriptPath)
    this.maxAppLiveWorkers = Math.max(1, options.maxAppLiveWorkers ?? 3)
    this.getExternalLiveWorkers = options.getExternalLiveWorkers
    this.workerBudget = options.workerBudget ?? new AppWorkerBudget(this.maxAppLiveWorkers)
    this.eventLoopMonitor = monitorEventLoopDelay({ resolution: 10 })
    this.eventLoopMonitor.enable()
    void this.cache.cleanupStagingFiles()
  }

  public async initialize(): Promise<void> {
    await this.cache.cleanupStagingFiles()
  }

  private getApprovedRoots(): readonly string[] {
    if (!this.approvedRoots) return []
    if (typeof this.approvedRoots === 'function') {
      return this.approvedRoots()
    }
    return this.approvedRoots
  }

  public getCache(): ThumbnailDiskCache {
    return this.cache
  }

  public getLiveWorkerCount(): number {
    return this.workers.length
  }

  public async releaseOneIdleWorker(): Promise<boolean> {
    const idleEntry =
      this.workers.find((w) => w.jobId === null && !w.isTerminating && !w.hasLoadedSemanticModel) ??
      this.workers.find((w) => w.jobId === null && !w.isTerminating)
    if (!idleEntry) {
      return false
    }
    idleEntry.isTerminating = true
    await new Promise<void>((resolveExit) => {
      let settled = false
      const done = () => {
        if (!settled) {
          settled = true
          resolveExit()
        }
      }
      idleEntry.worker.once('exit', done)
      void idleEntry.worker.terminate().catch(() => {
        this.workers = this.workers.filter((w) => w !== idleEntry)
        done()
      })
    })
    return true
  }

  public getActiveWorkerEntries(): readonly ActiveWorkerEntry[] {
    return this.workers
  }

  public hasInteractiveWorkPending(): boolean {
    const highQueued = this.queue.some((q) => q.priorityOrder <= 1)
    if (highQueued) return true
    const highActive = this.workers.some(
      (w) => w.item !== null && w.item.priorityOrder <= 1 && !w.isTerminating
    )
    return highActive && this.workers.length >= this.maxActiveJobs
  }

  public getDiagnostics(): ThumbnailDiagnostics {
    const active = this.workers.filter((w) => w.jobId !== null || w.isTerminating).length
    const terminating = this.workers.filter((w) => w.isTerminating).length
    const activeSemantic = this.workers.filter(
      (w) => w.item?.action === 'semantic_embed' && !w.isTerminating
    ).length
    const activeMetadata = this.workers.filter(
      (w) =>
        (w.item?.action === 'extract_metadata' || w.item?.action === 'verify_metadata_source') &&
        !w.isTerminating
    ).length
    const loadedSemantic = this.workers.filter(
      (w) => w.hasLoadedSemanticModel && !w.isTerminating
    ).length
    const delayP95 = this.eventLoopMonitor.percentile(95) / 1e6
    const delayMax = this.eventLoopMonitor.max / 1e6
    const delayMean = this.eventLoopMonitor.mean / 1e6
    const mem = process.memoryUsage()

    return {
      activeWorkers: active,
      terminatingWorkers: terminating,
      liveWorkers: this.workers.length,
      activeSemanticTasks: activeSemantic,
      activeMetadataTasks: activeMetadata,
      semanticModelLoadedWorkers: loadedSemantic,
      queuedJobs: this.queue.length,
      totalDecodes: this.totalDecodes,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      mainEventLoopDelayP95Ms: isFinite(delayP95) ? delayP95 : 0,
      mainEventLoopDelayMaxMs: isFinite(delayMax) ? delayMax : 0,
      mainEventLoopDelayMeanMs: isFinite(delayMean) ? delayMean : 0,
      mainProcessRssBytes: mem.rss,
      mainProcessHeapUsedBytes: mem.heapUsed,
      workerIsolatePeakHeapUsedBytes: this.workerIsolatePeakHeapUsedBytes,
      workerIsolateLastHeapUsedBytes: this.workerIsolateLastHeapUsedBytes,
      workerIsolatePeakExternalBytes: this.workerIsolatePeakExternalBytes
    }
  }

  public cancelRequest(locationId: number): boolean {
    // 1. Check queued thumbnail jobs only (never cancel background fingerprint or semantic indexing tasks when a thumbnail cell scrolls out of view)
    const qIndex = this.queue.findIndex(
      (q) =>
        (q.action === 'decode' || q.action === 'validate_cache') &&
        q.params.locationId === locationId
    )
    if (qIndex !== -1) {
      const item = this.queue.splice(qIndex, 1)[0]
      if (item) {
        this.resolveCancelledItem(item, locationId)
        return true
      }
    }

    // 2. Check active worker thumbnail jobs only
    const entry = this.workers.find(
      (w) =>
        w.locationId === locationId &&
        !w.isTerminating &&
        (w.item?.action === 'decode' || w.item?.action === 'validate_cache')
    )
    if (entry && entry.item) {
      entry.isTerminating = true
      if (entry.timeoutTimer) {
        clearTimeout(entry.timeoutTimer)
        entry.timeoutTimer = null
      }
      const item = entry.item
      entry.item = null
      entry.jobId = null
      entry.locationId = null

      void entry.worker.terminate().finally(() => {
        this.removeWorker(entry)
        this.processNext()
      })

      this.resolveCancelledItem(item, locationId)
      return true
    }

    // 3. Check in-progress request pre-flight
    if (this.inProgressLocationIds.has(locationId)) {
      this.cancelledLocationIds.add(locationId)
      return true
    }

    return false
  }

  public async cancelSemanticRequests(): Promise<void> {
    // Remove all queued semantic_embed or verify_source jobs
    const remaining: QueuedItem[] = []
    for (const item of this.queue) {
      if (item.action === 'semantic_embed') {
        item.resolve({
          status: 'error',
          locationId: item.params.locationId,
          code: 'CANCELLED',
          message: 'Semantic indexing cancelled'
        })
      } else {
        remaining.push(item)
      }
    }
    this.queue = remaining

    // Terminate any active semantic worker immediately
    const semanticWorkers = this.workers.filter(
      (w) => !w.isTerminating && w.item?.action === 'semantic_embed'
    )
    await Promise.all(
      semanticWorkers.map(async (entry) => {
        entry.isTerminating = true
        if (entry.timeoutTimer) {
          clearTimeout(entry.timeoutTimer)
          entry.timeoutTimer = null
        }
        const item = entry.item
        entry.item = null
        entry.jobId = null
        entry.locationId = null
        if (item && item.action === 'semantic_embed') {
          item.resolve({
            status: 'error',
            locationId: item.params.locationId,
            code: 'CANCELLED',
            message: 'Semantic indexing cancelled'
          })
        }
        try {
          await entry.worker.terminate()
        } catch {
          // ignore
        } finally {
          this.removeWorker(entry)
          this.processNext()
        }
      })
    )
  }

  public releaseSemanticModelSession(): void {
    for (const entry of this.workers) {
      if (!entry.isTerminating && entry.jobId === null && entry.hasLoadedSemanticModel) {
        entry.hasLoadedSemanticModel = false
        try {
          entry.worker.postMessage({ id: -1, action: 'release_model' })
        } catch {
          // ignore
        }
      }
    }
  }

  public async cancelMetadataRequests(): Promise<void> {
    const remaining: QueuedItem[] = []
    for (const item of this.queue) {
      if (item.action === 'extract_metadata') {
        item.resolve({
          status: 'error',
          locationId: item.params.locationId,
          code: 'CANCELLED',
          message: 'Metadata extraction cancelled'
        })
      } else if (item.action === 'verify_metadata_source') {
        item.resolve({
          ok: false,
          errorCode: 'CANCELLED',
          errorMessage: 'Metadata source verification cancelled'
        })
      } else {
        remaining.push(item)
      }
    }
    this.queue = remaining

    const metadataWorkers = this.workers.filter(
      (w) =>
        !w.isTerminating &&
        (w.item?.action === 'extract_metadata' || w.item?.action === 'verify_metadata_source')
    )
    await Promise.all(
      metadataWorkers.map(async (entry) => {
        entry.isTerminating = true
        if (entry.timeoutTimer) {
          clearTimeout(entry.timeoutTimer)
          entry.timeoutTimer = null
        }
        const item = entry.item
        entry.item = null
        entry.jobId = null
        entry.locationId = null
        if (item?.action === 'extract_metadata') {
          item.resolve({
            status: 'error',
            locationId: item.params.locationId,
            code: 'CANCELLED',
            message: 'Metadata extraction cancelled'
          })
        } else if (item?.action === 'verify_metadata_source') {
          item.resolve({
            ok: false,
            errorCode: 'CANCELLED',
            errorMessage: 'Metadata source verification cancelled'
          })
        }
        try {
          await entry.worker.terminate()
        } catch {
          // ignore
        } finally {
          this.removeWorker(entry)
          this.processNext()
        }
      })
    )
  }

  private resolveCancelledItem(item: QueuedItem, locationId: number): void {
    if (item.action === 'decode' || item.action === 'validate_cache') {
      item.resolve({
        status: 'error',
        locationId,
        code: 'CANCELLED',
        message: 'Thumbnail request was cancelled'
      })
    } else if (item.action === 'fingerprint') {
      item.resolve({
        status: 'error',
        locationId,
        code: 'CANCELLED',
        message: 'Fingerprint request was cancelled'
      })
    } else if (item.action === 'semantic_embed') {
      item.resolve({
        status: 'error',
        locationId,
        code: 'CANCELLED',
        message: 'Semantic embedding request was cancelled'
      })
    } else if (item.action === 'verify_source') {
      item.resolve({
        ok: false,
        category: 'error',
        errorCode: 'CANCELLED',
        errorMessage: 'Source verification cancelled'
      })
    } else if (item.action === 'verify_model') {
      item.resolve({
        ok: false,
        error: 'Model verification cancelled'
      })
    } else if (item.action === 'extract_metadata') {
      item.resolve({
        status: 'error',
        locationId,
        code: 'CANCELLED',
        message: 'Metadata extraction request was cancelled'
      })
    } else if (item.action === 'verify_metadata_source') {
      item.resolve({
        ok: false,
        errorCode: 'CANCELLED',
        errorMessage: 'Metadata source verification cancelled'
      })
    }
  }

  public async requestThumbnail(rawParams: ThumbnailRequestParams): Promise<ThumbnailResult> {
    const params = normalizeRequestParams(rawParams)
    if (this.isShuttingDown) {
      return {
        status: 'error',
        locationId: params.locationId,
        code: 'SHUTTING_DOWN',
        message: 'Thumbnail service is shutting down'
      }
    }

    this.inProgressLocationIds.add(params.locationId)
    try {
      return await this.executeRequestThumbnail(params)
    } finally {
      this.inProgressLocationIds.delete(params.locationId)
      this.cancelledLocationIds.delete(params.locationId)
    }
  }

  public async computePerceptualHash(params: {
    fileLocationId: number
    sourcePath: string
    expectedByteSize: number
    expectedMtimeMs: number | null
    expectedSha256?: string | null
  }): Promise<
    | {
        status: 'ok'
        fingerprint: string
        width: number
        height: number
        computedSha256: string
      }
    | {
        status: 'unsupported_format' | 'error'
        errorCode: string
        errorMessage: string
      }
  > {
    const res = await this.requestFingerprint({
      locationId: params.fileLocationId,
      sourcePath: params.sourcePath,
      expectedByteSize: params.expectedByteSize,
      expectedMtimeMs: params.expectedMtimeMs,
      expectedSha256: params.expectedSha256 ?? null,
      priority: 'low'
    })
    if (res.status === 'ready') {
      return {
        status: 'ok',
        fingerprint: res.fingerprint,
        width: res.width,
        height: res.height,
        computedSha256: res.computedSha256
      }
    }
    if (res.status === 'unsupported') {
      return {
        status: 'unsupported_format',
        errorCode: 'UNSUPPORTED_FORMAT',
        errorMessage: res.reason
      }
    }
    return {
      status: 'error',
      errorCode: res.code,
      errorMessage: res.message
    }
  }

  public async verifyModelDirectory(
    directoryPath: string,
    specs: readonly SemanticModelArtifactSpec[]
  ): Promise<{ ok: boolean; error?: string }> {
    if (this.isShuttingDown) {
      return { ok: false, error: 'Thumbnail service is shutting down' }
    }
    if (this.queue.length >= this.maxQueuedJobs) {
      return { ok: false, error: 'Worker queue is full' }
    }

    return new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
      const item: QueuedVerifyModelItem = {
        id: this.nextJobId++,
        action: 'verify_model',
        directoryPath,
        specs,
        cacheKey: '',
        resolve,
        reject,
        priorityOrder: 1
      }
      this.enqueueItem(item)
    })
  }

  public async verifySourceFile(params: {
    sourcePath: string
    expectedByteSize?: number
    expectedMtimeMs?: number | null
    expectedSha256?: string | null
  }): Promise<SourceVerificationJobResult> {
    if (this.isShuttingDown) {
      return {
        ok: false,
        category: 'error',
        errorCode: 'SHUTTING_DOWN',
        errorMessage: 'Thumbnail service is shutting down'
      }
    }
    if (this.queue.length >= this.maxQueuedJobs) {
      return {
        ok: false,
        category: 'error',
        errorCode: 'QUEUE_FULL',
        errorMessage: 'Worker queue is full'
      }
    }

    return new Promise<SourceVerificationJobResult>((resolve, reject) => {
      const item: QueuedVerifySourceItem = {
        id: this.nextJobId++,
        action: 'verify_source',
        params,
        cacheKey: '',
        resolve,
        reject,
        priorityOrder: 2
      }
      this.enqueueItem(item)
    })
  }

  public async requestSemanticEmbedding(
    params: SemanticEmbedRequestParams
  ): Promise<SemanticEmbedJobResult> {
    if (this.isShuttingDown) {
      return {
        status: 'error',
        locationId: params.locationId,
        code: 'SHUTTING_DOWN',
        message: 'Worker service is shutting down'
      }
    }

    // Reserve at least 8 queue slots for interactive browsing requests
    const maxSemanticQueueThreshold = Math.max(4, this.maxQueuedJobs - 8)
    if (this.queue.length >= maxSemanticQueueThreshold) {
      return {
        status: 'error',
        locationId: params.locationId,
        code: 'QUEUE_FULL',
        message: 'Interactive queue capacity reserved; semantic task deferred'
      }
    }

    return new Promise<SemanticEmbedJobResult>((resolve, reject) => {
      const item: QueuedSemanticEmbedItem = {
        id: this.nextJobId++,
        action: 'semantic_embed',
        params,
        cacheKey: '',
        resolve,
        reject,
        priorityOrder: 3 // Lowest priority so interactive thumbnails (0, 1) and fingerprints (2) preempt
      }
      this.enqueueItem(item)
    })
  }

  public async verifySourceForMetadata(params: {
    sourcePath: string
    expectedByteSize?: number
    expectedMtimeMs?: number | null
    expectedSha256?: string | null
  }): Promise<MetadataSourceVerifyResult> {
    if (this.isShuttingDown) {
      return {
        ok: false,
        errorCode: 'SHUTTING_DOWN',
        errorMessage: 'Worker service is shutting down'
      }
    }
    const maxBackgroundQueueThreshold = Math.max(4, this.maxQueuedJobs - 8)
    if (this.queue.length >= maxBackgroundQueueThreshold) {
      return {
        ok: false,
        errorCode: 'QUEUE_FULL',
        errorMessage: 'Interactive queue capacity reserved; metadata verification deferred'
      }
    }

    return new Promise<MetadataSourceVerifyResult>((resolve, reject) => {
      const item: QueuedVerifyMetadataSourceItem = {
        id: this.nextJobId++,
        action: 'verify_metadata_source',
        params,
        cacheKey: '',
        resolve,
        reject,
        priorityOrder: 2.5
      }
      this.enqueueItem(item)
    })
  }

  public async requestMetadataExtraction(
    params: MetadataExtractRequestParams
  ): Promise<MetadataExtractJobResult> {
    if (this.isShuttingDown) {
      return {
        status: 'error',
        locationId: params.locationId,
        code: 'SHUTTING_DOWN',
        message: 'Worker service is shutting down'
      }
    }

    // Reserve at least 8 queue slots for interactive browsing requests
    const maxBackgroundQueueThreshold = Math.max(4, this.maxQueuedJobs - 8)
    if (this.queue.length >= maxBackgroundQueueThreshold) {
      return {
        status: 'error',
        locationId: params.locationId,
        code: 'QUEUE_FULL',
        message: 'Interactive queue capacity reserved; metadata task deferred'
      }
    }

    return new Promise<MetadataExtractJobResult>((resolve, reject) => {
      const item: QueuedExtractMetadataItem = {
        id: this.nextJobId++,
        action: 'extract_metadata',
        params,
        cacheKey: '',
        resolve,
        reject,
        priorityOrder: 2.5 // Behind interactive thumbnails (0, 1) and perceptual fingerprints (2)
      }
      this.enqueueItem(item)
    })
  }

  public async requestFingerprint(
    rawParams: ThumbnailRequestParams
  ): Promise<FingerprintJobResult> {
    const params = normalizeRequestParams(rawParams)
    if (this.isShuttingDown) {
      return {
        status: 'error',
        locationId: params.locationId,
        code: 'SHUTTING_DOWN',
        message: 'Thumbnail service is shutting down'
      }
    }

    if (this.queue.length >= this.maxQueuedJobs) {
      return {
        status: 'error',
        locationId: params.locationId,
        code: 'QUEUE_FULL',
        message: `Image processing queue limit reached (${this.maxQueuedJobs} jobs)`
      }
    }

    // Validate root containment if approved roots are configured
    const roots = this.getApprovedRoots()
    if (roots.length > 0) {
      try {
        const canonicalSource = realpathSync(params.sourcePath)
        const isApproved = roots.some((root) => {
          try {
            const canonicalRoot = realpathSync(root)
            return (
              canonicalSource === canonicalRoot ||
              canonicalSource.startsWith(canonicalRoot + '\\') ||
              canonicalSource.startsWith(canonicalRoot + '/')
            )
          } catch {
            return false
          }
        })
        if (!isApproved) {
          return {
            status: 'error',
            locationId: params.locationId,
            code: 'ACCESS_DENIED',
            message: `Source path is outside approved roots: ${params.sourcePath}`
          }
        }
      } catch {
        return {
          status: 'error',
          locationId: params.locationId,
          code: 'ACCESS_DENIED',
          message: `Source path cannot be verified: ${params.sourcePath}`
        }
      }
    }

    // Check live source stability
    try {
      const st = statSync(params.sourcePath)
      if (st.size > this.maxSourceSizeBytes) {
        return {
          status: 'error',
          locationId: params.locationId,
          code: 'OVERSIZED_SOURCE',
          message: `Source file size (${st.size} bytes) exceeds limit (${this.maxSourceSizeBytes} bytes)`
        }
      }
      if (params.expectedByteSize !== undefined && st.size !== params.expectedByteSize) {
        return {
          status: 'error',
          locationId: params.locationId,
          code: 'SOURCE_MODIFIED',
          message: 'Source file size changed on disk'
        }
      }
    } catch {
      return {
        status: 'error',
        locationId: params.locationId,
        code: 'SOURCE_UNAVAILABLE',
        message: 'Source file is not accessible'
      }
    }

    const priority = params.priority ?? 'low'
    const priorityOrder = priority === 'high' ? 0 : priority === 'normal' ? 1 : 2

    return new Promise<FingerprintJobResult>((resolve, reject) => {
      const item: QueuedFingerprintItem = {
        id: this.nextJobId++,
        action: 'fingerprint',
        params,
        cacheKey: '',
        resolve,
        reject,
        priorityOrder
      }
      this.enqueueItem(item)
    })
  }

  private enqueueItem(item: QueuedItem): void {
    const insertIndex = this.queue.findIndex((q) => q.priorityOrder > item.priorityOrder)
    if (insertIndex === -1) {
      this.queue.push(item)
    } else {
      this.queue.splice(insertIndex, 0, item)
    }
    this.processNext()
  }

  private async executeRequestThumbnail(
    params: NormalizedThumbnailRequestParams
  ): Promise<ThumbnailResult> {
    if (this.cancelledLocationIds.has(params.locationId)) {
      return {
        status: 'error',
        locationId: params.locationId,
        code: 'CANCELLED',
        message: 'Thumbnail request was cancelled'
      }
    }

    // 1. Validate root containment if approved roots are configured
    const roots = this.getApprovedRoots()
    if (roots.length > 0) {
      try {
        const canonicalSource = realpathSync(params.sourcePath)
        const isApproved = roots.some((root) => {
          try {
            const canonicalRoot = realpathSync(root)
            return (
              canonicalSource === canonicalRoot ||
              canonicalSource.startsWith(canonicalRoot + '\\') ||
              canonicalSource.startsWith(canonicalRoot + '/')
            )
          } catch {
            return false
          }
        })
        if (!isApproved) {
          return {
            status: 'error',
            locationId: params.locationId,
            code: 'ACCESS_DENIED',
            message: `Source path is outside approved roots: ${params.sourcePath}`
          }
        }
      } catch {
        return {
          status: 'error',
          locationId: params.locationId,
          code: 'ACCESS_DENIED',
          message: `Source path cannot be verified: ${params.sourcePath}`
        }
      }
    }

    // 2. Check live source stability against expected revision
    try {
      const st = statSync(params.sourcePath)
      if (st.size > this.maxSourceSizeBytes) {
        return {
          status: 'error',
          locationId: params.locationId,
          code: 'OVERSIZED_SOURCE',
          message: `Source file size (${st.size} bytes) exceeds limit (${this.maxSourceSizeBytes} bytes)`
        }
      }
      if (params.expectedByteSize !== undefined && st.size !== params.expectedByteSize) {
        return {
          status: 'error',
          locationId: params.locationId,
          code: 'SOURCE_MODIFIED',
          message: `Source file size changed out-of-band: expected ${params.expectedByteSize}, found ${st.size}`
        }
      }
      if (
        params.expectedMtimeMs !== null &&
        params.expectedMtimeMs !== undefined &&
        Math.abs(st.mtimeMs - params.expectedMtimeMs) > 1.0
      ) {
        return {
          status: 'error',
          locationId: params.locationId,
          code: 'SOURCE_MODIFIED',
          message: 'Source file modification time changed out-of-band'
        }
      }
    } catch {
      return {
        status: 'error',
        locationId: params.locationId,
        code: 'SOURCE_MODIFIED',
        message: 'Source file is inaccessible or changed'
      }
    }

    // 3. Compute cache key and check cache
    const cacheKey = this.cache.computeCacheKey({
      locationId: params.locationId,
      sourcePath: params.sourcePath,
      sha256: params.expectedSha256,
      byteSize: params.expectedByteSize,
      mtimeMs: params.expectedMtimeMs
    })

    let candidateBuf: Buffer | null = null
    try {
      const cachedBuf = await this.cache.get(cacheKey)
      if (cachedBuf && cachedBuf.length > 0) {
        candidateBuf = cachedBuf
      }
    } catch {
      // Non-fatal if cache read fails, proceed to decode
    }

    if (!candidateBuf) {
      this.cacheMisses++
    }

    if (this.cancelledLocationIds.has(params.locationId)) {
      return {
        status: 'error',
        locationId: params.locationId,
        code: 'CANCELLED',
        message: 'Thumbnail request was cancelled'
      }
    }

    // 4. Enforce queue bounds
    if (this.queue.length >= this.maxQueuedJobs) {
      return {
        status: 'error',
        locationId: params.locationId,
        code: 'QUEUE_FULL',
        message: 'Thumbnail decode queue is full'
      }
    }

    // 5. Priority ordering: high=0, normal=1, low=2
    const priority = params.priority ?? 'normal'
    const priorityOrder = priority === 'high' ? 0 : priority === 'normal' ? 1 : 2

    return new Promise<ThumbnailResult>((resolve, reject) => {
      const item: QueuedThumbnailItem = {
        id: this.nextJobId++,
        action: candidateBuf ? 'validate_cache' : 'decode',
        params,
        cacheKey,
        cachedBuf: candidateBuf ?? undefined,
        resolve,
        reject,
        priorityOrder
      }
      this.enqueueItem(item)
    })
  }

  private processNext(): void {
    if (this.isShuttingDown || this.queue.length === 0) {
      return
    }

    // Total live workers (including terminating workers) cannot exceed maxActiveJobs.
    const idleWorkers = this.workers.filter((w) => w.jobId === null && !w.isTerminating)
    if (idleWorkers.length === 0 && this.workers.length >= this.maxActiveJobs) {
      return
    }

    // Check if an active semantic or metadata task is already running
    const activeSemanticCount = this.workers.filter(
      (w) => !w.isTerminating && w.item?.action === 'semantic_embed'
    ).length
    const activeMetadataCount = this.workers.filter(
      (w) =>
        !w.isTerminating &&
        (w.item?.action === 'extract_metadata' || w.item?.action === 'verify_metadata_source')
    ).length

    // Find the first eligible item in queue
    const nextIdx = this.queue.findIndex((candidate) => {
      if (candidate.action === 'semantic_embed') {
        // At most 1 active semantic embedding task at any time
        if (activeSemanticCount >= 1) return false
        // If another worker already holds the loaded semantic model and is busy, wait for it
        // rather than loading a 2nd heavyweight ONNX session into the other thumbnail worker!
        const busySemanticOwner = this.workers.find(
          (w) => !w.isTerminating && w.hasLoadedSemanticModel && w.jobId !== null
        )
        if (busySemanticOwner) return false
      }
      if (
        candidate.action === 'extract_metadata' ||
        candidate.action === 'verify_metadata_source'
      ) {
        // At most 1 active metadata task at any time so the 2nd worker remains free for interactive thumbnails
        if (activeMetadataCount >= 1) return false
      }
      return true
    })

    if (nextIdx === -1) {
      return
    }

    const item = this.queue.splice(nextIdx, 1)[0]
    if (!item) {
      return
    }

    this.dispatchToWorker(item)
  }

  private dispatchToWorker(item: QueuedItem): void {
    let entry: ActiveWorkerEntry | undefined

    if (item.action === 'semantic_embed') {
      // Prefer the idle worker that already has the semantic model loaded
      entry =
        this.workers.find(
          (w) => w.jobId === null && !w.isTerminating && w.hasLoadedSemanticModel
        ) ?? this.workers.find((w) => w.jobId === null && !w.isTerminating)
    } else {
      // For non-semantic work, prefer an idle worker without the semantic model first
      entry =
        this.workers.find(
          (w) => w.jobId === null && !w.isTerminating && !w.hasLoadedSemanticModel
        ) ?? this.workers.find((w) => w.jobId === null && !w.isTerminating)
    }

    if (!entry) {
      const reservation =
        this.workers.length < this.maxActiveJobs
          ? this.workerBudget.tryReserve(this.getExternalLiveWorkers)
          : null
      if (reservation) {
        try {
          entry = this.spawnWorker()
          this.workerBudget.promote(reservation, entry.worker)
        } catch (err) {
          this.workerBudget.releaseReservation(reservation)
          throw err
        }
      } else {
        this.queue.unshift(item)
        if (this.workers.length === 0) {
          setTimeout(() => {
            if (!this.isShuttingDown) {
              this.processNext()
            }
          }, 25)
        }
        return
      }
    }

    const currentEntry = entry
    currentEntry.jobId = item.id
    currentEntry.locationId =
      item.action === 'decode' ||
      item.action === 'validate_cache' ||
      item.action === 'fingerprint' ||
      item.action === 'semantic_embed' ||
      item.action === 'extract_metadata'
        ? item.params.locationId
        : null
    currentEntry.item = item

    // Setup hard timeout (allow 30s for semantic model init + inference, jobTimeoutMs for others)
    const timeoutMs =
      item.action === 'semantic_embed' || item.action === 'verify_model'
        ? Math.max(this.jobTimeoutMs, 30_000)
        : this.jobTimeoutMs

    currentEntry.timeoutTimer = setTimeout(() => {
      void this.handleWorkerTimeout(currentEntry)
    }, timeoutMs)

    if (item.action === 'validate_cache') {
      currentEntry.worker.postMessage({
        id: item.id,
        action: 'validate_cache',
        buffer: item.cachedBuf,
        maxBytes: THUMBNAIL_LIMITS.MAX_THUMBNAIL_BYTES,
        stuck: process.env.PV_TEST_STUCK_VALIDATION === '1'
      })
    } else if (item.action === 'fingerprint') {
      currentEntry.worker.postMessage({
        id: item.id,
        action: 'fingerprint',
        params: {
          sourcePath: item.params.sourcePath,
          expectedByteSize: item.params.expectedByteSize,
          expectedMtimeMs: item.params.expectedMtimeMs,
          expectedSha256: item.params.expectedSha256,
          maxInputPixels: this.maxInputPixels,
          maxSourceSizeBytes: this.maxSourceSizeBytes,
          approvedRoots: this.getApprovedRoots()
        }
      })
    } else if (item.action === 'semantic_embed') {
      currentEntry.hasLoadedSemanticModel = true
      currentEntry.worker.postMessage({
        id: item.id,
        action: 'semantic_embed',
        params: {
          sourcePath: item.params.sourcePath,
          expectedByteSize: item.params.expectedByteSize,
          expectedMtimeMs: item.params.expectedMtimeMs,
          expectedSha256: item.params.expectedSha256 ?? null,
          modelInstallDir: item.params.modelInstallDir,
          maxInputPixels: this.maxInputPixels,
          maxSourceSizeBytes: this.maxSourceSizeBytes,
          approvedRoots: this.getApprovedRoots()
        }
      })
    } else if (item.action === 'verify_source') {
      currentEntry.worker.postMessage({
        id: item.id,
        action: 'verify_source',
        params: {
          sourcePath: item.params.sourcePath,
          expectedByteSize: item.params.expectedByteSize,
          expectedMtimeMs: item.params.expectedMtimeMs,
          expectedSha256: item.params.expectedSha256,
          maxInputPixels: this.maxInputPixels,
          maxSourceSizeBytes: this.maxSourceSizeBytes,
          approvedRoots: this.getApprovedRoots()
        }
      })
    } else if (item.action === 'verify_model') {
      currentEntry.worker.postMessage({
        id: item.id,
        action: 'verify_model',
        directoryPath: item.directoryPath,
        specs: item.specs
      })
    } else if (item.action === 'verify_metadata_source') {
      currentEntry.worker.postMessage({
        id: item.id,
        action: 'verify_metadata_source',
        params: {
          sourcePath: item.params.sourcePath,
          expectedByteSize: item.params.expectedByteSize,
          expectedMtimeMs: item.params.expectedMtimeMs,
          expectedSha256: item.params.expectedSha256 ?? null,
          maxSourceSizeBytes: this.maxSourceSizeBytes,
          approvedRoots: this.getApprovedRoots()
        }
      })
    } else if (item.action === 'extract_metadata') {
      currentEntry.worker.postMessage({
        id: item.id,
        action: 'extract_metadata',
        stuck: process.env.PV_TEST_STUCK_METADATA === '1',
        params: {
          sourcePath: item.params.sourcePath,
          recordedExtension: item.params.recordedExtension,
          expectedByteSize: item.params.expectedByteSize,
          expectedMtimeMs: item.params.expectedMtimeMs,
          expectedSha256: item.params.expectedSha256 ?? null,
          maxSourceSizeBytes: this.maxSourceSizeBytes,
          approvedRoots: this.getApprovedRoots()
        }
      })
    } else {
      this.totalDecodes++
      currentEntry.worker.postMessage({
        id: item.id,
        action: 'decode',
        params: {
          sourcePath: item.params.sourcePath,
          expectedByteSize: item.params.expectedByteSize,
          expectedMtimeMs: item.params.expectedMtimeMs,
          expectedSha256: item.params.expectedSha256,
          maxDimension: THUMBNAIL_LIMITS.MAX_DIMENSION_PX,
          maxInputPixels: this.maxInputPixels,
          maxSourceSizeBytes: this.maxSourceSizeBytes,
          approvedRoots: this.getApprovedRoots()
        }
      })
    }
  }

  private spawnWorker(): ActiveWorkerEntry {
    const worker = new Worker(this.workerScriptPath)
    const entry: ActiveWorkerEntry = {
      worker,
      jobId: null,
      locationId: null,
      item: null,
      timeoutTimer: null,
      isTerminating: false,
      hasLoadedSemanticModel: false
    }

    worker.on('message', (msg: { id: number; status: string; [key: string]: unknown }) => {
      this.handleWorkerMessage(entry, msg)
    })

    worker.on('error', (err: Error) => {
      this.handleWorkerFailure(entry, err.message)
    })

    worker.on('exit', (code: number) => {
      if (!entry.isTerminating && code !== 0) {
        this.handleWorkerFailure(entry, `Worker exited with code ${code}`)
      }
    })

    this.workers.push(entry)
    return entry
  }

  private handleWorkerMessage(
    entry: ActiveWorkerEntry,
    msg: { id: number; status: string; [key: string]: unknown }
  ): void {
    if (msg.id === -1 || entry.isTerminating || entry.jobId !== msg.id || !entry.item) {
      return
    }

    if (entry.timeoutTimer) {
      clearTimeout(entry.timeoutTimer)
      entry.timeoutTimer = null
    }

    const item = entry.item

    if (item.action === 'verify_model') {
      entry.item = null
      entry.jobId = null
      entry.locationId = null
      item.resolve({
        ok: Boolean(msg.ok),
        error: typeof msg.error === 'string' ? msg.error : undefined
      })
      this.processNext()
      return
    }

    if (item.action === 'verify_metadata_source') {
      entry.item = null
      entry.jobId = null
      entry.locationId = null
      if (msg.status === 'ok') {
        item.resolve({
          ok: true,
          sha256: String(msg.sha256),
          observedByteSize: Number(msg.observedByteSize),
          observedMtimeMs: Number(msg.observedMtimeMs)
        })
      } else {
        item.resolve({
          ok: false,
          errorCode: typeof msg.code === 'string' ? msg.code : 'VERIFY_FAILED',
          errorMessage:
            typeof msg.message === 'string' ? msg.message : 'Metadata source verification failed'
        })
      }
      this.processNext()
      return
    }

    if (item.action === 'extract_metadata') {
      entry.item = null
      entry.jobId = null
      entry.locationId = null
      if (typeof msg.workerHeapUsedBytes === 'number' && msg.workerHeapUsedBytes > 0) {
        this.workerIsolateLastHeapUsedBytes = msg.workerHeapUsedBytes
        this.workerIsolatePeakHeapUsedBytes = Math.max(
          this.workerIsolatePeakHeapUsedBytes,
          msg.workerHeapUsedBytes
        )
      }
      if (typeof msg.workerExternalBytes === 'number' && msg.workerExternalBytes > 0) {
        this.workerIsolatePeakExternalBytes = Math.max(
          this.workerIsolatePeakExternalBytes,
          msg.workerExternalBytes
        )
      }
      if (msg.status === 'ok' && msg.extracted && typeof msg.extracted === 'object') {
        item.resolve({
          status: 'ok',
          locationId: item.params.locationId,
          extracted: msg.extracted as ExtractedPhotoMetadataResult
        })
      } else {
        item.resolve({
          status: 'error',
          locationId: item.params.locationId,
          code: typeof msg.code === 'string' ? msg.code : 'METADATA_EXTRACT_FAILED',
          message:
            typeof msg.message === 'string' ? msg.message : 'Photo metadata extraction failed'
        })
      }
      this.processNext()
      return
    }

    if (item.action === 'verify_source') {
      entry.item = null
      entry.jobId = null
      entry.locationId = null
      if (msg.status === 'ok') {
        item.resolve({
          ok: true,
          sha256: String(msg.sha256),
          observedByteSize: Number(msg.observedByteSize),
          observedMtimeMs: Number(msg.observedMtimeMs)
        })
      } else if (msg.status === 'unsupported') {
        item.resolve({
          ok: false,
          category: 'unsupported',
          errorCode: 'UNSUPPORTED_FORMAT',
          errorMessage: typeof msg.reason === 'string' ? msg.reason : 'Unsupported format'
        })
      } else {
        item.resolve({
          ok: false,
          category: 'error',
          errorCode: typeof msg.code === 'string' ? msg.code : 'VERIFY_FAILED',
          errorMessage: typeof msg.message === 'string' ? msg.message : 'Source verification failed'
        })
      }
      this.processNext()
      return
    }

    if (item.action === 'semantic_embed') {
      entry.item = null
      entry.jobId = null
      entry.locationId = null
      if (typeof msg.workerHeapUsedBytes === 'number' && msg.workerHeapUsedBytes > 0) {
        this.workerIsolateLastHeapUsedBytes = msg.workerHeapUsedBytes
        this.workerIsolatePeakHeapUsedBytes = Math.max(
          this.workerIsolatePeakHeapUsedBytes,
          msg.workerHeapUsedBytes
        )
      }
      if (typeof msg.workerExternalBytes === 'number' && msg.workerExternalBytes > 0) {
        this.workerIsolatePeakExternalBytes = Math.max(
          this.workerIsolatePeakExternalBytes,
          msg.workerExternalBytes
        )
      }
      if (msg.status === 'ready' && msg.vector instanceof Float32Array) {
        item.resolve({
          status: 'ready',
          locationId: item.params.locationId,
          vector: msg.vector,
          width: Number(msg.width),
          height: Number(msg.height),
          computedSha256: String(msg.computedSha256),
          observedByteSize: Number(msg.observedByteSize),
          observedMtimeMs: Number(msg.observedMtimeMs)
        })
      } else if (msg.status === 'unsupported') {
        item.resolve({
          status: 'unsupported',
          locationId: item.params.locationId,
          reason: typeof msg.reason === 'string' ? msg.reason : 'Unsupported image format'
        })
      } else {
        item.resolve({
          status: 'error',
          locationId: item.params.locationId,
          code: typeof msg.code === 'string' ? msg.code : 'EMBED_FAILED',
          message: typeof msg.message === 'string' ? msg.message : 'Semantic embedding failed'
        })
      }
      this.processNext()
      return
    }

    if (item.action === 'validate_cache') {
      if (msg.status === 'valid' && item.cachedBuf) {
        entry.item = null
        entry.jobId = null
        entry.locationId = null

        this.cacheHits++
        const width = typeof msg.width === 'number' ? msg.width : 512
        const height = typeof msg.height === 'number' ? msg.height : 512
        item.resolve({
          status: 'ready',
          locationId: item.params.locationId,
          dataUrl: `data:image/webp;base64,${item.cachedBuf.toString('base64')}`,
          mimeType: 'image/webp',
          width,
          height
        })
        this.processNext()
        return
      } else {
        // Cache entry is corrupt or validation failed! Discard and regenerate from source
        this.cacheMisses++
        this.cache.delete(item.cacheKey)

        item.action = 'decode'
        item.cachedBuf = undefined

        entry.item = null
        entry.jobId = null
        entry.locationId = null

        this.queue.unshift(item)
        this.processNext()
        return
      }
    }

    if (item.action === 'fingerprint') {
      entry.item = null
      entry.jobId = null
      entry.locationId = null

      if (msg.status === 'ready') {
        item.resolve({
          status: 'ready',
          locationId: item.params.locationId,
          fingerprint: msg.fingerprint as string,
          bucket0: msg.bucket0 as number,
          bucket1: msg.bucket1 as number,
          bucket2: msg.bucket2 as number,
          bucket3: msg.bucket3 as number,
          width: msg.width as number,
          height: msg.height as number,
          algorithmVersion: msg.algorithmVersion as string,
          computedSha256: msg.computedSha256 as string
        })
      } else if (msg.status === 'unsupported') {
        item.resolve({
          status: 'unsupported',
          locationId: item.params.locationId,
          reason: (msg.reason as string) || 'Unsupported image format'
        })
      } else {
        item.resolve({
          status: 'error',
          locationId: item.params.locationId,
          code: (msg.code as string) || 'FINGERPRINT_FAILED',
          message: (msg.message as string) || 'Failed to compute fingerprint'
        })
      }
      this.processNext()
      return
    }

    entry.item = null
    entry.jobId = null
    entry.locationId = null

    if (
      msg.status === 'ready' &&
      (Buffer.isBuffer(msg.buffer) || msg.buffer instanceof Uint8Array)
    ) {
      const buffer = Buffer.isBuffer(msg.buffer) ? msg.buffer : Buffer.from(msg.buffer)
      const width = typeof msg.width === 'number' ? msg.width : 512
      const height = typeof msg.height === 'number' ? msg.height : 512
      const mimeType = typeof msg.mimeType === 'string' ? msg.mimeType : 'image/webp'

      void this.cache
        .put(item.cacheKey, buffer)
        .catch(() => {
          // If caching fails, non-fatal: still return ready thumbnail
        })
        .finally(() => {
          item.resolve({
            status: 'ready',
            locationId: item.params.locationId,
            dataUrl: `data:image/webp;base64,${buffer.toString('base64')}`,
            mimeType,
            width,
            height
          })
          this.processNext()
        })
    } else if (msg.status === 'unsupported') {
      item.resolve({
        status: 'unsupported',
        locationId: item.params.locationId,
        reason: typeof msg.reason === 'string' ? msg.reason : 'Unsupported image format'
      })
      this.processNext()
    } else {
      item.resolve({
        status: 'error',
        locationId: item.params.locationId,
        code: typeof msg.code === 'string' ? msg.code : 'DECODE_FAILED',
        message: typeof msg.message === 'string' ? msg.message : 'Decode failed'
      })
      this.processNext()
    }
  }

  private async handleWorkerTimeout(entry: ActiveWorkerEntry): Promise<void> {
    if (entry.isTerminating) return
    entry.isTerminating = true

    if (entry.timeoutTimer) {
      clearTimeout(entry.timeoutTimer)
      entry.timeoutTimer = null
    }

    const item = entry.item
    entry.item = null
    entry.jobId = null
    entry.locationId = null

    // Concurrency capacity is NOT freed until the worker actually terminates!
    try {
      await entry.worker.terminate()
    } catch {
      // ignore
    }

    this.removeWorker(entry)

    if (item) {
      this.resolveWorkerErrorItem(
        item,
        'TIMEOUT',
        item.action === 'validate_cache'
          ? `Thumbnail validation exceeded timeout limit (${this.jobTimeoutMs} ms)`
          : item.action === 'extract_metadata' || item.action === 'verify_metadata_source'
            ? `Metadata parser exceeded timeout limit (${this.jobTimeoutMs} ms)`
            : `Thumbnail decode exceeded timeout limit (${this.jobTimeoutMs} ms)`
      )
    }

    this.processNext()
  }

  private handleWorkerFailure(entry: ActiveWorkerEntry, errorMessage: string): void {
    if (entry.isTerminating) return
    entry.isTerminating = true

    if (entry.timeoutTimer) {
      clearTimeout(entry.timeoutTimer)
      entry.timeoutTimer = null
    }

    const item = entry.item
    entry.item = null
    entry.jobId = null
    entry.locationId = null

    void entry.worker.terminate().finally(() => {
      this.removeWorker(entry)
      this.processNext()
    })

    if (item) {
      this.resolveWorkerErrorItem(item, 'WORKER_CRASHED', `Worker failure: ${errorMessage}`)
    }
  }

  private resolveWorkerErrorItem(item: QueuedItem, code: string, message: string): void {
    if (item.action === 'decode' || item.action === 'validate_cache') {
      item.resolve({
        status: 'error',
        locationId: item.params.locationId,
        code,
        message
      })
    } else if (item.action === 'fingerprint') {
      item.resolve({
        status: 'error',
        locationId: item.params.locationId,
        code,
        message
      })
    } else if (item.action === 'semantic_embed') {
      item.resolve({
        status: 'error',
        locationId: item.params.locationId,
        code,
        message
      })
    } else if (item.action === 'verify_source') {
      item.resolve({
        ok: false,
        category: 'error',
        errorCode: code,
        errorMessage: message
      })
    } else if (item.action === 'verify_model') {
      item.resolve({
        ok: false,
        error: message
      })
    } else if (item.action === 'extract_metadata') {
      item.resolve({
        status: 'error',
        locationId: item.params.locationId,
        code,
        message
      })
    } else if (item.action === 'verify_metadata_source') {
      item.resolve({
        ok: false,
        errorCode: code,
        errorMessage: message
      })
    }
  }

  private removeWorker(entry: ActiveWorkerEntry): void {
    const idx = this.workers.indexOf(entry)
    if (idx !== -1) {
      this.workers.splice(idx, 1)
    }
  }

  public async shutdown(): Promise<void> {
    this.isShuttingDown = true
    this.cache.abort()
    try {
      this.eventLoopMonitor.disable()
    } catch {
      // ignore
    }

    for (const item of this.queue) {
      this.resolveWorkerErrorItem(item, 'ABORTED', 'Thumbnail service shutdown')
    }
    this.queue = []

    const terminations = this.workers.map(async (entry) => {
      entry.isTerminating = true
      if (entry.timeoutTimer) {
        clearTimeout(entry.timeoutTimer)
        entry.timeoutTimer = null
      }
      if (entry.item) {
        this.resolveWorkerErrorItem(entry.item, 'ABORTED', 'Thumbnail service shutdown')
        entry.item = null
      }
      try {
        await entry.worker.terminate()
      } catch {
        // ignore
      }
    })

    await Promise.all(terminations)
    this.workers = []
    await this.cache.cleanupStagingFiles()
  }
}
