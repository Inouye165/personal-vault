export {
  resolveFeedConfiguration,
  sanitizeUpdateErrorMessage,
  UpdateCoordinator,
  type BackupJobDrain,
  type ResolvedFeedConfiguration,
  type UpdateCoordinatorOptions,
  type UpdaterAdapter,
  type UpdaterLogger,
  type UpdaterProgressInfo,
  type UpdaterVersionInfo,
  type VaultWriteDrain
} from './coordinator'
export { createElectronUpdaterAdapter } from './electron-adapter'
