/**
 * Shared point-in-time snapshot query helpers for Stage 7C document OCR jobs.
 *
 * Enforces:
 * 1. Independent compatibility between native extraction (`doc_extract_v1`) and
 *    OCR extraction (`doc_ocr_v1` + pinned model ID + manifest SHA-256 + language).
 * 2. Conservative `ocr_needed` scoping (never skipping mixed PDFs with scanned body pages
 *    or 32–64 MiB PDFs truncated by Stage 7B's 32 MiB native limit).
 * 3. Strict photo protection: bulk scopes (`ocr_needed`, `filtered`, `all`) query ONLY
 *    `f.category = 'document'` and NEVER bulk-OCR ordinary `category = 'photo'` items;
 *    only `selected` (`fileLocationIds`) permits explicitly selected document images.
 */

import { closeSync, openSync, writeSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { isObservationTimestampMatching } from '../semantic/vector'
import {
  DOCUMENT_EXTRACTION_LIMITS,
  DOCUMENT_EXTRACTION_RECIPE_VERSION,
  type PersistedDocumentExtractionStatus
} from '../documents/types'
import {
  OCR_MODEL_ID,
  OCR_MODEL_LANGUAGE,
  PINNED_OCR_MANIFEST_SHA256
} from '../documents/ocr/manifest'
import {
  DOCUMENT_OCR_LIMITS,
  DOCUMENT_OCR_RECIPE_VERSION,
  SUPPORTED_OCR_EXTENSIONS,
  SUPPORTED_OCR_IMAGE_EXTENSIONS,
  type DocumentOcrTerminalStatus
} from '../documents/ocr/types'
import {
  buildDocumentContentRevision,
  buildDocumentFilterSql,
  isExtractionRowCompatible,
  type SnapshotItem
} from './document-snapshot-query'

export type DocumentOcrJobScopeKind = 'selected' | 'ocr_needed' | 'filtered' | 'all'

export interface OcrCompatibilitySpec {
  readonly recipeVersion: string
  readonly ocrModelId: string
  readonly ocrModelManifestSha256: string
  readonly ocrLanguage: string
}

export const DEFAULT_OCR_COMPATIBILITY_SPEC: OcrCompatibilitySpec = {
  recipeVersion: DOCUMENT_OCR_RECIPE_VERSION,
  ocrModelId: OCR_MODEL_ID,
  ocrModelManifestSha256: PINNED_OCR_MANIFEST_SHA256,
  ocrLanguage: OCR_MODEL_LANGUAGE
}

export interface OcrSnapshotJobInput {
  readonly scopeKind: DocumentOcrJobScopeKind
  readonly recipeVersion: string
  readonly ocrModelId: string
  readonly ocrModelManifestSha256: string
  readonly ocrLanguage: string
  readonly nativeRecipeVersion?: string
  readonly fileLocationIds?: readonly number[]
  readonly extensionFilter?: string | null
  readonly filenameQuery?: string
  readonly retryFailed?: boolean
  readonly forceReocr?: boolean
}

export function normalizeDotExtension(ext: string): string {
  const trimmed = ext.trim().toLowerCase()
  if (!trimmed) return ''
  return trimmed.startsWith('.') ? trimmed : `.${trimmed}`
}

export function isOcrExtractionRowCompatible(
  row: {
    discovery_observation_id: number
    byte_size: number
    filesystem_mtime_ms: number | null
    active_hash: string | null
    ocr_discovery_observation_id: number | null
    ocr_content_sha256: string | null
    ocr_observed_byte_size: number | null
    ocr_observed_mtime_ms: number | null
    ocr_recipe_version: string | null
    ocr_model_id: string | null
    ocr_model_manifest_sha256: string | null
    ocr_language: string | null
  },
  expected: OcrCompatibilitySpec = DEFAULT_OCR_COMPATIBILITY_SPEC
): boolean {
  if (
    row.ocr_discovery_observation_id === null ||
    row.ocr_content_sha256 === null ||
    row.ocr_observed_byte_size === null ||
    row.ocr_recipe_version === null ||
    row.ocr_model_id === null ||
    row.ocr_model_manifest_sha256 === null ||
    row.ocr_language === null
  ) {
    return false
  }
  if (row.ocr_recipe_version !== expected.recipeVersion) {
    return false
  }
  if (row.ocr_model_id !== expected.ocrModelId) {
    return false
  }
  if (row.ocr_model_manifest_sha256 !== expected.ocrModelManifestSha256) {
    return false
  }
  if (row.ocr_language !== expected.ocrLanguage) {
    return false
  }
  if (row.ocr_discovery_observation_id !== row.discovery_observation_id) {
    return false
  }
  if (row.ocr_observed_byte_size !== row.byte_size) {
    return false
  }
  if (!isObservationTimestampMatching(row.ocr_observed_mtime_ms, row.filesystem_mtime_ms)) {
    return false
  }
  if (row.active_hash !== null && row.ocr_content_sha256 !== row.active_hash) {
    return false
  }
  return true
}

export function doesDocumentRowRequireOcr(
  row: {
    extension: string
    byte_size: number
    discovery_observation_id: number
    filesystem_mtime_ms: number | null
    active_hash: string | null
    ext_id: number | null
    ext_discovery_observation_id: number | null
    ext_content_sha256: string | null
    ext_observed_byte_size: number | null
    ext_observed_mtime_ms: number | null
    ext_recipe_version: string | null
    ext_status: PersistedDocumentExtractionStatus | null
    ext_ocr_candidate_page_count: number | null
  },
  nativeRecipeVersion = DOCUMENT_EXTRACTION_RECIPE_VERSION
): boolean {
  const ext = normalizeDotExtension(row.extension)
  if (!SUPPORTED_OCR_EXTENSIONS.has(ext)) {
    return false
  }
  if (row.byte_size > DOCUMENT_OCR_LIMITS.MAX_INPUT_BYTES) {
    return false
  }
  if (SUPPORTED_OCR_IMAGE_EXTENSIONS.has(ext)) {
    return true
  }
  if (ext !== '.pdf') {
    return false
  }

  // Absent or stale Stage 7B native extraction -> conservatively include
  if (
    row.ext_id === null ||
    row.ext_status === null ||
    !isExtractionRowCompatible(row, nativeRecipeVersion)
  ) {
    return true
  }

  switch (row.ext_status) {
    case 'no_text_ocr_required':
      return true
    case 'extracted':
      return row.ext_ocr_candidate_page_count === null || row.ext_ocr_candidate_page_count > 0
    case 'truncated':
      if (row.byte_size > DOCUMENT_EXTRACTION_LIMITS.MAX_INPUT_BYTES) {
        return true
      }
      return row.ext_ocr_candidate_page_count === null || row.ext_ocr_candidate_page_count > 0
    case 'password_protected':
    case 'unsupported':
    case 'corrupt_or_failed':
      return false
  }
}

/**
 * Captures a consistent point-in-time snapshot of matching OCR job items inside a
 * single read transaction and writes NDJSON lines to `stagingFilePath` in bounded batches.
 */
export function writeOcrSnapshotToStagingFile(
  db: DatabaseSync,
  input: OcrSnapshotJobInput,
  stagingFilePath: string
): number {
  const fd = openSync(stagingFilePath, 'w', 0o600)
  let count = 0
  let inReadTx = false
  const compatSpec: OcrCompatibilitySpec = {
    recipeVersion: input.recipeVersion,
    ocrModelId: input.ocrModelId,
    ocrModelManifestSha256: input.ocrModelManifestSha256,
    ocrLanguage: input.ocrLanguage
  }
  const nativeRecipe = input.nativeRecipeVersion ?? DOCUMENT_EXTRACTION_RECIPE_VERSION

  try {
    db.exec('BEGIN;')
    inReadTx = true

    if (input.scopeKind === 'selected' && input.fileLocationIds) {
      // ONLY explicit 'selected' scope allows user-chosen document images (category='photo')
      // alongside category='document'.
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
         WHERE f.id = ? AND f.category IN ('document', 'photo')
         LIMIT 1;`
      )
      const seen = new Set<number>()
      let lines: string[] = []
      for (const id of input.fileLocationIds) {
        if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id)) continue
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
      // All bulk scopes ('ocr_needed', 'filtered', 'all') strictly enforce f.category = 'document'
      // via buildDocumentFilterSql — NEVER bulk-OCR ordinary photos!
      const { whereClause, params } = buildDocumentFilterSql({
        extensionFilter: input.scopeKind === 'filtered' ? input.extensionFilter : null,
        filenameQuery: input.scopeKind === 'filtered' ? input.filenameQuery : undefined
      })
      const READ_BATCH = 500
      const selectBatch = db.prepare(
        `SELECT
           f.id AS file_location_id,
           f.extension,
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
           e.extraction_status AS ext_status,
           e.ocr_candidate_page_count AS ext_ocr_candidate_page_count,
           o.id AS ocr_id,
           o.discovery_observation_id AS ocr_discovery_observation_id,
           o.content_sha256 AS ocr_content_sha256,
           o.observed_byte_size AS ocr_observed_byte_size,
           o.observed_mtime_ms AS ocr_observed_mtime_ms,
           o.recipe_version AS ocr_recipe_version,
           o.ocr_model_id,
           o.ocr_model_manifest_sha256,
           o.ocr_language,
           o.ocr_status
         FROM file_locations f
         JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1
         LEFT JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1
         LEFT JOIN document_extractions e ON e.file_location_id = f.id AND e.is_current = 1
         LEFT JOIN document_ocr_extractions o ON o.file_location_id = f.id AND o.is_current = 1
         ${whereClause} AND f.id > ?
         ORDER BY f.id ASC
         LIMIT ?;`
      )

      let lastFileId = 0
      while (true) {
        const batchRows = selectBatch.all(...params, lastFileId, READ_BATCH) as Array<{
          file_location_id: number
          extension: string
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
          ext_ocr_candidate_page_count: number | null
          ocr_id: number | null
          ocr_discovery_observation_id: number | null
          ocr_content_sha256: string | null
          ocr_observed_byte_size: number | null
          ocr_observed_mtime_ms: number | null
          ocr_recipe_version: string | null
          ocr_model_id: string | null
          ocr_model_manifest_sha256: string | null
          ocr_language: string | null
          ocr_status: DocumentOcrTerminalStatus | null
        }>

        if (batchRows.length === 0) {
          break
        }

        const lines: string[] = []
        for (const row of batchRows) {
          lastFileId = row.file_location_id

          if (input.scopeKind === 'ocr_needed' && !doesDocumentRowRequireOcr(row, nativeRecipe)) {
            continue
          }

          if (
            !input.forceReocr &&
            row.ocr_id !== null &&
            isOcrExtractionRowCompatible(row, compatSpec)
          ) {
            if (!(input.retryFailed && row.ocr_status === 'corrupt_or_failed')) {
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
