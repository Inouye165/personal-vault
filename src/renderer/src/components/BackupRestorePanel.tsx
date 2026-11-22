import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Cloud,
  Copy,
  FolderOpen,
  FolderPlus,
  HardDrive,
  KeyRound,
  LogIn,
  LogOut,
  MapPin,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  XCircle
} from 'lucide-react'
import type {
  BackupDestinationRecordDto,
  BackupGoogleDriveAuthStatusDto,
  BackupGoogleDriveFolderDto,
  BackupJobRecordDto,
  BackupJobStatusDto,
  BackupRecoverCatalogResponse,
  BackupRecoveryPointSummary,
  BackupRestoreResponse,
  BackupVerifyRecoveryPointResponse
} from '../../../shared/validation/backup-ipc-schemas'

type StorageType = 'usb' | 'nas' | 'google_drive'
type RepoLoadState = 'idle' | 'loading' | 'loaded' | 'error'

interface VerifiedSnapshotInfo {
  readonly verifiedAtMs: number
  readonly result: BackupVerifyRecoveryPointResponse
}

function getDestinationLocationLabel(dest: BackupDestinationRecordDto): string {
  if (dest.kind === 'google_drive') {
    return dest.targetPath ? `Google Drive folder (${dest.targetPath})` : 'Google Drive'
  }
  return dest.targetPath ?? '—'
}

function getDestinationTargetKey(
  dest: BackupDestinationRecordDto | null | undefined,
  repoDir: string
): string {
  if (dest?.kind === 'google_drive') {
    return dest.targetPath ? `gdrive:${dest.targetPath}` : ''
  }
  const trimmed = repoDir.trim()
  return trimmed ? `dir:${trimmed}` : ''
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`
}

function formatTimestamp(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—'
  return new Date(ms).toLocaleString()
}

function formatVaultFileCount(count: number | null | undefined): string {
  if (count === null || count === undefined) return 'File count unavailable'
  if (count === 0) return '0 vault files (catalog only)'
  return `${count} ${count === 1 ? 'vault file' : 'vault files'}`
}

function hasInitializedVault(rp: BackupRecoveryPointSummary | null): boolean {
  return (
    rp !== null && (rp.vaultName !== null || (rp.vaultCopyCount !== null && rp.vaultCopyCount > 0))
  )
}

function joinChildPath(parentDir: string, childName: string): string {
  const trimmed = parentDir.trim().replace(/[\\/]+$/, '')
  if (!trimmed) return ''
  const sep = trimmed.includes('\\') || /^[a-zA-Z]:/.test(trimmed) ? '\\' : '/'
  return `${trimmed}${sep}${childName}`
}

function getPlainJobHeadline(job: BackupJobRecordDto): string {
  if (job.status === 'paused' && job.errorCode === 'wrong_recovery_secret') {
    return 'Backup paused — incorrect recovery secret'
  }
  if (job.status === 'paused' && job.errorCode === 'recovery_secret_required') {
    return 'Backup paused — recovery secret required'
  }
  if (job.status === 'paused' && job.pauseReason === 'daily_budget_exhausted') {
    return 'Backup paused — daily upload budget reached'
  }
  if (
    (job.status === 'queued_destination_unavailable' ||
      (job.status === 'paused' && job.pauseReason === 'destination_unavailable')) &&
    job.errorCode === 'destination_access_denied'
  ) {
    return 'Backup paused — Google Drive authorization expired'
  }
  if (
    job.status === 'queued_destination_unavailable' ||
    (job.status === 'paused' && job.pauseReason === 'destination_unavailable')
  ) {
    return 'Backup paused — destination disconnected'
  }
  switch (job.status) {
    case 'capturing':
      return 'Preparing backup…'
    case 'running':
      return 'Backup in progress'
    case 'paused':
      return 'Backup paused'
    case 'interrupted':
      return 'Backup interrupted'
    case 'completed':
      return 'Backup completed successfully'
    case 'cancelled':
      return 'Backup cancelled'
    case 'failed':
      return 'Backup failed'
    case 'abandoned':
      return 'Backup could not resume'
  }
}

function getPlainPauseOrFailureDetail(job: BackupJobRecordDto): string | null {
  if (job.errorCode === 'wrong_recovery_secret') {
    return 'The recovery secret did not match this backup repository. Enter the correct recovery secret, then click Resume.'
  }
  if (job.errorCode === 'recovery_secret_required') {
    return 'Enter your encryption recovery secret, then click Resume.'
  }
  if (job.errorCode === 'destination_access_denied') {
    return 'Google Drive authorization expired or was revoked. Reconnect your Google Drive account, then click Resume.'
  }
  if (
    job.status === 'queued_destination_unavailable' ||
    (job.status === 'paused' && job.pauseReason === 'destination_unavailable')
  ) {
    return 'The backup drive or network folder is disconnected. Reconnect it, then click Resume.'
  }
  if (job.status === 'paused') {
    if (job.pauseReason === 'daily_budget_exhausted') {
      return 'Paused because the rolling 24-hour upload budget was reached. Resume when budget becomes available or increase the daily budget.'
    }
    if (job.pauseReason === 'metered_network') {
      return 'Paused while on a metered network connection.'
    }
    if (job.pauseReason === 'provider_quota') {
      return 'Paused because the destination storage quota was reached.'
    }
    return 'Backup is paused. Click Resume when you are ready to continue.'
  }
  if (job.status === 'interrupted') {
    return 'This backup was interrupted before finishing. Click Resume to continue from where it stopped.'
  }
  if (job.status === 'failed') {
    return job.errorMessage ?? 'An unexpected error prevented the backup from finishing.'
  }
  if (job.status === 'abandoned') {
    return job.errorMessage ?? 'This backup could not be resumed. Start a new backup instead.'
  }
  return null
}

function getStatusPillClass(status: BackupJobStatusDto): string {
  if (status === 'completed') return 'backup-status-pill backup-status-pill-success'
  if (status === 'failed' || status === 'abandoned') {
    return 'backup-status-pill backup-status-pill-error'
  }
  if (
    status === 'paused' ||
    status === 'interrupted' ||
    status === 'queued_destination_unavailable'
  ) {
    return 'backup-status-pill backup-status-pill-warn'
  }
  return 'backup-status-pill'
}

export function BackupRestorePanel() {
  const [storageType, setStorageType] = useState<StorageType>('usb')
  const [destName, setDestName] = useState<string>('USB Backup Drive')
  const [destPath, setDestPath] = useState<string>('')
  const [nasRateCapMiB, setNasRateCapMiB] = useState<string>('10')
  const [driveRateCapMiB, setDriveRateCapMiB] = useState<string>('')
  const [driveDailyBudgetMiB, setDriveDailyBudgetMiB] = useState<string>('1024')
  const [isEditingLocation, setIsEditingLocation] = useState<boolean>(false)

  // Google Drive account & folder state
  const [gdriveAuth, setGdriveAuth] = useState<BackupGoogleDriveAuthStatusDto | null>(null)
  const [gdriveFolders, setGdriveFolders] = useState<readonly BackupGoogleDriveFolderDto[]>([])
  const [selectedDriveFolderId, setSelectedDriveFolderId] = useState<string>('')
  const [newDriveFolderName, setNewDriveFolderName] = useState<string>('')
  const [isLoadingDriveFolders, setIsLoadingDriveFolders] = useState<boolean>(false)

  // Transient recovery secret inputs (never persisted; cleared immediately on submit)
  const [backupRecoverySecret, setBackupRecoverySecret] = useState<string>('')
  const [restoreRecoverySecret, setRestoreRecoverySecret] = useState<string>('')

  const [destinations, setDestinations] = useState<readonly BackupDestinationRecordDto[]>([])
  const [selectedDestId, setSelectedDestId] = useState<string>('')
  const [jobs, setJobs] = useState<readonly BackupJobRecordDto[]>([])
  const [activeJob, setActiveJob] = useState<BackupJobRecordDto | null>(null)
  const [requestedJob, setRequestedJob] = useState<BackupJobRecordDto | null>(null)
  const refreshVersion = useRef(0)

  const [repoDir, setRepoDir] = useState<string>('')
  const [repoLoadState, setRepoLoadState] = useState<RepoLoadState>('idle')
  const [repoLoadError, setRepoLoadError] = useState<string | null>(null)
  const [recoveryPoints, setRecoveryPoints] = useState<readonly BackupRecoveryPointSummary[]>([])
  const [verifiedByKey, setVerifiedByKey] = useState<Record<string, VerifiedSnapshotInfo>>({})
  const [expandedDetails, setExpandedDetails] = useState<Record<string, boolean>>({})

  // Guided Restore state
  const [restoreRepoDir, setRestoreRepoDir] = useState<string>('')
  const [restoreLoadedRepoDir, setRestoreLoadedRepoDir] = useState<string>('')
  const [useCustomRestoreSource, setUseCustomRestoreSource] = useState<boolean>(false)
  const [restoreRecoveryPoints, setRestoreRecoveryPoints] = useState<
    readonly BackupRecoveryPointSummary[]
  >([])
  const [selectedRestoreSnapshotId, setSelectedRestoreSnapshotId] = useState<string>('')
  const [restoreLocationDir, setRestoreLocationDir] = useState<string>('')
  const [restoreResult, setRestoreResult] = useState<BackupRestoreResponse | null>(null)
  const [copiedCommand, setCopiedCommand] = useState<boolean>(false)

  // Recover catalog from an existing vault state
  const [recoverVaultDir, setRecoverVaultDir] = useState<string>('')
  const [recoverTargetProfileDir, setRecoverTargetProfileDir] = useState<string>('')
  const [recoverResult, setRecoverResult] = useState<BackupRecoverCatalogResponse | null>(null)
  const [copiedRecoverCommand, setCopiedRecoverCommand] = useState<boolean>(false)

  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isBusy, setIsBusy] = useState<boolean>(false)
  const lastCompletedJobIdRef = useRef<string | null>(null)
  const repoLoadSeqRef = useRef(0)
  const restoreLoadSeqRef = useRef(0)

  const loadRecoveryPointsForTarget = useCallback(
    async (
      target: {
        readonly destinationKind?: 'local_fs' | 'google_drive'
        readonly driveFolderId?: string
        readonly backupRepoDir?: string
      },
      forRestoreOnly = false
    ) => {
      const trimmedDir = target.backupRepoDir?.trim() ?? ''
      const driveFolderId = target.driveFolderId?.trim() ?? ''
      const isDrive = target.destinationKind === 'google_drive'
      const targetKey = isDrive
        ? driveFolderId
          ? `gdrive:${driveFolderId}`
          : ''
        : trimmedDir
          ? `dir:${trimmedDir}`
          : ''
      const repoSeq = !forRestoreOnly ? ++repoLoadSeqRef.current : null
      const restoreSeq =
        forRestoreOnly || !useCustomRestoreSource ? ++restoreLoadSeqRef.current : null

      if (!targetKey || typeof window.api?.listRecoveryPoints !== 'function') {
        if (repoSeq !== null && repoSeq === repoLoadSeqRef.current) {
          setRecoveryPoints([])
          setRepoLoadState('idle')
          setRepoLoadError(null)
        }
        if (restoreSeq !== null && restoreSeq === restoreLoadSeqRef.current) {
          setRestoreRecoveryPoints([])
          setRestoreLoadedRepoDir('')
          setSelectedRestoreSnapshotId('')
        }
        return
      }
      if (repoSeq !== null) {
        setRepoLoadState('loading')
        setRepoLoadError(null)
      }
      try {
        const res = await window.api.listRecoveryPoints(
          isDrive
            ? { destinationKind: 'google_drive', driveFolderId }
            : { backupRepoDir: trimmedDir }
        )
        if (repoSeq !== null && repoSeq === repoLoadSeqRef.current) {
          setRecoveryPoints(res.recoveryPoints)
          setRepoLoadState('loaded')
          setRepoLoadError(null)
        }
        if (restoreSeq !== null && restoreSeq === restoreLoadSeqRef.current) {
          setRestoreRecoveryPoints(res.recoveryPoints)
          setRestoreLoadedRepoDir(targetKey)
          setSelectedRestoreSnapshotId((prev) => {
            if (prev && res.recoveryPoints.some((rp) => rp.snapshotId === prev && rp.isComplete)) {
              return prev
            }
            return res.recoveryPoints.find((rp) => rp.isComplete)?.snapshotId ?? ''
          })
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Backup destination cannot be read'
        if (repoSeq !== null && repoSeq === repoLoadSeqRef.current) {
          setRecoveryPoints([])
          setRepoLoadState('error')
          setRepoLoadError(msg)
        }
        if (restoreSeq !== null && restoreSeq === restoreLoadSeqRef.current) {
          setRestoreRecoveryPoints([])
          setRestoreLoadedRepoDir('')
          setSelectedRestoreSnapshotId('')
        }
        if (forRestoreOnly && restoreSeq === restoreLoadSeqRef.current) {
          setErrorMessage(msg)
        }
      }
    },
    [useCustomRestoreSource]
  )

  const loadRecoveryPointsForDir = useCallback(
    async (dir: string, forRestoreOnly = false) =>
      loadRecoveryPointsForTarget({ backupRepoDir: dir }, forRestoreOnly),
    [loadRecoveryPointsForTarget]
  )

  const loadGoogleDriveFolders = useCallback(async () => {
    if (typeof window.api?.listGoogleDriveFolders !== 'function') return
    setIsLoadingDriveFolders(true)
    try {
      const folders = await window.api.listGoogleDriveFolders({})
      setGdriveFolders(folders)
      setSelectedDriveFolderId((prev) => {
        if (prev && folders.some((f) => f.id === prev)) return prev
        return folders[0]?.id ?? ''
      })
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to list Google Drive folders')
    } finally {
      setIsLoadingDriveFolders(false)
    }
  }, [])

  const refreshState = useCallback(
    async (signal?: AbortSignal) => {
      if (
        signal?.aborted ||
        typeof window.api?.listBackupDestinations !== 'function' ||
        typeof window.api?.listBackupJobs !== 'function'
      ) {
        return
      }
      const version = ++refreshVersion.current
      try {
        const [destList, jobPage, currentActive, authStatus] = await Promise.all([
          window.api.listBackupDestinations(),
          window.api.listBackupJobs({ limit: 25, offset: 0 }),
          typeof window.api?.getActiveBackupJob === 'function'
            ? window.api.getActiveBackupJob()
            : Promise.resolve(null),
          typeof window.api?.getGoogleDriveAuthStatus === 'function'
            ? window.api.getGoogleDriveAuthStatus()
            : Promise.resolve(null)
        ])
        if (signal?.aborted || version !== refreshVersion.current) return
        setDestinations(destList)
        setJobs(jobPage.items)
        setActiveJob(currentActive)
        if (authStatus) {
          setGdriveAuth(authStatus)
        }

        let nextRepo = repoDir
        let activeDest: BackupDestinationRecordDto | null =
          destList.find((d) => d.id === selectedDestId) ?? null
        if (destList.length > 0 && !selectedDestId) {
          const first = destList[0]!
          activeDest = first
          setSelectedDestId(first.id)
          if (first.targetPath) {
            nextRepo = first.targetPath
            setRepoDir(first.targetPath)
            if (!useCustomRestoreSource) {
              setRestoreRepoDir(first.targetPath)
            }
          } else {
            nextRepo = ''
            setRepoDir('')
          }
        } else if (selectedDestId) {
          if (activeDest?.kind === 'google_drive') {
            nextRepo = ''
            if (repoDir !== '') setRepoDir('')
          } else if (activeDest?.targetPath && activeDest.targetPath !== repoDir) {
            nextRepo = activeDest.targetPath
            setRepoDir(activeDest.targetPath)
          }
        }

        const newestCompleted = jobPage.items.find((j) => j.status === 'completed')
        if (newestCompleted && newestCompleted.id !== lastCompletedJobIdRef.current && activeDest) {
          lastCompletedJobIdRef.current = newestCompleted.id
          if (
            activeDest.kind === 'google_drive' &&
            activeDest.targetPath &&
            selectedDestId === activeDest.id
          ) {
            void loadRecoveryPointsForTarget({
              destinationKind: 'google_drive',
              driveFolderId: activeDest.targetPath
            })
          } else if (nextRepo && nextRepo === repoDir) {
            void loadRecoveryPointsForTarget({ backupRepoDir: nextRepo })
          }
        } else if (newestCompleted) {
          lastCompletedJobIdRef.current = newestCompleted.id
        }
      } catch (err) {
        if (signal?.aborted || version !== refreshVersion.current) return
        setErrorMessage(err instanceof Error ? err.message : 'Failed to load backup state')
      }
    },
    [loadRecoveryPointsForTarget, repoDir, selectedDestId, useCustomRestoreSource]
  )

  useEffect(() => {
    const controller = new AbortController()
    queueMicrotask(() => void refreshState(controller.signal))
    const unsubscribe = window.api?.onBackupProgress?.(({ job }) => {
      setActiveJob(job.status === 'capturing' || job.status === 'running' ? job : null)
      setRequestedJob((previous) => (previous?.id === job.id ? job : previous))
      void refreshState(controller.signal)
    })
    return () => {
      controller.abort()
      unsubscribe?.()
    }
  }, [refreshState])

  useEffect(() => {
    const selectedDest = destinations.find((d) => d.id === selectedDestId) ?? null
    if (selectedDest?.kind === 'google_drive' && selectedDest.targetPath) {
      const folderId = selectedDest.targetPath
      let cancelled = false
      queueMicrotask(() => {
        if (!cancelled) {
          void loadRecoveryPointsForTarget({
            destinationKind: 'google_drive',
            driveFolderId: folderId
          })
        }
      })
      return () => {
        cancelled = true
      }
    }
    if (!repoDir.trim()) return
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) {
        void loadRecoveryPointsForDir(repoDir)
      }
    })
    return () => {
      cancelled = true
    }
  }, [destinations, selectedDestId, repoDir, loadRecoveryPointsForDir, loadRecoveryPointsForTarget])

  const handleRecoverFromVault = async (): Promise<void> => {
    if (typeof window.api?.recoverCatalogFromVault !== 'function') return
    const sourceVaultDir = recoverVaultDir.trim()
    const targetProfileDir = recoverTargetProfileDir.trim()
    if (!sourceVaultDir || !targetProfileDir) {
      setErrorMessage(
        'Please choose both the surviving vault folder and a new empty profile folder.'
      )
      return
    }
    setErrorMessage(null)
    setRecoverResult(null)
    setCopiedRecoverCommand(false)
    setIsBusy(true)
    try {
      const res = await window.api.recoverCatalogFromVault({
        sourceVaultDir,
        targetProfileDir
      })
      setRecoverResult(res)
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Failed to recover catalog from existing vault'
      )
    } finally {
      setIsBusy(false)
    }
  }

  const handleBrowseFolder = async (
    title: string,
    setter: (dir: string) => void
  ): Promise<void> => {
    if (typeof window.api?.selectBackupDirectory !== 'function') return
    setErrorMessage(null)
    try {
      const res = await window.api.selectBackupDirectory({ title })
      if (!res.canceled && res.directoryPath) {
        setter(res.directoryPath)
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to select folder')
    }
  }

  const handleConnectGoogleDrive = async (): Promise<void> => {
    if (typeof window.api?.connectGoogleDrive !== 'function') return
    setErrorMessage(null)
    setIsBusy(true)
    try {
      const status = await window.api.connectGoogleDrive()
      setGdriveAuth(status)
      if (status.status === 'connected') {
        await loadGoogleDriveFolders()
      }
      await refreshState()
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to connect Google Drive')
    } finally {
      setIsBusy(false)
    }
  }

  const handleDisconnectGoogleDrive = async (): Promise<void> => {
    if (typeof window.api?.disconnectGoogleDrive !== 'function') return
    setErrorMessage(null)
    setIsBusy(true)
    try {
      const status = await window.api.disconnectGoogleDrive()
      setGdriveAuth(status)
      setGdriveFolders([])
      setSelectedDriveFolderId('')
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to disconnect Google Drive')
    } finally {
      setIsBusy(false)
    }
  }

  const handleCreateDriveFolder = async (): Promise<void> => {
    if (typeof window.api?.createGoogleDriveFolder !== 'function') return
    const trimmed = newDriveFolderName.trim()
    if (!trimmed) {
      setErrorMessage('Please enter a folder name to create in Google Drive.')
      return
    }
    setErrorMessage(null)
    setIsBusy(true)
    try {
      const created = await window.api.createGoogleDriveFolder({ name: trimmed })
      setGdriveFolders((prev) => [created, ...prev.filter((f) => f.id !== created.id)])
      setSelectedDriveFolderId(created.id)
      setNewDriveFolderName('')
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to create Google Drive folder')
    } finally {
      setIsBusy(false)
    }
  }

  const handleSaveDestination = async (): Promise<void> => {
    if (typeof window.api?.configureBackupDestination !== 'function') return
    setErrorMessage(null)

    if (storageType === 'google_drive') {
      if (!destName.trim()) {
        setErrorMessage('Please enter a destination name.')
        return
      }
      if (gdriveAuth?.status !== 'connected') {
        setErrorMessage('Connect your Google Drive account before saving this destination.')
        return
      }
      if (!selectedDriveFolderId) {
        setErrorMessage('Select or create a Google Drive backup folder.')
        return
      }
      let maxBytesPerSecond: number | null = null
      if (driveRateCapMiB.trim() !== '') {
        const parsedMiB = Number(driveRateCapMiB)
        if (!Number.isFinite(parsedMiB) || parsedMiB <= 0) {
          setErrorMessage('Google Drive upload speed limit must be a positive number (MiB/s).')
          return
        }
        maxBytesPerSecond = Math.max(65536, Math.round(parsedMiB * 1024 * 1024))
      }
      let dailyBudgetBytes: number | null = null
      if (driveDailyBudgetMiB.trim() !== '') {
        const parsedBudgetMiB = Number(driveDailyBudgetMiB)
        if (!Number.isFinite(parsedBudgetMiB) || parsedBudgetMiB < 16) {
          setErrorMessage('Rolling 24-hour upload budget must be at least 16 MiB.')
          return
        }
        dailyBudgetBytes = Math.round(parsedBudgetMiB * 1024 * 1024)
      }
      setIsBusy(true)
      try {
        const created = await window.api.configureBackupDestination({
          name: destName.trim(),
          kind: 'google_drive',
          targetPath: selectedDriveFolderId,
          encryptionMode: 'aes-256-gcm-v1',
          maxBytesPerSecond,
          dailyBudgetBytes
        })
        setRequestedJob(null)
        setSelectedDestId(created.id)
        setRepoDir('')
        if (!useCustomRestoreSource) {
          restoreLoadSeqRef.current += 1
          setRestoreRepoDir('')
          setRestoreRecoveryPoints([])
          setRestoreLoadedRepoDir('')
          setSelectedRestoreSnapshotId('')
        }
        setIsEditingLocation(false)
        await refreshState()
        if (created.targetPath) {
          await loadRecoveryPointsForTarget({
            destinationKind: 'google_drive',
            driveFolderId: created.targetPath
          })
        }
      } catch (err) {
        setErrorMessage(
          err instanceof Error ? err.message : 'Failed to save Google Drive destination'
        )
      } finally {
        setIsBusy(false)
      }
      return
    }

    if (!destName.trim() || !destPath.trim()) {
      setErrorMessage('Please enter a destination name and folder path.')
      return
    }
    let maxBytesPerSecond: number | null = null
    if (storageType === 'nas' && nasRateCapMiB.trim() !== '') {
      const parsedMiB = Number(nasRateCapMiB)
      if (!Number.isFinite(parsedMiB) || parsedMiB <= 0) {
        setErrorMessage('NAS transfer rate limit must be a positive number (MiB/s).')
        return
      }
      maxBytesPerSecond = Math.max(65536, Math.round(parsedMiB * 1024 * 1024))
    }

    setIsBusy(true)
    try {
      const created = await window.api.configureBackupDestination({
        name: destName.trim(),
        kind: 'local_fs',
        targetPath: destPath.trim(),
        maxBytesPerSecond
      })
      setRequestedJob(null)
      setSelectedDestId(created.id)
      const nextPath = created.targetPath ?? ''
      setRepoDir(nextPath)
      if (!useCustomRestoreSource) {
        restoreLoadSeqRef.current += 1
        setRestoreRepoDir(nextPath)
        if (nextPath.trim() !== restoreLoadedRepoDir.trim()) {
          setRestoreRecoveryPoints([])
          setRestoreLoadedRepoDir('')
          setSelectedRestoreSnapshotId('')
        }
      }
      setIsEditingLocation(false)
      await refreshState()
      if (nextPath) {
        await loadRecoveryPointsForDir(nextPath)
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to save destination')
    } finally {
      setIsBusy(false)
    }
  }

  const handleSelectDestination = (dest: BackupDestinationRecordDto): void => {
    setRequestedJob(null)
    setSelectedDestId(dest.id)
    if (dest.kind === 'google_drive') {
      setRepoDir('')
      if (!useCustomRestoreSource) {
        restoreLoadSeqRef.current += 1
        setRestoreRepoDir('')
        if (`gdrive:${dest.targetPath ?? ''}` !== restoreLoadedRepoDir.trim()) {
          setRestoreRecoveryPoints([])
          setRestoreLoadedRepoDir('')
          setSelectedRestoreSnapshotId('')
        }
      }
      return
    }
    const nextPath = dest.targetPath ?? ''
    setRepoDir(nextPath)
    if (!useCustomRestoreSource) {
      restoreLoadSeqRef.current += 1
      setRestoreRepoDir(nextPath)
      if (nextPath.trim() !== restoreLoadedRepoDir.trim()) {
        setRestoreRecoveryPoints([])
        setRestoreLoadedRepoDir('')
        setSelectedRestoreSnapshotId('')
      }
    }
  }

  const handleStartBackup = async (): Promise<void> => {
    if (typeof window.api?.startBackup !== 'function' || !selectedDestId) return
    const selectedDest = destinations.find((d) => d.id === selectedDestId) ?? null
    const secret = backupRecoverySecret
    setBackupRecoverySecret('')
    if (selectedDest?.kind === 'google_drive' && !secret.trim()) {
      setErrorMessage('Enter an encryption recovery secret before starting a Google Drive backup.')
      return
    }
    setErrorMessage(null)
    setIsBusy(true)
    try {
      const job = await window.api.startBackup({
        destinationId: selectedDestId,
        ...(secret.trim() ? { recoverySecret: secret } : {})
      })
      setRequestedJob(job)
      await refreshState()
      if (job.status === 'completed') {
        if (selectedDest?.kind === 'google_drive' && selectedDest.targetPath) {
          await loadRecoveryPointsForTarget({
            destinationKind: 'google_drive',
            driveFolderId: selectedDest.targetPath
          })
        } else if (repoDir.trim()) {
          await loadRecoveryPointsForDir(repoDir)
        }
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to start backup')
    } finally {
      setIsBusy(false)
    }
  }

  const handlePauseJob = async (jobId: string): Promise<void> => {
    if (typeof window.api?.pauseBackup !== 'function') return
    setErrorMessage(null)
    try {
      await window.api.pauseBackup(jobId)
      await refreshState()
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to pause backup')
    }
  }

  const handleResumeJob = async (jobId: string): Promise<void> => {
    if (typeof window.api?.resumeBackup !== 'function') return
    const selectedDest = destinations.find((d) => d.id === selectedDestId) ?? null
    const secret = backupRecoverySecret
    setBackupRecoverySecret('')
    setErrorMessage(null)
    setIsBusy(true)
    try {
      const job = secret.trim()
        ? await window.api.resumeBackup(jobId, secret)
        : await window.api.resumeBackup(jobId)
      setRequestedJob(job)
      await refreshState()
      if (job.status === 'completed') {
        if (selectedDest?.kind === 'google_drive' && selectedDest.targetPath) {
          await loadRecoveryPointsForTarget({
            destinationKind: 'google_drive',
            driveFolderId: selectedDest.targetPath
          })
        } else if (repoDir.trim()) {
          await loadRecoveryPointsForDir(repoDir)
        }
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to resume backup')
    } finally {
      setIsBusy(false)
    }
  }

  const handleCancelJob = async (jobId: string): Promise<void> => {
    if (typeof window.api?.cancelBackup !== 'function') return
    setErrorMessage(null)
    try {
      await window.api.cancelBackup(jobId)
      await refreshState()
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to cancel backup')
    }
  }

  const selectedDestination = useMemo(
    () => destinations.find((d) => d.id === selectedDestId) ?? null,
    [destinations, selectedDestId]
  )

  const currentTargetKey = getDestinationTargetKey(selectedDestination, repoDir)

  const handleVerifyRecoveryPoint = async (
    snapshotId: string,
    secretOverride?: string
  ): Promise<void> => {
    const isDrive = selectedDestination?.kind === 'google_drive'
    const trimmedRepo = repoDir.trim()
    if (
      typeof window.api?.verifyRecoveryPoint !== 'function' ||
      (!isDrive && !trimmedRepo) ||
      (isDrive && !selectedDestination)
    ) {
      return
    }
    const targetKey = getDestinationTargetKey(selectedDestination, trimmedRepo)
    const key = `${targetKey}::${snapshotId}`
    const secret = secretOverride ?? (isDrive ? backupRecoverySecret : '')
    if (!secretOverride && isDrive && backupRecoverySecret) {
      setBackupRecoverySecret('')
    }
    setErrorMessage(null)
    setIsBusy(true)
    try {
      const res = await window.api.verifyRecoveryPoint({
        ...(isDrive && selectedDestination?.targetPath
          ? { destinationKind: 'google_drive', driveFolderId: selectedDestination.targetPath }
          : { backupRepoDir: trimmedRepo }),
        snapshotId,
        ...(secret.trim() ? { recoverySecret: secret } : {})
      })
      setVerifiedByKey((prev) => ({
        ...prev,
        [key]: { verifiedAtMs: Date.now(), result: res }
      }))
    } catch (err) {
      setVerifiedByKey((prev) => {
        if (!(key in prev)) return prev
        const next = { ...prev }
        delete next[key]
        return next
      })
      setErrorMessage(err instanceof Error ? err.message : 'Backup verification failed')
    } finally {
      setIsBusy(false)
    }
  }

  const handleRestoreFiles = async (): Promise<void> => {
    if (typeof window.api?.restoreRecoveryPoint !== 'function') return
    const activeRestoreTarget = restoreLoadedRepoDir.trim()
    if (!isRestoreSourceSynced || !activeRestoreTarget || !selectedRestoreSnapshotId) {
      setErrorMessage(
        restoreSourceNeedsReload
          ? 'Backup folder changed. Click Load backups before restoring.'
          : 'Please choose a backup to restore.'
      )
      return
    }
    if (!restoreLocationDir.trim()) {
      setErrorMessage('Please choose an empty restore location.')
      return
    }

    const chosenRp =
      restoreRecoveryPoints.find((rp) => rp.snapshotId === selectedRestoreSnapshotId) ?? null
    const targetProfileDir = joinChildPath(restoreLocationDir, 'profile')
    const targetVaultDir = hasInitializedVault(chosenRp)
      ? joinChildPath(restoreLocationDir, 'vault')
      : null
    const secret = restoreRecoverySecret
    setRestoreRecoverySecret('')
    const isDriveTarget = activeRestoreTarget.startsWith('gdrive:')
    const restoreDriveFolderId = isDriveTarget ? activeRestoreTarget.slice('gdrive:'.length) : ''
    const restoreBackupRepoDir = activeRestoreTarget.startsWith('dir:')
      ? activeRestoreTarget.slice('dir:'.length)
      : activeRestoreTarget

    setErrorMessage(null)
    setRestoreResult(null)
    setCopiedCommand(false)
    setIsBusy(true)
    try {
      const res = await window.api.restoreRecoveryPoint({
        ...(isDriveTarget
          ? { destinationKind: 'google_drive', driveFolderId: restoreDriveFolderId }
          : { backupRepoDir: restoreBackupRepoDir }),
        snapshotId: selectedRestoreSnapshotId,
        targetProfileDir,
        targetVaultDir,
        ...(secret.trim() ? { recoverySecret: secret } : {})
      })
      setRestoreResult(res)
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Restore failed')
    } finally {
      setIsBusy(false)
    }
  }

  const destJobs = useMemo(
    () => jobs.filter((job) => !selectedDestId || job.destinationId === selectedDestId),
    [jobs, selectedDestId]
  )

  const latestJob = useMemo(() => {
    if (activeJob && (!selectedDestId || activeJob.destinationId === selectedDestId)) {
      return activeJob
    }
    if (requestedJob && (!selectedDestId || requestedJob.destinationId === selectedDestId)) {
      return destJobs.find((j) => j.id === requestedJob.id) ?? requestedJob
    }
    return destJobs[0] ?? null
  }, [activeJob, destJobs, requestedJob, selectedDestId])

  const latestRecoveryPoint = recoveryPoints[0] ?? null
  const matchedLatestRecoveryPoint = latestJob
    ? (recoveryPoints.find((rp) => rp.snapshotId === latestJob.snapshotId) ?? null)
    : latestRecoveryPoint

  const latestSnapshotId =
    latestJob?.status === 'completed'
      ? latestJob.snapshotId
      : latestRecoveryPoint?.isComplete
        ? latestRecoveryPoint.snapshotId
        : null

  const latestVerifiedInfo =
    latestSnapshotId && currentTargetKey
      ? (verifiedByKey[`${currentTargetKey}::${latestSnapshotId}`] ?? null)
      : null

  const isLatestRunning = latestJob?.status === 'capturing' || latestJob?.status === 'running'
  const isLatestResumable =
    latestJob?.status === 'paused' ||
    latestJob?.status === 'interrupted' ||
    latestJob?.status === 'queued_destination_unavailable'
  const isLatestFailed = latestJob?.status === 'failed' || latestJob?.status === 'abandoned'
  const isLatestCompleted =
    latestJob?.status === 'completed' || (!latestJob && Boolean(latestRecoveryPoint?.isComplete))

  const latestDestination =
    destinations.find((d) => d.id === latestJob?.destinationId) ?? selectedDestination

  const isDestinationDisconnected =
    repoLoadState === 'error' ||
    (isLatestCompleted && repoLoadState === 'loaded' && matchedLatestRecoveryPoint === null)

  const latestVaultCopyCount: number | null = isDestinationDisconnected
    ? null
    : (matchedLatestRecoveryPoint?.vaultCopyCount ?? null)

  const latestTimestampMs =
    latestJob?.completedAtMs ??
    latestJob?.updatedAtMs ??
    latestJob?.createdAtMs ??
    latestRecoveryPoint?.completedAtMs ??
    latestRecoveryPoint?.createdAtMs ??
    null

  const progressPercent =
    latestJob && latestJob.totalObjectCount > 0
      ? Math.min(
          100,
          Math.round((latestJob.completedObjectCount / latestJob.totalObjectCount) * 100)
        )
      : 0

  const showLocationEditor = destinations.length === 0 || isEditingLocation

  const effectiveRestoreTargetKey = useCustomRestoreSource
    ? restoreRepoDir.trim()
      ? `dir:${restoreRepoDir.trim()}`
      : ''
    : currentTargetKey
  const isRestoreSourceSynced =
    Boolean(effectiveRestoreTargetKey) && effectiveRestoreTargetKey === restoreLoadedRepoDir.trim()

  const completeRestoreChoices = isRestoreSourceSynced
    ? restoreRecoveryPoints.filter((rp) => rp.isComplete)
    : []
  const selectedRestoreChoice =
    completeRestoreChoices.find((rp) => rp.snapshotId === selectedRestoreSnapshotId) ?? null

  const preparedProfilePreview = restoreLocationDir.trim()
    ? joinChildPath(restoreLocationDir, 'profile')
    : ''
  const preparedVaultPreview =
    restoreLocationDir.trim() && hasInitializedVault(selectedRestoreChoice)
      ? joinChildPath(restoreLocationDir, 'vault')
      : ''
  const restoreSourceNeedsReload =
    useCustomRestoreSource &&
    (restoreRepoDir.trim() ? `dir:${restoreRepoDir.trim()}` : '') !== restoreLoadedRepoDir.trim()

  const historyItems = useMemo(() => {
    const bySnapshot = new Map<
      string,
      {
        key: string
        snapshotId: string
        job: BackupJobRecordDto | null
        rp: BackupRecoveryPointSummary | null
        timestampMs: number
        destinationName: string
      }
    >()

    for (const job of destJobs) {
      const dest = destinations.find((d) => d.id === job.destinationId)
      const rp = recoveryPoints.find((r) => r.snapshotId === job.snapshotId) ?? null
      bySnapshot.set(job.snapshotId, {
        key: job.id,
        snapshotId: job.snapshotId,
        job,
        rp,
        timestampMs: job.completedAtMs ?? job.updatedAtMs ?? job.createdAtMs,
        destinationName: dest?.name ?? selectedDestination?.name ?? 'Backup destination'
      })
    }

    for (const rp of recoveryPoints) {
      if (!bySnapshot.has(rp.snapshotId)) {
        bySnapshot.set(rp.snapshotId, {
          key: rp.snapshotId,
          snapshotId: rp.snapshotId,
          job: null,
          rp,
          timestampMs: rp.completedAtMs ?? rp.createdAtMs ?? 0,
          destinationName: selectedDestination?.name ?? repoDir
        })
      }
    }

    return Array.from(bySnapshot.values()).sort((a, b) => b.timestampMs - a.timestampMs)
  }, [destJobs, destinations, recoveryPoints, repoDir, selectedDestination])

  const launchCommand = restoreResult
    ? `--user-data-dir="${restoreResult.restoredProfilePath}"`
    : ''

  return (
    <div className="backup-restore-scroll">
      <section className="backup-restore-panel" aria-labelledby="backup-restore-heading">
        <header className="backup-page-header">
          <div>
            <div className="backup-page-title-row">
              <HardDrive size={22} aria-hidden="true" />
              <h2 id="backup-restore-heading">Backup &amp; Restore</h2>
            </div>
            <p className="backup-page-subtitle">
              Keep a safe copy of your vault photos, documents, and catalog on a USB drive or
              network folder.
            </p>
          </div>
        </header>

        {errorMessage && (
          <div className="notice notice-error backup-callout backup-callout-error" role="alert">
            <XCircle size={18} aria-hidden="true" />
            <span>{errorMessage}</span>
          </div>
        )}

        {/* 1. Latest Backup Summary Card */}
        <article className="backup-card backup-summary-card" aria-label="Latest backup summary">
          <div className="backup-card-header">
            <div className="backup-summary-status-block">
              {latestJob ? (
                <div
                  className={`backup-summary-headline backup-job-notice${
                    isLatestFailed
                      ? ' backup-summary-headline-error'
                      : isLatestCompleted
                        ? ' backup-summary-headline-success backup-job-notice-success'
                        : isLatestResumable
                          ? ' backup-summary-headline-warn'
                          : ''
                  }`}
                  role={isLatestFailed ? 'alert' : 'status'}
                >
                  {isLatestCompleted && <CheckCircle2 size={20} aria-hidden="true" />}
                  {isLatestFailed && <XCircle size={20} aria-hidden="true" />}
                  {isLatestResumable && <AlertTriangle size={20} aria-hidden="true" />}
                  <span>{getPlainJobHeadline(latestJob)}</span>
                </div>
              ) : isLatestCompleted ? (
                <div
                  className="backup-summary-headline backup-summary-headline-success backup-job-notice backup-job-notice-success"
                  role="status"
                >
                  <CheckCircle2 size={20} aria-hidden="true" />
                  <span>Backup completed successfully</span>
                </div>
              ) : selectedDestination ? (
                <div className="backup-summary-headline">
                  <span>No backups run yet</span>
                </div>
              ) : (
                <div className="backup-summary-headline">
                  <span>Set up a backup destination to get started</span>
                </div>
              )}

              {latestVerifiedInfo && (
                <div>
                  <span className="backup-verified-pill">
                    <ShieldCheck size={14} aria-hidden="true" />
                    Verified on {formatTimestamp(latestVerifiedInfo.verifiedAtMs)}
                  </span>
                </div>
              )}
            </div>

            <div className="backup-summary-actions">
              {isLatestRunning && latestJob && (
                <>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => void handlePauseJob(latestJob.id)}
                  >
                    <Pause size={14} aria-hidden="true" /> Pause
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => void handleCancelJob(latestJob.id)}
                  >
                    Cancel
                  </button>
                </>
              )}

              {isLatestResumable && latestJob && (
                <>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={isBusy || Boolean(activeJob)}
                    onClick={() => void handleResumeJob(latestJob.id)}
                  >
                    <Play size={14} aria-hidden="true" /> Resume
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => void handleCancelJob(latestJob.id)}
                  >
                    Cancel
                  </button>
                </>
              )}

              {selectedDestination && !isLatestRunning && !isLatestResumable && (
                <>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={isBusy || !selectedDestId || Boolean(activeJob)}
                    onClick={() => void handleStartBackup()}
                  >
                    <Play size={14} aria-hidden="true" /> Back up now
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={
                      isBusy || !latestSnapshotId || !currentTargetKey || isDestinationDisconnected
                    }
                    onClick={() =>
                      latestSnapshotId && void handleVerifyRecoveryPoint(latestSnapshotId)
                    }
                  >
                    <ShieldCheck size={14} aria-hidden="true" /> Verify backup
                  </button>
                </>
              )}

              {destinations.length > 0 && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setIsEditingLocation((prev) => !prev)}
                >
                  <MapPin size={14} aria-hidden="true" />{' '}
                  {isEditingLocation ? 'Close location settings' : 'Change backup location'}
                </button>
              )}
            </div>
          </div>

          {isLatestRunning && latestJob && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div className="backup-progress-bar-track" aria-hidden="true">
                <div
                  className="backup-progress-bar-fill"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
              <div className="backup-metric-sub">
                {latestJob.totalObjectCount > 0
                  ? `${latestJob.completedObjectCount} of ${latestJob.totalObjectCount} items backed up (${formatBytes(latestJob.transferredBytes)})`
                  : 'Preparing catalog and vault files…'}
              </div>
            </div>
          )}

          {(selectedDestination?.kind === 'google_drive' ||
            selectedDestination?.encryptionMode === 'aes-256-gcm-v1' ||
            latestJob?.errorCode === 'recovery_secret_required' ||
            latestJob?.errorCode === 'wrong_recovery_secret') && (
            <div
              className="backup-field-row"
              style={{ marginTop: '8px', alignItems: 'flex-end', flexWrap: 'wrap' }}
            >
              <label style={{ flex: 1, minWidth: '240px' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                  <KeyRound size={14} aria-hidden="true" /> Encryption Recovery Secret
                </span>
                <input
                  type="password"
                  autoComplete="new-password"
                  data-testid="backup-recovery-secret-input"
                  value={backupRecoverySecret}
                  onChange={(e) => setBackupRecoverySecret(e.target.value)}
                  placeholder={
                    isLatestResumable
                      ? 'Optional to resume if session stayed open; required after restart'
                      : 'Required to encrypt Google Drive backups'
                  }
                  style={{ width: '100%' }}
                />
              </label>
              {(gdriveAuth?.status === 'expired' ||
                latestJob?.errorCode === 'destination_access_denied') && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={isBusy}
                  onClick={() => void handleConnectGoogleDrive()}
                >
                  <LogIn size={14} aria-hidden="true" /> Reconnect Google Drive
                </button>
              )}
            </div>
          )}

          {latestJob && getPlainPauseOrFailureDetail(latestJob) && (
            <div
              className={`backup-callout ${
                isLatestFailed ? 'backup-callout-error' : 'backup-callout-warning'
              }`}
            >
              {isLatestFailed ? (
                <XCircle size={16} aria-hidden="true" />
              ) : (
                <AlertTriangle size={16} aria-hidden="true" />
              )}
              <span>{getPlainPauseOrFailureDetail(latestJob)}</span>
            </div>
          )}

          {selectedDestination && (latestJob || latestRecoveryPoint) && (
            <div className="backup-summary-grid">
              <div className="backup-metric">
                <span className="backup-metric-label">Latest backup</span>
                <span className="backup-metric-value">{formatTimestamp(latestTimestampMs)}</span>
                {isLatestCompleted && !latestVerifiedInfo && (
                  <span className="backup-metric-sub">
                    Not yet verified — run Verify backup to check every file
                  </span>
                )}
              </div>

              <div className="backup-metric">
                <span className="backup-metric-label">Destination</span>
                <span className="backup-metric-value">
                  {latestDestination?.name ?? selectedDestination.name}
                </span>
                <span className="backup-metric-sub">
                  {latestDestination
                    ? getDestinationLocationLabel(latestDestination)
                    : selectedDestination
                      ? getDestinationLocationLabel(selectedDestination)
                      : '—'}
                </span>
              </div>

              <div className="backup-metric">
                <span className="backup-metric-label">Vault files included</span>
                {isDestinationDisconnected || latestVaultCopyCount === null ? (
                  <>
                    <span className="backup-metric-value">File count unavailable</span>
                    <span className="backup-metric-sub">
                      {repoLoadState === 'loading'
                        ? 'Checking backup destination…'
                        : 'Destination is disconnected or cannot be read.'}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="backup-metric-value">
                      {latestVaultCopyCount === 0
                        ? '0 vault files'
                        : `${latestVaultCopyCount} ${latestVaultCopyCount === 1 ? 'vault file' : 'vault files'}`}
                    </span>
                    {matchedLatestRecoveryPoint?.vaultName && (
                      <span className="backup-metric-sub">
                        Vault: {matchedLatestRecoveryPoint.vaultName}
                      </span>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

          {isLatestCompleted && !isDestinationDisconnected && latestVaultCopyCount === 0 && (
            <div className="backup-callout backup-callout-warning" role="status">
              <AlertTriangle size={18} aria-hidden="true" />
              <div>
                <strong>No photos or documents were backed up.</strong> Scanned files must be
                imported into the vault to be included in backups. This backup saved your catalog
                and annotations only.
              </div>
            </div>
          )}

          {selectedDestination && !latestJob && !latestRecoveryPoint && (
            <div className="backup-summary-grid">
              <div className="backup-metric">
                <span className="backup-metric-label">Destination</span>
                <span className="backup-metric-value">{selectedDestination.name}</span>
                <span className="backup-metric-sub">
                  {getDestinationLocationLabel(selectedDestination)}
                </span>
              </div>
              <div className="backup-metric">
                <span className="backup-metric-label">Status</span>
                <span className="backup-metric-value">Ready</span>
                <span className="backup-metric-sub">
                  Click Back up now to create your first backup.
                </span>
              </div>
            </div>
          )}

          {/* Collapsible Setup / Change Backup Location */}
          {showLocationEditor && (
            <div className="backup-location-panel" aria-label="Backup location settings">
              {destinations.length > 0 && (
                <div>
                  <strong style={{ display: 'block', marginBottom: '8px' }}>
                    Saved backup locations
                  </strong>
                  <ul className="backup-dest-list">
                    {destinations.map((d) => (
                      <li key={d.id}>
                        <label className="backup-dest-item">
                          <input
                            type="radio"
                            name="selected-backup-destination"
                            checked={selectedDestId === d.id}
                            onChange={() => handleSelectDestination(d)}
                          />
                          <span>
                            <strong>{d.name}</strong> —{' '}
                            <code>{getDestinationLocationLabel(d)}</code>{' '}
                            {d.maxBytesPerSecond !== null
                              ? `(${formatBytes(d.maxBytesPerSecond)}/s limit)`
                              : '(full speed)'}
                            {d.dailyBudgetBytes !== null
                              ? ` • ${formatBytes(d.dailyBudgetBytes)}/24h budget`
                              : ''}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="backup-form-grid">
                <strong style={{ color: 'var(--text-main)' }}>
                  {destinations.length === 0
                    ? 'Choose where to store your backups'
                    : 'Add or update backup location'}
                </strong>

                <div className="backup-radio-group">
                  <label className="backup-radio-option">
                    <input
                      type="radio"
                      name="backup-storage-type"
                      checked={storageType === 'usb'}
                      onChange={() => {
                        setStorageType('usb')
                        if (destName === 'NAS Backup Share' || destName === 'Google Drive Backup') {
                          setDestName('USB Backup Drive')
                        }
                      }}
                    />
                    USB Drive (Full speed)
                  </label>
                  <label className="backup-radio-option">
                    <input
                      type="radio"
                      name="backup-storage-type"
                      checked={storageType === 'nas'}
                      onChange={() => {
                        setStorageType('nas')
                        if (destName === 'USB Backup Drive' || destName === 'Google Drive Backup') {
                          setDestName('NAS Backup Share')
                        }
                      }}
                    />
                    NAS / Network Share (Speed-limited)
                  </label>
                  <label className="backup-radio-option">
                    <input
                      type="radio"
                      name="backup-storage-type"
                      checked={storageType === 'google_drive'}
                      onChange={() => {
                        setStorageType('google_drive')
                        if (destName === 'USB Backup Drive' || destName === 'NAS Backup Share') {
                          setDestName('Google Drive Backup')
                        }
                        if (gdriveAuth?.status === 'connected' && gdriveFolders.length === 0) {
                          void loadGoogleDriveFolders()
                        }
                      }}
                    />
                    <Cloud size={14} aria-hidden="true" style={{ marginRight: '4px' }} />
                    Google Drive (Encrypted cloud)
                  </label>
                </div>

                <label>
                  Destination Name
                  <input
                    type="text"
                    value={destName}
                    onChange={(e) => setDestName(e.target.value)}
                    placeholder={
                      storageType === 'google_drive'
                        ? 'e.g. Google Drive Backup'
                        : 'e.g. USB Backup Drive or \\NAS\\Backups\\PersonalVault'
                    }
                    style={{ width: '100%' }}
                  />
                </label>

                {storageType === 'google_drive' ? (
                  <div
                    className="backup-gdrive-panel"
                    style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}
                  >
                    <div
                      className="backup-field-row"
                      style={{ justifyContent: 'space-between', alignItems: 'center' }}
                    >
                      <div>
                        <strong>Google Drive Account</strong>
                        <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                          {gdriveAuth?.status === 'connected'
                            ? `Connected as ${gdriveAuth.accountEmail ?? gdriveAuth.accountDisplayName ?? 'Google Account'}`
                            : gdriveAuth?.status === 'expired'
                              ? `Authorization expired${gdriveAuth.accountEmail ? ` (${gdriveAuth.accountEmail})` : ''} — reconnect to continue`
                              : 'Not connected'}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        {gdriveAuth?.status === 'connected' ? (
                          <button
                            type="button"
                            className="btn btn-secondary"
                            disabled={isBusy}
                            onClick={() => void handleDisconnectGoogleDrive()}
                          >
                            <LogOut size={14} aria-hidden="true" /> Disconnect
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-primary"
                            disabled={isBusy}
                            onClick={() => void handleConnectGoogleDrive()}
                          >
                            <LogIn size={14} aria-hidden="true" />{' '}
                            {gdriveAuth?.status === 'expired'
                              ? 'Reconnect Google Drive'
                              : 'Connect Google Drive'}
                          </button>
                        )}
                      </div>
                    </div>

                    {gdriveAuth?.status === 'connected' && (
                      <>
                        <div className="backup-field-row" style={{ alignItems: 'flex-end' }}>
                          <label style={{ flex: 1, minWidth: '220px' }}>
                            Google Drive Backup Folder
                            <select
                              value={selectedDriveFolderId}
                              onChange={(e) => setSelectedDriveFolderId(e.target.value)}
                              style={{ width: '100%' }}
                            >
                              {gdriveFolders.length === 0 ? (
                                <option value="">No folders loaded</option>
                              ) : (
                                gdriveFolders.map((folder) => (
                                  <option key={folder.id} value={folder.id}>
                                    {folder.name}
                                  </option>
                                ))
                              )}
                            </select>
                          </label>
                          <button
                            type="button"
                            className="btn btn-secondary"
                            disabled={isBusy || isLoadingDriveFolders}
                            onClick={() => void loadGoogleDriveFolders()}
                          >
                            <RefreshCw size={14} aria-hidden="true" /> Refresh folders
                          </button>
                        </div>

                        <div className="backup-field-row" style={{ alignItems: 'flex-end' }}>
                          <label style={{ flex: 1, minWidth: '220px' }}>
                            Or Create New Folder
                            <input
                              type="text"
                              value={newDriveFolderName}
                              onChange={(e) => setNewDriveFolderName(e.target.value)}
                              placeholder="PersonalVault Backups"
                              style={{ width: '100%' }}
                            />
                          </label>
                          <button
                            type="button"
                            className="btn btn-secondary"
                            disabled={isBusy || !newDriveFolderName.trim()}
                            onClick={() => void handleCreateDriveFolder()}
                          >
                            <FolderPlus size={14} aria-hidden="true" /> Create folder
                          </button>
                        </div>

                        <div className="backup-field-row">
                          <label style={{ flex: 1, minWidth: '180px' }}>
                            Upload Speed Limit (MiB/s, optional)
                            <input
                              type="number"
                              min="0.0625"
                              step="0.5"
                              value={driveRateCapMiB}
                              onChange={(e) => setDriveRateCapMiB(e.target.value)}
                              placeholder="Unlimited"
                              style={{ width: '100%' }}
                            />
                          </label>
                          <label style={{ flex: 1, minWidth: '180px' }}>
                            Rolling 24h Upload Budget (MiB, min 16)
                            <input
                              type="number"
                              min="16"
                              step="64"
                              value={driveDailyBudgetMiB}
                              onChange={(e) => setDriveDailyBudgetMiB(e.target.value)}
                              style={{ width: '100%' }}
                            />
                          </label>
                        </div>
                      </>
                    )}
                  </div>
                ) : (
                  <>
                    <div className="backup-field-row">
                      <label style={{ flex: 1, minWidth: '220px' }}>
                        Destination Folder (Local drive or UNC path)
                        <input
                          type="text"
                          value={destPath}
                          onChange={(e) => setDestPath(e.target.value)}
                          placeholder="E:\PersonalVaultBackup or \\NAS\Backups\PersonalVault"
                          style={{ width: '100%' }}
                        />
                      </label>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() =>
                          void handleBrowseFolder('Select Backup Destination Folder', setDestPath)
                        }
                      >
                        <FolderOpen size={14} aria-hidden="true" /> Browse…
                      </button>
                    </div>

                    {storageType === 'nas' && (
                      <label>
                        NAS Transfer Speed Limit (MiB/s, min 64 KiB/s)
                        <input
                          type="number"
                          min="0.0625"
                          step="0.5"
                          value={nasRateCapMiB}
                          onChange={(e) => setNasRateCapMiB(e.target.value)}
                          style={{ width: '180px' }}
                        />
                      </label>
                    )}
                  </>
                )}

                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={isBusy}
                    onClick={() => void handleSaveDestination()}
                  >
                    Save destination
                  </button>
                  {destinations.length > 0 && (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => setIsEditingLocation(false)}
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          <div className="backup-scope-footnote" role="note">
            <ShieldAlert size={15} aria-hidden="true" />
            <span>
              <strong>Files outside the vault are excluded:</strong> backups save your catalog,
              annotations/collections, and imported vault files only. Original source folders,
              thumbnails, and offline AI models are not copied.
            </span>
          </div>
        </article>

        {/* 2. Backup History */}
        <article className="backup-card" aria-labelledby="backup-history-heading">
          <div className="backup-card-header">
            <div>
              <h3 id="backup-history-heading">Backup History</h3>
              <p className="backup-card-subtitle">
                {selectedDestination
                  ? `Backups for ${selectedDestination.name}`
                  : 'Your past backups will appear here.'}
              </p>
            </div>
            {selectedDestination && (
              <button
                type="button"
                className="btn btn-secondary"
                disabled={repoLoadState === 'loading'}
                onClick={() => {
                  void refreshState()
                  if (
                    selectedDestination?.kind === 'google_drive' &&
                    selectedDestination.targetPath
                  ) {
                    void loadRecoveryPointsForTarget({
                      destinationKind: 'google_drive',
                      driveFolderId: selectedDestination.targetPath
                    })
                  } else if (repoDir.trim()) {
                    void loadRecoveryPointsForDir(repoDir)
                  }
                }}
                aria-label="Refresh backup history"
              >
                <RefreshCw size={14} aria-hidden="true" /> Refresh
              </button>
            )}
          </div>

          {repoLoadState === 'error' && repoLoadError && (
            <div className="backup-callout backup-callout-warning">
              <AlertTriangle size={16} aria-hidden="true" />
              <span>
                Backup destination is disconnected or unavailable ({repoLoadError}). Reconnect it to
                inspect backed-up file counts or verify recovery points.
              </span>
            </div>
          )}

          {historyItems.length === 0 ? (
            <p style={{ color: 'var(--text-muted)', margin: 0 }}>No backups recorded yet.</p>
          ) : (
            <ul className="backup-history-list">
              {historyItems.map((item) => {
                const { job, rp, snapshotId } = item
                const isRunning = job?.status === 'capturing' || job?.status === 'running'
                const isResumable =
                  job?.status === 'paused' ||
                  job?.status === 'interrupted' ||
                  job?.status === 'queued_destination_unavailable'
                const isExpanded = Boolean(expandedDetails[item.key])
                const verifiedInfo = currentTargetKey
                  ? (verifiedByKey[`${currentTargetKey}::${snapshotId}`] ?? null)
                  : null
                const canVerify =
                  Boolean(rp?.isComplete) && !isRunning && !isResumable && Boolean(currentTargetKey)

                return (
                  <li key={item.key} className="backup-history-item">
                    <div className="backup-history-row">
                      <div className="backup-history-primary">
                        <div className="backup-history-title">
                          <span>{formatTimestamp(item.timestampMs)}</span>
                          {job ? (
                            <span
                              className={`${getStatusPillClass(job.status)} backup-status-pill-cap`}
                              data-testid={`backup-job-status-${job.id}`}
                            >
                              {job.status}
                            </span>
                          ) : (
                            <span
                              className={
                                rp?.isComplete
                                  ? 'backup-status-pill backup-status-pill-success'
                                  : 'backup-status-pill backup-status-pill-warn'
                              }
                            >
                              {rp?.isComplete ? 'Completed' : 'Incomplete'}
                            </span>
                          )}
                          {verifiedInfo && (
                            <span className="backup-verified-pill">
                              <ShieldCheck size={12} aria-hidden="true" />
                              Verified on {formatTimestamp(verifiedInfo.verifiedAtMs)}
                            </span>
                          )}
                        </div>
                        <div className="backup-history-meta">
                          {item.destinationName} •{' '}
                          {rp ? formatVaultFileCount(rp.vaultCopyCount) : 'File count unavailable'}
                        </div>
                      </div>

                      <div className="backup-history-actions">
                        {isRunning && job && (
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => void handlePauseJob(job.id)}
                          >
                            <Pause size={14} aria-hidden="true" /> Pause
                          </button>
                        )}
                        {isResumable && job && (
                          <button
                            type="button"
                            className="btn btn-secondary"
                            disabled={isBusy || Boolean(activeJob)}
                            onClick={() => void handleResumeJob(job.id)}
                          >
                            <Play size={14} aria-hidden="true" /> Resume
                          </button>
                        )}
                        {(isRunning || isResumable) && job && (
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => void handleCancelJob(job.id)}
                          >
                            Cancel
                          </button>
                        )}
                        {canVerify && (
                          <button
                            type="button"
                            className="btn btn-secondary"
                            disabled={isBusy}
                            onClick={() => void handleVerifyRecoveryPoint(snapshotId)}
                          >
                            <ShieldCheck size={14} aria-hidden="true" /> Verify
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn btn-secondary"
                          aria-expanded={isExpanded}
                          onClick={() =>
                            setExpandedDetails((prev) => ({
                              ...prev,
                              [item.key]: !prev[item.key]
                            }))
                          }
                        >
                          {isExpanded ? (
                            <ChevronDown size={14} aria-hidden="true" />
                          ) : (
                            <ChevronRight size={14} aria-hidden="true" />
                          )}
                          Details
                        </button>
                      </div>
                    </div>

                    {job?.errorMessage && (
                      <div style={{ color: '#ff8787', fontSize: '13px' }}>{job.errorMessage}</div>
                    )}

                    {isExpanded && (
                      <div className="backup-details-drawer">
                        <div>
                          <span>Snapshot ID: </span>
                          <code>{snapshotId}</code>
                        </div>
                        <div>
                          <span>Backup chunks: </span>
                          <code>
                            {job
                              ? `${job.completedObjectCount}/${job.totalObjectCount}`
                              : (rp?.totalObjectCount ?? '—')}
                          </code>
                        </div>
                        {job && (
                          <div>
                            <span>Written / Reused: </span>
                            <code>
                              written: {job.writtenChunkCount}, reused: {job.reusedChunkCount}
                            </code>
                          </div>
                        )}
                        <div>
                          <span>Logical size: </span>
                          <code>
                            {formatBytes(job?.totalLogicalBytes ?? rp?.totalLogicalBytes ?? null)}
                          </code>
                        </div>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </article>

        {/* 3. Guided Restore Flow */}
        <article className="backup-card" aria-labelledby="restore-files-heading">
          <div className="backup-card-header">
            <div>
              <h3 id="restore-files-heading">Restore Files</h3>
              <p className="backup-card-subtitle">
                Recover your catalog and vault files into a separate folder without modifying your
                current library.
              </p>
            </div>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setUseCustomRestoreSource((prev) => {
                  const next = !prev
                  restoreLoadSeqRef.current += 1
                  if (!next) {
                    setRestoreRepoDir(repoDir)
                    if (repoLoadState === 'loaded' && currentTargetKey) {
                      setRestoreRecoveryPoints(recoveryPoints)
                      setRestoreLoadedRepoDir(currentTargetKey)
                      setSelectedRestoreSnapshotId(
                        recoveryPoints.find((rp) => rp.isComplete)?.snapshotId ?? ''
                      )
                    } else {
                      setRestoreRecoveryPoints([])
                      setRestoreLoadedRepoDir('')
                      setSelectedRestoreSnapshotId('')
                    }
                  } else if (
                    (restoreRepoDir.trim() ? `dir:${restoreRepoDir.trim()}` : '') !==
                    restoreLoadedRepoDir.trim()
                  ) {
                    setRestoreRecoveryPoints([])
                    setRestoreLoadedRepoDir('')
                    setSelectedRestoreSnapshotId('')
                  }
                  return next
                })
              }}
            >
              {useCustomRestoreSource
                ? 'Use configured destination'
                : 'Choose another backup folder'}
            </button>
          </div>

          {useCustomRestoreSource && (
            <div className="backup-field-row">
              <label style={{ flex: 1, minWidth: '220px' }}>
                Backup Repository Folder
                <input
                  type="text"
                  value={restoreRepoDir}
                  onChange={(e) => {
                    const nextVal = e.target.value
                    setRestoreRepoDir(nextVal)
                    const nextKey = nextVal.trim() ? `dir:${nextVal.trim()}` : ''
                    if (nextKey !== restoreLoadedRepoDir.trim()) {
                      restoreLoadSeqRef.current += 1
                      setRestoreRecoveryPoints([])
                      setRestoreLoadedRepoDir('')
                      setSelectedRestoreSnapshotId('')
                    }
                  }}
                  placeholder="Path to backup folder"
                  style={{ width: '100%' }}
                />
              </label>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() =>
                  void handleBrowseFolder('Select Backup Folder to Restore From', (dir) => {
                    setRestoreRepoDir(dir)
                    setRestoreRecoveryPoints([])
                    setRestoreLoadedRepoDir('')
                    setSelectedRestoreSnapshotId('')
                    void loadRecoveryPointsForDir(dir, true)
                  })
                }
              >
                <FolderOpen size={14} aria-hidden="true" /> Browse…
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={isBusy || !restoreRepoDir.trim()}
                onClick={() => void loadRecoveryPointsForDir(restoreRepoDir, true)}
              >
                Load backups
              </button>
            </div>
          )}

          <div className="backup-restore-steps">
            {/* Step 1: Choose a backup */}
            <div className="backup-restore-step">
              <div className="backup-restore-step-header">
                <span className="backup-step-badge">1</span>
                <span>Choose a backup</span>
              </div>

              {restoreSourceNeedsReload && (
                <div className="backup-callout backup-callout-warning">
                  <AlertTriangle size={16} aria-hidden="true" />
                  <span>
                    Backup folder changed. Click <strong>Load backups</strong> to load backups from
                    the new folder before restoring.
                  </span>
                </div>
              )}

              {completeRestoreChoices.length === 0 ? (
                <p style={{ color: 'var(--text-muted)', margin: 0, fontSize: '13px' }}>
                  No complete backups found at this location yet.
                </p>
              ) : (
                <div className="backup-restore-choice-list">
                  {completeRestoreChoices.map((rp) => {
                    const isSelected = selectedRestoreSnapshotId === rp.snapshotId
                    const activeRestoreRepo = restoreLoadedRepoDir.trim()
                    const verifiedInfo = activeRestoreRepo
                      ? verifiedByKey[`${activeRestoreRepo}::${rp.snapshotId}`]
                      : null

                    return (
                      <label
                        key={rp.snapshotId}
                        className={`backup-restore-choice${
                          isSelected ? ' backup-restore-choice-selected' : ''
                        }`}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                          <input
                            type="radio"
                            name="restore-backup-choice"
                            checked={isSelected}
                            onChange={() => setSelectedRestoreSnapshotId(rp.snapshotId)}
                          />
                          <div>
                            <div style={{ fontWeight: 500, color: 'var(--text-main)' }}>
                              {formatTimestamp(rp.completedAtMs ?? rp.createdAtMs)}
                            </div>
                            <div style={{ fontSize: '12.5px', color: 'var(--text-muted)' }}>
                              {formatVaultFileCount(rp.vaultCopyCount)}
                              {rp.vaultName ? ` (${rp.vaultName})` : ''} •{' '}
                              {formatBytes(rp.totalLogicalBytes)}
                            </div>
                          </div>
                        </div>
                        {verifiedInfo && (
                          <span className="backup-verified-pill">
                            <ShieldCheck size={12} aria-hidden="true" />
                            Verified
                          </span>
                        )}
                      </label>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Step 2: Choose one restore location */}
            <div className="backup-restore-step">
              <div className="backup-restore-step-header">
                <span className="backup-step-badge">2</span>
                <span>Choose one restore location</span>
              </div>
              <p style={{ color: 'var(--text-muted)', margin: 0, fontSize: '13px' }}>
                Pick one new or empty folder. Personal Vault will prepare separate{' '}
                <code>profile</code> and <code>vault</code> subfolders inside it, keeping your
                current library untouched.
              </p>

              <div className="backup-field-row">
                <label style={{ flex: 1, minWidth: '240px' }}>
                  Restore Location (empty folder)
                  <input
                    type="text"
                    value={restoreLocationDir}
                    onChange={(e) => setRestoreLocationDir(e.target.value)}
                    placeholder="e.g. D:\RestoredVault"
                    style={{ width: '100%' }}
                  />
                </label>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() =>
                    void handleBrowseFolder('Select Empty Restore Location', setRestoreLocationDir)
                  }
                >
                  <FolderOpen size={14} aria-hidden="true" /> Browse…
                </button>
              </div>

              {preparedProfilePreview && (
                <div className="backup-restore-subfolders">
                  <div>
                    Profile subfolder: <code>{preparedProfilePreview}</code>
                  </div>
                  {preparedVaultPreview ? (
                    <div>
                      Vault subfolder: <code>{preparedVaultPreview}</code>
                    </div>
                  ) : (
                    <div>No vault subfolder needed (this backup contains catalog data only).</div>
                  )}
                </div>
              )}

              {(restoreLoadedRepoDir.startsWith('gdrive:') ||
                selectedRestoreChoice?.integrityStatus === 'sealed_unverified' ||
                (!useCustomRestoreSource &&
                  selectedDestination?.encryptionMode === 'aes-256-gcm-v1')) && (
                <div className="backup-field-row">
                  <label style={{ flex: 1, minWidth: '240px' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                      <KeyRound size={14} aria-hidden="true" /> Recovery Secret (for encrypted
                      restore)
                    </span>
                    <input
                      type="password"
                      autoComplete="new-password"
                      data-testid="restore-recovery-secret-input"
                      value={restoreRecoverySecret}
                      onChange={(e) => setRestoreRecoverySecret(e.target.value)}
                      placeholder="Enter backup encryption recovery secret"
                      style={{ width: '100%' }}
                    />
                  </label>
                </div>
              )}

              <div>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={
                    isBusy ||
                    !isRestoreSourceSynced ||
                    !selectedRestoreSnapshotId ||
                    !restoreLocationDir.trim()
                  }
                  onClick={() => void handleRestoreFiles()}
                >
                  <RotateCcw size={14} aria-hidden="true" /> Restore files
                </button>
              </div>
            </div>

            {/* Step 3: Where your files went & how to open */}
            {restoreResult && (
              <div className="backup-restore-result-box" role="status">
                <div className="backup-restore-step-header">
                  <CheckCircle2 size={18} color="#6ed49b" aria-hidden="true" />
                  <span>Restore complete — {restoreResult.verifiedFileCount} files restored</span>
                </div>

                {restoreResult.restoredVaultPath && (
                  <div style={{ fontSize: '13px' }}>
                    <strong>Restored vault files:</strong>{' '}
                    <code>{restoreResult.restoredVaultPath}</code>
                    <div style={{ color: 'var(--text-muted)', marginTop: '2px' }}>
                      Open this folder in File Explorer to browse and open your restored photos and
                      documents directly.
                    </div>
                  </div>
                )}

                <div style={{ fontSize: '13px' }}>
                  <strong>Restored profile:</strong>{' '}
                  <code>{restoreResult.restoredProfilePath}</code>
                </div>

                <div style={{ fontSize: '13px' }}>
                  <strong>How to open the restored copy in Personal Vault:</strong>
                  <div className="backup-command-row" style={{ marginTop: '6px' }}>
                    <code className="backup-command-code">{launchCommand}</code>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => {
                        void navigator.clipboard?.writeText(launchCommand)
                        setCopiedCommand(true)
                      }}
                    >
                      <Copy size={14} aria-hidden="true" />{' '}
                      {copiedCommand ? 'Copied' : 'Copy launch flag'}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </article>

        {/* Recover catalog from an existing surviving vault */}
        <article
          className="backup-card"
          aria-label="Recover from an existing vault"
          data-testid="recover-from-vault-section"
          style={{ marginTop: '16px' }}
        >
          <div className="backup-card-header">
            <h2 className="backup-card-title">
              <ShieldCheck size={18} aria-hidden="true" /> Recover from an existing vault
            </h2>
          </div>
          <div className="backup-restore-body">
            <p className="backup-card-subtitle" style={{ marginTop: 0 }}>
              Rebuild a catalog of <strong>imported files</strong> in a new, empty profile directly
              from a surviving vault&apos;s manifests. The surviving vault is verified and bound{' '}
              <strong>read-only</strong> without modifying it or your active profile.
            </p>
            <div className="backup-notice-box" role="note">
              <AlertTriangle size={16} aria-hidden="true" />
              <span>
                <strong>Scope note:</strong> Recovering from an existing vault rebuilds imported
                vault files and recorded provenance only. Use <strong>Restore from Backup</strong>{' '}
                above to recover ratings, collections, duplicate reviews, similarity decisions,
                document overrides, and other user edits.
              </span>
            </div>

            <div className="backup-form-field">
              <label htmlFor="recover-vault-dir-input">Surviving vault folder</label>
              <div className="backup-path-row">
                <input
                  id="recover-vault-dir-input"
                  data-testid="recover-vault-dir-input"
                  type="text"
                  className="backup-input"
                  placeholder="E:\PersonalVault"
                  value={recoverVaultDir}
                  onChange={(e) => setRecoverVaultDir(e.target.value)}
                />
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() =>
                    void handleBrowseFolder('Select Surviving Vault Folder', setRecoverVaultDir)
                  }
                >
                  <FolderOpen size={14} aria-hidden="true" /> Browse…
                </button>
              </div>
            </div>

            <div className="backup-form-field">
              <label htmlFor="recover-profile-dir-input">New empty profile folder</label>
              <div className="backup-path-row">
                <input
                  id="recover-profile-dir-input"
                  data-testid="recover-profile-dir-input"
                  type="text"
                  className="backup-input"
                  placeholder="C:\Users\You\RecoveredProfile"
                  value={recoverTargetProfileDir}
                  onChange={(e) => setRecoverTargetProfileDir(e.target.value)}
                />
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() =>
                    void handleBrowseFolder(
                      'Select New Empty Profile Folder',
                      setRecoverTargetProfileDir
                    )
                  }
                >
                  <FolderOpen size={14} aria-hidden="true" /> Browse…
                </button>
              </div>
            </div>

            <div>
              <button
                type="button"
                className="btn btn-primary"
                data-testid="recover-catalog-submit-btn"
                disabled={isBusy || !recoverVaultDir.trim() || !recoverTargetProfileDir.trim()}
                onClick={() => void handleRecoverFromVault()}
              >
                <RotateCcw size={14} aria-hidden="true" /> Recover from an existing vault
              </button>
            </div>

            {recoverResult && (
              <div
                className="backup-restore-result-box"
                role="status"
                data-testid="recover-catalog-result"
              >
                <div className="backup-restore-step-header">
                  <CheckCircle2 size={18} color="#6ed49b" aria-hidden="true" />
                  <span>
                    Catalog rebuilt — {recoverResult.recoveredVaultCopies} verified vault copies (
                    {recoverResult.recoveredFileLocations} locations)
                  </span>
                </div>
                <div style={{ fontSize: '13px' }}>
                  <strong>Surviving vault (read-only):</strong>{' '}
                  <code>{recoverResult.sourceVaultDir}</code>
                </div>
                <div style={{ fontSize: '13px' }}>
                  <strong>New recovered profile:</strong>{' '}
                  <code>{recoverResult.targetProfileDir}</code>
                </div>
                <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                  Ratings, collections, duplicate reviews, similarity decisions, and document
                  overrides were not present in vault manifests and require a full backup restore.
                </div>
                <div style={{ fontSize: '13px' }}>
                  <strong>How to open the recovered profile in Personal Vault:</strong>
                  <div className="backup-command-row" style={{ marginTop: '6px' }}>
                    <code className="backup-command-code">{`--user-data-dir="${recoverResult.targetProfileDir}"`}</code>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => {
                        void navigator.clipboard?.writeText(
                          `--user-data-dir="${recoverResult.targetProfileDir}"`
                        )
                        setCopiedRecoverCommand(true)
                      }}
                    >
                      <Copy size={14} aria-hidden="true" />{' '}
                      {copiedRecoverCommand ? 'Copied' : 'Copy launch flag'}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </article>
      </section>
    </div>
  )
}
