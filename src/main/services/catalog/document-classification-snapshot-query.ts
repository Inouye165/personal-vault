/**
 * Shared point-in-time snapshot query & compatibility helpers for Stage 7E document classification.
 *
 * Enforces:
 * 1. Scoped strictly to `f.category = 'document'` and `d.is_current = 1`.
 * 2. Source-root-relative path (`relative(sourceRootPath, originalPath)`) so ancestor
 *    directories above a selected root never influence classification.
 * 3. Complete provenance & compatibility: binds source observation, active SHA-256,
 *    byte size, mtime, relative path, native/OCR extraction IDs & recipes, OCR model/language,
 *    exact `normalized_input_sha256`, and `rule_version`.
 * 4. Keyset-paginated read-only snapshot streaming into staging files (O(batch) memory).
 */

import { createHash } from 'node:crypto'
import { closeSync, openSync, writeSync } from 'node:fs'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { relative } from 'node:path'
import type {
  DocumentClassificationTextSource,
  DocumentExtractionStatus
} from '../../../shared/validation/document-schemas'
import { DOCUMENT_OCR_RECIPE_VERSION } from '../documents/ocr/types'
import { DOCUMENT_EXTRACTION_RECIPE_VERSION } from '../documents/types'
import { isObservationTimestampMatching } from '../semantic/vector'
import { isOcrExtractionRowCompatible } from './document-ocr-snapshot-query'
import {
  buildDocumentContentRevision,
  buildDocumentFilterSql,
  isExtractionRowCompatible
} from './document-snapshot-query'

export type DocClassificationJobScopeKind =
  'selected' | 'unclassified_or_stale' | 'filtered' | 'all'

export interface DocClassificationSnapshotJobInput {
  readonly scopeKind: DocClassificationJobScopeKind
  readonly ruleVersion: string
  readonly fileLocationIds?: readonly number[]
  readonly extensionFilter?: string | null
  readonly filenameQuery?: string
  readonly forceReclassify?: boolean
}

export interface DocClassificationSnapshotItem {
  readonly f: number
  readonly d: number
  readonly r: string
  readonly ne: number | null
  readonly oe: number | null
  readonly h: string
}

export interface DocumentClassificationCandidateRow {
  readonly file_location_id: number
  readonly source_id: number
  readonly source_root_path: string
  readonly original_path: string
  readonly file_name: string
  readonly extension: string
  readonly byte_size: number
  readonly filesystem_mtime_ms: number | null
  readonly discovery_observation_id: number
  readonly active_hash: string | null
  // Native extraction
  readonly native_id: number | null
  readonly native_discovery_observation_id: number | null
  readonly native_content_sha256: string | null
  readonly native_observed_byte_size: number | null
  readonly native_observed_mtime_ms: number | null
  readonly native_recipe_version: string | null
  readonly native_status: DocumentExtractionStatus | null
  readonly native_text: string | null
  readonly native_truncated: number | null
  readonly native_is_current: number | null
  // OCR extraction
  readonly ocr_id: number | null
  readonly ocr_discovery_observation_id: number | null
  readonly ocr_content_sha256: string | null
  readonly ocr_observed_byte_size: number | null
  readonly ocr_observed_mtime_ms: number | null
  readonly ocr_recipe_version: string | null
  readonly ocr_model_id: string | null
  readonly ocr_model_manifest_sha256: string | null
  readonly ocr_language: string | null
  readonly ocr_status: string | null
  readonly ocr_text: string | null
  readonly ocr_mean_confidence: number | null
  readonly ocr_truncated: number | null
  readonly ocr_is_current: number | null
  // Existing current classification
  readonly cls_id: number | null
  readonly cls_is_current: number | null
  readonly cls_discovery_observation_id: number | null
  readonly cls_content_sha256: string | null
  readonly cls_observed_byte_size: number | null
  readonly cls_observed_mtime_ms: number | null
  readonly cls_relative_path: string | null
  readonly cls_native_extraction_id: number | null
  readonly cls_native_recipe_version: string | null
  readonly cls_ocr_extraction_id: number | null
  readonly cls_ocr_recipe_version: string | null
  readonly cls_ocr_model_id: string | null
  readonly cls_ocr_model_manifest_sha256: string | null
  readonly cls_ocr_language: string | null
  readonly cls_normalized_input_sha256: string | null
  readonly cls_rule_version: string | null
}

export interface ResolvedClassificationInputTrack {
  readonly relativePath: string
  readonly contentRevision: string
  readonly textSourceKind: DocumentClassificationTextSource
  readonly extractionStatus: DocumentExtractionStatus
  readonly ocrMeanConfidence: number | null
  readonly nativeTruncated: boolean
  readonly ocrTruncated: boolean
  readonly text: string | null
  readonly nativeExtractionId: number | null
  readonly nativeRecipeVersion: string | null
  readonly ocrExtractionId: number | null
  readonly ocrRecipeVersion: string | null
  readonly ocrModelId: string | null
  readonly ocrModelManifestSha256: string | null
  readonly ocrLanguage: string | null
  readonly normalizedInputSha256: string
}

export function computeDocumentRelativePath(sourceRootPath: string, originalPath: string): string {
  const rel = relative(sourceRootPath, originalPath).replace(/\\/g, '/')
  return rel.length > 0 ? rel : originalPath.replace(/\\/g, '/')
}

export function computeClassificationInputSha256(params: {
  readonly relativePath: string
  readonly fileName: string
  readonly extension: string
  readonly textSourceKind: DocumentClassificationTextSource
  readonly ocrMeanConfidence: number | null
  readonly nativeTruncated: boolean
  readonly ocrTruncated: boolean
  readonly text: string | null
}): string {
  const normalizedText = (params.text ?? '').replace(/\r\n?/g, '\n').trim()
  const payload = JSON.stringify({
    relativePath: params.relativePath,
    fileName: params.fileName,
    extension: params.extension,
    textSourceKind: params.textSourceKind,
    ocrMeanConfidence: params.ocrMeanConfidence,
    nativeTruncated: params.nativeTruncated,
    ocrTruncated: params.ocrTruncated,
    normalizedText
  })
  return createHash('sha256').update(payload).digest('hex')
}

export function resolveClassificationInputTrack(
  row: DocumentClassificationCandidateRow
): ResolvedClassificationInputTrack {
  const relativePath = computeDocumentRelativePath(row.source_root_path, row.original_path)
  const contentRevision = buildDocumentContentRevision({
    discoveryObservationId: row.discovery_observation_id,
    byteSize: row.byte_size,
    filesystemMtimeMs: row.filesystem_mtime_ms,
    activeHash: row.active_hash
  })

  const nativeCompatible =
    row.native_id !== null &&
    row.native_is_current === 1 &&
    isExtractionRowCompatible({
      discovery_observation_id: row.discovery_observation_id,
      byte_size: row.byte_size,
      filesystem_mtime_ms: row.filesystem_mtime_ms,
      active_hash: row.active_hash,
      ext_discovery_observation_id: row.native_discovery_observation_id,
      ext_content_sha256: row.native_content_sha256,
      ext_observed_byte_size: row.native_observed_byte_size,
      ext_observed_mtime_ms: row.native_observed_mtime_ms,
      ext_recipe_version: row.native_recipe_version ?? DOCUMENT_EXTRACTION_RECIPE_VERSION
    })

  const ocrCompatible =
    row.ocr_id !== null &&
    row.ocr_is_current === 1 &&
    isOcrExtractionRowCompatible(
      {
        discovery_observation_id: row.discovery_observation_id,
        byte_size: row.byte_size,
        filesystem_mtime_ms: row.filesystem_mtime_ms,
        active_hash: row.active_hash,
        ocr_discovery_observation_id: row.ocr_discovery_observation_id,
        ocr_content_sha256: row.ocr_content_sha256,
        ocr_observed_byte_size: row.ocr_observed_byte_size,
        ocr_observed_mtime_ms: row.ocr_observed_mtime_ms,
        ocr_recipe_version: row.ocr_recipe_version,
        ocr_model_id: row.ocr_model_id,
        ocr_model_manifest_sha256: row.ocr_model_manifest_sha256,
        ocr_language: row.ocr_language
      },
      {
        recipeVersion: row.ocr_recipe_version ?? DOCUMENT_OCR_RECIPE_VERSION,
        ocrModelId: row.ocr_model_id ?? '',
        ocrModelManifestSha256: row.ocr_model_manifest_sha256 ?? '',
        ocrLanguage: row.ocr_language ?? ''
      }
    )

  const nativeHasText =
    nativeCompatible && typeof row.native_text === 'string' && row.native_text.trim().length > 0
  const ocrHasText =
    ocrCompatible && typeof row.ocr_text === 'string' && row.ocr_text.trim().length > 0

  let textSourceKind: DocumentClassificationTextSource = 'none'
  let text: string | null = null
  const extractionStatus: DocumentExtractionStatus = nativeCompatible
    ? (row.native_status ?? 'not_extracted')
    : 'not_extracted'
  let ocrMeanConfidence: number | null = null

  if (nativeHasText) {
    textSourceKind = 'native'
    text = row.native_text
  } else if (ocrHasText) {
    textSourceKind = 'ocr'
    text = row.ocr_text
    ocrMeanConfidence = row.ocr_mean_confidence
  }

  const nativeTruncated = Boolean(nativeCompatible && row.native_truncated === 1)
  const ocrTruncated = Boolean(ocrCompatible && row.ocr_truncated === 1)

  const nativeExtractionId = nativeCompatible ? row.native_id : null
  const nativeRecipeVersion = nativeCompatible ? row.native_recipe_version : null
  const ocrExtractionId = ocrCompatible ? row.ocr_id : null
  const ocrRecipeVersion = ocrCompatible ? row.ocr_recipe_version : null
  const ocrModelId = ocrCompatible ? row.ocr_model_id : null
  const ocrModelManifestSha256 = ocrCompatible ? row.ocr_model_manifest_sha256 : null
  const ocrLanguage = ocrCompatible ? row.ocr_language : null

  const normalizedInputSha256 = computeClassificationInputSha256({
    relativePath,
    fileName: row.file_name,
    extension: row.extension,
    textSourceKind,
    ocrMeanConfidence,
    nativeTruncated,
    ocrTruncated,
    text
  })

  return {
    relativePath,
    contentRevision,
    textSourceKind,
    extractionStatus,
    ocrMeanConfidence,
    nativeTruncated,
    ocrTruncated,
    text,
    nativeExtractionId,
    nativeRecipeVersion,
    ocrExtractionId,
    ocrRecipeVersion,
    ocrModelId,
    ocrModelManifestSha256,
    ocrLanguage,
    normalizedInputSha256
  }
}

export function isDocumentClassificationRowCompatible(
  row: DocumentClassificationCandidateRow,
  resolved: ResolvedClassificationInputTrack,
  expectedRuleVersion: string
): boolean {
  if (row.cls_id === null || row.cls_is_current !== 1) {
    return false
  }
  if (row.cls_rule_version !== expectedRuleVersion) {
    return false
  }
  if (row.cls_discovery_observation_id !== row.discovery_observation_id) {
    return false
  }
  if (row.cls_content_sha256 !== (row.active_hash ?? '')) {
    return false
  }
  if (row.cls_observed_byte_size !== row.byte_size) {
    return false
  }
  if (!isObservationTimestampMatching(row.cls_observed_mtime_ms, row.filesystem_mtime_ms)) {
    return false
  }
  if (row.cls_relative_path !== resolved.relativePath) {
    return false
  }
  if ((row.cls_native_extraction_id ?? null) !== resolved.nativeExtractionId) {
    return false
  }
  if ((row.cls_native_recipe_version ?? null) !== resolved.nativeRecipeVersion) {
    return false
  }
  if ((row.cls_ocr_extraction_id ?? null) !== resolved.ocrExtractionId) {
    return false
  }
  if ((row.cls_ocr_recipe_version ?? null) !== resolved.ocrRecipeVersion) {
    return false
  }
  if ((row.cls_ocr_model_id ?? null) !== resolved.ocrModelId) {
    return false
  }
  if ((row.cls_ocr_model_manifest_sha256 ?? null) !== resolved.ocrModelManifestSha256) {
    return false
  }
  if ((row.cls_ocr_language ?? null) !== resolved.ocrLanguage) {
    return false
  }
  if (row.cls_normalized_input_sha256 !== resolved.normalizedInputSha256) {
    return false
  }
  return true
}

export const DOCUMENT_CLASSIFICATION_CANDIDATE_SELECT = `
  SELECT
    f.id AS file_location_id,
    f.source_id AS source_id,
    s.root_path AS source_root_path,
    f.original_path AS original_path,
    f.file_name AS file_name,
    f.extension AS extension,
    d.byte_size AS byte_size,
    d.filesystem_mtime_ms AS filesystem_mtime_ms,
    d.id AS discovery_observation_id,
    h.sha256 AS active_hash,
    de.id AS native_id,
    de.discovery_observation_id AS native_discovery_observation_id,
    de.content_sha256 AS native_content_sha256,
    de.observed_byte_size AS native_observed_byte_size,
    de.observed_mtime_ms AS native_observed_mtime_ms,
    de.recipe_version AS native_recipe_version,
    de.extraction_status AS native_status,
    de.extracted_text AS native_text,
    de.truncated AS native_truncated,
    de.is_current AS native_is_current,
    ocr.id AS ocr_id,
    ocr.discovery_observation_id AS ocr_discovery_observation_id,
    ocr.content_sha256 AS ocr_content_sha256,
    ocr.observed_byte_size AS ocr_observed_byte_size,
    ocr.observed_mtime_ms AS ocr_observed_mtime_ms,
    ocr.recipe_version AS ocr_recipe_version,
    ocr.ocr_model_id AS ocr_model_id,
    ocr.ocr_model_manifest_sha256 AS ocr_model_manifest_sha256,
    ocr.ocr_language AS ocr_language,
    ocr.ocr_status AS ocr_status,
    ocr.extracted_text AS ocr_text,
    ocr.mean_confidence AS ocr_mean_confidence,
    ocr.truncated AS ocr_truncated,
    ocr.is_current AS ocr_is_current,
    dc.id AS cls_id,
    dc.is_current AS cls_is_current,
    dc.discovery_observation_id AS cls_discovery_observation_id,
    dc.content_sha256 AS cls_content_sha256,
    dc.observed_byte_size AS cls_observed_byte_size,
    dc.observed_mtime_ms AS cls_observed_mtime_ms,
    dc.relative_path AS cls_relative_path,
    dc.native_extraction_id AS cls_native_extraction_id,
    dc.native_recipe_version AS cls_native_recipe_version,
    dc.ocr_extraction_id AS cls_ocr_extraction_id,
    dc.ocr_recipe_version AS cls_ocr_recipe_version,
    dc.ocr_model_id AS cls_ocr_model_id,
    dc.ocr_model_manifest_sha256 AS cls_ocr_model_manifest_sha256,
    dc.ocr_language AS cls_ocr_language,
    dc.normalized_input_sha256 AS cls_normalized_input_sha256,
    dc.rule_version AS cls_rule_version
  FROM file_locations f
  JOIN sources s ON s.id = f.source_id
  JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1
  LEFT JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1
  LEFT JOIN document_extractions de ON de.file_location_id = f.id AND de.is_current = 1
  LEFT JOIN document_ocr_extractions ocr ON ocr.file_location_id = f.id AND ocr.is_current = 1
  LEFT JOIN document_classifications dc ON dc.file_location_id = f.id AND dc.is_current = 1
`

export function writeDocClassificationSnapshotToStagingFile(
  db: DatabaseSync,
  input: DocClassificationSnapshotJobInput,
  stagingFilePath: string
): number {
  const filter =
    input.scopeKind === 'filtered'
      ? buildDocumentFilterSql({
          extensionFilter: input.extensionFilter,
          filenameQuery: input.filenameQuery
        })
      : { whereClause: "WHERE f.category = 'document'", params: [] as SQLInputValue[] }

  let selectedWhere = ''
  const baseParams: SQLInputValue[] = [...filter.params]

  if (input.scopeKind === 'selected') {
    const ids = (input.fileLocationIds ?? []).filter((id) => Number.isInteger(id) && id > 0)
    if (ids.length === 0) {
      const fd = openSync(stagingFilePath, 'w')
      closeSync(fd)
      return 0
    }
    selectedWhere = ` AND f.id IN (${ids.map(() => '?').join(', ')})`
    baseParams.push(...ids)
  }

  const fd = openSync(stagingFilePath, 'w')
  let count = 0
  let lastId = 0

  try {
    const stmt = db.prepare(`
      ${DOCUMENT_CLASSIFICATION_CANDIDATE_SELECT}
      ${filter.whereClause}
        AND f.id > ?
        ${selectedWhere}
      ORDER BY f.id ASC
      LIMIT 500;
    `)

    for (;;) {
      const rows = stmt.all(
        ...baseParams,
        lastId
      ) as unknown as DocumentClassificationCandidateRow[]
      if (rows.length === 0) break

      const lines: string[] = []
      for (const row of rows) {
        lastId = row.file_location_id
        const resolved = resolveClassificationInputTrack(row)
        const compatible = isDocumentClassificationRowCompatible(row, resolved, input.ruleVersion)
        if (input.scopeKind === 'unclassified_or_stale' && !input.forceReclassify && compatible) {
          continue
        }
        const item: DocClassificationSnapshotItem = {
          f: row.file_location_id,
          d: row.discovery_observation_id,
          r: resolved.contentRevision,
          ne: resolved.nativeExtractionId,
          oe: resolved.ocrExtractionId,
          h: resolved.normalizedInputSha256
        }
        lines.push(JSON.stringify(item))
        count += 1
      }

      if (lines.length > 0) {
        writeSync(fd, `${lines.join('\n')}\n`, undefined, 'utf8')
      }
      if (rows.length < 500) break
    }
  } finally {
    closeSync(fd)
  }

  return count
}

export const EFFECTIVE_CLASSIFICATION_JOIN_SQL = `
  LEFT JOIN document_classifications cls
    ON cls.file_location_id = f.id
   AND cls.is_current = 1
   AND cls.discovery_observation_id = d.id
  LEFT JOIN document_classification_overrides clso
    ON clso.file_location_id = f.id
   AND clso.is_current = 1
   AND clso.discovery_observation_id = d.id
`

export const EFFECTIVE_CLUTTER_SQL_EXPR = `
  CASE
    WHEN clso.id IS NOT NULL AND clso.clutter_override = 'force_keep' THEN 0
    WHEN clso.id IS NOT NULL AND clso.clutter_override = 'force_clutter' THEN 1
    WHEN cls.id IS NOT NULL
      AND cls.is_clutter_candidate = 1
      AND NOT (
        (
          clso.id IS NOT NULL
          AND clso.origin_labels_json IS NOT NULL
          AND EXISTS (SELECT 1 FROM json_each(clso.origin_labels_json) WHERE value = 'personal')
        )
        OR (
          (clso.id IS NULL OR clso.origin_labels_json IS NULL)
          AND EXISTS (
            SELECT 1
            FROM document_classification_labels l
            WHERE l.classification_id = cls.id
              AND l.axis = 'origin'
              AND l.label = 'personal'
          )
        )
      )
    THEN 1
    ELSE 0
  END
`

export function buildClassificationFilterSql(filters: {
  readonly purposeFilter?: string | null
  readonly originFilter?: string | null
  readonly clutterFilter?: 'show_all' | 'hide_clutter' | 'only_clutter'
}): { readonly clauses: string[]; readonly params: SQLInputValue[] } {
  const clauses: string[] = []
  const params: SQLInputValue[] = []

  if (filters.clutterFilter === 'hide_clutter') {
    clauses.push(`${EFFECTIVE_CLUTTER_SQL_EXPR} = 0`)
  } else if (filters.clutterFilter === 'only_clutter') {
    clauses.push(`${EFFECTIVE_CLUTTER_SQL_EXPR} = 1`)
  }

  if (filters.purposeFilter) {
    if (filters.purposeFilter === 'other') {
      clauses.push(`(
        (clso.id IS NOT NULL AND clso.purpose_labels_json IS NOT NULL AND json_array_length(clso.purpose_labels_json) = 0)
        OR ((clso.id IS NULL OR clso.purpose_labels_json IS NULL) AND cls.id IS NOT NULL AND cls.purpose_status = 'other')
      )`)
    } else if (filters.purposeFilter === 'unknown') {
      clauses.push(`(
        (clso.id IS NULL OR clso.purpose_labels_json IS NULL)
        AND (cls.id IS NULL OR cls.purpose_status = 'unknown')
      )`)
    } else {
      clauses.push(`(
        (clso.id IS NOT NULL AND clso.purpose_labels_json IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(clso.purpose_labels_json) WHERE value = ?))
        OR ((clso.id IS NULL OR clso.purpose_labels_json IS NULL) AND cls.id IS NOT NULL AND EXISTS (SELECT 1 FROM document_classification_labels l WHERE l.classification_id = cls.id AND l.axis = 'purpose' AND l.label = ?))
      )`)
      params.push(filters.purposeFilter, filters.purposeFilter)
    }
  }

  if (filters.originFilter) {
    if (filters.originFilter === 'unknown') {
      clauses.push(`(
        (clso.id IS NOT NULL AND clso.origin_labels_json IS NOT NULL AND json_array_length(clso.origin_labels_json) = 0)
        OR ((clso.id IS NULL OR clso.origin_labels_json IS NULL) AND (cls.id IS NULL OR cls.origin_status = 'unknown'))
      )`)
    } else {
      clauses.push(`(
        (clso.id IS NOT NULL AND clso.origin_labels_json IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(clso.origin_labels_json) WHERE value = ?))
        OR ((clso.id IS NULL OR clso.origin_labels_json IS NULL) AND cls.id IS NOT NULL AND EXISTS (SELECT 1 FROM document_classification_labels l WHERE l.classification_id = cls.id AND l.axis = 'origin' AND l.label = ?))
      )`)
      params.push(filters.originFilter, filters.originFilter)
    }
  }

  return { clauses, params }
}
