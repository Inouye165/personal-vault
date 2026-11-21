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
  BackupVerifyRecoveryPointRequestSchema,
  BackupVerifyRecoveryPointResponseSchema
} from '../../shared/validation/backup-ipc-schemas'
import type { BackupCoordinator } from '../services/backup/coordinator'
import {
  listRecoveryPoints,
  restoreRecoveryPointToIsolatedProfile,
  verifyRecoveryPoint
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
  const { handle, backupCoordinator, catalog, userDataDir, getMainWindow, selectBackupDirectory } =
    deps

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
      maxBytesPerSecond: req.maxBytesPerSecond ?? null
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

  handle(IPC_CHANNELS.BACKUP_START, async (rawPayload) => {
    if (!backupCoordinator) {
      throw new Error('BackupCoordinator is not initialized')
    }
    const req = BackupStartRequestSchema.parse(rawPayload)
    const job = await backupCoordinator.startBackup(req.destinationId)
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
    const job = await backupCoordinator.resumeBackup(req.jobId)
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

  handle(IPC_CHANNELS.BACKUP_LIST_RECOVERY_POINTS, (rawPayload) => {
    const req = BackupListRecoveryPointsRequestSchema.parse(rawPayload)
    const result = listRecoveryPoints(req.backupRepoDir)
    return BackupListRecoveryPointsResponseSchema.parse(result)
  })

  handle(IPC_CHANNELS.BACKUP_VERIFY_RECOVERY_POINT, async (rawPayload) => {
    const req = BackupVerifyRecoveryPointRequestSchema.parse(rawPayload)
    const result = await verifyRecoveryPoint({
      backupRepoDir: req.backupRepoDir,
      snapshotId: req.snapshotId
    })
    return BackupVerifyRecoveryPointResponseSchema.parse(result)
  })

  handle(IPC_CHANNELS.BACKUP_RESTORE_RECOVERY_POINT, async (rawPayload) => {
    const req = BackupRestoreRequestSchema.parse(rawPayload)
    const result = await restoreRecoveryPointToIsolatedProfile({
      backupRepoDir: req.backupRepoDir,
      snapshotId: req.snapshotId,
      targetProfileDir: req.targetProfileDir,
      targetVaultDir: req.targetVaultDir ?? null,
      activeUserDataDir: userDataDir,
      activeSourceRoots: catalog && !catalog.isClosed() ? catalog.getAllSourceRoots() : [],
      activeVaultRoots: getAllRegisteredVaultRoots(catalog)
    })
    return BackupRestoreResponseSchema.parse(result)
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
