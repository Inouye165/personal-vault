/**
 * Personal Vault — Virtualized Photo Browsing Panel (Stage 5A)
 *
 * Implements bounded, virtualized grid rendering with absolute catalog
 * positions, full collection scroll extent, keyboard navigation,
 * thumbnail decoding with honest placeholders, and factual details panel.
 */

import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import {
  RefreshCw,
  Image as ImageIcon,
  AlertTriangle,
  FileQuestion,
  X,
  FileImage
} from 'lucide-react'
import { usePhotos, PHOTO_BOUNDS } from '../hooks/usePhotos'
import type { PhotoItem, ThumbnailResult } from '../../../shared/validation/ipc-schemas'

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

interface PhotoCardCellProps {
  photo: PhotoItem
  thumb?: ThumbnailResult
  isSelected: boolean
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
      aria-label={`${photo.fileName}, ${formatBytes(photo.byteSize)}`}
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
    requestThumbnail,
    cancelThumbnail
  } = usePhotos()

  const containerRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [containerHeight, setContainerHeight] = useState(600)
  const [containerWidth, setContainerWidth] = useState(800)

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
    setScrollTop(target.scrollTop)
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
        </div>

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
              <strong>No photographs discovered yet</strong>
              <p>Connect a source folder and run a scan to discover photographs.</p>
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
      </div>

      {/* Details Side Panel */}
      {selectedPhoto && (
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

            <div className="details-section">
              <h4>File Facts</h4>
              <dl className="details-list">
                <dt>File Name</dt>
                <dd title={selectedPhoto.fileName}>{selectedPhoto.fileName}</dd>

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
                <dd>{formatDate(selectedPhoto.inferredCaptureTimeMs)}</dd>

                <dt>Capture Location</dt>
                <dd>Unknown</dd>
              </dl>
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
