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
import { mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { checkSchemaCompatibility, runMigrations } from './migrations'
import { normalizePathForLookup } from './path-normalization'
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
  ImportCandidatesResult
} from './types'

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
  inferred_capture_time_ms: number | null
  sha256: string
  discovery_observation_id: number
  hash_observation_id: number
  vault_copy_id: number | null
  vault_status: 'not_imported' | 'copied'
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

export function isObservationTimestampMatching(
  observedMtimeMs: number | null,
  recordedMtimeMs: number | null
): boolean {
  if (observedMtimeMs === null && recordedMtimeMs === null) {
    return true
  }
  if (observedMtimeMs === null || recordedMtimeMs === null) {
    // Conservative null matching: one null and one non-null is an unambiguous mismatch
    return false
  }
  // Stage 2B precision contract:
  // If discovery expectation was recorded as an integer (e.g. truncated precision),
  // tolerate differences strictly within 1.0 ms (|observed - recorded| < 1.0 ms).
  // If recorded has fractional milliseconds, exact comparison is enforced.
  if (Number.isInteger(recordedMtimeMs)) {
    return Math.abs(observedMtimeMs - recordedMtimeMs) < 1.0
  }
  return observedMtimeMs === recordedMtimeMs
}

export class CatalogDatabase {
  private readonly db: DatabaseSync
  private closed = false

  private constructor(db: DatabaseSync) {
    this.db = db
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
      }

      return new CatalogDatabase(rawDb)
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
            updatedCount++
          } else {
            updateObsLastSeenStmt.run(candidate.discoveredAtMs, currentObs.id)
            updateFileLocationStmt.run(now, existingFile.id)
            unchangedCount++
          }
        }
      }

      this.db.exec('COMMIT;')
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

        const row = insertHashStmt.get(
          fileAndObs.file_id,
          fileAndObs.discovery_observation_id,
          normalizedSha256,
          input.observedByteSize,
          input.observedMtimeMs,
          input.hashedAtMs
        ) as unknown as RawHashRow

        results.push(this.mapHashRow(row))
      }

      this.db.exec('COMMIT;')
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
        h.hashed_at_ms as active_hash_verified_at_ms
      FROM file_locations f
      JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1
      LEFT JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1
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

    const conditions: string[] = []
    const params: SQLInputValue[] = []

    if (typeof options.sourceId === 'number') {
      conditions.push('f.source_id = ?')
      params.push(options.sourceId)
    }

    if (options.category) {
      conditions.push('f.category = ?')
      params.push(options.category)
    }

    if (typeof options.hasActiveHash === 'boolean') {
      if (options.hasActiveHash) {
        conditions.push('h.sha256 IS NOT NULL')
      } else {
        conditions.push('h.sha256 IS NULL')
      }
    }

    if (options.sha256) {
      conditions.push('h.sha256 = ?')
      params.push(options.sha256.toLowerCase())
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    // 1. Total count query
    const countSql = `
      SELECT COUNT(DISTINCT f.id) as total
      FROM file_locations f
      JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1
      LEFT JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1
      ${whereClause};
    `
    const countRow = this.db.prepare(countSql).get(...params) as unknown as { total: number }
    const totalCount = countRow.total

    // 2. Paginated rows query
    const querySql = `
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
      ${whereClause}
      ORDER BY f.id ASC
      LIMIT ? OFFSET ?;
    `
    const rows = this.db.prepare(querySql).all(...params, limit, offset) as unknown as RawFileRow[]
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
      activeHashVerifiedAtMs: row.active_hash_verified_at_ms
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
      const stmt = this.db.prepare(`
        INSERT INTO vaults (vault_id, vault_path, normalized_vault_path, name, created_at_ms, updated_at_ms, is_active)
        VALUES (?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(vault_id) DO UPDATE SET
          vault_path = excluded.vault_path,
          normalized_vault_path = excluded.normalized_vault_path,
          name = excluded.name,
          updated_at_ms = excluded.updated_at_ms,
          is_active = 1;
      `)
      stmt.run(
        input.vaultId,
        input.vaultPath,
        normalizedVaultPath,
        input.name,
        input.createdAtMs,
        now
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
      isActive: row.is_active === 1
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
      isActive: true
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
      isActive: true
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
        d.inferred_capture_time_ms,
        h.sha256,
        d.id as discovery_observation_id,
        h.id as hash_observation_id,
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
      inferredCaptureTimeMs: r.inferred_capture_time_ms,
      sha256: r.sha256,
      discoveryObservationId: r.discovery_observation_id,
      hashObservationId: r.hash_observation_id,
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
}
