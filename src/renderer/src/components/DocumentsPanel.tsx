import { useCallback, useRef } from 'react'
import { FileText, Search, X } from 'lucide-react'
import { useDocuments } from '../hooks/useDocuments'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useMediaQuery } from '../hooks/useMediaQuery'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function formatTimestampOrUnknown(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return 'Unknown'
  return new Date(ms).toLocaleString()
}

export function DocumentsPanel() {
  const docs = useDocuments()
  const isNarrowViewport = useMediaQuery('(max-width: 900px)')
  const detailDrawerRef = useRef<HTMLElement>(null)
  const lastRowButtonRef = useRef<HTMLButtonElement | null>(null)

  const closeDetail = useCallback(() => {
    void docs.selectDocument(null)
  }, [docs])

  const isDetailOpen = docs.selectedFileLocationId !== null

  useFocusTrap({
    isOpen: isDetailOpen,
    isModal: isNarrowViewport,
    isActive: isDetailOpen,
    containerRef: detailDrawerRef,
    onClose: closeDetail,
    restoreFocusTo: () => lastRowButtonRef.current
  })

  const hasActiveFilter = docs.filenameQuery.trim().length > 0 || docs.extensionFilter !== null
  const currentPage = Math.floor(docs.offset / docs.limit) + 1
  const totalPages = Math.max(1, Math.ceil(docs.totalCount / docs.limit))

  return (
    <section className="documents-panel" aria-label="Cataloged Documents">
      <div className="documents-header-row">
        <div>
          <h2 className="documents-title">Documents</h2>
          <p className="documents-subtitle" data-testid="documents-total-count">
            {docs.totalCount} cataloged {docs.totalCount === 1 ? 'document' : 'documents'}
          </p>
        </div>
        <div className="documents-stage-notice" role="note">
          Showing cataloged documents from your last scan (no rescan required). Content previews,
          text extraction, OCR, classification, and document semantic search will arrive in upcoming
          Stage 7 updates.
        </div>
      </div>

      <div className="documents-toolbar">
        <div className="documents-search-box">
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            className="documents-search-input"
            placeholder="Filter by filename…"
            aria-label="Filter documents by filename"
            maxLength={200}
            value={docs.filenameQuery}
            onChange={(e) => docs.setFilenameQuery(e.target.value)}
          />
          {docs.filenameQuery.length > 0 && (
            <button
              type="button"
              className="documents-clear-btn"
              onClick={() => docs.setFilenameQuery('')}
              aria-label="Clear filename filter"
            >
              <X size={14} aria-hidden="true" />
            </button>
          )}
        </div>

        <div className="documents-filter-group">
          <label htmlFor="documents-ext-filter" className="visually-hidden">
            Filter by file extension
          </label>
          <select
            id="documents-ext-filter"
            className="documents-ext-select"
            aria-label="Filter by file extension"
            value={docs.extensionFilter ?? ''}
            onChange={(e) => docs.setExtensionFilter(e.target.value || null)}
          >
            <option value="">All extensions</option>
            {docs.facets.map((f) => (
              <option key={f.extension || '__none__'} value={f.extension}>
                {f.extension || '(no extension)'} ({f.count})
              </option>
            ))}
          </select>

          {docs.facets.length < docs.facetsTotalCount && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void docs.loadMoreFacets()}
              disabled={docs.isLoadingMoreFacets}
            >
              {docs.isLoadingMoreFacets
                ? 'Loading extensions…'
                : `More extensions (${docs.facets.length}/${docs.facetsTotalCount})`}
            </button>
          )}

          {hasActiveFilter && (
            <button type="button" className="btn-secondary" onClick={docs.resetFilters}>
              Reset filters
            </button>
          )}
        </div>
      </div>

      {docs.error && (
        <div className="notice notice-error" role="alert">
          <div>
            <strong>Could not load documents:</strong> {docs.error}
          </div>
          <button type="button" className="btn-secondary" onClick={docs.reload}>
            Retry
          </button>
        </div>
      )}

      {!docs.error && docs.isLoading && docs.items.length === 0 && (
        <div className="notice" role="status">
          Loading cataloged documents…
        </div>
      )}

      {!docs.error && !docs.isLoading && docs.items.length === 0 && (
        <div className="notice" role="status">
          {hasActiveFilter
            ? 'No documents match the current filename or extension filters.'
            : 'No documents have been cataloged yet.'}
        </div>
      )}

      {docs.items.length > 0 && (
        <div className="documents-workspace">
          <div className="documents-list-pane">
            <ul className="documents-list" aria-label="Document list">
              {docs.items.map((doc) => {
                const isSelected = docs.selectedFileLocationId === doc.fileLocationId
                return (
                  <li key={doc.fileLocationId} className="documents-list-item">
                    <button
                      type="button"
                      className={`documents-row-btn${isSelected ? ' is-selected' : ''}`}
                      aria-pressed={isSelected}
                      onClick={(e) => {
                        lastRowButtonRef.current = e.currentTarget
                        void docs.selectDocument(doc.fileLocationId)
                      }}
                    >
                      <span className="documents-row-icon" aria-hidden="true">
                        <FileText size={18} />
                      </span>
                      <span className="documents-row-main">
                        <span className="documents-row-title">{doc.fileName}</span>
                        <span className="documents-row-path">{doc.originalPath}</span>
                      </span>
                      <span className="documents-row-meta">
                        <span className="documents-ext-badge">{doc.extension || 'file'}</span>
                        <span className="documents-size">{formatBytes(doc.byteSize)}</span>
                        <span className="documents-mtime">
                          {formatTimestampOrUnknown(doc.filesystemMtimeMs)}
                        </span>
                        <span className="documents-status-badge">Not extracted yet</span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>

            <div className="documents-pagination">
              <button
                type="button"
                className="btn-secondary"
                disabled={docs.offset === 0 || docs.isLoading}
                onClick={() => docs.goToPage(docs.offset - docs.limit)}
              >
                Previous
              </button>
              <span className="documents-page-indicator">
                Page {currentPage} of {totalPages}
              </span>
              <button
                type="button"
                className="btn-secondary"
                disabled={docs.offset + docs.limit >= docs.totalCount || docs.isLoading}
                onClick={() => docs.goToPage(docs.offset + docs.limit)}
              >
                Next
              </button>
            </div>
          </div>

          {isDetailOpen && (
            <>
              {isNarrowViewport && (
                <div className="photos-drawer-backdrop" aria-hidden="true" onClick={closeDetail} />
              )}
              <aside
                ref={detailDrawerRef}
                className={`documents-detail-drawer${isNarrowViewport ? ' is-modal-drawer' : ''}`}
                aria-label="Document Details"
                role={isNarrowViewport ? 'dialog' : undefined}
                aria-modal={isNarrowViewport ? 'true' : undefined}
              >
                <div className="documents-detail-header">
                  <h3>Document Details</h3>
                  <button
                    type="button"
                    className="documents-close-btn"
                    onClick={closeDetail}
                    aria-label="Close document details"
                  >
                    <X size={16} aria-hidden="true" />
                  </button>
                </div>

                {docs.isDetailLoading && (
                  <p className="documents-detail-status" role="status">
                    Loading document provenance…
                  </p>
                )}

                {docs.detailError && (
                  <div className="notice notice-error" role="alert">
                    {docs.detailError}
                  </div>
                )}

                {!docs.isDetailLoading && !docs.detailError && docs.detail && (
                  <dl className="documents-detail-list">
                    <div className="documents-detail-row">
                      <dt>Filename</dt>
                      <dd data-testid="document-detail-filename">{docs.detail.fileName}</dd>
                    </div>
                    <div className="documents-detail-row">
                      <dt>Type</dt>
                      <dd>{docs.detail.extension || 'Unknown'}</dd>
                    </div>
                    <div className="documents-detail-row">
                      <dt>Source Root</dt>
                      <dd className="documents-mono">{docs.detail.sourceRootPath}</dd>
                    </div>
                    <div className="documents-detail-row">
                      <dt>Original Path</dt>
                      <dd className="documents-mono">{docs.detail.originalPath}</dd>
                    </div>
                    <div className="documents-detail-row">
                      <dt>Recorded Size</dt>
                      <dd>
                        {formatBytes(docs.detail.byteSize)} ({docs.detail.byteSize} bytes)
                      </dd>
                    </div>
                    <div className="documents-detail-row">
                      <dt>Created (Filesystem)</dt>
                      <dd>{formatTimestampOrUnknown(docs.detail.filesystemBirthtimeMs)}</dd>
                    </div>
                    <div className="documents-detail-row">
                      <dt>Modified (Filesystem)</dt>
                      <dd>{formatTimestampOrUnknown(docs.detail.filesystemMtimeMs)}</dd>
                    </div>
                    <div className="documents-detail-row">
                      <dt>First Discovered</dt>
                      <dd>{formatTimestampOrUnknown(docs.detail.firstDiscoveredAtMs)}</dd>
                    </div>
                    <div className="documents-detail-row">
                      <dt>Last Seen</dt>
                      <dd>{formatTimestampOrUnknown(docs.detail.lastSeenAtMs)}</dd>
                    </div>
                    <div className="documents-detail-row">
                      <dt>Observation ID</dt>
                      <dd>#{docs.detail.discoveryObservationId}</dd>
                    </div>
                    <div className="documents-detail-row">
                      <dt>SHA-256 Hash</dt>
                      <dd className="documents-mono">{docs.detail.activeHash ?? 'Unknown'}</dd>
                    </div>
                    <div className="documents-detail-row">
                      <dt>Hash Verified</dt>
                      <dd>{formatTimestampOrUnknown(docs.detail.activeHashVerifiedAtMs)}</dd>
                    </div>
                    <div className="documents-detail-row">
                      <dt>Text Extraction</dt>
                      <dd>Not extracted yet (planned for Stage 7B/7C)</dd>
                    </div>
                    <div className="documents-detail-row">
                      <dt>Preview</dt>
                      <dd>Preview not yet available (planned for Stage 7B)</dd>
                    </div>
                  </dl>
                )}
              </aside>
            </>
          )}
        </div>
      )}
    </section>
  )
}
