import { useEffect, useState, useCallback, useRef } from 'react'
import {
  AlertCircle,
  Archive,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Folder,
  FolderOpen,
  HelpCircle,
  Pause,
  Play,
  RotateCcw,
  ShieldCheck,
  XCircle
} from 'lucide-react'
import type {
  ImportCandidateItem,
  VaultImportJobRecord,
  VaultImportProgress,
  VaultRecord
} from '../../../shared/validation/ipc-schemas'

const CANDIDATES_PER_PAGE = 100

export function VaultImportPanel() {
  const [activeVault, setActiveVault] = useState<VaultRecord | null>(null)
  const [selectedVaultDir, setSelectedVaultDir] = useState<string | null>(null)
  const [vaultNameInput, setVaultNameInput] = useState('Personal Vault')
  const [candidates, setCandidates] = useState<ImportCandidateItem[]>([])
  const [totalCandidates, setTotalCandidates] = useState(0)
  const [candidateOffset, setCandidateOffset] = useState(0)
  const [selectedLocationIds, setSelectedLocationIds] = useState<Set<number>>(new Set())
  const [candidateFilter, setCandidateFilter] = useState<'all' | 'unimported' | 'imported'>('all')
  const [activeJob, setActiveJob] = useState<VaultImportJobRecord | null>(null)
  const [progress, setProgress] = useState<VaultImportProgress | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  const loadTokenRef = useRef(0)

  // 1. Load active vault & latest job on mount
  const loadInitialState = useCallback(async () => {
    setIsLoading(true)
    setActionError(null)
    try {
      if (!window.api) return
      const vaultRes = await window.api.getActiveVault()
      setActiveVault(vaultRes.vault)

      const activeJobRes = await window.api.getActiveImportJob()
      if (activeJobRes.job) {
        setActiveJob(activeJobRes.job)
      } else {
        const latestJobRes = await window.api.getLatestImportJob()
        if (latestJobRes.job && latestJobRes.job.status === 'interrupted') {
          setActiveJob(latestJobRes.job)
        }
      }
    } catch (err) {
      setActionError((err as Error).message)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    let active = true
    const init = async () => {
      await Promise.resolve()
      if (active) {
        void loadInitialState()
      }
    }
    void init()
    return () => {
      active = false
    }
  }, [loadInitialState])

  // 2. Load candidate files when active vault, filter, or page offset changes
  const loadCandidates = useCallback(async () => {
    if (!window.api || !activeVault) {
      setCandidates([])
      setTotalCandidates(0)
      return
    }
    const currentToken = ++loadTokenRef.current
    try {
      const res = await window.api.getImportCandidates({
        vaultId: activeVault.vaultId,
        limit: CANDIDATES_PER_PAGE,
        offset: candidateOffset,
        filter: candidateFilter
      })
      if (currentToken === loadTokenRef.current) {
        setCandidates(res.items)
        setTotalCandidates(res.totalCount)
      }
    } catch (err) {
      if (currentToken === loadTokenRef.current) {
        setActionError((err as Error).message)
      }
    }
  }, [activeVault, candidateFilter, candidateOffset])

  useEffect(() => {
    let active = true
    const run = async () => {
      await Promise.resolve()
      if (active) {
        void loadCandidates()
      }
    }
    void run()
    return () => {
      active = false
    }
  }, [loadCandidates])

  // Reset offset and selection when filter changes
  const handleFilterChange = (filter: 'all' | 'unimported' | 'imported') => {
    setCandidateFilter(filter)
    setCandidateOffset(0)
    setSelectedLocationIds(new Set())
  }

  // 3. Subscribe to real-time progress events
  useEffect(() => {
    if (!window.api) return
    const unsubscribe = window.api.onImportProgress((evt) => {
      setProgress(evt)
      if (
        evt.status === 'completed' ||
        evt.status === 'cancelled' ||
        evt.status === 'failed' ||
        evt.status === 'interrupted'
      ) {
        void loadCandidates()
        void window.api.getLatestImportJob().then((res) => {
          if (res.job) setActiveJob(res.job)
        })
      }
    })
    return () => {
      unsubscribe()
    }
  }, [loadCandidates])

  // Directory selection & functional Change Vault
  const handleSelectDirectory = async () => {
    setActionError(null)
    try {
      const res = await window.api.selectVaultDirectory()
      if (res.selectedDirectory) {
        // Attempt to set as active vault immediately if already initialized
        try {
          const activeRes = await window.api.setActiveVault({ vaultPath: res.selectedDirectory })
          setActiveVault(activeRes.vault)
          setSelectedVaultDir(null)
          setSelectedLocationIds(new Set())
          setCandidateOffset(0)
        } catch {
          // Uninitialized directory; prompt initialization UI
          setSelectedVaultDir(res.selectedDirectory)
        }
      }
    } catch (err) {
      setActionError((err as Error).message)
    }
  }

  // Vault initialization
  const handleInitializeVault = async () => {
    if (!selectedVaultDir) return
    setActionError(null)
    setIsLoading(true)
    try {
      await window.api.initializeVault({
        vaultPath: selectedVaultDir,
        vaultName: vaultNameInput.trim() || 'Personal Vault'
      })
      const activeRes = await window.api.setActiveVault({ vaultPath: selectedVaultDir })
      setActiveVault(activeRes.vault)
      setSelectedVaultDir(null)
      setSelectedLocationIds(new Set())
      setCandidateOffset(0)
    } catch (err) {
      setActionError((err as Error).message)
    } finally {
      setIsLoading(false)
    }
  }

  // Selection toggles
  const handleToggleSelectAll = () => {
    if (selectedLocationIds.size === candidates.length) {
      setSelectedLocationIds(new Set())
    } else {
      setSelectedLocationIds(new Set(candidates.map((c) => c.fileLocationId)))
    }
  }

  const handleToggleItem = (id: number) => {
    setSelectedLocationIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  // Import actions
  const handleStartImport = async () => {
    if (!activeVault || selectedLocationIds.size === 0) return
    setActionError(null)
    try {
      const res = await window.api.startImport({
        vaultId: activeVault.vaultId,
        fileLocationIds: Array.from(selectedLocationIds)
      })
      setActiveJob(res.job)
      setSelectedLocationIds(new Set())
    } catch (err) {
      setActionError((err as Error).message)
    }
  }

  const handlePauseImport = async () => {
    try {
      const res = await window.api.pauseImport()
      if (res.job) setActiveJob(res.job)
    } catch (err) {
      setActionError((err as Error).message)
    }
  }

  const handleResumeImport = async () => {
    try {
      const res = await window.api.resumeImport(activeJob?.id)
      if (res.job) setActiveJob(res.job)
    } catch (err) {
      setActionError((err as Error).message)
    }
  }

  const handleCancelImport = async () => {
    try {
      const res = await window.api.cancelImport()
      if (res.job) setActiveJob(res.job)
    } catch (err) {
      setActionError((err as Error).message)
    }
  }

  const selectedBytes = candidates
    .filter((c) => selectedLocationIds.has(c.fileLocationId))
    .reduce((acc, c) => acc + c.byteSize, 0)

  const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const totalPages = Math.ceil(totalCandidates / CANDIDATES_PER_PAGE) || 1
  const currentPage = Math.floor(candidateOffset / CANDIDATES_PER_PAGE) + 1

  return (
    <div className="vault-panel-container">
      {/* 1. Distinct Operations Notice */}
      <div className="vault-notice-card" role="region" aria-label="Operations Distinction">
        <div className="vault-notice-header">
          <HelpCircle size={18} className="notice-icon" aria-hidden="true" />
          <strong>Operations Distinction & Source Preservation</strong>
        </div>
        <p>
          Verified vault copying copies selected originals into managed vault storage, verifies
          byte-for-byte SHA-256 integrity, and generates portable metadata sidecars.
          <strong> Catalog removal</strong>, <strong>vault-copy deletion</strong>, and
          <strong> original deletion</strong> are distinct operations. Your original files remain
          strictly read-only and will never be touched, modified, or deleted.
        </p>
      </div>

      {actionError && (
        <div className="notice notice-error" role="alert">
          <AlertCircle size={16} aria-hidden="true" />
          <span>{actionError}</span>
        </div>
      )}

      {/* 2. Vault Storage Setup Card (when uninitialized or initializing new directory) */}
      {(!activeVault || selectedVaultDir) && (
        <div className="vault-setup-card">
          <div className="setup-header">
            <Archive size={24} className="setup-icon" aria-hidden="true" />
            <div>
              <h2>Vault Storage Setup</h2>
              <p>Choose and initialize a local folder to store your verified vault copies.</p>
            </div>
          </div>

          <div className="setup-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleSelectDirectory}
              disabled={isLoading}
            >
              <FolderOpen size={16} aria-hidden="true" />
              <span>Choose Vault Directory</span>
            </button>

            {selectedVaultDir && (
              <div className="setup-init-row">
                <span className="selected-path">{selectedVaultDir}</span>
                <input
                  type="text"
                  className="input-vault-name"
                  value={vaultNameInput}
                  onChange={(e) => setVaultNameInput(e.target.value)}
                  placeholder="Vault Name"
                  aria-label="Vault Name"
                />
                <button
                  type="button"
                  className="btn btn-accent"
                  onClick={handleInitializeVault}
                  disabled={isLoading}
                >
                  <ShieldCheck size={16} aria-hidden="true" />
                  <span>Initialize Vault</span>
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {activeVault && (
        <div className="vault-active-card">
          <div className="vault-info">
            <div className="vault-badge">
              <ShieldCheck size={16} aria-hidden="true" />
              <span>Active Vault</span>
            </div>
            <h3>{activeVault.name}</h3>
            <p className="vault-path" title={activeVault.vaultPath}>
              <Folder size={14} aria-hidden="true" />
              <span>{activeVault.vaultPath}</span>
            </p>
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={handleSelectDirectory}
          >
            Change Vault
          </button>
        </div>
      )}

      {/* 3. Active Job / Recovery Card */}
      {activeJob && (
        <div
          className={`vault-job-card ${activeJob.status === 'interrupted' ? 'job-interrupted' : ''}`}
        >
          <div className="job-header">
            <h4>
              {activeJob.status === 'interrupted'
                ? 'Import Interrupted'
                : activeJob.status === 'completed'
                  ? 'Import Completed'
                  : activeJob.status === 'failed'
                    ? 'Import Failed'
                    : 'Import in Progress'}
            </h4>
            <span className={`status-badge status-${activeJob.status}`}>{activeJob.status}</span>
          </div>

          {activeJob.status === 'interrupted' && (
            <div className="job-recovery-banner">
              <p>
                An earlier import was interrupted. Resuming will safely complete remaining items.
              </p>
              <button type="button" className="btn btn-primary btn-sm" onClick={handleResumeImport}>
                <RotateCcw size={14} aria-hidden="true" />
                <span>Resume Import</span>
              </button>
            </div>
          )}

          {activeJob.status === 'running' && (
            <div className="job-progress-section">
              <div
                role="progressbar"
                className="progressbar-track"
                aria-valuenow={
                  progress
                    ? Math.round((progress.copiedFiles / Math.max(progress.totalFiles, 1)) * 100)
                    : 0
                }
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  className="progressbar-fill"
                  style={{
                    width: `${
                      progress
                        ? Math.round(
                            (progress.copiedFiles / Math.max(progress.totalFiles, 1)) * 100
                          )
                        : 0
                    }%`
                  }}
                />
              </div>
              <div className="job-stats-row">
                <span>
                  {progress?.copiedFiles ?? 0} of {activeJob.totalFiles} files copied
                </span>
                <span>
                  {progress?.currentFileName ? `Copying: ${progress.currentFileName}` : ''}
                </span>
              </div>
              <div className="job-controls">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={handlePauseImport}
                >
                  <Pause size={14} aria-hidden="true" />
                  <span>Pause</span>
                </button>
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  onClick={handleCancelImport}
                >
                  <XCircle size={14} aria-hidden="true" />
                  <span>Cancel</span>
                </button>
              </div>
            </div>
          )}

          {activeJob.status === 'paused' && (
            <div className="job-controls">
              <button type="button" className="btn btn-primary btn-sm" onClick={handleResumeImport}>
                <Play size={14} aria-hidden="true" />
                <span>Resume</span>
              </button>
              <button type="button" className="btn btn-danger btn-sm" onClick={handleCancelImport}>
                <XCircle size={14} aria-hidden="true" />
                <span>Cancel</span>
              </button>
            </div>
          )}

          {/* Truthful job status banners */}
          {activeJob.status === 'failed' && (
            <div className="job-completed-banner job-failed-banner" role="alert">
              <XCircle size={16} className="text-danger" aria-hidden="true" />
              <span>
                Import Failed: {activeJob.failedFiles} files failed to copy or verify.
                {activeJob.errorMessage ? ` (${activeJob.errorMessage})` : ''}
              </span>
            </div>
          )}

          {activeJob.status === 'completed' && activeJob.failedFiles > 0 && (
            <div className="job-completed-banner job-partial-banner" role="status">
              <AlertCircle size={16} className="text-warning" aria-hidden="true" />
              <span>
                Completed with Failures: {activeJob.verifiedFiles} files copied,{' '}
                {activeJob.failedFiles} failed.
              </span>
            </div>
          )}

          {activeJob.status === 'completed' && activeJob.failedFiles === 0 && (
            <div className="job-completed-banner" role="status">
              <CheckCircle2 size={16} className="text-success" aria-hidden="true" />
              <span>
                Verified Success: All {activeJob.verifiedFiles} files verified and published with
                portable metadata.
              </span>
            </div>
          )}
        </div>
      )}

      {/* 4. Scope and Candidates Selection Table */}
      {activeVault && (
        <div className="vault-scope-card">
          <div className="scope-header">
            <div>
              <h3>Select Originals for Verified Vault Copying</h3>
              <p>
                Destination: <strong title={activeVault.vaultPath}>{activeVault.vaultPath}</strong>
              </p>
            </div>

            <div className="scope-actions">
              <div className="filter-pill-group">
                <button
                  type="button"
                  className={`filter-pill ${candidateFilter === 'all' ? 'active' : ''}`}
                  onClick={() => handleFilterChange('all')}
                >
                  All ({totalCandidates})
                </button>
                <button
                  type="button"
                  className={`filter-pill ${candidateFilter === 'unimported' ? 'active' : ''}`}
                  onClick={() => handleFilterChange('unimported')}
                >
                  Not in Vault
                </button>
                <button
                  type="button"
                  className={`filter-pill ${candidateFilter === 'imported' ? 'active' : ''}`}
                  onClick={() => handleFilterChange('imported')}
                >
                  In Vault
                </button>
              </div>

              <button
                type="button"
                className="btn btn-primary"
                onClick={handleStartImport}
                disabled={selectedLocationIds.size === 0 || activeJob?.status === 'running'}
              >
                <ShieldCheck size={16} aria-hidden="true" />
                <span>
                  Start Verified Import ({selectedLocationIds.size} files,{' '}
                  {formatBytes(selectedBytes)})
                </span>
              </button>
            </div>
          </div>

          <div className="candidates-table-wrap">
            <table className="candidates-table" aria-label="Cataloged Files for Import">
              <thead>
                <tr>
                  <th style={{ width: 40 }}>
                    <input
                      type="checkbox"
                      aria-label="Select all files"
                      checked={
                        candidates.length > 0 && selectedLocationIds.size === candidates.length
                      }
                      onChange={handleToggleSelectAll}
                    />
                  </th>
                  <th>File Name</th>
                  <th>Original Path</th>
                  <th>Category</th>
                  <th>Size</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {candidates.length === 0 && (
                  <tr>
                    <td colSpan={6} className="text-center text-muted">
                      No cataloged files matching the active filter.
                    </td>
                  </tr>
                )}
                {candidates.map((c) => {
                  const isSelected = selectedLocationIds.has(c.fileLocationId)
                  return (
                    <tr
                      key={c.fileLocationId}
                      className={isSelected ? 'row-selected' : ''}
                      onClick={() => handleToggleItem(c.fileLocationId)}
                    >
                      <td onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label={`Select ${c.fileName}`}
                          checked={isSelected}
                          onChange={() => handleToggleItem(c.fileLocationId)}
                        />
                      </td>
                      <td className="cell-filename">{c.fileName}</td>
                      <td className="cell-path" title={c.originalPath}>
                        {c.originalPath}
                      </td>
                      <td className="cell-category">
                        <span className="badge-category">{c.category}</span>
                      </td>
                      <td className="cell-size">{formatBytes(c.byteSize)}</td>
                      <td className="cell-status">
                        {c.vaultStatus === 'copied' ? (
                          <span className="badge-vault-copied">
                            <Check size={12} aria-hidden="true" />
                            <span>In Vault</span>
                          </span>
                        ) : (
                          <span className="badge-vault-unimported">Not Imported</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination Controls */}
          {totalCandidates > CANDIDATES_PER_PAGE && (
            <div
              className="pagination-bar"
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginTop: 12
              }}
            >
              <span className="text-sm text-muted">
                Showing {candidateOffset + 1}–
                {Math.min(candidateOffset + CANDIDATES_PER_PAGE, totalCandidates)} of{' '}
                {totalCandidates} files (Page {currentPage} of {totalPages})
              </span>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={candidateOffset === 0}
                  onClick={() => {
                    setCandidateOffset((prev) => Math.max(0, prev - CANDIDATES_PER_PAGE))
                    setSelectedLocationIds(new Set())
                  }}
                >
                  <ChevronLeft size={14} aria-hidden="true" />
                  <span>Previous</span>
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={candidateOffset + CANDIDATES_PER_PAGE >= totalCandidates}
                  onClick={() => {
                    setCandidateOffset((prev) => prev + CANDIDATES_PER_PAGE)
                    setSelectedLocationIds(new Set())
                  }}
                >
                  <span>Next</span>
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
