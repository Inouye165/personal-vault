import { app, ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/contracts/channels.js'
import {
  AppInfoSchema,
  NavigationTabSchema,
  VaultStatusSchema,
  validatePayload,
  type AppInfo,
  type VaultStatus
} from '../../shared/validation/ipc-schemas.js'

let currentTab = 'all'

export function getCurrentTab(): string {
  return currentTab
}

export function registerIpcHandlers(): void {
  // Handler for retrieving application information
  ipcMain.handle(IPC_CHANNELS.APP_GET_INFO, (): AppInfo => {
    const rawData = {
      name: 'Personal Vault',
      version: app.getVersion() || '0.1.0',
      platform: process.platform,
      isPackaged: app.isPackaged
    }
    const result = validatePayload(AppInfoSchema, rawData)
    if (!result.success) {
      throw new Error(`Failed to validate AppInfo in main process: ${result.error}`)
    }
    return result.data
  })

  // Handler for vault status: honest representation of Stage 1 state
  ipcMain.handle(IPC_CHANNELS.VAULT_GET_STATUS, (): VaultStatus => {
    const rawStatus = {
      sourceCount: 0,
      itemCount: 0,
      isReady: true
    }
    const result = validatePayload(VaultStatusSchema, rawStatus)
    if (!result.success) {
      throw new Error(`Failed to validate VaultStatus in main process: ${result.error}`)
    }
    return result.data
  })

  // Handler for navigation tab updates
  ipcMain.handle(IPC_CHANNELS.NAVIGATE_SET_TAB, (_event, tab: unknown): boolean => {
    const result = validatePayload(NavigationTabSchema, tab)
    if (!result.success) {
      console.warn(`Invalid tab requested via IPC: ${result.error}`)
      return false
    }
    currentTab = result.data
    return true
  })
}
