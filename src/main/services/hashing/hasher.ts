import { createHash } from 'node:crypto'
import {
  createNodeReadOnlyHashingFsAdapter,
  type ReadOnlyFileHandle,
  type ReadOnlyHashingFsAdapter
} from './fs-adapter'
import { resolveHashingLimits } from './limits'
import { isPathContainedInRoot } from './path-security'
import type { HashErrorCode, HashFileErrorResult, HashFileOptions, HashFileResult } from './types'

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
 * Computes a streaming SHA-256 digest of a target file through a narrow, read-only
 * filesystem boundary.
 *
 * Guarantees:
 * - Constant bounded memory consumption using chunked reads (never buffers whole file).
 * - Identical byte sequences produce identical SHA-256 digests.
 * - Source preservation: strictly read-only access (creation and modification times unchanged;
 *   retains documented OS-managed access time limitation).
 * - Symlinks and non-regular files are rejected without reading.
 * - Approved root containment enforced against canonical realpaths.
 * - Opened descriptor identity and metadata inspected before and after reading (fstat).
 *   Never returns a successful digest for an unstable or modified read.
 * - Cooperative AbortSignal cancellation releases resources deterministically.
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

  // 1. Validate resource limits eagerly before any filesystem access
  const limits = resolveHashingLimits(limitsConfig)
  const fsAdapter: ReadOnlyHashingFsAdapter = customAdapter ?? createNodeReadOnlyHashingFsAdapter()

  // 2. Early cancellation check
  if (signal?.aborted) {
    return { status: 'cancelled', path: filePath }
  }

  // 3. Pre-open inspection via lstat and realpath
  let lstatResult
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

  // 4. Validate approved-root containment
  if (approvedRoots && approvedRoots.length > 0) {
    let isContained = false
    for (const root of approvedRoots) {
      let canonicalRoot: string
      try {
        canonicalRoot = await fsAdapter.realpath(root)
      } catch {
        continue
      }
      if (isPathContainedInRoot(canonicalRoot, canonicalPath)) {
        isContained = true
        break
      }
    }

    if (!isContained) {
      return {
        status: 'rejected',
        path: filePath,
        reason: 'outside_approved_root',
        message: `Canonical path "${canonicalPath}" is not within any approved root`
      }
    }
  }

  if (signal?.aborted) {
    return { status: 'cancelled', path: filePath }
  }

  // 5. Open file handle strictly for reading
  let handle: ReadOnlyFileHandle
  try {
    handle = await fsAdapter.open(filePath)
  } catch (error) {
    return classifyFsError(error, filePath, 'io_error')
  }

  try {
    if (signal?.aborted) {
      return { status: 'cancelled', path: filePath }
    }

    // 6. Pre-read inspection on opened handle (fstat)
    let preStat
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

    // Detect changes compared to lstat
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

    if (Math.floor(lstatResult.mtimeMs) !== Math.floor(preStat.mtimeMs)) {
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
        Math.floor(preStat.mtimeMs) !== Math.floor(expectation.mtimeMs)
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
        Math.floor(preStat.birthtimeMs) !== Math.floor(expectation.birthtimeMs)
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

    // 7. Bounded streaming chunked read loop
    const hash = createHash('sha256')
    const buffer = Buffer.alloc(limits.chunkSizeBytes)
    let totalBytesRead = 0

    while (true) {
      if (signal?.aborted) {
        return { status: 'cancelled', path: filePath }
      }

      let readResult
      try {
        readResult = await handle.read(buffer, 0, limits.chunkSizeBytes, null)
      } catch (error) {
        return classifyFsError(error, filePath, 'io_error')
      }

      const { bytesRead } = readResult
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

    // 8. Post-read verification
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

    let postStat
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

    if (Math.floor(postStat.mtimeMs) !== Math.floor(preStat.mtimeMs)) {
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

    if (signal?.aborted) {
      return { status: 'cancelled', path: filePath }
    }

    // 9. Return verified digest outcome
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
  } finally {
    try {
      await handle.close()
    } catch {
      // Ignore handle closure failures to prevent masking primary outcome
    }
  }
}
