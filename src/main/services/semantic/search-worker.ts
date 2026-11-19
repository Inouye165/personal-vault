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
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { embedQueryText, releaseTextSession } from './text-embedder'
import { applySearchTestBarrier } from '../search-test-barrier'
import { rankCandidatesWithBoundedPaging, type RankCandidate } from './ranking'
import { tryDeserializeEmbeddingVector, isSemanticEmbeddingRecordCompatible } from './vector'
import {
  SEMANTIC_MODEL_ID,
  SEMANTIC_MODEL_COMMIT,
  SEMANTIC_PREPROCESSING_VERSION,
  REQUIRED_MODEL_ARTIFACTS,
  computeManifestSha256
} from './manifest'
import type { QueryFileLocationsOptions } from '../catalog/types'
import { METADATA_PARSER_RECIPE_VERSION } from '../metadata/types'

const DEFAULT_SEMANTIC_MANIFEST_SHA256 = computeManifestSha256(REQUIRED_MODEL_ARTIFACTS)

let lastVerifiedSnapshot: string | null = null

export async function verifyModelDirIntegrity(
  modelDir: string
): Promise<{ ok: boolean; error?: string; snapshotKey?: string }> {
  try {
    if (!existsSync(modelDir)) {
      lastVerifiedSnapshot = null
      await releaseTextSession()
      return { ok: false, error: 'Model directory does not exist' }
    }
    const stat = lstatSync(modelDir)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      lastVerifiedSnapshot = null
      await releaseTextSession()
      return { ok: false, error: 'Model directory is not a canonical directory' }
    }

    const canonicalModelDir = realpathSync(modelDir)
    const dirPrefix = canonicalModelDir.endsWith(sep) ? canonicalModelDir : canonicalModelDir + sep

    const verifiedDigests: string[] = []

    for (const spec of REQUIRED_MODEL_ARTIFACTS) {
      const filePath = join(canonicalModelDir, spec.relativePath)
      if (!existsSync(filePath)) {
        lastVerifiedSnapshot = null
        await releaseTextSession()
        return { ok: false, error: `Missing required model artifact: ${spec.relativePath}` }
      }
      const fileStat = lstatSync(filePath)
      if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
        lastVerifiedSnapshot = null
        await releaseTextSession()
        return { ok: false, error: `Artifact is not a regular file: ${spec.relativePath}` }
      }
      const canonicalFile = realpathSync(filePath)
      if (!canonicalFile.startsWith(dirPrefix)) {
        lastVerifiedSnapshot = null
        await releaseTextSession()
        return {
          ok: false,
          error: `Artifact path escapes model directory: ${spec.relativePath}`
        }
      }
      if (fileStat.size !== spec.byteSize) {
        lastVerifiedSnapshot = null
        await releaseTextSession()
        return {
          ok: false,
          error: `Artifact byte size mismatch for ${spec.relativePath}: expected ${spec.byteSize}, got ${fileStat.size}`
        }
      }
      const handle = await open(canonicalFile, 'r')
      try {
        const hash = createHash('sha256')
        const buf = Buffer.allocUnsafe(64 * 1024)
        let totalRead = 0
        while (true) {
          const { bytesRead } = await handle.read(buf, 0, buf.length, totalRead)
          if (bytesRead <= 0) break
          hash.update(buf.subarray(0, bytesRead))
          totalRead += bytesRead
        }
        if (totalRead !== spec.byteSize) {
          lastVerifiedSnapshot = null
          await releaseTextSession()
          return { ok: false, error: `Artifact read size mismatch for ${spec.relativePath}` }
        }
        const digestHex = hash.digest('hex').toLowerCase()
        if (digestHex !== spec.sha256.toLowerCase()) {
          lastVerifiedSnapshot = null
          await releaseTextSession()
          return { ok: false, error: `Artifact digest mismatch for ${spec.relativePath}` }
        }
        verifiedDigests.push(`${spec.relativePath}:${digestHex}:${fileStat.mtimeMs}`)
      } finally {
        await handle.close()
      }
    }

    const snapshotKey = `${canonicalModelDir}|${verifiedDigests.join('|')}`
    if (lastVerifiedSnapshot !== null && lastVerifiedSnapshot !== snapshotKey) {
      await releaseTextSession()
    }
    lastVerifiedSnapshot = snapshotKey
    return { ok: true, snapshotKey }
  } catch (err: unknown) {
    lastVerifiedSnapshot = null
    await releaseTextSession().catch(() => {})
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

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

export interface SearchDatabaseQueryParams {
  readonly catalogPath: string
  readonly queryVector: Float32Array
  readonly filters?: QueryFileLocationsOptions
  readonly limit?: number
  readonly offset?: number
  readonly minScore?: number
  readonly modelId?: string
  readonly modelCommit?: string
  readonly modelManifestSha256?: string
  readonly preprocessingVersion?: string
  readonly onAfterRanking?: () => void
}

export interface SearchDatabaseRankedItem {
  readonly fileLocationId: number
  readonly score: number
  readonly discoveryObservationId: number
  readonly contentSha256: string
  readonly contentRevision: string
  readonly observedByteSize: number
  readonly observedMtimeMs: number | null
}

export interface SearchDatabaseQueryResult {
  readonly rankedItems: readonly SearchDatabaseRankedItem[]
  readonly totalMatched: number
  readonly eligibleCount: number
  readonly unindexedCount: number
  readonly staleCount: number
  readonly corruptCount: number
  readonly offset: number
  readonly limit: number
  readonly hasMore: boolean
}

export function executeSearchDatabaseQuery(
  paramsInput: SearchDatabaseQueryParams
): SearchDatabaseQueryResult {
  const {
    catalogPath,
    queryVector,
    filters = {},
    limit = 50,
    offset = 0,
    minScore = 0.0,
    modelId = SEMANTIC_MODEL_ID,
    modelCommit = SEMANTIC_MODEL_COMMIT,
    modelManifestSha256 = DEFAULT_SEMANTIC_MANIFEST_SHA256,
    preprocessingVersion = SEMANTIC_PREPROCESSING_VERSION,
    onAfterRanking
  } = paramsInput

  const db = new DatabaseSync(catalogPath, { readOnly: true })
  let inReadTransaction = false
  try {
    db.exec('BEGIN DEFERRED;')
    inReadTransaction = true

    const filterOptions: QueryFileLocationsOptions = {
      ...filters,
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
      modelManifestSha256.toLowerCase(),
      preprocessingVersion
    ]

    // 1. Coverage & candidate count query
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
        rankedItems: [],
        totalMatched: 0,
        eligibleCount: 0,
        unindexedCount,
        staleCount: sqlStaleCount,
        corruptCount: 0,
        offset,
        limit,
        hasMore: false
      }
    }

    // 2. Stream candidates with exact canonical revision & timestamp verification
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

    function* streamCandidates(): Generator<RankCandidate> {
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
          vector,
          identity: {
            discoveryObservationId: row.discovery_observation_id,
            contentSha256: row.content_sha256,
            contentRevision: row.content_revision,
            observedByteSize: row.observed_byte_size,
            observedMtimeMs: row.observed_mtime_ms
          }
        }
      }
    }

    const rankResult = rankCandidatesWithBoundedPaging(queryVector, streamCandidates(), {
      limit,
      offset,
      minScore
    })

    if (onAfterRanking) {
      onAfterRanking()
    }

    const rankedItems = rankResult.items.map((item) => ({
      fileLocationId: item.fileLocationId,
      score: item.score,
      discoveryObservationId: item.identity?.discoveryObservationId ?? 0,
      contentSha256: item.identity?.contentSha256 ?? '',
      contentRevision: item.identity?.contentRevision ?? '',
      observedByteSize: item.identity?.observedByteSize ?? 0,
      observedMtimeMs: item.identity?.observedMtimeMs ?? null
    }))

    return {
      rankedItems,
      totalMatched: rankResult.totalMatched,
      eligibleCount: validEligibleCount,
      unindexedCount,
      staleCount: sqlStaleCount + extraStaleCount,
      corruptCount,
      offset,
      limit,
      hasMore: rankResult.hasMore
    }
  } finally {
    if (inReadTransaction) {
      try {
        db.exec('ROLLBACK;')
      } catch {
        // ignore rollback error on cleanup
      }
    }
    try {
      db.close()
    } catch {
      // ignore close error on cleanup
    }
  }
}

if (parentPort) {
  parentPort.on(
    'message',
    async (message: {
      id: number
      action: 'embed_text' | 'search_database' | 'search' | 'release_session' | 'ping'
      modelDir?: string
      queryText?: string
      catalogPath?: string
      queryVector?: Float32Array
      filters?: QueryFileLocationsOptions
      limit?: number
      offset?: number
      minScore?: number
      modelId?: string
      modelCommit?: string
      modelManifestSha256?: string
      preprocessingVersion?: string
    }) => {
      try {
        if (message.action === 'ping') {
          parentPort!.postMessage({ id: message.id, status: 'pong' })
          return
        }

        if (message.action === 'release_session') {
          await releaseTextSession()
          parentPort!.postMessage({ id: message.id, status: 'released' })
          return
        }

        if (message.action === 'embed_text') {
          if (!message.modelDir) {
            parentPort!.postMessage({
              id: message.id,
              status: 'error',
              code: 'INVALID_PARAMS',
              message: 'Missing modelDir'
            })
            return
          }
          const verify = await verifyModelDirIntegrity(message.modelDir)
          if (!verify.ok) {
            parentPort!.postMessage({
              id: message.id,
              status: 'error',
              code: 'MODEL_CORRUPT',
              message: verify.error ?? 'Model integrity verification failed'
            })
            return
          }
          await applySearchTestBarrier('clip', message.queryText ?? '')
          const res = await embedQueryText({
            modelDir: message.modelDir,
            queryText: message.queryText ?? ''
          })
          parentPort!.postMessage({ id: message.id, ...res })
          return
        }

        if (message.action === 'search_database' || message.action === 'search') {
          const t0 = performance.now()
          const testSearchDelayMs = Number(process.env.PV_TEST_SEARCH_DELAY_MS ?? 0)
          if (Number.isFinite(testSearchDelayMs) && testSearchDelayMs > 0) {
            await new Promise((r) => setTimeout(r, testSearchDelayMs))
          }
          const {
            catalogPath,
            filters = {},
            limit = 50,
            offset = 0,
            minScore = 0.0,
            modelId = SEMANTIC_MODEL_ID,
            modelCommit = SEMANTIC_MODEL_COMMIT,
            modelManifestSha256 = DEFAULT_SEMANTIC_MANIFEST_SHA256,
            preprocessingVersion = SEMANTIC_PREPROCESSING_VERSION
          } = message

          if (!catalogPath) {
            parentPort!.postMessage({
              id: message.id,
              status: 'error',
              code: 'INVALID_PARAMS',
              message: 'Missing catalogPath'
            })
            return
          }

          let activeVector = message.queryVector
          let truncated = false
          let tokenCount = 0

          if (!activeVector) {
            if (!message.modelDir || message.queryText === undefined) {
              parentPort!.postMessage({
                id: message.id,
                status: 'error',
                code: 'INVALID_PARAMS',
                message: 'Must provide either queryVector or modelDir and queryText'
              })
              return
            }

            const verify = await verifyModelDirIntegrity(message.modelDir)
            if (!verify.ok) {
              parentPort!.postMessage({
                id: message.id,
                status: 'error',
                code: 'MODEL_CORRUPT',
                message: verify.error ?? 'Model integrity verification failed'
              })
              return
            }

            const embedRes = await embedQueryText({
              modelDir: message.modelDir,
              queryText: message.queryText
            })

            if (embedRes.status !== 'ready') {
              parentPort!.postMessage({
                id: message.id,
                status: 'error',
                code: embedRes.code ?? 'EMBED_FAILED',
                message: embedRes.message ?? 'Failed to embed query text'
              })
              return
            }

            activeVector = embedRes.vector
            truncated = embedRes.truncated
            tokenCount = embedRes.tokenCount
          }

          const searchRes = executeSearchDatabaseQuery({
            catalogPath,
            queryVector: activeVector,
            filters,
            limit,
            offset,
            minScore,
            modelId,
            modelCommit,
            modelManifestSha256,
            preprocessingVersion
          })

          parentPort!.postMessage({
            id: message.id,
            status: 'ready',
            ...searchRes,
            queryLatencyMs: performance.now() - t0,
            queryVector: activeVector,
            truncated,
            tokenCount
          })
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
