/**
 * Personal Vault — usePhotos Hook (Stage 5A)
 *
 * Provides bounded, virtualized photo catalog fetching with absolute catalog positions,
 * full collection scroll extent, LRU-bounded metadata and thumbnail caches,
 * monotonic generation request guarding, and selection state.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { PhotoItem, ThumbnailResult } from '../../../shared/validation/ipc-schemas'

export const PHOTO_BOUNDS = {
  PAGE_SIZE: 50,
  MAX_METADATA_RECORDS: 2000,
  MAX_PAGES: 40, // 40 * 50 = 2000 records
  MAX_THUMBNAIL_CACHE: 200,
  MAX_MOUNTED_CELLS: 200
} as const

interface InFlightThumbRequest {
  readonly requestId: number
  readonly generation: number
  readonly revision: string
}

export interface UsePhotosResult {
  readonly photos: readonly PhotoItem[]
  readonly totalCount: number
  readonly isLoading: boolean
  readonly error: string | null
  readonly selectedPhoto: PhotoItem | null
  readonly selectedId: number | null
  readonly thumbnails: ReadonlyMap<number, ThumbnailResult>
  readonly selectPhoto: (id: number | null) => void
  readonly refresh: () => Promise<void>
  readonly ensureRangeLoaded: (startIndex: number, endIndex: number) => void
  readonly getPhoto: (index: number) => PhotoItem | undefined
  readonly requestThumbnail: (photo: PhotoItem, priority?: 'high' | 'normal' | 'low') => void
}

export function usePhotos(): UsePhotosResult {
  const [pages, setPages] = useState<Map<number, PhotoItem[]>>(new Map())
  const [totalCount, setTotalCount] = useState<number>(0)
  const [isLoading, setIsLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [thumbnails, setThumbnails] = useState<Map<number, ThumbnailResult>>(new Map())

  // Monotonic generation incremented on unmount and refresh
  const generationRef = useRef<number>(1)
  // Page LRU tracking
  const pageLruRef = useRef<number[]>([])
  // In-flight page requests: pageNumber -> generation
  const inFlightPagesRef = useRef<Map<number, number>>(new Map())
  // In-flight thumbnail requests: locationId -> InFlightThumbRequest
  const inFlightThumbsRef = useRef<Map<number, InFlightThumbRequest>>(new Map())
  const requestSeqRef = useRef<number>(0)

  const loadPage = useCallback(async (pageIndex: number, currentGeneration: number) => {
    if (inFlightPagesRef.current.get(pageIndex) === currentGeneration) {
      return
    }
    inFlightPagesRef.current.set(pageIndex, currentGeneration)

    try {
      if (!window.api?.getPhotosPage) {
        throw new Error('Photos API unavailable')
      }

      const res = await window.api.getPhotosPage({
        offset: pageIndex * PHOTO_BOUNDS.PAGE_SIZE,
        limit: PHOTO_BOUNDS.PAGE_SIZE
      })

      // Discard response if generation changed (e.g. refreshed or unmounted)
      if (generationRef.current !== currentGeneration) {
        return
      }

      inFlightPagesRef.current.delete(pageIndex)
      setTotalCount(res.totalCount)

      setPages((prev) => {
        const next = new Map(prev)
        next.set(pageIndex, res.items)

        // Update LRU tracking
        const lru = pageLruRef.current.filter((p) => p !== pageIndex)
        lru.push(pageIndex)

        // Evict oldest pages if exceeding MAX_PAGES (40 pages = 2000 records)
        while (lru.length > PHOTO_BOUNDS.MAX_PAGES) {
          const evictedPage = lru.shift()
          if (evictedPage !== undefined) {
            next.delete(evictedPage)
          }
        }
        pageLruRef.current = lru

        return next
      })
    } catch (err: unknown) {
      if (generationRef.current === currentGeneration) {
        inFlightPagesRef.current.delete(pageIndex)
        setError(err instanceof Error ? err.message : 'Failed to load photographs')
      }
    } finally {
      if (generationRef.current === currentGeneration && pageIndex === 0) {
        setIsLoading(false)
      }
    }
  }, [])

  const ensureRangeLoaded = useCallback(
    (startIndex: number, endIndex: number) => {
      const currentGen = generationRef.current
      const startPage = Math.floor(startIndex / PHOTO_BOUNDS.PAGE_SIZE)
      const endPage = Math.floor(Math.max(startIndex, endIndex - 1) / PHOTO_BOUNDS.PAGE_SIZE)

      // Prefetch visible pages and 1 adjacent page buffer
      const minPage = Math.max(0, startPage - 1)
      const maxPage = endPage + 1

      for (let p = minPage; p <= maxPage; p++) {
        if (!pages.has(p) && !inFlightPagesRef.current.has(p)) {
          void loadPage(p, currentGen)
        } else if (pages.has(p)) {
          // Touch LRU
          const lru = pageLruRef.current.filter((idx) => idx !== p)
          lru.push(p)
          pageLruRef.current = lru
        }
      }
    },
    [pages, loadPage]
  )

  const getPhoto = useCallback(
    (index: number): PhotoItem | undefined => {
      const pageIndex = Math.floor(index / PHOTO_BOUNDS.PAGE_SIZE)
      const offsetInPage = index % PHOTO_BOUNDS.PAGE_SIZE
      return pages.get(pageIndex)?.[offsetInPage]
    },
    [pages]
  )

  const refresh = useCallback(async () => {
    // Monotonic generation increment prevents any pending async responses from repopulating
    const nextGen = ++generationRef.current
    pageLruRef.current = []
    inFlightPagesRef.current.clear()
    inFlightThumbsRef.current.clear()
    setPages(new Map())
    setThumbnails(new Map())
    setIsLoading(true)
    setError(null)
    await loadPage(0, nextGen)
  }, [loadPage])

  const requestThumbnail = useCallback(
    (photo: PhotoItem, priority: 'high' | 'normal' | 'low' = 'normal') => {
      if (!window.api?.getThumbnail) return
      if (thumbnails.has(photo.id)) return

      const currentGen = generationRef.current
      const existingReq = inFlightThumbsRef.current.get(photo.id)
      if (existingReq && existingReq.generation === currentGen) {
        return // Already in-flight for current generation
      }

      const requestId = ++requestSeqRef.current
      const revision = `${photo.id}:${photo.byteSize}:${photo.filesystemMtimeMs}`
      inFlightThumbsRef.current.set(photo.id, {
        requestId,
        generation: currentGen,
        revision
      })

      void window.api
        .getThumbnail({
          locationId: photo.id,
          expectedByteSize: photo.byteSize,
          expectedMtimeMs: photo.filesystemMtimeMs,
          priority
        })
        .then((result) => {
          const activeReq = inFlightThumbsRef.current.get(photo.id)
          // Discard response if generation, request id, or revision mismatch
          if (
            !activeReq ||
            activeReq.requestId !== requestId ||
            activeReq.generation !== currentGen ||
            activeReq.generation !== generationRef.current ||
            activeReq.revision !== revision
          ) {
            return
          }

          // Safe deletion: only delete if current active request matches this requestId
          inFlightThumbsRef.current.delete(photo.id)

          setThumbnails((prev) => {
            const next = new Map(prev)
            if (next.size >= PHOTO_BOUNDS.MAX_THUMBNAIL_CACHE) {
              const firstKey = next.keys().next().value
              if (firstKey !== undefined) {
                next.delete(firstKey)
              }
            }
            next.set(photo.id, result)
            return next
          })
        })
        .catch(() => {
          if (inFlightThumbsRef.current.get(photo.id)?.requestId === requestId) {
            inFlightThumbsRef.current.delete(photo.id)
          }
        })
    },
    [thumbnails]
  )

  useEffect(() => {
    let active = true

    const loadInitial = async () => {
      await Promise.resolve()
      if (active) {
        void loadPage(0, generationRef.current)
      }
    }
    void loadInitial()

    return () => {
      active = false
    }
  }, [loadPage])

  // Invalidate in-flight generation on unmount
  useEffect(() => {
    return () => {
      generationRef.current += 1
    }
  }, [])

  // Flatten currently retained photos for backwards compatibility and selection search
  const photos = Array.from(pages.values()).flat()
  const selectedPhoto = photos.find((p) => p.id === selectedId) ?? null

  const selectPhoto = useCallback((id: number | null) => {
    setSelectedId(id)
  }, [])

  return {
    photos,
    totalCount,
    isLoading,
    error,
    selectedPhoto,
    selectedId,
    thumbnails,
    selectPhoto,
    refresh,
    ensureRangeLoaded,
    getPhoto,
    requestThumbnail
  }
}
