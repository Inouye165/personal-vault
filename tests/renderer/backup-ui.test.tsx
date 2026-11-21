// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BackupRestorePanel } from '../../src/renderer/src/components/BackupRestorePanel'
import type { BackupProgressEvent } from '../../src/shared/validation/backup-ipc-schemas'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const baseDest = {
  id: 'dest-1',
  name: 'NAS Share',
  kind: 'local_fs' as const,
  targetPath: '\\\\NAS\\Backups\\PersonalVault',
  maxBytesPerSecond: 10 * 1024 * 1024,
  dailyBudgetBytes: null,
  encryptionMode: 'none' as const,
  repositoryId: 'repo-1',
  isEnabled: true,
  lastVerifiedSnapshotId: '2026-11-21T00-00-00Z_abc12345',
  lastVerifiedAtMs: 2000,
  createdAtMs: 1000,
  updatedAtMs: 2000
}

describe('BackupRestorePanel — Redesigned everyday view', () => {
  it('shows summary first, hides setup behind Change backup location, keeps Backup completed distinct from Verified on, and supports guided restore', async () => {
    const pausedJob = {
      id: 'job-1',
      destinationId: 'dest-1',
      snapshotId: '2026-11-21T00-00-00Z_abc12345',
      repositoryId: 'repo-1',
      status: 'paused' as const,
      pauseReason: 'destination_unavailable' as const,
      stagingDir: 'C:\\staging\\job-1',
      verificationScope: null,
      totalObjectCount: 10,
      completedObjectCount: 4,
      writtenChunkCount: 4,
      reusedChunkCount: 0,
      totalLogicalBytes: 4096,
      totalStoredBytes: 4096,
      transferredBytes: 2048,
      manifestSha256: null,
      abandonedFromJobId: null,
      errorCode: null,
      errorMessage: null,
      createdAtMs: 1000,
      startedAtMs: 1000,
      updatedAtMs: 2000,
      completedAtMs: null
    }

    const mockApi = {
      listBackupDestinations: vi.fn().mockResolvedValue([baseDest]),
      listBackupJobs: vi
        .fn()
        .mockResolvedValue({ items: [pausedJob], total: 1, limit: 20, offset: 0 }),
      getActiveBackupJob: vi.fn().mockResolvedValue(null),
      onBackupProgress: vi
        .fn<(_listener: (event: BackupProgressEvent) => void) => () => void>()
        .mockReturnValue(() => {}),
      selectBackupDirectory: vi.fn().mockResolvedValue({
        canceled: false,
        directoryPath: 'D:\\Restores\\Run1'
      }),
      configureBackupDestination: vi.fn().mockResolvedValue(baseDest),
      startBackup: vi
        .fn()
        .mockResolvedValue({ ...pausedJob, status: 'capturing', pauseReason: null }),
      pauseBackup: vi.fn().mockResolvedValue({ accepted: true, jobId: 'job-1' }),
      resumeBackup: vi
        .fn()
        .mockResolvedValue({ ...pausedJob, status: 'running', pauseReason: null }),
      cancelBackup: vi.fn().mockResolvedValue({ accepted: true, jobId: 'job-1' }),
      listRecoveryPoints: vi.fn().mockResolvedValue({
        backupRepoDir: '\\\\NAS\\Backups\\PersonalVault',
        repositoryId: 'repo-1',
        recoveryPoints: [
          {
            snapshotId: '2026-11-21T00-00-00Z_abc12345',
            isComplete: true,
            reasons: [],
            repositoryId: 'repo-1',
            createdAtMs: 1000,
            completedAtMs: 2000,
            verificationScope: 'full_readback' as const,
            totalObjectCount: 10,
            totalLogicalBytes: 4096,
            totalStoredBytes: 4096,
            vaultName: 'My Vault',
            vaultCopyCount: 2
          }
        ]
      }),
      verifyRecoveryPoint: vi.fn().mockResolvedValue({
        repositoryId: 'repo-1',
        snapshotId: '2026-11-21T00-00-00Z_abc12345',
        schemaVersion: 17,
        verifiedObjectCount: 10,
        verifiedFileCount: 5,
        hasVault: true,
        hasAnnotations: true
      }),
      restoreRecoveryPoint: vi.fn().mockResolvedValue({
        restoreJobId: 'restore-1',
        repositoryId: 'repo-1',
        snapshotId: '2026-11-21T00-00-00Z_abc12345',
        restoredProfilePath: 'D:\\Restores\\Run1\\profile',
        restoredVaultPath: 'D:\\Restores\\Run1\\vault',
        catalogSha256: 'a'.repeat(64),
        verifiedFileCount: 5,
        restoredAtMs: 3000
      })
    }

    Object.defineProperty(window, 'api', {
      value: mockApi,
      configurable: true
    })

    render(<BackupRestorePanel />)

    expect(screen.getByText(/files outside the vault are excluded/i)).toBeInTheDocument()

    // Setup & NAS speed limit are hidden behind "Change backup location" once configured
    const changeLocationBtn = await screen.findByRole('button', { name: /Change backup location/i })
    expect(screen.queryByLabelText(/NAS Transfer Speed Limit/i)).not.toBeInTheDocument()
    fireEvent.click(changeLocationBtn)
    fireEvent.click(screen.getByLabelText(/NAS \/ Network Share/i))
    expect(screen.getByLabelText(/NAS Transfer Speed Limit/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Close location settings/i }))
    expect(screen.queryByLabelText(/NAS Transfer Speed Limit/i)).not.toBeInTheDocument()

    await waitFor(() => {
      expect(screen.getByTestId('backup-job-status-job-1')).toHaveTextContent('paused')
    })
    expect(screen.getByText(/backup paused — destination disconnected/i)).toBeInTheDocument()

    // Snapshot ID and chunk stats are hidden behind Details
    expect(screen.queryByText(/2026-11-21T00-00-00Z_abc12345/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Details/i }))
    expect(screen.getByText(/2026-11-21T00-00-00Z_abc12345/)).toBeInTheDocument()
    expect(screen.getByText(/written: 4, reused: 0/i)).toBeInTheDocument()

    // Resume -> running
    const runningJob = { ...pausedJob, status: 'running' as const, pauseReason: null }
    mockApi.listBackupJobs.mockResolvedValue({
      items: [runningJob],
      total: 1,
      limit: 20,
      offset: 0
    })
    fireEvent.click(screen.getAllByRole('button', { name: /Resume/i })[0]!)
    await screen.findByText('Backup in progress')
    expect(mockApi.resumeBackup).toHaveBeenCalledWith('job-1')

    // Failure notice
    const failedJob = {
      ...runningJob,
      status: 'failed' as const,
      errorMessage: 'The drive is full.'
    }
    mockApi.listBackupJobs.mockResolvedValue({ items: [failedJob], total: 1, limit: 20, offset: 0 })
    await act(async () => {
      mockApi.onBackupProgress.mock.lastCall?.[0]({ job: failedJob })
    })
    expect(screen.getByRole('alert')).toHaveTextContent(/backup failed/i)
    expect(screen.getAllByText(/the drive is full/i)).not.toHaveLength(0)

    // Completed backup: "Backup completed successfully" must NOT show "Verified on" yet
    const completedJob = {
      ...runningJob,
      status: 'completed' as const,
      completedObjectCount: 10,
      completedAtMs: 2000
    }
    mockApi.startBackup.mockImplementationOnce(async () => {
      mockApi.listBackupJobs.mockResolvedValue({
        items: [completedJob],
        total: 1,
        limit: 20,
        offset: 0
      })
      return { ...runningJob, status: 'capturing' }
    })
    fireEvent.click(screen.getByRole('button', { name: /Back up now/i }))
    expect(await screen.findByText('Backup completed successfully')).toBeInTheDocument()
    expect(screen.getByText('2 vault files')).toBeInTheDocument()
    expect(screen.queryByText(/Verified on/i)).not.toBeInTheDocument()

    // Verify backup button next to summary -> shows "Verified on [date]"
    fireEvent.click(screen.getByRole('button', { name: /Verify backup/i }))
    await waitFor(() => {
      expect(mockApi.verifyRecoveryPoint).toHaveBeenCalledWith({
        backupRepoDir: '\\\\NAS\\Backups\\PersonalVault',
        snapshotId: '2026-11-21T00-00-00Z_abc12345'
      })
    })
    expect(await screen.findAllByText(/Verified on /i)).not.toHaveLength(0)

    // Guided Restore: choose single restore location -> prepares profile and vault subfolders
    fireEvent.change(screen.getByLabelText(/Restore Location/i), {
      target: { value: 'D:\\Restores\\Run1' }
    })
    expect(screen.getByText('D:\\Restores\\Run1\\profile')).toBeInTheDocument()
    expect(screen.getByText('D:\\Restores\\Run1\\vault')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Restore files/i }))
    await waitFor(() => {
      expect(mockApi.restoreRecoveryPoint).toHaveBeenCalledWith({
        backupRepoDir: '\\\\NAS\\Backups\\PersonalVault',
        snapshotId: '2026-11-21T00-00-00Z_abc12345',
        targetProfileDir: 'D:\\Restores\\Run1\\profile',
        targetVaultDir: 'D:\\Restores\\Run1\\vault'
      })
    })
    expect(await screen.findByText(/Restore complete — 5 files restored/i)).toBeInTheDocument()
    expect(screen.getByText(/--user-data-dir="D:\\Restores\\Run1\\profile"/)).toBeInTheDocument()
  })

  it('shows zero-file message for catalog-only backup and unavailable count when destination is disconnected', async () => {
    const completedJob = {
      id: 'job-2',
      destinationId: 'dest-1',
      snapshotId: '2026-11-21T01-00-00Z_zero0000',
      repositoryId: 'repo-1',
      status: 'completed' as const,
      pauseReason: null,
      stagingDir: null,
      verificationScope: 'full_readback' as const,
      totalObjectCount: 2,
      completedObjectCount: 2,
      writtenChunkCount: 2,
      reusedChunkCount: 0,
      totalLogicalBytes: 1024,
      totalStoredBytes: 1024,
      transferredBytes: 1024,
      manifestSha256: null,
      abandonedFromJobId: null,
      errorCode: null,
      errorMessage: null,
      createdAtMs: 1000,
      startedAtMs: 1000,
      updatedAtMs: 2000,
      completedAtMs: 2000
    }

    const listRecoveryPoints = vi
      .fn()
      .mockResolvedValueOnce({
        backupRepoDir: '\\\\NAS\\Backups\\PersonalVault',
        repositoryId: 'repo-1',
        recoveryPoints: [
          {
            snapshotId: '2026-11-21T01-00-00Z_zero0000',
            isComplete: true,
            reasons: [],
            repositoryId: 'repo-1',
            createdAtMs: 1000,
            completedAtMs: 2000,
            verificationScope: 'full_readback' as const,
            totalObjectCount: 2,
            totalLogicalBytes: 1024,
            totalStoredBytes: 1024,
            vaultName: null,
            vaultCopyCount: 0
          }
        ]
      })
      .mockRejectedValueOnce(new Error('ENOENT: drive disconnected'))

    Object.defineProperty(window, 'api', {
      value: {
        listBackupDestinations: vi.fn().mockResolvedValue([baseDest]),
        listBackupJobs: vi
          .fn()
          .mockResolvedValue({ items: [completedJob], total: 1, limit: 20, offset: 0 }),
        getActiveBackupJob: vi.fn().mockResolvedValue(null),
        onBackupProgress: vi.fn().mockReturnValue(() => {}),
        listRecoveryPoints
      },
      configurable: true
    })

    render(<BackupRestorePanel />)

    expect(await screen.findByText(/No photos or documents were backed up\./i)).toBeInTheDocument()
    expect(
      screen.getByText(/Scanned files must be imported into the vault to be included/i)
    ).toBeInTheDocument()

    // Refresh when destination is disconnected -> shows File count unavailable
    fireEvent.click(screen.getByRole('button', { name: /Refresh backup history/i }))
    expect(await screen.findAllByText(/File count unavailable/i)).not.toHaveLength(0)
  })

  it('distinguishes an empty initialized vault from a profile with no vault during restore', async () => {
    const restoreRecoveryPoint = vi.fn().mockResolvedValue({
      restoreJobId: 'restore-empty-vault',
      repositoryId: 'repo-1',
      snapshotId: 'snap-empty-vault',
      restoredProfilePath: 'D:\\Restores\\EmptyVault\\profile',
      restoredVaultPath: 'D:\\Restores\\EmptyVault\\vault',
      catalogSha256: 'b'.repeat(64),
      verifiedFileCount: 2,
      restoredAtMs: 4000
    })

    Object.defineProperty(window, 'api', {
      value: {
        listBackupDestinations: vi.fn().mockResolvedValue([baseDest]),
        listBackupJobs: vi.fn().mockResolvedValue({ items: [], total: 0, limit: 20, offset: 0 }),
        getActiveBackupJob: vi.fn().mockResolvedValue(null),
        onBackupProgress: vi.fn().mockReturnValue(() => {}),
        listRecoveryPoints: vi.fn().mockResolvedValue({
          backupRepoDir: '\\\\NAS\\Backups\\PersonalVault',
          repositoryId: 'repo-1',
          recoveryPoints: [
            {
              snapshotId: 'snap-empty-vault',
              isComplete: true,
              reasons: [],
              repositoryId: 'repo-1',
              createdAtMs: 2000,
              completedAtMs: 3000,
              verificationScope: 'full_readback' as const,
              totalObjectCount: 3,
              totalLogicalBytes: 2048,
              totalStoredBytes: 2048,
              vaultName: 'Empty Vault',
              vaultCopyCount: 0
            },
            {
              snapshotId: 'snap-no-vault',
              isComplete: true,
              reasons: [],
              repositoryId: 'repo-1',
              createdAtMs: 1000,
              completedAtMs: 2000,
              verificationScope: 'full_readback' as const,
              totalObjectCount: 2,
              totalLogicalBytes: 1024,
              totalStoredBytes: 1024,
              vaultName: null,
              vaultCopyCount: 0
            }
          ]
        }),
        restoreRecoveryPoint
      },
      configurable: true
    })

    render(<BackupRestorePanel />)

    await screen.findAllByText(/Empty Vault/i)
    fireEvent.change(screen.getByLabelText(/Restore Location/i), {
      target: { value: 'D:\\Restores\\EmptyVault' }
    })

    // Empty initialized vault (vaultName !== null, vaultCopyCount === 0) MUST prepare vault subfolder
    expect(screen.getByText('D:\\Restores\\EmptyVault\\vault')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Restore files/i }))
    await waitFor(() => {
      expect(restoreRecoveryPoint).toHaveBeenCalledWith({
        backupRepoDir: '\\\\NAS\\Backups\\PersonalVault',
        snapshotId: 'snap-empty-vault',
        targetProfileDir: 'D:\\Restores\\EmptyVault\\profile',
        targetVaultDir: 'D:\\Restores\\EmptyVault\\vault'
      })
    })

    // Switching to profile with no vault (vaultName === null) passes targetVaultDir: null
    const radios = screen.getAllByRole('radio')
    fireEvent.click(radios[1]!)
    expect(
      screen.getByText(/No vault subfolder needed \(this backup contains catalog data only\)/i)
    ).toBeInTheDocument()
  })

  it('clears the Verified badge when a subsequent re-verification fails', async () => {
    const verifyRecoveryPoint = vi
      .fn()
      .mockResolvedValueOnce({
        repositoryId: 'repo-1',
        snapshotId: 'snap-1',
        schemaVersion: 17,
        verifiedObjectCount: 4,
        verifiedFileCount: 4,
        hasVault: true,
        hasAnnotations: true
      })
      .mockRejectedValueOnce(new Error('Chunk SHA-256 mismatch'))

    Object.defineProperty(window, 'api', {
      value: {
        listBackupDestinations: vi.fn().mockResolvedValue([baseDest]),
        listBackupJobs: vi.fn().mockResolvedValue({ items: [], total: 0, limit: 20, offset: 0 }),
        getActiveBackupJob: vi.fn().mockResolvedValue(null),
        onBackupProgress: vi.fn().mockReturnValue(() => {}),
        listRecoveryPoints: vi.fn().mockResolvedValue({
          backupRepoDir: '\\\\NAS\\Backups\\PersonalVault',
          repositoryId: 'repo-1',
          recoveryPoints: [
            {
              snapshotId: 'snap-1',
              isComplete: true,
              reasons: [],
              repositoryId: 'repo-1',
              createdAtMs: 1000,
              completedAtMs: 2000,
              verificationScope: 'full_readback' as const,
              totalObjectCount: 4,
              totalLogicalBytes: 2048,
              totalStoredBytes: 2048,
              vaultName: 'My Vault',
              vaultCopyCount: 1
            }
          ]
        }),
        verifyRecoveryPoint
      },
      configurable: true
    })

    render(<BackupRestorePanel />)

    const verifyBtn = await screen.findByRole('button', { name: /Verify backup/i })
    await waitFor(() => expect(verifyBtn).not.toBeDisabled())

    fireEvent.click(verifyBtn)
    expect(await screen.findAllByText(/Verified on /i)).not.toHaveLength(0)

    // Re-verify fails -> stale Verified badge must be cleared
    fireEvent.click(verifyBtn)
    expect(await screen.findByRole('alert')).toHaveTextContent(/Chunk SHA-256 mismatch/i)
    expect(screen.queryByText(/Verified on /i)).not.toBeInTheDocument()
  })

  it('binds restore choices to the folder they were loaded from and blocks restore until reloaded', async () => {
    const listRecoveryPoints = vi
      .fn()
      .mockResolvedValueOnce({
        backupRepoDir: '\\\\NAS\\Backups\\PersonalVault',
        repositoryId: 'repo-1',
        recoveryPoints: [
          {
            snapshotId: 'snap-from-nas',
            isComplete: true,
            reasons: [],
            repositoryId: 'repo-1',
            createdAtMs: 1000,
            completedAtMs: 2000,
            verificationScope: 'full_readback' as const,
            totalObjectCount: 4,
            totalLogicalBytes: 2048,
            totalStoredBytes: 2048,
            vaultName: 'NAS Vault',
            vaultCopyCount: 1
          }
        ]
      })
      .mockResolvedValueOnce({
        backupRepoDir: 'E:\\OtherBackup',
        repositoryId: 'repo-2',
        recoveryPoints: [
          {
            snapshotId: 'snap-from-usb',
            isComplete: true,
            reasons: [],
            repositoryId: 'repo-2',
            createdAtMs: 3000,
            completedAtMs: 4000,
            verificationScope: 'full_readback' as const,
            totalObjectCount: 6,
            totalLogicalBytes: 4096,
            totalStoredBytes: 4096,
            vaultName: 'USB Vault',
            vaultCopyCount: 3
          }
        ]
      })

    const restoreRecoveryPoint = vi.fn().mockResolvedValue({
      restoreJobId: 'restore-usb',
      repositoryId: 'repo-2',
      snapshotId: 'snap-from-usb',
      restoredProfilePath: 'D:\\Restores\\USB\\profile',
      restoredVaultPath: 'D:\\Restores\\USB\\vault',
      catalogSha256: 'c'.repeat(64),
      verifiedFileCount: 6,
      restoredAtMs: 5000
    })

    Object.defineProperty(window, 'api', {
      value: {
        listBackupDestinations: vi.fn().mockResolvedValue([baseDest]),
        listBackupJobs: vi.fn().mockResolvedValue({ items: [], total: 0, limit: 20, offset: 0 }),
        getActiveBackupJob: vi.fn().mockResolvedValue(null),
        onBackupProgress: vi.fn().mockReturnValue(() => {}),
        listRecoveryPoints,
        restoreRecoveryPoint
      },
      configurable: true
    })

    render(<BackupRestorePanel />)

    await screen.findAllByText(/NAS Vault/i)
    fireEvent.change(screen.getByLabelText(/Restore Location/i), {
      target: { value: 'D:\\Restores\\USB' }
    })

    // Switch to custom folder and edit path without clicking Load backups
    fireEvent.click(screen.getByRole('button', { name: /Choose another backup folder/i }))
    fireEvent.change(screen.getByLabelText(/Backup Repository Folder/i), {
      target: { value: 'E:\\OtherBackup' }
    })

    expect(screen.getByText(/Backup folder changed\./i)).toBeInTheDocument()
    const restoreBtn = screen.getByRole('button', { name: /Restore files/i })
    expect(restoreBtn).toBeDisabled()

    // Click Load backups -> loads from E:\OtherBackup and enables restore bound to E:\OtherBackup
    fireEvent.click(screen.getByRole('button', { name: /Load backups/i }))
    await screen.findAllByText(/USB Vault/i)
    expect(restoreBtn).not.toBeDisabled()

    fireEvent.click(restoreBtn)
    await waitFor(() => {
      expect(restoreRecoveryPoint).toHaveBeenCalledWith({
        backupRepoDir: 'E:\\OtherBackup',
        snapshotId: 'snap-from-usb',
        targetProfileDir: 'D:\\Restores\\USB\\profile',
        targetVaultDir: 'D:\\Restores\\USB\\vault'
      })
    })
  })

  it('hides stale restore choices, disables restore while switching destinations, and ignores late responses from the previous folder', async () => {
    const destA = { ...baseDest, id: 'dest-a', name: 'Drive A', targetPath: 'E:\\BackupA' }
    const destB = { ...baseDest, id: 'dest-b', name: 'Drive B', targetPath: 'F:\\BackupB' }

    let resolveLateA!: (val: unknown) => void
    let resolveB!: (val: unknown) => void

    const listRecoveryPoints = vi.fn(({ backupRepoDir }: { backupRepoDir: string }) => {
      if (backupRepoDir === 'E:\\BackupA') {
        if (listRecoveryPoints.mock.calls.length === 1) {
          return Promise.resolve({
            backupRepoDir: 'E:\\BackupA',
            repositoryId: 'repo-a',
            recoveryPoints: [
              {
                snapshotId: 'snap-a',
                isComplete: true,
                reasons: [],
                repositoryId: 'repo-a',
                createdAtMs: 1000,
                completedAtMs: 2000,
                verificationScope: 'full_readback' as const,
                totalObjectCount: 3,
                totalLogicalBytes: 1024,
                totalStoredBytes: 1024,
                vaultName: 'Vault A',
                vaultCopyCount: 1
              }
            ]
          })
        }
        return new Promise((resolve) => {
          resolveLateA = resolve
        })
      }
      return new Promise((resolve) => {
        resolveB = resolve
      })
    })

    const restoreRecoveryPoint = vi.fn().mockResolvedValue({
      restoreJobId: 'restore-b',
      repositoryId: 'repo-b',
      snapshotId: 'snap-b',
      restoredProfilePath: 'D:\\Restores\\B\\profile',
      restoredVaultPath: 'D:\\Restores\\B\\vault',
      catalogSha256: 'd'.repeat(64),
      verifiedFileCount: 5,
      restoredAtMs: 5000
    })

    Object.defineProperty(window, 'api', {
      value: {
        listBackupDestinations: vi.fn().mockResolvedValue([destA, destB]),
        listBackupJobs: vi.fn().mockResolvedValue({ items: [], total: 0, limit: 20, offset: 0 }),
        getActiveBackupJob: vi.fn().mockResolvedValue(null),
        onBackupProgress: vi.fn().mockReturnValue(() => {}),
        listRecoveryPoints,
        restoreRecoveryPoint
      },
      configurable: true
    })

    render(<BackupRestorePanel />)

    await screen.findAllByText(/Vault A/i)
    fireEvent.change(screen.getByLabelText(/Restore Location/i), {
      target: { value: 'D:\\Restores\\B' }
    })

    const restoreBtn = screen.getByRole('button', { name: /Restore files/i })
    await waitFor(() => expect(restoreBtn).not.toBeDisabled())

    // Open location settings and trigger a refresh of Drive A, then switch to Drive B before it resolves
    fireEvent.click(screen.getByRole('button', { name: /Change backup location/i }))
    fireEvent.click(screen.getByRole('button', { name: /Refresh backup history/i }))
    fireEvent.click(screen.getByLabelText(/Drive B/i))

    // Stale Drive A restore choices must be hidden immediately and Restore must be disabled while Drive B loads
    expect(screen.queryByText(/\(Vault A\)/i)).not.toBeInTheDocument()
    expect(restoreBtn).toBeDisabled()

    // Late response from Drive A resolves after switching to Drive B -> must be ignored
    await act(async () => {
      resolveLateA({
        backupRepoDir: 'E:\\BackupA',
        repositoryId: 'repo-a',
        recoveryPoints: [
          {
            snapshotId: 'snap-a-late',
            isComplete: true,
            reasons: [],
            repositoryId: 'repo-a',
            createdAtMs: 1500,
            completedAtMs: 2500,
            verificationScope: 'full_readback' as const,
            totalObjectCount: 3,
            totalLogicalBytes: 1024,
            totalStoredBytes: 1024,
            vaultName: 'Vault A Late',
            vaultCopyCount: 1
          }
        ]
      })
    })
    expect(screen.queryByText(/Vault A Late/i)).not.toBeInTheDocument()
    expect(restoreBtn).toBeDisabled()

    // Drive B finishes loading -> Drive B choices appear and Restore is enabled for Drive B
    await act(async () => {
      resolveB({
        backupRepoDir: 'F:\\BackupB',
        repositoryId: 'repo-b',
        recoveryPoints: [
          {
            snapshotId: 'snap-b',
            isComplete: true,
            reasons: [],
            repositoryId: 'repo-b',
            createdAtMs: 3000,
            completedAtMs: 4000,
            verificationScope: 'full_readback' as const,
            totalObjectCount: 5,
            totalLogicalBytes: 2048,
            totalStoredBytes: 2048,
            vaultName: 'Vault B',
            vaultCopyCount: 2
          }
        ]
      })
    })

    await screen.findAllByText(/Vault B/i)
    expect(restoreBtn).not.toBeDisabled()

    fireEvent.click(restoreBtn)
    await waitFor(() => {
      expect(restoreRecoveryPoint).toHaveBeenCalledWith({
        backupRepoDir: 'F:\\BackupB',
        snapshotId: 'snap-b',
        targetProfileDir: 'D:\\Restores\\B\\profile',
        targetVaultDir: 'D:\\Restores\\B\\vault'
      })
    })
  })
})
