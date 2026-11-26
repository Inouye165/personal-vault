import { useState, type ReactElement } from 'react'
import {
  AlertTriangle,
  Camera,
  Play,
  Pause,
  RotateCcw,
  XCircle,
  X,
  SlidersHorizontal
} from 'lucide-react'
import type {
  CollectionItem,
  PhotoFileTypeBasis,
  PhotoFlagFilter,
  PhotoMetadataProgressResponse,
  PhotoRatingFilter,
  SavedEvent,
  SavedPlace
} from '../../../shared/validation/ipc-schemas'
import type { FacetSliceState } from '../hooks/usePhotoMetadata'
import type { PhotoMetadataFilterState } from '../hooks/usePhotos'

export interface PhotoMetadataFilterPanelProps {
  readonly progress: PhotoMetadataProgressResponse
  readonly isBusy: boolean
  readonly actionError: string | null
  readonly matchingCount: number
  readonly ratingFilter?: PhotoRatingFilter
  readonly flagFilter?: PhotoFlagFilter
  readonly collectionId?: number | null
  readonly collections?: readonly CollectionItem[]
  readonly onRatingFilterChange?: (filter: PhotoRatingFilter) => void
  readonly onFlagFilterChange?: (filter: PhotoFlagFilter) => void
  readonly onCollectionIdChange?: (collectionId: number | null) => void
  readonly metadataFilters: PhotoMetadataFilterState
  readonly cameraFacet: FacetSliceState
  readonly lensFacet: FacetSliceState
  readonly fileTypeFacet: FacetSliceState
  readonly onUpdateFilters: (patch: Partial<PhotoMetadataFilterState>) => void
  readonly onResetFilters: () => void
  readonly onCameraSearchChange: (search: string) => void
  readonly onCameraOffsetChange: (offset: number) => void
  readonly onLensSearchChange: (search: string) => void
  readonly onLensOffsetChange: (offset: number) => void
  readonly onFileTypeOffsetChange: (offset: number) => void
  readonly onStartExtraction: (retryFailed?: boolean) => Promise<void>
  readonly onPauseExtraction: () => Promise<void>
  readonly onResumeExtraction: () => Promise<void>
  readonly onCancelExtraction: () => Promise<void>
  readonly savedEvents?: readonly SavedEvent[]
  readonly savedPlaces?: readonly SavedPlace[]
  readonly onUpsertSavedEvent?: (input: {
    name: string
    dateFrom: string
    dateTo: string
  }) => Promise<unknown>
  readonly onDeleteSavedEvent?: (id: number) => Promise<void>
  readonly onUpsertSavedPlace?: (input: {
    name: string
    minLat: number
    maxLat: number
    minLon: number
    maxLon: number
  }) => Promise<unknown>
  readonly onDeleteSavedPlace?: (id: number) => Promise<void>
  readonly onClose?: () => void
}

function parseDimensionInput(raw: string): number | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const parsed = Number.parseInt(trimmed, 10)
  if (!Number.isFinite(parsed) || parsed < 1) return null
  return Math.min(100_000, parsed)
}

function parseCalendarDateInput(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null
  return trimmed
}

export function PhotoMetadataFilterPanel({
  progress,
  isBusy,
  actionError,
  matchingCount,
  ratingFilter = 'all',
  flagFilter = 'all',
  collectionId = null,
  collections = [],
  onRatingFilterChange,
  onFlagFilterChange,
  onCollectionIdChange,
  metadataFilters,
  cameraFacet,
  lensFacet,
  fileTypeFacet,
  onUpdateFilters,
  onResetFilters,
  onCameraSearchChange,
  onCameraOffsetChange,
  onLensSearchChange,
  onLensOffsetChange,
  onFileTypeOffsetChange,
  onStartExtraction,
  onPauseExtraction,
  onResumeExtraction,
  onCancelExtraction,
  savedEvents = [],
  savedPlaces = [],
  onUpsertSavedEvent,
  onDeleteSavedEvent,
  onUpsertSavedPlace,
  onDeleteSavedPlace,
  onClose
}: PhotoMetadataFilterPanelProps): ReactElement {
  const { coverage } = progress
  const unextractedTotal = coverage.unprocessedCount + coverage.staleCount
  const isRunning = progress.status === 'running'
  const isResumable = progress.status === 'paused' || progress.status === 'interrupted'

  const [newEventName, setNewEventName] = useState('')
  const [newEventFrom, setNewEventFrom] = useState('')
  const [newEventTo, setNewEventTo] = useState('')
  const [newPlaceName, setNewPlaceName] = useState('')
  const [newPlaceMinLat, setNewPlaceMinLat] = useState('')
  const [newPlaceMaxLat, setNewPlaceMaxLat] = useState('')
  const [newPlaceMinLon, setNewPlaceMinLon] = useState('')
  const [newPlaceMaxLon, setNewPlaceMaxLon] = useState('')

  const cameraHasSelectedInSlice =
    metadataFilters.cameraNormalized === null ||
    cameraFacet.items.some((i) => i.normalizedValue === metadataFilters.cameraNormalized)

  const lensHasSelectedInSlice =
    metadataFilters.lensNormalized === null ||
    lensFacet.items.some((i) => i.normalizedValue === metadataFilters.lensNormalized)

  const fileTypeHasSelectedInSlice =
    metadataFilters.fileTypeValue === null ||
    fileTypeFacet.items.some((i) => i.normalizedValue === metadataFilters.fileTypeValue)

  return (
    <section
      className="metadata-filter-panel"
      data-testid="photo-metadata-filter-panel"
      aria-label="Photo Technical Metadata Extraction and SQL Filters"
    >
      <div className="metadata-panel-header">
        <div className="metadata-panel-title-row">
          <SlidersHorizontal size={16} />
          <h3>Filters &amp; Metadata</h3>
          <span className="metadata-badge" data-testid="metadata-matching-count-badge">
            Matching: {matchingCount.toLocaleString()} {matchingCount === 1 ? 'photo' : 'photos'}
          </span>
          <span
            className={`metadata-badge metadata-status-${progress.status}`}
            data-testid="metadata-job-status-badge"
          >
            Extractor: {progress.status.toUpperCase()}
          </span>
        </div>

        <div className="metadata-header-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onResetFilters}
            data-testid="metadata-panel-reset-btn"
          >
            Reset all filters
          </button>
          {onClose && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={onClose}
              aria-label="Close Metadata and Filters Panel"
              data-testid="metadata-panel-close-btn"
            >
              <X size={14} />
              <span>Close</span>
            </button>
          )}
        </div>
      </div>

      {/* Review & Organization Filters */}
      {onRatingFilterChange && onFlagFilterChange && onCollectionIdChange && (
        <div
          className="photos-filter-bar"
          role="region"
          aria-label="Review and organization filters"
        >
          <div className="filter-group">
            <label htmlFor="filter-rating" className="filter-label">
              Rating
            </label>
            <select
              id="filter-rating"
              aria-label="Filter by Rating"
              className="filter-select"
              value={ratingFilter}
              onChange={(e) => onRatingFilterChange(e.target.value as PhotoRatingFilter)}
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
              Flag
            </label>
            <select
              id="filter-flag"
              aria-label="Filter by Flag"
              className="filter-select"
              value={flagFilter}
              onChange={(e) => onFlagFilterChange(e.target.value as PhotoFlagFilter)}
            >
              <option value="all">All Flags</option>
              <option value="none">Unflagged</option>
              <option value="pick">Pick</option>
              <option value="reject">Reject</option>
            </select>
          </div>

          <div className="filter-group">
            <label htmlFor="filter-collection" className="filter-label">
              Collection
            </label>
            <select
              id="filter-collection"
              aria-label="Filter by Collection"
              className="filter-select"
              value={collectionId !== null ? String(collectionId) : ''}
              onChange={(e) => onCollectionIdChange(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">All Collections</option>
              {collections.map((col) => (
                <option key={col.id} value={String(col.id)}>
                  {col.name} ({col.photoCount ?? 0})
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* Extraction Coverage & Controls Bar */}
      <div className="metadata-coverage-card" data-testid="metadata-coverage-card">
        <div className="metadata-coverage-summary">
          <Camera size={15} />
          <span>
            <strong>Catalog Coverage ({coverage.totalPhotos.toLocaleString()} photos):</strong>{' '}
            {coverage.extractedCount.toLocaleString()} with EXIF ·{' '}
            {coverage.noMetadataCount.toLocaleString()} no embedded EXIF ·{' '}
            {coverage.unsupportedCount.toLocaleString()} unsupported ·{' '}
            {coverage.failedCount.toLocaleString()} failed ·{' '}
            {(coverage.unavailableCount ?? 0).toLocaleString()} unavailable ·{' '}
            {coverage.unprocessedCount.toLocaleString()} unprocessed
            {coverage.staleCount > 0 ? ` · ${coverage.staleCount.toLocaleString()} stale` : ''}
          </span>
          <span className="metadata-recipe-tag">Recipe: `{coverage.parserRecipeVersion}`</span>
        </div>

        <div className="metadata-extraction-actions">
          {!isRunning && (
            <>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={isBusy}
                onClick={() => void onStartExtraction(false)}
                data-testid="metadata-start-btn"
              >
                <Play size={13} />
                <span>Extract Metadata</span>
              </button>

              {isResumable && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={isBusy}
                  onClick={() => void onResumeExtraction()}
                  data-testid="metadata-resume-btn"
                >
                  <RotateCcw size={13} />
                  <span>Resume Scope ({progress.pendingPhotos.toLocaleString()} pending)</span>
                </button>
              )}

              {coverage.failedCount > 0 && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={isBusy}
                  onClick={() => void onStartExtraction(true)}
                  data-testid="metadata-retry-failed-btn"
                >
                  <RotateCcw size={13} />
                  <span>Retry Failed ({coverage.failedCount.toLocaleString()})</span>
                </button>
              )}
            </>
          )}

          {isRunning && (
            <>
              <span className="metadata-live-progress" data-testid="metadata-live-progress">
                Processing {progress.processedPhotos.toLocaleString()} /{' '}
                {progress.totalPhotos.toLocaleString()} ({progress.reusedPhotos.toLocaleString()}{' '}
                reused · {progress.pendingPhotos.toLocaleString()} pending)
              </span>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={isBusy}
                onClick={() => void onPauseExtraction()}
                data-testid="metadata-pause-btn"
              >
                <Pause size={13} />
                <span>Pause</span>
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={isBusy}
                onClick={() => void onCancelExtraction()}
                data-testid="metadata-cancel-btn"
              >
                <XCircle size={13} />
                <span>Cancel</span>
              </button>
            </>
          )}
        </div>
      </div>

      {unextractedTotal > 0 && (
        <div
          className="metadata-incomplete-banner"
          data-testid="metadata-incomplete-coverage-banner"
        >
          <AlertTriangle size={14} />
          <span>
            <strong>
              {unextractedTotal.toLocaleString()}{' '}
              {unextractedTotal === 1 ? 'photo is' : 'photos are'} not extracted yet
            </strong>{' '}
            ({coverage.unprocessedCount.toLocaleString()} unprocessed
            {coverage.staleCount > 0 ? `, ${coverage.staleCount.toLocaleString()} stale` : ''}).
            Technical metadata filters ( including Unknown ) only match extracted records and
            exclude unprocessed photos until extraction runs.
          </span>
        </div>
      )}

      {(actionError || progress.lastError) && (
        <div className="notice notice-error" role="alert" data-testid="metadata-error-banner">
          <AlertTriangle size={15} />
          <div className="notice-content">
            {actionError && <div>{actionError}</div>}
            {progress.lastError && <div>Extractor error: {progress.lastError}</div>}
          </div>
        </div>
      )}

      {/* Compact SQL Filter Grid */}
      <div className="metadata-filters-grid">
        {/* 1. Capture Date Range */}
        <div className="metadata-filter-card">
          <div className="metadata-filter-card-title">Capture Date (Recorded Calendar Date)</div>
          <div className="metadata-inline-inputs">
            <label className="metadata-field-label">
              <span>From</span>
              <input
                type="date"
                className="metadata-input"
                aria-label="Capture date from"
                data-testid="filter-date-from"
                value={metadataFilters.captureDateFrom ?? ''}
                onChange={(e) =>
                  onUpdateFilters({ captureDateFrom: parseCalendarDateInput(e.target.value) })
                }
              />
            </label>
            <label className="metadata-field-label">
              <span>To</span>
              <input
                type="date"
                className="metadata-input"
                aria-label="Capture date to"
                data-testid="filter-date-to"
                value={metadataFilters.captureDateTo ?? ''}
                onChange={(e) =>
                  onUpdateFilters({ captureDateTo: parseCalendarDateInput(e.target.value) })
                }
              />
            </label>
          </div>
          <label className="metadata-checkbox-row">
            <input
              type="checkbox"
              data-testid="filter-include-unknown-date"
              checked={metadataFilters.includeUnknownCaptureDate}
              onChange={(e) => onUpdateFilters({ includeUnknownCaptureDate: e.target.checked })}
            />
            <span>
              {metadataFilters.captureDateFrom || metadataFilters.captureDateTo
                ? 'Also include Unknown capture date'
                : 'Only Unknown capture date (extracted)'}
            </span>
          </label>
        </div>

        {/* 2. Camera Make / Model */}
        <div className="metadata-filter-card">
          <div className="metadata-filter-card-title">Camera Make / Model</div>
          <div className="metadata-inline-inputs">
            <input
              type="search"
              className="metadata-input"
              placeholder="Search camera facets…"
              aria-label="Search camera facets"
              data-testid="filter-camera-search"
              value={cameraFacet.search}
              disabled={metadataFilters.onlyUnknownCamera}
              onChange={(e) => onCameraSearchChange(e.target.value)}
            />
            <select
              className="metadata-select"
              aria-label="Filter by Camera"
              data-testid="filter-camera-select"
              value={metadataFilters.cameraNormalized ?? ''}
              disabled={metadataFilters.onlyUnknownCamera}
              onChange={(e) =>
                onUpdateFilters({
                  cameraNormalized: e.target.value || null,
                  onlyUnknownCamera: false
                })
              }
            >
              <option value="">All Cameras</option>
              {!cameraHasSelectedInSlice && metadataFilters.cameraNormalized && (
                <option value={metadataFilters.cameraNormalized}>
                  {metadataFilters.cameraNormalized}
                </option>
              )}
              {cameraFacet.items.map((item) => (
                <option key={item.normalizedValue} value={item.normalizedValue}>
                  {item.displayLabel} ({item.count})
                </option>
              ))}
            </select>
          </div>
          <div className="metadata-facet-footer">
            <label className="metadata-checkbox-row">
              <input
                type="checkbox"
                data-testid="filter-only-unknown-camera"
                checked={metadataFilters.onlyUnknownCamera}
                onChange={(e) =>
                  onUpdateFilters({
                    onlyUnknownCamera: e.target.checked,
                    ...(e.target.checked ? { cameraNormalized: null } : {})
                  })
                }
              />
              <span>Unknown camera ({cameraFacet.unknownCount})</span>
            </label>
            {(cameraFacet.offset > 0 || cameraFacet.hasMore) && (
              <div className="metadata-facet-pager">
                <button
                  type="button"
                  className="btn btn-secondary btn-xs"
                  data-testid="filter-camera-prev"
                  disabled={cameraFacet.offset === 0}
                  onClick={() => onCameraOffsetChange(cameraFacet.offset - cameraFacet.limit)}
                >
                  Prev
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-xs"
                  data-testid="filter-camera-next"
                  disabled={!cameraFacet.hasMore}
                  onClick={() => onCameraOffsetChange(cameraFacet.offset + cameraFacet.limit)}
                >
                  More
                </button>
              </div>
            )}
          </div>
        </div>

        {/* 3. Lens Model */}
        <div className="metadata-filter-card">
          <div className="metadata-filter-card-title">Lens Model</div>
          <div className="metadata-inline-inputs">
            <input
              type="search"
              className="metadata-input"
              placeholder="Search lens facets…"
              aria-label="Search lens facets"
              data-testid="filter-lens-search"
              value={lensFacet.search}
              disabled={metadataFilters.onlyUnknownLens}
              onChange={(e) => onLensSearchChange(e.target.value)}
            />
            <select
              className="metadata-select"
              aria-label="Filter by Lens"
              data-testid="filter-lens-select"
              value={metadataFilters.lensNormalized ?? ''}
              disabled={metadataFilters.onlyUnknownLens}
              onChange={(e) =>
                onUpdateFilters({
                  lensNormalized: e.target.value || null,
                  onlyUnknownLens: false
                })
              }
            >
              <option value="">All Lenses</option>
              {!lensHasSelectedInSlice && metadataFilters.lensNormalized && (
                <option value={metadataFilters.lensNormalized}>
                  {metadataFilters.lensNormalized}
                </option>
              )}
              {lensFacet.items.map((item) => (
                <option key={item.normalizedValue} value={item.normalizedValue}>
                  {item.displayLabel} ({item.count})
                </option>
              ))}
            </select>
          </div>
          <div className="metadata-facet-footer">
            <label className="metadata-checkbox-row">
              <input
                type="checkbox"
                data-testid="filter-only-unknown-lens"
                checked={metadataFilters.onlyUnknownLens}
                onChange={(e) =>
                  onUpdateFilters({
                    onlyUnknownLens: e.target.checked,
                    ...(e.target.checked ? { lensNormalized: null } : {})
                  })
                }
              />
              <span>Unknown lens ({lensFacet.unknownCount})</span>
            </label>
            {(lensFacet.offset > 0 || lensFacet.hasMore) && (
              <div className="metadata-facet-pager">
                <button
                  type="button"
                  className="btn btn-secondary btn-xs"
                  data-testid="filter-lens-prev"
                  disabled={lensFacet.offset === 0}
                  onClick={() => onLensOffsetChange(lensFacet.offset - lensFacet.limit)}
                >
                  Prev
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-xs"
                  data-testid="filter-lens-next"
                  disabled={!lensFacet.hasMore}
                  onClick={() => onLensOffsetChange(lensFacet.offset + lensFacet.limit)}
                >
                  More
                </button>
              </div>
            )}
          </div>
        </div>

        {/* 4. Minimum Orientation-Adjusted Display Dimensions */}
        <div className="metadata-filter-card">
          <div className="metadata-filter-card-title">
            Minimum Display Resolution (Orientation-Adjusted)
          </div>
          <div className="metadata-inline-inputs">
            <label className="metadata-field-label">
              <span>Min W (px)</span>
              <input
                type="number"
                min={1}
                max={100000}
                className="metadata-input"
                placeholder="e.g. 1920"
                aria-label="Minimum display width in pixels"
                data-testid="filter-min-width"
                value={
                  metadataFilters.minWidthPx !== null ? String(metadataFilters.minWidthPx) : ''
                }
                onChange={(e) =>
                  onUpdateFilters({ minWidthPx: parseDimensionInput(e.target.value) })
                }
              />
            </label>
            <label className="metadata-field-label">
              <span>Min H (px)</span>
              <input
                type="number"
                min={1}
                max={100000}
                className="metadata-input"
                placeholder="e.g. 1080"
                aria-label="Minimum display height in pixels"
                data-testid="filter-min-height"
                value={
                  metadataFilters.minHeightPx !== null ? String(metadataFilters.minHeightPx) : ''
                }
                onChange={(e) =>
                  onUpdateFilters({ minHeightPx: parseDimensionInput(e.target.value) })
                }
              />
            </label>
          </div>
          <label className="metadata-checkbox-row">
            <input
              type="checkbox"
              data-testid="filter-include-unknown-dimensions"
              checked={metadataFilters.includeUnknownDimensions}
              onChange={(e) => onUpdateFilters({ includeUnknownDimensions: e.target.checked })}
            />
            <span>
              {metadataFilters.minWidthPx !== null || metadataFilters.minHeightPx !== null
                ? 'Also include Unknown dimensions'
                : 'Only Unknown dimensions (extracted)'}
            </span>
          </label>
        </div>

        {/* 5. File Type (Detected Container vs Recorded Filename Extension) */}
        <div className="metadata-filter-card">
          <div className="metadata-filter-card-title">File Type (Explicit Basis)</div>
          <div className="metadata-inline-inputs">
            <select
              className="metadata-select"
              aria-label="File type filter basis"
              data-testid="filter-filetype-basis"
              value={metadataFilters.fileTypeBasis}
              onChange={(e) =>
                onUpdateFilters({
                  fileTypeBasis: e.target.value as PhotoFileTypeBasis,
                  fileTypeValue: null,
                  onlyUnknownDetectedFormat: false
                })
              }
            >
              <option value="detected_format">Detected container format (header)</option>
              <option value="filename_extension">Recorded filename extension</option>
            </select>

            <select
              className="metadata-select"
              aria-label="Filter by File Type"
              data-testid="filter-filetype-value"
              value={metadataFilters.fileTypeValue ?? ''}
              disabled={
                metadataFilters.fileTypeBasis === 'detected_format' &&
                metadataFilters.onlyUnknownDetectedFormat
              }
              onChange={(e) =>
                onUpdateFilters({
                  fileTypeValue: e.target.value || null,
                  onlyUnknownDetectedFormat: false
                })
              }
            >
              <option value="">
                {metadataFilters.fileTypeBasis === 'detected_format'
                  ? 'All Detected Formats'
                  : 'All Filename Extensions'}
              </option>
              {!fileTypeHasSelectedInSlice && metadataFilters.fileTypeValue && (
                <option value={metadataFilters.fileTypeValue}>
                  {metadataFilters.fileTypeValue}
                </option>
              )}
              {fileTypeFacet.items.map((item) => (
                <option key={item.normalizedValue} value={item.normalizedValue}>
                  {item.displayLabel} ({item.count})
                </option>
              ))}
            </select>
          </div>

          <div className="metadata-facet-footer">
            {metadataFilters.fileTypeBasis === 'detected_format' ? (
              <label className="metadata-checkbox-row">
                <input
                  type="checkbox"
                  data-testid="filter-only-unknown-detected-format"
                  checked={metadataFilters.onlyUnknownDetectedFormat}
                  onChange={(e) =>
                    onUpdateFilters({
                      onlyUnknownDetectedFormat: e.target.checked,
                      ...(e.target.checked ? { fileTypeValue: null } : {})
                    })
                  }
                />
                <span>Unknown container format ({fileTypeFacet.unknownCount})</span>
              </label>
            ) : (
              <span className="metadata-basis-hint">
                Matches recorded filename suffix only; does not verify container bytes.
              </span>
            )}
            {(fileTypeFacet.offset > 0 || fileTypeFacet.hasMore) && (
              <div className="metadata-facet-pager">
                <button
                  type="button"
                  className="btn btn-secondary btn-xs"
                  disabled={fileTypeFacet.offset === 0}
                  onClick={() => onFileTypeOffsetChange(fileTypeFacet.offset - fileTypeFacet.limit)}
                >
                  Prev
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-xs"
                  disabled={!fileTypeFacet.hasMore}
                  onClick={() => onFileTypeOffsetChange(fileTypeFacet.offset + fileTypeFacet.limit)}
                >
                  More
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {(onUpsertSavedEvent || onUpsertSavedPlace) && (
        <div className="metadata-user-definitions" data-testid="metadata-user-definitions">
          {onUpsertSavedEvent && (
            <div className="metadata-filter-card">
              <h5>Saved Events (Offline Date Ranges)</h5>
              {savedEvents.length > 0 && (
                <ul className="metadata-saved-list">
                  {savedEvents.map((ev) => (
                    <li key={ev.id} className="metadata-saved-item">
                      <span>
                        <strong>{ev.name}</strong> ({ev.dateFrom} – {ev.dateTo})
                      </span>
                      {onDeleteSavedEvent && (
                        <button
                          type="button"
                          className="btn btn-secondary btn-xs"
                          onClick={() => void onDeleteSavedEvent(ev.id)}
                          aria-label={`Delete event ${ev.name}`}
                        >
                          Remove
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <div className="metadata-inline-create-row">
                <input
                  type="text"
                  placeholder="Event name"
                  aria-label="New saved event name"
                  value={newEventName}
                  onChange={(e) => setNewEventName(e.target.value)}
                />
                <input
                  type="date"
                  aria-label="New saved event start date"
                  value={newEventFrom}
                  onChange={(e) => setNewEventFrom(e.target.value)}
                />
                <input
                  type="date"
                  aria-label="New saved event end date"
                  value={newEventTo}
                  onChange={(e) => setNewEventTo(e.target.value)}
                />
                <button
                  type="button"
                  className="btn btn-secondary btn-xs"
                  disabled={
                    !newEventName.trim() ||
                    !newEventFrom ||
                    !newEventTo ||
                    newEventFrom > newEventTo
                  }
                  onClick={() => {
                    void onUpsertSavedEvent({
                      name: newEventName.trim(),
                      dateFrom: newEventFrom,
                      dateTo: newEventTo
                    })
                    setNewEventName('')
                    setNewEventFrom('')
                    setNewEventTo('')
                  }}
                >
                  Add Event
                </button>
              </div>
            </div>
          )}

          {onUpsertSavedPlace && (
            <div className="metadata-filter-card">
              <h5>Saved Places (Offline Bounds)</h5>
              {savedPlaces.length > 0 && (
                <ul className="metadata-saved-list">
                  {savedPlaces.map((pl) => (
                    <li key={pl.id} className="metadata-saved-item">
                      <span>
                        <strong>{pl.name}</strong> ({pl.minLat.toFixed(2)}..{pl.maxLat.toFixed(2)},{' '}
                        {pl.minLon.toFixed(2)}..{pl.maxLon.toFixed(2)})
                      </span>
                      {onDeleteSavedPlace && (
                        <button
                          type="button"
                          className="btn btn-secondary btn-xs"
                          onClick={() => void onDeleteSavedPlace(pl.id)}
                          aria-label={`Delete place ${pl.name}`}
                        >
                          Remove
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <div className="metadata-inline-create-row">
                <input
                  type="text"
                  placeholder="Place name"
                  aria-label="New saved place name"
                  value={newPlaceName}
                  onChange={(e) => setNewPlaceName(e.target.value)}
                />
                <input
                  type="number"
                  step="0.001"
                  placeholder="Min lat"
                  aria-label="New saved place min latitude"
                  value={newPlaceMinLat}
                  onChange={(e) => setNewPlaceMinLat(e.target.value)}
                />
                <input
                  type="number"
                  step="0.001"
                  placeholder="Max lat"
                  aria-label="New saved place max latitude"
                  value={newPlaceMaxLat}
                  onChange={(e) => setNewPlaceMaxLat(e.target.value)}
                />
                <input
                  type="number"
                  step="0.001"
                  placeholder="Min lon"
                  aria-label="New saved place min longitude"
                  value={newPlaceMinLon}
                  onChange={(e) => setNewPlaceMinLon(e.target.value)}
                />
                <input
                  type="number"
                  step="0.001"
                  placeholder="Max lon"
                  aria-label="New saved place max longitude"
                  value={newPlaceMaxLon}
                  onChange={(e) => setNewPlaceMaxLon(e.target.value)}
                />
                <button
                  type="button"
                  className="btn btn-secondary btn-xs"
                  onClick={() => {
                    const minLat = Number(newPlaceMinLat)
                    const maxLat = Number(newPlaceMaxLat)
                    const minLon = Number(newPlaceMinLon)
                    const maxLon = Number(newPlaceMaxLon)
                    if (
                      newPlaceName.trim() &&
                      Number.isFinite(minLat) &&
                      Number.isFinite(maxLat) &&
                      Number.isFinite(minLon) &&
                      Number.isFinite(maxLon) &&
                      minLat <= maxLat
                    ) {
                      void onUpsertSavedPlace({
                        name: newPlaceName.trim(),
                        minLat,
                        maxLat,
                        minLon,
                        maxLon
                      })
                      setNewPlaceName('')
                      setNewPlaceMinLat('')
                      setNewPlaceMaxLat('')
                      setNewPlaceMinLon('')
                      setNewPlaceMaxLon('')
                    }
                  }}
                >
                  Add Place
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
