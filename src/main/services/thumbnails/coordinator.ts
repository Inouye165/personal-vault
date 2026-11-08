/**
 * Personal Vault — Bounded Thumbnail Coordinator (Stage 5A)
 *
 * Coordinates decoding jobs with bounded concurrency, queue limits,
 * priority ordering, per-job timeouts, cache lookup/atomic store,
 * and strict source file preservation.
 */

import { realpathSync, statSync } from 'node:fs'
import { ThumbnailDiskCache } from './cache'
import { decodeThumbnail, type DecodeResult } from './decoder'
import {
  THUMBNAIL_LIMITS,
  type ThumbnailCoordinatorOptions,
  type ThumbnailRequestParams
} from './types'
import type { ThumbnailResult } from '../../../shared/validation/ipc-schemas'

export function readWebPDimensions(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 30) return { width: 512, height: 512 }
  const riff = buffer.toString('ascii', 0, 4)
  const webp = buffer.toString('ascii', 8, 12)
  if (riff !== 'RIFF' || webp !== 'WEBP') {
    return { width: 512, height: 512 }
  }
  const chunkHeader = buffer.toString('ascii', 12, 16)
  if (chunkHeader === 'VP8 ') {
    const width = buffer.readUInt16LE(26) & 0x3fff
    const height = buffer.readUInt16LE(28) & 0x3fff
    return { width, height }
  } else if (chunkHeader === 'VP8L') {
    const b0 = buffer[21] ?? 0
    const b1 = buffer[22] ?? 0
    const b2 = buffer[23] ?? 0
    const b3 = buffer[24] ?? 0
    const width = 1 + (((b1 & 0x3f) << 8) | b0)
    const height = 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6))
    return { width, height }
  } else if (chunkHeader === 'VP8X') {
    const width = 1 + buffer.readUIntLE(24, 3)
    const height = 1 + buffer.readUIntLE(27, 3)
    return { width, height }
  }
  return { width: 512, height: 512 }
}

interface QueuedItem {
  id: number
  params: ThumbnailRequestParams
  cacheKey: string
  resolve: (res: ThumbnailResult) => void
  reject: (err: unknown) => void
  priorityOrder: number
}

export class ThumbnailCoordinator {
  private readonly cache: ThumbnailDiskCache
  private readonly approvedRoots?: readonly string[] | (() => readonly string[])
  private readonly maxActiveJobs: number
  private readonly maxQueuedJobs: number
  private readonly jobTimeoutMs: number
  private readonly maxSourceSizeBytes: number
  private readonly maxInputPixels: number

  private activeJobsCount = 0
  private queue: QueuedItem[] = []
  private nextJobId = 1
  private isShuttingDown = false

  constructor(options: ThumbnailCoordinatorOptions) {
    this.cache = new ThumbnailDiskCache({
      cacheDir: options.cacheDir,
      maxSizeBytes: options.diskCacheBudget
    })
    this.approvedRoots = options.approvedRoots
    this.maxActiveJobs = options.maxActiveJobs ?? THUMBNAIL_LIMITS.MAX_ACTIVE_JOBS
    this.maxQueuedJobs = options.maxQueuedJobs ?? THUMBNAIL_LIMITS.MAX_QUEUED_JOBS
    this.jobTimeoutMs = options.jobTimeoutMs ?? THUMBNAIL_LIMITS.JOB_TIMEOUT_MS
    this.maxSourceSizeBytes = options.maxSourceSizeBytes ?? THUMBNAIL_LIMITS.MAX_SOURCE_SIZE_BYTES
    this.maxInputPixels = options.maxInputPixels ?? THUMBNAIL_LIMITS.MAX_INPUT_PIXELS
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

  public async requestThumbnail(params: ThumbnailRequestParams): Promise<ThumbnailResult> {
    if (this.isShuttingDown) {
      return {
        status: 'error',
        locationId: params.locationId,
        code: 'SHUTTING_DOWN',
        message: 'Thumbnail service is shutting down'
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
      sha256: params.expectedSha256,
      byteSize: params.expectedByteSize,
      mtimeMs: params.expectedMtimeMs
    })

    try {
      const cachedBuf = await this.cache.get(cacheKey)
      if (cachedBuf && cachedBuf.length > 0) {
        const dims = readWebPDimensions(cachedBuf)
        return {
          status: 'ready',
          locationId: params.locationId,
          dataUrl: `data:image/webp;base64,${cachedBuf.toString('base64')}`,
          mimeType: 'image/webp',
          width: dims.width,
          height: dims.height
        }
      }
    } catch {
      // Non-fatal if cache read fails, proceed to decode
    }

    // 3. Enforce queue bounds
    if (this.queue.length >= this.maxQueuedJobs) {
      return {
        status: 'error',
        locationId: params.locationId,
        code: 'QUEUE_FULL',
        message: 'Thumbnail decode queue is full'
      }
    }

    // 4. Priority ordering: high=0, normal=1, low=2
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
    if (
      this.isShuttingDown ||
      this.activeJobsCount >= this.maxActiveJobs ||
      this.queue.length === 0
    ) {
      return
    }

    const item = this.queue.shift()
    if (!item) {
      return
    }

    this.activeJobsCount++
    this.runJob(item)
      .catch((err) => {
        item.resolve({
          status: 'error',
          locationId: item.params.locationId,
          code: 'EXECUTION_FAILED',
          message: err?.message || 'Job failed'
        })
      })
      .finally(() => {
        this.activeJobsCount--
        this.processNext()
      })
  }

  private async runJob(item: QueuedItem): Promise<void> {
    const { params, cacheKey, resolve } = item

    let timer: NodeJS.Timeout | null = null
    const timeoutPromise = new Promise<DecodeResult>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error('JOB_TIMEOUT'))
      }, this.jobTimeoutMs)
    })

    const decodePromise = decodeThumbnail({
      sourcePath: params.sourcePath,
      expectedByteSize: params.expectedByteSize,
      expectedMtimeMs: params.expectedMtimeMs,
      expectedSha256: params.expectedSha256,
      maxDimension: THUMBNAIL_LIMITS.MAX_DIMENSION_PX,
      maxInputPixels: this.maxInputPixels,
      maxSourceSizeBytes: this.maxSourceSizeBytes,
      approvedRoots: this.getApprovedRoots()
    })

    try {
      const result = await Promise.race([decodePromise, timeoutPromise])
      if (timer) clearTimeout(timer)

      if (result.status === 'ready') {
        try {
          await this.cache.put(cacheKey, result.buffer)
        } catch {
          // If caching fails, still return ready thumbnail to caller
        }

        resolve({
          status: 'ready',
          locationId: params.locationId,
          dataUrl: `data:image/webp;base64,${result.buffer.toString('base64')}`,
          mimeType: result.mimeType,
          width: result.width,
          height: result.height
        })
      } else if (result.status === 'unsupported') {
        resolve({
          status: 'unsupported',
          locationId: params.locationId,
          reason: result.reason
        })
      } else {
        resolve({
          status: 'error',
          locationId: params.locationId,
          code: result.code,
          message: result.message
        })
      }
    } catch (err: unknown) {
      if (timer) clearTimeout(timer)
      const errorMsg = err instanceof Error ? err.message : String(err)
      if (errorMsg === 'JOB_TIMEOUT') {
        resolve({
          status: 'error',
          locationId: params.locationId,
          code: 'TIMEOUT',
          message: `Thumbnail decode exceeded timeout limit (${this.jobTimeoutMs} ms)`
        })
      } else {
        resolve({
          status: 'error',
          locationId: params.locationId,
          code: 'DECODE_FAILED',
          message: errorMsg || 'Decode failed'
        })
      }
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
    await this.cache.cleanupStagingFiles()
  }
}
