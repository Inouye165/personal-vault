/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { CatalogDatabase } from '../../src/main/services/catalog/database'
import { CURRENT_SCHEMA_VERSION } from '../../src/main/services/catalog/migrations'
import {
  SEMANTIC_MODEL_ID,
  SEMANTIC_MODEL_COMMIT,
  SEMANTIC_PREPROCESSING_VERSION,
  SEMANTIC_EMBEDDING_DIMENSIONS,
  REQUIRED_MODEL_ARTIFACTS,
  computeManifestSha256
} from '../../src/main/services/semantic/manifest'
import {
  validateAndSerializeEmbeddingVector,
  deserializeEmbeddingVector,
  normalizeEmbeddingVector
} from '../../src/main/services/semantic/vector'

function makeUnitVector(seed = 0): Float32Array {
  const vec = new Float32Array(SEMANTIC_EMBEDDING_DIMENSIONS)
  vec[seed % SEMANTIC_EMBEDDING_DIMENSIONS] = 0.6
  vec[(seed + 1) % SEMANTIC_EMBEDDING_DIMENSIONS] = 0.8
  return vec
}

describe('Stage 6B — Catalog Schema Migration 9, Vector Validation & Semantic Index Repository', () => {
  let tempDir: string
  let dbPath: string
  let catalog: CatalogDatabase
  const manifestSha256 = computeManifestSha256(REQUIRED_MODEL_ARTIFACTS)

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pv-semantic-catalog-test-'))
    dbPath = join(tempDir, 'catalog.db')
    catalog = CatalogDatabase.open({ catalogPath: dbPath })
  })

  afterEach(() => {
    try {
      catalog.close()
    } catch {
      // ignore
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('sets CURRENT_SCHEMA_VERSION to at least 9 and creates semantic index tables', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(9)
    const tables = catalog
      .getRawDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table';")
      .all() as { name: string }[]
    const tableNames = tables.map((t) => t.name)

    expect(tableNames).toContain('photo_semantic_embeddings')
    expect(tableNames).toContain('semantic_index_jobs')
    expect(tableNames).toContain('semantic_index_job_items')
  })

  it('validates finite values, 512 dimensions, L2 unit normalization, and 2048-byte blob size', () => {
    const valid = makeUnitVector(3)
    const blob = validateAndSerializeEmbeddingVector(valid)
    expect(blob.byteLength).toBe(2048)

    const roundTrip = deserializeEmbeddingVector(blob)
    expect(roundTrip.length).toBe(512)
    expect(roundTrip[3]).toBeCloseTo(0.6, 5)
    expect(roundTrip[4]).toBeCloseTo(0.8, 5)

    // Reject wrong dimension
    expect(() => validateAndSerializeEmbeddingVector(new Float32Array(256))).toThrow(
      /dimension|512/i
    )

    // Reject non-finite values
    const nanVec = makeUnitVector(0)
    nanVec[10] = Number.NaN
    expect(() => validateAndSerializeEmbeddingVector(nanVec)).toThrow(/finite|NaN/i)

    const infVec = makeUnitVector(0)
    infVec[10] = Number.POSITIVE_INFINITY
    expect(() => validateAndSerializeEmbeddingVector(infVec)).toThrow(/finite|Infinity/i)

    // Reject unnormalized vector
    const unnormalized = new Float32Array(512)
    unnormalized[0] = 5.0
    expect(() => validateAndSerializeEmbeddingVector(unnormalized)).toThrow(/normaliz|norm/i)

    // Reject wrong blob byte length on deserialize
    expect(() => deserializeEmbeddingVector(Buffer.alloc(1024))).toThrow(/byte|2048|length/i)

    // Reject zero vector in normalizeEmbeddingVector
    expect(() => normalizeEmbeddingVector(new Float32Array(512))).toThrow(/zero|norm/i)
  })

  it('binds embeddings to verified content, location/observation, full-precision mtimeMs, model artifact identity, and recipe version', () => {
    const preciseMtimeMs = 1710000123456.789
    catalog.persistDiscoveryBatch('C:\\photos', [
      {
        originalPath: 'C:\\photos\\board.jpg',
        fileName: 'board.jpg',
        extension: '.jpg',
        category: 'photo',
        byteSize: 42000,
        birthtimeMs: 1710000000000.125,
        mtimeMs: preciseMtimeMs,
        discoveredAtMs: 1710000200000
      }
    ])

    const sha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    catalog.recordHashObservation({
      originalPath: 'C:\\photos\\board.jpg',
      sha256: sha,
      observedByteSize: 42000,
      observedMtimeMs: preciseMtimeMs,
      hashedAtMs: 1710000300000
    })

    const updatedLoc = catalog.getFileLocationByPath('C:\\photos\\board.jpg')!
    const vec = makeUnitVector(7)
    const revision = `semrev:${updatedLoc.discoveryObservationId}:42000:${preciseMtimeMs}:${sha}`

    catalog.savePhotoSemanticEmbedding({
      fileId: updatedLoc.id,
      fileLocationId: updatedLoc.id,
      discoveryObservationId: updatedLoc.discoveryObservationId,
      contentSha256: sha,
      contentRevision: revision,
      sourcePath: updatedLoc.originalPath,
      observedByteSize: 42000,
      observedMtimeMs: preciseMtimeMs,
      modelId: SEMANTIC_MODEL_ID,
      modelCommit: SEMANTIC_MODEL_COMMIT,
      modelManifestSha256: manifestSha256,
      preprocessingVersion: SEMANTIC_PREPROCESSING_VERSION,
      embeddingDimensions: SEMANTIC_EMBEDDING_DIMENSIONS,
      vector: vec,
      width: 1600,
      height: 1200
    })

    const stored = catalog.getPhotoSemanticEmbedding(
      updatedLoc.id,
      SEMANTIC_MODEL_ID,
      SEMANTIC_PREPROCESSING_VERSION
    )
    expect(stored).not.toBeNull()
    expect(stored!.fileId).toBe(updatedLoc.id)
    expect(stored!.contentSha256).toBe(sha)
    expect(stored!.observedByteSize).toBe(42000)
    expect(stored!.observedMtimeMs).toBeCloseTo(preciseMtimeMs, 6)
    expect(stored!.modelId).toBe(SEMANTIC_MODEL_ID)
    expect(stored!.modelCommit).toBe(SEMANTIC_MODEL_COMMIT)
    expect(stored!.modelManifestSha256).toBe(manifestSha256)
    expect(stored!.preprocessingVersion).toBe(SEMANTIC_PREPROCESSING_VERSION)
    expect(stored!.embeddingDimensions).toBe(512)
    expect(stored!.isCurrent).toBe(true)
    expect(stored!.vector[7]).toBeCloseTo(0.6, 5)
  })

  it('invalidates current status when source file changes on rescan or when model/recipe version differs', () => {
    catalog.persistDiscoveryBatch('C:\\photos', [
      {
        originalPath: 'C:\\photos\\scene.jpg',
        fileName: 'scene.jpg',
        extension: '.jpg',
        category: 'photo',
        byteSize: 10000,
        birthtimeMs: 1000,
        mtimeMs: 2000.5,
        discoveredAtMs: 3000
      }
    ])

    const sha1 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    catalog.recordHashObservation({
      originalPath: 'C:\\photos\\scene.jpg',
      sha256: sha1,
      observedByteSize: 10000,
      observedMtimeMs: 2000.5,
      hashedAtMs: 3100
    })

    const loc1 = catalog.getFileLocationByPath('C:\\photos\\scene.jpg')!
    catalog.savePhotoSemanticEmbedding({
      fileId: loc1.id,
      fileLocationId: loc1.id,
      discoveryObservationId: loc1.discoveryObservationId,
      contentSha256: sha1,
      contentRevision: `semrev:${loc1.discoveryObservationId}:10000:2000.5:${sha1}`,
      sourcePath: loc1.originalPath,
      observedByteSize: 10000,
      observedMtimeMs: 2000.5,
      modelId: SEMANTIC_MODEL_ID,
      modelCommit: SEMANTIC_MODEL_COMMIT,
      modelManifestSha256: manifestSha256,
      preprocessingVersion: SEMANTIC_PREPROCESSING_VERSION,
      embeddingDimensions: SEMANTIC_EMBEDDING_DIMENSIONS,
      vector: makeUnitVector(1),
      width: 800,
      height: 600
    })

    // Coverage for current model/recipe is 1 indexed photo
    const cov1 = catalog.getSemanticIndexCoverage({
      modelId: SEMANTIC_MODEL_ID,
      modelCommit: SEMANTIC_MODEL_COMMIT,
      modelManifestSha256: manifestSha256,
      preprocessingVersion: SEMANTIC_PREPROCESSING_VERSION
    })
    expect(cov1.totalCatalogPhotos).toBe(1)
    expect(cov1.currentIndexedPhotos).toBe(1)

    // Coverage for a different recipe or model commit is 0 current indexed photos
    const covDifferentRecipe = catalog.getSemanticIndexCoverage({
      modelId: SEMANTIC_MODEL_ID,
      modelCommit: SEMANTIC_MODEL_COMMIT,
      modelManifestSha256: manifestSha256,
      preprocessingVersion: 'clip_vit_b32_224_bilinear_legacy'
    })
    expect(covDifferentRecipe.currentIndexedPhotos).toBe(0)

    // Rescan discovers modified byteSize / mtimeMs -> must invalidate is_current
    catalog.persistDiscoveryBatch('C:\\photos', [
      {
        originalPath: 'C:\\photos\\scene.jpg',
        fileName: 'scene.jpg',
        extension: '.jpg',
        category: 'photo',
        byteSize: 12500,
        birthtimeMs: 1000,
        mtimeMs: 5000.75,
        discoveredAtMs: 6000
      }
    ])

    const storedAfterRescan = catalog.getPhotoSemanticEmbedding(
      loc1.id,
      SEMANTIC_MODEL_ID,
      SEMANTIC_PREPROCESSING_VERSION
    )
    expect(storedAfterRescan?.isCurrent).toBe(false)

    const covAfterRescan = catalog.getSemanticIndexCoverage({
      modelId: SEMANTIC_MODEL_ID,
      modelCommit: SEMANTIC_MODEL_COMMIT,
      modelManifestSha256: manifestSha256,
      preprocessingVersion: SEMANTIC_PREPROCESSING_VERSION
    })
    expect(covAfterRescan.currentIndexedPhotos).toBe(0)
  })

  it('commits item embedding and job counters atomically and rolls back completely on transaction failure', () => {
    catalog.persistDiscoveryBatch('C:\\photos', [
      {
        originalPath: 'C:\\photos\\tx.jpg',
        fileName: 'tx.jpg',
        extension: '.jpg',
        category: 'photo',
        byteSize: 5000,
        birthtimeMs: 1000,
        mtimeMs: 2000,
        discoveredAtMs: 3000
      }
    ])

    const job = catalog.createSemanticIndexJob({
      modelId: SEMANTIC_MODEL_ID,
      modelCommit: SEMANTIC_MODEL_COMMIT,
      modelManifestSha256: manifestSha256,
      preprocessingVersion: SEMANTIC_PREPROCESSING_VERSION
    })
    expect(job.totalPhotos).toBe(1)
    expect(job.pendingPhotos).toBe(1)

    const pendingBatch = catalog.getNextPendingSemanticIndexJobItems(job.id, 10)
    expect(pendingBatch).toHaveLength(1)
    const item = pendingBatch[0]!

    // Attempt to record completion with an invalid (non-unit) vector inside the atomic transaction
    const invalidVec = new Float32Array(512)
    invalidVec[0] = 99
    expect(() =>
      catalog.completeSemanticIndexJobItemWithEmbedding({
        jobId: job.id,
        itemId: item.id,
        reused: false,
        embedding: {
          fileId: 1,
          fileLocationId: item.fileLocationId,
          discoveryObservationId: item.discoveryObservationId,
          contentSha256: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
          contentRevision: 'rev-bad',
          sourcePath: item.originalPath,
          observedByteSize: item.expectedByteSize,
          observedMtimeMs: item.expectedMtimeMs,
          modelId: SEMANTIC_MODEL_ID,
          modelCommit: SEMANTIC_MODEL_COMMIT,
          modelManifestSha256: manifestSha256,
          preprocessingVersion: SEMANTIC_PREPROCESSING_VERSION,
          embeddingDimensions: 512,
          vector: invalidVec,
          width: 100,
          height: 100
        }
      })
    ).toThrow()

    // Ensure item remained pending, no partial embedding was saved, and job counters did not advance
    const reloadedJob = catalog.getSemanticIndexJob(job.id)!
    expect(reloadedJob.processedPhotos).toBe(0)
    expect(reloadedJob.pendingPhotos).toBe(1)
    expect(
      catalog.getPhotoSemanticEmbedding(
        item.fileLocationId,
        SEMANTIC_MODEL_ID,
        SEMANTIC_PREPROCESSING_VERSION
      )
    ).toBeNull()
  })

  it('supports bounded SQL job snapshot creation, coverage queries, and paginated job items at 50,001-photo scale without full-index memory loading', () => {
    const rawDb = catalog.getRawDb()
    const totalScale = 50001
    const src = catalog.registerSource('C:\\scale')

    rawDb.exec('BEGIN IMMEDIATE TRANSACTION;')
    try {
      const insertLoc = rawDb.prepare(`
        INSERT INTO file_locations (
          id, source_id, original_path, normalized_path, file_name, extension, category,
          created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, '.jpg', 'photo', 1000, 1000)
      `)
      const insertObs = rawDb.prepare(`
        INSERT INTO discovery_observations (
          id, file_location_id, byte_size, filesystem_birthtime_ms, filesystem_mtime_ms,
          inferred_capture_time_ms, observed_at_ms, last_seen_at_ms, is_current
        ) VALUES (?, ?, 1024, 1000, 2000, NULL, 1000, 1000, 1)
      `)
      for (let i = 1; i <= totalScale; i++) {
        const p = `C:\\scale\\photo_${i}.jpg`
        insertLoc.run(i, src.id, p, p.toLowerCase(), `photo_${i}.jpg`)
        insertObs.run(i, i)
      }
      rawDb.exec('COMMIT;')
    } catch (err) {
      rawDb.exec('ROLLBACK;')
      throw err
    }

    const job = catalog.createSemanticIndexJob({
      modelId: SEMANTIC_MODEL_ID,
      modelCommit: SEMANTIC_MODEL_COMMIT,
      modelManifestSha256: manifestSha256,
      preprocessingVersion: SEMANTIC_PREPROCESSING_VERSION
    })

    // Ensure 50,000 is not imposed as a hard cap: all 50,001 photos are snapshotted in SQLite
    expect(job.totalPhotos).toBe(totalScale)
    expect(job.pendingPhotos).toBe(totalScale)

    // Paginate job items with bounded limit
    const page1 = catalog.listSemanticIndexJobItems({ jobId: job.id, limit: 50, offset: 0 })
    expect(page1.items).toHaveLength(50)
    expect(page1.totalCount).toBe(totalScale)

    const pageLast = catalog.listSemanticIndexJobItems({
      jobId: job.id,
      limit: 50,
      offset: 50000
    })
    expect(pageLast.items).toHaveLength(1)
    expect(pageLast.items[0]!.originalPath).toBe('C:\\scale\\photo_50001.jpg')
  })
})
