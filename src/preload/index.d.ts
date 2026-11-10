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
  CancelThumbnailRequest,
  CancelThumbnailResponse,
  PhotosDiagnosticsResponse,
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
  SemanticIndexJobItemsResponse
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
  cancelThumbnail: (request: CancelThumbnailRequest) => Promise<CancelThumbnailResponse>
  getPhotosDiagnostics: () => Promise<PhotosDiagnosticsResponse>
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
}

declare global {
  interface Window {
    api: VaultApi
  }
}
