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
  SemanticIndexJobItemsResponse,
  PhotoMetadataProgressResponse,
  StartPhotoMetadataExtractionRequest,
  GetPhotoMetadataDetailRequest,
  GetPhotoMetadataDetailResponse,
  GetPhotoMetadataFacetsRequest,
  GetPhotoMetadataFacetsResponse,
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
  searchPhotosSemantic: (request: SemanticSearchRequest) => Promise<SemanticSearchResponse>
  cancelPhotosSemanticSearch: (
    request?: SemanticSearchCancelRequest
  ) => Promise<SemanticSearchCancelResponse>
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
}

declare global {
  interface Window {
    api: VaultApi
  }
}
