import { useCallback, useEffect, useState } from 'react'
import type { ScanJobProgress } from '../../../shared/validation/ipc-schemas'

export function useScanJobs() {
  const [job, setJob] = useState<ScanJobProgress | null>(null)
  const [selectedRoots, setSelectedRoots] = useState<string[]>([])
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    const api = window.api
    if (!api) return

    // Query active or interrupted job on startup; if none, query latest terminal job
    api
      .getActiveScanJob()
      .then((res) => {
        if (active && res.job) {
          setJob(res.job)
          return
        }
        return api.getLatestScanJob?.().then((latestRes) => {
          if (active && latestRes?.job) {
            setJob(latestRes.job)
          }
        })
      })
      .catch((err) => {
        if (active) {
          console.error('Failed to query active/latest scan job:', err)
        }
      })

    // Listen to real-time progress events
    const unsubscribe = api.onScanProgress((progress) => {
      if (active) {
        setJob(progress)
      }
    })

    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  const selectRoots = useCallback(async () => {
    const api = window.api
    if (!api) return
    setActionError(null)
    try {
      const res = await api.selectRoots()
      if (!res.cancelled && res.rootPaths.length > 0) {
        setSelectedRoots(res.rootPaths)
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const startScan = useCallback(async () => {
    const api = window.api
    if (!api || selectedRoots.length === 0) return
    setActionError(null)
    try {
      const res = await api.startScan({ roots: selectedRoots })
      if (res.success && res.job) {
        setJob(res.job)
        setSelectedRoots([])
      } else if (res.error) {
        setActionError(res.error)
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    }
  }, [selectedRoots])

  const pauseScan = useCallback(async () => {
    const api = window.api
    if (!api || !job) return
    setActionError(null)
    try {
      const res = await api.pauseScan(job.jobId)
      if (res.job) setJob(res.job)
      if (res.error) setActionError(res.error)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    }
  }, [job])

  const resumeScan = useCallback(async () => {
    const api = window.api
    if (!api || !job) return
    setActionError(null)
    try {
      const res = await api.resumeScan(job.jobId)
      if (res.job) setJob(res.job)
      if (res.error) setActionError(res.error)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    }
  }, [job])

  const cancelScan = useCallback(async () => {
    const api = window.api
    if (!api || !job) return
    setActionError(null)
    try {
      const res = await api.cancelScan(job.jobId)
      if (res.job) setJob(res.job)
      if (res.error) setActionError(res.error)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    }
  }, [job])

  const dismissJob = useCallback(async (jobId: number) => {
    const api = window.api
    if (!api) return
    try {
      if (api.dismissScanJob) {
        await api.dismissScanJob(jobId)
      }
      setJob(null)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const clearRoots = useCallback(() => {
    setSelectedRoots([])
    setActionError(null)
  }, [])

  const clearJob = useCallback(() => {
    setJob(null)
    setActionError(null)
  }, [])

  return {
    job,
    selectedRoots,
    actionError,
    selectRoots,
    startScan,
    pauseScan,
    resumeScan,
    cancelScan,
    dismissJob,
    clearRoots,
    clearJob
  }
}
