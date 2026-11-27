import type { ItemKind } from '../../../shared/types/domain'
import type { ReadOnlyFsAdapter } from './fs-adapter'
import type { DiscoveryPolicyConfig } from './policy'

/**
 * Candidate file discovered by read-only filesystem traversal.
 *
 * Stage 2A note:
 * - `candidateKind` is derived from extension policy only; it does NOT claim the file
 *   has been content-verified or decoded.
 * - Content hashing (SHA-256) and embedded metadata (EXIF/document extraction) belong
 *   to subsequent tasks; metadata-only discovery is not a complete immutable file snapshot.
 */
export interface DiscoveredCandidate {
  readonly rootPath: string
  readonly absolutePath: string
  readonly fileName: string
  readonly extension: string
  readonly candidateKind: ItemKind
  readonly byteSize: number
  /**
   * ISO 8601 filesystem creation (birth) timestamp when reliably reported by the OS,
   * or `null` when absent, zero/epoch, or invalid. Never fabricated from `mtime`.
   */
  readonly filesystemCreatedAt: string | null
  /**
   * ISO 8601 filesystem modification timestamp when reliably reported by the OS,
   * or `null` when absent or invalid.
   */
  readonly filesystemModifiedAt: string | null
}

export type DiscoverySkipReason =
  | 'excluded_directory'
  | 'hidden_or_system_entry'
  | 'software_clutter_directory'
  | 'software_clutter_file'
  | 'symbolic_link_or_junction'
  | 'outside_approved_root'
  | 'unsupported_extension'
  | 'non_regular_entry'

export interface DiscoverySkip {
  readonly path: string
  readonly reason: DiscoverySkipReason
  readonly detail: string
}

export type DiscoveryErrorCode =
  | 'root_not_found'
  | 'root_not_directory'
  | 'permission_denied'
  | 'entry_disappeared'
  | 'unreadable_directory'
  | 'unreadable_entry'

export interface DiscoveryError {
  readonly path: string
  readonly code: DiscoveryErrorCode
  readonly message: string
  readonly errno?: string
}

export type DiscoveryEvent =
  | { readonly kind: 'candidate'; readonly candidate: DiscoveredCandidate }
  | { readonly kind: 'skip'; readonly skip: DiscoverySkip }
  | { readonly kind: 'error'; readonly error: DiscoveryError }

export type DiscoveryStatus = 'completed' | 'cancelled' | 'resource_limit_reached'

export type DiscoveryLimitKind =
  'maxPendingDirectories' | 'maxVisitedDirectories' | 'maxCollectedRecords'

export interface DiscoveryLimitReached {
  readonly limit: DiscoveryLimitKind
  readonly maxAllowed: number
  readonly observed: number
  readonly message: string
}

export interface DiscoveryResourceLimits {
  /**
   * Maximum number of pending subdirectories held in the traversal queue at one time.
   * Defaults to `DEFAULT_MAX_PENDING_DIRECTORIES` (10,000).
   */
  readonly maxPendingDirectories?: number
  /**
   * Maximum total directories opened across the scan.
   * Defaults to `DEFAULT_MAX_VISITED_DIRECTORIES` (100,000).
   */
  readonly maxVisitedDirectories?: number
  /**
   * Maximum total records (`candidates + skips + errors`) retained by the bounded
   * `discoverFiles` collector. Not used by streaming `scanSourceRoots`.
   * Defaults to `DEFAULT_MAX_COLLECTED_RECORDS` (50,000).
   */
  readonly maxCollectedRecords?: number
}

export interface DiscoveryStats {
  readonly rootsRequested: number
  readonly directoriesVisited: number
  readonly candidatesFound: number
  readonly skippedCount: number
  readonly errorCount: number
}

export interface DiscoverySummary {
  readonly status: DiscoveryStatus
  readonly stats: DiscoveryStats
  readonly limitReached?: DiscoveryLimitReached
}

export interface DiscoveryResult extends DiscoverySummary {
  readonly candidates: readonly DiscoveredCandidate[]
  readonly skips: readonly DiscoverySkip[]
  readonly errors: readonly DiscoveryError[]
}

export interface DiscoveryOptions {
  readonly roots: readonly string[]
  readonly policy?: DiscoveryPolicyConfig
  readonly limits?: DiscoveryResourceLimits
  readonly fsAdapter?: ReadOnlyFsAdapter
  readonly signal?: AbortSignal
  readonly onEvent?: (event: DiscoveryEvent) => void | Promise<void>
  readonly onCandidate?: (candidate: DiscoveredCandidate) => void | Promise<void>
}
