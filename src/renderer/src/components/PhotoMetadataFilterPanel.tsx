import { type ReactElement } from 'react'
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
  PhotoFileTypeBasis,
  PhotoMetadataProgressResponse
} from '../../../shared/validation/ipc-schemas'
import type { FacetSliceState } from '../hooks/usePhotoMetadata'
import type { PhotoMetadataFilterState } from '../hooks/usePhotos'

export interface PhotoMetadataFilterPanelProps {
  readonly progress: PhotoMetadataProgressResponse
  readonly isBusy: boolean
  readonly actionError: string | null
  readonly matchingCount: number
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
  onClose
}: PhotoMetadataFilterPanelProps): ReactElement {
  const { coverage } = progress
  const unextractedTotal = coverage.unprocessedCount + coverage.staleCount
  const isRunning = progress.status === 'running'
  const isResumable = progress.status === 'paused' || progress.status === 'interrupted'

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
          <h3>Photo Metadata &amp; SQL Filters</h3>
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
    </section>
  )
}
