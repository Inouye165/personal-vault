/**
 * Personal Vault — SQLite Catalog Persistence Service (Stage 2C)
 *
 * Implements an app-owned, modular SQLite database repository.
 * Stores source inventory, original file locations, immutable discovery facts,
 * and successful SHA-256 observations with clear relationships.
 *
 * All operations use parameterized SQL, foreign-key constraints,
 * and transactional batch execution with rollback on failure.
 */

import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { dirname } from 'node:path'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { checkSchemaCompatibility, runMigrations } from './migrations'
import { normalizePathForLookup } from './path-normalization'
import { DocumentRepository } from './document-repository'
import { DocumentOcrRepository } from './document-ocr-repository'
import { DocumentSemanticRepository } from './document-semantic-repository'
import { DocumentClassificationRepository } from './document-classification-repository'
import { ExportRepository } from './export-repository'
import { BackupRepository } from './backup-repository'
import type {
  DocumentDetailItem,
  GetDocumentExtensionFacetsRequest,
  GetDocumentExtensionFacetsResponse,
  GetDocumentsPageRequest,
  GetDocumentsPageResponse
} from '../../../shared/validation/document-schemas'
import {
  DatabaseClosedError,
  FileLocationNotFoundError,
  FileMetadataConflictError,
  DuplicateGroupNotFoundError,
  StaleReviewError,
  InvalidPreferredLocationError
} from './errors'
import type {
  CatalogDatabaseOptions,
  CatalogFileRecord,
  CatalogStats,
  DiscoveryCandidateInput,
  DiscoveryObservationRecord,
  DuplicateGroup,
  DuplicateGroupOptions,
  DuplicateGroupMembersOptions,
  DuplicateGroupMembersResult,
  DuplicateMemberRecord,
  SetDuplicateReviewInput,
  DuplicateReviewRecord,
  HashObservationRecord,
  BatchPersistenceResult,
  CreateScanJobInput,
  PaginatedResult,
  PaginationOptions,
  QueryFileLocationsOptions,
  RecordHashObservationInput,
  RecordScanJobErrorInput,
  ScanJobErrorRecord,
  ScanJobPhase,
  ScanJobRecord,
  ScanJobStatus,
  SourceRecord,
  UnhashedCountResult,
  UnhashedFileRecord,
  UnhashedFilesOptions,
  UpdateScanJobProgressInput,
  RegisterVaultInput,
  CatalogVaultRecord,
  RecordVaultCopyInput,
  CatalogVaultCopyRecord,
  CreateVaultImportJobInput,
  CatalogVaultImportJobRecord,
  UpdateVaultImportProgressInput,
  UpdateVaultImportItemInput,
  GetImportCandidatesOptions,
  ImportCandidateItem,
  VaultImportItemDetail,
  ImportCandidatesResult,
  CreateCollectionInput,
  RenameCollectionInput,
  CatalogCollectionRecord,
  AddCollectionMemberInput,
  RemoveCollectionMemberInput,
  CatalogCollectionMembershipRecord,
  SetPhotoAnnotationInput,
  CatalogPhotoAnnotationRecord,
  PhotoPerceptualHashRecord,
  SavePhotoPerceptualHashInput,
  SimilarityDecisionRecord,
  SetSimilarityDecisionInput,
  SimilarityJobRecord,
  CreateSimilarityJobInput,
  SimilarityJobItemRecord,
  PhotoSemanticEmbeddingRecord,
  SavePhotoSemanticEmbeddingInput,
  SemanticIndexJobRecord,
  CreateSemanticIndexJobInput,
  SemanticIndexJobItem,
  SemanticIndexCoverageResult,
  PhotoTechnicalMetadataRecord,
  SavePhotoTechnicalMetadataInput,
  PhotoMetadataCoverageResult,
  PhotoMetadataJobRecord,
  CreatePhotoMetadataJobInput,
  PhotoMetadataJobItemRecord,
  GetPhotoMetadataFacetsOptions,
  PhotoMetadataFacetsResult,
  PhotoTechnicalMetadataDetailResult,
  SemanticSearchCatalogInput,
  SemanticSearchCatalogResult,
  PopulateRecoveredCatalogInput,
  PopulateRecoveredCatalogResult,
  LocationReadResolutionContext
} from './types'
import {
  validateAndSerializeEmbeddingVector,
  deserializeEmbeddingVector,
  isObservationTimestampMatching
} from '../semantic/vector'
export { isObservationTimestampMatching }
import { METADATA_LIMITS, METADATA_PARSER_RECIPE_VERSION } from '../metadata/types'
import { buildPhotoFilterClauses } from './photo-filter-sql'
import { SemanticSearchRepository } from './semantic-search-repository'
import type { AnnotationJournal } from '../annotations/journal'
import type {
  AnnotationJournalEntry,
  SimilarityCandidatePair,
  SimilarityDecisionType
} from '../../../shared/validation/ipc-schemas'

interface RawFileRow {
  id: number
  source_id: number
  original_path: string
  normalized_path: string
  file_name: string
  extension: string
  category: 'photo' | 'document'
  discovery_observation_id: number
  byte_size: number
  filesystem_birthtime_ms: number | null
  filesystem_mtime_ms: number | null
  inferred_capture_time_ms: number | null
  first_discovered_at_ms: number
  last_seen_at_ms: number
  active_hash: string | null
  active_hash_verified_at_ms: number | null
  annotation_rating?: number | null
  annotation_flag?: 'none' | 'pick' | 'reject' | null
  annotation_version?: number | null
}

interface RawObservationRow {
  id: number
  file_location_id: number
  byte_size: number
  filesystem_birthtime_ms: number | null
  filesystem_mtime_ms: number | null
  inferred_capture_time_ms: number | null
  observed_at_ms: number
  last_seen_at_ms: number
  is_current: number
}

interface RawHashRow {
  id: number
  file_location_id: number
  discovery_observation_id: number
  sha256: string
  observed_byte_size: number
  observed_mtime_ms: number | null
  hashed_at_ms: number
  is_active: number
}

interface RawSourceRow {
  id: number
  root_path: string
  normalized_root_path: string
  created_at_ms: number
  updated_at_ms: number
}

interface RawScanJobRow {
  id: number
  status: ScanJobStatus
  roots_json: string
  phase: ScanJobPhase
  discovered_count: number
  hashed_count: number
  total_files_to_hash: number
  total_bytes: number
  hashed_bytes: number
  skipped_count: number
  error_count: number
  error_message: string | null
  is_dismissed?: number
  created_at_ms: number
  updated_at_ms: number
  started_at_ms: number
  completed_at_ms: number | null
}

interface RawVaultRow {
  id: number
  vault_id: string
  vault_path: string
  normalized_vault_path: string
  name: string
  created_at_ms: number
  updated_at_ms: number
  is_active: number
  is_read_only: number
}

interface RawVaultCopyRow {
  id: number
  vault_id: string
  sha256: string
  byte_size: number
  relative_path: string
  manifest_relative_path: string
  verified_at_ms: number
  created_at_ms: number
  updated_at_ms: number
}

interface RawVaultImportRow {
  id: string
  vault_id: string
  status: 'running' | 'paused' | 'cancelled' | 'interrupted' | 'failed' | 'completed'
  total_files: number
  total_bytes: number
  copied_files: number
  copied_bytes: number
  verified_files: number
  failed_files: number
  started_at_ms: number
  completed_at_ms: number | null
  error_message: string | null
}

interface RawImportCandidateRow {
  file_location_id: number
  source_id: number
  original_path: string
  file_name: string
  extension: string
  category: 'photo' | 'document'
  byte_size: number
  filesystem_birthtime_ms: number | null
  filesystem_mtime_ms: number | null
  first_discovered_at_ms: number
  last_seen_at_ms: number
  inferred_capture_time_ms: number | null
  sha256: string
  discovery_observation_id: number
  hash_observation_id: number
  hashed_at_ms: number
  vault_copy_id: number | null
  vault_status: 'not_imported' | 'copied'
  is_preferred: number
}

interface RawVaultImportItemDetailRow {
  file_location_id: number
  discovery_observation_id: number
  hash_observation_id: number | null
  sha256: string
  byte_size: number
  status: 'pending' | 'copying' | 'verifying' | 'completed' | 'failed' | 'cancelled' | 'skipped'
  source_id: number
  original_path: string
  file_name: string
  extension: string
  category: 'photo' | 'document'
  filesystem_birthtime_ms: number | null
  filesystem_mtime_ms: number | null
  first_discovered_at_ms: number | null
  last_seen_at_ms: number | null
  inferred_capture_time_ms: number | null
  hashed_at_ms: number | null
  is_discovery_current: number | null
  is_hash_active: number | null
  is_preferred: number
}

interface RawScanJobErrorRow {
  id: number
  job_id: number
  path: string
  code: string
  message: string
  phase: 'discovery' | 'hashing'
  occurred_at_ms: number
}

export const MAX_BATCH_SIZE = 1000
export const DEFAULT_PAGE_LIMIT = 50
export const MAX_PAGE_LIMIT = 1000
export const DEFAULT_MAX_LOCATIONS_PER_GROUP = 50
export const MAX_LOCATIONS_PER_GROUP = 100

const SHA256_HEX_REGEX = /^[0-9a-fA-F]{64}$/

export function validateSafeInteger(
  value: unknown,
  paramName: string,
  min: number,
  max: number = Number.MAX_SAFE_INTEGER
): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new RangeError(
      `${paramName} must be a safe integer between ${min} and ${max}, received: ${String(value)}`
    )
  }
  return value
}

export function validatePagination(options?: PaginationOptions): {
  offset: number
  limit: number
} {
  const offset =
    options?.offset !== undefined ? validateSafeInteger(options.offset, 'offset', 0) : 0

  const limit =
    options?.limit !== undefined
      ? validateSafeInteger(options.limit, 'limit', 1, MAX_PAGE_LIMIT)
      : DEFAULT_PAGE_LIMIT

  return { offset, limit }
}

export function validateRecordHashObservationInput(input: RecordHashObservationInput): void {
  if (!input.sha256 || typeof input.sha256 !== 'string' || !SHA256_HEX_REGEX.test(input.sha256)) {
    throw new RangeError(
      `Invalid SHA-256 digest: must be exactly 64 hexadecimal characters, received: ${String(input.sha256)}`
    )
  }

  validateSafeInteger(input.observedByteSize, 'observedByteSize', 0)

  if (
    input.observedMtimeMs !== null &&
    (typeof input.observedMtimeMs !== 'number' || !Number.isFinite(input.observedMtimeMs))
  ) {
    throw new RangeError(
      `observedMtimeMs must be null or a finite number, received: ${String(input.observedMtimeMs)}`
    )
  }

  validateSafeInteger(input.hashedAtMs, 'hashedAtMs', 1)
}

export function validateDiscoveryCandidateInput(candidate: DiscoveryCandidateInput): void {
  if (!candidate.originalPath || typeof candidate.originalPath !== 'string') {
    throw new TypeError('originalPath must be a non-empty string')
  }
  if (!candidate.fileName || typeof candidate.fileName !== 'string') {
    throw new TypeError('fileName must be a non-empty string')
  }
  if (typeof candidate.extension !== 'string') {
    throw new TypeError('extension must be a string')
  }
  validateSafeInteger(candidate.byteSize, 'byteSize', 0)
  if (
    candidate.birthtimeMs !== null &&
    (typeof candidate.birthtimeMs !== 'number' || !Number.isFinite(candidate.birthtimeMs))
  ) {
    throw new RangeError(
      `birthtimeMs must be null or a finite number, received: ${String(candidate.birthtimeMs)}`
    )
  }
  if (
    candidate.mtimeMs !== null &&
    (typeof candidate.mtimeMs !== 'number' || !Number.isFinite(candidate.mtimeMs))
  ) {
    throw new RangeError(
      `mtimeMs must be null or a finite number, received: ${String(candidate.mtimeMs)}`
    )
  }
  validateSafeInteger(candidate.discoveredAtMs, 'discoveredAtMs', 1)
  if (candidate.category !== 'photo' && candidate.category !== 'document') {
    throw new TypeError(`Invalid category: ${String(candidate.category)}`)
  }
}

export class CatalogDatabase {
  private readonly db: DatabaseSync
  private journal?: AnnotationJournal
  public readonly catalogPath: string
  private closed = false
  private documentOcrMutationSeq = 0
  private readonly semanticSearchRepository: SemanticSearchRepository
  private readonly documentRepository: DocumentRepository
  private readonly documentOcrRepository: DocumentOcrRepository
  private readonly documentSemanticRepository: DocumentSemanticRepository
  private documentSemanticMutationSeq = 0
  private readonly documentClassificationRepository: DocumentClassificationRepository
  private documentClassificationMutationSeq = 0
  private readonly exportRepository: ExportRepository
  private readonly backupRepository: BackupRepository

  private constructor(
    db: DatabaseSync,
    journal?: AnnotationJournal,
    catalogPath: string = ':memory:'
  ) {
    this.db = db
    this.journal = journal
    this.catalogPath = catalogPath
    this.semanticSearchRepository = new SemanticSearchRepository({
      getDb: () => this.getRawDb(),
      getFileLocationById: (id) => this.getFileLocationById(id)
    })
    this.documentRepository = new DocumentRepository({
      getDb: () => this.getRawDb(),
      getCatalogPath: () => this.catalogPath,
      onOcrRelevantMutation: () => {
        this.bumpDocumentOcrMutationSeq()
        this.bumpDocumentSemanticMutationSeq()
        this.bumpDocumentClassificationMutationSeq()
      }
    })
    this.documentOcrRepository = new DocumentOcrRepository({
      getDb: () => this.getRawDb(),
      getCatalogPath: () => this.catalogPath,
      onOcrRelevantMutation: () => {
        this.bumpDocumentOcrMutationSeq()
        this.bumpDocumentSemanticMutationSeq()
        this.bumpDocumentClassificationMutationSeq()
      }
    })
    this.documentSemanticRepository = new DocumentSemanticRepository(this.db, this.catalogPath)
    this.documentClassificationRepository = new DocumentClassificationRepository({
      getDb: () => this.getRawDb(),
      getCatalogPath: () => this.catalogPath,
      getJournal: () => this.journal,
      onClassificationMutation: () => {
        this.bumpDocumentClassificationMutationSeq()
      }
    })
    this.exportRepository = new ExportRepository({
      getDb: () => this.getRawDb()
    })
    this.backupRepository = new BackupRepository({
      db: this.db
    })
  }

  public bumpDocumentClassificationMutationSeq(): number {
    this.documentClassificationMutationSeq += 1
    return this.documentClassificationMutationSeq
  }

  public getDocumentClassificationCoverageGeneration(): string {
    this.assertOpen()
    const row = this.db.prepare('PRAGMA data_version;').get() as unknown as
      { data_version?: number } | undefined
    return `${this.documentClassificationMutationSeq}:${Number(row?.data_version ?? 0)}`
  }

  public getDocumentClassificationRepository(): DocumentClassificationRepository {
    this.assertOpen()
    return this.documentClassificationRepository
  }

  public getExportRepository(): ExportRepository {
    this.assertOpen()
    return this.exportRepository
  }

  public getBackupRepository(): BackupRepository {
    this.assertOpen()
    return this.backupRepository
  }

  public bumpDocumentSemanticMutationSeq(): number {
    this.documentSemanticMutationSeq += 1
    return this.documentSemanticMutationSeq
  }

  public getDocumentSemanticCoverageGeneration(): string {
    this.assertOpen()
    const row = this.db.prepare('PRAGMA data_version;').get() as unknown as
      { data_version?: number } | undefined
    return `${this.documentSemanticMutationSeq}:${Number(row?.data_version ?? 0)}`
  }

  public bumpDocumentOcrMutationSeq(): number {
    this.documentOcrMutationSeq += 1
    return this.documentOcrMutationSeq
  }

  public getDocumentOcrMutationSeq(): number {
    return this.documentOcrMutationSeq
  }

  public getDocumentOcrCoverageGeneration(): string {
    this.assertOpen()
    const row = this.db.prepare('PRAGMA data_version;').get() as unknown as
      { data_version?: number } | undefined
    return `${this.documentOcrMutationSeq}:${Number(row?.data_version ?? 0)}`
  }

  public getCatalogPath(): string {
    return this.catalogPath
  }

  public getRawDb(): DatabaseSync {
    this.assertOpen()
    return this.db
  }

  public getDocumentRepository(): DocumentRepository {
    this.assertOpen()
    return this.documentRepository
  }

  public getDocumentOcrRepository(): DocumentOcrRepository {
    this.assertOpen()
    return this.documentOcrRepository
  }

  public getDocumentSemanticRepository(): DocumentSemanticRepository {
    this.assertOpen()
    return this.documentSemanticRepository
  }

  public getDocumentsPage(
    input: GetDocumentsPageRequest,
    options?: { processingFileLocationIds?: ReadonlySet<number> }
  ): GetDocumentsPageResponse {
    return this.documentRepository.getDocumentsPage(input, options)
  }

  public getDocumentDetail(
    fileLocationId: number,
    options?: { processingFileLocationIds?: ReadonlySet<number> }
  ): DocumentDetailItem | null {
    return this.documentRepository.getDocumentDetail(fileLocationId, options)
  }

  public getDocumentExtensionFacets(
    input: GetDocumentExtensionFacetsRequest
  ): GetDocumentExtensionFacetsResponse {
    return this.documentRepository.getDocumentExtensionFacets(input)
  }

  /**
   * Opens or creates a catalog database at the caller-supplied path.
   * Runs versioned schema migrations deterministically.
   * Closes database connection cleanly on initialization or migration failure.
   */
  public static open(options: CatalogDatabaseOptions): CatalogDatabase {
    if (!options.catalogPath || typeof options.catalogPath !== 'string') {
      throw new TypeError('catalogPath must be a non-empty string')
    }

    let rawDb: DatabaseSync | null = null
    try {
      if (options.catalogPath !== ':memory:') {
        mkdirSync(dirname(options.catalogPath), { recursive: true })
      }

      rawDb = new DatabaseSync(options.catalogPath, {
        enableForeignKeyConstraints: options.enableForeignKeyConstraints ?? true,
        timeout: options.timeoutMs ?? 5000,
        readOnly: options.readOnly ?? false
      })

      // Compatibility check must run before any mutations or journal mode changes
      checkSchemaCompatibility(rawDb)

      if (!options.readOnly) {
        runMigrations(rawDb)
        ensureDocumentExtractionJobsColumns(rawDb)
      }

      const instance = new CatalogDatabase(rawDb, options.journal, options.catalogPath)
      if (instance.journal && !options.readOnly) {
        instance.reconcileJournalWithDatabase()
      }
      return instance
    } catch (error) {
      if (rawDb) {
        try {
          rawDb.close()
        } catch {
          // preserve primary initialization error
        }
      }
      throw error
    }
  }

  /**
   * Closes the database connection deterministically.
   * Subsequent operations throw DatabaseClosedError.
   * Calling close repeatedly is safe and idempotent.
   */
  public close(): void {
    if (this.closed) {
      return
    }
    this.db.close()
    this.closed = true
  }

  public isClosed(): boolean {
    return this.closed
  }

  /**
   * Diagnostic / testing helper exposing the underlying DatabaseSync connection.
   */
  public getRawDatabaseForTesting(): DatabaseSync {
    this.assertOpen()
    return this.db
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new DatabaseClosedError()
    }
  }

  /**
   * Registers a source directory root in the catalog inventory.
   * If already registered, updates its updated_at_ms timestamp.
   */
  public registerSource(rootPath: string): SourceRecord {
    this.assertOpen()
    if (!rootPath || typeof rootPath !== 'string') {
      throw new TypeError('rootPath must be a non-empty string')
    }

    const normalizedRoot = normalizePathForLookup(rootPath)
    const now = Date.now()

    const upsertStmt = this.db.prepare(`
      INSERT INTO sources (root_path, normalized_root_path, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(normalized_root_path) DO UPDATE SET updated_at_ms = excluded.updated_at_ms
      RETURNING id, root_path, normalized_root_path, created_at_ms, updated_at_ms;
    `)

    const row = upsertStmt.get(rootPath, normalizedRoot, now, now) as unknown as RawSourceRow
    return this.mapSourceRow(row)
  }

  public getSourceByPath(rootPath: string): SourceRecord | null {
    this.assertOpen()
    const normalizedRoot = normalizePathForLookup(rootPath)
    const stmt = this.db.prepare(
      'SELECT id, root_path, normalized_root_path, created_at_ms, updated_at_ms FROM sources WHERE normalized_root_path = ?;'
    )
    const row = stmt.get(normalizedRoot) as unknown as RawSourceRow | undefined
    return row ? this.mapSourceRow(row) : null
  }

  public listSources(options?: PaginationOptions): PaginatedResult<SourceRecord> {
    this.assertOpen()
    const { offset, limit } = validatePagination(options)

    const countRow = this.db.prepare('SELECT COUNT(*) as total FROM sources;').get() as unknown as {
      total: number
    }
    const totalCount = countRow.total

    const stmt = this.db.prepare(
      'SELECT id, root_path, normalized_root_path, created_at_ms, updated_at_ms FROM sources ORDER BY id ASC LIMIT ? OFFSET ?;'
    )
    const rows = stmt.all(limit, offset) as unknown as RawSourceRow[]
    const items = rows.map((r) => this.mapSourceRow(r))

    return {
      items,
      totalCount,
      offset,
      limit,
      hasMore: offset + items.length < totalCount
    }
  }

  /**
   * Persists a batch of discovered file candidates transactionally.
   * Includes source root registration in the transaction so failures roll back cleanly.
   *
   * Idempotent, Conflict-Rejecting & History-Preserving:
   * - New files insert a file_location and an initial current discovery_observation.
   * - Existing files with conflicting fileName, extension, or category reject immediately with FileMetadataConflictError (preserving recorded facts and rolling back the transaction).
   * - Existing files with unchanged facts update last_seen_at_ms on the current observation.
   * - Existing files with changed byte_size, mtime, or birthtime:
   *   1. Mark previous discovery_observation as is_current = 0 (preserving prior facts in history).
   *   2. Invalidate previous active hash observations (is_active = 0).
   *   3. Insert a NEW discovery_observation with is_current = 1, which starts with activeHash = null.
   */
  public persistDiscoveryBatch(
    sourceRoot: string,
    candidates: readonly DiscoveryCandidateInput[],
    jobId?: number
  ): BatchPersistenceResult {
    this.assertOpen()
    if (!sourceRoot || typeof sourceRoot !== 'string') {
      throw new TypeError('sourceRoot must be a non-empty string')
    }
    if (jobId !== undefined) {
      validateSafeInteger(jobId, 'jobId', 1)
    }

    if (candidates.length > MAX_BATCH_SIZE) {
      throw new RangeError(
        `Batch size ${candidates.length} exceeds maximum allowed limit of ${MAX_BATCH_SIZE}`
      )
    }

    if (candidates.length === 0) {
      return {
        insertedCount: 0,
        updatedCount: 0,
        unchangedCount: 0,
        invalidatedHashCount: 0
      }
    }

    // Pre-validate candidates before mutation
    for (const candidate of candidates) {
      validateDiscoveryCandidateInput(candidate)
    }

    let insertedCount = 0
    let updatedCount = 0
    let unchangedCount = 0
    let invalidatedHashCount = 0

    this.db.exec('BEGIN TRANSACTION;')
    try {
      let source = this.getSourceByPath(sourceRoot)
      if (!source) {
        source = this.registerSource(sourceRoot)
      }

      const insertJobFileStmt =
        jobId !== undefined
          ? this.db.prepare(
              'INSERT OR IGNORE INTO scan_job_files (job_id, file_location_id) VALUES (?, ?);'
            )
          : null

      const selectFileStmt = this.db.prepare(
        'SELECT id, original_path, file_name, extension, category FROM file_locations WHERE original_path = ?;'
      )

      const selectCurrentObsStmt = this.db.prepare(`
        SELECT id, byte_size, filesystem_birthtime_ms, filesystem_mtime_ms
        FROM discovery_observations
        WHERE file_location_id = ? AND is_current = 1;
      `)

      const insertFileStmt = this.db.prepare(`
        INSERT INTO file_locations (
          source_id, original_path, normalized_path, file_name, extension, category,
          created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id;
      `)

      const insertObsStmt = this.db.prepare(`
        INSERT INTO discovery_observations (
          file_location_id, byte_size, filesystem_birthtime_ms, filesystem_mtime_ms,
          inferred_capture_time_ms, observed_at_ms, last_seen_at_ms, is_current
        ) VALUES (?, ?, ?, ?, NULL, ?, ?, 1)
        RETURNING id;
      `)

      const deactivateObsStmt = this.db.prepare(`
        UPDATE discovery_observations SET is_current = 0 WHERE id = ?;
      `)

      const updateObsLastSeenStmt = this.db.prepare(`
        UPDATE discovery_observations SET last_seen_at_ms = ? WHERE id = ?;
      `)

      const updateFileLocationStmt = this.db.prepare(`
        UPDATE file_locations SET updated_at_ms = ? WHERE id = ?;
      `)

      const invalidateHashesStmt = this.db.prepare(`
        UPDATE hash_observations
        SET is_active = 0
        WHERE discovery_observation_id = ? AND is_active = 1;
      `)

      const now = Date.now()

      for (const candidate of candidates) {
        const normalizedPath = normalizePathForLookup(candidate.originalPath)
        const existingFile = selectFileStmt.get(candidate.originalPath) as unknown as
          | {
              id: number
              original_path: string
              file_name: string
              extension: string
              category: string
            }
          | undefined

        if (!existingFile) {
          const fileRow = insertFileStmt.get(
            source.id,
            candidate.originalPath,
            normalizedPath,
            candidate.fileName,
            candidate.extension,
            candidate.category,
            now,
            now
          ) as unknown as { id: number }

          insertObsStmt.run(
            fileRow.id,
            candidate.byteSize,
            candidate.birthtimeMs,
            candidate.mtimeMs,
            candidate.discoveredAtMs,
            candidate.discoveredAtMs
          )
          if (insertJobFileStmt) {
            insertJobFileStmt.run(jobId!, fileRow.id)
          }
          insertedCount++
        } else {
          if (insertJobFileStmt) {
            insertJobFileStmt.run(jobId!, existingFile.id)
          }

          // Reject conflicting recorded metadata before modifying records or invalidating hashes
          if (candidate.fileName !== existingFile.file_name) {
            throw new FileMetadataConflictError(
              candidate.originalPath,
              'fileName',
              existingFile.file_name,
              candidate.fileName
            )
          }
          if (candidate.extension !== existingFile.extension) {
            throw new FileMetadataConflictError(
              candidate.originalPath,
              'extension',
              existingFile.extension,
              candidate.extension
            )
          }
          if (candidate.category !== existingFile.category) {
            throw new FileMetadataConflictError(
              candidate.originalPath,
              'category',
              existingFile.category,
              candidate.category
            )
          }

          const currentObs = selectCurrentObsStmt.get(existingFile.id) as unknown as
            | {
                id: number
                byte_size: number
                filesystem_birthtime_ms: number | null
                filesystem_mtime_ms: number | null
              }
            | undefined

          const sizeChanged = !currentObs || currentObs.byte_size !== candidate.byteSize
          const mtimeChanged = !currentObs || currentObs.filesystem_mtime_ms !== candidate.mtimeMs
          const birthtimeChanged =
            !currentObs || currentObs.filesystem_birthtime_ms !== candidate.birthtimeMs

          if (sizeChanged || mtimeChanged || birthtimeChanged) {
            if (currentObs) {
              deactivateObsStmt.run(currentObs.id)
              const invRes = invalidateHashesStmt.run(currentObs.id)
              if (Number(invRes.changes) > 0) {
                invalidatedHashCount += Number(invRes.changes)
              }
            }

            insertObsStmt.run(
              existingFile.id,
              candidate.byteSize,
              candidate.birthtimeMs,
              candidate.mtimeMs,
              candidate.discoveredAtMs,
              candidate.discoveredAtMs
            )
            updateFileLocationStmt.run(now, existingFile.id)
            this.db
              .prepare(
                'UPDATE photo_semantic_embeddings SET is_current = 0 WHERE file_location_id = ? AND is_current = 1;'
              )
              .run(existingFile.id)
            this.db
              .prepare(
                'UPDATE photo_technical_metadata SET is_current = 0 WHERE file_location_id = ? AND is_current = 1;'
              )
              .run(existingFile.id)
            this.reconcilePhotoAnnotations(existingFile.id)
            this.documentClassificationRepository.reconcileForLocationInActiveTx(existingFile.id)
            updatedCount++
          } else {
            updateObsLastSeenStmt.run(candidate.discoveredAtMs, currentObs.id)
            updateFileLocationStmt.run(now, existingFile.id)
            unchangedCount++
          }
        }
      }

      this.db.exec('COMMIT;')
      if (insertedCount > 0 || updatedCount > 0 || invalidatedHashCount > 0) {
        this.bumpDocumentOcrMutationSeq()
        this.bumpDocumentSemanticMutationSeq()
        this.bumpDocumentClassificationMutationSeq()
      }
      return {
        insertedCount,
        updatedCount,
        unchangedCount,
        invalidatedHashCount
      }
    } catch (error) {
      try {
        this.db.exec('ROLLBACK;')
      } catch {
        // Rollback attempt
      }
      throw error
    }
  }

  /**
   * Records a verified SHA-256 hash observation for a file's current discovery state.
   * Verifies that observed size and modification timestamp match the current discovery facts.
   * Marks previous active hash observations for this discovery observation as inactive.
   */
  public recordHashObservation(input: RecordHashObservationInput): HashObservationRecord {
    const results = this.recordHashObservationsBatch([input])
    const first = results[0]
    if (!first) {
      throw new Error('Failed to record hash observation')
    }
    return first
  }

  /**
   * Records a batch of verified SHA-256 hash observations transactionally.
   * If any observation fails validation or consistency check, the entire batch rolls back.
   */
  public recordHashObservationsBatch(
    inputs: readonly RecordHashObservationInput[]
  ): readonly HashObservationRecord[] {
    this.assertOpen()
    if (inputs.length > MAX_BATCH_SIZE) {
      throw new RangeError(
        `Batch size ${inputs.length} exceeds maximum allowed limit of ${MAX_BATCH_SIZE}`
      )
    }

    if (inputs.length === 0) {
      return []
    }

    // Pre-validate all inputs eagerly before database mutation
    for (const input of inputs) {
      validateRecordHashObservationInput(input)
    }

    const results: HashObservationRecord[] = []
    let mutated = false
    this.db.exec('BEGIN TRANSACTION;')
    try {
      const selectFileAndObsStmt = this.db.prepare(`
        SELECT
          f.id as file_id,
          d.id as discovery_observation_id,
          d.byte_size,
          d.filesystem_mtime_ms
        FROM file_locations f
        JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1
        WHERE f.original_path = ?;
      `)

      const checkExistingHashStmt = this.db.prepare(`
        SELECT id, file_location_id, discovery_observation_id, sha256, observed_byte_size,
               observed_mtime_ms, hashed_at_ms, is_active
        FROM hash_observations
        WHERE discovery_observation_id = ? AND is_active = 1;
      `)

      const invalidateExistingStmt = this.db.prepare(`
        UPDATE hash_observations
        SET is_active = 0
        WHERE discovery_observation_id = ? AND is_active = 1;
      `)

      const insertHashStmt = this.db.prepare(`
        INSERT INTO hash_observations (
          file_location_id, discovery_observation_id, sha256, observed_byte_size,
          observed_mtime_ms, hashed_at_ms, is_active
        ) VALUES (?, ?, ?, ?, ?, ?, 1)
        RETURNING id, file_location_id, discovery_observation_id, sha256,
                  observed_byte_size, observed_mtime_ms, hashed_at_ms, is_active;
      `)

      for (const input of inputs) {
        const fileAndObs = selectFileAndObsStmt.get(input.originalPath) as unknown as
          | {
              file_id: number
              discovery_observation_id: number
              byte_size: number
              filesystem_mtime_ms: number | null
            }
          | undefined

        if (!fileAndObs) {
          throw new FileLocationNotFoundError(input.originalPath)
        }

        // Verify consistency with current recorded discovery facts
        if (fileAndObs.byte_size !== input.observedByteSize) {
          throw new Error(
            `Observed byte size mismatch: observed ${input.observedByteSize} != catalog recorded ${fileAndObs.byte_size}`
          )
        }

        if (
          !isObservationTimestampMatching(input.observedMtimeMs, fileAndObs.filesystem_mtime_ms)
        ) {
          throw new Error(
            `Observed mtime mismatch: observed ${String(input.observedMtimeMs)} != catalog recorded ${String(fileAndObs.filesystem_mtime_ms)}`
          )
        }

        const normalizedSha256 = input.sha256.toLowerCase()

        // Check if identical hash observation is already active (idempotency)
        const existingHash = checkExistingHashStmt.get(
          fileAndObs.discovery_observation_id
        ) as unknown as RawHashRow | undefined

        if (existingHash && existingHash.sha256 === normalizedSha256) {
          results.push(this.mapHashRow(existingHash))
          continue
        }

        if (existingHash) {
          invalidateExistingStmt.run(fileAndObs.discovery_observation_id)
        }
        mutated = true

        const row = insertHashStmt.get(
          fileAndObs.file_id,
          fileAndObs.discovery_observation_id,
          normalizedSha256,
          input.observedByteSize,
          input.observedMtimeMs,
          input.hashedAtMs
        ) as unknown as RawHashRow

        results.push(this.mapHashRow(row))
        this.db
          .prepare(
            'UPDATE photo_semantic_embeddings SET is_current = 0 WHERE file_location_id = ? AND is_current = 1 AND content_sha256 != ?;'
          )
          .run(fileAndObs.file_id, normalizedSha256)
        this.db
          .prepare(
            'UPDATE photo_technical_metadata SET is_current = 0 WHERE file_location_id = ? AND is_current = 1 AND content_sha256 IS NOT NULL AND content_sha256 != ?;'
          )
          .run(fileAndObs.file_id, normalizedSha256)
        this.reconcilePhotoAnnotations(fileAndObs.file_id)
        this.documentClassificationRepository.reconcileForLocationInActiveTx(fileAndObs.file_id)
      }

      this.db.exec('COMMIT;')
      if (mutated) {
        this.bumpDocumentOcrMutationSeq()
        this.bumpDocumentSemanticMutationSeq()
        this.bumpDocumentClassificationMutationSeq()
      }
      return results
    } catch (error) {
      try {
        this.db.exec('ROLLBACK;')
      } catch {
        // Rollback attempt
      }
      throw error
    }
  }

  /**
   * Retrieves a file record by exact original path.
   */
  public getFileLocationByPath(filePath: string): CatalogFileRecord | null {
    this.assertOpen()
    const stmt = this.db.prepare(`
      SELECT
        f.id, f.source_id, f.original_path, f.normalized_path, f.file_name, f.extension, f.category,
        d.id as discovery_observation_id,
        d.byte_size, d.filesystem_birthtime_ms, d.filesystem_mtime_ms, d.inferred_capture_time_ms,
        d.observed_at_ms as first_discovered_at_ms, d.last_seen_at_ms,
        h.sha256 as active_hash,
        h.hashed_at_ms as active_hash_verified_at_ms
      FROM file_locations f
      JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1
      LEFT JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1
      WHERE f.original_path = ?;
    `)
    const row = stmt.get(filePath) as unknown as RawFileRow | undefined
    return row ? this.mapFileRow(row) : null
  }

  /**
   * Retrieves a file record by catalog ID.
   */
  public getFileLocationById(id: number): CatalogFileRecord | null {
    this.assertOpen()
    const stmt = this.db.prepare(`
      SELECT
        f.id, f.source_id, f.original_path, f.normalized_path, f.file_name, f.extension, f.category,
        d.id as discovery_observation_id,
        d.byte_size, d.filesystem_birthtime_ms, d.filesystem_mtime_ms, d.inferred_capture_time_ms,
        d.observed_at_ms as first_discovered_at_ms, d.last_seen_at_ms,
        h.sha256 as active_hash,
        h.hashed_at_ms as active_hash_verified_at_ms,
        a.rating as annotation_rating,
        a.flag as annotation_flag,
        a.version as annotation_version
      FROM file_locations f
      JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1
      LEFT JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1
      LEFT JOIN photo_annotations a ON a.file_location_id = f.id AND a.is_current = 1
        AND (a.discovery_observation_id = d.id OR (a.content_sha256 IS NOT NULL AND h.sha256 IS NOT NULL AND a.content_sha256 = h.sha256))
      WHERE f.id = ?;
    `)
    const row = stmt.get(id) as unknown as RawFileRow | undefined
    return row ? this.mapFileRow(row) : null
  }

  /**
   * Retrieves all historical discovery observations for a specific file location.
   */
  public getDiscoveryObservationsForFile(
    fileLocationId: number,
    options?: PaginationOptions
  ): PaginatedResult<DiscoveryObservationRecord> {
    this.assertOpen()
    const { offset, limit } = validatePagination(options)

    const countRow = this.db
      .prepare('SELECT COUNT(*) as total FROM discovery_observations WHERE file_location_id = ?;')
      .get(fileLocationId) as unknown as { total: number }
    const totalCount = countRow.total

    const stmt = this.db.prepare(`
      SELECT id, file_location_id, byte_size, filesystem_birthtime_ms, filesystem_mtime_ms,
             inferred_capture_time_ms, observed_at_ms, last_seen_at_ms, is_current
      FROM discovery_observations
      WHERE file_location_id = ?
      ORDER BY observed_at_ms DESC, id DESC
      LIMIT ? OFFSET ?;
    `)
    const rows = stmt.all(fileLocationId, limit, offset) as unknown as RawObservationRow[]
    const items = rows.map((r) => this.mapObservationRow(r))

    return {
      items,
      totalCount,
      offset,
      limit,
      hasMore: offset + items.length < totalCount
    }
  }

  /**
   * Retrieves all historical hash observations for a specific file location.
   */
  public getHashObservationsForFile(
    fileLocationId: number,
    options?: PaginationOptions
  ): PaginatedResult<HashObservationRecord> {
    this.assertOpen()
    const { offset, limit } = validatePagination(options)

    const countRow = this.db
      .prepare('SELECT COUNT(*) as total FROM hash_observations WHERE file_location_id = ?;')
      .get(fileLocationId) as unknown as { total: number }
    const totalCount = countRow.total

    const stmt = this.db.prepare(`
      SELECT id, file_location_id, discovery_observation_id, sha256, observed_byte_size,
             observed_mtime_ms, hashed_at_ms, is_active
      FROM hash_observations
      WHERE file_location_id = ?
      ORDER BY hashed_at_ms DESC, id DESC
      LIMIT ? OFFSET ?;
    `)
    const rows = stmt.all(fileLocationId, limit, offset) as unknown as RawHashRow[]
    const items = rows.map((r) => this.mapHashRow(r))

    return {
      items,
      totalCount,
      offset,
      limit,
      hasMore: offset + items.length < totalCount
    }
  }

  /**
   * Executes bounded, paginated catalog file queries with optional filters.
   */
  public queryFileLocations(
    options: QueryFileLocationsOptions = {}
  ): PaginatedResult<CatalogFileRecord> {
    this.assertOpen()
    const { offset, limit } = validatePagination(options)

    const { conditions, params, techMetaJoinClause, joinParams } = buildPhotoFilterClauses(options)

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const allFilterParams = [...joinParams, ...params]

    // 1. Total count query
    const countSql = `
      SELECT COUNT(DISTINCT f.id) as total
      FROM file_locations f
      JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1
      LEFT JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1
      LEFT JOIN photo_annotations a ON a.file_location_id = f.id AND a.is_current = 1
        AND (a.discovery_observation_id = d.id OR (a.content_sha256 IS NOT NULL AND h.sha256 IS NOT NULL AND a.content_sha256 = h.sha256))
      ${techMetaJoinClause}
      ${whereClause};
    `
    const countRow = this.db.prepare(countSql).get(...allFilterParams) as unknown as {
      total: number
    }
    const totalCount = countRow.total

    // 2. Paginated rows query
    const querySql = `
      SELECT
        f.id, f.source_id, f.original_path, f.normalized_path, f.file_name, f.extension, f.category,
        d.id as discovery_observation_id,
        d.byte_size, d.filesystem_birthtime_ms, d.filesystem_mtime_ms, d.inferred_capture_time_ms,
        d.observed_at_ms as first_discovered_at_ms, d.last_seen_at_ms,
        h.sha256 as active_hash,
        h.hashed_at_ms as active_hash_verified_at_ms,
        a.rating as annotation_rating,
        a.flag as annotation_flag,
        a.version as annotation_version
      FROM file_locations f
      JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1
      LEFT JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1
      LEFT JOIN photo_annotations a ON a.file_location_id = f.id AND a.is_current = 1
        AND (a.discovery_observation_id = d.id OR (a.content_sha256 IS NOT NULL AND h.sha256 IS NOT NULL AND a.content_sha256 = h.sha256))
      ${techMetaJoinClause}
      ${whereClause}
      ORDER BY f.id ASC
      LIMIT ? OFFSET ?;
    `
    const rows = this.db
      .prepare(querySql)
      .all(...allFilterParams, limit, offset) as unknown as RawFileRow[]
    const items = rows.map((r) => this.mapFileRow(r))

    return {
      items,
      totalCount,
      offset,
      limit,
      hasMore: offset + items.length < totalCount
    }
  }

  /**
   * Searches photos by natural-language semantic similarity, applying Stage 5B
   * and Stage 6C SQL filters BEFORE candidate ranking and pagination.
   * Delegates to SemanticSearchRepository while retaining connection and
   * transaction ownership in CatalogDatabase.
   */
  public async searchPhotosSemantic(
    input: SemanticSearchCatalogInput
  ): Promise<SemanticSearchCatalogResult> {
    return this.semanticSearchRepository.searchPhotosSemantic(input)
  }

  /**
   * Computes the deterministic group signature and checks member count / preferred location
   * using bounded streaming iteration with constant O(1) auxiliary memory.
   */
  private computeGroupSignature(
    sha256: string,
    byteSize: number,
    preferredLocationId?: number | null
  ): { signature: string; memberCount: number; containsPreferred: boolean } {
    const stmt = this.db.prepare(`
      SELECT f.id, d.id as disc_id, h.id as hash_id
      FROM file_locations f
      JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1 AND d.byte_size = ?
      JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1 AND h.sha256 = ? AND h.observed_byte_size = ?
      ORDER BY f.id ASC;
    `)
    const hasher = createHash('sha256')
    let memberCount = 0
    let containsPreferred = false
    let first = true

    for (const row of stmt.iterate(byteSize, sha256, byteSize) as Iterable<{
      id: number
      disc_id: number
      hash_id: number
    }>) {
      memberCount++
      if (
        preferredLocationId !== null &&
        preferredLocationId !== undefined &&
        row.id === preferredLocationId
      ) {
        containsPreferred = true
      }
      if (!first) hasher.update(';')
      first = false
      hasher.update(`${row.id}:${row.disc_id}:${row.hash_id}`)
    }

    return { signature: hasher.digest('hex'), memberCount, containsPreferred }
  }

  /**
   * Retrieves paginated duplicate content clusters (active SHA-256 hashes with file count > 1).
   * Group pagination and preview locations per cluster are bounded in SQL to prevent unbounded memory loading.
   */
  public getDuplicateGroups(options: DuplicateGroupOptions = {}): PaginatedResult<DuplicateGroup> {
    this.assertOpen()
    const { offset, limit } = validatePagination(options)
    const filter = options.filter ?? 'all'

    const maxLocationsPerGroup =
      options.maxLocationsPerGroup !== undefined
        ? validateSafeInteger(
            options.maxLocationsPerGroup,
            'maxLocationsPerGroup',
            1,
            MAX_LOCATIONS_PER_GROUP
          )
        : DEFAULT_MAX_LOCATIONS_PER_GROUP

    // Maintain a temporary table to hold validly reviewed groups for bounded SQL filtering
    this.db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS _valid_reviewed_groups (
        sha256 TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        PRIMARY KEY (sha256, byte_size)
      );
      DELETE FROM _valid_reviewed_groups;
    `)

    // Identify active valid reviews using streaming iteration without materializing large arrays
    const candidateReviewsStmt = this.db.prepare(`
      SELECT sha256, byte_size, group_signature, preferred_location_id
      FROM duplicate_reviews
      WHERE status = 'reviewed';
    `)

    const insertValidStmt = this.db.prepare(`
      INSERT OR IGNORE INTO _valid_reviewed_groups (sha256, byte_size) VALUES (?, ?);
    `)

    for (const r of candidateReviewsStmt.iterate() as Iterable<{
      sha256: string
      byte_size: number
      group_signature: string
      preferred_location_id: number | null
    }>) {
      const { signature, memberCount, containsPreferred } = this.computeGroupSignature(
        r.sha256,
        r.byte_size,
        r.preferred_location_id
      )
      if (
        memberCount > 1 &&
        signature === r.group_signature &&
        (r.preferred_location_id === null || containsPreferred)
      ) {
        insertValidStmt.run(r.sha256, r.byte_size)
      }
    }

    let countSql: string
    let pageSql: string

    if (filter === 'reviewed') {
      countSql = `
        SELECT COUNT(*) as total FROM (
          SELECT 1
          FROM file_locations f
          JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1 AND d.byte_size = h.observed_byte_size
          JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1
          JOIN _valid_reviewed_groups vr ON vr.sha256 = h.sha256 AND vr.byte_size = h.observed_byte_size
          GROUP BY h.sha256, h.observed_byte_size
          HAVING COUNT(DISTINCT f.id) > 1
        );
      `
      pageSql = `
        SELECT
          h.sha256,
          h.observed_byte_size as byte_size,
          COUNT(DISTINCT f.id) as file_count
        FROM file_locations f
        JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1 AND d.byte_size = h.observed_byte_size
        JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1
        JOIN _valid_reviewed_groups vr ON vr.sha256 = h.sha256 AND vr.byte_size = h.observed_byte_size
        GROUP BY h.sha256, h.observed_byte_size
        HAVING COUNT(DISTINCT f.id) > 1
        ORDER BY file_count DESC, byte_size DESC, h.sha256 ASC
        LIMIT ? OFFSET ?;
      `
    } else if (filter === 'unreviewed') {
      countSql = `
        SELECT COUNT(*) as total FROM (
          SELECT 1
          FROM file_locations f
          JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1 AND d.byte_size = h.observed_byte_size
          JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1
          LEFT JOIN _valid_reviewed_groups vr ON vr.sha256 = h.sha256 AND vr.byte_size = h.observed_byte_size
          WHERE vr.sha256 IS NULL
          GROUP BY h.sha256, h.observed_byte_size
          HAVING COUNT(DISTINCT f.id) > 1
        );
      `
      pageSql = `
        SELECT
          h.sha256,
          h.observed_byte_size as byte_size,
          COUNT(DISTINCT f.id) as file_count
        FROM file_locations f
        JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1 AND d.byte_size = h.observed_byte_size
        JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1
        LEFT JOIN _valid_reviewed_groups vr ON vr.sha256 = h.sha256 AND vr.byte_size = h.observed_byte_size
        WHERE vr.sha256 IS NULL
        GROUP BY h.sha256, h.observed_byte_size
        HAVING COUNT(DISTINCT f.id) > 1
        ORDER BY file_count DESC, byte_size DESC, h.sha256 ASC
        LIMIT ? OFFSET ?;
      `
    } else {
      countSql = `
        SELECT COUNT(*) as total FROM (
          SELECT 1
          FROM file_locations f
          JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1 AND d.byte_size = h.observed_byte_size
          JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1
          GROUP BY h.sha256, h.observed_byte_size
          HAVING COUNT(DISTINCT f.id) > 1
        );
      `
      pageSql = `
        SELECT
          h.sha256,
          h.observed_byte_size as byte_size,
          COUNT(DISTINCT f.id) as file_count
        FROM file_locations f
        JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1 AND d.byte_size = h.observed_byte_size
        JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1
        GROUP BY h.sha256, h.observed_byte_size
        HAVING COUNT(DISTINCT f.id) > 1
        ORDER BY file_count DESC, byte_size DESC, h.sha256 ASC
        LIMIT ? OFFSET ?;
      `
    }

    const countRow = this.db.prepare(countSql).get() as unknown as { total: number }
    const totalCount = countRow?.total ?? 0

    const pagedRows = this.db.prepare(pageSql).all(limit, offset) as unknown as Array<{
      sha256: string
      byte_size: number
      file_count: number
    }>

    const reviewStmt = this.db.prepare(`
      SELECT status, preferred_location_id, group_signature, reviewed_at_ms
      FROM duplicate_reviews
      WHERE sha256 = ? AND byte_size = ?;
    `)

    const filesStmt = this.db.prepare(`
      SELECT
        f.id, f.source_id, f.original_path, f.normalized_path, f.file_name, f.extension, f.category,
        d.id as discovery_observation_id,
        d.byte_size, d.filesystem_birthtime_ms, d.filesystem_mtime_ms, d.inferred_capture_time_ms,
        d.observed_at_ms as first_discovered_at_ms, d.last_seen_at_ms,
        h.sha256 as active_hash,
        h.hashed_at_ms as active_hash_verified_at_ms
      FROM file_locations f
      JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1 AND d.byte_size = ?
      JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1 AND h.sha256 = ? AND h.observed_byte_size = ?
      ORDER BY f.id ASC
      LIMIT ?;
    `)

    const items: DuplicateGroup[] = pagedRows.map((g) => {
      const review = reviewStmt.get(g.sha256, g.byte_size) as unknown as
        | {
            status: 'unreviewed' | 'reviewed'
            preferred_location_id: number | null
            group_signature: string
            reviewed_at_ms: number
          }
        | undefined

      const preferredId = review?.preferred_location_id ?? null
      const { signature, containsPreferred } = this.computeGroupSignature(
        g.sha256,
        g.byte_size,
        preferredId
      )

      let reviewStatus: 'unreviewed' | 'reviewed' = 'unreviewed'
      let preferredLocationId: number | null = null
      let hasStaleDecision = false
      let reviewedAtMs: number | null = null

      if (review) {
        const isSignatureMatch = review.group_signature === signature
        const isPreferredValid = preferredId === null || containsPreferred

        if (isSignatureMatch && isPreferredValid) {
          reviewStatus = review.status
          preferredLocationId = review.preferred_location_id
          hasStaleDecision = false
          reviewedAtMs = review.reviewed_at_ms
        } else {
          // Stale decision invalidation: membership, content, or observations changed
          reviewStatus = 'unreviewed'
          preferredLocationId = null
          hasStaleDecision = true
          reviewedAtMs = null
        }
      }

      const files = (
        filesStmt.all(
          g.byte_size,
          g.sha256,
          g.byte_size,
          maxLocationsPerGroup
        ) as unknown as RawFileRow[]
      ).map((r) => this.mapFileRow(r))

      return {
        sha256: g.sha256,
        byteSize: g.byte_size,
        fileCount: g.file_count,
        groupSignature: signature,
        reviewStatus,
        preferredLocationId,
        hasStaleDecision,
        reviewedAtMs,
        locations: files,
        truncatedLocations: g.file_count > files.length
      }
    })

    return {
      items,
      totalCount,
      offset,
      limit,
      hasMore: offset + items.length < totalCount
    }
  }

  /**
   * Retrieves paginated members for a specific exact duplicate group.
   * Deterministically ordered by file_location_id ASC with SQL-level pagination and bounded iteration.
   */
  public getDuplicateGroupMembers(
    options: DuplicateGroupMembersOptions
  ): DuplicateGroupMembersResult {
    this.assertOpen()
    if (!options.sha256 || typeof options.sha256 !== 'string' || options.sha256.length !== 64) {
      throw new TypeError('sha256 must be a 64-character hex string')
    }
    const byteSize = validateSafeInteger(options.byteSize, 'byteSize', 0)
    const { offset, limit } = validatePagination(options)

    // 1. Total count query
    const countSql = `
      SELECT COUNT(DISTINCT f.id) as total
      FROM file_locations f
      JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1 AND d.byte_size = ?
      JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1 AND h.sha256 = ? AND h.observed_byte_size = ?;
    `
    const countRow = this.db
      .prepare(countSql)
      .get(byteSize, options.sha256, byteSize) as unknown as { total: number } | undefined
    const totalCount = countRow?.total ?? 0

    // 2. Review state lookup
    const reviewSql = `
      SELECT status, preferred_location_id, group_signature, reviewed_at_ms
      FROM duplicate_reviews
      WHERE sha256 = ? AND byte_size = ?;
    `
    const review = this.db.prepare(reviewSql).get(options.sha256, byteSize) as unknown as
      | {
          status: 'unreviewed' | 'reviewed'
          preferred_location_id: number | null
          group_signature: string
          reviewed_at_ms: number
        }
      | undefined

    const preferredId = review?.preferred_location_id ?? null

    // 3. Incremental streaming to compute deterministic signature with O(1) auxiliary memory
    const { signature: groupSignature, containsPreferred } = this.computeGroupSignature(
      options.sha256,
      byteSize,
      preferredId
    )

    let reviewStatus: 'unreviewed' | 'reviewed' = 'unreviewed'
    let preferredLocationId: number | null = null
    let hasStaleDecision = false
    let reviewedAtMs: number | null = null

    if (review) {
      const isSignatureMatch = review.group_signature === groupSignature
      const isPreferredValid = preferredId === null || containsPreferred

      if (isSignatureMatch && isPreferredValid) {
        reviewStatus = review.status
        preferredLocationId = review.preferred_location_id
        hasStaleDecision = false
        reviewedAtMs = review.reviewed_at_ms
      } else {
        reviewStatus = 'unreviewed'
        preferredLocationId = null
        hasStaleDecision = true
        reviewedAtMs = null
      }
    }

    // 4. Paginated members query using SQL LIMIT and OFFSET
    const pagedMembersSql = `
      SELECT
        f.id as file_location_id,
        f.source_id,
        f.original_path,
        f.normalized_path,
        f.file_name,
        f.extension,
        f.category,
        d.id as discovery_observation_id,
        d.byte_size,
        d.filesystem_birthtime_ms,
        d.filesystem_mtime_ms,
        d.inferred_capture_time_ms,
        d.observed_at_ms as first_discovered_at_ms,
        d.last_seen_at_ms,
        h.id as hash_observation_id,
        h.sha256 as active_hash,
        h.hashed_at_ms as active_hash_verified_at_ms
      FROM file_locations f
      JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1 AND d.byte_size = ?
      JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1 AND h.sha256 = ? AND h.observed_byte_size = ?
      ORDER BY f.id ASC
      LIMIT ? OFFSET ?;
    `

    const pagedRows = this.db
      .prepare(pagedMembersSql)
      .all(byteSize, options.sha256, byteSize, limit, offset) as unknown as Array<{
      file_location_id: number
      source_id: number
      original_path: string
      normalized_path: string
      file_name: string
      extension: string
      category: 'photo' | 'document'
      discovery_observation_id: number
      byte_size: number
      filesystem_birthtime_ms: number | null
      filesystem_mtime_ms: number | null
      inferred_capture_time_ms: number | null
      first_discovered_at_ms: number
      last_seen_at_ms: number
      hash_observation_id: number
      active_hash: string
      active_hash_verified_at_ms: number
    }>

    const items: DuplicateMemberRecord[] = pagedRows.map((m) => ({
      fileLocationId: m.file_location_id,
      sourceId: m.source_id,
      originalPath: m.original_path,
      normalizedPath: m.normalized_path,
      fileName: m.file_name,
      extension: m.extension,
      category: m.category,
      byteSize: m.byte_size,
      filesystemBirthtimeMs:
        m.filesystem_birthtime_ms !== null ? Number(m.filesystem_birthtime_ms) : null,
      filesystemMtimeMs: m.filesystem_mtime_ms !== null ? Number(m.filesystem_mtime_ms) : null,
      inferredCaptureTimeMs:
        m.inferred_capture_time_ms !== null ? Number(m.inferred_capture_time_ms) : null,
      firstDiscoveredAtMs: Number(m.first_discovered_at_ms),
      lastSeenAtMs: Number(m.last_seen_at_ms),
      discoveryObservationId: m.discovery_observation_id,
      hashObservationId: m.hash_observation_id,
      activeHash: m.active_hash,
      activeHashVerifiedAtMs: Number(m.active_hash_verified_at_ms),
      isPreferred: preferredLocationId !== null && m.file_location_id === preferredLocationId
    }))

    return {
      items,
      totalCount,
      offset,
      limit,
      hasMore: offset + items.length < totalCount,
      sha256: options.sha256,
      byteSize,
      groupSignature,
      reviewStatus,
      preferredLocationId,
      hasStaleDecision,
      reviewedAtMs
    }
  }

  /**
   * Persists a review decision for an exact duplicate group.
   * Enforces that the group exists, expectedGroupSignature matches current signature,
   * and preferredLocationId belongs to the group.
   */
  public setDuplicateReview(input: SetDuplicateReviewInput): DuplicateReviewRecord {
    this.assertOpen()
    if (!input.sha256 || typeof input.sha256 !== 'string' || input.sha256.length !== 64) {
      throw new TypeError('sha256 must be a 64-character hex string')
    }
    const byteSize = validateSafeInteger(input.byteSize, 'byteSize', 0)
    if (input.status !== 'unreviewed' && input.status !== 'reviewed') {
      throw new TypeError('status must be either "unreviewed" or "reviewed"')
    }
    if (!input.expectedGroupSignature || typeof input.expectedGroupSignature !== 'string') {
      throw new TypeError('expectedGroupSignature must be a non-empty string')
    }

    const preferredId = input.preferredLocationId ?? null
    const {
      signature: currentSignature,
      memberCount,
      containsPreferred
    } = this.computeGroupSignature(input.sha256, byteSize, preferredId)

    if (memberCount < 2) {
      throw new DuplicateGroupNotFoundError(input.sha256, byteSize)
    }

    if (input.expectedGroupSignature !== currentSignature) {
      throw new StaleReviewError()
    }

    if (preferredId !== null && !containsPreferred) {
      throw new InvalidPreferredLocationError(preferredId)
    }

    const now = Date.now()
    const upsertSql = `
      INSERT INTO duplicate_reviews (
        sha256, byte_size, status, preferred_location_id, group_signature, reviewed_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sha256, byte_size) DO UPDATE SET
        status = excluded.status,
        preferred_location_id = excluded.preferred_location_id,
        group_signature = excluded.group_signature,
        reviewed_at_ms = excluded.reviewed_at_ms,
        updated_at_ms = excluded.updated_at_ms;
    `
    this.db
      .prepare(upsertSql)
      .run(input.sha256, byteSize, input.status, preferredId, currentSignature, now, now)

    return {
      sha256: input.sha256,
      byteSize,
      status: input.status,
      preferredLocationId: preferredId,
      groupSignature: currentSignature,
      reviewedAtMs: now
    }
  }

  /**
   * Retrieves aggregate catalog inventory statistics.
   */
  public getCatalogStats(): CatalogStats {
    this.assertOpen()

    const sourcesRow = this.db
      .prepare('SELECT COUNT(*) as count FROM sources;')
      .get() as unknown as { count: number }

    const filesRow = this.db
      .prepare(
        `SELECT
          COUNT(*) as total_files,
          COALESCE(SUM(CASE WHEN category = 'photo' THEN 1 ELSE 0 END), 0) as total_photos,
          COALESCE(SUM(CASE WHEN category = 'document' THEN 1 ELSE 0 END), 0) as total_documents
        FROM file_locations;`
      )
      .get() as unknown as {
      total_files: number
      total_photos: number
      total_documents: number
    }

    const bytesRow = this.db
      .prepare(
        `SELECT COALESCE(SUM(byte_size), 0) as total_bytes
        FROM discovery_observations
        WHERE is_current = 1;`
      )
      .get() as unknown as { total_bytes: number }

    const hashedRow = this.db
      .prepare(
        `SELECT COUNT(DISTINCT h.file_location_id) as count
        FROM hash_observations h
        JOIN discovery_observations d ON d.id = h.discovery_observation_id AND d.is_current = 1
        WHERE h.is_active = 1;`
      )
      .get() as unknown as { count: number }

    const totalFiles = filesRow.total_files
    const hashedFiles = hashedRow.count

    return {
      totalSources: sourcesRow.count,
      totalFiles,
      totalPhotos: filesRow.total_photos,
      totalDocuments: filesRow.total_documents,
      totalBytes: bytesRow.total_bytes,
      hashedFiles,
      unhashedFiles: Math.max(0, totalFiles - hashedFiles)
    }
  }

  private mapSourceRow(row: RawSourceRow): SourceRecord {
    return {
      id: row.id,
      rootPath: row.root_path,
      normalizedRootPath: row.normalized_root_path,
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms
    }
  }

  private mapFileRow(row: RawFileRow): CatalogFileRecord {
    return {
      id: row.id,
      sourceId: row.source_id,
      originalPath: row.original_path,
      normalizedPath: row.normalized_path,
      fileName: row.file_name,
      extension: row.extension,
      category: row.category,
      discoveryObservationId: row.discovery_observation_id,
      byteSize: row.byte_size,
      filesystemBirthtimeMs: row.filesystem_birthtime_ms,
      filesystemMtimeMs: row.filesystem_mtime_ms,
      inferredCaptureTimeMs: row.inferred_capture_time_ms,
      firstDiscoveredAtMs: row.first_discovered_at_ms,
      lastSeenAtMs: row.last_seen_at_ms,
      activeHash: row.active_hash,
      activeHashVerifiedAtMs: row.active_hash_verified_at_ms,
      rating: row.annotation_rating !== undefined ? row.annotation_rating : null,
      flag: (row.annotation_flag as 'none' | 'pick' | 'reject') || 'none',
      annotationVersion: row.annotation_version ?? 0
    }
  }

  private mapObservationRow(row: RawObservationRow): DiscoveryObservationRecord {
    return {
      id: row.id,
      fileLocationId: row.file_location_id,
      byteSize: row.byte_size,
      filesystemBirthtimeMs: row.filesystem_birthtime_ms,
      filesystemMtimeMs: row.filesystem_mtime_ms,
      inferredCaptureTimeMs: row.inferred_capture_time_ms,
      observedAtMs: row.observed_at_ms,
      lastSeenAtMs: row.last_seen_at_ms,
      isCurrent: row.is_current === 1
    }
  }

  private mapHashRow(row: RawHashRow): HashObservationRecord {
    return {
      id: row.id,
      fileLocationId: row.file_location_id,
      discoveryObservationId: row.discovery_observation_id,
      sha256: row.sha256,
      observedByteSize: row.observed_byte_size,
      observedMtimeMs: row.observed_mtime_ms,
      hashedAtMs: row.hashed_at_ms,
      isActive: row.is_active === 1
    }
  }

  private mapScanJobRow(row: RawScanJobRow): ScanJobRecord {
    let roots: string[]
    try {
      roots = JSON.parse(row.roots_json) as string[]
    } catch {
      roots = []
    }
    return {
      id: row.id,
      status: row.status,
      phase: row.phase,
      roots,
      discoveredCount: row.discovered_count,
      hashedCount: row.hashed_count,
      totalFilesToHash: row.total_files_to_hash,
      totalBytes: row.total_bytes,
      hashedBytes: row.hashed_bytes,
      skippedCount: row.skipped_count,
      errorCount: row.error_count,
      errorMessage: row.error_message,
      isDismissed: row.is_dismissed === 1,
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms,
      startedAtMs: row.started_at_ms,
      completedAtMs: row.completed_at_ms
    }
  }

  private mapScanJobErrorRow(row: RawScanJobErrorRow): ScanJobErrorRecord {
    return {
      id: row.id,
      jobId: row.job_id,
      path: row.path,
      code: row.code,
      message: row.message,
      phase: row.phase,
      occurredAtMs: row.occurred_at_ms
    }
  }

  public createScanJob(input: CreateScanJobInput): ScanJobRecord {
    this.assertOpen()
    if (!Array.isArray(input.roots) || input.roots.length === 0) {
      throw new TypeError('roots must be a non-empty array of strings')
    }
    for (const r of input.roots) {
      if (typeof r !== 'string' || r.trim() === '') {
        throw new TypeError('roots entries must be non-empty strings')
      }
    }
    const now = input.nowMs ?? Date.now()
    const rootsJson = JSON.stringify(input.roots)
    const stmt = this.db.prepare(`
      INSERT INTO scan_jobs (
        status, roots_json, phase, discovered_count, hashed_count,
        total_files_to_hash, total_bytes, hashed_bytes, skipped_count,
        error_count, error_message, created_at_ms, updated_at_ms, started_at_ms, completed_at_ms
      ) VALUES ('running', ?, 'discovery', 0, 0, 0, 0, 0, 0, 0, NULL, ?, ?, ?, NULL);
    `)
    const result = stmt.run(rootsJson, now, now, now)
    const job = this.getScanJob(Number(result.lastInsertRowid))
    if (!job) {
      throw new Error('Failed to create scan job')
    }
    return job
  }

  public getScanJob(id: number): ScanJobRecord | null {
    this.assertOpen()
    validateSafeInteger(id, 'id', 1)
    const stmt = this.db.prepare('SELECT * FROM scan_jobs WHERE id = ?;')
    const row = stmt.get(id) as RawScanJobRow | undefined
    return row ? this.mapScanJobRow(row) : null
  }

  public getLatestScanJob(options?: { unDismissedOnly?: boolean }): ScanJobRecord | null {
    this.assertOpen()
    const where = options?.unDismissedOnly ? 'WHERE is_dismissed = 0' : ''
    const stmt = this.db.prepare(
      `SELECT * FROM scan_jobs ${where} ORDER BY created_at_ms DESC, id DESC LIMIT 1;`
    )
    const row = stmt.get() as RawScanJobRow | undefined
    return row ? this.mapScanJobRow(row) : null
  }

  public dismissScanJob(id: number): void {
    this.assertOpen()
    validateSafeInteger(id, 'id', 1)
    this.db.prepare('UPDATE scan_jobs SET is_dismissed = 1 WHERE id = ?;').run(id)
  }

  public getActiveScanJob(): ScanJobRecord | null {
    this.assertOpen()
    const stmt = this.db.prepare(
      "SELECT * FROM scan_jobs WHERE status IN ('running', 'paused', 'interrupted') ORDER BY created_at_ms DESC, id DESC LIMIT 1;"
    )
    const row = stmt.get() as RawScanJobRow | undefined
    return row ? this.mapScanJobRow(row) : null
  }

  public updateScanJobProgress(id: number, input: UpdateScanJobProgressInput): void {
    this.assertOpen()
    validateSafeInteger(id, 'id', 1)
    const now = input.nowMs ?? Date.now()
    const fields: string[] = ['updated_at_ms = ?']
    const values: SQLInputValue[] = [now]

    if (input.phase !== undefined) {
      fields.push('phase = ?')
      values.push(input.phase)
    }
    if (input.discoveredCount !== undefined) {
      validateSafeInteger(input.discoveredCount, 'discoveredCount', 0)
      fields.push('discovered_count = ?')
      values.push(input.discoveredCount)
    }
    if (input.hashedCount !== undefined) {
      validateSafeInteger(input.hashedCount, 'hashedCount', 0)
      fields.push('hashed_count = ?')
      values.push(input.hashedCount)
    }
    if (input.totalFilesToHash !== undefined) {
      validateSafeInteger(input.totalFilesToHash, 'totalFilesToHash', 0)
      fields.push('total_files_to_hash = ?')
      values.push(input.totalFilesToHash)
    }
    if (input.totalBytes !== undefined) {
      validateSafeInteger(input.totalBytes, 'totalBytes', 0)
      fields.push('total_bytes = ?')
      values.push(input.totalBytes)
    }
    if (input.hashedBytes !== undefined) {
      validateSafeInteger(input.hashedBytes, 'hashedBytes', 0)
      fields.push('hashed_bytes = ?')
      values.push(input.hashedBytes)
    }
    if (input.skippedCount !== undefined) {
      validateSafeInteger(input.skippedCount, 'skippedCount', 0)
      fields.push('skipped_count = ?')
      values.push(input.skippedCount)
    }
    if (input.errorCount !== undefined) {
      validateSafeInteger(input.errorCount, 'errorCount', 0)
      fields.push('error_count = ?')
      values.push(input.errorCount)
    }

    values.push(id)
    this.db.prepare(`UPDATE scan_jobs SET ${fields.join(', ')} WHERE id = ?;`).run(...values)
  }

  public updateScanJobStatus(
    id: number,
    status: ScanJobStatus,
    options?: { errorMessage?: string; completedAtMs?: number; nowMs?: number }
  ): void {
    this.assertOpen()
    validateSafeInteger(id, 'id', 1)
    const now = options?.nowMs ?? Date.now()
    const completedAt = options?.completedAtMs ?? (status === 'completed' ? now : null)
    const errMsg = options?.errorMessage ?? null
    this.db
      .prepare(
        `UPDATE scan_jobs
         SET status = ?, error_message = COALESCE(?, error_message), completed_at_ms = COALESCE(?, completed_at_ms), updated_at_ms = ?
         WHERE id = ?;`
      )
      .run(status, errMsg, completedAt, now, id)
  }

  public recordScanJobError(jobId: number, input: RecordScanJobErrorInput): void {
    this.assertOpen()
    validateSafeInteger(jobId, 'jobId', 1)
    const occurredAt = input.occurredAtMs ?? Date.now()
    this.db.exec('BEGIN TRANSACTION;')
    try {
      this.db
        .prepare(
          `INSERT INTO scan_job_errors (job_id, path, code, message, phase, occurred_at_ms)
           VALUES (?, ?, ?, ?, ?, ?);`
        )
        .run(jobId, input.path, input.code, input.message, input.phase, occurredAt)
      this.db
        .prepare(
          `UPDATE scan_jobs
           SET error_count = error_count + 1, updated_at_ms = ?
           WHERE id = ?;`
        )
        .run(occurredAt, jobId)
      this.db.exec('COMMIT;')
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;')
      } catch {
        // Suppress rollback errors
      }
      throw err
    }
  }

  public getScanJobErrors(
    jobId: number,
    options?: { limit?: number }
  ): readonly ScanJobErrorRecord[] {
    this.assertOpen()
    validateSafeInteger(jobId, 'jobId', 1)
    const limit = options?.limit ?? 100
    validateSafeInteger(limit, 'limit', 1, MAX_PAGE_LIMIT)
    const rows = this.db
      .prepare('SELECT * FROM scan_job_errors WHERE job_id = ? ORDER BY id DESC LIMIT ?;')
      .all(jobId, limit) as unknown as RawScanJobErrorRow[]
    return rows.map((r) => this.mapScanJobErrorRow(r))
  }

  public markRunningJobsAsInterrupted(nowMs: number): number {
    this.assertOpen()
    const res = this.db
      .prepare(
        "UPDATE scan_jobs SET status = 'interrupted', updated_at_ms = ? WHERE status = 'running';"
      )
      .run(nowMs)
    return Number(res.changes)
  }

  public getUnhashedFilesForRoots(
    roots: readonly string[],
    options?: UnhashedFilesOptions
  ): readonly UnhashedFileRecord[] {
    this.assertOpen()
    if (!Array.isArray(roots) || roots.length === 0) return []
    const normalizedRoots = roots.map((r) => normalizePathForLookup(r))
    const placeholders = normalizedRoots.map(() => '?').join(', ')
    const limit =
      options?.limit !== undefined
        ? validateSafeInteger(options.limit, 'limit', 1, MAX_PAGE_LIMIT)
        : 1000

    const hasAfterId = options?.afterId !== undefined
    const afterId = hasAfterId ? validateSafeInteger(options!.afterId!, 'afterId', 0) : 0
    const whereAfterId = hasAfterId ? 'AND fl.id > ?' : ''
    const offset =
      !hasAfterId && options?.offset !== undefined
        ? validateSafeInteger(options.offset, 'offset', 0)
        : 0
    const offsetClause = hasAfterId ? '' : 'OFFSET ?'

    const stmt = this.db.prepare(`
      SELECT
        fl.id AS file_location_id,
        fl.original_path,
        d.id AS discovery_observation_id,
        d.byte_size,
        d.filesystem_birthtime_ms,
        d.filesystem_mtime_ms
      FROM file_locations fl
      JOIN sources s ON fl.source_id = s.id
      JOIN discovery_observations d ON d.file_location_id = fl.id AND d.is_current = 1
      LEFT JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1
      WHERE s.normalized_root_path IN (${placeholders})
        AND h.id IS NULL
        ${whereAfterId}
      ORDER BY fl.id ASC
      LIMIT ? ${offsetClause};
    `)
    const params = hasAfterId
      ? [...normalizedRoots, afterId, limit]
      : [...normalizedRoots, limit, offset]
    const rows = stmt.all(...params) as Array<{
      file_location_id: number
      original_path: string
      discovery_observation_id: number
      byte_size: number
      filesystem_birthtime_ms: number | null
      filesystem_mtime_ms: number | null
    }>
    return rows.map((r) => ({
      fileLocationId: r.file_location_id,
      discoveryObservationId: r.discovery_observation_id,
      originalPath: r.original_path,
      byteSize: r.byte_size,
      filesystemBirthtimeMs: r.filesystem_birthtime_ms,
      filesystemMtimeMs: r.filesystem_mtime_ms
    }))
  }

  public countUnhashedFilesForRoots(roots: readonly string[]): UnhashedCountResult {
    this.assertOpen()
    if (!Array.isArray(roots) || roots.length === 0) return { count: 0, totalBytes: 0 }
    const normalizedRoots = roots.map((r) => normalizePathForLookup(r))
    const placeholders = normalizedRoots.map(() => '?').join(', ')

    const stmt = this.db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(d.byte_size), 0) AS total_bytes
      FROM file_locations fl
      JOIN sources s ON fl.source_id = s.id
      JOIN discovery_observations d ON d.file_location_id = fl.id AND d.is_current = 1
      LEFT JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1
      WHERE s.normalized_root_path IN (${placeholders})
        AND h.id IS NULL;
    `)
    const row = stmt.get(...normalizedRoots) as { count: number; total_bytes: number }
    return {
      count: row.count,
      totalBytes: row.total_bytes
    }
  }

  public linkUnhashedFilesForRootsToJob(jobId: number, roots: readonly string[]): number {
    this.assertOpen()
    validateSafeInteger(jobId, 'jobId', 1)
    if (!Array.isArray(roots) || roots.length === 0) return 0

    const sep = process.platform === 'win32' ? '\\' : '/'
    const conditions: string[] = []
    const params: (string | number)[] = [jobId]

    for (const r of roots) {
      const normRoot = normalizePathForLookup(r)
      const prefix = normRoot + sep
      conditions.push('(fl.normalized_path = ? OR substr(fl.normalized_path, 1, ?) = ?)')
      params.push(normRoot, prefix.length, prefix)
    }

    const sql = `
      INSERT OR IGNORE INTO scan_job_files (job_id, file_location_id)
      SELECT ?, fl.id
      FROM file_locations fl
      JOIN discovery_observations d ON d.file_location_id = fl.id AND d.is_current = 1
      LEFT JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1
      WHERE h.id IS NULL
        AND (${conditions.join(' OR ')});
    `
    const res = this.db.prepare(sql).run(...params)
    return Number(res.changes)
  }

  public clearScanJobFiles(jobId: number): void {
    this.assertOpen()
    validateSafeInteger(jobId, 'jobId', 1)
    this.db.prepare('DELETE FROM scan_job_files WHERE job_id = ?;').run(jobId)
  }

  public countUnhashedFilesForJob(jobId: number): UnhashedCountResult {
    this.assertOpen()
    validateSafeInteger(jobId, 'jobId', 1)
    const stmt = this.db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(d.byte_size), 0) AS total_bytes
      FROM scan_job_files sjf
      JOIN file_locations fl ON sjf.file_location_id = fl.id
      JOIN discovery_observations d ON d.file_location_id = fl.id AND d.is_current = 1
      LEFT JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1
      WHERE sjf.job_id = ?
        AND h.id IS NULL;
    `)
    const row = stmt.get(jobId) as { count: number; total_bytes: number } | undefined
    return {
      count: row?.count ?? 0,
      totalBytes: row?.total_bytes ?? 0
    }
  }

  public countDiscoveredFilesForJob(jobId: number): { count: number; totalBytes: number } {
    this.assertOpen()
    validateSafeInteger(jobId, 'jobId', 1)
    const stmt = this.db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(d.byte_size), 0) AS total_bytes
      FROM scan_job_files sjf
      JOIN discovery_observations d ON d.file_location_id = sjf.file_location_id AND d.is_current = 1
      WHERE sjf.job_id = ?;
    `)
    const row = stmt.get(jobId) as { count: number; total_bytes: number } | undefined
    return {
      count: row?.count ?? 0,
      totalBytes: row?.total_bytes ?? 0
    }
  }

  public getUnhashedFilesForJob(
    jobId: number,
    options?: UnhashedFilesOptions
  ): readonly UnhashedFileRecord[] {
    this.assertOpen()
    validateSafeInteger(jobId, 'jobId', 1)
    const limit =
      options?.limit !== undefined
        ? validateSafeInteger(options.limit, 'limit', 1, MAX_PAGE_LIMIT)
        : 1000

    const hasAfterId = options?.afterId !== undefined
    const afterId = hasAfterId ? validateSafeInteger(options!.afterId!, 'afterId', 0) : 0
    const whereAfterId = hasAfterId ? 'AND fl.id > ?' : ''

    const stmt = this.db.prepare(`
      SELECT
        fl.id AS file_location_id,
        fl.original_path,
        d.id AS discovery_observation_id,
        d.byte_size,
        d.filesystem_birthtime_ms,
        d.filesystem_mtime_ms
      FROM scan_job_files sjf
      JOIN file_locations fl ON sjf.file_location_id = fl.id
      JOIN discovery_observations d ON d.file_location_id = fl.id AND d.is_current = 1
      LEFT JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1
      WHERE sjf.job_id = ?
        AND h.id IS NULL
        ${whereAfterId}
      ORDER BY fl.id ASC
      LIMIT ?;
    `)
    const params = hasAfterId ? [jobId, afterId, limit] : [jobId, limit]
    const rows = stmt.all(...params) as Array<{
      file_location_id: number
      original_path: string
      discovery_observation_id: number
      byte_size: number
      filesystem_birthtime_ms: number | null
      filesystem_mtime_ms: number | null
    }>
    return rows.map((r) => ({
      fileLocationId: r.file_location_id,
      discoveryObservationId: r.discovery_observation_id,
      originalPath: r.original_path,
      byteSize: r.byte_size,
      filesystemBirthtimeMs: r.filesystem_birthtime_ms,
      filesystemMtimeMs: r.filesystem_mtime_ms
    }))
  }

  public countSources(): number {
    this.assertOpen()
    const row = this.db.prepare('SELECT COUNT(*) as count FROM sources;').get() as { count: number }
    return row.count
  }

  public countFileLocations(): number {
    this.assertOpen()
    const row = this.db.prepare('SELECT COUNT(*) as count FROM file_locations;').get() as {
      count: number
    }
    return row.count
  }

  public getFileLocationByOriginalPath(originalPath: string): CatalogFileRecord | null {
    this.assertOpen()
    if (!originalPath || typeof originalPath !== 'string') {
      throw new TypeError('originalPath must be a non-empty string')
    }
    const sql = `
      SELECT
        f.id, f.source_id, f.original_path, f.normalized_path, f.file_name, f.extension, f.category,
        f.created_at_ms as first_discovered_at_ms, f.updated_at_ms as last_seen_at_ms,
        d.id as discovery_observation_id, d.byte_size, d.filesystem_birthtime_ms,
        d.filesystem_mtime_ms, d.inferred_capture_time_ms,
        h.sha256 as active_hash, h.hashed_at_ms as active_hash_verified_at_ms
      FROM file_locations f
      JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1
      LEFT JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1
      WHERE f.original_path = ?;
    `
    const row = this.db.prepare(sql).get(originalPath) as unknown as RawFileRow | undefined
    return row ? this.mapFileRow(row) : null
  }

  // ==========================================
  // Stage 4: Vault & Verified Import Methods
  // ==========================================

  public registerVault(input: RegisterVaultInput): CatalogVaultRecord {
    this.assertOpen()
    if (!input.vaultId || typeof input.vaultId !== 'string') {
      throw new TypeError('vaultId must be a non-empty string')
    }
    if (!input.vaultPath || typeof input.vaultPath !== 'string') {
      throw new TypeError('vaultPath must be a non-empty string')
    }
    const normalizedVaultPath = normalizePathForLookup(input.vaultPath)
    const now = Date.now()

    this.db.exec('BEGIN TRANSACTION;')
    try {
      // Deactivate any currently active vaults
      this.db.prepare('UPDATE vaults SET is_active = 0;').run()

      // Upsert the vault record
      const isReadOnlyFlag = input.isReadOnly ? 1 : 0
      const stmt = this.db.prepare(`
        INSERT INTO vaults (vault_id, vault_path, normalized_vault_path, name, created_at_ms, updated_at_ms, is_active, is_read_only)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT(vault_id) DO UPDATE SET
          vault_path = excluded.vault_path,
          normalized_vault_path = excluded.normalized_vault_path,
          name = excluded.name,
          updated_at_ms = excluded.updated_at_ms,
          is_active = 1,
          is_read_only = CASE WHEN vaults.is_read_only = 1 THEN 1 ELSE excluded.is_read_only END;
      `)
      stmt.run(
        input.vaultId,
        input.vaultPath,
        normalizedVaultPath,
        input.name,
        input.createdAtMs,
        now,
        isReadOnlyFlag
      )
      this.db.exec('COMMIT;')
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;')
      } catch {
        // Ignore rollback failure
      }
      throw err
    }

    const row = this.db
      .prepare('SELECT * FROM vaults WHERE vault_id = ?;')
      .get(input.vaultId) as unknown as RawVaultRow
    return {
      id: row.id,
      vaultId: row.vault_id,
      vaultPath: row.vault_path,
      normalizedVaultPath: row.normalized_vault_path,
      name: row.name,
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms,
      isActive: row.is_active === 1,
      isReadOnly: row.is_read_only === 1
    }
  }

  public getActiveVault(): CatalogVaultRecord | null {
    this.assertOpen()
    const row = this.db
      .prepare('SELECT * FROM vaults WHERE is_active = 1 ORDER BY updated_at_ms DESC LIMIT 1;')
      .get() as unknown as RawVaultRow | undefined
    if (!row) return null
    return {
      id: row.id,
      vaultId: row.vault_id,
      vaultPath: row.vault_path,
      normalizedVaultPath: row.normalized_vault_path,
      name: row.name,
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms,
      isActive: true,
      isReadOnly: row.is_read_only === 1
    }
  }

  public setActiveVault(vaultPath: string): CatalogVaultRecord {
    this.assertOpen()
    const normalized = normalizePathForLookup(vaultPath)
    const row = this.db
      .prepare('SELECT * FROM vaults WHERE normalized_vault_path = ?;')
      .get(normalized) as unknown as RawVaultRow | undefined
    if (!row) {
      throw new Error(`Vault at path "${vaultPath}" is not registered in catalog`)
    }
    this.db.exec('BEGIN TRANSACTION;')
    try {
      this.db.prepare('UPDATE vaults SET is_active = 0;').run()
      this.db
        .prepare('UPDATE vaults SET is_active = 1, updated_at_ms = ? WHERE id = ?;')
        .run(Date.now(), row.id)
      this.db.exec('COMMIT;')
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;')
      } catch {
        // Ignore rollback failure
      }
      throw err
    }
    return {
      id: row.id,
      vaultId: row.vault_id,
      vaultPath: row.vault_path,
      normalizedVaultPath: row.normalized_vault_path,
      name: row.name,
      createdAtMs: row.created_at_ms,
      updatedAtMs: Date.now(),
      isActive: true,
      isReadOnly: row.is_read_only === 1
    }
  }

  public recordVaultCopy(input: RecordVaultCopyInput): CatalogVaultCopyRecord {
    this.assertOpen()
    const now = Date.now()
    const stmt = this.db.prepare(`
      INSERT INTO vault_copies (
        vault_id, sha256, byte_size, relative_path, manifest_relative_path,
        verified_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(vault_id, sha256, byte_size) DO UPDATE SET
        relative_path = excluded.relative_path,
        manifest_relative_path = excluded.manifest_relative_path,
        verified_at_ms = excluded.verified_at_ms,
        updated_at_ms = excluded.updated_at_ms;
    `)
    stmt.run(
      input.vaultId,
      input.sha256,
      input.byteSize,
      input.relativePath,
      input.manifestRelativePath,
      input.verifiedAtMs,
      now,
      now
    )

    const row = this.db
      .prepare('SELECT * FROM vault_copies WHERE vault_id = ? AND sha256 = ? AND byte_size = ?;')
      .get(input.vaultId, input.sha256, input.byteSize) as unknown as RawVaultCopyRow
    return {
      id: row.id,
      vaultId: row.vault_id,
      sha256: row.sha256,
      byteSize: row.byte_size,
      relativePath: row.relative_path,
      manifestRelativePath: row.manifest_relative_path,
      verifiedAtMs: row.verified_at_ms,
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms
    }
  }

  public getVaultCopiesForVault(vaultId: string): CatalogVaultCopyRecord[] {
    this.assertOpen()
    const rows = this.db
      .prepare('SELECT * FROM vault_copies WHERE vault_id = ? ORDER BY id ASC;')
      .all(vaultId) as unknown as RawVaultCopyRow[]
    return rows.map((r) => ({
      id: r.id,
      vaultId: r.vault_id,
      sha256: r.sha256,
      byteSize: r.byte_size,
      relativePath: r.relative_path,
      manifestRelativePath: r.manifest_relative_path,
      verifiedAtMs: r.verified_at_ms,
      createdAtMs: r.created_at_ms,
      updatedAtMs: r.updated_at_ms
    }))
  }

  public getVaultCopy(
    vaultId: string,
    sha256: string,
    byteSize: number
  ): CatalogVaultCopyRecord | null {
    this.assertOpen()
    const row = this.db
      .prepare('SELECT * FROM vault_copies WHERE vault_id = ? AND sha256 = ? AND byte_size = ?;')
      .get(vaultId, sha256, byteSize) as unknown as RawVaultCopyRow | undefined
    if (!row) return null
    return {
      id: row.id,
      vaultId: row.vault_id,
      sha256: row.sha256,
      byteSize: row.byte_size,
      relativePath: row.relative_path,
      manifestRelativePath: row.manifest_relative_path,
      verifiedAtMs: row.verified_at_ms,
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms
    }
  }

  public createVaultImportJob(input: CreateVaultImportJobInput): CatalogVaultImportJobRecord {
    this.assertOpen()
    const now = Date.now()
    this.db.exec('BEGIN TRANSACTION;')
    try {
      this.db
        .prepare(
          `
          INSERT INTO vault_imports (
            id, vault_id, status, total_files, total_bytes, copied_files,
            copied_bytes, verified_files, failed_files, started_at_ms
          ) VALUES (?, ?, 'running', ?, ?, 0, 0, 0, 0, ?);
        `
        )
        .run(input.jobId, input.vaultId, input.totalFiles, input.totalBytes, now)

      const itemStmt = this.db.prepare(`
        INSERT INTO vault_import_items (
          import_id, file_location_id, discovery_observation_id, hash_observation_id,
          sha256, byte_size, status, started_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?);
      `)

      for (const item of input.items) {
        itemStmt.run(
          input.jobId,
          item.fileLocationId,
          item.discoveryObservationId,
          item.hashObservationId ?? null,
          item.sha256,
          item.byteSize,
          now
        )
      }

      this.db.exec('COMMIT;')
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;')
      } catch {
        // Ignore rollback failure
      }
      throw err
    }

    const job = this.getVaultImportJob(input.jobId)
    if (!job) throw new Error('Failed to create vault import job')
    return job
  }

  public getVaultImportJob(jobId: string): CatalogVaultImportJobRecord | null {
    this.assertOpen()
    const row = this.db
      .prepare('SELECT * FROM vault_imports WHERE id = ?;')
      .get(jobId) as unknown as RawVaultImportRow | undefined
    if (!row) return null
    return {
      id: row.id,
      vaultId: row.vault_id,
      status: row.status,
      totalFiles: row.total_files,
      totalBytes: row.total_bytes,
      copiedFiles: row.copied_files,
      copiedBytes: row.copied_bytes,
      verifiedFiles: row.verified_files,
      failedFiles: row.failed_files,
      startedAtMs: row.started_at_ms,
      completedAtMs: row.completed_at_ms,
      errorMessage: row.error_message
    }
  }

  public getActiveVaultImportJob(): CatalogVaultImportJobRecord | null {
    this.assertOpen()
    const row = this.db
      .prepare(
        "SELECT * FROM vault_imports WHERE status IN ('running', 'paused', 'interrupted') ORDER BY started_at_ms DESC LIMIT 1;"
      )
      .get() as unknown as RawVaultImportRow | undefined
    if (!row) return null
    return {
      id: row.id,
      vaultId: row.vault_id,
      status: row.status,
      totalFiles: row.total_files,
      totalBytes: row.total_bytes,
      copiedFiles: row.copied_files,
      copiedBytes: row.copied_bytes,
      verifiedFiles: row.verified_files,
      failedFiles: row.failed_files,
      startedAtMs: row.started_at_ms,
      completedAtMs: row.completed_at_ms,
      errorMessage: row.error_message
    }
  }

  public getLatestVaultImportJob(): CatalogVaultImportJobRecord | null {
    this.assertOpen()
    const row = this.db
      .prepare('SELECT * FROM vault_imports ORDER BY started_at_ms DESC LIMIT 1;')
      .get() as unknown as RawVaultImportRow | undefined
    if (!row) return null
    return {
      id: row.id,
      vaultId: row.vault_id,
      status: row.status,
      totalFiles: row.total_files,
      totalBytes: row.total_bytes,
      copiedFiles: row.copied_files,
      copiedBytes: row.copied_bytes,
      verifiedFiles: row.verified_files,
      failedFiles: row.failed_files,
      startedAtMs: row.started_at_ms,
      completedAtMs: row.completed_at_ms,
      errorMessage: row.error_message
    }
  }

  public updateVaultImportProgress(input: UpdateVaultImportProgressInput): void {
    this.assertOpen()
    let sql = `
      UPDATE vault_imports SET
        copied_files = ?,
        copied_bytes = ?,
        verified_files = ?,
        failed_files = ?
    `
    const params: SQLInputValue[] = [
      input.copiedFiles,
      input.copiedBytes,
      input.verifiedFiles,
      input.failedFiles
    ]
    if (input.status !== undefined) {
      sql += ', status = ?'
      params.push(input.status)
    }
    if (input.errorMessage !== undefined) {
      sql += ', error_message = ?'
      params.push(input.errorMessage)
    }
    if (input.completedAtMs !== undefined) {
      sql += ', completed_at_ms = ?'
      params.push(input.completedAtMs)
    }
    sql += ' WHERE id = ?;'
    params.push(input.jobId)

    this.db.prepare(sql).run(...params)
  }

  public updateVaultImportStatus(
    jobId: string,
    status: 'running' | 'paused' | 'cancelled' | 'interrupted' | 'failed' | 'completed',
    errorMessage?: string | null,
    completedAtMs?: number | null
  ): void {
    this.assertOpen()
    let sql = 'UPDATE vault_imports SET status = ?'
    const params: SQLInputValue[] = [status]
    if (errorMessage !== undefined) {
      sql += ', error_message = ?'
      params.push(errorMessage)
    }
    if (completedAtMs !== undefined) {
      sql += ', completed_at_ms = ?'
      params.push(completedAtMs)
    }
    sql += ' WHERE id = ?;'
    params.push(jobId)
    this.db.prepare(sql).run(...params)
  }

  public updateVaultImportItem(input: UpdateVaultImportItemInput): void {
    this.assertOpen()
    let sql = 'UPDATE vault_import_items SET status = ?'
    const params: SQLInputValue[] = [input.status]
    if (input.vaultCopyId !== undefined) {
      sql += ', vault_copy_id = ?'
      params.push(input.vaultCopyId)
    }
    if (input.errorCode !== undefined) {
      sql += ', error_code = ?'
      params.push(input.errorCode)
    }
    if (input.errorMessage !== undefined) {
      sql += ', error_message = ?'
      params.push(input.errorMessage)
    }
    if (input.completedAtMs !== undefined) {
      sql += ', completed_at_ms = ?'
      params.push(input.completedAtMs)
    }
    sql += ' WHERE import_id = ? AND file_location_id = ?;'
    params.push(input.jobId, input.fileLocationId)

    this.db.prepare(sql).run(...params)
  }

  public markRunningImportJobsAsInterrupted(): number {
    this.assertOpen()
    const result = this.db
      .prepare(
        "UPDATE vault_imports SET status = 'interrupted' WHERE status IN ('running', 'paused');"
      )
      .run()
    return Number(result.changes)
  }

  public getImportCandidates(options: GetImportCandidatesOptions): ImportCandidatesResult {
    this.assertOpen()
    const limit = options.limit ?? 50
    const offset = options.offset ?? 0
    const filter = options.filter ?? 'all'

    let whereClause = `
      WHERE d.is_current = 1
        AND h.is_active = 1
        AND h.observed_byte_size = d.byte_size
    `
    const countParams: SQLInputValue[] = [options.vaultId]

    if (options.category) {
      whereClause += ' AND fl.category = ?'
      countParams.push(options.category)
    }

    if (filter === 'unimported') {
      whereClause += ' AND vc.id IS NULL'
    } else if (filter === 'imported') {
      whereClause += ' AND vc.id IS NOT NULL'
    }

    const countSql = `
      SELECT COUNT(*) as total
      FROM file_locations fl
      JOIN discovery_observations d ON d.file_location_id = fl.id
      JOIN hash_observations h ON h.discovery_observation_id = d.id
      LEFT JOIN vault_copies vc ON vc.vault_id = ? AND vc.sha256 = h.sha256 AND vc.byte_size = d.byte_size
      ${whereClause};
    `
    const countRow = this.db.prepare(countSql).get(...countParams) as { total: number }
    const totalCount = countRow ? countRow.total : 0

    const querySql = `
      SELECT
        fl.id as file_location_id,
        fl.source_id,
        fl.original_path,
        fl.file_name,
        fl.extension,
        fl.category,
        d.byte_size,
        d.filesystem_birthtime_ms,
        d.filesystem_mtime_ms,
        d.observed_at_ms as first_discovered_at_ms,
        d.last_seen_at_ms,
        d.inferred_capture_time_ms,
        h.sha256,
        d.id as discovery_observation_id,
        h.id as hash_observation_id,
        h.hashed_at_ms,
        vc.id as vault_copy_id,
        CASE WHEN vc.id IS NOT NULL THEN 'copied' ELSE 'not_imported' END as vault_status,
        CASE WHEN dr.preferred_location_id = fl.id THEN 1 ELSE 0 END as is_preferred
      FROM file_locations fl
      JOIN discovery_observations d ON d.file_location_id = fl.id
      JOIN hash_observations h ON h.discovery_observation_id = d.id
      LEFT JOIN vault_copies vc ON vc.vault_id = ? AND vc.sha256 = h.sha256 AND vc.byte_size = d.byte_size
      LEFT JOIN duplicate_reviews dr ON dr.sha256 = h.sha256 AND dr.byte_size = d.byte_size
      ${whereClause}
      ORDER BY fl.id ASC
      LIMIT ? OFFSET ?;
    `
    const queryParams: SQLInputValue[] = [...countParams, limit, offset]
    const rows = this.db.prepare(querySql).all(...queryParams) as unknown as RawImportCandidateRow[]

    const items: ImportCandidateItem[] = rows.map((r) => ({
      fileLocationId: r.file_location_id,
      sourceId: r.source_id,
      originalPath: r.original_path,
      fileName: r.file_name,
      extension: r.extension,
      category: r.category,
      byteSize: r.byte_size,
      filesystemBirthtimeMs: r.filesystem_birthtime_ms,
      filesystemMtimeMs: r.filesystem_mtime_ms,
      firstDiscoveredAtMs: r.first_discovered_at_ms,
      lastSeenAtMs: r.last_seen_at_ms,
      inferredCaptureTimeMs: r.inferred_capture_time_ms,
      sha256: r.sha256,
      discoveryObservationId: r.discovery_observation_id,
      hashObservationId: r.hash_observation_id,
      hashVerifiedAtMs: r.hashed_at_ms,
      vaultStatus: r.vault_status,
      vaultCopyId: r.vault_copy_id,
      isPreferred: r.is_preferred === 1
    }))

    return {
      items,
      totalCount,
      offset,
      limit,
      hasMore: offset + items.length < totalCount
    }
  }

  public getImportCandidatesByLocationIds(
    vaultId: string,
    locationIds: readonly number[]
  ): ImportCandidateItem[] {
    this.assertOpen()
    if (locationIds.length === 0) return []

    const results: ImportCandidateItem[] = []
    const CHUNK_SIZE = 500

    for (let i = 0; i < locationIds.length; i += CHUNK_SIZE) {
      const chunk = locationIds.slice(i, i + CHUNK_SIZE)
      const placeholders = chunk.map(() => '?').join(',')
      const sql = `
        SELECT
          fl.id as file_location_id,
          fl.source_id,
          fl.original_path,
          fl.file_name,
          fl.extension,
          fl.category,
          d.byte_size,
          d.filesystem_birthtime_ms,
          d.filesystem_mtime_ms,
          d.observed_at_ms as first_discovered_at_ms,
          d.last_seen_at_ms,
          d.inferred_capture_time_ms,
          h.sha256,
          d.id as discovery_observation_id,
          h.id as hash_observation_id,
          h.hashed_at_ms,
          vc.id as vault_copy_id,
          CASE WHEN vc.id IS NOT NULL THEN 'copied' ELSE 'not_imported' END as vault_status,
          CASE WHEN dr.preferred_location_id = fl.id THEN 1 ELSE 0 END as is_preferred
        FROM file_locations fl
        JOIN discovery_observations d ON d.file_location_id = fl.id
        JOIN hash_observations h ON h.discovery_observation_id = d.id
        LEFT JOIN vault_copies vc ON vc.vault_id = ? AND vc.sha256 = h.sha256 AND vc.byte_size = d.byte_size
        LEFT JOIN duplicate_reviews dr ON dr.sha256 = h.sha256 AND dr.byte_size = d.byte_size
        WHERE d.is_current = 1
          AND h.is_active = 1
          AND h.observed_byte_size = d.byte_size
          AND fl.id IN (${placeholders})
        ORDER BY fl.id ASC;
      `
      const rows = this.db.prepare(sql).all(vaultId, ...chunk) as unknown as RawImportCandidateRow[]
      for (const r of rows) {
        results.push({
          fileLocationId: r.file_location_id,
          sourceId: r.source_id,
          originalPath: r.original_path,
          fileName: r.file_name,
          extension: r.extension,
          category: r.category,
          byteSize: r.byte_size,
          filesystemBirthtimeMs: r.filesystem_birthtime_ms,
          filesystemMtimeMs: r.filesystem_mtime_ms,
          firstDiscoveredAtMs: r.first_discovered_at_ms,
          lastSeenAtMs: r.last_seen_at_ms,
          inferredCaptureTimeMs: r.inferred_capture_time_ms,
          sha256: r.sha256,
          discoveryObservationId: r.discovery_observation_id,
          hashObservationId: r.hash_observation_id,
          hashVerifiedAtMs: r.hashed_at_ms,
          vaultStatus: r.vault_status,
          vaultCopyId: r.vault_copy_id,
          isPreferred: r.is_preferred === 1
        })
      }
    }
    return results
  }

  public getVaultImportItems(jobId: string): VaultImportItemDetail[] {
    this.assertOpen()
    const sql = `
      SELECT
        vi.file_location_id,
        vi.discovery_observation_id,
        vi.hash_observation_id,
        vi.sha256,
        vi.byte_size,
        vi.status,
        fl.source_id,
        fl.original_path,
        fl.file_name,
        fl.extension,
        fl.category,
        d.filesystem_birthtime_ms,
        d.filesystem_mtime_ms,
        d.observed_at_ms as first_discovered_at_ms,
        d.last_seen_at_ms,
        d.inferred_capture_time_ms,
        CASE WHEN d.is_current = 1 AND d.id = vi.discovery_observation_id THEN 1 ELSE 0 END as is_discovery_current,
        h.hashed_at_ms,
        CASE WHEN h.is_active = 1 AND (vi.hash_observation_id IS NULL OR h.id = vi.hash_observation_id) THEN 1 ELSE 0 END as is_hash_active,
        CASE WHEN dr.preferred_location_id = fl.id THEN 1 ELSE 0 END as is_preferred
      FROM vault_import_items vi
      JOIN file_locations fl ON fl.id = vi.file_location_id
      LEFT JOIN discovery_observations d ON d.id = vi.discovery_observation_id
      LEFT JOIN hash_observations h ON h.id = vi.hash_observation_id
      LEFT JOIN duplicate_reviews dr ON dr.sha256 = vi.sha256 AND dr.byte_size = vi.byte_size
      WHERE vi.import_id = ?
      ORDER BY vi.id ASC;
    `
    const rows = this.db.prepare(sql).all(jobId) as unknown as RawVaultImportItemDetailRow[]
    return rows.map((r) => ({
      fileLocationId: r.file_location_id,
      discoveryObservationId: r.discovery_observation_id,
      hashObservationId: r.hash_observation_id,
      sha256: r.sha256,
      byteSize: r.byte_size,
      status: r.status,
      sourceId: r.source_id,
      originalPath: r.original_path,
      fileName: r.file_name,
      extension: r.extension,
      category: r.category,
      filesystemBirthtimeMs: r.filesystem_birthtime_ms,
      filesystemMtimeMs: r.filesystem_mtime_ms,
      firstDiscoveredAtMs: r.first_discovered_at_ms ?? 0,
      lastSeenAtMs: r.last_seen_at_ms ?? 0,
      inferredCaptureTimeMs: r.inferred_capture_time_ms,
      hashVerifiedAtMs: r.hashed_at_ms,
      isDiscoveryCurrent: r.is_discovery_current === 1,
      isHashActive: r.is_hash_active === 1,
      isPreferred: r.is_preferred === 1
    }))
  }

  // ==========================================
  // Stage 5B: Photo Review & Collections Methods
  // ==========================================

  private maybeHoldPersistenceBarrier(opId: string, entrySeq: number): void {
    const barrierSignal = process.env.PV_TEST_PERSISTENCE_BARRIER_SIGNAL
    if (!barrierSignal) return
    try {
      writeFileSync(barrierSignal, `${opId}\n${entrySeq}\n`)
    } catch {
      // ignore
    }
    if (process.env.PV_TEST_PERSISTENCE_BARRIER_HOLD === '1') {
      const releaseFile = process.env.PV_TEST_PERSISTENCE_BARRIER_RELEASE
      const deadline = Date.now() + 10000
      while (Date.now() < deadline) {
        if (releaseFile && existsSync(releaseFile)) break
        const sab = new SharedArrayBuffer(4)
        const int32 = new Int32Array(sab)
        Atomics.wait(int32, 0, 0, 50)
      }
    }
  }

  public setJournal(journal: AnnotationJournal): void {
    this.assertOpen()
    this.journal = journal
    this.reconcileJournalWithDatabase()
  }

  public getAllSourceRoots(): string[] {
    this.assertOpen()
    const rows = this.db
      .prepare("SELECT root_path FROM sources WHERE source_kind = 'user' ORDER BY id ASC;")
      .all() as Array<{
      root_path: string
    }>
    return rows.map((r) => r.root_path)
  }

  public getLocationReadResolutionContext(
    locationId: number
  ): LocationReadResolutionContext | null {
    this.assertOpen()
    const row = this.db
      .prepare(
        `
        SELECT
          fl.id AS location_id,
          fl.source_id AS source_id,
          s.root_path AS source_root_path,
          s.source_kind AS source_kind,
          fl.original_path AS original_path,
          d.byte_size AS byte_size,
          d.filesystem_mtime_ms AS filesystem_mtime_ms,
          h.sha256 AS active_hash
        FROM file_locations fl
        JOIN sources s ON s.id = fl.source_id
        JOIN discovery_observations d ON d.file_location_id = fl.id AND d.is_current = 1
        LEFT JOIN hash_observations h ON h.file_location_id = fl.id AND h.discovery_observation_id = d.id AND h.is_active = 1
        WHERE fl.id = ?
        LIMIT 1;
      `
      )
      .get(locationId) as
      | {
          location_id: number
          source_id: number
          source_root_path: string
          source_kind: 'user' | 'recovery_manifest'
          original_path: string
          byte_size: number
          filesystem_mtime_ms: number | null
          active_hash: string | null
        }
      | undefined

    if (!row) return null
    return {
      locationId: row.location_id,
      sourceId: row.source_id,
      sourceRootPath: row.source_root_path,
      sourceKind: row.source_kind,
      originalPath: row.original_path,
      byteSize: row.byte_size,
      filesystemMtimeMs: row.filesystem_mtime_ms,
      activeHash: row.active_hash
    }
  }

  public reconcileJournalWithDatabase(): { reconciledCount: number } {
    if (!this.journal) return { reconciledCount: 0 }
    this.assertOpen()

    const checkpointRow = this.db
      .prepare('SELECT last_applied_seq FROM journal_checkpoints WHERE singleton_id = 1;')
      .get() as { last_applied_seq: number } | undefined
    if (!checkpointRow) {
      this.db
        .prepare(
          'INSERT INTO journal_checkpoints (singleton_id, last_applied_seq, last_op_id, updated_at_ms) VALUES (1, 0, NULL, ?);'
        )
        .run(Date.now())
    }

    // Use a temp table to avoid accumulating journal entries in Node heap.
    this.db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS temp_journal_scan (
        op_id TEXT PRIMARY KEY,
        entry_seq INTEGER NOT NULL,
        is_terminal INTEGER NOT NULL
      );
      DELETE FROM temp_journal_scan;
    `)

    const insertScanStmt = this.db.prepare(`
      INSERT INTO temp_journal_scan (op_id, entry_seq, is_terminal)
      VALUES (?, ?, ?)
      ON CONFLICT(op_id) DO UPDATE SET
        entry_seq = excluded.entry_seq,
        is_terminal = CASE WHEN excluded.is_terminal = 1 THEN 1 ELSE temp_journal_scan.is_terminal END;
    `)

    for (const entry of this.journal.iterateEntriesSync()) {
      const isTerminal = entry.kind === 'op_committed' || entry.kind === 'op_aborted' ? 1 : 0
      insertScanStmt.run(entry.opId, entry.entrySeq, isTerminal)
    }

    // Query unterminated operations joining indexed journal_operations table using bounded streaming iterator
    const unterminatedIter = this.db
      .prepare(
        `
        SELECT t.op_id, t.entry_seq, jo.status
        FROM temp_journal_scan t
        LEFT JOIN journal_operations jo ON jo.op_id = t.op_id
        WHERE t.is_terminal = 0;
      `
      )
      .iterate() as Iterable<{ op_id: string; entry_seq: number; status: string | null }>

    let reconciledCount = 0
    for (const row of unterminatedIter) {
      if (row.status === 'committed') {
        this.journal.appendCommitRecordSync({ opId: row.op_id, targetSeq: row.entry_seq })
      } else {
        this.journal.appendAbortRecordSync({
          opId: row.op_id,
          targetSeq: row.entry_seq,
          reason: 'Startup reconciliation: uncommitted transaction aborted'
        })
      }
      reconciledCount++
    }

    this.db.exec('DROP TABLE IF EXISTS temp_journal_scan;')

    const latestSeq = this.journal.getLatestSeq()
    this.db
      .prepare(
        'UPDATE journal_checkpoints SET last_applied_seq = ?, updated_at_ms = ? WHERE singleton_id = 1;'
      )
      .run(latestSeq, Date.now())

    return { reconciledCount }
  }

  public createCollection(input: CreateCollectionInput): CatalogCollectionRecord {
    this.assertOpen()
    const normalizedName = normalizeCollectionName(input.name)
    const name = input.name.trim()
    const now = Date.now()

    const existing = this.db
      .prepare('SELECT id FROM collections WHERE normalized_name = ?;')
      .get(normalizedName)
    if (existing) {
      throw new Error(`Collection with name '${name}' already exists`)
    }

    const opId = randomUUID()
    let journalEntry:
      import('../../../shared/validation/ipc-schemas').AnnotationJournalEntry | undefined
    let isCommitted = false

    this.db.exec('BEGIN IMMEDIATE;')
    try {
      const stmt = this.db.prepare(`
        INSERT INTO collections (name, normalized_name, created_at_ms, updated_at_ms)
        VALUES (?, ?, ?, ?)
        RETURNING id, name, normalized_name, created_at_ms, updated_at_ms;
      `)
      const row = stmt.get(name, normalizedName, now, now) as {
        id: number
        name: string
        normalized_name: string
        created_at_ms: number
        updated_at_ms: number
      }

      if (this.journal) {
        journalEntry = this.journal.appendCollectionCreatedSync({
          opId,
          collectionId: row.id,
          name: row.name,
          normalizedName: row.normalized_name
        })
      }

      this.maybeHoldPersistenceBarrier(opId, journalEntry ? journalEntry.entrySeq : 0)

      this.db
        .prepare(
          "INSERT INTO journal_operations (op_id, entry_seq, kind, status, applied_at_ms) VALUES (?, ?, 'collection_created', 'committed', ?);"
        )
        .run(opId, journalEntry ? journalEntry.entrySeq : 0, now)

      this.db.exec('COMMIT;')
      isCommitted = true

      let persistencePending = false
      let persistenceError: string | undefined
      if (this.journal && journalEntry) {
        try {
          this.journal.appendCommitRecordSync({
            opId,
            targetSeq: journalEntry.entrySeq
          })
        } catch (commitErr) {
          persistencePending = true
          persistenceError = commitErr instanceof Error ? commitErr.message : String(commitErr)
        }
      }

      return {
        id: row.id,
        name: row.name,
        normalizedName: row.normalized_name,
        createdAtMs: row.created_at_ms,
        updatedAtMs: row.updated_at_ms,
        photoCount: 0,
        ...(persistencePending ? { persistencePending } : {}),
        ...(persistenceError ? { persistenceError } : {})
      }
    } catch (err) {
      if (isCommitted) {
        throw err
      }
      try {
        this.db.exec('ROLLBACK;')
      } catch {
        // ignore
      }
      if (this.journal && journalEntry) {
        try {
          this.journal.appendAbortRecordSync({
            opId,
            targetSeq: journalEntry.entrySeq,
            reason: err instanceof Error ? err.message : String(err)
          })
        } catch {
          // ignore
        }
      }
      throw err
    }
  }

  public renameCollection(input: RenameCollectionInput): CatalogCollectionRecord {
    this.assertOpen()
    if (!input.collectionId || input.collectionId <= 0) {
      throw new TypeError('collectionId must be a positive integer')
    }
    const normalizedName = normalizeCollectionName(input.name)
    const name = input.name.trim()
    const now = Date.now()

    const current = this.db
      .prepare('SELECT id, name FROM collections WHERE id = ?;')
      .get(input.collectionId) as { id: number; name: string } | undefined
    if (!current) {
      throw new Error(`Collection with ID ${input.collectionId} not found`)
    }

    const conflict = this.db
      .prepare('SELECT id FROM collections WHERE normalized_name = ? AND id != ?;')
      .get(normalizedName, input.collectionId)
    if (conflict) {
      throw new Error(`Collection with name '${name}' already exists`)
    }

    const opId = randomUUID()
    let journalEntry:
      import('../../../shared/validation/ipc-schemas').AnnotationJournalEntry | undefined
    let isCommitted = false

    this.db.exec('BEGIN IMMEDIATE;')
    try {
      const stmt = this.db.prepare(`
        UPDATE collections
        SET name = ?, normalized_name = ?, updated_at_ms = ?
        WHERE id = ?
        RETURNING id, name, normalized_name, created_at_ms, updated_at_ms;
      `)
      const row = stmt.get(name, normalizedName, now, input.collectionId) as {
        id: number
        name: string
        normalized_name: string
        created_at_ms: number
        updated_at_ms: number
      }

      if (this.journal) {
        journalEntry = this.journal.appendCollectionRenamedSync({
          opId,
          collectionId: row.id,
          oldName: current.name,
          newName: row.name,
          normalizedName: row.normalized_name
        })
      }

      this.maybeHoldPersistenceBarrier(opId, journalEntry ? journalEntry.entrySeq : 0)

      this.db
        .prepare(
          "INSERT INTO journal_operations (op_id, entry_seq, kind, status, applied_at_ms) VALUES (?, ?, 'collection_renamed', 'committed', ?);"
        )
        .run(opId, journalEntry ? journalEntry.entrySeq : 0, now)

      this.db.exec('COMMIT;')
      isCommitted = true

      let persistencePending = false
      let persistenceError: string | undefined
      if (this.journal && journalEntry) {
        try {
          this.journal.appendCommitRecordSync({
            opId,
            targetSeq: journalEntry.entrySeq
          })
        } catch (commitErr) {
          persistencePending = true
          persistenceError = commitErr instanceof Error ? commitErr.message : String(commitErr)
        }
      }

      return {
        id: row.id,
        name: row.name,
        normalizedName: row.normalized_name,
        createdAtMs: row.created_at_ms,
        updatedAtMs: row.updated_at_ms,
        ...(persistencePending ? { persistencePending } : {}),
        ...(persistenceError ? { persistenceError } : {})
      }
    } catch (err) {
      if (isCommitted) {
        throw err
      }
      try {
        this.db.exec('ROLLBACK;')
      } catch {
        // ignore
      }
      if (this.journal && journalEntry) {
        try {
          this.journal.appendAbortRecordSync({
            opId,
            targetSeq: journalEntry.entrySeq,
            reason: err instanceof Error ? err.message : String(err)
          })
        } catch {
          // ignore
        }
      }
      throw err
    }
  }

  public listCollections(options?: PaginationOptions): PaginatedResult<CatalogCollectionRecord> {
    this.assertOpen()
    const limit = options?.limit ?? 50
    const offset = options?.offset ?? 0

    const countRow = this.db.prepare('SELECT COUNT(*) as total FROM collections;').get() as {
      total: number
    }
    const totalCount = countRow.total

    const rows = this.db
      .prepare(
        `
        SELECT c.id, c.name, c.normalized_name, c.created_at_ms, c.updated_at_ms,
               COUNT(DISTINCT cm.file_location_id) as photo_count
        FROM collections c
        LEFT JOIN collection_memberships cm ON cm.collection_id = c.id AND cm.is_current = 1
          AND EXISTS (
            SELECT 1 FROM file_locations f
            JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1
            LEFT JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1
            WHERE f.id = cm.file_location_id
              AND (cm.discovery_observation_id = d.id OR (cm.content_sha256 IS NOT NULL AND h.sha256 IS NOT NULL AND cm.content_sha256 = h.sha256))
          )
        GROUP BY c.id
        ORDER BY c.name COLLATE NOCASE ASC
        LIMIT ? OFFSET ?;
      `
      )
      .all(limit, offset) as Array<{
      id: number
      name: string
      normalized_name: string
      created_at_ms: number
      updated_at_ms: number
      photo_count: number
    }>

    const items = rows.map((r) => ({
      id: r.id,
      name: r.name,
      normalizedName: r.normalized_name,
      createdAtMs: r.created_at_ms,
      updatedAtMs: r.updated_at_ms,
      photoCount: r.photo_count
    }))

    return {
      items,
      totalCount,
      offset,
      limit,
      hasMore: offset + items.length < totalCount
    }
  }

  public getCollectionById(id: number): CatalogCollectionRecord | null {
    this.assertOpen()
    const row = this.db
      .prepare(
        `
        SELECT c.id, c.name, c.normalized_name, c.created_at_ms, c.updated_at_ms,
               COUNT(DISTINCT cm.file_location_id) as photo_count
        FROM collections c
        LEFT JOIN collection_memberships cm ON cm.collection_id = c.id AND cm.is_current = 1
          AND EXISTS (
            SELECT 1 FROM file_locations f
            JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1
            LEFT JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1
            WHERE f.id = cm.file_location_id
              AND (cm.discovery_observation_id = d.id OR (cm.content_sha256 IS NOT NULL AND h.sha256 IS NOT NULL AND cm.content_sha256 = h.sha256))
          )
        WHERE c.id = ?
        GROUP BY c.id;
      `
      )
      .get(id) as
      | {
          id: number
          name: string
          normalized_name: string
          created_at_ms: number
          updated_at_ms: number
          photo_count: number
        }
      | undefined

    if (!row) return null
    return {
      id: row.id,
      name: row.name,
      normalizedName: row.normalized_name,
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms,
      photoCount: row.photo_count
    }
  }

  public addCollectionMember(input: AddCollectionMemberInput): {
    success: boolean
    isNew: boolean
    persistencePending?: boolean
    persistenceError?: string
  } {
    this.assertOpen()
    if (!input.collectionId || input.collectionId <= 0) {
      throw new TypeError('collectionId must be a positive integer')
    }
    if (!input.fileLocationId || input.fileLocationId <= 0) {
      throw new TypeError('fileLocationId must be a positive integer')
    }
    if (!input.expectedRevision || typeof input.expectedRevision !== 'string') {
      throw new TypeError('expectedRevision must be a non-empty string')
    }

    const collection = this.getCollectionById(input.collectionId)
    if (!collection) {
      throw new Error(`Collection with ID ${input.collectionId} not found`)
    }

    this.reconcilePhotoAnnotations(input.fileLocationId)

    const currentRevision = this.getPhotoRevisionString(input.fileLocationId)
    if (currentRevision !== input.expectedRevision) {
      throw new Error(
        `STALE_REVISION: Expected revision ${input.expectedRevision} but found ${currentRevision}`
      )
    }

    const obs = this.db
      .prepare(
        `
        SELECT f.original_path, f.normalized_path, d.id as discovery_id, d.byte_size, h.sha256 as active_hash
        FROM file_locations f
        JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1
        LEFT JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1
        WHERE f.id = ?;
      `
      )
      .get(input.fileLocationId) as
      | {
          original_path: string
          normalized_path: string
          discovery_id: number
          byte_size: number
          active_hash: string | null
        }
      | undefined

    if (!obs) {
      throw new Error(`File location with ID ${input.fileLocationId} not found`)
    }

    const existing = this.db
      .prepare(
        'SELECT id FROM collection_memberships WHERE collection_id = ? AND file_location_id = ? AND is_current = 1;'
      )
      .get(input.collectionId, input.fileLocationId)
    if (existing) {
      return { success: true, isNew: false }
    }

    const opId = randomUUID()
    let journalEntry:
      import('../../../shared/validation/ipc-schemas').AnnotationJournalEntry | undefined
    const now = Date.now()
    let isCommitted = false

    this.db.exec('BEGIN IMMEDIATE;')
    try {
      this.db
        .prepare(
          `
          INSERT INTO collection_memberships (
            collection_id, file_location_id, discovery_observation_id, content_sha256, is_current, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, 1, ?, ?);
        `
        )
        .run(input.collectionId, input.fileLocationId, obs.discovery_id, obs.active_hash, now, now)

      if (this.journal) {
        journalEntry = this.journal.appendMembershipAddedSync({
          opId,
          collectionId: input.collectionId,
          collectionName: collection.name,
          locationId: input.fileLocationId,
          expectedRevision: input.expectedRevision,
          normalizedPath: obs.normalized_path,
          byteSize: obs.byte_size,
          activeHash: obs.active_hash,
          discoveryObservationId: obs.discovery_id
        })
      }

      this.maybeHoldPersistenceBarrier(opId, journalEntry ? journalEntry.entrySeq : 0)

      this.db
        .prepare(
          "INSERT INTO journal_operations (op_id, entry_seq, kind, status, applied_at_ms) VALUES (?, ?, 'membership_added', 'committed', ?);"
        )
        .run(opId, journalEntry ? journalEntry.entrySeq : 0, now)

      this.db.exec('COMMIT;')
      isCommitted = true

      let persistencePending = false
      let persistenceError: string | undefined
      if (this.journal && journalEntry) {
        try {
          this.journal.appendCommitRecordSync({
            opId,
            targetSeq: journalEntry.entrySeq
          })
        } catch (commitErr) {
          persistencePending = true
          persistenceError = commitErr instanceof Error ? commitErr.message : String(commitErr)
        }
      }

      return {
        success: true,
        isNew: true,
        ...(persistencePending ? { persistencePending } : {}),
        ...(persistenceError ? { persistenceError } : {})
      }
    } catch (err) {
      if (isCommitted) {
        throw err
      }
      try {
        this.db.exec('ROLLBACK;')
      } catch {
        // ignore
      }
      if (this.journal && journalEntry) {
        try {
          this.journal.appendAbortRecordSync({
            opId,
            targetSeq: journalEntry.entrySeq,
            reason: err instanceof Error ? err.message : String(err)
          })
        } catch {
          // ignore
        }
      }
      throw err
    }
  }

  public removeCollectionMember(input: RemoveCollectionMemberInput): {
    success: boolean
    persistencePending?: boolean
    persistenceError?: string
  } {
    this.assertOpen()
    if (!input.expectedRevision || typeof input.expectedRevision !== 'string') {
      throw new TypeError('expectedRevision must be a non-empty string')
    }
    const collection = this.getCollectionById(input.collectionId)
    if (!collection) {
      throw new Error(`Collection with ID ${input.collectionId} not found`)
    }

    const currentRevision = this.getPhotoRevisionString(input.fileLocationId)
    if (currentRevision !== input.expectedRevision) {
      throw new Error(
        `STALE_REVISION: Expected revision ${input.expectedRevision} but found ${currentRevision}`
      )
    }

    const file = this.getFileLocationById(input.fileLocationId)
    if (!file) {
      throw new Error(`File location with ID ${input.fileLocationId} not found`)
    }

    const opId = randomUUID()
    let journalEntry:
      import('../../../shared/validation/ipc-schemas').AnnotationJournalEntry | undefined
    const now = Date.now()
    let isCommitted = false

    this.db.exec('BEGIN IMMEDIATE;')
    try {
      this.db
        .prepare(
          `
          UPDATE collection_memberships
          SET is_current = 0, updated_at_ms = ?
          WHERE collection_id = ? AND file_location_id = ? AND is_current = 1;
        `
        )
        .run(now, input.collectionId, input.fileLocationId)

      if (this.journal) {
        journalEntry = this.journal.appendMembershipRemovedSync({
          opId,
          collectionId: input.collectionId,
          collectionName: collection.name,
          locationId: input.fileLocationId,
          expectedRevision: input.expectedRevision,
          normalizedPath: file.normalizedPath
        })
      }

      this.maybeHoldPersistenceBarrier(opId, journalEntry ? journalEntry.entrySeq : 0)

      this.db
        .prepare(
          "INSERT INTO journal_operations (op_id, entry_seq, kind, status, applied_at_ms) VALUES (?, ?, 'membership_removed', 'committed', ?);"
        )
        .run(opId, journalEntry ? journalEntry.entrySeq : 0, now)

      this.db.exec('COMMIT;')
      isCommitted = true

      let persistencePending = false
      let persistenceError: string | undefined
      if (this.journal && journalEntry) {
        try {
          this.journal.appendCommitRecordSync({
            opId,
            targetSeq: journalEntry.entrySeq
          })
        } catch (commitErr) {
          persistencePending = true
          persistenceError = commitErr instanceof Error ? commitErr.message : String(commitErr)
        }
      }

      return {
        success: true,
        ...(persistencePending ? { persistencePending } : {}),
        ...(persistenceError ? { persistenceError } : {})
      }
    } catch (err) {
      if (isCommitted) {
        throw err
      }
      try {
        this.db.exec('ROLLBACK;')
      } catch {
        // ignore
      }
      if (this.journal && journalEntry) {
        try {
          this.journal.appendAbortRecordSync({
            opId,
            targetSeq: journalEntry.entrySeq,
            reason: err instanceof Error ? err.message : String(err)
          })
        } catch {
          // ignore
        }
      }
      throw err
    }
  }

  public getCollectionMembershipsForPhoto(options: {
    fileLocationId: number
    offset?: number
    limit?: number
  }): PaginatedResult<CatalogCollectionMembershipRecord> {
    this.assertOpen()
    this.reconcilePhotoAnnotations(options.fileLocationId)

    const limit = options.limit ?? 50
    const offset = options.offset ?? 0

    const countRow = this.db
      .prepare(
        `SELECT COUNT(*) as total FROM collection_memberships cm
         JOIN file_locations f ON f.id = cm.file_location_id
         JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1
         LEFT JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1
         WHERE cm.file_location_id = ? AND cm.is_current = 1
           AND (cm.discovery_observation_id = d.id OR (cm.content_sha256 IS NOT NULL AND h.sha256 IS NOT NULL AND cm.content_sha256 = h.sha256));`
      )
      .get(options.fileLocationId) as { total: number }
    const totalCount = countRow.total

    const rows = this.db
      .prepare(
        `
        SELECT cm.id, cm.collection_id, c.name as collection_name, cm.file_location_id, cm.created_at_ms
        FROM collection_memberships cm
        JOIN collections c ON c.id = cm.collection_id
        JOIN file_locations f ON f.id = cm.file_location_id
        JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1
        LEFT JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1
        WHERE cm.file_location_id = ? AND cm.is_current = 1
          AND (cm.discovery_observation_id = d.id OR (cm.content_sha256 IS NOT NULL AND h.sha256 IS NOT NULL AND cm.content_sha256 = h.sha256))
        ORDER BY c.name COLLATE NOCASE ASC
        LIMIT ? OFFSET ?;
      `
      )
      .all(options.fileLocationId, limit, offset) as Array<{
      id: number
      collection_id: number
      collection_name: string
      file_location_id: number
      created_at_ms: number
    }>

    const items = rows.map((r) => ({
      id: r.id,
      collectionId: r.collection_id,
      collectionName: r.collection_name,
      fileLocationId: r.file_location_id,
      createdAtMs: r.created_at_ms
    }))

    return {
      items,
      totalCount,
      offset,
      limit,
      hasMore: offset + items.length < totalCount
    }
  }

  public getPhotoRevisionString(fileLocationId: number): string {
    this.assertOpen()
    const row = this.db
      .prepare(
        `
        SELECT d.id as discovery_id, d.byte_size, d.filesystem_mtime_ms, h.sha256 as active_hash
        FROM discovery_observations d
        LEFT JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1
        WHERE d.file_location_id = ? AND d.is_current = 1;
      `
      )
      .get(fileLocationId) as
      | {
          discovery_id: number
          byte_size: number
          filesystem_mtime_ms: number | null
          active_hash: string | null
        }
      | undefined

    if (!row) {
      throw new Error(
        `File location with ID ${fileLocationId} not found or has no current discovery observation`
      )
    }

    return `rev:${row.discovery_id}:${row.byte_size}:${row.filesystem_mtime_ms ?? 'null'}:${row.active_hash ?? 'unhashed'}`
  }

  public reconcilePhotoAnnotations(fileLocationId: number): void {
    this.assertOpen()
    const currentObs = this.db
      .prepare(
        `
        SELECT d.id as discovery_id, d.byte_size, d.filesystem_mtime_ms, h.sha256 as active_hash
        FROM discovery_observations d
        LEFT JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1
        WHERE d.file_location_id = ? AND d.is_current = 1;
      `
      )
      .get(fileLocationId) as
      | {
          discovery_id: number
          byte_size: number
          filesystem_mtime_ms: number | null
          active_hash: string | null
        }
      | undefined

    if (!currentObs) return

    // 1. Invalidate annotations and memberships where byte size changed
    const now = Date.now()
    this.db
      .prepare(
        `
        UPDATE photo_annotations
        SET is_current = 0, updated_at_ms = ?
        WHERE is_current = 1
          AND (? IS NULL OR file_location_id = ?)
          AND file_location_id IN (
            SELECT f.id FROM file_locations f
            JOIN discovery_observations d_new ON d_new.file_location_id = f.id AND d_new.is_current = 1
            JOIN discovery_observations d_old ON d_old.id = photo_annotations.discovery_observation_id
            WHERE d_new.byte_size != d_old.byte_size
          );
      `
      )
      .run(now, fileLocationId ?? null, fileLocationId ?? null)

    this.db
      .prepare(
        `
        UPDATE collection_memberships
        SET is_current = 0, updated_at_ms = ?
        WHERE is_current = 1
          AND (? IS NULL OR file_location_id = ?)
          AND file_location_id IN (
            SELECT f.id FROM file_locations f
            JOIN discovery_observations d_new ON d_new.file_location_id = f.id AND d_new.is_current = 1
            JOIN discovery_observations d_old ON d_old.id = collection_memberships.discovery_observation_id
            WHERE d_new.byte_size != d_old.byte_size
          );
      `
      )
      .run(now, fileLocationId ?? null, fileLocationId ?? null)

    // 2. Invalidate annotations and memberships where hash changed (differed from original hash)
    this.db
      .prepare(
        `
        UPDATE photo_annotations
        SET is_current = 0, updated_at_ms = ?
        WHERE is_current = 1
          AND (? IS NULL OR file_location_id = ?)
          AND photo_annotations.content_sha256 IS NOT NULL
          AND file_location_id IN (
            SELECT f.id FROM file_locations f
            JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1
            JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1
            WHERE h.sha256 IS NOT NULL AND h.sha256 != photo_annotations.content_sha256
          );
      `
      )
      .run(now, fileLocationId ?? null, fileLocationId ?? null)

    this.db
      .prepare(
        `
        UPDATE collection_memberships
        SET is_current = 0, updated_at_ms = ?
        WHERE is_current = 1
          AND (? IS NULL OR file_location_id = ?)
          AND collection_memberships.content_sha256 IS NOT NULL
          AND file_location_id IN (
            SELECT f.id FROM file_locations f
            JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1
            JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1
            WHERE h.sha256 IS NOT NULL AND h.sha256 != collection_memberships.content_sha256
          );
      `
      )
      .run(now, fileLocationId ?? null, fileLocationId ?? null)

    // 3. For records whose hash is identical on new observation, re-anchor discovery_observation_id
    this.db
      .prepare(
        `
        UPDATE photo_annotations
        SET discovery_observation_id = (
          SELECT d.id FROM discovery_observations d
          WHERE d.file_location_id = photo_annotations.file_location_id AND d.is_current = 1
        ), updated_at_ms = ?
        WHERE is_current = 1
          AND (? IS NULL OR file_location_id = ?)
          AND photo_annotations.content_sha256 IS NOT NULL
          AND file_location_id IN (
            SELECT f.id FROM file_locations f
            JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1
            JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1
            WHERE h.sha256 = photo_annotations.content_sha256
              AND d.id != photo_annotations.discovery_observation_id
          );
      `
      )
      .run(now, fileLocationId ?? null, fileLocationId ?? null)

    this.db
      .prepare(
        `
        UPDATE collection_memberships
        SET discovery_observation_id = (
          SELECT d.id FROM discovery_observations d
          WHERE d.file_location_id = collection_memberships.file_location_id AND d.is_current = 1
        ), updated_at_ms = ?
        WHERE is_current = 1
          AND (? IS NULL OR file_location_id = ?)
          AND collection_memberships.content_sha256 IS NOT NULL
          AND file_location_id IN (
            SELECT f.id FROM file_locations f
            JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1
            JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1
            WHERE h.sha256 = collection_memberships.content_sha256
              AND d.id != collection_memberships.discovery_observation_id
          );
      `
      )
      .run(now, fileLocationId ?? null, fileLocationId ?? null)
  }

  public setPhotoAnnotation(input: SetPhotoAnnotationInput): CatalogPhotoAnnotationRecord {
    this.assertOpen()
    if (!input.fileLocationId || input.fileLocationId <= 0) {
      throw new TypeError('fileLocationId must be a positive integer')
    }
    if (!input.expectedRevision || typeof input.expectedRevision !== 'string') {
      throw new TypeError('expectedRevision must be a non-empty string')
    }
    if (typeof input.expectedVersion !== 'number' || input.expectedVersion < 0) {
      throw new TypeError('expectedVersion must be a non-negative integer')
    }
    if (
      input.rating !== null &&
      (input.rating < 1 || input.rating > 5 || !Number.isInteger(input.rating))
    ) {
      throw new RangeError('rating must be null or an integer between 1 and 5')
    }
    if (input.flag !== 'none' && input.flag !== 'pick' && input.flag !== 'reject') {
      throw new RangeError("flag must be 'none', 'pick', or 'reject'")
    }

    this.reconcilePhotoAnnotations(input.fileLocationId)

    const currentRev = this.getPhotoRevisionString(input.fileLocationId)
    if (currentRev !== input.expectedRevision) {
      throw new Error(
        `STALE_REVISION: Photo revision ${currentRev} does not match expected revision ${input.expectedRevision}`
      )
    }

    const obs = this.db
      .prepare(
        `
        SELECT f.original_path, f.normalized_path, d.id as discovery_id, d.byte_size, d.filesystem_mtime_ms, h.sha256 as active_hash
        FROM file_locations f
        JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1
        LEFT JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1
        WHERE f.id = ?;
      `
      )
      .get(input.fileLocationId) as
      | {
          original_path: string
          normalized_path: string
          discovery_id: number
          byte_size: number
          filesystem_mtime_ms: number | null
          active_hash: string | null
        }
      | undefined

    if (!obs) {
      throw new Error(`File location with ID ${input.fileLocationId} not found`)
    }

    const currentAnn = this.db
      .prepare(
        'SELECT id, version FROM photo_annotations WHERE file_location_id = ? AND is_current = 1;'
      )
      .get(input.fileLocationId) as { id: number; version: number } | undefined

    const currentVersion = currentAnn ? currentAnn.version : 0
    if (currentVersion !== input.expectedVersion) {
      throw new Error(
        `STALE_ANNOTATION_VERSION: Expected version ${input.expectedVersion} does not match current version ${currentVersion}`
      )
    }

    const nextVersion = currentVersion + 1
    const opId = randomUUID()
    let journalEntry:
      import('../../../shared/validation/ipc-schemas').AnnotationJournalEntry | undefined
    const now = Date.now()
    let isCommitted = false

    this.db.exec('BEGIN IMMEDIATE;')
    try {
      if (currentAnn) {
        this.db
          .prepare('UPDATE photo_annotations SET is_current = 0, updated_at_ms = ? WHERE id = ?;')
          .run(now, currentAnn.id)
      }

      const insertStmt = this.db.prepare(`
        INSERT INTO photo_annotations (
          file_location_id, discovery_observation_id, content_sha256,
          rating, flag, version, is_current, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
        RETURNING id, file_location_id, discovery_observation_id, content_sha256,
                  rating, flag, version, is_current, created_at_ms, updated_at_ms;
      `)

      const row = insertStmt.get(
        input.fileLocationId,
        obs.discovery_id,
        obs.active_hash,
        input.rating,
        input.flag,
        nextVersion,
        now,
        now
      ) as unknown as {
        id: number
        file_location_id: number
        discovery_observation_id: number
        content_sha256: string | null
        rating: number | null
        flag: 'none' | 'pick' | 'reject'
        version: number
        is_current: number
        created_at_ms: number
        updated_at_ms: number
      }

      if (this.journal) {
        journalEntry = this.journal.appendPhotoAnnotationSync({
          opId,
          locationId: input.fileLocationId,
          normalizedPath: obs.normalized_path,
          originalPath: obs.original_path,
          byteSize: obs.byte_size,
          filesystemMtimeMs: obs.filesystem_mtime_ms,
          activeHash: obs.active_hash,
          discoveryObservationId: obs.discovery_id,
          expectedRevision: input.expectedRevision,
          version: nextVersion,
          rating: input.rating,
          flag: input.flag
        })
      }

      this.maybeHoldPersistenceBarrier(opId, journalEntry ? journalEntry.entrySeq : 0)

      this.db
        .prepare(
          "INSERT INTO journal_operations (op_id, entry_seq, kind, status, applied_at_ms) VALUES (?, ?, 'photo_annotation', 'committed', ?);"
        )
        .run(opId, journalEntry ? journalEntry.entrySeq : 0, now)

      this.db.exec('COMMIT;')
      isCommitted = true

      let persistencePending = false
      let persistenceError: string | undefined
      if (this.journal && journalEntry) {
        try {
          this.journal.appendCommitRecordSync({
            opId,
            targetSeq: journalEntry.entrySeq
          })
        } catch (commitErr) {
          persistencePending = true
          persistenceError = commitErr instanceof Error ? commitErr.message : String(commitErr)
        }
      }

      return {
        id: row.id,
        fileLocationId: row.file_location_id,
        discoveryObservationId: row.discovery_observation_id,
        contentSha256: row.content_sha256,
        rating: row.rating,
        flag: row.flag,
        version: row.version,
        isCurrent: row.is_current === 1,
        createdAtMs: row.created_at_ms,
        updatedAtMs: row.updated_at_ms,
        ...(persistencePending ? { persistencePending } : {}),
        ...(persistenceError ? { persistenceError } : {})
      }
    } catch (err) {
      if (isCommitted) {
        throw err
      }
      try {
        this.db.exec('ROLLBACK;')
      } catch {
        // ignore
      }
      if (this.journal && journalEntry) {
        try {
          this.journal.appendAbortRecordSync({
            opId,
            targetSeq: journalEntry.entrySeq,
            reason: err instanceof Error ? err.message : String(err)
          })
        } catch {
          // ignore
        }
      }
      throw err
    }
  }

  public getPhotoAnnotation(fileLocationId: number): CatalogPhotoAnnotationRecord | null {
    this.assertOpen()
    this.reconcilePhotoAnnotations(fileLocationId)

    const row = this.db
      .prepare(
        `
        SELECT id, file_location_id, discovery_observation_id, content_sha256,
               rating, flag, version, is_current, created_at_ms, updated_at_ms
        FROM photo_annotations
        WHERE file_location_id = ? AND is_current = 1;
      `
      )
      .get(fileLocationId) as
      | {
          id: number
          file_location_id: number
          discovery_observation_id: number
          content_sha256: string | null
          rating: number | null
          flag: 'none' | 'pick' | 'reject'
          version: number
          is_current: number
          created_at_ms: number
          updated_at_ms: number
        }
      | undefined

    if (!row) return null
    return {
      id: row.id,
      fileLocationId: row.file_location_id,
      discoveryObservationId: row.discovery_observation_id,
      contentSha256: row.content_sha256,
      rating: row.rating,
      flag: row.flag,
      version: row.version,
      isCurrent: row.is_current === 1,
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms
    }
  }

  public getPhotoAnnotationHistory(fileLocationId: number): CatalogPhotoAnnotationRecord[] {
    this.assertOpen()
    const rows = this.db
      .prepare(
        `
        SELECT id, file_location_id, discovery_observation_id, content_sha256,
               rating, flag, version, is_current, created_at_ms, updated_at_ms
        FROM photo_annotations
        WHERE file_location_id = ?
        ORDER BY version ASC;
      `
      )
      .all(fileLocationId) as Array<{
      id: number
      file_location_id: number
      discovery_observation_id: number
      content_sha256: string | null
      rating: number | null
      flag: 'none' | 'pick' | 'reject'
      version: number
      is_current: number
      created_at_ms: number
      updated_at_ms: number
    }>

    return rows.map((r) => ({
      id: r.id,
      fileLocationId: r.file_location_id,
      discoveryObservationId: r.discovery_observation_id,
      contentSha256: r.content_sha256,
      rating: r.rating,
      flag: r.flag,
      version: r.version,
      isCurrent: r.is_current === 1,
      createdAtMs: r.created_at_ms,
      updatedAtMs: r.updated_at_ms
    }))
  }

  // ==========================================================================
  // Stage 5C: Perceptual Hashing & Similarity Operations
  // ==========================================================================

  public savePhotoPerceptualHash(input: SavePhotoPerceptualHashInput): PhotoPerceptualHashRecord {
    this.assertOpen()
    const now = Date.now()

    this.db.exec('BEGIN TRANSACTION;')
    try {
      this.db
        .prepare(
          'UPDATE photo_perceptual_hashes SET is_current = 0 WHERE file_location_id = ? AND algorithm_version = ?;'
        )
        .run(input.fileLocationId, input.algorithmVersion)

      const stmt = this.db.prepare(`
        INSERT INTO photo_perceptual_hashes (
          file_location_id, discovery_observation_id, content_sha256, content_revision,
          algorithm_version, fingerprint, bucket_0, bucket_1, bucket_2, bucket_3,
          width, height, created_at_ms, is_current
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        RETURNING id, file_location_id, discovery_observation_id, content_sha256, content_revision,
                  algorithm_version, fingerprint, bucket_0, bucket_1, bucket_2, bucket_3,
                  width, height, created_at_ms, is_current;
      `)

      const row = stmt.get(
        input.fileLocationId,
        input.discoveryObservationId,
        input.contentSha256,
        input.contentRevision,
        input.algorithmVersion,
        input.fingerprint,
        input.bucket0,
        input.bucket1,
        input.bucket2,
        input.bucket3,
        input.width ?? null,
        input.height ?? null,
        now
      ) as {
        id: number
        file_location_id: number
        discovery_observation_id: number
        content_sha256: string
        content_revision: string
        algorithm_version: string
        fingerprint: string
        bucket_0: number
        bucket_1: number
        bucket_2: number
        bucket_3: number
        width: number | null
        height: number | null
        created_at_ms: number
        is_current: number
      }

      this.db.exec('COMMIT;')

      return {
        id: row.id,
        fileLocationId: row.file_location_id,
        discoveryObservationId: row.discovery_observation_id,
        contentSha256: row.content_sha256,
        contentRevision: row.content_revision,
        algorithmVersion: row.algorithm_version,
        fingerprint: row.fingerprint,
        bucket0: row.bucket_0,
        bucket1: row.bucket_1,
        bucket2: row.bucket_2,
        bucket3: row.bucket_3,
        width: row.width,
        height: row.height,
        createdAtMs: row.created_at_ms,
        isCurrent: row.is_current === 1
      }
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;')
      } catch {
        // ignore
      }
      throw err
    }
  }

  public getPhotoPerceptualHash(
    fileLocationId: number,
    algorithmVersion: string = 'dhash64_v1'
  ): PhotoPerceptualHashRecord | null {
    this.assertOpen()
    const stmt = this.db.prepare(`
      SELECT id, file_location_id, discovery_observation_id, content_sha256, content_revision,
             algorithm_version, fingerprint, bucket_0, bucket_1, bucket_2, bucket_3,
             width, height, created_at_ms, is_current
      FROM photo_perceptual_hashes
      WHERE file_location_id = ? AND algorithm_version = ? AND is_current = 1;
    `)
    const row = stmt.get(fileLocationId, algorithmVersion) as
      | {
          id: number
          file_location_id: number
          discovery_observation_id: number
          content_sha256: string
          content_revision: string
          algorithm_version: string
          fingerprint: string
          bucket_0: number
          bucket_1: number
          bucket_2: number
          bucket_3: number
          width: number | null
          height: number | null
          created_at_ms: number
          is_current: number
        }
      | undefined

    if (!row) return null

    return {
      id: row.id,
      fileLocationId: row.file_location_id,
      discoveryObservationId: row.discovery_observation_id,
      contentSha256: row.content_sha256,
      contentRevision: row.content_revision,
      algorithmVersion: row.algorithm_version,
      fingerprint: row.fingerprint,
      bucket0: row.bucket_0,
      bucket1: row.bucket_1,
      bucket2: row.bucket_2,
      bucket3: row.bucket_3,
      width: row.width,
      height: row.height,
      createdAtMs: row.created_at_ms,
      isCurrent: row.is_current === 1
    }
  }

  public findFingerprintMatchesForBuckets(
    buckets: readonly [number, number, number, number],
    excludeLocationId: number,
    algorithmVersion: string = 'dhash64_v1'
  ): Array<{ fileLocationId: number; fingerprint: string; contentSha256: string }> {
    this.assertOpen()
    const stmt = this.db.prepare(`
      SELECT DISTINCT file_location_id, fingerprint, content_sha256
      FROM photo_perceptual_hashes
      WHERE algorithm_version = ?
        AND is_current = 1
        AND file_location_id > ?
        AND (bucket_0 = ? OR bucket_1 = ? OR bucket_2 = ? OR bucket_3 = ?);
    `)
    const rows = stmt.all(
      algorithmVersion,
      excludeLocationId,
      buckets[0],
      buckets[1],
      buckets[2],
      buckets[3]
    ) as Array<{
      file_location_id: number
      fingerprint: string
      content_sha256: string
    }>

    return rows.map((r) => ({
      fileLocationId: r.file_location_id,
      fingerprint: r.fingerprint,
      contentSha256: r.content_sha256
    }))
  }

  public setSimilarityDecision(input: SetSimilarityDecisionInput): {
    success: boolean
    decision: SimilarityDecisionType
    version: number
    persistencePending?: boolean
    persistenceError?: string
  } {
    this.assertOpen()
    const locA = Math.min(input.locationIdA, input.locationIdB)
    const locB = Math.max(input.locationIdA, input.locationIdB)
    const revA =
      input.locationIdA < input.locationIdB ? input.expectedRevisionA : input.expectedRevisionB
    const revB =
      input.locationIdA < input.locationIdB ? input.expectedRevisionB : input.expectedRevisionA

    if (locA === locB) {
      throw new Error('Cannot set similarity decision for a photo paired with itself')
    }

    const recordA = this.getFileLocationById(locA)
    const recordB = this.getFileLocationById(locB)
    if (!recordA || !recordB) {
      throw new Error('Photo location not found for similarity decision')
    }

    const currentRevA = `rev:${recordA.discoveryObservationId}:${recordA.byteSize}:${recordA.filesystemMtimeMs ?? 'null'}:${recordA.activeHash ?? 'unhashed'}`
    const currentRevB = `rev:${recordB.discoveryObservationId}:${recordB.byteSize}:${recordB.filesystemMtimeMs ?? 'null'}:${recordB.activeHash ?? 'unhashed'}`

    if (revA !== currentRevA || revB !== currentRevB) {
      throw new Error('REVISION_MISMATCH: Stale revision provided for similarity decision')
    }

    const now = Date.now()
    const opId = randomUUID()

    const existing = this.getSimilarityDecision(locA, locB)
    if (
      input.expectedVersion !== undefined &&
      existing &&
      existing.version !== input.expectedVersion
    ) {
      throw new Error('STALE_DECISION_VERSION')
    }

    const nextVersion = (existing?.version ?? 0) + 1

    let journalEntry: AnnotationJournalEntry | null = null
    let isCommitted = false

    this.db.exec('BEGIN TRANSACTION;')
    try {
      if (this.journal) {
        journalEntry = this.journal.appendSimilarityDecisionSync({
          opId,
          locationIdA: locA,
          locationIdB: locB,
          expectedRevisionA: revA,
          expectedRevisionB: revB,
          decision: input.decision,
          version: nextVersion
        })
      }

      this.maybeHoldPersistenceBarrier(opId, journalEntry ? journalEntry.entrySeq : 0)

      this.db
        .prepare(
          'UPDATE similarity_decisions SET is_current = 0 WHERE file_location_id_a = ? AND file_location_id_b = ?;'
        )
        .run(locA, locB)

      if (input.decision !== 'unreviewed') {
        this.db
          .prepare(
            `
            INSERT INTO similarity_decisions (
              file_location_id_a, file_location_id_b, content_revision_a, content_revision_b,
              decision, version, created_at_ms, updated_at_ms, is_current
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1);
          `
          )
          .run(
            locA,
            locB,
            revA,
            revB,
            input.decision,
            nextVersion,
            existing?.createdAtMs ?? now,
            now
          )
      }

      this.db
        .prepare(
          "INSERT INTO journal_operations (op_id, entry_seq, kind, status, applied_at_ms) VALUES (?, ?, 'similarity_decision', 'committed', ?);"
        )
        .run(opId, journalEntry ? journalEntry.entrySeq : 0, now)

      this.db.exec('COMMIT;')
      isCommitted = true

      let persistencePending = false
      let persistenceError: string | undefined
      if (this.journal && journalEntry) {
        try {
          this.journal.appendCommitRecordSync({
            opId,
            targetSeq: journalEntry.entrySeq
          })
        } catch (commitErr) {
          persistencePending = true
          persistenceError = commitErr instanceof Error ? commitErr.message : String(commitErr)
        }
      }

      return {
        success: true,
        decision: input.decision,
        version: nextVersion,
        persistencePending,
        ...(persistenceError ? { persistenceError } : {})
      }
    } catch (err) {
      if (isCommitted) throw err
      try {
        this.db.exec('ROLLBACK;')
      } catch {
        // ignore
      }
      if (this.journal && journalEntry) {
        try {
          this.journal.appendAbortRecordSync({
            opId,
            targetSeq: journalEntry.entrySeq,
            reason: err instanceof Error ? err.message : String(err)
          })
        } catch {
          // ignore
        }
      }
      throw err
    }
  }

  public getSimilarityDecision(
    locationIdA: number,
    locationIdB: number
  ): SimilarityDecisionRecord | null {
    this.assertOpen()
    const locA = Math.min(locationIdA, locationIdB)
    const locB = Math.max(locationIdA, locationIdB)

    const row = this.db
      .prepare(
        `
        SELECT id, file_location_id_a, file_location_id_b, content_revision_a, content_revision_b,
               decision, version, created_at_ms, updated_at_ms, is_current
        FROM similarity_decisions
        WHERE file_location_id_a = ? AND file_location_id_b = ? AND is_current = 1;
      `
      )
      .get(locA, locB) as
      | {
          id: number
          file_location_id_a: number
          file_location_id_b: number
          content_revision_a: string
          content_revision_b: string
          decision: 'edited_version' | 'similar_scene' | 'unrelated'
          version: number
          created_at_ms: number
          updated_at_ms: number
          is_current: number
        }
      | undefined

    if (!row) return null

    return {
      id: row.id,
      locationIdA: row.file_location_id_a,
      locationIdB: row.file_location_id_b,
      contentRevisionA: row.content_revision_a,
      contentRevisionB: row.content_revision_b,
      decision: row.decision,
      version: row.version,
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms,
      isCurrent: row.is_current === 1
    }
  }

  public createSimilarityJob(input: CreateSimilarityJobInput): SimilarityJobRecord {
    this.assertOpen()
    const now = Date.now()

    this.db.exec('BEGIN TRANSACTION;')
    try {
      this.db
        .prepare(
          `
          INSERT INTO similarity_jobs (
            job_id, status, algorithm_version, total_photos, processed_photos,
            error_photos, unsupported_photos, candidate_pairs_found,
            started_at_ms, updated_at_ms, completed_at_ms
          ) VALUES (?, 'running', ?, ?, 0, 0, 0, 0, ?, ?, NULL);
        `
        )
        .run(input.jobId, input.algorithmVersion, input.totalPhotos, now, now)

      const insertItemStmt = this.db.prepare(`
        INSERT INTO similarity_job_items (job_id, file_location_id, status, error_message, updated_at_ms)
        VALUES (?, ?, 'pending', NULL, ?);
      `)

      for (const locId of input.photoLocationIds) {
        insertItemStmt.run(input.jobId, locId, now)
      }

      this.db.exec('COMMIT;')

      return {
        jobId: input.jobId,
        status: 'running',
        algorithmVersion: input.algorithmVersion,
        totalPhotos: input.totalPhotos,
        processedPhotos: 0,
        errorPhotos: 0,
        unsupportedPhotos: 0,
        candidatePairsFound: 0,
        startedAtMs: now,
        updatedAtMs: now,
        completedAtMs: null
      }
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;')
      } catch {
        // ignore
      }
      throw err
    }
  }

  public getSimilarityJob(jobId: string): SimilarityJobRecord | null {
    this.assertOpen()
    const row = this.db
      .prepare(
        `
        SELECT job_id, status, algorithm_version, total_photos, processed_photos,
               error_photos, unsupported_photos, candidate_pairs_found,
               started_at_ms, updated_at_ms, completed_at_ms
        FROM similarity_jobs
        WHERE job_id = ?;
      `
      )
      .get(jobId) as
      | {
          job_id: string
          status: SimilarityJobRecord['status']
          algorithm_version: string
          total_photos: number
          processed_photos: number
          error_photos: number
          unsupported_photos: number
          candidate_pairs_found: number
          started_at_ms: number
          updated_at_ms: number
          completed_at_ms: number | null
        }
      | undefined

    if (!row) return null

    return {
      jobId: row.job_id,
      status: row.status,
      algorithmVersion: row.algorithm_version,
      totalPhotos: row.total_photos,
      processedPhotos: row.processed_photos,
      errorPhotos: row.error_photos,
      unsupportedPhotos: row.unsupported_photos,
      candidatePairsFound: row.candidate_pairs_found,
      startedAtMs: row.started_at_ms,
      updatedAtMs: row.updated_at_ms,
      completedAtMs: row.completed_at_ms
    }
  }

  public getLatestSimilarityJob(): SimilarityJobRecord | null {
    this.assertOpen()
    const row = this.db
      .prepare(
        `
        SELECT job_id, status, algorithm_version, total_photos, processed_photos,
               error_photos, unsupported_photos, candidate_pairs_found,
               started_at_ms, updated_at_ms, completed_at_ms
        FROM similarity_jobs
        ORDER BY started_at_ms DESC
        LIMIT 1;
      `
      )
      .get() as
      | {
          job_id: string
          status: SimilarityJobRecord['status']
          algorithm_version: string
          total_photos: number
          processed_photos: number
          error_photos: number
          unsupported_photos: number
          candidate_pairs_found: number
          started_at_ms: number
          updated_at_ms: number
          completed_at_ms: number | null
        }
      | undefined

    if (!row) return null

    return {
      jobId: row.job_id,
      status: row.status,
      algorithmVersion: row.algorithm_version,
      totalPhotos: row.total_photos,
      processedPhotos: row.processed_photos,
      errorPhotos: row.error_photos,
      unsupportedPhotos: row.unsupported_photos,
      candidatePairsFound: row.candidate_pairs_found,
      startedAtMs: row.started_at_ms,
      updatedAtMs: row.updated_at_ms,
      completedAtMs: row.completed_at_ms
    }
  }

  public updateSimilarityJob(
    jobId: string,
    updates: Partial<{
      status: SimilarityJobRecord['status']
      processedPhotos: number
      errorPhotos: number
      unsupportedPhotos: number
      candidatePairsFound: number
      completedAtMs: number | null
    }>
  ): void {
    this.assertOpen()
    const now = Date.now()
    const setClauses: string[] = ['updated_at_ms = ?']
    const params: (string | number | null)[] = [now]

    if (updates.status !== undefined) {
      setClauses.push('status = ?')
      params.push(updates.status)
    }
    if (updates.processedPhotos !== undefined) {
      setClauses.push('processed_photos = ?')
      params.push(updates.processedPhotos)
    }
    if (updates.errorPhotos !== undefined) {
      setClauses.push('error_photos = ?')
      params.push(updates.errorPhotos)
    }
    if (updates.unsupportedPhotos !== undefined) {
      setClauses.push('unsupported_photos = ?')
      params.push(updates.unsupportedPhotos)
    }
    if (updates.candidatePairsFound !== undefined) {
      setClauses.push('candidate_pairs_found = ?')
      params.push(updates.candidatePairsFound)
    }
    if (updates.completedAtMs !== undefined) {
      setClauses.push('completed_at_ms = ?')
      params.push(updates.completedAtMs)
    }

    params.push(jobId)

    this.db
      .prepare(`UPDATE similarity_jobs SET ${setClauses.join(', ')} WHERE job_id = ?;`)
      .run(...(params as SQLInputValue[]))
  }

  public markRunningSimilarityJobsAsInterrupted(): number {
    this.assertOpen()
    const now = Date.now()
    const result = this.db
      .prepare(
        "UPDATE similarity_jobs SET status = 'interrupted', updated_at_ms = ? WHERE status IN ('running', 'paused');"
      )
      .run(now)
    return Number(result.changes)
  }

  public getSimilarityJobItems(jobId: string, status?: string): SimilarityJobItemRecord[] {
    this.assertOpen()
    const sql = status
      ? 'SELECT id, job_id, file_location_id, status, error_message, updated_at_ms FROM similarity_job_items WHERE job_id = ? AND status = ? ORDER BY id ASC;'
      : 'SELECT id, job_id, file_location_id, status, error_message, updated_at_ms FROM similarity_job_items WHERE job_id = ? ORDER BY id ASC;'
    const rows = (
      status ? this.db.prepare(sql).all(jobId, status) : this.db.prepare(sql).all(jobId)
    ) as Array<{
      id: number
      job_id: string
      file_location_id: number
      status: SimilarityJobItemRecord['status']
      error_message: string | null
      updated_at_ms: number
    }>
    return rows.map((r) => ({
      id: r.id,
      jobId: r.job_id,
      fileLocationId: r.file_location_id,
      status: r.status,
      errorMessage: r.error_message,
      updatedAtMs: r.updated_at_ms
    }))
  }

  public updateSimilarityJobItem(
    jobId: string,
    fileLocationId: number,
    status: SimilarityJobItemRecord['status'],
    errorMessage?: string | null
  ): void {
    this.assertOpen()
    const now = Date.now()
    this.db
      .prepare(
        'UPDATE similarity_job_items SET status = ?, error_message = ?, updated_at_ms = ? WHERE job_id = ? AND file_location_id = ?;'
      )
      .run(status, errorMessage ?? null, now, jobId, fileLocationId)
  }

  public saveSimilarityCandidatePairs(
    jobId: string,
    pairs: Array<{
      locationIdA: number
      locationIdB: number
      distance: number
      similarityScore: number
      algorithmVersion: string
    }>
  ): void {
    this.assertOpen()
    if (pairs.length === 0) return
    const now = Date.now()
    this.db.exec('BEGIN TRANSACTION;')
    try {
      const stmt = this.db.prepare(`
        INSERT OR IGNORE INTO similarity_candidate_pairs (
          job_id, file_location_id_a, file_location_id_b, distance, similarity_score, algorithm_version, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?);
      `)
      for (const p of pairs) {
        const locA = Math.min(p.locationIdA, p.locationIdB)
        const locB = Math.max(p.locationIdA, p.locationIdB)
        stmt.run(jobId, locA, locB, p.distance, p.similarityScore, p.algorithmVersion, now)
      }
      this.db.exec('COMMIT;')
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;')
      } catch {
        // ignore
      }
      throw err
    }
  }

  public getSimilarityCandidatePairs(options: {
    page: number
    pageSize: number
    filter?: string
  }): {
    pairs: Array<SimilarityCandidatePair>
    totalCount: number
    page: number
    pageSize: number
    totalPages: number
  } {
    this.assertOpen()
    const page = Math.max(1, options.page)
    const pageSize = Math.max(1, Math.min(100, options.pageSize))
    const offset = (page - 1) * pageSize
    const filter = options.filter ?? 'all'

    let whereClause = ''
    if (filter === 'unreviewed') {
      whereClause = "AND (sd.decision IS NULL OR sd.decision = 'unreviewed')"
    } else if (filter === 'reviewed') {
      whereClause = "AND sd.decision IN ('edited_version', 'similar_scene', 'unrelated')"
    } else if (filter === 'edited_version') {
      whereClause = "AND sd.decision = 'edited_version'"
    } else if (filter === 'similar_scene') {
      whereClause = "AND sd.decision = 'similar_scene'"
    } else if (filter === 'unrelated') {
      whereClause = "AND sd.decision = 'unrelated'"
    }

    const countSql = `
      SELECT COUNT(*) AS total
      FROM similarity_candidate_pairs cp
      LEFT JOIN similarity_decisions sd
        ON sd.file_location_id_a = cp.file_location_id_a
        AND sd.file_location_id_b = cp.file_location_id_b
        AND sd.is_current = 1
      WHERE 1=1 ${whereClause};
    `
    const totalRow = this.db.prepare(countSql).get() as { total: number } | undefined
    const totalCount = totalRow?.total ?? 0
    const totalPages = Math.ceil(totalCount / pageSize)

    const querySql = `
      SELECT
        cp.id,
        cp.job_id,
        cp.file_location_id_a,
        cp.file_location_id_b,
        cp.distance,
        cp.similarity_score,
        cp.algorithm_version,
        cp.created_at_ms,
        sd.decision,
        sd.version AS decision_version,
        sd.updated_at_ms AS decision_updated_at_ms,
        flA.file_name AS a_file_name,
        flA.original_path AS a_original_path,
        dA.id AS a_discovery_observation_id,
        dA.byte_size AS a_byte_size,
        dA.filesystem_birthtime_ms AS a_birthtime_ms,
        dA.filesystem_mtime_ms AS a_mtime_ms,
        hA.sha256 AS a_sha256,
        phA.width AS a_width,
        phA.height AS a_height,
        paA.rating AS a_rating,
        paA.flag AS a_flag,
        flB.file_name AS b_file_name,
        flB.original_path AS b_original_path,
        dB.id AS b_discovery_observation_id,
        dB.byte_size AS b_byte_size,
        dB.filesystem_birthtime_ms AS b_birthtime_ms,
        dB.filesystem_mtime_ms AS b_mtime_ms,
        hB.sha256 AS b_sha256,
        phB.width AS b_width,
        phB.height AS b_height,
        paB.rating AS b_rating,
        paB.flag AS b_flag
      FROM similarity_candidate_pairs cp
      LEFT JOIN similarity_decisions sd
        ON sd.file_location_id_a = cp.file_location_id_a
        AND sd.file_location_id_b = cp.file_location_id_b
        AND sd.is_current = 1
      JOIN file_locations flA ON flA.id = cp.file_location_id_a
      JOIN discovery_observations dA ON dA.file_location_id = flA.id AND dA.is_current = 1
      LEFT JOIN hash_observations hA ON hA.discovery_observation_id = dA.id AND hA.is_active = 1
      LEFT JOIN photo_perceptual_hashes phA ON phA.file_location_id = flA.id AND phA.is_current = 1
      LEFT JOIN photo_annotations paA ON paA.file_location_id = flA.id AND paA.is_current = 1
      JOIN file_locations flB ON flB.id = cp.file_location_id_b
      JOIN discovery_observations dB ON dB.file_location_id = flB.id AND dB.is_current = 1
      LEFT JOIN hash_observations hB ON hB.discovery_observation_id = dB.id AND hB.is_active = 1
      LEFT JOIN photo_perceptual_hashes phB ON phB.file_location_id = flB.id AND phB.is_current = 1
      LEFT JOIN photo_annotations paB ON paB.file_location_id = flB.id AND paB.is_current = 1
      WHERE 1=1 ${whereClause}
      ORDER BY cp.distance ASC, cp.id ASC
      LIMIT ? OFFSET ?;
    `

    const rows = this.db.prepare(querySql).all(pageSize, offset) as Array<Record<string, unknown>>

    const pairs: SimilarityCandidatePair[] = rows.map((r) => ({
      id: Number(r.id),
      jobId: String(r.job_id),
      locationIdA: Number(r.file_location_id_a),
      locationIdB: Number(r.file_location_id_b),
      photoA: {
        id: Number(r.file_location_id_a),
        fileName: String(r.a_file_name),
        originalPath: String(r.a_original_path),
        byteSize: Number(r.a_byte_size),
        filesystemBirthtimeMs: r.a_birthtime_ms !== null ? Number(r.a_birthtime_ms) : null,
        filesystemMtimeMs: r.a_mtime_ms !== null ? Number(r.a_mtime_ms) : null,
        activeHash: (r.a_sha256 as string) ?? null,
        discoveryObservationId: Number(r.a_discovery_observation_id),
        width: r.a_width !== null ? Number(r.a_width) : null,
        height: r.a_height !== null ? Number(r.a_height) : null,
        rating: r.a_rating !== null ? Number(r.a_rating) : null,
        flag: (r.a_flag as 'none' | 'pick' | 'reject') ?? 'none'
      },
      photoB: {
        id: Number(r.file_location_id_b),
        fileName: String(r.b_file_name),
        originalPath: String(r.b_original_path),
        byteSize: Number(r.b_byte_size),
        filesystemBirthtimeMs: r.b_birthtime_ms !== null ? Number(r.b_birthtime_ms) : null,
        filesystemMtimeMs: r.b_mtime_ms !== null ? Number(r.b_mtime_ms) : null,
        activeHash: (r.b_sha256 as string) ?? null,
        discoveryObservationId: Number(r.b_discovery_observation_id),
        width: r.b_width !== null ? Number(r.b_width) : null,
        height: r.b_height !== null ? Number(r.b_height) : null,
        rating: r.b_rating !== null ? Number(r.b_rating) : null,
        flag: (r.b_flag as 'none' | 'pick' | 'reject') ?? 'none'
      },
      distance: Number(r.distance),
      similarityScore: Number(r.similarity_score),
      algorithmVersion: String(r.algorithm_version),
      decision: (r.decision as SimilarityDecisionType) ?? 'unreviewed',
      decisionVersion: r.decision_version !== null ? Number(r.decision_version) : null,
      decisionUpdatedAtMs:
        r.decision_updated_at_ms !== null ? Number(r.decision_updated_at_ms) : null,
      createdAtMs: Number(r.created_at_ms)
    }))

    return {
      pairs,
      totalCount,
      page,
      pageSize,
      totalPages
    }
  }

  // ==========================================================================
  // Stage 6B: Semantic Embeddings & Resumable Semantic Index Operations
  // ==========================================================================

  public savePhotoSemanticEmbedding(
    input: SavePhotoSemanticEmbeddingInput
  ): PhotoSemanticEmbeddingRecord {
    this.assertOpen()
    const blob = validateAndSerializeEmbeddingVector(input.vector, input.embeddingDimensions)
    const now = Date.now()
    const normalizedSha = input.contentSha256.toLowerCase()
    const normalizedManifestSha = input.modelManifestSha256.toLowerCase()

    this.db.exec('BEGIN TRANSACTION;')
    try {
      this.db
        .prepare(
          `
          UPDATE photo_semantic_embeddings
          SET is_current = 0
          WHERE file_location_id = ? AND model_id = ? AND preprocessing_version = ? AND is_current = 1;
        `
        )
        .run(input.fileLocationId, input.modelId, input.preprocessingVersion)

      const stmt = this.db.prepare(`
        INSERT INTO photo_semantic_embeddings (
          file_id, file_location_id, discovery_observation_id,
          content_sha256, content_revision, source_path,
          observed_byte_size, observed_mtime_ms,
          model_id, model_commit, model_manifest_sha256, preprocessing_version,
          embedding_dimensions, embedding_blob, width, height, created_at_ms, is_current
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        RETURNING id, file_id, file_location_id, discovery_observation_id,
                  content_sha256, content_revision, source_path,
                  observed_byte_size, observed_mtime_ms,
                  model_id, model_commit, model_manifest_sha256, preprocessing_version,
                  embedding_dimensions, embedding_blob, width, height, created_at_ms, is_current;
      `)

      const row = stmt.get(
        input.fileId ?? input.fileLocationId,
        input.fileLocationId,
        input.discoveryObservationId,
        normalizedSha,
        input.contentRevision,
        input.sourcePath,
        input.observedByteSize,
        input.observedMtimeMs,
        input.modelId,
        input.modelCommit,
        normalizedManifestSha,
        input.preprocessingVersion,
        input.embeddingDimensions,
        blob,
        input.width ?? null,
        input.height ?? null,
        now
      ) as Record<string, unknown>

      this.db.exec('COMMIT;')
      return this.mapSemanticEmbeddingRow(row)
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;')
      } catch {
        // ignore
      }
      throw err
    }
  }

  public getPhotoSemanticEmbedding(
    fileLocationId: number,
    modelId: string,
    preprocessingVersion: string
  ): PhotoSemanticEmbeddingRecord | null {
    this.assertOpen()
    const row = this.db
      .prepare(
        `
        SELECT id, file_id, file_location_id, discovery_observation_id,
               content_sha256, content_revision, source_path,
               observed_byte_size, observed_mtime_ms,
               model_id, model_commit, model_manifest_sha256, preprocessing_version,
               embedding_dimensions, embedding_blob, width, height, created_at_ms, is_current
        FROM photo_semantic_embeddings
        WHERE file_location_id = ? AND model_id = ? AND preprocessing_version = ?
        ORDER BY is_current DESC, id DESC
        LIMIT 1;
      `
      )
      .get(fileLocationId, modelId, preprocessingVersion) as Record<string, unknown> | undefined

    if (!row) return null
    return this.mapSemanticEmbeddingRow(row)
  }

  public findReusableSemanticEmbedding(params: {
    contentSha256: string
    observedByteSize: number
    modelId: string
    modelCommit: string
    modelManifestSha256: string
    preprocessingVersion: string
  }): PhotoSemanticEmbeddingRecord | null {
    this.assertOpen()
    const row = this.db
      .prepare(
        `
        SELECT id, file_id, file_location_id, discovery_observation_id,
               content_sha256, content_revision, source_path,
               observed_byte_size, observed_mtime_ms,
               model_id, model_commit, model_manifest_sha256, preprocessing_version,
               embedding_dimensions, embedding_blob, width, height, created_at_ms, is_current
        FROM photo_semantic_embeddings
        WHERE content_sha256 = ?
          AND observed_byte_size = ?
          AND model_id = ?
          AND model_commit = ?
          AND model_manifest_sha256 = ?
          AND preprocessing_version = ?
          AND is_current = 1
        ORDER BY id DESC
        LIMIT 1;
      `
      )
      .get(
        params.contentSha256.toLowerCase(),
        params.observedByteSize,
        params.modelId,
        params.modelCommit,
        params.modelManifestSha256.toLowerCase(),
        params.preprocessingVersion
      ) as Record<string, unknown> | undefined

    if (!row) return null
    return this.mapSemanticEmbeddingRow(row)
  }

  private mapSemanticEmbeddingRow(row: Record<string, unknown>): PhotoSemanticEmbeddingRecord {
    const dims = Number(row.embedding_dimensions)
    const rawBlob = row.embedding_blob as Uint8Array
    const vector = deserializeEmbeddingVector(rawBlob, dims)
    return {
      id: Number(row.id),
      fileId: row.file_id !== null && row.file_id !== undefined ? Number(row.file_id) : null,
      fileLocationId: Number(row.file_location_id),
      discoveryObservationId: Number(row.discovery_observation_id),
      contentSha256: String(row.content_sha256),
      contentRevision: String(row.content_revision),
      sourcePath: String(row.source_path),
      observedByteSize: Number(row.observed_byte_size),
      observedMtimeMs: Number(row.observed_mtime_ms),
      modelId: String(row.model_id),
      modelCommit: String(row.model_commit),
      modelManifestSha256: String(row.model_manifest_sha256),
      preprocessingVersion: String(row.preprocessing_version),
      embeddingDimensions: dims,
      vector,
      width: row.width !== null && row.width !== undefined ? Number(row.width) : null,
      height: row.height !== null && row.height !== undefined ? Number(row.height) : null,
      createdAtMs: Number(row.created_at_ms),
      isCurrent: Number(row.is_current) === 1
    }
  }

  public getSemanticIndexCoverage(params: {
    modelId: string
    modelCommit: string
    modelManifestSha256: string
    preprocessingVersion: string
  }): SemanticIndexCoverageResult {
    this.assertOpen()
    const totalRow = this.db
      .prepare(
        `
        SELECT COUNT(*) AS total
        FROM file_locations f
        JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1
        WHERE f.category = 'photo';
      `
      )
      .get() as { total: number } | undefined

    const indexedRow = this.db
      .prepare(
        `
        SELECT COUNT(*) AS indexed
        FROM file_locations f
        JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1
        JOIN photo_semantic_embeddings e ON e.file_location_id = f.id AND e.is_current = 1
        LEFT JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1
        WHERE f.category = 'photo'
          AND e.model_id = ?
          AND e.model_commit = ?
          AND e.model_manifest_sha256 = ?
          AND e.preprocessing_version = ?
          AND e.observed_byte_size = d.byte_size
          AND (d.filesystem_mtime_ms IS NULL OR ABS(e.observed_mtime_ms - d.filesystem_mtime_ms) <= 1)
          AND (h.sha256 IS NULL OR h.sha256 = e.content_sha256);
      `
      )
      .get(
        params.modelId,
        params.modelCommit,
        params.modelManifestSha256.toLowerCase(),
        params.preprocessingVersion
      ) as { indexed: number } | undefined

    return {
      totalCatalogPhotos: Number(totalRow?.total ?? 0),
      currentIndexedPhotos: Number(indexedRow?.indexed ?? 0)
    }
  }

  public createSemanticIndexJob(input: CreateSemanticIndexJobInput): SemanticIndexJobRecord {
    this.assertOpen()
    const jobId = input.jobId ?? randomUUID()
    const now = Date.now()
    const manifestSha = input.modelManifestSha256.toLowerCase()

    this.db.exec('BEGIN IMMEDIATE TRANSACTION;')
    try {
      this.db
        .prepare(
          `
          INSERT INTO semantic_index_jobs (
            id, status, model_id, model_commit, model_manifest_sha256, preprocessing_version,
            total_photos, processed_photos, reused_photos, unsupported_photos, failed_photos, pending_photos,
            started_at_ms, updated_at_ms, completed_at_ms, last_error
          ) VALUES (?, 'running', ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, ?, ?, NULL, NULL);
        `
        )
        .run(
          jobId,
          input.modelId,
          input.modelCommit,
          manifestSha,
          input.preprocessingVersion,
          now,
          now
        )

      // Snapshot authorized unindexed photo scope inside SQLite without loading rows into JS memory
      const insertItemsRes = this.db
        .prepare(
          `
          INSERT INTO semantic_index_job_items (
            job_id, file_location_id, original_path, discovery_observation_id,
            expected_byte_size, expected_mtime_ms, status, updated_at_ms
          )
          SELECT
            ?,
            f.id,
            f.original_path,
            d.id,
            d.byte_size,
            COALESCE(d.filesystem_mtime_ms, 0),
            'pending',
            ?
          FROM file_locations f
          JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1
          WHERE f.category = 'photo'
            AND NOT EXISTS (
              SELECT 1 FROM photo_semantic_embeddings e
              WHERE e.file_location_id = f.id
                AND e.discovery_observation_id = d.id
                AND e.is_current = 1
                AND e.model_id = ?
                AND e.model_commit = ?
                AND LOWER(e.model_manifest_sha256) = LOWER(?)
                AND e.preprocessing_version = ?
            )
          ORDER BY f.id ASC;
        `
        )
        .run(jobId, now, input.modelId, input.modelCommit, manifestSha, input.preprocessingVersion)

      const totalPhotos = Number(insertItemsRes.changes)
      const initialStatus = totalPhotos === 0 ? 'completed' : 'running'
      const completedAt = totalPhotos === 0 ? now : null

      this.db
        .prepare(
          `
          UPDATE semantic_index_jobs
          SET total_photos = ?, pending_photos = ?, status = ?, completed_at_ms = ?, updated_at_ms = ?
          WHERE id = ?;
        `
        )
        .run(totalPhotos, totalPhotos, initialStatus, completedAt, now, jobId)

      this.db.exec('COMMIT;')
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;')
      } catch {
        // ignore
      }
      throw err
    }

    const created = this.getSemanticIndexJob(jobId)
    if (!created) {
      throw new Error('Failed to create semantic index job')
    }
    return created
  }

  public getSemanticIndexJob(jobId: string): SemanticIndexJobRecord | null {
    this.assertOpen()
    const row = this.db.prepare('SELECT * FROM semantic_index_jobs WHERE id = ?;').get(jobId) as
      Record<string, unknown> | undefined
    if (!row) return null
    return this.mapSemanticIndexJobRow(row)
  }

  public getLatestSemanticIndexJob(): SemanticIndexJobRecord | null {
    this.assertOpen()
    const row = this.db
      .prepare('SELECT * FROM semantic_index_jobs ORDER BY started_at_ms DESC, rowid DESC LIMIT 1;')
      .get() as Record<string, unknown> | undefined
    if (!row) return null
    return this.mapSemanticIndexJobRow(row)
  }

  public markRunningSemanticIndexJobsAsInterrupted(): number {
    this.assertOpen()
    const now = Date.now()
    const res = this.db
      .prepare(
        "UPDATE semantic_index_jobs SET status = 'interrupted', updated_at_ms = ? WHERE status = 'running';"
      )
      .run(now)
    return Number(res.changes)
  }

  public updateSemanticIndexJobStatus(
    jobId: string,
    status: SemanticIndexJobRecord['status'],
    lastError?: string | null
  ): SemanticIndexJobRecord | null {
    this.assertOpen()
    const now = Date.now()
    const completedAt =
      status === 'completed' || status === 'cancelled' || status === 'failed' ? now : null

    this.db
      .prepare(
        `
        UPDATE semantic_index_jobs
        SET status = ?,
            updated_at_ms = ?,
            completed_at_ms = COALESCE(?, completed_at_ms),
            last_error = CASE WHEN ? IS NOT NULL THEN ? ELSE last_error END
        WHERE id = ?;
      `
      )
      .run(status, now, completedAt, lastError ?? null, lastError ?? null, jobId)

    return this.getSemanticIndexJob(jobId)
  }

  public getNextPendingSemanticIndexJobItems(jobId: string, limit = 16): SemanticIndexJobItem[] {
    this.assertOpen()
    const safeLimit = Math.max(1, Math.min(64, Math.floor(limit)))
    const rows = this.db
      .prepare(
        `
        SELECT id, job_id, file_location_id, original_path, discovery_observation_id,
               expected_byte_size, expected_mtime_ms, status, error_code, error_message, updated_at_ms
        FROM semantic_index_job_items
        WHERE job_id = ? AND status = 'pending'
        ORDER BY id ASC
        LIMIT ?;
      `
      )
      .all(jobId, safeLimit) as Array<Record<string, unknown>>

    return rows.map((r) => this.mapSemanticIndexJobItemRow(r))
  }

  public completeSemanticIndexJobItemWithEmbedding(params: {
    jobId: string
    itemId: number
    reused: boolean
    embedding: SavePhotoSemanticEmbeddingInput
  }): void {
    this.assertOpen()
    // Validate vector before opening transaction or inside transaction so any invalid vector throws & rolls back
    this.db.exec('BEGIN IMMEDIATE TRANSACTION;')
    try {
      const blob = validateAndSerializeEmbeddingVector(
        params.embedding.vector,
        params.embedding.embeddingDimensions
      )
      const now = Date.now()

      const itemRow = this.db
        .prepare(
          'SELECT status, file_location_id FROM semantic_index_job_items WHERE id = ? AND job_id = ?;'
        )
        .get(params.itemId, params.jobId) as
        { status: string; file_location_id: number } | undefined

      if (!itemRow || itemRow.status !== 'pending') {
        throw new Error(`Semantic index job item ${params.itemId} is no longer pending`)
      }

      // Revalidate current catalog observation revision before committing
      const currentCatalogObs = this.db
        .prepare(
          `
          SELECT d.id AS discovery_id, d.byte_size, d.filesystem_mtime_ms, h.sha256 AS active_hash
          FROM file_locations f
          JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1
          LEFT JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1
          WHERE f.id = ?;
        `
        )
        .get(params.embedding.fileLocationId) as
        | {
            discovery_id: number
            byte_size: number
            filesystem_mtime_ms: number | null
            active_hash: string | null
          }
        | undefined

      if (!currentCatalogObs) {
        throw new Error('SOURCE_REVISION_CHANGED: File location no longer present in catalog')
      }

      if (
        currentCatalogObs.discovery_id !== params.embedding.discoveryObservationId ||
        currentCatalogObs.byte_size !== params.embedding.observedByteSize ||
        (currentCatalogObs.filesystem_mtime_ms !== null &&
          Math.abs(currentCatalogObs.filesystem_mtime_ms - params.embedding.observedMtimeMs) > 1) ||
        (currentCatalogObs.active_hash !== null &&
          currentCatalogObs.active_hash.toLowerCase() !==
            params.embedding.contentSha256.toLowerCase())
      ) {
        throw new Error(
          'SOURCE_REVISION_CHANGED: Catalog observation changed before embedding commit'
        )
      }

      const normalizedSha = params.embedding.contentSha256.toLowerCase()
      const normalizedManifestSha = params.embedding.modelManifestSha256.toLowerCase()

      this.db
        .prepare(
          `
          UPDATE photo_semantic_embeddings
          SET is_current = 0
          WHERE file_location_id = ? AND model_id = ? AND preprocessing_version = ? AND is_current = 1;
        `
        )
        .run(
          params.embedding.fileLocationId,
          params.embedding.modelId,
          params.embedding.preprocessingVersion
        )

      this.db
        .prepare(
          `
          INSERT INTO photo_semantic_embeddings (
            file_id, file_location_id, discovery_observation_id,
            content_sha256, content_revision, source_path,
            observed_byte_size, observed_mtime_ms,
            model_id, model_commit, model_manifest_sha256, preprocessing_version,
            embedding_dimensions, embedding_blob, width, height, created_at_ms, is_current
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1);
        `
        )
        .run(
          params.embedding.fileId ?? params.embedding.fileLocationId,
          params.embedding.fileLocationId,
          params.embedding.discoveryObservationId,
          normalizedSha,
          params.embedding.contentRevision,
          params.embedding.sourcePath,
          params.embedding.observedByteSize,
          params.embedding.observedMtimeMs,
          params.embedding.modelId,
          params.embedding.modelCommit,
          normalizedManifestSha,
          params.embedding.preprocessingVersion,
          params.embedding.embeddingDimensions,
          blob,
          params.embedding.width ?? null,
          params.embedding.height ?? null,
          now
        )

      const itemStatus = params.reused ? 'reused' : 'completed'
      this.db
        .prepare(
          `
          UPDATE semantic_index_job_items
          SET status = ?, error_code = NULL, error_message = NULL, updated_at_ms = ?
          WHERE id = ? AND job_id = ?;
        `
        )
        .run(itemStatus, now, params.itemId, params.jobId)

      this.db
        .prepare(
          `
          UPDATE semantic_index_jobs
          SET processed_photos = processed_photos + 1,
              reused_photos = reused_photos + ?,
              pending_photos = CASE WHEN pending_photos > 0 THEN pending_photos - 1 ELSE 0 END,
              updated_at_ms = ?
          WHERE id = ?;
        `
        )
        .run(params.reused ? 1 : 0, now, params.jobId)

      this.db.exec('COMMIT;')
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;')
      } catch {
        // ignore
      }
      throw err
    }
  }

  public recordSemanticIndexJobItemOutcome(params: {
    jobId: string
    itemId: number
    status: 'unsupported' | 'failed' | 'skipped'
    errorCode?: string | null
    errorMessage?: string | null
  }): void {
    this.assertOpen()
    const now = Date.now()
    this.db.exec('BEGIN IMMEDIATE TRANSACTION;')
    try {
      const itemRow = this.db
        .prepare('SELECT status FROM semantic_index_job_items WHERE id = ? AND job_id = ?;')
        .get(params.itemId, params.jobId) as { status: string } | undefined

      if (!itemRow || itemRow.status !== 'pending') {
        this.db.exec('ROLLBACK;')
        return
      }

      this.db
        .prepare(
          `
          UPDATE semantic_index_job_items
          SET status = ?, error_code = ?, error_message = ?, updated_at_ms = ?
          WHERE id = ? AND job_id = ?;
        `
        )
        .run(
          params.status,
          params.errorCode ?? null,
          params.errorMessage ?? null,
          now,
          params.itemId,
          params.jobId
        )

      const isUnsupported = params.status === 'unsupported' ? 1 : 0
      const isFailed = params.status === 'failed' ? 1 : 0

      this.db
        .prepare(
          `
          UPDATE semantic_index_jobs
          SET unsupported_photos = unsupported_photos + ?,
              failed_photos = failed_photos + ?,
              pending_photos = CASE WHEN pending_photos > 0 THEN pending_photos - 1 ELSE 0 END,
              updated_at_ms = ?
          WHERE id = ?;
        `
        )
        .run(isUnsupported, isFailed, now, params.jobId)

      this.db.exec('COMMIT;')
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;')
      } catch {
        // ignore
      }
      throw err
    }
  }

  public listSemanticIndexJobItems(options: {
    jobId: string
    status?: SemanticIndexJobItem['status']
    limit?: number
    offset?: number
  }): {
    items: SemanticIndexJobItem[]
    totalCount: number
    limit: number
    offset: number
  } {
    this.assertOpen()
    const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 50)))
    const offset = Math.max(0, Math.floor(options.offset ?? 0))

    const countRow = options.status
      ? (this.db
          .prepare(
            'SELECT COUNT(*) AS total FROM semantic_index_job_items WHERE job_id = ? AND status = ?;'
          )
          .get(options.jobId, options.status) as { total: number } | undefined)
      : (this.db
          .prepare('SELECT COUNT(*) AS total FROM semantic_index_job_items WHERE job_id = ?;')
          .get(options.jobId) as { total: number } | undefined)

    const rows = options.status
      ? (this.db
          .prepare(
            `
            SELECT id, job_id, file_location_id, original_path, discovery_observation_id,
                   expected_byte_size, expected_mtime_ms, status, error_code, error_message, updated_at_ms
            FROM semantic_index_job_items
            WHERE job_id = ? AND status = ?
            ORDER BY id ASC
            LIMIT ? OFFSET ?;
          `
          )
          .all(options.jobId, options.status, limit, offset) as Array<Record<string, unknown>>)
      : (this.db
          .prepare(
            `
            SELECT id, job_id, file_location_id, original_path, discovery_observation_id,
                   expected_byte_size, expected_mtime_ms, status, error_code, error_message, updated_at_ms
            FROM semantic_index_job_items
            WHERE job_id = ?
            ORDER BY id ASC
            LIMIT ? OFFSET ?;
          `
          )
          .all(options.jobId, limit, offset) as Array<Record<string, unknown>>)

    return {
      items: rows.map((r) => this.mapSemanticIndexJobItemRow(r)),
      totalCount: Number(countRow?.total ?? 0),
      limit,
      offset
    }
  }

  private mapSemanticIndexJobRow(row: Record<string, unknown>): SemanticIndexJobRecord {
    return {
      id: String(row.id),
      status: row.status as SemanticIndexJobRecord['status'],
      modelId: String(row.model_id),
      modelCommit: String(row.model_commit),
      modelManifestSha256: String(row.model_manifest_sha256),
      preprocessingVersion: String(row.preprocessing_version),
      totalPhotos: Number(row.total_photos),
      processedPhotos: Number(row.processed_photos),
      reusedPhotos: Number(row.reused_photos),
      unsupportedPhotos: Number(row.unsupported_photos),
      failedPhotos: Number(row.failed_photos),
      pendingPhotos: Number(row.pending_photos),
      startedAtMs: Number(row.started_at_ms),
      updatedAtMs: Number(row.updated_at_ms),
      completedAtMs:
        row.completed_at_ms !== null && row.completed_at_ms !== undefined
          ? Number(row.completed_at_ms)
          : null,
      lastError:
        row.last_error !== null && row.last_error !== undefined ? String(row.last_error) : null
    }
  }

  private mapSemanticIndexJobItemRow(row: Record<string, unknown>): SemanticIndexJobItem {
    return {
      id: Number(row.id),
      jobId: String(row.job_id),
      fileLocationId: Number(row.file_location_id),
      originalPath: String(row.original_path),
      discoveryObservationId: Number(row.discovery_observation_id),
      expectedByteSize: Number(row.expected_byte_size),
      expectedMtimeMs: Number(row.expected_mtime_ms),
      status: row.status as SemanticIndexJobItem['status'],
      errorCode:
        row.error_code !== null && row.error_code !== undefined ? String(row.error_code) : null,
      errorMessage:
        row.error_message !== null && row.error_message !== undefined
          ? String(row.error_message)
          : null,
      updatedAtMs:
        row.updated_at_ms !== null && row.updated_at_ms !== undefined
          ? Number(row.updated_at_ms)
          : null
    }
  }

  // =========================================================================
  // Stage 6C: Photo Technical Metadata, Resumable Jobs, Coverage & Facets
  // =========================================================================

  public getPhotoMetadataCoverage(
    parserRecipeVersion: string = METADATA_PARSER_RECIPE_VERSION
  ): PhotoMetadataCoverageResult {
    this.assertOpen()
    const row = this.db
      .prepare(
        `
        SELECT
          COUNT(*) AS total_photos,
          COALESCE(SUM(CASE WHEN tm.extraction_status = 'extracted' THEN 1 ELSE 0 END), 0) AS extracted_count,
          COALESCE(SUM(CASE WHEN tm.extraction_status = 'no_metadata' THEN 1 ELSE 0 END), 0) AS no_metadata_count,
          COALESCE(SUM(CASE WHEN tm.extraction_status = 'unsupported' THEN 1 ELSE 0 END), 0) AS unsupported_count,
          COALESCE(SUM(CASE WHEN tm.extraction_status = 'failed' THEN 1 ELSE 0 END), 0) AS failed_count,
          COALESCE(SUM(CASE
            WHEN tm.id IS NULL AND EXISTS (
              SELECT 1 FROM photo_technical_metadata h WHERE h.file_location_id = f.id
            ) THEN 1 ELSE 0 END
          ), 0) AS stale_count,
          COALESCE(SUM(CASE
            WHEN tm.id IS NULL AND NOT EXISTS (
              SELECT 1 FROM photo_technical_metadata h WHERE h.file_location_id = f.id
            ) THEN 1 ELSE 0 END
          ), 0) AS unprocessed_count
        FROM file_locations f
        JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1
        LEFT JOIN photo_technical_metadata tm
          ON tm.file_location_id = f.id
         AND tm.is_current = 1
         AND tm.parser_recipe_version = ?
         AND tm.discovery_observation_id = d.id
        WHERE f.category = 'photo';
      `
      )
      .get(parserRecipeVersion) as Record<string, unknown> | undefined

    return {
      parserRecipeVersion,
      totalPhotos: Number(row?.total_photos ?? 0),
      extractedCount: Number(row?.extracted_count ?? 0),
      noMetadataCount: Number(row?.no_metadata_count ?? 0),
      unsupportedCount: Number(row?.unsupported_count ?? 0),
      failedCount: Number(row?.failed_count ?? 0),
      staleCount: Number(row?.stale_count ?? 0),
      unprocessedCount: Number(row?.unprocessed_count ?? 0)
    }
  }

  public createPhotoMetadataJob(input: CreatePhotoMetadataJobInput): PhotoMetadataJobRecord {
    this.assertOpen()
    const jobId = input.jobId ?? randomUUID()
    const now = Date.now()
    const recipe = input.parserRecipeVersion || METADATA_PARSER_RECIPE_VERSION
    const retryFailed = Boolean(input.retryFailed)

    this.db.exec('BEGIN IMMEDIATE TRANSACTION;')
    try {
      this.db
        .prepare(
          `
          INSERT INTO photo_metadata_jobs (
            id, status, parser_recipe_version,
            total_photos, processed_photos, extracted_photos, absent_metadata_photos,
            reused_photos, unsupported_photos, failed_photos, pending_photos,
            started_at_ms, updated_at_ms, completed_at_ms, last_error
          ) VALUES (?, 'running', ?, 0, 0, 0, 0, 0, 0, 0, 0, ?, ?, NULL, NULL);
        `
        )
        .run(jobId, recipe, now, now)

      // Snapshot authorized photo scope using bounded cursor batches (500 rows per step)
      const batchSize = METADATA_LIMITS.JOB_SNAPSHOT_BATCH_SIZE
      const selectBatchStmt = retryFailed
        ? this.db.prepare(
            `
            SELECT
              f.id AS file_location_id,
              f.original_path,
              f.extension,
              d.id AS discovery_observation_id,
              d.byte_size,
              d.filesystem_mtime_ms
            FROM file_locations f
            JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1
            WHERE f.category = 'photo'
              AND f.id > ?
              AND NOT EXISTS (
                SELECT 1 FROM photo_technical_metadata tm
                WHERE tm.file_location_id = f.id
                  AND tm.discovery_observation_id = d.id
                  AND tm.is_current = 1
                  AND tm.parser_recipe_version = ?
                  AND tm.extraction_status IN ('extracted', 'no_metadata', 'unsupported')
              )
            ORDER BY f.id ASC
            LIMIT ?;
          `
          )
        : this.db.prepare(
            `
            SELECT
              f.id AS file_location_id,
              f.original_path,
              f.extension,
              d.id AS discovery_observation_id,
              d.byte_size,
              d.filesystem_mtime_ms
            FROM file_locations f
            JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1
            WHERE f.category = 'photo'
              AND f.id > ?
              AND NOT EXISTS (
                SELECT 1 FROM photo_technical_metadata tm
                WHERE tm.file_location_id = f.id
                  AND tm.discovery_observation_id = d.id
                  AND tm.is_current = 1
                  AND tm.parser_recipe_version = ?
              )
            ORDER BY f.id ASC
            LIMIT ?;
          `
          )

      const insertItemStmt = this.db.prepare(
        `
        INSERT INTO photo_metadata_job_items (
          job_id, file_location_id, original_path, recorded_extension,
          discovery_observation_id, expected_byte_size, expected_mtime_ms,
          status, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?);
      `
      )

      let lastFileId = 0
      let totalSnapshotted = 0

      while (true) {
        const batchRows = selectBatchStmt.all(lastFileId, recipe, batchSize) as Array<{
          file_location_id: number
          original_path: string
          extension: string
          discovery_observation_id: number
          byte_size: number
          filesystem_mtime_ms: number | null
        }>

        if (batchRows.length === 0) {
          break
        }

        for (const row of batchRows) {
          insertItemStmt.run(
            jobId,
            row.file_location_id,
            row.original_path,
            row.extension,
            row.discovery_observation_id,
            row.byte_size,
            row.filesystem_mtime_ms,
            now
          )
          lastFileId = row.file_location_id
          totalSnapshotted++
        }

        if (batchRows.length < batchSize) {
          break
        }
      }

      const initialStatus = totalSnapshotted === 0 ? 'completed' : 'running'
      const completedAt = totalSnapshotted === 0 ? now : null

      this.db
        .prepare(
          `
          UPDATE photo_metadata_jobs
          SET total_photos = ?,
              pending_photos = ?,
              status = ?,
              completed_at_ms = ?,
              updated_at_ms = ?
          WHERE id = ?;
        `
        )
        .run(totalSnapshotted, totalSnapshotted, initialStatus, completedAt, now, jobId)

      this.db.exec('COMMIT;')
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;')
      } catch {
        // ignore
      }
      throw err
    }

    const created = this.getPhotoMetadataJob(jobId)
    if (!created) {
      throw new Error('Failed to create photo metadata extraction job')
    }
    return created
  }

  public getPhotoMetadataJob(jobId: string): PhotoMetadataJobRecord | null {
    this.assertOpen()
    const row = this.db.prepare('SELECT * FROM photo_metadata_jobs WHERE id = ?;').get(jobId) as
      Record<string, unknown> | undefined
    if (!row) return null
    return this.mapPhotoMetadataJobRow(row)
  }

  public getLatestPhotoMetadataJob(): PhotoMetadataJobRecord | null {
    this.assertOpen()
    const row = this.db
      .prepare('SELECT * FROM photo_metadata_jobs ORDER BY started_at_ms DESC, rowid DESC LIMIT 1;')
      .get() as Record<string, unknown> | undefined
    if (!row) return null
    return this.mapPhotoMetadataJobRow(row)
  }

  public markRunningPhotoMetadataJobsAsInterrupted(): number {
    this.assertOpen()
    const now = Date.now()
    const res = this.db
      .prepare(
        "UPDATE photo_metadata_jobs SET status = 'interrupted', updated_at_ms = ? WHERE status = 'running';"
      )
      .run(now)
    return Number(res.changes)
  }

  public updatePhotoMetadataJobStatus(
    jobId: string,
    status: PhotoMetadataJobRecord['status'],
    lastError?: string | null
  ): PhotoMetadataJobRecord | null {
    this.assertOpen()
    const now = Date.now()
    const completedAt =
      status === 'completed' || status === 'cancelled' || status === 'failed' ? now : null

    this.db
      .prepare(
        `
        UPDATE photo_metadata_jobs
        SET status = ?,
            updated_at_ms = ?,
            completed_at_ms = COALESCE(?, completed_at_ms),
            last_error = CASE WHEN ? IS NOT NULL THEN ? ELSE last_error END
        WHERE id = ?;
      `
      )
      .run(status, now, completedAt, lastError ?? null, lastError ?? null, jobId)

    return this.getPhotoMetadataJob(jobId)
  }

  public getNextPendingPhotoMetadataJobItems(
    jobId: string,
    limit: number = METADATA_LIMITS.JOB_FETCH_BATCH_SIZE
  ): PhotoMetadataJobItemRecord[] {
    this.assertOpen()
    const safeLimit = Math.max(1, Math.min(64, Math.floor(limit)))
    const rows = this.db
      .prepare(
        `
        SELECT id, job_id, file_location_id, original_path, recorded_extension,
               discovery_observation_id, expected_byte_size, expected_mtime_ms,
               status, error_code, error_message, updated_at_ms
        FROM photo_metadata_job_items
        WHERE job_id = ? AND status = 'pending'
        ORDER BY id ASC
        LIMIT ?;
      `
      )
      .all(jobId, safeLimit) as Array<Record<string, unknown>>

    return rows.map((r) => this.mapPhotoMetadataJobItemRow(r))
  }

  public listPhotoMetadataJobItems(options: {
    jobId: string
    status?: PhotoMetadataJobItemRecord['status']
    limit?: number
    offset?: number
  }): { items: PhotoMetadataJobItemRecord[]; totalCount: number } {
    this.assertOpen()
    const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 50)))
    const offset = Math.max(0, Math.floor(options.offset ?? 0))
    const statusCond = options.status ? 'AND status = ?' : ''
    const countParams: SQLInputValue[] = options.status
      ? [options.jobId, options.status]
      : [options.jobId]
    const rowParams: SQLInputValue[] = options.status
      ? [options.jobId, options.status, limit, offset]
      : [options.jobId, limit, offset]

    const countRow = this.db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM photo_metadata_job_items WHERE job_id = ? ${statusCond};`
      )
      .get(...countParams) as { cnt: number } | undefined

    const rows = this.db
      .prepare(
        `
        SELECT id, job_id, file_location_id, original_path, recorded_extension,
               discovery_observation_id, expected_byte_size, expected_mtime_ms,
               status, error_code, error_message, updated_at_ms
        FROM photo_metadata_job_items
        WHERE job_id = ? ${statusCond}
        ORDER BY id ASC
        LIMIT ? OFFSET ?;
      `
      )
      .all(...rowParams) as Array<Record<string, unknown>>

    return {
      items: rows.map((r) => this.mapPhotoMetadataJobItemRow(r)),
      totalCount: Number(countRow?.cnt ?? 0)
    }
  }

  public hasReusablePhotoTechnicalMetadataCandidate(params: {
    observedByteSize: number
    parserRecipeVersion: string
  }): boolean {
    this.assertOpen()
    const row = this.db
      .prepare(
        `
        SELECT 1 AS ok
        FROM photo_technical_metadata
        WHERE observed_byte_size = ?
          AND parser_recipe_version = ?
          AND extraction_status IN ('extracted', 'no_metadata')
        LIMIT 1;
      `
      )
      .get(params.observedByteSize, params.parserRecipeVersion) as { ok: number } | undefined
    return Boolean(row)
  }

  public findReusablePhotoTechnicalMetadata(params: {
    contentSha256: string
    observedByteSize: number
    parserRecipeVersion: string
  }): PhotoTechnicalMetadataRecord | null {
    this.assertOpen()
    const row = this.db
      .prepare(
        `
        SELECT *
        FROM photo_technical_metadata
        WHERE content_sha256 = ?
          AND observed_byte_size = ?
          AND parser_recipe_version = ?
          AND extraction_status IN ('extracted', 'no_metadata')
        ORDER BY is_current DESC, id DESC
        LIMIT 1;
      `
      )
      .get(
        params.contentSha256.toLowerCase(),
        params.observedByteSize,
        params.parserRecipeVersion
      ) as Record<string, unknown> | undefined

    if (!row) return null
    return this.mapPhotoTechnicalMetadataRow(row)
  }

  public completePhotoMetadataJobItem(params: {
    jobId: string
    itemId: number
    reused: boolean
    metadata: SavePhotoTechnicalMetadataInput
  }): void {
    this.assertOpen()
    const now = Date.now()

    this.db.exec('BEGIN IMMEDIATE TRANSACTION;')
    try {
      const itemRow = this.db
        .prepare(
          'SELECT status, file_location_id FROM photo_metadata_job_items WHERE id = ? AND job_id = ?;'
        )
        .get(params.itemId, params.jobId) as
        { status: string; file_location_id: number } | undefined

      if (!itemRow || itemRow.status !== 'pending') {
        throw new Error(`Photo metadata job item ${params.itemId} is no longer pending`)
      }

      // Transactionally revalidate current catalog observation before committing
      const currentObs = this.db
        .prepare(
          `
          SELECT d.id AS discovery_id, d.byte_size, d.filesystem_mtime_ms, h.sha256 AS active_hash
          FROM file_locations f
          JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1
          LEFT JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1
          WHERE f.id = ?;
        `
        )
        .get(params.metadata.fileLocationId) as
        | {
            discovery_id: number
            byte_size: number
            filesystem_mtime_ms: number | null
            active_hash: string | null
          }
        | undefined

      if (!currentObs) {
        throw new Error('SOURCE_REVISION_CHANGED: File location no longer present in catalog')
      }

      if (
        currentObs.discovery_id !== params.metadata.discoveryObservationId ||
        (params.metadata.observedByteSize !== null &&
          currentObs.byte_size !== params.metadata.observedByteSize) ||
        (params.metadata.observedMtimeMs !== null &&
          currentObs.filesystem_mtime_ms !== null &&
          !isObservationTimestampMatching(
            params.metadata.observedMtimeMs,
            currentObs.filesystem_mtime_ms
          )) ||
        (params.metadata.contentSha256 !== null &&
          currentObs.active_hash !== null &&
          currentObs.active_hash.toLowerCase() !== params.metadata.contentSha256.toLowerCase())
      ) {
        throw new Error(
          'SOURCE_REVISION_CHANGED: Catalog observation changed before metadata commit'
        )
      }

      const normalizedSha = params.metadata.contentSha256
        ? params.metadata.contentSha256.toLowerCase()
        : null

      // Supersede any existing current row for this location & recipe without erasing history
      this.db
        .prepare(
          `
          UPDATE photo_technical_metadata
          SET is_current = 0
          WHERE file_location_id = ? AND parser_recipe_version = ? AND is_current = 1;
        `
        )
        .run(params.metadata.fileLocationId, params.metadata.parserRecipeVersion)

      this.db
        .prepare(
          `
          INSERT INTO photo_technical_metadata (
            file_location_id, discovery_observation_id, parser_recipe_version, extraction_status,
            content_sha256, content_revision, observed_byte_size, observed_mtime_ms,
            recorded_extension, detected_format, extension_format_mismatch,
            encoded_width_px, encoded_height_px, exif_orientation, display_width_px, display_height_px,
            capture_date_source_tag, raw_capture_date_text, capture_subseconds,
            capture_offset_minutes, capture_offset_text, capture_timezone_status,
            capture_calendar_date, capture_local_iso, capture_utc_epoch_ms,
            capture_date_parse_error, capture_date_conflict,
            camera_make_raw, camera_model_raw, camera_display, camera_normalized,
            lens_make_raw, lens_model_raw, lens_display, lens_normalized,
            raw_metadata_json, error_code, error_message, created_at_ms, is_current
          ) VALUES (
            ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?,
            ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?, ?, 1
          );
        `
        )
        .run(
          params.metadata.fileLocationId,
          params.metadata.discoveryObservationId,
          params.metadata.parserRecipeVersion,
          params.metadata.extractionStatus,
          normalizedSha,
          params.metadata.contentRevision,
          params.metadata.observedByteSize,
          params.metadata.observedMtimeMs,
          params.metadata.recordedExtension,
          params.metadata.detectedFormat,
          params.metadata.extensionFormatMismatch ? 1 : 0,
          params.metadata.encodedWidthPx,
          params.metadata.encodedHeightPx,
          params.metadata.exifOrientation,
          params.metadata.displayWidthPx,
          params.metadata.displayHeightPx,
          params.metadata.captureDateSourceTag,
          params.metadata.rawCaptureDateText,
          params.metadata.captureSubseconds,
          params.metadata.captureOffsetMinutes,
          params.metadata.captureOffsetText,
          params.metadata.captureTimezoneStatus,
          params.metadata.captureCalendarDate,
          params.metadata.captureLocalIso,
          params.metadata.captureUtcEpochMs,
          params.metadata.captureDateParseError,
          params.metadata.captureDateConflict,
          params.metadata.cameraMakeRaw,
          params.metadata.cameraModelRaw,
          params.metadata.cameraDisplay,
          params.metadata.cameraNormalized,
          params.metadata.lensMakeRaw,
          params.metadata.lensModelRaw,
          params.metadata.lensDisplay,
          params.metadata.lensNormalized,
          params.metadata.rawMetadataJson,
          params.metadata.errorCode,
          params.metadata.errorMessage,
          now
        )

      const mStatus = params.metadata.extractionStatus
      const jobItemStatus = params.reused ? 'reused' : mStatus

      this.db
        .prepare(
          `
          UPDATE photo_metadata_job_items
          SET status = ?, error_code = ?, error_message = ?, updated_at_ms = ?
          WHERE id = ? AND job_id = ?;
        `
        )
        .run(
          jobItemStatus,
          params.metadata.errorCode,
          params.metadata.errorMessage,
          now,
          params.itemId,
          params.jobId
        )

      const isExtracted = mStatus === 'extracted' ? 1 : 0
      const isNoMetadata = mStatus === 'no_metadata' ? 1 : 0
      const isProcessed = isExtracted || isNoMetadata ? 1 : 0
      const isReused = isProcessed && params.reused ? 1 : 0
      const isUnsupported = mStatus === 'unsupported' ? 1 : 0
      const isFailed = mStatus === 'failed' ? 1 : 0

      this.db
        .prepare(
          `
          UPDATE photo_metadata_jobs
          SET processed_photos = processed_photos + ?,
              extracted_photos = extracted_photos + ?,
              absent_metadata_photos = absent_metadata_photos + ?,
              reused_photos = reused_photos + ?,
              unsupported_photos = unsupported_photos + ?,
              failed_photos = failed_photos + ?,
              pending_photos = CASE WHEN pending_photos > 0 THEN pending_photos - 1 ELSE 0 END,
              updated_at_ms = ?
          WHERE id = ?;
        `
        )
        .run(
          isProcessed,
          isExtracted,
          isNoMetadata,
          isReused,
          isUnsupported,
          isFailed,
          now,
          params.jobId
        )

      this.db.exec('COMMIT;')
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;')
      } catch {
        // ignore
      }
      throw err
    }
  }

  public recordPhotoMetadataJobItemTransientFailure(params: {
    jobId: string
    itemId: number
    errorCode: string
    errorMessage: string
  }): void {
    this.assertOpen()
    const now = Date.now()
    this.db.exec('BEGIN IMMEDIATE TRANSACTION;')
    try {
      const itemRow = this.db
        .prepare('SELECT status FROM photo_metadata_job_items WHERE id = ? AND job_id = ?;')
        .get(params.itemId, params.jobId) as { status: string } | undefined

      if (!itemRow || itemRow.status !== 'pending') {
        this.db.exec('ROLLBACK;')
        return
      }

      this.db
        .prepare(
          `
          UPDATE photo_metadata_job_items
          SET status = 'failed', error_code = ?, error_message = ?, updated_at_ms = ?
          WHERE id = ? AND job_id = ?;
        `
        )
        .run(params.errorCode, params.errorMessage, now, params.itemId, params.jobId)

      this.db
        .prepare(
          `
          UPDATE photo_metadata_jobs
          SET failed_photos = failed_photos + 1,
              pending_photos = CASE WHEN pending_photos > 0 THEN pending_photos - 1 ELSE 0 END,
              updated_at_ms = ?
          WHERE id = ?;
        `
        )
        .run(now, params.jobId)

      this.db.exec('COMMIT;')
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;')
      } catch {
        // ignore
      }
      throw err
    }
  }

  public getPhotoTechnicalMetadataDetail(
    fileLocationId: number,
    parserRecipeVersion: string = METADATA_PARSER_RECIPE_VERSION
  ): PhotoTechnicalMetadataDetailResult | null {
    this.assertOpen()
    const fileRow = this.db
      .prepare(
        `
        SELECT f.id, f.extension, d.id AS discovery_id
        FROM file_locations f
        JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1
        WHERE f.id = ?;
      `
      )
      .get(fileLocationId) as { id: number; extension: string; discovery_id: number } | undefined

    if (!fileRow) {
      return null
    }

    const currentRevision = this.getPhotoRevisionString(fileLocationId)

    const currentMetaRow = this.db
      .prepare(
        `
        SELECT *
        FROM photo_technical_metadata
        WHERE file_location_id = ?
          AND discovery_observation_id = ?
          AND parser_recipe_version = ?
          AND is_current = 1
        LIMIT 1;
      `
      )
      .get(fileLocationId, fileRow.discovery_id, parserRecipeVersion) as
      Record<string, unknown> | undefined

    const histRow = this.db
      .prepare(
        `
        SELECT COUNT(*) AS total_rows
        FROM photo_technical_metadata
        WHERE file_location_id = ?;
      `
      )
      .get(fileLocationId) as { total_rows: number } | undefined

    const totalRows = Number(histRow?.total_rows ?? 0)
    const currentMetadata = currentMetaRow
      ? this.mapPhotoTechnicalMetadataRow(currentMetaRow)
      : null
    const historicalMetadataCount = currentMetadata ? Math.max(0, totalRows - 1) : totalRows

    let effectiveStatus: PhotoTechnicalMetadataDetailResult['effectiveStatus']
    if (currentMetadata) {
      effectiveStatus = currentMetadata.extractionStatus
    } else if (totalRows > 0) {
      effectiveStatus = 'stale'
    } else {
      effectiveStatus = 'unprocessed'
    }

    return {
      fileLocationId,
      currentRevision,
      effectiveStatus,
      parserRecipeVersion,
      recordedExtension: fileRow.extension,
      historicalMetadataCount,
      currentMetadata
    }
  }

  public getPhotoMetadataFacets(options: GetPhotoMetadataFacetsOptions): PhotoMetadataFacetsResult {
    this.assertOpen()
    const recipe = options.parserRecipeVersion || METADATA_PARSER_RECIPE_VERSION
    const limit = Math.max(
      1,
      Math.min(
        METADATA_LIMITS.FACET_MAX_LIMIT,
        Math.floor(options.limit ?? METADATA_LIMITS.FACET_DEFAULT_LIMIT)
      )
    )
    const offset = Math.max(0, Math.floor(options.offset ?? 0))
    const search = options.search?.trim().toLowerCase() ?? ''

    const cov = this.getPhotoMetadataCoverage(recipe)
    const unprocessedCount = cov.unprocessedCount + cov.staleCount

    if (options.field === 'filename_extension') {
      const searchCond = search ? 'AND LOWER(f.extension) LIKE ?' : ''
      const queryParams: SQLInputValue[] = search
        ? [`%${search}%`, limit + 1, offset]
        : [limit + 1, offset]

      const rows = this.db
        .prepare(
          `
          SELECT LOWER(f.extension) AS norm_val, LOWER(f.extension) AS disp_val, COUNT(*) AS cnt
          FROM file_locations f
          JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1
          WHERE f.category = 'photo'
            AND f.extension IS NOT NULL
            AND f.extension != ''
            ${searchCond}
          GROUP BY LOWER(f.extension)
          ORDER BY cnt DESC, norm_val ASC
          LIMIT ? OFFSET ?;
        `
        )
        .all(...queryParams) as Array<{ norm_val: string; disp_val: string; cnt: number }>

      const hasMore = rows.length > limit
      const sliced = hasMore ? rows.slice(0, limit) : rows

      return {
        field: options.field,
        items: sliced.map((r) => ({
          normalizedValue: r.norm_val,
          displayLabel: r.disp_val,
          count: Number(r.cnt)
        })),
        unknownCount: 0,
        unprocessedCount,
        offset,
        limit,
        hasMore
      }
    }

    if (options.field === 'detected_format') {
      const searchCond = search ? 'AND tm.detected_format LIKE ?' : ''
      const queryParams: SQLInputValue[] = search
        ? [recipe, `%${search}%`, limit + 1, offset]
        : [recipe, limit + 1, offset]

      const rows = this.db
        .prepare(
          `
          SELECT tm.detected_format AS norm_val, UPPER(tm.detected_format) AS disp_val, COUNT(*) AS cnt
          FROM file_locations f
          JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1
          JOIN photo_technical_metadata tm
            ON tm.file_location_id = f.id
           AND tm.is_current = 1
           AND tm.parser_recipe_version = ?
           AND tm.discovery_observation_id = d.id
          WHERE f.category = 'photo'
            AND tm.detected_format IS NOT NULL
            ${searchCond}
          GROUP BY tm.detected_format
          ORDER BY cnt DESC, norm_val ASC
          LIMIT ? OFFSET ?;
        `
        )
        .all(...queryParams) as Array<{ norm_val: string; disp_val: string; cnt: number }>

      const unknownRow = this.db
        .prepare(
          `
          SELECT COUNT(*) AS cnt
          FROM file_locations f
          JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1
          JOIN photo_technical_metadata tm
            ON tm.file_location_id = f.id
           AND tm.is_current = 1
           AND tm.parser_recipe_version = ?
           AND tm.discovery_observation_id = d.id
          WHERE f.category = 'photo'
            AND tm.detected_format IS NULL;
        `
        )
        .get(recipe) as { cnt: number } | undefined

      const hasMore = rows.length > limit
      const sliced = hasMore ? rows.slice(0, limit) : rows

      return {
        field: options.field,
        items: sliced.map((r) => ({
          normalizedValue: r.norm_val,
          displayLabel: r.disp_val,
          count: Number(r.cnt)
        })),
        unknownCount: Number(unknownRow?.cnt ?? 0),
        unprocessedCount,
        offset,
        limit,
        hasMore
      }
    }

    const normCol = options.field === 'camera' ? 'camera_normalized' : 'lens_normalized'
    const dispCol = options.field === 'camera' ? 'camera_display' : 'lens_display'
    const searchCond = search ? `AND tm.${normCol} LIKE ?` : ''
    const queryParams: SQLInputValue[] = search
      ? [recipe, `%${search}%`, limit + 1, offset]
      : [recipe, limit + 1, offset]

    const rows = this.db
      .prepare(
        `
        SELECT tm.${normCol} AS norm_val, MAX(tm.${dispCol}) AS disp_val, COUNT(*) AS cnt
        FROM file_locations f
        JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1
        JOIN photo_technical_metadata tm
          ON tm.file_location_id = f.id
         AND tm.is_current = 1
         AND tm.parser_recipe_version = ?
         AND tm.discovery_observation_id = d.id
        WHERE f.category = 'photo'
          AND tm.extraction_status IN ('extracted', 'no_metadata')
          AND tm.${normCol} IS NOT NULL
          ${searchCond}
        GROUP BY tm.${normCol}
        ORDER BY cnt DESC, norm_val ASC
        LIMIT ? OFFSET ?;
      `
      )
      .all(...queryParams) as Array<{ norm_val: string; disp_val: string; cnt: number }>

    const unknownRow = this.db
      .prepare(
        `
        SELECT COUNT(*) AS cnt
        FROM file_locations f
        JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1
        JOIN photo_technical_metadata tm
          ON tm.file_location_id = f.id
         AND tm.is_current = 1
         AND tm.parser_recipe_version = ?
         AND tm.discovery_observation_id = d.id
        WHERE f.category = 'photo'
          AND tm.extraction_status IN ('extracted', 'no_metadata')
          AND tm.${normCol} IS NULL;
      `
      )
      .get(recipe) as { cnt: number } | undefined

    const hasMore = rows.length > limit
    const sliced = hasMore ? rows.slice(0, limit) : rows

    return {
      field: options.field,
      items: sliced.map((r) => ({
        normalizedValue: r.norm_val,
        displayLabel: r.disp_val ?? r.norm_val,
        count: Number(r.cnt)
      })),
      unknownCount: Number(unknownRow?.cnt ?? 0),
      unprocessedCount,
      offset,
      limit,
      hasMore
    }
  }

  private mapPhotoMetadataJobRow(row: Record<string, unknown>): PhotoMetadataJobRecord {
    return {
      id: String(row.id),
      status: row.status as PhotoMetadataJobRecord['status'],
      parserRecipeVersion: String(row.parser_recipe_version),
      totalPhotos: Number(row.total_photos),
      processedPhotos: Number(row.processed_photos),
      extractedPhotos: Number(row.extracted_photos),
      absentMetadataPhotos: Number(row.absent_metadata_photos),
      reusedPhotos: Number(row.reused_photos),
      unsupportedPhotos: Number(row.unsupported_photos),
      failedPhotos: Number(row.failed_photos),
      pendingPhotos: Number(row.pending_photos),
      startedAtMs: Number(row.started_at_ms),
      updatedAtMs: Number(row.updated_at_ms),
      completedAtMs:
        row.completed_at_ms !== null && row.completed_at_ms !== undefined
          ? Number(row.completed_at_ms)
          : null,
      lastError:
        row.last_error !== null && row.last_error !== undefined ? String(row.last_error) : null
    }
  }

  private mapPhotoMetadataJobItemRow(row: Record<string, unknown>): PhotoMetadataJobItemRecord {
    return {
      id: Number(row.id),
      jobId: String(row.job_id),
      fileLocationId: Number(row.file_location_id),
      originalPath: String(row.original_path),
      recordedExtension: String(row.recorded_extension),
      discoveryObservationId: Number(row.discovery_observation_id),
      expectedByteSize: Number(row.expected_byte_size),
      expectedMtimeMs:
        row.expected_mtime_ms !== null && row.expected_mtime_ms !== undefined
          ? Number(row.expected_mtime_ms)
          : null,
      status: row.status as PhotoMetadataJobItemRecord['status'],
      errorCode:
        row.error_code !== null && row.error_code !== undefined ? String(row.error_code) : null,
      errorMessage:
        row.error_message !== null && row.error_message !== undefined
          ? String(row.error_message)
          : null,
      updatedAtMs:
        row.updated_at_ms !== null && row.updated_at_ms !== undefined
          ? Number(row.updated_at_ms)
          : null
    }
  }

  private mapPhotoTechnicalMetadataRow(row: Record<string, unknown>): PhotoTechnicalMetadataRecord {
    const strOrNull = (val: unknown): string | null =>
      val !== null && val !== undefined ? String(val) : null
    const numOrNull = (val: unknown): number | null =>
      val !== null && val !== undefined ? Number(val) : null

    return {
      id: Number(row.id),
      fileLocationId: Number(row.file_location_id),
      discoveryObservationId: Number(row.discovery_observation_id),
      parserRecipeVersion: String(row.parser_recipe_version),
      extractionStatus: row.extraction_status as PhotoTechnicalMetadataRecord['extractionStatus'],
      contentSha256: strOrNull(row.content_sha256),
      contentRevision: String(row.content_revision),
      observedByteSize: numOrNull(row.observed_byte_size),
      observedMtimeMs: numOrNull(row.observed_mtime_ms),
      recordedExtension: String(row.recorded_extension),
      detectedFormat: strOrNull(row.detected_format),
      extensionFormatMismatch: Number(row.extension_format_mismatch) === 1,

      encodedWidthPx: numOrNull(row.encoded_width_px),
      encodedHeightPx: numOrNull(row.encoded_height_px),
      exifOrientation: numOrNull(row.exif_orientation),
      displayWidthPx: numOrNull(row.display_width_px),
      displayHeightPx: numOrNull(row.display_height_px),

      captureDateSourceTag: strOrNull(
        row.capture_date_source_tag
      ) as PhotoTechnicalMetadataRecord['captureDateSourceTag'],
      rawCaptureDateText: strOrNull(row.raw_capture_date_text),
      captureSubseconds: strOrNull(row.capture_subseconds),
      captureOffsetMinutes: numOrNull(row.capture_offset_minutes),
      captureOffsetText: strOrNull(row.capture_offset_text),
      captureTimezoneStatus: String(
        row.capture_timezone_status
      ) as PhotoTechnicalMetadataRecord['captureTimezoneStatus'],
      captureCalendarDate: strOrNull(row.capture_calendar_date),
      captureLocalIso: strOrNull(row.capture_local_iso),
      captureUtcEpochMs: numOrNull(row.capture_utc_epoch_ms),
      captureDateParseError: strOrNull(row.capture_date_parse_error),
      captureDateConflict: strOrNull(row.capture_date_conflict),

      cameraMakeRaw: strOrNull(row.camera_make_raw),
      cameraModelRaw: strOrNull(row.camera_model_raw),
      cameraDisplay: strOrNull(row.camera_display),
      cameraNormalized: strOrNull(row.camera_normalized),
      lensMakeRaw: strOrNull(row.lens_make_raw),
      lensModelRaw: strOrNull(row.lens_model_raw),
      lensDisplay: strOrNull(row.lens_display),
      lensNormalized: strOrNull(row.lens_normalized),

      rawMetadataJson: strOrNull(row.raw_metadata_json),
      errorCode: strOrNull(row.error_code),
      errorMessage: strOrNull(row.error_message),
      createdAtMs: Number(row.created_at_ms),
      isCurrent: Number(row.is_current) === 1
    }
  }

  public populateRecoveredCatalog(
    input: PopulateRecoveredCatalogInput
  ): PopulateRecoveredCatalogResult {
    this.assertOpen()

    let recoveredVaultCopies = 0
    let recoveredSources = 0
    let recoveredFileLocations = 0
    let recoveredObservations = 0
    let historicalObservations = 0

    this.db.exec('BEGIN IMMEDIATE;')
    try {
      this.db.prepare('UPDATE vaults SET is_active = 0;').run()
      this.db
        .prepare(
          `INSERT INTO vaults (
            vault_id, vault_path, normalized_vault_path, name,
            created_at_ms, updated_at_ms, is_active, is_read_only
          ) VALUES (?, ?, ?, ?, ?, ?, 1, 1);`
        )
        .run(
          input.vaultId,
          input.vaultPath,
          input.normalizedVaultPath,
          input.vaultName,
          input.vaultCreatedAtMs,
          input.recoveredAtMs
        )

      const insertVaultCopyStmt = this.db.prepare(`
        INSERT INTO vault_copies (
          vault_id, sha256, byte_size, relative_path, manifest_relative_path,
          verified_at_ms, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);
      `)
      for (const copy of input.vaultCopies) {
        insertVaultCopyStmt.run(
          input.vaultId,
          copy.sha256,
          copy.byteSize,
          copy.relativePath,
          copy.manifestRelativePath,
          copy.verifiedAtMs,
          copy.createdAtMs,
          copy.updatedAtMs
        )
        recoveredVaultCopies++
      }

      const sourceIdByNormRoot = new Map<string, number>()
      const selectSourceStmt = this.db.prepare(
        'SELECT id FROM sources WHERE normalized_root_path = ?;'
      )
      const insertSourceStmt = this.db.prepare(`
        INSERT INTO sources (root_path, normalized_root_path, created_at_ms, updated_at_ms, source_kind)
        VALUES (?, ?, ?, ?, 'recovery_manifest');
      `)

      const insertFileLocationStmt = this.db.prepare(`
        INSERT INTO file_locations (
          source_id, original_path, normalized_path, file_name, extension, category,
          created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);
      `)
      const insertDiscoveryObsStmt = this.db.prepare(`
        INSERT INTO discovery_observations (
          file_location_id, byte_size, filesystem_birthtime_ms, filesystem_mtime_ms,
          inferred_capture_time_ms, observed_at_ms, last_seen_at_ms, is_current
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);
      `)
      const insertHashObsStmt = this.db.prepare(`
        INSERT INTO hash_observations (
          file_location_id, discovery_observation_id, sha256,
          observed_byte_size, observed_mtime_ms, hashed_at_ms, is_active
        ) VALUES (?, ?, ?, ?, ?, ?, ?);
      `)

      for (const loc of input.fileLocations) {
        let sourceId = sourceIdByNormRoot.get(loc.normalizedSourceRootPath)
        if (sourceId === undefined) {
          const existing = selectSourceStmt.get(loc.normalizedSourceRootPath) as
            { id: number } | undefined
          if (existing) {
            sourceId = existing.id
          } else {
            const res = insertSourceStmt.run(
              loc.sourceRootPath,
              loc.normalizedSourceRootPath,
              input.recoveredAtMs,
              input.recoveredAtMs
            )
            sourceId = Number(res.lastInsertRowid)
            recoveredSources++
          }
          sourceIdByNormRoot.set(loc.normalizedSourceRootPath, sourceId)
        }

        const fileLocRes = insertFileLocationStmt.run(
          sourceId,
          loc.originalPath,
          loc.normalizedPath,
          loc.fileName,
          loc.extension,
          loc.category,
          input.recoveredAtMs,
          input.recoveredAtMs
        )
        const fileLocationId = Number(fileLocRes.lastInsertRowid)
        recoveredFileLocations++

        for (const obs of loc.observations) {
          const isCurInt = obs.isCurrent ? 1 : 0
          const discRes = insertDiscoveryObsStmt.run(
            fileLocationId,
            obs.byteSize,
            obs.filesystemBirthtimeMs,
            obs.filesystemMtimeMs,
            obs.inferredCaptureTimeMs,
            obs.firstDiscoveredAtMs,
            obs.lastSeenAtMs,
            isCurInt
          )
          const discObsId = Number(discRes.lastInsertRowid)

          insertHashObsStmt.run(
            fileLocationId,
            discObsId,
            obs.sha256,
            obs.byteSize,
            obs.filesystemMtimeMs,
            obs.hashVerifiedAtMs,
            isCurInt
          )
          recoveredObservations++
          if (!obs.isCurrent) {
            historicalObservations++
          }
        }
      }

      const integrity = this.db.prepare('PRAGMA integrity_check;').get() as {
        integrity_check?: string
      }
      if (integrity.integrity_check !== 'ok') {
        throw new Error(
          `Recovered catalog failed PRAGMA integrity_check: ${integrity.integrity_check}`
        )
      }
      const fkViolations = this.db.prepare('PRAGMA foreign_key_check;').all()
      if (fkViolations.length > 0) {
        throw new Error(
          `Recovered catalog failed PRAGMA foreign_key_check (${fkViolations.length} violations)`
        )
      }

      this.db.exec('COMMIT;')
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;')
      } catch {
        // Ignore rollback failure
      }
      throw err
    }

    return {
      recoveredVaultCopies,
      recoveredSources,
      recoveredFileLocations,
      recoveredObservations,
      historicalObservations
    }
  }
}

function hasControlChars(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i)
    if ((code >= 0 && code <= 31) || (code >= 127 && code <= 159)) return true
  }
  return false
}

export function normalizeCollectionName(name: string): string {
  if (!name || typeof name !== 'string') {
    throw new TypeError('Collection name must be a non-empty string')
  }
  const trimmed = name.trim()
  if (trimmed.length < 1 || trimmed.length > 80) {
    throw new RangeError('Collection name must be between 1 and 80 characters')
  }
  if (hasControlChars(trimmed)) {
    throw new RangeError('Collection name must not contain control characters')
  }
  return trimmed.toLowerCase()
}

function ensureDocumentExtractionJobsColumns(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(document_extraction_jobs)').all() as Array<{
    name?: unknown
  }>
  if (columns.length === 0) {
    return
  }
  if (!columns.some((col) => col.name === 'force_reextract')) {
    db.exec(
      'ALTER TABLE document_extraction_jobs ADD COLUMN force_reextract INTEGER NOT NULL DEFAULT 0 CHECK (force_reextract IN (0, 1))'
    )
  }
  if (!columns.some((col) => col.name === 'snapshot_complete')) {
    db.exec(
      'ALTER TABLE document_extraction_jobs ADD COLUMN snapshot_complete INTEGER NOT NULL DEFAULT 1 CHECK (snapshot_complete IN (0, 1))'
    )
  }
}
