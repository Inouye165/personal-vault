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
  DiscoveryEvent,
  DiscoveryLimitReached,
  DiscoveryOptions,
  DiscoveryResult,
  DiscoverySkip,
  DiscoveryStatus,
  DiscoverySummary
} from './types'

export const DEFAULT_MAX_PENDING_DIRECTORIES = 10_000
export const DEFAULT_MAX_VISITED_DIRECTORIES = 100_000
export const DEFAULT_MAX_COLLECTED_RECORDS = 50_000

interface QueueNode<T> {
  readonly value: T
  next: QueueNode<T> | null
}

/**
 * Bounded O(1) FIFO queue backed by a singly linked list.
 * Avoids `Array.prototype.shift()` O(n) copying and enforces a hard upper bound on queue size.
 */
export class BoundedFifoQueue<T> {
  private head: QueueNode<T> | null = null
  private tail: QueueNode<T> | null = null
  private count = 0
  public readonly capacity: number

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`BoundedFifoQueue capacity must be a positive integer, got ${capacity}`)
    }
    this.capacity = capacity
  }

  public get size(): number {
    return this.count
  }

  public enqueue(value: T): boolean {
    if (this.count >= this.capacity) {
      return false
    }
    const node: QueueNode<T> = { value, next: null }
    if (this.tail === null) {
      this.head = node
      this.tail = node
    } else {
      this.tail.next = node
      this.tail = node
    }
    this.count++
    return true
  }

  public dequeue(): T | undefined {
    const first = this.head
    if (first === null) {
      return undefined
    }
    this.head = first.next
    if (this.head === null) {
      this.tail = null
    }
    this.count--
    return first.value
  }
}

interface QueuedDirectory {
  readonly dirPath: string
  readonly expectedRealPath: string
  readonly isRoot: boolean
}

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
 * Incrementally scans the supplied source roots in read-only mode, yielding
 * structured `DiscoveryEvent` items (`candidate`, `skip`, `error`) with consumer
 * backpressure.
 *
 * Resource & safety properties:
 * - Does not retain emitted candidates, skips, or errors in memory; summary counters
 *   are tracked independently and returned when the generator completes.
 * - Keeps at most one directory handle open at any time (`O(1)` file descriptors)
 *   and closes the active handle in a `finally` block on completion, abort, limit, or
 *   early consumer termination (`break` / `stream.return()`).
 * - Bounds the pending directory queue via `BoundedFifoQueue` (`maxPendingDirectories`)
 *   and total opened directories (`maxVisitedDirectories`), returning
 *   `status: 'resource_limit_reached'` if exceeded.
 * - Applies explicit path and name-based exclusions to source roots before opening them.
 * - Revalidates each queued directory (`lstat`, `realpath`, policy, and approved-root
 *   containment) immediately before calling `opendir`. Note: path-based user-space
 *   checks narrow the TOCTOU window between queuing and opening, though they do not
 *   replace OS kernel-level `openat` directory-descriptor sandboxing.
 */
interface MutableDiscoveryStats {
  rootsRequested: number
  directoriesVisited: number
  candidatesFound: number
  skippedCount: number
  errorCount: number
}

export async function* scanSourceRoots(
  options: DiscoveryOptions
): AsyncGenerator<DiscoveryEvent, DiscoverySummary, void> {
  return yield* scanSourceRootsInternal(options)
}

async function* scanSourceRootsInternal(
  options: DiscoveryOptions,
  externalStats?: MutableDiscoveryStats
): AsyncGenerator<DiscoveryEvent, DiscoverySummary, void> {
  const fsAdapter = options.fsAdapter ?? createNodeReadOnlyFsAdapter()
  const policy = resolveDiscoveryPolicy(options.policy)
  const signal = options.signal

  const maxPendingDirectories =
    options.limits?.maxPendingDirectories ?? DEFAULT_MAX_PENDING_DIRECTORIES
  const maxVisitedDirectories =
    options.limits?.maxVisitedDirectories ?? DEFAULT_MAX_VISITED_DIRECTORIES

  const stats: MutableDiscoveryStats = externalStats ?? {
    rootsRequested: options.roots.length,
    directoriesVisited: 0,
    candidatesFound: 0,
    skippedCount: 0,
    errorCount: 0
  }
  stats.rootsRequested = options.roots.length

  const buildSummary = (
    status: DiscoveryStatus,
    limitReached?: DiscoveryLimitReached
  ): DiscoverySummary => ({
    status,
    stats: {
      rootsRequested: stats.rootsRequested,
      directoriesVisited: stats.directoriesVisited,
      candidatesFound: stats.candidatesFound,
      skippedCount: stats.skippedCount,
      errorCount: stats.errorCount
    },
    ...(limitReached ? { limitReached } : {})
  })

  const emitSkip = async function* (
    skip: DiscoverySkip
  ): AsyncGenerator<DiscoveryEvent, void, void> {
    stats.skippedCount++
    const event: DiscoveryEvent = { kind: 'skip', skip }
    if (options.onEvent) {
      await options.onEvent(event)
    }
    yield event
  }

  const emitError = async function* (
    error: DiscoveryError
  ): AsyncGenerator<DiscoveryEvent, void, void> {
    stats.errorCount++
    const event: DiscoveryEvent = { kind: 'error', error }
    if (options.onEvent) {
      await options.onEvent(event)
    }
    yield event
  }

  const emitCandidate = async function* (
    candidate: DiscoveredCandidate
  ): AsyncGenerator<DiscoveryEvent, void, void> {
    stats.candidatesFound++
    const event: DiscoveryEvent = { kind: 'candidate', candidate }
    if (options.onCandidate) {
      await options.onCandidate(candidate)
    }
    if (options.onEvent) {
      await options.onEvent(event)
    }
    yield event
  }

  for (const rawRoot of options.roots) {
    if (signal?.aborted) {
      return buildSummary('cancelled')
    }

    const rootPath = resolve(rawRoot)
    const rootName = basename(rootPath) || rootPath

    const rootDecision = evaluateDirectoryEntry(rootPath, rootName, policy)
    if (rootDecision.action === 'skip') {
      yield* emitSkip({
        path: rootPath,
        reason: rootDecision.reason,
        detail: rootDecision.detail
      })
      continue
    }

    let rootStats
    try {
      rootStats = await fsAdapter.lstat(rootPath)
    } catch (error) {
      if (signal?.aborted) {
        return buildSummary('cancelled')
      }
      const classified = classifyFsError(error, 'root_not_found')
      yield* emitError({
        path: rootPath,
        code: classified.code,
        message: classified.message,
        errno: classified.errno
      })
      continue
    }

    if (signal?.aborted) {
      return buildSummary('cancelled')
    }

    if (rootStats.isSymbolicLink()) {
      yield* emitSkip({
        path: rootPath,
        reason: 'symbolic_link_or_junction',
        detail: 'Source root is a symbolic link or directory junction'
      })
      continue
    }

    if (!rootStats.isDirectory()) {
      yield* emitError({
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
      if (signal?.aborted) {
        return buildSummary('cancelled')
      }
      const classified = classifyFsError(error, 'unreadable_directory')
      yield* emitError({
        path: rootPath,
        code: classified.code,
        message: classified.message,
        errno: classified.errno
      })
      continue
    }

    if (signal?.aborted) {
      return buildSummary('cancelled')
    }

    if (normalizePathForComparison(canonicalRoot) !== normalizePathForComparison(rootPath)) {
      const canonicalRootDecision = evaluateDirectoryEntry(
        canonicalRoot,
        basename(canonicalRoot) || canonicalRoot,
        policy
      )
      if (canonicalRootDecision.action === 'skip') {
        yield* emitSkip({
          path: rootPath,
          reason: canonicalRootDecision.reason,
          detail: canonicalRootDecision.detail
        })
        continue
      }
    }

    const pendingDirs = new BoundedFifoQueue<QueuedDirectory>(maxPendingDirectories)
    pendingDirs.enqueue({
      dirPath: rootPath,
      expectedRealPath: canonicalRoot,
      isRoot: true
    })

    while (pendingDirs.size > 0) {
      if (signal?.aborted) {
        return buildSummary('cancelled')
      }

      const queued = pendingDirs.dequeue()!
      const currentDir = queued.dirPath

      if (!queued.isRoot) {
        const currentName = basename(currentDir) || currentDir
        const recheckedPolicy = evaluateDirectoryEntry(currentDir, currentName, policy)
        if (recheckedPolicy.action === 'skip') {
          yield* emitSkip({
            path: currentDir,
            reason: recheckedPolicy.reason,
            detail: recheckedPolicy.detail
          })
          continue
        }

        let currentStats
        try {
          currentStats = await fsAdapter.lstat(currentDir)
        } catch (error) {
          if (signal?.aborted) {
            return buildSummary('cancelled')
          }
          const classified = classifyFsError(error, 'unreadable_directory')
          yield* emitError({
            path: currentDir,
            code: classified.code,
            message: classified.message,
            errno: classified.errno
          })
          continue
        }

        if (signal?.aborted) {
          return buildSummary('cancelled')
        }

        if (currentStats.isSymbolicLink()) {
          yield* emitSkip({
            path: currentDir,
            reason: 'symbolic_link_or_junction',
            detail: `Queued directory "${currentName}" changed into a symbolic link or junction before opening`
          })
          continue
        }

        if (!currentStats.isDirectory()) {
          yield* emitSkip({
            path: currentDir,
            reason: 'non_regular_entry',
            detail: `Queued directory "${currentName}" is no longer a directory before opening`
          })
          continue
        }

        let currentRealPath: string
        try {
          currentRealPath = await fsAdapter.realpath(currentDir)
        } catch (error) {
          if (signal?.aborted) {
            return buildSummary('cancelled')
          }
          const classified = classifyFsError(error, 'unreadable_directory')
          yield* emitError({
            path: currentDir,
            code: classified.code,
            message: classified.message,
            errno: classified.errno
          })
          continue
        }

        if (signal?.aborted) {
          return buildSummary('cancelled')
        }

        if (
          !isInsideApprovedRoot(canonicalRoot, currentRealPath) ||
          normalizePathForComparison(currentRealPath) !==
            normalizePathForComparison(queued.expectedRealPath)
        ) {
          yield* emitSkip({
            path: currentDir,
            reason: 'outside_approved_root',
            detail: `Queued directory resolves outside approved root or changed canonical target (${currentRealPath})`
          })
          continue
        }

        if (
          normalizePathForComparison(currentRealPath) !== normalizePathForComparison(currentDir)
        ) {
          const realPolicyDecision = evaluateDirectoryEntry(
            currentRealPath,
            basename(currentRealPath) || currentRealPath,
            policy
          )
          if (realPolicyDecision.action === 'skip') {
            yield* emitSkip({
              path: currentDir,
              reason: realPolicyDecision.reason,
              detail: realPolicyDecision.detail
            })
            continue
          }
        }
      }

      if (stats.directoriesVisited >= maxVisitedDirectories) {
        return buildSummary('resource_limit_reached', {
          limit: 'maxVisitedDirectories',
          maxAllowed: maxVisitedDirectories,
          observed: stats.directoriesVisited + 1,
          message: `Maximum visited directories limit (${maxVisitedDirectories}) reached before opening "${currentDir}"`
        })
      }

      let dirHandle
      try {
        dirHandle = await fsAdapter.opendir(currentDir)
      } catch (error) {
        if (signal?.aborted) {
          return buildSummary('cancelled')
        }
        const classified = classifyFsError(error, 'unreadable_directory')
        yield* emitError({
          path: currentDir,
          code: classified.code,
          message: classified.message,
          errno: classified.errno
        })
        continue
      }

      stats.directoriesVisited++

      try {
        while (true) {
          if (signal?.aborted) {
            return buildSummary('cancelled')
          }

          let entry
          try {
            entry = await dirHandle.read()
          } catch (error) {
            if (signal?.aborted) {
              return buildSummary('cancelled')
            }
            const classified = classifyFsError(error, 'unreadable_directory')
            yield* emitError({
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
            return buildSummary('cancelled')
          }

          const entryName = entry.name || basename(currentDir)
          const entryPath = join(currentDir, entryName)

          if (entry.isSymbolicLink()) {
            yield* emitSkip({
              path: entryPath,
              reason: 'symbolic_link_or_junction',
              detail: `Entry "${entryName}" is a symbolic link or directory junction`
            })
            continue
          }

          if (entry.isDirectory()) {
            const dirDecision = evaluateDirectoryEntry(entryPath, entryName, policy)
            if (dirDecision.action === 'skip') {
              yield* emitSkip({
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
              if (signal?.aborted) {
                return buildSummary('cancelled')
              }
              const classified = classifyFsError(error, 'unreadable_entry')
              yield* emitError({
                path: entryPath,
                code: classified.code,
                message: classified.message,
                errno: classified.errno
              })
              continue
            }

            if (signal?.aborted) {
              return buildSummary('cancelled')
            }

            if (subStats.isSymbolicLink()) {
              yield* emitSkip({
                path: entryPath,
                reason: 'symbolic_link_or_junction',
                detail: `Directory "${entryName}" is a symbolic link or junction`
              })
              continue
            }

            if (!subStats.isDirectory()) {
              yield* emitSkip({
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
              if (signal?.aborted) {
                return buildSummary('cancelled')
              }
              const classified = classifyFsError(error, 'unreadable_directory')
              yield* emitError({
                path: entryPath,
                code: classified.code,
                message: classified.message,
                errno: classified.errno
              })
              continue
            }

            if (signal?.aborted) {
              return buildSummary('cancelled')
            }

            if (!isInsideApprovedRoot(canonicalRoot, realSubPath)) {
              yield* emitSkip({
                path: entryPath,
                reason: 'outside_approved_root',
                detail: `Directory resolves outside approved root (${canonicalRoot})`
              })
              continue
            }

            if (normalizePathForComparison(realSubPath) !== normalizePathForComparison(entryPath)) {
              const realSubDecision = evaluateDirectoryEntry(
                realSubPath,
                basename(realSubPath) || entryName,
                policy
              )
              if (realSubDecision.action === 'skip') {
                yield* emitSkip({
                  path: entryPath,
                  reason: realSubDecision.reason,
                  detail: realSubDecision.detail
                })
                continue
              }
            }

            const enqueued = pendingDirs.enqueue({
              dirPath: entryPath,
              expectedRealPath: realSubPath,
              isRoot: false
            })
            if (!enqueued) {
              return buildSummary('resource_limit_reached', {
                limit: 'maxPendingDirectories',
                maxAllowed: maxPendingDirectories,
                observed: pendingDirs.size + 1,
                message: `Maximum pending directories limit (${maxPendingDirectories}) reached while queueing "${entryPath}"`
              })
            }
            continue
          }

          if (entry.isFile()) {
            const fileDecision = evaluateFileEntry(entryName, policy)
            if (fileDecision.action === 'skip') {
              yield* emitSkip({
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
              if (signal?.aborted) {
                return buildSummary('cancelled')
              }
              const classified = classifyFsError(error, 'unreadable_entry')
              yield* emitError({
                path: entryPath,
                code: classified.code,
                message: classified.message,
                errno: classified.errno
              })
              continue
            }

            if (signal?.aborted) {
              return buildSummary('cancelled')
            }

            if (fileStats.isSymbolicLink()) {
              yield* emitSkip({
                path: entryPath,
                reason: 'symbolic_link_or_junction',
                detail: `File "${entryName}" is a symbolic link`
              })
              continue
            }

            if (!fileStats.isFile()) {
              yield* emitSkip({
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
              if (signal?.aborted) {
                return buildSummary('cancelled')
              }
              const classified = classifyFsError(error, 'unreadable_entry')
              yield* emitError({
                path: entryPath,
                code: classified.code,
                message: classified.message,
                errno: classified.errno
              })
              continue
            }

            if (signal?.aborted) {
              return buildSummary('cancelled')
            }

            if (!isInsideApprovedRoot(canonicalRoot, realFilePath)) {
              yield* emitSkip({
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

            yield* emitCandidate(candidate)
            continue
          }

          yield* emitSkip({
            path: entryPath,
            reason: 'non_regular_entry',
            detail: `Entry "${entryName}" is neither a regular file nor a directory`
          })
        }
      } finally {
        await dirHandle.close()
      }
    }
  }

  return buildSummary(signal?.aborted ? 'cancelled' : 'completed')
}

/**
 * Bounded convenience collector built on top of `scanSourceRoots`.
 *
 * Collects candidates, skips, and errors in memory up to `limits.maxCollectedRecords`
 * (defaults to `DEFAULT_MAX_COLLECTED_RECORDS` = 50,000). If the collected record limit
 * is exceeded, closes the underlying stream deterministically and returns
 * `status: 'resource_limit_reached'` with `limitReached` metadata.
 *
 * For unbounded-size scans with zero record retention, consume `scanSourceRoots` directly.
 */
export async function discoverFiles(options: DiscoveryOptions): Promise<DiscoveryResult> {
  const maxCollectedRecords = options.limits?.maxCollectedRecords ?? DEFAULT_MAX_COLLECTED_RECORDS

  const candidates: DiscoveredCandidate[] = []
  const skips: DiscoverySkip[] = []
  const errors: DiscoveryError[] = []

  const liveStats: MutableDiscoveryStats = {
    rootsRequested: options.roots.length,
    directoriesVisited: 0,
    candidatesFound: 0,
    skippedCount: 0,
    errorCount: 0
  }

  const stream = scanSourceRootsInternal(options, liveStats)

  while (true) {
    const step = await stream.next()
    if (step.done) {
      const summary = step.value
      return {
        status: summary.status,
        candidates,
        skips,
        errors,
        stats: summary.stats,
        ...(summary.limitReached ? { limitReached: summary.limitReached } : {})
      }
    }

    const event = step.value
    const totalCollected = candidates.length + skips.length + errors.length
    if (totalCollected >= maxCollectedRecords) {
      const limitReached: DiscoveryLimitReached = {
        limit: 'maxCollectedRecords',
        maxAllowed: maxCollectedRecords,
        observed: totalCollected + 1,
        message: `Maximum collected records limit (${maxCollectedRecords}) reached in discoverFiles collector`
      }
      const snapshotStats = {
        rootsRequested: liveStats.rootsRequested,
        directoriesVisited: liveStats.directoriesVisited,
        candidatesFound: liveStats.candidatesFound,
        skippedCount: liveStats.skippedCount,
        errorCount: liveStats.errorCount
      }
      await stream.return({
        status: 'resource_limit_reached',
        stats: snapshotStats,
        limitReached
      })
      return {
        status: 'resource_limit_reached',
        candidates,
        skips,
        errors,
        stats: snapshotStats,
        limitReached
      }
    }

    if (event.kind === 'candidate') {
      candidates.push(event.candidate)
    } else if (event.kind === 'skip') {
      skips.push(event.skip)
    } else {
      errors.push(event.error)
    }
  }
}
