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
  CancelImportRequest
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
}

declare global {
  interface Window {
    api: VaultApi
  }
}
