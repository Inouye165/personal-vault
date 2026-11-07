import type {
  AppInfo,
  NavigationTab,
  VaultStatus,
  SelectRootsResponse,
  StartScanRequest,
  JobActionResponse,
  GetActiveJobResponse,
  ScanJobProgress
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
  onScanProgress: (callback: (progress: ScanJobProgress) => void) => () => void
}

declare global {
  interface Window {
    api: VaultApi
  }
}
