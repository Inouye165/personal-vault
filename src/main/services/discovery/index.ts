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
  isPathOrAncestorExcluded,
  normalizePathForComparison,
  resolveDiscoveryPolicy,
  type DirectoryDecision,
  type DiscoveryPolicyConfig,
  type FileDecision,
  type ResolvedDiscoveryPolicy
} from './policy'
export {
  BoundedFifoQueue,
  DEFAULT_MAX_COLLECTED_RECORDS,
  DEFAULT_MAX_PENDING_DIRECTORIES,
  DEFAULT_MAX_VISITED_DIRECTORIES,
  discoverFiles,
  isInsideApprovedRoot,
  scanSourceRoots
} from './scanner'
export type {
  DiscoveredCandidate,
  DiscoveryError,
  DiscoveryErrorCode,
  DiscoveryEvent,
  DiscoveryLimitKind,
  DiscoveryLimitReached,
  DiscoveryOptions,
  DiscoveryResourceLimits,
  DiscoveryResult,
  DiscoverySkip,
  DiscoverySkipReason,
  DiscoveryStats,
  DiscoveryStatus,
  DiscoverySummary
} from './types'
