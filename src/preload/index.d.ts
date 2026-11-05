import type { AppInfo, NavigationTab, VaultStatus } from '../shared/validation/ipc-schemas.js'

export interface VaultApi {
  getAppInfo: () => Promise<AppInfo>
  getVaultStatus: () => Promise<VaultStatus>
  setTab: (tab: NavigationTab) => Promise<boolean>
}

declare global {
  interface Window {
    api: VaultApi
  }
}
