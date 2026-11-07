import {
  FolderSearch,
  AlertTriangle,
  CheckCircle,
  PauseCircle,
  PlayCircle,
  XCircle
} from 'lucide-react'
import type { ScanJobProgress } from '../../../shared/validation/ipc-schemas'

export interface ScanJobsPanelProps {
  readonly job: ScanJobProgress | null
  readonly selectedRoots: readonly string[]
  readonly actionError: string | null
  readonly onSelectRoots: () => void
  readonly onStartScan: () => void
  readonly onPauseScan: () => void
  readonly onResumeScan: () => void
  readonly onCancelScan: () => void
  readonly onClearRoots: () => void
  readonly onClearJob: () => void
}

export function ScanJobsPanel({
  job,
  selectedRoots,
  actionError,
  onSelectRoots,
  onStartScan,
  onPauseScan,
  onResumeScan,
  onCancelScan,
  onClearRoots,
  onClearJob
}: ScanJobsPanelProps) {
  if (!job) {
    return (
      <div className="scan-panel-idle">
        {actionError && (
          <div className="notice notice-error" role="alert">
            <p>{actionError}</p>
          </div>
        )}
        <div className="scan-actions-row">
          <button
            type="button"
            className="btn btn-primary"
            onClick={onSelectRoots}
            aria-label="Select Source Folders"
          >
            <FolderSearch size={16} aria-hidden="true" />
            <span>Select Source Folders</span>
          </button>
        </div>

        {selectedRoots.length > 0 && (
          <div className="selected-roots-container">
            <p className="selected-roots-title">Selected Folders for Scanning:</p>
            <ul className="selected-roots-list">
              {selectedRoots.map((root) => (
                <li key={root} className="root-item">
                  {root}
                </li>
              ))}
            </ul>
            <div className="selected-roots-buttons">
              <button
                type="button"
                className="btn btn-primary"
                onClick={onStartScan}
                aria-label="Start Scan"
              >
                <PlayCircle size={16} aria-hidden="true" />
                <span>Start Scan</span>
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={onClearRoots}
                aria-label="Clear selected folders"
              >
                Clear
              </button>
            </div>
          </div>
        )}
      </div>
    )
  }

  // Calculate percentage
  let percentage = 0
  const isCompleted = job.status === 'completed'
  const hasErrors = job.errorCount > 0

  if (isCompleted) {
    if (job.totalFilesToHash > 0) {
      percentage = Math.min(100, Math.round((job.hashedCount / job.totalFilesToHash) * 100))
    } else {
      percentage = hasErrors ? 0 : 100
    }
  } else if (job.phase === 'hashing' && job.totalFilesToHash > 0) {
    percentage = Math.min(100, Math.round((job.hashedCount / job.totalFilesToHash) * 100))
  } else if (job.discoveredCount > 0) {
    percentage =
      job.totalFilesToHash > 0 ? Math.round((job.hashedCount / job.totalFilesToHash) * 100) : 10
  }

  return (
    <div className="scan-panel-active" aria-label="Scan job details">
      {actionError && (
        <div className="notice notice-error" role="alert">
          <p>{actionError}</p>
        </div>
      )}

      {isCompleted && hasErrors && (
        <div className="notice notice-warning" role="alert">
          <AlertTriangle size={18} aria-hidden="true" />
          <div>
            <strong>Scan Completed with Errors</strong>
            <p>
              {job.errorMessage || `${job.errorCount} file(s) encountered errors during the scan.`}{' '}
              Healthy files have been indexed and verified.
            </p>
          </div>
        </div>
      )}

      {job.status === 'interrupted' && (
        <div className="notice notice-warning" role="alert">
          <AlertTriangle size={18} aria-hidden="true" />
          <div>
            <strong>Scan Interrupted</strong>
            <p>
              A previous scan was interrupted when the application was closed. Committed catalog
              facts and verified hashes have been preserved. You can resume scanning.
            </p>
          </div>
        </div>
      )}

      {job.status === 'failed' && (
        <div className="notice notice-error" role="alert">
          <XCircle size={18} aria-hidden="true" />
          <div>
            <strong>Scan Failed</strong>
            <p>{job.errorMessage || 'An unexpected error occurred during the scan.'}</p>
          </div>
        </div>
      )}

      <div className="scan-header">
        <div className="scan-title-row">
          <h3 className="scan-title">Source Scan</h3>
          <span
            className={`status-badge ${isCompleted && hasErrors ? 'status-warning' : `status-${job.status}`}`}
          >
            {job.status === 'running' && <span className="status-dot ready" aria-hidden="true" />}
            {job.status === 'paused' && <PauseCircle size={14} aria-hidden="true" />}
            {isCompleted && !hasErrors && <CheckCircle size={14} aria-hidden="true" />}
            {isCompleted && hasErrors && <AlertTriangle size={14} aria-hidden="true" />}
            {job.status === 'interrupted' && <AlertTriangle size={14} aria-hidden="true" />}
            <span className="status-text">
              {isCompleted && hasErrors ? 'Completed with errors' : job.status}
            </span>
          </span>
        </div>
        <p className="scan-phase-text">
          Phase: <strong>{job.phase}</strong>
        </p>
      </div>

      <div
        className="scan-progress-bar"
        role="progressbar"
        aria-valuenow={percentage}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Scan progress"
      >
        <div
          className={`scan-progress-fill ${isCompleted && hasErrors ? 'completed-with-errors' : job.status}`}
          style={{ width: `${percentage}%` }}
        />
      </div>

      <div className="scan-stats-grid">
        <div className="scan-stat-card">
          <span className="stat-label">Discovered Files</span>
          <span className="stat-value">{job.discoveredCount}</span>
        </div>
        <div className="scan-stat-card">
          <span className="stat-label">Hashed Files</span>
          <span className="stat-value">
            {job.hashedCount} / {job.totalFilesToHash || job.discoveredCount}
          </span>
        </div>
        <div className="scan-stat-card">
          <span className="stat-label">Skipped</span>
          <span className="stat-value">{job.skippedCount}</span>
        </div>
        <div className="scan-stat-card">
          <span className="stat-label">Errors</span>
          <span className={`stat-value ${job.errorCount > 0 ? 'text-error' : ''}`}>
            {job.errorCount}
          </span>
        </div>
      </div>

      {job.currentPath && (
        <div className="scan-current-file" title={job.currentPath}>
          <span className="current-label">Processing:</span>
          <span className="current-path">{job.currentPath}</span>
        </div>
      )}

      <div className="scan-controls-row">
        {job.status === 'running' && (
          <>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onPauseScan}
              aria-label="Pause scan"
            >
              <PauseCircle size={16} aria-hidden="true" />
              <span>Pause</span>
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={onCancelScan}
              aria-label="Cancel scan"
            >
              <XCircle size={16} aria-hidden="true" />
              <span>Cancel</span>
            </button>
          </>
        )}

        {job.status === 'paused' && (
          <>
            <button
              type="button"
              className="btn btn-primary"
              onClick={onResumeScan}
              aria-label="Resume scan"
            >
              <PlayCircle size={16} aria-hidden="true" />
              <span>Resume</span>
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={onCancelScan}
              aria-label="Cancel scan"
            >
              <XCircle size={16} aria-hidden="true" />
              <span>Cancel</span>
            </button>
          </>
        )}

        {job.status === 'interrupted' && (
          <>
            <button
              type="button"
              className="btn btn-primary"
              onClick={onResumeScan}
              aria-label="Resume scan"
            >
              <PlayCircle size={16} aria-hidden="true" />
              <span>Resume</span>
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onCancelScan}
              aria-label="Cancel scan"
            >
              <span>Dismiss</span>
            </button>
          </>
        )}

        {job.status === 'completed' && (
          <button
            type="button"
            className="btn btn-primary"
            onClick={onClearJob}
            aria-label="Scan another folder"
          >
            <FolderSearch size={16} aria-hidden="true" />
            <span>Scan Another Folder</span>
          </button>
        )}

        {(job.status === 'cancelled' || job.status === 'failed') && (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClearJob}
            aria-label="Dismiss scan"
          >
            <span>Dismiss</span>
          </button>
        )}
      </div>

      {job.errorCount > 0 && job.errors.length > 0 && (
        <div className="scan-errors-box" aria-label="Scan errors">
          <h4 className="errors-title">Scan Errors ({job.errorCount})</h4>
          <ul className="errors-list">
            {job.errors.map((err, index) => (
              <li key={`${err.path}-${index}`} className="error-item">
                <span className="error-code">[{err.code}]</span>
                <span className="error-path">{err.path}</span>
                <span className="error-message">— {err.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
