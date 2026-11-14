/**
 * Personal Vault — Document Catalog Repository (Stage 7A)
 *
 * Provides read-only paginated queries, filename/extension filtering,
 * paginated extension facets, and recorded-fact provenance details for
 * already-cataloged documents (`category = 'document'`) without owning
 * SQLite connection lifecycle or transactions.
 */

import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type {
  DocumentDetailItem,
  DocumentSummaryItem,
  GetDocumentExtensionFacetsRequest,
  GetDocumentExtensionFacetsResponse,
  GetDocumentsPageRequest,
  GetDocumentsPageResponse
} from '../../../shared/validation/document-schemas'

export interface DocumentRepositoryDeps {
  readonly getDb: () => DatabaseSync
}

interface RawDocumentRow {
  file_location_id: number
  source_id: number
  file_name: string
  extension: string
  original_path: string
  byte_size: number
  filesystem_birthtime_ms: number | null
  filesystem_mtime_ms: number | null
  first_discovered_at_ms: number
  last_seen_at_ms: number
  discovery_observation_id: number
  active_hash: string | null
  active_hash_verified_at_ms: number | null
}

interface RawDocumentDetailRow extends RawDocumentRow {
  source_root_path: string
  normalized_path: string
}

function escapeSqlLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&')
}

function validateOffsetLimit(offset: number, limit: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new RangeError(`offset must be a non-negative safe integer, got ${String(offset)}`)
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError(`limit must be an integer between 1 and 100, got ${String(limit)}`)
  }
}

export class DocumentRepository {
  private readonly deps: DocumentRepositoryDeps

  public constructor(deps: DocumentRepositoryDeps) {
    this.deps = deps
  }

  public getDocumentsPage(input: GetDocumentsPageRequest): GetDocumentsPageResponse {
    const db = this.deps.getDb()
    validateOffsetLimit(input.offset, input.limit)

    const conditions: string[] = ["f.category = 'document'"]
    const params: SQLInputValue[] = []

    if (input.extensionFilter !== undefined && input.extensionFilter !== null) {
      const normalizedExt = input.extensionFilter.trim().toLowerCase()
      if (normalizedExt.length > 0) {
        conditions.push('LOWER(f.extension) = ?')
        params.push(normalizedExt)
      }
    }

    if (input.filenameQuery !== undefined) {
      const trimmed = input.filenameQuery.trim()
      if (trimmed.length > 0) {
        conditions.push("LOWER(f.file_name) LIKE ? ESCAPE '\\'")
        params.push(`%${escapeSqlLike(trimmed.toLowerCase())}%`)
      }
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`

    const countRow = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM file_locations f
         JOIN discovery_observations d
           ON d.file_location_id = f.id AND d.is_current = 1
         ${whereClause};`
      )
      .get(...params) as unknown as { count: number }

    const rows = db
      .prepare(
        `SELECT
           f.id AS file_location_id,
           f.source_id,
           f.file_name,
           f.extension,
           f.original_path,
           d.byte_size,
           d.filesystem_birthtime_ms,
           d.filesystem_mtime_ms,
           d.observed_at_ms AS first_discovered_at_ms,
           d.last_seen_at_ms,
           d.id AS discovery_observation_id,
           h.sha256 AS active_hash,
           h.hashed_at_ms AS active_hash_verified_at_ms
         FROM file_locations f
         JOIN discovery_observations d
           ON d.file_location_id = f.id AND d.is_current = 1
         LEFT JOIN hash_observations h
           ON h.discovery_observation_id = d.id AND h.is_active = 1
         ${whereClause}
         ORDER BY f.id ASC
         LIMIT ? OFFSET ?;`
      )
      .all(...params, input.limit, input.offset) as unknown as RawDocumentRow[]

    return {
      items: rows.map((row) => this.mapSummaryRow(row)),
      totalCount: countRow.count,
      offset: input.offset,
      limit: input.limit
    }
  }

  public getDocumentDetail(fileLocationId: number): DocumentDetailItem | null {
    const db = this.deps.getDb()
    if (!Number.isSafeInteger(fileLocationId) || fileLocationId <= 0) {
      throw new RangeError(
        `fileLocationId must be a positive safe integer, got ${String(fileLocationId)}`
      )
    }

    const row = db
      .prepare(
        `SELECT
           f.id AS file_location_id,
           f.source_id,
           s.root_path AS source_root_path,
           f.normalized_path,
           f.file_name,
           f.extension,
           f.original_path,
           d.byte_size,
           d.filesystem_birthtime_ms,
           d.filesystem_mtime_ms,
           d.observed_at_ms AS first_discovered_at_ms,
           d.last_seen_at_ms,
           d.id AS discovery_observation_id,
           h.sha256 AS active_hash,
           h.hashed_at_ms AS active_hash_verified_at_ms
         FROM file_locations f
         JOIN sources s
           ON s.id = f.source_id
         JOIN discovery_observations d
           ON d.file_location_id = f.id AND d.is_current = 1
         LEFT JOIN hash_observations h
           ON h.discovery_observation_id = d.id AND h.is_active = 1
         WHERE f.id = ? AND f.category = 'document'
         LIMIT 1;`
      )
      .get(fileLocationId) as unknown as RawDocumentDetailRow | undefined

    if (!row) {
      return null
    }

    return {
      ...this.mapSummaryRow(row),
      sourceRootPath: row.source_root_path,
      normalizedPath: row.normalized_path
    }
  }

  public getDocumentExtensionFacets(
    input: GetDocumentExtensionFacetsRequest
  ): GetDocumentExtensionFacetsResponse {
    const db = this.deps.getDb()
    validateOffsetLimit(input.offset, input.limit)

    const countRow = db
      .prepare(
        `SELECT COUNT(DISTINCT LOWER(f.extension)) AS count
         FROM file_locations f
         JOIN discovery_observations d
           ON d.file_location_id = f.id AND d.is_current = 1
         WHERE f.category = 'document';`
      )
      .get() as unknown as { count: number }

    const rows = db
      .prepare(
        `SELECT LOWER(f.extension) AS extension, COUNT(*) AS count
         FROM file_locations f
         JOIN discovery_observations d
           ON d.file_location_id = f.id AND d.is_current = 1
         WHERE f.category = 'document'
         GROUP BY LOWER(f.extension)
         ORDER BY count DESC, extension ASC
         LIMIT ? OFFSET ?;`
      )
      .all(input.limit, input.offset) as unknown as Array<{ extension: string; count: number }>

    return {
      items: rows,
      totalCount: countRow.count,
      offset: input.offset,
      limit: input.limit
    }
  }

  private mapSummaryRow(row: RawDocumentRow): DocumentSummaryItem {
    return {
      fileLocationId: row.file_location_id,
      sourceId: row.source_id,
      fileName: row.file_name,
      extension: row.extension,
      originalPath: row.original_path,
      byteSize: row.byte_size,
      filesystemBirthtimeMs: row.filesystem_birthtime_ms,
      filesystemMtimeMs: row.filesystem_mtime_ms,
      firstDiscoveredAtMs: row.first_discovered_at_ms,
      lastSeenAtMs: row.last_seen_at_ms,
      discoveryObservationId: row.discovery_observation_id,
      activeHash: row.active_hash,
      activeHashVerifiedAtMs: row.active_hash_verified_at_ms,
      extractionStatus: 'not_extracted',
      previewStatus: 'not_implemented'
    }
  }
}
