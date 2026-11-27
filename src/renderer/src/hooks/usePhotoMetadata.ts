import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  PhotoFileTypeBasis,
  PhotoItem,
  PhotoMetadataAttentionItem,
  PhotoMetadataFacetField,
  PhotoMetadataFacetItem,
  PhotoMetadataProgressResponse,
  PhotoTechnicalMetadataDetail
} from '../../../shared/validation/ipc-schemas'

export const METADATA_FACET_PAGE_SIZE = 15

const DEFAULT_METADATA_PROGRESS: PhotoMetadataProgressResponse = {
  jobId: null,
  status: 'idle',
  parserRecipeVersion: 'exif_tech_v2',
  totalPhotos: 0,
  processedPhotos: 0,
  extractedPhotos: 0,
  absentMetadataPhotos: 0,
  reusedPhotos: 0,
  unsupportedPhotos: 0,
  failedPhotos: 0,
  unavailablePhotos: 0,
  pendingPhotos: 0,
  startedAtMs: null,
  updatedAtMs: null,
  completedAtMs: null,
  lastError: null,
  coverage: {
    parserRecipeVersion: 'exif_tech_v2',
    totalPhotos: 0,
    extractedCount: 0,
    noMetadataCount: 0,
    unsupportedCount: 0,
    failedCount: 0,
    unavailableCount: 0,
    staleCount: 0,
    unprocessedCount: 0
  }
}

export interface FacetSliceState {
  readonly items: readonly PhotoMetadataFacetItem[]
  readonly unknownCount: number
  readonly unprocessedCount: number
  readonly offset: number
  readonly limit: number
  readonly hasMore: boolean
  readonly search: string
  readonly isLoading: boolean
}

const DEFAULT_FACET_SLICE: FacetSliceState = {
  items: [],
  unknownCount: 0,
  unprocessedCount: 0,
  offset: 0,
  limit: METADATA_FACET_PAGE_SIZE,
  hasMore: false,
  search: '',
  isLoading: false
}

function buildPhotoRevisionKey(photo: PhotoItem | null): string | null {
  if (!photo) return null
  return `${photo.id}:${photo.discoveryObservationId}:${photo.byteSize}:${photo.filesystemMtimeMs ?? 'null'}:${photo.activeHash ?? 'unhashed'}`
}

export interface UsePhotoMetadataOptions {
  readonly selectedPhoto: PhotoItem | null
  readonly isPanelOpen: boolean
  readonly fileTypeBasis: PhotoFileTypeBasis
  readonly onExtractionSettled?: () => void
}

export function usePhotoMetadata({
  selectedPhoto,
  isPanelOpen,
  fileTypeBasis,
  onExtractionSettled
}: UsePhotoMetadataOptions) {
  const [progress, setProgress] = useState<PhotoMetadataProgressResponse>(DEFAULT_METADATA_PROGRESS)
  const [isBusy, setIsBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const [loadedDetailState, setLoadedDetailState] = useState<{
    readonly cacheKey: string
    readonly detail: PhotoTechnicalMetadataDetail | null
  } | null>(null)

  const [cameraFacet, setCameraFacet] = useState<FacetSliceState>(DEFAULT_FACET_SLICE)
  const [lensFacet, setLensFacet] = useState<FacetSliceState>(DEFAULT_FACET_SLICE)
  const [fileTypeFacet, setFileTypeFacet] = useState<FacetSliceState>(DEFAULT_FACET_SLICE)
  const [attentionItems, setAttentionItems] = useState<readonly PhotoMetadataAttentionItem[]>([])
  const [attentionTotalCount, setAttentionTotalCount] = useState(0)
  const [isLoadingAttentionItems, setIsLoadingAttentionItems] = useState(false)

  const [refreshTick, setRefreshTick] = useState(0)

  const isMountedRef = useRef(true)
  const progressEpochRef = useRef(0)
  const latestUpdatedAtRef = useRef(0)
  const prevJobStatusRef = useRef(progress.status)
  const onExtractionSettledRef = useRef(onExtractionSettled)

  const detailSeqRef = useRef(0)
  const activeRevisionKeyRef = useRef<string | null>(null)

  const cameraSeqRef = useRef(0)
  const lensSeqRef = useRef(0)
  const fileTypeSeqRef = useRef(0)
  const attentionSeqRef = useRef(0)

  useEffect(() => {
    onExtractionSettledRef.current = onExtractionSettled
  }, [onExtractionSettled])

  const applyProgress = useCallback(
    (next: PhotoMetadataProgressResponse, epoch: number, isLiveEvent = false) => {
      if (!isMountedRef.current) return
      if (!isLiveEvent && epoch < progressEpochRef.current) {
        return
      }
      if (
        !isLiveEvent &&
        next.updatedAtMs !== null &&
        latestUpdatedAtRef.current > next.updatedAtMs
      ) {
        return
      }
      progressEpochRef.current = Math.max(progressEpochRef.current, epoch)
      if (next.updatedAtMs !== null && next.updatedAtMs > latestUpdatedAtRef.current) {
        latestUpdatedAtRef.current = next.updatedAtMs
      }

      const prevStatus = prevJobStatusRef.current
      prevJobStatusRef.current = next.status
      setProgress(next)

      if (
        prevStatus === 'running' &&
        (next.status === 'completed' ||
          next.status === 'paused' ||
          next.status === 'cancelled' ||
          next.status === 'failed')
      ) {
        setRefreshTick((t) => t + 1)
        if (next.status === 'completed') {
          onExtractionSettledRef.current?.()
        }
      }
    },
    []
  )

  const refreshMetadata = useCallback(async () => {
    const api = window.api
    if (!api?.getPhotoMetadataProgress) return
    const epoch = ++progressEpochRef.current
    try {
      const res = await api.getPhotoMetadataProgress()
      if (res) {
        applyProgress(res, epoch, false)
      }
      setRefreshTick((t) => t + 1)
    } catch (err) {
      if (isMountedRef.current) {
        setActionError(err instanceof Error ? err.message : String(err))
      }
    }
  }, [applyProgress])

  useEffect(() => {
    isMountedRef.current = true
    const api = window.api
    if (api?.getPhotoMetadataProgress) {
      const epoch = ++progressEpochRef.current
      void api
        .getPhotoMetadataProgress()
        .then((res) => {
          if (res) applyProgress(res, epoch, false)
        })
        .catch((err) => {
          if (isMountedRef.current) {
            setActionError(err instanceof Error ? err.message : String(err))
          }
        })
    }

    const unsub = api?.onPhotoMetadataProgress?.((next) => {
      const epoch = ++progressEpochRef.current
      applyProgress(next, epoch, true)
    })

    return () => {
      isMountedRef.current = false
      detailSeqRef.current += 1
      cameraSeqRef.current += 1
      lensSeqRef.current += 1
      fileTypeSeqRef.current += 1
      unsub?.()
    }
  }, [applyProgress])

  // Selected-photo technical metadata detail with revision & sequence race guards
  const photoRevisionKey = buildPhotoRevisionKey(selectedPhoto)
  const selectedPhotoId = selectedPhoto?.id ?? null
  const detailCacheKey = photoRevisionKey !== null ? `${photoRevisionKey}:${refreshTick}` : null

  const selectedDetail =
    detailCacheKey !== null && loadedDetailState?.cacheKey === detailCacheKey
      ? loadedDetailState.detail
      : null
  const isLoadingDetail =
    Boolean(selectedPhotoId && detailCacheKey && window.api?.getPhotoMetadataDetail) &&
    loadedDetailState?.cacheKey !== detailCacheKey

  useEffect(() => {
    activeRevisionKeyRef.current = detailCacheKey
    const reqSeq = ++detailSeqRef.current

    if (!selectedPhotoId || !detailCacheKey || !window.api?.getPhotoMetadataDetail) {
      return
    }

    void window.api
      .getPhotoMetadataDetail({ fileLocationId: selectedPhotoId })
      .then((res) => {
        if (
          !isMountedRef.current ||
          reqSeq !== detailSeqRef.current ||
          activeRevisionKeyRef.current !== detailCacheKey
        ) {
          return
        }
        setLoadedDetailState({ cacheKey: detailCacheKey, detail: res.detail })
      })
      .catch(() => {
        if (
          isMountedRef.current &&
          reqSeq === detailSeqRef.current &&
          activeRevisionKeyRef.current === detailCacheKey
        ) {
          setLoadedDetailState({ cacheKey: detailCacheKey, detail: null })
        }
      })
  }, [selectedPhotoId, detailCacheKey])

  // Bounded facet queries with independent monotonic sequence guards
  const loadFacet = useCallback(
    async (
      field: PhotoMetadataFacetField,
      search: string,
      offset: number,
      seqRef: React.MutableRefObject<number>,
      setter: React.Dispatch<React.SetStateAction<FacetSliceState>>
    ) => {
      const api = window.api
      if (!api?.getPhotoMetadataFacets) {
        return
      }
      const seq = ++seqRef.current
      setter((prev) => ({ ...prev, search, offset, isLoading: true }))

      try {
        const trimmed = search.trim()
        const res = await api.getPhotoMetadataFacets({
          field,
          ...(trimmed.length > 0 ? { search: trimmed } : {}),
          limit: METADATA_FACET_PAGE_SIZE,
          offset
        })
        if (!isMountedRef.current || seq !== seqRef.current) {
          return
        }
        setter({
          items: res.items,
          unknownCount: res.unknownCount,
          unprocessedCount: res.unprocessedCount,
          offset: res.offset,
          limit: res.limit,
          hasMore: res.hasMore,
          search,
          isLoading: false
        })
      } catch {
        if (isMountedRef.current && seq === seqRef.current) {
          setter((prev) => ({ ...prev, isLoading: false }))
        }
      }
    },
    []
  )

  useEffect(() => {
    if (!isPanelOpen) return
    void loadFacet('camera', cameraFacet.search, cameraFacet.offset, cameraSeqRef, setCameraFacet)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPanelOpen, refreshTick])

  useEffect(() => {
    if (!isPanelOpen) return
    void loadFacet('lens', lensFacet.search, lensFacet.offset, lensSeqRef, setLensFacet)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPanelOpen, refreshTick])

  useEffect(() => {
    if (!isPanelOpen) return
    void loadFacet(fileTypeBasis, '', 0, fileTypeSeqRef, setFileTypeFacet)
  }, [isPanelOpen, fileTypeBasis, refreshTick, loadFacet])

  const setCameraFacetSearch = useCallback(
    (search: string) => {
      void loadFacet('camera', search, 0, cameraSeqRef, setCameraFacet)
    },
    [loadFacet]
  )

  const setCameraFacetOffset = useCallback(
    (offset: number) => {
      void loadFacet(
        'camera',
        cameraFacet.search,
        Math.max(0, offset),
        cameraSeqRef,
        setCameraFacet
      )
    },
    [cameraFacet.search, loadFacet]
  )

  const setLensFacetSearch = useCallback(
    (search: string) => {
      void loadFacet('lens', search, 0, lensSeqRef, setLensFacet)
    },
    [loadFacet]
  )

  const setLensFacetOffset = useCallback(
    (offset: number) => {
      void loadFacet('lens', lensFacet.search, Math.max(0, offset), lensSeqRef, setLensFacet)
    },
    [lensFacet.search, loadFacet]
  )

  const setFileTypeFacetOffset = useCallback(
    (offset: number) => {
      void loadFacet(
        fileTypeBasis,
        fileTypeFacet.search,
        Math.max(0, offset),
        fileTypeSeqRef,
        setFileTypeFacet
      )
    },
    [fileTypeBasis, fileTypeFacet.search, loadFacet]
  )

  const startExtraction = useCallback(
    async (retryFailed = false) => {
      if (!window.api?.startPhotoMetadataExtraction) return
      setActionError(null)
      setIsBusy(true)
      const epoch = ++progressEpochRef.current
      try {
        const res = await window.api.startPhotoMetadataExtraction({ retryFailed })
        applyProgress(res, epoch, false)
      } catch (err) {
        if (isMountedRef.current) {
          setActionError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        if (isMountedRef.current) {
          setIsBusy(false)
        }
      }
    },
    [applyProgress]
  )

  const pauseExtraction = useCallback(async () => {
    if (!window.api?.pausePhotoMetadataExtraction) return
    setActionError(null)
    setIsBusy(true)
    const epoch = ++progressEpochRef.current
    try {
      const res = await window.api.pausePhotoMetadataExtraction()
      applyProgress(res, epoch, false)
    } catch (err) {
      if (isMountedRef.current) {
        setActionError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      if (isMountedRef.current) {
        setIsBusy(false)
      }
    }
  }, [applyProgress])

  const resumeExtraction = useCallback(async () => {
    if (!window.api?.resumePhotoMetadataExtraction) return
    setActionError(null)
    setIsBusy(true)
    const epoch = ++progressEpochRef.current
    try {
      const res = await window.api.resumePhotoMetadataExtraction()
      applyProgress(res, epoch, false)
    } catch (err) {
      if (isMountedRef.current) {
        setActionError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      if (isMountedRef.current) {
        setIsBusy(false)
      }
    }
  }, [applyProgress])

  const cancelExtraction = useCallback(async () => {
    if (!window.api?.cancelPhotoMetadataExtraction) return
    setActionError(null)
    setIsBusy(true)
    const epoch = ++progressEpochRef.current
    try {
      const res = await window.api.cancelPhotoMetadataExtraction()
      applyProgress(res, epoch, false)
    } catch (err) {
      if (isMountedRef.current) {
        setActionError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      if (isMountedRef.current) {
        setIsBusy(false)
      }
    }
  }, [applyProgress])

  const loadAttentionItems = useCallback(async () => {
    const api = window.api
    if (!api?.getPhotoMetadataAttentionItems) return
    const seq = ++attentionSeqRef.current
    setIsLoadingAttentionItems(true)
    try {
      const res = await api.getPhotoMetadataAttentionItems({ limit: 50, offset: 0 })
      if (!isMountedRef.current || seq !== attentionSeqRef.current) return
      setAttentionItems(res.items)
      setAttentionTotalCount(res.totalCount)
    } catch {
      // ignore read failure
    } finally {
      if (isMountedRef.current && seq === attentionSeqRef.current) {
        setIsLoadingAttentionItems(false)
      }
    }
  }, [])

  return {
    progress,
    isBusy,
    actionError,
    selectedDetail,
    isLoadingDetail,
    cameraFacet,
    lensFacet,
    fileTypeFacet,
    attentionItems,
    attentionTotalCount,
    isLoadingAttentionItems,
    loadAttentionItems,
    setCameraFacetSearch,
    setCameraFacetOffset,
    setLensFacetSearch,
    setLensFacetOffset,
    setFileTypeFacetOffset,
    startExtraction,
    pauseExtraction,
    resumeExtraction,
    cancelExtraction,
    refreshMetadata
  }
}
