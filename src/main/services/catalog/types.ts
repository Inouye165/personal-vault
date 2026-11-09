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
  readonly journal?: import('../annotations/journal').AnnotationJournal
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
  readonly rating?: number | null
  readonly flag?: 'none' | 'pick' | 'reject'
  readonly annotationVersion?: number
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
  readonly ratingFilter?: 'all' | 'unrated' | '1' | '2' | '3' | '4' | '5'
  readonly flagFilter?: 'all' | 'none' | 'pick' | 'reject'
  readonly collectionId?: number | null
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

// Stage 4: Vault & Verified Import Types

export interface RegisterVaultInput {
  readonly vaultId: string
  readonly vaultPath: string
  readonly name: string
  readonly createdAtMs: number
}

export interface CatalogVaultRecord {
  readonly id: number
  readonly vaultId: string
  readonly vaultPath: string
  readonly normalizedVaultPath: string
  readonly name: string
  readonly createdAtMs: number
  readonly updatedAtMs: number
  readonly isActive: boolean
}

export interface RecordVaultCopyInput {
  readonly vaultId: string
  readonly sha256: string
  readonly byteSize: number
  readonly relativePath: string
  readonly manifestRelativePath: string
  readonly verifiedAtMs: number
}

export interface CatalogVaultCopyRecord {
  readonly id: number
  readonly vaultId: string
  readonly sha256: string
  readonly byteSize: number
  readonly relativePath: string
  readonly manifestRelativePath: string
  readonly verifiedAtMs: number
  readonly createdAtMs: number
  readonly updatedAtMs: number
}

export interface CreateVaultImportItemInput {
  readonly fileLocationId: number
  readonly discoveryObservationId: number
  readonly hashObservationId?: number | null
  readonly sha256: string
  readonly byteSize: number
}

export interface CreateVaultImportJobInput {
  readonly jobId: string
  readonly vaultId: string
  readonly totalFiles: number
  readonly totalBytes: number
  readonly items: readonly CreateVaultImportItemInput[]
}

export interface CatalogVaultImportJobRecord {
  readonly id: string
  readonly vaultId: string
  readonly status: 'running' | 'paused' | 'cancelled' | 'interrupted' | 'failed' | 'completed'
  readonly totalFiles: number
  readonly totalBytes: number
  readonly copiedFiles: number
  readonly copiedBytes: number
  readonly verifiedFiles: number
  readonly failedFiles: number
  readonly startedAtMs: number
  readonly completedAtMs: number | null
  readonly errorMessage: string | null
}

export interface UpdateVaultImportProgressInput {
  readonly jobId: string
  readonly copiedFiles: number
  readonly copiedBytes: number
  readonly verifiedFiles: number
  readonly failedFiles: number
  readonly status?: 'running' | 'paused' | 'cancelled' | 'interrupted' | 'failed' | 'completed'
  readonly errorMessage?: string | null
  readonly completedAtMs?: number | null
}

export interface UpdateVaultImportItemInput {
  readonly jobId: string
  readonly fileLocationId: number
  readonly status:
    'pending' | 'copying' | 'verifying' | 'completed' | 'failed' | 'cancelled' | 'skipped'
  readonly vaultCopyId?: number | null
  readonly errorCode?: string | null
  readonly errorMessage?: string | null
  readonly completedAtMs?: number | null
}

export interface GetImportCandidatesOptions extends PaginationOptions {
  readonly vaultId: string
  readonly filter?: 'all' | 'unimported' | 'imported'
  readonly category?: 'photo' | 'document'
}

export interface ImportCandidateItem {
  readonly fileLocationId: number
  readonly sourceId: number
  readonly originalPath: string
  readonly fileName: string
  readonly extension: string
  readonly category: 'photo' | 'document'
  readonly byteSize: number
  readonly filesystemBirthtimeMs: number | null
  readonly filesystemMtimeMs: number | null
  readonly inferredCaptureTimeMs: number | null
  readonly firstDiscoveredAtMs: number
  readonly lastSeenAtMs: number
  readonly sha256: string
  readonly discoveryObservationId: number
  readonly hashObservationId: number
  readonly hashVerifiedAtMs: number
  readonly vaultStatus: 'not_imported' | 'copied'
  readonly vaultCopyId: number | null
  readonly isPreferred?: boolean
}

export type ImportCandidatesResult = PaginatedResult<ImportCandidateItem>

export interface VaultImportItemDetail {
  readonly fileLocationId: number
  readonly discoveryObservationId: number
  readonly hashObservationId: number | null
  readonly sha256: string
  readonly byteSize: number
  readonly status:
    'pending' | 'copying' | 'verifying' | 'completed' | 'failed' | 'cancelled' | 'skipped'
  readonly sourceId: number
  readonly originalPath: string
  readonly fileName: string
  readonly extension: string
  readonly category: 'photo' | 'document'
  readonly filesystemBirthtimeMs: number | null
  readonly filesystemMtimeMs: number | null
  readonly firstDiscoveredAtMs: number
  readonly lastSeenAtMs: number
  readonly inferredCaptureTimeMs: number | null
  readonly hashVerifiedAtMs: number | null
  readonly isDiscoveryCurrent: boolean
  readonly isHashActive: boolean
  readonly isPreferred?: boolean
}

// ==========================================
// Stage 5B: Photo Review & Collections Types
// ==========================================

export interface CreateCollectionInput {
  readonly name: string
}

export interface RenameCollectionInput {
  readonly collectionId: number
  readonly name: string
}

export interface CatalogCollectionRecord {
  readonly id: number
  readonly name: string
  readonly normalizedName: string
  readonly createdAtMs: number
  readonly updatedAtMs: number
  readonly photoCount?: number
  readonly persistencePending?: boolean
  readonly persistenceError?: string
}

export interface AddCollectionMemberInput {
  readonly collectionId: number
  readonly fileLocationId: number
  readonly expectedRevision: string
}

export interface RemoveCollectionMemberInput {
  readonly collectionId: number
  readonly fileLocationId: number
  readonly expectedRevision: string
}

export interface CatalogCollectionMembershipRecord {
  readonly id: number
  readonly collectionId: number
  readonly collectionName?: string
  readonly fileLocationId: number
  readonly createdAtMs: number
}

export interface SetPhotoAnnotationInput {
  readonly fileLocationId: number
  readonly expectedRevision: string
  readonly expectedVersion: number
  readonly rating: number | null
  readonly flag: 'none' | 'pick' | 'reject'
}

export interface CatalogPhotoAnnotationRecord {
  readonly id: number
  readonly fileLocationId: number
  readonly discoveryObservationId: number
  readonly contentSha256: string | null
  readonly rating: number | null
  readonly flag: 'none' | 'pick' | 'reject'
  readonly version: number
  readonly isCurrent: boolean
  readonly createdAtMs: number
  readonly updatedAtMs: number
  readonly persistencePending?: boolean
  readonly persistenceError?: string
}

// Stage 5C: Perceptual Hashing & Similarity Types

export interface PhotoPerceptualHashRecord {
  readonly id: number
  readonly fileLocationId: number
  readonly discoveryObservationId: number
  readonly contentSha256: string
  readonly contentRevision: string
  readonly algorithmVersion: string
  readonly fingerprint: string
  readonly bucket0: number
  readonly bucket1: number
  readonly bucket2: number
  readonly bucket3: number
  readonly width: number | null
  readonly height: number | null
  readonly createdAtMs: number
  readonly isCurrent: boolean
}

export interface SavePhotoPerceptualHashInput {
  readonly fileLocationId: number
  readonly discoveryObservationId: number
  readonly contentSha256: string
  readonly contentRevision: string
  readonly algorithmVersion: string
  readonly fingerprint: string
  readonly bucket0: number
  readonly bucket1: number
  readonly bucket2: number
  readonly bucket3: number
  readonly width?: number | null
  readonly height?: number | null
}

export interface SimilarityDecisionRecord {
  readonly id: number
  readonly locationIdA: number
  readonly locationIdB: number
  readonly contentRevisionA: string
  readonly contentRevisionB: string
  readonly decision: 'edited_version' | 'similar_scene' | 'unrelated'
  readonly version: number
  readonly createdAtMs: number
  readonly updatedAtMs: number
  readonly isCurrent: boolean
  readonly persistencePending?: boolean
}

export interface SetSimilarityDecisionInput {
  readonly locationIdA: number
  readonly locationIdB: number
  readonly expectedRevisionA: string
  readonly expectedRevisionB: string
  readonly decision: 'edited_version' | 'similar_scene' | 'unrelated' | 'unreviewed'
  readonly expectedVersion?: number
}

export interface SimilarityJobRecord {
  readonly jobId: string
  readonly status:
    'idle' | 'running' | 'paused' | 'cancelled' | 'interrupted' | 'completed' | 'failed'
  readonly algorithmVersion: string
  readonly totalPhotos: number
  readonly processedPhotos: number
  readonly errorPhotos: number
  readonly unsupportedPhotos: number
  readonly candidatePairsFound: number
  readonly startedAtMs: number
  readonly updatedAtMs: number
  readonly completedAtMs: number | null
}

export interface CreateSimilarityJobInput {
  readonly jobId: string
  readonly algorithmVersion: string
  readonly totalPhotos: number
  readonly photoLocationIds: readonly number[]
}

export interface SimilarityJobItemRecord {
  readonly id: number
  readonly jobId: string
  readonly fileLocationId: number
  readonly status: 'pending' | 'processed' | 'skipped' | 'error' | 'unsupported'
  readonly errorMessage: string | null
  readonly updatedAtMs: number
}

export interface SimilarityCandidatePairRecord {
  readonly id: number
  readonly jobId: string
  readonly locationIdA: number
  readonly locationIdB: number
  readonly distance: number
  readonly similarityScore: number
  readonly algorithmVersion: string
  readonly createdAtMs: number
  readonly decision?: 'edited_version' | 'similar_scene' | 'unrelated' | 'unreviewed'
  readonly decisionVersion?: number | null
  readonly decisionUpdatedAtMs?: number | null
}
