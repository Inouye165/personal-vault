/**
 * Personal Vault — Photos Natural-Language Search Bar (Stage 6D)
 *
 * Provides compact offline semantic search query input, clear control,
 * match count badges, honest model/coverage notices, and non-factual disclaimer.
 */

import { useState, type FormEvent, type ReactElement } from 'react'
import { Search, X, Loader2, AlertCircle, Info, Cpu, CheckCircle2 } from 'lucide-react'
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
  onDismissSearchReady
}: PhotosSearchBarProps): ReactElement {
  const [inputValue, setInputValue] = useState(query)
  const [prevQuery, setPrevQuery] = useState(query)
  const [showEnableConfirm, setShowEnableConfirm] = useState(false)

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

  const isModelMissing = modelStatus === 'unprovisioned' || modelStatus === 'missing'
  const isModelCorrupt = modelStatus === 'corrupt'
  const isModelError = modelStatus === 'error'
  const isModelDownloading = modelStatus === 'installing'
  const needsModel = isModelMissing || isModelCorrupt || isModelError
  const isIndexingActive =
    indexingProgress?.status === 'running' || indexingProgress?.status === 'paused'

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
        {needsModel && onEnablePhotoSearch && (
          <button
            type="button"
            className="btn btn-secondary btn-sm photos-enable-search-btn"
            data-testid="enable-photo-search-btn"
            aria-expanded={showEnableConfirm}
            onClick={() => setShowEnableConfirm((prev) => !prev)}
          >
            <Cpu size={14} aria-hidden="true" />
            <span>Enable photo search</span>
          </button>
        )}
      </form>

      {showEnableConfirm && needsModel && !isModelDownloading && onEnablePhotoSearch && (
        <div
          className="search-onboarding-card"
          role="region"
          aria-label="Confirm one-time photo search model download"
          data-testid="enable-photo-search-confirm"
        >
          <p className="search-onboarding-copy">
            <strong>One-time offline AI model download (~149 MiB)</strong> is required to search
            photos by description. Your photos stay on this device, and you can continue browsing
            while it downloads and indexes.
          </p>
          <div className="search-onboarding-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              data-testid="confirm-enable-photo-search-btn"
              onClick={() => {
                setShowEnableConfirm(false)
                void onEnablePhotoSearch()
              }}
            >
              Download &amp; enable search (~149 MiB)
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              data-testid="cancel-enable-photo-search-btn"
              onClick={() => setShowEnableConfirm(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {isModelDownloading && (
        <div
          className="search-onboarding-progress"
          role="status"
          data-testid="photo-search-download-progress"
        >
          <div className="search-onboarding-progress-header">
            <span>
              Downloading photo search model…{' '}
              {modelDownloadProgress
                ? `${formatMiB(modelDownloadProgress.downloadedBytes)} / ${formatMiB(modelDownloadProgress.requiredBytes)} (${downloadPct}%)`
                : ''}
            </span>
            {onCancelEnablePhotoSearch && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
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
            aria-label="Model download progress"
          />
        </div>
      )}

      {!isModelDownloading && isIndexingActive && indexingProgress && (
        <div
          className="search-onboarding-progress"
          role="status"
          data-testid="photo-search-indexing-progress"
        >
          <div className="search-onboarding-progress-header">
            <span>
              {indexingProgress.status === 'paused'
                ? 'Photo search indexing paused'
                : 'Indexing photos for search…'}{' '}
              {indexingProgress.processedPhotos} / {indexingProgress.totalPhotos} ({indexingPct}%)
            </span>
          </div>
          <progress
            className="search-onboarding-meter"
            max={100}
            value={indexingPct}
            aria-label="Photo search indexing progress"
          />
        </div>
      )}

      {!isModelDownloading &&
        !isIndexingActive &&
        modelStatus === 'ready' &&
        searchReadyAnnouncement && (
          <div
            className="search-ready-banner"
            role="status"
            data-testid="photo-search-ready-notice"
          >
            <div className="search-ready-banner-text">
              <CheckCircle2 size={14} aria-hidden="true" />
              <span>
                Photo search is ready ({searchReadyAnnouncement.indexedCount} of{' '}
                {searchReadyAnnouncement.totalCount} photos indexed). Try searching above.
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

      {setupError && (
        <div className="search-model-notice search-warning-banner" role="alert">
          <AlertCircle size={14} className="notice-icon" aria-hidden="true" />
          <span>{setupError}</span>
        </div>
      )}

      {isModelMissing && !showEnableConfirm && !isModelDownloading && (
        <div
          className="search-model-notice search-warning-banner"
          role="status"
          data-testid="search-model-missing-notice"
        >
          <AlertCircle size={14} className="notice-icon" aria-hidden="true" />
          <span>
            Offline search model is not installed. Download or import model in the Semantic Index
            tab to enable natural-language search.
          </span>
        </div>
      )}

      {isModelCorrupt && (
        <div
          className="search-model-notice search-warning-banner"
          role="alert"
          data-testid="search-model-corrupt-notice"
        >
          <AlertCircle size={14} className="notice-icon" aria-hidden="true" />
          <span>
            Offline search model is invalid or damaged. Re-download or re-import the verified model
            in the Semantic Index panel to restore natural-language search.
          </span>
        </div>
      )}

      {isModelError && (
        <div
          className="search-model-notice search-warning-banner"
          role="alert"
          data-testid="search-model-error-notice"
        >
          <AlertCircle size={14} className="notice-icon" aria-hidden="true" />
          <span>
            Offline search model download or setup failed. Open the Semantic Index tab to retry
            downloading or import a verified model.
          </span>
        </div>
      )}

      {searchResult && !isModelMissing && !isModelCorrupt && !isModelError && (
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
