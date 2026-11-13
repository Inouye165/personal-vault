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

  describe('Full embedding compatibility and corrupt candidate isolation', () => {
    it('excludes photos with modified model_commit and truthfully increments staleCount', async () => {
      const queryVector = makeVector(21)
      const photoId = createTestPhotoWithEmbedding({
        fileName: 'commit_test.jpg',
        vector: queryVector,
        isCurrentEmbedding: true
      })

      // Invalidate model_commit directly in SQLite
      catalog
        .getRawDb()
        .prepare(
          'UPDATE photo_semantic_embeddings SET model_commit = ? WHERE file_location_id = ?;'
        )
        .run('incompatible_commit_hash', photoId)

      const res = await catalog.searchPhotosSemantic({
        queryVector,
        filters: {}
      })

      expect(res.eligibleCount).toBe(0)
      expect(res.staleCount).toBe(1)
      expect(res.unindexedCount).toBe(0)
      expect(res.items).toEqual([])
      expect(res.totalMatched).toBe(0)
    })

    it('excludes photos with modified model_manifest_sha256 and truthfully increments staleCount', async () => {
      const queryVector = makeVector(22)
      const photoId = createTestPhotoWithEmbedding({
        fileName: 'manifest_test.jpg',
        vector: queryVector,
        isCurrentEmbedding: true
      })

      // Invalidate manifest hash
      catalog
        .getRawDb()
        .prepare(
          'UPDATE photo_semantic_embeddings SET model_manifest_sha256 = ? WHERE file_location_id = ?;'
        )
        .run('b'.repeat(64), photoId)

      const res = await catalog.searchPhotosSemantic({
        queryVector,
        filters: {}
      })

      expect(res.eligibleCount).toBe(0)
      expect(res.staleCount).toBe(1)
      expect(res.unindexedCount).toBe(0)
      expect(res.items).toEqual([])
      expect(res.totalMatched).toBe(0)
    })

    it('excludes photos with modified content_revision and truthfully increments staleCount', async () => {
      const queryVector = makeVector(23)
      const photoId = createTestPhotoWithEmbedding({
        fileName: 'revision_test.jpg',
        vector: queryVector,
        isCurrentEmbedding: true
      })

      // Invalidate content_revision
      catalog
        .getRawDb()
        .prepare(
          'UPDATE photo_semantic_embeddings SET content_revision = ? WHERE file_location_id = ?;'
        )
        .run('outdated_corrupted_revision_string', photoId)

      const res = await catalog.searchPhotosSemantic({
        queryVector,
        filters: {}
      })

      expect(res.eligibleCount).toBe(0)
      expect(res.staleCount).toBe(1)
      expect(res.unindexedCount).toBe(0)
      expect(res.items).toEqual([])
      expect(res.totalMatched).toBe(0)
    })

    it('isolates corrupt candidate blobs and preserves valid search results', async () => {
      const queryVector = makeVector(24)
      const validPhotoId = createTestPhotoWithEmbedding({
        fileName: 'valid_candidate.jpg',
        vector: queryVector,
        isCurrentEmbedding: true
      })
      const corruptPhotoId = createTestPhotoWithEmbedding({
        fileName: 'corrupt_candidate.jpg',
        vector: queryVector,
        isCurrentEmbedding: true
      })

      // Corrupt candidate's blob with NaN values
      const nanRaw = new Float32Array(512)
      nanRaw.fill(Number.NaN)
      const nanBlob = Buffer.from(nanRaw.buffer)
      catalog
        .getRawDb()
        .prepare(
          'UPDATE photo_semantic_embeddings SET embedding_blob = ? WHERE file_location_id = ?;'
        )
        .run(nanBlob, corruptPhotoId)

      const res = await catalog.searchPhotosSemantic({
        queryVector,
        filters: {}
      })

      // Search succeeds, valid photo is returned, corrupt candidate is skipped and honestly counted
      expect(res.items.length).toBe(1)
      expect(res.items[0]?.photo.id).toBe(validPhotoId)
      expect(res.items[0]?.score).toBeCloseTo(1.0, 5)
      expect(res.eligibleCount).toBe(1)
      expect(res.corruptCount).toBe(1)
    })

    it('rejects content_revision with altered timestamp (e.g. 999999) (Finding 2)', async () => {
      const queryVector = makeVector(25)
      const photoId = createTestPhotoWithEmbedding({
        fileName: 'altered_rev_ts.jpg',
        vector: queryVector,
        isCurrentEmbedding: true
      })

      const row = catalog
        .getRawDb()
        .prepare(
          'SELECT content_revision FROM photo_semantic_embeddings WHERE file_location_id = ?;'
        )
        .get(photoId) as { content_revision: string }
      const parts = row.content_revision.split(':')
      parts[3] = '999999'
      catalog
        .getRawDb()
        .prepare(
          'UPDATE photo_semantic_embeddings SET content_revision = ? WHERE file_location_id = ?;'
        )
        .run(parts.join(':'), photoId)

      const res = await catalog.searchPhotosSemantic({
        queryVector,
        filters: {}
      })

      expect(res.eligibleCount).toBe(0)
      expect(res.staleCount).toBe(1)
      expect(res.items).toEqual([])
    })

    it('rejects observed_mtime_ms differing by 0.5 ms from fractional filesystem_mtime_ms (Finding 2)', async () => {
      const queryVector = makeVector(26)
      const originalPath = join(tempDir, 'fractional_mtime.jpg')
      const fractionalMtime = 1700000000123.25
      catalog.persistDiscoveryBatch(tempDir, [
        {
          originalPath,
          fileName: 'fractional_mtime.jpg',
          extension: '.jpg',
          category: 'photo',
          byteSize: 2048,
          birthtimeMs: fractionalMtime,
          mtimeMs: fractionalMtime,
          discoveredAtMs: 1700000000000
        }
      ])
      const sha256 = 'b'.repeat(64)
      catalog.recordHashObservation({
        originalPath,
        sha256,
        observedByteSize: 2048,
        observedMtimeMs: fractionalMtime,
        hashedAtMs: 1700000000000
      })
      const loc = catalog.getFileLocationByPath(originalPath)!
      const driftedMtime = fractionalMtime + 0.5
      catalog.savePhotoSemanticEmbedding({
        fileId: loc.id,
        fileLocationId: loc.id,
        discoveryObservationId: loc.discoveryObservationId,
        contentSha256: sha256,
        contentRevision: `semrev:${loc.discoveryObservationId}:2048:${fractionalMtime}:${sha256}`,
        sourcePath: originalPath,
        observedByteSize: 2048,
        observedMtimeMs: fractionalMtime,
        modelId: SEMANTIC_MODEL_ID,
        modelCommit: SEMANTIC_MODEL_COMMIT,
        modelManifestSha256: manifestSha256,
        preprocessingVersion: SEMANTIC_PREPROCESSING_VERSION,
        embeddingDimensions: SEMANTIC_EMBEDDING_DIMENSIONS,
        vector: queryVector
      })

      // Update observed_mtime_ms and content_revision by 0.5ms to test fractional precision policy
      catalog
        .getRawDb()
        .prepare(
          'UPDATE photo_semantic_embeddings SET observed_mtime_ms = ?, content_revision = ? WHERE file_location_id = ?;'
        )
        .run(
          driftedMtime,
          `semrev:${loc.discoveryObservationId}:2048:${driftedMtime}:${sha256}`,
          loc.id
        )

      const res = await catalog.searchPhotosSemantic({
        queryVector,
        filters: {}
      })

      expect(res.eligibleCount).toBe(0)
      expect(res.staleCount).toBe(1)
      expect(res.items).toEqual([])
    })

    it('supports bounded pagination beyond offset 10,000 with deterministic ties and backward navigation (Finding 3)', async () => {
      const queryVector = makeVector(27)
      const total = 10_150
      const batch: Array<{
        originalPath: string
        fileName: string
        extension: string
        category: 'photo'
        byteSize: number
        birthtimeMs: number
        mtimeMs: number
        discoveredAtMs: number
      }> = []
      for (let i = 0; i < total; i++) {
        batch.push({
          originalPath: join(tempDir, `deep_${i}.jpg`),
          fileName: `deep_${i}.jpg`,
          extension: '.jpg',
          category: 'photo',
          byteSize: 1024,
          birthtimeMs: 1700000000000,
          mtimeMs: 1700000000000,
          discoveredAtMs: 1700000000000
        })
      }
      for (let start = 0; start < total; start += 1000) {
        catalog.persistDiscoveryBatch(tempDir, batch.slice(start, start + 1000))
      }

      const rawDb = catalog.getRawDb()
      const rows = rawDb
        .prepare(
          'SELECT f.id AS id, d.id AS obs_id, f.original_path AS p FROM file_locations f JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1 ORDER BY f.id ASC;'
        )
        .all() as Array<{ id: number; obs_id: number; p: string }>

      const blob = Buffer.from(queryVector.buffer, queryVector.byteOffset, queryVector.byteLength)
      const sha = 'c'.repeat(64)
      rawDb.exec('BEGIN TRANSACTION;')
      const insertStmt = rawDb.prepare(`
        INSERT INTO photo_semantic_embeddings (
          file_id, file_location_id, discovery_observation_id,
          content_sha256, content_revision, source_path, observed_byte_size, observed_mtime_ms,
          model_id, model_commit, model_manifest_sha256, preprocessing_version,
          embedding_dimensions, embedding_blob, is_current, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?);
      `)
      for (const r of rows) {
        insertStmt.run(
          r.id,
          r.id,
          r.obs_id,
          sha,
          `semrev:${r.obs_id}:1024:1700000000000:${sha}`,
          r.p,
          1024,
          1700000000000,
          SEMANTIC_MODEL_ID,
          SEMANTIC_MODEL_COMMIT,
          manifestSha256,
          SEMANTIC_PREPROCESSING_VERSION,
          SEMANTIC_EMBEDDING_DIMENSIONS,
          blob,
          1700000000000
        )
      }
      rawDb.exec('COMMIT;')

      // Jump past offset 10,000
      const deepPage = await catalog.searchPhotosSemantic({
        queryVector,
        filters: {},
        offset: 10_050,
        limit: 25,
        minScore: 0.5
      })

      expect(deepPage.totalMatched).toBe(total)
      expect(deepPage.items.length).toBe(25)
      expect(deepPage.hasMore).toBe(true)
      // Since all scores are tied (1.0), deterministic tie-break is file_location_id ASC
      expect(deepPage.items[0]?.photo.id).toBe(rows[10_050]!.id)
      expect(deepPage.items[24]?.photo.id).toBe(rows[10_074]!.id)

      // Navigate backward to page 0
      const firstPage = await catalog.searchPhotosSemantic({
        queryVector,
        filters: {},
        offset: 0,
        limit: 25,
        minScore: 0.5
      })
      expect(firstPage.items.length).toBe(25)
      expect(firstPage.items[0]?.photo.id).toBe(rows[0]!.id)
    })
  })
})
