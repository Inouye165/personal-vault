import { app, dialog, ipcMain, type BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/contracts/channels'
import {
  AppInfoSchema,
  DismissJobRequestSchema,
  DismissJobResponseSchema,
  GetActiveJobResponseSchema,
  GetLatestJobResponseSchema,
  JobActionResponseSchema,
  JobIdRequestSchema,
  NavigationTabSchema,
  ScanJobProgressSchema,
  SelectRootsResponseSchema,
  StartScanRequestSchema,
  VaultStatusSchema,
  GetDuplicateGroupsRequestSchema,
  GetDuplicateGroupsResponseSchema,
  GetDuplicateGroupMembersRequestSchema,
  GetDuplicateGroupMembersResponseSchema,
  SetDuplicateReviewRequestSchema,
  SetDuplicateReviewResponseSchema,
  validatePayload,
  type AppInfo,
  type DismissJobResponse,
  type GetActiveJobResponse,
  type GetLatestJobResponse,
  type JobActionResponse,
  type SelectRootsResponse,
  type VaultStatus,
  type GetDuplicateGroupsResponse,
  type GetDuplicateGroupMembersResponse,
  type SetDuplicateReviewResponse
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

  const formatActionResponse = (payload: {
    success: boolean
    job?: unknown
    error?: string
  }): JobActionResponse => {
    const res = validatePayload(JobActionResponseSchema, payload)
    if (!res.success) {
      throw new Error(`Invalid JobActionResponse payload in main: ${res.error}`)
    }
    return res.data
  }

  handle(IPC_CHANNELS.SCAN_START_JOB, async (raw: unknown): Promise<JobActionResponse> => {
    const parsed = validatePayload(StartScanRequestSchema, raw)
    if (!parsed.success) {
      return formatActionResponse({ success: false, error: parsed.error })
    }
    if (!coordinator) {
      return formatActionResponse({ success: false, error: 'ScanJobCoordinator not available' })
    }
    try {
      const job = await coordinator.startScan(parsed.data)
      return formatActionResponse({ success: true, job })
    } catch (err) {
      return formatActionResponse({
        success: false,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  })

  handle(IPC_CHANNELS.SCAN_PAUSE_JOB, async (raw: unknown): Promise<JobActionResponse> => {
    const parsed = validatePayload(JobIdRequestSchema, raw)
    if (!parsed.success) {
      return formatActionResponse({ success: false, error: parsed.error })
    }
    if (!coordinator) {
      return formatActionResponse({ success: false, error: 'ScanJobCoordinator not available' })
    }
    try {
      const job = await coordinator.pauseScan(parsed.data.jobId)
      return formatActionResponse({ success: true, job })
    } catch (err) {
      return formatActionResponse({
        success: false,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  })

  handle(IPC_CHANNELS.SCAN_RESUME_JOB, async (raw: unknown): Promise<JobActionResponse> => {
    const parsed = validatePayload(JobIdRequestSchema, raw)
    if (!parsed.success) {
      return formatActionResponse({ success: false, error: parsed.error })
    }
    if (!coordinator) {
      return formatActionResponse({ success: false, error: 'ScanJobCoordinator not available' })
    }
    try {
      const job = await coordinator.resumeScan(parsed.data.jobId)
      return formatActionResponse({ success: true, job })
    } catch (err) {
      return formatActionResponse({
        success: false,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  })

  handle(IPC_CHANNELS.SCAN_CANCEL_JOB, async (raw: unknown): Promise<JobActionResponse> => {
    const parsed = validatePayload(JobIdRequestSchema, raw)
    if (!parsed.success) {
      return formatActionResponse({ success: false, error: parsed.error })
    }
    if (!coordinator) {
      return formatActionResponse({ success: false, error: 'ScanJobCoordinator not available' })
    }
    try {
      const job = await coordinator.cancelScan(parsed.data.jobId)
      return formatActionResponse({ success: true, job })
    } catch (err) {
      return formatActionResponse({
        success: false,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  })

  handle(IPC_CHANNELS.SCAN_GET_ACTIVE_JOB, (): GetActiveJobResponse => {
    const job = coordinator ? coordinator.getActiveJob() : null
    const res = validatePayload(GetActiveJobResponseSchema, { job })
    if (!res.success) throw new Error(res.error)
    return res.data
  })

  handle(IPC_CHANNELS.SCAN_GET_LATEST_JOB, (): GetLatestJobResponse => {
    const job = coordinator ? coordinator.getLatestJob({ unDismissedOnly: true }) : null
    const res = validatePayload(GetLatestJobResponseSchema, { job })
    if (!res.success) throw new Error(res.error)
    return res.data
  })

  handle(IPC_CHANNELS.SCAN_DISMISS_JOB, (raw: unknown): DismissJobResponse => {
    const parsed = validatePayload(DismissJobRequestSchema, raw)
    if (!parsed.success) {
      return DismissJobResponseSchema.parse({ success: false, error: parsed.error })
    }
    if (!coordinator) {
      return DismissJobResponseSchema.parse({
        success: false,
        error: 'ScanJobCoordinator not available'
      })
    }
    try {
      coordinator.dismissScanJob(parsed.data.jobId)
      return DismissJobResponseSchema.parse({ success: true })
    } catch (err) {
      return DismissJobResponseSchema.parse({
        success: false,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  })

  handle(IPC_CHANNELS.DUPLICATES_GET_GROUPS, (raw: unknown): GetDuplicateGroupsResponse => {
    const parsed = validatePayload(GetDuplicateGroupsRequestSchema, raw ?? {})
    if (!parsed.success) {
      throw new Error(`Invalid getDuplicateGroups request: ${parsed.error}`)
    }
    if (!catalog || catalog.isClosed()) {
      return GetDuplicateGroupsResponseSchema.parse({
        items: [],
        totalCount: 0,
        offset: parsed.data.offset ?? 0,
        limit: parsed.data.limit ?? 20,
        hasMore: false
      })
    }
    const result = catalog.getDuplicateGroups(parsed.data)
    const formatted = {
      items: result.items.map((g) => ({
        sha256: g.sha256,
        byteSize: g.byteSize,
        fileCount: g.fileCount,
        groupSignature: g.groupSignature,
        reviewStatus: g.reviewStatus,
        preferredLocationId: g.preferredLocationId,
        hasStaleDecision: g.hasStaleDecision,
        reviewedAtMs: g.reviewedAtMs,
        previewLocations: g.locations.map((loc) => ({
          id: loc.id,
          sourceId: loc.sourceId,
          originalPath: loc.originalPath,
          normalizedPath: loc.normalizedPath,
          fileName: loc.fileName,
          extension: loc.extension,
          category: loc.category,
          byteSize: loc.byteSize,
          filesystemBirthtimeMs: loc.filesystemBirthtimeMs,
          filesystemMtimeMs: loc.filesystemMtimeMs,
          inferredCaptureTimeMs: loc.inferredCaptureTimeMs,
          firstDiscoveredAtMs: loc.firstDiscoveredAtMs,
          lastSeenAtMs: loc.lastSeenAtMs,
          activeHash: loc.activeHash,
          activeHashVerifiedAtMs: loc.activeHashVerifiedAtMs,
          discoveryObservationId: loc.discoveryObservationId
        })),
        truncatedLocations: g.truncatedLocations
      })),
      totalCount: result.totalCount,
      offset: result.offset,
      limit: result.limit,
      hasMore: result.hasMore
    }
    const validated = validatePayload(GetDuplicateGroupsResponseSchema, formatted)
    if (!validated.success) {
      throw new Error(`Invalid outgoing GetDuplicateGroupsResponse in main: ${validated.error}`)
    }
    return validated.data
  })

  handle(IPC_CHANNELS.DUPLICATES_GET_MEMBERS, (raw: unknown): GetDuplicateGroupMembersResponse => {
    const parsed = validatePayload(GetDuplicateGroupMembersRequestSchema, raw)
    if (!parsed.success) {
      throw new Error(`Invalid getDuplicateGroupMembers request: ${parsed.error}`)
    }
    if (!catalog || catalog.isClosed()) {
      throw new Error('Catalog database is not available')
    }
    const result = catalog.getDuplicateGroupMembers(parsed.data)
    const validated = validatePayload(GetDuplicateGroupMembersResponseSchema, result)
    if (!validated.success) {
      throw new Error(
        `Invalid outgoing GetDuplicateGroupMembersResponse in main: ${validated.error}`
      )
    }
    return validated.data
  })

  handle(IPC_CHANNELS.DUPLICATES_SET_REVIEW, (raw: unknown): SetDuplicateReviewResponse => {
    const parsed = validatePayload(SetDuplicateReviewRequestSchema, raw)
    if (!parsed.success) {
      throw new Error(`Invalid setDuplicateReview request: ${parsed.error}`)
    }
    if (!catalog || catalog.isClosed()) {
      throw new Error('Catalog database is not available')
    }
    const result = catalog.setDuplicateReview(parsed.data)
    const validated = validatePayload(SetDuplicateReviewResponseSchema, result)
    if (!validated.success) {
      throw new Error(`Invalid outgoing SetDuplicateReviewResponse in main: ${validated.error}`)
    }
    return validated.data
  })

  handle(IPC_CHANNELS.SCAN_PROGRESS_EVENT, (): never => {
    throw new Error('Event-only channel cannot be invoked')
  })

  if (coordinator && getMainWindow) {
    coordinator.onProgress((progress) => {
      const win = getMainWindow()
      if (win && !win.isDestroyed()) {
        const validated = validatePayload(ScanJobProgressSchema, progress)
        if (validated.success) {
          win.webContents.send(IPC_CHANNELS.SCAN_PROGRESS_EVENT, validated.data)
        } else {
          console.error(
            `Invalid outgoing ScanJobProgress event payload in main: ${validated.error}`
          )
        }
      }
    })
  }
}
