/**
 * Personal Vault — Document Catalog Repository (Stages 7A & 7B)
 *
 * Provides read-only paginated queries, filename/extension filtering,
 * paginated extension facets, recorded-fact provenance details, and
 * revision-bound document text extraction persistence for cataloged
 * documents (`category = 'document'`) without owning SQLite connection
 * lifecycle or transactions.
 */

import { createReadStream, readdirSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import type {
  DocumentDetailItem,
  DocumentExtractionStatus,
  DocumentPreviewPayload,
  DocumentPreviewStatus,
  DocumentSummaryItem,
  GetDocumentExtensionFacetsRequest,
  GetDocumentExtensionFacetsResponse,
  GetDocumentsPageRequest,
  GetDocumentsPageResponse
} from '../../../shared/validation/document-schemas'
import { isObservationTimestampMatching } from '../semantic/vector'
import { resolveMainWorkerScriptPath } from '../worker-path'
import type { WorkerBudgetReservation } from '../worker-budget'
import {
  DOCUMENT_EXTRACTION_LIMITS,
  DOCUMENT_EXTRACTION_RECIPE_VERSION,
  type DocumentExtractionCoverage,
  type PersistedDocumentExtractionStatus
} from '../documents/types'
import {
  buildClassificationFilterSql,
  EFFECTIVE_CLASSIFICATION_JOIN_SQL,
  EFFECTIVE_CLUTTER_SQL_EXPR
} from './document-classification-snapshot-query'
import { DocumentClassificationRepository } from './document-classification-repository'
import {
  buildDocumentContentRevision,
  buildDocumentFilterSql,
  isExtractionRowCompatible,
  type SnapshotItem,
  type SnapshotJobInput
} from './document-snapshot-query'

export { buildDocumentContentRevision }

export interface DocumentRepositoryDeps {
  readonly getDb: () => DatabaseSync
  readonly getCatalogPath?: () => string
  readonly onOcrRelevantMutation?: () => void
}

export interface DocumentExtractionCandidate {
  readonly fileLocationId: number
  readonly sourceId: number
  readonly sourceRootPath: string
  readonly originalPath: string
  readonly fileName: string
  readonly extension: string
  readonly discoveryObservationId: number
  readonly byteSize: number
  readonly filesystemMtimeMs: number | null
  readonly activeHash: string | null
  readonly contentRevision: string
}

export interface DocumentExtractionJobRecord {
  readonly id: string
  readonly scopeKind: 'selected' | 'filtered' | 'all'
  readonly status: 'running' | 'paused' | 'cancelled' | 'interrupted' | 'completed' | 'failed'
  readonly recipeVersion: string
  readonly forceReextract: boolean
  readonly snapshotComplete: boolean
  readonly totalDocuments: number
  readonly processedDocuments: number
  readonly extractedDocuments: number
  readonly noTextDocuments: number
  readonly passwordProtectedDocuments: number
  readonly unsupportedDocuments: number
  readonly failedDocuments: number
  readonly truncatedDocuments: number
  readonly reusedDocuments: number
  readonly pendingDocuments: number
  readonly startedAtMs: number
  readonly updatedAtMs: number
  readonly completedAtMs: number | null
  readonly lastError: string | null
}

export interface DocumentExtractionJobItemRecord {
  readonly jobId: string
  readonly fileLocationId: number
  readonly discoveryObservationId: number
  readonly contentRevision: string
  readonly status: 'pending' | PersistedDocumentExtractionStatus | 'reused' | 'skipped_stale'
  readonly errorMessage: string | null
  readonly updatedAtMs: number
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
  ext_id: number | null
  ext_discovery_observation_id: number | null
  ext_content_sha256: string | null
  ext_observed_byte_size: number | null
  ext_observed_mtime_ms: number | null
  ext_content_revision: string | null
  ext_recipe_version: string | null
  ext_status: PersistedDocumentExtractionStatus | null
  ext_status_detail: string | null
  ext_char_count: number | null
  ext_page_count: number | null
  ext_truncated: number | null
  ext_truncation_reason: string | null
  ext_detected_encoding: string | null
  ext_extracted_at_ms: number | null
}

interface RawDocumentDetailRow extends RawDocumentRow {
  source_root_path: string
  normalized_path: string
}

interface RawDocumentPreviewRow extends RawDocumentRow {
  ext_text: string | null
}

function validateOffsetLimit(offset: number, limit: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new RangeError(`offset must be a non-negative safe integer, got ${String(offset)}`)
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError(`limit must be an integer between 1 and 100, got ${String(limit)}`)
  }
}

function mapPreviewStatus(extractionStatus: DocumentExtractionStatus): DocumentPreviewStatus {
  if (extractionStatus === 'extracted') return 'ready'
  if (extractionStatus === 'processing') return 'not_extracted'
  return extractionStatus
}

export class DocumentRepository {
  private readonly deps: DocumentRepositoryDeps
  private classificationRepo: DocumentClassificationRepository | null = null

  public constructor(deps: DocumentRepositoryDeps) {
    this.deps = deps
  }

  private getClassificationRepo(): DocumentClassificationRepository {
    if (!this.classificationRepo) {
      this.classificationRepo = new DocumentClassificationRepository({
        getDb: this.deps.getDb,
        getCatalogPath: this.deps.getCatalogPath ?? (() => ':memory:')
      })
    }
    return this.classificationRepo
  }

  public getDocumentsPage(
    input: GetDocumentsPageRequest,
    options?: {
      processingFileLocationIds?: ReadonlySet<number>
      recipeVersion?: string
    }
  ): GetDocumentsPageResponse {
    const db = this.deps.getDb()
    validateOffsetLimit(input.offset, input.limit)
    const recipeVersion = options?.recipeVersion ?? DOCUMENT_EXTRACTION_RECIPE_VERSION

    const { whereClause: baseWhere, params: baseParams } = buildDocumentFilterSql(input)
    const clsFilter = buildClassificationFilterSql({
      purposeFilter: input.purposeFilter,
      originFilter: input.originFilter,
      clutterFilter: input.clutterFilter
    })
    const nonClutterClsFilter = buildClassificationFilterSql({
      purposeFilter: input.purposeFilter,
      originFilter: input.originFilter
    })

    const combinedWhere =
      clsFilter.clauses.length > 0
        ? `${baseWhere} AND ${clsFilter.clauses.join(' AND ')}`
        : baseWhere
    const combinedParams = [...baseParams, ...clsFilter.params]

    const hiddenWhere =
      nonClutterClsFilter.clauses.length > 0
        ? `${baseWhere} AND ${nonClutterClsFilter.clauses.join(' AND ')} AND (${EFFECTIVE_CLUTTER_SQL_EXPR}) = 1`
        : `${baseWhere} AND (${EFFECTIVE_CLUTTER_SQL_EXPR}) = 1`
    const hiddenParams = [...baseParams, ...nonClutterClsFilter.params]

    const countRow = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM file_locations f
         JOIN discovery_observations d
           ON d.file_location_id = f.id AND d.is_current = 1
         ${EFFECTIVE_CLASSIFICATION_JOIN_SQL}
         ${combinedWhere};`
      )
      .get(...combinedParams) as unknown as { count: number }

    const hiddenCountRow = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM file_locations f
         JOIN discovery_observations d
           ON d.file_location_id = f.id AND d.is_current = 1
         ${EFFECTIVE_CLASSIFICATION_JOIN_SQL}
         ${hiddenWhere};`
      )
      .get(...hiddenParams) as unknown as { count: number }

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
           h.hashed_at_ms AS active_hash_verified_at_ms,
           e.id AS ext_id,
           e.discovery_observation_id AS ext_discovery_observation_id,
           e.content_sha256 AS ext_content_sha256,
           e.observed_byte_size AS ext_observed_byte_size,
           e.observed_mtime_ms AS ext_observed_mtime_ms,
           e.content_revision AS ext_content_revision,
           e.recipe_version AS ext_recipe_version,
           e.extraction_status AS ext_status,
           e.status_detail AS ext_status_detail,
           e.extracted_char_count AS ext_char_count,
           e.page_count AS ext_page_count,
           e.truncated AS ext_truncated,
           e.truncation_reason AS ext_truncation_reason,
           e.detected_encoding AS ext_detected_encoding,
           e.extracted_at_ms AS ext_extracted_at_ms
         FROM file_locations f
         JOIN discovery_observations d
           ON d.file_location_id = f.id AND d.is_current = 1
         LEFT JOIN hash_observations h
           ON h.discovery_observation_id = d.id AND h.is_active = 1
         LEFT JOIN document_extractions e
           ON e.file_location_id = f.id AND e.is_current = 1
         ${EFFECTIVE_CLASSIFICATION_JOIN_SQL}
         ${combinedWhere}
         ORDER BY f.id ASC
         LIMIT ? OFFSET ?;`
      )
      .all(...combinedParams, input.limit, input.offset) as unknown as RawDocumentRow[]

    const clsRepo = this.getClassificationRepo()
    return {
      items: rows.map((row) => {
        const summary = this.mapSummaryRow(row, options?.processingFileLocationIds, recipeVersion)
        const eff = clsRepo.getEffectiveDocumentClassification(row.file_location_id)
        return eff
          ? { ...summary, classification: clsRepo.toEffectiveClassificationSummary(eff, false) }
          : summary
      }),
      totalCount: countRow.count,
      offset: input.offset,
      limit: input.limit,
      hiddenClutterCount: Number(hiddenCountRow.count ?? 0)
    }
  }

  public getDocumentDetail(
    fileLocationId: number,
    options?: {
      processingFileLocationIds?: ReadonlySet<number>
      recipeVersion?: string
    }
  ): DocumentDetailItem | null {
    const db = this.deps.getDb()
    if (!Number.isSafeInteger(fileLocationId) || fileLocationId <= 0) {
      throw new RangeError(
        `fileLocationId must be a positive safe integer, got ${String(fileLocationId)}`
      )
    }
    const recipeVersion = options?.recipeVersion ?? DOCUMENT_EXTRACTION_RECIPE_VERSION

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
           h.hashed_at_ms AS active_hash_verified_at_ms,
           e.id AS ext_id,
           e.discovery_observation_id AS ext_discovery_observation_id,
           e.content_sha256 AS ext_content_sha256,
           e.observed_byte_size AS ext_observed_byte_size,
           e.observed_mtime_ms AS ext_observed_mtime_ms,
           e.content_revision AS ext_content_revision,
           e.recipe_version AS ext_recipe_version,
           e.extraction_status AS ext_status,
           e.status_detail AS ext_status_detail,
           e.extracted_char_count AS ext_char_count,
           e.page_count AS ext_page_count,
           e.truncated AS ext_truncated,
           e.truncation_reason AS ext_truncation_reason,
           e.detected_encoding AS ext_detected_encoding,
           e.extracted_at_ms AS ext_extracted_at_ms
         FROM file_locations f
         JOIN sources s
           ON s.id = f.source_id
         JOIN discovery_observations d
           ON d.file_location_id = f.id AND d.is_current = 1
         LEFT JOIN hash_observations h
           ON h.discovery_observation_id = d.id AND h.is_active = 1
         LEFT JOIN document_extractions e
           ON e.file_location_id = f.id AND e.is_current = 1
         WHERE f.id = ? AND f.category = 'document'
         LIMIT 1;`
      )
      .get(fileLocationId) as unknown as RawDocumentDetailRow | undefined

    if (!row) {
      return null
    }

    const summary = this.mapSummaryRow(row, options?.processingFileLocationIds, recipeVersion)
    const compatible = row.ext_id !== null && isExtractionRowCompatible(row, recipeVersion)
    const clsRepo = this.getClassificationRepo()
    const eff = clsRepo.getEffectiveDocumentClassification(fileLocationId)

    return {
      ...summary,
      sourceRootPath: row.source_root_path,
      normalizedPath: row.normalized_path,
      recipeVersion: row.ext_recipe_version,
      extractedAtMs: compatible ? row.ext_extracted_at_ms : row.ext_extracted_at_ms,
      truncationReason: compatible ? row.ext_truncation_reason : null,
      detectedEncoding: compatible ? row.ext_detected_encoding : null,
      ...(eff ? { classification: clsRepo.toEffectiveClassificationSummary(eff, true) } : {})
    }
  }

  public getDocumentPreview(
    fileLocationId: number,
    options?: {
      processingFileLocationIds?: ReadonlySet<number>
      recipeVersion?: string
      maxPreviewChars?: number
    }
  ): DocumentPreviewPayload | null {
    const db = this.deps.getDb()
    if (!Number.isSafeInteger(fileLocationId) || fileLocationId <= 0) {
      throw new RangeError(
        `fileLocationId must be a positive safe integer, got ${String(fileLocationId)}`
      )
    }
    const recipeVersion = options?.recipeVersion ?? DOCUMENT_EXTRACTION_RECIPE_VERSION
    const maxPreviewChars = options?.maxPreviewChars ?? DOCUMENT_EXTRACTION_LIMITS.MAX_PREVIEW_CHARS

    const row = db
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
           h.hashed_at_ms AS active_hash_verified_at_ms,
           e.id AS ext_id,
           e.discovery_observation_id AS ext_discovery_observation_id,
           e.content_sha256 AS ext_content_sha256,
           e.observed_byte_size AS ext_observed_byte_size,
           e.observed_mtime_ms AS ext_observed_mtime_ms,
           e.content_revision AS ext_content_revision,
           e.recipe_version AS ext_recipe_version,
           e.extraction_status AS ext_status,
           e.status_detail AS ext_status_detail,
           e.extracted_text AS ext_text,
           e.extracted_char_count AS ext_char_count,
           e.page_count AS ext_page_count,
           e.truncated AS ext_truncated,
           e.truncation_reason AS ext_truncation_reason,
           e.detected_encoding AS ext_detected_encoding,
           e.extracted_at_ms AS ext_extracted_at_ms
         FROM file_locations f
         JOIN discovery_observations d
           ON d.file_location_id = f.id AND d.is_current = 1
         LEFT JOIN hash_observations h
           ON h.discovery_observation_id = d.id AND h.is_active = 1
         LEFT JOIN document_extractions e
           ON e.file_location_id = f.id AND e.is_current = 1
         WHERE f.id = ? AND f.category = 'document'
         LIMIT 1;`
      )
      .get(fileLocationId) as unknown as RawDocumentPreviewRow | undefined

    if (!row) {
      return null
    }

    const summary = this.mapSummaryRow(row, options?.processingFileLocationIds, recipeVersion)
    const compatible = row.ext_id !== null && isExtractionRowCompatible(row, recipeVersion)

    if (!compatible || !row.ext_status) {
      return {
        fileLocationId: row.file_location_id,
        extractionStatus: summary.extractionStatus,
        previewStatus: summary.previewStatus,
        extractedText: null,
        extractedCharCount: 0,
        previewCharCount: 0,
        previewTruncated: false,
        extractionTruncated: false,
        truncationReason:
          summary.extractionStatus === 'stale'
            ? 'Source file or extraction recipe changed since last extraction.'
            : null,
        pageCount: null,
        statusDetail: summary.statusDetail ?? null,
        recipeVersion: row.ext_recipe_version,
        detectedEncoding: null,
        extractedAtMs: row.ext_extracted_at_ms,
        contentRevision: row.ext_content_revision
      }
    }

    const rawText = row.ext_text
    const previewTruncated = rawText !== null && rawText.length > maxPreviewChars
    const boundedText = rawText !== null ? rawText.slice(0, maxPreviewChars) : null
    const previewCharCount = boundedText !== null ? boundedText.length : 0

    return {
      fileLocationId: row.file_location_id,
      extractionStatus: summary.extractionStatus,
      previewStatus: summary.previewStatus,
      extractedText: boundedText,
      extractedCharCount: row.ext_char_count ?? 0,
      previewCharCount,
      previewTruncated,
      extractionTruncated: row.ext_truncated === 1,
      truncationReason: row.ext_truncation_reason,
      pageCount: row.ext_page_count,
      statusDetail: row.ext_status_detail,
      recipeVersion: row.ext_recipe_version,
      detectedEncoding: row.ext_detected_encoding,
      extractedAtMs: row.ext_extracted_at_ms,
      contentRevision: row.ext_content_revision
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

  public getDocumentExtractionCandidate(
    fileLocationId: number
  ): DocumentExtractionCandidate | null {
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
           d.id AS discovery_observation_id,
           d.byte_size,
           d.filesystem_mtime_ms,
           h.sha256 AS active_hash
         FROM file_locations f
         JOIN sources s ON s.id = f.source_id
         JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1
         LEFT JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1
         WHERE f.id = ? AND f.category = 'document'
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

  private getCompatibleReuseExtensions(extension: string): readonly string[] {
    const normalized = extension.trim().toLowerCase()
    switch (normalized) {
      case '.txt':
      case '.md':
      case '.markdown':
        return ['.txt', '.md', '.markdown']
      case '.csv':
        return ['.csv']
      case '.tsv':
        return ['.tsv']
      case '.rtf':
        return ['.rtf']
      case '.pdf':
        return ['.pdf']
      case '.docx':
        return ['.docx']
      default:
        return []
    }
  }

  public findReusableDocumentExtraction(
    contentSha256: string,
    recipeVersion: string,
    targetExtension: string
  ): {
    extractionStatus: PersistedDocumentExtractionStatus
    statusDetail: string | null
    extractedText: string | null
    extractedCharCount: number
    pageCount: number | null
    ocrCandidatePageCount: number | null
    truncated: boolean
    truncationReason: string | null
    detectedEncoding: string | null
  } | null {
    const compatibleExts = this.getCompatibleReuseExtensions(targetExtension)
    if (compatibleExts.length === 0) {
      return null
    }
    const placeholders = compatibleExts.map(() => '?').join(', ')
    const db = this.deps.getDb()
    const row = db
      .prepare(
        `SELECT
           de.extraction_status,
           de.status_detail,
           de.extracted_text,
           de.extracted_char_count,
           de.page_count,
           de.ocr_candidate_page_count,
           de.truncated,
           de.truncation_reason,
           de.detected_encoding
         FROM document_extractions de
         JOIN file_locations f ON f.id = de.file_location_id
         WHERE de.content_sha256 = ?
           AND de.recipe_version = ?
           AND de.is_current = 1
           AND de.extraction_status IN ('extracted', 'no_text_ocr_required', 'truncated')
           AND LOWER(f.extension) IN (${placeholders})
         ORDER BY de.extracted_at_ms DESC
         LIMIT 1;`
      )
      .get(contentSha256, recipeVersion, ...compatibleExts) as unknown as
      | {
          extraction_status: PersistedDocumentExtractionStatus
          status_detail: string | null
          extracted_text: string | null
          extracted_char_count: number
          page_count: number | null
          ocr_candidate_page_count: number | null
          truncated: number
          truncation_reason: string | null
          detected_encoding: string | null
        }
      | undefined

    if (!row) return null
    return {
      extractionStatus: row.extraction_status,
      statusDetail: row.status_detail,
      extractedText: row.extracted_text,
      extractedCharCount: row.extracted_char_count,
      pageCount: row.page_count,
      ocrCandidatePageCount: row.ocr_candidate_page_count ?? null,
      truncated: row.truncated === 1,
      truncationReason: row.truncation_reason,
      detectedEncoding: row.detected_encoding
    }
  }

  public upsertDocumentExtraction(input: {
    fileLocationId: number
    expectedDiscoveryObservationId: number
    expectedContentRevision: string
    contentSha256: string
    observedByteSize: number
    observedMtimeMs: number | null
    recipeVersion: string
    extractionStatus: PersistedDocumentExtractionStatus
    statusDetail: string | null
    extractedText: string | null
    extractedCharCount: number
    pageCount: number | null
    ocrCandidatePageCount?: number | null
    truncated: boolean
    truncationReason: string | null
    detectedEncoding: string | null
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
           WHERE f.id = ? AND f.category = 'document'
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
        `UPDATE document_extractions SET is_current = 0 WHERE file_location_id = ? AND is_current = 1;`
      ).run(input.fileLocationId)

      db.prepare(
        `INSERT INTO document_extractions (
           file_location_id,
           discovery_observation_id,
           content_sha256,
           observed_byte_size,
           observed_mtime_ms,
           content_revision,
           recipe_version,
           extraction_status,
           status_detail,
           extracted_text,
           extracted_char_count,
           page_count,
           ocr_candidate_page_count,
           truncated,
           truncation_reason,
           detected_encoding,
           extracted_at_ms,
           is_current
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1);`
      ).run(
        input.fileLocationId,
        input.expectedDiscoveryObservationId,
        input.contentSha256,
        input.observedByteSize,
        input.observedMtimeMs,
        input.expectedContentRevision,
        input.recipeVersion,
        input.extractionStatus,
        input.statusDetail,
        input.extractedText,
        input.extractedCharCount,
        input.pageCount,
        input.ocrCandidatePageCount ?? null,
        input.truncated ? 1 : 0,
        input.truncationReason,
        input.detectedEncoding,
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

  public getDocumentExtractionCoverage(
    recipeVersion = DOCUMENT_EXTRACTION_RECIPE_VERSION
  ): DocumentExtractionCoverage {
    const db = this.deps.getDb()
    const rows = db
      .prepare(
        `SELECT
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
         JOIN discovery_observations d
           ON d.file_location_id = f.id AND d.is_current = 1
         LEFT JOIN hash_observations h
           ON h.discovery_observation_id = d.id AND h.is_active = 1
         LEFT JOIN document_extractions e
           ON e.file_location_id = f.id AND e.is_current = 1
         WHERE f.category = 'document';`
      )
      .iterate() as IterableIterator<{
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

    let totalDocuments = 0
    let notExtractedDocuments = 0
    let extractedDocuments = 0
    let noTextDocuments = 0
    let passwordProtectedDocuments = 0
    let unsupportedDocuments = 0
    let failedDocuments = 0
    let truncatedDocuments = 0
    let staleDocuments = 0

    for (const row of rows) {
      totalDocuments++
      if (row.ext_id === null || row.ext_status === null) {
        notExtractedDocuments++
        continue
      }
      if (!isExtractionRowCompatible(row, recipeVersion)) {
        staleDocuments++
        continue
      }
      switch (row.ext_status) {
        case 'extracted':
          extractedDocuments++
          break
        case 'no_text_ocr_required':
          noTextDocuments++
          break
        case 'password_protected':
          passwordProtectedDocuments++
          break
        case 'unsupported':
          unsupportedDocuments++
          break
        case 'corrupt_or_failed':
          failedDocuments++
          break
        case 'truncated':
          truncatedDocuments++
          break
      }
    }

    return {
      totalDocuments,
      notExtractedDocuments,
      extractedDocuments,
      noTextDocuments,
      passwordProtectedDocuments,
      unsupportedDocuments,
      failedDocuments,
      truncatedDocuments,
      staleDocuments
    }
  }

  public async createDocumentExtractionJob(input: {
    jobId: string
    scopeKind: 'selected' | 'filtered' | 'all'
    recipeVersion: string
    fileLocationIds?: readonly number[]
    extensionFilter?: string | null
    filenameQuery?: string
    retryFailed?: boolean
    forceReextract?: boolean
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
  }): Promise<DocumentExtractionJobRecord> {
    const db = this.deps.getDb()
    const now = Date.now()
    const batchSize = Math.max(1, Math.min(500, Math.floor(input.batchSize ?? 250)))
    const catalogPath = this.deps.getCatalogPath?.() ?? ':memory:'
    const stagingFilePath =
      catalogPath !== ':memory:' ? `${catalogPath}.snapshot-${input.jobId}.tmp` : null

    // Insert job header with snapshot_complete = 0 so an interrupted scope construction
    // can never be mistaken for a complete resumable extraction job on restart.
    db.exec('BEGIN IMMEDIATE;')
    try {
      db.prepare(
        `INSERT INTO document_extraction_jobs (
           id, scope_kind, status, recipe_version, force_reextract, snapshot_complete,
           total_documents, processed_documents, extracted_documents,
           no_text_documents, password_protected_documents, unsupported_documents,
           failed_documents, truncated_documents, reused_documents,
           started_at_ms, updated_at_ms, completed_at_ms, last_error
         ) VALUES (?, ?, 'running', ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ?, ?, NULL, NULL);`
      ).run(
        input.jobId,
        input.scopeKind,
        input.recipeVersion,
        input.forceReextract ? 1 : 0,
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
          currentDb.prepare('DELETE FROM document_extraction_jobs WHERE id = ?;').run(input.jobId)
          currentDb.exec('COMMIT;')
        } catch {
          try {
            currentDb.exec('ROLLBACK;')
          } catch {
            // ignore rollback error
          }
        }
      } catch {
        // catalog already closed
      }
    }

    const cancelPartialJob = (): DocumentExtractionJobRecord => {
      const cancelNow = Date.now()
      const currentDb = this.deps.getDb()
      currentDb.exec('BEGIN IMMEDIATE;')
      try {
        currentDb
          .prepare('DELETE FROM document_extraction_job_items WHERE job_id = ?;')
          .run(input.jobId)
        currentDb
          .prepare(
            `UPDATE document_extraction_jobs
             SET total_documents = 0,
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
      const cancelled = this.getDocumentExtractionJob(input.jobId)
      if (!cancelled) {
        throw new Error(`Failed to read cancelled document extraction job ${input.jobId}`)
      }
      return cancelled
    }

    const yieldToEventLoop = (): Promise<void> =>
      new Promise<void>((resolveYield) => {
        setImmediate(resolveYield)
      })

    const snapshotInput: SnapshotJobInput = {
      scopeKind: input.scopeKind,
      recipeVersion: input.recipeVersion,
      fileLocationIds: input.fileLocationIds,
      extensionFilter: input.extensionFilter,
      filenameQuery: input.filenameQuery,
      retryFailed: input.retryFailed,
      forceReextract: input.forceReextract
    }

    let totalSnapshotted = 0

    try {
      if (stagingFilePath === null) {
        // :memory: database cannot be opened by a separate worker connection;
        // capture the snapshot synchronously inside one transaction.
        db.exec('BEGIN IMMEDIATE;')
        try {
          totalSnapshotted = this.insertSnapshotSynchronouslyInTx(
            db,
            input.jobId,
            snapshotInput,
            now
          )
          db.prepare(
            `UPDATE document_extraction_jobs
             SET total_documents = ?,
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

        // Capture a consistent point-in-time read snapshot off the main event loop.
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
          `INSERT INTO document_extraction_job_items (
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

        // Atomically mark scope construction complete and publish final total_documents.
        const doneNow = Date.now()
        db.exec('BEGIN IMMEDIATE;')
        try {
          db.prepare(
            `UPDATE document_extraction_jobs
             SET total_documents = ?,
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

    const created = this.getDocumentExtractionJob(input.jobId)
    if (!created) {
      throw new Error(`Failed to read created document extraction job ${input.jobId}`)
    }
    return created
  }

  private insertSnapshotSynchronouslyInTx(
    db: DatabaseSync,
    jobId: string,
    input: SnapshotJobInput,
    now: number
  ): number {
    const insertItem = db.prepare(
      `INSERT INTO document_extraction_job_items (
         job_id, file_location_id, discovery_observation_id, content_revision,
         status, error_message, updated_at_ms
       ) VALUES (?, ?, ?, ?, 'pending', NULL, ?);`
    )
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
         WHERE f.id = ? AND f.category = 'document'
         LIMIT 1;`
      )
      const seen = new Set<number>()
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
       LIMIT 500;`
    )
    let lastFileId = 0
    while (true) {
      const batchRows = selectBatch.all(...params, lastFileId) as Array<{
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
      if (batchRows.length === 0) break
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
    input: SnapshotJobInput,
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
          workerData: { catalogPath, stagingFilePath, input }
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
                new Error(pendingMessage!.errorMessage ?? 'Document snapshot worker failed')
              )
            )
          }
          return
        }
        finish(() =>
          rejectPromise(new Error(`Document snapshot worker exited unexpectedly (${code})`))
        )
      })
    })
  }

  public getDocumentExtractionJob(jobId: string): DocumentExtractionJobRecord | null {
    const db = this.deps.getDb()
    const row = db
      .prepare(
        `SELECT j.*,
                (SELECT COUNT(*) FROM document_extraction_job_items i WHERE i.job_id = j.id AND i.status = 'pending') AS pending_documents
         FROM document_extraction_jobs j
         WHERE j.id = ?
         LIMIT 1;`
      )
      .get(jobId) as unknown as RawJobRow | undefined

    return row ? mapJobRow(row) : null
  }

  public getLatestDocumentExtractionJob(): DocumentExtractionJobRecord | null {
    const db = this.deps.getDb()
    const row = db
      .prepare(
        `SELECT j.*,
                (SELECT COUNT(*) FROM document_extraction_job_items i WHERE i.job_id = j.id AND i.status = 'pending') AS pending_documents
         FROM document_extraction_jobs j
         WHERE j.snapshot_complete = 1
         ORDER BY j.started_at_ms DESC, j.rowid DESC
         LIMIT 1;`
      )
      .get() as unknown as RawJobRow | undefined

    return row ? mapJobRow(row) : null
  }

  public markRunningDocumentExtractionJobsAsInterrupted(): number {
    const db = this.deps.getDb()
    const now = Date.now()
    const catalogPath = this.deps.getCatalogPath?.() ?? ':memory:'

    // Clean up any orphaned snapshot staging temp files left behind by a hard crash.
    if (catalogPath !== ':memory:') {
      try {
        const dir = dirname(catalogPath)
        const prefix = `${basename(catalogPath)}.snapshot-`
        for (const entry of readdirSync(dir)) {
          if (entry.startsWith(prefix) && entry.endsWith('.tmp')) {
            rmSync(join(dir, entry), { force: true })
          }
        }
      } catch {
        // Ignore staging temp cleanup error
      }
    }

    db.exec('BEGIN IMMEDIATE;')
    try {
      // Discard incomplete scope-construction jobs so a partial scope can never be resumed as complete.
      db.prepare('DELETE FROM document_extraction_jobs WHERE snapshot_complete = 0;').run()
      const res = db
        .prepare(
          `UPDATE document_extraction_jobs
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

  public getNextPendingDocumentExtractionJobItems(
    jobId: string,
    limit: number
  ): DocumentExtractionJobItemRecord[] {
    const db = this.deps.getDb()
    const rows = db
      .prepare(
        `SELECT job_id, file_location_id, discovery_observation_id, content_revision, status, error_message, updated_at_ms
         FROM document_extraction_job_items
         WHERE job_id = ? AND status = 'pending'
         ORDER BY file_location_id ASC
         LIMIT ?;`
      )
      .all(jobId, limit) as unknown as Array<{
      job_id: string
      file_location_id: number
      discovery_observation_id: number
      content_revision: string
      status: DocumentExtractionJobItemRecord['status']
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

  public recordDocumentExtractionJobItemResult(input: {
    jobId: string
    fileLocationId: number
    status: Exclude<DocumentExtractionJobItemRecord['status'], 'pending'>
    errorMessage?: string | null
  }): void {
    const db = this.deps.getDb()
    const now = Date.now()

    db.exec('BEGIN IMMEDIATE;')
    try {
      const updateItem = db
        .prepare(
          `UPDATE document_extraction_job_items
           SET status = ?, error_message = ?, updated_at_ms = ?
           WHERE job_id = ? AND file_location_id = ? AND status = 'pending';`
        )
        .run(input.status, input.errorMessage ?? null, now, input.jobId, input.fileLocationId)

      if (Number(updateItem.changes) > 0) {
        const incExtracted = input.status === 'extracted' || input.status === 'reused' ? 1 : 0
        const incNoText = input.status === 'no_text_ocr_required' ? 1 : 0
        const incPassword = input.status === 'password_protected' ? 1 : 0
        const incUnsupported = input.status === 'unsupported' ? 1 : 0
        const incFailed = input.status === 'corrupt_or_failed' ? 1 : 0
        const incTruncated = input.status === 'truncated' ? 1 : 0
        const incReused = input.status === 'reused' ? 1 : 0

        db.prepare(
          `UPDATE document_extraction_jobs
           SET
             processed_documents = processed_documents + 1,
             extracted_documents = extracted_documents + ?,
             no_text_documents = no_text_documents + ?,
             password_protected_documents = password_protected_documents + ?,
             unsupported_documents = unsupported_documents + ?,
             failed_documents = failed_documents + ?,
             truncated_documents = truncated_documents + ?,
             reused_documents = reused_documents + ?,
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
          now,
          input.status === 'corrupt_or_failed' ? (input.errorMessage ?? 'Extraction failed') : null,
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

  public updateDocumentExtractionJobStatus(
    jobId: string,
    status: DocumentExtractionJobRecord['status'],
    lastError?: string | null
  ): void {
    const db = this.deps.getDb()
    const now = Date.now()
    const isTerminal = status === 'completed' || status === 'cancelled' || status === 'failed'
    db.prepare(
      `UPDATE document_extraction_jobs
       SET
         status = ?,
         updated_at_ms = ?,
         completed_at_ms = CASE WHEN ? THEN COALESCE(completed_at_ms, ?) ELSE NULL END,
         last_error = COALESCE(?, last_error)
       WHERE id = ?;`
    ).run(status, now, isTerminal ? 1 : 0, now, lastError ?? null, jobId)
  }

  private mapSummaryRow(
    row: RawDocumentRow,
    processingIds?: ReadonlySet<number>,
    recipeVersion = DOCUMENT_EXTRACTION_RECIPE_VERSION
  ): DocumentSummaryItem {
    let extractionStatus: DocumentExtractionStatus = 'not_extracted'
    let statusDetail: string | null = null
    let extractedCharCount: number | null = null
    let pageCount: number | null = null
    let extractionTruncated = false

    if (processingIds?.has(row.file_location_id)) {
      extractionStatus = 'processing'
    } else if (row.ext_id !== null && row.ext_status !== null) {
      if (isExtractionRowCompatible(row, recipeVersion)) {
        extractionStatus = row.ext_status
        statusDetail = row.ext_status_detail
        extractedCharCount = row.ext_char_count
        pageCount = row.ext_page_count
        extractionTruncated = row.ext_truncated === 1
      } else {
        extractionStatus = 'stale'
        statusDetail = 'Source file or extraction recipe changed since last extraction.'
      }
    }

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
      extractionStatus,
      previewStatus: mapPreviewStatus(extractionStatus),
      extractedCharCount,
      pageCount,
      extractionTruncated,
      statusDetail
    }
  }
}

interface RawJobRow {
  id: string
  scope_kind: 'selected' | 'filtered' | 'all'
  status: 'running' | 'paused' | 'cancelled' | 'interrupted' | 'completed' | 'failed'
  recipe_version: string
  force_reextract?: number
  snapshot_complete?: number
  total_documents: number
  processed_documents: number
  extracted_documents: number
  no_text_documents: number
  password_protected_documents: number
  unsupported_documents: number
  failed_documents: number
  truncated_documents: number
  reused_documents: number
  pending_documents: number
  started_at_ms: number
  updated_at_ms: number
  completed_at_ms: number | null
  last_error: string | null
}

function mapJobRow(row: RawJobRow): DocumentExtractionJobRecord {
  return {
    id: row.id,
    scopeKind: row.scope_kind,
    status: row.status,
    recipeVersion: row.recipe_version,
    forceReextract: Boolean(row.force_reextract),
    snapshotComplete: row.snapshot_complete === undefined ? true : Boolean(row.snapshot_complete),
    totalDocuments: row.total_documents,
    processedDocuments: row.processed_documents,
    extractedDocuments: row.extracted_documents,
    noTextDocuments: row.no_text_documents,
    passwordProtectedDocuments: row.password_protected_documents,
    unsupportedDocuments: row.unsupported_documents,
    failedDocuments: row.failed_documents,
    truncatedDocuments: row.truncated_documents,
    reusedDocuments: row.reused_documents,
    pendingDocuments: row.pending_documents,
    startedAtMs: row.started_at_ms,
    updatedAtMs: row.updated_at_ms,
    completedAtMs: row.completed_at_ms,
    lastError: row.last_error
  }
}
