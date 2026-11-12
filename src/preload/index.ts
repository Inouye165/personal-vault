import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/contracts/channels.js'
import {
  AppInfoSchema,
  NavigationTabSchema,
  TabAckSchema,
  VaultStatusSchema,
  SelectRootsResponseSchema,
  StartScanRequestSchema,
  JobIdRequestSchema,
  JobActionResponseSchema,
  GetActiveJobResponseSchema,
  GetLatestJobResponseSchema,
  DismissJobRequestSchema,
  DismissJobResponseSchema,
  ScanJobProgressSchema,
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
  GetPhotosPageRequestSchema,
  GetPhotosPageResponseSchema,
  GetThumbnailRequestSchema,
  ThumbnailResultSchema,
  CancelThumbnailRequestSchema,
  CancelThumbnailResponseSchema,
  PhotosDiagnosticsResponseSchema,
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
  SimilarityAnalysisProgressSchema,
  SimilarityGetPairsRequestSchema,
  SimilarityGetPairsResponseSchema,
  SimilaritySetDecisionRequestSchema,
  SimilaritySetDecisionResponseSchema,
  SimilarityReconcileResponseSchema,
  SemanticModelStatusResponseSchema,
  SemanticIndexProgressResponseSchema,
  SemanticIndexJobItemsRequestSchema,
  SemanticIndexJobItemsResponseSchema,
  PhotoMetadataProgressResponseSchema,
  StartPhotoMetadataExtractionRequestSchema,
  GetPhotoMetadataDetailRequestSchema,
  GetPhotoMetadataDetailResponseSchema,
  GetPhotoMetadataFacetsRequestSchema,
  GetPhotoMetadataFacetsResponseSchema,
  SemanticSearchRequestSchema,
  SemanticSearchResponseSchema,
  SemanticSearchCancelRequestSchema,
  SemanticSearchCancelResponseSchema,
  validatePayload,
  type AppInfo,
  type NavigationTab,
  type VaultStatus,
  type SelectRootsResponse,
  type StartScanRequest,
  type JobActionResponse,
  type GetActiveJobResponse,
  type GetLatestJobResponse,
  type DismissJobResponse,
  type ScanJobProgress,
  type GetDuplicateGroupsRequest,
  type GetDuplicateGroupsResponse,
  type GetDuplicateGroupMembersRequest,
  type GetDuplicateGroupMembersResponse,
  type SetDuplicateReviewRequest,
  type SetDuplicateReviewResponse,
  type SelectVaultDirectoryResponse,
  type InitializeVaultRequest,
  type InitializeVaultResponse,
  type GetActiveVaultResponse,
  type SetActiveVaultRequest,
  type SetActiveVaultResponse,
  type GetImportCandidatesRequest,
  type GetImportCandidatesResponse,
  type StartImportRequest,
  type StartImportResponse,
  type VaultImportProgress,
  type GetActiveImportJobResponse,
  type GetLatestImportJobResponse,
  type VaultImportActionResponse,
  type PauseImportRequest,
  type ResumeImportRequest,
  type CancelImportRequest,
  type GetPhotosPageRequest,
  type GetPhotosPageResponse,
  type GetThumbnailRequest,
  type ThumbnailResult,
  type CancelThumbnailRequest,
  type CancelThumbnailResponse,
  type PhotosDiagnosticsResponse,
  type SetPhotoAnnotationRequest,
  type SetPhotoAnnotationResponse,
  type GetPhotoAnnotationRequest,
  type GetPhotoAnnotationResponse,
  type CreateCollectionRequest,
  type CreateCollectionResponse,
  type RenameCollectionRequest,
  type RenameCollectionResponse,
  type ListCollectionsRequest,
  type ListCollectionsResponse,
  type AddCollectionMemberRequest,
  type AddCollectionMemberResponse,
  type RemoveCollectionMemberRequest,
  type RemoveCollectionMemberResponse,
  type GetPhotoMembershipsRequest,
  type GetPhotoMembershipsResponse,
  type ReconcileJournalResponse,
  type SimilarityAnalysisProgress,
  type SimilarityGetPairsRequest,
  type SimilarityGetPairsResponse,
  type SimilaritySetDecisionRequest,
  type SimilaritySetDecisionResponse,
  type SimilarityReconcileResponse,
  type SemanticModelStatusResponse,
  type SemanticIndexProgressResponse,
  type SemanticIndexJobItemsRequest,
  type SemanticIndexJobItemsResponse,
  type PhotoMetadataProgressResponse,
  type StartPhotoMetadataExtractionRequest,
  type GetPhotoMetadataDetailRequest,
  type GetPhotoMetadataDetailResponse,
  type GetPhotoMetadataFacetsRequest,
  type GetPhotoMetadataFacetsResponse,
  type SemanticSearchRequest,
  type SemanticSearchResponse,
  type SemanticSearchCancelRequest,
  type SemanticSearchCancelResponse
} from '../shared/validation/ipc-schemas.js'
import type { VaultApi } from './index.d.js'

const api: VaultApi = {
  async getAppInfo(): Promise<AppInfo> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.APP_GET_INFO)
    const result = validatePayload(AppInfoSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid AppInfo payload from main: ${result.error}`)
    }
    return result.data
  },

  async getVaultStatus(): Promise<VaultStatus> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.VAULT_GET_STATUS)
    const result = validatePayload(VaultStatusSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid VaultStatus payload from main: ${result.error}`)
    }
    return result.data
  },

  async setTab(tab: NavigationTab): Promise<boolean> {
    const parsedTab = validatePayload(NavigationTabSchema, tab)
    if (!parsedTab.success) {
      throw new Error(`Invalid tab name provided: ${parsedTab.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.NAVIGATE_SET_TAB, parsedTab.data)
    const ack = validatePayload(TabAckSchema, raw)
    if (!ack.success) {
      throw new Error(`Invalid setTab acknowledgement from main: ${ack.error}`)
    }
    return ack.data
  },

  async selectRoots(): Promise<SelectRootsResponse> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.SCAN_SELECT_ROOTS)
    const result = validatePayload(SelectRootsResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid selectRoots response from main: ${result.error}`)
    }
    return result.data
  },

  async startScan(request: StartScanRequest): Promise<JobActionResponse> {
    const parsed = validatePayload(StartScanRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid startScan request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.SCAN_START_JOB, parsed.data)
    const result = validatePayload(JobActionResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid startScan response from main: ${result.error}`)
    }
    return result.data
  },

  async pauseScan(jobId: number): Promise<JobActionResponse> {
    const parsed = validatePayload(JobIdRequestSchema, { jobId })
    if (!parsed.success) {
      throw new Error(`Invalid pauseScan request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.SCAN_PAUSE_JOB, parsed.data)
    const result = validatePayload(JobActionResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid pauseScan response from main: ${result.error}`)
    }
    return result.data
  },

  async resumeScan(jobId: number): Promise<JobActionResponse> {
    const parsed = validatePayload(JobIdRequestSchema, { jobId })
    if (!parsed.success) {
      throw new Error(`Invalid resumeScan request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.SCAN_RESUME_JOB, parsed.data)
    const result = validatePayload(JobActionResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid resumeScan response from main: ${result.error}`)
    }
    return result.data
  },

  async cancelScan(jobId: number): Promise<JobActionResponse> {
    const parsed = validatePayload(JobIdRequestSchema, { jobId })
    if (!parsed.success) {
      throw new Error(`Invalid cancelScan request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.SCAN_CANCEL_JOB, parsed.data)
    const result = validatePayload(JobActionResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid cancelScan response from main: ${result.error}`)
    }
    return result.data
  },

  async getActiveScanJob(): Promise<GetActiveJobResponse> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.SCAN_GET_ACTIVE_JOB)
    const result = validatePayload(GetActiveJobResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid getActiveScanJob response from main: ${result.error}`)
    }
    return result.data
  },

  async getLatestScanJob(): Promise<GetLatestJobResponse> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.SCAN_GET_LATEST_JOB)
    const result = validatePayload(GetLatestJobResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid getLatestScanJob response from main: ${result.error}`)
    }
    return result.data
  },

  async dismissScanJob(jobId: number): Promise<DismissJobResponse> {
    const parsed = validatePayload(DismissJobRequestSchema, { jobId })
    if (!parsed.success) {
      throw new Error(`Invalid dismissScanJob request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.SCAN_DISMISS_JOB, parsed.data)
    const result = validatePayload(DismissJobResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid dismissScanJob response from main: ${result.error}`)
    }
    return result.data
  },

  onScanProgress(callback: (progress: ScanJobProgress) => void): () => void {
    const listener = (_event: unknown, raw: unknown): void => {
      const result = validatePayload(ScanJobProgressSchema, raw)
      if (result.success) {
        callback(result.data)
      } else {
        console.error(`Invalid ScanJobProgress event payload from main: ${result.error}`)
      }
    }
    ipcRenderer.on(IPC_CHANNELS.SCAN_PROGRESS_EVENT, listener)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.SCAN_PROGRESS_EVENT, listener)
    }
  },

  async getDuplicateGroups(
    request: GetDuplicateGroupsRequest = { offset: 0, limit: 20 }
  ): Promise<GetDuplicateGroupsResponse> {
    const parsed = validatePayload(GetDuplicateGroupsRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid getDuplicateGroups request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.DUPLICATES_GET_GROUPS, parsed.data)
    const result = validatePayload(GetDuplicateGroupsResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid getDuplicateGroups response from main: ${result.error}`)
    }
    return result.data
  },

  async getDuplicateGroupMembers(
    request: GetDuplicateGroupMembersRequest
  ): Promise<GetDuplicateGroupMembersResponse> {
    const parsed = validatePayload(GetDuplicateGroupMembersRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid getDuplicateGroupMembers request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.DUPLICATES_GET_MEMBERS, parsed.data)
    const result = validatePayload(GetDuplicateGroupMembersResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid getDuplicateGroupMembers response from main: ${result.error}`)
    }
    return result.data
  },

  async setDuplicateReview(
    request: SetDuplicateReviewRequest
  ): Promise<SetDuplicateReviewResponse> {
    const parsed = validatePayload(SetDuplicateReviewRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid setDuplicateReview request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.DUPLICATES_SET_REVIEW, parsed.data)
    const result = validatePayload(SetDuplicateReviewResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid setDuplicateReview response from main: ${result.error}`)
    }
    return result.data
  },

  async selectVaultDirectory(): Promise<SelectVaultDirectoryResponse> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.VAULT_SELECT_DIRECTORY)
    const result = validatePayload(SelectVaultDirectoryResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid selectVaultDirectory response from main: ${result.error}`)
    }
    return result.data
  },

  async initializeVault(request: InitializeVaultRequest): Promise<InitializeVaultResponse> {
    const parsed = validatePayload(InitializeVaultRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid initializeVault request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.VAULT_INITIALIZE, parsed.data)
    const result = validatePayload(InitializeVaultResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid initializeVault response from main: ${result.error}`)
    }
    return result.data
  },

  async getActiveVault(): Promise<GetActiveVaultResponse> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.VAULT_GET_ACTIVE)
    const result = validatePayload(GetActiveVaultResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid getActiveVault response from main: ${result.error}`)
    }
    return result.data
  },

  async setActiveVault(request: SetActiveVaultRequest): Promise<SetActiveVaultResponse> {
    const parsed = validatePayload(SetActiveVaultRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid setActiveVault request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.VAULT_SET_ACTIVE, parsed.data)
    const result = validatePayload(SetActiveVaultResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid setActiveVault response from main: ${result.error}`)
    }
    return result.data
  },

  async getImportCandidates(
    request: GetImportCandidatesRequest
  ): Promise<GetImportCandidatesResponse> {
    const parsed = validatePayload(GetImportCandidatesRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid getImportCandidates request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.VAULT_GET_IMPORT_CANDIDATES, parsed.data)
    const result = validatePayload(GetImportCandidatesResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid getImportCandidates response from main: ${result.error}`)
    }
    return result.data
  },

  async startImport(request: StartImportRequest): Promise<StartImportResponse> {
    const parsed = validatePayload(StartImportRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid startImport request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.VAULT_START_IMPORT, parsed.data)
    const result = validatePayload(StartImportResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid startImport response from main: ${result.error}`)
    }
    return result.data
  },

  async pauseImport(request?: PauseImportRequest): Promise<VaultImportActionResponse> {
    const parsed = validatePayload(PauseImportRequestSchema, request ?? {})
    if (!parsed.success) {
      throw new Error(`Invalid pauseImport request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.VAULT_PAUSE_IMPORT, parsed.data)
    const result = validatePayload(VaultImportActionResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid pauseImport response from main: ${result.error}`)
    }
    return result.data
  },

  async resumeImport(request?: ResumeImportRequest | string): Promise<VaultImportActionResponse> {
    const normalized = typeof request === 'string' ? { jobId: request } : (request ?? {})
    const parsed = validatePayload(ResumeImportRequestSchema, normalized)
    if (!parsed.success) {
      throw new Error(`Invalid resumeImport request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.VAULT_RESUME_IMPORT, parsed.data)
    const result = validatePayload(VaultImportActionResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid resumeImport response from main: ${result.error}`)
    }
    return result.data
  },

  async cancelImport(request?: CancelImportRequest): Promise<VaultImportActionResponse> {
    const parsed = validatePayload(CancelImportRequestSchema, request ?? {})
    if (!parsed.success) {
      throw new Error(`Invalid cancelImport request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.VAULT_CANCEL_IMPORT, parsed.data)
    const result = validatePayload(VaultImportActionResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid cancelImport response from main: ${result.error}`)
    }
    return result.data
  },

  async getActiveImportJob(): Promise<GetActiveImportJobResponse> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.VAULT_GET_ACTIVE_IMPORT)
    const result = validatePayload(GetActiveImportJobResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid getActiveImportJob response from main: ${result.error}`)
    }
    return result.data
  },

  async getLatestImportJob(): Promise<GetLatestImportJobResponse> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.VAULT_GET_LATEST_IMPORT)
    const result = validatePayload(GetLatestImportJobResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid getLatestImportJob response from main: ${result.error}`)
    }
    return result.data
  },

  onImportProgress(callback: (progress: VaultImportProgress) => void): () => void {
    const listener = (_event: unknown, raw: unknown): void => {
      const result = validatePayload(VaultImportProgressSchema, raw)
      if (result.success) {
        callback(result.data)
      } else {
        console.error(`Invalid VaultImportProgress event payload from main: ${result.error}`)
      }
    }
    ipcRenderer.on(IPC_CHANNELS.VAULT_PROGRESS_EVENT, listener)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.VAULT_PROGRESS_EVENT, listener)
    }
  },

  async getPhotosPage(request: GetPhotosPageRequest): Promise<GetPhotosPageResponse> {
    const parsed = validatePayload(GetPhotosPageRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid getPhotosPage request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.PHOTOS_GET_PAGE, parsed.data)
    const result = validatePayload(GetPhotosPageResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid getPhotosPage response from main: ${result.error}`)
    }
    return result.data
  },

  async getThumbnail(request: GetThumbnailRequest): Promise<ThumbnailResult> {
    const parsed = validatePayload(GetThumbnailRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid getThumbnail request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.PHOTOS_GET_THUMBNAIL, parsed.data)
    const result = validatePayload(ThumbnailResultSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid getThumbnail response from main: ${result.error}`)
    }
    return result.data
  },

  async cancelThumbnail(request: CancelThumbnailRequest): Promise<CancelThumbnailResponse> {
    const parsed = validatePayload(CancelThumbnailRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid cancelThumbnail request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.PHOTOS_CANCEL_THUMBNAIL, parsed.data)
    const result = validatePayload(CancelThumbnailResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid cancelThumbnail response from main: ${result.error}`)
    }
    return result.data
  },

  async getPhotosDiagnostics(): Promise<PhotosDiagnosticsResponse> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.PHOTOS_GET_DIAGNOSTICS)
    const result = validatePayload(PhotosDiagnosticsResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid getPhotosDiagnostics response from main: ${result.error}`)
    }
    return result.data
  },

  async setPhotoAnnotation(
    request: SetPhotoAnnotationRequest
  ): Promise<SetPhotoAnnotationResponse> {
    const parsed = validatePayload(SetPhotoAnnotationRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid setPhotoAnnotation request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.PHOTOS_SET_ANNOTATION, parsed.data)
    const result = validatePayload(SetPhotoAnnotationResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid setPhotoAnnotation response from main: ${result.error}`)
    }
    return result.data
  },

  async getPhotoAnnotation(
    request: GetPhotoAnnotationRequest
  ): Promise<GetPhotoAnnotationResponse> {
    const parsed = validatePayload(GetPhotoAnnotationRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid getPhotoAnnotation request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.PHOTOS_GET_ANNOTATION, parsed.data)
    const result = validatePayload(GetPhotoAnnotationResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid getPhotoAnnotation response from main: ${result.error}`)
    }
    return result.data
  },

  async listCollections(request: ListCollectionsRequest = {}): Promise<ListCollectionsResponse> {
    const parsed = validatePayload(ListCollectionsRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid listCollections request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.COLLECTIONS_LIST, parsed.data)
    const result = validatePayload(ListCollectionsResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid listCollections response from main: ${result.error}`)
    }
    return result.data
  },

  async createCollection(request: CreateCollectionRequest): Promise<CreateCollectionResponse> {
    const parsed = validatePayload(CreateCollectionRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid createCollection request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.COLLECTIONS_CREATE, parsed.data)
    const result = validatePayload(CreateCollectionResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid createCollection response from main: ${result.error}`)
    }
    return result.data
  },

  async renameCollection(request: RenameCollectionRequest): Promise<RenameCollectionResponse> {
    const parsed = validatePayload(RenameCollectionRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid renameCollection request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.COLLECTIONS_RENAME, parsed.data)
    const result = validatePayload(RenameCollectionResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid renameCollection response from main: ${result.error}`)
    }
    return result.data
  },

  async addCollectionMember(
    request: AddCollectionMemberRequest
  ): Promise<AddCollectionMemberResponse> {
    const parsed = validatePayload(AddCollectionMemberRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid addCollectionMember request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.COLLECTIONS_ADD_MEMBER, parsed.data)
    const result = validatePayload(AddCollectionMemberResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid addCollectionMember response from main: ${result.error}`)
    }
    return result.data
  },

  async removeCollectionMember(
    request: RemoveCollectionMemberRequest
  ): Promise<RemoveCollectionMemberResponse> {
    const parsed = validatePayload(RemoveCollectionMemberRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid removeCollectionMember request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.COLLECTIONS_REMOVE_MEMBER, parsed.data)
    const result = validatePayload(RemoveCollectionMemberResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid removeCollectionMember response from main: ${result.error}`)
    }
    return result.data
  },

  async getPhotoMemberships(
    request: GetPhotoMembershipsRequest
  ): Promise<GetPhotoMembershipsResponse> {
    const parsed = validatePayload(GetPhotoMembershipsRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid getPhotoMemberships request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(
      IPC_CHANNELS.COLLECTIONS_GET_MEMBERSHIPS_FOR_PHOTO,
      parsed.data
    )
    const result = validatePayload(GetPhotoMembershipsResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid getPhotoMemberships response from main: ${result.error}`)
    }
    return result.data
  },

  async reconcileJournal(): Promise<ReconcileJournalResponse> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.PHOTOS_RECONCILE_JOURNAL)
    const result = validatePayload(ReconcileJournalResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid reconcileJournal response from main: ${result.error}`)
    }
    return result.data
  },

  async startSimilarityAnalysis(): Promise<SimilarityAnalysisProgress> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.SIMILARITY_START_ANALYSIS)
    const result = validatePayload(SimilarityAnalysisProgressSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid startSimilarityAnalysis response from main: ${result.error}`)
    }
    return result.data
  },

  async cancelSimilarityAnalysis(): Promise<SimilarityAnalysisProgress> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.SIMILARITY_CANCEL_ANALYSIS)
    const result = validatePayload(SimilarityAnalysisProgressSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid cancelSimilarityAnalysis response from main: ${result.error}`)
    }
    return result.data
  },

  async resumeSimilarityAnalysis(): Promise<SimilarityAnalysisProgress> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.SIMILARITY_RESUME_ANALYSIS)
    const result = validatePayload(SimilarityAnalysisProgressSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid resumeSimilarityAnalysis response from main: ${result.error}`)
    }
    return result.data
  },

  async getSimilarityProgress(): Promise<SimilarityAnalysisProgress> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.SIMILARITY_GET_PROGRESS)
    const result = validatePayload(SimilarityAnalysisProgressSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid getSimilarityProgress response from main: ${result.error}`)
    }
    return result.data
  },

  async getSimilarityPairs(
    request: SimilarityGetPairsRequest
  ): Promise<SimilarityGetPairsResponse> {
    const parsed = validatePayload(SimilarityGetPairsRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid getSimilarityPairs request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.SIMILARITY_GET_PAIRS, parsed.data)
    const result = validatePayload(SimilarityGetPairsResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid getSimilarityPairs response from main: ${result.error}`)
    }
    return result.data
  },

  async setSimilarityDecision(
    request: SimilaritySetDecisionRequest
  ): Promise<SimilaritySetDecisionResponse> {
    const parsed = validatePayload(SimilaritySetDecisionRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid setSimilarityDecision request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.SIMILARITY_SET_DECISION, parsed.data)
    const result = validatePayload(SimilaritySetDecisionResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid setSimilarityDecision response from main: ${result.error}`)
    }
    return result.data
  },

  async reconcileSimilarity(): Promise<SimilarityReconcileResponse> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.SIMILARITY_RECONCILE)
    const result = validatePayload(SimilarityReconcileResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid reconcileSimilarity response from main: ${result.error}`)
    }
    return result.data
  },

  async getSemanticModelStatus(): Promise<SemanticModelStatusResponse> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.SEMANTIC_MODEL_GET_STATUS)
    const result = validatePayload(SemanticModelStatusResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid getSemanticModelStatus response from main: ${result.error}`)
    }
    return result.data
  },

  async downloadSemanticModel(): Promise<SemanticModelStatusResponse> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.SEMANTIC_MODEL_DOWNLOAD)
    const result = validatePayload(SemanticModelStatusResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid downloadSemanticModel response from main: ${result.error}`)
    }
    return result.data
  },

  async importSemanticModelFromFolder(): Promise<SemanticModelStatusResponse> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.SEMANTIC_MODEL_IMPORT)
    const result = validatePayload(SemanticModelStatusResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid importSemanticModelFromFolder response from main: ${result.error}`)
    }
    return result.data
  },

  async cancelSemanticModelProvisioning(): Promise<SemanticModelStatusResponse> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.SEMANTIC_MODEL_CANCEL)
    const result = validatePayload(SemanticModelStatusResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid cancelSemanticModelProvisioning response from main: ${result.error}`)
    }
    return result.data
  },

  onSemanticModelStatus(callback: (status: SemanticModelStatusResponse) => void): () => void {
    const listener = (_event: unknown, raw: unknown): void => {
      const result = validatePayload(SemanticModelStatusResponseSchema, raw)
      if (result.success) {
        callback(result.data)
      } else {
        console.error(`Invalid SemanticModelStatus event payload from main: ${result.error}`)
      }
    }
    ipcRenderer.on(IPC_CHANNELS.SEMANTIC_MODEL_STATUS_EVENT, listener)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.SEMANTIC_MODEL_STATUS_EVENT, listener)
    }
  },

  async getSemanticIndexProgress(): Promise<SemanticIndexProgressResponse> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.SEMANTIC_INDEX_GET_PROGRESS)
    const result = validatePayload(SemanticIndexProgressResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid getSemanticIndexProgress response from main: ${result.error}`)
    }
    return result.data
  },

  async startSemanticIndexing(): Promise<SemanticIndexProgressResponse> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.SEMANTIC_INDEX_START)
    const result = validatePayload(SemanticIndexProgressResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid startSemanticIndexing response from main: ${result.error}`)
    }
    return result.data
  },

  async pauseSemanticIndexing(): Promise<SemanticIndexProgressResponse> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.SEMANTIC_INDEX_PAUSE)
    const result = validatePayload(SemanticIndexProgressResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid pauseSemanticIndexing response from main: ${result.error}`)
    }
    return result.data
  },

  async resumeSemanticIndexing(): Promise<SemanticIndexProgressResponse> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.SEMANTIC_INDEX_RESUME)
    const result = validatePayload(SemanticIndexProgressResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid resumeSemanticIndexing response from main: ${result.error}`)
    }
    return result.data
  },

  async cancelSemanticIndexing(): Promise<SemanticIndexProgressResponse> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.SEMANTIC_INDEX_CANCEL)
    const result = validatePayload(SemanticIndexProgressResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid cancelSemanticIndexing response from main: ${result.error}`)
    }
    return result.data
  },

  async getSemanticIndexJobItems(
    request: SemanticIndexJobItemsRequest = { page: 1, pageSize: 25 }
  ): Promise<SemanticIndexJobItemsResponse> {
    const parsed = validatePayload(SemanticIndexJobItemsRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid getSemanticIndexJobItems request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.SEMANTIC_INDEX_GET_ITEMS, parsed.data)
    const result = validatePayload(SemanticIndexJobItemsResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid getSemanticIndexJobItems response from main: ${result.error}`)
    }
    return result.data
  },

  onSemanticIndexProgress(callback: (progress: SemanticIndexProgressResponse) => void): () => void {
    const listener = (_event: unknown, raw: unknown): void => {
      const result = validatePayload(SemanticIndexProgressResponseSchema, raw)
      if (result.success) {
        callback(result.data)
      } else {
        console.error(`Invalid SemanticIndexProgress event payload from main: ${result.error}`)
      }
    }
    ipcRenderer.on(IPC_CHANNELS.SEMANTIC_INDEX_PROGRESS_EVENT, listener)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.SEMANTIC_INDEX_PROGRESS_EVENT, listener)
    }
  },

  async getPhotoMetadataProgress(): Promise<PhotoMetadataProgressResponse> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.METADATA_GET_PROGRESS)
    const result = validatePayload(PhotoMetadataProgressResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid getPhotoMetadataProgress response from main: ${result.error}`)
    }
    return result.data
  },

  async startPhotoMetadataExtraction(
    request: StartPhotoMetadataExtractionRequest = {}
  ): Promise<PhotoMetadataProgressResponse> {
    const parsed = validatePayload(StartPhotoMetadataExtractionRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid startPhotoMetadataExtraction request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.METADATA_START_EXTRACTION, parsed.data)
    const result = validatePayload(PhotoMetadataProgressResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid startPhotoMetadataExtraction response from main: ${result.error}`)
    }
    return result.data
  },

  async pausePhotoMetadataExtraction(): Promise<PhotoMetadataProgressResponse> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.METADATA_PAUSE_EXTRACTION)
    const result = validatePayload(PhotoMetadataProgressResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid pausePhotoMetadataExtraction response from main: ${result.error}`)
    }
    return result.data
  },

  async resumePhotoMetadataExtraction(): Promise<PhotoMetadataProgressResponse> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.METADATA_RESUME_EXTRACTION)
    const result = validatePayload(PhotoMetadataProgressResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid resumePhotoMetadataExtraction response from main: ${result.error}`)
    }
    return result.data
  },

  async cancelPhotoMetadataExtraction(): Promise<PhotoMetadataProgressResponse> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.METADATA_CANCEL_EXTRACTION)
    const result = validatePayload(PhotoMetadataProgressResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid cancelPhotoMetadataExtraction response from main: ${result.error}`)
    }
    return result.data
  },

  onPhotoMetadataProgress(callback: (progress: PhotoMetadataProgressResponse) => void): () => void {
    const listener = (_event: unknown, raw: unknown): void => {
      const result = validatePayload(PhotoMetadataProgressResponseSchema, raw)
      if (result.success) {
        callback(result.data)
      } else {
        console.error(`Invalid PhotoMetadataProgress event payload from main: ${result.error}`)
      }
    }
    ipcRenderer.on(IPC_CHANNELS.METADATA_PROGRESS_EVENT, listener)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.METADATA_PROGRESS_EVENT, listener)
    }
  },

  async getPhotoMetadataDetail(
    request: GetPhotoMetadataDetailRequest
  ): Promise<GetPhotoMetadataDetailResponse> {
    const parsed = validatePayload(GetPhotoMetadataDetailRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid getPhotoMetadataDetail request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.METADATA_GET_PHOTO_DETAIL, parsed.data)
    const result = validatePayload(GetPhotoMetadataDetailResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid getPhotoMetadataDetail response from main: ${result.error}`)
    }
    return result.data
  },

  async getPhotoMetadataFacets(
    request: GetPhotoMetadataFacetsRequest
  ): Promise<GetPhotoMetadataFacetsResponse> {
    const parsed = validatePayload(GetPhotoMetadataFacetsRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid getPhotoMetadataFacets request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.METADATA_GET_FACETS, parsed.data)
    const result = validatePayload(GetPhotoMetadataFacetsResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid getPhotoMetadataFacets response from main: ${result.error}`)
    }
    return result.data
  },

  async searchPhotosSemantic(request: SemanticSearchRequest): Promise<SemanticSearchResponse> {
    const parsed = validatePayload(SemanticSearchRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid searchPhotosSemantic request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.SEMANTIC_SEARCH_PHOTOS, parsed.data)
    const result = validatePayload(SemanticSearchResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid searchPhotosSemantic response from main: ${result.error}`)
    }
    return result.data
  },

  async cancelPhotosSemanticSearch(
    request?: SemanticSearchCancelRequest
  ): Promise<SemanticSearchCancelResponse> {
    const parsed = validatePayload(SemanticSearchCancelRequestSchema, request ?? {})
    if (!parsed.success) {
      throw new Error(`Invalid cancelPhotosSemanticSearch request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.SEMANTIC_SEARCH_CANCEL, parsed.data)
    const result = validatePayload(SemanticSearchCancelResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid cancelPhotosSemanticSearch response from main: ${result.error}`)
    }
    return result.data
  }
}

// A failure here is deliberately not swallowed: Electron reports it as a preload error.
contextBridge.exposeInMainWorld('api', api)
