import { basename, isAbsolute, relative, sep } from 'node:path'
import type { ReadOnlyFsAdapter } from './fs-adapter'
import { inspectMediaFileByContent } from '../video/inspector'
import {
  evaluateDirectoryEntry,
  evaluateFileEntry,
  normalizePathForComparison,
  type ResolvedDiscoveryPolicy
} from './policy'
import type {
  DiscoveredCandidate,
  DiscoveryError,
  DiscoveryErrorCode,
  DiscoverySkip
} from './types'

export function toHonestIsoTimestamp(ms: number): string | null {
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

export function classifyFsError(
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

export type DirectoryInspectionContext =
  | { readonly kind: 'root' }
  | { readonly kind: 'child'; readonly canonicalRoot: string }
  | {
      readonly kind: 'queued'
      readonly canonicalRoot: string
      readonly expectedRealPath: string
    }

export type DirectoryInspectionOutcome =
  | { readonly outcome: 'ok'; readonly canonicalPath: string }
  | { readonly outcome: 'skip'; readonly skip: DiscoverySkip }
  | { readonly outcome: 'error'; readonly error: DiscoveryError }
  | { readonly outcome: 'cancelled' }

/**
 * Shared validation for source roots, newly discovered subdirectories, and queued
 * directories immediately before `opendir`.
 *
 * Evaluates policy exclusions before `lstat`, verifies regular directory status and
 * absence of symlinks/junctions, resolves `realpath`, checks approved-root containment,
 * and re-evaluates policy on the canonical path when it differs from `dirPath`.
 */
export async function inspectDirectoryTarget(params: {
  readonly dirPath: string
  readonly dirName: string
  readonly context: DirectoryInspectionContext
  readonly policy: ResolvedDiscoveryPolicy
  readonly fsAdapter: ReadOnlyFsAdapter
  readonly signal?: AbortSignal
}): Promise<DirectoryInspectionOutcome> {
  const { dirPath, dirName, context, policy, fsAdapter, signal } = params

  if (signal?.aborted) {
    return { outcome: 'cancelled' }
  }

  const policyDecision = evaluateDirectoryEntry(dirPath, dirName, policy)
  if (policyDecision.action === 'skip') {
    return {
      outcome: 'skip',
      skip: {
        path: dirPath,
        reason: policyDecision.reason,
        detail: policyDecision.detail
      }
    }
  }

  const lstatFallback: DiscoveryErrorCode =
    context.kind === 'root'
      ? 'root_not_found'
      : context.kind === 'child'
        ? 'unreadable_entry'
        : 'unreadable_directory'

  let stats
  try {
    stats = await fsAdapter.lstat(dirPath)
  } catch (error) {
    if (signal?.aborted) {
      return { outcome: 'cancelled' }
    }
    const classified = classifyFsError(error, lstatFallback)
    return {
      outcome: 'error',
      error: {
        path: dirPath,
        code: classified.code,
        message: classified.message,
        errno: classified.errno
      }
    }
  }

  if (signal?.aborted) {
    return { outcome: 'cancelled' }
  }

  if (stats.isSymbolicLink()) {
    return {
      outcome: 'skip',
      skip: {
        path: dirPath,
        reason: 'symbolic_link_or_junction',
        detail:
          context.kind === 'root'
            ? 'Source root is a symbolic link or directory junction'
            : context.kind === 'queued'
              ? `Queued directory "${dirName}" changed into a symbolic link or junction before opening`
              : `Directory "${dirName}" is a symbolic link or junction`
      }
    }
  }

  if (!stats.isDirectory()) {
    if (context.kind === 'root') {
      return {
        outcome: 'error',
        error: {
          path: dirPath,
          code: 'root_not_directory',
          message: 'Source root is not a directory'
        }
      }
    }
    return {
      outcome: 'skip',
      skip: {
        path: dirPath,
        reason: 'non_regular_entry',
        detail:
          context.kind === 'queued'
            ? `Queued directory "${dirName}" is no longer a directory before opening`
            : `Entry "${dirName}" is no longer a directory`
      }
    }
  }

  let realPath: string
  try {
    realPath = await fsAdapter.realpath(dirPath)
  } catch (error) {
    if (signal?.aborted) {
      return { outcome: 'cancelled' }
    }
    const classified = classifyFsError(error, 'unreadable_directory')
    return {
      outcome: 'error',
      error: {
        path: dirPath,
        code: classified.code,
        message: classified.message,
        errno: classified.errno
      }
    }
  }

  if (signal?.aborted) {
    return { outcome: 'cancelled' }
  }

  if (context.kind !== 'root') {
    const insideRoot = isInsideApprovedRoot(context.canonicalRoot, realPath)
    const canonicalTargetUnchanged =
      context.kind !== 'queued' ||
      normalizePathForComparison(realPath) === normalizePathForComparison(context.expectedRealPath)

    if (!insideRoot || !canonicalTargetUnchanged) {
      return {
        outcome: 'skip',
        skip: {
          path: dirPath,
          reason: 'outside_approved_root',
          detail:
            context.kind === 'queued'
              ? `Queued directory resolves outside approved root or changed canonical target (${realPath})`
              : `Directory resolves outside approved root (${context.canonicalRoot})`
        }
      }
    }
  }

  if (normalizePathForComparison(realPath) !== normalizePathForComparison(dirPath)) {
    const realPolicyDecision = evaluateDirectoryEntry(
      realPath,
      basename(realPath) || dirName,
      policy
    )
    if (realPolicyDecision.action === 'skip') {
      return {
        outcome: 'skip',
        skip: {
          path: dirPath,
          reason: realPolicyDecision.reason,
          detail: realPolicyDecision.detail
        }
      }
    }
  }

  return { outcome: 'ok', canonicalPath: realPath }
}

export type FileInspectionOutcome =
  | { readonly outcome: 'candidate'; readonly candidate: DiscoveredCandidate }
  | { readonly outcome: 'skip'; readonly skip: DiscoverySkip }
  | { readonly outcome: 'error'; readonly error: DiscoveryError }
  | { readonly outcome: 'cancelled' }

/**
 * Inspects a discovered file entry against extension/clutter policy, `lstat`, and
 * `realpath` containment within the canonical approved root.
 */
export async function inspectFileEntry(params: {
  readonly rootPath: string
  readonly canonicalRoot: string
  readonly entryPath: string
  readonly entryName: string
  readonly policy: ResolvedDiscoveryPolicy
  readonly fsAdapter: ReadOnlyFsAdapter
  readonly signal?: AbortSignal
}): Promise<FileInspectionOutcome> {
  const { rootPath, canonicalRoot, entryPath, entryName, policy, fsAdapter, signal } = params

  const fileDecision = evaluateFileEntry(entryName, policy)
  if (fileDecision.action === 'skip') {
    return {
      outcome: 'skip',
      skip: {
        path: entryPath,
        reason: fileDecision.reason,
        detail: fileDecision.detail
      }
    }
  }

  let fileStats
  try {
    fileStats = await fsAdapter.lstat(entryPath)
  } catch (error) {
    if (signal?.aborted) {
      return { outcome: 'cancelled' }
    }
    const classified = classifyFsError(error, 'unreadable_entry')
    return {
      outcome: 'error',
      error: {
        path: entryPath,
        code: classified.code,
        message: classified.message,
        errno: classified.errno
      }
    }
  }

  if (signal?.aborted) {
    return { outcome: 'cancelled' }
  }

  if (fileStats.isSymbolicLink()) {
    return {
      outcome: 'skip',
      skip: {
        path: entryPath,
        reason: 'symbolic_link_or_junction',
        detail: `File "${entryName}" is a symbolic link`
      }
    }
  }

  if (!fileStats.isFile()) {
    return {
      outcome: 'skip',
      skip: {
        path: entryPath,
        reason: 'non_regular_entry',
        detail: `Entry "${entryName}" is not a regular file`
      }
    }
  }

  let realFilePath: string
  try {
    realFilePath = await fsAdapter.realpath(entryPath)
  } catch (error) {
    if (signal?.aborted) {
      return { outcome: 'cancelled' }
    }
    const classified = classifyFsError(error, 'unreadable_entry')
    return {
      outcome: 'error',
      error: {
        path: entryPath,
        code: classified.code,
        message: classified.message,
        errno: classified.errno
      }
    }
  }

  if (signal?.aborted) {
    return { outcome: 'cancelled' }
  }

  if (!isInsideApprovedRoot(canonicalRoot, realFilePath)) {
    return {
      outcome: 'skip',
      skip: {
        path: entryPath,
        reason: 'outside_approved_root',
        detail: `File resolves outside approved root (${canonicalRoot})`
      }
    }
  }

  let mediaKind: 'photo' | 'video' | 'document' = fileDecision.initialMediaKind
  let videoMetadata = null
  if (fileDecision.candidateKind === 'photo') {
    try {
      const inspected = await inspectMediaFileByContent(realFilePath)
      if (inspected.mediaKind === 'video') {
        mediaKind = 'video'
        videoMetadata = inspected.video
      } else {
        mediaKind = 'photo'
      }
    } catch {
      // Keep initial extension-derived kind when file cannot be opened (e.g., mocked fsAdapter)
    }
  }

  return {
    outcome: 'candidate',
    candidate: {
      rootPath,
      absolutePath: entryPath,
      fileName: entryName,
      extension: fileDecision.extension,
      candidateKind: fileDecision.candidateKind,
      mediaKind,
      videoMetadata,
      byteSize: fileStats.size,
      filesystemCreatedAt: toHonestIsoTimestamp(fileStats.birthtimeMs),
      filesystemModifiedAt: toHonestIsoTimestamp(fileStats.mtimeMs)
    }
  }
}
