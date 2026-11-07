import { app, dialog, ipcMain, type BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/contracts/channels'
import {
  AppInfoSchema,
  GetActiveJobResponseSchema,
  JobActionResponseSchema,
  JobIdRequestSchema,
  NavigationTabSchema,
  SelectRootsResponseSchema,
  StartScanRequestSchema,
  VaultStatusSchema,
  validatePayload,
  type AppInfo,
  type GetActiveJobResponse,
  type JobActionResponse,
  type SelectRootsResponse,
  type VaultStatus
} from '../../shared/validation/ipc-schemas'
import type { CatalogDatabase } from '../services/catalog'
import type { ScanJobCoordinator } from '../services/jobs'
import type { IpcSenderEvent, SenderValidator } from './sender'

export interface IpcHandlerOptions {
  readonly validateSender: SenderValidator
  readonly catalog?: CatalogDatabase
  readonly coordinator?: ScanJobCoordinator
  readonly getMainWindow?: () => BrowserWindow | null
  readonly selectDirectories?: () => Promise<{ cancelled: boolean; filePaths: string[] }>
}

export function registerIpcHandlers({
  validateSender,
  catalog,
  coordinator,
  getMainWindow,
  selectDirectories
}: IpcHandlerOptions): void {
  const handle = <Args extends unknown[], Result>(
    channel: string,
    fn: (...args: Args) => Result | Promise<Result>
  ): void => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!validateSender(event as IpcSenderEvent)) {
        throw new Error(`Unauthorized IPC sender for ${channel}`)
      }
      return fn(...(args as Args))
    })
  }

  handle(IPC_CHANNELS.APP_GET_INFO, (): AppInfo => {
    const result = validatePayload(AppInfoSchema, {
      name: 'Personal Vault',
      version: app.getVersion(),
      platform: process.platform,
      isPackaged: app.isPackaged
    })
    if (!result.success) throw new Error(`Invalid AppInfo in main process: ${result.error}`)
    return result.data
  })

  handle(IPC_CHANNELS.VAULT_GET_STATUS, (): VaultStatus => {
    const sourceCount = catalog && !catalog.isClosed() ? catalog.countSources() : 0
    const itemCount = catalog && !catalog.isClosed() ? catalog.countFileLocations() : 0
    const result = validatePayload(VaultStatusSchema, {
      sourceCount,
      itemCount,
      isReady: true
    })
    if (!result.success) throw new Error(`Invalid VaultStatus in main process: ${result.error}`)
    return result.data
  })

  handle(IPC_CHANNELS.NAVIGATE_SET_TAB, (tab: unknown): boolean => {
    return validatePayload(NavigationTabSchema, tab).success
  })

  handle(IPC_CHANNELS.SCAN_SELECT_ROOTS, async (): Promise<SelectRootsResponse> => {
    let cancelled: boolean
    let rootPaths: string[]

    if (selectDirectories) {
      const res = await selectDirectories()
      cancelled = res.cancelled
      rootPaths = res.filePaths
    } else {
      const win = getMainWindow?.() ?? null
      const dialogOpts = {
        title: 'Select Source Folders',
        properties: ['openDirectory', 'multiSelections'] as ('openDirectory' | 'multiSelections')[]
      }
      const res = win
        ? await dialog.showOpenDialog(win, dialogOpts)
        : await dialog.showOpenDialog(dialogOpts)
      cancelled = res.canceled
      rootPaths = res.filePaths
    }

    const result = validatePayload(SelectRootsResponseSchema, {
      cancelled,
      rootPaths
    })
    if (!result.success) throw new Error(`Invalid SelectRootsResponse: ${result.error}`)
    return result.data
  })

  handle(IPC_CHANNELS.SCAN_START_JOB, async (raw: unknown): Promise<JobActionResponse> => {
    const parsed = validatePayload(StartScanRequestSchema, raw)
    if (!parsed.success) {
      return { success: false, error: parsed.error }
    }
    if (!coordinator) {
      return { success: false, error: 'ScanJobCoordinator not available' }
    }
    try {
      const job = await coordinator.startScan(parsed.data)
      const res = validatePayload(JobActionResponseSchema, { success: true, job })
      if (!res.success) throw new Error(res.error)
      return res.data
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  handle(IPC_CHANNELS.SCAN_PAUSE_JOB, async (raw: unknown): Promise<JobActionResponse> => {
    const parsed = validatePayload(JobIdRequestSchema, raw)
    if (!parsed.success) {
      return { success: false, error: parsed.error }
    }
    if (!coordinator) {
      return { success: false, error: 'ScanJobCoordinator not available' }
    }
    try {
      const job = await coordinator.pauseScan(parsed.data.jobId)
      const res = validatePayload(JobActionResponseSchema, { success: true, job })
      if (!res.success) throw new Error(res.error)
      return res.data
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  handle(IPC_CHANNELS.SCAN_RESUME_JOB, async (raw: unknown): Promise<JobActionResponse> => {
    const parsed = validatePayload(JobIdRequestSchema, raw)
    if (!parsed.success) {
      return { success: false, error: parsed.error }
    }
    if (!coordinator) {
      return { success: false, error: 'ScanJobCoordinator not available' }
    }
    try {
      const job = await coordinator.resumeScan(parsed.data.jobId)
      const res = validatePayload(JobActionResponseSchema, { success: true, job })
      if (!res.success) throw new Error(res.error)
      return res.data
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  handle(IPC_CHANNELS.SCAN_CANCEL_JOB, async (raw: unknown): Promise<JobActionResponse> => {
    const parsed = validatePayload(JobIdRequestSchema, raw)
    if (!parsed.success) {
      return { success: false, error: parsed.error }
    }
    if (!coordinator) {
      return { success: false, error: 'ScanJobCoordinator not available' }
    }
    try {
      const job = await coordinator.cancelScan(parsed.data.jobId)
      const res = validatePayload(JobActionResponseSchema, { success: true, job })
      if (!res.success) throw new Error(res.error)
      return res.data
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  handle(IPC_CHANNELS.SCAN_GET_ACTIVE_JOB, (): GetActiveJobResponse => {
    const job = coordinator ? coordinator.getActiveJob() : null
    const res = validatePayload(GetActiveJobResponseSchema, { job })
    if (!res.success) throw new Error(res.error)
    return res.data
  })

  handle(IPC_CHANNELS.SCAN_PROGRESS_EVENT, (): never => {
    throw new Error('Event-only channel cannot be invoked')
  })

  if (coordinator && getMainWindow) {
    coordinator.onProgress((progress) => {
      const win = getMainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.SCAN_PROGRESS_EVENT, progress)
      }
    })
  }
}
