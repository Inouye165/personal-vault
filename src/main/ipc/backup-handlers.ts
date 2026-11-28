/**
 * Personal Vault — Stage 8B Sub-slice 1C: Backup & Restore IPC Handlers
 *
 * Registers sender-validated, Zod-validated IPC handlers for configuring local
 * USB/NAS backup destinations, starting/pausing/resuming/cancelling backups,
 * listing and verifying recovery points, and restoring into an isolated profile.
 */

import { dialog, type BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/contracts/channels'
import {
  BackupConfigureDestinationRequestSchema,
  BackupDestinationRecordSchema,
  BackupGoogleDriveAuthStatusSchema,
  BackupGoogleDriveCreateFolderRequestSchema,
  BackupGoogleDriveFolderSchema,
  BackupGoogleDriveListFoldersRequestSchema,
  BackupGoogleDriveListFoldersResponseSchema,
  BackupJobActionRequestSchema,
  BackupJobActionResponseSchema,
  BackupJobRecordSchema,
  BackupListDestinationsRequestSchema,
  BackupListDestinationsResponseSchema,
  BackupListJobsRequestSchema,
  BackupListJobsResponseSchema,
  BackupListRecoveryPointsRequestSchema,
  BackupListRecoveryPointsResponseSchema,
  BackupProgressEventSchema,
  BackupRecoverCatalogRequestSchema,
  BackupRecoverCatalogResponseSchema,
  BackupRestoreRequestSchema,
  BackupRestoreResponseSchema,
  BackupSelectDirectoryRequestSchema,
  BackupSelectDirectoryResponseSchema,
  BackupStartRequestSchema,
  BackupSummarySchema,
  BackupVerifyRecoveryPointRequestSchema,
  BackupVerifyRecoveryPointResponseSchema
} from '../../shared/validation/backup-ipc-schemas'
import type { BackupCoordinator } from '../services/backup/coordinator'
import type { GoogleDriveAuthService } from '../services/backup/google-drive-auth'
import { GoogleDriveTransport } from '../services/backup/google-drive-transport'
import {
  listRecoveryPoints,
  listRemoteRecoveryPoints,
  restoreRecoveryPointToIsolatedProfile,
  restoreRemoteRecoveryPointToIsolatedProfile,
  verifyRecoveryPoint,
  verifyRemoteRecoveryPoint
} from '../services/backup/restore'
import { recoverCatalogFromVaultManifests } from '../services/backup/catalog-recovery'
import type { CatalogDatabase } from '../services/catalog'

type RegisterHandleFn = (
  channel: string,
  handler: (...args: unknown[]) => Promise<unknown> | unknown
) => void

export interface BackupIpcHandlerDeps {
  readonly handle: RegisterHandleFn
  readonly backupCoordinator?: BackupCoordinator
  readonly googleDriveAuth?: GoogleDriveAuthService
  readonly createGoogleDriveTransport?: (folderId: string) => GoogleDriveTransport
  readonly catalog?: CatalogDatabase
  readonly userDataDir?: string
  readonly getMainWindow?: () => BrowserWindow | null
  readonly selectBackupDirectory?: (title?: string) => Promise<{
    canceled: boolean
    directoryPath: string | null
  }>
}

function getAllRegisteredVaultRoots(catalog?: CatalogDatabase): string[] {
  if (!catalog || catalog.isClosed()) return []
  const rows = catalog.getRawDb().prepare('SELECT vault_path FROM vaults').all() as Array<{
    vault_path: string
  }>
  return rows.map((r) => r.vault_path)
}

export function registerBackupIpcHandlers(deps: BackupIpcHandlerDeps): void {
  const {
    handle,
    backupCoordinator,
    googleDriveAuth,
    createGoogleDriveTransport,
    catalog,
    userDataDir,
    getMainWindow,
    selectBackupDirectory
  } = deps

  const resolveDriveTransport = (folderId: string): GoogleDriveTransport => {
    if (createGoogleDriveTransport) {
      return createGoogleDriveTransport(folderId)
    }
    if (!googleDriveAuth) {
      throw new Error('Google Drive auth service is not initialized')
    }
    return new GoogleDriveTransport({
      rootFolderId: folderId,
      getAccessToken: () => googleDriveAuth.getAccessToken()
    })
  }

  handle(IPC_CHANNELS.BACKUP_SELECT_DIRECTORY, async (rawPayload) => {
    const req = rawPayload === undefined ? {} : BackupSelectDirectoryRequestSchema.parse(rawPayload)
    const result = selectBackupDirectory
      ? await selectBackupDirectory(req.title)
      : await (async () => {
          const win = getMainWindow?.() ?? null
          const options: Electron.OpenDialogOptions = {
            title: req.title ?? 'Select Folder',
            properties: ['openDirectory', 'createDirectory']
          }
          const dialogRes = win
            ? await dialog.showOpenDialog(win, options)
            : await dialog.showOpenDialog(options)
          return {
            canceled: dialogRes.canceled || dialogRes.filePaths.length === 0,
            directoryPath: dialogRes.canceled ? null : (dialogRes.filePaths[0] ?? null)
          }
        })()

    return BackupSelectDirectoryResponseSchema.parse(result)
  })

  handle(IPC_CHANNELS.BACKUP_CONFIGURE_DESTINATION, (rawPayload) => {
    if (!backupCoordinator) {
      throw new Error('BackupCoordinator is not initialized')
    }
    const req = BackupConfigureDestinationRequestSchema.parse(rawPayload)
    const dest = backupCoordinator.configureDestination({
      name: req.name,
      kind: req.kind,
      targetPath: req.targetPath,
      maxBytesPerSecond: req.maxBytesPerSecond ?? null,
      dailyBudgetBytes: req.dailyBudgetBytes ?? null,
      encryptionMode: req.encryptionMode
    })
    return BackupDestinationRecordSchema.parse(dest)
  })

  handle(IPC_CHANNELS.BACKUP_LIST_DESTINATIONS, (rawPayload) => {
    if (!backupCoordinator) {
      return BackupListDestinationsResponseSchema.parse([])
    }
    const req =
      rawPayload === undefined ? {} : BackupListDestinationsRequestSchema.parse(rawPayload)
    const list = backupCoordinator.listDestinations({ enabledOnly: req.enabledOnly })
    return BackupListDestinationsResponseSchema.parse(list)
  })

  handle(IPC_CHANNELS.BACKUP_GET_SUMMARY, () => {
    if (!backupCoordinator) {
      return BackupSummarySchema.parse({
        hasActiveVault: false,
        activeVaultName: null,
        activeVaultPath: null,
        vaultFileCount: 0,
        vaultLogicalBytes: 0,
        catalogedFileCount: 0,
        excludedScannedOnlyCount: 0,
        catalogApproxBytes: 0,
        annotationsApproxBytes: 0,
        estimatedTotalBytes: 0,
        isCatalogOnly: true
      })
    }
    return BackupSummarySchema.parse(backupCoordinator.getBackupSummary())
  })

  handle(IPC_CHANNELS.BACKUP_START, async (rawPayload) => {
    if (!backupCoordinator) {
      throw new Error('BackupCoordinator is not initialized')
    }
    const req = BackupStartRequestSchema.parse(rawPayload)
    const job = await backupCoordinator.startBackup(req.destinationId, {
      recoverySecret: req.recoverySecret
    })
    return BackupJobRecordSchema.parse(job)
  })

  handle(IPC_CHANNELS.BACKUP_PAUSE, (rawPayload) => {
    if (!backupCoordinator) {
      throw new Error('BackupCoordinator is not initialized')
    }
    const req = BackupJobActionRequestSchema.parse(rawPayload)
    const accepted = backupCoordinator.pauseBackup(req.jobId)
    return BackupJobActionResponseSchema.parse({ accepted, jobId: req.jobId })
  })

  handle(IPC_CHANNELS.BACKUP_RESUME, async (rawPayload) => {
    if (!backupCoordinator) {
      throw new Error('BackupCoordinator is not initialized')
    }
    const req = BackupJobActionRequestSchema.parse(rawPayload)
    const job = await backupCoordinator.resumeBackup(req.jobId, {
      recoverySecret: req.recoverySecret
    })
    return BackupJobRecordSchema.parse(job)
  })

  handle(IPC_CHANNELS.BACKUP_CANCEL, (rawPayload) => {
    if (!backupCoordinator) {
      throw new Error('BackupCoordinator is not initialized')
    }
    const req = BackupJobActionRequestSchema.parse(rawPayload)
    const accepted = backupCoordinator.cancelBackup(req.jobId)
    return BackupJobActionResponseSchema.parse({ accepted, jobId: req.jobId })
  })

  handle(IPC_CHANNELS.BACKUP_GET_ACTIVE, () => {
    if (!backupCoordinator) {
      return null
    }
    const job = backupCoordinator.getActiveBackupJob()
    return job ? BackupJobRecordSchema.parse(job) : null
  })

  handle(IPC_CHANNELS.BACKUP_LIST_JOBS, (rawPayload) => {
    if (!backupCoordinator) {
      return BackupListJobsResponseSchema.parse({ items: [], total: 0, limit: 25, offset: 0 })
    }
    const req = rawPayload === undefined ? {} : BackupListJobsRequestSchema.parse(rawPayload)
    const page = backupCoordinator.listJobs(req)
    return BackupListJobsResponseSchema.parse(page)
  })

  handle(IPC_CHANNELS.BACKUP_GET_JOB, (rawPayload) => {
    if (!backupCoordinator) {
      return null
    }
    const req = BackupJobActionRequestSchema.parse(rawPayload)
    const job = backupCoordinator.getJob(req.jobId)
    return job ? BackupJobRecordSchema.parse(job) : null
  })

  handle(IPC_CHANNELS.BACKUP_LIST_RECOVERY_POINTS, async (rawPayload) => {
    const req = BackupListRecoveryPointsRequestSchema.parse(rawPayload)
    if (req.destinationKind === 'google_drive') {
      if (!req.driveFolderId) {
        throw new Error('driveFolderId is required when listing Google Drive recovery points')
      }
      const transport = resolveDriveTransport(req.driveFolderId)
      const result = await listRemoteRecoveryPoints(
        transport,
        `google-drive://${req.driveFolderId}`
      )
      return BackupListRecoveryPointsResponseSchema.parse(result)
    }
    if (!req.backupRepoDir) {
      throw new Error('backupRepoDir is required for local recovery points')
    }
    const result = listRecoveryPoints(req.backupRepoDir)
    return BackupListRecoveryPointsResponseSchema.parse(result)
  })

  handle(IPC_CHANNELS.BACKUP_VERIFY_RECOVERY_POINT, async (rawPayload) => {
    const req = BackupVerifyRecoveryPointRequestSchema.parse(rawPayload)
    if (req.destinationKind === 'google_drive') {
      if (!req.driveFolderId) {
        throw new Error('driveFolderId is required when verifying Google Drive recovery point')
      }
      const transport = resolveDriveTransport(req.driveFolderId)
      const result = await verifyRemoteRecoveryPoint({
        transport,
        snapshotId: req.snapshotId,
        recoverySecret: req.recoverySecret
      })
      return BackupVerifyRecoveryPointResponseSchema.parse(result)
    }
    if (!req.backupRepoDir) {
      throw new Error('backupRepoDir is required for local recovery point verification')
    }
    const result = await verifyRecoveryPoint({
      backupRepoDir: req.backupRepoDir,
      snapshotId: req.snapshotId,
      recoverySecret: req.recoverySecret
    })
    return BackupVerifyRecoveryPointResponseSchema.parse(result)
  })

  handle(IPC_CHANNELS.BACKUP_RESTORE_RECOVERY_POINT, async (rawPayload) => {
    const req = BackupRestoreRequestSchema.parse(rawPayload)
    if (req.destinationKind === 'google_drive') {
      if (!req.driveFolderId) {
        throw new Error('driveFolderId is required when restoring Google Drive recovery point')
      }
      const transport = resolveDriveTransport(req.driveFolderId)
      const result = await restoreRemoteRecoveryPointToIsolatedProfile({
        transport,
        snapshotId: req.snapshotId,
        targetProfileDir: req.targetProfileDir,
        targetVaultDir: req.targetVaultDir ?? null,
        activeUserDataDir: userDataDir,
        activeSourceRoots: catalog && !catalog.isClosed() ? catalog.getAllSourceRoots() : [],
        activeVaultRoots: getAllRegisteredVaultRoots(catalog),
        recoverySecret: req.recoverySecret
      })
      return BackupRestoreResponseSchema.parse(result)
    }
    if (!req.backupRepoDir) {
      throw new Error('backupRepoDir is required for local recovery point restore')
    }
    const result = await restoreRecoveryPointToIsolatedProfile({
      backupRepoDir: req.backupRepoDir,
      snapshotId: req.snapshotId,
      targetProfileDir: req.targetProfileDir,
      targetVaultDir: req.targetVaultDir ?? null,
      activeUserDataDir: userDataDir,
      activeSourceRoots: catalog && !catalog.isClosed() ? catalog.getAllSourceRoots() : [],
      activeVaultRoots: getAllRegisteredVaultRoots(catalog),
      recoverySecret: req.recoverySecret
    })
    return BackupRestoreResponseSchema.parse(result)
  })

  handle(IPC_CHANNELS.BACKUP_GDRIVE_GET_STATUS, () => {
    if (!googleDriveAuth) {
      return BackupGoogleDriveAuthStatusSchema.parse({
        status: 'disconnected',
        accountEmail: null,
        accountDisplayName: null,
        lastError: null
      })
    }
    return BackupGoogleDriveAuthStatusSchema.parse(googleDriveAuth.getStatus())
  })

  handle(IPC_CHANNELS.BACKUP_GDRIVE_CONNECT, async () => {
    if (!googleDriveAuth) {
      throw new Error('Google Drive auth service is not initialized')
    }
    const status = await googleDriveAuth.connect()
    return BackupGoogleDriveAuthStatusSchema.parse(status)
  })

  handle(IPC_CHANNELS.BACKUP_GDRIVE_DISCONNECT, () => {
    if (!googleDriveAuth) {
      return BackupGoogleDriveAuthStatusSchema.parse({
        status: 'disconnected',
        accountEmail: null,
        accountDisplayName: null,
        lastError: null
      })
    }
    return BackupGoogleDriveAuthStatusSchema.parse(googleDriveAuth.disconnect())
  })

  handle(IPC_CHANNELS.BACKUP_GDRIVE_LIST_FOLDERS, async (rawPayload) => {
    if (!googleDriveAuth) {
      throw new Error('Google Drive auth service is not initialized')
    }
    const req =
      rawPayload === undefined ? {} : BackupGoogleDriveListFoldersRequestSchema.parse(rawPayload)
    const folders = await googleDriveAuth.listFolders(req.parentId)
    return BackupGoogleDriveListFoldersResponseSchema.parse(folders)
  })

  handle(IPC_CHANNELS.BACKUP_GDRIVE_CREATE_FOLDER, async (rawPayload) => {
    if (!googleDriveAuth) {
      throw new Error('Google Drive auth service is not initialized')
    }
    const req = BackupGoogleDriveCreateFolderRequestSchema.parse(rawPayload)
    const created = await googleDriveAuth.createFolder(req.name, req.parentId)
    return BackupGoogleDriveFolderSchema.parse(created)
  })

  handle(IPC_CHANNELS.BACKUP_RECOVER_CATALOG_FROM_VAULT, async (rawPayload) => {
    const req = BackupRecoverCatalogRequestSchema.parse(rawPayload)
    const result = await recoverCatalogFromVaultManifests({
      sourceVaultDir: req.sourceVaultDir,
      targetProfileDir: req.targetProfileDir,
      activeUserDataDir: userDataDir,
      activeSourceRoots: catalog && !catalog.isClosed() ? catalog.getAllSourceRoots() : [],
      activeVaultPaths: getAllRegisteredVaultRoots(catalog)
    })
    return BackupRecoverCatalogResponseSchema.parse(result)
  })

  handle(IPC_CHANNELS.BACKUP_PROGRESS_EVENT, (): never => {
    throw new Error('Event-only channel cannot be invoked')
  })

  if (backupCoordinator && getMainWindow) {
    backupCoordinator.onProgress((job) => {
      const win = getMainWindow()
      if (win && !win.isDestroyed()) {
        const parsed = BackupProgressEventSchema.safeParse({ job })
        if (parsed.success) {
          win.webContents.send(IPC_CHANNELS.BACKUP_PROGRESS_EVENT, parsed.data)
        }
      }
    })
  }
}
