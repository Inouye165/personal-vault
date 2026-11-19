/**
 * Shared point-in-time snapshot query & compatibility helpers for Stage 7D document semantic indexing.
 *
 * Enforces:
 * 1. Dual-track provenance (`native` from `document_extractions` and `ocr` from
 *    `document_ocr_extractions`), strictly scoped to `f.category = 'document'` and `f.is_present = 1`.
 * 2. Complete embedding compatibility & non-reuse: binds source observation, active SHA-256,
 *    source-track extraction ID/recipe, OCR model/language (when OCR), exact `normalized_text_sha256`,
 *    embedding model manifest, and chunking recipe parameters.
 * 3. Keyset-paginated read-only snapshot streaming into staging files (O(batch) memory).
 */

import { closeSync, openSync, writeSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { isObservationTimestampMatching } from '../semantic/vector'
import { DOCUMENT_EXTRACTION_RECIPE_VERSION } from '../documents/types'
import {
  DOC_SEMANTIC_MODEL_COMMIT,
  DOC_SEMANTIC_MODEL_ID,
  PINNED_DOC_SEMANTIC_MANIFEST_SHA256
} from '../documents/semantic/manifest'
import { computeNormalizedTextSha256, normalizeDocumentText } from '../documents/semantic/chunker'
import { DOC_CHUNKING_RECIPE_VERSION, DOC_SEMANTIC_LIMITS } from '../documents/semantic/types'
import {
  buildDocumentContentRevision,
  buildDocumentFilterSql,
  isExtractionRowCompatible
} from './document-snapshot-query'
import { isOcrExtractionRowCompatible } from './document-ocr-snapshot-query'
import { DOCUMENT_OCR_RECIPE_VERSION } from '../documents/ocr/types'
import {
  OCR_MODEL_ID,
  OCR_MODEL_LANGUAGE,
  PINNED_OCR_MANIFEST_SHA256
} from '../documents/ocr/manifest'

export type DocSemanticJobScopeKind = 'selected' | 'unindexed_or_stale' | 'filtered' | 'all'
export type DocTextSourceKind = 'native' | 'ocr'

export interface DocSemanticCompatibilitySpec {
  readonly docModelId: string
  readonly docModelCommit: string
  readonly docModelManifestSha256: string
  readonly chunkingRecipeVersion: string
  readonly maxContentTokensPerChunk: number
  readonly overlapTokens: number
  readonly maxChunksPerDocument: number
  readonly maxTextCharsForIndexing: number
  readonly nativeRecipeVersion?: string
  readonly ocrRecipeVersion?: string
  readonly ocrModelId?: string
  readonly ocrModelManifestSha256?: string
  readonly ocrLanguage?: string
}

export const DEFAULT_DOC_SEMANTIC_COMPATIBILITY_SPEC: DocSemanticCompatibilitySpec = {
  docModelId: DOC_SEMANTIC_MODEL_ID,
  docModelCommit: DOC_SEMANTIC_MODEL_COMMIT,
  docModelManifestSha256: PINNED_DOC_SEMANTIC_MANIFEST_SHA256,
  chunkingRecipeVersion: DOC_CHUNKING_RECIPE_VERSION,
  maxContentTokensPerChunk: DOC_SEMANTIC_LIMITS.MAX_CONTENT_TOKENS_PER_CHUNK,
  overlapTokens: DOC_SEMANTIC_LIMITS.OVERLAP_TOKENS,
  maxChunksPerDocument: DOC_SEMANTIC_LIMITS.MAX_CHUNKS_PER_DOCUMENT,
  maxTextCharsForIndexing: DOC_SEMANTIC_LIMITS.MAX_TEXT_CHARS_FOR_INDEXING,
  nativeRecipeVersion: DOCUMENT_EXTRACTION_RECIPE_VERSION,
  ocrRecipeVersion: DOCUMENT_OCR_RECIPE_VERSION,
  ocrModelId: OCR_MODEL_ID,
  ocrModelManifestSha256: PINNED_OCR_MANIFEST_SHA256,
  ocrLanguage: OCR_MODEL_LANGUAGE
}

export interface DocSemanticSnapshotJobInput {
  readonly scopeKind: DocSemanticJobScopeKind
  readonly compat: DocSemanticCompatibilitySpec
  readonly fileLocationIds?: readonly number[]
  readonly extensionFilter?: string | null
  readonly filenameQuery?: string
  readonly retryFailed?: boolean
  readonly forceReindex?: boolean
}

export interface DocSemanticSnapshotItem {
  readonly f: number
  readonly k: DocTextSourceKind
  readonly e: number
  readonly d: number
  readonly r: string
  readonly h: string
}

export interface DocSemanticTrackCompatibilityRow {
  readonly discovery_observation_id: number
  readonly byte_size: number
  readonly filesystem_mtime_ms: number | null
  readonly active_hash: string | null
  readonly sem_is_current: number
  readonly sem_discovery_observation_id: number
  readonly sem_content_sha256: string
  readonly sem_observed_byte_size: number
  readonly sem_observed_mtime_ms: number | null
  readonly sem_content_revision: string
  readonly sem_source_extraction_id: number
  readonly sem_source_recipe_version: string
  readonly sem_source_ocr_model_id: string | null
  readonly sem_source_ocr_model_manifest_sha256: string | null
  readonly sem_source_ocr_language: string | null
  readonly sem_normalized_text_sha256: string
  readonly sem_doc_model_id: string
  readonly sem_doc_model_commit: string
  readonly sem_doc_model_manifest_sha256: string
  readonly sem_chunking_recipe_version: string
  readonly sem_max_content_tokens_per_chunk: number
  readonly sem_overlap_tokens: number
  readonly sem_max_chunks_per_document: number
  readonly sem_max_text_chars_for_indexing: number
  readonly current_source_extraction_id: number | null
  readonly current_source_recipe_version: string | null
  readonly current_source_text: string | null
  readonly current_source_ocr_model_id: string | null
  readonly current_source_ocr_model_manifest_sha256: string | null
  readonly current_source_ocr_language: string | null
}

export interface DocSemanticTrackCompatibilityOptions {
  /**
   * When `false`, skips re-hashing `current_source_text`. Only safe when the caller separately
   * proves that the current extraction row id equals the extraction id whose text was already
   * hash-verified (extraction rows are immutable: re-extraction inserts a new row id).
   */
  readonly verifyNormalizedTextHash?: boolean
}

export function isDocSemanticTrackCompatible(
  row: DocSemanticTrackCompatibilityRow,
  expected: DocSemanticCompatibilitySpec,
  textSourceKind: DocTextSourceKind,
  options: DocSemanticTrackCompatibilityOptions = {}
): boolean {
  const verifyText = options.verifyNormalizedTextHash !== false
  if (row.sem_is_current !== 1) return false
  if (row.sem_discovery_observation_id !== row.discovery_observation_id) return false
  if (row.sem_observed_byte_size !== row.byte_size) return false
  if (!isObservationTimestampMatching(row.sem_observed_mtime_ms, row.filesystem_mtime_ms)) {
    return false
  }
  if (row.active_hash !== null && row.sem_content_sha256 !== row.active_hash) {
    return false
  }

  const expectedRevision = buildDocumentContentRevision({
    discoveryObservationId: row.discovery_observation_id,
    byteSize: row.byte_size,
    filesystemMtimeMs: row.filesystem_mtime_ms,
    activeHash: row.active_hash
  })
  if (row.sem_content_revision !== expectedRevision) {
    return false
  }

  if (
    row.current_source_extraction_id === null ||
    row.current_source_recipe_version === null ||
    (verifyText && row.current_source_text === null)
  ) {
    return false
  }
  if (row.sem_source_extraction_id !== row.current_source_extraction_id) return false
  if (row.sem_source_recipe_version !== row.current_source_recipe_version) return false

  if (textSourceKind === 'ocr') {
    if (
      row.sem_source_ocr_model_id === null ||
      row.sem_source_ocr_model_manifest_sha256 === null ||
      row.sem_source_ocr_language === null ||
      row.sem_source_ocr_model_id !== row.current_source_ocr_model_id ||
      row.sem_source_ocr_model_manifest_sha256 !== row.current_source_ocr_model_manifest_sha256 ||
      row.sem_source_ocr_language !== row.current_source_ocr_language
    ) {
      return false
    }
  }

  if (verifyText) {
    const currentNormHash = computeNormalizedTextSha256(
      normalizeDocumentText(row.current_source_text ?? '')
    )
    if (row.sem_normalized_text_sha256 !== currentNormHash) {
      return false
    }
  }

  if (
    row.sem_doc_model_id !== expected.docModelId ||
    row.sem_doc_model_commit !== expected.docModelCommit ||
    row.sem_doc_model_manifest_sha256 !== expected.docModelManifestSha256 ||
    row.sem_chunking_recipe_version !== expected.chunkingRecipeVersion ||
    row.sem_max_content_tokens_per_chunk !== expected.maxContentTokensPerChunk ||
    row.sem_overlap_tokens !== expected.overlapTokens ||
    row.sem_max_chunks_per_document !== expected.maxChunksPerDocument ||
    row.sem_max_text_chars_for_indexing !== expected.maxTextCharsForIndexing
  ) {
    return false
  }

  return true
}

interface SnapshotCandidateRow {
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
  ext_status: string | null
  ext_text: string | null
  ocr_id: number | null
  ocr_discovery_observation_id: number | null
  ocr_content_sha256: string | null
  ocr_observed_byte_size: number | null
  ocr_observed_mtime_ms: number | null
  ocr_recipe_version: string | null
  ocr_model_id: string | null
  ocr_model_manifest_sha256: string | null
  ocr_language: string | null
  ocr_status: string | null
  ocr_text: string | null
}

interface TrackRowBrief {
  file_location_id: number
  text_source_kind: DocTextSourceKind
  status: string
  is_current: number
  discovery_observation_id: number
  content_sha256: string
  observed_byte_size: number
  observed_mtime_ms: number | null
  content_revision: string
  source_extraction_id: number
  source_recipe_version: string
  source_ocr_model_id: string | null
  source_ocr_model_manifest_sha256: string | null
  source_ocr_language: string | null
  normalized_text_sha256: string
  doc_model_id: string
  doc_model_commit: string
  doc_model_manifest_sha256: string
  chunking_recipe_version: string
  max_content_tokens_per_chunk: number
  overlap_tokens: number
  max_chunks_per_document: number
  max_text_chars_for_indexing: number
}

function collectEligibleTracksForRow(
  row: SnapshotCandidateRow,
  trackMap: Map<string, TrackRowBrief>,
  input: DocSemanticSnapshotJobInput
): DocSemanticSnapshotItem[] {
  const out: DocSemanticSnapshotItem[] = []
  const compat = input.compat
  const nativeRecipe = compat.nativeRecipeVersion ?? DOCUMENT_EXTRACTION_RECIPE_VERSION
  const ocrSpec = {
    recipeVersion: compat.ocrRecipeVersion ?? DOCUMENT_OCR_RECIPE_VERSION,
    ocrModelId: compat.ocrModelId ?? OCR_MODEL_ID,
    ocrModelManifestSha256: compat.ocrModelManifestSha256 ?? PINNED_OCR_MANIFEST_SHA256,
    ocrLanguage: compat.ocrLanguage ?? OCR_MODEL_LANGUAGE
  }

  const rev = buildDocumentContentRevision({
    discoveryObservationId: row.discovery_observation_id,
    byteSize: row.byte_size,
    filesystemMtimeMs: row.filesystem_mtime_ms,
    activeHash: row.active_hash
  })

  // Track 1: Native extracted text
  if (
    row.ext_id !== null &&
    (row.ext_status === 'extracted' || row.ext_status === 'truncated') &&
    row.ext_text !== null &&
    isExtractionRowCompatible(
      {
        discovery_observation_id: row.discovery_observation_id,
        byte_size: row.byte_size,
        filesystem_mtime_ms: row.filesystem_mtime_ms,
        active_hash: row.active_hash,
        ext_discovery_observation_id: row.ext_discovery_observation_id,
        ext_content_sha256: row.ext_content_sha256,
        ext_observed_byte_size: row.ext_observed_byte_size,
        ext_observed_mtime_ms: row.ext_observed_mtime_ms,
        ext_recipe_version: row.ext_recipe_version
      },
      nativeRecipe
    )
  ) {
    const normHash = computeNormalizedTextSha256(normalizeDocumentText(row.ext_text))
    const existing = trackMap.get(`${row.file_location_id}:native`)
    const compatible =
      existing !== undefined &&
      (existing.status === 'indexed' ||
        existing.status === 'truncated' ||
        existing.status === 'empty_text') &&
      isDocSemanticTrackCompatible(
        {
          discovery_observation_id: row.discovery_observation_id,
          byte_size: row.byte_size,
          filesystem_mtime_ms: row.filesystem_mtime_ms,
          active_hash: row.active_hash,
          sem_is_current: existing.is_current,
          sem_discovery_observation_id: existing.discovery_observation_id,
          sem_content_sha256: existing.content_sha256,
          sem_observed_byte_size: existing.observed_byte_size,
          sem_observed_mtime_ms: existing.observed_mtime_ms,
          sem_content_revision: existing.content_revision,
          sem_source_extraction_id: existing.source_extraction_id,
          sem_source_recipe_version: existing.source_recipe_version,
          sem_source_ocr_model_id: existing.source_ocr_model_id,
          sem_source_ocr_model_manifest_sha256: existing.source_ocr_model_manifest_sha256,
          sem_source_ocr_language: existing.source_ocr_language,
          sem_normalized_text_sha256: existing.normalized_text_sha256,
          sem_doc_model_id: existing.doc_model_id,
          sem_doc_model_commit: existing.doc_model_commit,
          sem_doc_model_manifest_sha256: existing.doc_model_manifest_sha256,
          sem_chunking_recipe_version: existing.chunking_recipe_version,
          sem_max_content_tokens_per_chunk: existing.max_content_tokens_per_chunk,
          sem_overlap_tokens: existing.overlap_tokens,
          sem_max_chunks_per_document: existing.max_chunks_per_document,
          sem_max_text_chars_for_indexing: existing.max_text_chars_for_indexing,
          current_source_extraction_id: row.ext_id,
          current_source_recipe_version: row.ext_recipe_version,
          current_source_text: row.ext_text,
          current_source_ocr_model_id: null,
          current_source_ocr_model_manifest_sha256: null,
          current_source_ocr_language: null
        },
        compat,
        'native'
      )

    const shouldSkip =
      input.scopeKind === 'unindexed_or_stale' &&
      !input.forceReindex &&
      (compatible || (existing?.status === 'failed' && !input.retryFailed))

    if (!shouldSkip) {
      out.push({
        f: row.file_location_id,
        k: 'native',
        e: row.ext_id,
        d: row.discovery_observation_id,
        r: rev,
        h: normHash
      })
    }
  }

  // Track 2: Machine OCR extracted text
  if (
    row.ocr_id !== null &&
    (row.ocr_status === 'extracted' || row.ocr_status === 'truncated') &&
    row.ocr_text !== null &&
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
      ocrSpec
    )
  ) {
    const normHash = computeNormalizedTextSha256(normalizeDocumentText(row.ocr_text))
    const existing = trackMap.get(`${row.file_location_id}:ocr`)
    const compatible =
      existing !== undefined &&
      (existing.status === 'indexed' ||
        existing.status === 'truncated' ||
        existing.status === 'empty_text') &&
      isDocSemanticTrackCompatible(
        {
          discovery_observation_id: row.discovery_observation_id,
          byte_size: row.byte_size,
          filesystem_mtime_ms: row.filesystem_mtime_ms,
          active_hash: row.active_hash,
          sem_is_current: existing.is_current,
          sem_discovery_observation_id: existing.discovery_observation_id,
          sem_content_sha256: existing.content_sha256,
          sem_observed_byte_size: existing.observed_byte_size,
          sem_observed_mtime_ms: existing.observed_mtime_ms,
          sem_content_revision: existing.content_revision,
          sem_source_extraction_id: existing.source_extraction_id,
          sem_source_recipe_version: existing.source_recipe_version,
          sem_source_ocr_model_id: existing.source_ocr_model_id,
          sem_source_ocr_model_manifest_sha256: existing.source_ocr_model_manifest_sha256,
          sem_source_ocr_language: existing.source_ocr_language,
          sem_normalized_text_sha256: existing.normalized_text_sha256,
          sem_doc_model_id: existing.doc_model_id,
          sem_doc_model_commit: existing.doc_model_commit,
          sem_doc_model_manifest_sha256: existing.doc_model_manifest_sha256,
          sem_chunking_recipe_version: existing.chunking_recipe_version,
          sem_max_content_tokens_per_chunk: existing.max_content_tokens_per_chunk,
          sem_overlap_tokens: existing.overlap_tokens,
          sem_max_chunks_per_document: existing.max_chunks_per_document,
          sem_max_text_chars_for_indexing: existing.max_text_chars_for_indexing,
          current_source_extraction_id: row.ocr_id,
          current_source_recipe_version: row.ocr_recipe_version,
          current_source_text: row.ocr_text,
          current_source_ocr_model_id: row.ocr_model_id,
          current_source_ocr_model_manifest_sha256: row.ocr_model_manifest_sha256,
          current_source_ocr_language: row.ocr_language
        },
        compat,
        'ocr'
      )

    const shouldSkip =
      input.scopeKind === 'unindexed_or_stale' &&
      !input.forceReindex &&
      (compatible || (existing?.status === 'failed' && !input.retryFailed))

    if (!shouldSkip) {
      out.push({
        f: row.file_location_id,
        k: 'ocr',
        e: row.ocr_id,
        d: row.discovery_observation_id,
        r: rev,
        h: normHash
      })
    }
  }

  return out
}

export function writeDocSemanticSnapshotToStagingFile(
  db: DatabaseSync,
  input: DocSemanticSnapshotJobInput,
  stagingFilePath: string
): number {
  const fd = openSync(stagingFilePath, 'w')
  let count = 0

  try {
    const loadTrackMap = (fileIds: readonly number[]): Map<string, TrackRowBrief> => {
      const map = new Map<string, TrackRowBrief>()
      if (fileIds.length === 0) return map
      const placeholders = fileIds.map(() => '?').join(', ')
      const rows = db
        .prepare(
          `SELECT
             file_location_id, text_source_kind, status, is_current,
             discovery_observation_id, content_sha256, observed_byte_size,
             observed_mtime_ms, content_revision, source_extraction_id,
             source_recipe_version, source_ocr_model_id,
             source_ocr_model_manifest_sha256, source_ocr_language,
             normalized_text_sha256, doc_model_id, doc_model_commit,
             doc_model_manifest_sha256, chunking_recipe_version,
             max_content_tokens_per_chunk, overlap_tokens,
             max_chunks_per_document, max_text_chars_for_indexing
           FROM document_semantic_tracks
           WHERE file_location_id IN (${placeholders}) AND is_current = 1;`
        )
        .all(...fileIds) as unknown as TrackRowBrief[]
      for (const t of rows) {
        map.set(`${t.file_location_id}:${t.text_source_kind}`, t)
      }
      return map
    }

    if (input.scopeKind === 'selected') {
      const uniqueIds = Array.from(new Set(input.fileLocationIds ?? [])).sort((a, b) => a - b)
      const BATCH = 250
      let lines: string[] = []
      for (let i = 0; i < uniqueIds.length; i += BATCH) {
        const chunk = uniqueIds.slice(i, i + BATCH)
        const placeholders = chunk.map(() => '?').join(', ')
        const rows = db
          .prepare(
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
               e.extraction_status AS ext_status,
               e.extracted_text AS ext_text,
               o.id AS ocr_id,
               o.discovery_observation_id AS ocr_discovery_observation_id,
               o.content_sha256 AS ocr_content_sha256,
               o.observed_byte_size AS ocr_observed_byte_size,
               o.observed_mtime_ms AS ocr_observed_mtime_ms,
               o.recipe_version AS ocr_recipe_version,
               o.ocr_model_id,
               o.ocr_model_manifest_sha256,
               o.ocr_language,
               o.ocr_status,
               o.extracted_text AS ocr_text
             FROM file_locations f
             JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1
             LEFT JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1
             LEFT JOIN document_extractions e ON e.file_location_id = f.id AND e.is_current = 1
             LEFT JOIN document_ocr_extractions o ON o.file_location_id = f.id AND o.is_current = 1
             WHERE f.category = 'document' AND f.id IN (${placeholders})
             ORDER BY f.id ASC;`
          )
          .all(...chunk) as unknown as SnapshotCandidateRow[]

        const trackMap = loadTrackMap(rows.map((r) => r.file_location_id))
        for (const row of rows) {
          const items = collectEligibleTracksForRow(row, trackMap, input)
          for (const item of items) {
            lines.push(JSON.stringify(item))
            count += 1
            if (lines.length >= 250) {
              writeSync(fd, lines.join('\n') + '\n', null, 'utf8')
              lines = []
            }
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
      const READ_BATCH = 250
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
           e.extraction_status AS ext_status,
           e.extracted_text AS ext_text,
           o.id AS ocr_id,
           o.discovery_observation_id AS ocr_discovery_observation_id,
           o.content_sha256 AS ocr_content_sha256,
           o.observed_byte_size AS ocr_observed_byte_size,
           o.observed_mtime_ms AS ocr_observed_mtime_ms,
           o.recipe_version AS ocr_recipe_version,
           o.ocr_model_id,
           o.ocr_model_manifest_sha256,
           o.ocr_language,
           o.ocr_status,
           o.extracted_text AS ocr_text
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
        const batchRows = selectBatch.all(
          ...params,
          lastFileId,
          READ_BATCH
        ) as unknown as SnapshotCandidateRow[]
        if (batchRows.length === 0) break

        const trackMap = loadTrackMap(batchRows.map((r) => r.file_location_id))
        const lines: string[] = []
        for (const row of batchRows) {
          lastFileId = row.file_location_id
          const items = collectEligibleTracksForRow(row, trackMap, input)
          for (const item of items) {
            lines.push(JSON.stringify(item))
            count += 1
          }
        }
        if (lines.length > 0) {
          writeSync(fd, lines.join('\n') + '\n', null, 'utf8')
        }
      }
    }
  } finally {
    closeSync(fd)
  }

  return count
}
