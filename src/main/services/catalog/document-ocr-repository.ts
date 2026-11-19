/**
 * Personal Vault — Stage 7C Document OCR Repository (`DocumentOcrRepository`)
 *
 * Persists offline OCR results (`document_ocr_extractions`) and resumable job state
 * (`document_ocr_jobs`, `document_ocr_job_items`) completely separately from Stage 7B
 * native extractions (`document_extractions`).
 *
 * Guarantees:
 * - Independent source/revision/model/manifest/language/recipe compatibility & provenance.
 * - Atomic `BEGIN IMMEDIATE` stale-commit rejection (`REVISION_MISMATCH`).
 * - Format-group-compatible reuse (`pdf_ocr` vs `raster_image_ocr`) under identical model+manifest+recipe.
 * - Point-in-time isolated job snapshots (`snapshot_complete = 0 -> 1`) and startup cleanup
 *   of incomplete crash snapshots.
 * - Explicit photo protection: bulk scopes (`ocr_needed`, `filtered`, `all`) NEVER include
 *   `category = 'photo'` rows; only explicit `selected` (`fileLocationIds`) allows user-chosen
 *   document images.
 */

import { createReadStream, readdirSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import { isObservationTimestampMatching } from '../semantic/vector'
import type { WorkerBudgetReservation } from '../worker-budget'
import { resolveMainWorkerScriptPath } from '../worker-path'
import {
  DOCUMENT_EXTRACTION_LIMITS,
  DOCUMENT_EXTRACTION_RECIPE_VERSION,
  type PersistedDocumentExtractionStatus
} from '../documents/types'
import {
  SUPPORTED_OCR_IMAGE_EXTENSIONS,
  type DocumentOcrMethod,
  type DocumentOcrTerminalStatus
} from '../documents/ocr/types'
import {
  buildDocumentContentRevision,
  buildDocumentFilterSql,
  type SnapshotItem
} from './document-snapshot-query'
import {
  DEFAULT_OCR_COMPATIBILITY_SPEC,
  doesDocumentRowRequireOcr,
  isOcrExtractionRowCompatible,
  normalizeDotExtension,
  type DocumentOcrJobScopeKind,
  type OcrCompatibilitySpec,
  type OcrSnapshotJobInput
} from './document-ocr-snapshot-query'

export type DocumentOcrStatus = 'not_processed' | 'processing' | 'stale' | DocumentOcrTerminalStatus

export type DocumentOcrPreviewStatus =
  | 'not_processed'
  | 'processing'
  | 'ready'
  | 'no_text'
  | 'password_protected'
  | 'unsupported'
  | 'failed'
  | 'truncated'
  | 'stale'

export type DocumentOcrJobStatus =
  'running' | 'paused' | 'cancelled' | 'interrupted' | 'completed' | 'failed'

export type DocumentOcrJobItemStatus =
  'pending' | DocumentOcrTerminalStatus | 'reused' | 'skipped_stale'

export interface DocumentOcrStateItem {
  readonly fileLocationId: number
  readonly category: 'document' | 'photo'
  readonly fileName: string
  readonly extension: string
  readonly originalPath: string
  readonly byteSize: number
  readonly filesystemMtimeMs: number | null
  readonly discoveryObservationId: number
  readonly activeHash: string | null
  readonly ocrStatus: DocumentOcrStatus
  readonly previewStatus: DocumentOcrPreviewStatus
  readonly recipeVersion: string | null
  readonly ocrModelId: string | null
  readonly ocrModelManifestSha256: string | null
  readonly ocrLanguage: string | null
  readonly extractionMethod: DocumentOcrMethod | null
  readonly extractedCharCount: number
  readonly pageCount: number | null
  readonly ocrPageCount: number
  readonly nativeOnlyPageCount: number
  readonly skippedBlankPageCount: number
  readonly meanConfidence: number | null
  readonly truncated: boolean
  readonly truncationReason: string | null
  readonly statusDetail: string | null
  readonly extractedAtMs: number | null
  readonly contentRevision: string | null
  readonly contentSha256: string | null
}

export interface DocumentOcrPreviewPayload extends DocumentOcrStateItem {
  readonly extractedText: string | null
  readonly previewCharCount: number
  readonly previewTruncated: boolean
}

export interface DocumentOcrCandidate {
  readonly fileLocationId: number
  readonly sourceId: number
  readonly sourceRootPath: string
  readonly originalPath: string
  readonly fileName: string
  readonly extension: string
  readonly category: 'document' | 'photo'
  readonly discoveryObservationId: number
  readonly byteSize: number
  readonly filesystemMtimeMs: number | null
  readonly activeHash: string | null
  readonly contentRevision: string
}

export interface ReusableDocumentOcrRecord {
  readonly extractionMethod: DocumentOcrMethod
  readonly ocrStatus: DocumentOcrTerminalStatus
  readonly statusDetail: string | null
  readonly extractedText: string | null
  readonly extractedCharCount: number
  readonly pageCount: number | null
  readonly ocrPageCount: number
  readonly nativeOnlyPageCount: number
  readonly skippedBlankPageCount: number
  readonly meanConfidence: number | null
  readonly truncated: boolean
  readonly truncationReason: string | null
}

export interface DocumentOcrCoverage {
  readonly totalDocuments: number
  readonly ocrNeededDocuments: number
  readonly notProcessedDocuments: number
  readonly extractedDocuments: number
  readonly noTextDocuments: number
  readonly passwordProtectedDocuments: number
  readonly unsupportedDocuments: number
  readonly failedDocuments: number
  readonly truncatedDocuments: number
  readonly staleDocuments: number
  readonly selectedImageOcrCount: number
}

export interface DocumentOcrJobRecord {
  readonly id: string
  readonly scopeKind: DocumentOcrJobScopeKind
  readonly status: DocumentOcrJobStatus
  readonly recipeVersion: string
  readonly ocrModelId: string
  readonly ocrModelManifestSha256: string
  readonly ocrLanguage: string
  readonly forceReocr: boolean
  readonly snapshotComplete: boolean
  readonly totalItems: number
  readonly processedItems: number
  readonly extractedItems: number
  readonly noTextItems: number
  readonly passwordProtectedItems: number
  readonly unsupportedItems: number
  readonly failedItems: number
  readonly truncatedItems: number
  readonly reusedItems: number
  readonly skippedStaleItems: number
  readonly pendingItems: number
  readonly startedAtMs: number
  readonly updatedAtMs: number
  readonly completedAtMs: number | null
  readonly lastError: string | null
}

export interface DocumentOcrJobItemRecord {
  readonly jobId: string
  readonly fileLocationId: number
  readonly discoveryObservationId: number
  readonly contentRevision: string
  readonly status: DocumentOcrJobItemStatus
  readonly errorMessage: string | null
  readonly updatedAtMs: number
}

export interface DocumentOcrRepositoryDeps {
  readonly getDb: () => DatabaseSync
  readonly getCatalogPath?: () => string
  readonly onOcrRelevantMutation?: () => void
}

interface RawOcrStateRow {
  file_location_id: number
  category: 'document' | 'photo'
  file_name: string
  extension: string
  original_path: string
  byte_size: number
  filesystem_mtime_ms: number | null
  discovery_observation_id: number
  active_hash: string | null
  ocr_id: number | null
  ocr_discovery_observation_id: number | null
  ocr_content_sha256: string | null
  ocr_observed_byte_size: number | null
  ocr_observed_mtime_ms: number | null
  ocr_content_revision: string | null
  ocr_recipe_version: string | null
  ocr_model_id: string | null
  ocr_model_manifest_sha256: string | null
  ocr_language: string | null
  ocr_extraction_method: DocumentOcrMethod | null
  ocr_status: DocumentOcrTerminalStatus | null
  ocr_status_detail: string | null
  ocr_text?: string | null
  ocr_char_count: number | null
  ocr_total_page_count: number | null
  ocr_page_count: number | null
  ocr_native_only_page_count: number | null
  ocr_skipped_blank_page_count: number | null
  ocr_mean_confidence: number | null
  ocr_truncated: number | null
  ocr_truncation_reason: string | null
  ocr_extracted_at_ms: number | null
}

function mapOcrPreviewStatus(status: DocumentOcrStatus): DocumentOcrPreviewStatus {
  switch (status) {
    case 'not_processed':
      return 'not_processed'
    case 'processing':
      return 'processing'
    case 'extracted':
      return 'ready'
    case 'ocr_no_text':
      return 'no_text'
    case 'password_protected':
      return 'password_protected'
    case 'unsupported':
      return 'unsupported'
    case 'corrupt_or_failed':
      return 'failed'
    case 'truncated':
      return 'truncated'
    case 'stale':
      return 'stale'
  }
}

function getCompatibleOcrReuseExtensions(extension: string): readonly string[] {
  const ext = normalizeDotExtension(extension)
  if (ext === '.pdf') {
    return ['.pdf']
  }
  if (SUPPORTED_OCR_IMAGE_EXTENSIONS.has(ext)) {
    return Array.from(SUPPORTED_OCR_IMAGE_EXTENSIONS)
  }
  return []
}

export class DocumentOcrRepository {
  public constructor(private readonly deps: DocumentOcrRepositoryDeps) {}

  private resolveCompatibilitySpec(partial?: Partial<OcrCompatibilitySpec>): OcrCompatibilitySpec {
    return {
      recipeVersion: partial?.recipeVersion ?? DEFAULT_OCR_COMPATIBILITY_SPEC.recipeVersion,
      ocrModelId: partial?.ocrModelId ?? DEFAULT_OCR_COMPATIBILITY_SPEC.ocrModelId,
      ocrModelManifestSha256:
        partial?.ocrModelManifestSha256 ?? DEFAULT_OCR_COMPATIBILITY_SPEC.ocrModelManifestSha256,
      ocrLanguage: partial?.ocrLanguage ?? DEFAULT_OCR_COMPATIBILITY_SPEC.ocrLanguage
    }
  }

  public getDocumentOcrState(
    fileLocationId: number,
    options?: Partial<OcrCompatibilitySpec> & {
      readonly processingFileLocationIds?: ReadonlySet<number>
    }
  ): DocumentOcrStateItem | null {
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
           f.category,
           f.file_name,
           f.extension,
           f.original_path,
           d.byte_size,
           d.filesystem_mtime_ms,
           d.id AS discovery_observation_id,
           h.sha256 AS active_hash,
           o.id AS ocr_id,
           o.discovery_observation_id AS ocr_discovery_observation_id,
           o.content_sha256 AS ocr_content_sha256,
           o.observed_byte_size AS ocr_observed_byte_size,
           o.observed_mtime_ms AS ocr_observed_mtime_ms,
           o.content_revision AS ocr_content_revision,
           o.recipe_version AS ocr_recipe_version,
           o.ocr_model_id,
           o.ocr_model_manifest_sha256,
           o.ocr_language,
           o.extraction_method AS ocr_extraction_method,
           o.ocr_status,
           o.status_detail AS ocr_status_detail,
           o.extracted_char_count AS ocr_char_count,
           o.page_count AS ocr_total_page_count,
           o.ocr_page_count,
           o.native_only_page_count AS ocr_native_only_page_count,
           o.skipped_blank_page_count AS ocr_skipped_blank_page_count,
           o.mean_confidence AS ocr_mean_confidence,
           o.truncated AS ocr_truncated,
           o.truncation_reason AS ocr_truncation_reason,
           o.extracted_at_ms AS ocr_extracted_at_ms
         FROM file_locations f
         JOIN discovery_observations d
           ON d.file_location_id = f.id AND d.is_current = 1
         LEFT JOIN hash_observations h
           ON h.discovery_observation_id = d.id AND h.is_active = 1
         LEFT JOIN document_ocr_extractions o
           ON o.file_location_id = f.id AND o.is_current = 1
         WHERE f.id = ? AND f.category IN ('document', 'photo')
         LIMIT 1;`
      )
      .get(fileLocationId) as unknown as RawOcrStateRow | undefined

    if (!row) {
      return null
    }

    const spec = this.resolveCompatibilitySpec(options)
    return this.mapStateRow(row, spec, options?.processingFileLocationIds)
  }

  public getDocumentOcrPreview(
    fileLocationId: number,
    options?: Partial<OcrCompatibilitySpec> & {
      readonly processingFileLocationIds?: ReadonlySet<number>
      readonly maxPreviewChars?: number
    }
  ): DocumentOcrPreviewPayload | null {
    const db = this.deps.getDb()
    if (!Number.isSafeInteger(fileLocationId) || fileLocationId <= 0) {
      throw new RangeError(
        `fileLocationId must be a positive safe integer, got ${String(fileLocationId)}`
      )
    }
    const maxPreviewChars = options?.maxPreviewChars ?? DOCUMENT_EXTRACTION_LIMITS.MAX_PREVIEW_CHARS

    const row = db
      .prepare(
        `SELECT
           f.id AS file_location_id,
           f.category,
           f.file_name,
           f.extension,
           f.original_path,
           d.byte_size,
           d.filesystem_mtime_ms,
           d.id AS discovery_observation_id,
           h.sha256 AS active_hash,
           o.id AS ocr_id,
           o.discovery_observation_id AS ocr_discovery_observation_id,
           o.content_sha256 AS ocr_content_sha256,
           o.observed_byte_size AS ocr_observed_byte_size,
           o.observed_mtime_ms AS ocr_observed_mtime_ms,
           o.content_revision AS ocr_content_revision,
           o.recipe_version AS ocr_recipe_version,
           o.ocr_model_id,
           o.ocr_model_manifest_sha256,
           o.ocr_language,
           o.extraction_method AS ocr_extraction_method,
           o.ocr_status,
           o.status_detail AS ocr_status_detail,
           o.extracted_text AS ocr_text,
           o.extracted_char_count AS ocr_char_count,
           o.page_count AS ocr_total_page_count,
           o.ocr_page_count,
           o.native_only_page_count AS ocr_native_only_page_count,
           o.skipped_blank_page_count AS ocr_skipped_blank_page_count,
           o.mean_confidence AS ocr_mean_confidence,
           o.truncated AS ocr_truncated,
           o.truncation_reason AS ocr_truncation_reason,
           o.extracted_at_ms AS ocr_extracted_at_ms
         FROM file_locations f
         JOIN discovery_observations d
           ON d.file_location_id = f.id AND d.is_current = 1
         LEFT JOIN hash_observations h
           ON h.discovery_observation_id = d.id AND h.is_active = 1
         LEFT JOIN document_ocr_extractions o
           ON o.file_location_id = f.id AND o.is_current = 1
         WHERE f.id = ? AND f.category IN ('document', 'photo')
         LIMIT 1;`
      )
      .get(fileLocationId) as unknown as RawOcrStateRow | undefined

    if (!row) {
      return null
    }

    const spec = this.resolveCompatibilitySpec(options)
    const state = this.mapStateRow(row, spec, options?.processingFileLocationIds)
    const compatible = row.ocr_id !== null && isOcrExtractionRowCompatible(row, spec)

    if (!compatible || !row.ocr_status) {
      return {
        ...state,
        extractedText: null,
        previewCharCount: 0,
        previewTruncated: false
      }
    }

    const rawText = row.ocr_text ?? null
    const previewTruncated = rawText !== null && rawText.length > maxPreviewChars
    const boundedText = rawText !== null ? rawText.slice(0, maxPreviewChars) : null

    return {
      ...state,
      extractedText: boundedText,
      previewCharCount: boundedText ? boundedText.length : 0,
      previewTruncated
    }
  }

  private mapStateRow(
    row: RawOcrStateRow,
    spec: OcrCompatibilitySpec,
    processingIds?: ReadonlySet<number>
  ): DocumentOcrStateItem {
    const compatible = row.ocr_id !== null && isOcrExtractionRowCompatible(row, spec)
    let ocrStatus: DocumentOcrStatus = 'not_processed'
    let statusDetail: string | null = null

    if (processingIds?.has(row.file_location_id)) {
      ocrStatus = 'processing'
    } else if (row.ocr_id !== null && row.ocr_status !== null) {
      if (compatible) {
        ocrStatus = row.ocr_status
        statusDetail = row.ocr_status_detail
      } else {
        ocrStatus = 'stale'
        statusDetail =
          'Source file, OCR recipe, or pinned OCR model changed since last OCR extraction.'
      }
    }

    return {
      fileLocationId: row.file_location_id,
      category: row.category,
      fileName: row.file_name,
      extension: row.extension,
      originalPath: row.original_path,
      byteSize: row.byte_size,
      filesystemMtimeMs: row.filesystem_mtime_ms,
      discoveryObservationId: row.discovery_observation_id,
      activeHash: row.active_hash,
      ocrStatus,
      previewStatus: mapOcrPreviewStatus(ocrStatus),
      recipeVersion: row.ocr_recipe_version,
      ocrModelId: row.ocr_model_id,
      ocrModelManifestSha256: row.ocr_model_manifest_sha256,
      ocrLanguage: row.ocr_language,
      extractionMethod: compatible ? row.ocr_extraction_method : null,
      extractedCharCount: compatible ? (row.ocr_char_count ?? 0) : 0,
      pageCount: compatible ? row.ocr_total_page_count : null,
      ocrPageCount: compatible ? (row.ocr_page_count ?? 0) : 0,
      nativeOnlyPageCount: compatible ? (row.ocr_native_only_page_count ?? 0) : 0,
      skippedBlankPageCount: compatible ? (row.ocr_skipped_blank_page_count ?? 0) : 0,
      meanConfidence: compatible ? row.ocr_mean_confidence : null,
      truncated: compatible ? row.ocr_truncated === 1 : false,
      truncationReason: compatible
        ? row.ocr_truncation_reason
        : ocrStatus === 'stale'
          ? statusDetail
          : null,
      statusDetail,
      extractedAtMs: row.ocr_extracted_at_ms,
      contentRevision: row.ocr_content_revision,
      contentSha256: row.ocr_content_sha256
    }
  }

  public getDocumentOcrCandidate(fileLocationId: number): DocumentOcrCandidate | null {
    const db = this.deps.getDb()
    const row = db
      .prepare(
        `SELECT
           f.id AS file_location_id,
           f.source_id,
           s.root_path AS source_root_path,
           f.original_path,
           f.file_name,
           f.extension,
           f.category,
           d.id AS discovery_observation_id,
           d.byte_size,
           d.filesystem_mtime_ms,
           h.sha256 AS active_hash
         FROM file_locations f
         JOIN sources s ON s.id = f.source_id
         JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1
         LEFT JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1
         WHERE f.id = ? AND f.category IN ('document', 'photo')
         LIMIT 1;`
      )
      .get(fileLocationId) as unknown as
      | {
          file_location_id: number
          source_id: number
          source_root_path: string
          original_path: string
          file_name: string
          extension: string
          category: 'document' | 'photo'
          discovery_observation_id: number
          byte_size: number
          filesystem_mtime_ms: number | null
          active_hash: string | null
        }
      | undefined

    if (!row) {
      return null
    }

    return {
      fileLocationId: row.file_location_id,
      sourceId: row.source_id,
      sourceRootPath: row.source_root_path,
      originalPath: row.original_path,
      fileName: row.file_name,
      extension: row.extension,
      category: row.category,
      discoveryObservationId: row.discovery_observation_id,
      byteSize: row.byte_size,
      filesystemMtimeMs: row.filesystem_mtime_ms,
      activeHash: row.active_hash,
      contentRevision: buildDocumentContentRevision({
        discoveryObservationId: row.discovery_observation_id,
        byteSize: row.byte_size,
        filesystemMtimeMs: row.filesystem_mtime_ms,
        activeHash: row.active_hash
      })
    }
  }

  public findReusableDocumentOcrExtraction(input: {
    contentSha256: string
    recipeVersion: string
    ocrModelId: string
    ocrModelManifestSha256: string
    ocrLanguage: string
    targetExtension: string
  }): ReusableDocumentOcrRecord | null {
    const compatibleExts = getCompatibleOcrReuseExtensions(input.targetExtension)
    if (compatibleExts.length === 0) {
      return null
    }

    const placeholders = compatibleExts.map(() => '?').join(', ')
    const db = this.deps.getDb()
    const row = db
      .prepare(
        `SELECT
           o.extraction_method,
           o.ocr_status,
           o.status_detail,
           o.extracted_text,
           o.extracted_char_count,
           o.page_count,
           o.ocr_page_count,
           o.native_only_page_count,
           o.skipped_blank_page_count,
           o.mean_confidence,
           o.truncated,
           o.truncation_reason
         FROM document_ocr_extractions o
         JOIN file_locations f ON f.id = o.file_location_id
         WHERE o.content_sha256 = ?
           AND o.recipe_version = ?
           AND o.ocr_model_id = ?
           AND o.ocr_model_manifest_sha256 = ?
           AND o.ocr_language = ?
           AND o.is_current = 1
           AND o.ocr_status IN ('extracted', 'ocr_no_text', 'truncated')
           AND LOWER(f.extension) IN (${placeholders})
         ORDER BY o.extracted_at_ms DESC
         LIMIT 1;`
      )
      .get(
        input.contentSha256,
        input.recipeVersion,
        input.ocrModelId,
        input.ocrModelManifestSha256,
        input.ocrLanguage,
        ...compatibleExts
      ) as unknown as
      | {
          extraction_method: DocumentOcrMethod
          ocr_status: DocumentOcrTerminalStatus
          status_detail: string | null
          extracted_text: string | null
          extracted_char_count: number
          page_count: number | null
          ocr_page_count: number
          native_only_page_count: number
          skipped_blank_page_count: number
          mean_confidence: number | null
          truncated: number
          truncation_reason: string | null
        }
      | undefined

    if (!row) {
      return null
    }

    return {
      extractionMethod: row.extraction_method,
      ocrStatus: row.ocr_status,
      statusDetail: row.status_detail,
      extractedText: row.extracted_text,
      extractedCharCount: row.extracted_char_count,
      pageCount: row.page_count,
      ocrPageCount: row.ocr_page_count,
      nativeOnlyPageCount: row.native_only_page_count,
      skippedBlankPageCount: row.skipped_blank_page_count,
      meanConfidence: row.mean_confidence,
      truncated: row.truncated === 1,
      truncationReason: row.truncation_reason
    }
  }

  public upsertDocumentOcrExtraction(input: {
    fileLocationId: number
    expectedDiscoveryObservationId: number
    expectedContentRevision: string
    contentSha256: string
    observedByteSize: number
    observedMtimeMs: number | null
    recipeVersion: string
    ocrModelId: string
    ocrModelManifestSha256: string
    ocrLanguage: string
    extractionMethod: DocumentOcrMethod
    ocrStatus: DocumentOcrTerminalStatus
    statusDetail: string | null
    extractedText: string | null
    extractedCharCount: number
    pageCount: number | null
    ocrPageCount: number
    nativeOnlyPageCount: number
    skippedBlankPageCount: number
    meanConfidence: number | null
    truncated: boolean
    truncationReason: string | null
    extractedAtMs?: number
  }): { committed: true } | { committed: false; reason: 'REVISION_MISMATCH' } {
    const db = this.deps.getDb()
    const now = input.extractedAtMs ?? Date.now()

    db.exec('BEGIN IMMEDIATE;')
    try {
      const current = db
        .prepare(
          `SELECT
             d.id AS discovery_observation_id,
             d.byte_size,
             d.filesystem_mtime_ms,
             h.sha256 AS active_hash
           FROM file_locations f
           JOIN discovery_observations d
             ON d.file_location_id = f.id AND d.is_current = 1
           LEFT JOIN hash_observations h
             ON h.discovery_observation_id = d.id AND h.is_active = 1
           WHERE f.id = ? AND f.category IN ('document', 'photo')
           LIMIT 1;`
        )
        .get(input.fileLocationId) as unknown as
        | {
            discovery_observation_id: number
            byte_size: number
            filesystem_mtime_ms: number | null
            active_hash: string | null
          }
        | undefined

      if (!current) {
        db.exec('ROLLBACK;')
        return { committed: false, reason: 'REVISION_MISMATCH' }
      }

      const currentRevision = buildDocumentContentRevision({
        discoveryObservationId: current.discovery_observation_id,
        byteSize: current.byte_size,
        filesystemMtimeMs: current.filesystem_mtime_ms,
        activeHash: current.active_hash
      })

      if (
        current.discovery_observation_id !== input.expectedDiscoveryObservationId ||
        currentRevision !== input.expectedContentRevision ||
        current.byte_size !== input.observedByteSize ||
        !isObservationTimestampMatching(input.observedMtimeMs, current.filesystem_mtime_ms) ||
        (current.active_hash !== null && current.active_hash !== input.contentSha256)
      ) {
        db.exec('ROLLBACK;')
        return { committed: false, reason: 'REVISION_MISMATCH' }
      }

      db.prepare(
        `UPDATE document_ocr_extractions
         SET is_current = 0
         WHERE file_location_id = ? AND is_current = 1;`
      ).run(input.fileLocationId)

      db.prepare(
        `INSERT INTO document_ocr_extractions (
           file_location_id,
           discovery_observation_id,
           content_sha256,
           observed_byte_size,
           observed_mtime_ms,
           content_revision,
           recipe_version,
           ocr_model_id,
           ocr_model_manifest_sha256,
           ocr_language,
           extraction_method,
           ocr_status,
           status_detail,
           extracted_text,
           extracted_char_count,
           page_count,
           ocr_page_count,
           native_only_page_count,
           skipped_blank_page_count,
           mean_confidence,
           truncated,
           truncation_reason,
           extracted_at_ms,
           is_current
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1);`
      ).run(
        input.fileLocationId,
        input.expectedDiscoveryObservationId,
        input.contentSha256,
        input.observedByteSize,
        input.observedMtimeMs,
        input.expectedContentRevision,
        input.recipeVersion,
        input.ocrModelId,
        input.ocrModelManifestSha256,
        input.ocrLanguage,
        input.extractionMethod,
        input.ocrStatus,
        input.statusDetail,
        input.extractedText,
        input.extractedCharCount,
        input.pageCount,
        input.ocrPageCount,
        input.nativeOnlyPageCount,
        input.skippedBlankPageCount,
        input.meanConfidence,
        input.truncated ? 1 : 0,
        input.truncationReason,
        now
      )

      db.exec('COMMIT;')
      this.deps.onOcrRelevantMutation?.()
      return { committed: true }
    } catch (error) {
      try {
        db.exec('ROLLBACK;')
      } catch {
        // ignore rollback error
      }
      throw error
    }
  }

  public getDocumentOcrCoverage(
    options?: Partial<OcrCompatibilitySpec> & { readonly nativeRecipeVersion?: string }
  ): DocumentOcrCoverage {
    const db = this.deps.getDb()
    const spec = this.resolveCompatibilitySpec(options)
    const nativeRecipe = options?.nativeRecipeVersion ?? DOCUMENT_EXTRACTION_RECIPE_VERSION

    const counts = createMutableOcrCoverage()

    const docRows = db
      .prepare(
        `SELECT
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
         JOIN discovery_observations d
           ON d.file_location_id = f.id AND d.is_current = 1
         LEFT JOIN hash_observations h
           ON h.discovery_observation_id = d.id AND h.is_active = 1
         LEFT JOIN document_extractions e
           ON e.file_location_id = f.id AND e.is_current = 1
         LEFT JOIN document_ocr_extractions o
           ON o.file_location_id = f.id AND o.is_current = 1
         WHERE f.category = 'document';`
      )
      .iterate() as IterableIterator<DocumentCoverageQueryRow>

    for (const row of docRows) {
      accumulateDocumentCoverageRow(counts, row, spec, nativeRecipe)
    }

    const photoOcrRows = db
      .prepare(
        `SELECT
           d.id AS discovery_observation_id,
           d.byte_size,
           d.filesystem_mtime_ms,
           h.sha256 AS active_hash,
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
         FROM document_ocr_extractions o
         JOIN file_locations f ON f.id = o.file_location_id AND f.category = 'photo'
         JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1
         LEFT JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1
         WHERE o.is_current = 1;`
      )
      .iterate() as IterableIterator<PhotoOcrCoverageQueryRow>

    for (const pRow of photoOcrRows) {
      accumulatePhotoCoverageRow(counts, pRow, spec)
    }

    return counts
  }

  public async getDocumentOcrCoverageAsync(
    options?: Partial<OcrCompatibilitySpec> & {
      readonly nativeRecipeVersion?: string
      readonly chunkSize?: number
      readonly shouldAbort?: () => boolean
    }
  ): Promise<DocumentOcrCoverage | null> {
    const spec = this.resolveCompatibilitySpec(options)
    const nativeRecipe = options?.nativeRecipeVersion ?? DOCUMENT_EXTRACTION_RECIPE_VERSION
    const chunkSize = Math.max(50, Math.min(5000, Math.floor(options?.chunkSize ?? 1000)))
    const counts = createMutableOcrCoverage()

    const docSql = `SELECT
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
         JOIN discovery_observations d
           ON d.file_location_id = f.id AND d.is_current = 1
         LEFT JOIN hash_observations h
           ON h.discovery_observation_id = d.id AND h.is_active = 1
         LEFT JOIN document_extractions e
           ON e.file_location_id = f.id AND e.is_current = 1
         LEFT JOIN document_ocr_extractions o
           ON o.file_location_id = f.id AND o.is_current = 1
         WHERE f.category = 'document' AND f.id > ?
         ORDER BY f.id ASC
         LIMIT ?;`

    let lastFileLocationId = 0
    while (true) {
      if (options?.shouldAbort?.()) {
        return null
      }
      const db = this.deps.getDb()
      const chunk = db
        .prepare(docSql)
        .all(lastFileLocationId, chunkSize) as unknown as (DocumentCoverageQueryRow & {
        file_location_id: number
      })[]
      if (chunk.length === 0) {
        break
      }
      for (const row of chunk) {
        accumulateDocumentCoverageRow(counts, row, spec, nativeRecipe)
        lastFileLocationId = row.file_location_id
      }
      if (chunk.length < chunkSize) {
        break
      }
      await new Promise<void>((resolveTick) => setImmediate(resolveTick))
    }

    const photoSql = `SELECT
           o.id AS ocr_row_id,
           d.id AS discovery_observation_id,
           d.byte_size,
           d.filesystem_mtime_ms,
           h.sha256 AS active_hash,
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
         FROM document_ocr_extractions o
         JOIN file_locations f ON f.id = o.file_location_id AND f.category = 'photo'
         JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1
         LEFT JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1
         WHERE o.is_current = 1 AND o.id > ?
         ORDER BY o.id ASC
         LIMIT ?;`

    let lastOcrRowId = 0
    while (true) {
      if (options?.shouldAbort?.()) {
        return null
      }
      const db = this.deps.getDb()
      const chunk = db
        .prepare(photoSql)
        .all(lastOcrRowId, chunkSize) as unknown as (PhotoOcrCoverageQueryRow & {
        ocr_row_id: number
      })[]
      if (chunk.length === 0) {
        break
      }
      for (const pRow of chunk) {
        accumulatePhotoCoverageRow(counts, pRow, spec)
        lastOcrRowId = pRow.ocr_row_id
      }
      if (chunk.length < chunkSize) {
        break
      }
      await new Promise<void>((resolveTick) => setImmediate(resolveTick))
    }

    return counts
  }

  public getDocumentOcrCoverageContribution(
    fileLocationId: number,
    options?: Partial<OcrCompatibilitySpec> & { readonly nativeRecipeVersion?: string }
  ): DocumentOcrCoverage | null {
    const db = this.deps.getDb()
    const spec = this.resolveCompatibilitySpec(options)
    const nativeRecipe = options?.nativeRecipeVersion ?? DOCUMENT_EXTRACTION_RECIPE_VERSION

    const row = db
      .prepare(
        `SELECT
           f.category,
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
         JOIN discovery_observations d
           ON d.file_location_id = f.id AND d.is_current = 1
         LEFT JOIN hash_observations h
           ON h.discovery_observation_id = d.id AND h.is_active = 1
         LEFT JOIN document_extractions e
           ON e.file_location_id = f.id AND e.is_current = 1
         LEFT JOIN document_ocr_extractions o
           ON o.file_location_id = f.id AND o.is_current = 1
         WHERE f.id = ? AND f.category IN ('document', 'photo')
         LIMIT 1;`
      )
      .get(fileLocationId) as unknown as
      (DocumentCoverageQueryRow & { category: 'document' | 'photo' }) | undefined

    if (!row) {
      return null
    }
    const counts = createMutableOcrCoverage()
    if (row.category === 'document') {
      accumulateDocumentCoverageRow(counts, row, spec, nativeRecipe)
    } else if (row.ocr_id !== null) {
      accumulatePhotoCoverageRow(counts, row, spec)
    }
    return counts
  }

  public async createDocumentOcrJob(input: {
    jobId: string
    scopeKind: DocumentOcrJobScopeKind
    recipeVersion: string
    ocrModelId: string
    ocrModelManifestSha256: string
    ocrLanguage: string
    fileLocationIds?: readonly number[]
    extensionFilter?: string | null
    filenameQuery?: string
    retryFailed?: boolean
    forceReocr?: boolean
    shouldCancel?: () => boolean
    batchSize?: number
    onBatchInserted?: (batchIndex: number, totalSnapshotted: number) => void | Promise<void>
    awaitWorkerAdmission?: () => Promise<WorkerBudgetReservation>
    snapshotWorkerHooks?: {
      readonly onSpawn?: (worker: Worker, reservation?: WorkerBudgetReservation) => void
      readonly onSpawnFailure?: (reservation: WorkerBudgetReservation) => void
      readonly onTerminating?: (worker: Worker) => void
      readonly onExit?: (worker: Worker) => void
    }
  }): Promise<DocumentOcrJobRecord> {
    const db = this.deps.getDb()
    const now = Date.now()
    const batchSize = Math.max(1, Math.min(500, Math.floor(input.batchSize ?? 250)))
    const catalogPath = this.deps.getCatalogPath?.() ?? ':memory:'
    const stagingFilePath =
      catalogPath !== ':memory:' ? `${catalogPath}.ocr-snapshot-${input.jobId}.tmp` : null

    db.exec('BEGIN IMMEDIATE;')
    try {
      db.prepare(
        `INSERT INTO document_ocr_jobs (
           id, scope_kind, status, recipe_version,
           ocr_model_id, ocr_model_manifest_sha256, ocr_language,
           force_reocr, snapshot_complete,
           total_items, processed_items, extracted_items,
           no_text_items, password_protected_items, unsupported_items,
           failed_items, truncated_items, reused_items, skipped_stale_items,
           started_at_ms, updated_at_ms, completed_at_ms, last_error
         ) VALUES (?, ?, 'running', ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ?, ?, NULL, NULL);`
      ).run(
        input.jobId,
        input.scopeKind,
        input.recipeVersion,
        input.ocrModelId,
        input.ocrModelManifestSha256,
        input.ocrLanguage,
        input.forceReocr ? 1 : 0,
        now,
        now
      )
      db.exec('COMMIT;')
    } catch (error) {
      try {
        db.exec('ROLLBACK;')
      } catch {
        // ignore rollback error
      }
      throw error
    }

    const cleanupPartialJobOnError = (): void => {
      try {
        const currentDb = this.deps.getDb()
        currentDb.exec('BEGIN IMMEDIATE;')
        try {
          currentDb.prepare('DELETE FROM document_ocr_jobs WHERE id = ?;').run(input.jobId)
          currentDb.exec('COMMIT;')
        } catch {
          try {
            currentDb.exec('ROLLBACK;')
          } catch {
            // ignore rollback error
          }
        }
      } catch {
        // catalog closed
      }
    }

    const cancelPartialJob = (): DocumentOcrJobRecord => {
      const cancelNow = Date.now()
      const currentDb = this.deps.getDb()
      currentDb.exec('BEGIN IMMEDIATE;')
      try {
        currentDb.prepare('DELETE FROM document_ocr_job_items WHERE job_id = ?;').run(input.jobId)
        currentDb
          .prepare(
            `UPDATE document_ocr_jobs
             SET total_items = 0,
                 snapshot_complete = 1,
                 status = 'cancelled',
                 updated_at_ms = ?,
                 completed_at_ms = ?
             WHERE id = ?;`
          )
          .run(cancelNow, cancelNow, input.jobId)
        currentDb.exec('COMMIT;')
      } catch (err) {
        try {
          currentDb.exec('ROLLBACK;')
        } catch {
          // ignore rollback error
        }
        throw err
      }
      const cancelled = this.getDocumentOcrJob(input.jobId)
      if (!cancelled) {
        throw new Error(`Failed to read cancelled document OCR job ${input.jobId}`)
      }
      return cancelled
    }

    const yieldToEventLoop = (): Promise<void> =>
      new Promise<void>((resolveYield) => {
        setImmediate(resolveYield)
      })

    const snapshotInput: OcrSnapshotJobInput = {
      scopeKind: input.scopeKind,
      recipeVersion: input.recipeVersion,
      ocrModelId: input.ocrModelId,
      ocrModelManifestSha256: input.ocrModelManifestSha256,
      ocrLanguage: input.ocrLanguage,
      fileLocationIds: input.fileLocationIds,
      extensionFilter: input.extensionFilter,
      filenameQuery: input.filenameQuery,
      retryFailed: input.retryFailed,
      forceReocr: input.forceReocr
    }

    let totalSnapshotted = 0

    try {
      if (stagingFilePath === null) {
        db.exec('BEGIN IMMEDIATE;')
        try {
          totalSnapshotted = this.insertSnapshotSynchronouslyInTx(
            db,
            input.jobId,
            snapshotInput,
            now
          )
          db.prepare(
            `UPDATE document_ocr_jobs
             SET total_items = ?,
                 snapshot_complete = 1,
                 status = ?,
                 updated_at_ms = ?,
                 completed_at_ms = ?
             WHERE id = ?;`
          ).run(
            totalSnapshotted,
            totalSnapshotted === 0 ? 'completed' : 'running',
            now,
            totalSnapshotted === 0 ? now : null,
            input.jobId
          )
          db.exec('COMMIT;')
        } catch (err) {
          try {
            db.exec('ROLLBACK;')
          } catch {
            // ignore rollback error
          }
          throw err
        }
      } else {
        if (input.shouldCancel?.()) {
          return cancelPartialJob()
        }

        const reservation = input.awaitWorkerAdmission
          ? await input.awaitWorkerAdmission()
          : undefined
        if (input.shouldCancel?.()) {
          if (reservation) {
            input.snapshotWorkerHooks?.onSpawnFailure?.(reservation)
          }
          return cancelPartialJob()
        }

        const workerResult = await this.runSnapshotWorker(
          catalogPath,
          stagingFilePath,
          snapshotInput,
          input.shouldCancel,
          input.snapshotWorkerHooks,
          reservation
        )
        if (workerResult.cancelled || input.shouldCancel?.()) {
          return cancelPartialJob()
        }

        const insertItem = db.prepare(
          `INSERT INTO document_ocr_job_items (
             job_id, file_location_id, discovery_observation_id, content_revision,
             status, error_message, updated_at_ms
           ) VALUES (?, ?, ?, ?, 'pending', NULL, ?);`
        )

        const insertBatch = (chunk: readonly SnapshotItem[], batchNow: number): void => {
          db.exec('BEGIN IMMEDIATE;')
          try {
            for (const item of chunk) {
              insertItem.run(input.jobId, item.f, item.d, item.r, batchNow)
              totalSnapshotted++
            }
            db.exec('COMMIT;')
          } catch (err) {
            try {
              db.exec('ROLLBACK;')
            } catch {
              // ignore rollback error
            }
            throw err
          }
        }

        let chunk: SnapshotItem[] = []
        let batchIndex = 0
        const stream = createReadStream(stagingFilePath, { encoding: 'utf8' })
        const rl = createInterface({ input: stream, crlfDelay: Infinity })
        try {
          for await (const line of rl) {
            if (input.shouldCancel?.()) {
              rl.close()
              stream.destroy()
              return cancelPartialJob()
            }
            if (!line) continue
            chunk.push(JSON.parse(line) as SnapshotItem)
            if (chunk.length >= batchSize) {
              insertBatch(chunk, Date.now())
              batchIndex++
              chunk = []
              await input.onBatchInserted?.(batchIndex, totalSnapshotted)
              if (input.shouldCancel?.()) {
                rl.close()
                stream.destroy()
                return cancelPartialJob()
              }
              await yieldToEventLoop()
            }
          }
        } finally {
          rl.close()
          stream.destroy()
        }

        if (input.shouldCancel?.()) {
          return cancelPartialJob()
        }

        if (chunk.length > 0) {
          insertBatch(chunk, Date.now())
          batchIndex++
          await input.onBatchInserted?.(batchIndex, totalSnapshotted)
        }

        if (input.shouldCancel?.()) {
          return cancelPartialJob()
        }

        const doneNow = Date.now()
        db.exec('BEGIN IMMEDIATE;')
        try {
          db.prepare(
            `UPDATE document_ocr_jobs
             SET total_items = ?,
                 snapshot_complete = 1,
                 status = ?,
                 updated_at_ms = ?,
                 completed_at_ms = ?
             WHERE id = ?;`
          ).run(
            totalSnapshotted,
            totalSnapshotted === 0 ? 'completed' : 'running',
            doneNow,
            totalSnapshotted === 0 ? doneNow : null,
            input.jobId
          )
          db.exec('COMMIT;')
        } catch (err) {
          try {
            db.exec('ROLLBACK;')
          } catch {
            // ignore rollback error
          }
          throw err
        }
      }
    } catch (error) {
      cleanupPartialJobOnError()
      throw error
    } finally {
      if (stagingFilePath) {
        try {
          rmSync(stagingFilePath, { force: true })
        } catch {
          // ignore temp cleanup error
        }
      }
    }

    const created = this.getDocumentOcrJob(input.jobId)
    if (!created) {
      throw new Error(`Failed to read created document OCR job ${input.jobId}`)
    }
    return created
  }

  private insertSnapshotSynchronouslyInTx(
    db: DatabaseSync,
    jobId: string,
    input: OcrSnapshotJobInput,
    now: number
  ): number {
    const insertItem = db.prepare(
      `INSERT INTO document_ocr_job_items (
         job_id, file_location_id, discovery_observation_id, content_revision,
         status, error_message, updated_at_ms
       ) VALUES (?, ?, ?, ?, 'pending', NULL, ?);`
    )
    const compatSpec: OcrCompatibilitySpec = {
      recipeVersion: input.recipeVersion,
      ocrModelId: input.ocrModelId,
      ocrModelManifestSha256: input.ocrModelManifestSha256,
      ocrLanguage: input.ocrLanguage
    }
    const nativeRecipe = input.nativeRecipeVersion ?? DOCUMENT_EXTRACTION_RECIPE_VERSION
    let count = 0

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
         WHERE f.id = ? AND f.category IN ('document', 'photo')
         LIMIT 1;`
      )
      const seen = new Set<number>()
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
          insertItem.run(jobId, row.file_location_id, row.discovery_observation_id, rev, now)
          count++
        }
      }
      return count
    }

    const { whereClause, params } = buildDocumentFilterSql({
      extensionFilter: input.scopeKind === 'filtered' ? input.extensionFilter : null,
      filenameQuery: input.scopeKind === 'filtered' ? input.filenameQuery : undefined
    })
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
       LIMIT 500;`
    )

    let lastFileId = 0
    while (true) {
      const batchRows = selectBatch.all(...params, lastFileId) as Array<{
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
      if (batchRows.length === 0) break
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
        insertItem.run(jobId, row.file_location_id, row.discovery_observation_id, rev, now)
        count++
      }
      if (batchRows.length < 500) break
    }
    return count
  }

  private runSnapshotWorker(
    catalogPath: string,
    stagingFilePath: string,
    input: OcrSnapshotJobInput,
    shouldCancel?: () => boolean,
    hooks?: {
      readonly onSpawn?: (worker: Worker, reservation?: WorkerBudgetReservation) => void
      readonly onSpawnFailure?: (reservation: WorkerBudgetReservation) => void
      readonly onTerminating?: (worker: Worker) => void
      readonly onExit?: (worker: Worker) => void
    },
    reservation?: WorkerBudgetReservation
  ): Promise<{ cancelled: boolean; count: number }> {
    return new Promise((resolvePromise, rejectPromise) => {
      let settled = false
      let cancelled = false
      let pendingMessage: { ok: boolean; count?: number; errorMessage?: string } | null = null
      let pendingError: unknown = null
      let worker: Worker
      let promoted = false

      try {
        if (shouldCancel?.()) {
          if (reservation) {
            hooks?.onSpawnFailure?.(reservation)
          }
          resolvePromise({ cancelled: true, count: 0 })
          return
        }
        const scriptPath = resolveMainWorkerScriptPath({
          workerFileName: 'document_snapshot_worker.js',
          sourceEntryPath: resolve(__dirname, '../documents/snapshot-worker.ts'),
          moduleDir: __dirname,
          esbuildExternals: ['electron']
        })
        if (shouldCancel?.()) {
          if (reservation) {
            hooks?.onSpawnFailure?.(reservation)
          }
          resolvePromise({ cancelled: true, count: 0 })
          return
        }
        worker = new Worker(scriptPath, {
          workerData: { kind: 'ocr', catalogPath, stagingFilePath, input }
        })
        hooks?.onSpawn?.(worker, reservation)
        promoted = true
      } catch (err) {
        if (!promoted && reservation) {
          hooks?.onSpawnFailure?.(reservation)
        }
        rejectPromise(err)
        return
      }

      let cancelPoll: NodeJS.Timeout | null = null
      if (shouldCancel) {
        cancelPoll = setInterval(() => {
          if (!settled && shouldCancel()) {
            cancelled = true
            if (cancelPoll) {
              clearInterval(cancelPoll)
              cancelPoll = null
            }
            hooks?.onTerminating?.(worker)
            void worker.terminate()
          }
        }, 25)
      }

      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        if (cancelPoll) clearInterval(cancelPoll)
        fn()
      }

      worker.on('message', (msg: { ok: boolean; count?: number; errorMessage?: string }) => {
        pendingMessage = msg
      })
      worker.on('error', (err) => {
        hooks?.onTerminating?.(worker)
        pendingError = err
      })
      worker.on('exit', (code) => {
        hooks?.onExit?.(worker)
        if (cancelled) {
          finish(() => resolvePromise({ cancelled: true, count: 0 }))
          return
        }
        if (pendingError !== null) {
          finish(() => rejectPromise(pendingError))
          return
        }
        if (pendingMessage !== null) {
          if (pendingMessage.ok) {
            finish(() => resolvePromise({ cancelled: false, count: pendingMessage!.count ?? 0 }))
          } else {
            finish(() =>
              rejectPromise(
                new Error(pendingMessage!.errorMessage ?? 'Document OCR snapshot worker failed')
              )
            )
          }
          return
        }
        finish(() =>
          rejectPromise(new Error(`Document OCR snapshot worker exited unexpectedly (${code})`))
        )
      })
    })
  }

  public getDocumentOcrJob(jobId: string): DocumentOcrJobRecord | null {
    const db = this.deps.getDb()
    const row = db
      .prepare(
        `SELECT j.*,
                (SELECT COUNT(*) FROM document_ocr_job_items i WHERE i.job_id = j.id AND i.status = 'pending') AS pending_items
         FROM document_ocr_jobs j
         WHERE j.id = ?
         LIMIT 1;`
      )
      .get(jobId) as unknown as RawOcrJobRow | undefined

    return row ? mapOcrJobRow(row) : null
  }

  public getLatestDocumentOcrJob(): DocumentOcrJobRecord | null {
    const db = this.deps.getDb()
    const row = db
      .prepare(
        `SELECT j.*,
                (SELECT COUNT(*) FROM document_ocr_job_items i WHERE i.job_id = j.id AND i.status = 'pending') AS pending_items
         FROM document_ocr_jobs j
         WHERE j.snapshot_complete = 1
         ORDER BY j.started_at_ms DESC, j.rowid DESC
         LIMIT 1;`
      )
      .get() as unknown as RawOcrJobRow | undefined

    return row ? mapOcrJobRow(row) : null
  }

  public markRunningDocumentOcrJobsAsInterrupted(): number {
    const db = this.deps.getDb()
    const now = Date.now()
    const catalogPath = this.deps.getCatalogPath?.() ?? ':memory:'

    if (catalogPath !== ':memory:') {
      try {
        const dir = dirname(catalogPath)
        const prefix = `${basename(catalogPath)}.ocr-snapshot-`
        for (const entry of readdirSync(dir)) {
          if (entry.startsWith(prefix) && entry.endsWith('.tmp')) {
            rmSync(join(dir, entry), { force: true })
          }
        }
      } catch {
        // ignore temp cleanup error
      }
    }

    db.exec('BEGIN IMMEDIATE;')
    try {
      db.prepare('DELETE FROM document_ocr_jobs WHERE snapshot_complete = 0;').run()
      const res = db
        .prepare(
          `UPDATE document_ocr_jobs
           SET status = 'interrupted', updated_at_ms = ?
           WHERE snapshot_complete = 1 AND status IN ('running', 'paused');`
        )
        .run(now)
      db.exec('COMMIT;')
      return Number(res.changes)
    } catch (err) {
      try {
        db.exec('ROLLBACK;')
      } catch {
        // ignore rollback error
      }
      throw err
    }
  }

  public getNextPendingDocumentOcrJobItems(
    jobId: string,
    limit: number
  ): DocumentOcrJobItemRecord[] {
    const db = this.deps.getDb()
    const rows = db
      .prepare(
        `SELECT job_id, file_location_id, discovery_observation_id, content_revision, status, error_message, updated_at_ms
         FROM document_ocr_job_items
         WHERE job_id = ? AND status = 'pending'
         ORDER BY file_location_id ASC
         LIMIT ?;`
      )
      .all(jobId, limit) as unknown as Array<{
      job_id: string
      file_location_id: number
      discovery_observation_id: number
      content_revision: string
      status: DocumentOcrJobItemStatus
      error_message: string | null
      updated_at_ms: number
    }>

    return rows.map((r) => ({
      jobId: r.job_id,
      fileLocationId: r.file_location_id,
      discoveryObservationId: r.discovery_observation_id,
      contentRevision: r.content_revision,
      status: r.status,
      errorMessage: r.error_message,
      updatedAtMs: r.updated_at_ms
    }))
  }

  public recordDocumentOcrJobItemResult(input: {
    jobId: string
    fileLocationId: number
    status: Exclude<DocumentOcrJobItemStatus, 'pending'>
    errorMessage?: string | null
  }): void {
    const db = this.deps.getDb()
    const now = Date.now()

    db.exec('BEGIN IMMEDIATE;')
    try {
      const updateItem = db
        .prepare(
          `UPDATE document_ocr_job_items
           SET status = ?, error_message = ?, updated_at_ms = ?
           WHERE job_id = ? AND file_location_id = ? AND status = 'pending';`
        )
        .run(input.status, input.errorMessage ?? null, now, input.jobId, input.fileLocationId)

      if (Number(updateItem.changes) > 0) {
        const incExtracted = input.status === 'extracted' ? 1 : 0
        const incNoText = input.status === 'ocr_no_text' ? 1 : 0
        const incPassword = input.status === 'password_protected' ? 1 : 0
        const incUnsupported = input.status === 'unsupported' ? 1 : 0
        const incFailed = input.status === 'corrupt_or_failed' ? 1 : 0
        const incTruncated = input.status === 'truncated' ? 1 : 0
        const incReused = input.status === 'reused' ? 1 : 0
        const incSkippedStale = input.status === 'skipped_stale' ? 1 : 0

        db.prepare(
          `UPDATE document_ocr_jobs
           SET
             processed_items = processed_items + 1,
             extracted_items = extracted_items + ?,
             no_text_items = no_text_items + ?,
             password_protected_items = password_protected_items + ?,
             unsupported_items = unsupported_items + ?,
             failed_items = failed_items + ?,
             truncated_items = truncated_items + ?,
             reused_items = reused_items + ?,
             skipped_stale_items = skipped_stale_items + ?,
             updated_at_ms = ?,
             last_error = COALESCE(?, last_error)
           WHERE id = ?;`
        ).run(
          incExtracted,
          incNoText,
          incPassword,
          incUnsupported,
          incFailed,
          incTruncated,
          incReused,
          incSkippedStale,
          now,
          input.status === 'corrupt_or_failed' ? (input.errorMessage ?? 'OCR failed') : null,
          input.jobId
        )
      }

      db.exec('COMMIT;')
    } catch (error) {
      try {
        db.exec('ROLLBACK;')
      } catch {
        // ignore rollback error
      }
      throw error
    }
  }

  public updateDocumentOcrJobStatus(
    jobId: string,
    status: DocumentOcrJobStatus,
    lastError?: string | null
  ): void {
    const db = this.deps.getDb()
    const now = Date.now()
    const isTerminal = status === 'completed' || status === 'cancelled' || status === 'failed'
    db.prepare(
      `UPDATE document_ocr_jobs
       SET
         status = ?,
         updated_at_ms = ?,
         completed_at_ms = CASE WHEN ? THEN COALESCE(completed_at_ms, ?) ELSE NULL END,
         last_error = COALESCE(?, last_error)
       WHERE id = ?;`
    ).run(status, now, isTerminal ? 1 : 0, now, lastError ?? null, jobId)
  }
}

interface RawOcrJobRow {
  id: string
  scope_kind: DocumentOcrJobScopeKind
  status: DocumentOcrJobStatus
  recipe_version: string
  ocr_model_id: string
  ocr_model_manifest_sha256: string
  ocr_language: string
  force_reocr: number
  snapshot_complete: number
  total_items: number
  processed_items: number
  extracted_items: number
  no_text_items: number
  password_protected_items: number
  unsupported_items: number
  failed_items: number
  truncated_items: number
  reused_items: number
  skipped_stale_items: number
  pending_items: number
  started_at_ms: number
  updated_at_ms: number
  completed_at_ms: number | null
  last_error: string | null
}

function mapOcrJobRow(row: RawOcrJobRow): DocumentOcrJobRecord {
  return {
    id: row.id,
    scopeKind: row.scope_kind,
    status: row.status,
    recipeVersion: row.recipe_version,
    ocrModelId: row.ocr_model_id,
    ocrModelManifestSha256: row.ocr_model_manifest_sha256,
    ocrLanguage: row.ocr_language,
    forceReocr: row.force_reocr === 1,
    snapshotComplete: row.snapshot_complete === 1,
    totalItems: row.total_items,
    processedItems: row.processed_items,
    extractedItems: row.extracted_items,
    noTextItems: row.no_text_items,
    passwordProtectedItems: row.password_protected_items,
    unsupportedItems: row.unsupported_items,
    failedItems: row.failed_items,
    truncatedItems: row.truncated_items,
    reusedItems: row.reused_items,
    skippedStaleItems: row.skipped_stale_items,
    pendingItems: row.pending_items,
    startedAtMs: row.started_at_ms,
    updatedAtMs: row.updated_at_ms,
    completedAtMs: row.completed_at_ms,
    lastError: row.last_error
  }
}

export const EMPTY_DOCUMENT_OCR_COVERAGE: DocumentOcrCoverage = {
  totalDocuments: 0,
  ocrNeededDocuments: 0,
  notProcessedDocuments: 0,
  extractedDocuments: 0,
  noTextDocuments: 0,
  passwordProtectedDocuments: 0,
  unsupportedDocuments: 0,
  failedDocuments: 0,
  truncatedDocuments: 0,
  staleDocuments: 0,
  selectedImageOcrCount: 0
}

interface MutableDocumentOcrCoverage {
  totalDocuments: number
  ocrNeededDocuments: number
  notProcessedDocuments: number
  extractedDocuments: number
  noTextDocuments: number
  passwordProtectedDocuments: number
  unsupportedDocuments: number
  failedDocuments: number
  truncatedDocuments: number
  staleDocuments: number
  selectedImageOcrCount: number
}

interface DocumentCoverageQueryRow {
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
}

interface PhotoOcrCoverageQueryRow {
  discovery_observation_id: number
  byte_size: number
  filesystem_mtime_ms: number | null
  active_hash: string | null
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
}

function createMutableOcrCoverage(): MutableDocumentOcrCoverage {
  return { ...EMPTY_DOCUMENT_OCR_COVERAGE }
}

function accumulateDocumentCoverageRow(
  counts: MutableDocumentOcrCoverage,
  row: DocumentCoverageQueryRow,
  spec: OcrCompatibilitySpec,
  nativeRecipe: string
): void {
  counts.totalDocuments++
  const compatibleOcr = row.ocr_id !== null && isOcrExtractionRowCompatible(row, spec)
  if (!compatibleOcr && doesDocumentRowRequireOcr(row, nativeRecipe)) {
    counts.ocrNeededDocuments++
  }

  if (row.ocr_id === null || row.ocr_status === null) {
    counts.notProcessedDocuments++
    return
  }
  if (!compatibleOcr) {
    counts.staleDocuments++
    return
  }
  switch (row.ocr_status) {
    case 'extracted':
      counts.extractedDocuments++
      break
    case 'ocr_no_text':
      counts.noTextDocuments++
      break
    case 'password_protected':
      counts.passwordProtectedDocuments++
      break
    case 'unsupported':
      counts.unsupportedDocuments++
      break
    case 'corrupt_or_failed':
      counts.failedDocuments++
      break
    case 'truncated':
      counts.truncatedDocuments++
      break
  }
}

function accumulatePhotoCoverageRow(
  counts: MutableDocumentOcrCoverage,
  pRow: PhotoOcrCoverageQueryRow,
  spec: OcrCompatibilitySpec
): void {
  if (
    pRow.ocr_id !== null &&
    pRow.ocr_status === 'extracted' &&
    isOcrExtractionRowCompatible(pRow, spec)
  ) {
    counts.selectedImageOcrCount++
  }
}
