/**
 * Personal Vault — Semantic Search Worker Thread (Stage 6D)
 *
 * Runs off the Electron main thread.
 * Handles:
 * - Text tokenization and CPU ONNX text embedding inference (never loads vision model).
 * - Exact cosine similarity ranking over candidate vectors with bounded heap.
 * - Read-only SQLite streaming scan when catalogPath is provided.
 */

import { parentPort } from 'node:worker_threads'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { embedQueryText, releaseTextSession } from './text-embedder'
import { rankCandidates, type RankCandidate } from './ranking'
import { deserializeEmbeddingVector } from './vector'
import { SEMANTIC_MODEL_ID, SEMANTIC_PREPROCESSING_VERSION } from './manifest'
import type { QueryFileLocationsOptions } from '../catalog/types'
import { METADATA_PARSER_RECIPE_VERSION } from '../metadata/types'

function buildPhotoFilterClauses(options: QueryFileLocationsOptions): {
  conditions: string[]
  params: SQLInputValue[]
  techMetaJoinClause: string
  joinParams: SQLInputValue[]
} {
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

  if (options.ratingFilter && options.ratingFilter !== 'all') {
    if (options.ratingFilter === 'unrated') {
      conditions.push('(a.rating IS NULL OR a.id IS NULL)')
    } else if (options.ratingFilter === '1') {
      conditions.push('a.rating >= 1')
    } else if (options.ratingFilter === '2') {
      conditions.push('a.rating >= 2')
    } else if (options.ratingFilter === '3') {
      conditions.push('a.rating >= 3')
    } else if (options.ratingFilter === '4') {
      conditions.push('a.rating >= 4')
    } else if (options.ratingFilter === '5') {
      conditions.push('a.rating = 5')
    }
  }

  if (options.flagFilter && options.flagFilter !== 'all') {
    if (options.flagFilter === 'none') {
      conditions.push("(a.flag = 'none' OR a.flag IS NULL OR a.id IS NULL)")
    } else if (options.flagFilter === 'pick') {
      conditions.push("a.flag = 'pick'")
    } else if (options.flagFilter === 'reject') {
      conditions.push("a.flag = 'reject'")
    }
  }

  if (typeof options.collectionId === 'number') {
    conditions.push(`
      EXISTS (
        SELECT 1 FROM collection_memberships cm
        WHERE cm.file_location_id = f.id AND cm.collection_id = ? AND cm.is_current = 1
          AND (cm.discovery_observation_id = d.id OR (cm.content_sha256 IS NOT NULL AND h.sha256 IS NOT NULL AND cm.content_sha256 = h.sha256))
      )
    `)
    params.push(options.collectionId)
  }

  const hasDateRange = Boolean(options.captureDateFrom || options.captureDateTo)
  const hasDateFilter = Boolean(hasDateRange || options.includeUnknownCaptureDate)
  const hasCameraFilter = Boolean(options.cameraNormalized || options.onlyUnknownCamera)
  const hasLensFilter = Boolean(options.lensNormalized || options.onlyUnknownLens)
  const hasMinDimensions =
    typeof options.minWidthPx === 'number' || typeof options.minHeightPx === 'number'
  const hasDimensionFilter = Boolean(hasMinDimensions || options.includeUnknownDimensions)
  const fileTypeBasis = options.fileTypeBasis ?? 'detected_format'
  const hasDetectedFormatFilter =
    fileTypeBasis === 'detected_format' &&
    Boolean(options.fileTypeValue || options.onlyUnknownDetectedFormat)
  const hasExtensionFilter =
    fileTypeBasis === 'filename_extension' && Boolean(options.fileTypeValue)

  const needsTechMetaJoin =
    hasDateFilter ||
    hasCameraFilter ||
    hasLensFilter ||
    hasDimensionFilter ||
    hasDetectedFormatFilter

  const joinParams: SQLInputValue[] = []
  let techMetaJoinClause = ''
  if (needsTechMetaJoin) {
    const recipeVersion = options.parserRecipeVersion ?? METADATA_PARSER_RECIPE_VERSION
    techMetaJoinClause = `
      LEFT JOIN photo_technical_metadata tm
        ON tm.file_location_id = f.id
       AND tm.is_current = 1
       AND tm.parser_recipe_version = ?
       AND tm.discovery_observation_id = d.id
    `
    joinParams.push(recipeVersion)
  }

  if (hasDateFilter) {
    if (hasDateRange && options.includeUnknownCaptureDate) {
      const rangeSub: string[] = [
        "tm.extraction_status IN ('extracted', 'no_metadata')",
        'tm.capture_calendar_date IS NOT NULL'
      ]
      if (options.captureDateFrom) {
        rangeSub.push('tm.capture_calendar_date >= ?')
        params.push(options.captureDateFrom)
      }
      if (options.captureDateTo) {
        rangeSub.push('tm.capture_calendar_date <= ?')
        params.push(options.captureDateTo)
      }
      conditions.push(
        `((${rangeSub.join(' AND ')}) OR (tm.extraction_status IN ('extracted', 'no_metadata') AND tm.capture_calendar_date IS NULL))`
      )
    } else if (hasDateRange) {
      conditions.push("tm.extraction_status IN ('extracted', 'no_metadata')")
      conditions.push('tm.capture_calendar_date IS NOT NULL')
      if (options.captureDateFrom) {
        conditions.push('tm.capture_calendar_date >= ?')
        params.push(options.captureDateFrom)
      }
      if (options.captureDateTo) {
        conditions.push('tm.capture_calendar_date <= ?')
        params.push(options.captureDateTo)
      }
    } else if (options.includeUnknownCaptureDate) {
      conditions.push("tm.extraction_status IN ('extracted', 'no_metadata')")
      conditions.push('tm.capture_calendar_date IS NULL')
    }
  }

  if (hasCameraFilter) {
    if (options.onlyUnknownCamera) {
      conditions.push("tm.extraction_status IN ('extracted', 'no_metadata')")
      conditions.push('tm.camera_normalized IS NULL')
    } else if (options.cameraNormalized) {
      conditions.push("tm.extraction_status IN ('extracted', 'no_metadata')")
      conditions.push('tm.camera_normalized = ?')
      params.push(options.cameraNormalized.trim().toLowerCase())
    }
  }

  if (hasLensFilter) {
    if (options.onlyUnknownLens) {
      conditions.push("tm.extraction_status IN ('extracted', 'no_metadata')")
      conditions.push('tm.lens_normalized IS NULL')
    } else if (options.lensNormalized) {
      conditions.push("tm.extraction_status IN ('extracted', 'no_metadata')")
      conditions.push('tm.lens_normalized = ?')
      params.push(options.lensNormalized.trim().toLowerCase())
    }
  }

  if (hasDimensionFilter) {
    if (hasMinDimensions && options.includeUnknownDimensions) {
      const knownSub: string[] = [
        "tm.extraction_status IN ('extracted', 'no_metadata')",
        'tm.display_width_px IS NOT NULL',
        'tm.display_height_px IS NOT NULL'
      ]
      if (typeof options.minWidthPx === 'number') {
        knownSub.push('tm.display_width_px >= ?')
        params.push(options.minWidthPx)
      }
      if (typeof options.minHeightPx === 'number') {
        knownSub.push('tm.display_height_px >= ?')
        params.push(options.minHeightPx)
      }
      conditions.push(
        `((${knownSub.join(' AND ')}) OR (tm.extraction_status IN ('extracted', 'no_metadata', 'unsupported', 'failed') AND (tm.display_width_px IS NULL OR tm.display_height_px IS NULL)))`
      )
    } else if (hasMinDimensions) {
      conditions.push("tm.extraction_status IN ('extracted', 'no_metadata')")
      conditions.push('tm.display_width_px IS NOT NULL')
      conditions.push('tm.display_height_px IS NOT NULL')
      if (typeof options.minWidthPx === 'number') {
        conditions.push('tm.display_width_px >= ?')
        params.push(options.minWidthPx)
      }
      if (typeof options.minHeightPx === 'number') {
        conditions.push('tm.display_height_px >= ?')
        params.push(options.minHeightPx)
      }
    } else if (options.includeUnknownDimensions) {
      conditions.push(
        "tm.extraction_status IN ('extracted', 'no_metadata', 'unsupported', 'failed')"
      )
      conditions.push('(tm.display_width_px IS NULL OR tm.display_height_px IS NULL)')
    }
  }

  if (hasExtensionFilter && options.fileTypeValue) {
    const trimmedExt = options.fileTypeValue.trim().toLowerCase()
    const normExt = trimmedExt.startsWith('.') ? trimmedExt : `.${trimmedExt}`
    conditions.push('LOWER(f.extension) = ?')
    params.push(normExt)
  } else if (hasDetectedFormatFilter) {
    if (options.onlyUnknownDetectedFormat) {
      conditions.push(
        "tm.extraction_status IN ('extracted', 'no_metadata', 'unsupported', 'failed')"
      )
      conditions.push('tm.detected_format IS NULL')
    } else if (options.fileTypeValue) {
      conditions.push(
        "tm.extraction_status IN ('extracted', 'no_metadata', 'unsupported', 'failed')"
      )
      conditions.push('tm.detected_format = ?')
      params.push(options.fileTypeValue.trim().toLowerCase())
    }
  }

  return { conditions, params, techMetaJoinClause, joinParams }
}

if (parentPort) {
  parentPort.on(
    'message',
    async (message: {
      id: number
      action: 'embed_text' | 'search_database' | 'release_session'
      modelDir?: string
      queryText?: string
      catalogPath?: string
      queryVector?: Float32Array
      filters?: QueryFileLocationsOptions
      limit?: number
      offset?: number
      minScore?: number
      modelId?: string
      preprocessingVersion?: string
    }) => {
      try {
        if (message.action === 'release_session') {
          await releaseTextSession()
          parentPort!.postMessage({ id: message.id, status: 'released' })
          return
        }

        if (message.action === 'embed_text') {
          const res = await embedQueryText({
            modelDir: message.modelDir!,
            queryText: message.queryText!
          })
          parentPort!.postMessage({ id: message.id, ...res })
          return
        }

        if (message.action === 'search_database') {
          const t0 = performance.now()
          const {
            catalogPath,
            queryVector,
            filters = {},
            limit = 50,
            offset = 0,
            minScore = 0.0,
            modelId = SEMANTIC_MODEL_ID,
            preprocessingVersion = SEMANTIC_PREPROCESSING_VERSION
          } = message

          if (!catalogPath || !queryVector) {
            parentPort!.postMessage({
              id: message.id,
              status: 'error',
              code: 'INVALID_PARAMS',
              message: 'Missing catalogPath or queryVector'
            })
            return
          }

          const db = new DatabaseSync(catalogPath, { readOnly: true })
          try {
            const filterOptions: QueryFileLocationsOptions = {
              ...filters,
              category: 'photo'
            }
            const { conditions, params, techMetaJoinClause, joinParams } =
              buildPhotoFilterClauses(filterOptions)

            const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
            const allFilterParams = [...joinParams, ...params]

            // 1. Coverage & candidate count query
            const countSql = `
              SELECT
                COUNT(*) AS total_filtered_photos,
                COALESCE(SUM(CASE WHEN se.id IS NOT NULL THEN 1 ELSE 0 END), 0) AS eligible_count,
                COALESCE(SUM(CASE
                  WHEN se.id IS NULL AND EXISTS (
                    SELECT 1 FROM photo_semantic_embeddings h
                    WHERE h.file_location_id = f.id
                  ) THEN 1 ELSE 0 END
                ), 0) AS stale_count,
                COALESCE(SUM(CASE
                  WHEN se.id IS NULL AND NOT EXISTS (
                    SELECT 1 FROM photo_semantic_embeddings h
                    WHERE h.file_location_id = f.id
                  ) THEN 1 ELSE 0 END
                ), 0) AS unindexed_count
              FROM file_locations f
              JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1
              LEFT JOIN photo_semantic_embeddings se
                ON se.file_location_id = f.id
               AND se.discovery_observation_id = d.id
               AND se.is_current = 1
               AND se.model_id = ?
               AND se.preprocessing_version = ?
              LEFT JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1
              LEFT JOIN photo_annotations a ON a.file_location_id = f.id AND a.is_current = 1
                AND (a.discovery_observation_id = d.id OR (a.content_sha256 IS NOT NULL AND h.sha256 IS NOT NULL AND a.content_sha256 = h.sha256))
              ${techMetaJoinClause}
              ${whereClause};
            `
            const countRow = db
              .prepare(countSql)
              .get(modelId, preprocessingVersion, ...allFilterParams) as
              Record<string, unknown> | undefined

            const eligibleCount = Number(countRow?.eligible_count ?? 0)
            const staleCount = Number(countRow?.stale_count ?? 0)
            const unindexedCount = Number(countRow?.unindexed_count ?? 0)

            if (eligibleCount === 0) {
              parentPort!.postMessage({
                id: message.id,
                status: 'ready',
                items: [],
                totalMatched: 0,
                eligibleCount: 0,
                unindexedCount,
                staleCount,
                offset,
                limit,
                hasMore: false,
                queryLatencyMs: performance.now() - t0
              })
              return
            }

            // 2. Stream candidates
            const candidatesSql = `
              SELECT
                f.id AS file_location_id,
                se.embedding_blob
              FROM file_locations f
              JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1
              JOIN photo_semantic_embeddings se
                ON se.file_location_id = f.id
               AND se.discovery_observation_id = d.id
               AND se.is_current = 1
               AND se.model_id = ?
               AND se.preprocessing_version = ?
              LEFT JOIN hash_observations h ON h.discovery_observation_id = d.id AND h.is_active = 1
              LEFT JOIN photo_annotations a ON a.file_location_id = f.id AND a.is_current = 1
                AND (a.discovery_observation_id = d.id OR (a.content_sha256 IS NOT NULL AND h.sha256 IS NOT NULL AND a.content_sha256 = h.sha256))
              ${techMetaJoinClause}
              ${whereClause}
              ORDER BY f.id ASC;
            `
            const stmt = db.prepare(candidatesSql)
            const cursor = stmt.iterate(
              modelId,
              preprocessingVersion,
              ...allFilterParams
            ) as Iterable<{
              file_location_id: number
              embedding_blob: Buffer | Uint8Array
            }>

            function* streamCandidates(): Generator<RankCandidate> {
              for (const row of cursor) {
                const vector = deserializeEmbeddingVector(row.embedding_blob)
                yield {
                  fileLocationId: row.file_location_id,
                  vector
                }
              }
            }

            const rankResult = rankCandidates(queryVector, streamCandidates(), {
              limit,
              offset,
              minScore
            })

            parentPort!.postMessage({
              id: message.id,
              status: 'ready',
              rankedItems: rankResult.items,
              totalMatched: rankResult.totalMatched,
              eligibleCount,
              unindexedCount,
              staleCount,
              offset,
              limit,
              hasMore: rankResult.hasMore,
              queryLatencyMs: performance.now() - t0
            })
          } finally {
            db.close()
          }
          return
        }

        parentPort!.postMessage({
          id: message.id,
          status: 'error',
          code: 'UNKNOWN_ACTION',
          message: `Unknown search worker action: ${message.action}`
        })
      } catch (err: unknown) {
        parentPort!.postMessage({
          id: message.id,
          status: 'error',
          code: 'WORKER_INTERNAL_ERROR',
          message: err instanceof Error ? err.message : String(err)
        })
      }
    }
  )
}
