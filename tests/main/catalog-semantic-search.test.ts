// @vitest-environment node
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { CatalogDatabase } from '../../src/main/services/catalog/database'
import {
  SEMANTIC_EMBEDDING_DIMENSIONS,
  SEMANTIC_MODEL_ID,
  SEMANTIC_MODEL_COMMIT,
  SEMANTIC_PREPROCESSING_VERSION,
  computeManifestSha256,
  REQUIRED_MODEL_ARTIFACTS
} from '../../src/main/services/semantic/manifest'
import { normalizeEmbeddingVector } from '../../src/main/services/semantic/vector'
import { METADATA_PARSER_RECIPE_VERSION } from '../../src/main/services/metadata/types'

describe('Stage 6D: Catalog Semantic Search - Filter-Before-Ranking & Invalidation', () => {
  let tempDir: string
  let catalogPath: string
  let catalog: CatalogDatabase
  const manifestSha256 = computeManifestSha256(REQUIRED_MODEL_ARTIFACTS)

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pv-test-sem-search-'))
    catalogPath = join(tempDir, 'catalog.sqlite')
    catalog = CatalogDatabase.open({ catalogPath })
  })

  afterEach(() => {
    try {
      catalog.close()
    } catch {
      // ignore
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  function makeVector(seed: number): Float32Array {
    const raw = new Float32Array(SEMANTIC_EMBEDDING_DIMENSIONS)
    for (let i = 0; i < SEMANTIC_EMBEDDING_DIMENSIONS; i++) {
      raw[i] = Math.sin(seed * (i + 1))
    }
    return normalizeEmbeddingVector(raw)
  }

  function createTestPhotoWithEmbedding(params: {
    fileName: string
    rating?: number | null
    flag?: 'none' | 'pick' | 'reject'
    cameraNormalized?: string | null
    captureCalendarDate?: string | null
    isCurrentEmbedding?: boolean
    modelId?: string
    preprocessingVersion?: string
    vector: Float32Array
  }): number {
    const originalPath = join(tempDir, params.fileName)
    catalog.persistDiscoveryBatch(tempDir, [
      {
        originalPath,
        fileName: params.fileName,
        extension: '.jpg',
        category: 'photo',
        byteSize: 1024,
        birthtimeMs: 1700000000000,
        mtimeMs: 1700000000000,
        discoveredAtMs: 1700000000000
      }
    ])

    const sha256 = 'a'.repeat(64)
    catalog.recordHashObservation({
      originalPath,
      sha256,
      observedByteSize: 1024,
      observedMtimeMs: 1700000000000,
      hashedAtMs: 1700000000000
    })

    const loc = catalog.getFileLocationByPath(originalPath)!

    if (params.rating !== undefined || params.flag !== undefined) {
      catalog.setPhotoAnnotation({
        fileLocationId: loc.id,
        rating: params.rating ?? null,
        flag: params.flag ?? 'none',
        expectedRevision: `rev:${loc.discoveryObservationId}:1024:1700000000000:${sha256}`,
        expectedVersion: 0
      })
    }

    if (params.cameraNormalized !== undefined || params.captureCalendarDate !== undefined) {
      ;(
        catalog as unknown as {
          db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } }
        }
      ).db
        .prepare(
          `
        INSERT INTO photo_technical_metadata (
          file_location_id, discovery_observation_id, parser_recipe_version, extraction_status,
          content_sha256, content_revision, observed_byte_size, observed_mtime_ms,
          recorded_extension, detected_format, extension_format_mismatch,
          camera_normalized, capture_calendar_date, created_at_ms, is_current
        ) VALUES (
          ?, ?, ?, 'extracted',
          ?, ?, 1024, 1700000000000,
          '.jpg', 'jpeg', 0,
          ?, ?, 1700000000000, 1
        );
      `
        )
        .run(
          loc.id,
          loc.discoveryObservationId,
          METADATA_PARSER_RECIPE_VERSION,
          sha256,
          `rev:${loc.discoveryObservationId}:1024:1700000000000:${sha256}`,
          params.cameraNormalized ?? null,
          params.captureCalendarDate ?? null
        )
    }

    // Save semantic embedding
    catalog.savePhotoSemanticEmbedding({
      fileId: loc.id,
      fileLocationId: loc.id,
      discoveryObservationId: loc.discoveryObservationId,
      contentSha256: sha256,
      contentRevision: `rev:${loc.discoveryObservationId}:1024:1700000000000:${sha256}`,
      sourcePath: loc.originalPath,
      observedByteSize: 1024,
      observedMtimeMs: 1700000000000,
      modelId: params.modelId ?? SEMANTIC_MODEL_ID,
      modelCommit: SEMANTIC_MODEL_COMMIT,
      modelManifestSha256: manifestSha256,
      preprocessingVersion: params.preprocessingVersion ?? SEMANTIC_PREPROCESSING_VERSION,
      embeddingDimensions: SEMANTIC_EMBEDDING_DIMENSIONS,
      vector: params.vector
    })

    if (params.isCurrentEmbedding === false) {
      // Mark as not current
      catalog
        .getRawDb()
        .prepare('UPDATE photo_semantic_embeddings SET is_current = 0 WHERE file_location_id = ?;')
        .run(loc.id)
    }

    return loc.id
  }

  it('applies SQL filters BEFORE ranking: passes a case that would fail if filtered after top-K', async () => {
    // Target query vector
    const queryVector = makeVector(100)

    // Create 10 photos that have very high semantic similarity (score = 1.0)
    // BUT have rating = 1 (low rating)
    const highlySimilarLowRatingIds: number[] = []
    for (let i = 1; i <= 10; i++) {
      const id = createTestPhotoWithEmbedding({
        fileName: `similar_low_${i}.jpg`,
        rating: 1, // low rating
        vector: queryVector // exact match: score 1.0
      })
      highlySimilarLowRatingIds.push(id)
    }

    // Create 5 photos that have moderate semantic similarity (score ~ 0.7)
    // AND have rating = 5 (high rating)
    const moderateHighRatingIds: number[] = []
    for (let i = 1; i <= 5; i++) {
      const v = new Float32Array(SEMANTIC_EMBEDDING_DIMENSIONS)
      v.set(queryVector)
      v[0] = (v[0] ?? 0) + 0.5 * i
      const normalized = normalizeEmbeddingVector(v)

      const id = createTestPhotoWithEmbedding({
        fileName: `moderate_high_${i}.jpg`,
        rating: 5, // high rating
        vector: normalized
      })
      moderateHighRatingIds.push(id)
    }

    // Query with filter: ratingFilter = '5', limit = 5
    // If filtering occurred AFTER picking top 5 global matches:
    // Global top 5 are all in `highlySimilarLowRatingIds` (rating 1).
    // Filtering by rating = 5 afterwards would yield 0 results!
    // With filter-before-ranking:
    // Only photos with rating = 5 are considered, so all 5 `moderateHighRatingIds` are returned.

    const searchResult = await catalog.searchPhotosSemantic({
      queryVector,
      filters: {
        ratingFilter: '5',
        flagFilter: 'all'
      },
      limit: 5,
      offset: 0,
      minScore: 0.1
    })

    expect(searchResult.items.length).toBe(5)
    expect(searchResult.totalMatched).toBe(5)
    expect(searchResult.eligibleCount).toBe(5)
    for (const item of searchResult.items) {
      expect(moderateHighRatingIds).toContain(item.photo.id)
      expect(item.photo.rating).toBe(5)
    }
  })

  it('excludes stale and incompatible model/recipe embeddings', async () => {
    const queryVector = makeVector(42)

    // 1. Current compatible embedding -> must be included
    const currentId = createTestPhotoWithEmbedding({
      fileName: 'current_photo.jpg',
      vector: queryVector,
      isCurrentEmbedding: true,
      modelId: SEMANTIC_MODEL_ID,
      preprocessingVersion: SEMANTIC_PREPROCESSING_VERSION
    })

    // 2. Stale embedding (isCurrent = false) -> must be excluded
    createTestPhotoWithEmbedding({
      fileName: 'stale_photo.jpg',
      vector: queryVector,
      isCurrentEmbedding: false,
      modelId: SEMANTIC_MODEL_ID,
      preprocessingVersion: SEMANTIC_PREPROCESSING_VERSION
    })

    // 3. Incompatible modelId -> must be excluded
    createTestPhotoWithEmbedding({
      fileName: 'incompatible_model.jpg',
      vector: queryVector,
      isCurrentEmbedding: true,
      modelId: 'old-model-v0@123',
      preprocessingVersion: SEMANTIC_PREPROCESSING_VERSION
    })

    // 4. Incompatible preprocessingVersion -> must be excluded
    createTestPhotoWithEmbedding({
      fileName: 'incompatible_recipe.jpg',
      vector: queryVector,
      isCurrentEmbedding: true,
      modelId: SEMANTIC_MODEL_ID,
      preprocessingVersion: 'old_recipe_v0'
    })

    const result = await catalog.searchPhotosSemantic({
      queryVector,
      filters: {},
      limit: 10,
      offset: 0,
      minScore: 0.1
    })

    expect(result.eligibleCount).toBe(1)
    expect(result.totalMatched).toBe(1)
    expect(result.items.length).toBe(1)
    expect(result.items[0]?.photo.id).toBe(currentId)
  })

  it('distinguishes eligible indexed candidates from unindexed/stale candidates', async () => {
    const queryVector = makeVector(7)

    // Photo 1: indexed with current embedding
    createTestPhotoWithEmbedding({
      fileName: 'indexed_1.jpg',
      vector: queryVector,
      isCurrentEmbedding: true
    })

    // Photo 2: not indexed (no embedding record at all)
    catalog.persistDiscoveryBatch(tempDir, [
      {
        originalPath: join(tempDir, 'unindexed_2.jpg'),
        fileName: 'unindexed_2.jpg',
        extension: '.jpg',
        category: 'photo',
        byteSize: 1024,
        birthtimeMs: 1700000000000,
        mtimeMs: 1700000000000,
        discoveredAtMs: 1700000000000
      }
    ])

    const result = await catalog.searchPhotosSemantic({
      queryVector,
      filters: {},
      limit: 10,
      offset: 0,
      minScore: 0.1
    })

    expect(result.eligibleCount).toBe(1)
    expect(result.unindexedCount).toBe(1)
    expect(result.totalMatched).toBe(1)
  })
})
