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
  ReconcileJournalResponseSchema,
  type SetPhotoAnnotationResponse,
  type GetPhotoAnnotationResponse,
  type CreateCollectionResponse,
  type RenameCollectionResponse,
  type ListCollectionsResponse,
  type AddCollectionMemberResponse,
  type RemoveCollectionMemberResponse,
  type GetPhotoMembershipsResponse,
  type ReconcileJournalResponse,
  SimilarityGetPairsRequestSchema,
  SimilarityGetPairsResponseSchema,
  SimilaritySetDecisionRequestSchema,
  SimilaritySetDecisionResponseSchema,
  type SimilarityAnalysisProgress,
  type SimilarityGetPairsResponse,
  type SimilaritySetDecisionResponse,
  type SimilarityReconcileResponse,
  SemanticModelStatusResponseSchema,
  SemanticIndexProgressResponseSchema,
  SemanticIndexJobItemsRequestSchema,
  SemanticIndexJobItemsResponseSchema,
  type SemanticModelStatusResponse,
  type SemanticIndexProgressResponse,
  type SemanticIndexJobItemsResponse,
  SemanticSearchRequestSchema,
  SemanticSearchResponseSchema,
  SemanticSearchCancelRequestSchema,
  SemanticSearchCancelResponseSchema,
  type SemanticSearchResponse,
  type SemanticSearchCancelResponse,
  PhotoMetadataProgressResponseSchema,
  StartPhotoMetadataExtractionRequestSchema,
  GetPhotoMetadataDetailRequestSchema,
  GetPhotoMetadataDetailResponseSchema,
  GetPhotoMetadataFacetsRequestSchema,
  GetPhotoMetadataFacetsResponseSchema,
  type PhotoMetadataProgressResponse,
  type GetPhotoMetadataDetailResponse,
  type GetPhotoMetadataFacetsResponse
} from '../../shared/validation/ipc-schemas'
import type { CatalogDatabase } from '../services/catalog'
import type { ScanJobCoordinator } from '../services/jobs'
import {
  initializeVault,
  validateVaultSeparation,
  type VaultImportCoordinator
} from '../services/vault'
import type { ThumbnailCoordinator } from '../services/thumbnails'
import type { SimilarityCoordinator } from '../services/similarity'
import type {
  SemanticModelManager,
  SemanticIndexCoordinator,
  SemanticSearchCoordinator
} from '../services/semantic'
import { METADATA_PARSER_RECIPE_VERSION, type PhotoMetadataCoordinator } from '../services/metadata'
import type { IpcSenderEvent, SenderValidator } from './sender'
import { registerDocumentIpcHandlers } from './document-handlers'

export interface IpcHandlerOptions {
  readonly validateSender: SenderValidator
  readonly catalog?: CatalogDatabase
  readonly coordinator?: ScanJobCoordinator
  readonly vaultCoordinator?: VaultImportCoordinator
  readonly thumbnailCoordinator?: ThumbnailCoordinator
  readonly similarityCoordinator?: SimilarityCoordinator
  readonly semanticModelManager?: SemanticModelManager
  readonly semanticIndexCoordinator?: SemanticIndexCoordinator
  readonly semanticSearchCoordinator?: SemanticSearchCoordinator
  readonly photoMetadataCoordinator?: PhotoMetadataCoordinator
  readonly getMainWindow?: () => BrowserWindow | null
  readonly selectDirectories?: () => Promise<{ cancelled: boolean; filePaths: string[] }>
  readonly selectVaultDirectory?: () => Promise<{ cancelled: boolean; filePaths: string[] }>
  readonly selectDirectory?: () => Promise<string | null>
}

export function registerIpcHandlers({
  validateSender,
  catalog,
  coordinator,
  vaultCoordinator,
  thumbnailCoordinator,
  similarityCoordinator,
  semanticModelManager,
  semanticIndexCoordinator,
  semanticSearchCoordinator,
  photoMetadataCoordinator,
  getMainWindow,
  selectDirectories,
  selectVaultDirectory,
  selectDirectory
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
    const activeRecipe =
      photoMetadataCoordinator?.getParserRecipeVersion() ?? METADATA_PARSER_RECIPE_VERSION
    const res = catalog.queryFileLocations({
      category: 'photo',
      offset: parsed.data.offset,
      limit: parsed.data.limit,
      ratingFilter: parsed.data.ratingFilter,
      flagFilter: parsed.data.flagFilter,
      collectionId: parsed.data.collectionId,
      parserRecipeVersion: activeRecipe,
      captureDateFrom: parsed.data.captureDateFrom,
      captureDateTo: parsed.data.captureDateTo,
      includeUnknownCaptureDate: parsed.data.includeUnknownCaptureDate,
      cameraNormalized: parsed.data.cameraNormalized,
      onlyUnknownCamera: parsed.data.onlyUnknownCamera,
      lensNormalized: parsed.data.lensNormalized,
      onlyUnknownLens: parsed.data.onlyUnknownLens,
      minWidthPx: parsed.data.minWidthPx,
      minHeightPx: parsed.data.minHeightPx,
      includeUnknownDimensions: parsed.data.includeUnknownDimensions,
      fileTypeBasis: parsed.data.fileTypeBasis,
      fileTypeValue: parsed.data.fileTypeValue,
      onlyUnknownDetectedFormat: parsed.data.onlyUnknownDetectedFormat
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
    const searchDiag = semanticSearchCoordinator?.getDiagnostics()
    const combinedDiag = {
      ...diag,
      ...(searchDiag
        ? {
            searchActiveWorkers: searchDiag.activeWorkers,
            searchTerminatingWorkers: searchDiag.terminatingWorkers,
            searchLiveWorkers: searchDiag.liveWorkers,
            searchPendingRequests: searchDiag.pendingRequests,
            searchActiveCalls: searchDiag.activeSearchCalls,
            searchMaxPendingRequests: searchDiag.maxPendingRequests,
            totalAppLiveWorkers: (diag.liveWorkers ?? diag.activeWorkers) + searchDiag.liveWorkers
          }
        : {})
    }
    const validated = validatePayload(PhotosDiagnosticsResponseSchema, combinedDiag)
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
      annotation: ann,
      persistencePending: ann.persistencePending,
      persistenceError: ann.persistenceError
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
    const res: CreateCollectionResponse = {
      collection,
      persistencePending: collection.persistencePending,
      persistenceError: collection.persistenceError
    }
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
    const res: RenameCollectionResponse = {
      collection,
      persistencePending: collection.persistencePending,
      persistenceError: collection.persistenceError
    }
    const validated = validatePayload(RenameCollectionResponseSchema, res)
    if (!validated.success) {
      throw new Error(`Invalid outgoing RenameCollectionResponse in main: ${validated.error}`)
    }
    return validated.data
  })

  handle(IPC_CHANNELS.PHOTOS_RECONCILE_JOURNAL, (): ReconcileJournalResponse => {
    if (!catalog) {
      throw new Error('Catalog unavailable')
    }
    const result = catalog.reconcileJournalWithDatabase()
    const res: ReconcileJournalResponse = {
      success: true,
      reconciledCount: result.reconciledCount
    }
    const validated = validatePayload(ReconcileJournalResponseSchema, res)
    if (!validated.success) {
      throw new Error(`Invalid outgoing ReconcileJournalResponse in main: ${validated.error}`)
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

  handle(IPC_CHANNELS.SIMILARITY_START_ANALYSIS, async (): Promise<SimilarityAnalysisProgress> => {
    if (!similarityCoordinator) {
      throw new Error('Similarity coordinator unavailable')
    }
    await similarityCoordinator.startAnalysis()
    return similarityCoordinator.getProgress()
  })

  handle(IPC_CHANNELS.SIMILARITY_CANCEL_ANALYSIS, (): SimilarityAnalysisProgress => {
    if (!similarityCoordinator) {
      throw new Error('Similarity coordinator unavailable')
    }
    similarityCoordinator.cancelAnalysis()
    return similarityCoordinator.getProgress()
  })

  handle(IPC_CHANNELS.SIMILARITY_RESUME_ANALYSIS, async (): Promise<SimilarityAnalysisProgress> => {
    if (!similarityCoordinator) {
      throw new Error('Similarity coordinator unavailable')
    }
    await similarityCoordinator.resumeAnalysis()
    return similarityCoordinator.getProgress()
  })

  handle(IPC_CHANNELS.SIMILARITY_GET_PROGRESS, (): SimilarityAnalysisProgress => {
    if (!similarityCoordinator) {
      return {
        jobId: null,
        status: 'idle',
        algorithmVersion: 'dhash64_v1',
        totalPhotos: 0,
        processedPhotos: 0,
        errorPhotos: 0,
        unsupportedPhotos: 0,
        candidatePairsFound: 0,
        startedAtMs: null,
        updatedAtMs: null,
        completedAtMs: null
      }
    }
    return similarityCoordinator.getProgress()
  })

  handle(IPC_CHANNELS.SIMILARITY_GET_PAIRS, (raw: unknown): SimilarityGetPairsResponse => {
    const parsed = validatePayload(SimilarityGetPairsRequestSchema, raw)
    if (!parsed.success) {
      throw new Error(`Invalid incoming SimilarityGetPairsRequest: ${parsed.error}`)
    }
    if (!catalog) {
      return {
        pairs: [],
        totalCount: 0,
        page: parsed.data.page,
        pageSize: parsed.data.pageSize,
        totalPages: 0
      }
    }
    const res = catalog.getSimilarityCandidatePairs(parsed.data)
    const validated = validatePayload(SimilarityGetPairsResponseSchema, res)
    if (!validated.success) {
      throw new Error(`Invalid outgoing SimilarityGetPairsResponse: ${validated.error}`)
    }
    return validated.data
  })

  handle(IPC_CHANNELS.SIMILARITY_SET_DECISION, (raw: unknown): SimilaritySetDecisionResponse => {
    const parsed = validatePayload(SimilaritySetDecisionRequestSchema, raw)
    if (!parsed.success) {
      throw new Error(`Invalid incoming SimilaritySetDecisionRequest: ${parsed.error}`)
    }
    if (!catalog) {
      throw new Error('Catalog database unavailable')
    }
    const res = catalog.setSimilarityDecision(parsed.data)
    const responsePayload = {
      success: true,
      decision: res.decision,
      version: res.version,
      persistencePending: res.persistencePending ?? false,
      message: res.persistenceError
    }
    const validated = validatePayload(SimilaritySetDecisionResponseSchema, responsePayload)
    if (!validated.success) {
      throw new Error(`Invalid outgoing SimilaritySetDecisionResponse: ${validated.error}`)
    }
    return validated.data
  })

  handle(IPC_CHANNELS.SIMILARITY_RECONCILE, (): SimilarityReconcileResponse => {
    if (!catalog) {
      return { reconciledCount: 0, unresolvedCount: 0 }
    }
    const res = catalog.reconcileJournalWithDatabase()
    return {
      reconciledCount: res.reconciledCount,
      unresolvedCount: 0
    }
  })

  // --- Stage 6B: Semantic Model Provisioning & Resumable Semantic Index ---

  const validateModelStatusOut = (status: unknown): SemanticModelStatusResponse => {
    const validated = validatePayload(SemanticModelStatusResponseSchema, status)
    if (!validated.success) {
      throw new Error(`Invalid outgoing SemanticModelStatusResponse: ${validated.error}`)
    }
    return validated.data
  }

  const validateIndexProgressOut = (progress: unknown): SemanticIndexProgressResponse => {
    const validated = validatePayload(SemanticIndexProgressResponseSchema, progress)
    if (!validated.success) {
      throw new Error(`Invalid outgoing SemanticIndexProgressResponse: ${validated.error}`)
    }
    return validated.data
  }

  handle(IPC_CHANNELS.SEMANTIC_MODEL_GET_STATUS, (): SemanticModelStatusResponse => {
    if (!semanticModelManager) {
      throw new Error('Semantic model manager unavailable')
    }
    return validateModelStatusOut(semanticModelManager.getStatus())
  })

  handle(IPC_CHANNELS.SEMANTIC_MODEL_DOWNLOAD, async (): Promise<SemanticModelStatusResponse> => {
    if (!semanticModelManager) {
      throw new Error('Semantic model manager unavailable')
    }
    const res = await semanticModelManager.downloadModel()
    return validateModelStatusOut(res)
  })

  handle(
    IPC_CHANNELS.SEMANTIC_MODEL_IMPORT,
    async (raw?: unknown): Promise<SemanticModelStatusResponse> => {
      if (raw !== undefined) {
        throw new Error('Renderer cannot supply filesystem paths to semantic:model-import')
      }
      if (!semanticModelManager) {
        throw new Error('Semantic model manager unavailable')
      }

      let chosenDir: string | null = null
      if (selectDirectory) {
        chosenDir = await selectDirectory()
      } else if (process.env.PV_TEST_MODEL_IMPORT_DIR) {
        chosenDir = process.env.PV_TEST_MODEL_IMPORT_DIR
      } else {
        const win = getMainWindow ? getMainWindow() : null
        const dialogOpts: Electron.OpenDialogOptions = {
          title: 'Select Verified CLIP Model Folder',
          properties: ['openDirectory', 'dontAddToRecent']
        }
        const dialogRes = win
          ? await dialog.showOpenDialog(win, dialogOpts)
          : await dialog.showOpenDialog(dialogOpts)
        if (!dialogRes.canceled && dialogRes.filePaths.length > 0) {
          chosenDir = dialogRes.filePaths[0] ?? null
        }
      }

      if (!chosenDir) {
        return validateModelStatusOut(semanticModelManager.getStatus())
      }

      const res = await semanticModelManager.importFromDirectory(chosenDir)
      return validateModelStatusOut(res)
    }
  )

  handle(IPC_CHANNELS.SEMANTIC_MODEL_CANCEL, async (): Promise<SemanticModelStatusResponse> => {
    if (!semanticModelManager) {
      throw new Error('Semantic model manager unavailable')
    }
    const res = await semanticModelManager.cancelProvisioning()
    return validateModelStatusOut(res)
  })

  handle(IPC_CHANNELS.SEMANTIC_INDEX_GET_PROGRESS, (): SemanticIndexProgressResponse => {
    if (!semanticIndexCoordinator) {
      throw new Error('Semantic index coordinator unavailable')
    }
    return validateIndexProgressOut(semanticIndexCoordinator.getStatus())
  })

  handle(IPC_CHANNELS.SEMANTIC_INDEX_START, async (): Promise<SemanticIndexProgressResponse> => {
    if (!semanticIndexCoordinator) {
      throw new Error('Semantic index coordinator unavailable')
    }
    const res = await semanticIndexCoordinator.startIndexing()
    return validateIndexProgressOut(res)
  })

  handle(IPC_CHANNELS.SEMANTIC_INDEX_PAUSE, async (): Promise<SemanticIndexProgressResponse> => {
    if (!semanticIndexCoordinator) {
      throw new Error('Semantic index coordinator unavailable')
    }
    const res = await semanticIndexCoordinator.pauseIndexing()
    return validateIndexProgressOut(res)
  })

  handle(IPC_CHANNELS.SEMANTIC_INDEX_RESUME, async (): Promise<SemanticIndexProgressResponse> => {
    if (!semanticIndexCoordinator) {
      throw new Error('Semantic index coordinator unavailable')
    }
    const res = await semanticIndexCoordinator.resumeIndexing()
    return validateIndexProgressOut(res)
  })

  handle(IPC_CHANNELS.SEMANTIC_INDEX_CANCEL, async (): Promise<SemanticIndexProgressResponse> => {
    if (!semanticIndexCoordinator) {
      throw new Error('Semantic index coordinator unavailable')
    }
    const res = await semanticIndexCoordinator.cancelIndexing()
    return validateIndexProgressOut(res)
  })

  handle(
    IPC_CHANNELS.SEMANTIC_INDEX_GET_ITEMS,
    (raw: unknown = {}): SemanticIndexJobItemsResponse => {
      const parsed = validatePayload(SemanticIndexJobItemsRequestSchema, raw ?? {})
      if (!parsed.success) {
        throw new Error(`Invalid incoming SemanticIndexJobItemsRequest: ${parsed.error}`)
      }
      if (!semanticIndexCoordinator) {
        throw new Error('Semantic index coordinator unavailable')
      }
      const res = semanticIndexCoordinator.listJobItems(parsed.data)
      const validated = validatePayload(SemanticIndexJobItemsResponseSchema, res)
      if (!validated.success) {
        throw new Error(`Invalid outgoing SemanticIndexJobItemsResponse: ${validated.error}`)
      }
      return validated.data
    }
  )

  handle(IPC_CHANNELS.SEMANTIC_MODEL_STATUS_EVENT, (): never => {
    throw new Error('Event-only channel cannot be invoked')
  })

  handle(IPC_CHANNELS.SEMANTIC_INDEX_PROGRESS_EVENT, (): never => {
    throw new Error('Event-only channel cannot be invoked')
  })

  // --- Stage 6D: Natural-Language Photo Search ---

  handle(
    IPC_CHANNELS.SEMANTIC_SEARCH_PHOTOS,
    async (raw: unknown): Promise<SemanticSearchResponse> => {
      const parsed = validatePayload(SemanticSearchRequestSchema, raw)
      if (!parsed.success) {
        throw new Error(`Invalid incoming SemanticSearchRequest: ${parsed.error}`)
      }
      if (!semanticSearchCoordinator) {
        return {
          items: [],
          totalMatched: 0,
          offset: parsed.data.offset,
          limit: parsed.data.limit,
          hasMore: false,
          eligibleCount: 0,
          unindexedCount: 0,
          staleCount: 0,
          corruptCount: 0,
          modelStatus: 'unprovisioned',
          tokenCount: 0,
          truncated: false,
          queryLatencyMs: 0
        }
      }
      const result = await semanticSearchCoordinator.search(parsed.data)
      const validated = validatePayload(SemanticSearchResponseSchema, result)
      if (!validated.success) {
        throw new Error(`Invalid outgoing SemanticSearchResponse: ${validated.error}`)
      }
      return validated.data
    }
  )

  handle(
    IPC_CHANNELS.SEMANTIC_SEARCH_CANCEL,
    async (raw?: unknown): Promise<SemanticSearchCancelResponse> => {
      const parsed = validatePayload(SemanticSearchCancelRequestSchema, raw ?? {})
      if (!parsed.success) {
        throw new Error(`Invalid incoming SemanticSearchCancelRequest: ${parsed.error}`)
      }
      if (semanticSearchCoordinator) {
        semanticSearchCoordinator.cancelActiveSearch()
      }
      const response: SemanticSearchCancelResponse = { cancelled: true }
      const validated = validatePayload(SemanticSearchCancelResponseSchema, response)
      if (!validated.success) {
        throw new Error(`Invalid outgoing SemanticSearchCancelResponse: ${validated.error}`)
      }
      return validated.data
    }
  )

  // --- Stage 6C: Photo Metadata Extraction, Provenance & Facet Handlers ---

  const validateMetadataProgressOut = (raw: unknown): PhotoMetadataProgressResponse => {
    const validated = validatePayload(PhotoMetadataProgressResponseSchema, raw)
    if (!validated.success) {
      throw new Error(`Invalid outgoing PhotoMetadataProgressResponse: ${validated.error}`)
    }
    return validated.data
  }

  handle(IPC_CHANNELS.METADATA_GET_PROGRESS, (): PhotoMetadataProgressResponse => {
    if (!photoMetadataCoordinator) {
      throw new Error('Photo metadata coordinator unavailable')
    }
    return validateMetadataProgressOut(photoMetadataCoordinator.getProgress())
  })

  handle(
    IPC_CHANNELS.METADATA_START_EXTRACTION,
    async (raw: unknown = {}): Promise<PhotoMetadataProgressResponse> => {
      const parsed = validatePayload(StartPhotoMetadataExtractionRequestSchema, raw ?? {})
      if (!parsed.success) {
        throw new Error(`Invalid incoming StartPhotoMetadataExtractionRequest: ${parsed.error}`)
      }
      if (!photoMetadataCoordinator) {
        throw new Error('Photo metadata coordinator unavailable')
      }
      const res = await photoMetadataCoordinator.startExtraction(parsed.data)
      return validateMetadataProgressOut(res)
    }
  )

  handle(
    IPC_CHANNELS.METADATA_PAUSE_EXTRACTION,
    async (): Promise<PhotoMetadataProgressResponse> => {
      if (!photoMetadataCoordinator) {
        throw new Error('Photo metadata coordinator unavailable')
      }
      const res = await photoMetadataCoordinator.pauseExtraction()
      return validateMetadataProgressOut(res)
    }
  )

  handle(
    IPC_CHANNELS.METADATA_RESUME_EXTRACTION,
    async (): Promise<PhotoMetadataProgressResponse> => {
      if (!photoMetadataCoordinator) {
        throw new Error('Photo metadata coordinator unavailable')
      }
      const res = await photoMetadataCoordinator.resumeExtraction()
      return validateMetadataProgressOut(res)
    }
  )

  handle(
    IPC_CHANNELS.METADATA_CANCEL_EXTRACTION,
    async (): Promise<PhotoMetadataProgressResponse> => {
      if (!photoMetadataCoordinator) {
        throw new Error('Photo metadata coordinator unavailable')
      }
      const res = await photoMetadataCoordinator.cancelExtraction()
      return validateMetadataProgressOut(res)
    }
  )

  handle(IPC_CHANNELS.METADATA_PROGRESS_EVENT, (): never => {
    throw new Error('Event-only channel cannot be invoked')
  })

  handle(IPC_CHANNELS.METADATA_GET_PHOTO_DETAIL, (raw: unknown): GetPhotoMetadataDetailResponse => {
    const parsed = validatePayload(GetPhotoMetadataDetailRequestSchema, raw)
    if (!parsed.success) {
      throw new Error(`Invalid incoming GetPhotoMetadataDetailRequest: ${parsed.error}`)
    }
    if (!catalog || catalog.isClosed()) {
      return { detail: null }
    }
    const recipe =
      photoMetadataCoordinator?.getParserRecipeVersion() ?? METADATA_PARSER_RECIPE_VERSION
    const detail = catalog.getPhotoTechnicalMetadataDetail(parsed.data.fileLocationId, recipe)
    const validated = validatePayload(GetPhotoMetadataDetailResponseSchema, { detail })
    if (!validated.success) {
      throw new Error(`Invalid outgoing GetPhotoMetadataDetailResponse: ${validated.error}`)
    }
    return validated.data
  })

  handle(IPC_CHANNELS.METADATA_GET_FACETS, (raw: unknown): GetPhotoMetadataFacetsResponse => {
    const parsed = validatePayload(GetPhotoMetadataFacetsRequestSchema, raw)
    if (!parsed.success) {
      throw new Error(`Invalid incoming GetPhotoMetadataFacetsRequest: ${parsed.error}`)
    }
    const recipe =
      photoMetadataCoordinator?.getParserRecipeVersion() ?? METADATA_PARSER_RECIPE_VERSION
    if (!catalog || catalog.isClosed()) {
      return {
        field: parsed.data.field,
        items: [],
        unknownCount: 0,
        unprocessedCount: 0,
        offset: parsed.data.offset,
        limit: parsed.data.limit,
        hasMore: false
      }
    }
    const facets = catalog.getPhotoMetadataFacets({
      field: parsed.data.field,
      parserRecipeVersion: recipe,
      search: parsed.data.search,
      limit: parsed.data.limit,
      offset: parsed.data.offset
    })
    const validated = validatePayload(GetPhotoMetadataFacetsResponseSchema, facets)
    if (!validated.success) {
      throw new Error(`Invalid outgoing GetPhotoMetadataFacetsResponse: ${validated.error}`)
    }
    return validated.data
  })

  if (photoMetadataCoordinator && getMainWindow) {
    photoMetadataCoordinator.onProgress((progress) => {
      const win = getMainWindow()
      if (win && !win.isDestroyed()) {
        const validated = validatePayload(PhotoMetadataProgressResponseSchema, progress)
        if (validated.success) {
          win.webContents.send(IPC_CHANNELS.METADATA_PROGRESS_EVENT, validated.data)
        }
      }
    })
  }

  if (semanticModelManager && getMainWindow) {
    semanticModelManager.onStatusChange((status) => {
      const win = getMainWindow()
      if (win && !win.isDestroyed()) {
        const validated = validatePayload(SemanticModelStatusResponseSchema, status)
        if (validated.success) {
          win.webContents.send(IPC_CHANNELS.SEMANTIC_MODEL_STATUS_EVENT, validated.data)
        }
      }
    })
  }

  if (semanticIndexCoordinator && getMainWindow) {
    semanticIndexCoordinator.onProgress((progress) => {
      const win = getMainWindow()
      if (win && !win.isDestroyed()) {
        const validated = validatePayload(SemanticIndexProgressResponseSchema, progress)
        if (validated.success) {
          win.webContents.send(IPC_CHANNELS.SEMANTIC_INDEX_PROGRESS_EVENT, validated.data)
        }
      }
    })
  }

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

  registerDocumentIpcHandlers({ handle, catalog })
}
