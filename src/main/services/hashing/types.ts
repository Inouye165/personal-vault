import type { ReadOnlyHashingFsAdapter } from './fs-adapter'

/**
 * Expected file metadata from discovery or prior inventory inspection.
 */
export interface HashCandidateExpectation {
  /**
   * Expected byte size from prior discovery.
   */
  readonly byteSize?: number
  /**
   * Expected modification timestamp in ms from prior discovery.
   */
  readonly mtimeMs?: number
  /**
   * Expected creation timestamp in ms from prior discovery.
   */
  readonly birthtimeMs?: number
}

/**
 * Configurable resource limits for hashing.
 */
export interface HashFileLimits {
  /**
   * Chunk size in bytes for bounded streaming reads.
   * Default: 65,536 (64 KiB).
   * Valid range: 1,024 (1 KiB) to 16,777,216 (16 MiB).
   */
  readonly chunkSizeBytes?: number
  /**
   * Optional maximum allowed file size in bytes.
   * If a file's size exceeds this value, hashing is rejected with 'file_size_exceeded'.
   */
  readonly maxFileSizeBytes?: number
}

export interface ResolvedHashingLimits {
  readonly chunkSizeBytes: number
  readonly maxFileSizeBytes?: number
}

/**
 * Options passed to `hashFile`.
 */
export interface HashFileOptions {
  /**
   * Path to the target file.
   */
  readonly filePath: string
  /**
   * Required non-empty list of approved root directory paths.
   * The candidate file's canonical path must reside within at least one approved root.
   */
  readonly approvedRoots: readonly [string, ...string[]] | readonly string[]
  /**
   * Optional metadata expected from discovery (e.g. Stage 2A candidate).
   */
  readonly expectation?: HashCandidateExpectation
  /**
   * Optional resource limits overriding defaults.
   */
  readonly limits?: HashFileLimits
  /**
   * Optional AbortSignal for cooperative cancellation.
   */
  readonly signal?: AbortSignal
  /**
   * Optional read-only filesystem adapter override (for testing).
   */
  readonly fsAdapter?: ReadOnlyHashingFsAdapter
}

/**
 * Successful hash outcome.
 */
export interface HashFileSuccessResult {
  readonly status: 'success'
  readonly path: string
  readonly canonicalPath: string
  readonly sha256: string
  readonly byteSize: number
  readonly mtimeMs: number
  readonly birthtimeMs: number
}

/**
 * Cooperative cancellation outcome.
 */
export interface HashFileCancelledResult {
  readonly status: 'cancelled'
  readonly path: string
}

export type HashChangedReason =
  | 'size_mismatch_discovery'
  | 'mtime_modified_discovery'
  | 'birthtime_modified_discovery'
  | 'size_modified_during_read'
  | 'mtime_modified_during_read'
  | 'bytes_read_mismatch'
  | 'file_replaced_before_open'
  | 'file_replaced_during_read'

/**
 * Outcome when file modification or instability is detected.
 */
export interface HashFileChangedResult {
  readonly status: 'file_changed'
  readonly path: string
  readonly reason: HashChangedReason
  readonly message: string
  readonly expected?: number | string
  readonly actual?: number | string
}

export type HashRejectedReason =
  'symbolic_link' | 'not_regular_file' | 'outside_approved_root' | 'file_size_exceeded'

/**
 * Outcome when file is safely rejected before/after opening without hashing.
 */
export interface HashFileRejectedResult {
  readonly status: 'rejected'
  readonly path: string
  readonly reason: HashRejectedReason
  readonly message: string
}

export type HashErrorCode = 'file_not_found' | 'permission_denied' | 'io_error'

/**
 * Outcome when a filesystem I/O error occurs.
 */
export interface HashFileErrorResult {
  readonly status: 'error'
  readonly path: string
  readonly code: HashErrorCode
  readonly message: string
  readonly errno?: string
}

/**
 * Discriminated union of all possible hashFile outcomes.
 * Note: partial digests are never returned on non-success outcomes.
 */
export type HashFileResult =
  | HashFileSuccessResult
  | HashFileCancelledResult
  | HashFileChangedResult
  | HashFileRejectedResult
  | HashFileErrorResult
