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
  SelectVaultDirectoryResponseSchema,
  InitializeVaultRequestSchema,
  InitializeVaultResponseSchema,
  GetActiveVaultResponseSchema,
  SetActiveVaultRequestSchema,
  SetActiveVaultResponseSchema,
  GetImportCandidatesRequestSchema,
  GetImportCandidatesResponseSchema,
  StartImportRequestSchema,
  StartImportResponseSchema,
  VaultImportProgressSchema,
  GetActiveImportJobResponseSchema,
  GetLatestImportJobResponseSchema,
  VaultImportActionResponseSchema,
  PauseImportRequestSchema,
  ResumeImportRequestSchema,
  CancelImportRequestSchema,
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
  type SetDuplicateReviewResponse,
  type SelectVaultDirectoryResponse,
  type InitializeVaultResponse,
  type GetActiveVaultResponse,
  type SetActiveVaultResponse,
  type GetImportCandidatesResponse,
  type StartImportResponse,
  type GetActiveImportJobResponse,
  type GetLatestImportJobResponse,
  type VaultImportActionResponse,
  GetPhotosPageRequestSchema,
  GetPhotosPageResponseSchema,
  GetThumbnailRequestSchema,
  ThumbnailResultSchema,
  CancelThumbnailRequestSchema,
  CancelThumbnailResponseSchema,
  PhotosDiagnosticsResponseSchema,
  type GetPhotosPageResponse,
  type ThumbnailResult,
  type CancelThumbnailResponse,
  type PhotosDiagnosticsResponse,
  SetPhotoAnnotationRequestSchema,
  SetPhotoAnnotationResponseSchema,
  GetPhotoAnnotationRequestSchema,
  GetPhotoAnnotationResponseSchema,
  CreateCollectionRequestSchema,
  CreateCollectionResponseSchema,
  RenameCollectionRequestSchema,
  RenameCollectionResponseSchema,
  ListCollectionsRequestSchema,
  ListCollectionsResponseSchema,
  AddCollectionMemberRequestSchema,
  AddCollectionMemberResponseSchema,
  RemoveCollectionMemberRequestSchema,
  RemoveCollectionMemberResponseSchema,
  GetPhotoMembershipsRequestSchema,
  GetPhotoMembershipsResponseSchema,
  type SetPhotoAnnotationResponse,
  type GetPhotoAnnotationResponse,
  type CreateCollectionResponse,
  type RenameCollectionResponse,
  type ListCollectionsResponse,
  type AddCollectionMemberResponse,
  type RemoveCollectionMemberResponse,
  type GetPhotoMembershipsResponse
} from '../../shared/validation/ipc-schemas'
import type { CatalogDatabase } from '../services/catalog'
import type { ScanJobCoordinator } from '../services/jobs'
import {
  initializeVault,
  validateVaultSeparation,
  type VaultImportCoordinator
} from '../services/vault'
import type { ThumbnailCoordinator } from '../services/thumbnails'
import type { IpcSenderEvent, SenderValidator } from './sender'

export interface IpcHandlerOptions {
  readonly validateSender: SenderValidator
  readonly catalog?: CatalogDatabase
  readonly coordinator?: ScanJobCoordinator
  readonly vaultCoordinator?: VaultImportCoordinator
  readonly thumbnailCoordinator?: ThumbnailCoordinator
  readonly getMainWindow?: () => BrowserWindow | null
  readonly selectDirectories?: () => Promise<{ cancelled: boolean; filePaths: string[] }>
  readonly selectVaultDirectory?: () => Promise<{ cancelled: boolean; filePaths: string[] }>
}

export function registerIpcHandlers({
  validateSender,
  catalog,
  coordinator,
  vaultCoordinator,
  thumbnailCoordinator,
  getMainWindow,
  selectDirectories,
  selectVaultDirectory
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
    if (catalog && !catalog.isClosed()) {
      const activeVault = catalog.getActiveVault()
      if (activeVault) {
        try {
          validateVaultSeparation(activeVault.vaultPath, parsed.data.roots)
        } catch (err) {
          return formatActionResponse({
            success: false,
            error: err instanceof Error ? err.message : String(err)
          })
        }
      }
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

  // ==========================================
  // Stage 4: Vault & Verified Import Handlers
  // ==========================================

  handle(IPC_CHANNELS.VAULT_SELECT_DIRECTORY, async (): Promise<SelectVaultDirectoryResponse> => {
    const dialogFn =
      selectVaultDirectory ||
      (async () => {
        const win = getMainWindow ? getMainWindow() : null
        return win
          ? dialog.showOpenDialog(win, {
              title: 'Select Vault Storage Directory',
              properties: ['openDirectory', 'createDirectory']
            })
          : dialog.showOpenDialog({
              title: 'Select Vault Storage Directory',
              properties: ['openDirectory', 'createDirectory']
            })
      })

    const dialogResult = await dialogFn()
    const cancelled =
      'canceled' in dialogResult
        ? (dialogResult as { canceled: boolean }).canceled
        : (dialogResult as { cancelled: boolean }).cancelled
    const filePaths = dialogResult.filePaths
    const selectedDirectory = !cancelled && filePaths.length > 0 ? filePaths[0] : null
    const validated = validatePayload(SelectVaultDirectoryResponseSchema, { selectedDirectory })
    if (!validated.success) {
      throw new Error(`Invalid outgoing SelectVaultDirectoryResponse in main: ${validated.error}`)
    }
    return validated.data
  })

  handle(IPC_CHANNELS.VAULT_INITIALIZE, (raw: unknown): InitializeVaultResponse => {
    const parsed = validatePayload(InitializeVaultRequestSchema, raw)
    if (!parsed.success) {
      throw new Error(`Invalid initializeVault request: ${parsed.error}`)
    }
    if (catalog && !catalog.isClosed()) {
      const sourceRoots = catalog.listSources().items.map((s) => s.rootPath)
      validateVaultSeparation(parsed.data.vaultPath, sourceRoots)
    }
    const identity = initializeVault(parsed.data)
    if (catalog && !catalog.isClosed()) {
      catalog.registerVault({
        vaultId: identity.vaultId,
        vaultPath: parsed.data.vaultPath,
        name: identity.vaultName,
        createdAtMs: identity.createdAtMs
      })
    }
    const validated = validatePayload(InitializeVaultResponseSchema, { vault: identity })
    if (!validated.success) {
      throw new Error(`Invalid outgoing InitializeVaultResponse in main: ${validated.error}`)
    }
    return validated.data
  })

  handle(IPC_CHANNELS.VAULT_GET_ACTIVE, (): GetActiveVaultResponse => {
    if (!catalog || catalog.isClosed()) {
      return { vault: null }
    }
    const active = catalog.getActiveVault()
    const validated = validatePayload(GetActiveVaultResponseSchema, {
      vault: active
        ? {
            vaultId: active.vaultId,
            vaultPath: active.vaultPath,
            name: active.name,
            createdAtMs: active.createdAtMs
          }
        : null
    })
    if (!validated.success) {
      throw new Error(`Invalid outgoing GetActiveVaultResponse in main: ${validated.error}`)
    }
    return validated.data
  })

  handle(IPC_CHANNELS.VAULT_SET_ACTIVE, (raw: unknown): SetActiveVaultResponse => {
    const parsed = validatePayload(SetActiveVaultRequestSchema, raw)
    if (!parsed.success) {
      throw new Error(`Invalid setActiveVault request: ${parsed.error}`)
    }
    if (!catalog || catalog.isClosed()) {
      throw new Error('Catalog database is not available')
    }
    const sourceRoots = catalog.listSources().items.map((s) => s.rootPath)
    validateVaultSeparation(parsed.data.vaultPath, sourceRoots)
    const record = catalog.setActiveVault(parsed.data.vaultPath)
    const validated = validatePayload(SetActiveVaultResponseSchema, {
      vault: {
        vaultId: record.vaultId,
        vaultPath: record.vaultPath,
        name: record.name,
        createdAtMs: record.createdAtMs
      }
    })
    if (!validated.success) {
      throw new Error(`Invalid outgoing SetActiveVaultResponse in main: ${validated.error}`)
    }
    return validated.data
  })

  handle(IPC_CHANNELS.VAULT_GET_IMPORT_CANDIDATES, (raw: unknown): GetImportCandidatesResponse => {
    const parsed = validatePayload(GetImportCandidatesRequestSchema, raw)
    if (!parsed.success) {
      throw new Error(`Invalid getImportCandidates request: ${parsed.error}`)
    }
    if (!catalog || catalog.isClosed()) {
      throw new Error('Catalog database is not available')
    }
    const result = catalog.getImportCandidates(parsed.data)
    const validated = validatePayload(GetImportCandidatesResponseSchema, result)
    if (!validated.success) {
      throw new Error(`Invalid outgoing GetImportCandidatesResponse in main: ${validated.error}`)
    }
    return validated.data
  })

  handle(IPC_CHANNELS.VAULT_START_IMPORT, async (raw: unknown): Promise<StartImportResponse> => {
    const parsed = validatePayload(StartImportRequestSchema, raw)
    if (!parsed.success) {
      throw new Error(`Invalid startImport request: ${parsed.error}`)
    }
    if (!vaultCoordinator) {
      throw new Error('Vault import coordinator is not available')
    }
    const job = await vaultCoordinator.startImport(parsed.data)
    const validated = validatePayload(StartImportResponseSchema, { job })
    if (!validated.success) {
      throw new Error(`Invalid outgoing StartImportResponse in main: ${validated.error}`)
    }
    return validated.data
  })

  handle(
    IPC_CHANNELS.VAULT_PAUSE_IMPORT,
    async (raw: unknown): Promise<VaultImportActionResponse> => {
      const parsed = validatePayload(PauseImportRequestSchema, raw ?? {})
      if (!parsed.success) {
        throw new Error(`Invalid pauseImport request: ${parsed.error}`)
      }
      if (!vaultCoordinator) {
        throw new Error('Vault import coordinator is not available')
      }
      const job = await vaultCoordinator.pauseImport()
      const validated = validatePayload(VaultImportActionResponseSchema, { success: true, job })
      if (!validated.success) {
        throw new Error(`Invalid outgoing VaultImportActionResponse in main: ${validated.error}`)
      }
      return validated.data
    }
  )

  handle(
    IPC_CHANNELS.VAULT_RESUME_IMPORT,
    async (raw: unknown): Promise<VaultImportActionResponse> => {
      const parsed = validatePayload(ResumeImportRequestSchema, raw ?? {})
      if (!parsed.success) {
        throw new Error(`Invalid resumeImport request: ${parsed.error}`)
      }
      if (!vaultCoordinator) {
        throw new Error('Vault import coordinator is not available')
      }
      const job = await vaultCoordinator.resumeImport(parsed.data.jobId)
      const validated = validatePayload(VaultImportActionResponseSchema, { success: true, job })
      if (!validated.success) {
        throw new Error(`Invalid outgoing VaultImportActionResponse in main: ${validated.error}`)
      }
      return validated.data
    }
  )

  handle(
    IPC_CHANNELS.VAULT_CANCEL_IMPORT,
    async (raw: unknown): Promise<VaultImportActionResponse> => {
      const parsed = validatePayload(CancelImportRequestSchema, raw ?? {})
      if (!parsed.success) {
        throw new Error(`Invalid cancelImport request: ${parsed.error}`)
      }
      if (!vaultCoordinator) {
        throw new Error('Vault import coordinator is not available')
      }
      const job = await vaultCoordinator.cancelImport(parsed.data.jobId)
      const validated = validatePayload(VaultImportActionResponseSchema, { success: true, job })
      if (!validated.success) {
        throw new Error(`Invalid outgoing VaultImportActionResponse in main: ${validated.error}`)
      }
      return validated.data
    }
  )

  handle(IPC_CHANNELS.VAULT_GET_ACTIVE_IMPORT, (): GetActiveImportJobResponse => {
    if (!vaultCoordinator) {
      return { job: null }
    }
    const job = vaultCoordinator.getActiveImportJob()
    const validated = validatePayload(GetActiveImportJobResponseSchema, { job })
    if (!validated.success) {
      throw new Error(`Invalid outgoing GetActiveImportJobResponse in main: ${validated.error}`)
    }
    return validated.data
  })

  handle(IPC_CHANNELS.VAULT_GET_LATEST_IMPORT, (): GetLatestImportJobResponse => {
    if (!vaultCoordinator) {
      return { job: null }
    }
    const job = vaultCoordinator.getLatestImportJob()
    const validated = validatePayload(GetLatestImportJobResponseSchema, { job })
    if (!validated.success) {
      throw new Error(`Invalid outgoing GetLatestImportJobResponse in main: ${validated.error}`)
    }
    return validated.data
  })

  handle(IPC_CHANNELS.VAULT_PROGRESS_EVENT, (): never => {
    throw new Error('Event-only channel cannot be invoked')
  })

  handle(IPC_CHANNELS.PHOTOS_GET_PAGE, (raw: unknown): GetPhotosPageResponse => {
    const parsed = validatePayload(GetPhotosPageRequestSchema, raw)
    if (!parsed.success) {
      throw new Error(`Invalid incoming GetPhotosPageRequest in main: ${parsed.error}`)
    }
    if (!catalog) {
      return {
        items: [],
        totalCount: 0,
        offset: parsed.data.offset,
        limit: parsed.data.limit,
        hasMore: false
      }
    }
    const res = catalog.queryFileLocations({
      category: 'photo',
      offset: parsed.data.offset,
      limit: parsed.data.limit,
      ratingFilter: parsed.data.ratingFilter,
      flagFilter: parsed.data.flagFilter,
      collectionId: parsed.data.collectionId
    })
    const validated = validatePayload(GetPhotosPageResponseSchema, res)
    if (!validated.success) {
      throw new Error(`Invalid outgoing GetPhotosPageResponse in main: ${validated.error}`)
    }
    return validated.data
  })

  handle(IPC_CHANNELS.PHOTOS_GET_THUMBNAIL, async (raw: unknown): Promise<ThumbnailResult> => {
    const parsed = validatePayload(GetThumbnailRequestSchema, raw)
    if (!parsed.success) {
      throw new Error(`Invalid incoming GetThumbnailRequest in main: ${parsed.error}`)
    }
    const { locationId, expectedByteSize, expectedMtimeMs, priority } = parsed.data
    if (!thumbnailCoordinator || !catalog) {
      return {
        status: 'missing',
        locationId,
        reason: 'Thumbnail coordinator or catalog unavailable'
      }
    }

    const fileRecord = catalog.getFileLocationById(locationId)
    if (!fileRecord || fileRecord.category !== 'photo') {
      return {
        status: 'missing',
        locationId,
        reason: `Photograph location ID ${locationId} not found in catalog`
      }
    }

    const res = await thumbnailCoordinator.requestThumbnail({
      locationId,
      sourcePath: fileRecord.originalPath,
      expectedByteSize: expectedByteSize ?? fileRecord.byteSize,
      expectedMtimeMs:
        expectedMtimeMs !== undefined ? expectedMtimeMs : fileRecord.filesystemMtimeMs,
      expectedSha256: fileRecord.activeHash,
      priority
    })

    const validated = validatePayload(ThumbnailResultSchema, res)
    if (!validated.success) {
      throw new Error(`Invalid outgoing ThumbnailResult in main: ${validated.error}`)
    }
    return validated.data
  })

  handle(IPC_CHANNELS.PHOTOS_CANCEL_THUMBNAIL, (raw: unknown): CancelThumbnailResponse => {
    const parsed = validatePayload(CancelThumbnailRequestSchema, raw)
    if (!parsed.success) {
      throw new Error(`Invalid cancelThumbnail request: ${parsed.error}`)
    }
    if (!thumbnailCoordinator) {
      return { success: false, locationId: parsed.data.locationId }
    }
    const success = thumbnailCoordinator.cancelRequest(parsed.data.locationId)
    const validated = validatePayload(CancelThumbnailResponseSchema, {
      success,
      locationId: parsed.data.locationId
    })
    if (!validated.success) {
      throw new Error(`Invalid outgoing CancelThumbnailResponse: ${validated.error}`)
    }
    return validated.data
  })

  handle(IPC_CHANNELS.PHOTOS_GET_DIAGNOSTICS, (): PhotosDiagnosticsResponse => {
    if (!thumbnailCoordinator) {
      return { activeWorkers: 0, queuedJobs: 0, totalDecodes: 0, cacheHits: 0, cacheMisses: 0 }
    }
    const diag = thumbnailCoordinator.getDiagnostics()
    const validated = validatePayload(PhotosDiagnosticsResponseSchema, diag)
    if (!validated.success) {
      throw new Error(`Invalid outgoing PhotosDiagnosticsResponse: ${validated.error}`)
    }
    return validated.data
  })

  // --- Stage 5B: Photo Review & Collections Handlers ---

  handle(IPC_CHANNELS.PHOTOS_SET_ANNOTATION, (raw: unknown): SetPhotoAnnotationResponse => {
    const parsed = validatePayload(SetPhotoAnnotationRequestSchema, raw)
    if (!parsed.success) {
      throw new Error(`Invalid incoming SetPhotoAnnotationRequest in main: ${parsed.error}`)
    }
    if (!catalog) {
      throw new Error('Catalog unavailable')
    }
    const ann = catalog.setPhotoAnnotation({
      fileLocationId: parsed.data.fileLocationId,
      expectedRevision: parsed.data.expectedRevision,
      expectedVersion: parsed.data.expectedVersion,
      rating: parsed.data.rating,
      flag: parsed.data.flag
    })
    const res: SetPhotoAnnotationResponse = {
      success: true,
      annotation: ann
    }
    const validated = validatePayload(SetPhotoAnnotationResponseSchema, res)
    if (!validated.success) {
      throw new Error(`Invalid outgoing SetPhotoAnnotationResponse in main: ${validated.error}`)
    }
    return validated.data
  })

  handle(IPC_CHANNELS.PHOTOS_GET_ANNOTATION, (raw: unknown): GetPhotoAnnotationResponse => {
    const parsed = validatePayload(GetPhotoAnnotationRequestSchema, raw)
    if (!parsed.success) {
      throw new Error(`Invalid incoming GetPhotoAnnotationRequest in main: ${parsed.error}`)
    }
    if (!catalog) {
      return { annotation: null }
    }
    const ann = catalog.getPhotoAnnotation(parsed.data.fileLocationId)
    const res: GetPhotoAnnotationResponse = {
      annotation: ann
    }
    const validated = validatePayload(GetPhotoAnnotationResponseSchema, res)
    if (!validated.success) {
      throw new Error(`Invalid outgoing GetPhotoAnnotationResponse in main: ${validated.error}`)
    }
    return validated.data
  })

  handle(IPC_CHANNELS.COLLECTIONS_LIST, (raw: unknown): ListCollectionsResponse => {
    const parsed = validatePayload(ListCollectionsRequestSchema, raw)
    if (!parsed.success) {
      throw new Error(`Invalid incoming ListCollectionsRequest in main: ${parsed.error}`)
    }
    if (!catalog) {
      return {
        items: [],
        totalCount: 0,
        offset: parsed.data.offset ?? 0,
        limit: parsed.data.limit ?? 50,
        hasMore: false
      }
    }
    const res = catalog.listCollections({
      offset: parsed.data.offset,
      limit: parsed.data.limit
    })
    const validated = validatePayload(ListCollectionsResponseSchema, res)
    if (!validated.success) {
      throw new Error(`Invalid outgoing ListCollectionsResponse in main: ${validated.error}`)
    }
    return validated.data
  })

  handle(IPC_CHANNELS.COLLECTIONS_CREATE, (raw: unknown): CreateCollectionResponse => {
    const parsed = validatePayload(CreateCollectionRequestSchema, raw)
    if (!parsed.success) {
      throw new Error(`Invalid incoming CreateCollectionRequest in main: ${parsed.error}`)
    }
    if (!catalog) {
      throw new Error('Catalog unavailable')
    }
    const collection = catalog.createCollection({ name: parsed.data.name })
    const res: CreateCollectionResponse = { collection }
    const validated = validatePayload(CreateCollectionResponseSchema, res)
    if (!validated.success) {
      throw new Error(`Invalid outgoing CreateCollectionResponse in main: ${validated.error}`)
    }
    return validated.data
  })

  handle(IPC_CHANNELS.COLLECTIONS_RENAME, (raw: unknown): RenameCollectionResponse => {
    const parsed = validatePayload(RenameCollectionRequestSchema, raw)
    if (!parsed.success) {
      throw new Error(`Invalid incoming RenameCollectionRequest in main: ${parsed.error}`)
    }
    if (!catalog) {
      throw new Error('Catalog unavailable')
    }
    const collection = catalog.renameCollection({
      collectionId: parsed.data.collectionId,
      name: parsed.data.name
    })
    const res: RenameCollectionResponse = { collection }
    const validated = validatePayload(RenameCollectionResponseSchema, res)
    if (!validated.success) {
      throw new Error(`Invalid outgoing RenameCollectionResponse in main: ${validated.error}`)
    }
    return validated.data
  })

  handle(IPC_CHANNELS.COLLECTIONS_ADD_MEMBER, (raw: unknown): AddCollectionMemberResponse => {
    const parsed = validatePayload(AddCollectionMemberRequestSchema, raw)
    if (!parsed.success) {
      throw new Error(`Invalid incoming AddCollectionMemberRequest in main: ${parsed.error}`)
    }
    if (!catalog) {
      throw new Error('Catalog unavailable')
    }
    const result = catalog.addCollectionMember({
      collectionId: parsed.data.collectionId,
      fileLocationId: parsed.data.fileLocationId,
      expectedRevision: parsed.data.expectedRevision
    })
    const validated = validatePayload(AddCollectionMemberResponseSchema, result)
    if (!validated.success) {
      throw new Error(`Invalid outgoing AddCollectionMemberResponse in main: ${validated.error}`)
    }
    return validated.data
  })

  handle(IPC_CHANNELS.COLLECTIONS_REMOVE_MEMBER, (raw: unknown): RemoveCollectionMemberResponse => {
    const parsed = validatePayload(RemoveCollectionMemberRequestSchema, raw)
    if (!parsed.success) {
      throw new Error(`Invalid incoming RemoveCollectionMemberRequest in main: ${parsed.error}`)
    }
    if (!catalog) {
      throw new Error('Catalog unavailable')
    }
    const result = catalog.removeCollectionMember({
      collectionId: parsed.data.collectionId,
      fileLocationId: parsed.data.fileLocationId,
      expectedRevision: parsed.data.expectedRevision
    })
    const validated = validatePayload(RemoveCollectionMemberResponseSchema, result)
    if (!validated.success) {
      throw new Error(`Invalid outgoing RemoveCollectionMemberResponse in main: ${validated.error}`)
    }
    return validated.data
  })

  handle(
    IPC_CHANNELS.COLLECTIONS_GET_MEMBERSHIPS_FOR_PHOTO,
    (raw: unknown): GetPhotoMembershipsResponse => {
      const parsed = validatePayload(GetPhotoMembershipsRequestSchema, raw)
      if (!parsed.success) {
        throw new Error(`Invalid incoming GetPhotoMembershipsRequest in main: ${parsed.error}`)
      }
      if (!catalog) {
        return { items: [], totalCount: 0, hasMore: false }
      }
      const res = catalog.getCollectionMembershipsForPhoto({
        fileLocationId: parsed.data.fileLocationId,
        offset: parsed.data.offset,
        limit: parsed.data.limit
      })
      const mapped = {
        items: res.items.map((i) => ({
          id: i.id,
          collectionId: i.collectionId,
          collectionName: i.collectionName ?? '',
          fileLocationId: i.fileLocationId,
          createdAtMs: i.createdAtMs
        })),
        totalCount: res.totalCount,
        hasMore: res.hasMore
      }
      const validated = validatePayload(GetPhotoMembershipsResponseSchema, mapped)
      if (!validated.success) {
        throw new Error(`Invalid outgoing GetPhotoMembershipsResponse in main: ${validated.error}`)
      }
      return validated.data
    }
  )

  if (vaultCoordinator && getMainWindow) {
    vaultCoordinator.onProgress((progress) => {
      const win = getMainWindow()
      if (win && !win.isDestroyed()) {
        const validated = validatePayload(VaultImportProgressSchema, progress)
        if (validated.success) {
          win.webContents.send(IPC_CHANNELS.VAULT_PROGRESS_EVENT, validated.data)
        } else {
          console.error(
            `Invalid outgoing VaultImportProgress event payload in main: ${validated.error}`
          )
        }
      }
    })
  }

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
