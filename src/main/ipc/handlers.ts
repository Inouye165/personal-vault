import { app, ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/contracts/channels'
import {
  AppInfoSchema,
  NavigationTabSchema,
  VaultStatusSchema,
  validatePayload,
  type AppInfo,
  type VaultStatus
} from '../../shared/validation/ipc-schemas'
import type { IpcSenderEvent, SenderValidator } from './sender'

export interface IpcHandlerOptions {
  readonly validateSender: SenderValidator
}

export function registerIpcHandlers({ validateSender }: IpcHandlerOptions): void {
  const handle = <Args extends unknown[], Result>(
    channel: string,
    fn: (...args: Args) => Result
  ): void => {
    ipcMain.handle(channel, (event, ...args) => {
      if (!validateSender(event as IpcSenderEvent)) {
        throw new Error(`Unauthorized IPC sender for ${channel}`)
      }
      return fn(...(args as Args))
    })
  }

  handle(IPC_CHANNELS.APP_GET_INFO, (): AppInfo => {
    const result = validatePayload(AppInfoSchema, {
      name: 'Personal Vault',
      version: app.getVersion(),
      platform: process.platform,
      isPackaged: app.isPackaged
    })
    if (!result.success) throw new Error(`Invalid AppInfo in main process: ${result.error}`)
    return result.data
  })

  // Stage 1 has no sources or catalog, so the status is honestly empty.
  handle(IPC_CHANNELS.VAULT_GET_STATUS, (): VaultStatus => {
    const result = validatePayload(VaultStatusSchema, {
      sourceCount: 0,
      itemCount: 0,
      isReady: true
    })
    if (!result.success) throw new Error(`Invalid VaultStatus in main process: ${result.error}`)
    return result.data
  })

  handle(IPC_CHANNELS.NAVIGATE_SET_TAB, (tab: unknown): boolean => {
    return validatePayload(NavigationTabSchema, tab).success
  })
}
