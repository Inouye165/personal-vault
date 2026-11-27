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

export interface GpsBoundingBox {
  readonly minLat: number
  readonly maxLat: number
  readonly minLon: number
  readonly maxLon: number
}

export interface QueryFileLocationsOptions extends PaginationOptions {
  readonly sourceId?: number
  readonly category?: 'photo' | 'document'
  readonly hasActiveHash?: boolean
  readonly sha256?: string
  readonly ratingFilter?: 'all' | 'unrated' | '1' | '2' | '3' | '4' | '5'
  readonly flagFilter?: 'all' | 'none' | 'pick' | 'reject'
  readonly collectionId?: number | null
  // Stage 6C + metadata-aware SQL metadata filters
  readonly parserRecipeVersion?: string
  readonly captureDateFrom?: string | null
  readonly captureDateTo?: string | null
  readonly captureMonth?: number | null
  readonly captureDay?: number | null
  readonly includeUnknownCaptureDate?: boolean
  readonly gpsBounds?: GpsBoundingBox | null
  readonly userPlaceId?: number | null
  readonly userPlaceLabel?: string | null
  readonly cameraNormalized?: string | null
  readonly onlyUnknownCamera?: boolean
  readonly lensNormalized?: string | null
  readonly onlyUnknownLens?: boolean
  readonly minWidthPx?: number | null
  readonly minHeightPx?: number | null
  readonly includeUnknownDimensions?: boolean
  readonly fileTypeBasis?: 'detected_format' | 'filename_extension'
  readonly fileTypeValue?: string | null
  readonly onlyUnknownDetectedFormat?: boolean
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
  readonly isReadOnly?: boolean
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
  readonly isReadOnly: boolean
}

export interface RecoveredVaultCopyEntry {
  readonly sha256: string
  readonly byteSize: number
  readonly relativePath: string
  readonly manifestRelativePath: string
  readonly verifiedAtMs: number
  readonly createdAtMs: number
  readonly updatedAtMs: number
}

export interface RecoveredObservationEntry {
  readonly sha256: string
  readonly byteSize: number
  readonly filesystemBirthtimeMs: number | null
  readonly filesystemMtimeMs: number | null
  readonly inferredCaptureTimeMs: number | null
  readonly firstDiscoveredAtMs: number
  readonly lastSeenAtMs: number
  readonly hashVerifiedAtMs: number
  readonly isCurrent: boolean
}

export interface RecoveredFileLocationEntry {
  readonly sourceRootPath: string
  readonly normalizedSourceRootPath: string
  readonly originalPath: string
  readonly normalizedPath: string
  readonly fileName: string
  readonly extension: string
  readonly category: 'photo' | 'document'
  readonly currentObservation: RecoveredObservationEntry
  readonly observations: readonly RecoveredObservationEntry[]
}

export interface PopulateRecoveredCatalogInput {
  readonly vaultId: string
  readonly vaultPath: string
  readonly normalizedVaultPath: string
  readonly vaultName: string
  readonly vaultCreatedAtMs: number
  readonly recoveredAtMs: number
  readonly vaultCopies: readonly RecoveredVaultCopyEntry[]
  readonly fileLocations: readonly RecoveredFileLocationEntry[]
}

export interface PopulateRecoveredCatalogResult {
  readonly recoveredVaultCopies: number
  readonly recoveredSources: number
  readonly recoveredFileLocations: number
  readonly recoveredObservations: number
  readonly historicalObservations: number
}

export interface LocationReadResolutionContext {
  readonly locationId: number
  readonly sourceId: number
  readonly sourceRootPath: string
  readonly sourceKind: 'user' | 'recovery_manifest'
  readonly originalPath: string
  readonly byteSize: number
  readonly filesystemMtimeMs: number | null
  readonly activeHash: string | null
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

// Stage 6B: Semantic Embeddings & Resumable Semantic Index Types

export interface PhotoSemanticEmbeddingRecord {
  readonly id: number
  readonly fileId: number | null
  readonly fileLocationId: number
  readonly discoveryObservationId: number
  readonly contentSha256: string
  readonly contentRevision: string
  readonly sourcePath: string
  readonly observedByteSize: number
  readonly observedMtimeMs: number
  readonly modelId: string
  readonly modelCommit: string
  readonly modelManifestSha256: string
  readonly preprocessingVersion: string
  readonly embeddingDimensions: number
  readonly vector: Float32Array
  readonly width: number | null
  readonly height: number | null
  readonly createdAtMs: number
  readonly isCurrent: boolean
}

export interface SavePhotoSemanticEmbeddingInput {
  readonly fileId?: number | null
  readonly fileLocationId: number
  readonly discoveryObservationId: number
  readonly contentSha256: string
  readonly contentRevision: string
  readonly sourcePath: string
  readonly observedByteSize: number
  readonly observedMtimeMs: number
  readonly modelId: string
  readonly modelCommit: string
  readonly modelManifestSha256: string
  readonly preprocessingVersion: string
  readonly embeddingDimensions: number
  readonly vector: Float32Array
  readonly width?: number | null
  readonly height?: number | null
}

export interface SemanticIndexJobRecord {
  readonly id: string
  readonly status:
    'idle' | 'running' | 'paused' | 'completed' | 'cancelled' | 'interrupted' | 'failed'
  readonly modelId: string
  readonly modelCommit: string
  readonly modelManifestSha256: string
  readonly preprocessingVersion: string
  readonly totalPhotos: number
  readonly processedPhotos: number
  readonly reusedPhotos: number
  readonly unsupportedPhotos: number
  readonly failedPhotos: number
  readonly pendingPhotos: number
  readonly startedAtMs: number
  readonly updatedAtMs: number
  readonly completedAtMs: number | null
  readonly lastError: string | null
}

export interface CreateSemanticIndexJobInput {
  readonly jobId?: string
  readonly modelId: string
  readonly modelCommit: string
  readonly modelManifestSha256: string
  readonly preprocessingVersion: string
}

export interface SemanticIndexJobItem {
  readonly id: number
  readonly jobId: string
  readonly fileLocationId: number
  readonly originalPath: string
  readonly discoveryObservationId: number
  readonly expectedByteSize: number
  readonly expectedMtimeMs: number
  readonly status: 'pending' | 'completed' | 'reused' | 'unsupported' | 'failed' | 'skipped'
  readonly errorCode: string | null
  readonly errorMessage: string | null
  readonly updatedAtMs: number | null
}

export interface SemanticIndexCoverageResult {
  readonly totalCatalogPhotos: number
  readonly currentIndexedPhotos: number
}

// ==========================================
// Stage 6C: Photo Technical Metadata & SQL Filters Types
// ==========================================

export interface PhotoTechnicalMetadataRecord {
  readonly id: number
  readonly fileLocationId: number
  readonly discoveryObservationId: number
  readonly parserRecipeVersion: string
  readonly extractionStatus:
    'extracted' | 'no_metadata' | 'unsupported' | 'failed' | 'unavailable' | 'stale'
  readonly contentSha256: string | null
  readonly contentRevision: string
  readonly observedByteSize: number | null
  readonly observedMtimeMs: number | null
  readonly recordedExtension: string
  readonly detectedFormat: string | null
  readonly extensionFormatMismatch: boolean

  readonly encodedWidthPx: number | null
  readonly encodedHeightPx: number | null
  readonly exifOrientation: number | null
  readonly displayWidthPx: number | null
  readonly displayHeightPx: number | null

  readonly captureDateSourceTag: 'DateTimeOriginal' | 'DateTimeDigitized' | null
  readonly rawCaptureDateText: string | null
  readonly captureSubseconds: string | null
  readonly captureOffsetMinutes: number | null
  readonly captureOffsetText: string | null
  readonly captureTimezoneStatus:
    'offset_present' | 'local_wall_clock_unknown_tz' | 'invalid_offset' | 'unknown'
  readonly captureCalendarDate: string | null
  readonly captureYear: number | null
  readonly captureMonth: number | null
  readonly captureDay: number | null
  readonly captureLocalIso: string | null
  readonly captureUtcEpochMs: number | null
  readonly captureDateParseError: string | null
  readonly captureDateConflict: string | null

  readonly gpsStatus: 'present' | 'absent' | 'invalid'
  readonly gpsLatitude: number | null
  readonly gpsLongitude: number | null
  readonly gpsAltitudeM: number | null
  readonly gpsParseError: string | null

  readonly cameraMakeRaw: string | null
  readonly cameraModelRaw: string | null
  readonly cameraDisplay: string | null
  readonly cameraNormalized: string | null
  readonly lensMakeRaw: string | null
  readonly lensModelRaw: string | null
  readonly lensDisplay: string | null
  readonly lensNormalized: string | null

  readonly unknownTagCount: number
  readonly parserLimitsNote: string | null
  readonly rawMetadataJson: string | null
  readonly errorCode: string | null
  readonly errorMessage: string | null
  readonly createdAtMs: number
  readonly isCurrent: boolean
}

export interface SavePhotoTechnicalMetadataInput {
  readonly fileLocationId: number
  readonly discoveryObservationId: number
  readonly parserRecipeVersion: string
  readonly extractionStatus: 'extracted' | 'no_metadata' | 'unsupported' | 'failed' | 'unavailable'
  readonly contentSha256: string | null
  readonly contentRevision: string
  readonly observedByteSize: number | null
  readonly observedMtimeMs: number | null
  readonly recordedExtension: string
  readonly detectedFormat: string | null
  readonly extensionFormatMismatch: boolean

  readonly encodedWidthPx: number | null
  readonly encodedHeightPx: number | null
  readonly exifOrientation: number | null
  readonly displayWidthPx: number | null
  readonly displayHeightPx: number | null

  readonly captureDateSourceTag: 'DateTimeOriginal' | 'DateTimeDigitized' | null
  readonly rawCaptureDateText: string | null
  readonly captureSubseconds: string | null
  readonly captureOffsetMinutes: number | null
  readonly captureOffsetText: string | null
  readonly captureTimezoneStatus:
    'offset_present' | 'local_wall_clock_unknown_tz' | 'invalid_offset' | 'unknown'
  readonly captureCalendarDate: string | null
  readonly captureYear?: number | null
  readonly captureMonth?: number | null
  readonly captureDay?: number | null
  readonly captureLocalIso: string | null
  readonly captureUtcEpochMs: number | null
  readonly captureDateParseError: string | null
  readonly captureDateConflict: string | null

  readonly gpsStatus?: 'present' | 'absent' | 'invalid'
  readonly gpsLatitude?: number | null
  readonly gpsLongitude?: number | null
  readonly gpsAltitudeM?: number | null
  readonly gpsParseError?: string | null

  readonly cameraMakeRaw: string | null
  readonly cameraModelRaw: string | null
  readonly cameraDisplay: string | null
  readonly cameraNormalized: string | null
  readonly lensMakeRaw: string | null
  readonly lensModelRaw: string | null
  readonly lensDisplay: string | null
  readonly lensNormalized: string | null

  readonly unknownTagCount?: number
  readonly parserLimitsNote?: string | null
  readonly rawMetadataJson: string | null
  readonly errorCode: string | null
  readonly errorMessage: string | null
}

export interface PhotoMetadataCoverageResult {
  readonly parserRecipeVersion: string
  readonly totalPhotos: number
  readonly extractedCount: number
  readonly noMetadataCount: number
  readonly unsupportedCount: number
  readonly failedCount: number
  readonly unavailableCount: number
  readonly staleCount: number
  readonly unprocessedCount: number
}

export interface PhotoMetadataJobRecord {
  readonly id: string
  readonly status:
    'idle' | 'running' | 'paused' | 'completed' | 'cancelled' | 'interrupted' | 'failed'
  readonly parserRecipeVersion: string
  readonly totalPhotos: number
  readonly processedPhotos: number
  readonly extractedPhotos: number
  readonly absentMetadataPhotos: number
  readonly reusedPhotos: number
  readonly unsupportedPhotos: number
  readonly failedPhotos: number
  readonly unavailablePhotos: number
  readonly pendingPhotos: number
  readonly startedAtMs: number
  readonly updatedAtMs: number
  readonly completedAtMs: number | null
  readonly lastError: string | null
}

export interface CreatePhotoMetadataJobInput {
  readonly jobId?: string
  readonly parserRecipeVersion: string
  readonly retryFailed?: boolean
}

export interface PhotoMetadataJobItemRecord {
  readonly id: number
  readonly jobId: string
  readonly fileLocationId: number
  readonly originalPath: string
  readonly recordedExtension: string
  readonly discoveryObservationId: number
  readonly expectedByteSize: number
  readonly expectedMtimeMs: number | null
  readonly status:
    | 'pending'
    | 'extracted'
    | 'no_metadata'
    | 'reused'
    | 'unsupported'
    | 'failed'
    | 'unavailable'
    | 'skipped'
  readonly errorCode: string | null
  readonly errorMessage: string | null
  readonly updatedAtMs: number | null
}

export interface PhotoMetadataFacetItem {
  readonly normalizedValue: string
  readonly displayLabel: string
  readonly count: number
}

export interface GetPhotoMetadataFacetsOptions {
  readonly field: 'camera' | 'lens' | 'detected_format' | 'filename_extension'
  readonly parserRecipeVersion: string
  readonly search?: string
  readonly limit?: number
  readonly offset?: number
}

export interface PhotoMetadataFacetsResult {
  readonly field: 'camera' | 'lens' | 'detected_format' | 'filename_extension'
  readonly items: readonly PhotoMetadataFacetItem[]
  readonly unknownCount: number
  readonly unprocessedCount: number
  readonly offset: number
  readonly limit: number
  readonly hasMore: boolean
}

export interface SavedEventRecord {
  readonly id: number
  readonly name: string
  readonly normalizedName: string
  readonly dateFrom: string
  readonly dateTo: string
  readonly notes: string | null
  readonly createdAtMs: number
  readonly updatedAtMs: number
}

export interface SavedPlaceRecord {
  readonly id: number
  readonly name: string
  readonly normalizedName: string
  readonly minLat: number
  readonly maxLat: number
  readonly minLon: number
  readonly maxLon: number
  readonly centerLat: number
  readonly centerLon: number
  readonly radiusKm: number | null
  readonly notes: string | null
  readonly createdAtMs: number
  readonly updatedAtMs: number
}

export interface PhotoUserPlaceRecord {
  readonly id: number
  readonly fileLocationId: number
  readonly placeId: number | null
  readonly placeLabel: string
  readonly normalizedLabel: string
  readonly createdAtMs: number
  readonly updatedAtMs: number
}

export interface CameraLabelRecord {
  readonly id: number
  readonly cameraNormalized: string
  readonly label: string
  readonly normalizedLabel: string
  readonly createdAtMs: number
  readonly updatedAtMs: number
}

export interface PhotoTechnicalMetadataDetailResult {
  readonly fileLocationId: number
  readonly currentRevision: string
  readonly effectiveStatus:
    'unprocessed' | 'extracted' | 'no_metadata' | 'unsupported' | 'failed' | 'unavailable' | 'stale'
  readonly parserRecipeVersion: string
  readonly recordedExtension: string
  readonly historicalMetadataCount: number
  readonly currentMetadata: PhotoTechnicalMetadataRecord | null
  readonly userPlace?: PhotoUserPlaceRecord | null
  readonly cameraLabel?: CameraLabelRecord | null
}

// Stage 6D: Semantic Search
export interface SemanticSearchCatalogInput {
  readonly queryVector: Float32Array
  readonly filters?: QueryFileLocationsOptions
  readonly limit?: number
  readonly offset?: number
  readonly minScore?: number
  readonly modelId?: string
  readonly modelCommit?: string
  readonly modelManifestSha256?: string
  readonly preprocessingVersion?: string
}

export interface SemanticSearchCatalogResultItem {
  readonly photo: CatalogFileRecord
  readonly score: number
  readonly rank: number
}

export interface SemanticSearchCatalogResult {
  readonly items: readonly SemanticSearchCatalogResultItem[]
  readonly totalMatched: number
  readonly eligibleCount: number
  readonly unindexedCount: number
  readonly staleCount: number
  readonly corruptCount: number
  readonly offset: number
  readonly limit: number
  readonly hasMore: boolean
  readonly queryLatencyMs: number
}

export type PhotoThumbnailPrepStatus = 'ready' | 'unsupported' | 'unavailable' | 'failed'

export interface PhotoThumbnailPrepSummary {
  readonly totalPhotos: number
  readonly preparedPhotos: number
  readonly unsupportedPhotos: number
  readonly unavailablePhotos: number
  readonly failedPhotos: number
  readonly pendingPhotos: number
}

export interface PhotoThumbnailPrepCandidate {
  readonly fileLocationId: number
  readonly sourceId: number
  readonly sourceRootPath: string
  readonly sourceKind: 'user' | 'recovery_manifest'
  readonly originalPath: string
  readonly discoveryObservationId: number
  readonly byteSize: number
  readonly filesystemMtimeMs: number | null
  readonly activeHash: string | null
}

export interface PhotoThumbnailReadyStateRow {
  readonly fileLocationId: number
  readonly cacheKey: string | null
}

export interface UpsertPhotoThumbnailStateInput {
  readonly fileLocationId: number
  readonly discoveryObservationId: number
  readonly contentSha256: string | null
  readonly observedByteSize: number
  readonly observedMtimeMs: number | null
  readonly recipeVersion: string
  readonly cacheKey: string | null
  readonly status: PhotoThumbnailPrepStatus
  readonly errorCode?: string | null
  readonly errorMessage?: string | null
  readonly updatedAtMs?: number
}
