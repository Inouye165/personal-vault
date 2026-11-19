import { useEffect, useState, type ReactElement } from 'react'
import {
  AlertCircle,
  FileImage,
  FileText,
  Info,
  Loader2,
  RotateCcw,
  SlidersHorizontal
} from 'lucide-react'
import type {
  NavigationTab,
  PhotoFileTypeBasis,
  SemanticSearchResultItem,
  ThumbnailResult,
  UnifiedSearchModality
} from '../../../shared/validation/ipc-schemas'
import type { HydratedDocSearchItemDto } from '../../../shared/validation/document-schemas'
import {
  hasActiveDocumentQuickFilters,
  hasActivePhotoQuickFilters,
  UNIFIED_SEARCH_PAGE_SIZE,
  type UseUnifiedSearchResult
} from '../hooks/useUnifiedSearch'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatLatency(ms: number): string {
  if (!Number.isFinite(ms)) return '0 ms'
  return `${Math.round(ms)} ms`
}

interface UnifiedPhotoCardProps {
  readonly item: SemanticSearchResultItem
  readonly isExpanded: boolean
  readonly onToggleExpand: () => void
  readonly onOpenPhotosTab: () => void
}

function UnifiedPhotoCard({
  item,
  isExpanded,
  onToggleExpand,
  onOpenPhotosTab
}: UnifiedPhotoCardProps): ReactElement {
  const { photo, score } = item
  const [thumb, setThumb] = useState<ThumbnailResult | null>(null)

  useEffect(() => {
    let cancelled = false
    const getThumb = window.api?.getThumbnail
    if (typeof getThumb === 'function') {
      void getThumb({ locationId: photo.id, priority: 'high' })
        .then((result) => {
          if (!cancelled) {
            setThumb(result)
          }
        })
        .catch(() => {})
    }
    return () => {
      cancelled = true
      try {
        void window.api?.cancelThumbnail?.({ locationId: photo.id })?.catch?.(() => {})
      } catch {
        // Ignore cleanup errors
      }
    }
  }, [photo.id])

  const similarityPct = Math.round(Math.max(0, score) * 100)

  return (
    <li className="unified-photo-card" data-testid={`unified-photo-result-${photo.id}`}>
      <div className="unified-photo-thumb-wrap">
        {thumb?.status === 'ready' ? (
          <img
            src={thumb.dataUrl}
            alt={photo.fileName}
            className="unified-photo-thumb-img"
            loading="lazy"
          />
        ) : (
          <div className="unified-photo-thumb-placeholder" aria-hidden="true">
            <FileImage size={24} />
          </div>
        )}
        <span
          className="unified-similarity-badge unified-similarity-clip"
          title={`CLIP relative cosine similarity: ${score.toFixed(3)} (uncalibrated; not comparable to document scores)`}
        >
          {similarityPct}% CLIP similarity
        </span>
      </div>

      <div className="unified-photo-card-body">
        <button
          type="button"
          className="unified-result-title-btn"
          data-testid={`unified-photo-item-${photo.id}`}
          aria-expanded={isExpanded}
          onClick={onToggleExpand}
        >
          {photo.fileName}
        </button>

        <div className="unified-result-meta-row">
          <span>{formatBytes(photo.byteSize)}</span>
          {photo.rating !== null && <span>· ★ {photo.rating}</span>}
          {photo.flag && photo.flag !== 'none' && <span>· {photo.flag.toUpperCase()}</span>}
        </div>

        {isExpanded && (
          <div className="unified-result-details" data-testid={`unified-photo-details-${photo.id}`}>
            <p className="unified-result-path">{photo.originalPath}</p>
            <div className="unified-result-details-actions">
              <button type="button" className="btn btn-secondary btn-sm" onClick={onOpenPhotosTab}>
                Open Photos tab
              </button>
            </div>
          </div>
        )}
      </div>
    </li>
  )
}

interface UnifiedDocCardProps {
  readonly item: HydratedDocSearchItemDto
  readonly isExpanded: boolean
  readonly onToggleExpand: () => void
  readonly onOpenDocumentsTab: () => void
}

function UnifiedDocCard({
  item,
  isExpanded,
  onToggleExpand,
  onOpenDocumentsTab
}: UnifiedDocCardProps): ReactElement {
  const similarityPct = Math.round(Math.max(0, item.score) * 100)

  return (
    <li className="unified-doc-card" data-testid={`unified-doc-result-${item.fileLocationId}`}>
      <div className="unified-doc-card-top">
        <button
          type="button"
          className="unified-result-title-btn"
          data-testid={`unified-doc-item-${item.fileLocationId}`}
          aria-expanded={isExpanded}
          onClick={onToggleExpand}
        >
          {item.fileName}
        </button>
        <span
          className="unified-similarity-badge unified-similarity-bge"
          title={`BGE relative cosine similarity: ${item.score.toFixed(3)} (uncalibrated; not comparable to photo scores)`}
        >
          {similarityPct}% BGE similarity
        </span>
        <span className={`doc-semantic-track-badge doc-semantic-track-${item.textSourceKind}`}>
          {item.textSourceKind === 'ocr' ? 'OCR text (machine-recognized)' : 'Native text'}
        </span>
        {item.truncated && (
          <span
            className="doc-semantic-partial-badge"
            data-testid={`unified-doc-partial-${item.fileLocationId}`}
          >
            Partially indexed: first {item.indexedCharCount.toLocaleString()} of{' '}
            {item.normalizedCharCount.toLocaleString()} chars (
            {Math.round(item.coverageRatio * 100)}%)
          </span>
        )}
      </div>

      <pre className="unified-doc-snippet">{item.winningSnippet}</pre>

      {isExpanded && (
        <div
          className="unified-result-details"
          data-testid={`unified-doc-details-${item.fileLocationId}`}
        >
          <p className="unified-result-path">{item.originalPath}</p>
          <p className="unified-result-meta-row">
            Extension: {item.extension || '(none)'} · Chunk {item.winningChunkIndex + 1} (chars{' '}
            {item.charOffsetStart}–{item.charOffsetEnd})
          </p>
          <div className="unified-result-details-actions">
            <button type="button" className="btn btn-secondary btn-sm" onClick={onOpenDocumentsTab}>
              Open Documents tab
            </button>
          </div>
        </div>
      )}
    </li>
  )
}

export interface UnifiedSearchPanelProps {
  readonly search: UseUnifiedSearchResult
  readonly isMobileViewport: boolean
  readonly onNavigateTab: (tab: NavigationTab) => void
}

const MODALITY_OPTIONS: readonly { value: UnifiedSearchModality; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'photos', label: 'Photos' },
  { value: 'documents', label: 'Documents' }
]

export function UnifiedSearchPanel({
  search,
  isMobileViewport,
  onNavigateTab
}: UnifiedSearchPanelProps): ReactElement {
  const [expandedPhotoId, setExpandedPhotoId] = useState<number | null>(null)
  const [expandedDocId, setExpandedDocId] = useState<number | null>(null)

  const photosActive = search.modality !== 'documents'
  const docsActive = search.modality !== 'photos'
  const hasPhotoFilters = hasActivePhotoQuickFilters(search.photoFilters)
  const hasDocFilters = hasActiveDocumentQuickFilters(search.documentFilters)
  const showMixedScopeDisclosure = search.modality === 'all' && (hasPhotoFilters || hasDocFilters)

  const jumpToSection = (sectionId: string, headingId: string) => {
    const section = document.getElementById(sectionId)
    section?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
    const heading = document.getElementById(headingId)
    heading?.focus?.()
  }

  const photoResult = search.photos.response?.result ?? null
  const docResult = search.documents.response?.result ?? null

  const photoValueSelectDisabled = !photosActive

  const selectedPhotoFormatValue = search.photoFilters.onlyUnknownDetectedFormat
    ? '__unknown__'
    : (search.photoFilters.fileTypeValue ?? '')

  const photoFacetHasSelected =
    !search.photoFilters.fileTypeValue ||
    search.photoFileTypeFacets.some((f) => f.normalizedValue === search.photoFilters.fileTypeValue)

  const docFacetHasSelected =
    !search.documentFilters.extensionFilter ||
    search.docExtensionFacets.some((f) => f.extension === search.documentFilters.extensionFilter)

  return (
    <section
      className="unified-search-panel"
      data-testid="unified-search-panel"
      aria-label="Unified Search Results"
    >
      <div className="unified-search-header">
        <div className="unified-search-title-row">
          <div>
            <h2 className="unified-search-title">Unified Search</h2>
            <p className="unified-search-subtitle">
              Query: <strong>{search.submittedQuery}</strong> · Per-modality results (up to{' '}
              {UNIFIED_SEARCH_PAGE_SIZE} per page)
            </p>
          </div>
          <div className="unified-modality-selector" role="group" aria-label="Search modality">
            {MODALITY_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={`unified-modality-btn ${search.modality === opt.value ? 'active' : ''}`}
                data-testid={`unified-modality-${opt.value}`}
                aria-pressed={search.modality === opt.value}
                onClick={() => search.setModality(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <p className="unified-score-disclaimer" role="note">
          <Info size={13} aria-hidden="true" />
          <span>
            Photo (CLIP) and document (BGE) similarity scores use different vector spaces and are
            uncalibrated — scores and counts are reported separately and are not comparable across
            sections.
          </span>
        </p>

        {/* Compact explicitly scoped quick filters */}
        <div className="unified-quick-filters" aria-label="Scoped Quick Filters">
          <fieldset
            className="unified-filter-group"
            disabled={!photosActive}
            aria-label="Photo quick filters (Photos only)"
          >
            <legend className="unified-filter-legend">
              <SlidersHorizontal size={12} aria-hidden="true" />
              <span>Photos only</span>
            </legend>
            <div className="unified-filter-controls">
              <select
                className="unified-filter-select"
                aria-label="Photo format basis (Photos only)"
                data-testid="unified-photo-format-basis"
                value={search.photoFilters.fileTypeBasis}
                onChange={(e) =>
                  search.updatePhotoFilters({
                    fileTypeBasis: e.target.value as PhotoFileTypeBasis,
                    fileTypeValue: null,
                    onlyUnknownDetectedFormat: false
                  })
                }
              >
                <option value="detected_format">Detected format</option>
                <option value="filename_extension">Filename extension</option>
              </select>

              <select
                className="unified-filter-select"
                aria-label="Photo format filter (Photos only)"
                data-testid="unified-photo-format-value"
                disabled={photoValueSelectDisabled}
                value={selectedPhotoFormatValue}
                onChange={(e) => {
                  const val = e.target.value
                  if (val === '__unknown__') {
                    search.updatePhotoFilters({
                      fileTypeValue: null,
                      onlyUnknownDetectedFormat: true
                    })
                  } else {
                    search.updatePhotoFilters({
                      fileTypeValue: val || null,
                      onlyUnknownDetectedFormat: false
                    })
                  }
                }}
              >
                <option value="">
                  {search.photoFilters.fileTypeBasis === 'detected_format'
                    ? 'All photo formats'
                    : 'All photo extensions'}
                </option>
                {search.photoFilters.fileTypeBasis === 'detected_format' && (
                  <option value="__unknown__">Unknown detected format</option>
                )}
                {!photoFacetHasSelected && search.photoFilters.fileTypeValue && (
                  <option value={search.photoFilters.fileTypeValue}>
                    {search.photoFilters.fileTypeValue}
                  </option>
                )}
                {search.photoFileTypeFacets.map((f) => (
                  <option key={f.normalizedValue} value={f.normalizedValue}>
                    {f.displayLabel} ({f.count})
                  </option>
                ))}
              </select>
            </div>
          </fieldset>

          <fieldset
            className="unified-filter-group"
            disabled={!docsActive}
            aria-label="Document quick filters (Documents only)"
          >
            <legend className="unified-filter-legend">
              <SlidersHorizontal size={12} aria-hidden="true" />
              <span>Documents only</span>
            </legend>
            <div className="unified-filter-controls">
              <label className="unified-filter-checkbox">
                <input
                  type="checkbox"
                  data-testid="unified-doc-hide-clutter"
                  aria-label="Hide clutter (Documents only)"
                  checked={search.documentFilters.clutterFilter === 'hide_clutter'}
                  onChange={(e) =>
                    search.updateDocumentFilters({
                      clutterFilter: e.target.checked ? 'hide_clutter' : 'show_all'
                    })
                  }
                />
                <span>Hide clutter</span>
              </label>

              <select
                className="unified-filter-select"
                aria-label="Document text source (Documents only)"
                data-testid="unified-doc-text-source"
                value={search.documentFilters.textSourceKindFilter ?? ''}
                onChange={(e) => {
                  const val = e.target.value
                  search.updateDocumentFilters({
                    textSourceKindFilter: val === 'native' || val === 'ocr' ? val : null
                  })
                }}
              >
                <option value="">All text sources</option>
                <option value="native">Native text only</option>
                <option value="ocr">OCR text only</option>
              </select>

              <select
                className="unified-filter-select"
                aria-label="Document extension (Documents only)"
                data-testid="unified-doc-extension"
                value={search.documentFilters.extensionFilter ?? ''}
                onChange={(e) =>
                  search.updateDocumentFilters({
                    extensionFilter: e.target.value || null
                  })
                }
              >
                <option value="">All doc extensions</option>
                {!docFacetHasSelected && search.documentFilters.extensionFilter && (
                  <option value={search.documentFilters.extensionFilter}>
                    {search.documentFilters.extensionFilter}
                  </option>
                )}
                {search.docExtensionFacets.map((f) => (
                  <option key={f.extension || '__none__'} value={f.extension}>
                    {f.extension || '(no extension)'} ({f.count})
                  </option>
                ))}
              </select>
            </div>
          </fieldset>

          <div className="unified-filter-links">
            {search.hasAnyQuickFilter && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                data-testid="unified-reset-filters-btn"
                onClick={search.resetQuickFilters}
              >
                <RotateCcw size={13} aria-hidden="true" />
                <span>Reset quick filters</span>
              </button>
            )}
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => onNavigateTab('photos')}
            >
              More photo filters
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => onNavigateTab('documents')}
            >
              More document filters
            </button>
          </div>
        </div>

        {showMixedScopeDisclosure && (
          <div
            className="unified-scope-disclosure"
            data-testid="unified-filter-scope-disclosure"
            role="note"
          >
            {hasDocFilters && (
              <span>
                Document-only filters apply to Documents only; Photos results are not filtered by
                document criteria.
              </span>
            )}
            {hasPhotoFilters && (
              <span>
                Photo-only filters apply to Photos only; Documents results are not filtered by photo
                criteria.
              </span>
            )}
          </div>
        )}

        {isMobileViewport && search.modality === 'all' && (
          <div className="unified-jump-links" data-testid="unified-jump-links">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => jumpToSection('unified-photos-section', 'unified-photos-heading')}
            >
              Jump to Photos
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() =>
                jumpToSection('unified-documents-section', 'unified-documents-heading')
              }
            >
              Jump to Documents
            </button>
          </div>
        )}

        <div
          className="visually-hidden"
          role="status"
          aria-live="polite"
          data-testid="unified-live-status"
        >
          {search.statusAnnouncement}
        </div>
      </div>

      <div
        className={`unified-results-grid ${search.modality === 'all' ? 'two-column' : 'single-column'}`}
      >
        {photosActive && (
          <section
            id="unified-photos-section"
            className="unified-modality-section"
            data-testid="unified-photos-section"
            aria-labelledby="unified-photos-heading"
          >
            <div className="unified-section-header">
              <div className="unified-section-title-group">
                <h3 id="unified-photos-heading" tabIndex={-1} className="unified-section-title">
                  <FileImage size={16} aria-hidden="true" />
                  <span>Photos</span>
                </h3>
                {search.photos.phase === 'ready' && photoResult && (
                  <span className="unified-section-count" data-testid="unified-photos-count">
                    {photoResult.totalMatched}{' '}
                    {photoResult.totalMatched === 1 ? 'photo match' : 'photo matches'} ·{' '}
                    {formatLatency(photoResult.queryLatencyMs)}
                  </span>
                )}
              </div>
              <p className="unified-modality-model-note">
                CLIP relative similarity (Xenova/clip-vit-base-patch32)
              </p>
            </div>

            {search.photos.phase === 'loading' && (
              <div className="unified-modality-status" role="status">
                <Loader2 size={16} className="spin" aria-hidden="true" />
                <span>Searching photos…</span>
              </div>
            )}

            {search.photos.phase === 'unprovisioned' && (
              <div className="notice unified-modality-notice" role="status">
                <AlertCircle size={15} aria-hidden="true" />
                <div>
                  <strong>Photo search model is not installed.</strong>
                  <p>
                    {search.photos.errorMessage ??
                      'Open the Photos tab to download or import the offline CLIP model.'}
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => onNavigateTab('photos')}
                >
                  Open Photos tab
                </button>
              </div>
            )}

            {search.photos.phase === 'corrupt' && (
              <div className="notice notice-error unified-modality-notice" role="alert">
                <AlertCircle size={15} aria-hidden="true" />
                <div>
                  <strong>Photo search model is corrupt or invalid.</strong>
                  <p>
                    {search.photos.errorMessage ??
                      'Re-download or re-import the verified CLIP model in the Photos tab.'}
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => onNavigateTab('photos')}
                >
                  Open Photos tab
                </button>
              </div>
            )}

            {(search.photos.phase === 'timed_out' ||
              search.photos.phase === 'overloaded' ||
              search.photos.phase === 'cancelled' ||
              search.photos.phase === 'error') && (
              <div className="notice notice-error unified-modality-notice" role="alert">
                <AlertCircle size={15} aria-hidden="true" />
                <div>
                  <strong>
                    {search.photos.phase === 'timed_out'
                      ? 'Photo search timed out'
                      : search.photos.phase === 'overloaded'
                        ? 'Photo search is busy'
                        : search.photos.phase === 'cancelled'
                          ? 'Photo search cancelled'
                          : 'Photo search failed'}
                  </strong>
                  <p>{search.photos.errorMessage ?? 'Please retry photo search.'}</p>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  data-testid="unified-photos-retry-btn"
                  onClick={search.retryPhotos}
                >
                  Retry Photos
                </button>
              </div>
            )}

            {search.photos.phase === 'ready' && photoResult && (
              <>
                {(photoResult.truncated ||
                  photoResult.unindexedCount > 0 ||
                  photoResult.staleCount > 0 ||
                  photoResult.corruptCount > 0) && (
                  <div className="unified-coverage-notes">
                    {photoResult.truncated && (
                      <span>Query truncated to {photoResult.tokenCount} CLIP tokens.</span>
                    )}
                    {photoResult.unindexedCount > 0 && (
                      <span>{photoResult.unindexedCount} unindexed photos.</span>
                    )}
                    {photoResult.staleCount > 0 && (
                      <span>{photoResult.staleCount} stale photo embeddings.</span>
                    )}
                    {photoResult.corruptCount > 0 && (
                      <span>{photoResult.corruptCount} corrupt embeddings excluded.</span>
                    )}
                  </div>
                )}

                {photoResult.items.length === 0 ? (
                  <div className="unified-empty-section" data-testid="unified-photos-empty">
                    <p>No matching photos found.</p>
                    {photoResult.eligibleCount === 0 && (
                      <p className="unified-empty-hint">
                        No photos are indexed for semantic search yet. Open the Photos tab to index
                        your photos.
                      </p>
                    )}
                  </div>
                ) : (
                  <ul className="unified-photos-list">
                    {photoResult.items.map((item) => (
                      <UnifiedPhotoCard
                        key={item.photo.id}
                        item={item}
                        isExpanded={expandedPhotoId === item.photo.id}
                        onToggleExpand={() =>
                          setExpandedPhotoId((prev) =>
                            prev === item.photo.id ? null : item.photo.id
                          )
                        }
                        onOpenPhotosTab={() => onNavigateTab('photos')}
                      />
                    ))}
                  </ul>
                )}

                {(search.photos.offset > 0 || photoResult.hasMore) && (
                  <div className="unified-pagination" aria-label="Photo results pagination">
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      data-testid="unified-photos-prev-btn"
                      disabled={search.photos.offset === 0}
                      onClick={() =>
                        search.pagePhotos(
                          Math.max(0, search.photos.offset - UNIFIED_SEARCH_PAGE_SIZE)
                        )
                      }
                    >
                      Previous
                    </button>
                    <span className="unified-pagination-info">
                      Page {Math.floor(search.photos.offset / UNIFIED_SEARCH_PAGE_SIZE) + 1}
                    </span>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      data-testid="unified-photos-next-btn"
                      disabled={!photoResult.hasMore}
                      onClick={() =>
                        search.pagePhotos(search.photos.offset + UNIFIED_SEARCH_PAGE_SIZE)
                      }
                    >
                      Next
                    </button>
                  </div>
                )}
              </>
            )}
          </section>
        )}

        {docsActive && (
          <section
            id="unified-documents-section"
            className="unified-modality-section"
            data-testid="unified-documents-section"
            aria-labelledby="unified-documents-heading"
          >
            <div className="unified-section-header">
              <div className="unified-section-title-group">
                <h3 id="unified-documents-heading" tabIndex={-1} className="unified-section-title">
                  <FileText size={16} aria-hidden="true" />
                  <span>Documents</span>
                </h3>
                {search.documents.phase === 'ready' && docResult && (
                  <span className="unified-section-count" data-testid="unified-documents-count">
                    {docResult.totalMatched}{' '}
                    {docResult.totalMatched === 1 ? 'document match' : 'document matches'} ·{' '}
                    {formatLatency(docResult.queryLatencyMs)}
                  </span>
                )}
              </div>
              <p className="unified-modality-model-note">
                BGE relative similarity (Xenova/bge-small-en-v1.5)
              </p>
            </div>

            {(docResult?.clutterFilterActive ||
              search.documentFilters.clutterFilter === 'hide_clutter') && (
              <div
                className="unified-clutter-disclosure"
                data-testid="unified-doc-clutter-disclosure"
                role="note"
              >
                Clutter filter active: clutter documents are excluded before semantic ranking.
              </div>
            )}

            {search.documents.phase === 'loading' && (
              <div className="unified-modality-status" role="status">
                <Loader2 size={16} className="spin" aria-hidden="true" />
                <span>Searching documents…</span>
              </div>
            )}

            {search.documents.phase === 'unprovisioned' && (
              <div className="notice unified-modality-notice" role="status">
                <AlertCircle size={15} aria-hidden="true" />
                <div>
                  <strong>Document search model is not installed.</strong>
                  <p>
                    {search.documents.errorMessage ??
                      'Open the Documents tab to download or import the offline BGE model.'}
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => onNavigateTab('documents')}
                >
                  Open Documents tab
                </button>
              </div>
            )}

            {search.documents.phase === 'corrupt' && (
              <div className="notice notice-error unified-modality-notice" role="alert">
                <AlertCircle size={15} aria-hidden="true" />
                <div>
                  <strong>Document search model is corrupt or invalid.</strong>
                  <p>
                    {search.documents.errorMessage ??
                      'Re-download or re-import the verified BGE model in the Documents tab.'}
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => onNavigateTab('documents')}
                >
                  Open Documents tab
                </button>
              </div>
            )}

            {(search.documents.phase === 'timed_out' ||
              search.documents.phase === 'overloaded' ||
              search.documents.phase === 'cancelled' ||
              search.documents.phase === 'error') && (
              <div className="notice notice-error unified-modality-notice" role="alert">
                <AlertCircle size={15} aria-hidden="true" />
                <div>
                  <strong>
                    {search.documents.phase === 'timed_out'
                      ? 'Document search timed out'
                      : search.documents.phase === 'overloaded'
                        ? 'Document search is busy'
                        : search.documents.phase === 'cancelled'
                          ? 'Document search cancelled'
                          : 'Document search failed'}
                  </strong>
                  <p>{search.documents.errorMessage ?? 'Please retry document search.'}</p>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  data-testid="unified-documents-retry-btn"
                  onClick={search.retryDocuments}
                >
                  Retry Documents
                </button>
              </div>
            )}

            {search.documents.phase === 'ready' && docResult && (
              <>
                {(docResult.queryTruncated ||
                  docResult.corruptChunkCount > 0 ||
                  docResult.coverage.unindexedTracks > 0 ||
                  docResult.coverage.staleTracks > 0) && (
                  <div className="unified-coverage-notes">
                    {docResult.queryTruncated && (
                      <span>Query truncated at {docResult.queryTokenCount} BGE tokens.</span>
                    )}
                    {docResult.coverage.unindexedTracks > 0 && (
                      <span>{docResult.coverage.unindexedTracks} unindexed document tracks.</span>
                    )}
                    {docResult.coverage.staleTracks > 0 && (
                      <span>
                        {docResult.coverage.staleTracks} stale document{' '}
                        {docResult.coverage.staleTracks === 1 ? 'track' : 'tracks'}.
                      </span>
                    )}
                    {docResult.corruptChunkCount > 0 && (
                      <span>{docResult.corruptChunkCount} corrupt chunks excluded.</span>
                    )}
                  </div>
                )}

                {docResult.items.length === 0 ? (
                  <div className="unified-empty-section" data-testid="unified-documents-empty">
                    <p>No matching documents found.</p>
                    {docResult.eligibleChunkCount === 0 && (
                      <p className="unified-empty-hint">
                        No indexed document chunks available yet. Open the Documents tab to extract,
                        OCR, and index documents.
                      </p>
                    )}
                  </div>
                ) : (
                  <ul className="unified-docs-list">
                    {docResult.items.map((item) => (
                      <UnifiedDocCard
                        key={`${item.fileLocationId}:${item.winningChunkId}`}
                        item={item}
                        isExpanded={expandedDocId === item.fileLocationId}
                        onToggleExpand={() =>
                          setExpandedDocId((prev) =>
                            prev === item.fileLocationId ? null : item.fileLocationId
                          )
                        }
                        onOpenDocumentsTab={() => onNavigateTab('documents')}
                      />
                    ))}
                  </ul>
                )}

                {(search.documents.offset > 0 || docResult.hasMore) && (
                  <div className="unified-pagination" aria-label="Document results pagination">
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      data-testid="unified-documents-prev-btn"
                      disabled={search.documents.offset === 0}
                      onClick={() =>
                        search.pageDocuments(
                          Math.max(0, search.documents.offset - UNIFIED_SEARCH_PAGE_SIZE)
                        )
                      }
                    >
                      Previous
                    </button>
                    <span className="unified-pagination-info">
                      Page {Math.floor(search.documents.offset / UNIFIED_SEARCH_PAGE_SIZE) + 1}
                    </span>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      data-testid="unified-documents-next-btn"
                      disabled={!docResult.hasMore}
                      onClick={() =>
                        search.pageDocuments(search.documents.offset + UNIFIED_SEARCH_PAGE_SIZE)
                      }
                    >
                      Next
                    </button>
                  </div>
                )}
              </>
            )}
          </section>
        )}
      </div>
    </section>
  )
}
