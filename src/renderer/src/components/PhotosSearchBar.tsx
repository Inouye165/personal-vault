/**
 * Personal Vault — Photos Natural-Language Search Bar (Stage 6D)
 *
 * Provides compact offline semantic search query input, clear control,
 * match count badges, honest model/coverage notices, and non-factual disclaimer.
 */

import { useState, type FormEvent, type ReactElement } from 'react'
import { Search, X, Loader2, AlertCircle, Info, Sparkles, CheckCircle2 } from 'lucide-react'
import type {
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
  readonly searchResult?: PhotosSearchBarResultMeta | null
  readonly onSearch: (query: string) => void
  readonly onClear: () => void
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
  searchResult,
  onSearch,
  onClear,
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

  if (query !== prevQuery) {
    setPrevQuery(query)
    setInputValue(query)
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

  return (
    <div className="photos-search-bar-container" data-testid="photos-search-bar">
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
            Turning this on starts a one-time ~149 MiB download so search works privately on this
            device. Your photos stay on your device and remain browsable during setup.
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

      {isModelReady && (
        <form onSubmit={handleSubmit} className="photos-search-form" role="search">
          <div className="photos-search-input-wrapper">
            <Search size={16} className="search-icon" aria-hidden="true" />
            <input
              type="text"
              className="photos-search-input"
              placeholder="Search photos by description (e.g. sunset over ocean)..."
              aria-label="Search photos by description"
              value={inputValue}
              maxLength={500}
              disabled={disabled || isSearching}
              onChange={(e) => setInputValue(e.target.value)}
            />
            {isSearching && (
              <Loader2 size={16} className="search-loading-icon spin" aria-label="Searching..." />
            )}
            {(inputValue.length > 0 || query.length > 0 || searchResult) && !isSearching && (
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

      {isModelReady && searchResult && (
        <div className="photos-search-feedback">
          <div className="search-meta-row">
            <span className="search-match-badge" data-testid="search-match-badge">
              {searchResult.totalMatched} semantic match
              {searchResult.totalMatched === 1 ? '' : 'es'}
            </span>
            <span className="search-latency-badge">
              · {formatCompactSearchTime(searchResult.queryLatencyMs)}
            </span>
            {searchResult.unindexedCount > 0 && (
              <span className="search-coverage-warning">
                • {searchResult.unindexedCount} unindexed
              </span>
            )}
            {searchResult.staleCount > 0 && (
              <span className="search-coverage-warning">• {searchResult.staleCount} stale</span>
            )}
            {(searchResult.corruptCount ?? 0) > 0 && (
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
              Matches are semantic suggestions based on AI multimodal embedding, not verified
              factual labels.
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
