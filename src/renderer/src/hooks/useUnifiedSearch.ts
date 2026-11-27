import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  DocumentClutterFilter,
  DocumentExtensionFacetItem,
  PhotoFileTypeBasis,
  PhotoMetadataFacetItem,
  UnifiedDocumentFilters,
  UnifiedPhotoFilters,
  UnifiedSearchDocumentsResponse,
  UnifiedSearchModality,
  UnifiedSearchPhotosResponse,
  UnifiedSearchStatus
} from '../../../shared/validation/ipc-schemas'
import { allocateSearchOwnerGen } from './search-owner'

export const UNIFIED_SEARCH_PAGE_SIZE = 20

export type UnifiedModalityPhase = 'idle' | 'loading' | UnifiedSearchStatus

export interface UnifiedPhotoQuickFilters {
  readonly fileTypeBasis: PhotoFileTypeBasis
  readonly fileTypeValue: string | null
  readonly onlyUnknownDetectedFormat: boolean
}

export interface UnifiedDocumentQuickFilters {
  readonly clutterFilter: DocumentClutterFilter
  readonly textSourceKindFilter: 'native' | 'ocr' | null
  readonly extensionFilter: string | null
}

export const DEFAULT_UNIFIED_PHOTO_FILTERS: UnifiedPhotoQuickFilters = {
  fileTypeBasis: 'detected_format',
  fileTypeValue: null,
  onlyUnknownDetectedFormat: false
}

export const DEFAULT_UNIFIED_DOCUMENT_FILTERS: UnifiedDocumentQuickFilters = {
  clutterFilter: 'show_all',
  textSourceKindFilter: null,
  extensionFilter: null
}

export interface UnifiedModalityState<TResponse> {
  readonly phase: UnifiedModalityPhase
  readonly offset: number
  readonly response: TResponse | null
  readonly errorMessage: string | null
}

function createIdleModalityState<TResponse>(): UnifiedModalityState<TResponse> {
  return {
    phase: 'idle',
    offset: 0,
    response: null,
    errorMessage: null
  }
}

export function hasActivePhotoQuickFilters(filters: UnifiedPhotoQuickFilters): boolean {
  return filters.fileTypeValue !== null || filters.onlyUnknownDetectedFormat
}

export function hasActiveDocumentQuickFilters(filters: UnifiedDocumentQuickFilters): boolean {
  return (
    filters.clutterFilter !== 'show_all' ||
    filters.textSourceKindFilter !== null ||
    filters.extensionFilter !== null
  )
}

function buildPhotoFiltersPayload(
  filters: UnifiedPhotoQuickFilters
): UnifiedPhotoFilters | undefined {
  if (
    filters.fileTypeBasis === 'detected_format' &&
    filters.fileTypeValue === null &&
    !filters.onlyUnknownDetectedFormat
  ) {
    return undefined
  }
  return {
    fileTypeBasis: filters.fileTypeBasis,
    ...(filters.fileTypeValue !== null ? { fileTypeValue: filters.fileTypeValue } : {}),
    ...(filters.onlyUnknownDetectedFormat ? { onlyUnknownDetectedFormat: true } : {})
  }
}

function buildDocumentFiltersPayload(
  filters: UnifiedDocumentQuickFilters
): UnifiedDocumentFilters | undefined {
  if (!hasActiveDocumentQuickFilters(filters)) {
    return undefined
  }
  return {
    ...(filters.clutterFilter !== 'show_all' ? { clutterFilter: filters.clutterFilter } : {}),
    ...(filters.textSourceKindFilter !== null
      ? { textSourceKindFilter: filters.textSourceKindFilter }
      : {}),
    ...(filters.extensionFilter !== null ? { extensionFilter: filters.extensionFilter } : {})
  }
}

function mapRejectedErrorToPhase(err: unknown): {
  phase: 'timed_out' | 'error'
  errorMessage: string
} {
  const errorMessage = err instanceof Error ? err.message : String(err)
  const phase = /timed?\s*out|timeout/i.test(errorMessage) ? 'timed_out' : 'error'
  return { phase, errorMessage }
}

export interface UseUnifiedSearchOptions {
  readonly isSurfaceActive: boolean
}

export interface UseUnifiedSearchResult {
  readonly hasActiveSearch: boolean
  readonly submittedQuery: string
  readonly modality: UnifiedSearchModality
  readonly photoFilters: UnifiedPhotoQuickFilters
  readonly documentFilters: UnifiedDocumentQuickFilters
  readonly photos: UnifiedModalityState<UnifiedSearchPhotosResponse>
  readonly documents: UnifiedModalityState<UnifiedSearchDocumentsResponse>
  readonly docExtensionFacets: readonly DocumentExtensionFacetItem[]
  readonly photoFileTypeFacets: readonly PhotoMetadataFacetItem[]
  readonly isSearchingAny: boolean
  readonly hasAnyQuickFilter: boolean
  readonly statusAnnouncement: string
  readonly submitSearch: (query: string) => void
  readonly clearSearch: () => void
  readonly setModality: (modality: UnifiedSearchModality) => void
  readonly updatePhotoFilters: (patch: Partial<UnifiedPhotoQuickFilters>) => void
  readonly updateDocumentFilters: (patch: Partial<UnifiedDocumentQuickFilters>) => void
  readonly resetQuickFilters: () => void
  readonly pagePhotos: (nextOffset: number) => void
  readonly pageDocuments: (nextOffset: number) => void
  readonly retryPhotos: () => void
  readonly retryDocuments: () => void
}

function summarizeModalityArrival(
  label: 'Photos' | 'Documents',
  phase: UnifiedModalityPhase,
  totalMatched?: number
): string {
  switch (phase) {
    case 'idle':
      return ''
    case 'loading':
      return `Searching ${label.toLowerCase()}.`
    case 'ready': {
      const count = totalMatched ?? 0
      if (count === 0) return `${label}: no matches found.`
      return `${label}: ${count} ${count === 1 ? 'match' : 'matches'} ready.`
    }
    case 'unprovisioned':
      return `${label} semantic search model is not installed.`
    case 'corrupt':
      return `${label} semantic search model is corrupt or invalid.`
    case 'timed_out':
      return `${label} search timed out.`
    case 'overloaded':
      return `${label} search queue is busy.`
    case 'cancelled':
      return `${label} search was cancelled.`
    case 'error':
      return `${label} search failed.`
  }
}

export function useUnifiedSearch({
  isSurfaceActive
}: UseUnifiedSearchOptions): UseUnifiedSearchResult {
  const [hasActiveSearch, setHasActiveSearch] = useState(false)
  const [submittedQuery, setSubmittedQuery] = useState('')
  const [modality, setModalityState] = useState<UnifiedSearchModality>('all')
  const [photoFilters, setPhotoFiltersState] = useState<UnifiedPhotoQuickFilters>(
    DEFAULT_UNIFIED_PHOTO_FILTERS
  )
  const [documentFilters, setDocumentFiltersState] = useState<UnifiedDocumentQuickFilters>(
    DEFAULT_UNIFIED_DOCUMENT_FILTERS
  )
  const [photos, setPhotos] = useState<UnifiedModalityState<UnifiedSearchPhotosResponse>>(() =>
    createIdleModalityState()
  )
  const [documents, setDocuments] = useState<UnifiedModalityState<UnifiedSearchDocumentsResponse>>(
    () => createIdleModalityState()
  )

  const [docExtensionFacets, setDocExtensionFacets] = useState<
    readonly DocumentExtensionFacetItem[]
  >([])
  const [photoFileTypeFacets, setPhotoFileTypeFacets] = useState<readonly PhotoMetadataFacetItem[]>(
    []
  )

  const isMountedRef = useRef(true)
  const photosOwnerGenRef = useRef<number | null>(null)
  const documentsOwnerGenRef = useRef<number | null>(null)
  const queryGenRef = useRef(0)
  const photosPageGenRef = useRef(0)
  const documentsPageGenRef = useRef(0)
  const activeQueryRef = useRef('')
  const modalityRef = useRef<UnifiedSearchModality>('all')
  const photoFiltersRef = useRef<UnifiedPhotoQuickFilters>(DEFAULT_UNIFIED_PHOTO_FILTERS)
  const documentFiltersRef = useRef<UnifiedDocumentQuickFilters>(DEFAULT_UNIFIED_DOCUMENT_FILTERS)
  const photosOffsetRef = useRef(0)
  const documentsOffsetRef = useRef(0)
  const docFacetsGenRef = useRef(0)
  const photoFacetsGenRef = useRef(0)

  const sendCancelUnified = useCallback(
    (ownerGen: number, targetModality: UnifiedSearchModality = 'all') => {
      try {
        const result = window.api?.cancelUnifiedSearch?.({
          ownerSurface: 'unified',
          ownerGen,
          modality: targetModality
        })
        void result?.catch?.(() => {})
      } catch {
        // Ignore bridge errors during teardown
      }
    },
    []
  )

  const cancelActiveOwners = useCallback(
    (targetModality: UnifiedSearchModality = 'all') => {
      const photosGen = targetModality !== 'documents' ? photosOwnerGenRef.current : null
      const docsGen = targetModality !== 'photos' ? documentsOwnerGenRef.current : null

      if (targetModality !== 'documents') {
        photosOwnerGenRef.current = null
      }
      if (targetModality !== 'photos') {
        documentsOwnerGenRef.current = null
      }

      if (photosGen !== null && docsGen !== null) {
        if (photosGen === docsGen) {
          sendCancelUnified(photosGen, 'all')
        } else {
          sendCancelUnified(photosGen, 'photos')
          sendCancelUnified(docsGen, 'documents')
        }
        return
      }

      if (photosGen !== null) {
        sendCancelUnified(photosGen, targetModality === 'all' ? 'all' : 'photos')
      } else if (docsGen !== null) {
        sendCancelUnified(docsGen, targetModality === 'all' ? 'all' : 'documents')
      }
    },
    [sendCancelUnified]
  )

  const dispatchPhotosSearch = useCallback(
    (
      query: string,
      offset: number,
      ownerGen: number,
      queryGen: number,
      pageGen: number,
      filters: UnifiedPhotoQuickFilters
    ) => {
      setPhotos({
        phase: 'loading',
        offset,
        response: null,
        errorMessage: null
      })

      const searchFn = window.api?.searchUnifiedPhotos
      if (typeof searchFn !== 'function') {
        setPhotos({
          phase: 'error',
          offset,
          response: null,
          errorMessage: 'Unified photo search API is unavailable.'
        })
        return
      }

      void searchFn({
        query,
        ownerSurface: 'unified',
        ownerGen,
        offset,
        limit: UNIFIED_SEARCH_PAGE_SIZE,
        photoFilters: buildPhotoFiltersPayload(filters)
      })
        .then((res) => {
          if (
            !isMountedRef.current ||
            queryGen !== queryGenRef.current ||
            pageGen !== photosPageGenRef.current
          ) {
            return
          }
          if (res.status === 'ready') {
            if (!res.result) {
              setPhotos({
                phase: 'error',
                offset,
                response: null,
                errorMessage: 'Photo search returned an empty payload.'
              })
              return
            }
            if (res.result.modelStatus !== 'ready') {
              setPhotos({
                phase: res.result.modelStatus,
                offset,
                response: res,
                errorMessage: res.errorMessage
              })
              return
            }
            setPhotos({
              phase: 'ready',
              offset,
              response: res,
              errorMessage: null
            })
            return
          }
          setPhotos({
            phase: res.status,
            offset,
            response: res,
            errorMessage: res.errorMessage
          })
        })
        .catch((err: unknown) => {
          if (
            !isMountedRef.current ||
            queryGen !== queryGenRef.current ||
            pageGen !== photosPageGenRef.current
          ) {
            return
          }
          const mapped = mapRejectedErrorToPhase(err)
          setPhotos({
            phase: mapped.phase,
            offset,
            response: null,
            errorMessage: mapped.errorMessage
          })
        })
    },
    []
  )

  const dispatchDocumentsSearch = useCallback(
    (
      query: string,
      offset: number,
      ownerGen: number,
      queryGen: number,
      pageGen: number,
      filters: UnifiedDocumentQuickFilters
    ) => {
      setDocuments({
        phase: 'loading',
        offset,
        response: null,
        errorMessage: null
      })

      const searchFn = window.api?.searchUnifiedDocuments
      if (typeof searchFn !== 'function') {
        setDocuments({
          phase: 'error',
          offset,
          response: null,
          errorMessage: 'Unified document search API is unavailable.'
        })
        return
      }

      void searchFn({
        query,
        ownerSurface: 'unified',
        ownerGen,
        offset,
        limit: UNIFIED_SEARCH_PAGE_SIZE,
        documentFilters: buildDocumentFiltersPayload(filters)
      })
        .then((res) => {
          if (
            !isMountedRef.current ||
            queryGen !== queryGenRef.current ||
            pageGen !== documentsPageGenRef.current
          ) {
            return
          }
          if (res.status === 'ready') {
            if (!res.result) {
              setDocuments({
                phase: 'error',
                offset,
                response: null,
                errorMessage: 'Document search returned an empty payload.'
              })
              return
            }
            setDocuments({
              phase: 'ready',
              offset,
              response: res,
              errorMessage: null
            })
            return
          }
          setDocuments({
            phase: res.status,
            offset,
            response: res,
            errorMessage: res.errorMessage
          })
        })
        .catch((err: unknown) => {
          if (
            !isMountedRef.current ||
            queryGen !== queryGenRef.current ||
            pageGen !== documentsPageGenRef.current
          ) {
            return
          }
          const mapped = mapRejectedErrorToPhase(err)
          setDocuments({
            phase: mapped.phase,
            offset,
            response: null,
            errorMessage: mapped.errorMessage
          })
        })
    },
    []
  )

  const dispatchQueryForCurrentState = useCallback(
    (
      query: string,
      nextModality: UnifiedSearchModality,
      nextPhotoFilters: UnifiedPhotoQuickFilters,
      nextDocFilters: UnifiedDocumentQuickFilters
    ) => {
      const queryGen = ++queryGenRef.current
      const photosPageGen = ++photosPageGenRef.current
      const docsPageGen = ++documentsPageGenRef.current
      const ownerGen = allocateSearchOwnerGen()
      photosOffsetRef.current = 0
      documentsOffsetRef.current = 0

      if (nextModality === 'all' || nextModality === 'photos') {
        photosOwnerGenRef.current = ownerGen
        dispatchPhotosSearch(query, 0, ownerGen, queryGen, photosPageGen, nextPhotoFilters)
      } else {
        photosOwnerGenRef.current = null
        setPhotos(createIdleModalityState())
      }

      if (nextModality === 'all' || nextModality === 'documents') {
        documentsOwnerGenRef.current = ownerGen
        dispatchDocumentsSearch(query, 0, ownerGen, queryGen, docsPageGen, nextDocFilters)
      } else {
        documentsOwnerGenRef.current = null
        setDocuments(createIdleModalityState())
      }
    },
    [dispatchDocumentsSearch, dispatchPhotosSearch]
  )

  // Lifecycle & unmount cleanup (React 19 StrictMode safe)
  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      queryGenRef.current += 1
      photosPageGenRef.current += 1
      documentsPageGenRef.current += 1
      cancelActiveOwners('all')
    }
  }, [cancelActiveOwners])

  // Cancel active unified search when leaving the All Items surface
  const prevSurfaceActiveRef = useRef(isSurfaceActive)
  useEffect(() => {
    const wasActive = prevSurfaceActiveRef.current
    prevSurfaceActiveRef.current = isSurfaceActive
    if (wasActive && !isSurfaceActive) {
      queryGenRef.current += 1
      photosPageGenRef.current += 1
      documentsPageGenRef.current += 1
      cancelActiveOwners('all')
      setPhotos((prev) =>
        prev.phase === 'loading'
          ? {
              ...prev,
              phase: 'cancelled',
              errorMessage: 'Search paused while viewing another tab.'
            }
          : prev
      )
      setDocuments((prev) =>
        prev.phase === 'loading'
          ? {
              ...prev,
              phase: 'cancelled',
              errorMessage: 'Search paused while viewing another tab.'
            }
          : prev
      )
    }
  }, [cancelActiveOwners, isSurfaceActive])

  // Lazy-load document extension facets when unified search opens
  useEffect(() => {
    if (!isSurfaceActive || !hasActiveSearch) return
    const getExtFacets = window.api?.getDocumentExtensionFacets
    if (typeof getExtFacets !== 'function') return
    const gen = ++docFacetsGenRef.current
    void getExtFacets({ limit: 50, offset: 0 })
      .then((res) => {
        if (!isMountedRef.current || gen !== docFacetsGenRef.current) return
        setDocExtensionFacets(res.items)
      })
      .catch(() => {})
  }, [isSurfaceActive, hasActiveSearch])

  // Lazy-load photo file-type facets when unified search opens or basis changes
  useEffect(() => {
    if (!isSurfaceActive || !hasActiveSearch) return
    const getPhotoFacets = window.api?.getPhotoMetadataFacets
    if (typeof getPhotoFacets !== 'function') return
    const gen = ++photoFacetsGenRef.current
    void getPhotoFacets({
      field: photoFilters.fileTypeBasis,
      limit: 50,
      offset: 0
    })
      .then((res) => {
        if (!isMountedRef.current || gen !== photoFacetsGenRef.current) return
        setPhotoFileTypeFacets(res.items)
      })
      .catch(() => {})
  }, [isSurfaceActive, hasActiveSearch, photoFilters.fileTypeBasis])

  const submitSearch = useCallback(
    (rawQuery: string) => {
      const trimmed = rawQuery.trim()
      if (!trimmed) return
      activeQueryRef.current = trimmed
      setSubmittedQuery(trimmed)
      setHasActiveSearch(true)
      dispatchQueryForCurrentState(
        trimmed,
        modalityRef.current,
        photoFiltersRef.current,
        documentFiltersRef.current
      )
    },
    [dispatchQueryForCurrentState]
  )

  const clearSearch = useCallback(() => {
    queryGenRef.current += 1
    photosPageGenRef.current += 1
    documentsPageGenRef.current += 1
    activeQueryRef.current = ''
    photosOffsetRef.current = 0
    documentsOffsetRef.current = 0
    setHasActiveSearch(false)
    setSubmittedQuery('')
    setPhotos(createIdleModalityState())
    setDocuments(createIdleModalityState())
    cancelActiveOwners('all')
  }, [cancelActiveOwners])

  const setModality = useCallback(
    (nextModality: UnifiedSearchModality) => {
      if (nextModality === modalityRef.current) return
      modalityRef.current = nextModality
      setModalityState(nextModality)

      if (!activeQueryRef.current) return

      if (nextModality === 'photos') {
        cancelActiveOwners('documents')
      } else if (nextModality === 'documents') {
        cancelActiveOwners('photos')
      }

      dispatchQueryForCurrentState(
        activeQueryRef.current,
        nextModality,
        photoFiltersRef.current,
        documentFiltersRef.current
      )
    },
    [cancelActiveOwners, dispatchQueryForCurrentState]
  )

  const updatePhotoFilters = useCallback(
    (patch: Partial<UnifiedPhotoQuickFilters>) => {
      const next: UnifiedPhotoQuickFilters = { ...photoFiltersRef.current, ...patch }
      photoFiltersRef.current = next
      setPhotoFiltersState(next)
      if (!activeQueryRef.current || modalityRef.current === 'documents') return
      dispatchQueryForCurrentState(
        activeQueryRef.current,
        modalityRef.current,
        next,
        documentFiltersRef.current
      )
    },
    [dispatchQueryForCurrentState]
  )

  const updateDocumentFilters = useCallback(
    (patch: Partial<UnifiedDocumentQuickFilters>) => {
      const next: UnifiedDocumentQuickFilters = { ...documentFiltersRef.current, ...patch }
      documentFiltersRef.current = next
      setDocumentFiltersState(next)
      if (!activeQueryRef.current || modalityRef.current === 'photos') return
      dispatchQueryForCurrentState(
        activeQueryRef.current,
        modalityRef.current,
        photoFiltersRef.current,
        next
      )
    },
    [dispatchQueryForCurrentState]
  )

  const resetQuickFilters = useCallback(() => {
    photoFiltersRef.current = DEFAULT_UNIFIED_PHOTO_FILTERS
    documentFiltersRef.current = DEFAULT_UNIFIED_DOCUMENT_FILTERS
    setPhotoFiltersState(DEFAULT_UNIFIED_PHOTO_FILTERS)
    setDocumentFiltersState(DEFAULT_UNIFIED_DOCUMENT_FILTERS)
    if (!activeQueryRef.current) return
    dispatchQueryForCurrentState(
      activeQueryRef.current,
      modalityRef.current,
      DEFAULT_UNIFIED_PHOTO_FILTERS,
      DEFAULT_UNIFIED_DOCUMENT_FILTERS
    )
  }, [dispatchQueryForCurrentState])

  const pagePhotos = useCallback(
    (nextOffset: number) => {
      const query = activeQueryRef.current
      if (!query || modalityRef.current === 'documents') return
      const clampedOffset = Math.max(0, Math.floor(nextOffset))
      const queryGen = queryGenRef.current
      const pageGen = ++photosPageGenRef.current
      const ownerGen =
        photosOwnerGenRef.current ?? (photosOwnerGenRef.current = allocateSearchOwnerGen())
      photosOffsetRef.current = clampedOffset
      dispatchPhotosSearch(
        query,
        clampedOffset,
        ownerGen,
        queryGen,
        pageGen,
        photoFiltersRef.current
      )
    },
    [dispatchPhotosSearch]
  )

  const pageDocuments = useCallback(
    (nextOffset: number) => {
      const query = activeQueryRef.current
      if (!query || modalityRef.current === 'photos') return
      const clampedOffset = Math.max(0, Math.floor(nextOffset))
      const queryGen = queryGenRef.current
      const pageGen = ++documentsPageGenRef.current
      const ownerGen =
        documentsOwnerGenRef.current ?? (documentsOwnerGenRef.current = allocateSearchOwnerGen())
      documentsOffsetRef.current = clampedOffset
      dispatchDocumentsSearch(
        query,
        clampedOffset,
        ownerGen,
        queryGen,
        pageGen,
        documentFiltersRef.current
      )
    },
    [dispatchDocumentsSearch]
  )

  const retryPhotos = useCallback(() => {
    const query = activeQueryRef.current
    if (!query || modalityRef.current === 'documents') return
    const queryGen = queryGenRef.current
    const pageGen = ++photosPageGenRef.current
    if (photosOwnerGenRef.current === null || photos.phase === 'cancelled') {
      photosOwnerGenRef.current = allocateSearchOwnerGen()
    }
    const ownerGen = photosOwnerGenRef.current
    dispatchPhotosSearch(
      query,
      photosOffsetRef.current,
      ownerGen,
      queryGen,
      pageGen,
      photoFiltersRef.current
    )
  }, [dispatchPhotosSearch, photos.phase])

  const retryDocuments = useCallback(() => {
    const query = activeQueryRef.current
    if (!query || modalityRef.current === 'photos') return
    const queryGen = queryGenRef.current
    const pageGen = ++documentsPageGenRef.current
    if (documentsOwnerGenRef.current === null || documents.phase === 'cancelled') {
      documentsOwnerGenRef.current = allocateSearchOwnerGen()
    }
    const ownerGen = documentsOwnerGenRef.current
    dispatchDocumentsSearch(
      query,
      documentsOffsetRef.current,
      ownerGen,
      queryGen,
      pageGen,
      documentFiltersRef.current
    )
  }, [dispatchDocumentsSearch, documents.phase])

  const hasAnyQuickFilter =
    hasActivePhotoQuickFilters(photoFilters) || hasActiveDocumentQuickFilters(documentFilters)

  const isSearchingAny =
    (modality !== 'documents' && photos.phase === 'loading') ||
    (modality !== 'photos' && documents.phase === 'loading')

  const statusAnnouncement = useMemo(() => {
    if (!hasActiveSearch) return ''
    const parts: string[] = []
    if (modality !== 'documents') {
      const pMsg = summarizeModalityArrival(
        'Photos',
        photos.phase,
        photos.response?.result?.totalMatched
      )
      if (pMsg) parts.push(pMsg)
    }
    if (modality !== 'photos') {
      const dMsg = summarizeModalityArrival(
        'Documents',
        documents.phase,
        documents.response?.result?.totalMatched
      )
      if (dMsg) parts.push(dMsg)
    }
    if (modality === 'all' && hasAnyQuickFilter) {
      if (hasActiveDocumentQuickFilters(documentFilters)) {
        parts.push('Document-only filters apply to Documents only.')
      }
      if (hasActivePhotoQuickFilters(photoFilters)) {
        parts.push('Photo-only filters apply to Photos only.')
      }
    }
    return parts.join(' ')
  }, [
    documentFilters,
    documents.phase,
    documents.response?.result?.totalMatched,
    hasActiveSearch,
    hasAnyQuickFilter,
    modality,
    photoFilters,
    photos.phase,
    photos.response?.result?.totalMatched
  ])

  return {
    hasActiveSearch,
    submittedQuery,
    modality,
    photoFilters,
    documentFilters,
    photos,
    documents,
    docExtensionFacets,
    photoFileTypeFacets,
    isSearchingAny,
    hasAnyQuickFilter,
    statusAnnouncement,
    submitSearch,
    clearSearch,
    setModality,
    updatePhotoFilters,
    updateDocumentFilters,
    resetQuickFilters,
    pagePhotos,
    pageDocuments,
    retryPhotos,
    retryDocuments
  }
}
