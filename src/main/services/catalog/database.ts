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
import { checkSchemaCompatibility, runMigrations } from './migrations'
import { normalizePathForLookup } from './path-normalization'
import { DatabaseClosedError, FileLocationNotFoundError } from './errors'
import type {
  CatalogDatabaseOptions,
  CatalogFileRecord,
  CatalogStats,
  DiscoveryCandidateInput,
  DiscoveryObservationRecord,
  DuplicateGroup,
  DuplicateGroupOptions,
  HashObservationRecord,
  BatchPersistenceResult,
  PaginatedResult,
  PaginationOptions,
  QueryFileLocationsOptions,
  RecordHashObservationInput,
  SourceRecord
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
  // Tolerates sub-millisecond precision loss (< 1.0 ms), rejects shifts >= 1.0 ms
  return Math.abs(observedMtimeMs - recordedMtimeMs) < 1.0
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
    this.closed = true
    this.db.close()
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
   * Idempotent & History-Preserving:
   * - New files insert a file_location and an initial current discovery_observation.
   * - Existing files with unchanged facts update last_seen_at_ms on the current observation.
   * - Existing files with changed byte_size or mtime:
   *   1. Mark previous discovery_observation as is_current = 0 (preserving prior facts in history).
   *   2. Invalidate previous active hash observations (is_active = 0, is_current = 0).
   *   3. Insert a NEW discovery_observation with is_current = 1, which starts with activeHash = null.
   */
  public persistDiscoveryBatch(
    sourceRoot: string,
    candidates: readonly DiscoveryCandidateInput[]
  ): BatchPersistenceResult {
    this.assertOpen()
    if (!sourceRoot || typeof sourceRoot !== 'string') {
      throw new TypeError('sourceRoot must be a non-empty string')
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
      validateSafeInteger(candidate.byteSize, 'byteSize', 0)
      if (candidate.category !== 'photo' && candidate.category !== 'document') {
        throw new TypeError(`Invalid category: ${String(candidate.category)}`)
      }
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

      const selectFileStmt = this.db.prepare(
        'SELECT id, original_path FROM file_locations WHERE original_path = ?;'
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
          { id: number; original_path: string } | undefined

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
          insertedCount++
        } else {
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

          if (sizeChanged || mtimeChanged) {
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
   * Retrieves paginated duplicate content clusters (active SHA-256 hashes with file count > 1).
   * Member locations per cluster are bounded to prevent unbounded memory loading.
   */
  public getDuplicateGroups(options: DuplicateGroupOptions = {}): PaginatedResult<DuplicateGroup> {
    this.assertOpen()
    const { offset, limit } = validatePagination(options)

    const maxLocationsPerGroup =
      options.maxLocationsPerGroup !== undefined
        ? validateSafeInteger(
            options.maxLocationsPerGroup,
            'maxLocationsPerGroup',
            1,
            MAX_LOCATIONS_PER_GROUP
          )
        : DEFAULT_MAX_LOCATIONS_PER_GROUP

    // Total duplicate hashes count
    const countSql = `
      SELECT COUNT(*) as total FROM (
        SELECT h.sha256
        FROM hash_observations h
        JOIN discovery_observations d ON d.id = h.discovery_observation_id AND d.is_current = 1
        WHERE h.is_active = 1
        GROUP BY h.sha256
        HAVING COUNT(DISTINCT h.file_location_id) > 1
      );
    `
    const countRow = this.db.prepare(countSql).get() as unknown as { total: number }
    const totalCount = countRow.total

    // Paginated groups
    const groupsSql = `
      SELECT
        h.sha256,
        h.observed_byte_size as byte_size,
        COUNT(DISTINCT h.file_location_id) as file_count
      FROM hash_observations h
      JOIN discovery_observations d ON d.id = h.discovery_observation_id AND d.is_current = 1
      WHERE h.is_active = 1
      GROUP BY h.sha256, h.observed_byte_size
      HAVING COUNT(DISTINCT h.file_location_id) > 1
      ORDER BY file_count DESC, h.sha256 ASC
      LIMIT ? OFFSET ?;
    `
    const groupRows = this.db.prepare(groupsSql).all(limit, offset) as unknown as Array<{
      sha256: string
      byte_size: number
      file_count: number
    }>

    const items: DuplicateGroup[] = groupRows.map((g) => {
      const filesSql = `
        SELECT
          f.id, f.source_id, f.original_path, f.normalized_path, f.file_name, f.extension, f.category,
          d.id as discovery_observation_id,
          d.byte_size, d.filesystem_birthtime_ms, d.filesystem_mtime_ms, d.inferred_capture_time_ms,
          d.observed_at_ms as first_discovered_at_ms, d.last_seen_at_ms,
          h.sha256 as active_hash,
          h.hashed_at_ms as active_hash_verified_at_ms
        FROM file_locations f
        JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1
        JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1
        WHERE h.sha256 = ?
        ORDER BY f.id ASC
        LIMIT ?;
      `
      const files = (
        this.db.prepare(filesSql).all(g.sha256, maxLocationsPerGroup) as unknown as RawFileRow[]
      ).map((r) => this.mapFileRow(r))

      return {
        sha256: g.sha256,
        byteSize: g.byte_size,
        fileCount: g.file_count,
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
}
