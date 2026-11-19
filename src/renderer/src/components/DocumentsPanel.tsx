import { useCallback, useRef, useState } from 'react'
import { FileText, Search, X } from 'lucide-react'
import type {
  DocumentClutterFilter,
  DocumentClutterOverride,
  DocumentEffectiveClassificationSummary,
  DocumentExtractionStatus,
  DocumentOcrStatusDto,
  DocumentOriginFilter,
  DocumentOriginLabel,
  DocumentPurposeFilter,
  DocumentPurposeLabel
} from '../../../shared/validation/document-schemas'
import { useDocuments } from '../hooks/useDocuments'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useMediaQuery } from '../hooks/useMediaQuery'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function formatTimestampOrUnknown(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return 'Unknown'
  return new Date(ms).toLocaleString()
}

export function formatExtractionStatusLabel(status: DocumentExtractionStatus): string {
  switch (status) {
    case 'not_extracted':
      return 'Not extracted'
    case 'processing':
      return 'Processing'
    case 'extracted':
      return 'Extracted'
    case 'no_text_ocr_required':
      return 'No text / OCR required'
    case 'password_protected':
      return 'Password protected'
    case 'unsupported':
      return 'Unsupported'
    case 'corrupt_or_failed':
      return 'Corrupt or failed'
    case 'stale':
      return 'Stale'
    case 'truncated':
      return 'Truncated'
  }
}

export function formatOcrStatusLabel(status: DocumentOcrStatusDto): string {
  switch (status) {
    case 'not_processed':
      return 'Not processed'
    case 'processing':
      return 'Processing'
    case 'extracted':
      return 'OCR Extracted'
    case 'ocr_no_text':
      return 'No text recognized'
    case 'truncated':
      return 'Truncated'
    case 'password_protected':
      return 'Password protected'
    case 'unsupported':
      return 'Unsupported'
    case 'corrupt_or_failed':
      return 'Failed'
    case 'stale':
      return 'Stale'
  }
}

const PURPOSE_LABELS: readonly { value: DocumentPurposeLabel; label: string }[] = [
  { value: 'legal', label: 'Legal' },
  { value: 'lists', label: 'Lists' },
  { value: 'instructions', label: 'Instructions' },
  { value: 'receipts', label: 'Receipts' },
  { value: 'recipes', label: 'Recipes' }
]

const ORIGIN_LABELS: readonly { value: DocumentOriginLabel; label: string }[] = [
  { value: 'personal', label: 'Personal' },
  { value: 'software_project', label: 'Software project' },
  { value: 'application_system', label: 'Application / System' }
]

function formatPurposeSummary(cls: DocumentEffectiveClassificationSummary | undefined): string {
  if (!cls) return 'Unclassified / Needs text extraction or OCR'
  if (cls.effectivePurposeLabels.length > 0) {
    return cls.effectivePurposeLabels
      .map((l) => PURPOSE_LABELS.find((p) => p.value === l)?.label ?? l)
      .join(', ')
  }
  if (cls.effectivePurposeStatus === 'other') return 'Other / No structured match'
  return 'Unclassified / Needs text extraction or OCR'
}

function formatOriginSummary(cls: DocumentEffectiveClassificationSummary | undefined): string {
  if (!cls || cls.effectiveOriginLabels.length === 0) return 'Unknown'
  return cls.effectiveOriginLabels
    .map((l) => ORIGIN_LABELS.find((o) => o.value === l)?.label ?? l)
    .join(', ')
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

  const hasActiveFilter =
    docs.filenameQuery.trim().length > 0 ||
    docs.extensionFilter !== null ||
    docs.purposeFilter !== null ||
    docs.originFilter !== null ||
    docs.clutterFilter !== 'show_all'
  const currentPage = Math.floor(docs.offset / docs.limit) + 1
  const totalPages = Math.max(1, Math.ceil(docs.totalCount / docs.limit))

  const clsProgress = docs.classificationProgress
  const isClsRunning = clsProgress?.status === 'running'
  const isClsPausedOrInterrupted =
    clsProgress?.status === 'paused' || clsProgress?.status === 'interrupted'
  const clsCoverage = clsProgress?.coverage

  const [editingOverrideDocId, setEditingOverrideDocId] = useState<number | null>(null)
  const [editPurposeLabels, setEditPurposeLabels] = useState<DocumentPurposeLabel[]>([])
  const [editOriginLabels, setEditOriginLabels] = useState<DocumentOriginLabel[]>([])
  const [editClutterOverride, setEditClutterOverride] = useState<DocumentClutterOverride>('inherit')

  const openOverrideEditor = (cls: DocumentEffectiveClassificationSummary, docId: number) => {
    setEditingOverrideDocId(docId)
    setEditPurposeLabels([...cls.effectivePurposeLabels])
    setEditOriginLabels([...cls.effectiveOriginLabels])
    setEditClutterOverride(cls.clutterOverride)
  }

  const progress = docs.extractionProgress
  const isJobRunning = progress?.status === 'running'
  const isJobPausedOrInterrupted =
    progress?.status === 'paused' || progress?.status === 'interrupted'
  const coverage = progress?.coverage

  const ocrModel = docs.ocrModelStatus
  const isOcrModelReady = ocrModel?.state === 'ready'
  const isOcrModelInstalling = ocrModel?.state === 'installing'
  const ocrProgress = docs.ocrProgress
  const isOcrRunning = ocrProgress?.status === 'running'
  const isOcrPausedOrInterrupted =
    ocrProgress?.status === 'paused' || ocrProgress?.status === 'interrupted'
  const ocrCoverage = ocrProgress?.coverage

  const docSemModel = docs.docSemanticModelStatus
  const isDocSemModelReady = docSemModel?.state === 'ready'
  const isDocSemModelBusy =
    docSemModel?.state === 'downloading' ||
    docSemModel?.state === 'importing' ||
    docSemModel?.state === 'verifying'
  const docSemProgress = docs.docSemanticProgress
  const isDocSemRunning = docSemProgress?.status === 'running'
  const isDocSemPausedOrInterrupted =
    docSemProgress?.status === 'paused' || docSemProgress?.status === 'interrupted'
  const docSemCoverage = docSemProgress?.coverage
  const [docSearchDraft, setDocSearchDraft] = useState('')

  return (
    <section className="documents-panel" aria-label="Cataloged Documents">
      <div className="documents-header-row">
        <div>
          <h2 className="documents-title">Documents</h2>
          <p className="documents-subtitle" data-testid="documents-total-count">
            {docs.totalCount} cataloged {docs.totalCount === 1 ? 'document' : 'documents'}
            {coverage && coverage.extractedDocuments > 0
              ? ` · ${coverage.extractedDocuments} extracted`
              : ''}
            {ocrProgress?.coverageReady && ocrCoverage && ocrCoverage.extractedDocuments > 0
              ? ` · ${ocrCoverage.extractedDocuments} OCR`
              : ''}
          </p>
        </div>
        <div className="documents-stage-notice" role="note">
          Showing cataloged documents from your last scan (no rescan required). Local read-only text
          extraction supports .txt, .md, .markdown, .csv, .tsv, .rtf, text PDFs, and .docx; offline
          OCR supports scanned PDFs and explicitly selected document images.
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

          <label htmlFor="documents-purpose-filter" className="visually-hidden">
            Filter by document purpose
          </label>
          <select
            id="documents-purpose-filter"
            data-testid="documents-purpose-filter"
            className="documents-ext-select"
            aria-label="Filter by document purpose"
            value={docs.purposeFilter ?? ''}
            onChange={(e) =>
              docs.setPurposeFilter((e.target.value || null) as DocumentPurposeFilter | null)
            }
          >
            <option value="">All purposes</option>
            {PURPOSE_LABELS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
                {docs.classificationFacets
                  ? ` (${docs.classificationFacets.purposeCounts[p.value]})`
                  : ''}
              </option>
            ))}
            <option value="other">
              Other / No structured match
              {docs.classificationFacets
                ? ` (${docs.classificationFacets.purposeCounts.other})`
                : ''}
            </option>
            <option value="unknown">
              Unclassified / Needs text extraction or OCR
              {docs.classificationFacets
                ? ` (${docs.classificationFacets.purposeCounts.unknown})`
                : ''}
            </option>
          </select>

          <label htmlFor="documents-origin-filter" className="visually-hidden">
            Filter by document origin
          </label>
          <select
            id="documents-origin-filter"
            data-testid="documents-origin-filter"
            className="documents-ext-select"
            aria-label="Filter by document origin"
            value={docs.originFilter ?? ''}
            onChange={(e) =>
              docs.setOriginFilter((e.target.value || null) as DocumentOriginFilter | null)
            }
          >
            <option value="">All origins</option>
            {ORIGIN_LABELS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
                {docs.classificationFacets
                  ? ` (${docs.classificationFacets.originCounts[o.value]})`
                  : ''}
              </option>
            ))}
            <option value="unknown">
              Unknown
              {docs.classificationFacets
                ? ` (${docs.classificationFacets.originCounts.unknown})`
                : ''}
            </option>
          </select>

          <label htmlFor="documents-clutter-filter" className="visually-hidden">
            Clutter visibility
          </label>
          <select
            id="documents-clutter-filter"
            data-testid="documents-clutter-filter"
            className="documents-ext-select"
            aria-label="Clutter visibility"
            value={docs.clutterFilter}
            onChange={(e) => docs.setClutterFilter(e.target.value as DocumentClutterFilter)}
          >
            <option value="show_all">Show all (default)</option>
            <option value="hide_clutter">Hide clutter</option>
            <option value="only_clutter">Inspect hidden ({docs.hiddenClutterCount})</option>
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

          {docs.totalCount > 0 && !isJobRunning && !isJobPausedOrInterrupted && (
            <button
              type="button"
              className="btn-primary"
              data-testid="documents-extract-scope-btn"
              onClick={() => void docs.startScopeExtraction(hasActiveFilter ? 'filtered' : 'all')}
            >
              {hasActiveFilter ? 'Extract Filtered Text' : 'Extract All Text'}
            </button>
          )}
        </div>
      </div>

      {/* Stage 7C: Offline OCR Setup & Controls */}
      <div
        className="documents-ocr-panel"
        data-testid="documents-ocr-panel"
        aria-label="Offline OCR"
      >
        <div className="documents-ocr-panel-row">
          <div className="documents-ocr-model-summary">
            <strong>Offline OCR (English)</strong>
            <span className="documents-ocr-model-badge" data-testid="ocr-model-state-badge">
              {ocrModel ? ocrModel.state : 'unavailable'}
            </span>
            {ocrModel && (
              <span className="documents-ocr-model-meta">
                {ocrModel.modelId} ({ocrModel.language})
                {isOcrModelInstalling && ocrModel.requiredBytes > 0
                  ? ` — ${formatBytes(ocrModel.downloadedBytes)} / ${formatBytes(ocrModel.requiredBytes)}${ocrModel.currentArtifact ? ` (${ocrModel.currentArtifact})` : ''}`
                  : ''}
              </span>
            )}
          </div>

          <div className="documents-ocr-model-actions">
            {isOcrModelInstalling ? (
              <button
                type="button"
                className="btn-secondary"
                data-testid="ocr-model-cancel-btn"
                onClick={() => void docs.cancelOcrModel()}
              >
                Cancel Model Setup
              </button>
            ) : (
              <>
                {!isOcrModelReady && (
                  <button
                    type="button"
                    className="btn-secondary"
                    data-testid="ocr-model-download-btn"
                    onClick={() => void docs.downloadOcrModel()}
                  >
                    Download English OCR Model
                  </button>
                )}
                <button
                  type="button"
                  className="btn-secondary"
                  data-testid="ocr-model-import-btn"
                  onClick={() => void docs.importOcrModel()}
                >
                  {isOcrModelReady ? 'Re-import Offline Model…' : 'Import Offline Model…'}
                </button>
              </>
            )}

            {docs.totalCount > 0 && !isOcrRunning && !isOcrPausedOrInterrupted && (
              <button
                type="button"
                className="btn-primary"
                data-testid="documents-ocr-scope-btn"
                disabled={!isOcrModelReady}
                title={
                  isOcrModelReady
                    ? 'Run offline OCR on documents needing OCR'
                    : 'Install or import the verified English OCR model first'
                }
                onClick={() => void docs.startScopeOcr(hasActiveFilter ? 'filtered' : 'ocr_needed')}
              >
                {hasActiveFilter ? 'Run OCR (Filtered)' : 'Run OCR'}
              </button>
            )}
          </div>
        </div>

        {ocrProgress && (
          <div
            className="documents-ocr-coverage-row"
            data-testid="documents-ocr-coverage-status"
            role="status"
          >
            {!ocrProgress.coverageReady && ocrProgress.coverageRefreshing && (
              <span>Calculating OCR coverage…</span>
            )}
            {ocrProgress.coverageReady && (
              <span>
                OCR coverage: {ocrProgress.coverage.ocrNeededDocuments} needing OCR ·{' '}
                {ocrProgress.coverage.extractedDocuments} OCR extracted ·{' '}
                {ocrProgress.coverage.totalDocuments} total documents
                {ocrProgress.coverageRefreshing ? ' (Refreshing OCR coverage…)' : ''}
              </span>
            )}
          </div>
        )}

        {(docs.ocrModelActionError || ocrModel?.error || ocrModel?.lastReplacementError) && (
          <div className="notice notice-error" role="alert" data-testid="ocr-model-error-notice">
            <strong>OCR model error:</strong>{' '}
            {docs.ocrModelActionError ?? ocrModel?.error ?? ocrModel?.lastReplacementError}
          </div>
        )}

        {docs.ocrActionError && (
          <div className="notice notice-error" role="alert" data-testid="ocr-action-error-notice">
            <strong>OCR error:</strong> {docs.ocrActionError}
          </div>
        )}
      </div>

      {/* Stage 7E: Offline Document Classification & Clutter Controls */}
      <div
        className="documents-ocr-panel"
        data-testid="documents-classification-panel"
        aria-label="Document Classification"
      >
        <div className="documents-ocr-panel-row">
          <div className="documents-ocr-model-summary">
            <strong>Document Classification (Offline Rules)</strong>
            <span className="documents-ocr-model-badge" data-testid="doc-classify-status-badge">
              {clsProgress ? clsProgress.status : 'idle'}
            </span>
            {clsCoverage && (
              <span className="documents-ocr-model-meta" data-testid="doc-classify-coverage-text">
                {clsCoverage.classifiedDocuments} labeled · {clsCoverage.otherDocuments} other ·{' '}
                {clsCoverage.unknownDocuments + clsCoverage.unclassifiedDocuments} unclassified ·{' '}
                {clsCoverage.hiddenClutterCount} clutter · {clsCoverage.overriddenDocuments}{' '}
                overridden
                {clsProgress?.coverageRefreshing ? ' (Refreshing…)' : ''}
              </span>
            )}
          </div>

          <div className="documents-ocr-model-actions">
            {!isClsRunning && !isClsPausedOrInterrupted && (
              <>
                <button
                  type="button"
                  className="btn-primary"
                  data-testid="documents-classify-start-btn"
                  onClick={() => void docs.startClassification('unclassified_or_stale', false)}
                >
                  Classify Documents
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  data-testid="documents-classify-reclassify-btn"
                  onClick={() => void docs.startClassification('all', true)}
                >
                  Reclassify All
                </button>
              </>
            )}
            {isClsRunning && (
              <>
                <button
                  type="button"
                  className="btn-secondary"
                  data-testid="documents-classify-pause-btn"
                  onClick={() => void docs.pauseClassification()}
                >
                  Pause Classification
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  data-testid="documents-classify-cancel-btn"
                  onClick={() => void docs.cancelClassification()}
                >
                  Cancel Classification
                </button>
              </>
            )}
            {isClsPausedOrInterrupted && (
              <>
                <button
                  type="button"
                  className="btn-primary"
                  data-testid="documents-classify-resume-btn"
                  onClick={() => void docs.resumeClassification()}
                >
                  Resume Classification
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  data-testid="documents-classify-cancel-btn"
                  onClick={() => void docs.cancelClassification()}
                >
                  Cancel Classification
                </button>
              </>
            )}
          </div>
        </div>

        {clsProgress && clsProgress.status !== 'idle' && (
          <div
            className="documents-ocr-coverage-row"
            data-testid="documents-classify-progress"
            role="status"
          >
            <span>
              Classification ({clsProgress.scopeKind ?? 'all'}): {clsProgress.processedItems}/
              {clsProgress.totalItems} processed · {clsProgress.classifiedItems} labeled ·{' '}
              {clsProgress.otherItems} other · {clsProgress.unknownItems} unknown ·{' '}
              {clsProgress.clutterItems} clutter
              {clsProgress.reusedItems > 0 ? ` · ${clsProgress.reusedItems} reused` : ''}
              {clsProgress.skippedStaleItems > 0
                ? ` · ${clsProgress.skippedStaleItems} stale skipped`
                : ''}
              {clsProgress.failedItems > 0 ? ` · ${clsProgress.failedItems} failed` : ''}
            </span>
          </div>
        )}

        {docs.classificationActionError && (
          <div className="notice notice-error" role="alert" data-testid="doc-classify-error-notice">
            <strong>Classification error:</strong> {docs.classificationActionError}
          </div>
        )}
      </div>

      {ocrProgress && ocrProgress.status !== 'idle' && (
        <div
          className="documents-extraction-banner"
          data-testid="documents-ocr-progress"
          role="status"
        >
          <div className="documents-extraction-banner-main">
            <span className="documents-extraction-status-title">
              Offline OCR ({ocrProgress.scopeKind ?? 'ocr_needed'}):{' '}
              <strong>{ocrProgress.status}</strong> — {ocrProgress.processedItems}/
              {ocrProgress.totalItems} processed
              {ocrProgress.extractedItems > 0 ? ` · ${ocrProgress.extractedItems} extracted` : ''}
              {ocrProgress.noTextItems > 0 ? ` · ${ocrProgress.noTextItems} no text` : ''}
              {ocrProgress.reusedItems > 0 ? ` · ${ocrProgress.reusedItems} reused` : ''}
              {ocrProgress.skippedStaleItems > 0
                ? ` · ${ocrProgress.skippedStaleItems} stale skipped`
                : ''}
              {ocrProgress.passwordProtectedItems > 0
                ? ` · ${ocrProgress.passwordProtectedItems} password protected`
                : ''}
              {ocrProgress.unsupportedItems > 0
                ? ` · ${ocrProgress.unsupportedItems} unsupported`
                : ''}
              {ocrProgress.failedItems > 0 ? ` · ${ocrProgress.failedItems} failed` : ''}
              {ocrProgress.truncatedItems > 0 ? ` · ${ocrProgress.truncatedItems} truncated` : ''}
            </span>
            {ocrProgress.lastError && (
              <span className="documents-ocr-last-error">{ocrProgress.lastError}</span>
            )}
            {ocrProgress.totalItems > 0 && (
              <progress
                className="documents-progress-bar"
                value={ocrProgress.processedItems}
                max={ocrProgress.totalItems}
                aria-label="Document OCR progress"
              />
            )}
          </div>
          <div className="documents-extraction-actions">
            {isOcrRunning && (
              <>
                <button
                  type="button"
                  className="btn-secondary"
                  data-testid="ocr-pause-btn"
                  onClick={() => void docs.pauseOcr()}
                >
                  Pause OCR
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  data-testid="ocr-cancel-btn"
                  onClick={() => void docs.cancelOcr()}
                >
                  Cancel OCR
                </button>
              </>
            )}
            {isOcrPausedOrInterrupted && (
              <>
                <button
                  type="button"
                  className="btn-primary"
                  data-testid="ocr-resume-btn"
                  onClick={() => void docs.resumeOcr()}
                >
                  Resume OCR
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  data-testid="ocr-cancel-btn"
                  onClick={() => void docs.cancelOcr()}
                >
                  Cancel OCR
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Stage 7D: Offline Document Semantic Search & Indexing */}
      <div
        className="documents-semantic-panel"
        data-testid="documents-semantic-panel"
        aria-label="Offline Document Semantic Search"
      >
        <div className="documents-ocr-panel-row">
          <div className="documents-ocr-model-summary">
            <strong>Offline Document Search (BGE)</strong>
            <span
              className="documents-ocr-model-badge"
              data-testid="doc-semantic-model-state-badge"
            >
              {docSemModel ? docSemModel.state : 'unavailable'}
            </span>
            {docSemModel && (
              <span className="documents-ocr-model-meta">
                {docSemModel.modelId}
                {isDocSemModelBusy && docSemModel.totalBytes > 0
                  ? ` — ${formatBytes(docSemModel.downloadedBytes)} / ${formatBytes(docSemModel.totalBytes)}${docSemModel.currentFile ? ` (${docSemModel.currentFile})` : ''}`
                  : ''}
              </span>
            )}
          </div>

          <div className="documents-ocr-model-actions">
            {isDocSemModelBusy ? (
              <button
                type="button"
                className="btn-secondary"
                data-testid="doc-semantic-model-cancel-btn"
                onClick={() => void docs.cancelDocSemanticModel()}
              >
                Cancel Model Setup
              </button>
            ) : (
              <>
                {!isDocSemModelReady && (
                  <button
                    type="button"
                    className="btn-primary"
                    data-testid="doc-semantic-model-download-btn"
                    onClick={() => void docs.downloadDocSemanticModel()}
                  >
                    Download Search Model
                  </button>
                )}
                <button
                  type="button"
                  className="btn-secondary"
                  data-testid="doc-semantic-model-import-btn"
                  onClick={() => void docs.importDocSemanticModel()}
                >
                  {isDocSemModelReady ? 'Re-import Model Folder' : 'Import Model Folder'}
                </button>
              </>
            )}

            {isDocSemModelReady && !isDocSemRunning && !isDocSemPausedOrInterrupted && (
              <button
                type="button"
                className="btn-primary"
                data-testid="doc-semantic-index-start-btn"
                onClick={() =>
                  void docs.startDocSemanticIndexing(
                    hasActiveFilter ? 'filtered' : 'unindexed_or_stale'
                  )
                }
              >
                {hasActiveFilter ? 'Index Filtered Docs' : 'Index Documents'}
              </button>
            )}
            {isDocSemRunning && (
              <>
                <button
                  type="button"
                  className="btn-secondary"
                  data-testid="doc-semantic-index-pause-btn"
                  onClick={() => void docs.pauseDocSemanticIndexing()}
                >
                  Pause Indexing
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  data-testid="doc-semantic-index-cancel-btn"
                  onClick={() => void docs.cancelDocSemanticIndexing()}
                >
                  Cancel Indexing
                </button>
              </>
            )}
            {isDocSemPausedOrInterrupted && (
              <>
                <button
                  type="button"
                  className="btn-primary"
                  data-testid="doc-semantic-index-resume-btn"
                  onClick={() => void docs.resumeDocSemanticIndexing()}
                >
                  Resume Indexing
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  data-testid="doc-semantic-index-cancel-btn"
                  onClick={() => void docs.cancelDocSemanticIndexing()}
                >
                  Cancel Indexing
                </button>
              </>
            )}
          </div>
        </div>

        {docSemModel?.errorMessage && (
          <div className="notice notice-error" role="alert">
            {docSemModel.errorMessage}
          </div>
        )}
        {docs.docSemanticModelActionError && (
          <div className="notice notice-error" role="alert">
            {docs.docSemanticModelActionError}
          </div>
        )}
        {docs.docSemanticIndexError && (
          <div className="notice notice-error" role="alert">
            {docs.docSemanticIndexError}
          </div>
        )}

        {docSemProgress && (
          <div className="documents-ocr-coverage-row" data-testid="doc-semantic-coverage">
            {docSemProgress.coverageReady && docSemCoverage ? (
              <span>
                Semantic index: {docSemCoverage.indexedDocuments} docs (
                {docSemCoverage.indexedTracks} tracks) · {docSemCoverage.unindexedTracks} unindexed
                {docSemCoverage.staleTracks > 0 ? ` · ${docSemCoverage.staleTracks} stale` : ''}
                {docSemCoverage.truncatedTracks > 0
                  ? ` · ${docSemCoverage.truncatedTracks} partial`
                  : ''}
                {docSemCoverage.corruptChunks > 0
                  ? ` · ${docSemCoverage.corruptChunks} corrupt chunks excluded`
                  : ''}
                {docSemProgress.coverageRefreshing ? ' · refreshing…' : ''}
              </span>
            ) : (
              <span>Semantic coverage: loading…</span>
            )}
            {docSemProgress.status !== 'idle' && (
              <span data-testid="doc-semantic-job-status">
                Job: <strong>{docSemProgress.status}</strong> ({docSemProgress.processedItems}/
                {docSemProgress.totalItems})
              </span>
            )}
          </div>
        )}

        <form
          className="doc-semantic-search-form"
          data-testid="doc-semantic-search-form"
          onSubmit={(e) => {
            e.preventDefault()
            void docs.runDocSemanticSearch(docSearchDraft, 0)
          }}
        >
          <input
            type="search"
            className="documents-search-input"
            data-testid="doc-semantic-search-input"
            placeholder="Search document meaning (offline)… "
            aria-label="Search document meaning"
            maxLength={500}
            value={docSearchDraft}
            onChange={(e) => setDocSearchDraft(e.target.value)}
          />
          <select
            className="documents-ext-select"
            aria-label="Filter semantic results by source track"
            data-testid="doc-semantic-track-filter"
            value={docs.docSearchTrackFilter ?? ''}
            onChange={(e) =>
              docs.setDocSearchTrackFilter(
                e.target.value === 'native' || e.target.value === 'ocr' ? e.target.value : null
              )
            }
          >
            <option value="">All text tracks</option>
            <option value="native">Native text only</option>
            <option value="ocr">OCR text only</option>
          </select>
          <button
            type="submit"
            className="btn-primary"
            data-testid="doc-semantic-search-submit-btn"
            disabled={
              !isDocSemModelReady || docSearchDraft.trim().length === 0 || docs.isDocSearching
            }
          >
            {docs.isDocSearching ? 'Searching…' : 'Search Meaning'}
          </button>
          {docs.isDocSearching && (
            <button
              type="button"
              className="btn-secondary"
              data-testid="doc-semantic-search-cancel-btn"
              onClick={() => void docs.cancelDocSemanticSearch()}
            >
              Cancel
            </button>
          )}
          {(docs.docSearchResults !== null || docSearchDraft.length > 0 || docs.docSearchError) && (
            <button
              type="button"
              className="btn-secondary"
              data-testid="doc-semantic-search-clear-btn"
              onClick={() => {
                setDocSearchDraft('')
                docs.clearDocSemanticSearch()
              }}
            >
              Clear
            </button>
          )}
        </form>

        <p className="doc-semantic-disclaimer" role="note">
          Semantic matches are machine-inferred similarity scores over local text, not factual
          classifications.
        </p>

        {docs.docSearchError && (
          <div className="notice notice-error" role="alert" data-testid="doc-semantic-search-error">
            {docs.docSearchError}
          </div>
        )}

        {docs.docSearchResults && (
          <div
            className="doc-semantic-results"
            data-testid="doc-semantic-search-results"
            aria-label="Document Semantic Search Results"
          >
            <div className="doc-semantic-results-header">
              <span>
                {docs.docSearchResults.totalMatched} matching{' '}
                {docs.docSearchResults.totalMatched === 1 ? 'document' : 'documents'} ·{' '}
                {docs.docSearchResults.queryLatencyMs} ms
                {docs.docSearchResults.queryTruncated
                  ? ` (query truncated at ${docs.docSearchResults.queryTokenCount} tokens)`
                  : ''}
              </span>
              {docs.docSearchResults.corruptChunkCount > 0 && (
                <span className="notice-inline-warning">
                  {docs.docSearchResults.corruptChunkCount} corrupt chunks excluded
                </span>
              )}
              {(docs.docSearchResults.clutterFilterActive || docs.clutterFilter !== 'show_all') && (
                <span
                  className="notice-inline-warning"
                  data-testid="doc-semantic-clutter-disclosure"
                >
                  Clutter filter active: clutter documents are excluded before semantic ranking.
                </span>
              )}
            </div>

            {docs.docSearchResults.items.length === 0 ? (
              <p className="doc-semantic-empty" data-testid="doc-semantic-search-empty">
                No matching indexed document chunks found.
              </p>
            ) : (
              <ul className="doc-semantic-result-list">
                {docs.docSearchResults.items.map((item) => (
                  <li
                    key={`${item.fileLocationId}:${item.winningChunkId}`}
                    className="doc-semantic-result-card"
                    data-testid={`doc-semantic-result-${item.fileLocationId}`}
                  >
                    <div className="doc-semantic-result-top">
                      <button
                        type="button"
                        className="doc-semantic-result-title-btn"
                        onClick={() => docs.selectDocument(item.fileLocationId)}
                      >
                        {item.fileName}
                      </button>
                      <span className="doc-semantic-score-badge">
                        {Math.round(Math.max(0, item.score) * 100)}% match
                      </span>
                      <span
                        className={`doc-semantic-track-badge doc-semantic-track-${item.textSourceKind}`}
                      >
                        {item.textSourceKind === 'ocr'
                          ? 'OCR text (machine-recognized)'
                          : 'Native text'}
                      </span>
                      {item.truncated && (
                        <span
                          className="doc-semantic-partial-badge"
                          data-testid={`doc-semantic-partial-${item.fileLocationId}`}
                        >
                          Partially indexed: first {item.indexedCharCount.toLocaleString()} of{' '}
                          {item.normalizedCharCount.toLocaleString()} chars (
                          {Math.round(item.coverageRatio * 100)}%)
                        </span>
                      )}
                    </div>
                    <pre className="doc-semantic-snippet">{item.winningSnippet}</pre>
                  </li>
                ))}
              </ul>
            )}

            {(docs.docSearchOffset > 0 || docs.docSearchResults.hasMore) && (
              <div className="doc-semantic-pagination">
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={docs.docSearchOffset === 0 || docs.isDocSearching}
                  onClick={() =>
                    void docs.runDocSemanticSearch(
                      docs.docSearchQuery,
                      Math.max(0, docs.docSearchOffset - docs.limit)
                    )
                  }
                >
                  Previous
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={!docs.docSearchResults.hasMore || docs.isDocSearching}
                  onClick={() =>
                    void docs.runDocSemanticSearch(
                      docs.docSearchQuery,
                      docs.docSearchOffset + docs.limit
                    )
                  }
                >
                  Next
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {docs.extractionActionError && (
        <div className="notice notice-error" role="alert">
          <strong>Extraction error:</strong> {docs.extractionActionError}
        </div>
      )}

      {progress && progress.status !== 'idle' && (
        <div
          className="documents-extraction-banner"
          data-testid="documents-extraction-progress"
          role="status"
        >
          <div className="documents-extraction-banner-main">
            <span className="documents-extraction-status-title">
              Text extraction ({progress.scopeKind ?? 'catalog'}):{' '}
              <strong>{progress.status}</strong> — {progress.processedDocuments}/
              {progress.totalDocuments} processed
              {progress.extractedDocuments > 0 ? ` · ${progress.extractedDocuments} extracted` : ''}
              {progress.noTextDocuments > 0 ? ` · ${progress.noTextDocuments} no text/OCR` : ''}
              {progress.passwordProtectedDocuments > 0
                ? ` · ${progress.passwordProtectedDocuments} password protected`
                : ''}
              {progress.unsupportedDocuments > 0
                ? ` · ${progress.unsupportedDocuments} unsupported`
                : ''}
              {progress.failedDocuments > 0 ? ` · ${progress.failedDocuments} failed` : ''}
              {progress.truncatedDocuments > 0 ? ` · ${progress.truncatedDocuments} truncated` : ''}
            </span>
            {progress.totalDocuments > 0 && (
              <progress
                className="documents-progress-bar"
                value={progress.processedDocuments}
                max={progress.totalDocuments}
                aria-label="Document extraction progress"
              />
            )}
          </div>
          <div className="documents-extraction-actions">
            {isJobRunning && (
              <>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => void docs.pauseExtraction()}
                >
                  Pause
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => void docs.cancelExtraction()}
                >
                  Cancel
                </button>
              </>
            )}
            {isJobPausedOrInterrupted && (
              <>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => void docs.resumeExtraction()}
                >
                  Resume
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => void docs.cancelExtraction()}
                >
                  Cancel
                </button>
              </>
            )}
          </div>
        </div>
      )}

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

      {docs.clutterFilter === 'hide_clutter' && docs.hiddenClutterCount > 0 && (
        <div
          className="notice documents-clutter-banner"
          role="status"
          data-testid="documents-hidden-clutter-banner"
        >
          <span>
            {docs.hiddenClutterCount} clutter{' '}
            {docs.hiddenClutterCount === 1 ? 'document' : 'documents'} hidden in this view.
          </span>
          <div className="documents-clutter-banner-actions">
            <button
              type="button"
              className="btn-secondary"
              data-testid="documents-show-all-btn"
              onClick={() => docs.setClutterFilter('show_all')}
            >
              Show all
            </button>
            <button
              type="button"
              className="btn-secondary"
              data-testid="documents-inspect-hidden-btn"
              onClick={() => docs.setClutterFilter('only_clutter')}
            >
              Inspect hidden ({docs.hiddenClutterCount})
            </button>
          </div>
        </div>
      )}

      {docs.clutterFilter === 'only_clutter' && (
        <div
          className="notice documents-clutter-banner"
          role="status"
          data-testid="documents-inspect-hidden-banner"
        >
          <span>Inspecting hidden clutter documents only.</span>
          <button
            type="button"
            className="btn-secondary"
            data-testid="documents-exit-inspect-btn"
            onClick={() => docs.setClutterFilter('show_all')}
          >
            Show all
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

      {(docs.items.length > 0 || isDetailOpen) && (
        <div className="documents-workspace">
          {docs.items.length > 0 && (
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
                          <span
                            className={`documents-status-badge status-${doc.extractionStatus}`}
                            data-testid={`document-status-${doc.fileLocationId}`}
                          >
                            {formatExtractionStatusLabel(doc.extractionStatus)}
                          </span>
                          {doc.classification && (
                            <>
                              <span
                                className="documents-ext-badge"
                                data-testid={`document-purpose-${doc.fileLocationId}`}
                              >
                                {formatPurposeSummary(doc.classification)}
                              </span>
                              {doc.classification.effectiveOriginLabels.length > 0 && (
                                <span
                                  className="documents-ext-badge"
                                  data-testid={`document-origin-${doc.fileLocationId}`}
                                >
                                  {formatOriginSummary(doc.classification)}
                                </span>
                              )}
                              {doc.classification.isStale && (
                                <span
                                  className="documents-status-badge status-stale"
                                  data-testid={`document-stale-cls-${doc.fileLocationId}`}
                                >
                                  Stale classification
                                </span>
                              )}
                              {doc.classification.hasOverride && (
                                <span
                                  className="documents-status-badge status-extracted"
                                  data-testid={`document-override-badge-${doc.fileLocationId}`}
                                >
                                  User override
                                </span>
                              )}
                              {doc.classification.effectiveIsClutter && (
                                <span
                                  className="documents-status-badge status-unsupported"
                                  data-testid={`document-clutter-badge-${doc.fileLocationId}`}
                                >
                                  Clutter
                                </span>
                              )}
                            </>
                          )}
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
          )}

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
                  <>
                    <div className="documents-detail-actions">
                      <button
                        type="button"
                        className="btn-primary"
                        data-testid="document-extract-selected-btn"
                        disabled={isJobRunning}
                        onClick={() => void docs.extractDocument(docs.detail!.fileLocationId, true)}
                      >
                        {docs.detail.extractionStatus === 'not_extracted'
                          ? 'Extract Text'
                          : 'Re-extract Text'}
                      </button>
                      <button
                        type="button"
                        className="btn-secondary"
                        data-testid="document-ocr-selected-btn"
                        disabled={!isOcrModelReady || isOcrRunning}
                        title={
                          isOcrModelReady
                            ? 'Run offline OCR on this document'
                            : 'Install or import the verified English OCR model first'
                        }
                        onClick={() => void docs.ocrDocument(docs.detail!.fileLocationId, true)}
                      >
                        {docs.ocrState && docs.ocrState.ocrStatus !== 'not_processed'
                          ? 'Re-run OCR'
                          : 'Run OCR'}
                      </button>
                      <button
                        type="button"
                        className="btn-secondary"
                        data-testid="document-classify-selected-btn"
                        disabled={isClsRunning}
                        onClick={() =>
                          void docs.classifyDocument(docs.detail!.fileLocationId, true)
                        }
                      >
                        {docs.detail.classification?.isClassified ? 'Reclassify' : 'Classify'}
                      </button>
                    </div>

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
                        <dd data-testid="document-detail-extraction-status">
                          {formatExtractionStatusLabel(docs.detail.extractionStatus)}
                          {docs.detail.recipeVersion ? ` (${docs.detail.recipeVersion})` : ''}
                        </dd>
                      </div>
                      {docs.detail.extractedAtMs && (
                        <div className="documents-detail-row">
                          <dt>Extracted At</dt>
                          <dd>{formatTimestampOrUnknown(docs.detail.extractedAtMs)}</dd>
                        </div>
                      )}
                      {docs.detail.pageCount !== null && docs.detail.pageCount !== undefined && (
                        <div className="documents-detail-row">
                          <dt>Pages</dt>
                          <dd>{docs.detail.pageCount}</dd>
                        </div>
                      )}
                      {docs.detail.detectedEncoding && (
                        <div className="documents-detail-row">
                          <dt>Encoding</dt>
                          <dd>{docs.detail.detectedEncoding}</dd>
                        </div>
                      )}
                      {docs.detail.statusDetail && (
                        <div className="documents-detail-row">
                          <dt>Extraction Note</dt>
                          <dd data-testid="document-detail-status-detail">
                            {docs.detail.statusDetail}
                          </dd>
                        </div>
                      )}
                    </dl>

                    {docs.detail.classification && (
                      <section
                        className="documents-preview-section documents-classification-section"
                        data-testid="document-classification-section"
                        aria-label="Classification & Inference Provenance"
                      >
                        <h4>Classification &amp; Inference Provenance</h4>
                        <p
                          className="documents-preview-meta"
                          data-testid="doc-classify-effective-summary"
                        >
                          <strong>Purpose:</strong>{' '}
                          {formatPurposeSummary(docs.detail.classification)} ·{' '}
                          <strong>Origin:</strong> {formatOriginSummary(docs.detail.classification)}{' '}
                          · <strong>Clutter:</strong>{' '}
                          {docs.detail.classification.effectiveIsClutter
                            ? 'Clutter candidate'
                            : 'Visible'}
                        </p>

                        <p
                          className="documents-preview-meta"
                          data-testid="doc-classify-provenance-meta"
                        >
                          <strong>State:</strong>{' '}
                          {!docs.detail.classification.isClassified
                            ? 'Unclassified'
                            : docs.detail.classification.isStale
                              ? 'Stale classification (needs reclassification)'
                              : 'Classified'}{' '}
                          · <strong>Confidence:</strong> {docs.detail.classification.confidenceBand}
                          {docs.detail.classification.machineRuleVersion
                            ? ` · Rule: ${docs.detail.classification.machineRuleVersion}`
                            : ''}
                          {docs.detail.classification.machineTextSourceKind
                            ? ` · Source: ${docs.detail.classification.machineTextSourceKind}`
                            : ''}
                          {docs.detail.classification.hasPersonalVeto
                            ? ' · Personal-protection veto active'
                            : ''}
                        </p>

                        {docs.detail.classification.uncertaintyReasons.length > 0 && (
                          <p
                            className="documents-preview-meta"
                            data-testid="doc-classify-uncertainty"
                          >
                            <strong>Uncertainty:</strong>{' '}
                            {docs.detail.classification.uncertaintyReasons.join(', ')}
                          </p>
                        )}

                        {docs.detail.classification.hasStaleOverride && (
                          <div
                            className="notice"
                            role="note"
                            data-testid="doc-classify-stale-override-note"
                          >
                            A previous user override became stale after file content changed.
                          </div>
                        )}

                        {docs.detail.classification.hasUnverifiedOverride && (
                          <div
                            className="notice"
                            role="note"
                            data-testid="doc-classify-unverified-override-note"
                          >
                            A previous user override is pending hash verification on this
                            observation.
                          </div>
                        )}

                        {docs.detail.classification.evidence &&
                          docs.detail.classification.evidence.length > 0 && (
                            <ul
                              className="documents-evidence-list"
                              data-testid="doc-classify-evidence-list"
                            >
                              {docs.detail.classification.evidence.map((ev, idx) => (
                                <li key={`${ev.ruleId}-${idx}`}>
                                  <code>{ev.ruleId}</code> ({ev.axis}: {ev.targetLabel}) —{' '}
                                  {ev.summary}
                                </li>
                              ))}
                            </ul>
                          )}

                        {docs.overrideAckNotice && (
                          <div
                            className={`notice${docs.overrideAckNotice.ok && !docs.overrideAckNotice.persistencePending ? '' : ' notice-error'}`}
                            role={docs.overrideAckNotice.ok ? 'status' : 'alert'}
                            data-testid="doc-classify-override-notice"
                          >
                            <span>{docs.overrideAckNotice.message}</span>
                            <button
                              type="button"
                              className="btn-secondary"
                              onClick={docs.dismissOverrideNotice}
                            >
                              Dismiss
                            </button>
                          </div>
                        )}

                        <div className="documents-detail-actions">
                          {docs.detail.classification.effectiveIsClutter && (
                            <button
                              type="button"
                              className="btn-primary"
                              data-testid="doc-classify-not-clutter-btn"
                              disabled={docs.isSavingOverride}
                              onClick={() =>
                                void docs.setClassificationOverride({
                                  fileLocationId: docs.detail!.fileLocationId,
                                  expectedRevision: docs.detail!.classification!.contentRevision,
                                  expectedOverrideVersion:
                                    docs.detail!.classification!.overrideVersion,
                                  purposeLabels: docs.detail!.classification!.hasOverride
                                    ? docs.detail!.classification!.effectivePurposeLabels
                                    : null,
                                  originLabels: docs.detail!.classification!.hasOverride
                                    ? docs.detail!.classification!.effectiveOriginLabels
                                    : null,
                                  clutterOverride: 'force_keep'
                                })
                              }
                            >
                              Not clutter — Always show
                            </button>
                          )}

                          <button
                            type="button"
                            className="btn-secondary"
                            data-testid="doc-classify-edit-btn"
                            onClick={() =>
                              openOverrideEditor(
                                docs.detail!.classification!,
                                docs.detail!.fileLocationId
                              )
                            }
                          >
                            Edit classification
                          </button>

                          {(docs.detail.classification.hasOverride ||
                            docs.detail.classification.hasStaleOverride ||
                            docs.detail.classification.hasUnverifiedOverride) && (
                            <button
                              type="button"
                              className="btn-secondary"
                              data-testid="doc-classify-reset-override-btn"
                              disabled={docs.isSavingOverride}
                              onClick={() =>
                                void docs.resetClassificationOverride({
                                  fileLocationId: docs.detail!.fileLocationId,
                                  expectedRevision: docs.detail!.classification!.contentRevision,
                                  expectedOverrideVersion:
                                    docs.detail!.classification!.overrideVersion
                                })
                              }
                            >
                              Reset to automatic
                            </button>
                          )}
                        </div>

                        {editingOverrideDocId === docs.detail.fileLocationId && (
                          <div
                            className="documents-override-editor"
                            data-testid="doc-classify-override-editor"
                          >
                            <fieldset className="documents-override-fieldset">
                              <legend>Purpose labels</legend>
                              {PURPOSE_LABELS.map((p) => (
                                <label key={p.value} className="documents-override-checkbox">
                                  <input
                                    type="checkbox"
                                    checked={editPurposeLabels.includes(p.value)}
                                    onChange={(e) => {
                                      setEditPurposeLabels((prev) =>
                                        e.target.checked
                                          ? [...prev, p.value]
                                          : prev.filter((v) => v !== p.value)
                                      )
                                    }}
                                  />
                                  {p.label}
                                </label>
                              ))}
                            </fieldset>

                            <fieldset className="documents-override-fieldset">
                              <legend>Origin labels</legend>
                              {ORIGIN_LABELS.map((o) => (
                                <label key={o.value} className="documents-override-checkbox">
                                  <input
                                    type="checkbox"
                                    checked={editOriginLabels.includes(o.value)}
                                    onChange={(e) => {
                                      setEditOriginLabels((prev) =>
                                        e.target.checked
                                          ? [...prev, o.value]
                                          : prev.filter((v) => v !== o.value)
                                      )
                                    }}
                                  />
                                  {o.label}
                                </label>
                              ))}
                            </fieldset>

                            <label className="documents-override-clutter-select">
                              Clutter visibility override
                              <select
                                data-testid="doc-classify-override-clutter-select"
                                value={editClutterOverride}
                                onChange={(e) =>
                                  setEditClutterOverride(e.target.value as DocumentClutterOverride)
                                }
                              >
                                <option value="inherit">Automatic (inherit rules)</option>
                                <option value="force_keep">Always show (not clutter)</option>
                                <option value="force_clutter">Mark as clutter</option>
                              </select>
                            </label>

                            <div className="documents-detail-actions">
                              <button
                                type="button"
                                className="btn-primary"
                                data-testid="doc-classify-save-override-btn"
                                disabled={docs.isSavingOverride}
                                onClick={async () => {
                                  const ack = await docs.setClassificationOverride({
                                    fileLocationId: docs.detail!.fileLocationId,
                                    expectedRevision: docs.detail!.classification!.contentRevision,
                                    expectedOverrideVersion:
                                      docs.detail!.classification!.overrideVersion,
                                    purposeLabels: editPurposeLabels,
                                    originLabels: editOriginLabels,
                                    clutterOverride: editClutterOverride
                                  })
                                  if (ack?.ok) {
                                    setEditingOverrideDocId(null)
                                  }
                                }}
                              >
                                Save override
                              </button>
                              <button
                                type="button"
                                className="btn-secondary"
                                onClick={() => setEditingOverrideDocId(null)}
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        )}
                      </section>
                    )}

                    <section className="documents-preview-section" aria-label="Extracted text">
                      <div className="documents-preview-header">
                        <h4>Extracted text</h4>
                        {docs.preview && docs.preview.extractedCharCount > 0 && (
                          <span className="documents-preview-meta">
                            {docs.preview.previewCharCount.toLocaleString()} /{' '}
                            {docs.preview.extractedCharCount.toLocaleString()} chars
                          </span>
                        )}
                      </div>

                      {docs.isPreviewLoading && (
                        <p className="documents-detail-status" role="status">
                          Loading extracted text…
                        </p>
                      )}

                      {docs.previewError && (
                        <div className="notice notice-error" role="alert">
                          {docs.previewError}
                        </div>
                      )}

                      {!docs.isPreviewLoading && !docs.previewError && docs.preview && (
                        <>
                          {(docs.preview.extractionTruncated || docs.preview.previewTruncated) && (
                            <div
                              className="documents-truncation-notice"
                              role="note"
                              data-testid="document-preview-truncated-notice"
                            >
                              <strong>Truncated:</strong>{' '}
                              {docs.preview.truncationReason ??
                                'Preview truncated to bounded display length.'}
                            </div>
                          )}

                          {docs.preview.extractedText !== null &&
                          docs.preview.extractedText.length > 0 ? (
                            <pre
                              className="documents-extracted-text"
                              data-testid="document-extracted-text-preview"
                            >
                              {docs.preview.extractedText}
                            </pre>
                          ) : (
                            <p
                              className="documents-preview-empty"
                              data-testid="document-preview-empty-state"
                            >
                              {docs.preview.statusDetail ??
                                (docs.preview.extractionStatus === 'not_extracted'
                                  ? 'Not extracted yet. Click "Extract Text" to extract text locally.'
                                  : `No extracted text available (${formatExtractionStatusLabel(docs.preview.extractionStatus)}).`)}
                            </p>
                          )}
                        </>
                      )}
                    </section>

                    <section
                      className="documents-preview-section"
                      aria-label="OCR text (machine-recognized)"
                      data-testid="document-ocr-section"
                    >
                      <div className="documents-preview-header">
                        <h4>OCR text (machine-recognized)</h4>
                        {docs.ocrPreview && docs.ocrPreview.extractedCharCount > 0 && (
                          <span className="documents-preview-meta">
                            {docs.ocrPreview.previewCharCount.toLocaleString()} /{' '}
                            {docs.ocrPreview.extractedCharCount.toLocaleString()} chars
                          </span>
                        )}
                      </div>

                      {docs.ocrState && (
                        <dl className="documents-detail-list" data-testid="document-ocr-provenance">
                          <div className="documents-detail-row">
                            <dt>OCR Status</dt>
                            <dd data-testid="document-detail-ocr-status">
                              {formatOcrStatusLabel(docs.ocrState.ocrStatus)}
                            </dd>
                          </div>
                          {docs.ocrState.ocrModelId && (
                            <div className="documents-detail-row">
                              <dt>OCR Model</dt>
                              <dd>
                                {docs.ocrState.ocrModelId} ({docs.ocrState.ocrLanguage ?? 'eng'})
                                {docs.ocrState.recipeVersion
                                  ? ` · ${docs.ocrState.recipeVersion}`
                                  : ''}
                              </dd>
                            </div>
                          )}
                          {docs.ocrState.extractionMethod &&
                            docs.ocrState.extractionMethod !== 'none' && (
                              <div className="documents-detail-row">
                                <dt>OCR Method</dt>
                                <dd>{docs.ocrState.extractionMethod}</dd>
                              </div>
                            )}
                          {docs.ocrState.pageCount !== null && (
                            <div className="documents-detail-row">
                              <dt>OCR Pages</dt>
                              <dd>
                                {docs.ocrState.ocrPageCount} OCR / {docs.ocrState.pageCount} total
                                {docs.ocrState.nativeOnlyPageCount > 0
                                  ? ` (${docs.ocrState.nativeOnlyPageCount} native-only)`
                                  : ''}
                                {docs.ocrState.skippedBlankPageCount > 0
                                  ? ` (${docs.ocrState.skippedBlankPageCount} blank skipped)`
                                  : ''}
                              </dd>
                            </div>
                          )}
                          {docs.ocrState.meanConfidence !== null && (
                            <div className="documents-detail-row">
                              <dt>Mean Confidence</dt>
                              <dd>{Math.round(docs.ocrState.meanConfidence)}%</dd>
                            </div>
                          )}
                          {docs.ocrState.extractedAtMs && (
                            <div className="documents-detail-row">
                              <dt>OCR Recorded</dt>
                              <dd>{formatTimestampOrUnknown(docs.ocrState.extractedAtMs)}</dd>
                            </div>
                          )}
                        </dl>
                      )}

                      {docs.isOcrPreviewLoading && (
                        <p className="documents-detail-status" role="status">
                          Loading OCR text…
                        </p>
                      )}

                      {docs.ocrPreviewError && (
                        <div className="notice notice-error" role="alert">
                          {docs.ocrPreviewError}
                        </div>
                      )}

                      {!docs.isOcrPreviewLoading && !docs.ocrPreviewError && docs.ocrPreview && (
                        <>
                          {(docs.ocrPreview.truncated || docs.ocrPreview.previewTruncated) && (
                            <div
                              className="documents-truncation-notice"
                              role="note"
                              data-testid="document-ocr-truncated-notice"
                            >
                              <strong>Truncated:</strong>{' '}
                              {docs.ocrPreview.truncationReason ??
                                'OCR preview truncated to bounded display length.'}
                            </div>
                          )}

                          {docs.ocrPreview.extractedText !== null &&
                          docs.ocrPreview.extractedText.length > 0 ? (
                            <pre
                              className="documents-extracted-text"
                              data-testid="document-ocr-text-preview"
                            >
                              {docs.ocrPreview.extractedText}
                            </pre>
                          ) : (
                            <p
                              className="documents-preview-empty"
                              data-testid="document-ocr-empty-state"
                            >
                              {docs.ocrPreview.statusDetail ??
                                (docs.ocrPreview.ocrStatus === 'not_processed'
                                  ? 'Not OCR-processed yet. Click "Run OCR" when the offline model is ready.'
                                  : `No OCR text available (${formatOcrStatusLabel(docs.ocrPreview.ocrStatus)}).`)}
                            </p>
                          )}
                        </>
                      )}
                    </section>
                  </>
                )}
              </aside>
            </>
          )}
        </div>
      )}
    </section>
  )
}
