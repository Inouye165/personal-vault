import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, FolderOpen, RefreshCw, ShieldCheck, XCircle } from 'lucide-react'
import type {
  ExportJobItemRecordDto,
  ExportJobRecordDto
} from '../../../shared/validation/export-schemas'

export interface ExportPanelProps {
  readonly selectedLocationIds: readonly number[]
}

export function ExportPanel({ selectedLocationIds }: ExportPanelProps) {
  const [destinationDir, setDestinationDir] = useState<string>('')
  const [bundleFolderName, setBundleFolderName] = useState<string>('personal-vault-export')
  const [includeOriginalPaths, setIncludeOriginalPaths] = useState<boolean>(false)
  const [includeExtractedText, setIncludeExtractedText] = useState<boolean>(false)
  const [jobs, setJobs] = useState<readonly ExportJobRecordDto[]>([])
  const [activeJob, setActiveJob] = useState<ExportJobRecordDto | null>(null)
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null)
  const [expandedItems, setExpandedItems] = useState<readonly ExportJobItemRecordDto[]>([])
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false)

  const refreshHistory = useCallback(async () => {
    if (typeof window.api?.listExportJobs !== 'function') {
      return
    }
    try {
      const [page, active] = await Promise.all([
        window.api.listExportJobs({ limit: 20, offset: 0 }),
        typeof window.api?.getActiveExportJob === 'function'
          ? window.api.getActiveExportJob()
          : Promise.resolve(null)
      ])
      setJobs(page.items)
      setActiveJob(active)
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to load export history')
    }
  }, [])

  useEffect(() => {
    let active = true
    if (typeof window.api?.listExportJobs === 'function') {
      void Promise.all([
        window.api.listExportJobs({ limit: 20, offset: 0 }),
        typeof window.api?.getActiveExportJob === 'function'
          ? window.api.getActiveExportJob()
          : Promise.resolve(null)
      ])
        .then(([page, currentActive]) => {
          if (!active) return
          setJobs(page.items)
          setActiveJob(currentActive)
        })
        .catch((err) => {
          if (!active) return
          setErrorMessage(err instanceof Error ? err.message : 'Failed to load export history')
        })
    }
    if (typeof window.api?.onExportProgress !== 'function') {
      return () => {
        active = false
      }
    }
    const unsubscribe = window.api.onExportProgress(({ job }) => {
      setActiveJob(job.status === 'running' ? job : null)
      void refreshHistory()
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [refreshHistory])

  const handleSelectDestination = async () => {
    if (typeof window.api?.selectExportDestination !== 'function') return
    setErrorMessage(null)
    try {
      const res = await window.api.selectExportDestination()
      if (!res.canceled && res.directoryPath) {
        setDestinationDir(res.directoryPath)
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to select destination folder')
    }
  }

  const handleStartExport = async () => {
    if (typeof window.api?.startExport !== 'function') return
    setErrorMessage(null)
    setIsSubmitting(true)
    try {
      const created = await window.api.startExport({
        parentDir: destinationDir,
        bundleFolderName: bundleFolderName.trim(),
        fileLocationIds: [...selectedLocationIds],
        privacyOptions: {
          includeOriginalPaths,
          includeExtractedText
        }
      })
      setActiveJob(created)
      await refreshHistory()
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to start export')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleCancelExport = async (jobId: string) => {
    if (typeof window.api?.cancelExport !== 'function') return
    setErrorMessage(null)
    try {
      await window.api.cancelExport(jobId)
      await refreshHistory()
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to cancel export')
    }
  }

  const handleVerifyJob = async (jobId: string) => {
    if (typeof window.api?.verifyExportJob !== 'function') return
    setErrorMessage(null)
    try {
      await window.api.verifyExportJob(jobId)
      await refreshHistory()
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to verify export bundle')
    }
  }

  const handleToggleItems = async (jobId: string) => {
    if (expandedJobId === jobId) {
      setExpandedJobId(null)
      setExpandedItems([])
      return
    }
    if (typeof window.api?.getExportJobItems !== 'function') return
    setErrorMessage(null)
    try {
      const res = await window.api.getExportJobItems({ jobId, limit: 100, offset: 0 })
      setExpandedJobId(jobId)
      setExpandedItems(res.items)
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to load export job items')
    }
  }

  const canStart =
    !isSubmitting &&
    activeJob === null &&
    destinationDir.trim().length > 0 &&
    bundleFolderName.trim().length > 0 &&
    selectedLocationIds.length > 0

  return (
    <section className="vault-card" aria-label="Portable Bundle Export">
      <div className="vault-card-header">
        <div>
          <h3>Selective Portable Export</h3>
          <p className="text-sm text-muted">
            Export selected items with SHA-256 verification and portable metadata sidecars. Original
            source and vault files are never modified; existing destination folders are never
            overwritten.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => void refreshHistory()}
        >
          <RefreshCw size={14} aria-hidden="true" />
          <span>Refresh</span>
        </button>
      </div>

      {errorMessage && (
        <div className="notice notice-error" role="alert">
          <XCircle size={16} aria-hidden="true" />
          <span>{errorMessage}</span>
        </div>
      )}

      <div style={{ display: 'grid', gap: 12, marginTop: 12 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => void handleSelectDestination()}
          >
            <FolderOpen size={14} aria-hidden="true" />
            <span>Select Export Folder</span>
          </button>
          <span className="text-sm">
            {destinationDir ? destinationDir : 'No destination folder selected'}
          </span>
        </div>

        <label style={{ display: 'grid', gap: 4, maxWidth: 360 }}>
          <span className="text-sm">Bundle Folder Name</span>
          <input
            type="text"
            value={bundleFolderName}
            onChange={(e) => setBundleFolderName(e.target.value)}
            placeholder="personal-vault-export"
          />
        </label>

        <div style={{ display: 'grid', gap: 6 }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={includeOriginalPaths}
              onChange={(e) => setIncludeOriginalPaths(e.target.checked)}
            />
            <span className="text-sm">Include original source paths in sidecars/manifest</span>
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={includeExtractedText}
              onChange={(e) => setIncludeExtractedText(e.target.checked)}
            />
            <span className="text-sm">Include extracted document text in sidecars</span>
          </label>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={!canStart}
            onClick={() => void handleStartExport()}
          >
            <span>Export Selected ({selectedLocationIds.length})</span>
          </button>
          {activeJob && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => void handleCancelExport(activeJob.id)}
            >
              <span>Cancel Active Export</span>
            </button>
          )}
        </div>
      </div>

      {jobs.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <h4>Export History</h4>
          <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0', display: 'grid', gap: 8 }}>
            {jobs.map((job) => (
              <li
                key={job.id}
                style={{
                  border: '1px solid var(--border-subtle, #333)',
                  borderRadius: 6,
                  padding: 10
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 8,
                    flexWrap: 'wrap'
                  }}
                >
                  <div>
                    <strong>{job.bundleFolderName}</strong>{' '}
                    <span className="text-sm text-muted">({job.status})</span>
                    {job.bundleVerified ? (
                      <span
                        className="text-sm"
                        style={{
                          marginLeft: 8,
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4
                        }}
                      >
                        <CheckCircle2 size={14} aria-hidden="true" />
                        Verified
                      </span>
                    ) : null}
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => void handleVerifyJob(job.id)}
                    >
                      <ShieldCheck size={14} aria-hidden="true" />
                      <span>Verify on Disk</span>
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => void handleToggleItems(job.id)}
                    >
                      <span>{expandedJobId === job.id ? 'Hide Items' : 'View Items'}</span>
                    </button>
                  </div>
                </div>
                <div className="text-sm text-muted" style={{ marginTop: 4 }}>
                  Exported: {job.exportedItems} / {job.totalItems} · Failed: {job.failedItems} ·
                  Cancelled: {job.cancelledItems}
                  {job.incompleteReasons.length > 0
                    ? ` · Incomplete: ${job.incompleteReasons.join(', ')}`
                    : ''}
                </div>
                {expandedJobId === job.id && (
                  <ul style={{ marginTop: 8, paddingLeft: 18 }}>
                    {expandedItems.map((item) => (
                      <li key={item.fileLocationId} className="text-sm">
                        {item.originalFileName} — {item.status}
                        {item.exportedFileName ? ` → ${item.exportedFileName}` : ''}
                        {item.errorMessage ? ` (${item.errorMessage})` : ''}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
