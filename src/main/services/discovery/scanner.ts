import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createNodeReadOnlyFsAdapter } from './fs-adapter'
import {
  evaluateDirectoryEntry,
  evaluateFileEntry,
  normalizePathForComparison,
  resolveDiscoveryPolicy
} from './policy'
import type {
  DiscoveredCandidate,
  DiscoveryError,
  DiscoveryErrorCode,
  DiscoveryOptions,
  DiscoveryResult,
  DiscoverySkip
} from './types'

function toHonestIsoTimestamp(ms: number): string | null {
  if (!Number.isFinite(ms) || ms <= 0) {
    return null
  }
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export function isInsideApprovedRoot(canonicalRoot: string, candidateRealPath: string): boolean {
  const normRoot = normalizePathForComparison(canonicalRoot)
  const normCandidate = normalizePathForComparison(candidateRealPath)
  const rel = relative(normRoot, normCandidate)
  if (rel === '') return true
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return false
  }
  return true
}

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
  fallback: DiscoveryErrorCode
): { code: DiscoveryErrorCode; errno?: string; message: string } {
  const errno = getErrnoCode(error)
  const message = getErrorMessage(error)
  if (errno === 'ENOENT') {
    return {
      code: fallback === 'root_not_found' ? 'root_not_found' : 'entry_disappeared',
      errno,
      message
    }
  }
  if (errno === 'EACCES' || errno === 'EPERM') {
    return { code: 'permission_denied', errno, message }
  }
  return { code: fallback, errno, message }
}

/**
 * Incrementally traverses the supplied source roots in read-only mode.
 *
 * - Keeps at most one directory handle open at any time (`O(1)` file descriptors).
 * - Closes the active directory handle in a `finally` block on completion, error, or abort.
 * - Never traverses symbolic links, directory junctions, or paths resolving outside the canonical root.
 */
export async function discoverFiles(options: DiscoveryOptions): Promise<DiscoveryResult> {
  const fsAdapter = options.fsAdapter ?? createNodeReadOnlyFsAdapter()
  const policy = resolveDiscoveryPolicy(options.policy)
  const signal = options.signal

  const candidates: DiscoveredCandidate[] = []
  const skips: DiscoverySkip[] = []
  const errors: DiscoveryError[] = []
  let directoriesVisited = 0

  const buildResult = (status: 'completed' | 'cancelled'): DiscoveryResult => ({
    status,
    candidates,
    skips,
    errors,
    stats: {
      rootsRequested: options.roots.length,
      directoriesVisited,
      candidatesFound: candidates.length,
      skippedCount: skips.length,
      errorCount: errors.length
    }
  })

  for (const rawRoot of options.roots) {
    if (signal?.aborted) {
      return buildResult('cancelled')
    }

    const rootPath = resolve(rawRoot)

    let rootStats
    try {
      rootStats = await fsAdapter.lstat(rootPath)
    } catch (error) {
      const classified = classifyFsError(error, 'root_not_found')
      errors.push({
        path: rootPath,
        code: classified.code,
        message: classified.message,
        errno: classified.errno
      })
      continue
    }

    if (rootStats.isSymbolicLink()) {
      skips.push({
        path: rootPath,
        reason: 'symbolic_link_or_junction',
        detail: 'Source root is a symbolic link or directory junction'
      })
      continue
    }

    if (!rootStats.isDirectory()) {
      errors.push({
        path: rootPath,
        code: 'root_not_directory',
        message: 'Source root is not a directory'
      })
      continue
    }

    let canonicalRoot: string
    try {
      canonicalRoot = await fsAdapter.realpath(rootPath)
    } catch (error) {
      const classified = classifyFsError(error, 'unreadable_directory')
      errors.push({
        path: rootPath,
        code: classified.code,
        message: classified.message,
        errno: classified.errno
      })
      continue
    }

    const queue: string[] = [rootPath]

    while (queue.length > 0) {
      if (signal?.aborted) {
        return buildResult('cancelled')
      }

      const currentDir = queue.shift()!

      let dirHandle
      try {
        dirHandle = await fsAdapter.opendir(currentDir)
      } catch (error) {
        const classified = classifyFsError(error, 'unreadable_directory')
        errors.push({
          path: currentDir,
          code: classified.code,
          message: classified.message,
          errno: classified.errno
        })
        continue
      }

      directoriesVisited++
      const discoveredSubdirs: string[] = []

      try {
        while (true) {
          if (signal?.aborted) {
            return buildResult('cancelled')
          }

          let entry
          try {
            entry = await dirHandle.read()
          } catch (error) {
            const classified = classifyFsError(error, 'unreadable_directory')
            errors.push({
              path: currentDir,
              code: classified.code,
              message: classified.message,
              errno: classified.errno
            })
            break
          }

          if (entry === null) {
            break
          }

          if (signal?.aborted) {
            return buildResult('cancelled')
          }

          const entryName = entry.name || basename(currentDir)
          const entryPath = join(currentDir, entryName)

          if (entry.isSymbolicLink()) {
            skips.push({
              path: entryPath,
              reason: 'symbolic_link_or_junction',
              detail: `Entry "${entryName}" is a symbolic link or directory junction`
            })
            continue
          }

          if (entry.isDirectory()) {
            const dirDecision = evaluateDirectoryEntry(entryPath, entryName, policy)
            if (dirDecision.action === 'skip') {
              skips.push({
                path: entryPath,
                reason: dirDecision.reason,
                detail: dirDecision.detail
              })
              continue
            }

            let subStats
            try {
              subStats = await fsAdapter.lstat(entryPath)
            } catch (error) {
              const classified = classifyFsError(error, 'unreadable_entry')
              errors.push({
                path: entryPath,
                code: classified.code,
                message: classified.message,
                errno: classified.errno
              })
              continue
            }

            if (subStats.isSymbolicLink()) {
              skips.push({
                path: entryPath,
                reason: 'symbolic_link_or_junction',
                detail: `Directory "${entryName}" is a symbolic link or junction`
              })
              continue
            }

            if (!subStats.isDirectory()) {
              skips.push({
                path: entryPath,
                reason: 'non_regular_entry',
                detail: `Entry "${entryName}" is no longer a directory`
              })
              continue
            }

            let realSubPath: string
            try {
              realSubPath = await fsAdapter.realpath(entryPath)
            } catch (error) {
              const classified = classifyFsError(error, 'unreadable_directory')
              errors.push({
                path: entryPath,
                code: classified.code,
                message: classified.message,
                errno: classified.errno
              })
              continue
            }

            if (!isInsideApprovedRoot(canonicalRoot, realSubPath)) {
              skips.push({
                path: entryPath,
                reason: 'outside_approved_root',
                detail: `Directory resolves outside approved root (${canonicalRoot})`
              })
              continue
            }

            discoveredSubdirs.push(entryPath)
            continue
          }

          if (entry.isFile()) {
            const fileDecision = evaluateFileEntry(entryName, policy)
            if (fileDecision.action === 'skip') {
              skips.push({
                path: entryPath,
                reason: fileDecision.reason,
                detail: fileDecision.detail
              })
              continue
            }

            let fileStats
            try {
              fileStats = await fsAdapter.lstat(entryPath)
            } catch (error) {
              const classified = classifyFsError(error, 'unreadable_entry')
              errors.push({
                path: entryPath,
                code: classified.code,
                message: classified.message,
                errno: classified.errno
              })
              continue
            }

            if (fileStats.isSymbolicLink()) {
              skips.push({
                path: entryPath,
                reason: 'symbolic_link_or_junction',
                detail: `File "${entryName}" is a symbolic link`
              })
              continue
            }

            if (!fileStats.isFile()) {
              skips.push({
                path: entryPath,
                reason: 'non_regular_entry',
                detail: `Entry "${entryName}" is not a regular file`
              })
              continue
            }

            let realFilePath: string
            try {
              realFilePath = await fsAdapter.realpath(entryPath)
            } catch (error) {
              const classified = classifyFsError(error, 'unreadable_entry')
              errors.push({
                path: entryPath,
                code: classified.code,
                message: classified.message,
                errno: classified.errno
              })
              continue
            }

            if (!isInsideApprovedRoot(canonicalRoot, realFilePath)) {
              skips.push({
                path: entryPath,
                reason: 'outside_approved_root',
                detail: `File resolves outside approved root (${canonicalRoot})`
              })
              continue
            }

            const candidate: DiscoveredCandidate = {
              rootPath,
              absolutePath: entryPath,
              fileName: entryName,
              extension: fileDecision.extension,
              candidateKind: fileDecision.candidateKind,
              byteSize: fileStats.size,
              filesystemCreatedAt: toHonestIsoTimestamp(fileStats.birthtimeMs),
              filesystemModifiedAt: toHonestIsoTimestamp(fileStats.mtimeMs)
            }

            candidates.push(candidate)
            options.onCandidate?.(candidate)
            continue
          }

          skips.push({
            path: entryPath,
            reason: 'non_regular_entry',
            detail: `Entry "${entryName}" is neither a regular file nor a directory`
          })
        }
      } finally {
        await dirHandle.close()
      }

      for (const subdir of discoveredSubdirs) {
        queue.push(subdir)
      }
    }
  }

  return buildResult(signal?.aborted ? 'cancelled' : 'completed')
}
