/**
 * Personal Vault — Stage 7D Document Semantic Repository (`DocumentSemanticRepository`)
 *
 * Manages:
 * - Dual-track (`native` + `ocr`) semantic track & chunk persistence (`Migration 14`)
 * - Strict `normalized_text_sha256` + source/extraction/model/chunk-recipe compatibility
 * - Atomic `BEGIN IMMEDIATE` `REVISION_MISMATCH` stale-commit rejection
 * - Off-main `document_snapshot_worker` scope capture, bounded 250-row insertion,
 *   incomplete-snapshot cleanup, and startup `interrupted` recovery
 * - Exact bounded document-level max-chunk streaming search (`DocTopKMinHeap` +
 *   disk-backed `DatabaseSync('')` fallback) with WAL read snapshot & `finally` cleanup.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import { computeNormalizedTextSha256, normalizeDocumentText } from '../documents/semantic/chunker'
import { DOC_SEMANTIC_EMBEDDING_DIMENSIONS } from '../documents/semantic/manifest'
import {
  rankDocumentChunksStreaming,
  type DocRankOptions,
  type RankedDocResult,
  type StreamedDocChunkCandidate
} from '../documents/semantic/ranking'
import type { DocChunk, DocChunkTruncationReason } from '../documents/semantic/types'
import {
  tryDeserializeDocEmbeddingVector,
  validateAndSerializeDocEmbeddingVector
} from '../documents/semantic/vector'
import { AppWorkerBudget, type WorkerBudgetReservation } from '../worker-budget'
import { resolveMainWorkerScriptPath } from '../worker-path'
import {
  DEFAULT_DOC_SEMANTIC_COMPATIBILITY_SPEC,
  isDocSemanticTrackCompatible,
  type DocSemanticCompatibilitySpec,
  type DocSemanticJobScopeKind,
  type DocSemanticSnapshotItem,
  type DocSemanticSnapshotJobInput,
  type DocSemanticTrackCompatibilityRow,
  type DocTextSourceKind
} from './document-semantic-snapshot-query'
import { buildDocumentContentRevision, buildDocumentFilterSql } from './document-snapshot-query'
import { isObservationTimestampMatching } from '../semantic/vector'
import {
  buildClassificationFilterSql,
  EFFECTIVE_CLASSIFICATION_JOIN_SQL
} from './document-classification-snapshot-query'
import type {
  DocumentClutterFilter,
  DocumentOriginFilter,
  DocumentPurposeFilter
} from '../../../shared/validation/document-schemas'
import { isExtractionRowCompatible } from './document-snapshot-query'
import { isOcrExtractionRowCompatible } from './document-ocr-snapshot-query'
import { DOCUMENT_EXTRACTION_RECIPE_VERSION } from '../documents/types'
import { DOCUMENT_OCR_RECIPE_VERSION } from '../documents/ocr/types'
import {
  OCR_MODEL_ID,
  OCR_MODEL_LANGUAGE,
  PINNED_OCR_MANIFEST_SHA256
} from '../documents/ocr/manifest'

export type DocSemanticTrackStatus = 'indexed' | 'truncated' | 'empty_text' | 'failed'
export type DocSemanticJobStatus =
  'running' | 'paused' | 'completed' | 'cancelled' | 'interrupted' | 'failed'
export type DocSemanticJobItemStatus =
  'pending' | 'indexed' | 'truncated' | 'empty_text' | 'failed' | 'reused' | 'skipped_stale'

export interface DocSemanticCoverage {
  readonly totalExtractableTracks: number
  readonly totalDocumentsWithText: number
  readonly indexedTracks: number
  readonly truncatedTracks: number
  readonly emptyTextTracks: number
  readonly failedTracks: number
  readonly unindexedTracks: number
  readonly staleTracks: number
  readonly corruptChunks: number
  readonly indexedDocuments: number
}

export const EMPTY_DOC_SEMANTIC_COVERAGE: DocSemanticCoverage = {
  totalExtractableTracks: 0,
  totalDocumentsWithText: 0,
  indexedTracks: 0,
  truncatedTracks: 0,
  emptyTextTracks: 0,
  failedTracks: 0,
  unindexedTracks: 0,
  staleTracks: 0,
  corruptChunks: 0,
  indexedDocuments: 0
}

export interface DocSemanticJobRecord {
  readonly id: string
  readonly scopeKind: DocSemanticJobScopeKind
  readonly status: DocSemanticJobStatus
  readonly docModelId: string
  readonly docModelCommit: string
  readonly docModelManifestSha256: string
  readonly chunkingRecipeVersion: string
  readonly filterExtension: string | null
  readonly filterFilenameQuery: string | null
  readonly forceReindex: boolean
  readonly snapshotComplete: boolean
  readonly totalItems: number
  readonly processedItems: number
  readonly indexedItems: number
  readonly truncatedItems: number
  readonly emptyTextItems: number
  readonly failedItems: number
  readonly reusedItems: number
  readonly skippedStaleItems: number
  readonly startedAtMs: number
  readonly updatedAtMs: number
  readonly completedAtMs: number | null
  readonly lastError: string | null
}

export interface DocSemanticPendingItem {
  readonly jobId: string
  readonly fileLocationId: number
  readonly textSourceKind: DocTextSourceKind
  readonly sourceExtractionId: number
  readonly discoveryObservationId: number
  readonly contentRevision: string
  readonly normalizedTextSha256: string
}

export interface DocSemanticTrackSourceData {
  readonly fileLocationId: number
  readonly textSourceKind: DocTextSourceKind
  readonly discoveryObservationId: number
  readonly observedByteSize: number
  readonly observedMtimeMs: number | null
  readonly contentSha256: string
  readonly contentRevision: string
  readonly sourceExtractionId: number
  readonly sourceRecipeVersion: string
  readonly sourceOcrModelId: string | null
  readonly sourceOcrModelManifestSha256: string | null
  readonly sourceOcrLanguage: string | null
  readonly rawText: string
  readonly normalizedText: string
  readonly normalizedTextSha256: string
}

export interface CommitDocSemanticTrackInput {
  readonly jobId: string | null
  readonly fileLocationId: number
  readonly textSourceKind: DocTextSourceKind
  readonly discoveryObservationId: number
  readonly observedByteSize: number
  readonly observedMtimeMs: number | null
  readonly contentSha256: string
  readonly contentRevision: string
  readonly sourceExtractionId: number
  readonly sourceRecipeVersion: string
  readonly sourceOcrModelId: string | null
  readonly sourceOcrModelManifestSha256: string | null
  readonly sourceOcrLanguage: string | null
  readonly normalizedTextSha256: string
  readonly compat: DocSemanticCompatibilitySpec
  readonly status: DocSemanticTrackStatus
  readonly normalizedCharCount: number
  readonly indexedCharCount: number
  readonly coverageRatio: number
  readonly truncated: boolean
  readonly truncationReason: DocChunkTruncationReason
  readonly totalTokenCount: number
  readonly uniqueIndexedTokenCount: number
  readonly emittedChunkTokenSum: number
  readonly chunks: ReadonlyArray<{
    readonly chunk: DocChunk
    readonly vector: Float32Array
  }>
  readonly reused?: boolean
  readonly errorMessage?: string | null
}

/**
 * Exact identity of the winning chunk as scored by the search worker inside its read snapshot.
 * Main-process hydration compares this against the current catalog before showing a result.
 * Internal only — stripped before crossing the IPC boundary.
 */
export interface DocSearchScoredIdentity {
  readonly chunkId: number
  readonly trackId: number
  readonly fileLocationId: number
  readonly textSourceKind: DocTextSourceKind
  readonly discoveryObservationId: number
  readonly observedByteSize: number
  readonly observedMtimeMs: number | null
  readonly activeHash: string | null
  readonly contentSha256: string
  readonly contentRevision: string
  readonly sourceExtractionId: number
  readonly sourceRecipeVersion: string
  readonly sourceOcrModelId: string | null
  readonly sourceOcrModelManifestSha256: string | null
  readonly sourceOcrLanguage: string | null
  readonly normalizedTextSha256: string
  readonly docModelManifestSha256: string
  readonly chunkingRecipeVersion: string
  readonly classificationId: number | null
  readonly classificationRuleVersion: string | null
  readonly classificationInputSha256: string | null
  readonly overrideId: number | null
  readonly overrideVersion: number | null
  readonly overrideDiscoveryObservationId: number | null
}

export interface HydratedDocSearchItem extends RankedDocResult {
  readonly originalPath: string
  readonly fileName: string
  readonly extension: string
  readonly winningSnippet: string
  readonly scoredIdentity?: DocSearchScoredIdentity
}

const DOC_SEARCH_IDENTITY_KEYS: readonly (keyof DocSearchScoredIdentity)[] = [
  'chunkId',
  'trackId',
  'fileLocationId',
  'textSourceKind',
  'discoveryObservationId',
  'observedByteSize',
  'observedMtimeMs',
  'activeHash',
  'contentSha256',
  'contentRevision',
  'sourceExtractionId',
  'sourceRecipeVersion',
  'sourceOcrModelId',
  'sourceOcrModelManifestSha256',
  'sourceOcrLanguage',
  'normalizedTextSha256',
  'docModelManifestSha256',
  'chunkingRecipeVersion',
  'classificationId',
  'classificationRuleVersion',
  'classificationInputSha256',
  'overrideId',
  'overrideVersion',
  'overrideDiscoveryObservationId'
]

function buildDocChunkSearchColumnsSql(includeSourceText: boolean): string {
  return `c.id AS chunk_id,
           c.file_location_id,
           c.text_source_kind,
           c.chunk_index,
           c.char_offset_start,
           c.char_offset_end,
           c.vector_dimensions,
           c.embedding_vector,
           c.doc_model_manifest_sha256 AS chunk_doc_model_manifest_sha256,
           c.chunking_recipe_version AS chunk_chunking_recipe_version,
           d.id AS discovery_observation_id,
           d.byte_size,
           d.filesystem_mtime_ms,
           h.sha256 AS active_hash,
           t.id AS sem_track_id,
           t.is_current AS sem_is_current,
           t.discovery_observation_id AS sem_discovery_observation_id,
           t.content_sha256 AS sem_content_sha256,
           t.observed_byte_size AS sem_observed_byte_size,
           t.observed_mtime_ms AS sem_observed_mtime_ms,
           t.content_revision AS sem_content_revision,
           t.source_extraction_id AS sem_source_extraction_id,
           t.source_recipe_version AS sem_source_recipe_version,
           t.source_ocr_model_id AS sem_source_ocr_model_id,
           t.source_ocr_model_manifest_sha256 AS sem_source_ocr_model_manifest_sha256,
           t.source_ocr_language AS sem_source_ocr_language,
           t.normalized_text_sha256 AS sem_normalized_text_sha256,
           t.doc_model_id AS sem_doc_model_id,
           t.doc_model_commit AS sem_doc_model_commit,
           t.doc_model_manifest_sha256 AS sem_doc_model_manifest_sha256,
           t.chunking_recipe_version AS sem_chunking_recipe_version,
           t.max_content_tokens_per_chunk AS sem_max_content_tokens_per_chunk,
           t.overlap_tokens AS sem_overlap_tokens,
           t.max_chunks_per_document AS sem_max_chunks_per_document,
           t.max_text_chars_for_indexing AS sem_max_text_chars_for_indexing,
           t.truncated AS sem_truncated,
           t.normalized_char_count AS sem_normalized_char_count,
           t.indexed_char_count AS sem_indexed_char_count,
           t.coverage_ratio AS sem_coverage_ratio,
           CASE
             WHEN c.text_source_kind = 'native' THEN e.id
             ELSE o.id
           END AS current_source_extraction_id,
           CASE
             WHEN c.text_source_kind = 'native' THEN e.recipe_version
             ELSE o.recipe_version
           END AS current_source_recipe_version,
           ${
             includeSourceText
               ? `CASE
             WHEN c.text_source_kind = 'native' THEN e.extracted_text
             ELSE o.extracted_text
           END`
               : 'NULL'
           } AS current_source_text,
           CASE
             WHEN c.text_source_kind = 'ocr' THEN o.ocr_model_id
             ELSE NULL
           END AS current_source_ocr_model_id,
           CASE
             WHEN c.text_source_kind = 'ocr' THEN o.ocr_model_manifest_sha256
             ELSE NULL
           END AS current_source_ocr_model_manifest_sha256,
           CASE
             WHEN c.text_source_kind = 'ocr' THEN o.ocr_language
             ELSE NULL
           END AS current_source_ocr_language,
           cls.id AS cls_id,
           cls.rule_version AS cls_rule_version,
           cls.normalized_input_sha256 AS cls_input_sha256,
           clso.id AS clso_id,
           clso.override_version AS clso_override_version,
           clso.discovery_observation_id AS clso_discovery_observation_id`
}

const DOC_CHUNK_SEARCH_FROM_SQL = `FROM document_semantic_chunks c
         JOIN document_semantic_tracks t
           ON t.id = c.track_id AND t.is_current = 1 AND t.status IN ('indexed', 'truncated')
         JOIN file_locations f ON f.id = c.file_location_id
         JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1
         LEFT JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1
         LEFT JOIN document_extractions e
           ON c.text_source_kind = 'native' AND e.file_location_id = f.id AND e.is_current = 1
         LEFT JOIN document_ocr_extractions o
           ON c.text_source_kind = 'ocr' AND o.file_location_id = f.id AND o.is_current = 1
         ${EFFECTIVE_CLASSIFICATION_JOIN_SQL}`

function toDocSemanticCompatRow(raw: Record<string, unknown>): DocSemanticTrackCompatibilityRow {
  const nullableNumber = (v: unknown): number | null =>
    v === null || v === undefined ? null : Number(v)
  const nullableString = (v: unknown): string | null =>
    v === null || v === undefined ? null : String(v)
  return {
    discovery_observation_id: Number(raw.discovery_observation_id),
    byte_size: Number(raw.byte_size),
    filesystem_mtime_ms: nullableNumber(raw.filesystem_mtime_ms),
    active_hash: nullableString(raw.active_hash),
    sem_is_current: Number(raw.sem_is_current),
    sem_discovery_observation_id: Number(raw.sem_discovery_observation_id),
    sem_content_sha256: String(raw.sem_content_sha256),
    sem_observed_byte_size: Number(raw.sem_observed_byte_size),
    sem_observed_mtime_ms: nullableNumber(raw.sem_observed_mtime_ms),
    sem_content_revision: String(raw.sem_content_revision),
    sem_source_extraction_id: Number(raw.sem_source_extraction_id),
    sem_source_recipe_version: String(raw.sem_source_recipe_version),
    sem_source_ocr_model_id: nullableString(raw.sem_source_ocr_model_id),
    sem_source_ocr_model_manifest_sha256: nullableString(raw.sem_source_ocr_model_manifest_sha256),
    sem_source_ocr_language: nullableString(raw.sem_source_ocr_language),
    sem_normalized_text_sha256: String(raw.sem_normalized_text_sha256),
    sem_doc_model_id: String(raw.sem_doc_model_id),
    sem_doc_model_commit: String(raw.sem_doc_model_commit),
    sem_doc_model_manifest_sha256: String(raw.sem_doc_model_manifest_sha256),
    sem_chunking_recipe_version: String(raw.sem_chunking_recipe_version),
    sem_max_content_tokens_per_chunk: Number(raw.sem_max_content_tokens_per_chunk),
    sem_overlap_tokens: Number(raw.sem_overlap_tokens),
    sem_max_chunks_per_document: Number(raw.sem_max_chunks_per_document),
    sem_max_text_chars_for_indexing: Number(raw.sem_max_text_chars_for_indexing),
    current_source_extraction_id: nullableNumber(raw.current_source_extraction_id),
    current_source_recipe_version: nullableString(raw.current_source_recipe_version),
    current_source_text: nullableString(raw.current_source_text),
    current_source_ocr_model_id: nullableString(raw.current_source_ocr_model_id),
    current_source_ocr_model_manifest_sha256: nullableString(
      raw.current_source_ocr_model_manifest_sha256
    ),
    current_source_ocr_language: nullableString(raw.current_source_ocr_language)
  }
}

function toDocSearchScoredIdentity(raw: Record<string, unknown>): DocSearchScoredIdentity {
  const row = toDocSemanticCompatRow(raw)
  return {
    chunkId: Number(raw.chunk_id),
    trackId: Number(raw.sem_track_id),
    fileLocationId: Number(raw.file_location_id),
    textSourceKind: String(raw.text_source_kind) as DocTextSourceKind,
    discoveryObservationId: row.discovery_observation_id,
    observedByteSize: row.byte_size,
    observedMtimeMs: row.filesystem_mtime_ms,
    activeHash: row.active_hash,
    contentSha256: row.sem_content_sha256,
    contentRevision: row.sem_content_revision,
    sourceExtractionId: row.sem_source_extraction_id,
    sourceRecipeVersion: row.sem_source_recipe_version,
    sourceOcrModelId: row.sem_source_ocr_model_id,
    sourceOcrModelManifestSha256: row.sem_source_ocr_model_manifest_sha256,
    sourceOcrLanguage: row.sem_source_ocr_language,
    normalizedTextSha256: row.sem_normalized_text_sha256,
    docModelManifestSha256: String(raw.chunk_doc_model_manifest_sha256),
    chunkingRecipeVersion: String(raw.chunk_chunking_recipe_version),
    classificationId: raw.cls_id === null || raw.cls_id === undefined ? null : Number(raw.cls_id),
    classificationRuleVersion:
      raw.cls_rule_version === null || raw.cls_rule_version === undefined
        ? null
        : String(raw.cls_rule_version),
    classificationInputSha256:
      raw.cls_input_sha256 === null || raw.cls_input_sha256 === undefined
        ? null
        : String(raw.cls_input_sha256),
    overrideId: raw.clso_id === null || raw.clso_id === undefined ? null : Number(raw.clso_id),
    overrideVersion:
      raw.clso_override_version === null || raw.clso_override_version === undefined
        ? null
        : Number(raw.clso_override_version),
    overrideDiscoveryObservationId:
      raw.clso_discovery_observation_id === null || raw.clso_discovery_observation_id === undefined
        ? null
        : Number(raw.clso_discovery_observation_id)
  }
}

export interface DocSemanticSearchResult {
  readonly items: readonly HydratedDocSearchItem[]
  readonly totalMatched: number
  readonly hasMore: boolean
  readonly eligibleChunkCount: number
  readonly corruptChunkCount: number
}

export interface SnapshotCreationOptions {
  readonly jobId: string
  readonly input: DocSemanticSnapshotJobInput
  readonly workerBudget?: AppWorkerBudget
  readonly getExternalLiveWorkers?: () => number
  readonly tryReleaseExternalIdleWorker?: () => Promise<boolean>
  readonly shouldCancel?: () => boolean
  readonly workerScriptPath?: string
  readonly appPath?: string | null
  readonly isPackaged?: boolean
}

const SNAPSHOT_STAGING_PREFIX = '.doc-semantic-snapshot-'

export class DocumentSemanticRepository {
  public constructor(
    private readonly db: DatabaseSync,
    private readonly dbPath?: string
  ) {}

  public cleanupIncompleteSnapshots(): number {
    const res = this.db
      .prepare('DELETE FROM document_semantic_jobs WHERE snapshot_complete = 0;')
      .run()

    if (this.dbPath && this.dbPath !== ':memory:') {
      const dir = dirname(resolve(this.dbPath))
      if (existsSync(dir)) {
        for (const entry of readdirSync(dir)) {
          if (entry.startsWith(SNAPSHOT_STAGING_PREFIX) && entry.endsWith('.tmp')) {
            rmSync(join(dir, entry), { force: true })
          }
        }
      }
    }

    return Number(res.changes ?? 0)
  }

  public markRunningDocumentSemanticJobsAsInterrupted(nowMs = Date.now()): number {
    this.cleanupIncompleteSnapshots()
    const res = this.db
      .prepare(
        `UPDATE document_semantic_jobs
         SET status = 'interrupted', updated_at_ms = ?
         WHERE status = 'running' AND snapshot_complete = 1;`
      )
      .run(nowMs)
    return Number(res.changes ?? 0)
  }

  public async createSnapshotJob(options: SnapshotCreationOptions): Promise<DocSemanticJobRecord> {
    if (!this.dbPath || this.dbPath === ':memory:') {
      throw new Error(
        'DocumentSemanticRepository.createSnapshotJob requires a file-backed SQLite database path'
      )
    }

    const now = Date.now()
    const compat = options.input.compat
    const stagingDir = dirname(resolve(this.dbPath))
    mkdirSync(stagingDir, { recursive: true })
    const stagingFilePath = join(stagingDir, `${SNAPSHOT_STAGING_PREFIX}${options.jobId}.tmp`)

    this.db
      .prepare(
        `INSERT INTO document_semantic_jobs (
           id, scope_kind, status,
           doc_model_id, doc_model_commit, doc_model_manifest_sha256, chunking_recipe_version,
           filter_extension, filter_filename_query, force_reindex,
           snapshot_complete, total_items, processed_items,
           indexed_items, truncated_items, empty_text_items,
           failed_items, reused_items, skipped_stale_items,
           started_at_ms, updated_at_ms
         ) VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, ?, ?);`
      )
      .run(
        options.jobId,
        options.input.scopeKind,
        compat.docModelId,
        compat.docModelCommit,
        compat.docModelManifestSha256,
        compat.chunkingRecipeVersion,
        options.input.extensionFilter ?? null,
        options.input.filenameQuery ?? null,
        options.input.forceReindex ? 1 : 0,
        now,
        now
      )

    try {
      await this.runDocSemanticSnapshotWorker(stagingFilePath, options)

      if (options.shouldCancel?.()) {
        const err = new Error('CANCELLED: Document semantic snapshot cancelled')
        ;(err as Error & { code?: string }).code = 'CANCELLED'
        throw err
      }

      let insertedCount = 0
      if (existsSync(stagingFilePath)) {
        const raw = readFileSync(stagingFilePath, 'utf8')
        const lines = raw.split('\n').filter((l) => l.trim().length > 0)
        const BATCH = 250
        const insertItem = this.db.prepare(
          `INSERT OR IGNORE INTO document_semantic_job_items (
             job_id, file_location_id, text_source_kind,
             source_extraction_id, discovery_observation_id,
             content_revision, normalized_text_sha256,
             status, updated_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?);`
        )

        for (let i = 0; i < lines.length; i += BATCH) {
          if (options.shouldCancel?.()) {
            const err = new Error('CANCELLED: Document semantic snapshot cancelled during insert')
            ;(err as Error & { code?: string }).code = 'CANCELLED'
            throw err
          }
          const slice = lines.slice(i, i + BATCH)
          const batchTime = Date.now()
          this.db.exec('BEGIN IMMEDIATE;')
          try {
            for (const line of slice) {
              const item = JSON.parse(line) as DocSemanticSnapshotItem
              const r = insertItem.run(
                options.jobId,
                item.f,
                item.k,
                item.e,
                item.d,
                item.r,
                item.h,
                batchTime
              )
              insertedCount += Number(r.changes ?? 0)
            }
            this.db.exec('COMMIT;')
          } catch (err) {
            try {
              this.db.exec('ROLLBACK;')
            } catch {
              // ignore rollback error
            }
            throw err
          }
        }
      }

      const finalTime = Date.now()
      this.db
        .prepare(
          `UPDATE document_semantic_jobs
           SET snapshot_complete = 1, total_items = ?, updated_at_ms = ?
           WHERE id = ?;`
        )
        .run(insertedCount, finalTime, options.jobId)

      return this.getJob(options.jobId)!
    } catch (err) {
      this.db.prepare('DELETE FROM document_semantic_jobs WHERE id = ?;').run(options.jobId)
      throw err
    } finally {
      rmSync(stagingFilePath, { force: true })
    }
  }

  private async runDocSemanticSnapshotWorker(
    stagingFilePath: string,
    options: SnapshotCreationOptions
  ): Promise<number> {
    const budget = options.workerBudget ?? new AppWorkerBudget(3)
    const reservation = await this.reserveSnapshotSlot(budget, options)
    let worker: Worker | null = null

    try {
      if (options.shouldCancel?.()) {
        const err = new Error('CANCELLED: Document semantic snapshot cancelled')
        ;(err as Error & { code?: string }).code = 'CANCELLED'
        throw err
      }
      const scriptPath = resolveMainWorkerScriptPath({
        workerFileName: 'document_snapshot_worker.js',
        sourceEntryPath: resolve(process.cwd(), 'src/main/services/documents/snapshot-worker.ts'),
        customPath: options.workerScriptPath,
        moduleDir: __dirname,
        appPath: options.appPath,
        isPackaged: options.isPackaged,
        esbuildExternals: ['electron', 'esbuild']
      })

      worker = new Worker(scriptPath, {
        workerData: {
          kind: 'doc_semantic',
          catalogPath: resolve(this.dbPath!),
          stagingFilePath,
          input: options.input
        }
      })
      budget.promote(reservation, worker)
    } catch (err) {
      if (!worker) {
        budget.releaseReservation(reservation)
      }
      throw err
    }

    const activeWorker = worker
    return await new Promise<number>((resolvePromise, rejectPromise) => {
      let settled = false
      let cancelInProgress = false
      const settleError = (err: Error): void => {
        if (settled) return
        settled = true
        clearInterval(cancelPoll)
        rejectPromise(err)
      }
      const terminateAndAwaitExit = async (): Promise<void> => {
        const exitWait = new Promise<void>((resolveExit) => {
          const fallback = setTimeout(resolveExit, 1_500)
          activeWorker.once('exit', () => {
            clearTimeout(fallback)
            resolveExit()
          })
        })
        try {
          await activeWorker.terminate()
        } catch {
          // ignore termination error; still wait for exit
        }
        await exitWait
      }
      const cancelPoll = setInterval(() => {
        if (options.shouldCancel?.() && !settled && !cancelInProgress) {
          cancelInProgress = true
          clearInterval(cancelPoll)
          void terminateAndAwaitExit().finally(() => {
            const err = new Error('CANCELLED: Document semantic snapshot cancelled')
            ;(err as Error & { code?: string }).code = 'CANCELLED'
            settleError(err)
          })
        }
      }, 25)

      activeWorker.on('message', (msg: { ok: boolean; count?: number; errorMessage?: string }) => {
        if (settled || cancelInProgress) return
        settled = true
        clearInterval(cancelPoll)
        if (msg.ok) {
          resolvePromise(msg.count ?? 0)
        } else {
          rejectPromise(new Error(msg.errorMessage ?? 'Document semantic snapshot worker failed'))
        }
      })

      activeWorker.on('error', (err) => {
        if (settled || cancelInProgress) return
        settleError(err)
      })

      activeWorker.on('exit', (code) => {
        if (settled || cancelInProgress) return
        settleError(new Error(`Document semantic snapshot worker exited with code ${code}`))
      })
    })
  }

  private async reserveSnapshotSlot(
    budget: AppWorkerBudget,
    options: SnapshotCreationOptions
  ): Promise<WorkerBudgetReservation> {
    const deadline = Date.now() + 30_000
    while (true) {
      if (options.shouldCancel?.()) {
        const err = new Error('CANCELLED: Document semantic snapshot admission cancelled')
        ;(err as Error & { code?: string }).code = 'CANCELLED'
        throw err
      }
      let reservation = budget.tryReserve(options.getExternalLiveWorkers)
      if (reservation) return reservation

      if (options.tryReleaseExternalIdleWorker) {
        const released = await options.tryReleaseExternalIdleWorker()
        if (options.shouldCancel?.()) {
          const err = new Error('CANCELLED: Document semantic snapshot admission cancelled')
          ;(err as Error & { code?: string }).code = 'CANCELLED'
          throw err
        }
        if (released) {
          reservation = budget.tryReserve(options.getExternalLiveWorkers)
          if (reservation) return reservation
        }
      }

      if (Date.now() >= deadline) {
        const err = new Error('WORKER_BUDGET_EXHAUSTED: Document semantic snapshot timed out')
        ;(err as Error & { code?: string }).code = 'WORKER_BUDGET_EXHAUSTED'
        throw err
      }
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  public getJob(jobId: string): DocSemanticJobRecord | null {
    const row = this.db.prepare('SELECT * FROM document_semantic_jobs WHERE id = ?;').get(jobId) as
      Record<string, unknown> | undefined
    return row ? this.mapJobRow(row) : null
  }

  public getLatestJob(): DocSemanticJobRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM document_semantic_jobs
         WHERE snapshot_complete = 1
         ORDER BY started_at_ms DESC, rowid DESC
         LIMIT 1;`
      )
      .get() as Record<string, unknown> | undefined
    return row ? this.mapJobRow(row) : null
  }

  public listPendingJobItems(jobId: string, limit = 50): DocSemanticPendingItem[] {
    const rows = this.db
      .prepare(
        `SELECT
           job_id,
           file_location_id,
           text_source_kind,
           source_extraction_id,
           discovery_observation_id,
           content_revision,
           normalized_text_sha256
         FROM document_semantic_job_items
         WHERE job_id = ? AND status = 'pending'
         ORDER BY file_location_id ASC, text_source_kind ASC
         LIMIT ?;`
      )
      .all(jobId, limit) as Array<{
      job_id: string
      file_location_id: number
      text_source_kind: DocTextSourceKind
      source_extraction_id: number
      discovery_observation_id: number
      content_revision: string
      normalized_text_sha256: string
    }>

    return rows.map((r) => ({
      jobId: r.job_id,
      fileLocationId: r.file_location_id,
      textSourceKind: r.text_source_kind,
      sourceExtractionId: r.source_extraction_id,
      discoveryObservationId: r.discovery_observation_id,
      contentRevision: r.content_revision,
      normalizedTextSha256: r.normalized_text_sha256
    }))
  }

  public updateJobStatus(
    jobId: string,
    status: DocSemanticJobStatus,
    lastError: string | null = null,
    nowMs = Date.now()
  ): void {
    const completedAtMs =
      status === 'completed' || status === 'cancelled' || status === 'failed' ? nowMs : null
    this.db
      .prepare(
        `UPDATE document_semantic_jobs
         SET status = ?,
             updated_at_ms = ?,
             completed_at_ms = COALESCE(?, completed_at_ms),
             last_error = COALESCE(?, last_error)
         WHERE id = ?;`
      )
      .run(status, nowMs, completedAtMs, lastError, jobId)
  }

  public markJobItemSkippedStale(
    jobId: string,
    fileLocationId: number,
    textSourceKind: DocTextSourceKind,
    reason = 'REVISION_MISMATCH',
    nowMs = Date.now()
  ): void {
    this.db.exec('BEGIN IMMEDIATE;')
    try {
      const itemRes = this.db
        .prepare(
          `UPDATE document_semantic_job_items
           SET status = 'skipped_stale', error_message = ?, updated_at_ms = ?
           WHERE job_id = ? AND file_location_id = ? AND text_source_kind = ? AND status = 'pending';`
        )
        .run(reason, nowMs, jobId, fileLocationId, textSourceKind)
      if (Number(itemRes.changes ?? 0) > 0) {
        this.db
          .prepare(
            `UPDATE document_semantic_jobs
             SET processed_items = processed_items + 1,
                 skipped_stale_items = skipped_stale_items + 1,
                 updated_at_ms = ?
             WHERE id = ?;`
          )
          .run(nowMs, jobId)
      }
      this.db.exec('COMMIT;')
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;')
      } catch {
        // ignore rollback error
      }
      throw err
    }
  }

  public loadTrackSource(
    fileLocationId: number,
    textSourceKind: DocTextSourceKind
  ): DocSemanticTrackSourceData | null {
    const base = this.db
      .prepare(
        `SELECT
           f.id AS file_location_id,
           d.id AS discovery_observation_id,
           d.byte_size,
           d.filesystem_mtime_ms,
           h.sha256 AS active_hash
         FROM file_locations f
         JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1
         LEFT JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1
         WHERE f.id = ? AND f.category = 'document';`
      )
      .get(fileLocationId) as
      | {
          file_location_id: number
          discovery_observation_id: number
          byte_size: number
          filesystem_mtime_ms: number | null
          active_hash: string | null
        }
      | undefined

    if (!base || !base.active_hash) return null

    const contentRevision = buildDocumentContentRevision({
      discoveryObservationId: base.discovery_observation_id,
      byteSize: base.byte_size,
      filesystemMtimeMs: base.filesystem_mtime_ms,
      activeHash: base.active_hash
    })

    if (textSourceKind === 'native') {
      const ext = this.db
        .prepare(
          `SELECT id, discovery_observation_id, content_sha256, observed_byte_size,
                  observed_mtime_ms, recipe_version, extraction_status, extracted_text
           FROM document_extractions
           WHERE file_location_id = ? AND is_current = 1;`
        )
        .get(fileLocationId) as
        | {
            id: number
            discovery_observation_id: number
            content_sha256: string
            observed_byte_size: number
            observed_mtime_ms: number | null
            recipe_version: string
            extraction_status: string
            extracted_text: string | null
          }
        | undefined

      if (
        !ext ||
        (ext.extraction_status !== 'extracted' && ext.extraction_status !== 'truncated') ||
        ext.extracted_text === null
      ) {
        return null
      }
      if (
        !isExtractionRowCompatible(
          {
            discovery_observation_id: base.discovery_observation_id,
            byte_size: base.byte_size,
            filesystem_mtime_ms: base.filesystem_mtime_ms,
            active_hash: base.active_hash,
            ext_discovery_observation_id: ext.discovery_observation_id,
            ext_content_sha256: ext.content_sha256,
            ext_observed_byte_size: ext.observed_byte_size,
            ext_observed_mtime_ms: ext.observed_mtime_ms,
            ext_recipe_version: ext.recipe_version
          },
          ext.recipe_version
        )
      ) {
        return null
      }

      const normalizedText = normalizeDocumentText(ext.extracted_text)
      return {
        fileLocationId,
        textSourceKind: 'native',
        discoveryObservationId: base.discovery_observation_id,
        observedByteSize: base.byte_size,
        observedMtimeMs: base.filesystem_mtime_ms,
        contentSha256: base.active_hash,
        contentRevision,
        sourceExtractionId: ext.id,
        sourceRecipeVersion: ext.recipe_version,
        sourceOcrModelId: null,
        sourceOcrModelManifestSha256: null,
        sourceOcrLanguage: null,
        rawText: ext.extracted_text,
        normalizedText,
        normalizedTextSha256: computeNormalizedTextSha256(normalizedText)
      }
    }

    const ocr = this.db
      .prepare(
        `SELECT id, discovery_observation_id, content_sha256, observed_byte_size,
                observed_mtime_ms, recipe_version, ocr_model_id, ocr_model_manifest_sha256,
                ocr_language, ocr_status, extracted_text AS ocr_text
         FROM document_ocr_extractions
         WHERE file_location_id = ? AND is_current = 1;`
      )
      .get(fileLocationId) as
      | {
          id: number
          discovery_observation_id: number
          content_sha256: string
          observed_byte_size: number
          observed_mtime_ms: number | null
          recipe_version: string
          ocr_model_id: string
          ocr_model_manifest_sha256: string
          ocr_language: string
          ocr_status: string
          ocr_text: string | null
        }
      | undefined

    if (
      !ocr ||
      (ocr.ocr_status !== 'extracted' && ocr.ocr_status !== 'truncated') ||
      ocr.ocr_text === null
    ) {
      return null
    }
    if (
      !isOcrExtractionRowCompatible(
        {
          discovery_observation_id: base.discovery_observation_id,
          byte_size: base.byte_size,
          filesystem_mtime_ms: base.filesystem_mtime_ms,
          active_hash: base.active_hash,
          ocr_discovery_observation_id: ocr.discovery_observation_id,
          ocr_content_sha256: ocr.content_sha256,
          ocr_observed_byte_size: ocr.observed_byte_size,
          ocr_observed_mtime_ms: ocr.observed_mtime_ms,
          ocr_recipe_version: ocr.recipe_version,
          ocr_model_id: ocr.ocr_model_id,
          ocr_model_manifest_sha256: ocr.ocr_model_manifest_sha256,
          ocr_language: ocr.ocr_language
        },
        {
          recipeVersion: ocr.recipe_version,
          ocrModelId: ocr.ocr_model_id,
          ocrModelManifestSha256: ocr.ocr_model_manifest_sha256,
          ocrLanguage: ocr.ocr_language
        }
      )
    ) {
      return null
    }

    const normalizedText = normalizeDocumentText(ocr.ocr_text)
    return {
      fileLocationId,
      textSourceKind: 'ocr',
      discoveryObservationId: base.discovery_observation_id,
      observedByteSize: base.byte_size,
      observedMtimeMs: base.filesystem_mtime_ms,
      contentSha256: base.active_hash,
      contentRevision,
      sourceExtractionId: ocr.id,
      sourceRecipeVersion: ocr.recipe_version,
      sourceOcrModelId: ocr.ocr_model_id,
      sourceOcrModelManifestSha256: ocr.ocr_model_manifest_sha256,
      sourceOcrLanguage: ocr.ocr_language,
      rawText: ocr.ocr_text,
      normalizedText,
      normalizedTextSha256: computeNormalizedTextSha256(normalizedText)
    }
  }

  public findReusableTrackChunks(options: {
    readonly compat: DocSemanticCompatibilitySpec
    readonly textSourceKind: DocTextSourceKind
    readonly normalizedTextSha256: string
    readonly sourceRecipeVersion: string
    readonly sourceOcrModelId: string | null
    readonly sourceOcrModelManifestSha256: string | null
    readonly sourceOcrLanguage: string | null
  }): {
    readonly status: DocSemanticTrackStatus
    readonly normalizedCharCount: number
    readonly indexedCharCount: number
    readonly coverageRatio: number
    readonly truncated: boolean
    readonly truncationReason: DocChunkTruncationReason
    readonly totalTokenCount: number
    readonly uniqueIndexedTokenCount: number
    readonly emittedChunkTokenSum: number
    readonly chunks: ReadonlyArray<{ readonly chunk: DocChunk; readonly vector: Float32Array }>
  } | null {
    const candidates = this.db
      .prepare(
        `SELECT
           t.*,
           CASE
             WHEN t.text_source_kind = 'native' THEN e.extracted_text
             ELSE o.extracted_text
           END AS source_text
         FROM document_semantic_tracks t
         LEFT JOIN document_extractions e
           ON t.text_source_kind = 'native' AND e.id = t.source_extraction_id
         LEFT JOIN document_ocr_extractions o
           ON t.text_source_kind = 'ocr' AND o.id = t.source_extraction_id
         WHERE t.is_current = 1
           AND t.status IN ('indexed', 'truncated', 'empty_text')
           AND t.text_source_kind = ?
           AND t.normalized_text_sha256 = ?
           AND t.source_recipe_version = ?
           AND t.doc_model_id = ?
           AND t.doc_model_commit = ?
           AND t.doc_model_manifest_sha256 = ?
           AND t.chunking_recipe_version = ?
           AND t.max_content_tokens_per_chunk = ?
           AND t.overlap_tokens = ?
           AND t.max_chunks_per_document = ?
           AND t.max_text_chars_for_indexing = ?
           AND (? = 'native' OR (
             t.source_ocr_model_id = ?
             AND t.source_ocr_model_manifest_sha256 = ?
             AND t.source_ocr_language = ?
           ))
         ORDER BY t.id DESC
         LIMIT 3;`
      )
      .all(
        options.textSourceKind,
        options.normalizedTextSha256,
        options.sourceRecipeVersion,
        options.compat.docModelId,
        options.compat.docModelCommit,
        options.compat.docModelManifestSha256,
        options.compat.chunkingRecipeVersion,
        options.compat.maxContentTokensPerChunk,
        options.compat.overlapTokens,
        options.compat.maxChunksPerDocument,
        options.compat.maxTextCharsForIndexing,
        options.textSourceKind,
        options.sourceOcrModelId,
        options.sourceOcrModelManifestSha256,
        options.sourceOcrLanguage
      ) as Array<Record<string, unknown>>

    for (const track of candidates) {
      const sourceText = track.source_text as string | null
      if (sourceText === null || sourceText === undefined) continue
      const normalized = normalizeDocumentText(sourceText)
      const chunkRows = this.db
        .prepare(
          `SELECT chunk_index, char_offset_start, char_offset_end, content_token_count,
                  vector_dimensions, embedding_vector
           FROM document_semantic_chunks
           WHERE track_id = ? AND is_current = 1
           ORDER BY chunk_index ASC;`
        )
        .all(Number(track.id)) as Array<{
        chunk_index: number
        char_offset_start: number
        char_offset_end: number
        content_token_count: number
        vector_dimensions: number
        embedding_vector: Buffer
      }>

      if (chunkRows.length !== Number(track.chunk_count)) continue

      let corrupt = false
      const hydratedChunks: Array<{ chunk: DocChunk; vector: Float32Array }> = []
      for (const c of chunkRows) {
        if (c.vector_dimensions !== DOC_SEMANTIC_EMBEDDING_DIMENSIONS) {
          corrupt = true
          break
        }
        const vec = tryDeserializeDocEmbeddingVector(
          c.embedding_vector,
          DOC_SEMANTIC_EMBEDDING_DIMENSIONS
        )
        if (!vec) {
          corrupt = true
          break
        }
        hydratedChunks.push({
          chunk: {
            chunkIndex: c.chunk_index,
            charOffsetStart: c.char_offset_start,
            charOffsetEnd: c.char_offset_end,
            contentTokenCount: c.content_token_count,
            text: normalized.slice(c.char_offset_start, c.char_offset_end)
          },
          vector: vec
        })
      }

      if (corrupt) continue

      return {
        status: track.status as DocSemanticTrackStatus,
        normalizedCharCount: Number(track.normalized_char_count),
        indexedCharCount: Number(track.indexed_char_count),
        coverageRatio: Number(track.coverage_ratio),
        truncated: Number(track.truncated) === 1,
        truncationReason: (track.truncation_reason as DocChunkTruncationReason) ?? null,
        totalTokenCount: Number(track.total_token_count),
        uniqueIndexedTokenCount: Number(track.unique_indexed_token_count),
        emittedChunkTokenSum: Number(track.emitted_chunk_token_sum),
        chunks: hydratedChunks
      }
    }

    return null
  }

  public commitTrackChunks(
    input: CommitDocSemanticTrackInput,
    nowMs = Date.now()
  ): { readonly committed: boolean; readonly reason?: 'REVISION_MISMATCH' } {
    const serializedChunks = input.chunks.map((entry) => ({
      chunk: entry.chunk,
      blob: validateAndSerializeDocEmbeddingVector(entry.vector, DOC_SEMANTIC_EMBEDDING_DIMENSIONS)
    }))

    this.db.exec('BEGIN IMMEDIATE;')
    try {
      // Re-verify live catalog observation + source extraction + normalized_text_sha256 atomically
      const liveSource = this.loadTrackSource(input.fileLocationId, input.textSourceKind)
      const isMatch =
        liveSource !== null &&
        liveSource.discoveryObservationId === input.discoveryObservationId &&
        liveSource.observedByteSize === input.observedByteSize &&
        isObservationTimestampMatching(input.observedMtimeMs, liveSource.observedMtimeMs) &&
        liveSource.contentSha256 === input.contentSha256 &&
        liveSource.contentRevision === input.contentRevision &&
        liveSource.sourceExtractionId === input.sourceExtractionId &&
        liveSource.sourceRecipeVersion === input.sourceRecipeVersion &&
        liveSource.sourceOcrModelId === input.sourceOcrModelId &&
        liveSource.sourceOcrModelManifestSha256 === input.sourceOcrModelManifestSha256 &&
        liveSource.sourceOcrLanguage === input.sourceOcrLanguage &&
        liveSource.normalizedTextSha256 === input.normalizedTextSha256

      if (!isMatch) {
        if (input.jobId) {
          const itemRes = this.db
            .prepare(
              `UPDATE document_semantic_job_items
               SET status = 'skipped_stale', error_message = 'REVISION_MISMATCH', updated_at_ms = ?
               WHERE job_id = ? AND file_location_id = ? AND text_source_kind = ? AND status = 'pending';`
            )
            .run(nowMs, input.jobId, input.fileLocationId, input.textSourceKind)
          if (Number(itemRes.changes ?? 0) > 0) {
            this.db
              .prepare(
                `UPDATE document_semantic_jobs
                 SET processed_items = processed_items + 1,
                     skipped_stale_items = skipped_stale_items + 1,
                     updated_at_ms = ?
                 WHERE id = ?;`
              )
              .run(nowMs, input.jobId)
          }
        }
        this.db.exec('COMMIT;')
        return { committed: false, reason: 'REVISION_MISMATCH' }
      }

      // Remove prior chunks/track for (file_location_id, text_source_kind) cleanly
      this.db
        .prepare(
          'DELETE FROM document_semantic_chunks WHERE file_location_id = ? AND text_source_kind = ?;'
        )
        .run(input.fileLocationId, input.textSourceKind)
      this.db
        .prepare(
          'DELETE FROM document_semantic_tracks WHERE file_location_id = ? AND text_source_kind = ?;'
        )
        .run(input.fileLocationId, input.textSourceKind)

      const trackRes = this.db
        .prepare(
          `INSERT INTO document_semantic_tracks (
             file_location_id, text_source_kind,
             discovery_observation_id, content_sha256, observed_byte_size, observed_mtime_ms, content_revision,
             source_extraction_id, source_recipe_version,
             source_ocr_model_id, source_ocr_model_manifest_sha256, source_ocr_language,
             normalized_text_sha256,
             doc_model_id, doc_model_commit, doc_model_manifest_sha256,
             chunking_recipe_version, max_content_tokens_per_chunk, overlap_tokens,
             max_chunks_per_document, max_text_chars_for_indexing,
             status, normalized_char_count, indexed_char_count, coverage_ratio,
             truncated, truncation_reason, total_token_count,
             unique_indexed_token_count, emitted_chunk_token_sum, chunk_count,
             error_message, is_current, indexed_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?);`
        )
        .run(
          input.fileLocationId,
          input.textSourceKind,
          input.discoveryObservationId,
          input.contentSha256,
          input.observedByteSize,
          input.observedMtimeMs,
          input.contentRevision,
          input.sourceExtractionId,
          input.sourceRecipeVersion,
          input.sourceOcrModelId,
          input.sourceOcrModelManifestSha256,
          input.sourceOcrLanguage,
          input.normalizedTextSha256,
          input.compat.docModelId,
          input.compat.docModelCommit,
          input.compat.docModelManifestSha256,
          input.compat.chunkingRecipeVersion,
          input.compat.maxContentTokensPerChunk,
          input.compat.overlapTokens,
          input.compat.maxChunksPerDocument,
          input.compat.maxTextCharsForIndexing,
          input.status,
          input.normalizedCharCount,
          input.indexedCharCount,
          input.coverageRatio,
          input.truncated ? 1 : 0,
          input.truncationReason,
          input.totalTokenCount,
          input.uniqueIndexedTokenCount,
          input.emittedChunkTokenSum,
          serializedChunks.length,
          input.errorMessage ?? null,
          nowMs
        )

      const trackId = Number(trackRes.lastInsertRowid)
      const insertChunk = this.db.prepare(
        `INSERT INTO document_semantic_chunks (
           track_id, file_location_id, text_source_kind,
           discovery_observation_id, content_sha256, observed_byte_size, observed_mtime_ms, content_revision,
           source_extraction_id, source_recipe_version,
           source_ocr_model_id, source_ocr_model_manifest_sha256, source_ocr_language,
           normalized_text_sha256,
           doc_model_id, doc_model_commit, doc_model_manifest_sha256,
           chunking_recipe_version, max_content_tokens_per_chunk, overlap_tokens,
           max_chunks_per_document, max_text_chars_for_indexing,
           chunk_index, char_offset_start, char_offset_end, content_token_count,
           vector_dimensions, embedding_vector, is_current, created_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?);`
      )

      for (const { chunk, blob } of serializedChunks) {
        insertChunk.run(
          trackId,
          input.fileLocationId,
          input.textSourceKind,
          input.discoveryObservationId,
          input.contentSha256,
          input.observedByteSize,
          input.observedMtimeMs,
          input.contentRevision,
          input.sourceExtractionId,
          input.sourceRecipeVersion,
          input.sourceOcrModelId,
          input.sourceOcrModelManifestSha256,
          input.sourceOcrLanguage,
          input.normalizedTextSha256,
          input.compat.docModelId,
          input.compat.docModelCommit,
          input.compat.docModelManifestSha256,
          input.compat.chunkingRecipeVersion,
          input.compat.maxContentTokensPerChunk,
          input.compat.overlapTokens,
          input.compat.maxChunksPerDocument,
          input.compat.maxTextCharsForIndexing,
          chunk.chunkIndex,
          chunk.charOffsetStart,
          chunk.charOffsetEnd,
          chunk.contentTokenCount,
          DOC_SEMANTIC_EMBEDDING_DIMENSIONS,
          blob,
          nowMs
        )
      }

      if (input.jobId) {
        const itemStatus: DocSemanticJobItemStatus = input.reused
          ? 'reused'
          : input.status === 'failed'
            ? 'failed'
            : input.status === 'empty_text'
              ? 'empty_text'
              : input.status === 'truncated'
                ? 'truncated'
                : 'indexed'

        const itemRes = this.db
          .prepare(
            `UPDATE document_semantic_job_items
             SET status = ?, error_message = ?, updated_at_ms = ?
             WHERE job_id = ? AND file_location_id = ? AND text_source_kind = ? AND status = 'pending';`
          )
          .run(
            itemStatus,
            input.errorMessage ?? null,
            nowMs,
            input.jobId,
            input.fileLocationId,
            input.textSourceKind
          )

        if (Number(itemRes.changes ?? 0) > 0) {
          const indexedInc = input.status === 'indexed' || input.status === 'truncated' ? 1 : 0
          const truncatedInc = input.status === 'truncated' ? 1 : 0
          const emptyInc = input.status === 'empty_text' ? 1 : 0
          const failedInc = input.status === 'failed' ? 1 : 0
          const reusedInc = input.reused ? 1 : 0
          this.db
            .prepare(
              `UPDATE document_semantic_jobs
               SET processed_items = processed_items + 1,
                   indexed_items = indexed_items + ?,
                   truncated_items = truncated_items + ?,
                   empty_text_items = empty_text_items + ?,
                   failed_items = failed_items + ?,
                   reused_items = reused_items + ?,
                   updated_at_ms = ?
               WHERE id = ?;`
            )
            .run(indexedInc, truncatedInc, emptyInc, failedInc, reusedInc, nowMs, input.jobId)
        }
      }

      this.db.exec('COMMIT;')
      return { committed: true }
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;')
      } catch {
        // ignore rollback error
      }
      throw err
    }
  }

  public commitTrackFailure(
    options: {
      readonly jobId: string | null
      readonly fileLocationId: number
      readonly textSourceKind: DocTextSourceKind
      readonly errorMessage: string
    },
    nowMs = Date.now()
  ): void {
    if (!options.jobId) return
    this.db.exec('BEGIN IMMEDIATE;')
    try {
      const itemRes = this.db
        .prepare(
          `UPDATE document_semantic_job_items
           SET status = 'failed', error_message = ?, updated_at_ms = ?
           WHERE job_id = ? AND file_location_id = ? AND text_source_kind = ? AND status = 'pending';`
        )
        .run(
          options.errorMessage,
          nowMs,
          options.jobId,
          options.fileLocationId,
          options.textSourceKind
        )
      if (Number(itemRes.changes ?? 0) > 0) {
        this.db
          .prepare(
            `UPDATE document_semantic_jobs
             SET processed_items = processed_items + 1,
                 failed_items = failed_items + 1,
                 updated_at_ms = ?
             WHERE id = ?;`
          )
          .run(nowMs, options.jobId)
      }
      this.db.exec('COMMIT;')
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;')
      } catch {
        // ignore rollback error
      }
      throw err
    }
  }

  public getCoverage(
    compat: DocSemanticCompatibilitySpec = DEFAULT_DOC_SEMANTIC_COMPATIBILITY_SPEC
  ): DocSemanticCoverage {
    let totalExtractableTracks = 0
    let indexedTracks = 0
    let truncatedTracks = 0
    let emptyTextTracks = 0
    let failedTracks = 0
    let unindexedTracks = 0
    let staleTracks = 0
    let corruptChunks = 0
    const docsWithText = new Set<number>()
    const indexedDocs = new Set<number>()

    const nativeRecipe = compat.nativeRecipeVersion ?? DOCUMENT_EXTRACTION_RECIPE_VERSION
    const ocrSpec = {
      recipeVersion: compat.ocrRecipeVersion ?? DOCUMENT_OCR_RECIPE_VERSION,
      ocrModelId: compat.ocrModelId ?? OCR_MODEL_ID,
      ocrModelManifestSha256: compat.ocrModelManifestSha256 ?? PINNED_OCR_MANIFEST_SHA256,
      ocrLanguage: compat.ocrLanguage ?? OCR_MODEL_LANGUAGE
    }

    const docRows = this.db
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
         WHERE f.category = 'document';`
      )
      .iterate() as Iterable<Record<string, unknown>>

    const trackRows = this.db
      .prepare(`SELECT * FROM document_semantic_tracks WHERE is_current = 1;`)
      .all() as Array<Record<string, unknown>>
    const trackMap = new Map<string, Record<string, unknown>>()
    for (const t of trackRows) {
      trackMap.set(`${Number(t.file_location_id)}:${String(t.text_source_kind)}`, t)
    }

    const inspectTrack = (
      docRow: Record<string, unknown>,
      kind: DocTextSourceKind,
      extractionId: number,
      recipeVersion: string,
      sourceText: string,
      ocrModelId: string | null,
      ocrModelManifestSha256: string | null,
      ocrLanguage: string | null
    ): void => {
      const fileId = Number(docRow.file_location_id)
      totalExtractableTracks += 1
      docsWithText.add(fileId)

      const existing = trackMap.get(`${fileId}:${kind}`)
      if (!existing) {
        unindexedTracks += 1
        return
      }

      const compatible = isDocSemanticTrackCompatible(
        {
          discovery_observation_id: Number(docRow.discovery_observation_id),
          byte_size: Number(docRow.byte_size),
          filesystem_mtime_ms:
            docRow.filesystem_mtime_ms === null ? null : Number(docRow.filesystem_mtime_ms),
          active_hash: (docRow.active_hash as string | null) ?? null,
          sem_is_current: Number(existing.is_current),
          sem_discovery_observation_id: Number(existing.discovery_observation_id),
          sem_content_sha256: String(existing.content_sha256),
          sem_observed_byte_size: Number(existing.observed_byte_size),
          sem_observed_mtime_ms:
            existing.observed_mtime_ms === null ? null : Number(existing.observed_mtime_ms),
          sem_content_revision: String(existing.content_revision),
          sem_source_extraction_id: Number(existing.source_extraction_id),
          sem_source_recipe_version: String(existing.source_recipe_version),
          sem_source_ocr_model_id: (existing.source_ocr_model_id as string | null) ?? null,
          sem_source_ocr_model_manifest_sha256:
            (existing.source_ocr_model_manifest_sha256 as string | null) ?? null,
          sem_source_ocr_language: (existing.source_ocr_language as string | null) ?? null,
          sem_normalized_text_sha256: String(existing.normalized_text_sha256),
          sem_doc_model_id: String(existing.doc_model_id),
          sem_doc_model_commit: String(existing.doc_model_commit),
          sem_doc_model_manifest_sha256: String(existing.doc_model_manifest_sha256),
          sem_chunking_recipe_version: String(existing.chunking_recipe_version),
          sem_max_content_tokens_per_chunk: Number(existing.max_content_tokens_per_chunk),
          sem_overlap_tokens: Number(existing.overlap_tokens),
          sem_max_chunks_per_document: Number(existing.max_chunks_per_document),
          sem_max_text_chars_for_indexing: Number(existing.max_text_chars_for_indexing),
          current_source_extraction_id: extractionId,
          current_source_recipe_version: recipeVersion,
          current_source_text: sourceText,
          current_source_ocr_model_id: ocrModelId,
          current_source_ocr_model_manifest_sha256: ocrModelManifestSha256,
          current_source_ocr_language: ocrLanguage
        },
        compat,
        kind
      )

      if (!compatible) {
        staleTracks += 1
        return
      }

      const status = String(existing.status) as DocSemanticTrackStatus
      if (status === 'failed') {
        failedTracks += 1
      } else if (status === 'empty_text') {
        emptyTextTracks += 1
      } else if (status === 'truncated') {
        truncatedTracks += 1
        indexedTracks += 1
        indexedDocs.add(fileId)
      } else if (status === 'indexed') {
        indexedTracks += 1
        indexedDocs.add(fileId)
      }
    }

    for (const row of docRows) {
      if (
        row.ext_id !== null &&
        (row.ext_status === 'extracted' || row.ext_status === 'truncated') &&
        row.ext_text !== null &&
        isExtractionRowCompatible(
          {
            discovery_observation_id: Number(row.discovery_observation_id),
            byte_size: Number(row.byte_size),
            filesystem_mtime_ms:
              row.filesystem_mtime_ms === null ? null : Number(row.filesystem_mtime_ms),
            active_hash: (row.active_hash as string | null) ?? null,
            ext_discovery_observation_id:
              row.ext_discovery_observation_id === null
                ? null
                : Number(row.ext_discovery_observation_id),
            ext_content_sha256: (row.ext_content_sha256 as string | null) ?? null,
            ext_observed_byte_size:
              row.ext_observed_byte_size === null ? null : Number(row.ext_observed_byte_size),
            ext_observed_mtime_ms:
              row.ext_observed_mtime_ms === null ? null : Number(row.ext_observed_mtime_ms),
            ext_recipe_version: (row.ext_recipe_version as string | null) ?? null
          },
          nativeRecipe
        )
      ) {
        inspectTrack(
          row,
          'native',
          Number(row.ext_id),
          String(row.ext_recipe_version),
          String(row.ext_text),
          null,
          null,
          null
        )
      }

      if (
        row.ocr_id !== null &&
        (row.ocr_status === 'extracted' || row.ocr_status === 'truncated') &&
        row.ocr_text !== null &&
        isOcrExtractionRowCompatible(
          {
            discovery_observation_id: Number(row.discovery_observation_id),
            byte_size: Number(row.byte_size),
            filesystem_mtime_ms:
              row.filesystem_mtime_ms === null ? null : Number(row.filesystem_mtime_ms),
            active_hash: (row.active_hash as string | null) ?? null,
            ocr_discovery_observation_id:
              row.ocr_discovery_observation_id === null
                ? null
                : Number(row.ocr_discovery_observation_id),
            ocr_content_sha256: (row.ocr_content_sha256 as string | null) ?? null,
            ocr_observed_byte_size:
              row.ocr_observed_byte_size === null ? null : Number(row.ocr_observed_byte_size),
            ocr_observed_mtime_ms:
              row.ocr_observed_mtime_ms === null ? null : Number(row.ocr_observed_mtime_ms),
            ocr_recipe_version: (row.ocr_recipe_version as string | null) ?? null,
            ocr_model_id: (row.ocr_model_id as string | null) ?? null,
            ocr_model_manifest_sha256: (row.ocr_model_manifest_sha256 as string | null) ?? null,
            ocr_language: (row.ocr_language as string | null) ?? null
          },
          ocrSpec
        )
      ) {
        inspectTrack(
          row,
          'ocr',
          Number(row.ocr_id),
          String(row.ocr_recipe_version),
          String(row.ocr_text),
          String(row.ocr_model_id),
          String(row.ocr_model_manifest_sha256),
          String(row.ocr_language)
        )
      }
    }

    const chunkIter = this.db
      .prepare(
        `SELECT vector_dimensions, embedding_vector
         FROM document_semantic_chunks
         WHERE is_current = 1;`
      )
      .iterate() as Iterable<{ vector_dimensions: number; embedding_vector: Buffer }>

    for (const chunk of chunkIter) {
      if (
        chunk.vector_dimensions !== DOC_SEMANTIC_EMBEDDING_DIMENSIONS ||
        !tryDeserializeDocEmbeddingVector(chunk.embedding_vector, DOC_SEMANTIC_EMBEDDING_DIMENSIONS)
      ) {
        corruptChunks += 1
      }
    }

    return {
      totalExtractableTracks,
      totalDocumentsWithText: docsWithText.size,
      indexedTracks,
      truncatedTracks,
      emptyTextTracks,
      failedTracks,
      unindexedTracks,
      staleTracks,
      corruptChunks,
      indexedDocuments: indexedDocs.size
    }
  }

  /**
   * Reads the identity of a single current, fully compatible chunk (same predicate as search).
   * Returns `null` when the chunk is missing, non-current, or no longer compatible.
   *
   * `verifyNormalizedTextHash: false` skips re-hashing the extraction text; it is only used for
   * main-process revalidation, where equality of the immutable extraction row id and of the
   * track's `normalized_text_sha256` with the worker-verified identity proves the same text.
   */
  public readChunkSearchIdentity(
    chunkId: number,
    compat: DocSemanticCompatibilitySpec = DEFAULT_DOC_SEMANTIC_COMPATIBILITY_SPEC,
    options: { readonly verifyNormalizedTextHash?: boolean } = {}
  ): DocSearchScoredIdentity | null {
    const verifyText = options.verifyNormalizedTextHash !== false
    const raw = this.db
      .prepare(
        `SELECT ${buildDocChunkSearchColumnsSql(verifyText)}
         ${DOC_CHUNK_SEARCH_FROM_SQL}
         WHERE c.id = ?
           AND f.category = 'document'
           AND c.is_current = 1
           AND c.doc_model_manifest_sha256 = ?
           AND c.chunking_recipe_version = ?;`
      )
      .get(chunkId, compat.docModelManifestSha256, compat.chunkingRecipeVersion) as
      Record<string, unknown> | undefined
    if (!raw) return null
    const textSourceKind = String(raw.text_source_kind) as DocTextSourceKind
    if (
      !isDocSemanticTrackCompatible(toDocSemanticCompatRow(raw), compat, textSourceKind, {
        verifyNormalizedTextHash: verifyText
      })
    ) {
      return null
    }
    return toDocSearchScoredIdentity(raw)
  }

  /**
   * Main-process revalidation of a worker-scored item against the current catalog: the winning
   * chunk must still be current and compatible, and every field of the identity actually scored
   * (observation, active hash, content revision, extraction provenance, track, normalized text,
   * model/recipe) must be unchanged. Items without a scored identity fail closed.
   */
  public revalidateScoredSearchItem(
    item: HydratedDocSearchItem,
    compat: DocSemanticCompatibilitySpec = DEFAULT_DOC_SEMANTIC_COMPATIBILITY_SPEC
  ): boolean {
    const scored = item.scoredIdentity
    if (!scored) return false
    if (
      scored.chunkId !== item.winningChunkId ||
      scored.fileLocationId !== item.fileLocationId ||
      scored.textSourceKind !== item.textSourceKind
    ) {
      return false
    }
    const current = this.readChunkSearchIdentity(item.winningChunkId, compat, {
      verifyNormalizedTextHash: false
    })
    if (!current) return false
    return DOC_SEARCH_IDENTITY_KEYS.every((key) => current[key] === scored[key])
  }

  public searchDocumentChunksBounded(
    queryVector: Float32Array,
    options: DocRankOptions & {
      readonly compat?: DocSemanticCompatibilitySpec
      readonly extensionFilter?: string | null
      readonly filenameQuery?: string
      readonly textSourceKindFilter?: DocTextSourceKind | null
      readonly purposeFilter?: DocumentPurposeFilter | null
      readonly originFilter?: DocumentOriginFilter | null
      readonly clutterFilter?: DocumentClutterFilter
    } = {}
  ): DocSemanticSearchResult {
    const compat = options.compat ?? DEFAULT_DOC_SEMANTIC_COMPATIBILITY_SPEC
    const { whereClause, params } = buildDocumentFilterSql({
      extensionFilter: options.extensionFilter ?? null,
      filenameQuery: options.filenameQuery
    })
    const clsFilter = buildClassificationFilterSql({
      purposeFilter: options.purposeFilter,
      originFilter: options.originFilter,
      clutterFilter: options.clutterFilter
    })

    const sourceKindClause = options.textSourceKindFilter ? ' AND c.text_source_kind = ?' : ''
    const clsWhereClause =
      clsFilter.clauses.length > 0 ? ` AND ${clsFilter.clauses.join(' AND ')}` : ''
    const queryParams: SQLInputValue[] = [
      ...params,
      ...clsFilter.params,
      compat.docModelManifestSha256,
      compat.chunkingRecipeVersion
    ]
    if (options.textSourceKindFilter) {
      queryParams.push(options.textSourceKindFilter)
    }

    this.db.exec('BEGIN DEFERRED;')
    try {
      const stmt = this.db.prepare(
        `SELECT ${buildDocChunkSearchColumnsSql(true)}
         ${DOC_CHUNK_SEARCH_FROM_SQL}
         ${whereClause}${clsWhereClause}
           AND c.is_current = 1
           AND c.doc_model_manifest_sha256 = ?
           AND c.chunking_recipe_version = ?${sourceKindClause}
         ORDER BY c.file_location_id ASC, c.id ASC;`
      )

      // O(1) track compatibility cache for the active file_location_id + text_source_kind
      let cachedKey = ''
      let cachedCompatible = false

      function* filterCompatibleChunks(): Iterable<StreamedDocChunkCandidate> {
        for (const raw of stmt.iterate(...queryParams) as Iterable<Record<string, unknown>>) {
          const fileLocationId = Number(raw.file_location_id)
          const textSourceKind = String(raw.text_source_kind) as DocTextSourceKind
          const key = `${fileLocationId}:${textSourceKind}`
          if (key !== cachedKey) {
            cachedKey = key
            cachedCompatible = isDocSemanticTrackCompatible(
              toDocSemanticCompatRow(raw),
              compat,
              textSourceKind
            )
          }

          if (!cachedCompatible) {
            continue
          }

          yield {
            chunkId: Number(raw.chunk_id),
            fileLocationId,
            textSourceKind,
            chunkIndex: Number(raw.chunk_index),
            charOffsetStart: Number(raw.char_offset_start),
            charOffsetEnd: Number(raw.char_offset_end),
            vectorDimensions: Number(raw.vector_dimensions),
            embeddingBlob: raw.embedding_vector as Buffer,
            truncated: Number(raw.sem_truncated) === 1,
            normalizedCharCount: Number(raw.sem_normalized_char_count),
            indexedCharCount: Number(raw.sem_indexed_char_count),
            coverageRatio: Number(raw.sem_coverage_ratio)
          }
        }
      }

      const ranked = rankDocumentChunksStreaming(queryVector, filterCompatibleChunks(), options)

      const hydratedItems: HydratedDocSearchItem[] = []
      const hydrateStmt = this.db.prepare(
        `SELECT f.original_path, f.file_name, f.extension,
                e.extracted_text, o.extracted_text AS ocr_text
         FROM file_locations f
         LEFT JOIN document_extractions e ON e.file_location_id = f.id AND e.is_current = 1
         LEFT JOIN document_ocr_extractions o ON o.file_location_id = f.id AND o.is_current = 1
         WHERE f.id = ?;`
      )

      for (const item of ranked.items) {
        const meta = hydrateStmt.get(item.fileLocationId) as
          | {
              original_path: string
              file_name: string
              extension: string
              extracted_text: string | null
              ocr_text: string | null
            }
          | undefined
        if (!meta) continue
        const sourceRaw = item.textSourceKind === 'native' ? meta.extracted_text : meta.ocr_text
        const norm = sourceRaw ? normalizeDocumentText(sourceRaw) : ''
        const snippet = norm.slice(item.charOffsetStart, item.charOffsetEnd)
        // Identity actually scored, captured inside the same read snapshot as ranking.
        const scoredIdentity = this.readChunkSearchIdentity(item.winningChunkId, compat)
        hydratedItems.push({
          ...item,
          originalPath: meta.original_path,
          fileName: meta.file_name,
          extension: meta.extension,
          winningSnippet: snippet,
          ...(scoredIdentity ? { scoredIdentity } : {})
        })
      }

      return {
        items: hydratedItems,
        totalMatched: ranked.totalMatched,
        hasMore: ranked.hasMore,
        eligibleChunkCount: ranked.eligibleChunkCount,
        corruptChunkCount: ranked.corruptChunkCount
      }
    } finally {
      try {
        this.db.exec('ROLLBACK;')
      } catch {
        // ignore rollback error
      }
    }
  }

  private mapJobRow(row: Record<string, unknown>): DocSemanticJobRecord {
    return {
      id: String(row.id),
      scopeKind: String(row.scope_kind) as DocSemanticJobScopeKind,
      status: String(row.status) as DocSemanticJobStatus,
      docModelId: String(row.doc_model_id),
      docModelCommit: String(row.doc_model_commit),
      docModelManifestSha256: String(row.doc_model_manifest_sha256),
      chunkingRecipeVersion: String(row.chunking_recipe_version),
      filterExtension: (row.filter_extension as string | null) ?? null,
      filterFilenameQuery: (row.filter_filename_query as string | null) ?? null,
      forceReindex: Number(row.force_reindex) === 1,
      snapshotComplete: Number(row.snapshot_complete) === 1,
      totalItems: Number(row.total_items),
      processedItems: Number(row.processed_items),
      indexedItems: Number(row.indexed_items),
      truncatedItems: Number(row.truncated_items),
      emptyTextItems: Number(row.empty_text_items),
      failedItems: Number(row.failed_items),
      reusedItems: Number(row.reused_items),
      skippedStaleItems: Number(row.skipped_stale_items),
      startedAtMs: Number(row.started_at_ms),
      updatedAtMs: Number(row.updated_at_ms),
      completedAtMs: row.completed_at_ms === null ? null : Number(row.completed_at_ms),
      lastError: (row.last_error as string | null) ?? null
    }
  }
}
