/**
 * Personal Vault — Semantic Photo Search Repository
 *
 * Encapsulates semantic photo-search SQL coverage counting, candidate vector
 * streaming, compatibility verification, corrupt-vector isolation, bounded
 * ranking delegation, and photo record hydration against CatalogDatabase's
 * authoritative SQLite connection.
 */

import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { buildPhotoFilterClauses } from './photo-filter-sql'
import type {
  CatalogFileRecord,
  QueryFileLocationsOptions,
  SemanticSearchCatalogInput,
  SemanticSearchCatalogResult,
  SemanticSearchCatalogResultItem
} from './types'
import {
  tryDeserializeEmbeddingVector,
  isSemanticEmbeddingRecordCompatible
} from '../semantic/vector'
import {
  SEMANTIC_MODEL_ID,
  SEMANTIC_MODEL_COMMIT,
  SEMANTIC_PREPROCESSING_VERSION,
  REQUIRED_MODEL_ARTIFACTS,
  computeManifestSha256
} from '../semantic/manifest'
import { rankCandidatesWithBoundedPaging } from '../semantic/ranking'

const DEFAULT_SEMANTIC_MANIFEST_SHA256 = computeManifestSha256(REQUIRED_MODEL_ARTIFACTS)

export interface SemanticSearchRepositoryDeps {
  /** Returns the authoritative open DatabaseSync connection or throws DatabaseClosedError. */
  readonly getDb: () => DatabaseSync
  /** Hydrates a catalog file record by ID using CatalogDatabase's authoritative mapping. */
  readonly getFileLocationById: (id: number) => CatalogFileRecord | null
}

/**
 * Internal repository handling semantic photo search queries and hydration
 * without owning connection lifecycle or transactions.
 */
export class SemanticSearchRepository {
  private readonly deps: SemanticSearchRepositoryDeps

  public constructor(deps: SemanticSearchRepositoryDeps) {
    this.deps = deps
  }

  /**
   * Searches photos by natural-language semantic similarity, applying Stage 5B
   * and Stage 6C SQL filters BEFORE candidate ranking and pagination.
   * Streams candidate vectors using bounded O(K) ranking heap or disk-backed ranker.
   */
  public async searchPhotosSemantic(
    input: SemanticSearchCatalogInput
  ): Promise<SemanticSearchCatalogResult> {
    const db = this.deps.getDb()
    const t0 = performance.now()
    const limit = Math.min(Math.max(1, input.limit ?? 50), 100)
    const offset = Math.max(0, input.offset ?? 0)
    const minScore = input.minScore ?? 0.0
    const modelId = input.modelId ?? SEMANTIC_MODEL_ID
    const modelCommit = input.modelCommit ?? SEMANTIC_MODEL_COMMIT
    const modelManifestSha256 = (
      input.modelManifestSha256 ?? DEFAULT_SEMANTIC_MANIFEST_SHA256
    ).toLowerCase()
    const preprocessingVersion = input.preprocessingVersion ?? SEMANTIC_PREPROCESSING_VERSION

    const filterOptions: QueryFileLocationsOptions = {
      ...input.filters,
      category: 'photo'
    }
    const { conditions, params, techMetaJoinClause, joinParams } =
      buildPhotoFilterClauses(filterOptions)

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const allFilterParams = [...joinParams, ...params]

    const semanticEmbeddingOnClause = `
      se.file_location_id = f.id
       AND se.discovery_observation_id = d.id
       AND se.is_current = 1
       AND se.model_id = ?
       AND se.model_commit = ?
       AND se.model_manifest_sha256 = ?
       AND se.preprocessing_version = ?
       AND se.embedding_dimensions = 512
       AND se.observed_byte_size = d.byte_size
       AND (h.sha256 IS NULL OR h.sha256 = se.content_sha256)
    `
    const semanticModelQueryParams: SQLInputValue[] = [
      modelId,
      modelCommit,
      modelManifestSha256,
      preprocessingVersion
    ]

    // 1. Single aggregate count query for coverage and candidates under current filters
    const countSql = `
      SELECT
        COUNT(*) AS total_filtered_photos,
        COALESCE(SUM(CASE WHEN se.id IS NOT NULL THEN 1 ELSE 0 END), 0) AS candidate_count,
        COALESCE(SUM(CASE
          WHEN se.id IS NULL AND EXISTS (
            SELECT 1 FROM photo_semantic_embeddings h_se
            WHERE h_se.file_location_id = f.id
          ) THEN 1 ELSE 0 END
        ), 0) AS stale_count,
        COALESCE(SUM(CASE
          WHEN se.id IS NULL AND NOT EXISTS (
            SELECT 1 FROM photo_semantic_embeddings h_se
            WHERE h_se.file_location_id = f.id
          ) THEN 1 ELSE 0 END
        ), 0) AS unindexed_count
      FROM file_locations f
      JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1
      LEFT JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1
      LEFT JOIN photo_semantic_embeddings se
        ON ${semanticEmbeddingOnClause}
      LEFT JOIN photo_annotations a ON a.file_location_id = f.id AND a.is_current = 1
        AND (a.discovery_observation_id = d.id OR (a.content_sha256 IS NOT NULL AND h.sha256 IS NOT NULL AND a.content_sha256 = h.sha256))
      ${techMetaJoinClause}
      ${whereClause};
    `
    const countRow = db.prepare(countSql).get(...semanticModelQueryParams, ...allFilterParams) as
      Record<string, unknown> | undefined

    const sqlCandidateCount = Number(countRow?.candidate_count ?? 0)
    const sqlStaleCount = Number(countRow?.stale_count ?? 0)
    const unindexedCount = Number(countRow?.unindexed_count ?? 0)

    if (sqlCandidateCount === 0) {
      return {
        items: [],
        totalMatched: 0,
        eligibleCount: 0,
        unindexedCount,
        staleCount: sqlStaleCount,
        corruptCount: 0,
        offset,
        limit,
        hasMore: false,
        queryLatencyMs: performance.now() - t0
      }
    }

    // 2. Stream candidate embedding vectors with exact canonical revision & timestamp checks
    const candidatesSql = `
      SELECT
        f.id AS file_location_id,
        d.id AS discovery_observation_id,
        d.byte_size AS discovery_byte_size,
        d.filesystem_mtime_ms,
        h.sha256 AS active_hash,
        se.content_sha256,
        se.content_revision,
        se.observed_byte_size,
        se.observed_mtime_ms,
        se.embedding_blob
      FROM file_locations f
      JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1
      LEFT JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1
      JOIN photo_semantic_embeddings se
        ON ${semanticEmbeddingOnClause}
      LEFT JOIN photo_annotations a ON a.file_location_id = f.id AND a.is_current = 1
        AND (a.discovery_observation_id = d.id OR (a.content_sha256 IS NOT NULL AND h.sha256 IS NOT NULL AND a.content_sha256 = h.sha256))
      ${techMetaJoinClause}
      ${whereClause}
      ORDER BY f.id ASC;
    `

    const stmt = db.prepare(candidatesSql)
    const cursor = stmt.iterate(...semanticModelQueryParams, ...allFilterParams) as Iterable<{
      file_location_id: number
      discovery_observation_id: number
      discovery_byte_size: number
      filesystem_mtime_ms: number | null
      active_hash: string | null
      content_sha256: string
      content_revision: string
      observed_byte_size: number
      observed_mtime_ms: number | null
      embedding_blob: Buffer | Uint8Array
    }>

    let validEligibleCount = 0
    let extraStaleCount = 0
    let corruptCount = 0

    function* streamCandidates() {
      for (const row of cursor) {
        if (
          !isSemanticEmbeddingRecordCompatible({
            discoveryObservationId: row.discovery_observation_id,
            discoveryByteSize: row.discovery_byte_size,
            filesystemMtimeMs: row.filesystem_mtime_ms,
            activeHash: row.active_hash,
            contentSha256: row.content_sha256,
            contentRevision: row.content_revision,
            observedByteSize: row.observed_byte_size,
            observedMtimeMs: row.observed_mtime_ms
          })
        ) {
          extraStaleCount++
          continue
        }

        const vector = tryDeserializeEmbeddingVector(row.embedding_blob)
        if (!vector) {
          corruptCount++
          continue
        }

        validEligibleCount++
        yield {
          fileLocationId: row.file_location_id,
          vector
        }
      }
    }

    const rankResult = rankCandidatesWithBoundedPaging(input.queryVector, streamCandidates(), {
      limit,
      offset,
      minScore
    })

    // 3. Hydrate top-K photos
    const items: SemanticSearchCatalogResultItem[] = []
    for (let i = 0; i < rankResult.items.length; i++) {
      const match = rankResult.items[i]
      if (match) {
        const photo = this.deps.getFileLocationById(match.fileLocationId)
        if (photo && photo.category === 'photo' && photo.discoveryObservationId > 0) {
          items.push({
            photo,
            score: match.score,
            rank: offset + i + 1
          })
        }
      }
    }

    return {
      items,
      totalMatched: rankResult.totalMatched,
      eligibleCount: validEligibleCount,
      unindexedCount,
      staleCount: sqlStaleCount + extraStaleCount,
      corruptCount,
      offset,
      limit,
      hasMore: rankResult.hasMore,
      queryLatencyMs: performance.now() - t0
    }
  }
}
