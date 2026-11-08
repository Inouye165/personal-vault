/**
 * Personal Vault — Virtualized Photo Browsing Panel (Stage 5A)
 */

import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import {
  RefreshCw,
  Image as ImageIcon,
  AlertTriangle,
  FileQuestion,
  X,
  FileImage
} from 'lucide-react'
import { usePhotos, PHOTO_BOUNDS } from '../hooks/usePhotos'
import type { PhotoItem } from '../../../shared/validation/ipc-schemas'

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
    loadMore,
    requestThumbnail
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

    // Trigger loadMore near bottom
    if (target.scrollHeight - target.scrollTop - target.clientHeight < 300) {
      void loadMore()
    }
  }

  // Virtualization calculations
  const cellWidth = 180
  const cellHeight = 200
  const gap = 16
  const columns = Math.max(1, Math.floor((containerWidth + gap) / (cellWidth + gap)))
  const totalRows = Math.ceil(photos.length / columns)
  const rowHeight = cellHeight + gap

  // Bounded visible window with overscan (max 200 cells)
  const startRow = Math.max(0, Math.floor(scrollTop / rowHeight) - 2)
  const visibleRowCount = Math.ceil(containerHeight / rowHeight) + 4
  const endRow = Math.min(totalRows, startRow + visibleRowCount)

  const startIndex = startRow * columns
  const rawEndIndex = endRow * columns
  // Bound mounted cells to at most 200
  const endIndex = Math.min(
    photos.length,
    Math.min(rawEndIndex, startIndex + PHOTO_BOUNDS.MAX_MOUNTED_CELLS)
  )
  const visiblePhotos = photos.slice(startIndex, endIndex)

  // Request thumbnails for visible cells
  useEffect(() => {
    for (const photo of visiblePhotos) {
      requestThumbnail(photo, 'high')
    }
  }, [visiblePhotos, requestThumbnail])

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
        // Focus target cell if DOM element exists
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
        {isLoading && photos.length === 0 && (
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

        {!isLoading && !error && photos.length === 0 && (
          <div className="notice" role="status">
            <ImageIcon size={24} />
            <div className="notice-content">
              <strong>No photographs discovered yet</strong>
              <p>Connect a source folder and run a scan to discover photographs.</p>
            </div>
          </div>
        )}

        {/* Virtualized Grid Container */}
        {photos.length > 0 && (
          <div
            ref={containerRef}
            className="photos-grid-scroll-container"
            onScroll={handleScroll}
            tabIndex={-1}
            role="region"
            aria-label="Photographs Grid"
          >
            <div
              className="photos-virtual-height-holder"
              style={{
                height: `${totalRows * rowHeight}px`,
                position: 'relative'
              }}
            >
              <div
                className="photos-grid"
                style={{
                  transform: `translateY(${startRow * rowHeight}px)`,
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  display: 'grid',
                  gridTemplateColumns: `repeat(${columns}, ${cellWidth}px)`,
                  gap: `${gap}px`
                }}
              >
                {visiblePhotos.map((photo) => {
                  const thumb = thumbnails.get(photo.id)
                  const isSelected = selectedId === photo.id

                  return (
                    <div
                      key={photo.id}
                      id={`photo-cell-${photo.id}`}
                      className={`photo-card ${isSelected ? 'selected' : ''}`}
                      role="button"
                      tabIndex={0}
                      aria-label={`${photo.fileName}, ${formatBytes(photo.byteSize)}`}
                      aria-pressed={isSelected}
                      onClick={() => selectPhoto(photo.id)}
                      onKeyDown={(e) => handleKeyDown(e, photo)}
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
                })}
              </div>
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
