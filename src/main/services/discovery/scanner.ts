import { basename, join, resolve } from 'node:path'
import { createNodeReadOnlyFsAdapter } from './fs-adapter'
import {
  classifyFsError,
  inspectDirectoryTarget,
  inspectFileEntry,
  isInsideApprovedRoot
} from './inspection'
import {
  BoundedFifoQueue,
  DEFAULT_MAX_COLLECTED_RECORDS,
  DEFAULT_MAX_PENDING_DIRECTORIES,
  DEFAULT_MAX_VISITED_DIRECTORIES,
  resolveDiscoveryLimits,
  type ResolvedDiscoveryLimits
} from './limits'
import { resolveDiscoveryPolicy } from './policy'
import type {
  DiscoveredCandidate,
  DiscoveryError,
  DiscoveryEvent,
  DiscoveryLimitReached,
  DiscoveryOptions,
  DiscoveryResult,
  DiscoverySkip,
  DiscoveryStatus,
  DiscoverySummary
} from './types'

export {
  BoundedFifoQueue,
  DEFAULT_MAX_COLLECTED_RECORDS,
  DEFAULT_MAX_PENDING_DIRECTORIES,
  DEFAULT_MAX_VISITED_DIRECTORIES,
  isInsideApprovedRoot,
  resolveDiscoveryLimits
}

interface QueuedDirectory {
  readonly dirPath: string
  readonly expectedRealPath: string
  readonly isRoot: boolean
}

interface MutableDiscoveryStats {
  rootsRequested: number
  directoriesVisited: number
  candidatesFound: number
  skippedCount: number
  errorCount: number
}

/**
 * Incrementally scans the supplied source roots in read-only mode, yielding
 * structured `DiscoveryEvent` items (`candidate`, `skip`, `error`) with consumer
 * backpressure.
 *
 * Resource & safety properties:
 * - Validates `options.limits` lazily when generator iteration starts (`next()` /
 *   `for await`), before any filesystem operations or callbacks execute.
 *   Note: `maxPendingDirectories` and `maxVisitedDirectories` bound streaming traversal;
 *   `maxCollectedRecords` applies only to the `discoverFiles` collector (though if supplied
 *   in `options.limits`, it is still validated as a positive safe integer).
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
export async function* scanSourceRoots(
  options: DiscoveryOptions
): AsyncGenerator<DiscoveryEvent, DiscoverySummary, void> {
  return yield* scanSourceRootsInternal(options)
}

async function* scanSourceRootsInternal(
  options: DiscoveryOptions,
  externalStats?: MutableDiscoveryStats,
  preResolvedLimits?: ResolvedDiscoveryLimits
): AsyncGenerator<DiscoveryEvent, DiscoverySummary, void> {
  const limits = preResolvedLimits ?? resolveDiscoveryLimits(options.limits)
  const fsAdapter = options.fsAdapter ?? createNodeReadOnlyFsAdapter()
  const policy = resolveDiscoveryPolicy(options.policy)
  const signal = options.signal

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

    const rootInspection = await inspectDirectoryTarget({
      dirPath: rootPath,
      dirName: rootName,
      context: { kind: 'root' },
      policy,
      fsAdapter,
      signal
    })

    if (rootInspection.outcome === 'cancelled') {
      return buildSummary('cancelled')
    }
    if (rootInspection.outcome === 'skip') {
      yield* emitSkip(rootInspection.skip)
      continue
    }
    if (rootInspection.outcome === 'error') {
      yield* emitError(rootInspection.error)
      continue
    }

    const canonicalRoot = rootInspection.canonicalPath
    const pendingDirs = new BoundedFifoQueue<QueuedDirectory>(limits.maxPendingDirectories)
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
        const queuedInspection = await inspectDirectoryTarget({
          dirPath: currentDir,
          dirName: currentName,
          context: {
            kind: 'queued',
            canonicalRoot,
            expectedRealPath: queued.expectedRealPath
          },
          policy,
          fsAdapter,
          signal
        })

        if (queuedInspection.outcome === 'cancelled') {
          return buildSummary('cancelled')
        }
        if (queuedInspection.outcome === 'skip') {
          yield* emitSkip(queuedInspection.skip)
          continue
        }
        if (queuedInspection.outcome === 'error') {
          yield* emitError(queuedInspection.error)
          continue
        }
      }

      if (stats.directoriesVisited >= limits.maxVisitedDirectories) {
        return buildSummary('resource_limit_reached', {
          limit: 'maxVisitedDirectories',
          maxAllowed: limits.maxVisitedDirectories,
          observed: stats.directoriesVisited + 1,
          message: `Maximum visited directories limit (${limits.maxVisitedDirectories}) reached before opening "${currentDir}"`
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
            const childInspection = await inspectDirectoryTarget({
              dirPath: entryPath,
              dirName: entryName,
              context: { kind: 'child', canonicalRoot },
              policy,
              fsAdapter,
              signal
            })

            if (childInspection.outcome === 'cancelled') {
              return buildSummary('cancelled')
            }
            if (childInspection.outcome === 'skip') {
              yield* emitSkip(childInspection.skip)
              continue
            }
            if (childInspection.outcome === 'error') {
              yield* emitError(childInspection.error)
              continue
            }

            const enqueued = pendingDirs.enqueue({
              dirPath: entryPath,
              expectedRealPath: childInspection.canonicalPath,
              isRoot: false
            })
            if (!enqueued) {
              return buildSummary('resource_limit_reached', {
                limit: 'maxPendingDirectories',
                maxAllowed: limits.maxPendingDirectories,
                observed: pendingDirs.size + 1,
                message: `Maximum pending directories limit (${limits.maxPendingDirectories}) reached while queueing "${entryPath}"`
              })
            }
            continue
          }

          if (entry.isFile()) {
            const fileInspection = await inspectFileEntry({
              rootPath,
              canonicalRoot,
              entryPath,
              entryName,
              policy,
              fsAdapter,
              signal
            })

            if (fileInspection.outcome === 'cancelled') {
              return buildSummary('cancelled')
            }
            if (fileInspection.outcome === 'skip') {
              yield* emitSkip(fileInspection.skip)
              continue
            }
            if (fileInspection.outcome === 'error') {
              yield* emitError(fileInspection.error)
              continue
            }

            yield* emitCandidate(fileInspection.candidate)
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
 * - Validates `options.limits` immediately at the API boundary before performing any
 *   filesystem operations or invoking callbacks.
 * - Collects candidates, skips, and errors in memory up to `limits.maxCollectedRecords`
 *   (defaults to `DEFAULT_MAX_COLLECTED_RECORDS` = 50,000). If the collected record limit
 *   is exceeded, closes the underlying stream deterministically and returns
 *   `status: 'resource_limit_reached'` with `limitReached` metadata.
 * - For unbounded-size scans with zero record retention, consume `scanSourceRoots` directly.
 */
export async function discoverFiles(options: DiscoveryOptions): Promise<DiscoveryResult> {
  const limits = resolveDiscoveryLimits(options.limits)

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

  const stream = scanSourceRootsInternal(options, liveStats, limits)

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
    if (totalCollected >= limits.maxCollectedRecords) {
      const limitReached: DiscoveryLimitReached = {
        limit: 'maxCollectedRecords',
        maxAllowed: limits.maxCollectedRecords,
        observed: totalCollected + 1,
        message: `Maximum collected records limit (${limits.maxCollectedRecords}) reached in discoverFiles collector`
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
