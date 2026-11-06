export {
  createNodeReadOnlyFsAdapter,
  type ReadOnlyDirEntry,
  type ReadOnlyDirHandle,
  type ReadOnlyFsAdapter,
  type ReadOnlyFsStats
} from './fs-adapter'
export {
  DEFAULT_DOCUMENT_EXTENSIONS,
  DEFAULT_HIDDEN_AND_SYSTEM_NAMES,
  DEFAULT_PHOTO_EXTENSIONS,
  DEFAULT_SOFTWARE_CLUTTER_DIRECTORY_NAMES,
  DEFAULT_SOFTWARE_CLUTTER_FILE_NAMES,
  evaluateDirectoryEntry,
  evaluateFileEntry,
  normalizePathForComparison,
  resolveDiscoveryPolicy,
  type DirectoryDecision,
  type DiscoveryPolicyConfig,
  type FileDecision,
  type ResolvedDiscoveryPolicy
} from './policy'
export { discoverFiles, isInsideApprovedRoot } from './scanner'
export type {
  DiscoveredCandidate,
  DiscoveryError,
  DiscoveryErrorCode,
  DiscoveryOptions,
  DiscoveryResult,
  DiscoverySkip,
  DiscoverySkipReason,
  DiscoveryStats,
  DiscoveryStatus
} from './types'
