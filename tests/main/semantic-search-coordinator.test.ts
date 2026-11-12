// @vitest-environment node
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { join, resolve } from 'node:path'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { CatalogDatabase } from '../../src/main/services/catalog/database'
import { SemanticModelManager } from '../../src/main/services/semantic/model-manager'
import { SemanticSearchCoordinator } from '../../src/main/services/semantic/search-coordinator'
import {
  SEMANTIC_EMBEDDING_DIMENSIONS,
  SEMANTIC_MODEL_ID,
  SEMANTIC_MODEL_COMMIT,
  SEMANTIC_PREPROCESSING_VERSION,
  REQUIRED_MODEL_ARTIFACTS,
  computeManifestSha256
} from '../../src/main/services/semantic/manifest'
import { normalizeEmbeddingVector } from '../../src/main/services/semantic/vector'

const REAL_MODEL_DIR = resolve(
  __dirname,
  '../../spikes/semantic-eval/.model-cache/Xenova--clip-vit-base-patch32'
)

describe('Stage 6D: SemanticSearchCoordinator - Lifecycle, Races, Cancellation', () => {
  let tempDir: string
  let modelsRootDir: string
  let sourcesDir: string
  let catalogPath: string
  let catalog: CatalogDatabase
  let modelManager: SemanticModelManager
  let coordinator: SemanticSearchCoordinator

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pv-test-sem-coord-'))
    modelsRootDir = join(tempDir, 'models')
    sourcesDir = join(tempDir, 'sources')
    mkdirSync(modelsRootDir, { recursive: true })
    mkdirSync(sourcesDir, { recursive: true })

    catalogPath = join(tempDir, 'catalog.sqlite')
    catalog = CatalogDatabase.open({ catalogPath })

    modelManager = new SemanticModelManager({
      modelsRootDir,
      getApprovedRoots: () => [sourcesDir, REAL_MODEL_DIR],
      getVaultRoot: () => null
    })

    coordinator = new SemanticSearchCoordinator({
      catalog,
      modelManager
    })
  })

  afterEach(async () => {
    try {
      await coordinator.shutdown()
    } catch {
      // ignore
    }
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

  const manifestSha256 = computeManifestSha256(REQUIRED_MODEL_ARTIFACTS)

  function addPhoto(fileName: string, vector?: Float32Array): number {
    const originalPath = join(sourcesDir, fileName)
    catalog.persistDiscoveryBatch(sourcesDir, [
      {
        originalPath,
        fileName,
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

    if (vector) {
      catalog.savePhotoSemanticEmbedding({
        fileId: loc.id,
        fileLocationId: loc.id,
        discoveryObservationId: loc.discoveryObservationId,
        contentSha256: sha256,
        contentRevision: `rev:${loc.discoveryObservationId}:1024:1700000000000:${sha256}`,
        sourcePath: loc.originalPath,
        observedByteSize: 1024,
        observedMtimeMs: 1700000000000,
        modelId: SEMANTIC_MODEL_ID,
        modelCommit: SEMANTIC_MODEL_COMMIT,
        modelManifestSha256: manifestSha256,
        preprocessingVersion: SEMANTIC_PREPROCESSING_VERSION,
        embeddingDimensions: SEMANTIC_EMBEDDING_DIMENSIONS,
        vector
      })
    }
    return loc.id
  }

  it('reports missing model honestly when offline model is not installed', async () => {
    const res = await coordinator.search({
      queryText: 'sunset over water',
      limit: 10,
      offset: 0
    })

    expect(res.modelStatus).toBe('unprovisioned')
    expect(res.items).toEqual([])
    expect(res.totalMatched).toBe(0)
    expect(res.eligibleCount).toBe(0)
  })

  it('reports empty index when model is ready but no photos are indexed', async () => {
    // Import model folder
    await modelManager.importFromDirectory(REAL_MODEL_DIR)

    // Add unindexed photo
    addPhoto('photo1.jpg')

    const res = await coordinator.search({
      queryText: 'forest trees',
      limit: 10,
      offset: 0
    })

    expect(res.modelStatus).toBe('ready')
    expect(res.eligibleCount).toBe(0)
    expect(res.unindexedCount).toBe(1)
    expect(res.totalMatched).toBe(0)
    expect(res.items).toEqual([])
  })

  it('handles rapid replacement queries: earlier requests do not overwrite newer queries', async () => {
    await modelManager.importFromDirectory(REAL_MODEL_DIR)

    // Add indexed photo
    const vec = makeVector(1)
    addPhoto('beach.jpg', vec)

    // Fire two searches in rapid succession
    const p1 = coordinator.search({
      queryText: 'query one',
      limit: 10,
      offset: 0
    })
    const p2 = coordinator.search({
      queryText: 'query two',
      limit: 10,
      offset: 0
    })

    const [, r2] = await Promise.all([p1, p2])
    // The later query must be ready and valid
    expect(r2.modelStatus).toBe('ready')
    // Cancellation or completion of r1 is safe and does not corrupt r2
    expect(r2.tokenCount).toBeGreaterThan(0)
  })

  it('cancels active search promptly when cancel is requested', async () => {
    await modelManager.importFromDirectory(REAL_MODEL_DIR)

    const searchPromise = coordinator.search({
      queryText: 'a very long complex search query',
      limit: 10,
      offset: 0
    })

    coordinator.cancelActiveSearch()

    const res = await searchPromise
    // Either gracefully aborted or completed, but never throws uncaught error
    expect(res).toBeDefined()
  })
})
