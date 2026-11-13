/**
 * Personal Vault — Virtualized Photo Browsing Panel (Stage 5A/5B)
 *
 * Implements bounded, virtualized grid rendering with absolute catalog
 * positions, full collection scroll extent, keyboard navigation,
 * thumbnail decoding with honest placeholders, factual details panel,
 * and Stage 5B review features (ratings, flags, custom collections, and filters).
 */

import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
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
  Edit2
} from 'lucide-react'
import {
  usePhotos,
  PHOTO_BOUNDS,
  countActiveMetadataFilters,
  hasActiveMetadataFilters
} from '../hooks/usePhotos'
import { usePhotoReview } from '../hooks/usePhotoReview'
import { usePhotoMetadata } from '../hooks/usePhotoMetadata'
import { SimilarityReviewPanel } from './SimilarityReviewPanel'
import { SemanticIndexPanel } from './SemanticIndexPanel'
import { PhotoMetadataFilterPanel } from './PhotoMetadataFilterPanel'
import { PhotosSearchBar } from './PhotosSearchBar'
import type {
  PhotoFlagFilter,
  PhotoItem,
  PhotoRatingFilter,
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
    case 'stale':
      return 'Stale (source or parser recipe changed; re-run extraction)'
  }
}

interface PhotoCardCellProps {
  photo: PhotoItem
  thumb?: ThumbnailResult
  isSelected: boolean
  similarityScore?: number
  top: number
  left: number
  cellWidth: number
  cellHeight: number
  onSelect: (id: number) => void
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>, photo: PhotoItem) => void
  requestThumbnail: (photo: PhotoItem, priority?: 'high' | 'normal' | 'low') => void
  cancelThumbnail: (id: number) => void
}

function PhotoCardCell({
  photo,
  thumb,
  isSelected,
  similarityScore,
  top,
  left,
  cellWidth,
  cellHeight,
  onSelect,
  onKeyDown,
  requestThumbnail,
  cancelThumbnail
}: PhotoCardCellProps): ReactElement {
  useEffect(() => {
    requestThumbnail(photo, 'high')
    return () => {
      cancelThumbnail(photo.id)
    }
  }, [photo, requestThumbnail, cancelThumbnail])

  const ratingDesc = photo.rating ? `${photo.rating} stars` : 'unrated'
  const flagDesc = photo.flag && photo.flag !== 'none' ? photo.flag : 'no flag'

  return (
    <div
      id={`photo-cell-${photo.id}`}
      className={`photo-card photo-cell ${isSelected ? 'selected' : ''}`}
      style={{
        position: 'absolute',
        top: `${top}px`,
        left: `${left}px`,
        width: `${cellWidth}px`,
        height: `${cellHeight}px`
      }}
      role="button"
      tabIndex={0}
      aria-label={`${photo.fileName}, ${formatBytes(photo.byteSize)}, ${ratingDesc}, ${flagDesc}`}
      aria-pressed={isSelected}
      onClick={() => onSelect(photo.id)}
      onKeyDown={(e) => onKeyDown(e, photo)}
    >
      <div className="photo-thumbnail-container">
        {thumb?.status === 'ready' ? (
          <img
            src={thumb.dataUrl}
            alt={photo.fileName}
            className="photo-thumbnail-img"
            loading="lazy"
          />
        ) : thumb?.status === 'unsupported' ? (
          <div className="thumbnail-placeholder unsupported">
            <FileQuestion size={32} />
            <span className="placeholder-tag">Unsupported</span>
          </div>
        ) : thumb?.status === 'error' ? (
          <div className="thumbnail-placeholder error">
            <AlertTriangle size={32} />
            <span className="placeholder-tag">Unavailable</span>
          </div>
        ) : (
          <div className="thumbnail-placeholder loading">
            <FileImage size={32} className="pulse" />
            <span className="placeholder-tag">Loading…</span>
          </div>
        )}

        {/* Compact Review Badges Overlay */}
        <div className="photo-badges-overlay">
          {similarityScore !== undefined && (
            <span
              className="badge-similarity-score"
              title={`Semantic similarity score: ${similarityScore.toFixed(3)} (machine inference)`}
            >
              {(similarityScore * 100).toFixed(0)}% match
            </span>
          )}
          {photo.rating !== null && (
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
      </div>
      <div className="photo-card-info">
        <span className="photo-filename" title={photo.fileName}>
          {photo.fileName}
        </span>
        <span className="photo-size">{formatBytes(photo.byteSize)}</span>
      </div>
    </div>
  )
}

export function PhotosPanel() {
  const {
    photos,
    cachedPageIndices,
    totalCount,
    isLoading,
    error,
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
    searchResultMeta,
    searchScores,
    modelStatus,
    setSearchQuery,
    clearSearch,
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
  const [viewMode, setViewMode] = useState<'grid' | 'similarity'>('grid')
  const [showSemanticPanel, setShowSemanticPanel] = useState(false)
  const [showMetadataPanel, setShowMetadataPanel] = useState(false)

  const {
    progress: metadataProgress,
    isBusy: isMetadataBusy,
    actionError: metadataActionError,
    selectedDetail: selectedMetadataDetail,
    isLoadingDetail: isLoadingMetadataDetail,
    cameraFacet,
    lensFacet,
    fileTypeFacet,
    setCameraFacetSearch,
    setCameraFacetOffset,
    setLensFacetSearch,
    setLensFacetOffset,
    setFileTypeFacetOffset,
    startExtraction: startMetadataExtraction,
    pauseExtraction: pauseMetadataExtraction,
    resumeExtraction: resumeMetadataExtraction,
    cancelExtraction: cancelMetadataExtraction
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

  const containerRef = useRef<HTMLDivElement>(null)
  const [scrollState, setScrollState] = useState<{ generation: number; top: number }>({
    generation: 0,
    top: 0
  })
  const scrollTop = scrollState.generation === filterGeneration ? scrollState.top : 0
  const [containerHeight, setContainerHeight] = useState(600)
  const [containerWidth, setContainerWidth] = useState(800)

  // Reset scroll viewport DOM position whenever filters change or reset so result pages never mix
  useEffect(() => {
    if (filterGeneration > 0 && containerRef.current) {
      containerRef.current.scrollTop = 0
    }
  }, [filterGeneration])

  // Measure container dimensions for virtualization
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const updateDimensions = () => {
      setContainerHeight(el.clientHeight || 600)
      setContainerWidth(el.clientWidth || 800)
    }

    updateDimensions()
    const observer = new ResizeObserver(updateDimensions)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget
    setScrollState({ generation: filterGeneration, top: target.scrollTop })
  }

  // Virtualization calculations based on totalCount for full extent
  const cellWidth = 180
  const cellHeight = 200
  const gap = 16
  const columns = Math.max(1, Math.floor((containerWidth + gap) / (cellWidth + gap)))
  const totalRows = Math.ceil(totalCount / columns)
  const rowHeight = cellHeight + gap
  const totalHeight = Math.max(0, totalRows * rowHeight - gap)

  // Visible window range calculation (bounded to max 200 cells)
  const startRow = Math.max(0, Math.floor(scrollTop / rowHeight) - 1)
  const visibleRowCount = Math.ceil(containerHeight / rowHeight) + 2
  const endRow = Math.min(totalRows, startRow + visibleRowCount)

  const startIndex = startRow * columns
  const rawEndIndex = endRow * columns
  const endIndex = Math.min(
    totalCount,
    Math.min(rawEndIndex, startIndex + PHOTO_BOUNDS.MAX_MOUNTED_CELLS)
  )

  // Trigger loading of required page range
  useEffect(() => {
    if (totalCount > 0) {
      ensureRangeLoaded(startIndex, endIndex)
    }
  }, [totalCount, startIndex, endIndex, ensureRangeLoaded])

  // Build cell indices array for mounted range
  const visibleIndices: number[] = []
  for (let i = startIndex; i < endIndex; i++) {
    visibleIndices.push(i)
  }

  // Keyboard navigation within grid
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>, currentPhoto: PhotoItem) => {
    const currentIndex = photos.findIndex((p) => p.id === currentPhoto.id)
    if (currentIndex === -1) return

    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      selectPhoto(currentPhoto.id)
      return
    }

    let nextIndex: number
    switch (e.key) {
      case 'ArrowRight':
        nextIndex = Math.min(photos.length - 1, currentIndex + 1)
        break
      case 'ArrowLeft':
        nextIndex = Math.max(0, currentIndex - 1)
        break
      case 'ArrowDown':
        nextIndex = Math.min(photos.length - 1, currentIndex + columns)
        break
      case 'ArrowUp':
        nextIndex = Math.max(0, currentIndex - columns)
        break
      default:
        return
    }

    if (nextIndex !== -1 && nextIndex !== currentIndex) {
      const nextPhoto = photos[nextIndex]
      if (nextPhoto) {
        e.preventDefault()
        selectPhoto(nextPhoto.id)
        const targetEl = document.getElementById(`photo-cell-${nextPhoto.id}`)
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
  const hasAnyActiveFilter =
    ratingFilter !== 'all' ||
    flagFilter !== 'all' ||
    collectionId !== null ||
    activeMetadataFilterCount > 0 ||
    Boolean(searchQuery)

  return (
    <div className="photos-layout">
      <div className="photos-main">
        {/* Photos Toolbar */}
        <div className="photos-toolbar">
          <div className="photos-count-info">
            <h2>Photographs</h2>
            <span className="count-badge">
              {totalCount.toLocaleString()} {totalCount === 1 ? 'photo' : 'photos'}
            </span>
          </div>

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
            <button
              id="photos-toggle-metadata-filters"
              data-testid="photos-toggle-metadata-filters"
              type="button"
              className={`btn btn-sm ${showMetadataPanel || activeMetadataFilterCount > 0 ? 'btn-primary' : 'btn-secondary'}`}
              aria-expanded={showMetadataPanel}
              onClick={() => {
                setViewMode('grid')
                setShowMetadataPanel((prev) => !prev)
              }}
            >
              Metadata &amp; Filters
              {activeMetadataFilterCount > 0 ? ` (${activeMetadataFilterCount})` : ''}
            </button>
            <button
              id="photos-toggle-semantic-index"
              data-testid="photos-toggle-semantic-index"
              type="button"
              className={`btn btn-sm ${showSemanticPanel ? 'btn-primary' : 'btn-secondary'}`}
              aria-expanded={showSemanticPanel}
              onClick={() => setShowSemanticPanel((prev) => !prev)}
            >
              Semantic Index
            </button>
          </div>

          {viewMode === 'grid' && (
            <>
              {/* Natural-Language Semantic Search Bar */}
              <PhotosSearchBar
                query={searchQuery}
                isSearching={isSearching}
                modelStatus={modelStatus}
                searchResult={searchResultMeta}
                onSearch={setSearchQuery}
                onClear={clearSearch}
              />

              {/* Filter Bar */}
              <div className="photos-filter-bar" role="search" aria-label="Photo filters">
                <div className="filter-group">
                  <label htmlFor="filter-rating" className="filter-label">
                    Rating:
                  </label>
                  <select
                    id="filter-rating"
                    aria-label="Filter by Rating"
                    className="filter-select"
                    value={ratingFilter}
                    onChange={(e) => setRatingFilter(e.target.value as PhotoRatingFilter)}
                  >
                    <option value="all">All Ratings</option>
                    <option value="unrated">Unrated</option>
                    <option value="1">1+ Stars</option>
                    <option value="2">2+ Stars</option>
                    <option value="3">3+ Stars</option>
                    <option value="4">4+ Stars</option>
                    <option value="5">5 Stars</option>
                  </select>
                </div>

                <div className="filter-group">
                  <label htmlFor="filter-flag" className="filter-label">
                    Flag:
                  </label>
                  <select
                    id="filter-flag"
                    aria-label="Filter by Flag"
                    className="filter-select"
                    value={flagFilter}
                    onChange={(e) => setFlagFilter(e.target.value as PhotoFlagFilter)}
                  >
                    <option value="all">All Flags</option>
                    <option value="none">Unflagged</option>
                    <option value="pick">Pick</option>
                    <option value="reject">Reject</option>
                  </select>
                </div>

                <div className="filter-group">
                  <label htmlFor="filter-collection" className="filter-label">
                    Collection:
                  </label>
                  <select
                    id="filter-collection"
                    aria-label="Filter by Collection"
                    className="filter-select"
                    value={collectionId !== null ? String(collectionId) : ''}
                    onChange={(e) =>
                      setCollectionId(e.target.value ? Number(e.target.value) : null)
                    }
                  >
                    <option value="">All Collections</option>
                    {collections.map((col) => (
                      <option key={col.id} value={String(col.id)}>
                        {col.name} ({col.photoCount ?? 0})
                      </option>
                    ))}
                  </select>
                </div>

                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={resetFilters}
                  title="Reset all filters"
                >
                  Reset filters
                </button>
              </div>

              <div className="photos-toolbar-actions">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => void refresh()}
                  disabled={isLoading}
                  title="Refresh photograph catalog"
                >
                  <RefreshCw size={14} className={isLoading ? 'spin' : ''} />
                  <span>Refresh</span>
                </button>
              </div>
            </>
          )}
        </div>

        {showMetadataPanel && viewMode === 'grid' && (
          <PhotoMetadataFilterPanel
            progress={metadataProgress}
            isBusy={isMetadataBusy}
            actionError={metadataActionError}
            matchingCount={totalCount}
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
            onClose={() => setShowMetadataPanel(false)}
          />
        )}

        {showSemanticPanel && <SemanticIndexPanel onClose={() => setShowSemanticPanel(false)} />}

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
              <div className="notice notice-error" role="alert">
                <AlertTriangle size={16} />
                <div className="notice-content">
                  <strong>Failed to load photographs</strong>
                  <p>{error}</p>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => void refresh()}
                >
                  Retry
                </button>
              </div>
            )}

            {!isLoading && !error && totalCount === 0 && (
              <div className="notice" role="status">
                <ImageIcon size={24} />
                <div className="notice-content">
                  <strong>
                    {searchQuery
                      ? `No semantic matches found for "${searchQuery}"`
                      : hasAnyActiveFilter
                        ? 'No photographs match the current filter criteria'
                        : 'No photographs discovered yet'}
                  </strong>
                  <p>
                    {searchQuery
                      ? 'Try different search terms or click Clear search to restore ordinary browsing.'
                      : hasAnyActiveFilter
                        ? 'Try selecting different filters or click Reset filters.'
                        : 'Connect a source folder and run a scan to discover photographs.'}
                  </p>
                </div>
              </div>
            )}

            {/* Virtualized Grid Container */}
            {totalCount > 0 && (
              <div
                ref={containerRef}
                className="photos-grid-scroll-container photos-grid-container"
                onScroll={handleScroll}
                tabIndex={-1}
                role="region"
                aria-label="Photographs Grid"
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
                        thumb={thumb}
                        isSelected={isSelected}
                        similarityScore={searchScores.get(photo.id)}
                        top={top}
                        left={left}
                        cellWidth={cellWidth}
                        cellHeight={cellHeight}
                        onSelect={selectPhoto}
                        onKeyDown={handleKeyDown}
                        requestThumbnail={requestThumbnail}
                        cancelThumbnail={cancelThumbnail}
                      />
                    )
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Details Side Panel */}
      {viewMode === 'grid' && selectedPhoto && (
        <aside className="photo-details-panel" aria-label="Photograph Details">
          <div className="details-header">
            <h3>Photograph Details</h3>
            <button
              type="button"
              className="btn-icon"
              onClick={() => selectPhoto(null)}
              aria-label="Close details"
              title="Close details"
            >
              <X size={16} />
            </button>
          </div>

          <div className="details-body">
            <div className="details-preview">
              {(() => {
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
                return (
                  <div className="details-preview-placeholder">
                    <ImageIcon size={48} />
                  </div>
                )
              })()}
            </div>

            {/* Stage 5B: Review & Organize Controls */}
            <div className="details-section review-section">
              <h4>Review & Organize</h4>

              {saveStatus === 'saving' && (
                <div className="status-saving-indicator" role="status">
                  <span>Saving...</span>
                </div>
              )}

              {persistencePending && (
                <div className="notice notice-warning persistence-pending-indicator" role="status">
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

                <dt>Capture Location</dt>
                <dd>Unknown</dd>
              </dl>
            </div>

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

                      <dt>Parser Provenance</dt>
                      <dd>
                        <div className="metadata-provenance-stack">
                          <span className="sub-text">
                            Recipe: `{selectedMetadataDetail?.parserRecipeVersion ?? 'exif_tech_v1'}
                            `
                          </span>
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
                      <details className="metadata-raw-json-details">
                        <summary>Raw Embedded Tag Evidence (JSON)</summary>
                        <pre className="metadata-raw-json-pre">{meta.rawMetadataJson}</pre>
                      </details>
                    )}
                  </>
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
          </div>
        </aside>
      )}
    </div>
  )
}
