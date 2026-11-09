/**
 * Personal Vault — Similarity Review Hook (Stage 5C)
 *
 * Manages similarity analysis lifecycle (start, cancel, resume, progress polling),
 * paginated candidate pair browsing, optimistic decision updates with rollback,
 * two-phase persistence status propagation, and monotonic stale response guards.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  SimilarityAnalysisProgress,
  SimilarityCandidatePair,
  SimilarityDecisionType,
  SimilarityGetPairsFilter
} from '../../../shared/validation/ipc-schemas'

export function computeSimilarityPhotoRevision(photo: {
  discoveryObservationId: number
  byteSize: number
  filesystemMtimeMs: number | null
  activeHash: string | null
}): string {
  const mtime = photo.filesystemMtimeMs !== null ? photo.filesystemMtimeMs : 'null'
  const hash = photo.activeHash ? photo.activeHash : 'unhashed'
  return `rev:${photo.discoveryObservationId}:${photo.byteSize}:${mtime}:${hash}`
}

export function useSimilarityReview() {
  const [progress, setProgress] = useState<SimilarityAnalysisProgress>({
    jobId: null,
    status: 'idle',
    algorithmVersion: 'dhash64_v1',
    totalPhotos: 0,
    processedPhotos: 0,
    errorPhotos: 0,
    unsupportedPhotos: 0,
    candidatePairsFound: 0,
    startedAtMs: null,
    updatedAtMs: null,
    completedAtMs: null
  })

  const [pairs, setPairs] = useState<SimilarityCandidatePair[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize] = useState(10)
  const [totalPages, setTotalPages] = useState(0)
  const [filter, setFilter] = useState<SimilarityGetPairsFilter>('all')
  const [isLoadingPairs, setIsLoadingPairs] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [persistencePending, setPersistencePending] = useState(false)
  const [persistenceError, setPersistenceError] = useState<string | null>(null)

  // Monotonic request tokens guarding against out-of-order responses
  const requestTokenRef = useRef(0)
  const pollTimerRef = useRef<NodeJS.Timeout | null>(null)

  // Load progress on mount
  const refreshProgress = useCallback(async () => {
    try {
      if (!window.api?.getSimilarityProgress) return
      const p = await window.api.getSimilarityProgress()
      setProgress(p)
      return p
    } catch (err: unknown) {
      console.error('Failed to get similarity progress:', err)
      return null
    }
  }, [])

  // Load candidate pairs for current page and filter
  const loadPairs = useCallback(
    async (targetPage = page, targetFilter = filter) => {
      if (!window.api?.getSimilarityPairs) return
      const token = ++requestTokenRef.current
      setIsLoadingPairs(true)
      try {
        const res = await window.api.getSimilarityPairs({
          page: targetPage,
          pageSize,
          filter: targetFilter
        })
        if (token === requestTokenRef.current) {
          setPairs(res.pairs)
          setTotalCount(res.totalCount)
          setPage(res.page)
          setTotalPages(res.totalPages)
          setIsLoadingPairs(false)
        }
      } catch (err: unknown) {
        if (token === requestTokenRef.current) {
          setActionError(err instanceof Error ? err.message : String(err))
          setIsLoadingPairs(false)
        }
      }
    },
    [page, filter, pageSize]
  )

  // Initial load
  useEffect(() => {
    let cancelled = false
    const api = window.api
    if (!api) return

    Promise.all([
      api.getSimilarityProgress?.(),
      api.getSimilarityPairs?.({ page: 1, pageSize, filter: 'all' })
    ])
      .then(([prog, res]) => {
        if (cancelled) return
        if (prog) setProgress(prog)
        if (res) {
          setPairs(res.pairs)
          setTotalCount(res.totalCount)
          setPage(res.page)
          setTotalPages(res.totalPages)
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          console.error('Failed initial similarity load:', err)
        }
      })

    return () => {
      cancelled = true
    }
  }, [pageSize])

  // Polling loop while analysis is running
  useEffect(() => {
    if (progress.status === 'running') {
      pollTimerRef.current = setInterval(async () => {
        const p = await refreshProgress()
        if (p && p.status !== 'running') {
          if (pollTimerRef.current) clearInterval(pollTimerRef.current)
          pollTimerRef.current = null
          void loadPairs(1, filter)
        }
      }, 500)
    } else {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current)
        pollTimerRef.current = null
      }
    }
    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current)
        pollTimerRef.current = null
      }
    }
  }, [progress.status, refreshProgress, loadPairs, filter])

  const startAnalysis = useCallback(async () => {
    setActionError(null)
    try {
      const p = await window.api.startSimilarityAnalysis()
      setProgress(p)
      void loadPairs(1, filter)
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err))
    }
  }, [loadPairs, filter])

  const cancelAnalysis = useCallback(async () => {
    setActionError(null)
    try {
      const p = await window.api.cancelSimilarityAnalysis()
      setProgress(p)
      void loadPairs(page, filter)
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err))
    }
  }, [page, filter, loadPairs])

  const resumeAnalysis = useCallback(async () => {
    setActionError(null)
    try {
      const p = await window.api.resumeSimilarityAnalysis()
      setProgress(p)
      void loadPairs(page, filter)
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err))
    }
  }, [page, filter, loadPairs])

  const changeFilter = useCallback(
    (newFilter: SimilarityGetPairsFilter) => {
      setFilter(newFilter)
      setPage(1)
      void loadPairs(1, newFilter)
    },
    [loadPairs]
  )

  const goToPage = useCallback(
    (newPage: number) => {
      if (newPage < 1 || (totalPages > 0 && newPage > totalPages)) return
      setPage(newPage)
      void loadPairs(newPage, filter)
    },
    [totalPages, filter, loadPairs]
  )

  const setDecision = useCallback(
    async (
      pairId: number,
      locationIdA: number,
      locationIdB: number,
      revA: string,
      revB: string,
      decision: SimilarityDecisionType,
      expectedVersion?: number
    ) => {
      setActionError(null)

      // Optimistic update
      setPairs((prev) =>
        prev.map((p) => {
          if (p.id === pairId) {
            return {
              ...p,
              decision,
              decisionVersion: (p.decisionVersion ?? 0) + 1,
              decisionUpdatedAtMs: Date.now()
            }
          }
          return p
        })
      )

      try {
        const res = await window.api.setSimilarityDecision({
          locationIdA,
          locationIdB,
          expectedRevisionA: revA,
          expectedRevisionB: revB,
          decision,
          expectedVersion
        })

        if (res.persistencePending) {
          setPersistencePending(true)
          setPersistenceError(res.message ?? 'Journal persistence pending')
        } else {
          setPersistencePending(false)
          setPersistenceError(null)
        }

        // Update with verified version
        setPairs((prev) =>
          prev.map((p) => {
            if (p.id === pairId) {
              return {
                ...p,
                decision: res.decision,
                decisionVersion: res.version,
                decisionUpdatedAtMs: Date.now()
              }
            }
            return p
          })
        )
      } catch (err: unknown) {
        // Rollback on error
        setActionError(err instanceof Error ? err.message : String(err))
        void loadPairs(page, filter)
      }
    },
    [page, filter, loadPairs]
  )

  const retryReconciliation = useCallback(async () => {
    try {
      await window.api.reconcileSimilarity()
      setPersistencePending(false)
      setPersistenceError(null)
      void loadPairs(page, filter)
    } catch (err: unknown) {
      setPersistenceError(err instanceof Error ? err.message : String(err))
    }
  }, [page, filter, loadPairs])

  return {
    progress,
    pairs,
    totalCount,
    page,
    pageSize,
    totalPages,
    filter,
    isLoadingPairs,
    actionError,
    persistencePending,
    persistenceError,
    startAnalysis,
    cancelAnalysis,
    resumeAnalysis,
    refreshProgress,
    changeFilter,
    goToPage,
    setDecision,
    retryReconciliation
  }
}
