/**
 * Personal Vault — Bounded Thumbnail Coordinator (Stage 5A)
 *
 * Coordinates decoding jobs with bounded concurrency, queue limits,
 * priority ordering, per-job timeouts, cache lookup/atomic store,
 * worker thread lifecycle management, cancellation, and strict source
 * file preservation.
 */

import { realpathSync, statSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { ThumbnailDiskCache, readWebPDimensions } from './cache'
import {
  THUMBNAIL_LIMITS,
  type ThumbnailCoordinatorOptions,
  type ThumbnailRequestParams,
  type ThumbnailDiagnostics
} from './types'
import type { ThumbnailResult } from '../../../shared/validation/ipc-schemas'

export { readWebPDimensions }

interface QueuedItem {
  id: number
  params: ThumbnailRequestParams
  cacheKey: string
  resolve: (res: ThumbnailResult) => void
  reject: (err: unknown) => void
  priorityOrder: number
}

interface ActiveWorkerEntry {
  worker: Worker
  jobId: number | null
  locationId: number | null
  item: QueuedItem | null
  timeoutTimer: NodeJS.Timeout | null
  isTerminating: boolean
}

function resolveWorkerScriptPath(customPath?: string): string {
  if (customPath && existsSync(customPath)) {
    return customPath
  }
  const isTest = process.env.VITEST !== undefined || process.env.NODE_ENV === 'test'
  if (!isTest) {
    const builtInSameDir = join(__dirname, 'thumbnail_worker.js')
    if (existsSync(builtInSameDir)) {
      return builtInSameDir
    }
    const projectBuilt = resolve(process.cwd(), 'out', 'main', 'thumbnail_worker.js')
    if (existsSync(projectBuilt)) {
      return projectBuilt
    }
  }

  // Dynamic bundling for tests/dev to ensure live code execution
  const tempWorker = join(process.cwd(), 'out', 'main', 'thumbnail_worker.js')
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const esbuild = require('esbuild')
    const workerSource = resolve(__dirname, 'worker.ts')
    const entry = existsSync(workerSource)
      ? workerSource
      : resolve(process.cwd(), 'src', 'main', 'services', 'thumbnails', 'worker.ts')

    esbuild.buildSync({
      entryPoints: [entry],
      outfile: tempWorker,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['sharp', 'electron']
    })
    return tempWorker
  } catch {
    const projectBuilt = resolve(process.cwd(), 'out', 'main', 'thumbnail_worker.js')
    return projectBuilt
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

  constructor(options: ThumbnailCoordinatorOptions) {
    this.cache = new ThumbnailDiskCache({
      cacheDir: options.cacheDir,
      maxSizeBytes: options.diskCacheBudget,
      sourceRoots: options.approvedRoots,
      vaultPath: options.vaultPath
    })
    this.approvedRoots = options.approvedRoots
    this.maxActiveJobs = options.maxActiveJobs ?? THUMBNAIL_LIMITS.MAX_ACTIVE_JOBS
    this.maxQueuedJobs = options.maxQueuedJobs ?? THUMBNAIL_LIMITS.MAX_QUEUED_JOBS
    this.jobTimeoutMs = options.jobTimeoutMs ?? THUMBNAIL_LIMITS.JOB_TIMEOUT_MS
    this.maxSourceSizeBytes = options.maxSourceSizeBytes ?? THUMBNAIL_LIMITS.MAX_SOURCE_SIZE_BYTES
    this.maxInputPixels = options.maxInputPixels ?? THUMBNAIL_LIMITS.MAX_INPUT_PIXELS
    this.workerScriptPath = resolveWorkerScriptPath(options.workerScriptPath)
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

  public getDiagnostics(): ThumbnailDiagnostics {
    const active = this.workers.filter((w) => w.jobId !== null && !w.isTerminating).length
    return {
      activeWorkers: active,
      queuedJobs: this.queue.length,
      totalDecodes: this.totalDecodes,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses
    }
  }

  public cancelRequest(locationId: number): boolean {
    // 1. Check queued jobs
    const qIndex = this.queue.findIndex((q) => q.params.locationId === locationId)
    if (qIndex !== -1) {
      const item = this.queue.splice(qIndex, 1)[0]
      if (item) {
        item.resolve({
          status: 'error',
          locationId,
          code: 'CANCELLED',
          message: 'Thumbnail request was cancelled'
        })
        return true
      }
    }

    // 2. Check active worker jobs
    const entry = this.workers.find((w) => w.locationId === locationId && !w.isTerminating)
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

      void entry.worker.terminate().then(() => {
        this.removeWorker(entry)
        this.processNext()
      })

      item.resolve({
        status: 'error',
        locationId,
        code: 'CANCELLED',
        message: 'Thumbnail request was cancelled'
      })
      return true
    }

    // 3. Check in-progress request pre-flight
    if (this.inProgressLocationIds.has(locationId)) {
      this.cancelledLocationIds.add(locationId)
      return true
    }

    return false
  }

  public async requestThumbnail(params: ThumbnailRequestParams): Promise<ThumbnailResult> {
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

  private async executeRequestThumbnail(params: ThumbnailRequestParams): Promise<ThumbnailResult> {
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

    try {
      const cachedBuf = await this.cache.get(cacheKey)
      if (cachedBuf && cachedBuf.length > 0) {
        const dims = readWebPDimensions(cachedBuf)
        if (dims) {
          this.cacheHits++
          return {
            status: 'ready',
            locationId: params.locationId,
            dataUrl: `data:image/webp;base64,${cachedBuf.toString('base64')}`,
            mimeType: 'image/webp',
            width: dims.width,
            height: dims.height
          }
        }
      }
    } catch {
      // Non-fatal if cache read fails, proceed to decode
    }

    this.cacheMisses++

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
      const item: QueuedItem = {
        id: this.nextJobId++,
        params,
        cacheKey,
        resolve,
        reject,
        priorityOrder
      }

      // Insert preserving priority order
      const insertIndex = this.queue.findIndex((q) => q.priorityOrder > priorityOrder)
      if (insertIndex === -1) {
        this.queue.push(item)
      } else {
        this.queue.splice(insertIndex, 0, item)
      }

      this.processNext()
    })
  }

  private processNext(): void {
    if (this.isShuttingDown || this.queue.length === 0) {
      return
    }

    // Count non-terminating active workers
    const busyWorkers = this.workers.filter((w) => w.jobId !== null && !w.isTerminating)
    if (busyWorkers.length >= this.maxActiveJobs) {
      return
    }

    const item = this.queue.shift()
    if (!item) {
      return
    }

    this.dispatchToWorker(item)
  }

  private dispatchToWorker(item: QueuedItem): void {
    // Find an idle worker or spawn new worker if below limit
    let entry = this.workers.find((w) => w.jobId === null && !w.isTerminating)
    if (!entry) {
      if (this.workers.filter((w) => !w.isTerminating).length < this.maxActiveJobs) {
        entry = this.spawnWorker()
      } else {
        // Concurrency capacity full; put item back at head
        this.queue.unshift(item)
        return
      }
    }

    const currentEntry = entry
    currentEntry.jobId = item.id
    currentEntry.locationId = item.params.locationId
    currentEntry.item = item

    // Setup hard timeout
    currentEntry.timeoutTimer = setTimeout(() => {
      void this.handleWorkerTimeout(currentEntry)
    }, this.jobTimeoutMs)

    this.totalDecodes++

    // Post decode task to worker thread
    currentEntry.worker.postMessage({
      id: item.id,
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

  private spawnWorker(): ActiveWorkerEntry {
    const worker = new Worker(this.workerScriptPath)
    const entry: ActiveWorkerEntry = {
      worker,
      jobId: null,
      locationId: null,
      item: null,
      timeoutTimer: null,
      isTerminating: false
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
    if (entry.isTerminating || entry.jobId !== msg.id || !entry.item) {
      return
    }

    if (entry.timeoutTimer) {
      clearTimeout(entry.timeoutTimer)
      entry.timeoutTimer = null
    }

    const item = entry.item
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
      item.resolve({
        status: 'error',
        locationId: item.params.locationId,
        code: 'TIMEOUT',
        message: `Thumbnail decode exceeded timeout limit (${this.jobTimeoutMs} ms)`
      })
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

    try {
      void entry.worker.terminate()
    } catch {
      // ignore
    }

    this.removeWorker(entry)

    if (item) {
      item.resolve({
        status: 'error',
        locationId: item.params.locationId,
        code: 'WORKER_CRASHED',
        message: `Worker failure: ${errorMessage}`
      })
    }

    this.processNext()
  }

  private removeWorker(entry: ActiveWorkerEntry): void {
    const idx = this.workers.indexOf(entry)
    if (idx !== -1) {
      this.workers.splice(idx, 1)
    }
  }

  public async shutdown(): Promise<void> {
    this.isShuttingDown = true

    for (const item of this.queue) {
      item.resolve({
        status: 'error',
        locationId: item.params.locationId,
        code: 'ABORTED',
        message: 'Thumbnail service shutdown'
      })
    }
    this.queue = []

    const terminations = this.workers.map(async (entry) => {
      entry.isTerminating = true
      if (entry.timeoutTimer) {
        clearTimeout(entry.timeoutTimer)
        entry.timeoutTimer = null
      }
      if (entry.item) {
        entry.item.resolve({
          status: 'error',
          locationId: entry.item.params.locationId,
          code: 'ABORTED',
          message: 'Thumbnail service shutdown'
        })
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
