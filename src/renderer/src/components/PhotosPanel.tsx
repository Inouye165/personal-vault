/**
 * Personal Vault — Virtualized Photo Browsing Panel (Stage 5A/5B)
 *
 * Implements bounded, virtualized grid rendering with absolute catalog
 * positions, full collection scroll extent, keyboard navigation,
 * thumbnail decoding with honest placeholders, factual details panel,
 * and Stage 5B review features (ratings, flags, custom collections, and filters).
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement
} from 'react'
import {
  RefreshCw,
  Image as ImageIcon,
  AlertTriangle,
  FileQuestion,
  X,
  FileImage,
  Star,
  Check,
  Ban,
  Plus,
  FolderPlus,
  Edit2,
  SlidersHorizontal,
  Cpu,
  ArrowLeft,
  Play,
  Film,
  ExternalLink
} from 'lucide-react'
import {
  usePhotos,
  PHOTO_BOUNDS,
  countActiveMetadataFilters,
  hasActiveMetadataFilters
} from '../hooks/usePhotos'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { usePhotoReview } from '../hooks/usePhotoReview'
import { usePhotoMetadata } from '../hooks/usePhotoMetadata'
import { useSemanticIndex } from '../hooks/useSemanticIndex'
import { SimilarityReviewPanel } from './SimilarityReviewPanel'
import { SemanticIndexPanel } from './SemanticIndexPanel'
import { ScanJobsPanel, type ScanJobsPanelProps } from './ScanJobsPanel'
import { PhotoMetadataFilterPanel } from './PhotoMetadataFilterPanel'
import { PhotosSearchBar } from './PhotosSearchBar'
import { PhotoSelectedOcrSection } from './PhotoSelectedOcrSection'
import {
  MediaViewerModal,
  formatContainerLabel,
  formatMediaDuration,
  hasMismatchedVideoExtension
} from './MediaViewerModal'
import {
  matchGpsToOfflinePlaces,
  resolveOfflinePlace
} from '../../../shared/search/offline-gazetteer'
import type {
  MediaKindFilter,
  OpenInDefaultPlayerResponse,
  PhotoItem,
  PhotoTechnicalMetadataDetail,
  ThumbnailResult
} from '../../../shared/validation/ipc-schemas'
import type { PhotoRating } from '../../../shared/types/domain'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(ms: number | null): string {
  if (ms === null || ms === undefined || isNaN(ms)) return 'Unknown'
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

function renderInferredCaptureDateValue(
  photo: PhotoItem,
  detail: PhotoTechnicalMetadataDetail | null
): ReactElement | string {
  const meta = detail?.currentMetadata ?? null
  const effStatus = detail?.effectiveStatus ?? 'unprocessed'

  if (meta?.captureLocalIso) {
    const hasSubsecInIso = /\.\d+$/.test(meta.captureLocalIso)
    const formattedIso = `${meta.captureLocalIso}${!hasSubsecInIso && meta.captureSubseconds ? `.${meta.captureSubseconds}` : ''}${meta.captureOffsetText ?? ''}`
    const tzLabel =
      meta.captureTimezoneStatus === 'offset_present'
        ? `Explicit EXIF offset (${meta.captureOffsetText})`
        : meta.captureTimezoneStatus === 'local_wall_clock_unknown_tz'
          ? 'Local wall-clock time (timezone unknown — no EXIF offset)'
          : meta.captureTimezoneStatus === 'invalid_offset'
            ? 'Local wall-clock time (timezone unknown — invalid EXIF offset)'
            : 'Timezone unknown'

    return (
      <div className="metadata-provenance-stack">
        <span className="mono-value">{formattedIso}</span>
        <span className="sub-text">{tzLabel}</span>
        {meta.captureDateSourceTag && (
          <span className="sub-text">Derived from EXIF `{meta.captureDateSourceTag}`</span>
        )}
        {meta.captureDateConflict && (
          <span className="metadata-warning-inline">{meta.captureDateConflict}</span>
        )}
      </div>
    )
  }

  if (!detail || effStatus === 'unprocessed') {
    if (photo.inferredCaptureTimeMs !== null) {
      return formatDate(photo.inferredCaptureTimeMs)
    }
    return 'Unknown (not extracted yet)'
  }

  if (effStatus === 'stale') {
    return 'Unknown (not extracted yet — stale revision)'
  }

  if (meta?.captureDateParseError) {
    return (
      <div className="metadata-provenance-stack">
        <span>Unknown</span>
        <span className="metadata-warning-inline">
          Invalid EXIF tag ({meta.captureDateParseError})
        </span>
      </div>
    )
  }

  if (effStatus === 'unsupported') {
    return 'Unknown (unsupported image format)'
  }

  if (effStatus === 'failed') {
    return 'Unknown (extraction failed)'
  }

  if (effStatus === 'unavailable') {
    return 'Unknown (file unavailable)'
  }

  return 'Unknown'
}

function formatEffectiveExtractionStatus(detail: PhotoTechnicalMetadataDetail | null): string {
  if (!detail || detail.effectiveStatus === 'unprocessed') {
    return 'Not extracted yet'
  }
  switch (detail.effectiveStatus) {
    case 'extracted':
      return 'Extracted'
    case 'no_metadata':
      return 'Extracted (no embedded EXIF)'
    case 'unsupported':
      return `Unsupported format${detail.currentMetadata?.errorMessage ? ` — ${detail.currentMetadata.errorMessage}` : ''}`
    case 'failed':
      return `Extraction failed${detail.currentMetadata?.errorMessage ? ` — ${detail.currentMetadata.errorMessage}` : ''}`
    case 'unavailable':
      return `Unavailable${detail.currentMetadata?.errorMessage ? ` — ${detail.currentMetadata.errorMessage}` : ''}`
    case 'stale':
      return 'Stale (source or parser recipe changed; re-run extraction)'
  }
}

function formatThumbnailErrorLabel(code: string): string {
  switch (code) {
    case 'VAULT_COPY_MISSING':
      return 'Vault copy missing'
    case 'VAULT_COPY_CORRUPT':
    case 'VAULT_CONTAINMENT_ERROR':
      return 'Vault copy corrupt'
    default:
      return 'Preview unavailable'
  }
}

interface PhotoCardCellProps {
  photo: PhotoItem
  index: number
  thumb?: ThumbnailResult
  isSelected: boolean
  top: number
  left: number
  cellWidth: number
  cellHeight: number
  onOpenViewer: (index: number, photo: PhotoItem) => void
  onSelectDetails: (id: number) => void
  onKeyDown: (e: KeyboardEvent<HTMLElement>, photo: PhotoItem, index: number) => void
}

function PhotoCardCell({
  photo,
  index,
  thumb,
  isSelected,
  top,
  left,
  cellWidth,
  cellHeight,
  onOpenViewer,
  onSelectDetails,
  onKeyDown
}: PhotoCardCellProps): ReactElement {
  const isVideo = photo.mediaKind === 'video'
  const durationText = isVideo ? formatMediaDuration(photo.videoDurationMs) : null
  const containerShort = isVideo
    ? photo.videoContainer === 'quicktime'
      ? 'MOV'
      : photo.videoContainer === 'webm'
        ? 'WEBM'
        : 'MP4'
    : null
  const hasMismatch = isVideo && hasMismatchedVideoExtension(photo)
  const ratingDesc = photo.rating ? `${photo.rating} stars` : 'unrated'
  const flagDesc = photo.flag && photo.flag !== 'none' ? photo.flag : 'no flag'
  const statusSuffix = !isVideo
    ? thumb?.status === 'error' &&
      (thumb.code === 'VAULT_COPY_MISSING' ||
        thumb.code === 'VAULT_COPY_CORRUPT' ||
        thumb.code === 'VAULT_CONTAINMENT_ERROR')
      ? `, ${formatThumbnailErrorLabel(thumb.code).toLowerCase()}`
      : (thumb?.status === 'ready' && thumb.originalUnavailable) || thumb?.status === 'missing'
        ? ', original unavailable'
        : ''
    : ''

  return (
    <div
      id={`photo-cell-${photo.id}`}
      className={`photo-card photo-cell ${isSelected ? 'selected' : ''} ${isVideo ? 'is-video' : ''}`}
      style={{
        position: 'absolute',
        top: `${top}px`,
        left: `${left}px`,
        width: `${cellWidth}px`,
        height: `${cellHeight}px`
      }}
      onKeyDown={(e) => onKeyDown(e, photo, index)}
    >
      <button
        type="button"
        id={`photo-open-${photo.id}`}
        data-testid={`photo-open-btn-${photo.id}`}
        className="photo-thumbnail-container photo-card-open-btn"
        aria-label={`${isVideo ? 'Play video' : 'Open photograph'} ${photo.fileName}, ${formatBytes(photo.byteSize)}, ${ratingDesc}, ${flagDesc}${statusSuffix}`}
        onClick={() => onOpenViewer(index, photo)}
      >
        {isVideo ? (
          <div className="video-card-tile" data-testid={`video-card-tile-${photo.id}`}>
            <span className="video-play-circle" aria-hidden="true">
              <Play size={22} />
            </span>
            <div className="video-tile-badges">
              <span className="video-kind-badge">VIDEO</span>
              {containerShort && <span className="video-container-badge">{containerShort}</span>}
              {durationText && <span className="video-duration-badge">{durationText}</span>}
            </div>
            {photo.videoStructureError && (
              <span className="thumbnail-status-badge" title={photo.videoStructureError}>
                Unreadable video
              </span>
            )}
            {!photo.videoStructureError && hasMismatch && (
              <span
                className="video-mismatch-badge"
                title={`Content detected as ${formatContainerLabel(photo.videoContainer)}`}
              >
                Detected video ({containerShort})
              </span>
            )}
          </div>
        ) : thumb?.status === 'ready' ? (
          <>
            <img
              src={thumb.dataUrl}
              alt={photo.fileName}
              className="photo-thumbnail-img"
              loading="lazy"
            />
            {thumb.originalUnavailable && (
              <span
                className="thumbnail-status-badge"
                title="Cached preview only — original file is currently unavailable"
              >
                Original unavailable
              </span>
            )}
          </>
        ) : thumb?.status === 'unsupported' ? (
          <div className="thumbnail-placeholder unsupported" title={thumb.reason}>
            <FileQuestion size={32} />
            <span className="placeholder-tag">Unsupported</span>
          </div>
        ) : thumb?.status === 'missing' ? (
          <div className="thumbnail-placeholder unavailable" title={thumb.reason}>
            <AlertTriangle size={32} />
            <span className="placeholder-tag">Original unavailable</span>
          </div>
        ) : thumb?.status === 'error' ? (
          <div className="thumbnail-placeholder error" title={thumb.message}>
            <AlertTriangle size={32} />
            <span className="placeholder-tag">{formatThumbnailErrorLabel(thumb.code)}</span>
          </div>
        ) : (
          <div className="thumbnail-placeholder loading">
            <FileImage size={32} className="pulse" />
            <span className="placeholder-tag">Loading…</span>
          </div>
        )}

        {/* Compact Review Badges Overlay */}
        <div className="photo-badges-overlay">
          {typeof photo.rating === 'number' && (
            <span className="badge-rating" title={`Rating: ${photo.rating} stars`}>
              ★ {photo.rating}
            </span>
          )}
          {photo.flag && photo.flag !== 'none' && (
            <span className={`badge-flag badge-flag-${photo.flag}`} title={`Flag: ${photo.flag}`}>
              {photo.flag.toUpperCase()}
            </span>
          )}
        </div>
      </button>
      <div className="photo-card-info">
        <div className="photo-card-meta-text">
          <span className="photo-filename" title={photo.fileName}>
            {photo.fileName}
          </span>
          <span className="photo-size">{formatBytes(photo.byteSize)}</span>
        </div>
        <button
          type="button"
          id={`photo-details-btn-${photo.id}`}
          data-testid={`photo-details-btn-${photo.id}`}
          className="btn btn-secondary btn-xs photo-card-details-btn"
          aria-label={`Details for ${photo.fileName}`}
          aria-pressed={isSelected}
          onClick={() => onSelectDetails(photo.id)}
        >
          Details
        </button>
      </div>
    </div>
  )
}

export interface PhotosPanelProps {
  readonly scanJobs?: ScanJobsPanelProps
}

export function PhotosPanel({ scanJobs }: PhotosPanelProps = {}) {
  const {
    photos,
    cachedPageIndices,
    totalCount,
    isLoading,
    error,
    errorDetails,
    selectedPhoto,
    selectedId,
    thumbnails,
    thumbnailPrepProgress,
    mediaKindFilter,
    photoCount,
    videoCount,
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
    setMediaKindFilter,
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
  } = usePhotos()

  const {
    collections,
    collectionsPage,
    totalCollectionsPages,
    hasMoreCollections,
    hasPrevCollections,
    goToNextCollectionsPage,
    goToPrevCollectionsPage,
    memberships,
    membershipsPage,
    totalMembershipsPages,
    hasMoreMemberships,
    hasPrevMemberships,
    goToNextMembershipsPage,
    goToPrevMembershipsPage,
    isLoadingMemberships,
    membershipError,
    retryLoadMemberships,
    saveStatus,
    statusMessage,
    persistencePending,
    persistenceError,
    retryReconciliation,
    setRating,
    setFlag,
    createCollection,
    renameCollection,
    addCollectionMember,
    removeCollectionMember
  } = usePhotoReview({
    selectedPhoto,
    ratingFilter,
    flagFilter,
    collectionIdFilter: collectionId,
    updatePhotoLocal,
    removePhotoFromFilterView
  })

  const [newCollectionName, setNewCollectionName] = useState('')
  const [renamingCollectionId, setRenamingCollectionId] = useState<number | null>(null)
  const [renameInputValue, setRenameInputValue] = useState('')
  const [collectionActionError, setCollectionActionError] = useState<string | null>(null)
  const [userPlaceDraft, setUserPlaceDraft] = useState('')
  const [cameraLabelDraft, setCameraLabelDraft] = useState('')
  const [trackedDetailKey, setTrackedDetailKey] = useState<string>('')
  const [viewMode, setViewMode] = useState<'grid' | 'similarity'>('grid')
  const [showSemanticPanel, setShowSemanticPanel] = useState(false)
  const [showMetadataPanel, setShowMetadataPanel] = useState(false)
  const [showAddScanPanel, setShowAddScanPanel] = useState(false)
  const [onboardingTriggered, setOnboardingTriggered] = useState(false)
  const [dismissedReadyKey, setDismissedReadyKey] = useState<string | null>(null)
  const autoIndexStartedRef = useRef(false)
  const lastCompletedScanJobIdRef = useRef<number | null>(
    scanJobs?.job?.status === 'completed' ? scanJobs.job.jobId : null
  )

  const semanticIndex = useSemanticIndex()
  const { startIndexing } = semanticIndex

  const isScanActive = scanJobs?.job?.status === 'running' || scanJobs?.job?.status === 'paused'

  const handleAddPhotosClick = useCallback(async () => {
    if (!scanJobs) return
    setShowAddScanPanel(true)
    await scanJobs.onSelectRoots()
  }, [scanJobs])

  // Auto-refresh photo grid when a scan job completes without requiring manual Refresh
  useEffect(() => {
    const completedJob = scanJobs?.job
    if (
      completedJob?.status === 'completed' &&
      completedJob.jobId !== lastCompletedScanJobIdRef.current
    ) {
      lastCompletedScanJobIdRef.current = completedJob.jobId
      void refresh()
    }
  }, [scanJobs?.job, refresh])

  const handleEnablePhotoSearch = useCallback(async () => {
    autoIndexStartedRef.current = false
    setDismissedReadyKey(null)
    setOnboardingTriggered(true)
    await semanticIndex.downloadModel()
  }, [semanticIndex])

  const handleCancelEnablePhotoSearch = useCallback(async () => {
    setOnboardingTriggered(false)
    autoIndexStartedRef.current = false
    await semanticIndex.cancelModelProvisioning()
  }, [semanticIndex])

  // Automatically start indexing once model download completes during inline onboarding.
  useEffect(() => {
    if (!onboardingTriggered) return
    if (semanticIndex.modelStatus.state !== 'ready') return
    if (autoIndexStartedRef.current) return

    const iProg = semanticIndex.indexProgress
    autoIndexStartedRef.current = true
    if (
      iProg.status !== 'running' &&
      iProg.status !== 'paused' &&
      iProg.totalCatalogPhotos > 0 &&
      iProg.currentIndexedPhotos < iProg.totalCatalogPhotos
    ) {
      void startIndexing()
    }
  }, [
    onboardingTriggered,
    semanticIndex.modelStatus.state,
    semanticIndex.indexProgress,
    startIndexing
  ])

  const readyAnnouncementKey =
    semanticIndex.indexProgress.jobId ??
    `ready-${semanticIndex.indexProgress.currentIndexedPhotos}-${semanticIndex.indexProgress.totalCatalogPhotos}`

  const searchReadyAnnouncement =
    onboardingTriggered &&
    semanticIndex.modelStatus.state === 'ready' &&
    semanticIndex.indexProgress.status !== 'running' &&
    semanticIndex.indexProgress.status !== 'paused' &&
    semanticIndex.indexProgress.status !== 'failed' &&
    semanticIndex.indexProgress.status !== 'cancelled' &&
    (semanticIndex.indexProgress.status === 'completed' ||
      semanticIndex.indexProgress.totalCatalogPhotos === 0 ||
      semanticIndex.indexProgress.currentIndexedPhotos >=
        semanticIndex.indexProgress.totalCatalogPhotos) &&
    dismissedReadyKey !== readyAnnouncementKey
      ? {
          indexedCount: semanticIndex.indexProgress.currentIndexedPhotos,
          totalCount: semanticIndex.indexProgress.totalCatalogPhotos
        }
      : null

  const {
    progress: metadataProgress,
    isBusy: isMetadataBusy,
    actionError: metadataActionError,
    selectedDetail: selectedMetadataDetail,
    isLoadingDetail: isLoadingMetadataDetail,
    cameraFacet,
    lensFacet,
    fileTypeFacet,
    attentionItems: metadataAttentionItems,
    attentionTotalCount: metadataAttentionTotalCount,
    isLoadingAttentionItems: isLoadingMetadataAttentionItems,
    loadAttentionItems: loadMetadataAttentionItems,
    setCameraFacetSearch,
    setCameraFacetOffset,
    setLensFacetSearch,
    setLensFacetOffset,
    setFileTypeFacetOffset,
    startExtraction: startMetadataExtraction,
    pauseExtraction: pauseMetadataExtraction,
    resumeExtraction: resumeMetadataExtraction,
    cancelExtraction: cancelMetadataExtraction,
    refreshMetadata
  } = usePhotoMetadata({
    selectedPhoto,
    isPanelOpen: showMetadataPanel,
    fileTypeBasis: metadataFilters.fileTypeBasis,
    onExtractionSettled: () => {
      if (hasActiveMetadataFilters(metadataFilters)) {
        void refresh()
      }
    }
  })

  const detailSyncKey = `${selectedPhoto?.id ?? 'none'}:${selectedMetadataDetail?.userPlace?.placeLabel ?? ''}:${selectedMetadataDetail?.cameraLabel?.label ?? ''}`
  if (trackedDetailKey !== detailSyncKey) {
    setTrackedDetailKey(detailSyncKey)
    setUserPlaceDraft(selectedMetadataDetail?.userPlace?.placeLabel ?? '')
    setCameraLabelDraft(selectedMetadataDetail?.cameraLabel?.label ?? '')
  }

  const containerRef = useRef<HTMLDivElement | null>(null)
  const [gridContainerEl, setGridContainerEl] = useState<HTMLDivElement | null>(null)
  const handleGridRef = useCallback((el: HTMLDivElement | null) => {
    containerRef.current = el
    setGridContainerEl(el)
  }, [])

  const detailsPanelRef = useRef<HTMLElement>(null)
  const filtersDrawerRef = useRef<HTMLDivElement>(null)
  const filtersToggleBtnRef = useRef<HTMLButtonElement>(null)
  const semanticDrawerRef = useRef<HTMLDivElement>(null)
  const semanticToggleBtnRef = useRef<HTMLButtonElement>(null)
  const lastSelectedIdRef = useRef<number | null>(null)
  useEffect(() => {
    if (selectedId !== null) {
      lastSelectedIdRef.current = selectedId
    }
  }, [selectedId])

  const [isNarrowDetailsViewport] = [useMediaQuery('(max-width: 959px)')]

  const closeDetails = useCallback(() => {
    selectPhoto(null)
  }, [selectPhoto])

  const closeFiltersDrawer = useCallback(() => {
    setShowMetadataPanel(false)
  }, [setShowMetadataPanel])

  const closeSemanticDrawer = useCallback(() => {
    setShowSemanticPanel(false)
  }, [])

  const originalOpenBtnRef = useRef<HTMLButtonElement>(null)
  const lastOpenedViewerIdRef = useRef<number | null>(null)

  const [viewerState, setViewerState] = useState<{
    open: boolean
    index: number | null
    locationId: number | null
    fallbackItem: PhotoItem | null
    restoreTo: 'grid' | 'details'
  }>({
    open: false,
    index: null,
    locationId: null,
    fallbackItem: null,
    restoreTo: 'grid'
  })

  const [prevOriginalSelectedId, setPrevOriginalSelectedId] = useState<number | null>(
    selectedPhoto?.id ?? null
  )
  const currentOriginalSelectedId = selectedPhoto?.id ?? null
  if (prevOriginalSelectedId !== currentOriginalSelectedId) {
    setPrevOriginalSelectedId(currentOriginalSelectedId)
    if (
      viewerState.restoreTo === 'details' &&
      viewerState.locationId !== null &&
      viewerState.locationId !== currentOriginalSelectedId &&
      viewerState.open
    ) {
      setViewerState({
        open: false,
        index: null,
        locationId: null,
        fallbackItem: null,
        restoreTo: 'grid'
      })
    }
  }

  const closeMediaViewer = useCallback(() => {
    setViewerState((prev) => ({
      ...prev,
      open: false,
      index: null,
      locationId: null,
      fallbackItem: null
    }))
  }, [])

  const openViewerFromGrid = useCallback((index: number, item: PhotoItem) => {
    lastOpenedViewerIdRef.current = item.id
    setViewerState({
      open: true,
      index,
      locationId: item.id,
      fallbackItem: item,
      restoreTo: 'grid'
    })
  }, [])

  const handleOpenOriginal = useCallback(() => {
    if (!selectedPhoto) return
    const loadedIndex = photos.findIndex((p) => p.id === selectedPhoto.id)
    lastOpenedViewerIdRef.current = selectedPhoto.id
    setViewerState({
      open: true,
      index: loadedIndex >= 0 ? loadedIndex : 0,
      locationId: selectedPhoto.id,
      fallbackItem: selectedPhoto,
      restoreTo: 'details'
    })
  }, [selectedPhoto, photos])

  const handleViewerNavigate = useCallback(
    (nextIndex: number) => {
      const nextItem = getPhoto(nextIndex) ?? photos[nextIndex] ?? null
      if (nextItem) {
        lastOpenedViewerIdRef.current = nextItem.id
      }
      setViewerState((prev) => ({
        ...prev,
        index: nextIndex,
        locationId: nextItem?.id ?? null,
        fallbackItem: nextItem
      }))
    },
    [getPhoto, photos]
  )

  const handleOpenDetailsFromViewer = useCallback(
    (item: PhotoItem) => {
      lastOpenedViewerIdRef.current = item.id
      closeMediaViewer()
      selectPhoto(item.id)
    },
    [closeMediaViewer, selectPhoto]
  )

  const [detailsDefaultPlayerState, setDetailsDefaultPlayerState] = useState<{
    locationId: number | null
    busy: boolean
    feedback: OpenInDefaultPlayerResponse | null
  }>({ locationId: null, busy: false, feedback: null })
  const isCurrentDetailsPlayerState =
    Boolean(selectedPhoto) && detailsDefaultPlayerState.locationId === selectedPhoto?.id
  const detailsDefaultPlayerBusy = Boolean(
    isCurrentDetailsPlayerState && detailsDefaultPlayerState.busy
  )
  const detailsDefaultPlayerFeedback = isCurrentDetailsPlayerState
    ? detailsDefaultPlayerState.feedback
    : null

  const handleOpenDetailsDefaultPlayer = useCallback(async () => {
    if (!selectedPhoto || !window.api?.openMediaInDefaultPlayer) return
    const targetId = selectedPhoto.id
    setDetailsDefaultPlayerState({ locationId: targetId, busy: true, feedback: null })
    try {
      const res = await window.api.openMediaInDefaultPlayer({ locationId: targetId })
      setDetailsDefaultPlayerState((prev) =>
        prev.locationId === targetId ? { locationId: targetId, busy: false, feedback: res } : prev
      )
    } catch (err: unknown) {
      setDetailsDefaultPlayerState((prev) =>
        prev.locationId === targetId
          ? {
              locationId: targetId,
              busy: false,
              feedback: {
                ok: false,
                usedTemporaryCopy: false,
                launchedFileName: null,
                error: err instanceof Error ? err.message : 'Failed to open in default player'
              }
            }
          : prev
      )
    }
  }, [selectedPhoto])

  const restorePhotoFocus = useCallback(() => {
    const id = lastSelectedIdRef.current
    if (id === null) return null
    return (
      document.getElementById(`photo-details-btn-${id}`) ??
      document.getElementById(`photo-open-${id}`) ??
      document.getElementById(`photo-cell-${id}`)
    )
  }, [])

  const restoreViewerFocus = useCallback(() => {
    if (viewerState.restoreTo === 'details' && originalOpenBtnRef.current) {
      return originalOpenBtnRef.current
    }
    const id = lastOpenedViewerIdRef.current
    if (id === null) return null
    return (
      document.getElementById(`photo-open-${id}`) ?? document.getElementById(`photo-cell-${id}`)
    )
  }, [viewerState.restoreTo])

  const isFiltersDrawerOpen = showMetadataPanel && viewMode === 'grid'
  const isDetailsOpen = viewMode === 'grid' && Boolean(selectedPhoto)
  const isMediaViewerOpen = viewerState.open
  const hasTopmostDrawer = isFiltersDrawerOpen || showSemanticPanel || isMediaViewerOpen

  useFocusTrap({
    isOpen: isFiltersDrawerOpen,
    isModal: isFiltersDrawerOpen,
    isActive: isFiltersDrawerOpen,
    containerRef: filtersDrawerRef,
    onClose: closeFiltersDrawer,
    restoreFocusTo: () => filtersToggleBtnRef.current
  })

  useFocusTrap({
    isOpen: showSemanticPanel,
    isModal: showSemanticPanel,
    isActive: showSemanticPanel,
    containerRef: semanticDrawerRef,
    onClose: closeSemanticDrawer,
    restoreFocusTo: () => semanticToggleBtnRef.current
  })

  useFocusTrap({
    isOpen: isDetailsOpen,
    isModal: isNarrowDetailsViewport && isDetailsOpen,
    isActive: isDetailsOpen && !hasTopmostDrawer,
    containerRef: detailsPanelRef,
    onClose: closeDetails,
    restoreFocusTo: restorePhotoFocus
  })

  const [scrollState, setScrollState] = useState<{
    generation: number
    top: number
    direction: 'down' | 'up'
  }>({
    generation: 0,
    top: 0,
    direction: 'down'
  })
  const scrollTop = scrollState.generation === filterGeneration ? scrollState.top : 0
  const scrollDirection =
    scrollState.generation === filterGeneration ? scrollState.direction : 'down'
  const prevScrollTopRef = useRef<number>(0)
  const activeThumbIdsRef = useRef<Set<number>>(new Set())
  const [containerHeight, setContainerHeight] = useState(600)
  const [containerWidth, setContainerWidth] = useState(800)

  // Reset scroll viewport DOM position whenever filters change or reset so result pages never mix
  useEffect(() => {
    prevScrollTopRef.current = 0
    if (filterGeneration > 0 && containerRef.current) {
      containerRef.current.scrollTop = 0
    }
  }, [filterGeneration])

  // Measure inner grid container dimensions whenever it mounts, resizes, or is replaced on mode change
  useEffect(() => {
    if (!gridContainerEl) return

    const updateDimensions = () => {
      const style = window.getComputedStyle(gridContainerEl)
      const padX =
        (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0)
      const padY =
        (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0)
      const rawWidth = gridContainerEl.clientWidth
      const rawHeight = gridContainerEl.clientHeight
      const innerW = rawWidth > 0 ? Math.max(200, rawWidth - padX) : 800
      const innerH = rawHeight > 0 ? Math.max(200, rawHeight - padY) : 600
      setContainerWidth(innerW)
      setContainerHeight(innerH)
    }

    updateDimensions()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(updateDimensions)
    observer.observe(gridContainerEl)
    return () => observer.disconnect()
  }, [gridContainerEl])

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget
    const nextTop = target.scrollTop
    const prevTop = prevScrollTopRef.current
    const direction: 'down' | 'up' =
      nextTop > prevTop ? 'down' : nextTop < prevTop ? 'up' : scrollDirection
    prevScrollTopRef.current = nextTop
    setScrollState({ generation: filterGeneration, top: nextTop, direction })
  }

  // Responsive virtualization calculations filling available content width
  const isNarrowGrid = containerWidth < 480
  const gap = isNarrowGrid ? 10 : 16
  const targetCellWidth = isNarrowGrid ? 140 : 180
  const columns = Math.max(1, Math.floor((containerWidth + gap) / (targetCellWidth + gap)))
  const cellWidth = Math.max(120, Math.floor((containerWidth - (columns - 1) * gap) / columns))
  const cellHeight = Math.min(240, Math.max(185, Math.round(cellWidth * 1.1)))
  const totalRows = Math.ceil(totalCount / columns)
  const rowHeight = cellHeight + gap
  const totalHeight = Math.max(0, totalRows * rowHeight - gap)

  // Strictly visible viewport rows + bounded scroll-direction prefetch rows (capped to MAX_MOUNTED_CELLS)
  const PREFETCH_ROWS_AHEAD = 3
  const PREFETCH_ROWS_BEHIND = 1
  const viewportStartRow = Math.max(0, Math.floor(scrollTop / rowHeight))
  const viewportEndRow = Math.min(totalRows, Math.ceil((scrollTop + containerHeight) / rowHeight))
  const rowsAbove = scrollDirection === 'up' ? PREFETCH_ROWS_AHEAD : PREFETCH_ROWS_BEHIND
  const rowsBelow = scrollDirection === 'down' ? PREFETCH_ROWS_AHEAD : PREFETCH_ROWS_BEHIND
  const startRow = Math.max(0, viewportStartRow - rowsAbove)
  const endRow = Math.min(totalRows, viewportEndRow + rowsBelow)

  const viewportStartIndex = Math.min(totalCount, viewportStartRow * columns)
  const viewportEndIndex = Math.min(totalCount, viewportEndRow * columns)
  const startIndex = startRow * columns
  const rawEndIndex = endRow * columns
  const endIndex = Math.min(
    totalCount,
    Math.min(rawEndIndex, startIndex + PHOTO_BOUNDS.MAX_MOUNTED_CELLS)
  )

  // Trigger loading of required page range (covers both visible rows and scroll-direction prefetch rows)
  useEffect(() => {
    if (totalCount > 0 && endIndex > startIndex) {
      ensureRangeLoaded(startIndex, endIndex)
    }
  }, [totalCount, startIndex, endIndex, ensureRangeLoaded])

  // Schedule visible tiles at high priority first, then bounded prefetch rows in the scroll direction at normal priority
  useEffect(() => {
    if (viewMode !== 'grid' || totalCount === 0 || endIndex <= startIndex) {
      for (const id of activeThumbIdsRef.current) {
        cancelThumbnail(id, { queuedOnly: true })
      }
      activeThumbIdsRef.current = new Set()
      return
    }

    const desiredIds = new Set<number>()
    const visibleStart = Math.max(startIndex, viewportStartIndex)
    const visibleEnd = Math.min(endIndex, viewportEndIndex)

    // 1. Visible viewport tiles first (high priority)
    for (let i = visibleStart; i < visibleEnd; i++) {
      const photo = getPhoto(i)
      if (photo && photo.mediaKind !== 'video') {
        desiredIds.add(photo.id)
        requestThumbnail(photo, 'high')
      }
    }

    // 2. Scroll-direction prefetch rows (normal priority)
    if (scrollDirection === 'up') {
      for (let i = visibleStart - 1; i >= startIndex; i--) {
        const photo = getPhoto(i)
        if (photo && photo.mediaKind !== 'video' && !desiredIds.has(photo.id)) {
          desiredIds.add(photo.id)
          requestThumbnail(photo, 'normal')
        }
      }
      for (let i = visibleEnd; i < endIndex; i++) {
        const photo = getPhoto(i)
        if (photo && photo.mediaKind !== 'video' && !desiredIds.has(photo.id)) {
          desiredIds.add(photo.id)
          requestThumbnail(photo, 'normal')
        }
      }
    } else {
      for (let i = visibleEnd; i < endIndex; i++) {
        const photo = getPhoto(i)
        if (photo && photo.mediaKind !== 'video' && !desiredIds.has(photo.id)) {
          desiredIds.add(photo.id)
          requestThumbnail(photo, 'normal')
        }
      }
      for (let i = visibleStart - 1; i >= startIndex; i--) {
        const photo = getPhoto(i)
        if (photo && photo.mediaKind !== 'video' && !desiredIds.has(photo.id)) {
          desiredIds.add(photo.id)
          requestThumbnail(photo, 'normal')
        }
      }
    }

    // 3. Cancel only queued UI requests that scrolled out of the visible + prefetch window
    for (const prevId of activeThumbIdsRef.current) {
      if (!desiredIds.has(prevId)) {
        cancelThumbnail(prevId, { queuedOnly: true })
      }
    }
    activeThumbIdsRef.current = desiredIds
  }, [
    viewMode,
    totalCount,
    startIndex,
    endIndex,
    viewportStartIndex,
    viewportEndIndex,
    scrollDirection,
    getPhoto,
    requestThumbnail,
    cancelThumbnail
  ])

  useEffect(() => {
    return () => {
      for (const id of activeThumbIdsRef.current) {
        cancelThumbnail(id, { queuedOnly: true })
      }
      activeThumbIdsRef.current = new Set()
    }
  }, [cancelThumbnail])

  // Build cell indices array for mounted range
  const visibleIndices: number[] = []
  for (let i = startIndex; i < endIndex; i++) {
    visibleIndices.push(i)
  }

  // Keyboard navigation within grid
  const handleKeyDown = (
    e: KeyboardEvent<HTMLElement>,
    currentPhoto: PhotoItem,
    currentIndex: number
  ) => {
    if (isMediaViewerOpen) return

    if (e.key === 'Enter') {
      const target = e.target as HTMLElement | null
      if (target?.classList?.contains('photo-card-details-btn')) {
        return
      }
      e.preventDefault()
      openViewerFromGrid(currentIndex, currentPhoto)
      return
    }

    let nextIndex: number
    switch (e.key) {
      case 'ArrowRight':
        nextIndex = Math.min(totalCount - 1, currentIndex + 1)
        break
      case 'ArrowLeft':
        nextIndex = Math.max(0, currentIndex - 1)
        break
      case 'ArrowDown':
        nextIndex = Math.min(totalCount - 1, currentIndex + columns)
        break
      case 'ArrowUp':
        nextIndex = Math.max(0, currentIndex - columns)
        break
      default:
        return
    }

    if (nextIndex !== -1 && nextIndex !== currentIndex) {
      e.preventDefault()
      ensureRangeLoaded(nextIndex, nextIndex + 1)
      const nextPhoto = getPhoto(nextIndex)
      if (containerRef.current) {
        const nextRow = Math.floor(nextIndex / columns)
        const itemTop = nextRow * rowHeight
        const itemBottom = itemTop + cellHeight
        const curScrollTop = containerRef.current.scrollTop
        if (itemTop < curScrollTop) {
          containerRef.current.scrollTop = itemTop
        } else if (itemBottom > curScrollTop + containerHeight) {
          containerRef.current.scrollTop = Math.max(0, itemBottom - containerHeight)
        }
      }
      if (nextPhoto) {
        const targetEl = document.getElementById(`photo-open-${nextPhoto.id}`)
        targetEl?.focus()
      }
    }
  }

  const handleCreateCollection = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newCollectionName.trim()) return
    setCollectionActionError(null)
    try {
      await createCollection(newCollectionName.trim())
      setNewCollectionName('')
    } catch (err: unknown) {
      setCollectionActionError(err instanceof Error ? err.message : String(err))
    }
  }

  // Track collection IDs photo belongs to
  const membershipCollectionIds = new Set(memberships.map((m) => m.collectionId))
  const activeMetadataFilterCount = countActiveMetadataFilters(metadataFilters)
  const reviewFilterCount =
    (mediaKindFilter !== 'all' ? 1 : 0) +
    (ratingFilter !== 'all' ? 1 : 0) +
    (flagFilter !== 'all' ? 1 : 0) +
    (collectionId !== null ? 1 : 0)
  const totalActiveFilterCount = reviewFilterCount + activeMetadataFilterCount
  const hasAnyActiveFilter = totalActiveFilterCount > 0 || Boolean(searchQuery)

  return (
    <div className="photos-layout">
      <div className="photos-main">
        {/* Photos Toolbar: 3-tier hierarchy (Header, Search, Mode/Filter Controls) */}
        <div className="photos-toolbar">
          <div className="photos-header-row">
            <div className="photos-count-info">
              <h2>Photographs</h2>
              <span className="count-badge" data-testid="photos-count-badge">
                {mediaKindFilter === 'video'
                  ? `${totalCount.toLocaleString()} ${totalCount === 1 ? 'video' : 'videos'}`
                  : mediaKindFilter === 'photo'
                    ? `${totalCount.toLocaleString()} ${totalCount === 1 ? 'photo' : 'photos'}`
                    : videoCount > 0
                      ? `${totalCount.toLocaleString()} items (${photoCount.toLocaleString()} photos · ${videoCount.toLocaleString()} videos)`
                      : `${totalCount.toLocaleString()} ${totalCount === 1 ? 'photo' : 'photos'}`}
              </span>
              {thumbnailPrepProgress?.status === 'running' &&
                thumbnailPrepProgress.pendingPhotos > 0 &&
                totalCount > 0 && (
                  <span
                    className="photos-prep-status"
                    data-testid="photos-prep-status"
                    role="status"
                    aria-live="polite"
                  >
                    Preparing photo previews (
                    {(
                      thumbnailPrepProgress.totalPhotos - thumbnailPrepProgress.pendingPhotos
                    ).toLocaleString()}{' '}
                    of {thumbnailPrepProgress.totalPhotos.toLocaleString()})
                  </span>
                )}
              {(() => {
                const cov = metadataProgress?.coverage
                const unreadMeta = (cov?.unprocessedCount ?? 0) + (cov?.staleCount ?? 0)
                const attentionMeta =
                  (cov?.failedCount ?? 0) +
                  (cov?.unavailableCount ?? 0) +
                  (cov?.unsupportedCount ?? 0)
                if (
                  metadataProgress?.status !== 'running' &&
                  metadataProgress?.status !== 'paused' &&
                  unreadMeta === 0 &&
                  attentionMeta === 0
                ) {
                  return null
                }
                const metaLabel =
                  metadataProgress.status === 'running'
                    ? `Dates & locations: reading ${metadataProgress.processedPhotos.toLocaleString()} of ${metadataProgress.totalPhotos.toLocaleString()}`
                    : metadataProgress.status === 'paused'
                      ? `Dates & locations: paused (${metadataProgress.pendingPhotos.toLocaleString()} left)`
                      : unreadMeta > 0
                        ? `Dates & locations: ${unreadMeta.toLocaleString()} not read yet`
                        : `Dates & locations: ${attentionMeta.toLocaleString()} need attention`
                return (
                  <button
                    type="button"
                    className={`photos-status-chip ${attentionMeta > 0 ? 'photos-status-warning' : ''}`}
                    data-testid="photos-metadata-status"
                    onClick={() => {
                      setViewMode('grid')
                      setShowMetadataPanel(true)
                      setShowSemanticPanel(false)
                    }}
                    title="Inspect date and location extraction status"
                  >
                    {metaLabel}
                  </button>
                )
              })()}
              {semanticIndex.modelStatus.state === 'ready' &&
                (() => {
                  const sp = semanticIndex.indexProgress
                  const unindexed = Math.max(0, sp.totalCatalogPhotos - sp.currentIndexedPhotos)
                  const semAttention = sp.failedPhotos + sp.unsupportedPhotos
                  if (
                    sp.status !== 'running' &&
                    sp.status !== 'paused' &&
                    sp.status !== 'interrupted' &&
                    unindexed === 0 &&
                    semAttention === 0
                  ) {
                    return null
                  }
                  const semLabel =
                    sp.status === 'running'
                      ? `Visual search: indexing ${sp.processedPhotos.toLocaleString()} of ${sp.totalPhotos.toLocaleString()}`
                      : sp.status === 'paused' || sp.status === 'interrupted'
                        ? `Visual search: paused (${sp.pendingPhotos.toLocaleString()} left)`
                        : semAttention > 0
                          ? `Visual search: ${semAttention.toLocaleString()} need attention`
                          : `Visual search: ${unindexed.toLocaleString()} not indexed yet`
                  return (
                    <button
                      type="button"
                      className={`photos-status-chip ${semAttention > 0 ? 'photos-status-warning' : ''}`}
                      data-testid="photos-visual-status"
                      onClick={() => {
                        setViewMode('grid')
                        setShowSemanticPanel(true)
                        setShowMetadataPanel(false)
                      }}
                      title="Inspect local visual search indexing status"
                    >
                      {semLabel}
                    </button>
                  )
                })()}
            </div>

            <div className="photos-toolbar-actions">
              {scanJobs && (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  data-testid="photos-add-photos-btn"
                  disabled={isScanActive}
                  onClick={() => void handleAddPhotosClick()}
                  title="Select read-only folders to scan for photographs"
                >
                  <FolderPlus size={14} aria-hidden="true" />
                  <span>Add photos</span>
                </button>
              )}
              <button
                ref={semanticToggleBtnRef}
                id="photos-toggle-semantic-index"
                data-testid="photos-toggle-semantic-index"
                type="button"
                className={`btn btn-sm ${showSemanticPanel ? 'btn-primary' : 'btn-secondary'}`}
                aria-expanded={showSemanticPanel}
                onClick={() => {
                  setShowSemanticPanel((prev) => {
                    const next = !prev
                    if (next) setShowMetadataPanel(false)
                    return next
                  })
                }}
                title="Manage offline search model and indexing"
              >
                <Cpu size={14} aria-hidden="true" />
                <span>Semantic Index</span>
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => void refresh()}
                disabled={isLoading}
                title="Refresh photograph catalog"
              >
                <RefreshCw size={14} className={isLoading ? 'spin' : ''} aria-hidden="true" />
                <span>Refresh</span>
              </button>
            </div>
          </div>

          {viewMode === 'grid' &&
            (() => {
              const effectiveModelStatus =
                semanticIndex.modelStatus.state === 'installing'
                  ? 'installing'
                  : modelStatus === 'corrupt' || modelStatus === 'unprovisioned'
                    ? modelStatus
                    : semanticIndex.modelStatus.state !== 'missing'
                      ? semanticIndex.modelStatus.state
                      : modelStatus

              return (
                <div className="photos-search-row">
                  <PhotosSearchBar
                    query={searchQuery}
                    isSearching={isSearching}
                    modelStatus={effectiveModelStatus}
                    searchMode={searchMode}
                    searchResult={searchResultMeta}
                    interpretedFilters={interpretedFilters}
                    clarification={clarification}
                    visualModelRequired={visualModelRequired}
                    filteredCandidateCount={filteredCandidateCount}
                    onSearch={setSearchQuery}
                    onClear={clearSearch}
                    onUpdateInterpretedFilters={updateInterpretedFilters}
                    onClearInterpretedFilter={clearInterpretedFilter}
                    onBypassVisualModel={showMetadataMatchesWithoutVisualModel}
                    onSaveEventAndSearch={saveEventAndRetrySearch}
                    onSelectDisambiguatedPlace={selectDisambiguatedPlace}
                    onSaveCustomPlaceAndSearch={saveCustomPlaceAndRetrySearch}
                    modelDownloadProgress={
                      effectiveModelStatus === 'installing'
                        ? {
                            downloadedBytes: semanticIndex.modelStatus.downloadedBytes,
                            requiredBytes: semanticIndex.modelStatus.requiredBytes,
                            currentArtifact: semanticIndex.modelStatus.currentArtifact
                          }
                        : null
                    }
                    indexingProgress={semanticIndex.indexProgress}
                    setupError={
                      semanticIndex.actionError ??
                      semanticIndex.modelStatus.error ??
                      semanticIndex.indexProgress.lastError
                    }
                    searchReadyAnnouncement={searchReadyAnnouncement}
                    onEnablePhotoSearch={handleEnablePhotoSearch}
                    onCancelEnablePhotoSearch={handleCancelEnablePhotoSearch}
                    onRetryIndexing={startIndexing}
                    onDismissSearchReady={() => setDismissedReadyKey(readyAnnouncementKey)}
                  />
                </div>
              )
            })()}

          <div className="photos-controls-row">
            <div className="photos-mode-toggle" role="group" aria-label="Photo view mode">
              <button
                id="photos-mode-grid"
                type="button"
                className={`btn btn-sm ${viewMode === 'grid' ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setViewMode('grid')}
              >
                Photo Grid
              </button>
              <button
                id="photos-mode-similarity"
                type="button"
                className={`btn btn-sm ${viewMode === 'similarity' ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setViewMode('similarity')}
              >
                Visual Similarity
              </button>
            </div>

            {viewMode === 'grid' && (
              <div className="photos-filter-actions">
                <div
                  className="media-type-filter-group"
                  role="group"
                  aria-label="Media type filter"
                >
                  {(
                    [
                      { key: 'all', label: 'All media' },
                      { key: 'photo', label: 'Photos' },
                      { key: 'video', label: 'Videos' }
                    ] as const
                  ).map(({ key, label }) => {
                    const countSuffix =
                      key === 'video' && videoCount > 0
                        ? ` (${videoCount.toLocaleString()})`
                        : key === 'photo' && videoCount > 0
                          ? ` (${photoCount.toLocaleString()})`
                          : ''
                    return (
                      <button
                        key={key}
                        type="button"
                        data-testid={`media-filter-${key}`}
                        className={`btn btn-sm ${mediaKindFilter === key ? 'btn-primary' : 'btn-secondary'}`}
                        aria-pressed={mediaKindFilter === key}
                        onClick={() => setMediaKindFilter(key as MediaKindFilter)}
                      >
                        {label}
                        {countSuffix}
                      </button>
                    )
                  })}
                </div>
                <button
                  ref={filtersToggleBtnRef}
                  id="photos-toggle-metadata-filters"
                  data-testid="photos-toggle-metadata-filters"
                  type="button"
                  className={`btn btn-sm ${showMetadataPanel || totalActiveFilterCount > 0 ? 'btn-primary' : 'btn-secondary'}`}
                  aria-expanded={showMetadataPanel}
                  onClick={() => {
                    setViewMode('grid')
                    setShowMetadataPanel((prev) => {
                      const next = !prev
                      if (next) setShowSemanticPanel(false)
                      return next
                    })
                  }}
                >
                  <SlidersHorizontal size={14} aria-hidden="true" />
                  <span>
                    Filters{totalActiveFilterCount > 0 ? ` (${totalActiveFilterCount})` : ''}
                  </span>
                </button>
                {totalActiveFilterCount > 0 && (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={resetFilters}
                    title="Reset all filters"
                  >
                    Reset filters
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {scanJobs &&
          (scanJobs.selectedRoots.length > 0 ||
            Boolean(scanJobs.actionError) ||
            Boolean(
              scanJobs.job &&
              (showAddScanPanel ||
                isScanActive ||
                scanJobs.job.status === 'interrupted' ||
                scanJobs.job.status === 'failed')
            )) && (
            <section
              className="photos-add-scan-banner"
              aria-label="Add photos scan status"
              data-testid="photos-add-scan-banner"
            >
              <ScanJobsPanel
                {...scanJobs}
                job={scanJobs.selectedRoots.length > 0 ? null : scanJobs.job}
                selectButtonLabel="Add photos"
                onDismissJob={(jobId) => {
                  setShowAddScanPanel(false)
                  scanJobs.onDismissJob?.(jobId)
                }}
              />
            </section>
          )}

        {isFiltersDrawerOpen && (
          <>
            <div
              className="photos-drawer-backdrop"
              aria-hidden="true"
              onClick={closeFiltersDrawer}
            />
            <div
              ref={filtersDrawerRef}
              className="photos-side-drawer"
              role="dialog"
              aria-modal="true"
              aria-label="Filters and Metadata"
              tabIndex={-1}
            >
              <PhotoMetadataFilterPanel
                progress={metadataProgress}
                isBusy={isMetadataBusy}
                actionError={metadataActionError}
                matchingCount={totalCount}
                ratingFilter={ratingFilter}
                flagFilter={flagFilter}
                collectionId={collectionId}
                collections={collections}
                onRatingFilterChange={setRatingFilter}
                onFlagFilterChange={setFlagFilter}
                onCollectionIdChange={setCollectionId}
                metadataFilters={metadataFilters}
                cameraFacet={cameraFacet}
                lensFacet={lensFacet}
                fileTypeFacet={fileTypeFacet}
                onUpdateFilters={updateMetadataFilters}
                onResetFilters={resetFilters}
                onCameraSearchChange={setCameraFacetSearch}
                onCameraOffsetChange={setCameraFacetOffset}
                onLensSearchChange={setLensFacetSearch}
                onLensOffsetChange={setLensFacetOffset}
                onFileTypeOffsetChange={setFileTypeFacetOffset}
                onStartExtraction={startMetadataExtraction}
                onPauseExtraction={pauseMetadataExtraction}
                onResumeExtraction={resumeMetadataExtraction}
                onCancelExtraction={cancelMetadataExtraction}
                attentionItems={metadataAttentionItems}
                attentionTotalCount={metadataAttentionTotalCount}
                isLoadingAttentionItems={isLoadingMetadataAttentionItems}
                onLoadAttentionItems={loadMetadataAttentionItems}
                savedEvents={savedEvents}
                savedPlaces={savedPlaces}
                onUpsertSavedEvent={upsertSavedEvent}
                onDeleteSavedEvent={deleteSavedEvent}
                onUpsertSavedPlace={upsertSavedPlace}
                onDeleteSavedPlace={deleteSavedPlace}
                onClose={closeFiltersDrawer}
              />
            </div>
          </>
        )}

        {showSemanticPanel && (
          <>
            <div
              className="photos-drawer-backdrop"
              aria-hidden="true"
              onClick={closeSemanticDrawer}
            />
            <div
              ref={semanticDrawerRef}
              className="photos-side-drawer"
              role="dialog"
              aria-modal="true"
              aria-label="Local Semantic Index"
              tabIndex={-1}
            >
              <SemanticIndexPanel onClose={closeSemanticDrawer} />
            </div>
          </>
        )}

        {viewMode === 'similarity' ? (
          <SimilarityReviewPanel />
        ) : (
          <>
            {/* Status Notices */}
            {isLoading && totalCount === 0 && (
              <div className="notice" role="status">
                <RefreshCw size={16} className="spin" />
                <span>Loading photographs…</span>
              </div>
            )}

            {error && (
              <div className="notice notice-error" role="alert" data-testid="photos-load-error">
                <AlertTriangle size={16} />
                <div className="notice-content">
                  <strong>
                    {searchQuery.trim()
                      ? "Couldn't complete photo search"
                      : 'Failed to load photographs'}
                  </strong>
                  <p>{error}</p>
                  {errorDetails && (
                    <details className="search-error-details">
                      <summary>Diagnostics</summary>
                      <span>{errorDetails}</span>
                    </details>
                  )}
                </div>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  data-testid="photos-retry-btn"
                  onClick={() => void refresh()}
                >
                  Retry
                </button>
              </div>
            )}

            {!isLoading &&
              !error &&
              totalCount === 0 &&
              !clarification &&
              !visualModelRequired &&
              (() => {
                const cov = metadataProgress?.coverage
                const unreadMeta = (cov?.unprocessedCount ?? 0) + (cov?.staleCount ?? 0)
                const visualUnindexed =
                  semanticIndex.modelStatus.state === 'ready'
                    ? Math.max(
                        0,
                        semanticIndex.indexProgress.totalCatalogPhotos -
                          semanticIndex.indexProgress.currentIndexedPhotos
                      )
                    : 0
                const hasUnfinishedMeta = (searchQuery || hasAnyActiveFilter) && unreadMeta > 0
                const hasUnfinishedVisual =
                  Boolean(searchQuery) && searchMode !== 'metadata_only' && visualUnindexed > 0

                return (
                  <div className="notice" role="status" data-testid="photos-empty-notice">
                    <ImageIcon size={24} />
                    <div className="notice-content">
                      <strong>
                        {searchQuery
                          ? hasUnfinishedMeta || hasUnfinishedVisual
                            ? `No matches yet for "${searchQuery}" — catalog catch-up is incomplete`
                            : searchMode === 'metadata_only'
                              ? `No matching photos found for "${searchQuery}"`
                              : `No semantic matches found for "${searchQuery}"`
                          : hasAnyActiveFilter
                            ? hasUnfinishedMeta
                              ? 'No matching photos yet — some photo dates and locations are not read yet'
                              : 'No photographs match the current filter criteria'
                            : 'No photographs discovered yet'}
                      </strong>
                      <p>
                        {hasUnfinishedMeta || hasUnfinishedVisual
                          ? `${unreadMeta > 0 ? `${unreadMeta.toLocaleString()} photos have not had dates/locations read yet. ` : ''}${hasUnfinishedVisual ? `${visualUnindexed.toLocaleString()} photos are not visually indexed yet.` : ''}`
                          : searchQuery
                            ? 'Try different search terms or click Clear search to restore ordinary browsing.'
                            : hasAnyActiveFilter
                              ? 'Try selecting different filters or click Reset filters.'
                              : 'Connect a source folder and run a scan to discover photographs.'}
                      </p>
                    </div>
                  </div>
                )
              })()}

            {/* Virtualized Grid & Search Results Container */}
            {totalCount > 0 && (
              <div
                ref={handleGridRef}
                className="photos-grid-scroll-container photos-grid-container"
                onScroll={handleScroll}
                tabIndex={-1}
                role="region"
                aria-label="Photographs Grid"
                data-grid-columns={columns}
                data-cached-page-count={cachedPageIndices.length}
                data-cached-pages={cachedPageIndices.join(',')}
                data-search-score-count={searchScores.size}
              >
                <div
                  className="photos-virtual-height-holder photos-virtual-container"
                  style={{
                    height: `${totalHeight}px`,
                    position: 'relative',
                    width: '100%'
                  }}
                >
                  {visibleIndices.map((index) => {
                    const photo = getPhoto(index)
                    const row = Math.floor(index / columns)
                    const col = index % columns
                    const top = row * rowHeight
                    const left = col * (cellWidth + gap)

                    if (!photo) {
                      return (
                        <div
                          key={`placeholder-${index}`}
                          className="photo-card photo-cell photo-skeleton"
                          style={{
                            position: 'absolute',
                            top: `${top}px`,
                            left: `${left}px`,
                            width: `${cellWidth}px`,
                            height: `${cellHeight}px`
                          }}
                        >
                          <div className="photo-thumbnail-container">
                            <div className="thumbnail-placeholder loading">
                              <FileImage size={28} className="pulse" />
                            </div>
                          </div>
                          <div className="photo-card-info">
                            <span className="photo-filename">Loading…</span>
                          </div>
                        </div>
                      )
                    }

                    const thumb = thumbnails.get(photo.id)
                    const isSelected = selectedId === photo.id

                    return (
                      <PhotoCardCell
                        key={photo.id}
                        photo={photo}
                        index={index}
                        thumb={thumb}
                        isSelected={isSelected}
                        top={top}
                        left={left}
                        cellWidth={cellWidth}
                        cellHeight={cellHeight}
                        onOpenViewer={openViewerFromGrid}
                        onSelectDetails={selectPhoto}
                        onKeyDown={handleKeyDown}
                      />
                    )
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Details Side Panel / Responsive Drawer */}
      {viewMode === 'grid' && selectedPhoto && (
        <>
          {isNarrowDetailsViewport && (
            <div className="details-backdrop" aria-hidden="true" onClick={closeDetails} />
          )}
          <aside
            ref={detailsPanelRef}
            className="photo-details-panel"
            aria-label="Photograph Details"
            role={isNarrowDetailsViewport ? 'dialog' : undefined}
            aria-modal={isNarrowDetailsViewport ? true : undefined}
            tabIndex={-1}
          >
            <div className="details-header">
              <button
                type="button"
                className="btn btn-secondary btn-sm details-back-btn"
                onClick={closeDetails}
                aria-label="Back to Photos"
              >
                <ArrowLeft size={16} aria-hidden="true" />
                <span>Back</span>
              </button>
              <h3>Photograph Details</h3>
              <button
                type="button"
                className="btn-icon details-close-btn"
                onClick={closeDetails}
                aria-label="Close details"
                title="Close details"
              >
                <X size={16} />
              </button>
            </div>

            <div className="details-body">
              <div className="details-preview">
                {selectedPhoto.mediaKind === 'video' ? (
                  <div className="details-preview-placeholder details-video-preview">
                    <Film size={40} aria-hidden="true" />
                    <strong>{formatContainerLabel(selectedPhoto.videoContainer)} Video</strong>
                    <span className="sub-text">
                      {[
                        selectedPhoto.videoCodec?.toUpperCase(),
                        formatMediaDuration(selectedPhoto.videoDurationMs),
                        selectedPhoto.videoWidthPx && selectedPhoto.videoHeightPx
                          ? `${selectedPhoto.videoWidthPx} × ${selectedPhoto.videoHeightPx}`
                          : null
                      ]
                        .filter(Boolean)
                        .join(' · ') || 'Video file'}
                    </span>
                  </div>
                ) : (
                  (() => {
                    const selectedThumb = thumbnails.get(selectedPhoto.id)
                    if (selectedThumb?.status === 'ready') {
                      return (
                        <img
                          src={selectedThumb.dataUrl}
                          alt={selectedPhoto.fileName}
                          className="details-preview-img"
                        />
                      )
                    }
                    if (selectedThumb?.status === 'missing') {
                      return (
                        <div className="details-preview-placeholder unavailable">
                          <AlertTriangle size={36} />
                          <span>Original unavailable</span>
                        </div>
                      )
                    }
                    if (selectedThumb?.status === 'error') {
                      return (
                        <div
                          className="details-preview-placeholder error"
                          title={selectedThumb.message}
                        >
                          <AlertTriangle size={36} />
                          <span>{formatThumbnailErrorLabel(selectedThumb.code)}</span>
                        </div>
                      )
                    }
                    return (
                      <div className="details-preview-placeholder">
                        <ImageIcon size={48} />
                      </div>
                    )
                  })()
                )}
              </div>
              {selectedPhoto.mediaKind !== 'video' &&
                thumbnails.get(selectedPhoto.id)?.status === 'ready' &&
                (thumbnails.get(selectedPhoto.id) as Extract<ThumbnailResult, { status: 'ready' }>)
                  .originalUnavailable && (
                  <p className="sub-text details-preview-unavailable-note" role="status">
                    Original unavailable — showing cached preview
                  </p>
                )}
              {selectedPhoto.mediaKind !== 'video' &&
                thumbnails.get(selectedPhoto.id)?.status === 'error' && (
                  <p className="error-text details-preview-unavailable-note" role="alert">
                    {
                      (
                        thumbnails.get(selectedPhoto.id) as Extract<
                          ThumbnailResult,
                          { status: 'error' }
                        >
                      ).message
                    }
                  </p>
                )}
              <div className="details-preview-actions">
                <button
                  ref={originalOpenBtnRef}
                  type="button"
                  className="btn btn-secondary btn-sm"
                  data-testid="photos-open-original-btn"
                  onClick={handleOpenOriginal}
                >
                  {selectedPhoto.mediaKind === 'video' ? 'Play video' : 'Open original'}
                </button>
                {selectedPhoto.mediaKind === 'video' && (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    data-testid="details-open-default-player-btn"
                    disabled={detailsDefaultPlayerBusy}
                    onClick={() => void handleOpenDetailsDefaultPlayer()}
                  >
                    <ExternalLink size={14} aria-hidden="true" />
                    <span>{detailsDefaultPlayerBusy ? 'Opening…' : 'Open in default player'}</span>
                  </button>
                )}
              </div>
              {detailsDefaultPlayerFeedback && (
                <p
                  className={detailsDefaultPlayerFeedback.ok ? 'sub-text' : 'error-text'}
                  role="status"
                >
                  {detailsDefaultPlayerFeedback.ok
                    ? (detailsDefaultPlayerFeedback.message ??
                      `Opened ${detailsDefaultPlayerFeedback.launchedFileName ?? selectedPhoto.fileName} in your default media player.`)
                    : (detailsDefaultPlayerFeedback.error ?? 'Could not launch default player.')}
                </p>
              )}

              {selectedPhoto.mediaKind === 'video' && (
                <div className="details-section" data-testid="details-video-metadata-section">
                  <h4>Video Stream &amp; Container</h4>
                  <dl className="details-list">
                    <dt>Detected Container</dt>
                    <dd>{formatContainerLabel(selectedPhoto.videoContainer)}</dd>
                    {selectedPhoto.videoCodec && (
                      <>
                        <dt>Video Codec</dt>
                        <dd>{selectedPhoto.videoCodec.toUpperCase()}</dd>
                      </>
                    )}
                    {selectedPhoto.audioCodec && (
                      <>
                        <dt>Audio Codec</dt>
                        <dd>{selectedPhoto.audioCodec.toUpperCase()}</dd>
                      </>
                    )}
                    {formatMediaDuration(selectedPhoto.videoDurationMs) && (
                      <>
                        <dt>Duration</dt>
                        <dd>{formatMediaDuration(selectedPhoto.videoDurationMs)}</dd>
                      </>
                    )}
                    {selectedPhoto.videoWidthPx && selectedPhoto.videoHeightPx && (
                      <>
                        <dt>Resolution</dt>
                        <dd>
                          {selectedPhoto.videoWidthPx} × {selectedPhoto.videoHeightPx}
                        </dd>
                      </>
                    )}
                    {hasMismatchedVideoExtension(selectedPhoto) && (
                      <>
                        <dt>Extension Notice</dt>
                        <dd>
                          File keeps original <code>{selectedPhoto.extension}</code> name; content
                          identified as {formatContainerLabel(selectedPhoto.videoContainer)}.
                        </dd>
                      </>
                    )}
                    {selectedPhoto.videoStructureError && (
                      <>
                        <dt>Container Check</dt>
                        <dd className="error-text">{selectedPhoto.videoStructureError}</dd>
                      </>
                    )}
                  </dl>
                </div>
              )}

              {/* Stage 5B: Review & Organize Controls */}
              <div className="details-section review-section">
                <h4>Review & Organize</h4>

                {saveStatus === 'saving' && (
                  <div className="status-saving-indicator" role="status">
                    <span>Saving...</span>
                  </div>
                )}

                {persistencePending && (
                  <div
                    className="notice notice-warning persistence-pending-indicator"
                    role="status"
                  >
                    <AlertTriangle size={16} />
                    <div className="notice-content">
                      <strong>Journal finalization pending</strong>
                      <p>Saved to database; awaiting journal finalization on disk.</p>
                      {persistenceError && <p className="error-text">{persistenceError}</p>}
                    </div>
                    <button
                      type="button"
                      className="btn btn-secondary btn-xs"
                      aria-label="Retry reconciliation"
                      onClick={() => void retryReconciliation()}
                    >
                      <RefreshCw size={12} />
                      <span>Retry reconciliation</span>
                    </button>
                  </div>
                )}

                {saveStatus === 'saved' && !persistencePending && (
                  <div className="status-saved-indicator" role="status">
                    <span>Saved</span>
                  </div>
                )}

                {saveStatus === 'conflict' && (
                  <div className="notice notice-error" role="alert">
                    <AlertTriangle size={16} />
                    <div className="notice-content">
                      <strong>Conflict</strong>
                      <p>{statusMessage ?? 'Annotation version or file revision mismatch.'}</p>
                    </div>
                  </div>
                )}

                {saveStatus === 'error' && (
                  <div className="notice notice-error" role="alert">
                    <AlertTriangle size={16} />
                    <div className="notice-content">
                      <strong>Error</strong>
                      <p>{statusMessage}</p>
                    </div>
                  </div>
                )}

                {/* Rating stars */}
                <div className="review-control-row">
                  <span className="control-label">Rating:</span>
                  <div className="rating-star-buttons" role="group" aria-label="Photo Rating">
                    {[1, 2, 3, 4, 5].map((starVal) => {
                      const isActive =
                        selectedPhoto.rating !== null && selectedPhoto.rating >= starVal
                      const starLabel = starVal === 1 ? '1 Star' : `${starVal} Stars`
                      return (
                        <button
                          key={starVal}
                          type="button"
                          className={`btn-star ${isActive ? 'active' : ''}`}
                          aria-label={starLabel}
                          title={starLabel}
                          onClick={() => void setRating(starVal as PhotoRating)}
                        >
                          <Star size={16} fill={isActive ? 'currentColor' : 'none'} />
                        </button>
                      )
                    })}
                    {selectedPhoto.rating !== null && (
                      <button
                        type="button"
                        className="btn-clear-rating"
                        onClick={() => void setRating(null)}
                        title="Clear rating"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </div>

                {/* Review Flags */}
                <div className="review-control-row">
                  <span className="control-label">Flag:</span>
                  <div className="flag-buttons-group" role="group" aria-label="Photo Flag">
                    <button
                      type="button"
                      className={`btn-flag ${selectedPhoto.flag === 'none' ? 'active' : ''}`}
                      onClick={() => void setFlag('none')}
                      title="No flag"
                    >
                      None
                    </button>
                    <button
                      type="button"
                      className={`btn-flag btn-flag-pick ${selectedPhoto.flag === 'pick' ? 'active' : ''}`}
                      onClick={() => void setFlag('pick')}
                      title="Pick (Keep / Feature)"
                    >
                      <Check size={14} />
                      <span>Pick</span>
                    </button>
                    <button
                      type="button"
                      className={`btn-flag btn-flag-reject ${selectedPhoto.flag === 'reject' ? 'active' : ''}`}
                      onClick={() => void setFlag('reject')}
                      title="Reject (Review annotation only; source file preserved)"
                    >
                      <Ban size={14} />
                      <span>Reject</span>
                    </button>
                  </div>
                </div>

                {/* Custom Collections */}
                <div className="review-control-row collections-row">
                  <span className="control-label">Collections:</span>
                  <div className="collections-management">
                    {isLoadingMemberships ? (
                      <span className="sub-text loading-memberships">Loading memberships…</span>
                    ) : membershipError ? (
                      <div
                        className="membership-error-container"
                        style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
                      >
                        <span className="sub-text membership-error-text error-text">
                          {membershipError}
                        </span>
                        <button
                          type="button"
                          className="btn btn-secondary btn-xs retry-memberships-btn"
                          onClick={() => void retryLoadMemberships()}
                        >
                          Retry
                        </button>
                      </div>
                    ) : memberships.length > 0 ? (
                      <div className="memberships-list">
                        {memberships.map((m) => (
                          <span key={m.id} className="membership-tag">
                            <span className="membership-name">{m.collectionName}</span>
                            <button
                              type="button"
                              className="btn-remove-membership"
                              aria-label={`Remove from ${m.collectionName}`}
                              title={`Remove from ${m.collectionName}`}
                              onClick={() => void removeCollectionMember(m.collectionId)}
                            >
                              <X size={12} />
                            </button>
                          </span>
                        ))}
                        {totalMembershipsPages > 1 && (
                          <div
                            className="memberships-pagination-controls"
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '8px',
                              marginTop: '6px'
                            }}
                          >
                            <button
                              type="button"
                              className="btn btn-secondary btn-xs"
                              aria-label="Previous memberships page"
                              disabled={!hasPrevMemberships}
                              onClick={() => void goToPrevMembershipsPage()}
                            >
                              Prev
                            </button>
                            <span className="sub-text">
                              Page {membershipsPage} of {totalMembershipsPages}
                            </span>
                            <button
                              type="button"
                              className="btn btn-secondary btn-xs"
                              aria-label="Next memberships page"
                              disabled={!hasMoreMemberships}
                              onClick={() => void goToNextMembershipsPage()}
                            >
                              Next
                            </button>
                          </div>
                        )}
                      </div>
                    ) : (
                      <span className="sub-text no-memberships">Not in any collection</span>
                    )}

                    {/* Add to existing collection & Rename controls */}
                    <div className="collections-action-container">
                      {collections.length > 0 && (
                        <div className="collections-list-panel">
                          {collections.map((col) => {
                            const isMember = membershipCollectionIds.has(col.id)
                            const isRenaming = renamingCollectionId === col.id

                            if (isRenaming) {
                              return (
                                <form
                                  key={col.id}
                                  className="rename-collection-form"
                                  onSubmit={async (e) => {
                                    e.preventDefault()
                                    if (!renameInputValue.trim()) return
                                    setCollectionActionError(null)
                                    try {
                                      await renameCollection(col.id, renameInputValue.trim())
                                      setRenamingCollectionId(null)
                                    } catch (err: unknown) {
                                      setCollectionActionError(
                                        err instanceof Error ? err.message : String(err)
                                      )
                                    }
                                  }}
                                >
                                  <input
                                    type="text"
                                    className="input-collection-name"
                                    aria-label={`New name for collection ${col.name}`}
                                    value={renameInputValue}
                                    onChange={(e) => setRenameInputValue(e.target.value)}
                                    maxLength={80}
                                    autoFocus
                                  />
                                  <button
                                    type="submit"
                                    className="btn btn-primary btn-xs"
                                    aria-label="Save collection name"
                                    disabled={!renameInputValue.trim()}
                                  >
                                    Save
                                  </button>
                                  <button
                                    type="button"
                                    className="btn btn-secondary btn-xs"
                                    aria-label="Cancel rename"
                                    onClick={() => setRenamingCollectionId(null)}
                                  >
                                    Cancel
                                  </button>
                                </form>
                              )
                            }

                            return (
                              <div key={col.id} className="collection-item-row">
                                <span className="collection-item-name">{col.name}</span>
                                <div className="collection-item-actions">
                                  {!isMember && (
                                    <button
                                      type="button"
                                      className="btn btn-secondary btn-xs"
                                      aria-label={`Add to ${col.name}`}
                                      onClick={() => void addCollectionMember(col.id)}
                                    >
                                      <Plus size={12} />
                                      <span>Add to {col.name}</span>
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    className="btn-icon"
                                    aria-label={`Rename collection ${col.name}`}
                                    title={`Rename collection ${col.name}`}
                                    onClick={() => {
                                      setRenamingCollectionId(col.id)
                                      setRenameInputValue(col.name)
                                    }}
                                  >
                                    <Edit2 size={12} />
                                  </button>
                                </div>
                              </div>
                            )
                          })}
                          {totalCollectionsPages > 1 && (
                            <div
                              className="collections-pagination-controls"
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '8px',
                                marginTop: '6px'
                              }}
                            >
                              <button
                                type="button"
                                className="btn btn-secondary btn-xs"
                                aria-label="Previous collections page"
                                disabled={!hasPrevCollections}
                                onClick={() => void goToPrevCollectionsPage()}
                              >
                                Prev
                              </button>
                              <span className="sub-text">
                                Page {collectionsPage} of {totalCollectionsPages}
                              </span>
                              <button
                                type="button"
                                className="btn btn-secondary btn-xs"
                                aria-label="Next collections page"
                                disabled={!hasMoreCollections}
                                onClick={() => void goToNextCollectionsPage()}
                              >
                                Next
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Create new collection */}
                    <form onSubmit={handleCreateCollection} className="create-collection-form">
                      <input
                        type="text"
                        className="input-collection-name"
                        placeholder="New collection name…"
                        aria-label="New collection name"
                        value={newCollectionName}
                        onChange={(e) => setNewCollectionName(e.target.value)}
                        maxLength={80}
                      />
                      <button
                        type="submit"
                        className="btn btn-secondary btn-xs"
                        disabled={!newCollectionName.trim()}
                        title="Create collection"
                      >
                        <FolderPlus size={12} />
                        <span>Create</span>
                      </button>
                    </form>
                    {collectionActionError && (
                      <span className="error-text">{collectionActionError}</span>
                    )}
                  </div>
                </div>
              </div>

              <div className="details-section">
                <h4>File Facts</h4>
                <dl className="details-list">
                  <dt>File Name</dt>
                  <dd title={selectedPhoto.fileName}>{selectedPhoto.fileName}</dd>

                  <dt>Recorded Extension</dt>
                  <dd>{selectedPhoto.extension || '(none)'}</dd>

                  <dt>Original Source Path</dt>
                  <dd className="path-text" title={selectedPhoto.originalPath}>
                    {selectedPhoto.originalPath}
                  </dd>

                  <dt>Size</dt>
                  <dd>
                    {formatBytes(selectedPhoto.byteSize)}{' '}
                    <span className="sub-text">
                      ({selectedPhoto.byteSize.toLocaleString()} bytes)
                    </span>
                  </dd>

                  <dt>Filesystem Created</dt>
                  <dd>{formatDate(selectedPhoto.filesystemBirthtimeMs)}</dd>

                  <dt>Filesystem Modified</dt>
                  <dd>{formatDate(selectedPhoto.filesystemMtimeMs)}</dd>
                </dl>
              </div>

              <div className="details-section">
                <h4>Inferred Metadata</h4>
                <dl className="details-list">
                  <dt>Capture Date</dt>
                  <dd>{renderInferredCaptureDateValue(selectedPhoto, selectedMetadataDetail)}</dd>

                  <dt>Capture Location (GPS)</dt>
                  <dd>
                    {(() => {
                      const effStatus = selectedMetadataDetail?.effectiveStatus ?? 'unprocessed'
                      const gpsMeta = selectedMetadataDetail?.currentMetadata
                      if (
                        gpsMeta?.gpsStatus === 'present' &&
                        gpsMeta.gpsLatitude !== null &&
                        gpsMeta.gpsLongitude !== null
                      ) {
                        const matchedAreas = matchGpsToOfflinePlaces(
                          gpsMeta.gpsLatitude,
                          gpsMeta.gpsLongitude,
                          savedPlaces
                        )
                        const areaLabel = matchedAreas.map((m) => m.label).join(', ')
                        return areaLabel
                          ? `${areaLabel} (${gpsMeta.gpsLatitude.toFixed(4)}, ${gpsMeta.gpsLongitude.toFixed(4)})`
                          : `${gpsMeta.gpsLatitude.toFixed(4)}, ${gpsMeta.gpsLongitude.toFixed(4)}`
                      }
                      if (gpsMeta?.gpsStatus === 'invalid') {
                        return 'Unknown (invalid GPS tags)'
                      }
                      if (
                        !selectedMetadataDetail ||
                        effStatus === 'unprocessed' ||
                        effStatus === 'stale'
                      ) {
                        return 'Location not read yet'
                      }
                      if (effStatus === 'unavailable') {
                        return 'Original unavailable — location could not be read'
                      }
                      if (effStatus === 'failed') {
                        return 'Could not read location'
                      }
                      if (effStatus === 'unsupported') {
                        return 'Unsupported format — location could not be read'
                      }
                      return 'No embedded GPS'
                    })()}
                  </dd>
                </dl>
              </div>

              {searchScores.has(selectedPhoto.id) && (
                <div className="details-section" data-testid="photo-search-similarity-detail">
                  <h4>Search Relevance</h4>
                  <dl className="details-list">
                    <dt>Similarity Score</dt>
                    <dd className="mono-value">{searchScores.get(selectedPhoto.id)!.toFixed(3)}</dd>
                    <dt>Provenance</dt>
                    <dd className="sub-text">
                      Machine inference ranking signal, not a probability.
                    </dd>
                  </dl>
                </div>
              )}

              <div className="details-section" data-testid="photo-technical-metadata-section">
                <h4>Embedded Technical Metadata</h4>
                {(() => {
                  const effStatus = selectedMetadataDetail?.effectiveStatus ?? 'unprocessed'
                  const meta = selectedMetadataDetail?.currentMetadata ?? null
                  const isUnprocessed =
                    !selectedMetadataDetail || effStatus === 'unprocessed' || effStatus === 'stale'
                  const unknownFallback = isUnprocessed ? 'Unknown (not extracted yet)' : 'Unknown'

                  return (
                    <>
                      <dl className="details-list">
                        <dt>Extraction Status</dt>
                        <dd>
                          {isLoadingMetadataDetail && !selectedMetadataDetail
                            ? 'Loading metadata…'
                            : formatEffectiveExtractionStatus(selectedMetadataDetail)}
                        </dd>

                        <dt>Detected Container</dt>
                        <dd>
                          <div className="metadata-provenance-stack">
                            <span>
                              {meta?.detectedFormat
                                ? meta.detectedFormat.toUpperCase()
                                : unknownFallback}
                            </span>
                            {meta?.extensionFormatMismatch && (
                              <span className="badge-warning metadata-mismatch-badge">
                                Extension / container mismatch ({meta.recordedExtension || '(none)'}{' '}
                                vs {meta.detectedFormat})
                              </span>
                            )}
                          </div>
                        </dd>

                        <dt>Display Dimensions</dt>
                        <dd>
                          {meta?.displayWidthPx && meta?.displayHeightPx ? (
                            <span>
                              {meta.displayWidthPx.toLocaleString()} ×{' '}
                              {meta.displayHeightPx.toLocaleString()} px{' '}
                              <span className="sub-text">(orientation-adjusted)</span>
                            </span>
                          ) : (
                            unknownFallback
                          )}
                        </dd>

                        <dt>Encoded Dimensions</dt>
                        <dd>
                          {meta?.encodedWidthPx && meta?.encodedHeightPx ? (
                            <span>
                              {meta.encodedWidthPx.toLocaleString()} ×{' '}
                              {meta.encodedHeightPx.toLocaleString()} px
                              {meta.exifOrientation !== null
                                ? ` · Orientation ${meta.exifOrientation}`
                                : ' · Orientation unspecified'}
                            </span>
                          ) : (
                            unknownFallback
                          )}
                        </dd>

                        <dt>Camera</dt>
                        <dd>
                          {meta?.cameraDisplay ? (
                            <div className="metadata-provenance-stack">
                              <span>{meta.cameraDisplay}</span>
                              <span className="sub-text">
                                Raw Make: {meta.cameraMakeRaw ?? '—'} · Model:{' '}
                                {meta.cameraModelRaw ?? '—'}
                              </span>
                            </div>
                          ) : (
                            unknownFallback
                          )}
                        </dd>

                        <dt>Lens</dt>
                        <dd>
                          {meta?.lensDisplay ? (
                            <div className="metadata-provenance-stack">
                              <span>{meta.lensDisplay}</span>
                              <span className="sub-text">
                                Raw LensMake: {meta.lensMakeRaw ?? '—'} · LensModel:{' '}
                                {meta.lensModelRaw ?? '—'}
                              </span>
                            </div>
                          ) : (
                            unknownFallback
                          )}
                        </dd>

                        {(meta?.rawCaptureDateText ||
                          meta?.captureDateConflict ||
                          meta?.captureDateParseError) && (
                          <>
                            <dt>Date Tag Evidence</dt>
                            <dd>
                              <div className="metadata-provenance-stack">
                                {meta.rawCaptureDateText && (
                                  <span className="mono-value">
                                    Raw `{meta.captureDateSourceTag ?? 'EXIF'}`:{' '}
                                    {meta.rawCaptureDateText}
                                    {meta.captureSubseconds
                                      ? ` (SubSec: ${meta.captureSubseconds})`
                                      : ''}
                                  </span>
                                )}
                                {meta.captureDateConflict && (
                                  <span className="metadata-warning-inline">
                                    {meta.captureDateConflict}
                                  </span>
                                )}
                                {meta.captureDateParseError && (
                                  <span className="metadata-warning-inline">
                                    {meta.captureDateParseError}
                                  </span>
                                )}
                              </div>
                            </dd>
                          </>
                        )}

                        <dt>GPS Coordinates</dt>
                        <dd>
                          {meta?.gpsStatus === 'present' &&
                          meta.gpsLatitude !== null &&
                          meta.gpsLongitude !== null ? (
                            <div className="metadata-provenance-stack">
                              <span className="mono-value">
                                {meta.gpsLatitude.toFixed(5)}, {meta.gpsLongitude.toFixed(5)}
                                {meta.gpsAltitudeM !== null
                                  ? ` · ${Math.round(meta.gpsAltitudeM)} m`
                                  : ''}
                              </span>
                              {(() => {
                                const areaMatches = matchGpsToOfflinePlaces(
                                  meta.gpsLatitude,
                                  meta.gpsLongitude,
                                  savedPlaces
                                )
                                return areaMatches.length > 0 ? (
                                  <span className="sub-text">
                                    Offline area: {areaMatches.map((m) => m.label).join(', ')}
                                  </span>
                                ) : null
                              })()}
                            </div>
                          ) : meta?.gpsStatus === 'invalid' ? (
                            <span className="metadata-warning-inline">
                              Invalid GPS ({meta.gpsParseError ?? 'malformed coordinates'})
                            </span>
                          ) : effStatus === 'unprocessed' ||
                            effStatus === 'stale' ||
                            !selectedMetadataDetail ? (
                            'Location not read yet'
                          ) : effStatus === 'unavailable' ? (
                            'Original unavailable — location could not be read'
                          ) : effStatus === 'failed' ? (
                            'Could not read location'
                          ) : effStatus === 'unsupported' ? (
                            'Unsupported format — location could not be read'
                          ) : (
                            'No embedded GPS'
                          )}
                        </dd>

                        <dt>Parser Provenance</dt>
                        <dd>
                          <div className="metadata-provenance-stack">
                            <span className="sub-text">
                              Recipe: `
                              {selectedMetadataDetail?.parserRecipeVersion ?? 'exif_tech_v2'}`
                            </span>
                            {meta && meta.unknownTagCount > 0 && (
                              <span className="sub-text">
                                {meta.unknownTagCount} unknown/proprietary tag(s) preserved in
                                original bytes
                              </span>
                            )}
                            {meta?.parserLimitsNote && (
                              <span className="sub-text">{meta.parserLimitsNote}</span>
                            )}
                            {selectedMetadataDetail &&
                              selectedMetadataDetail.historicalMetadataCount > 0 && (
                                <span className="sub-text">
                                  {selectedMetadataDetail.historicalMetadataCount} historical
                                  revision(s) preserved
                                </span>
                              )}
                          </div>
                        </dd>
                      </dl>

                      {meta?.rawMetadataJson && (
                        <details
                          className="metadata-raw-json-details"
                          data-testid="metadata-readable-tags"
                        >
                          <summary>Readable Embedded Tags &amp; Raw Evidence (JSON)</summary>
                          {(() => {
                            try {
                              const parsed = JSON.parse(meta.rawMetadataJson) as {
                                readableTags?: Record<string, string | number | boolean>
                              }
                              const entries = parsed.readableTags
                                ? Object.entries(parsed.readableTags)
                                : []
                              if (entries.length > 0) {
                                return (
                                  <dl className="details-list metadata-readable-tags-list">
                                    {entries.map(([k, v]) => (
                                      <div key={k} className="metadata-readable-tag-row">
                                        <dt>{k}</dt>
                                        <dd className="mono-value">{String(v)}</dd>
                                      </div>
                                    ))}
                                  </dl>
                                )
                              }
                            } catch {
                              // Fallback directly to raw JSON display
                            }
                            return null
                          })()}
                          <pre className="metadata-raw-json-pre">{meta.rawMetadataJson}</pre>
                        </details>
                      )}
                    </>
                  )
                })()}
              </div>

              <div className="details-section" data-testid="photo-user-metadata-section">
                <h4>User-Assigned Metadata</h4>
                <p className="sub-text">
                  Stored separately from recorded file facts and embedded EXIF/GPS tags.
                </p>
                <div className="user-metadata-editor-block">
                  <div className="user-metadata-field-row">
                    <span className="control-label">Assigned Place:</span>
                    <div className="user-metadata-controls">
                      <input
                        type="text"
                        aria-label="User-assigned place"
                        placeholder="e.g. Yellowstone National Park"
                        value={userPlaceDraft}
                        onChange={(e) => setUserPlaceDraft(e.target.value)}
                      />
                      <button
                        type="button"
                        className="btn btn-secondary btn-xs"
                        disabled={!userPlaceDraft.trim()}
                        onClick={() => {
                          const rawLabel = userPlaceDraft.trim()
                          const resolvedOffline = resolveOfflinePlace(rawLabel, savedPlaces)
                          const canonicalLabel =
                            resolvedOffline.status === 'resolved'
                              ? resolvedOffline.match.label
                              : rawLabel
                          const canonicalPlaceId =
                            resolvedOffline.status === 'resolved'
                              ? resolvedOffline.match.savedPlaceId
                              : null
                          void setPhotoUserPlace({
                            fileLocationId: selectedPhoto.id,
                            placeId: canonicalPlaceId,
                            placeLabel: canonicalLabel
                          }).then(() => refreshMetadata())
                        }}
                      >
                        Save Place
                      </button>
                      {selectedMetadataDetail?.userPlace && (
                        <button
                          type="button"
                          className="btn btn-secondary btn-xs"
                          onClick={() =>
                            void clearPhotoUserPlace(selectedPhoto.id).then(() => refreshMetadata())
                          }
                        >
                          Clear
                        </button>
                      )}
                    </div>
                  </div>

                  {selectedMetadataDetail?.currentMetadata?.cameraNormalized && (
                    <div className="user-metadata-field-row">
                      <span className="control-label">
                        Camera Label ({selectedMetadataDetail.currentMetadata.cameraDisplay}):
                      </span>
                      <div className="user-metadata-controls">
                        <input
                          type="text"
                          aria-label="User-assigned camera label"
                          placeholder="e.g. Family Travel Body"
                          value={cameraLabelDraft}
                          onChange={(e) => setCameraLabelDraft(e.target.value)}
                        />
                        <button
                          type="button"
                          className="btn btn-secondary btn-xs"
                          disabled={!cameraLabelDraft.trim()}
                          onClick={() =>
                            void upsertCameraLabel({
                              cameraNormalized:
                                selectedMetadataDetail.currentMetadata!.cameraNormalized!,
                              label: cameraLabelDraft.trim()
                            }).then(() => refreshMetadata())
                          }
                        >
                          Save Label
                        </button>
                        {selectedMetadataDetail.cameraLabel && (
                          <button
                            type="button"
                            className="btn btn-secondary btn-xs"
                            onClick={() =>
                              void deleteCameraLabel(selectedMetadataDetail.cameraLabel!.id).then(
                                () => refreshMetadata()
                              )
                            }
                          >
                            Clear
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="details-section" data-testid="photo-protection-section">
                <h4>Copy &amp; Backup Protection</h4>
                {(() => {
                  const prot = selectedMetadataDetail?.protectionStatus
                  return (
                    <dl className="details-list">
                      <dt>Cataloged Original</dt>
                      <dd>Tracked read-only in catalog (source file is never altered)</dd>

                      <dt>Verified Vault Copy</dt>
                      <dd>
                        {prot?.hasVerifiedVaultCopy ? (
                          <div className="metadata-provenance-stack">
                            <span>Verified copy in vault</span>
                            {prot.vaultCopyVerifiedAtMs && (
                              <span className="sub-text">
                                Verified {formatDate(prot.vaultCopyVerifiedAtMs)}
                              </span>
                            )}
                            {prot.vaultCopyRelativePath && (
                              <span className="sub-text path-text">
                                {prot.vaultCopyRelativePath}
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="photo-protection-warning">
                            No verified vault copy yet
                          </span>
                        )}
                      </dd>

                      <dt>Verified Backup</dt>
                      <dd>
                        {prot?.hasVerifiedBackup ? (
                          <div className="metadata-provenance-stack">
                            <span>
                              {prot.latestBackupDestinationName ?? 'Verified destination'}
                            </span>
                            {prot.latestBackupVerifiedAtMs && (
                              <span className="sub-text">
                                Verified {formatDate(prot.latestBackupVerifiedAtMs)}
                                {prot.hasVerifiedVaultCopy
                                  ? prot.backupCoversVaultCopy
                                    ? ' · includes this vault copy'
                                    : ' · vault copy created after last backup'
                                  : ' · catalog snapshot only (no vault copy for this file)'}
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="photo-protection-warning">No verified backup yet</span>
                        )}
                      </dd>
                    </dl>
                  )
                })()}
              </div>

              <div className="details-section">
                <h4>Integrity & Provenance</h4>
                <dl className="details-list">
                  <dt>Verified Content Hash</dt>
                  <dd className="hash-text" title={selectedPhoto.activeHash ?? 'Not hashed'}>
                    {selectedPhoto.activeHash ? (
                      <code>{selectedPhoto.activeHash}</code>
                    ) : (
                      <span className="unhashed-tag">Not yet hashed</span>
                    )}
                  </dd>

                  {selectedPhoto.activeHashVerifiedAtMs && (
                    <>
                      <dt>Hash Verified At</dt>
                      <dd>{formatDate(selectedPhoto.activeHashVerifiedAtMs)}</dd>
                    </>
                  )}

                  <dt>Catalog Provenance</dt>
                  <dd>Discovery Observation #{selectedPhoto.discoveryObservationId}</dd>
                </dl>
              </div>

              <PhotoSelectedOcrSection
                fileLocationId={selectedPhoto.id}
                extension={selectedPhoto.extension}
              />
            </div>
          </aside>
        </>
      )}

      <MediaViewerModal
        open={isMediaViewerOpen}
        items={photos}
        getItemAtIndex={(index) =>
          getPhoto(index) ??
          (viewerState.index === index ? (viewerState.fallbackItem ?? undefined) : undefined)
        }
        totalCount={Math.max(totalCount, photos.length)}
        currentIndex={viewerState.index}
        onNavigate={handleViewerNavigate}
        onClose={closeMediaViewer}
        onOpenDetails={handleOpenDetailsFromViewer}
        ensureRangeLoaded={ensureRangeLoaded}
        restoreFocusTo={restoreViewerFocus}
      />
    </div>
  )
}
