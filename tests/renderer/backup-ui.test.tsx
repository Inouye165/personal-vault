// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BackupRestorePanel } from '../../src/renderer/src/components/BackupRestorePanel'
import type {
  BackupProgressEvent,
  BackupSummaryDto
} from '../../src/shared/validation/backup-ipc-schemas'

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

  it('recovers a catalog from an existing surviving vault and discloses full-restore scope', async () => {
    const recoverCatalogFromVault = vi.fn().mockResolvedValue({
      recoveryJobId: 'rec-job-1',
      vaultId: 'vault-uuid-1',
      vaultName: 'Surviving Vault',
      sourceVaultDir: 'E:\\SurvivingVault',
      targetProfileDir: 'D:\\RecoveredProfile',
      catalogPath: 'D:\\RecoveredProfile\\vault-catalog.db',
      catalogSha256: 'a'.repeat(64),
      recoveredVaultCopies: 2,
      recoveredSources: 1,
      recoveredFileLocations: 2,
      recoveredObservations: 2,
      historicalObservations: 0,
      recoveredAtMs: 5000,
      currentVersionSelectionNote: 'inferred_from_manifest_evidence',
      omittedDataCategories: ['photo_annotations', 'collections']
    })

    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        listBackupDestinations: vi.fn().mockResolvedValue([]),
        listBackupJobs: vi.fn().mockResolvedValue({ items: [], total: 0, limit: 20, offset: 0 }),
        getActiveBackupJob: vi.fn().mockResolvedValue(null),
        listRecoveryPoints: vi.fn().mockResolvedValue({
          backupRepoDir: '',
          repositoryId: null,
          recoveryPoints: []
        }),
        selectBackupDirectory: vi.fn().mockResolvedValue({ canceled: true, directoryPath: null }),
        onBackupProgress: vi.fn().mockReturnValue(() => {}),
        recoverCatalogFromVault
      }
    })

    render(<BackupRestorePanel />)

    const section = await screen.findByTestId('recover-from-vault-section')
    expect(section).toHaveTextContent(/Recover from an existing vault/i)
    expect(section).toHaveTextContent(/without modifying it/i)
    expect(section).toHaveTextContent(/ratings, collections/i)

    fireEvent.change(screen.getByTestId('recover-vault-dir-input'), {
      target: { value: 'E:\\SurvivingVault' }
    })
    fireEvent.change(screen.getByTestId('recover-profile-dir-input'), {
      target: { value: 'D:\\RecoveredProfile' }
    })

    fireEvent.click(screen.getByTestId('recover-catalog-submit-btn'))

    await waitFor(() => {
      expect(recoverCatalogFromVault).toHaveBeenCalledWith({
        sourceVaultDir: 'E:\\SurvivingVault',
        targetProfileDir: 'D:\\RecoveredProfile'
      })
    })

    const resultBox = await screen.findByTestId('recover-catalog-result')
    expect(resultBox).toHaveTextContent(/2 verified vault copies/i)
    expect(resultBox).toHaveTextContent(/--user-data-dir="D:\\RecoveredProfile"/)
  })

  it('supports Google Drive account connect/disconnect, folder creation, speed & rolling budget setup, budget-exhausted resume, and remote restore', async () => {
    const driveDest = {
      id: 'dest-gdrive-1',
      name: 'Google Drive Backup',
      kind: 'google_drive' as const,
      targetPath: 'folder-2',
      maxBytesPerSecond: 2 * 1024 * 1024,
      dailyBudgetBytes: 512 * 1024 * 1024,
      encryptionMode: 'aes-256-gcm-v1' as const,
      repositoryId: 'repo-gdrive-1',
      isEnabled: true,
      lastVerifiedSnapshotId: null,
      lastVerifiedAtMs: null,
      createdAtMs: 1000,
      updatedAtMs: 2000
    }

    const budgetPausedJob = {
      id: 'job-gdrive-1',
      destinationId: 'dest-gdrive-1',
      snapshotId: '2026-11-21T01-00-00Z_gdrive1',
      repositoryId: 'repo-gdrive-1',
      status: 'paused' as const,
      pauseReason: 'daily_budget_exhausted' as const,
      stagingDir: 'C:\\staging\\job-gdrive-1',
      verificationScope: null,
      totalObjectCount: 5,
      completedObjectCount: 2,
      writtenChunkCount: 2,
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

    let authState: {
      status: 'disconnected' | 'connected' | 'expired'
      accountEmail: string | null
      accountDisplayName: string | null
      lastError: string | null
    } = {
      status: 'disconnected',
      accountEmail: null,
      accountDisplayName: null,
      lastError: null
    }
    const getGoogleDriveAuthStatus = vi.fn().mockImplementation(async () => authState)
    const connectGoogleDrive = vi.fn().mockImplementation(async () => {
      authState = {
        status: 'connected',
        accountEmail: 'user@example.com',
        accountDisplayName: 'Test User',
        lastError: null
      }
      return authState
    })
    const disconnectGoogleDrive = vi.fn().mockImplementation(async () => {
      authState = {
        status: 'disconnected',
        accountEmail: null,
        accountDisplayName: null,
        lastError: null
      }
      return authState
    })
    const listGoogleDriveFolders = vi
      .fn()
      .mockResolvedValue([{ id: 'folder-1', name: 'Existing Backups' }])
    const createGoogleDriveFolder = vi.fn().mockResolvedValue({
      id: 'folder-2',
      name: 'Vault Cloud'
    })
    let configuredDestinations: Array<typeof driveDest> = []
    const configureBackupDestination = vi.fn().mockImplementation(async () => {
      configuredDestinations = [driveDest]
      return driveDest
    })
    const listBackupDestinations = vi.fn().mockImplementation(async () => configuredDestinations)
    const listBackupJobs = vi
      .fn()
      .mockResolvedValue({ items: [budgetPausedJob], total: 1, limit: 25, offset: 0 })
    const resumeBackup = vi
      .fn()
      .mockResolvedValue({ ...budgetPausedJob, status: 'completed', pauseReason: null })
    const listRecoveryPoints = vi.fn().mockResolvedValue({
      destinationId: 'dest-gdrive-1',
      backupRepoDir: 'gdrive://folder/folder-2',
      repositoryId: 'repo-gdrive-1',
      recoveryPoints: [
        {
          snapshotId: '2026-11-21T01-00-00Z_gdrive1',
          isComplete: true,
          reasons: [],
          repositoryId: 'repo-gdrive-1',
          encryptionMode: 'aes-256-gcm-v1' as const,
          createdAtMs: 1000,
          completedAtMs: 2000,
          verificationScope: 'full_readback' as const,
          totalObjectCount: 5,
          totalLogicalBytes: 4096,
          totalStoredBytes: 4096,
          vaultName: 'Cloud Vault',
          vaultCopyCount: 3
        }
      ]
    })
    const verifyRecoveryPoint = vi.fn().mockResolvedValue({
      repositoryId: 'repo-gdrive-1',
      snapshotId: '2026-11-21T01-00-00Z_gdrive1',
      verifiedFileCount: 5,
      verifiedObjectCount: 5,
      hasVault: true,
      verificationScope: 'full_readback' as const
    })
    const restoreRecoveryPoint = vi.fn().mockResolvedValue({
      repositoryId: 'repo-gdrive-1',
      snapshotId: '2026-11-21T01-00-00Z_gdrive1',
      restoredProfilePath: 'D:\\Restores\\Cloud\\profile',
      restoredVaultPath: 'D:\\Restores\\Cloud\\vault',
      verifiedFileCount: 5,
      verificationScope: 'full_readback' as const
    })

    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        listBackupDestinations,
        listBackupJobs,
        getActiveBackupJob: vi.fn().mockResolvedValue(null),
        getGoogleDriveAuthStatus,
        connectGoogleDrive,
        disconnectGoogleDrive,
        listGoogleDriveFolders,
        createGoogleDriveFolder,
        configureBackupDestination,
        resumeBackup,
        listRecoveryPoints,
        verifyRecoveryPoint,
        restoreRecoveryPoint,
        selectBackupDirectory: vi.fn().mockResolvedValue({ canceled: true, directoryPath: null }),
        onBackupProgress: vi.fn().mockReturnValue(() => {})
      }
    })

    render(<BackupRestorePanel />)

    const gdriveRadio = await screen.findByLabelText(/Google Drive \(Encrypted cloud\)/i)
    fireEvent.click(gdriveRadio)

    const connectBtn = await screen.findByRole('button', { name: /Connect Google Drive/i })
    fireEvent.click(connectBtn)

    await screen.findByText(/Connected as user@example\.com/i)
    expect(listGoogleDriveFolders).toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText(/Or Create New Folder/i), {
      target: { value: 'Vault Cloud' }
    })
    fireEvent.click(screen.getByRole('button', { name: /Create folder/i }))
    await waitFor(() => {
      expect(createGoogleDriveFolder).toHaveBeenCalledWith({ name: 'Vault Cloud' })
    })

    fireEvent.change(screen.getByLabelText(/Upload Speed Limit/i), {
      target: { value: '2' }
    })
    fireEvent.change(screen.getByLabelText(/Rolling 24h Upload Budget/i), {
      target: { value: '512' }
    })

    fireEvent.click(screen.getByRole('button', { name: /Save destination/i }))

    await waitFor(() => {
      expect(configureBackupDestination).toHaveBeenCalledWith({
        name: 'Google Drive Backup',
        kind: 'google_drive',
        targetPath: 'folder-2',
        encryptionMode: 'aes-256-gcm-v1',
        maxBytesPerSecond: 2 * 1024 * 1024,
        dailyBudgetBytes: 512 * 1024 * 1024
      })
    })

    // Budget-exhausted pause banner is shown
    await screen.findByText(/Backup paused — daily upload budget reached/i)
    await screen.findByText(/rolling 24-hour upload budget was reached/i)

    // Resume passes optional secret and clears input immediately
    const secretInput = screen.getByTestId('backup-recovery-secret-input') as HTMLInputElement
    fireEvent.change(secretInput, { target: { value: 'my-drive-secret' } })
    const summaryResumeBtn = screen.getAllByRole('button', { name: /^Resume$/i })[0]!
    fireEvent.click(summaryResumeBtn)

    await waitFor(() => {
      expect(resumeBackup).toHaveBeenCalledWith('job-gdrive-1', 'my-drive-secret')
    })
    expect(secretInput.value).toBe('')

    // Remote snapshot appears in Restore section and restores with destinationId + recoverySecret
    await screen.findByText(/3 vault files \(Cloud Vault\)/i)
    const restoreSecretInput = screen.getByTestId(
      'restore-recovery-secret-input'
    ) as HTMLInputElement
    fireEvent.change(restoreSecretInput, { target: { value: 'my-drive-secret' } })
    fireEvent.change(screen.getByLabelText(/Restore Location \(empty folder\)/i), {
      target: { value: 'D:\\Restores\\Cloud' }
    })
    fireEvent.click(screen.getByRole('button', { name: /Restore files/i }))

    await waitFor(() => {
      expect(restoreRecoveryPoint).toHaveBeenCalledWith({
        destinationKind: 'google_drive',
        driveFolderId: 'folder-2',
        snapshotId: '2026-11-21T01-00-00Z_gdrive1',
        targetProfileDir: 'D:\\Restores\\Cloud\\profile',
        targetVaultDir: 'D:\\Restores\\Cloud\\vault',
        recoverySecret: 'my-drive-secret'
      })
    })
    expect(restoreSecretInput.value).toBe('')
    await screen.findByText(/Restore complete — 5 files restored/i)
  })

  it('preserves locked-snapshot uncertainty for encrypted Google Drive summaries, avoids disconnected message, and passes targetVaultDir to restore', async () => {
    const driveDest = {
      id: 'dest-gdrive-locked',
      name: 'Google Drive Backup',
      kind: 'google_drive' as const,
      targetPath: 'folder-live-smoke',
      maxBytesPerSecond: null,
      dailyBudgetBytes: 1024 * 1024 * 1024,
      encryptionMode: 'aes-256-gcm-v1' as const,
      repositoryId: 'repo-gdrive-locked',
      isEnabled: true,
      lastVerifiedSnapshotId: null,
      lastVerifiedAtMs: null,
      createdAtMs: 1000,
      updatedAtMs: 2000
    }

    const completedJob = {
      id: 'job-gdrive-locked',
      destinationId: 'dest-gdrive-locked',
      snapshotId: '2026-11-22T05-00-00Z_locked01',
      repositoryId: 'repo-gdrive-locked',
      status: 'completed' as const,
      pauseReason: null,
      stagingDir: null,
      verificationScope: 'full_readback' as const,
      totalObjectCount: 6,
      completedObjectCount: 6,
      writtenChunkCount: 6,
      reusedChunkCount: 0,
      totalLogicalBytes: 8192,
      totalStoredBytes: 8400,
      transferredBytes: 8400,
      manifestSha256: 'a'.repeat(64),
      abandonedFromJobId: null,
      errorCode: null,
      errorMessage: null,
      createdAtMs: 1000,
      startedAtMs: 1000,
      updatedAtMs: 2000,
      completedAtMs: 2000
    }

    // Exact locked summary shape returned by listRemoteRecoveryPoints() for encrypted Drive snapshots
    const listRecoveryPoints = vi.fn().mockResolvedValue({
      backupRepoDir: 'google-drive://folder-live-smoke',
      repositoryId: 'repo-gdrive-locked',
      recoveryPoints: [
        {
          snapshotId: '2026-11-22T05-00-00Z_locked01',
          isComplete: true,
          integrityStatus: 'sealed_unverified' as const,
          reasons: [],
          repositoryId: 'repo-gdrive-locked',
          createdAtMs: null,
          completedAtMs: 2000,
          verificationScope: 'full_readback' as const,
          totalObjectCount: 6,
          totalLogicalBytes: 8192,
          totalStoredBytes: 8400,
          vaultName: null,
          vaultCopyCount: null
        }
      ]
    })

    const restoreRecoveryPoint = vi.fn().mockResolvedValue({
      restoreJobId: 'restore-locked-1',
      repositoryId: 'repo-gdrive-locked',
      snapshotId: '2026-11-22T05-00-00Z_locked01',
      restoredProfilePath: 'D:\\Restores\\LockedCloud\\profile',
      restoredVaultPath: 'D:\\Restores\\LockedCloud\\vault',
      catalogSha256: 'e'.repeat(64),
      verifiedFileCount: 6,
      restoredAtMs: 3000
    })

    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        listBackupDestinations: vi.fn().mockResolvedValue([driveDest]),
        listBackupJobs: vi
          .fn()
          .mockResolvedValue({ items: [completedJob], total: 1, limit: 25, offset: 0 }),
        getActiveBackupJob: vi.fn().mockResolvedValue(null),
        getGoogleDriveAuthStatus: vi.fn().mockResolvedValue({
          status: 'connected',
          accountEmail: 'smoke@example.com',
          accountDisplayName: 'Smoke User',
          lastError: null
        }),
        onBackupProgress: vi.fn().mockReturnValue(() => {}),
        selectBackupDirectory: vi.fn().mockResolvedValue({ canceled: true, directoryPath: null }),
        listRecoveryPoints,
        restoreRecoveryPoint
      }
    })

    render(<BackupRestorePanel />)

    // Reachable locked encrypted snapshot must NOT show the misleading disconnected message
    await screen.findByText(/Backup completed successfully/i)
    await waitFor(() => {
      expect(listRecoveryPoints).toHaveBeenCalledWith({
        destinationKind: 'google_drive',
        driveFolderId: 'folder-live-smoke'
      })
    })
    expect(screen.getAllByText(/File count unavailable/i).length).toBeGreaterThan(0)
    expect(
      screen.queryByText(/Destination is disconnected or cannot be read\./i)
    ).not.toBeInTheDocument()
    expect(screen.getByText(/Encrypted backup is locked/i)).toBeInTheDocument()

    // Choosing a single empty restore location must NOT claim the locked backup is catalog-only
    fireEvent.change(screen.getByLabelText(/Restore Location \(empty folder\)/i), {
      target: { value: 'D:\\Restores\\LockedCloud' }
    })
    expect(screen.getByText('D:\\Restores\\LockedCloud\\profile')).toBeInTheDocument()
    expect(screen.getByText('D:\\Restores\\LockedCloud\\vault')).toBeInTheDocument()
    expect(
      screen.queryByText(/No vault subfolder needed \(this backup contains catalog data only\)/i)
    ).not.toBeInTheDocument()

    // Entering the recovery secret and clicking Restore files must send targetVaultDir so the
    // authenticated manifest decides whether a vault subfolder is needed
    const restoreSecretInput = screen.getByTestId(
      'restore-recovery-secret-input'
    ) as HTMLInputElement
    fireEvent.change(restoreSecretInput, { target: { value: 'live-recovery-secret' } })
    fireEvent.click(screen.getByRole('button', { name: /Restore files/i }))

    await waitFor(() => {
      expect(restoreRecoveryPoint).toHaveBeenCalledWith({
        destinationKind: 'google_drive',
        driveFolderId: 'folder-live-smoke',
        snapshotId: '2026-11-22T05-00-00Z_locked01',
        targetProfileDir: 'D:\\Restores\\LockedCloud\\profile',
        targetVaultDir: 'D:\\Restores\\LockedCloud\\vault',
        recoverySecret: 'live-recovery-secret'
      })
    })
    expect(restoreSecretInput.value).toBe('')
    await screen.findByText(/Restore complete — 6 files restored/i)
  })

  it('shows destination folder, vault file count, approximate size, and catalog-only warning before starting backup, and remembers selected local drive destination across restarts', async () => {
    localStorage.clear()
    const destD = {
      ...baseDest,
      id: 'dest-d',
      name: 'Local Backup (D:)',
      targetPath: 'D:\\Backups\\PV',
      maxBytesPerSecond: null,
      lastVerifiedSnapshotId: null,
      lastVerifiedAtMs: null
    }
    const destC = {
      ...baseDest,
      id: 'dest-c',
      name: 'Local Backup (C:)',
      targetPath: 'C:\\Backups\\PV',
      maxBytesPerSecond: null,
      lastVerifiedSnapshotId: null,
      lastVerifiedAtMs: null
    }

    const catalogOnlySummary: BackupSummaryDto = {
      hasActiveVault: false,
      activeVaultId: null,
      activeVaultName: null,
      activeVaultPath: null,
      vaultFileCount: 0,
      vaultBytes: 0,
      catalogBytes: 16 * 1024,
      annotationsBytes: 512,
      estimatedTotalBytes: 16 * 1024 + 512,
      catalogedFileCount: 2,
      isCatalogOnly: true
    }
    const populatedSummary: BackupSummaryDto = {
      hasActiveVault: true,
      activeVaultId: 'vault-1',
      activeVaultName: 'Trial Vault',
      activeVaultPath: 'D:\\TrialVault',
      vaultFileCount: 3,
      vaultBytes: 3 * 1024 * 1024,
      catalogBytes: 32 * 1024,
      annotationsBytes: 1024,
      estimatedTotalBytes: 3 * 1024 * 1024 + 33 * 1024,
      catalogedFileCount: 4,
      isCatalogOnly: false
    }
    let currentSummary: BackupSummaryDto = catalogOnlySummary
    const getBackupSummary = vi.fn().mockImplementation(async () => currentSummary)

    const savedDestinations = [destD, destC]
    const selectBackupDirectory = vi
      .fn()
      .mockResolvedValueOnce({ canceled: false, directoryPath: 'D:\\Backups\\PV' })
      .mockResolvedValueOnce({ canceled: false, directoryPath: 'C:\\Backups\\PV' })

    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        listBackupDestinations: vi.fn().mockImplementation(async () => savedDestinations),
        listBackupJobs: vi.fn().mockResolvedValue({ items: [], total: 0, limit: 25, offset: 0 }),
        getActiveBackupJob: vi.fn().mockResolvedValue(null),
        getBackupSummary,
        listRecoveryPoints: vi.fn().mockResolvedValue({
          backupRepoDir: 'D:\\Backups\\PV',
          repositoryId: null,
          recoveryPoints: []
        }),
        selectBackupDirectory,
        configureBackupDestination: vi.fn().mockResolvedValue(destD),
        onBackupProgress: vi.fn().mockReturnValue(() => {})
      }
    })

    // 1. Catalog-only pre-backup warning and pre-start summary render BEFORE starting backup
    const firstRender = render(<BackupRestorePanel />)
    const prestart = await screen.findByTestId('backup-prestart-summary')
    expect(prestart).toHaveTextContent('D:\\Backups\\PV')
    expect(prestart).toHaveTextContent(/0 vault files \(catalog only\)/i)
    expect(prestart).toHaveTextContent(/16\.5 KiB/i)
    const catalogOnlyWarn = await screen.findByTestId('backup-catalog-only-warning')
    expect(catalogOnlyWarn).toHaveTextContent(/catalog-only backup/i)

    // Browse works across D: and C:
    fireEvent.click(screen.getByRole('button', { name: /Change backup location/i }))
    const browseBtn = screen.getAllByRole('button', { name: /Browse/i })[0]!
    fireEvent.click(browseBtn)
    await waitFor(() => {
      expect(screen.getByLabelText(/Destination Folder/i)).toHaveValue('D:\\Backups\\PV')
    })
    fireEvent.click(browseBtn)
    await waitFor(() => {
      expect(screen.getByLabelText(/Destination Folder/i)).toHaveValue('C:\\Backups\\PV')
    })

    // Switching saved destination to C: persists across unmount/remount
    fireEvent.click(screen.getByLabelText(/Local Backup \(C:\)/i))
    currentSummary = populatedSummary
    firstRender.unmount()

    render(<BackupRestorePanel />)
    const prestartAfterRemount = await screen.findByTestId('backup-prestart-summary')
    await waitFor(() => {
      expect(prestartAfterRemount).toHaveTextContent('C:\\Backups\\PV')
    })
    expect(prestartAfterRemount).toHaveTextContent(/3 vault files/i)
    expect(prestartAfterRemount).toHaveTextContent(/3\.03 MiB/i)
    expect(prestartAfterRemount).toHaveTextContent(/1 scanned-only file/i)
    expect(screen.queryByTestId('backup-catalog-only-warning')).not.toBeInTheDocument()
  })
})
