/**
 * Personal Vault — Visual Similarity Review Panel (Stage 5C)
 *
 * Implements accessible, side-by-side candidate pair comparison cards,
 * explicit user classification controls, truthful progress / cancellation,
 * paginated browsing, and truthful unknown values for missing facts.
 */

import { useEffect, useState, type ReactElement } from 'react'
import {
  Play,
  XCircle,
  RotateCcw,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Image as ImageIcon,
  Check,
  Ban,
  Star,
  RefreshCw
} from 'lucide-react'
import { useSimilarityReview, computeSimilarityPhotoRevision } from '../hooks/useSimilarityReview'
import type {
  SimilarityCandidatePair,
  SimilarityCandidatePhoto,
  SimilarityDecisionType,
  SimilarityGetPairsFilter
} from '../../../shared/validation/ipc-schemas'

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
    minute: '2-digit'
  })
}

function ComparisonThumbnail({ photo }: { photo: SimilarityCandidatePhoto }): ReactElement {
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [prevPhotoId, setPrevPhotoId] = useState(photo.id)

  if (prevPhotoId !== photo.id) {
    setPrevPhotoId(photo.id)
    setDataUrl(null)
    setLoading(true)
  }

  useEffect(() => {
    let cancelled = false
    if (window.api?.getThumbnail) {
      window.api
        .getThumbnail({
          locationId: photo.id,
          expectedByteSize: photo.byteSize,
          expectedMtimeMs: photo.filesystemMtimeMs,
          priority: 'high'
        })
        .then((res) => {
          if (cancelled) return
          if (res.status === 'ready' && res.dataUrl) {
            setDataUrl(res.dataUrl)
          }
          setLoading(false)
        })
        .catch(() => {
          if (!cancelled) setLoading(false)
        })
    } else {
      Promise.resolve().then(() => {
        if (!cancelled) setLoading(false)
      })
    }
    return () => {
      cancelled = true
    }
  }, [photo.id, photo.byteSize, photo.filesystemMtimeMs])

  if (loading) {
    return (
      <div className="comparison-thumb-box loading" aria-label="Loading thumbnail">
        <span className="loading-spinner" />
      </div>
    )
  }

  if (dataUrl) {
    return (
      <div className="comparison-thumb-box">
        <img
          src={dataUrl}
          alt={`Thumbnail for ${photo.fileName}`}
          className="comparison-thumb-img"
        />
      </div>
    )
  }

  return (
    <div className="comparison-thumb-box placeholder" aria-label="Thumbnail unavailable">
      <ImageIcon size={32} />
    </div>
  )
}

function CandidatePhotoColumn({
  photo,
  label
}: {
  photo: SimilarityCandidatePhoto
  label: string
}): ReactElement {
  const dimensionsStr = photo.width && photo.height ? `${photo.width} × ${photo.height}` : 'Unknown'

  return (
    <div className="similarity-photo-column">
      <div className="column-header">
        <span className="column-label">{label}</span>
        <span className="photo-filename" title={photo.originalPath}>
          {photo.fileName}
        </span>
      </div>

      <ComparisonThumbnail photo={photo} />

      <div className="photo-facts">
        <div className="fact-row">
          <span className="fact-label">Location:</span>
          <span className="fact-value path" title={photo.originalPath}>
            {photo.originalPath}
          </span>
        </div>
        <div className="fact-row">
          <span className="fact-label">Dimensions:</span>
          <span className="fact-value">{dimensionsStr}</span>
        </div>
        <div className="fact-row">
          <span className="fact-label">Size:</span>
          <span className="fact-value">{formatBytes(photo.byteSize)}</span>
        </div>
        <div className="fact-row">
          <span className="fact-label">Modified:</span>
          <span className="fact-value">{formatDate(photo.filesystemMtimeMs)}</span>
        </div>
        <div className="fact-row">
          <span className="fact-label">SHA-256:</span>
          <span className="fact-value hash" title={photo.activeHash ?? 'Unhashed'}>
            {photo.activeHash ? `${photo.activeHash.slice(0, 12)}…` : 'Unknown'}
          </span>
        </div>
        {(photo.rating !== null || (photo.flag && photo.flag !== 'none')) && (
          <div className="fact-row review-tags">
            {photo.rating !== null && (
              <span className="tag rating-tag">
                <Star size={12} fill="currentColor" /> {photo.rating}
              </span>
            )}
            {photo.flag === 'pick' && (
              <span className="tag flag-pick">
                <Check size={12} /> Pick
              </span>
            )}
            {photo.flag === 'reject' && (
              <span className="tag flag-reject">
                <Ban size={12} /> Reject
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function CandidatePairCard({
  pair,
  onDecision
}: {
  pair: SimilarityCandidatePair
  onDecision: (
    pairId: number,
    locationIdA: number,
    locationIdB: number,
    revA: string,
    revB: string,
    decision: SimilarityDecisionType,
    version?: number
  ) => void
}): ReactElement {
  const revA = computeSimilarityPhotoRevision(pair.photoA)
  const revB = computeSimilarityPhotoRevision(pair.photoB)

  const similarityPercent = Math.round(pair.similarityScore * 100)

  let decisionLabel = 'Unreviewed'
  let decisionBadgeClass = 'badge-unreviewed'
  if (pair.decision === 'edited_version') {
    decisionLabel = 'Edited Version'
    decisionBadgeClass = 'badge-edited'
  } else if (pair.decision === 'similar_scene') {
    decisionLabel = 'Similar Scene'
    decisionBadgeClass = 'badge-similar'
  } else if (pair.decision === 'unrelated') {
    decisionLabel = 'Dismissed / Unrelated'
    decisionBadgeClass = 'badge-unrelated'
  }

  return (
    <div className="candidate-pair-card" id={`pair-card-${pair.id}`}>
      <div className="pair-card-header">
        <div className="similarity-score-info">
          <span className="similarity-badge">
            Algorithmic Similarity: <strong>{similarityPercent}%</strong>
          </span>
          <span className="distance-info">
            (Hamming distance: {pair.distance}/64 bits &bull; {pair.algorithmVersion})
          </span>
        </div>
        <span className={`decision-status-badge ${decisionBadgeClass}`}>
          Decision: {decisionLabel}
        </span>
      </div>

      <div className="pair-comparison-row">
        <CandidatePhotoColumn photo={pair.photoA} label="Photo A" />
        <div className="pair-vs-divider" aria-hidden="true">
          <span>vs</span>
        </div>
        <CandidatePhotoColumn photo={pair.photoB} label="Photo B" />
      </div>

      <div className="pair-decision-actions" role="group" aria-label="Pair review decision">
        <button
          type="button"
          data-testid={`decision-edited-${pair.id}`}
          className={`btn-decision ${pair.decision === 'edited_version' ? 'active' : ''}`}
          onClick={() =>
            onDecision(
              pair.id,
              pair.locationIdA,
              pair.locationIdB,
              revA,
              revB,
              'edited_version',
              pair.decisionVersion ?? undefined
            )
          }
          aria-label="Mark as edited versions of the same image"
        >
          Edited Version
        </button>

        <button
          type="button"
          data-testid={`decision-similar-${pair.id}`}
          className={`btn-decision ${pair.decision === 'similar_scene' ? 'active' : ''}`}
          onClick={() =>
            onDecision(
              pair.id,
              pair.locationIdA,
              pair.locationIdB,
              revA,
              revB,
              'similar_scene',
              pair.decisionVersion ?? undefined
            )
          }
          aria-label="Mark as different but visually similar photos"
        >
          Similar Scene
        </button>

        <button
          type="button"
          data-testid={`decision-unrelated-${pair.id}`}
          className={`btn-decision ${pair.decision === 'unrelated' ? 'active' : ''}`}
          onClick={() =>
            onDecision(
              pair.id,
              pair.locationIdA,
              pair.locationIdB,
              revA,
              revB,
              'unrelated',
              pair.decisionVersion ?? undefined
            )
          }
          aria-label="Dismiss as unrelated"
        >
          Dismiss (Unrelated)
        </button>

        {pair.decision !== 'unreviewed' && (
          <button
            type="button"
            data-testid={`decision-clear-${pair.id}`}
            className="btn-decision btn-clear-decision"
            onClick={() =>
              onDecision(
                pair.id,
                pair.locationIdA,
                pair.locationIdB,
                revA,
                revB,
                'unreviewed',
                pair.decisionVersion ?? undefined
              )
            }
            aria-label="Clear decision and return to unreviewed"
          >
            Clear Decision
          </button>
        )}
      </div>
    </div>
  )
}

export function SimilarityReviewPanel(): ReactElement {
  const {
    progress,
    pairs,
    totalCount,
    page,
    totalPages,
    filter,
    isLoadingPairs,
    actionError,
    persistencePending,
    persistenceError,
    startAnalysis,
    cancelAnalysis,
    resumeAnalysis,
    changeFilter,
    goToPage,
    setDecision,
    retryReconciliation
  } = useSimilarityReview()

  const percentComplete =
    progress.totalPhotos > 0
      ? Math.round((progress.processedPhotos / progress.totalPhotos) * 100)
      : 0

  return (
    <div className="similarity-panel-layout">
      {/* Top Header Card */}
      <div className="similarity-header-card">
        <div className="header-info">
          <h2>Visual Similarity Review</h2>
          <p>
            Find and compare visually similar photographs and potential edited derivatives.
            Algorithmic similarity indicates visual closeness and does not prove an edited-copy
            relationship.
          </p>
        </div>

        {/* Action Error Banner */}
        {actionError && (
          <div className="notice notice-error" role="alert">
            <AlertTriangle size={16} />
            <span>{actionError}</span>
          </div>
        )}

        {/* Persistence Pending Banner */}
        {persistencePending && (
          <div className="notice notice-warning" role="alert">
            <AlertTriangle size={16} />
            <span>
              Pending review persistence: {persistenceError || 'Journal append unresolved.'}
            </span>
            <button
              type="button"
              id="retry-similarity-persistence"
              className="btn-small"
              onClick={retryReconciliation}
            >
              <RefreshCw size={14} /> Retry Persistence
            </button>
          </div>
        )}

        {/* Analysis Status & Controls Banner */}
        <div className="analysis-status-box">
          {progress.status === 'idle' && (
            <div className="status-idle">
              <span>Similarity analysis has not been run for the catalog.</span>
              <button
                type="button"
                id="start-similarity-analysis"
                className="btn-primary"
                onClick={startAnalysis}
              >
                <Play size={16} /> Start Similarity Analysis
              </button>
            </div>
          )}

          {progress.status === 'running' && (
            <div className="status-running">
              <div className="progress-bar-container">
                <div className="progress-bar-fill" style={{ width: `${percentComplete}%` }} />
              </div>
              <div className="progress-info-row">
                <span>
                  Analyzing photographs: {progress.processedPhotos} / {progress.totalPhotos} (
                  {percentComplete}%)
                </span>
                <span className="stats-sub">
                  {progress.unsupportedPhotos} unsupported, {progress.errorPhotos} errors,{' '}
                  {progress.candidatePairsFound} candidate pairs
                </span>
                <button
                  type="button"
                  id="cancel-similarity-analysis"
                  className="btn-secondary btn-cancel"
                  onClick={cancelAnalysis}
                >
                  <XCircle size={16} /> Cancel Analysis
                </button>
              </div>
            </div>
          )}

          {progress.status === 'interrupted' && (
            <div className="status-interrupted">
              <div className="alert-interrupted">
                <AlertTriangle size={18} />
                <span>
                  Previous similarity analysis was interrupted ({progress.processedPhotos}/
                  {progress.totalPhotos} processed).
                </span>
              </div>
              <div className="interrupted-actions">
                <button
                  type="button"
                  id="resume-similarity-analysis"
                  className="btn-primary"
                  onClick={resumeAnalysis}
                >
                  <RotateCcw size={16} /> Resume Analysis
                </button>
                <button
                  type="button"
                  id="start-similarity-analysis"
                  className="btn-secondary"
                  onClick={startAnalysis}
                >
                  <Play size={16} /> Start New Run
                </button>
              </div>
            </div>
          )}

          {progress.status === 'cancelled' && (
            <div className="status-cancelled">
              <span>
                Analysis was cancelled ({progress.processedPhotos}/{progress.totalPhotos} analyzed,{' '}
                {progress.candidatePairsFound} candidate pairs found).
              </span>
              <button
                type="button"
                id="start-similarity-analysis"
                className="btn-primary"
                onClick={startAnalysis}
              >
                <RotateCcw size={16} /> Rerun Analysis
              </button>
            </div>
          )}

          {progress.status === 'completed' && (
            <div className="status-completed">
              <span>
                Analysis complete ({progress.totalPhotos} photos analyzed,{' '}
                {progress.candidatePairsFound} candidate pairs found).
              </span>
              <button
                type="button"
                id="start-similarity-analysis"
                className="btn-secondary"
                onClick={startAnalysis}
              >
                <RotateCcw size={16} /> Rerun Analysis
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Filter & Pagination Toolbar */}
      <div className="similarity-toolbar">
        <div className="filter-controls">
          <label htmlFor="similarity-filter-select">Filter Pairs:</label>
          <select
            id="similarity-filter-select"
            value={filter}
            onChange={(e) => changeFilter(e.target.value as SimilarityGetPairsFilter)}
          >
            <option value="all">All Pairs ({totalCount})</option>
            <option value="unreviewed">Unreviewed</option>
            <option value="reviewed">Reviewed</option>
            <option value="edited_version">Edited Versions</option>
            <option value="similar_scene">Similar Scenes</option>
            <option value="unrelated">Dismissed / Unrelated</option>
          </select>
        </div>

        <div className="pagination-controls">
          <span className="page-indicator">
            Page {page} of {totalPages || 1} ({totalCount} pairs)
          </span>
          <button
            type="button"
            id="prev-page-button"
            className="btn-page"
            disabled={page <= 1}
            onClick={() => goToPage(page - 1)}
            aria-label="Previous Page"
          >
            <ChevronLeft size={16} />
          </button>
          <button
            type="button"
            id="next-page-button"
            className="btn-page"
            disabled={totalPages <= page}
            onClick={() => goToPage(page + 1)}
            aria-label="Next Page"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      {/* Candidate Pairs Grid / List */}
      <div className="similarity-pairs-container">
        {isLoadingPairs && (
          <div className="pairs-loading" role="status">
            Loading candidate pairs…
          </div>
        )}

        {!isLoadingPairs && pairs.length === 0 && (
          <div className="pairs-empty-state">
            <p>No similarity candidate pairs found matching the current filter.</p>
          </div>
        )}

        {!isLoadingPairs &&
          pairs.map((pair) => (
            <CandidatePairCard key={pair.id} pair={pair} onDecision={setDecision} />
          ))}
      </div>
    </div>
  )
}
