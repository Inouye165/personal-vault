import { createHash } from 'node:crypto'
import {
  createNodeReadOnlyHashingFsAdapter,
  type ReadOnlyFileHandle,
  type ReadOnlyFileStats,
  type ReadOnlyHashingFsAdapter
} from './fs-adapter'
import { resolveHashingLimits } from './limits'
import { isPathContainedInRoot } from './path-security'
import type {
  HashCandidateExpectation,
  HashErrorCode,
  HashFileErrorResult,
  HashFileOptions,
  HashFileResult,
  ResolvedHashingLimits
} from './types'

function getErrnoCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  return undefined
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

function classifyFsError(
  error: unknown,
  filePath: string,
  fallback: HashErrorCode
): HashFileErrorResult {
  const errno = getErrnoCode(error)
  const message = getErrorMessage(error)
  if (errno === 'ENOENT') {
    return { status: 'error', path: filePath, code: 'file_not_found', message, errno }
  }
  if (errno === 'EACCES' || errno === 'EPERM') {
    return { status: 'error', path: filePath, code: 'permission_denied', message, errno }
  }
  return { status: 'error', path: filePath, code: fallback, message, errno }
}

/**
 * Validates the caller-supplied approved roots array before filesystem work.
 * Throws RangeError if missing, empty, or containing invalid paths.
 */
export function validateApprovedRoots(roots: unknown): readonly string[] {
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new RangeError(
      'Invalid hashing configuration: "approvedRoots" must be a non-empty array of directory paths'
    )
  }
  for (const root of roots) {
    if (typeof root !== 'string' || root.trim() === '') {
      throw new RangeError(
        'Invalid hashing configuration: "approvedRoots" contains an empty or non-string path entry'
      )
    }
  }
  return roots
}

/**
 * Compares a live timestamp against a discovery expectation.
 *
 * If the expectation was recorded as an integer (e.g. from an ISO string or catalog
 * serialization where sub-millisecond precision was truncated), tolerates differences
 * strictly within 1.0 ms (|live - expected| < 1.0 ms) while detecting any real shift >= 1 ms.
 * If the expectation has fractional milliseconds, exact comparison is enforced.
 */
export function isTimestampConsistentWithExpectation(liveMs: number, expectedMs: number): boolean {
  if (Number.isInteger(expectedMs)) {
    return Math.abs(liveMs - expectedMs) < 1.0
  }
  return liveMs === expectedMs
}

interface ProcessHandleParams {
  readonly handle: ReadOnlyFileHandle
  readonly filePath: string
  readonly canonicalPath: string
  readonly lstatResult: ReadOnlyFileStats
  readonly canonicalApprovedRoots: readonly string[]
  readonly limits: ResolvedHashingLimits
  readonly expectation?: HashCandidateExpectation
  readonly signal?: AbortSignal
  readonly fsAdapter: ReadOnlyHashingFsAdapter
}

/**
 * Inspects the opened descriptor before and after reading, performs streaming SHA-256 chunked
 * hashing, and revalidates the target pathname after reading.
 */
async function processFileDescriptor(params: ProcessHandleParams): Promise<HashFileResult> {
  const {
    handle,
    filePath,
    canonicalPath,
    lstatResult,
    canonicalApprovedRoots,
    limits,
    expectation,
    signal,
    fsAdapter
  } = params

  if (signal?.aborted) {
    return { status: 'cancelled', path: filePath }
  }

  // 1. Pre-read inspection on opened handle (fstat)
  let preStat: ReadOnlyFileStats
  try {
    preStat = await handle.stat()
  } catch (error) {
    return classifyFsError(error, filePath, 'io_error')
  }

  if (!preStat.isFile()) {
    return {
      status: 'rejected',
      path: filePath,
      reason: 'not_regular_file',
      message: `Opened descriptor is not a regular file: "${filePath}"`
    }
  }

  if (limits.maxFileSizeBytes !== undefined && preStat.size > limits.maxFileSizeBytes) {
    return {
      status: 'rejected',
      path: filePath,
      reason: 'file_size_exceeded',
      message: `File size (${preStat.size} bytes) exceeds maximum configured limit (${limits.maxFileSizeBytes} bytes)`
    }
  }

  // Detect changes between lstat and open (preserving fractional millisecond precision)
  if (lstatResult.size !== preStat.size) {
    return {
      status: 'file_changed',
      path: filePath,
      reason: 'size_modified_during_read',
      message: `File size changed between lstat (${lstatResult.size}) and open (${preStat.size})`,
      expected: lstatResult.size,
      actual: preStat.size
    }
  }

  if (lstatResult.mtimeMs !== preStat.mtimeMs) {
    return {
      status: 'file_changed',
      path: filePath,
      reason: 'mtime_modified_during_read',
      message: `File mtime changed between lstat (${lstatResult.mtimeMs}) and open (${preStat.mtimeMs})`,
      expected: lstatResult.mtimeMs,
      actual: preStat.mtimeMs
    }
  }

  if (
    lstatResult.ino !== undefined &&
    preStat.ino !== undefined &&
    (lstatResult.ino !== preStat.ino || lstatResult.dev !== preStat.dev)
  ) {
    return {
      status: 'file_changed',
      path: filePath,
      reason: 'file_replaced_before_open',
      message: 'File descriptor identity (dev/ino) changed between lstat and open'
    }
  }

  // Detect changes compared to discovery expectation
  if (expectation) {
    if (expectation.byteSize !== undefined && preStat.size !== expectation.byteSize) {
      return {
        status: 'file_changed',
        path: filePath,
        reason: 'size_mismatch_discovery',
        message: `File size (${preStat.size} bytes) differs from discovery expectation (${expectation.byteSize} bytes)`,
        expected: expectation.byteSize,
        actual: preStat.size
      }
    }

    if (
      expectation.mtimeMs !== undefined &&
      !isTimestampConsistentWithExpectation(preStat.mtimeMs, expectation.mtimeMs)
    ) {
      return {
        status: 'file_changed',
        path: filePath,
        reason: 'mtime_modified_discovery',
        message: `File mtime (${preStat.mtimeMs}) differs from discovery expectation (${expectation.mtimeMs})`,
        expected: expectation.mtimeMs,
        actual: preStat.mtimeMs
      }
    }

    if (
      expectation.birthtimeMs !== undefined &&
      !isTimestampConsistentWithExpectation(preStat.birthtimeMs, expectation.birthtimeMs)
    ) {
      return {
        status: 'file_changed',
        path: filePath,
        reason: 'birthtime_modified_discovery',
        message: `File birthtime (${preStat.birthtimeMs}) differs from discovery expectation (${expectation.birthtimeMs})`,
        expected: expectation.birthtimeMs,
        actual: preStat.birthtimeMs
      }
    }
  }

  // 2. Bounded streaming chunked read loop
  const hash = createHash('sha256')
  const buffer = Buffer.alloc(limits.chunkSizeBytes)
  let totalBytesRead = 0

  while (true) {
    if (signal?.aborted) {
      return { status: 'cancelled', path: filePath }
    }

    const { bytesRead } = await handle.read(buffer, 0, limits.chunkSizeBytes, null)
    if (bytesRead === 0) {
      break
    }

    totalBytesRead += bytesRead

    if (totalBytesRead > preStat.size) {
      return {
        status: 'file_changed',
        path: filePath,
        reason: 'size_modified_during_read',
        message: `Bytes read (${totalBytesRead}) exceeded pre-stat file size (${preStat.size})`,
        expected: preStat.size,
        actual: totalBytesRead
      }
    }

    if (limits.maxFileSizeBytes !== undefined && totalBytesRead > limits.maxFileSizeBytes) {
      return {
        status: 'rejected',
        path: filePath,
        reason: 'file_size_exceeded',
        message: `Read exceeded maximum configured limit (${limits.maxFileSizeBytes} bytes)`
      }
    }

    hash.update(buffer.subarray(0, bytesRead))
  }

  if (signal?.aborted) {
    return { status: 'cancelled', path: filePath }
  }

  // 3. Post-read verification on descriptor (fstat)
  if (totalBytesRead !== preStat.size) {
    return {
      status: 'file_changed',
      path: filePath,
      reason: 'bytes_read_mismatch',
      message: `Total bytes read (${totalBytesRead}) does not match pre-stat file size (${preStat.size})`,
      expected: preStat.size,
      actual: totalBytesRead
    }
  }

  let postStat: ReadOnlyFileStats
  try {
    postStat = await handle.stat()
  } catch (error) {
    return classifyFsError(error, filePath, 'io_error')
  }

  if (postStat.size !== preStat.size) {
    return {
      status: 'file_changed',
      path: filePath,
      reason: 'size_modified_during_read',
      message: `File size changed during read (pre: ${preStat.size}, post: ${postStat.size})`,
      expected: preStat.size,
      actual: postStat.size
    }
  }

  if (postStat.mtimeMs !== preStat.mtimeMs) {
    return {
      status: 'file_changed',
      path: filePath,
      reason: 'mtime_modified_during_read',
      message: `File modification time changed during read (pre: ${preStat.mtimeMs}, post: ${postStat.mtimeMs})`,
      expected: preStat.mtimeMs,
      actual: postStat.mtimeMs
    }
  }

  if (
    preStat.ino !== undefined &&
    postStat.ino !== undefined &&
    (postStat.ino !== preStat.ino || postStat.dev !== preStat.dev)
  ) {
    return {
      status: 'file_changed',
      path: filePath,
      reason: 'file_replaced_during_read',
      message: 'File descriptor identity (dev/ino) changed during read'
    }
  }

  // 4. Revalidate pathname on disk after reading
  let postPathStat: ReadOnlyFileStats
  try {
    postPathStat = await fsAdapter.lstat(filePath)
  } catch (error) {
    const errno = getErrnoCode(error)
    if (errno === 'ENOENT') {
      return {
        status: 'file_changed',
        path: filePath,
        reason: 'file_replaced_during_read',
        message: 'File pathname disappeared or was removed during read'
      }
    }
    return classifyFsError(error, filePath, 'io_error')
  }

  if (postPathStat.isSymbolicLink()) {
    return {
      status: 'file_changed',
      path: filePath,
      reason: 'file_replaced_during_read',
      message: 'File pathname was replaced with a symbolic link during read'
    }
  }

  if (!postPathStat.isFile()) {
    return {
      status: 'file_changed',
      path: filePath,
      reason: 'file_replaced_during_read',
      message: 'File pathname was replaced with a non-regular file during read'
    }
  }

  if (postPathStat.size !== postStat.size) {
    return {
      status: 'file_changed',
      path: filePath,
      reason: 'size_modified_during_read',
      message: `File pathname size (${postPathStat.size}) differs from descriptor size (${postStat.size}) after read`,
      expected: postStat.size,
      actual: postPathStat.size
    }
  }

  if (postPathStat.mtimeMs !== postStat.mtimeMs) {
    return {
      status: 'file_changed',
      path: filePath,
      reason: 'mtime_modified_during_read',
      message: `File pathname mtime (${postPathStat.mtimeMs}) differs from descriptor mtime (${postStat.mtimeMs}) after read`,
      expected: postStat.mtimeMs,
      actual: postPathStat.mtimeMs
    }
  }

  if (
    postPathStat.ino !== undefined &&
    postStat.ino !== undefined &&
    (postPathStat.ino !== postStat.ino || postPathStat.dev !== postStat.dev)
  ) {
    return {
      status: 'file_changed',
      path: filePath,
      reason: 'file_replaced_during_read',
      message:
        'File pathname on disk identifies a different file (dev/ino) than the opened descriptor'
    }
  }

  let postCanonicalPath: string
  try {
    postCanonicalPath = await fsAdapter.realpath(filePath)
  } catch (error) {
    return classifyFsError(error, filePath, 'io_error')
  }

  if (postCanonicalPath !== canonicalPath) {
    return {
      status: 'file_changed',
      path: filePath,
      reason: 'file_replaced_during_read',
      message: `File canonical path changed from "${canonicalPath}" to "${postCanonicalPath}" during read`
    }
  }

  const postContained = canonicalApprovedRoots.some((root) =>
    isPathContainedInRoot(root, postCanonicalPath)
  )
  if (!postContained) {
    return {
      status: 'file_changed',
      path: filePath,
      reason: 'file_replaced_during_read',
      message: `File canonical path "${postCanonicalPath}" is no longer contained within approved roots`
    }
  }

  if (signal?.aborted) {
    return { status: 'cancelled', path: filePath }
  }

  // 5. Successful digest outcome
  const sha256 = hash.digest('hex')
  return {
    status: 'success',
    path: filePath,
    canonicalPath,
    sha256,
    byteSize: totalBytesRead,
    mtimeMs: postStat.mtimeMs,
    birthtimeMs: postStat.birthtimeMs
  }
}

/**
 * Computes a streaming SHA-256 digest of a target file through a narrow, read-only
 * filesystem boundary.
 *
 * Guarantees:
 * - Constant bounded memory consumption using chunked reads (never buffers whole file).
 * - Identical byte sequences produce identical SHA-256 digests.
 * - Source preservation: strictly read-only access (creation and modification times unchanged;
 *   retains documented OS-managed access time limitation).
 * - Symlinks and non-regular files are rejected without reading.
 * - Mandatory, validated approved root containment enforced against canonical realpaths.
 * - Opened descriptor identity and metadata inspected before and after reading (fstat), preserving
 *   full sub-millisecond precision for live comparisons.
 * - Pathname revalidation after reading to detect post-read replacement, disappearance, link substitution,
 *   or changed canonical destinations.
 *   Note: While pathname and descriptor revalidation drastically narrows the TOCTOU window,
 *   user-space path APIs cannot eliminate every kernel-level filesystem race.
 * - Cooperative AbortSignal cancellation releases resources deterministically.
 * - Surface handle-close failures: otherwise-successful hashing returns a typed error without
 *   a digest if cleanup fails; primary errors are preserved if both processing and cleanup fail.
 * - Clear typed outcomes (success, cancelled, file_changed, rejected, error).
 */
export async function hashFile(options: HashFileOptions): Promise<HashFileResult> {
  const {
    filePath,
    approvedRoots,
    expectation,
    limits: limitsConfig,
    signal,
    fsAdapter: customAdapter
  } = options

  // 1. Validate resource limits and approved roots eagerly before any filesystem access
  const limits = resolveHashingLimits(limitsConfig)
  const validatedRoots = validateApprovedRoots(approvedRoots)
  const fsAdapter: ReadOnlyHashingFsAdapter = customAdapter ?? createNodeReadOnlyHashingFsAdapter()

  // 2. Early cancellation check
  if (signal?.aborted) {
    return { status: 'cancelled', path: filePath }
  }

  // 3. Inspect and canonicalize approved roots, ensuring they are directories
  const canonicalApprovedRoots: string[] = []
  for (const root of validatedRoots) {
    let rootStats: ReadOnlyFileStats
    try {
      rootStats = await fsAdapter.lstat(root)
    } catch {
      continue
    }
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      continue
    }
    try {
      const canonical = await fsAdapter.realpath(root)
      canonicalApprovedRoots.push(canonical)
    } catch {
      continue
    }
  }

  if (canonicalApprovedRoots.length === 0) {
    return {
      status: 'rejected',
      path: filePath,
      reason: 'outside_approved_root',
      message: 'No valid approved root directories exist on the filesystem'
    }
  }

  if (signal?.aborted) {
    return { status: 'cancelled', path: filePath }
  }

  // 4. Pre-open inspection via lstat and realpath
  let lstatResult: ReadOnlyFileStats
  try {
    lstatResult = await fsAdapter.lstat(filePath)
  } catch (error) {
    return classifyFsError(error, filePath, 'file_not_found')
  }

  if (signal?.aborted) {
    return { status: 'cancelled', path: filePath }
  }

  if (lstatResult.isSymbolicLink()) {
    return {
      status: 'rejected',
      path: filePath,
      reason: 'symbolic_link',
      message: `Symbolic link is not allowed: "${filePath}"`
    }
  }

  if (!lstatResult.isFile()) {
    return {
      status: 'rejected',
      path: filePath,
      reason: 'not_regular_file',
      message: `Target is not a regular file: "${filePath}"`
    }
  }

  if (limits.maxFileSizeBytes !== undefined && lstatResult.size > limits.maxFileSizeBytes) {
    return {
      status: 'rejected',
      path: filePath,
      reason: 'file_size_exceeded',
      message: `File size (${lstatResult.size} bytes) exceeds maximum configured limit (${limits.maxFileSizeBytes} bytes)`
    }
  }

  let canonicalPath: string
  try {
    canonicalPath = await fsAdapter.realpath(filePath)
  } catch (error) {
    return classifyFsError(error, filePath, 'io_error')
  }

  if (signal?.aborted) {
    return { status: 'cancelled', path: filePath }
  }

  // Validate approved-root containment against canonical path
  const isContained = canonicalApprovedRoots.some((root) =>
    isPathContainedInRoot(root, canonicalPath)
  )
  if (!isContained) {
    return {
      status: 'rejected',
      path: filePath,
      reason: 'outside_approved_root',
      message: `Canonical path "${canonicalPath}" is not within any approved root`
    }
  }

  if (signal?.aborted) {
    return { status: 'cancelled', path: filePath }
  }

  // 5. Open file handle strictly for reading and process descriptor
  let handle: ReadOnlyFileHandle | null = null
  let outcome: HashFileResult | null = null
  let primaryError: unknown = null

  try {
    handle = await fsAdapter.open(filePath)
    outcome = await processFileDescriptor({
      handle,
      filePath,
      canonicalPath,
      lstatResult,
      canonicalApprovedRoots,
      limits,
      expectation,
      signal,
      fsAdapter
    })
  } catch (error) {
    primaryError = error
    outcome = classifyFsError(error, filePath, 'io_error')
  } finally {
    if (handle) {
      try {
        await handle.close()
      } catch (closeError) {
        if (primaryError !== null) {
          outcome = classifyFsError(primaryError, filePath, 'io_error')
        } else if (outcome === null || outcome.status === 'success') {
          outcome = classifyFsError(closeError, filePath, 'io_error')
        }
      }
    }
  }

  return (
    outcome ??
    classifyFsError(primaryError ?? new Error('Unknown hashing failure'), filePath, 'io_error')
  )
}
