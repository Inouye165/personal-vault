/**
 * Personal Vault — Shared Bounded Read-Only Document Source Reader
 *
 * Enforces approved-root canonical containment, symlink/junction rejection,
 * pre/post `lstat` <-> `fstat` descriptor identity binding, live streaming SHA-256
 * verification, and a MANDATORY caller-supplied `maxInputBytes` limit so
 * Stage 7B native extraction (`32 MiB`) and Stage 7C OCR (`64 MiB`) never silently
 * inherit each other's cap.
 */

import { createHash } from 'node:crypto'
import { lstat, open, realpath } from 'node:fs/promises'
import { isTimestampConsistentWithExpectation } from '../hashing/hasher'
import { isPathContainedInRoot } from '../hashing/path-security'

const STREAM_CHUNK_BYTES = 64 * 1024

export interface DocumentSourceReaderFsDeps {
  readonly lstat: typeof lstat
  readonly realpath: typeof realpath
  readonly open: typeof open
}

export const DEFAULT_SOURCE_READER_FS_DEPS: DocumentSourceReaderFsDeps = {
  lstat,
  realpath,
  open
}

export interface ExplicitSourceReadRequest {
  readonly sourcePath: string
  readonly approvedRoots: readonly string[]
  readonly expectedByteSize: number
  readonly expectedMtimeMs: number | null
  readonly expectedSha256: string | null
  readonly maxInputBytes: number
}

export type ExplicitSourceReadResult =
  | {
      readonly ok: true
      readonly buffer: Buffer | null
      readonly oversizedBytes: number | null
      readonly observedSha256: string
      readonly observedByteSize: number
      readonly observedMtimeMs: number | null
    }
  | {
      readonly ok: false
      readonly errorCode: string
      readonly errorMessage: string
    }

async function assertSourcePathAllowed(
  sourcePath: string,
  approvedRoots: readonly string[],
  fsDeps: DocumentSourceReaderFsDeps
): Promise<{ canonicalSource: string; preLstat: Awaited<ReturnType<typeof lstat>> }> {
  const sourceLstat = await fsDeps.lstat(sourcePath, { bigint: false })
  if (sourceLstat.isSymbolicLink() || !sourceLstat.isFile()) {
    throw new Error('Source path is a symbolic link or not a regular file')
  }
  const canonicalSource = await fsDeps.realpath(sourcePath)
  for (const root of approvedRoots) {
    try {
      const rootLstat = await fsDeps.lstat(root, { bigint: false })
      if (rootLstat.isSymbolicLink() || !rootLstat.isDirectory()) {
        continue
      }
      const canonicalRoot = await fsDeps.realpath(root)
      if (isPathContainedInRoot(canonicalRoot, canonicalSource)) {
        return { canonicalSource, preLstat: sourceLstat }
      }
    } catch {
      // Try next approved root
    }
  }
  throw new Error('Source path is outside approved roots')
}

export async function readAndVerifySourceWithExplicitLimit(
  req: ExplicitSourceReadRequest,
  fsDeps: DocumentSourceReaderFsDeps = DEFAULT_SOURCE_READER_FS_DEPS
): Promise<ExplicitSourceReadResult> {
  if (!Number.isSafeInteger(req.maxInputBytes) || req.maxInputBytes <= 0) {
    throw new RangeError('maxInputBytes must be an explicit positive safe integer')
  }

  if (!req.approvedRoots || req.approvedRoots.length === 0) {
    return {
      ok: false,
      errorCode: 'SECURITY_REJECTED',
      errorMessage: 'approvedRoots must be non-empty'
    }
  }

  let canonicalPath: string
  let preLstat: Awaited<ReturnType<typeof lstat>>
  try {
    const allowed = await assertSourcePathAllowed(req.sourcePath, req.approvedRoots, fsDeps)
    canonicalPath = allowed.canonicalSource
    preLstat = allowed.preLstat
  } catch (err: unknown) {
    return {
      ok: false,
      errorCode: 'SECURITY_REJECTED',
      errorMessage: err instanceof Error ? err.message : String(err)
    }
  }

  const maxInputBytes = req.maxInputBytes
  let handle: Awaited<ReturnType<typeof open>> | null = null

  try {
    handle = await fsDeps.open(req.sourcePath, 'r')
    const preStat = await handle.stat({ bigint: false })
    if (!preStat.isFile()) {
      return {
        ok: false,
        errorCode: 'NOT_A_FILE',
        errorMessage: 'Target is not a regular file'
      }
    }
    if (
      preStat.size !== preLstat.size ||
      preStat.mtimeMs !== preLstat.mtimeMs ||
      (preStat.ino !== undefined &&
        preLstat.ino !== undefined &&
        (preStat.ino !== preLstat.ino || preStat.dev !== preLstat.dev))
    ) {
      return {
        ok: false,
        errorCode: 'FILE_CHANGED',
        errorMessage: 'Source pathname identity changed between lstat and open'
      }
    }

    const observedByteSize = preStat.size
    const observedMtimeMs = Number.isFinite(preStat.mtimeMs) ? preStat.mtimeMs : null

    if (observedByteSize !== req.expectedByteSize) {
      return {
        ok: false,
        errorCode: 'FILE_CHANGED',
        errorMessage: `Source byte size changed (expected ${req.expectedByteSize}, got ${observedByteSize})`
      }
    }

    const mtimeMatches =
      observedMtimeMs === null || req.expectedMtimeMs === null
        ? observedMtimeMs === req.expectedMtimeMs
        : isTimestampConsistentWithExpectation(observedMtimeMs, req.expectedMtimeMs)
    if (!mtimeMatches) {
      return {
        ok: false,
        errorCode: 'FILE_CHANGED',
        errorMessage: 'Source modification timestamp changed since discovery'
      }
    }

    const isOversized = observedByteSize > maxInputBytes
    const hasher = createHash('sha256')
    const chunks: Buffer[] = []
    const chunkBuf = Buffer.allocUnsafe(STREAM_CHUNK_BYTES)
    let totalRead = 0

    while (true) {
      const { bytesRead } = await handle.read(chunkBuf, 0, STREAM_CHUNK_BYTES, totalRead)
      if (bytesRead === 0) break
      const slice = chunkBuf.subarray(0, bytesRead)
      hasher.update(slice)
      totalRead += bytesRead

      if (totalRead > maxInputBytes && !isOversized) {
        return {
          ok: false,
          errorCode: 'FILE_CHANGED',
          errorMessage: 'Source file grew beyond input limit while reading'
        }
      }
      if (!isOversized) {
        chunks.push(Buffer.from(slice))
      }
    }

    const postStat = await handle.stat({ bigint: false })
    if (
      postStat.size !== preStat.size ||
      postStat.mtimeMs !== preStat.mtimeMs ||
      postStat.ino !== preStat.ino ||
      postStat.dev !== preStat.dev
    ) {
      return {
        ok: false,
        errorCode: 'FILE_CHANGED',
        errorMessage: 'Source file changed during read'
      }
    }

    const postLstat = await fsDeps.lstat(req.sourcePath, { bigint: false })
    if (postLstat.isSymbolicLink() || !postLstat.isFile()) {
      return {
        ok: false,
        errorCode: 'FILE_CHANGED',
        errorMessage: 'Source pathname changed to a symbolic link or non-file during read'
      }
    }
    if (
      postLstat.size !== postStat.size ||
      postLstat.mtimeMs !== postStat.mtimeMs ||
      (postLstat.ino !== undefined &&
        postStat.ino !== undefined &&
        (postLstat.ino !== postStat.ino || postLstat.dev !== postStat.dev))
    ) {
      return {
        ok: false,
        errorCode: 'FILE_CHANGED',
        errorMessage: 'Source pathname identity or metadata changed during read (file replaced)'
      }
    }
    const postRealpath = await fsDeps.realpath(req.sourcePath)
    if (postRealpath !== canonicalPath) {
      return {
        ok: false,
        errorCode: 'FILE_CHANGED',
        errorMessage: 'Source canonical path changed during read'
      }
    }

    const observedSha256 = hasher.digest('hex')
    if (req.expectedSha256 !== null && req.expectedSha256.toLowerCase() !== observedSha256) {
      return {
        ok: false,
        errorCode: 'FILE_CHANGED',
        errorMessage: 'Source SHA-256 digest changed since catalog hash'
      }
    }

    return {
      ok: true,
      buffer: isOversized ? null : Buffer.concat(chunks),
      oversizedBytes: isOversized ? observedByteSize : null,
      observedSha256,
      observedByteSize,
      observedMtimeMs
    }
  } catch (err: unknown) {
    return {
      ok: false,
      errorCode: 'IO_ERROR',
      errorMessage: err instanceof Error ? err.message : String(err)
    }
  } finally {
    if (handle) {
      try {
        await handle.close()
      } catch {
        // Ignore close error if primary result already captured
      }
    }
  }
}
