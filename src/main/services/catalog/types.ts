/**
 * Personal Vault — Catalog Persistence Contracts (Stage 2C)
 *
 * Defines domain models, database options, batch inputs, and query contracts
 * for the SQLite catalog storage service.
 */

export interface CatalogDatabaseOptions {
  /**
   * Absolute path to the SQLite catalog database file on disk.
   */
  readonly catalogPath: string

  /**
   * Whether foreign key constraints are enforced.
   * Defaults to true.
   */
  readonly enableForeignKeyConstraints?: boolean

  /**
   * Busy timeout in milliseconds for database locks.
   * Defaults to 5000 ms.
   */
  readonly timeoutMs?: number

  /**
   * Whether the database should be opened in read-only mode.
   * Defaults to false.
   */
  readonly readOnly?: boolean
}

export interface SourceRecord {
  readonly id: number
  readonly rootPath: string
  readonly normalizedRootPath: string
  readonly createdAtMs: number
  readonly updatedAtMs: number
}

export interface CatalogFileRecord {
  readonly id: number
  readonly sourceId: number
  readonly originalPath: string
  readonly normalizedPath: string
  readonly fileName: string
  readonly extension: string
  readonly category: 'photo' | 'document'
  readonly discoveryObservationId: number
  readonly byteSize: number
  readonly filesystemBirthtimeMs: number | null
  readonly filesystemMtimeMs: number | null
  readonly inferredCaptureTimeMs: number | null
  readonly firstDiscoveredAtMs: number
  readonly lastSeenAtMs: number
  readonly activeHash: string | null
  readonly activeHashVerifiedAtMs: number | null
}

export interface DiscoveryObservationRecord {
  readonly id: number
  readonly fileLocationId: number
  readonly byteSize: number
  readonly filesystemBirthtimeMs: number | null
  readonly filesystemMtimeMs: number | null
  readonly inferredCaptureTimeMs: number | null
  readonly observedAtMs: number
  readonly lastSeenAtMs: number
  readonly isCurrent: boolean
}

export interface HashObservationRecord {
  readonly id: number
  readonly fileLocationId: number
  readonly discoveryObservationId: number
  readonly sha256: string
  readonly observedByteSize: number
  readonly observedMtimeMs: number | null
  readonly hashedAtMs: number
  readonly isActive: boolean
}

export interface DiscoveryCandidateInput {
  readonly originalPath: string
  readonly fileName: string
  readonly extension: string
  readonly byteSize: number
  readonly birthtimeMs: number | null
  readonly mtimeMs: number | null
  readonly discoveredAtMs: number
  readonly category: 'photo' | 'document'
}

export interface RecordHashObservationInput {
  readonly originalPath: string
  readonly sha256: string
  readonly observedByteSize: number
  readonly observedMtimeMs: number | null
  readonly hashedAtMs: number
}

export interface BatchPersistenceResult {
  readonly insertedCount: number
  readonly updatedCount: number
  readonly unchangedCount: number
  readonly invalidatedHashCount: number
}

export interface PaginationOptions {
  readonly offset?: number
  readonly limit?: number
}

export interface QueryFileLocationsOptions extends PaginationOptions {
  readonly sourceId?: number
  readonly category?: 'photo' | 'document'
  readonly hasActiveHash?: boolean
  readonly sha256?: string
}

export type ScanJobStatus =
  'running' | 'paused' | 'cancelled' | 'interrupted' | 'failed' | 'completed'

export type ScanJobPhase = 'discovery' | 'hashing' | 'completed'

export interface ScanJobRecord {
  readonly id: number
  readonly status: ScanJobStatus
  readonly phase: ScanJobPhase
  readonly roots: readonly string[]
  readonly discoveredCount: number
  readonly hashedCount: number
  readonly totalFilesToHash: number
  readonly totalBytes: number
  readonly hashedBytes: number
  readonly skippedCount: number
  readonly errorCount: number
  readonly errorMessage: string | null
  readonly isDismissed: boolean
  readonly createdAtMs: number
  readonly updatedAtMs: number
  readonly startedAtMs: number
  readonly completedAtMs: number | null
}

export interface ScanJobErrorRecord {
  readonly id: number
  readonly jobId: number
  readonly path: string
  readonly code: string
  readonly message: string
  readonly phase: 'discovery' | 'hashing'
  readonly occurredAtMs: number
}

export interface CreateScanJobInput {
  readonly roots: readonly string[]
  readonly nowMs?: number
}

export interface UpdateScanJobProgressInput {
  readonly phase?: ScanJobPhase
  readonly discoveredCount?: number
  readonly hashedCount?: number
  readonly totalFilesToHash?: number
  readonly totalBytes?: number
  readonly hashedBytes?: number
  readonly skippedCount?: number
  readonly errorCount?: number
  readonly nowMs?: number
}

export interface RecordScanJobErrorInput {
  readonly path: string
  readonly code: string
  readonly message: string
  readonly phase: 'discovery' | 'hashing'
  readonly occurredAtMs?: number
}

export interface UnhashedFileRecord {
  readonly fileLocationId: number
  readonly discoveryObservationId: number
  readonly originalPath: string
  readonly byteSize: number
  readonly filesystemBirthtimeMs: number | null
  readonly filesystemMtimeMs: number | null
}

export interface UnhashedCountResult {
  readonly count: number
  readonly totalBytes: number
}

export interface UnhashedFilesOptions extends PaginationOptions {
  readonly afterId?: number
}

export type DuplicateReviewStatus = 'unreviewed' | 'reviewed'
export type DuplicateReviewFilter = 'all' | 'unreviewed' | 'reviewed'

export interface DuplicateGroupOptions extends PaginationOptions {
  readonly maxLocationsPerGroup?: number
  readonly filter?: DuplicateReviewFilter
}

export interface PaginatedResult<T> {
  readonly items: readonly T[]
  readonly totalCount: number
  readonly offset: number
  readonly limit: number
  readonly hasMore: boolean
}

export interface DuplicateGroup {
  readonly sha256: string
  readonly byteSize: number
  readonly fileCount: number
  readonly groupSignature: string
  readonly reviewStatus: DuplicateReviewStatus
  readonly preferredLocationId: number | null
  readonly hasStaleDecision: boolean
  readonly reviewedAtMs: number | null
  readonly locations: readonly CatalogFileRecord[]
  readonly truncatedLocations: boolean
}

export interface DuplicateMemberRecord {
  readonly fileLocationId: number
  readonly sourceId: number
  readonly originalPath: string
  readonly normalizedPath: string
  readonly fileName: string
  readonly extension: string
  readonly category: 'photo' | 'document'
  readonly byteSize: number
  readonly filesystemBirthtimeMs: number | null
  readonly filesystemMtimeMs: number | null
  readonly inferredCaptureTimeMs: number | null
  readonly firstDiscoveredAtMs: number
  readonly lastSeenAtMs: number
  readonly discoveryObservationId: number
  readonly hashObservationId: number
  readonly activeHash: string
  readonly activeHashVerifiedAtMs: number
  readonly isPreferred: boolean
}

export interface DuplicateGroupMembersOptions extends PaginationOptions {
  readonly sha256: string
  readonly byteSize: number
}

export interface DuplicateGroupMembersResult extends PaginatedResult<DuplicateMemberRecord> {
  readonly sha256: string
  readonly byteSize: number
  readonly groupSignature: string
  readonly reviewStatus: DuplicateReviewStatus
  readonly preferredLocationId: number | null
  readonly hasStaleDecision: boolean
  readonly reviewedAtMs: number | null
}

export interface SetDuplicateReviewInput {
  readonly sha256: string
  readonly byteSize: number
  readonly status: DuplicateReviewStatus
  readonly preferredLocationId?: number | null
  readonly expectedGroupSignature: string
}

export interface DuplicateReviewRecord {
  readonly sha256: string
  readonly byteSize: number
  readonly status: DuplicateReviewStatus
  readonly preferredLocationId: number | null
  readonly groupSignature: string
  readonly reviewedAtMs: number
}

export interface CatalogStats {
  readonly totalSources: number
  readonly totalFiles: number
  readonly totalPhotos: number
  readonly totalDocuments: number
  readonly totalBytes: number
  readonly hashedFiles: number
  readonly unhashedFiles: number
}
