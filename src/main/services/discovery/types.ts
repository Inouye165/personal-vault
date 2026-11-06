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

export type DiscoveryStatus = 'completed' | 'cancelled'

export interface DiscoveryStats {
  readonly rootsRequested: number
  readonly directoriesVisited: number
  readonly candidatesFound: number
  readonly skippedCount: number
  readonly errorCount: number
}

export interface DiscoveryResult {
  readonly status: DiscoveryStatus
  readonly candidates: readonly DiscoveredCandidate[]
  readonly skips: readonly DiscoverySkip[]
  readonly errors: readonly DiscoveryError[]
  readonly stats: DiscoveryStats
}

export interface DiscoveryOptions {
  readonly roots: readonly string[]
  readonly policy?: DiscoveryPolicyConfig
  readonly fsAdapter?: ReadOnlyFsAdapter
  readonly signal?: AbortSignal
  readonly onCandidate?: (candidate: DiscoveredCandidate) => void
}
