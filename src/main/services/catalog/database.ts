/**
 * Personal Vault — SQLite Catalog Persistence Service (Stage 2C)
 *
 * Implements an app-owned, modular SQLite database repository.
 * Stores source inventory, original file locations, discovery facts,
 * and successful SHA-256 observations with clear relationships.
 *
 * All operations use parameterized SQL, foreign-key constraints,
 * and transactional batch execution with rollback on failure.
 */

import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import { runMigrations } from './migrations'
import { normalizePathForLookup } from './path-normalization'
import { DatabaseClosedError, FileLocationNotFoundError } from './errors'
import type {
  CatalogDatabaseOptions,
  CatalogFileRecord,
  CatalogStats,
  DiscoveryCandidateInput,
  DuplicateGroup,
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
  byte_size: number
  filesystem_birthtime_ms: number | null
  filesystem_mtime_ms: number | null
  inferred_capture_time_ms: number | null
  first_discovered_at_ms: number
  last_seen_at_ms: number
  active_hash: string | null
  active_hash_verified_at_ms: number | null
}

interface RawHashRow {
  id: number
  file_location_id: number
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

const DEFAULT_PAGE_LIMIT = 50
const MAX_PAGE_LIMIT = 1000

export class CatalogDatabase {
  private readonly db: DatabaseSync
  private closed = false

  private constructor(db: DatabaseSync) {
    this.db = db
  }

  /**
   * Opens or creates a catalog database at the caller-supplied path.
   * Runs versioned schema migrations deterministically.
   */
  public static open(options: CatalogDatabaseOptions): CatalogDatabase {
    if (!options.catalogPath || typeof options.catalogPath !== 'string') {
      throw new TypeError('catalogPath must be a non-empty string')
    }

    if (options.catalogPath !== ':memory:') {
      mkdirSync(dirname(options.catalogPath), { recursive: true })
    }

    const rawDb = new DatabaseSync(options.catalogPath, {
      enableForeignKeyConstraints: options.enableForeignKeyConstraints ?? true,
      timeout: options.timeoutMs ?? 5000,
      readOnly: options.readOnly ?? false
    })

    if (!options.readOnly) {
      runMigrations(rawDb)
    }

    return new CatalogDatabase(rawDb)
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

  public listSources(): SourceRecord[] {
    this.assertOpen()
    const stmt = this.db.prepare(
      'SELECT id, root_path, normalized_root_path, created_at_ms, updated_at_ms FROM sources ORDER BY id ASC;'
    )
    const rows = stmt.all() as unknown as RawSourceRow[]
    return rows.map((r) => this.mapSourceRow(r))
  }

  /**
   * Persists a batch of discovered file candidates transactionally.
   * If any candidate violates constraints, the entire batch is rolled back.
   *
   * Idempotent:
   * - New files are inserted.
   * - Existing files with unchanged facts have last_seen_at_ms updated.
   * - Existing files with changed byte_size or mtime have discovery facts updated
   *   and any active hash observation invalidated (isActive = 0).
   */
  public persistDiscoveryBatch(
    sourceRoot: string,
    candidates: readonly DiscoveryCandidateInput[]
  ): BatchPersistenceResult {
    this.assertOpen()
    if (!sourceRoot || typeof sourceRoot !== 'string') {
      throw new TypeError('sourceRoot must be a non-empty string')
    }

    let source = this.getSourceByPath(sourceRoot)
    if (!source) {
      source = this.registerSource(sourceRoot)
    }

    const selectStmt = this.db.prepare(
      'SELECT id, byte_size, filesystem_mtime_ms FROM file_locations WHERE normalized_path = ?;'
    )

    const insertStmt = this.db.prepare(`
      INSERT INTO file_locations (
        source_id, original_path, normalized_path, file_name, extension, category,
        byte_size, filesystem_birthtime_ms, filesystem_mtime_ms, inferred_capture_time_ms,
        first_discovered_at_ms, last_seen_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?);
    `)

    const updateChangedStmt = this.db.prepare(`
      UPDATE file_locations SET
        byte_size = ?,
        filesystem_birthtime_ms = ?,
        filesystem_mtime_ms = ?,
        last_seen_at_ms = ?
      WHERE id = ?;
    `)

    const updateUnchangedStmt = this.db.prepare(`
      UPDATE file_locations SET last_seen_at_ms = ? WHERE id = ?;
    `)

    const invalidateHashStmt = this.db.prepare(`
      UPDATE hash_observations SET is_active = 0 WHERE file_location_id = ? AND is_active = 1;
    `)

    let insertedCount = 0
    let updatedCount = 0
    let unchangedCount = 0
    let invalidatedHashCount = 0

    this.db.exec('BEGIN TRANSACTION;')
    try {
      for (const candidate of candidates) {
        if (candidate.byteSize < 0) {
          throw new RangeError(`Candidate byteSize cannot be negative: ${candidate.byteSize}`)
        }
        if (candidate.category !== 'photo' && candidate.category !== 'document') {
          throw new TypeError(`Invalid category: ${String(candidate.category)}`)
        }

        const normalizedPath = normalizePathForLookup(candidate.originalPath)
        const existing = selectStmt.get(normalizedPath) as
          { id: number; byte_size: number; filesystem_mtime_ms: number | null } | undefined

        if (!existing) {
          insertStmt.run(
            source.id,
            candidate.originalPath,
            normalizedPath,
            candidate.fileName,
            candidate.extension,
            candidate.category,
            candidate.byteSize,
            candidate.birthtimeMs,
            candidate.mtimeMs,
            candidate.discoveredAtMs,
            candidate.discoveredAtMs
          )
          insertedCount++
        } else {
          const sizeChanged = existing.byte_size !== candidate.byteSize
          const mtimeChanged = existing.filesystem_mtime_ms !== candidate.mtimeMs

          if (sizeChanged || mtimeChanged) {
            updateChangedStmt.run(
              candidate.byteSize,
              candidate.birthtimeMs,
              candidate.mtimeMs,
              candidate.discoveredAtMs,
              existing.id
            )
            const result = invalidateHashStmt.run(existing.id)
            if (Number(result.changes) > 0) {
              invalidatedHashCount += Number(result.changes)
            }
            updatedCount++
          } else {
            updateUnchangedStmt.run(candidate.discoveredAtMs, existing.id)
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
   * Records a verified SHA-256 hash observation for a file location.
   * Verifies that observed size and modification timestamp match the current discovery facts.
   * Marks previous active hash observations for this location as inactive.
   */
  public recordHashObservation(input: RecordHashObservationInput): HashObservationRecord {
    this.assertOpen()
    if (!input.sha256 || input.sha256.length !== 64) {
      throw new RangeError(`Invalid SHA-256 length: ${input.sha256}`)
    }

    const file = this.getFileLocationByPath(input.originalPath)
    if (!file) {
      throw new FileLocationNotFoundError(input.originalPath)
    }

    // Verify consistency with current recorded facts
    if (file.byteSize !== input.observedByteSize) {
      throw new Error(
        `Observed byte size mismatch: observed ${input.observedByteSize} != catalog recorded ${file.byteSize}`
      )
    }

    if (file.filesystemMtimeMs !== null && input.observedMtimeMs !== null) {
      if (Math.abs(file.filesystemMtimeMs - input.observedMtimeMs) >= 1.0) {
        throw new Error(
          `Observed mtime mismatch: observed ${input.observedMtimeMs} != catalog recorded ${file.filesystemMtimeMs}`
        )
      }
    }

    this.db.exec('BEGIN TRANSACTION;')
    try {
      // Invalidate existing active hashes for this file
      this.db
        .prepare(
          'UPDATE hash_observations SET is_active = 0 WHERE file_location_id = ? AND is_active = 1;'
        )
        .run(file.id)

      // Insert new active hash observation
      const insertStmt = this.db.prepare(`
        INSERT INTO hash_observations (
          file_location_id, sha256, observed_byte_size, observed_mtime_ms, hashed_at_ms, is_active
        ) VALUES (?, ?, ?, ?, ?, 1)
        RETURNING id, file_location_id, sha256, observed_byte_size, observed_mtime_ms, hashed_at_ms, is_active;
      `)

      const row = insertStmt.get(
        file.id,
        input.sha256.toLowerCase(),
        input.observedByteSize,
        input.observedMtimeMs,
        input.hashedAtMs
      ) as unknown as RawHashRow

      this.db.exec('COMMIT;')
      return this.mapHashRow(row)
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
   * Records a batch of verified SHA-256 hash observations transactionally.
   * If any observation fails validation or consistency check, the entire batch rolls back.
   */
  public recordHashObservationsBatch(
    inputs: readonly RecordHashObservationInput[]
  ): readonly HashObservationRecord[] {
    this.assertOpen()
    if (inputs.length === 0) {
      return []
    }

    const results: HashObservationRecord[] = []
    this.db.exec('BEGIN TRANSACTION;')
    try {
      const invalidateStmt = this.db.prepare(
        'UPDATE hash_observations SET is_active = 0 WHERE file_location_id = ? AND is_active = 1;'
      )
      const insertStmt = this.db.prepare(`
        INSERT INTO hash_observations (
          file_location_id, sha256, observed_byte_size, observed_mtime_ms, hashed_at_ms, is_active
        ) VALUES (?, ?, ?, ?, ?, 1)
        RETURNING id, file_location_id, sha256, observed_byte_size, observed_mtime_ms, hashed_at_ms, is_active;
      `)

      for (const input of inputs) {
        if (!input.sha256 || input.sha256.length !== 64) {
          throw new RangeError(`Invalid SHA-256 length: ${input.sha256}`)
        }

        const file = this.getFileLocationByPath(input.originalPath)
        if (!file) {
          throw new FileLocationNotFoundError(input.originalPath)
        }

        if (file.byteSize !== input.observedByteSize) {
          throw new Error(
            `Observed byte size mismatch: observed ${input.observedByteSize} != catalog recorded ${file.byteSize}`
          )
        }

        if (file.filesystemMtimeMs !== null && input.observedMtimeMs !== null) {
          if (Math.abs(file.filesystemMtimeMs - input.observedMtimeMs) >= 1.0) {
            throw new Error(
              `Observed mtime mismatch: observed ${input.observedMtimeMs} != catalog recorded ${file.filesystemMtimeMs}`
            )
          }
        }

        invalidateStmt.run(file.id)
        const row = insertStmt.get(
          file.id,
          input.sha256.toLowerCase(),
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
    const normalizedPath = normalizePathForLookup(filePath)
    const stmt = this.db.prepare(`
      SELECT
        f.id, f.source_id, f.original_path, f.normalized_path, f.file_name, f.extension, f.category,
        f.byte_size, f.filesystem_birthtime_ms, f.filesystem_mtime_ms, f.inferred_capture_time_ms,
        f.first_discovered_at_ms, f.last_seen_at_ms,
        h.sha256 as active_hash,
        h.hashed_at_ms as active_hash_verified_at_ms
      FROM file_locations f
      LEFT JOIN hash_observations h ON h.file_location_id = f.id AND h.is_active = 1
      WHERE f.normalized_path = ?;
    `)
    const row = stmt.get(normalizedPath) as unknown as RawFileRow | undefined
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
        f.byte_size, f.filesystem_birthtime_ms, f.filesystem_mtime_ms, f.inferred_capture_time_ms,
        f.first_discovered_at_ms, f.last_seen_at_ms,
        h.sha256 as active_hash,
        h.hashed_at_ms as active_hash_verified_at_ms
      FROM file_locations f
      LEFT JOIN hash_observations h ON h.file_location_id = f.id AND h.is_active = 1
      WHERE f.id = ?;
    `)
    const row = stmt.get(id) as unknown as RawFileRow | undefined
    return row ? this.mapFileRow(row) : null
  }

  /**
   * Retrieves all historical hash observations for a specific file location.
   */
  public getHashObservationsForFile(fileLocationId: number): HashObservationRecord[] {
    this.assertOpen()
    const stmt = this.db.prepare(`
      SELECT id, file_location_id, sha256, observed_byte_size, observed_mtime_ms, hashed_at_ms, is_active
      FROM hash_observations
      WHERE file_location_id = ?
      ORDER BY hashed_at_ms DESC, id DESC;
    `)
    const rows = stmt.all(fileLocationId) as unknown as RawHashRow[]
    return rows.map((r) => this.mapHashRow(r))
  }

  /**
   * Executes bounded, paginated catalog file queries with optional filters.
   */
  public queryFileLocations(
    options: QueryFileLocationsOptions = {}
  ): PaginatedResult<CatalogFileRecord> {
    this.assertOpen()
    const offset = Math.max(0, options.offset ?? 0)
    const limit = Math.min(MAX_PAGE_LIMIT, Math.max(1, options.limit ?? DEFAULT_PAGE_LIMIT))

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
      LEFT JOIN hash_observations h ON h.file_location_id = f.id AND h.is_active = 1
      ${whereClause};
    `
    const countRow = this.db.prepare(countSql).get(...params) as unknown as { total: number }
    const totalCount = countRow.total

    // 2. Paginated rows query
    const querySql = `
      SELECT
        f.id, f.source_id, f.original_path, f.normalized_path, f.file_name, f.extension, f.category,
        f.byte_size, f.filesystem_birthtime_ms, f.filesystem_mtime_ms, f.inferred_capture_time_ms,
        f.first_discovered_at_ms, f.last_seen_at_ms,
        h.sha256 as active_hash,
        h.hashed_at_ms as active_hash_verified_at_ms
      FROM file_locations f
      LEFT JOIN hash_observations h ON h.file_location_id = f.id AND h.is_active = 1
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
   */
  public getDuplicateGroups(options: PaginationOptions = {}): PaginatedResult<DuplicateGroup> {
    this.assertOpen()
    const offset = Math.max(0, options.offset ?? 0)
    const limit = Math.min(MAX_PAGE_LIMIT, Math.max(1, options.limit ?? DEFAULT_PAGE_LIMIT))

    // Total duplicate hashes count
    const countSql = `
      SELECT COUNT(*) as total FROM (
        SELECT h.sha256
        FROM hash_observations h
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
          f.byte_size, f.filesystem_birthtime_ms, f.filesystem_mtime_ms, f.inferred_capture_time_ms,
          f.first_discovered_at_ms, f.last_seen_at_ms,
          h.sha256 as active_hash,
          h.hashed_at_ms as active_hash_verified_at_ms
        FROM file_locations f
        JOIN hash_observations h ON h.file_location_id = f.id AND h.is_active = 1
        WHERE h.sha256 = ?
        ORDER BY f.id ASC;
      `
      const files = (this.db.prepare(filesSql).all(g.sha256) as unknown as RawFileRow[]).map((r) =>
        this.mapFileRow(r)
      )
      return {
        sha256: g.sha256,
        byteSize: g.byte_size,
        fileCount: g.file_count,
        locations: files
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
      .get() as unknown as {
      count: number
    }
    const filesRow = this.db
      .prepare(
        `SELECT
          COUNT(*) as total_files,
          COALESCE(SUM(CASE WHEN category = 'photo' THEN 1 ELSE 0 END), 0) as total_photos,
          COALESCE(SUM(CASE WHEN category = 'document' THEN 1 ELSE 0 END), 0) as total_documents,
          COALESCE(SUM(byte_size), 0) as total_bytes
        FROM file_locations;`
      )
      .get() as unknown as {
      total_files: number
      total_photos: number
      total_documents: number
      total_bytes: number
    }

    const hashedRow = this.db
      .prepare(
        'SELECT COUNT(DISTINCT file_location_id) as count FROM hash_observations WHERE is_active = 1;'
      )
      .get() as unknown as { count: number }

    const totalFiles = filesRow.total_files
    const hashedFiles = hashedRow.count

    return {
      totalSources: sourcesRow.count,
      totalFiles,
      totalPhotos: filesRow.total_photos,
      totalDocuments: filesRow.total_documents,
      totalBytes: filesRow.total_bytes,
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

  private mapHashRow(row: RawHashRow): HashObservationRecord {
    return {
      id: row.id,
      fileLocationId: row.file_location_id,
      sha256: row.sha256,
      observedByteSize: row.observed_byte_size,
      observedMtimeMs: row.observed_mtime_ms,
      hashedAtMs: row.hashed_at_ms,
      isActive: row.is_active === 1
    }
  }
}
