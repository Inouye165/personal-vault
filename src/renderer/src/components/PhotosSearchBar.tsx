/**
 * Personal Vault — Photos Natural-Language Search Bar (Stage 6D)
 *
 * Provides compact offline semantic search query input, clear control,
 * match count badges, honest model/coverage notices, and non-factual disclaimer.
 */

import { useState, type FormEvent, type ReactElement } from 'react'
import { Search, X, Loader2, AlertCircle, Info } from 'lucide-react'
import type { SemanticModelProvisionState } from '../../../shared/validation/ipc-schemas'

export interface PhotosSearchBarResultMeta {
  readonly totalMatched: number
  readonly eligibleCount: number
  readonly unindexedCount: number
  readonly staleCount: number
  readonly truncated: boolean
  readonly tokenCount: number
  readonly queryLatencyMs: number
}

export type PhotosSearchModelStatus = SemanticModelProvisionState | 'unprovisioned' | 'corrupt'

export interface PhotosSearchBarProps {
  readonly query: string
  readonly isSearching: boolean
  readonly modelStatus: PhotosSearchModelStatus
  readonly searchResult?: PhotosSearchBarResultMeta | null
  readonly onSearch: (query: string) => void
  readonly onClear: () => void
  readonly disabled?: boolean
}

export function PhotosSearchBar({
  query,
  isSearching,
  modelStatus,
  searchResult,
  onSearch,
  onClear,
  disabled = false
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

  const isModelMissing = modelStatus === 'unprovisioned' || modelStatus === 'missing'

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
              <X size={14} aria-hidden="true" />
              <span>Clear search</span>
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

      {isModelMissing && (
        <div className="search-model-notice search-warning-banner" role="status">
          <AlertCircle size={14} className="notice-icon" aria-hidden="true" />
          <span>
            Offline search model is not installed. Download or import model in the Semantic Index
            tab to enable natural-language search.
          </span>
        </div>
      )}

      {searchResult && !isModelMissing && (
        <div className="photos-search-feedback">
          <div className="search-meta-row">
            <span className="search-match-badge" data-testid="search-match-badge">
              {searchResult.totalMatched} semantic match
              {searchResult.totalMatched === 1 ? '' : 'es'}
            </span>
            <span className="search-latency-badge">
              ({searchResult.queryLatencyMs}ms, {searchResult.tokenCount} tokens)
            </span>
            {searchResult.unindexedCount > 0 && (
              <span className="search-coverage-warning">
                • {searchResult.unindexedCount} unindexed
              </span>
            )}
            {searchResult.staleCount > 0 && (
              <span className="search-coverage-warning">• {searchResult.staleCount} stale</span>
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
