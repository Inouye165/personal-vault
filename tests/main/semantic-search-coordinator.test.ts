// @vitest-environment node
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { join, resolve } from 'node:path'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { CatalogDatabase } from '../../src/main/services/catalog/database'
import { SemanticModelManager } from '../../src/main/services/semantic/model-manager'
import {
  SemanticSearchCoordinator,
  SearchCancelledError
} from '../../src/main/services/semantic/search-coordinator'
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

  it('supports concurrent page requests for the same query generation without cancelling each other', async () => {
    await modelManager.importFromDirectory(REAL_MODEL_DIR)

    // Add 4 indexed photos with distinct vectors
    for (let i = 1; i <= 4; i++) {
      addPhoto(`photo_${i}.jpg`, makeVector(i))
    }

    // Fire page 0 and page 1 concurrently for the SAME query
    const page0Promise = coordinator.search({
      queryText: 'mountain landscape',
      limit: 2,
      offset: 0,
      minScore: -1.0
    })

    const page1Promise = coordinator.search({
      queryText: 'mountain landscape',
      limit: 2,
      offset: 2,
      minScore: -1.0
    })

    const [page0, page1] = await Promise.all([page0Promise, page1Promise])

    expect(page0.items.length).toBe(2)
    expect(page1.items.length).toBe(2)
    expect(page0.totalMatched).toBe(4)
    expect(page1.totalMatched).toBe(4)
    expect(page0.offset).toBe(0)
    expect(page1.offset).toBe(2)
    // Page 0 and Page 1 should contain non-overlapping items
    const page0Ids = page0.items.map((i) => i.photo.id)
    const page1Ids = page1.items.map((i) => i.photo.id)
    for (const id of page0Ids) {
      expect(page1Ids).not.toContain(id)
    }
  })

  it('handles rapid query replacement: older query rejects with SearchCancelledError and newer query succeeds', async () => {
    await modelManager.importFromDirectory(REAL_MODEL_DIR)

    const vec = makeVector(1)
    addPhoto('beach.jpg', vec)

    // Fire first search
    const p1 = coordinator.search({
      queryText: 'first query',
      limit: 10,
      offset: 0
    })

    // Immediately replace with second search (new query generation)
    const p2 = coordinator.search({
      queryText: 'second query',
      limit: 10,
      offset: 0
    })

    // First query must reject with SearchCancelledError (not return mask with items: [])
    await expect(p1).rejects.toThrow(SearchCancelledError)

    // Second query must resolve successfully
    const r2 = await p2
    expect(r2.modelStatus).toBe('ready')
    expect(r2.items.length).toBe(1)
    expect(r2.tokenCount).toBeGreaterThan(0)
  })

  it('cancels active search promptly and rejects with SearchCancelledError when cancel is requested', async () => {
    await modelManager.importFromDirectory(REAL_MODEL_DIR)

    const searchPromise = coordinator.search({
      queryText: 'a very long complex search query',
      limit: 10,
      offset: 0
    })

    coordinator.cancelActiveSearch()

    await expect(searchPromise).rejects.toThrow(SearchCancelledError)
  })

  it('maintains bounded worker lifecycle (<= 1 active search worker) and reports diagnostics', async () => {
    await modelManager.importFromDirectory(REAL_MODEL_DIR)

    const diagBefore = coordinator.getDiagnostics()
    expect(diagBefore.liveWorkers).toBeLessThanOrEqual(1)

    // Perform a search
    await coordinator.search({
      queryText: 'forest trees',
      limit: 5,
      offset: 0
    })

    const diagAfter = coordinator.getDiagnostics()
    expect(diagAfter.liveWorkers).toBe(1)
    expect(diagAfter.terminatingWorkers).toBe(0)

    // Shutting down terminates worker
    await coordinator.shutdown()
    const diagShutdown = coordinator.getDiagnostics()
    expect(diagShutdown.activeWorkers).toBe(0)
  })
})
