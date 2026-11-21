/**
 * Personal Vault — Stage 8B Sub-slice 1A-2: Transfer Rate Limiter
 *
 * Injectable-clock, AbortSignal-aware token bucket applied at 64 KiB I/O slices
 * across destination writes, retries, and read-back verification reads.
 */

import { BackupSnapshotError } from './errors'

export const MIN_TRANSFER_RATE_BYTES_PER_SEC = 64 * 1024 // 64 KiB/s
export const RATE_LIMIT_SLICE_BYTES = 64 * 1024 // 64 KiB

export interface TransferRateLimiterOptions {
  readonly maxBytesPerSecond: number | null
  readonly nowMs?: () => number
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new BackupSnapshotError('backup_cancelled', 'Transfer cancelled'))
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new BackupSnapshotError('backup_cancelled', 'Transfer cancelled'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export class TransferRateLimiter {
  public readonly maxBytesPerSecond: number | null
  private readonly burstBytes: number
  private readonly nowMs: () => number
  private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>
  private tokens: number
  private lastRefillMs: number
  private totalConsumedBytes = 0

  public constructor(options: TransferRateLimiterOptions) {
    if (options.maxBytesPerSecond !== null) {
      if (
        !Number.isFinite(options.maxBytesPerSecond) ||
        options.maxBytesPerSecond < MIN_TRANSFER_RATE_BYTES_PER_SEC
      ) {
        throw new RangeError(
          `maxBytesPerSecond must be null or >= ${MIN_TRANSFER_RATE_BYTES_PER_SEC}, received: ${String(options.maxBytesPerSecond)}`
        )
      }
    }
    this.maxBytesPerSecond = options.maxBytesPerSecond
    this.burstBytes =
      options.maxBytesPerSecond === null
        ? 0
        : Math.max(64 * 1024, Math.min(256 * 1024, options.maxBytesPerSecond))
    this.nowMs = options.nowMs ?? (() => Date.now())
    this.sleepFn = options.sleep ?? defaultSleep
    this.tokens = 0
    this.lastRefillMs = this.nowMs()
  }

  public getTotalConsumedBytes(): number {
    return this.totalConsumedBytes
  }

  private refill(): void {
    if (this.maxBytesPerSecond === null) return
    const now = this.nowMs()
    const elapsedMs = Math.max(0, now - this.lastRefillMs)
    this.lastRefillMs = now
    if (elapsedMs > 0) {
      const added = (elapsedMs / 1000) * this.maxBytesPerSecond
      this.tokens = Math.min(this.burstBytes, this.tokens + added)
    }
  }

  public async consume(bytes: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new BackupSnapshotError('backup_cancelled', 'Transfer cancelled')
    }
    if (bytes <= 0) return

    this.totalConsumedBytes += bytes

    if (this.maxBytesPerSecond === null) {
      return
    }

    let remaining = bytes
    while (remaining > 0) {
      if (signal?.aborted) {
        throw new BackupSnapshotError('backup_cancelled', 'Transfer cancelled')
      }
      const slice = Math.min(remaining, RATE_LIMIT_SLICE_BYTES)
      this.refill()

      if (this.tokens < slice) {
        const deficit = slice - this.tokens
        const waitMs = Math.ceil((deficit / this.maxBytesPerSecond) * 1000)
        await this.sleepFn(Math.max(1, waitMs), signal)
        this.refill()
      }

      this.tokens = Math.max(0, this.tokens - slice)
      remaining -= slice
    }
  }
}
