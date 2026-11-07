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
  SetDuplicateReviewResponse
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
}

declare global {
  interface Window {
    api: VaultApi
  }
}
