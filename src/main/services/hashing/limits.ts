import type { HashFileLimits, ResolvedHashingLimits } from './types'

export const DEFAULT_CHUNK_SIZE_BYTES = 64 * 1024 // 64 KiB
export const MIN_CHUNK_SIZE_BYTES = 1024 // 1 KiB
export const MAX_CHUNK_SIZE_BYTES = 16 * 1024 * 1024 // 16 MiB

/**
 * Validates and resolves hashing resource limits before any filesystem access.
 *
 * - `chunkSizeBytes` must be a finite positive safe integer between 1,024 and 16,777,216.
 * - `maxFileSizeBytes` (if provided) must be a finite non-negative safe integer.
 *
 * Throws RangeError if any limit is invalid.
 */
export function resolveHashingLimits(limits?: HashFileLimits): ResolvedHashingLimits {
  let chunkSizeBytes = DEFAULT_CHUNK_SIZE_BYTES
  if (limits?.chunkSizeBytes !== undefined) {
    const val = limits.chunkSizeBytes
    if (!Number.isSafeInteger(val) || val < MIN_CHUNK_SIZE_BYTES || val > MAX_CHUNK_SIZE_BYTES) {
      throw new RangeError(
        `Invalid hashing configuration: "chunkSizeBytes" must be a finite positive safe integer between ${MIN_CHUNK_SIZE_BYTES} and ${MAX_CHUNK_SIZE_BYTES}, got ${String(val)}`
      )
    }
    chunkSizeBytes = val
  }

  let maxFileSizeBytes: number | undefined
  if (limits?.maxFileSizeBytes !== undefined) {
    const val = limits.maxFileSizeBytes
    if (!Number.isSafeInteger(val) || val < 0) {
      throw new RangeError(
        `Invalid hashing configuration: "maxFileSizeBytes" must be a finite non-negative safe integer, got ${String(val)}`
      )
    }
    maxFileSizeBytes = val
  }

  return {
    chunkSizeBytes,
    maxFileSizeBytes
  }
}
