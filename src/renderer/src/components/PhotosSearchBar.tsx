/**
 * Personal Vault — Photos Natural-Language & Metadata-Aware Search Bar
 *
 * Keeps metadata search (place, date, recurring month/day, saved events, camera)
 * immediately usable without requiring the offline visual model, shows editable
 * interpreted filters, renders offline clarifications, and preserves PR #4's
 * first-run visual-search onboarding controls.
 */

import { useState, type FormEvent, type ReactElement } from 'react'
import {
  Search,
  X,
  Loader2,
  AlertCircle,
  Info,
  Sparkles,
  CheckCircle2,
  MapPin,
  Calendar,
  Camera
} from 'lucide-react'
import type {
  InterpretedSearchFilters,
  SearchClarificationOption,
  SearchClarificationPrompt,
  SemanticIndexJobStatus,
  SemanticModelProvisionState
} from '../../../shared/validation/ipc-schemas'

export interface PhotosSearchBarResultMeta {
  readonly totalMatched: number
  readonly eligibleCount: number
  readonly unindexedCount: number
  readonly staleCount: number
  readonly corruptCount?: number
  readonly truncated: boolean
  readonly tokenCount: number
  readonly queryLatencyMs: number
}

export type PhotosSearchModelStatus = SemanticModelProvisionState | 'unprovisioned' | 'corrupt'

function formatCompactSearchTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 100) {
    return '<0.1s'
  }
  return `${(ms / 1000).toFixed(1)}s`
}

export interface PhotosSearchBarProps {
  readonly query: string
  readonly isSearching: boolean
  readonly modelStatus: PhotosSearchModelStatus
  readonly searchMode?: 'metadata_only' | 'hybrid' | 'visual_only' | 'needs_clarification' | null
  readonly searchResult?: PhotosSearchBarResultMeta | null
  readonly interpretedFilters?: InterpretedSearchFilters | null
  readonly clarification?: SearchClarificationPrompt | null
  readonly visualModelRequired?: boolean
  readonly filteredCandidateCount?: number
  readonly onSearch: (query: string) => void
  readonly onClear: () => void
  readonly onUpdateInterpretedFilters?: (next: InterpretedSearchFilters) => void
  readonly onClearInterpretedFilter?: (field: 'place' | 'date' | 'camera' | 'visualTerms') => void
  readonly onBypassVisualModel?: () => void
  readonly onSaveEventAndSearch?: (input: {
    name: string
    dateFrom: string
    dateTo: string
  }) => Promise<void> | void
  readonly onSelectDisambiguatedPlace?: (option: SearchClarificationOption) => void
  readonly onSaveCustomPlaceAndSearch?: (input: {
    name: string
    minLat: number
    maxLat: number
    minLon: number
    maxLon: number
  }) => Promise<void> | void
  readonly disabled?: boolean
  readonly modelDownloadProgress?: {
    readonly downloadedBytes: number
    readonly requiredBytes: number
    readonly currentArtifact: string | null
  } | null
  readonly indexingProgress?: {
    readonly status: SemanticIndexJobStatus
    readonly processedPhotos: number
    readonly totalPhotos: number
    readonly currentIndexedPhotos: number
    readonly totalCatalogPhotos: number
  } | null
  readonly setupError?: string | null
  readonly searchReadyAnnouncement?: {
    readonly indexedCount: number
    readonly totalCount: number
  } | null
  readonly onEnablePhotoSearch?: () => Promise<void> | void
  readonly onCancelEnablePhotoSearch?: () => Promise<void> | void
  readonly onRetryIndexing?: () => Promise<void> | void
  readonly onDismissSearchReady?: () => void
}

function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

export function PhotosSearchBar({
  query,
  isSearching,
  modelStatus,
  searchMode = null,
  searchResult,
  interpretedFilters = null,
  clarification = null,
  visualModelRequired = false,
  filteredCandidateCount = 0,
  onSearch,
  onClear,
  onUpdateInterpretedFilters,
  onClearInterpretedFilter,
  onBypassVisualModel,
  onSaveEventAndSearch,
  onSelectDisambiguatedPlace,
  onSaveCustomPlaceAndSearch,
  disabled = false,
  modelDownloadProgress = null,
  indexingProgress = null,
  setupError = null,
  searchReadyAnnouncement = null,
  onEnablePhotoSearch,
  onCancelEnablePhotoSearch,
  onRetryIndexing,
  onDismissSearchReady
}: PhotosSearchBarProps): ReactElement {
  const [inputValue, setInputValue] = useState(query)
  const [prevQuery, setPrevQuery] = useState(query)

  const [editingDateChip, setEditingDateChip] = useState(false)
  const [dateFromDraft, setDateFromDraft] = useState('')
  const [dateToDraft, setDateToDraft] = useState('')

  const [editingVisualChip, setEditingVisualChip] = useState(false)
  const [visualTermsDraft, setVisualTermsDraft] = useState('')

  const [eventNameDraft, setEventNameDraft] = useState('')
  const [eventFromDraft, setEventFromDraft] = useState('')
  const [eventToDraft, setEventToDraft] = useState('')
  const [prevClarificationTerm, setPrevClarificationTerm] = useState<string | null>(null)

  const [placeNameDraft, setPlaceNameDraft] = useState('')
  const [minLatDraft, setMinLatDraft] = useState('44.131')
  const [maxLatDraft, setMaxLatDraft] = useState('45.111')
  const [minLonDraft, setMinLonDraft] = useState('-111.156')
  const [maxLonDraft, setMaxLonDraft] = useState('-109.825')

  if (query !== prevQuery) {
    setPrevQuery(query)
    setInputValue(query)
    setEditingDateChip(false)
    setEditingVisualChip(false)
  }

  const clarificationKey = clarification ? `${clarification.kind}:${clarification.term}` : null
  if (clarificationKey !== prevClarificationTerm) {
    setPrevClarificationTerm(clarificationKey)
    if (clarification?.kind === 'define_event') {
      setEventNameDraft(clarification.term)
    } else if (clarification?.kind === 'define_place') {
      setPlaceNameDraft(clarification.term)
    }
  }

  const handleSubmit = (e: FormEvent): void => {
    e.preventDefault()
    const trimmed = inputValue.trim()
    if (trimmed) {
      onSearch(trimmed)
    }
  }

  const handleClear = (): void => {
    setInputValue('')
    setEditingDateChip(false)
    setEditingVisualChip(false)
    onClear()
  }

  const isModelReady = modelStatus === 'ready'
  const isModelCorrupt = modelStatus === 'corrupt'
  const isModelError = modelStatus === 'error'
  const isModelDownloading = modelStatus === 'installing'
  const hasSetupFailure =
    !isModelReady && !isModelDownloading && (isModelError || isModelCorrupt || Boolean(setupError))
  const isIndexingActive =
    indexingProgress?.status === 'running' || indexingProgress?.status === 'paused'
  const isIndexingFailed = isModelReady && indexingProgress?.status === 'failed'

  const downloadPct =
    modelDownloadProgress && modelDownloadProgress.requiredBytes > 0
      ? Math.min(
          100,
          Math.round(
            (modelDownloadProgress.downloadedBytes / modelDownloadProgress.requiredBytes) * 100
          )
        )
      : 0

  const indexingPct =
    indexingProgress && indexingProgress.totalPhotos > 0
      ? Math.min(
          100,
          Math.round((indexingProgress.processedPhotos / indexingProgress.totalPhotos) * 100)
        )
      : 0

  const hasAnyInterpretedChip = Boolean(
    interpretedFilters &&
    (interpretedFilters.place ||
      interpretedFilters.date ||
      interpretedFilters.camera ||
      interpretedFilters.visualTerms)
  )

  return (
    <div className="photos-search-bar-container" data-testid="photos-search-bar">
      <form onSubmit={handleSubmit} className="photos-search-form" role="search">
        <div className="photos-search-input-wrapper">
          <Search size={16} className="search-icon" aria-hidden="true" />
          <input
            type="text"
            className="photos-search-input"
            placeholder="Search photos by description, place, date, event, or camera..."
            aria-label="Search photos by description, place, date, or camera"
            value={inputValue}
            maxLength={500}
            disabled={disabled || isSearching}
            onChange={(e) => setInputValue(e.target.value)}
          />
          {isSearching && (
            <Loader2 size={16} className="search-loading-icon spin" aria-label="Searching..." />
          )}
          {(inputValue.length > 0 ||
            query.length > 0 ||
            Boolean(searchResult) ||
            hasAnyInterpretedChip ||
            Boolean(clarification)) &&
            !isSearching && (
              <button
                type="button"
                className="photos-search-clear-btn"
                onClick={handleClear}
                aria-label="Clear search"
                title="Clear search and restore ordinary browsing"
              >
                <X size={16} aria-hidden="true" />
              </button>
            )}
        </div>
        <button
          type="submit"
          className="btn btn-primary btn-sm photos-search-submit-btn"
          disabled={disabled || isSearching || !inputValue.trim()}
          aria-label="Search"
        >
          <span>Search</span>
        </button>
      </form>

      {hasAnyInterpretedChip && interpretedFilters && (
        <div
          className="interpreted-filters-bar"
          role="region"
          aria-label="Interpreted search filters"
          data-testid="interpreted-filters-bar"
        >
          {interpretedFilters.place && (
            <div className="interpreted-filter-chip" data-testid="filter-chip-place">
              <MapPin size={12} aria-hidden="true" />
              <span>
                Place: <strong>{interpretedFilters.place.label}</strong>
              </span>
              <span className="interpreted-chip-source">
                {interpretedFilters.place.source === 'saved_place' ? 'Saved' : 'Offline area'}
              </span>
              {onClearInterpretedFilter && (
                <button
                  type="button"
                  className="interpreted-chip-remove"
                  aria-label="Remove place filter"
                  onClick={() => onClearInterpretedFilter('place')}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              )}
            </div>
          )}

          {interpretedFilters.date && (
            <div className="interpreted-filter-chip" data-testid="filter-chip-date">
              <Calendar size={12} aria-hidden="true" />
              {editingDateChip && onUpdateInterpretedFilters ? (
                <span className="interpreted-chip-editor">
                  <input
                    type="date"
                    aria-label="Edit interpreted date from"
                    value={dateFromDraft}
                    onChange={(e) => setDateFromDraft(e.target.value)}
                  />
                  <span>to</span>
                  <input
                    type="date"
                    aria-label="Edit interpreted date to"
                    value={dateToDraft}
                    onChange={(e) => setDateToDraft(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn btn-primary btn-xs"
                    disabled={!dateFromDraft || !dateToDraft}
                    onClick={() => {
                      const from = dateFromDraft <= dateToDraft ? dateFromDraft : dateToDraft
                      const to = dateFromDraft <= dateToDraft ? dateToDraft : dateFromDraft
                      onUpdateInterpretedFilters({
                        ...interpretedFilters,
                        date: {
                          mode: 'range',
                          label: `${from} to ${to}`,
                          captureDateFrom: from,
                          captureDateTo: to
                        }
                      })
                      setEditingDateChip(false)
                    }}
                  >
                    Apply
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="interpreted-chip-edit-trigger"
                  onClick={() => {
                    setDateFromDraft(interpretedFilters.date?.captureDateFrom ?? '2025-01-01')
                    setDateToDraft(interpretedFilters.date?.captureDateTo ?? '2025-12-31')
                    setEditingDateChip(true)
                  }}
                  title="Edit date filter"
                >
                  Date: <strong>{interpretedFilters.date.label}</strong>
                </button>
              )}
              {onClearInterpretedFilter && (
                <button
                  type="button"
                  className="interpreted-chip-remove"
                  aria-label="Remove date filter"
                  onClick={() => onClearInterpretedFilter('date')}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              )}
            </div>
          )}

          {interpretedFilters.camera && (
            <div className="interpreted-filter-chip" data-testid="filter-chip-camera">
              <Camera size={12} aria-hidden="true" />
              <span>
                Camera: <strong>{interpretedFilters.camera.label}</strong>
              </span>
              {onClearInterpretedFilter && (
                <button
                  type="button"
                  className="interpreted-chip-remove"
                  aria-label="Remove camera filter"
                  onClick={() => onClearInterpretedFilter('camera')}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              )}
            </div>
          )}

          {interpretedFilters.visualTerms && (
            <div className="interpreted-filter-chip" data-testid="filter-chip-visual">
              <Sparkles size={12} aria-hidden="true" />
              {editingVisualChip && onUpdateInterpretedFilters ? (
                <span className="interpreted-chip-editor">
                  <input
                    type="text"
                    aria-label="Edit visual search terms"
                    value={visualTermsDraft}
                    onChange={(e) => setVisualTermsDraft(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn btn-primary btn-xs"
                    disabled={!visualTermsDraft.trim()}
                    onClick={() => {
                      onUpdateInterpretedFilters({
                        ...interpretedFilters,
                        visualTerms: visualTermsDraft.trim()
                      })
                      setEditingVisualChip(false)
                    }}
                  >
                    Apply
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="interpreted-chip-edit-trigger"
                  onClick={() => {
                    setVisualTermsDraft(interpretedFilters.visualTerms ?? '')
                    setEditingVisualChip(true)
                  }}
                  title="Edit visual terms"
                >
                  Visual: <strong>{interpretedFilters.visualTerms}</strong>
                </button>
              )}
              {onClearInterpretedFilter && (
                <button
                  type="button"
                  className="interpreted-chip-remove"
                  aria-label="Remove visual filter"
                  onClick={() => onClearInterpretedFilter('visualTerms')}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {clarification && (
        <div
          className="search-clarification-card"
          role="region"
          aria-label="Search clarification needed"
          data-testid="search-clarification-card"
        >
          <p className="search-clarification-message">{clarification.message}</p>

          {clarification.kind === 'define_event' && onSaveEventAndSearch && (
            <div className="search-clarification-form">
              <input
                type="text"
                aria-label="Event name"
                value={eventNameDraft}
                onChange={(e) => setEventNameDraft(e.target.value)}
              />
              <input
                type="date"
                aria-label="Event start date"
                value={eventFromDraft}
                onChange={(e) => setEventFromDraft(e.target.value)}
              />
              <input
                type="date"
                aria-label="Event end date"
                value={eventToDraft}
                onChange={(e) => setEventToDraft(e.target.value)}
              />
              <button
                type="button"
                className="btn btn-primary btn-sm"
                data-testid="save-clarified-event-btn"
                disabled={
                  !eventNameDraft.trim() ||
                  !eventFromDraft ||
                  !eventToDraft ||
                  eventFromDraft > eventToDraft
                }
                onClick={() =>
                  void onSaveEventAndSearch({
                    name: eventNameDraft.trim(),
                    dateFrom: eventFromDraft,
                    dateTo: eventToDraft
                  })
                }
              >
                Save event &amp; search
              </button>
            </div>
          )}

          {clarification.kind === 'disambiguate_place' && onSelectDisambiguatedPlace && (
            <div className="search-clarification-options">
              {clarification.options.map((opt) => (
                <button
                  key={opt.placeId}
                  type="button"
                  className="btn btn-secondary btn-sm"
                  data-testid={`disambiguate-place-${opt.placeId}`}
                  onClick={() => onSelectDisambiguatedPlace(opt)}
                >
                  <strong>{opt.label}</strong> ({opt.regionHint})
                </button>
              ))}
            </div>
          )}

          {clarification.kind === 'define_place' && onSaveCustomPlaceAndSearch && (
            <div className="search-clarification-form">
              <input
                type="text"
                aria-label="Custom place name"
                value={placeNameDraft}
                onChange={(e) => setPlaceNameDraft(e.target.value)}
              />
              <input
                type="number"
                step="0.001"
                aria-label="Minimum latitude"
                value={minLatDraft}
                onChange={(e) => setMinLatDraft(e.target.value)}
              />
              <input
                type="number"
                step="0.001"
                aria-label="Maximum latitude"
                value={maxLatDraft}
                onChange={(e) => setMaxLatDraft(e.target.value)}
              />
              <input
                type="number"
                step="0.001"
                aria-label="Minimum longitude"
                value={minLonDraft}
                onChange={(e) => setMinLonDraft(e.target.value)}
              />
              <input
                type="number"
                step="0.001"
                aria-label="Maximum longitude"
                value={maxLonDraft}
                onChange={(e) => setMaxLonDraft(e.target.value)}
              />
              <button
                type="button"
                className="btn btn-primary btn-sm"
                data-testid="save-clarified-place-btn"
                onClick={() => {
                  const minLat = Number(minLatDraft)
                  const maxLat = Number(maxLatDraft)
                  const minLon = Number(minLonDraft)
                  const maxLon = Number(maxLonDraft)
                  if (
                    placeNameDraft.trim() &&
                    Number.isFinite(minLat) &&
                    Number.isFinite(maxLat) &&
                    Number.isFinite(minLon) &&
                    Number.isFinite(maxLon) &&
                    minLat <= maxLat
                  ) {
                    void onSaveCustomPlaceAndSearch({
                      name: placeNameDraft.trim(),
                      minLat,
                      maxLat,
                      minLon,
                      maxLon
                    })
                  }
                }}
              >
                Save place &amp; search
              </button>
            </div>
          )}
        </div>
      )}

      {visualModelRequired && (
        <div
          className="search-clarification-card"
          role="status"
          data-testid="visual-model-required-notice"
        >
          <p className="search-clarification-message">
            Found <strong>{filteredCandidateCount}</strong> matching photo
            {filteredCandidateCount === 1 ? '' : 's'} by location/date metadata. Visual ranking for
            &ldquo;{interpretedFilters?.visualTerms}&rdquo; needs the offline visual search model.
          </p>
          <div className="search-clarification-options">
            {onEnablePhotoSearch && (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => void onEnablePhotoSearch()}
              >
                Turn on visual search
              </button>
            )}
            {onBypassVisualModel && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                data-testid="bypass-visual-model-btn"
                onClick={onBypassVisualModel}
              >
                Show {filteredCandidateCount} matches without visual ranking
              </button>
            )}
          </div>
        </div>
      )}

      {!isModelReady && !isModelDownloading && !hasSetupFailure && (
        <div
          className="search-onboarding-card"
          role="region"
          aria-label="Turn on photo search"
          data-testid="turn-on-photo-search-panel"
        >
          <div className="search-onboarding-header">
            <Sparkles size={16} aria-hidden="true" />
            <strong>Turn on photo search</strong>
          </div>
          <p className="search-onboarding-copy">
            Find photos by describing what&apos;s in them, such as &ldquo;sunset over ocean&rdquo;.
            Place, date, event, and camera searches already work offline above. Turning on visual
            search starts a one-time ~149 MiB download so visual ranking works privately on this
            device.
          </p>
          {onEnablePhotoSearch && (
            <div className="search-onboarding-actions">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                data-testid="turn-on-photo-search-btn"
                onClick={() => void onEnablePhotoSearch()}
              >
                Download &amp; turn on (~149 MiB)
              </button>
            </div>
          )}
        </div>
      )}

      {isModelDownloading && (
        <div
          className="search-onboarding-progress"
          role="status"
          data-testid="photo-search-download-progress"
        >
          <div className="search-onboarding-progress-header">
            <div className="search-onboarding-status-stack">
              <strong>Turning on photo search</strong>
              <span>
                Downloading search support…{' '}
                {modelDownloadProgress && modelDownloadProgress.requiredBytes > 0
                  ? `${formatMiB(modelDownloadProgress.downloadedBytes)} / ${formatMiB(modelDownloadProgress.requiredBytes)} (${downloadPct}%)`
                  : 'Starting download…'}
              </span>
              <span className="search-onboarding-subtext">
                Your photos remain browsable while this finishes.
              </span>
            </div>
            {onCancelEnablePhotoSearch && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                data-testid="cancel-enable-photo-search-btn"
                onClick={() => void onCancelEnablePhotoSearch()}
              >
                Cancel
              </button>
            )}
          </div>
          <progress
            className="search-onboarding-meter"
            max={100}
            value={downloadPct}
            aria-label="Photo search download progress"
          />
        </div>
      )}

      {hasSetupFailure && (
        <div
          className="search-onboarding-card search-onboarding-error"
          role="alert"
          data-testid="photo-search-setup-error"
        >
          <div className="search-onboarding-header">
            <AlertCircle size={16} className="notice-icon" aria-hidden="true" />
            <strong>Couldn&apos;t turn on photo search</strong>
          </div>
          <p className="search-onboarding-copy">
            {isModelCorrupt
              ? "The downloaded search files appear damaged and couldn't be verified. Try downloading again — your photos remain safe and browsable."
              : "Photo search couldn't finish setting up right now. Check your connection and try again — your photos remain safe and browsable."}
          </p>
          {setupError && (
            <details className="search-error-details">
              <summary>Details</summary>
              <span>{setupError}</span>
            </details>
          )}
          {onEnablePhotoSearch && (
            <div className="search-onboarding-actions">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                data-testid="retry-photo-search-btn"
                onClick={() => void onEnablePhotoSearch()}
              >
                Try again
              </button>
            </div>
          )}
        </div>
      )}

      {isModelReady && isIndexingActive && indexingProgress && (
        <div
          className="search-onboarding-progress"
          role="status"
          data-testid="photo-search-indexing-progress"
        >
          <div className="search-onboarding-progress-header">
            <div className="search-onboarding-status-stack">
              <span>
                {indexingProgress.status === 'paused'
                  ? 'Photo search preparation paused'
                  : 'Preparing your photos for search…'}{' '}
                {indexingProgress.processedPhotos} of {indexingProgress.totalPhotos} ({indexingPct}
                %)
              </span>
              <span className="search-onboarding-subtext">
                You can keep browsing and searching while this finishes.
              </span>
            </div>
          </div>
          <progress
            className="search-onboarding-meter"
            max={100}
            value={indexingPct}
            aria-label="Photo search preparation progress"
          />
        </div>
      )}

      {isIndexingFailed && (
        <div
          className="search-onboarding-card search-onboarding-error"
          role="alert"
          data-testid="photo-search-indexing-error"
        >
          <div className="search-onboarding-header">
            <AlertCircle size={16} className="notice-icon" aria-hidden="true" />
            <strong>Couldn&apos;t finish preparing all photos for search</strong>
          </div>
          {setupError && (
            <details className="search-error-details">
              <summary>Details</summary>
              <span>{setupError}</span>
            </details>
          )}
          {(onRetryIndexing ?? onEnablePhotoSearch) && (
            <div className="search-onboarding-actions">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                data-testid="retry-photo-indexing-btn"
                onClick={() => void (onRetryIndexing ?? onEnablePhotoSearch)?.()}
              >
                Try again
              </button>
            </div>
          )}
        </div>
      )}

      {isModelReady && !isIndexingActive && !isIndexingFailed && searchReadyAnnouncement && (
        <div className="search-ready-banner" role="status" data-testid="photo-search-ready-notice">
          <div className="search-ready-banner-text">
            <CheckCircle2 size={14} aria-hidden="true" />
            <span>
              {searchReadyAnnouncement.totalCount > 0
                ? `Photo search is ready (${searchReadyAnnouncement.indexedCount} of ${searchReadyAnnouncement.totalCount} photos ready to search).`
                : 'Photo search is ready. Add photos to search them.'}
            </span>
          </div>
          {onDismissSearchReady && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={onDismissSearchReady}
              aria-label="Dismiss search ready notice"
            >
              Dismiss
            </button>
          )}
        </div>
      )}

      {searchResult && (isModelReady || searchMode === 'metadata_only') && (
        <div className="photos-search-feedback">
          <div className="search-meta-row">
            <span className="search-match-badge" data-testid="search-match-badge">
              {searchMode === 'metadata_only'
                ? `${searchResult.totalMatched} metadata match${searchResult.totalMatched === 1 ? '' : 'es'}`
                : `${searchResult.totalMatched} semantic match${searchResult.totalMatched === 1 ? '' : 'es'}`}
            </span>
            <span className="search-latency-badge">
              · {formatCompactSearchTime(searchResult.queryLatencyMs)}
            </span>
            {searchMode !== 'metadata_only' && searchResult.unindexedCount > 0 && (
              <span className="search-coverage-warning" data-testid="search-partial-results-notice">
                • Partial results — {searchResult.unindexedCount.toLocaleString()} unindexed (
                {searchResult.eligibleCount.toLocaleString()} searched)
              </span>
            )}
            {searchMode !== 'metadata_only' && searchResult.staleCount > 0 && (
              <span className="search-coverage-warning">• {searchResult.staleCount} stale</span>
            )}
            {searchMode !== 'metadata_only' && (searchResult.corruptCount ?? 0) > 0 && (
              <span className="search-coverage-warning" data-testid="search-corrupt-warning">
                • {searchResult.corruptCount} damaged (reindex recommended)
              </span>
            )}
            {searchResult.truncated && (
              <span className="search-truncation-notice">• Query truncated to 77 tokens</span>
            )}
          </div>
          <div className="search-disclaimer" role="note">
            <Info size={12} className="disclaimer-icon" aria-hidden="true" />
            <span>
              {searchMode === 'metadata_only'
                ? 'Matched offline from recorded embedded EXIF/GPS facts and saved user metadata.'
                : 'Matches are semantic suggestions based on AI multimodal embedding, not verified factual labels.'}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
