/**
 * Personal Vault — usePhotos Hook (Stage 5A)
 *
 * Provides bounded, virtualized photo catalog fetching, memory-bounded
 * metadata and thumbnail caches, monotonic async token guarding,
 * and selection state.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { PhotoItem, ThumbnailResult } from '../../../shared/validation/ipc-schemas'

export const PHOTO_BOUNDS = {
  PAGE_SIZE: 50,
  MAX_METADATA_RECORDS: 2000,
  MAX_THUMBNAIL_CACHE: 200,
  MAX_MOUNTED_CELLS: 200
} as const

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
  readonly loadMore: () => Promise<void>
  readonly hasMore: boolean
  readonly requestThumbnail: (photo: PhotoItem, priority?: 'high' | 'normal' | 'low') => void
}

export function usePhotos(): UsePhotosResult {
  const [photos, setPhotos] = useState<PhotoItem[]>([])
  const [totalCount, setTotalCount] = useState<number>(0)
  const [isLoading, setIsLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [thumbnails, setThumbnails] = useState<Map<number, ThumbnailResult>>(new Map())
  const [hasMore, setHasMore] = useState<boolean>(false)

  // Monotonic request tokens to guard out-of-order responses
  const fetchTokenRef = useRef<number>(0)
  const thumbTokensRef = useRef<Map<number, number>>(new Map())
  // Track in-flight thumbnail requests to prevent duplicate requests
  const inFlightThumbsRef = useRef<Set<number>>(new Set())

  const loadPhotos = useCallback(async (offset: number, append: boolean) => {
    const currentToken = ++fetchTokenRef.current
    setIsLoading(true)
    setError(null)

    try {
      if (!window.api?.getPhotosPage) {
        throw new Error('Photos API unavailable')
      }

      const res = await window.api.getPhotosPage({
        offset,
        limit: PHOTO_BOUNDS.PAGE_SIZE
      })

      if (fetchTokenRef.current !== currentToken) {
        return // Stale response discarded
      }

      setTotalCount(res.totalCount)
      setHasMore(res.hasMore)

      setPhotos((prev) => {
        let next: PhotoItem[]
        if (append) {
          // Bounded deduplication by ID
          const existingIds = new Set(prev.map((p) => p.id))
          const newItems = res.items.filter((p) => !existingIds.has(p.id))
          next = [...prev, ...newItems]
        } else {
          next = res.items
        }

        // Enforce max renderer metadata records bound (2,000)
        if (next.length > PHOTO_BOUNDS.MAX_METADATA_RECORDS) {
          next = next.slice(next.length - PHOTO_BOUNDS.MAX_METADATA_RECORDS)
        }
        return next
      })
    } catch (err: unknown) {
      if (fetchTokenRef.current === currentToken) {
        setError(err instanceof Error ? err.message : 'Failed to load photographs')
      }
    } finally {
      if (fetchTokenRef.current === currentToken) {
        setIsLoading(false)
      }
    }
  }, [])

  const refresh = useCallback(async () => {
    inFlightThumbsRef.current.clear()
    thumbTokensRef.current.clear()
    setThumbnails(new Map())
    await loadPhotos(0, false)
  }, [loadPhotos])

  const loadMore = useCallback(async () => {
    if (isLoading || !hasMore) return
    await loadPhotos(photos.length, true)
  }, [isLoading, hasMore, photos.length, loadPhotos])

  const requestThumbnail = useCallback(
    (photo: PhotoItem, priority: 'high' | 'normal' | 'low' = 'normal') => {
      if (!window.api?.getThumbnail) return
      if (thumbnails.has(photo.id) || inFlightThumbsRef.current.has(photo.id)) {
        return
      }

      inFlightThumbsRef.current.add(photo.id)
      const currentToken = (thumbTokensRef.current.get(photo.id) ?? 0) + 1
      thumbTokensRef.current.set(photo.id, currentToken)

      void window.api
        .getThumbnail({
          locationId: photo.id,
          expectedByteSize: photo.byteSize,
          expectedMtimeMs: photo.filesystemMtimeMs,
          priority
        })
        .then((result) => {
          inFlightThumbsRef.current.delete(photo.id)
          if (thumbTokensRef.current.get(photo.id) !== currentToken) {
            return // Obsolete response
          }

          setThumbnails((prev) => {
            const next = new Map(prev)
            // Evict oldest entries if exceeding cache limit (200)
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
          inFlightThumbsRef.current.delete(photo.id)
        })
    },
    [thumbnails]
  )

  useEffect(() => {
    let active = true

    const loadInitial = async () => {
      await Promise.resolve()
      if (active) {
        void loadPhotos(0, false)
      }
    }
    void loadInitial()

    return () => {
      active = false
    }
  }, [loadPhotos])

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
    loadMore,
    hasMore,
    requestThumbnail
  }
}
