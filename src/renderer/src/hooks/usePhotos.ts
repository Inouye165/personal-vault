/**
 * Personal Vault — usePhotos Hook (Stage 5A/5B)
 *
 * Provides bounded, virtualized photo catalog fetching with absolute catalog positions,
 * full collection scroll extent, LRU-bounded metadata and thumbnail caches,
 * SQL-level rating/flag/collection filtering, optimistic annotation updates,
 * filter refill on out-of-filter edits, and selection state.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  CameraLabel,
  InterpretedSearchFilters,
  MetadataAwarePhotoSearchResponse,
  PhotoFileTypeBasis,
  PhotoFlagFilter,
  PhotoItem,
  PhotoRatingFilter,
  PhotoUserPlace,
  SavedEvent,
  SavedPlace,
  SearchClarificationOption,
  SearchClarificationPrompt,
  ThumbnailResult
} from '../../../shared/validation/ipc-schemas'
import type {
  PhotosSearchBarResultMeta,
  PhotosSearchModelStatus
} from '../components/PhotosSearchBar'
import { allocateSearchOwnerGen } from './search-owner'

export const PHOTO_BOUNDS = {
  PAGE_SIZE: 50,
  MAX_METADATA_RECORDS: 2000,
  MAX_PAGES: 40, // 40 * 50 = 2000 records
  MAX_THUMBNAIL_CACHE: 200,
  MAX_MOUNTED_CELLS: 200
} as const

export interface PhotoMetadataFilterState {
  readonly captureDateFrom: string | null
  readonly captureDateTo: string | null
  readonly includeUnknownCaptureDate: boolean
  readonly cameraNormalized: string | null
  readonly onlyUnknownCamera: boolean
  readonly lensNormalized: string | null
  readonly onlyUnknownLens: boolean
  readonly minWidthPx: number | null
  readonly minHeightPx: number | null
  readonly includeUnknownDimensions: boolean
  readonly fileTypeBasis: PhotoFileTypeBasis
  readonly fileTypeValue: string | null
  readonly onlyUnknownDetectedFormat: boolean
}

export const DEFAULT_PHOTO_METADATA_FILTERS: PhotoMetadataFilterState = {
  captureDateFrom: null,
  captureDateTo: null,
  includeUnknownCaptureDate: false,
  cameraNormalized: null,
  onlyUnknownCamera: false,
  lensNormalized: null,
  onlyUnknownLens: false,
  minWidthPx: null,
  minHeightPx: null,
  includeUnknownDimensions: false,
  fileTypeBasis: 'detected_format',
  fileTypeValue: null,
  onlyUnknownDetectedFormat: false
}

export function countActiveMetadataFilters(filters: PhotoMetadataFilterState): number {
  let count = 0
  if (
    filters.captureDateFrom !== null ||
    filters.captureDateTo !== null ||
    filters.includeUnknownCaptureDate
  ) {
    count++
  }
  if (filters.cameraNormalized !== null || filters.onlyUnknownCamera) {
    count++
  }
  if (filters.lensNormalized !== null || filters.onlyUnknownLens) {
    count++
  }
  if (
    filters.minWidthPx !== null ||
    filters.minHeightPx !== null ||
    filters.includeUnknownDimensions
  ) {
    count++
  }
  if (filters.fileTypeValue !== null || filters.onlyUnknownDetectedFormat) {
    count++
  }
  return count
}

export function hasActiveMetadataFilters(filters: PhotoMetadataFilterState): boolean {
  return countActiveMetadataFilters(filters) > 0
}

interface InFlightThumbRequest {
  readonly requestId: number
  readonly generation: number
  readonly revision: string
}

export interface UsePhotosResult {
  readonly photos: readonly PhotoItem[]
  readonly cachedPageIndices: readonly number[]
  readonly totalCount: number
  readonly isLoading: boolean
  readonly error: string | null
  readonly errorDetails: string | null
  readonly selectedPhoto: PhotoItem | null
  readonly selectedId: number | null
  readonly thumbnails: ReadonlyMap<number, ThumbnailResult>
  readonly ratingFilter: PhotoRatingFilter
  readonly flagFilter: PhotoFlagFilter
  readonly collectionId: number | null
  readonly metadataFilters: PhotoMetadataFilterState
  readonly filterGeneration: number
  readonly searchQuery: string
  readonly isSearching: boolean
  readonly searchMode: 'metadata_only' | 'hybrid' | 'visual_only' | 'needs_clarification' | null
  readonly interpretedFilters: InterpretedSearchFilters | null
  readonly clarification: SearchClarificationPrompt | null
  readonly visualModelRequired: boolean
  readonly filteredCandidateCount: number
  readonly searchResultMeta: PhotosSearchBarResultMeta | null
  readonly searchScores: ReadonlyMap<number, number>
  readonly modelStatus: PhotosSearchModelStatus
  readonly savedEvents: readonly SavedEvent[]
  readonly savedPlaces: readonly SavedPlace[]
  readonly cameraLabels: readonly CameraLabel[]
  readonly setSearchQuery: (query: string) => void
  readonly clearSearch: () => void
  readonly updateInterpretedFilters: (next: InterpretedSearchFilters) => void
  readonly clearInterpretedFilter: (field: 'place' | 'date' | 'camera' | 'visualTerms') => void
  readonly showMetadataMatchesWithoutVisualModel: () => void
  readonly saveEventAndRetrySearch: (input: {
    name: string
    dateFrom: string
    dateTo: string
  }) => Promise<void>
  readonly selectDisambiguatedPlace: (option: SearchClarificationOption) => void
  readonly saveCustomPlaceAndRetrySearch: (input: {
    name: string
    minLat: number
    maxLat: number
    minLon: number
    maxLon: number
  }) => Promise<void>
  readonly upsertSavedEvent: (input: {
    name: string
    dateFrom: string
    dateTo: string
  }) => Promise<SavedEvent | null>
  readonly deleteSavedEvent: (id: number) => Promise<void>
  readonly upsertSavedPlace: (input: {
    name: string
    minLat: number
    maxLat: number
    minLon: number
    maxLon: number
  }) => Promise<SavedPlace | null>
  readonly deleteSavedPlace: (id: number) => Promise<void>
  readonly setPhotoUserPlace: (input: {
    fileLocationId: number
    placeId?: number | null
    placeLabel: string
  }) => Promise<PhotoUserPlace | null>
  readonly clearPhotoUserPlace: (fileLocationId: number) => Promise<void>
  readonly upsertCameraLabel: (input: {
    cameraNormalized: string
    label: string
  }) => Promise<CameraLabel | null>
  readonly deleteCameraLabel: (id: number) => Promise<void>
  readonly selectPhoto: (id: number | null) => void
  readonly setRatingFilter: (filter: PhotoRatingFilter) => void
  readonly setFlagFilter: (filter: PhotoFlagFilter) => void
  readonly setCollectionId: (collectionId: number | null) => void
  readonly updateMetadataFilters: (patch: Partial<PhotoMetadataFilterState>) => void
  readonly resetFilters: () => void
  readonly updatePhotoLocal: (
    photoId: number,
    rating: number | null,
    flag: 'none' | 'pick' | 'reject',
    version: number
  ) => void
  readonly removePhotoFromFilterView: (photoId: number) => void
  readonly refresh: () => Promise<void>
  readonly ensureRangeLoaded: (startIndex: number, endIndex: number) => void
  readonly getPhoto: (index: number) => PhotoItem | undefined
  readonly requestThumbnail: (photo: PhotoItem, priority?: 'high' | 'normal' | 'low') => void
  readonly cancelThumbnail: (locationId: number) => void
}

function formatPhotoLoadError(rawMessage: string, isSearch: boolean): string {
  if (/SearchTimeoutError|SEARCH_TIMEOUT|timed out/i.test(rawMessage)) {
    return 'Visual search timed out while your photo library is busy. Try again or clear search to keep browsing.'
  }
  if (isSearch) {
    return "Couldn't complete photo search right now. Try again or clear search to keep browsing."
  }
  return "Couldn't load photographs right now. Try again."
}

interface PhotoViewQueryContext {
  readonly queryText: string
  readonly filterOverrides: InterpretedSearchFilters | null
  readonly bypassVisualModel: boolean
  readonly rating: PhotoRatingFilter
  readonly flag: PhotoFlagFilter
  readonly collection: number | null
  readonly metadata: PhotoMetadataFilterState
}

interface LastGoodPhotoView {
  readonly pages: Map<number, PhotoItem[]>
  readonly totalCount: number
  readonly searchMode: 'metadata_only' | 'hybrid' | 'visual_only' | 'needs_clarification' | null
  readonly searchResultMeta: PhotosSearchBarResultMeta | null
  readonly searchScores: Map<number, number>
  readonly viewQuery: PhotoViewQueryContext
}

export function usePhotos(): UsePhotosResult {
  const [pages, setPages] = useState<Map<number, PhotoItem[]>>(new Map())
  const [totalCount, setTotalCount] = useState<number>(0)
  const [isLoading, setIsLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)
  const [errorDetails, setErrorDetails] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [thumbnails, setThumbnails] = useState<Map<number, ThumbnailResult>>(new Map())
  const thumbnailsRef = useRef(thumbnails)

  const pagesRef = useRef(pages)
  const totalCountRef = useRef(totalCount)
  const errorRef = useRef(error)
  const lastGoodViewRef = useRef<LastGoodPhotoView | null>(null)
  const displayedViewQueryRef = useRef<PhotoViewQueryContext>({
    queryText: '',
    filterOverrides: null,
    bypassVisualModel: false,
    rating: 'all',
    flag: 'all',
    collection: null,
    metadata: DEFAULT_PHOTO_METADATA_FILTERS
  })
  const restoredGridQueryRef = useRef<PhotoViewQueryContext | null>(null)

  // Filters state
  const [ratingFilter, setRatingFilterState] = useState<PhotoRatingFilter>('all')
  const [flagFilter, setFlagFilterState] = useState<PhotoFlagFilter>('all')
  const [collectionId, setCollectionIdState] = useState<number | null>(null)
  const [metadataFilters, setMetadataFiltersState] = useState<PhotoMetadataFilterState>(
    DEFAULT_PHOTO_METADATA_FILTERS
  )
  const [filterGeneration, setFilterGeneration] = useState<number>(0)

  // Stage 6D + metadata-aware search state
  const [searchQuery, setSearchQueryState] = useState<string>('')
  const searchQueryRef = useRef<string>('')
  const filterOverridesRef = useRef<InterpretedSearchFilters | null>(null)
  const bypassVisualModelRef = useRef<boolean>(false)
  const [isSearching, setIsSearching] = useState<boolean>(false)
  const [searchMode, setSearchMode] = useState<
    'metadata_only' | 'hybrid' | 'visual_only' | 'needs_clarification' | null
  >(null)
  const [interpretedFilters, setInterpretedFilters] = useState<InterpretedSearchFilters | null>(
    null
  )
  const interpretedFiltersRef = useRef<InterpretedSearchFilters | null>(null)
  const [clarification, setClarification] = useState<SearchClarificationPrompt | null>(null)
  const [visualModelRequired, setVisualModelRequired] = useState<boolean>(false)
  const [filteredCandidateCount, setFilteredCandidateCount] = useState<number>(0)
  const [searchResultMeta, setSearchResultMeta] = useState<PhotosSearchBarResultMeta | null>(null)
  const [searchScores, setSearchScores] = useState<Map<number, number>>(new Map())
  const [modelStatus, setModelStatus] = useState<PhotosSearchModelStatus>('missing')
  const [savedEvents, setSavedEvents] = useState<SavedEvent[]>([])
  const [savedPlaces, setSavedPlaces] = useState<SavedPlace[]>([])
  const [cameraLabels, setCameraLabels] = useState<CameraLabel[]>([])

  const ratingFilterRef = useRef(ratingFilter)
  const flagFilterRef = useRef(flagFilter)
  const collectionIdRef = useRef(collectionId)
  const metadataFiltersRef = useRef(metadataFilters)
  const searchModeRef = useRef(searchMode)
  const searchResultMetaRef = useRef(searchResultMeta)
  const searchScoresRef = useRef(searchScores)

  useEffect(() => {
    ratingFilterRef.current = ratingFilter
    flagFilterRef.current = flagFilter
    collectionIdRef.current = collectionId
    metadataFiltersRef.current = metadataFilters
  }, [ratingFilter, flagFilter, collectionId, metadataFilters])

  useEffect(() => {
    pagesRef.current = pages
    totalCountRef.current = totalCount
    errorRef.current = error
    searchModeRef.current = searchMode
    searchResultMetaRef.current = searchResultMeta
    searchScoresRef.current = searchScores
  }, [pages, totalCount, error, searchMode, searchResultMeta, searchScores])

  const snapshotLastGoodView = useCallback(() => {
    if (!errorRef.current && pagesRef.current.size > 0) {
      lastGoodViewRef.current = {
        pages: new Map(pagesRef.current),
        totalCount: totalCountRef.current,
        searchMode: searchModeRef.current,
        searchResultMeta: searchResultMetaRef.current,
        searchScores: new Map(searchScoresRef.current),
        viewQuery: displayedViewQueryRef.current
      }
    }
  }, [])

  const refreshUserPhotoMetadata = useCallback(async () => {
    try {
      const [evRes, plRes, clRes] = await Promise.all([
        window.api?.listSavedEvents?.(),
        window.api?.listSavedPlaces?.(),
        window.api?.listCameraLabels?.()
      ])
      if (evRes?.items) setSavedEvents(evRes.items)
      if (plRes?.items) setSavedPlaces(plRes.items)
      if (clRes?.items) setCameraLabels(clRes.items)
    } catch {
      // Non-fatal in minimal test environments
    }
  }, [])

  useEffect(() => {
    let unmounted = false
    void window.api?.getSemanticModelStatus?.().then((status) => {
      if (!unmounted && status) {
        setModelStatus(status.state)
      }
    })
    void Promise.all([
      window.api?.listSavedEvents?.(),
      window.api?.listSavedPlaces?.(),
      window.api?.listCameraLabels?.()
    ])
      .then(([evRes, plRes, clRes]) => {
        if (unmounted) return
        if (evRes?.items) setSavedEvents(evRes.items)
        if (plRes?.items) setSavedPlaces(plRes.items)
        if (clRes?.items) setCameraLabels(clRes.items)
      })
      .catch(() => {
        // Non-fatal in minimal test environments
      })
    const unsub = window.api?.onSemanticModelStatus?.((status) => {
      if (!unmounted && status) {
        setModelStatus(status.state)
      }
    })
    return () => {
      unmounted = true
      unsub?.()
    }
  }, [])

  useEffect(() => {
    thumbnailsRef.current = thumbnails
  }, [thumbnails])

  // Monotonic generation incremented on unmount, refresh, and filter change
  const generationRef = useRef<number>(1)
  const searchOwnerGenRef = useRef<number | null>(null)
  // Page LRU tracking
  const pageLruRef = useRef<number[]>([])
  // Page photo IDs tracking for pure LRU eviction
  const pagePhotoIdsRef = useRef<Map<number, number[]>>(new Map())
  // In-flight page requests: pageNumber -> generation
  const inFlightPagesRef = useRef<Map<number, number>>(new Map())
  // In-flight thumbnail requests: locationId -> InFlightThumbRequest
  const inFlightThumbsRef = useRef<Map<number, InFlightThumbRequest>>(new Map())
  const requestSeqRef = useRef<number>(0)

  const loadPage = useCallback(
    async (
      pageIndex: number,
      currentGeneration: number,
      activeFilters?: {
        rating: PhotoRatingFilter
        flag: PhotoFlagFilter
        collection: number | null
        metadata: PhotoMetadataFilterState
        searchQuery?: string
      }
    ) => {
      if (inFlightPagesRef.current.get(pageIndex) === currentGeneration) {
        return
      }
      inFlightPagesRef.current.set(pageIndex, currentGeneration)

      const restoredViewQuery = pageIndex > 0 ? restoredGridQueryRef.current : null
      const filters = restoredViewQuery
        ? {
            rating: restoredViewQuery.rating,
            flag: restoredViewQuery.flag,
            collection: restoredViewQuery.collection,
            metadata: restoredViewQuery.metadata
          }
        : (activeFilters ?? {
            rating: ratingFilterRef.current,
            flag: flagFilterRef.current,
            collection: collectionIdRef.current,
            metadata: metadataFiltersRef.current
          })
      const query = restoredViewQuery
        ? restoredViewQuery.queryText
        : activeFilters?.searchQuery !== undefined
          ? activeFilters.searchQuery
          : searchQueryRef.current

      const activeFilterOverrides = restoredViewQuery
        ? restoredViewQuery.filterOverrides
        : filterOverridesRef.current
      const activeBypassVisualModel = restoredViewQuery
        ? restoredViewQuery.bypassVisualModel
        : bypassVisualModelRef.current
      const hasFilterOverrides = activeFilterOverrides !== null

      try {
        if (query || hasFilterOverrides) {
          if (window.api?.searchPhotosMetadataAware) {
            const res: MetadataAwarePhotoSearchResponse =
              await window.api.searchPhotosMetadataAware({
                queryText: query,
                ...(activeFilterOverrides ? { filterOverrides: activeFilterOverrides } : {}),
                bypassVisualModel: activeBypassVisualModel,
                offset: pageIndex * PHOTO_BOUNDS.PAGE_SIZE,
                limit: PHOTO_BOUNDS.PAGE_SIZE,
                ratingFilter: filters.rating,
                flagFilter: filters.flag,
                collectionId: filters.collection,
                captureDateFrom: filters.metadata.captureDateFrom,
                captureDateTo: filters.metadata.captureDateTo,
                includeUnknownCaptureDate: filters.metadata.includeUnknownCaptureDate,
                cameraNormalized: filters.metadata.cameraNormalized,
                onlyUnknownCamera: filters.metadata.onlyUnknownCamera,
                lensNormalized: filters.metadata.lensNormalized,
                onlyUnknownLens: filters.metadata.onlyUnknownLens,
                minWidthPx: filters.metadata.minWidthPx,
                minHeightPx: filters.metadata.minHeightPx,
                includeUnknownDimensions: filters.metadata.includeUnknownDimensions,
                fileTypeBasis: filters.metadata.fileTypeBasis,
                fileTypeValue: filters.metadata.fileTypeValue,
                onlyUnknownDetectedFormat: filters.metadata.onlyUnknownDetectedFormat,
                ...(searchOwnerGenRef.current !== null
                  ? { ownerGen: searchOwnerGenRef.current }
                  : {})
              })

            if (generationRef.current !== currentGeneration) {
              return
            }

            if (pageIndex === 0) {
              displayedViewQueryRef.current = {
                queryText: query,
                filterOverrides: activeFilterOverrides,
                bypassVisualModel: activeBypassVisualModel,
                rating: filters.rating,
                flag: filters.flag,
                collection: filters.collection,
                metadata: filters.metadata
              }
            }
            inFlightPagesRef.current.delete(pageIndex)
            setTotalCount(res.totalMatched)
            setModelStatus((prev) =>
              prev === 'installing' && res.modelStatus === 'unprovisioned' ? prev : res.modelStatus
            )
            setSearchMode(res.mode)
            interpretedFiltersRef.current = res.interpretedFilters
            setInterpretedFilters(res.interpretedFilters)
            setClarification(res.clarification ?? null)
            setVisualModelRequired(res.visualModelRequired ?? false)
            setFilteredCandidateCount(res.filteredCandidateCount ?? 0)
            setSearchResultMeta(
              res.mode === 'needs_clarification' || res.visualModelRequired
                ? null
                : {
                    totalMatched: res.totalMatched,
                    eligibleCount: res.eligibleCount,
                    unindexedCount: res.unindexedCount,
                    staleCount: res.staleCount,
                    corruptCount: res.corruptCount ?? 0,
                    truncated: false,
                    tokenCount: 0,
                    queryLatencyMs: res.queryLatencyMs
                  }
            )

            const pageItems = res.items.map((i) => i.photo)
            pagePhotoIdsRef.current.set(
              pageIndex,
              pageItems.map((p) => p.id)
            )

            const lru = pageLruRef.current.filter((p) => p !== pageIndex)
            lru.push(pageIndex)
            const evictedPages: number[] = []
            const evictedPhotoIds: number[] = []

            while (lru.length > PHOTO_BOUNDS.MAX_PAGES) {
              const evictedPage = lru.shift()
              if (evictedPage !== undefined) {
                evictedPages.push(evictedPage)
                const idsToEvict = pagePhotoIdsRef.current.get(evictedPage)
                if (idsToEvict) {
                  for (const id of idsToEvict) {
                    evictedPhotoIds.push(id)
                  }
                  pagePhotoIdsRef.current.delete(evictedPage)
                }
              }
            }
            pageLruRef.current = lru

            setPages((prev) => {
              const next = new Map(prev)
              next.set(pageIndex, pageItems)
              for (const evictedPage of evictedPages) {
                next.delete(evictedPage)
              }
              return next
            })

            setSearchScores((prev) => {
              const next = new Map(prev)
              for (const item of res.items) {
                if (typeof item.score === 'number') {
                  next.set(item.photo.id, item.score)
                }
              }
              for (const id of evictedPhotoIds) {
                next.delete(id)
              }
              return next
            })
            return
          }

          if (!window.api?.searchPhotosSemantic) {
            throw new Error('Semantic search API unavailable')
          }
          const res = await window.api.searchPhotosSemantic({
            queryText: query,
            offset: pageIndex * PHOTO_BOUNDS.PAGE_SIZE,
            limit: PHOTO_BOUNDS.PAGE_SIZE,
            ratingFilter: filters.rating,
            flagFilter: filters.flag,
            collectionId: filters.collection,
            captureDateFrom: filters.metadata.captureDateFrom,
            captureDateTo: filters.metadata.captureDateTo,
            includeUnknownCaptureDate: filters.metadata.includeUnknownCaptureDate,
            cameraNormalized: filters.metadata.cameraNormalized,
            onlyUnknownCamera: filters.metadata.onlyUnknownCamera,
            lensNormalized: filters.metadata.lensNormalized,
            onlyUnknownLens: filters.metadata.onlyUnknownLens,
            minWidthPx: filters.metadata.minWidthPx,
            minHeightPx: filters.metadata.minHeightPx,
            includeUnknownDimensions: filters.metadata.includeUnknownDimensions,
            fileTypeBasis: filters.metadata.fileTypeBasis,
            fileTypeValue: filters.metadata.fileTypeValue,
            onlyUnknownDetectedFormat: filters.metadata.onlyUnknownDetectedFormat,
            ...(searchOwnerGenRef.current !== null ? { ownerGen: searchOwnerGenRef.current } : {})
          })

          // Discard response if generation changed
          if (generationRef.current !== currentGeneration) {
            return
          }

          inFlightPagesRef.current.delete(pageIndex)
          setTotalCount(res.totalMatched)
          setModelStatus(res.modelStatus)
          setSearchMode('visual_only')
          setSearchResultMeta({
            totalMatched: res.totalMatched,
            eligibleCount: res.eligibleCount,
            unindexedCount: res.unindexedCount,
            staleCount: res.staleCount,
            corruptCount: res.corruptCount ?? 0,
            truncated: res.truncated,
            tokenCount: res.tokenCount,
            queryLatencyMs: res.queryLatencyMs
          })

          const pageItems = res.items.map((i) => i.photo)
          pagePhotoIdsRef.current.set(
            pageIndex,
            pageItems.map((p) => p.id)
          )

          const lru = pageLruRef.current.filter((p) => p !== pageIndex)
          lru.push(pageIndex)
          const evictedPages: number[] = []
          const evictedPhotoIds: number[] = []

          while (lru.length > PHOTO_BOUNDS.MAX_PAGES) {
            const evictedPage = lru.shift()
            if (evictedPage !== undefined) {
              evictedPages.push(evictedPage)
              const idsToEvict = pagePhotoIdsRef.current.get(evictedPage)
              if (idsToEvict) {
                for (const id of idsToEvict) {
                  evictedPhotoIds.push(id)
                }
                pagePhotoIdsRef.current.delete(evictedPage)
              }
            }
          }
          pageLruRef.current = lru

          setPages((prev) => {
            const next = new Map(prev)
            next.set(pageIndex, pageItems)
            for (const evictedPage of evictedPages) {
              next.delete(evictedPage)
            }
            return next
          })

          setSearchScores((prev) => {
            const next = new Map(prev)
            for (const item of res.items) {
              next.set(item.photo.id, item.score)
            }
            for (const id of evictedPhotoIds) {
              next.delete(id)
            }
            return next
          })
        } else {
          if (!window.api?.getPhotosPage) {
            throw new Error('Photos API unavailable')
          }
          if (pageIndex === 0) {
            displayedViewQueryRef.current = {
              queryText: '',
              filterOverrides: null,
              bypassVisualModel: false,
              rating: filters.rating,
              flag: filters.flag,
              collection: filters.collection,
              metadata: filters.metadata
            }
            setSearchResultMeta(null)
            setSearchMode(null)
            interpretedFiltersRef.current = null
            setInterpretedFilters(null)
            setClarification(null)
            setVisualModelRequired(false)
            setFilteredCandidateCount(0)
            setSearchScores(new Map())
          }

          const res = await window.api.getPhotosPage({
            offset: pageIndex * PHOTO_BOUNDS.PAGE_SIZE,
            limit: PHOTO_BOUNDS.PAGE_SIZE,
            ratingFilter: filters.rating,
            flagFilter: filters.flag,
            collectionId: filters.collection,
            captureDateFrom: filters.metadata.captureDateFrom,
            captureDateTo: filters.metadata.captureDateTo,
            includeUnknownCaptureDate: filters.metadata.includeUnknownCaptureDate,
            cameraNormalized: filters.metadata.cameraNormalized,
            onlyUnknownCamera: filters.metadata.onlyUnknownCamera,
            lensNormalized: filters.metadata.lensNormalized,
            onlyUnknownLens: filters.metadata.onlyUnknownLens,
            minWidthPx: filters.metadata.minWidthPx,
            minHeightPx: filters.metadata.minHeightPx,
            includeUnknownDimensions: filters.metadata.includeUnknownDimensions,
            fileTypeBasis: filters.metadata.fileTypeBasis,
            fileTypeValue: filters.metadata.fileTypeValue,
            onlyUnknownDetectedFormat: filters.metadata.onlyUnknownDetectedFormat
          })

          // Discard response if generation changed
          if (generationRef.current !== currentGeneration) {
            return
          }

          inFlightPagesRef.current.delete(pageIndex)
          setTotalCount(res.totalCount)

          pagePhotoIdsRef.current.set(
            pageIndex,
            res.items.map((p) => p.id)
          )
          const lru = pageLruRef.current.filter((p) => p !== pageIndex)
          lru.push(pageIndex)
          const evictedPages: number[] = []
          while (lru.length > PHOTO_BOUNDS.MAX_PAGES) {
            const evictedPage = lru.shift()
            if (evictedPage !== undefined) {
              evictedPages.push(evictedPage)
              pagePhotoIdsRef.current.delete(evictedPage)
            }
          }
          pageLruRef.current = lru

          setPages((prev) => {
            const next = new Map(prev)
            next.set(pageIndex, res.items)
            for (const evictedPage of evictedPages) {
              next.delete(evictedPage)
            }
            return next
          })
        }
      } catch (err: unknown) {
        if (generationRef.current === currentGeneration) {
          if (pageIndex === 0) {
            inFlightPagesRef.current.clear()
          } else {
            if (pageIndex === 0) {
              displayedViewQueryRef.current = {
                queryText: query,
                filterOverrides: activeFilterOverrides,
                bypassVisualModel: activeBypassVisualModel,
                rating: filters.rating,
                flag: filters.flag,
                collection: filters.collection,
                metadata: filters.metadata
              }
            }
            inFlightPagesRef.current.delete(pageIndex)
          }
          const rawMsg = err instanceof Error ? err.message : 'Failed to load photographs'
          if (
            !rawMsg.includes('SEARCH_CANCELLED') &&
            !rawMsg.includes('cancelled') &&
            !rawMsg.includes('superseded')
          ) {
            const isSearchLoad = Boolean(query || hasFilterOverrides)
            setError(formatPhotoLoadError(rawMsg, isSearchLoad))
            setErrorDetails(rawMsg)
            if (pageIndex === 0) {
              const lastGood = lastGoodViewRef.current
              if (lastGood && lastGood.pages.size > 0) {
                restoredGridQueryRef.current = lastGood.viewQuery
                displayedViewQueryRef.current = lastGood.viewQuery
                setPages(new Map(lastGood.pages))
                setTotalCount(lastGood.totalCount)
                setSearchMode(lastGood.searchMode)
                setSearchResultMeta(lastGood.searchResultMeta)
                setSearchScores(new Map(lastGood.searchScores))
                pageLruRef.current = Array.from(lastGood.pages.keys())
                pagePhotoIdsRef.current = new Map(
                  Array.from(lastGood.pages.entries()).map(([p, items]) => [
                    p,
                    items.map((item) => item.id)
                  ])
                )
              } else {
                restoredGridQueryRef.current = null
                setPages(new Map())
                setTotalCount(0)
                setSearchScores(new Map())
              }
            }
          }
        }
      } finally {
        if (generationRef.current === currentGeneration && pageIndex === 0) {
          setIsLoading(false)
          setIsSearching(false)
        }
      }
    },
    []
  )

  const applyFilters = useCallback(
    (
      newRating: PhotoRatingFilter,
      newFlag: PhotoFlagFilter,
      newCollection: number | null,
      newMetadata: PhotoMetadataFilterState
    ) => {
      const nextGen = ++generationRef.current
      if (searchQueryRef.current) {
        searchOwnerGenRef.current = allocateSearchOwnerGen()
      }
      snapshotLastGoodView()
      restoredGridQueryRef.current = null
      pageLruRef.current = []
      pagePhotoIdsRef.current.clear()
      inFlightPagesRef.current.clear()
      inFlightThumbsRef.current.clear()
      setPages(new Map())
      setTotalCount(0)
      setSearchScores(new Map())
      setThumbnails(new Map())
      setIsLoading(true)
      setIsSearching(Boolean(searchQueryRef.current))
      setError(null)
      setErrorDetails(null)
      setFilterGeneration((prev) => prev + 1)
      void loadPage(0, nextGen, {
        rating: newRating,
        flag: newFlag,
        collection: newCollection,
        metadata: newMetadata,
        searchQuery: searchQueryRef.current
      })
    },
    [loadPage, snapshotLastGoodView]
  )

  const setSearchQuery = useCallback(
    (newQuery: string) => {
      const trimmed = newQuery.trim()
      searchQueryRef.current = trimmed
      filterOverridesRef.current = null
      bypassVisualModelRef.current = false
      setSearchQueryState(trimmed)
      setClarification(null)
      setVisualModelRequired(false)
      setFilteredCandidateCount(0)
      if (trimmed) {
        searchOwnerGenRef.current = allocateSearchOwnerGen()
      } else if (searchOwnerGenRef.current !== null) {
        void window.api?.cancelPhotosSemanticSearch?.({ ownerGen: searchOwnerGenRef.current })
        searchOwnerGenRef.current = null
      }
      snapshotLastGoodView()
      restoredGridQueryRef.current = null
      const nextGen = ++generationRef.current
      pageLruRef.current = []
      pagePhotoIdsRef.current.clear()
      inFlightPagesRef.current.clear()
      inFlightThumbsRef.current.clear()
      setPages(new Map())
      setTotalCount(0)
      setSearchScores(new Map())
      setThumbnails(new Map())
      setIsLoading(true)
      setIsSearching(Boolean(trimmed))
      setError(null)
      setErrorDetails(null)
      setFilterGeneration((prev) => prev + 1)
      void loadPage(0, nextGen, {
        rating: ratingFilterRef.current,
        flag: flagFilterRef.current,
        collection: collectionIdRef.current,
        metadata: metadataFiltersRef.current,
        searchQuery: trimmed
      })
    },
    [loadPage, snapshotLastGoodView]
  )

  const clearSearch = useCallback(() => {
    searchQueryRef.current = ''
    filterOverridesRef.current = null
    bypassVisualModelRef.current = false
    setSearchQueryState('')
    setSearchMode(null)
    interpretedFiltersRef.current = null
    setInterpretedFilters(null)
    setClarification(null)
    setVisualModelRequired(false)
    setFilteredCandidateCount(0)
    setSearchResultMeta(null)
    setSearchScores(new Map())
    const cancelOwnerGen = searchOwnerGenRef.current
    searchOwnerGenRef.current = null
    void window.api?.cancelPhotosSemanticSearch?.(
      cancelOwnerGen !== null ? { ownerGen: cancelOwnerGen } : undefined
    )
    lastGoodViewRef.current = null
    restoredGridQueryRef.current = null
    const nextGen = ++generationRef.current
    pageLruRef.current = []
    pagePhotoIdsRef.current.clear()
    inFlightPagesRef.current.clear()
    inFlightThumbsRef.current.clear()
    setPages(new Map())
    setTotalCount(0)
    setThumbnails(new Map())
    setIsLoading(true)
    setIsSearching(false)
    setError(null)
    setErrorDetails(null)
    setFilterGeneration((prev) => prev + 1)
    void loadPage(0, nextGen, {
      rating: ratingFilterRef.current,
      flag: flagFilterRef.current,
      collection: collectionIdRef.current,
      metadata: metadataFiltersRef.current,
      searchQuery: ''
    })
  }, [loadPage])

  const updateInterpretedFilters = useCallback(
    (next: InterpretedSearchFilters) => {
      filterOverridesRef.current = next
      bypassVisualModelRef.current = false
      interpretedFiltersRef.current = next
      setInterpretedFilters(next)
      setClarification(null)
      setVisualModelRequired(false)
      searchOwnerGenRef.current = allocateSearchOwnerGen()
      snapshotLastGoodView()
      restoredGridQueryRef.current = null
      const nextGen = ++generationRef.current
      pageLruRef.current = []
      pagePhotoIdsRef.current.clear()
      inFlightPagesRef.current.clear()
      inFlightThumbsRef.current.clear()
      setPages(new Map())
      setTotalCount(0)
      setSearchScores(new Map())
      setThumbnails(new Map())
      setIsLoading(true)
      setIsSearching(true)
      setError(null)
      setErrorDetails(null)
      setFilterGeneration((prev) => prev + 1)
      void loadPage(0, nextGen, {
        rating: ratingFilterRef.current,
        flag: flagFilterRef.current,
        collection: collectionIdRef.current,
        metadata: metadataFiltersRef.current,
        searchQuery: searchQueryRef.current
      })
    },
    [loadPage, snapshotLastGoodView]
  )

  const clearInterpretedFilter = useCallback(
    (field: 'place' | 'date' | 'camera' | 'visualTerms') => {
      const curr = interpretedFiltersRef.current
      if (!curr) {
        clearSearch()
        return
      }
      const next: InterpretedSearchFilters = {
        ...curr,
        [field]: null
      }
      if (!next.place && !next.date && !next.camera && !next.visualTerms) {
        clearSearch()
        return
      }
      updateInterpretedFilters(next)
    },
    [clearSearch, updateInterpretedFilters]
  )

  const showMetadataMatchesWithoutVisualModel = useCallback(() => {
    snapshotLastGoodView()
    bypassVisualModelRef.current = true
    filterOverridesRef.current = interpretedFiltersRef.current
    const nextGen = ++generationRef.current
    pageLruRef.current = []
    pagePhotoIdsRef.current.clear()
    inFlightPagesRef.current.clear()
    inFlightThumbsRef.current.clear()
    setPages(new Map())
    setTotalCount(0)
    setSearchScores(new Map())
    setThumbnails(new Map())
    setIsLoading(true)
    setIsSearching(true)
    setError(null)
    setErrorDetails(null)
    void loadPage(0, nextGen, {
      rating: ratingFilterRef.current,
      flag: flagFilterRef.current,
      collection: collectionIdRef.current,
      metadata: metadataFiltersRef.current,
      searchQuery: searchQueryRef.current
    })
  }, [loadPage, snapshotLastGoodView])

  const upsertSavedEvent = useCallback(
    async (input: {
      name: string
      dateFrom: string
      dateTo: string
    }): Promise<SavedEvent | null> => {
      if (!window.api?.upsertSavedEvent) return null
      const saved = await window.api.upsertSavedEvent(input)
      await refreshUserPhotoMetadata()
      return saved
    },
    [refreshUserPhotoMetadata]
  )

  const deleteSavedEvent = useCallback(
    async (id: number): Promise<void> => {
      if (!window.api?.deleteSavedEvent) return
      await window.api.deleteSavedEvent(id)
      await refreshUserPhotoMetadata()
    },
    [refreshUserPhotoMetadata]
  )

  const upsertSavedPlace = useCallback(
    async (input: {
      name: string
      minLat: number
      maxLat: number
      minLon: number
      maxLon: number
    }): Promise<SavedPlace | null> => {
      if (!window.api?.upsertSavedPlace) return null
      const saved = await window.api.upsertSavedPlace(input)
      await refreshUserPhotoMetadata()
      return saved
    },
    [refreshUserPhotoMetadata]
  )

  const deleteSavedPlace = useCallback(
    async (id: number): Promise<void> => {
      if (!window.api?.deleteSavedPlace) return
      await window.api.deleteSavedPlace(id)
      await refreshUserPhotoMetadata()
    },
    [refreshUserPhotoMetadata]
  )

  const setPhotoUserPlace = useCallback(
    async (input: {
      fileLocationId: number
      placeId?: number | null
      placeLabel: string
    }): Promise<PhotoUserPlace | null> => {
      if (!window.api?.setPhotoUserPlace) return null
      return await window.api.setPhotoUserPlace(input)
    },
    []
  )

  const clearPhotoUserPlace = useCallback(async (fileLocationId: number): Promise<void> => {
    if (!window.api?.clearPhotoUserPlace) return
    await window.api.clearPhotoUserPlace({ fileLocationId })
  }, [])

  const upsertCameraLabel = useCallback(
    async (input: { cameraNormalized: string; label: string }): Promise<CameraLabel | null> => {
      if (!window.api?.upsertCameraLabel) return null
      const saved = await window.api.upsertCameraLabel(input)
      await refreshUserPhotoMetadata()
      return saved
    },
    [refreshUserPhotoMetadata]
  )

  const deleteCameraLabel = useCallback(
    async (id: number): Promise<void> => {
      if (!window.api?.deleteCameraLabel) return
      await window.api.deleteCameraLabel(id)
      await refreshUserPhotoMetadata()
    },
    [refreshUserPhotoMetadata]
  )

  const saveEventAndRetrySearch = useCallback(
    async (input: { name: string; dateFrom: string; dateTo: string }): Promise<void> => {
      await upsertSavedEvent(input)
      filterOverridesRef.current = null
      bypassVisualModelRef.current = false
      restoredGridQueryRef.current = null
      setClarification(null)
      const nextGen = ++generationRef.current
      pageLruRef.current = []
      pagePhotoIdsRef.current.clear()
      inFlightPagesRef.current.clear()
      inFlightThumbsRef.current.clear()
      setPages(new Map())
      setSearchScores(new Map())
      setIsLoading(true)
      setIsSearching(true)
      await loadPage(0, nextGen, {
        rating: ratingFilterRef.current,
        flag: flagFilterRef.current,
        collection: collectionIdRef.current,
        metadata: metadataFiltersRef.current,
        searchQuery: searchQueryRef.current
      })
    },
    [loadPage, upsertSavedEvent]
  )

  const selectDisambiguatedPlace = useCallback(
    (option: SearchClarificationOption) => {
      const curr = interpretedFiltersRef.current ?? {
        place: null,
        date: null,
        camera: null,
        visualTerms: null
      }
      updateInterpretedFilters({
        ...curr,
        place: {
          label: option.label,
          normalizedLabel: option.label.trim().toLowerCase(),
          source: option.savedPlaceId ? 'saved_place' : 'offline_gazetteer',
          savedPlaceId: option.savedPlaceId ?? null,
          gpsBounds: option.gpsBounds
        }
      })
    },
    [updateInterpretedFilters]
  )

  const saveCustomPlaceAndRetrySearch = useCallback(
    async (input: {
      name: string
      minLat: number
      maxLat: number
      minLon: number
      maxLon: number
    }): Promise<void> => {
      await upsertSavedPlace(input)
      filterOverridesRef.current = null
      bypassVisualModelRef.current = false
      restoredGridQueryRef.current = null
      setClarification(null)
      const nextGen = ++generationRef.current
      pageLruRef.current = []
      pagePhotoIdsRef.current.clear()
      inFlightPagesRef.current.clear()
      inFlightThumbsRef.current.clear()
      setPages(new Map())
      setSearchScores(new Map())
      setIsLoading(true)
      setIsSearching(true)
      await loadPage(0, nextGen, {
        rating: ratingFilterRef.current,
        flag: flagFilterRef.current,
        collection: collectionIdRef.current,
        metadata: metadataFiltersRef.current,
        searchQuery: searchQueryRef.current
      })
    },
    [loadPage, upsertSavedPlace]
  )

  const setRatingFilter = useCallback(
    (newRating: PhotoRatingFilter) => {
      ratingFilterRef.current = newRating
      setRatingFilterState(newRating)
      applyFilters(
        newRating,
        flagFilterRef.current,
        collectionIdRef.current,
        metadataFiltersRef.current
      )
    },
    [applyFilters]
  )

  const setFlagFilter = useCallback(
    (newFlag: PhotoFlagFilter) => {
      flagFilterRef.current = newFlag
      setFlagFilterState(newFlag)
      applyFilters(
        ratingFilterRef.current,
        newFlag,
        collectionIdRef.current,
        metadataFiltersRef.current
      )
    },
    [applyFilters]
  )

  const setCollectionId = useCallback(
    (newCollection: number | null) => {
      collectionIdRef.current = newCollection
      setCollectionIdState(newCollection)
      applyFilters(
        ratingFilterRef.current,
        flagFilterRef.current,
        newCollection,
        metadataFiltersRef.current
      )
    },
    [applyFilters]
  )

  const updateMetadataFilters = useCallback(
    (patch: Partial<PhotoMetadataFilterState>) => {
      const nextMetadata: PhotoMetadataFilterState = {
        ...metadataFiltersRef.current,
        ...patch
      }
      metadataFiltersRef.current = nextMetadata
      setMetadataFiltersState(nextMetadata)
      applyFilters(
        ratingFilterRef.current,
        flagFilterRef.current,
        collectionIdRef.current,
        nextMetadata
      )
    },
    [applyFilters]
  )

  const resetFilters = useCallback(() => {
    ratingFilterRef.current = 'all'
    flagFilterRef.current = 'all'
    collectionIdRef.current = null
    metadataFiltersRef.current = DEFAULT_PHOTO_METADATA_FILTERS
    searchQueryRef.current = ''
    filterOverridesRef.current = null
    bypassVisualModelRef.current = false
    setSearchQueryState('')
    setSearchMode(null)
    interpretedFiltersRef.current = null
    setInterpretedFilters(null)
    setClarification(null)
    setVisualModelRequired(false)
    setFilteredCandidateCount(0)
    setSearchResultMeta(null)
    setSearchScores(new Map())
    const cancelOwnerGen = searchOwnerGenRef.current
    searchOwnerGenRef.current = null
    void window.api?.cancelPhotosSemanticSearch?.(
      cancelOwnerGen !== null ? { ownerGen: cancelOwnerGen } : undefined
    )
    setRatingFilterState('all')
    setFlagFilterState('all')
    setCollectionIdState(null)
    setMetadataFiltersState(DEFAULT_PHOTO_METADATA_FILTERS)
    applyFilters('all', 'all', null, DEFAULT_PHOTO_METADATA_FILTERS)
  }, [applyFilters])

  const ensureRangeLoaded = useCallback(
    (startIndex: number, endIndex: number) => {
      if (inFlightPagesRef.current.has(0) && !pages.has(0)) {
        return
      }
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
    if (searchQueryRef.current || filterOverridesRef.current) {
      searchOwnerGenRef.current = allocateSearchOwnerGen()
    }
    snapshotLastGoodView()
    restoredGridQueryRef.current = null
    const nextGen = ++generationRef.current
    pageLruRef.current = []
    pagePhotoIdsRef.current.clear()
    inFlightPagesRef.current.clear()
    inFlightThumbsRef.current.clear()
    setPages(new Map())
    setTotalCount(0)
    setSearchScores(new Map())
    setThumbnails(new Map())
    setIsLoading(true)
    setIsSearching(Boolean(searchQueryRef.current || filterOverridesRef.current))
    setError(null)
    setErrorDetails(null)
    setFilterGeneration((prev) => prev + 1)
    await loadPage(0, nextGen)
  }, [loadPage, snapshotLastGoodView])

  const matchesCurrentFilters = useCallback(
    (rating: number | null, flag: 'none' | 'pick' | 'reject'): boolean => {
      const rF = ratingFilterRef.current
      if (rF === 'unrated' && rating !== null) return false
      if (rF === '1' && (rating === null || rating < 1)) return false
      if (rF === '2' && (rating === null || rating < 2)) return false
      if (rF === '3' && (rating === null || rating < 3)) return false
      if (rF === '4' && (rating === null || rating < 4)) return false
      if (rF === '5' && (rating === null || rating !== 5)) return false

      const fF = flagFilterRef.current
      if (fF === 'none' && flag !== 'none') return false
      if (fF === 'pick' && flag !== 'pick') return false
      if (fF === 'reject' && flag !== 'reject') return false

      return true
    },
    []
  )

  const removePhotoFromFilterView = useCallback(
    (photoId: number) => {
      setSelectedId((prev) => (prev === photoId ? null : prev))
      void refresh()
    },
    [refresh]
  )

  const updatePhotoLocal = useCallback(
    (photoId: number, rating: number | null, flag: 'none' | 'pick' | 'reject', version: number) => {
      if (!matchesCurrentFilters(rating, flag)) {
        removePhotoFromFilterView(photoId)
        return
      }

      setPages((prev) => {
        let changed = false
        const next = new Map(prev)
        for (const [pageIdx, items] of next.entries()) {
          const itemIdx = items.findIndex((i) => i.id === photoId)
          if (itemIdx !== -1) {
            const updatedItems = [...items]
            const existing = updatedItems[itemIdx]!
            updatedItems[itemIdx] = {
              ...existing,
              rating,
              flag,
              annotationVersion: version
            }
            next.set(pageIdx, updatedItems)
            changed = true
            break
          }
        }
        return changed ? next : prev
      })
    },
    [matchesCurrentFilters, removePhotoFromFilterView]
  )

  const requestThumbnail = useCallback(
    (photo: PhotoItem, priority: 'high' | 'normal' | 'low' = 'normal') => {
      if (!window.api?.getThumbnail) return
      if (thumbnailsRef.current.has(photo.id)) return

      const currentGen = generationRef.current
      const existingReq = inFlightThumbsRef.current.get(photo.id)
      if (existingReq && existingReq.generation === currentGen) {
        return
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
          if (
            !activeReq ||
            activeReq.requestId !== requestId ||
            activeReq.generation !== currentGen ||
            activeReq.generation !== generationRef.current ||
            activeReq.revision !== revision
          ) {
            return
          }

          inFlightThumbsRef.current.delete(photo.id)

          if (
            result.status === 'error' &&
            (result.code === 'QUEUE_FULL' || result.code === 'CANCELLED')
          ) {
            return
          }

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
    []
  )

  const cancelThumbnail = useCallback((locationId: number) => {
    inFlightThumbsRef.current.delete(locationId)
    void window.api?.cancelThumbnail?.({ locationId })
  }, [])

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
      if (searchOwnerGenRef.current !== null) {
        const cancelOwnerGen = searchOwnerGenRef.current
        searchOwnerGenRef.current = null
        void window.api?.cancelPhotosSemanticSearch?.({ ownerGen: cancelOwnerGen })
      }
    }
  }, [])

  const photos = Array.from(pages.values()).flat()
  const selectedPhoto = photos.find((p) => p.id === selectedId) ?? null

  const selectPhoto = useCallback((id: number | null) => {
    setSelectedId(id)
  }, [])

  const cachedPageIndices = useMemo(() => Array.from(pages.keys()).sort((a, b) => a - b), [pages])

  return {
    photos,
    cachedPageIndices,
    totalCount,
    isLoading,
    error,
    errorDetails,
    selectedPhoto,
    selectedId,
    thumbnails,
    ratingFilter,
    flagFilter,
    collectionId,
    metadataFilters,
    filterGeneration,
    searchQuery,
    isSearching,
    searchMode,
    interpretedFilters,
    clarification,
    visualModelRequired,
    filteredCandidateCount,
    searchResultMeta,
    searchScores,
    modelStatus,
    savedEvents,
    savedPlaces,
    cameraLabels,
    setSearchQuery,
    clearSearch,
    updateInterpretedFilters,
    clearInterpretedFilter,
    showMetadataMatchesWithoutVisualModel,
    saveEventAndRetrySearch,
    selectDisambiguatedPlace,
    saveCustomPlaceAndRetrySearch,
    upsertSavedEvent,
    deleteSavedEvent,
    upsertSavedPlace,
    deleteSavedPlace,
    setPhotoUserPlace,
    clearPhotoUserPlace,
    upsertCameraLabel,
    deleteCameraLabel,
    selectPhoto,
    setRatingFilter,
    setFlagFilter,
    setCollectionId,
    updateMetadataFilters,
    resetFilters,
    updatePhotoLocal,
    removePhotoFromFilterView,
    refresh,
    ensureRangeLoaded,
    getPhoto,
    requestThumbnail,
    cancelThumbnail
  }
}
