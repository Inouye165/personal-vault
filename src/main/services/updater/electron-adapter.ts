import { autoUpdater } from 'electron-updater'
import type { UpdaterAdapter, UpdaterLogger } from './coordinator'

export function createElectronUpdaterAdapter(): UpdaterAdapter {
  return {
    get autoDownload() {
      return autoUpdater.autoDownload
    },
    set autoDownload(value: boolean) {
      autoUpdater.autoDownload = value
    },
    get autoInstallOnAppQuit() {
      return autoUpdater.autoInstallOnAppQuit
    },
    set autoInstallOnAppQuit(value: boolean) {
      autoUpdater.autoInstallOnAppQuit = value
    },
    get allowDowngrade() {
      return autoUpdater.allowDowngrade
    },
    set allowDowngrade(value: boolean) {
      autoUpdater.allowDowngrade = value
    },
    get forceDevUpdateConfig() {
      return autoUpdater.forceDevUpdateConfig
    },
    set forceDevUpdateConfig(value: boolean) {
      autoUpdater.forceDevUpdateConfig = value
    },
    get requestHeaders() {
      return (autoUpdater.requestHeaders as Record<string, string> | null) ?? null
    },
    set requestHeaders(value: Record<string, string> | null) {
      autoUpdater.requestHeaders = value
    },
    get logger(): UpdaterLogger | null {
      return autoUpdater.logger
    },
    set logger(value: UpdaterLogger | null) {
      autoUpdater.logger = value
    },
    setFeedURL(options) {
      autoUpdater.setFeedURL(options)
    },
    checkForUpdates() {
      return autoUpdater.checkForUpdates()
    },
    downloadUpdate() {
      return autoUpdater.downloadUpdate()
    },
    quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean) {
      autoUpdater.quitAndInstall(isSilent, isForceRunAfter)
    },
    on(event, listener) {
      autoUpdater.on(event as Parameters<typeof autoUpdater.on>[0], listener as never)
    },
    off(event, listener) {
      autoUpdater.off(event as Parameters<typeof autoUpdater.off>[0], listener as never)
    }
  }
}
