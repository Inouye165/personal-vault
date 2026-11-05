import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/contracts/channels.js'
import {
  AppInfoSchema,
  NavigationTabSchema,
  TabAckSchema,
  VaultStatusSchema,
  validatePayload,
  type AppInfo,
  type NavigationTab,
  type VaultStatus
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
  }
}

// A failure here is deliberately not swallowed: Electron reports it as a preload error.
contextBridge.exposeInMainWorld('api', api)
