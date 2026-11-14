import { type ReactElement } from 'react'
import {
  Download,
  FolderOpen,
  Play,
  Pause,
  RotateCcw,
  XCircle,
  CheckCircle2,
  AlertTriangle,
  Cpu,
  X
} from 'lucide-react'
import { useSemanticIndex } from '../hooks/useSemanticIndex'

export interface SemanticIndexPanelProps {
  readonly onClose?: () => void
}

function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

export function SemanticIndexPanel({ onClose }: SemanticIndexPanelProps): ReactElement {
  const {
    modelStatus,
    indexProgress,
    actionError,
    isBusy,
    downloadModel,
    importModelFromFolder,
    cancelModelProvisioning,
    startIndexing,
    pauseIndexing,
    resumeIndexing,
    cancelIndexing
  } = useSemanticIndex()

  const isModelReady = modelStatus.state === 'ready'
  const isModelInstalling = modelStatus.state === 'installing'
  const jobStatus = indexProgress.status

  const hasNonIndexedOutcomes =
    indexProgress.unsupportedPhotos > 0 || indexProgress.failedPhotos > 0

  return (
    <section
      className="semantic-index-panel"
      data-testid="semantic-index-panel"
      aria-label="Local Semantic Model and Index Management"
    >
      <div className="semantic-panel-header">
        <div className="semantic-panel-title-row">
          <Cpu size={18} />
          <h3>Local Semantic Index</h3>
          <span
            className={`semantic-badge semantic-badge-${modelStatus.state}`}
            data-testid="semantic-model-state-badge"
          >
            Model: {modelStatus.state.toUpperCase()}
          </span>
        </div>
        {onClose && (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onClose}
            aria-label="Close Semantic Index Panel"
            data-testid="semantic-index-close-btn"
          >
            <X size={14} />
            <span>Close</span>
          </button>
        )}
      </div>

      <p className="semantic-panel-scope-note" data-testid="semantic-scope-note">
        <strong>About Semantic Indexing:</strong> Local indexing computes 512-dimensional visual
        embeddings on CPU to enable <strong>offline semantic search</strong>. Embeddings are derived
        similarity vectors — <strong>not factual labels</strong> — and do not identify every object
        or specific electronic module.
      </p>

      {(actionError ||
        modelStatus.error ||
        modelStatus.lastReplacementError ||
        indexProgress.lastError) && (
        <div
          className="notice notice-error semantic-error-banner"
          role="alert"
          data-testid="semantic-error-banner"
        >
          <AlertTriangle size={16} />
          <div className="notice-content">
            {actionError && <div>{actionError}</div>}
            {modelStatus.error && <div>Model error: {modelStatus.error}</div>}
            {modelStatus.lastReplacementError && (
              <div>
                Replacement attempt failed (existing verified model preserved):{' '}
                {modelStatus.lastReplacementError}
              </div>
            )}
            {indexProgress.lastError && <div>Indexing error: {indexProgress.lastError}</div>}
          </div>
        </div>
      )}

      <div className="semantic-panel-grid">
        {/* Model Provisioning Card */}
        <div className="semantic-card" data-testid="semantic-model-card">
          <div className="semantic-card-header">
            <strong>1. Pinned Local Model (`{modelStatus.modelId}`)</strong>
            <span className="semantic-meta-tag">
              Requirement: ~149 MiB ({formatMiB(modelStatus.requiredBytes)}) · CPU ONNX
            </span>
          </div>

          <div className="semantic-card-body">
            <div className="semantic-detail-line">
              <span>Recipe: `{modelStatus.preprocessingVersion}`</span>
              <span>Dimensions: {modelStatus.dimensions}</span>
            </div>

            {isModelInstalling && (
              <div
                className="semantic-install-progress"
                data-testid="semantic-model-install-progress"
              >
                <span>
                  Installing {modelStatus.currentArtifact ?? 'artifacts'}…{' '}
                  {formatMiB(modelStatus.downloadedBytes)} / {formatMiB(modelStatus.requiredBytes)}
                </span>
              </div>
            )}

            <div className="semantic-actions-row">
              {!isModelInstalling && (
                <>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => void downloadModel()}
                    disabled={isBusy}
                    data-testid="semantic-model-download-btn"
                  >
                    <Download size={14} />
                    <span>
                      {isModelReady
                        ? 'Re-verify / Replace via Download (~149 MiB)'
                        : 'Download Verified Model (~149 MiB)'}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => void importModelFromFolder()}
                    disabled={isBusy}
                    data-testid="semantic-model-import-btn"
                  >
                    <FolderOpen size={14} />
                    <span>Import Offline Model Folder</span>
                  </button>
                </>
              )}

              {isModelInstalling && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => void cancelModelProvisioning()}
                  data-testid="semantic-model-cancel-btn"
                >
                  <XCircle size={14} />
                  <span>Cancel Installation</span>
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Resumable Semantic Indexing Card */}
        <div className="semantic-card" data-testid="semantic-index-card">
          <div className="semantic-card-header">
            <strong>2. Resumable Catalog Photo Indexing</strong>
            <span
              className={`semantic-badge semantic-job-badge-${jobStatus}`}
              data-testid="semantic-index-job-status"
            >
              Status: {jobStatus.toUpperCase()}
            </span>
          </div>

          <div className="semantic-card-body">
            <div className="semantic-detail-line" data-testid="semantic-index-coverage">
              <span>
                Current Catalog Coverage:{' '}
                <strong>
                  {indexProgress.currentIndexedPhotos.toLocaleString()} /{' '}
                  {indexProgress.totalCatalogPhotos.toLocaleString()}
                </strong>{' '}
                photos indexed
              </span>
              {indexProgress.jobId && (
                <span>
                  Job Scope: {indexProgress.processedPhotos.toLocaleString()} /{' '}
                  {indexProgress.totalPhotos.toLocaleString()}
                </span>
              )}
            </div>

            <div className="semantic-detail-line" data-testid="semantic-index-summary">
              <span>
                {indexProgress.processedPhotos} indexed ({indexProgress.reusedPhotos} reused) ·{' '}
                {indexProgress.unsupportedPhotos} unsupported · {indexProgress.failedPhotos} failed
                · {indexProgress.pendingPhotos} pending
              </span>
              {jobStatus === 'completed' &&
                !hasNonIndexedOutcomes &&
                indexProgress.totalPhotos > 0 && (
                  <span className="semantic-outcome-ok">
                    <CheckCircle2 size={14} /> All {indexProgress.processedPhotos} snapshotted
                    photos indexed
                  </span>
                )}
              {jobStatus === 'completed' && hasNonIndexedOutcomes && (
                <span className="semantic-outcome-partial">
                  <AlertTriangle size={14} /> Completed with partial coverage:{' '}
                  {indexProgress.processedPhotos} of {indexProgress.totalPhotos} indexed (
                  {indexProgress.unsupportedPhotos} unsupported, {indexProgress.failedPhotos}{' '}
                  failed)
                </span>
              )}
            </div>

            <div className="semantic-actions-row">
              {!isModelReady ? (
                <span
                  className="semantic-disabled-hint"
                  data-testid="semantic-index-requires-model"
                >
                  Install or import the verified local model above to enable semantic indexing.
                </span>
              ) : (
                <>
                  {(jobStatus === 'idle' ||
                    jobStatus === 'completed' ||
                    jobStatus === 'cancelled' ||
                    jobStatus === 'failed') && (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => void startIndexing()}
                      data-testid="semantic-index-start-btn"
                    >
                      <Play size={14} />
                      <span>Start Semantic Indexing</span>
                    </button>
                  )}

                  {jobStatus === 'running' && (
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => void pauseIndexing()}
                      data-testid="semantic-index-pause-btn"
                    >
                      <Pause size={14} />
                      <span>Pause</span>
                    </button>
                  )}

                  {(jobStatus === 'paused' || jobStatus === 'interrupted') && (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => void resumeIndexing()}
                      data-testid="semantic-index-resume-btn"
                    >
                      <RotateCcw size={14} />
                      <span>Resume Job Scope</span>
                    </button>
                  )}

                  {(jobStatus === 'running' ||
                    jobStatus === 'paused' ||
                    jobStatus === 'interrupted') && (
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => void cancelIndexing()}
                      data-testid="semantic-index-cancel-btn"
                    >
                      <XCircle size={14} />
                      <span>Cancel</span>
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
