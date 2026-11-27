/**
 * Shared point-in-time snapshot query helpers for document extraction jobs.
 *
 * Used both by DocumentRepository (for :memory: databases and catalog queries)
 * and by document_snapshot_worker (for isolated read-only SQLite snapshots
 * off the main process event loop).
 */

import { closeSync, openSync, writeSync } from 'node:fs'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { isObservationTimestampMatching } from '../semantic/vector'
import {
  DOCUMENT_EXTRACTION_RECIPE_VERSION,
  type PersistedDocumentExtractionStatus
} from '../documents/types'

export interface SnapshotJobInput {
  readonly scopeKind: 'selected' | 'filtered' | 'all'
  readonly recipeVersion: string
  readonly fileLocationIds?: readonly number[]
  readonly extensionFilter?: string | null
  readonly filenameQuery?: string
  readonly retryFailed?: boolean
  readonly forceReextract?: boolean
}

export interface SnapshotItem {
  readonly f: number
  readonly d: number
  readonly r: string
}

export function buildDocumentContentRevision(input: {
  discoveryObservationId: number
  byteSize: number
  filesystemMtimeMs: number | null
  activeHash: string | null
}): string {
  return `rev:${input.discoveryObservationId}:${input.byteSize}:${input.filesystemMtimeMs ?? 'null'}:${input.activeHash ?? 'unhashed'}`
}

export function escapeSqlLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&')
}

export function isExtractionRowCompatible(
  row: {
    discovery_observation_id: number
    byte_size: number
    filesystem_mtime_ms: number | null
    active_hash: string | null
    ext_discovery_observation_id: number | null
    ext_content_sha256: string | null
    ext_observed_byte_size: number | null
    ext_observed_mtime_ms: number | null
    ext_recipe_version: string | null
  },
  expectedRecipeVersion = DOCUMENT_EXTRACTION_RECIPE_VERSION
): boolean {
  if (
    row.ext_discovery_observation_id === null ||
    row.ext_content_sha256 === null ||
    row.ext_observed_byte_size === null ||
    row.ext_recipe_version === null
  ) {
    return false
  }
  if (row.ext_recipe_version !== expectedRecipeVersion) {
    return false
  }
  if (row.ext_discovery_observation_id !== row.discovery_observation_id) {
    return false
  }
  if (row.ext_observed_byte_size !== row.byte_size) {
    return false
  }
  if (!isObservationTimestampMatching(row.ext_observed_mtime_ms, row.filesystem_mtime_ms)) {
    return false
  }
  if (row.active_hash !== null && row.ext_content_sha256 !== row.active_hash) {
    return false
  }
  return true
}

export function buildDocumentFilterSql(input: {
  extensionFilter?: string | null
  filenameQuery?: string
}): { whereClause: string; params: SQLInputValue[] } {
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

  return {
    whereClause: `WHERE ${conditions.join(' AND ')}`,
    params
  }
}

/**
 * Captures a consistent point-in-time snapshot of matching document job items
 * inside a single read transaction and streams them as NDJSON lines to `stagingFilePath`
 * using bounded memory (500-row keyset cursor batches).
 */
export function writeSnapshotToStagingFile(
  db: DatabaseSync,
  input: SnapshotJobInput,
  stagingFilePath: string
): number {
  const fd = openSync(stagingFilePath, 'w', 0o600)
  let count = 0
  let inReadTx = false
  try {
    db.exec('BEGIN;')
    inReadTx = true

    if (input.scopeKind === 'selected' && input.fileLocationIds) {
      const selectOne = db.prepare(
        `SELECT
           f.id AS file_location_id,
           d.id AS discovery_observation_id,
           d.byte_size,
           d.filesystem_mtime_ms,
           h.sha256 AS active_hash
         FROM file_locations f
         JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1
         LEFT JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1
         WHERE f.id = ? AND f.category = 'document'
         LIMIT 1;`
      )
      const seen = new Set<number>()
      let lines: string[] = []
      for (const id of input.fileLocationIds) {
        if (seen.has(id)) continue
        seen.add(id)
        const row = selectOne.get(id) as
          | {
              file_location_id: number
              discovery_observation_id: number
              byte_size: number
              filesystem_mtime_ms: number | null
              active_hash: string | null
            }
          | undefined
        if (row) {
          const rev = buildDocumentContentRevision({
            discoveryObservationId: row.discovery_observation_id,
            byteSize: row.byte_size,
            filesystemMtimeMs: row.filesystem_mtime_ms,
            activeHash: row.active_hash
          })
          lines.push(
            JSON.stringify({
              f: row.file_location_id,
              d: row.discovery_observation_id,
              r: rev
            } satisfies SnapshotItem)
          )
          count++
          if (lines.length >= 500) {
            writeSync(fd, lines.join('\n') + '\n', null, 'utf8')
            lines = []
          }
        }
      }
      if (lines.length > 0) {
        writeSync(fd, lines.join('\n') + '\n', null, 'utf8')
      }
    } else {
      const { whereClause, params } = buildDocumentFilterSql({
        extensionFilter: input.scopeKind === 'filtered' ? input.extensionFilter : null,
        filenameQuery: input.scopeKind === 'filtered' ? input.filenameQuery : undefined
      })
      const READ_BATCH = 500
      const selectBatch = db.prepare(
        `SELECT
           f.id AS file_location_id,
           d.id AS discovery_observation_id,
           d.byte_size,
           d.filesystem_mtime_ms,
           h.sha256 AS active_hash,
           e.id AS ext_id,
           e.discovery_observation_id AS ext_discovery_observation_id,
           e.content_sha256 AS ext_content_sha256,
           e.observed_byte_size AS ext_observed_byte_size,
           e.observed_mtime_ms AS ext_observed_mtime_ms,
           e.recipe_version AS ext_recipe_version,
           e.extraction_status AS ext_status
         FROM file_locations f
         JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1
         LEFT JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1
         LEFT JOIN document_extractions e ON e.file_location_id = f.id AND e.is_current = 1
         ${whereClause} AND f.id > ?
         ORDER BY f.id ASC
         LIMIT ?;`
      )

      let lastFileId = 0
      while (true) {
        const batchRows = selectBatch.all(...params, lastFileId, READ_BATCH) as Array<{
          file_location_id: number
          discovery_observation_id: number
          byte_size: number
          filesystem_mtime_ms: number | null
          active_hash: string | null
          ext_id: number | null
          ext_discovery_observation_id: number | null
          ext_content_sha256: string | null
          ext_observed_byte_size: number | null
          ext_observed_mtime_ms: number | null
          ext_recipe_version: string | null
          ext_status: PersistedDocumentExtractionStatus | null
        }>

        if (batchRows.length === 0) {
          break
        }

        const lines: string[] = []
        for (const row of batchRows) {
          lastFileId = row.file_location_id
          if (
            !input.forceReextract &&
            row.ext_id !== null &&
            isExtractionRowCompatible(row, input.recipeVersion)
          ) {
            if (!(input.retryFailed && row.ext_status === 'corrupt_or_failed')) {
              continue
            }
          }
          const rev = buildDocumentContentRevision({
            discoveryObservationId: row.discovery_observation_id,
            byteSize: row.byte_size,
            filesystemMtimeMs: row.filesystem_mtime_ms,
            activeHash: row.active_hash
          })
          lines.push(
            JSON.stringify({
              f: row.file_location_id,
              d: row.discovery_observation_id,
              r: rev
            } satisfies SnapshotItem)
          )
          count++
        }
        if (lines.length > 0) {
          writeSync(fd, lines.join('\n') + '\n', null, 'utf8')
        }
        if (batchRows.length < READ_BATCH) {
          break
        }
      }
    }

    db.exec('COMMIT;')
    inReadTx = false
    return count
  } finally {
    if (inReadTx) {
      try {
        db.exec('ROLLBACK;')
      } catch {
        // ignore rollback error
      }
    }
    try {
      closeSync(fd)
    } catch {
      // ignore close error
    }
  }
}
