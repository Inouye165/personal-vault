import type {
  UpdateActionResponseDto,
  UpdateStateDto
} from '../shared/validation/update-ipc-schemas.js'
import type {
  BackupConfigureDestinationRequest,
  BackupDestinationRecordDto,
  BackupGoogleDriveAuthStatusDto,
  BackupGoogleDriveCreateFolderRequest,
  BackupGoogleDriveFolderDto,
  BackupGoogleDriveListFoldersRequest,
  BackupGoogleDriveListFoldersResponse,
  BackupJobActionResponse,
  BackupJobRecordDto,
  BackupListDestinationsRequest,
  BackupListDestinationsResponse,
  BackupListJobsRequest,
  BackupListJobsResponse,
  BackupListRecoveryPointsRequest,
  BackupListRecoveryPointsResponse,
  BackupProgressEvent,
  BackupRecoverCatalogRequest,
  BackupRecoverCatalogResponse,
  BackupRestoreRequest,
  BackupRestoreResponse,
  BackupSelectDirectoryRequest,
  BackupSelectDirectoryResponse,
  BackupStartRequest,
  BackupSummaryDto,
  BackupVerifyRecoveryPointRequest,
  BackupVerifyRecoveryPointResponse
} from '../shared/validation/backup-ipc-schemas.js'
import type {
  ExportCancelResponse,
  ExportGetJobItemsRequest,
  ExportJobItemsResponse,
  ExportJobListResponse,
  ExportJobRecordDto,
  ExportListJobsRequest,
  ExportProgressEvent,
  ExportSelectDestinationResponse,
  ExportStartRequest
} from '../shared/validation/export-schemas.js'
import type {
  AppInfo,
  NavigationTab,
  VaultStatus,
  SelectRootsResponse,
  StartScanRequest,
  JobActionResponse,
  GetActiveJobResponse,
  GetLatestJobResponse,
  DismissJobResponse,
  ScanJobProgress,
  GetDuplicateGroupsRequest,
  GetDuplicateGroupsResponse,
  GetDuplicateGroupMembersRequest,
  GetDuplicateGroupMembersResponse,
  SetDuplicateReviewRequest,
  SetDuplicateReviewResponse,
  SelectVaultDirectoryResponse,
  InitializeVaultRequest,
  InitializeVaultResponse,
  GetActiveVaultResponse,
  SetActiveVaultRequest,
  SetActiveVaultResponse,
  GetImportCandidatesRequest,
  GetImportCandidatesResponse,
  StartImportRequest,
  StartImportResponse,
  VaultImportProgress,
  GetActiveImportJobResponse,
  GetLatestImportJobResponse,
  VaultImportActionResponse,
  PauseImportRequest,
  ResumeImportRequest,
  CancelImportRequest,
  GetPhotosPageRequest,
  GetPhotosPageResponse,
  GetThumbnailRequest,
  ThumbnailResult,
  GetOriginalPhotoRequest,
  OriginalPhotoResult,
  PrepareVideoPlaybackRequest,
  VideoPlaybackResult,
  RevokeVideoTokenRequest,
  OpenInDefaultPlayerRequest,
  OpenInDefaultPlayerResponse,
  MediaLibraryUpdatedEvent,
  CancelThumbnailRequest,
  CancelThumbnailResponse,
  PhotosDiagnosticsResponse,
  ThumbnailPrepProgress,
  SetPhotoAnnotationRequest,
  SetPhotoAnnotationResponse,
  GetPhotoAnnotationRequest,
  GetPhotoAnnotationResponse,
  CreateCollectionRequest,
  CreateCollectionResponse,
  RenameCollectionRequest,
  RenameCollectionResponse,
  ListCollectionsRequest,
  ListCollectionsResponse,
  AddCollectionMemberRequest,
  AddCollectionMemberResponse,
  RemoveCollectionMemberRequest,
  RemoveCollectionMemberResponse,
  GetPhotoMembershipsRequest,
  GetPhotoMembershipsResponse,
  ReconcileJournalResponse,
  SimilarityAnalysisProgress,
  SimilarityGetPairsRequest,
  SimilarityGetPairsResponse,
  SimilaritySetDecisionRequest,
  SimilaritySetDecisionResponse,
  SimilarityReconcileResponse,
  SemanticModelStatusResponse,
  SemanticIndexProgressResponse,
  SemanticIndexJobItemsRequest,
  SemanticIndexJobItemsResponse,
  PhotoMetadataProgressResponse,
  StartPhotoMetadataExtractionRequest,
  GetPhotoMetadataDetailRequest,
  GetPhotoMetadataDetailResponse,
  GetPhotoMetadataFacetsRequest,
  GetPhotoMetadataFacetsResponse,
  GetPhotoMetadataAttentionItemsRequest,
  GetPhotoMetadataAttentionItemsResponse,
  SemanticSearchRequest,
  SemanticSearchResponse,
  SemanticSearchCancelRequest,
  SemanticSearchCancelResponse,
  GetDocumentsPageRequest,
  GetDocumentsPageResponse,
  GetDocumentDetailRequest,
  GetDocumentDetailResponse,
  GetDocumentExtensionFacetsRequest,
  GetDocumentExtensionFacetsResponse,
  GetDocumentPreviewRequest,
  GetDocumentPreviewResponse,
  ExtractSelectedDocumentsRequest,
  StartDocumentExtractionRequest,
  DocumentExtractionProgressDto,
  OcrModelStatusDto,
  GetDocumentOcrStateRequest,
  GetDocumentOcrStateResponse,
  GetDocumentOcrPreviewRequest,
  GetDocumentOcrPreviewResponse,
  OcrSelectedDocumentsRequest,
  StartDocumentOcrRequest,
  DocumentOcrProgressDto,
  DocSemanticModelStatusDto,
  DocumentSemanticProgressDto,
  IndexSelectedDocumentsRequest,
  StartDocSemanticIndexRequest,
  DocSemanticSearchRequest,
  DocSemanticSearchResponseDto,
  DocSemanticSearchCancelRequest,
  MetadataAwarePhotoSearchRequest,
  MetadataAwarePhotoSearchResponse,
  SavedEventsListResponse,
  UpsertSavedEventRequest,
  SavedEvent,
  SavedPlacesListResponse,
  UpsertSavedPlaceRequest,
  SavedPlace,
  SetPhotoUserPlaceRequest,
  ClearPhotoUserPlaceRequest,
  PhotoUserPlace,
  CameraLabelsListResponse,
  UpsertCameraLabelRequest,
  CameraLabel,
  UnifiedSearchPhotosRequest,
  UnifiedSearchPhotosResponse,
  UnifiedSearchDocumentsRequest,
  UnifiedSearchDocumentsResponse,
  UnifiedSearchCancelRequest,
  UnifiedSearchCancelResponse,
  ClassifySelectedDocumentsRequest,
  StartDocumentClassificationRequest,
  DocumentClassificationProgressDto,
  SetDocumentClassificationOverrideRequest,
  ResetDocumentClassificationOverrideRequest,
  DocumentClassificationOverrideAckDto,
  GetDocumentClassificationFacetsRequest,
  GetDocumentClassificationFacetsResponseDto
} from '../shared/validation/ipc-schemas.js'

export interface VaultApi {
  getAppInfo: () => Promise<AppInfo>
  getVaultStatus: () => Promise<VaultStatus>
  setTab: (tab: NavigationTab) => Promise<boolean>
  selectRoots: () => Promise<SelectRootsResponse>
  startScan: (request: StartScanRequest) => Promise<JobActionResponse>
  pauseScan: (jobId: number) => Promise<JobActionResponse>
  resumeScan: (jobId: number) => Promise<JobActionResponse>
  cancelScan: (jobId: number) => Promise<JobActionResponse>
  getActiveScanJob: () => Promise<GetActiveJobResponse>
  getLatestScanJob: () => Promise<GetLatestJobResponse>
  dismissScanJob: (jobId: number) => Promise<DismissJobResponse>
  onScanProgress: (callback: (progress: ScanJobProgress) => void) => () => void
  getDuplicateGroups: (request?: GetDuplicateGroupsRequest) => Promise<GetDuplicateGroupsResponse>
  getDuplicateGroupMembers: (
    request: GetDuplicateGroupMembersRequest
  ) => Promise<GetDuplicateGroupMembersResponse>
  setDuplicateReview: (request: SetDuplicateReviewRequest) => Promise<SetDuplicateReviewResponse>
  selectVaultDirectory: () => Promise<SelectVaultDirectoryResponse>
  initializeVault: (request: InitializeVaultRequest) => Promise<InitializeVaultResponse>
  getActiveVault: () => Promise<GetActiveVaultResponse>
  setActiveVault: (request: SetActiveVaultRequest) => Promise<SetActiveVaultResponse>
  getImportCandidates: (request: GetImportCandidatesRequest) => Promise<GetImportCandidatesResponse>
  startImport: (request: StartImportRequest) => Promise<StartImportResponse>
  pauseImport: (request?: PauseImportRequest) => Promise<VaultImportActionResponse>
  resumeImport: (request?: ResumeImportRequest | string) => Promise<VaultImportActionResponse>
  cancelImport: (request?: CancelImportRequest) => Promise<VaultImportActionResponse>
  getActiveImportJob: () => Promise<GetActiveImportJobResponse>
  getLatestImportJob: () => Promise<GetLatestImportJobResponse>
  onImportProgress: (callback: (progress: VaultImportProgress) => void) => () => void
  getPhotosPage: (request: GetPhotosPageRequest) => Promise<GetPhotosPageResponse>
  getThumbnail: (request: GetThumbnailRequest) => Promise<ThumbnailResult>
  getOriginalPhoto: (request: GetOriginalPhotoRequest) => Promise<OriginalPhotoResult>
  prepareVideoPlayback: (request: PrepareVideoPlaybackRequest) => Promise<VideoPlaybackResult>
  revokeVideoPlaybackToken: (request: RevokeVideoTokenRequest) => Promise<boolean>
  openMediaInDefaultPlayer: (
    request: OpenInDefaultPlayerRequest
  ) => Promise<OpenInDefaultPlayerResponse>
  onMediaLibraryUpdated: (callback: (event: MediaLibraryUpdatedEvent) => void) => () => void
  cancelThumbnail: (request: CancelThumbnailRequest) => Promise<CancelThumbnailResponse>
  getPhotosDiagnostics: () => Promise<PhotosDiagnosticsResponse>
  getThumbnailPrepProgress: () => Promise<ThumbnailPrepProgress>
  onThumbnailPrepProgress: (callback: (progress: ThumbnailPrepProgress) => void) => () => void
  setPhotoAnnotation: (request: SetPhotoAnnotationRequest) => Promise<SetPhotoAnnotationResponse>
  getPhotoAnnotation: (request: GetPhotoAnnotationRequest) => Promise<GetPhotoAnnotationResponse>
  listCollections: (request?: ListCollectionsRequest) => Promise<ListCollectionsResponse>
  createCollection: (request: CreateCollectionRequest) => Promise<CreateCollectionResponse>
  renameCollection: (request: RenameCollectionRequest) => Promise<RenameCollectionResponse>
  addCollectionMember: (request: AddCollectionMemberRequest) => Promise<AddCollectionMemberResponse>
  removeCollectionMember: (
    request: RemoveCollectionMemberRequest
  ) => Promise<RemoveCollectionMemberResponse>
  getPhotoMemberships: (request: GetPhotoMembershipsRequest) => Promise<GetPhotoMembershipsResponse>
  reconcileJournal: () => Promise<ReconcileJournalResponse>
  startSimilarityAnalysis: () => Promise<SimilarityAnalysisProgress>
  cancelSimilarityAnalysis: () => Promise<SimilarityAnalysisProgress>
  resumeSimilarityAnalysis: () => Promise<SimilarityAnalysisProgress>
  getSimilarityProgress: () => Promise<SimilarityAnalysisProgress>
  getSimilarityPairs: (request: SimilarityGetPairsRequest) => Promise<SimilarityGetPairsResponse>
  setSimilarityDecision: (
    request: SimilaritySetDecisionRequest
  ) => Promise<SimilaritySetDecisionResponse>
  reconcileSimilarity: () => Promise<SimilarityReconcileResponse>
  getSemanticModelStatus: () => Promise<SemanticModelStatusResponse>
  downloadSemanticModel: () => Promise<SemanticModelStatusResponse>
  importSemanticModelFromFolder: () => Promise<SemanticModelStatusResponse>
  cancelSemanticModelProvisioning: () => Promise<SemanticModelStatusResponse>
  onSemanticModelStatus: (callback: (status: SemanticModelStatusResponse) => void) => () => void
  getSemanticIndexProgress: () => Promise<SemanticIndexProgressResponse>
  startSemanticIndexing: () => Promise<SemanticIndexProgressResponse>
  pauseSemanticIndexing: () => Promise<SemanticIndexProgressResponse>
  resumeSemanticIndexing: () => Promise<SemanticIndexProgressResponse>
  cancelSemanticIndexing: () => Promise<SemanticIndexProgressResponse>
  getSemanticIndexJobItems: (
    request?: SemanticIndexJobItemsRequest
  ) => Promise<SemanticIndexJobItemsResponse>
  onSemanticIndexProgress: (
    callback: (progress: SemanticIndexProgressResponse) => void
  ) => () => void
  getPhotoMetadataProgress: () => Promise<PhotoMetadataProgressResponse>
  startPhotoMetadataExtraction: (
    request?: StartPhotoMetadataExtractionRequest
  ) => Promise<PhotoMetadataProgressResponse>
  pausePhotoMetadataExtraction: () => Promise<PhotoMetadataProgressResponse>
  resumePhotoMetadataExtraction: () => Promise<PhotoMetadataProgressResponse>
  cancelPhotoMetadataExtraction: () => Promise<PhotoMetadataProgressResponse>
  onPhotoMetadataProgress: (
    callback: (progress: PhotoMetadataProgressResponse) => void
  ) => () => void
  getPhotoMetadataDetail: (
    request: GetPhotoMetadataDetailRequest
  ) => Promise<GetPhotoMetadataDetailResponse>
  getPhotoMetadataFacets: (
    request: GetPhotoMetadataFacetsRequest
  ) => Promise<GetPhotoMetadataFacetsResponse>
  getPhotoMetadataAttentionItems: (
    request?: GetPhotoMetadataAttentionItemsRequest
  ) => Promise<GetPhotoMetadataAttentionItemsResponse>
  searchPhotosSemantic: (request: SemanticSearchRequest) => Promise<SemanticSearchResponse>
  cancelPhotosSemanticSearch: (
    request?: SemanticSearchCancelRequest
  ) => Promise<SemanticSearchCancelResponse>
  searchPhotosMetadataAware: (
    request: MetadataAwarePhotoSearchRequest
  ) => Promise<MetadataAwarePhotoSearchResponse>
  listSavedEvents: () => Promise<SavedEventsListResponse>
  upsertSavedEvent: (request: UpsertSavedEventRequest) => Promise<SavedEvent>
  deleteSavedEvent: (id: number) => Promise<boolean>
  listSavedPlaces: () => Promise<SavedPlacesListResponse>
  upsertSavedPlace: (request: UpsertSavedPlaceRequest) => Promise<SavedPlace>
  deleteSavedPlace: (id: number) => Promise<boolean>
  setPhotoUserPlace: (request: SetPhotoUserPlaceRequest) => Promise<PhotoUserPlace>
  clearPhotoUserPlace: (request: ClearPhotoUserPlaceRequest) => Promise<boolean>
  listCameraLabels: () => Promise<CameraLabelsListResponse>
  upsertCameraLabel: (request: UpsertCameraLabelRequest) => Promise<CameraLabel>
  deleteCameraLabel: (id: number) => Promise<boolean>
  getDocumentsPage: (request: GetDocumentsPageRequest) => Promise<GetDocumentsPageResponse>
  getDocumentDetail: (request: GetDocumentDetailRequest) => Promise<GetDocumentDetailResponse>
  getDocumentExtensionFacets: (
    request?: GetDocumentExtensionFacetsRequest
  ) => Promise<GetDocumentExtensionFacetsResponse>
  getDocumentPreview: (request: GetDocumentPreviewRequest) => Promise<GetDocumentPreviewResponse>
  extractSelectedDocuments: (
    request: ExtractSelectedDocumentsRequest
  ) => Promise<DocumentExtractionProgressDto>
  startDocumentExtraction: (
    request?: StartDocumentExtractionRequest
  ) => Promise<DocumentExtractionProgressDto>
  pauseDocumentExtraction: () => Promise<DocumentExtractionProgressDto>
  resumeDocumentExtraction: () => Promise<DocumentExtractionProgressDto>
  cancelDocumentExtraction: () => Promise<DocumentExtractionProgressDto>
  getDocumentExtractionProgress: () => Promise<DocumentExtractionProgressDto>
  onDocumentExtractionProgress: (
    callback: (progress: DocumentExtractionProgressDto) => void
  ) => () => void
  getOcrModelStatus: () => Promise<OcrModelStatusDto>
  downloadOcrModel: () => Promise<OcrModelStatusDto>
  importOcrModel: () => Promise<OcrModelStatusDto>
  cancelOcrModel: () => Promise<OcrModelStatusDto>
  onOcrModelStatus: (callback: (status: OcrModelStatusDto) => void) => () => void
  getDocumentOcrState: (request: GetDocumentOcrStateRequest) => Promise<GetDocumentOcrStateResponse>
  getDocumentOcrPreview: (
    request: GetDocumentOcrPreviewRequest
  ) => Promise<GetDocumentOcrPreviewResponse>
  ocrSelectedDocuments: (request: OcrSelectedDocumentsRequest) => Promise<DocumentOcrProgressDto>
  startDocumentOcr: (request?: StartDocumentOcrRequest) => Promise<DocumentOcrProgressDto>
  pauseDocumentOcr: () => Promise<DocumentOcrProgressDto>
  resumeDocumentOcr: () => Promise<DocumentOcrProgressDto>
  cancelDocumentOcr: () => Promise<DocumentOcrProgressDto>
  getDocumentOcrProgress: () => Promise<DocumentOcrProgressDto>
  onDocumentOcrProgress: (callback: (progress: DocumentOcrProgressDto) => void) => () => void
  getDocSemanticModelStatus: () => Promise<DocSemanticModelStatusDto>
  downloadDocSemanticModel: () => Promise<DocSemanticModelStatusDto>
  importDocSemanticModel: () => Promise<DocSemanticModelStatusDto>
  cancelDocSemanticModel: () => Promise<DocSemanticModelStatusDto>
  indexSelectedDocuments: (
    request: IndexSelectedDocumentsRequest
  ) => Promise<DocumentSemanticProgressDto>
  startDocumentSemanticIndexing: (
    request?: StartDocSemanticIndexRequest
  ) => Promise<DocumentSemanticProgressDto>
  pauseDocumentSemanticIndexing: () => Promise<DocumentSemanticProgressDto>
  resumeDocumentSemanticIndexing: () => Promise<DocumentSemanticProgressDto>
  cancelDocumentSemanticIndexing: () => Promise<DocumentSemanticProgressDto>
  getDocumentSemanticProgress: () => Promise<DocumentSemanticProgressDto>
  searchDocumentsSemantic: (
    request: DocSemanticSearchRequest
  ) => Promise<DocSemanticSearchResponseDto>
  cancelDocumentSemanticSearch: (
    request?: DocSemanticSearchCancelRequest
  ) => Promise<{ cancelled: boolean }>
  classifySelectedDocuments: (
    request: ClassifySelectedDocumentsRequest
  ) => Promise<DocumentClassificationProgressDto>
  startDocumentClassification: (
    request?: StartDocumentClassificationRequest
  ) => Promise<DocumentClassificationProgressDto>
  pauseDocumentClassification: () => Promise<DocumentClassificationProgressDto>
  resumeDocumentClassification: () => Promise<DocumentClassificationProgressDto>
  cancelDocumentClassification: () => Promise<DocumentClassificationProgressDto>
  getDocumentClassificationProgress: () => Promise<DocumentClassificationProgressDto>
  onDocumentClassificationProgress: (
    callback: (progress: DocumentClassificationProgressDto) => void
  ) => () => void
  setDocumentClassificationOverride: (
    request: SetDocumentClassificationOverrideRequest
  ) => Promise<DocumentClassificationOverrideAckDto>
  resetDocumentClassificationOverride: (
    request: ResetDocumentClassificationOverrideRequest
  ) => Promise<DocumentClassificationOverrideAckDto>
  getDocumentClassificationFacets: (
    request?: GetDocumentClassificationFacetsRequest
  ) => Promise<GetDocumentClassificationFacetsResponseDto>
  searchUnifiedPhotos: (request: UnifiedSearchPhotosRequest) => Promise<UnifiedSearchPhotosResponse>
  searchUnifiedDocuments: (
    request: UnifiedSearchDocumentsRequest
  ) => Promise<UnifiedSearchDocumentsResponse>
  cancelUnifiedSearch: (request: UnifiedSearchCancelRequest) => Promise<UnifiedSearchCancelResponse>
  selectExportDestination: () => Promise<ExportSelectDestinationResponse>
  startExport: (request: ExportStartRequest) => Promise<ExportJobRecordDto>
  cancelExport: (jobId: string) => Promise<ExportCancelResponse>
  getActiveExportJob: () => Promise<ExportJobRecordDto | null>
  listExportJobs: (request?: ExportListJobsRequest) => Promise<ExportJobListResponse>
  getExportJob: (jobId: string) => Promise<ExportJobRecordDto | null>
  getExportJobItems: (request: ExportGetJobItemsRequest) => Promise<ExportJobItemsResponse>
  verifyExportJob: (jobId: string) => Promise<ExportJobRecordDto | null>
  onExportProgress: (listener: (event: ExportProgressEvent) => void) => () => void
  selectBackupDirectory: (
    request?: BackupSelectDirectoryRequest
  ) => Promise<BackupSelectDirectoryResponse>
  configureBackupDestination: (
    request: BackupConfigureDestinationRequest
  ) => Promise<BackupDestinationRecordDto>
  listBackupDestinations: (
    request?: BackupListDestinationsRequest
  ) => Promise<BackupListDestinationsResponse>
  getBackupSummary: () => Promise<BackupSummaryDto>
  startBackup: (request: BackupStartRequest) => Promise<BackupJobRecordDto>
  pauseBackup: (jobId: string) => Promise<BackupJobActionResponse>
  resumeBackup: (jobId: string, recoverySecret?: string) => Promise<BackupJobRecordDto>
  cancelBackup: (jobId: string) => Promise<BackupJobActionResponse>
  getActiveBackupJob: () => Promise<BackupJobRecordDto | null>
  listBackupJobs: (request?: BackupListJobsRequest) => Promise<BackupListJobsResponse>
  getBackupJob: (jobId: string) => Promise<BackupJobRecordDto | null>
  listRecoveryPoints: (
    request: BackupListRecoveryPointsRequest
  ) => Promise<BackupListRecoveryPointsResponse>
  verifyRecoveryPoint: (
    request: BackupVerifyRecoveryPointRequest
  ) => Promise<BackupVerifyRecoveryPointResponse>
  restoreRecoveryPoint: (request: BackupRestoreRequest) => Promise<BackupRestoreResponse>
  recoverCatalogFromVault: (
    request: BackupRecoverCatalogRequest
  ) => Promise<BackupRecoverCatalogResponse>
  getGoogleDriveAuthStatus: () => Promise<BackupGoogleDriveAuthStatusDto>
  connectGoogleDrive: () => Promise<BackupGoogleDriveAuthStatusDto>
  disconnectGoogleDrive: () => Promise<BackupGoogleDriveAuthStatusDto>
  listGoogleDriveFolders: (
    request?: BackupGoogleDriveListFoldersRequest
  ) => Promise<BackupGoogleDriveListFoldersResponse>
  createGoogleDriveFolder: (
    request: BackupGoogleDriveCreateFolderRequest
  ) => Promise<BackupGoogleDriveFolderDto>
  onBackupProgress: (listener: (event: BackupProgressEvent) => void) => () => void
  getUpdateState: () => Promise<UpdateStateDto>
  checkForUpdates: () => Promise<UpdateActionResponseDto>
  installUpdateNow: () => Promise<UpdateActionResponseDto>
  deferUpdate: () => Promise<UpdateActionResponseDto>
  dismissUpdateError: () => Promise<UpdateActionResponseDto>
  onUpdateState: (listener: (state: UpdateStateDto) => void) => () => void
}

declare global {
  interface Window {
    api: VaultApi
  }
}
