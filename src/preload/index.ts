import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/contracts/channels.js'
import {
  UpdateActionResponseSchema,
  UpdateStateSchema,
  type UpdateActionResponseDto,
  type UpdateStateDto
} from '../shared/validation/update-ipc-schemas.js'
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
  BackupVerifyRecoveryPointResponseSchema,
  type BackupConfigureDestinationRequest,
  type BackupDestinationRecordDto,
  type BackupGoogleDriveAuthStatusDto,
  type BackupGoogleDriveCreateFolderRequest,
  type BackupGoogleDriveFolderDto,
  type BackupGoogleDriveListFoldersRequest,
  type BackupGoogleDriveListFoldersResponse,
  type BackupJobActionResponse,
  type BackupJobRecordDto,
  type BackupListDestinationsRequest,
  type BackupListDestinationsResponse,
  type BackupListJobsRequest,
  type BackupListJobsResponse,
  type BackupListRecoveryPointsRequest,
  type BackupListRecoveryPointsResponse,
  type BackupProgressEvent,
  type BackupRecoverCatalogRequest,
  type BackupRecoverCatalogResponse,
  type BackupRestoreRequest,
  type BackupRestoreResponse,
  type BackupSelectDirectoryRequest,
  type BackupSelectDirectoryResponse,
  type BackupStartRequest,
  type BackupSummaryDto,
  type BackupVerifyRecoveryPointRequest,
  type BackupVerifyRecoveryPointResponse
} from '../shared/validation/backup-ipc-schemas.js'
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
  ExportVerifyJobRequestSchema,
  type ExportCancelResponse,
  type ExportGetJobItemsRequest,
  type ExportJobItemsResponse,
  type ExportJobListResponse,
  type ExportJobRecordDto,
  type ExportListJobsRequest,
  type ExportProgressEvent,
  type ExportSelectDestinationResponse,
  type ExportStartRequest
} from '../shared/validation/export-schemas.js'
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
  GetOriginalPhotoRequestSchema,
  OriginalPhotoResultSchema,
  PrepareVideoPlaybackRequestSchema,
  VideoPlaybackResultSchema,
  RevokeVideoTokenRequestSchema,
  OpenInDefaultPlayerRequestSchema,
  OpenInDefaultPlayerResponseSchema,
  MediaLibraryUpdatedEventSchema,
  CancelThumbnailRequestSchema,
  CancelThumbnailResponseSchema,
  PhotosDiagnosticsResponseSchema,
  ThumbnailPrepProgressSchema,
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
  GetPhotoMetadataAttentionItemsRequestSchema,
  GetPhotoMetadataAttentionItemsResponseSchema,
  SemanticSearchRequestSchema,
  SemanticSearchResponseSchema,
  SemanticSearchCancelRequestSchema,
  SemanticSearchCancelResponseSchema,
  MetadataAwarePhotoSearchRequestSchema,
  MetadataAwarePhotoSearchResponseSchema,
  SavedEventsListResponseSchema,
  UpsertSavedEventRequestSchema,
  SavedEventSchema,
  DeleteSavedRecordRequestSchema,
  SavedPlacesListResponseSchema,
  UpsertSavedPlaceRequestSchema,
  SavedPlaceSchema,
  SetPhotoUserPlaceRequestSchema,
  ClearPhotoUserPlaceRequestSchema,
  PhotoUserPlaceSchema,
  CameraLabelsListResponseSchema,
  UpsertCameraLabelRequestSchema,
  CameraLabelSchema,
  GetDocumentsPageRequestSchema,
  GetDocumentsPageResponseSchema,
  GetDocumentDetailRequestSchema,
  GetDocumentDetailResponseSchema,
  GetDocumentExtensionFacetsRequestSchema,
  GetDocumentExtensionFacetsResponseSchema,
  GetDocumentPreviewRequestSchema,
  GetDocumentPreviewResponseSchema,
  ExtractSelectedDocumentsRequestSchema,
  StartDocumentExtractionRequestSchema,
  DocumentExtractionProgressSchema,
  OcrModelStatusSchema,
  GetDocumentOcrStateRequestSchema,
  GetDocumentOcrStateResponseSchema,
  GetDocumentOcrPreviewRequestSchema,
  GetDocumentOcrPreviewResponseSchema,
  OcrSelectedDocumentsRequestSchema,
  StartDocumentOcrRequestSchema,
  DocumentOcrProgressSchema,
  DocSemanticModelStatusSchema,
  DocSemanticProgressSchema,
  IndexSelectedDocumentsRequestSchema,
  StartDocSemanticIndexRequestSchema,
  DocSemanticSearchRequestSchema,
  DocSemanticSearchResponseSchema,
  DocSemanticSearchCancelRequestSchema,
  DocSemanticSearchCancelResponseSchema,
  UnifiedSearchPhotosRequestSchema,
  UnifiedSearchPhotosResponseSchema,
  UnifiedSearchDocumentsRequestSchema,
  UnifiedSearchDocumentsResponseSchema,
  UnifiedSearchCancelRequestSchema,
  UnifiedSearchCancelResponseSchema,
  ClassifySelectedDocumentsRequestSchema,
  StartDocumentClassificationRequestSchema,
  DocumentClassificationProgressSchema,
  SetDocumentClassificationOverrideRequestSchema,
  ResetDocumentClassificationOverrideRequestSchema,
  DocumentClassificationOverrideAckSchema,
  GetDocumentClassificationFacetsRequestSchema,
  GetDocumentClassificationFacetsResponseSchema,
  validatePayload,
  type DocSemanticSearchCancelResponseDto,
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
  type GetOriginalPhotoRequest,
  type OriginalPhotoResult,
  type PrepareVideoPlaybackRequest,
  type VideoPlaybackResult,
  type RevokeVideoTokenRequest,
  type OpenInDefaultPlayerRequest,
  type OpenInDefaultPlayerResponse,
  type MediaLibraryUpdatedEvent,
  type CancelThumbnailRequest,
  type CancelThumbnailResponse,
  type PhotosDiagnosticsResponse,
  type ThumbnailPrepProgress,
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
  type GetPhotoMetadataAttentionItemsRequest,
  type GetPhotoMetadataAttentionItemsResponse,
  type SemanticSearchRequest,
  type SemanticSearchResponse,
  type SemanticSearchCancelRequest,
  type SemanticSearchCancelResponse,
  type MetadataAwarePhotoSearchRequest,
  type MetadataAwarePhotoSearchResponse,
  type SavedEventsListResponse,
  type UpsertSavedEventRequest,
  type SavedEvent,
  type SavedPlacesListResponse,
  type UpsertSavedPlaceRequest,
  type SavedPlace,
  type SetPhotoUserPlaceRequest,
  type ClearPhotoUserPlaceRequest,
  type PhotoUserPlace,
  type CameraLabelsListResponse,
  type UpsertCameraLabelRequest,
  type CameraLabel,
  type GetDocumentsPageRequest,
  type GetDocumentsPageResponse,
  type GetDocumentDetailRequest,
  type GetDocumentDetailResponse,
  type GetDocumentExtensionFacetsRequest,
  type GetDocumentExtensionFacetsResponse,
  type GetDocumentPreviewRequest,
  type GetDocumentPreviewResponse,
  type ExtractSelectedDocumentsRequest,
  type StartDocumentExtractionRequest,
  type DocumentExtractionProgressDto,
  type OcrModelStatusDto,
  type GetDocumentOcrStateRequest,
  type GetDocumentOcrStateResponse,
  type GetDocumentOcrPreviewRequest,
  type GetDocumentOcrPreviewResponse,
  type OcrSelectedDocumentsRequest,
  type StartDocumentOcrRequest,
  type DocumentOcrProgressDto,
  type DocSemanticModelStatusDto,
  type DocumentSemanticProgressDto,
  type IndexSelectedDocumentsRequest,
  type StartDocSemanticIndexRequest,
  type DocSemanticSearchRequest,
  type DocSemanticSearchResponseDto,
  type DocSemanticSearchCancelRequest,
  type UnifiedSearchPhotosRequest,
  type UnifiedSearchPhotosResponse,
  type UnifiedSearchDocumentsRequest,
  type UnifiedSearchDocumentsResponse,
  type UnifiedSearchCancelRequest,
  type UnifiedSearchCancelResponse,
  type ClassifySelectedDocumentsRequest,
  type StartDocumentClassificationRequest,
  type DocumentClassificationProgressDto,
  type SetDocumentClassificationOverrideRequest,
  type ResetDocumentClassificationOverrideRequest,
  type DocumentClassificationOverrideAckDto,
  type GetDocumentClassificationFacetsRequest,
  type GetDocumentClassificationFacetsResponseDto
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

  async getOriginalPhoto(request: GetOriginalPhotoRequest): Promise<OriginalPhotoResult> {
    const parsed = validatePayload(GetOriginalPhotoRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid getOriginalPhoto request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.PHOTOS_GET_ORIGINAL, parsed.data)
    const result = validatePayload(OriginalPhotoResultSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid getOriginalPhoto response from main: ${result.error}`)
    }
    return result.data
  },

  async prepareVideoPlayback(request: PrepareVideoPlaybackRequest): Promise<VideoPlaybackResult> {
    const parsed = validatePayload(PrepareVideoPlaybackRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid prepareVideoPlayback request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.MEDIA_PREPARE_VIDEO, parsed.data)
    const result = validatePayload(VideoPlaybackResultSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid prepareVideoPlayback response from main: ${result.error}`)
    }
    return result.data
  },

  async revokeVideoPlaybackToken(request: RevokeVideoTokenRequest): Promise<boolean> {
    const parsed = validatePayload(RevokeVideoTokenRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid revokeVideoPlaybackToken request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.MEDIA_REVOKE_VIDEO_TOKEN, parsed.data)
    return Boolean(raw)
  },

  async openMediaInDefaultPlayer(
    request: OpenInDefaultPlayerRequest
  ): Promise<OpenInDefaultPlayerResponse> {
    const parsed = validatePayload(OpenInDefaultPlayerRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid openMediaInDefaultPlayer request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.MEDIA_OPEN_IN_DEFAULT_PLAYER, parsed.data)
    const result = validatePayload(OpenInDefaultPlayerResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid openMediaInDefaultPlayer response from main: ${result.error}`)
    }
    return result.data
  },

  onMediaLibraryUpdated(callback: (event: MediaLibraryUpdatedEvent) => void): () => void {
    const listener = (_event: unknown, raw: unknown): void => {
      const result = validatePayload(MediaLibraryUpdatedEventSchema, raw)
      if (result.success) {
        callback(result.data)
      }
    }
    ipcRenderer.on(IPC_CHANNELS.MEDIA_LIBRARY_UPDATED_EVENT, listener)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.MEDIA_LIBRARY_UPDATED_EVENT, listener)
    }
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

  async getThumbnailPrepProgress(): Promise<ThumbnailPrepProgress> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.THUMBNAILS_PREP_GET_PROGRESS)
    const result = validatePayload(ThumbnailPrepProgressSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid getThumbnailPrepProgress response from main: ${result.error}`)
    }
    return result.data
  },

  onThumbnailPrepProgress(callback: (progress: ThumbnailPrepProgress) => void): () => void {
    const listener = (_event: unknown, raw: unknown): void => {
      const result = validatePayload(ThumbnailPrepProgressSchema, raw)
      if (result.success) {
        callback(result.data)
      } else {
        console.error(`Invalid ThumbnailPrepProgress event payload from main: ${result.error}`)
      }
    }
    ipcRenderer.on(IPC_CHANNELS.THUMBNAILS_PREP_PROGRESS_EVENT, listener)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.THUMBNAILS_PREP_PROGRESS_EVENT, listener)
    }
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

  async getPhotoMetadataAttentionItems(
    request: GetPhotoMetadataAttentionItemsRequest = {}
  ): Promise<GetPhotoMetadataAttentionItemsResponse> {
    const parsed = validatePayload(GetPhotoMetadataAttentionItemsRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid getPhotoMetadataAttentionItems request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.METADATA_GET_ATTENTION_ITEMS, parsed.data)
    const result = validatePayload(GetPhotoMetadataAttentionItemsResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid getPhotoMetadataAttentionItems response from main: ${result.error}`)
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
  },

  async searchPhotosMetadataAware(
    request: MetadataAwarePhotoSearchRequest
  ): Promise<MetadataAwarePhotoSearchResponse> {
    const parsed = validatePayload(MetadataAwarePhotoSearchRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid searchPhotosMetadataAware request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.PHOTOS_SEARCH_METADATA_AWARE, parsed.data)
    const result = validatePayload(MetadataAwarePhotoSearchResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid searchPhotosMetadataAware response from main: ${result.error}`)
    }
    return result.data
  },

  async listSavedEvents(): Promise<SavedEventsListResponse> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.SAVED_EVENTS_LIST)
    const result = validatePayload(SavedEventsListResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid listSavedEvents response from main: ${result.error}`)
    }
    return result.data
  },

  async upsertSavedEvent(request: UpsertSavedEventRequest): Promise<SavedEvent> {
    const parsed = validatePayload(UpsertSavedEventRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid upsertSavedEvent request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.SAVED_EVENTS_UPSERT, parsed.data)
    const result = validatePayload(SavedEventSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid upsertSavedEvent response from main: ${result.error}`)
    }
    return result.data
  },

  async deleteSavedEvent(id: number): Promise<boolean> {
    const parsed = validatePayload(DeleteSavedRecordRequestSchema, { id })
    if (!parsed.success) {
      throw new Error(`Invalid deleteSavedEvent request: ${parsed.error}`)
    }
    return Boolean(await ipcRenderer.invoke(IPC_CHANNELS.SAVED_EVENTS_DELETE, parsed.data))
  },

  async listSavedPlaces(): Promise<SavedPlacesListResponse> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.SAVED_PLACES_LIST)
    const result = validatePayload(SavedPlacesListResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid listSavedPlaces response from main: ${result.error}`)
    }
    return result.data
  },

  async upsertSavedPlace(request: UpsertSavedPlaceRequest): Promise<SavedPlace> {
    const parsed = validatePayload(UpsertSavedPlaceRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid upsertSavedPlace request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.SAVED_PLACES_UPSERT, parsed.data)
    const result = validatePayload(SavedPlaceSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid upsertSavedPlace response from main: ${result.error}`)
    }
    return result.data
  },

  async deleteSavedPlace(id: number): Promise<boolean> {
    const parsed = validatePayload(DeleteSavedRecordRequestSchema, { id })
    if (!parsed.success) {
      throw new Error(`Invalid deleteSavedPlace request: ${parsed.error}`)
    }
    return Boolean(await ipcRenderer.invoke(IPC_CHANNELS.SAVED_PLACES_DELETE, parsed.data))
  },

  async setPhotoUserPlace(request: SetPhotoUserPlaceRequest): Promise<PhotoUserPlace> {
    const parsed = validatePayload(SetPhotoUserPlaceRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid setPhotoUserPlace request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.PHOTO_USER_PLACE_SET, parsed.data)
    const result = validatePayload(PhotoUserPlaceSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid setPhotoUserPlace response from main: ${result.error}`)
    }
    return result.data
  },

  async clearPhotoUserPlace(request: ClearPhotoUserPlaceRequest): Promise<boolean> {
    const parsed = validatePayload(ClearPhotoUserPlaceRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid clearPhotoUserPlace request: ${parsed.error}`)
    }
    return Boolean(await ipcRenderer.invoke(IPC_CHANNELS.PHOTO_USER_PLACE_CLEAR, parsed.data))
  },

  async listCameraLabels(): Promise<CameraLabelsListResponse> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.CAMERA_LABELS_LIST)
    const result = validatePayload(CameraLabelsListResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid listCameraLabels response from main: ${result.error}`)
    }
    return result.data
  },

  async upsertCameraLabel(request: UpsertCameraLabelRequest): Promise<CameraLabel> {
    const parsed = validatePayload(UpsertCameraLabelRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid upsertCameraLabel request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.CAMERA_LABELS_UPSERT, parsed.data)
    const result = validatePayload(CameraLabelSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid upsertCameraLabel response from main: ${result.error}`)
    }
    return result.data
  },

  async deleteCameraLabel(id: number): Promise<boolean> {
    const parsed = validatePayload(DeleteSavedRecordRequestSchema, { id })
    if (!parsed.success) {
      throw new Error(`Invalid deleteCameraLabel request: ${parsed.error}`)
    }
    return Boolean(await ipcRenderer.invoke(IPC_CHANNELS.CAMERA_LABELS_DELETE, parsed.data))
  },

  async getDocumentsPage(request: GetDocumentsPageRequest): Promise<GetDocumentsPageResponse> {
    const parsed = validatePayload(GetDocumentsPageRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid getDocumentsPage request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.DOCUMENTS_GET_PAGE, parsed.data)
    const result = validatePayload(GetDocumentsPageResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid getDocumentsPage response from main: ${result.error}`)
    }
    return result.data
  },

  async getDocumentDetail(request: GetDocumentDetailRequest): Promise<GetDocumentDetailResponse> {
    const parsed = validatePayload(GetDocumentDetailRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid getDocumentDetail request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.DOCUMENTS_GET_DETAIL, parsed.data)
    const result = validatePayload(GetDocumentDetailResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid getDocumentDetail response from main: ${result.error}`)
    }
    return result.data
  },

  async getDocumentExtensionFacets(
    request?: GetDocumentExtensionFacetsRequest
  ): Promise<GetDocumentExtensionFacetsResponse> {
    const parsed = validatePayload(GetDocumentExtensionFacetsRequestSchema, request ?? {})
    if (!parsed.success) {
      throw new Error(`Invalid getDocumentExtensionFacets request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.DOCUMENTS_GET_EXTENSION_FACETS, parsed.data)
    const result = validatePayload(GetDocumentExtensionFacetsResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid getDocumentExtensionFacets response from main: ${result.error}`)
    }
    return result.data
  },

  async getDocumentPreview(
    request: GetDocumentPreviewRequest
  ): Promise<GetDocumentPreviewResponse> {
    const parsed = validatePayload(GetDocumentPreviewRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid getDocumentPreview request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.DOCUMENTS_GET_PREVIEW, parsed.data)
    const result = validatePayload(GetDocumentPreviewResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid getDocumentPreview response from main: ${result.error}`)
    }
    return result.data
  },

  async extractSelectedDocuments(
    request: ExtractSelectedDocumentsRequest
  ): Promise<DocumentExtractionProgressDto> {
    const parsed = validatePayload(ExtractSelectedDocumentsRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid extractSelectedDocuments request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.DOCUMENTS_EXTRACT_SELECTED, parsed.data)
    const result = validatePayload(DocumentExtractionProgressSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid extractSelectedDocuments response from main: ${result.error}`)
    }
    return result.data
  },

  async startDocumentExtraction(
    request?: StartDocumentExtractionRequest
  ): Promise<DocumentExtractionProgressDto> {
    const parsed = validatePayload(StartDocumentExtractionRequestSchema, request ?? {})
    if (!parsed.success) {
      throw new Error(`Invalid startDocumentExtraction request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.DOCUMENTS_START_EXTRACTION, parsed.data)
    const result = validatePayload(DocumentExtractionProgressSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid startDocumentExtraction response from main: ${result.error}`)
    }
    return result.data
  },

  async pauseDocumentExtraction(): Promise<DocumentExtractionProgressDto> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.DOCUMENTS_PAUSE_EXTRACTION)
    const result = validatePayload(DocumentExtractionProgressSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid pauseDocumentExtraction response from main: ${result.error}`)
    }
    return result.data
  },

  async resumeDocumentExtraction(): Promise<DocumentExtractionProgressDto> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.DOCUMENTS_RESUME_EXTRACTION)
    const result = validatePayload(DocumentExtractionProgressSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid resumeDocumentExtraction response from main: ${result.error}`)
    }
    return result.data
  },

  async cancelDocumentExtraction(): Promise<DocumentExtractionProgressDto> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.DOCUMENTS_CANCEL_EXTRACTION)
    const result = validatePayload(DocumentExtractionProgressSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid cancelDocumentExtraction response from main: ${result.error}`)
    }
    return result.data
  },

  async getDocumentExtractionProgress(): Promise<DocumentExtractionProgressDto> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.DOCUMENTS_GET_EXTRACTION_PROGRESS)
    const result = validatePayload(DocumentExtractionProgressSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid getDocumentExtractionProgress response from main: ${result.error}`)
    }
    return result.data
  },

  onDocumentExtractionProgress(
    callback: (progress: DocumentExtractionProgressDto) => void
  ): () => void {
    const handler = (_event: Electron.IpcRendererEvent, rawPayload: unknown) => {
      const result = validatePayload(DocumentExtractionProgressSchema, rawPayload)
      if (result.success) {
        callback(result.data)
      }
    }
    ipcRenderer.on(IPC_CHANNELS.DOCUMENTS_EXTRACTION_PROGRESS_EVENT, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.DOCUMENTS_EXTRACTION_PROGRESS_EVENT, handler)
    }
  },

  async getOcrModelStatus(): Promise<OcrModelStatusDto> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.OCR_MODEL_GET_STATUS)
    const result = validatePayload(OcrModelStatusSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid getOcrModelStatus response from main: ${result.error}`)
    }
    return result.data
  },

  async downloadOcrModel(): Promise<OcrModelStatusDto> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.OCR_MODEL_DOWNLOAD)
    const result = validatePayload(OcrModelStatusSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid downloadOcrModel response from main: ${result.error}`)
    }
    return result.data
  },

  async importOcrModel(): Promise<OcrModelStatusDto> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.OCR_MODEL_IMPORT)
    const result = validatePayload(OcrModelStatusSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid importOcrModel response from main: ${result.error}`)
    }
    return result.data
  },

  async cancelOcrModel(): Promise<OcrModelStatusDto> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.OCR_MODEL_CANCEL)
    const result = validatePayload(OcrModelStatusSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid cancelOcrModel response from main: ${result.error}`)
    }
    return result.data
  },

  onOcrModelStatus(callback: (status: OcrModelStatusDto) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, rawPayload: unknown) => {
      const result = validatePayload(OcrModelStatusSchema, rawPayload)
      if (result.success) {
        callback(result.data)
      }
    }
    ipcRenderer.on(IPC_CHANNELS.OCR_MODEL_STATUS_EVENT, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.OCR_MODEL_STATUS_EVENT, handler)
    }
  },

  async getDocumentOcrState(
    request: GetDocumentOcrStateRequest
  ): Promise<GetDocumentOcrStateResponse> {
    const parsed = validatePayload(GetDocumentOcrStateRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid getDocumentOcrState request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.DOCUMENTS_OCR_GET_STATE, parsed.data)
    const result = validatePayload(GetDocumentOcrStateResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid getDocumentOcrState response from main: ${result.error}`)
    }
    return result.data
  },

  async getDocumentOcrPreview(
    request: GetDocumentOcrPreviewRequest
  ): Promise<GetDocumentOcrPreviewResponse> {
    const parsed = validatePayload(GetDocumentOcrPreviewRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid getDocumentOcrPreview request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.DOCUMENTS_OCR_GET_PREVIEW, parsed.data)
    const result = validatePayload(GetDocumentOcrPreviewResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid getDocumentOcrPreview response from main: ${result.error}`)
    }
    return result.data
  },

  async ocrSelectedDocuments(
    request: OcrSelectedDocumentsRequest
  ): Promise<DocumentOcrProgressDto> {
    const parsed = validatePayload(OcrSelectedDocumentsRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid ocrSelectedDocuments request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.DOCUMENTS_OCR_SELECTED, parsed.data)
    const result = validatePayload(DocumentOcrProgressSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid ocrSelectedDocuments response from main: ${result.error}`)
    }
    return result.data
  },

  async startDocumentOcr(
    request: StartDocumentOcrRequest = { scope: 'ocr_needed' }
  ): Promise<DocumentOcrProgressDto> {
    const parsed = validatePayload(StartDocumentOcrRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid startDocumentOcr request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.DOCUMENTS_OCR_START, parsed.data)
    const result = validatePayload(DocumentOcrProgressSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid startDocumentOcr response from main: ${result.error}`)
    }
    return result.data
  },

  async pauseDocumentOcr(): Promise<DocumentOcrProgressDto> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.DOCUMENTS_OCR_PAUSE)
    const result = validatePayload(DocumentOcrProgressSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid pauseDocumentOcr response from main: ${result.error}`)
    }
    return result.data
  },

  async resumeDocumentOcr(): Promise<DocumentOcrProgressDto> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.DOCUMENTS_OCR_RESUME)
    const result = validatePayload(DocumentOcrProgressSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid resumeDocumentOcr response from main: ${result.error}`)
    }
    return result.data
  },

  async cancelDocumentOcr(): Promise<DocumentOcrProgressDto> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.DOCUMENTS_OCR_CANCEL)
    const result = validatePayload(DocumentOcrProgressSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid cancelDocumentOcr response from main: ${result.error}`)
    }
    return result.data
  },

  async getDocumentOcrProgress(): Promise<DocumentOcrProgressDto> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.DOCUMENTS_OCR_GET_PROGRESS)
    const result = validatePayload(DocumentOcrProgressSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid getDocumentOcrProgress response from main: ${result.error}`)
    }
    return result.data
  },

  onDocumentOcrProgress(callback: (progress: DocumentOcrProgressDto) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, rawPayload: unknown) => {
      const result = validatePayload(DocumentOcrProgressSchema, rawPayload)
      if (result.success) {
        callback(result.data)
      }
    }
    ipcRenderer.on(IPC_CHANNELS.DOCUMENTS_OCR_PROGRESS_EVENT, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.DOCUMENTS_OCR_PROGRESS_EVENT, handler)
    }
  },

  async getDocSemanticModelStatus(): Promise<DocSemanticModelStatusDto> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.DOC_SEMANTIC_MODEL_GET_STATUS)
    const result = validatePayload(DocSemanticModelStatusSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid getDocSemanticModelStatus response from main: ${result.error}`)
    }
    return result.data
  },

  async downloadDocSemanticModel(): Promise<DocSemanticModelStatusDto> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.DOC_SEMANTIC_MODEL_DOWNLOAD)
    const result = validatePayload(DocSemanticModelStatusSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid downloadDocSemanticModel response from main: ${result.error}`)
    }
    return result.data
  },

  async importDocSemanticModel(): Promise<DocSemanticModelStatusDto> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.DOC_SEMANTIC_MODEL_IMPORT)
    const result = validatePayload(DocSemanticModelStatusSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid importDocSemanticModel response from main: ${result.error}`)
    }
    return result.data
  },

  async cancelDocSemanticModel(): Promise<DocSemanticModelStatusDto> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.DOC_SEMANTIC_MODEL_CANCEL)
    const result = validatePayload(DocSemanticModelStatusSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid cancelDocSemanticModel response from main: ${result.error}`)
    }
    return result.data
  },

  async indexSelectedDocuments(
    request: IndexSelectedDocumentsRequest
  ): Promise<DocumentSemanticProgressDto> {
    const parsed = validatePayload(IndexSelectedDocumentsRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid indexSelectedDocuments request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.DOC_SEMANTIC_INDEX_SELECTED, parsed.data)
    const result = validatePayload(DocSemanticProgressSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid indexSelectedDocuments response from main: ${result.error}`)
    }
    return result.data
  },

  async startDocumentSemanticIndexing(
    request?: StartDocSemanticIndexRequest
  ): Promise<DocumentSemanticProgressDto> {
    const parsed = validatePayload(StartDocSemanticIndexRequestSchema, request ?? {})
    if (!parsed.success) {
      throw new Error(`Invalid startDocumentSemanticIndexing request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.DOC_SEMANTIC_INDEX_START, parsed.data)
    const result = validatePayload(DocSemanticProgressSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid startDocumentSemanticIndexing response from main: ${result.error}`)
    }
    return result.data
  },

  async pauseDocumentSemanticIndexing(): Promise<DocumentSemanticProgressDto> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.DOC_SEMANTIC_INDEX_PAUSE)
    const result = validatePayload(DocSemanticProgressSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid pauseDocumentSemanticIndexing response from main: ${result.error}`)
    }
    return result.data
  },

  async resumeDocumentSemanticIndexing(): Promise<DocumentSemanticProgressDto> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.DOC_SEMANTIC_INDEX_RESUME)
    const result = validatePayload(DocSemanticProgressSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid resumeDocumentSemanticIndexing response from main: ${result.error}`)
    }
    return result.data
  },

  async cancelDocumentSemanticIndexing(): Promise<DocumentSemanticProgressDto> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.DOC_SEMANTIC_INDEX_CANCEL)
    const result = validatePayload(DocSemanticProgressSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid cancelDocumentSemanticIndexing response from main: ${result.error}`)
    }
    return result.data
  },

  async getDocumentSemanticProgress(): Promise<DocumentSemanticProgressDto> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.DOC_SEMANTIC_INDEX_GET_PROGRESS)
    const result = validatePayload(DocSemanticProgressSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid getDocumentSemanticProgress response from main: ${result.error}`)
    }
    return result.data
  },

  async searchDocumentsSemantic(
    request: DocSemanticSearchRequest
  ): Promise<DocSemanticSearchResponseDto> {
    const parsed = validatePayload(DocSemanticSearchRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid searchDocumentsSemantic request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.DOC_SEMANTIC_SEARCH, parsed.data)
    const result = validatePayload(DocSemanticSearchResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid searchDocumentsSemantic response from main: ${result.error}`)
    }
    return result.data
  },

  async cancelDocumentSemanticSearch(
    request?: DocSemanticSearchCancelRequest
  ): Promise<DocSemanticSearchCancelResponseDto> {
    if (request !== undefined) {
      const parsed = validatePayload(DocSemanticSearchCancelRequestSchema, request)
      if (!parsed.success) {
        throw new Error(`Invalid cancelDocumentSemanticSearch request: ${parsed.error}`)
      }
      const raw = await ipcRenderer.invoke(IPC_CHANNELS.DOC_SEMANTIC_SEARCH_CANCEL, parsed.data)
      const result = validatePayload(DocSemanticSearchCancelResponseSchema, raw)
      if (!result.success) {
        throw new Error(`Invalid cancelDocumentSemanticSearch response from main: ${result.error}`)
      }
      return result.data
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.DOC_SEMANTIC_SEARCH_CANCEL)
    const result = validatePayload(DocSemanticSearchCancelResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid cancelDocumentSemanticSearch response from main: ${result.error}`)
    }
    return result.data
  },

  async classifySelectedDocuments(
    request: ClassifySelectedDocumentsRequest
  ): Promise<DocumentClassificationProgressDto> {
    const parsed = validatePayload(ClassifySelectedDocumentsRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid classifySelectedDocuments request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.DOCUMENTS_CLASSIFY_SELECTED, parsed.data)
    const result = validatePayload(DocumentClassificationProgressSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid classifySelectedDocuments response from main: ${result.error}`)
    }
    return result.data
  },

  async startDocumentClassification(
    request?: StartDocumentClassificationRequest
  ): Promise<DocumentClassificationProgressDto> {
    const parsed = validatePayload(StartDocumentClassificationRequestSchema, request ?? {})
    if (!parsed.success) {
      throw new Error(`Invalid startDocumentClassification request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.DOCUMENTS_CLASSIFY_START, parsed.data)
    const result = validatePayload(DocumentClassificationProgressSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid startDocumentClassification response from main: ${result.error}`)
    }
    return result.data
  },

  async pauseDocumentClassification(): Promise<DocumentClassificationProgressDto> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.DOCUMENTS_CLASSIFY_PAUSE)
    const result = validatePayload(DocumentClassificationProgressSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid pauseDocumentClassification response from main: ${result.error}`)
    }
    return result.data
  },

  async resumeDocumentClassification(): Promise<DocumentClassificationProgressDto> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.DOCUMENTS_CLASSIFY_RESUME)
    const result = validatePayload(DocumentClassificationProgressSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid resumeDocumentClassification response from main: ${result.error}`)
    }
    return result.data
  },

  async cancelDocumentClassification(): Promise<DocumentClassificationProgressDto> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.DOCUMENTS_CLASSIFY_CANCEL)
    const result = validatePayload(DocumentClassificationProgressSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid cancelDocumentClassification response from main: ${result.error}`)
    }
    return result.data
  },

  async getDocumentClassificationProgress(): Promise<DocumentClassificationProgressDto> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.DOCUMENTS_CLASSIFY_GET_PROGRESS)
    const result = validatePayload(DocumentClassificationProgressSchema, raw)
    if (!result.success) {
      throw new Error(
        `Invalid getDocumentClassificationProgress response from main: ${result.error}`
      )
    }
    return result.data
  },

  onDocumentClassificationProgress(
    callback: (progress: DocumentClassificationProgressDto) => void
  ): () => void {
    const listener = (_event: Electron.IpcRendererEvent, raw: unknown) => {
      const result = validatePayload(DocumentClassificationProgressSchema, raw)
      if (result.success) {
        callback(result.data)
      }
    }
    ipcRenderer.on(IPC_CHANNELS.DOCUMENTS_CLASSIFY_PROGRESS_EVENT, listener)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.DOCUMENTS_CLASSIFY_PROGRESS_EVENT, listener)
    }
  },

  async setDocumentClassificationOverride(
    request: SetDocumentClassificationOverrideRequest
  ): Promise<DocumentClassificationOverrideAckDto> {
    const parsed = validatePayload(SetDocumentClassificationOverrideRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid setDocumentClassificationOverride request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(
      IPC_CHANNELS.DOCUMENTS_SET_CLASSIFICATION_OVERRIDE,
      parsed.data
    )
    const result = validatePayload(DocumentClassificationOverrideAckSchema, raw)
    if (!result.success) {
      throw new Error(
        `Invalid setDocumentClassificationOverride response from main: ${result.error}`
      )
    }
    return result.data
  },

  async resetDocumentClassificationOverride(
    request: ResetDocumentClassificationOverrideRequest
  ): Promise<DocumentClassificationOverrideAckDto> {
    const parsed = validatePayload(ResetDocumentClassificationOverrideRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid resetDocumentClassificationOverride request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(
      IPC_CHANNELS.DOCUMENTS_RESET_CLASSIFICATION_OVERRIDE,
      parsed.data
    )
    const result = validatePayload(DocumentClassificationOverrideAckSchema, raw)
    if (!result.success) {
      throw new Error(
        `Invalid resetDocumentClassificationOverride response from main: ${result.error}`
      )
    }
    return result.data
  },

  async getDocumentClassificationFacets(
    request?: GetDocumentClassificationFacetsRequest
  ): Promise<GetDocumentClassificationFacetsResponseDto> {
    const parsed = validatePayload(GetDocumentClassificationFacetsRequestSchema, request ?? {})
    if (!parsed.success) {
      throw new Error(`Invalid getDocumentClassificationFacets request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(
      IPC_CHANNELS.DOCUMENTS_GET_CLASSIFICATION_FACETS,
      parsed.data
    )
    const result = validatePayload(GetDocumentClassificationFacetsResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid getDocumentClassificationFacets response from main: ${result.error}`)
    }
    return result.data
  },

  async searchUnifiedPhotos(
    request: UnifiedSearchPhotosRequest
  ): Promise<UnifiedSearchPhotosResponse> {
    const parsed = validatePayload(UnifiedSearchPhotosRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid searchUnifiedPhotos request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.UNIFIED_SEARCH_PHOTOS, parsed.data)
    const result = validatePayload(UnifiedSearchPhotosResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid searchUnifiedPhotos response from main: ${result.error}`)
    }
    return result.data
  },

  async searchUnifiedDocuments(
    request: UnifiedSearchDocumentsRequest
  ): Promise<UnifiedSearchDocumentsResponse> {
    const parsed = validatePayload(UnifiedSearchDocumentsRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid searchUnifiedDocuments request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.UNIFIED_SEARCH_DOCUMENTS, parsed.data)
    const result = validatePayload(UnifiedSearchDocumentsResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid searchUnifiedDocuments response from main: ${result.error}`)
    }
    return result.data
  },

  async cancelUnifiedSearch(
    request: UnifiedSearchCancelRequest
  ): Promise<UnifiedSearchCancelResponse> {
    const parsed = validatePayload(UnifiedSearchCancelRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid cancelUnifiedSearch request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.UNIFIED_SEARCH_CANCEL, parsed.data)
    const result = validatePayload(UnifiedSearchCancelResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid cancelUnifiedSearch response from main: ${result.error}`)
    }
    return result.data
  },

  async selectExportDestination(): Promise<ExportSelectDestinationResponse> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.EXPORT_SELECT_DESTINATION)
    const result = validatePayload(ExportSelectDestinationResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid selectExportDestination response from main: ${result.error}`)
    }
    return result.data
  },

  async startExport(request: ExportStartRequest): Promise<ExportJobRecordDto> {
    const parsed = validatePayload(ExportStartRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid startExport request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.EXPORT_START, parsed.data)
    const result = validatePayload(ExportJobRecordSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid startExport response from main: ${result.error}`)
    }
    return result.data
  },

  async cancelExport(jobId: string): Promise<ExportCancelResponse> {
    const parsed = validatePayload(ExportCancelRequestSchema, { jobId })
    if (!parsed.success) {
      throw new Error(`Invalid cancelExport request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.EXPORT_CANCEL, parsed.data)
    const result = validatePayload(ExportCancelResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid cancelExport response from main: ${result.error}`)
    }
    return result.data
  },

  async getActiveExportJob(): Promise<ExportJobRecordDto | null> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.EXPORT_GET_ACTIVE)
    if (raw === null) return null
    const result = validatePayload(ExportJobRecordSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid getActiveExportJob response from main: ${result.error}`)
    }
    return result.data
  },

  async listExportJobs(request?: ExportListJobsRequest): Promise<ExportJobListResponse> {
    const parsed = validatePayload(ExportListJobsRequestSchema, request ?? {})
    if (!parsed.success) {
      throw new Error(`Invalid listExportJobs request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.EXPORT_LIST_JOBS, parsed.data)
    const result = validatePayload(ExportJobListResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid listExportJobs response from main: ${result.error}`)
    }
    return result.data
  },

  async getExportJob(jobId: string): Promise<ExportJobRecordDto | null> {
    const parsed = validatePayload(ExportGetJobRequestSchema, { jobId })
    if (!parsed.success) {
      throw new Error(`Invalid getExportJob request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.EXPORT_GET_JOB, parsed.data)
    if (raw === null) return null
    const result = validatePayload(ExportJobRecordSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid getExportJob response from main: ${result.error}`)
    }
    return result.data
  },

  async getExportJobItems(request: ExportGetJobItemsRequest): Promise<ExportJobItemsResponse> {
    const parsed = validatePayload(ExportGetJobItemsRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid getExportJobItems request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.EXPORT_GET_JOB_ITEMS, parsed.data)
    const result = validatePayload(ExportJobItemsResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid getExportJobItems response from main: ${result.error}`)
    }
    return result.data
  },

  async verifyExportJob(jobId: string): Promise<ExportJobRecordDto | null> {
    const parsed = validatePayload(ExportVerifyJobRequestSchema, { jobId })
    if (!parsed.success) {
      throw new Error(`Invalid verifyExportJob request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.EXPORT_VERIFY_JOB, parsed.data)
    if (raw === null) return null
    const result = validatePayload(ExportJobRecordSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid verifyExportJob response from main: ${result.error}`)
    }
    return result.data
  },

  onExportProgress(listener: (event: ExportProgressEvent) => void): () => void {
    const wrapped = (_event: Electron.IpcRendererEvent, raw: unknown): void => {
      const result = validatePayload(ExportProgressEventSchema, raw)
      if (result.success) {
        listener(result.data)
      }
    }
    ipcRenderer.on(IPC_CHANNELS.EXPORT_PROGRESS_EVENT, wrapped)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.EXPORT_PROGRESS_EVENT, wrapped)
    }
  },

  async selectBackupDirectory(
    request?: BackupSelectDirectoryRequest
  ): Promise<BackupSelectDirectoryResponse> {
    const parsed = validatePayload(BackupSelectDirectoryRequestSchema, request ?? {})
    if (!parsed.success) {
      throw new Error(`Invalid selectBackupDirectory request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.BACKUP_SELECT_DIRECTORY, parsed.data)
    const result = validatePayload(BackupSelectDirectoryResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid selectBackupDirectory response from main: ${result.error}`)
    }
    return result.data
  },

  async configureBackupDestination(
    request: BackupConfigureDestinationRequest
  ): Promise<BackupDestinationRecordDto> {
    const parsed = validatePayload(BackupConfigureDestinationRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid configureBackupDestination request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.BACKUP_CONFIGURE_DESTINATION, parsed.data)
    const result = validatePayload(BackupDestinationRecordSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid configureBackupDestination response from main: ${result.error}`)
    }
    return result.data
  },

  async listBackupDestinations(
    request?: BackupListDestinationsRequest
  ): Promise<BackupListDestinationsResponse> {
    const parsed = validatePayload(BackupListDestinationsRequestSchema, request ?? {})
    if (!parsed.success) {
      throw new Error(`Invalid listBackupDestinations request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.BACKUP_LIST_DESTINATIONS, parsed.data)
    const result = validatePayload(BackupListDestinationsResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid listBackupDestinations response from main: ${result.error}`)
    }
    return result.data
  },

  async getBackupSummary(): Promise<BackupSummaryDto> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.BACKUP_GET_SUMMARY)
    const result = validatePayload(BackupSummarySchema, raw)
    if (!result.success) {
      throw new Error(`Invalid getBackupSummary response from main: ${result.error}`)
    }
    return result.data
  },

  async startBackup(request: BackupStartRequest): Promise<BackupJobRecordDto> {
    const parsed = validatePayload(BackupStartRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid startBackup request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.BACKUP_START, parsed.data)
    const result = validatePayload(BackupJobRecordSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid startBackup response from main: ${result.error}`)
    }
    return result.data
  },

  async pauseBackup(jobId: string): Promise<BackupJobActionResponse> {
    const parsed = validatePayload(BackupJobActionRequestSchema, { jobId })
    if (!parsed.success) {
      throw new Error(`Invalid pauseBackup request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.BACKUP_PAUSE, parsed.data)
    const result = validatePayload(BackupJobActionResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid pauseBackup response from main: ${result.error}`)
    }
    return result.data
  },

  async resumeBackup(jobId: string, recoverySecret?: string): Promise<BackupJobRecordDto> {
    const parsed = validatePayload(BackupJobActionRequestSchema, {
      jobId,
      ...(recoverySecret !== undefined ? { recoverySecret } : {})
    })
    if (!parsed.success) {
      throw new Error(`Invalid resumeBackup request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.BACKUP_RESUME, parsed.data)
    const result = validatePayload(BackupJobRecordSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid resumeBackup response from main: ${result.error}`)
    }
    return result.data
  },

  async cancelBackup(jobId: string): Promise<BackupJobActionResponse> {
    const parsed = validatePayload(BackupJobActionRequestSchema, { jobId })
    if (!parsed.success) {
      throw new Error(`Invalid cancelBackup request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.BACKUP_CANCEL, parsed.data)
    const result = validatePayload(BackupJobActionResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid cancelBackup response from main: ${result.error}`)
    }
    return result.data
  },

  async getActiveBackupJob(): Promise<BackupJobRecordDto | null> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.BACKUP_GET_ACTIVE)
    if (raw === null) return null
    const result = validatePayload(BackupJobRecordSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid getActiveBackupJob response from main: ${result.error}`)
    }
    return result.data
  },

  async listBackupJobs(request?: BackupListJobsRequest): Promise<BackupListJobsResponse> {
    const parsed = validatePayload(BackupListJobsRequestSchema, request ?? {})
    if (!parsed.success) {
      throw new Error(`Invalid listBackupJobs request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.BACKUP_LIST_JOBS, parsed.data)
    const result = validatePayload(BackupListJobsResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid listBackupJobs response from main: ${result.error}`)
    }
    return result.data
  },

  async getBackupJob(jobId: string): Promise<BackupJobRecordDto | null> {
    const parsed = validatePayload(BackupJobActionRequestSchema, { jobId })
    if (!parsed.success) {
      throw new Error(`Invalid getBackupJob request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.BACKUP_GET_JOB, parsed.data)
    if (raw === null) return null
    const result = validatePayload(BackupJobRecordSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid getBackupJob response from main: ${result.error}`)
    }
    return result.data
  },

  async listRecoveryPoints(
    request: BackupListRecoveryPointsRequest
  ): Promise<BackupListRecoveryPointsResponse> {
    const parsed = validatePayload(BackupListRecoveryPointsRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid listRecoveryPoints request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.BACKUP_LIST_RECOVERY_POINTS, parsed.data)
    const result = validatePayload(BackupListRecoveryPointsResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid listRecoveryPoints response from main: ${result.error}`)
    }
    return result.data
  },

  async verifyRecoveryPoint(
    request: BackupVerifyRecoveryPointRequest
  ): Promise<BackupVerifyRecoveryPointResponse> {
    const parsed = validatePayload(BackupVerifyRecoveryPointRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid verifyRecoveryPoint request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.BACKUP_VERIFY_RECOVERY_POINT, parsed.data)
    const result = validatePayload(BackupVerifyRecoveryPointResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid verifyRecoveryPoint response from main: ${result.error}`)
    }
    return result.data
  },

  async restoreRecoveryPoint(request: BackupRestoreRequest): Promise<BackupRestoreResponse> {
    const parsed = validatePayload(BackupRestoreRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid restoreRecoveryPoint request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.BACKUP_RESTORE_RECOVERY_POINT, parsed.data)
    const result = validatePayload(BackupRestoreResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid restoreRecoveryPoint response from main: ${result.error}`)
    }
    return result.data
  },

  async recoverCatalogFromVault(
    request: BackupRecoverCatalogRequest
  ): Promise<BackupRecoverCatalogResponse> {
    const parsed = validatePayload(BackupRecoverCatalogRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid recoverCatalogFromVault request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(
      IPC_CHANNELS.BACKUP_RECOVER_CATALOG_FROM_VAULT,
      parsed.data
    )
    const result = validatePayload(BackupRecoverCatalogResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid recoverCatalogFromVault response from main: ${result.error}`)
    }
    return result.data
  },

  async getGoogleDriveAuthStatus(): Promise<BackupGoogleDriveAuthStatusDto> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.BACKUP_GDRIVE_GET_STATUS)
    const result = validatePayload(BackupGoogleDriveAuthStatusSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid getGoogleDriveAuthStatus response from main: ${result.error}`)
    }
    return result.data
  },

  async connectGoogleDrive(): Promise<BackupGoogleDriveAuthStatusDto> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.BACKUP_GDRIVE_CONNECT)
    const result = validatePayload(BackupGoogleDriveAuthStatusSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid connectGoogleDrive response from main: ${result.error}`)
    }
    return result.data
  },

  async disconnectGoogleDrive(): Promise<BackupGoogleDriveAuthStatusDto> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.BACKUP_GDRIVE_DISCONNECT)
    const result = validatePayload(BackupGoogleDriveAuthStatusSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid disconnectGoogleDrive response from main: ${result.error}`)
    }
    return result.data
  },

  async listGoogleDriveFolders(
    request?: BackupGoogleDriveListFoldersRequest
  ): Promise<BackupGoogleDriveListFoldersResponse> {
    const parsed = validatePayload(BackupGoogleDriveListFoldersRequestSchema, request ?? {})
    if (!parsed.success) {
      throw new Error(`Invalid listGoogleDriveFolders request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.BACKUP_GDRIVE_LIST_FOLDERS, parsed.data)
    const result = validatePayload(BackupGoogleDriveListFoldersResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid listGoogleDriveFolders response from main: ${result.error}`)
    }
    return result.data
  },

  async createGoogleDriveFolder(
    request: BackupGoogleDriveCreateFolderRequest
  ): Promise<BackupGoogleDriveFolderDto> {
    const parsed = validatePayload(BackupGoogleDriveCreateFolderRequestSchema, request)
    if (!parsed.success) {
      throw new Error(`Invalid createGoogleDriveFolder request: ${parsed.error}`)
    }
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.BACKUP_GDRIVE_CREATE_FOLDER, parsed.data)
    const result = validatePayload(BackupGoogleDriveFolderSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid createGoogleDriveFolder response from main: ${result.error}`)
    }
    return result.data
  },

  onBackupProgress(listener: (event: BackupProgressEvent) => void): () => void {
    const wrapped = (_event: Electron.IpcRendererEvent, raw: unknown): void => {
      const result = validatePayload(BackupProgressEventSchema, raw)
      if (result.success) {
        listener(result.data)
      }
    }
    ipcRenderer.on(IPC_CHANNELS.BACKUP_PROGRESS_EVENT, wrapped)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.BACKUP_PROGRESS_EVENT, wrapped)
    }
  },

  async getUpdateState(): Promise<UpdateStateDto> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.UPDATE_GET_STATE)
    const result = validatePayload(UpdateStateSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid getUpdateState response from main: ${result.error}`)
    }
    return result.data
  },

  async checkForUpdates(): Promise<UpdateActionResponseDto> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.UPDATE_CHECK)
    const result = validatePayload(UpdateActionResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid checkForUpdates response from main: ${result.error}`)
    }
    return result.data
  },

  async installUpdateNow(): Promise<UpdateActionResponseDto> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.UPDATE_INSTALL_NOW)
    const result = validatePayload(UpdateActionResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid installUpdateNow response from main: ${result.error}`)
    }
    return result.data
  },

  async deferUpdate(): Promise<UpdateActionResponseDto> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.UPDATE_DEFER)
    const result = validatePayload(UpdateActionResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid deferUpdate response from main: ${result.error}`)
    }
    return result.data
  },

  async dismissUpdateError(): Promise<UpdateActionResponseDto> {
    const raw = await ipcRenderer.invoke(IPC_CHANNELS.UPDATE_DISMISS_ERROR)
    const result = validatePayload(UpdateActionResponseSchema, raw)
    if (!result.success) {
      throw new Error(`Invalid dismissUpdateError response from main: ${result.error}`)
    }
    return result.data
  },

  onUpdateState(listener: (state: UpdateStateDto) => void): () => void {
    const wrapped = (_event: Electron.IpcRendererEvent, raw: unknown): void => {
      const result = validatePayload(UpdateStateSchema, raw)
      if (result.success) {
        listener(result.data)
      }
    }
    ipcRenderer.on(IPC_CHANNELS.UPDATE_STATE_EVENT, wrapped)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.UPDATE_STATE_EVENT, wrapped)
    }
  }
}

// A failure here is deliberately not swallowed: Electron reports it as a preload error.
contextBridge.exposeInMainWorld('api', api)
