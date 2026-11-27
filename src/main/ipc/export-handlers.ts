/**
 * Personal Vault — Stage 8A Slice 3: Export IPC Handlers
 *
 * Registers sender-validated, Zod-validated IPC handlers for selective export
 * execution, destination folder picking, cancellation, job history, and
 * on-disk bundle verification.
 */

import { dialog, type BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/contracts/channels'
import {
  ExportCancelRequestSchema,
  ExportCancelResponseSchema,
  ExportGetJobItemsRequestSchema,
  ExportGetJobRequestSchema,
  ExportJobItemsResponseSchema,
  ExportJobListResponseSchema,
  ExportJobRecordSchema,
  ExportListJobsRequestSchema,
  ExportProgressEventSchema,
  ExportSelectDestinationResponseSchema,
  ExportStartRequestSchema,
  ExportVerifyJobRequestSchema
} from '../../shared/validation/export-schemas'
import type { ExportCoordinator } from '../services/export/coordinator'

type RegisterHandleFn = (
  channel: string,
  handler: (...args: unknown[]) => Promise<unknown> | unknown
) => void

export interface ExportIpcHandlerDeps {
  readonly handle: RegisterHandleFn
  readonly exportCoordinator?: ExportCoordinator
  readonly getMainWindow?: () => BrowserWindow | null
  readonly selectDestinationDirectory?: () => Promise<{
    canceled: boolean
    directoryPath: string | null
  }>
}

export function registerExportIpcHandlers(deps: ExportIpcHandlerDeps): void {
  const { handle, exportCoordinator, getMainWindow, selectDestinationDirectory } = deps

  handle(IPC_CHANNELS.EXPORT_SELECT_DESTINATION, async () => {
    const result = selectDestinationDirectory
      ? await selectDestinationDirectory()
      : await (async () => {
          const win = getMainWindow?.() ?? null
          const options: Electron.OpenDialogOptions = {
            title: 'Select Export Destination Folder',
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

    return ExportSelectDestinationResponseSchema.parse(result)
  })

  handle(IPC_CHANNELS.EXPORT_START, (rawPayload) => {
    if (!exportCoordinator) {
      throw new Error('ExportCoordinator is not initialized')
    }
    const req = ExportStartRequestSchema.parse(rawPayload)
    const job = exportCoordinator.startExport({
      parentDir: req.parentDir,
      bundleFolderName: req.bundleFolderName,
      fileLocationIds: req.fileLocationIds,
      privacyOptions: req.privacyOptions
    })
    return ExportJobRecordSchema.parse(job)
  })

  handle(IPC_CHANNELS.EXPORT_CANCEL, (rawPayload) => {
    if (!exportCoordinator) {
      throw new Error('ExportCoordinator is not initialized')
    }
    const req = ExportCancelRequestSchema.parse(rawPayload)
    const cancelled = exportCoordinator.cancelExport(req.jobId)
    return ExportCancelResponseSchema.parse({ cancelled, jobId: req.jobId })
  })

  handle(IPC_CHANNELS.EXPORT_GET_ACTIVE, () => {
    if (!exportCoordinator) {
      return null
    }
    const job = exportCoordinator.getActiveExportJob()
    return job ? ExportJobRecordSchema.parse(job) : null
  })

  handle(IPC_CHANNELS.EXPORT_LIST_JOBS, (rawPayload) => {
    if (!exportCoordinator) {
      throw new Error('ExportCoordinator is not initialized')
    }
    const req = rawPayload === undefined ? {} : ExportListJobsRequestSchema.parse(rawPayload)
    const page = exportCoordinator.listExportJobs(req)
    return ExportJobListResponseSchema.parse(page)
  })

  handle(IPC_CHANNELS.EXPORT_GET_JOB, (rawPayload) => {
    if (!exportCoordinator) {
      throw new Error('ExportCoordinator is not initialized')
    }
    const req = ExportGetJobRequestSchema.parse(rawPayload)
    const job = exportCoordinator.getExportJob(req.jobId)
    return job ? ExportJobRecordSchema.parse(job) : null
  })

  handle(IPC_CHANNELS.EXPORT_GET_JOB_ITEMS, (rawPayload) => {
    if (!exportCoordinator) {
      throw new Error('ExportCoordinator is not initialized')
    }
    const req = ExportGetJobItemsRequestSchema.parse(rawPayload)
    const itemsPage = exportCoordinator.getExportJobItems(req.jobId, {
      limit: req.limit,
      offset: req.offset,
      status: req.status
    })
    return ExportJobItemsResponseSchema.parse(itemsPage)
  })

  handle(IPC_CHANNELS.EXPORT_VERIFY_JOB, (rawPayload) => {
    if (!exportCoordinator) {
      throw new Error('ExportCoordinator is not initialized')
    }
    const req = ExportVerifyJobRequestSchema.parse(rawPayload)
    const job = exportCoordinator.verifyExportJob(req.jobId)
    return job ? ExportJobRecordSchema.parse(job) : null
  })

  handle(IPC_CHANNELS.EXPORT_PROGRESS_EVENT, (): never => {
    throw new Error('Event-only channel cannot be invoked')
  })

  if (exportCoordinator && getMainWindow) {
    exportCoordinator.onProgress((job) => {
      const win = getMainWindow()
      if (win && !win.isDestroyed()) {
        const parsed = ExportProgressEventSchema.safeParse({ job })
        if (parsed.success) {
          win.webContents.send(IPC_CHANNELS.EXPORT_PROGRESS_EVENT, parsed.data)
        }
      }
    })
  }
}
