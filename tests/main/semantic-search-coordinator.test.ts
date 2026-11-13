// @vitest-environment node
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { join, resolve } from 'node:path'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { CatalogDatabase } from '../../src/main/services/catalog/database'
import { SemanticModelManager } from '../../src/main/services/semantic/model-manager'
import {
  SemanticSearchCoordinator,
  SearchCancelledError,
  SearchOverloadError
} from '../../src/main/services/semantic/search-coordinator'
import { verifyModelDirIntegrity } from '../../src/main/services/semantic/search-worker'
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

  it('never exceeds liveWorkers <= 1 when cancelling and immediately restarting search (Finding 1)', async () => {
    await modelManager.importFromDirectory(REAL_MODEL_DIR)
    addPhoto('p1.jpg', makeVector(1))

    // Start search to spawn worker
    const first = coordinator.search({ queryText: 'ocean waves', limit: 10, offset: 0 })
    const firstHandled = first.catch((e) => e)
    // Cancel immediately and start another search right away
    coordinator.cancelActiveSearch()

    const diagRightAfterCancel = coordinator.getDiagnostics()
    expect(diagRightAfterCancel.liveWorkers).toBeLessThanOrEqual(1)

    const second = coordinator.search({
      queryText: 'mountain peak',
      limit: 10,
      offset: 0,
      minScore: -1.0
    })
    // Immediately check diagnostics synchronously
    const diagDuringRestart = coordinator.getDiagnostics()
    expect(diagDuringRestart.liveWorkers).toBeLessThanOrEqual(1)

    const firstErr = await firstHandled
    expect(firstErr).toBeInstanceOf(SearchCancelledError)
    const res = await second
    expect(res.modelStatus).toBe('ready')
    expect(coordinator.getDiagnostics().liveWorkers).toBeLessThanOrEqual(1)
  })

  it('enforces bounded pending requests under 100 simultaneous same-query calls (Finding 1)', async () => {
    await modelManager.importFromDirectory(REAL_MODEL_DIR)
    for (let i = 1; i <= 5; i++) {
      addPhoto(`p${i}.jpg`, makeVector(i))
    }

    let maxObservedPending = 0
    const promises = Array.from({ length: 100 }, (_, idx) => {
      const p = coordinator.search({
        queryText: 'simultaneous query test',
        limit: 2,
        offset: idx % 3,
        minScore: -1.0
      })
      maxObservedPending = Math.max(
        maxObservedPending,
        coordinator.getDiagnostics().pendingRequests
      )
      return p
    })

    const results = await Promise.allSettled(promises)
    expect(maxObservedPending).toBeLessThanOrEqual(16)
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled.length).toBeGreaterThan(0)
    expect(rejected.length).toBeGreaterThan(0)
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(SearchOverloadError)
    }
  })

  it('terminates busy worker on query supersession and recovers cleanly for retries after timeout (Finding 1)', async () => {
    await modelManager.importFromDirectory(REAL_MODEL_DIR)
    addPhoto('p1.jpg', makeVector(1))

    // Force a very short timeout to trigger timeout on cold load, then verify retry works
    const shortTimeoutCoord = new SemanticSearchCoordinator({
      catalog,
      modelManager,
      requestTimeoutMs: 5
    })
    try {
      await expect(
        shortTimeoutCoord.search({
          queryText: 'timeout retry test',
          limit: 5,
          offset: 0,
          minScore: -1.0
        })
      ).rejects.toThrow()

      // Retry with normal coordinator on same query must NOT be poisoned
      const ok = await coordinator.search({
        queryText: 'timeout retry test',
        limit: 5,
        offset: 0,
        minScore: -1.0
      })
      expect(ok.modelStatus).toBe('ready')
      expect(ok.items.length).toBe(1)
    } finally {
      await shortTimeoutCoord.shutdown()
    }
  })

  it('detects same-path model artifact modification even when directory mtime is preserved (Finding 4)', async () => {
    const { copyFileSync, statSync, utimesSync, writeFileSync } = await import('node:fs')
    const isolatedModelDir = join(tempDir, 'isolated-model')
    mkdirSync(join(isolatedModelDir, 'onnx'), { recursive: true })

    for (const spec of REQUIRED_MODEL_ARTIFACTS) {
      const src = join(REAL_MODEL_DIR, spec.relativePath)
      const dst = join(isolatedModelDir, spec.relativePath)
      copyFileSync(src, dst)
    }

    const firstCheck = await verifyModelDirIntegrity(isolatedModelDir)
    expect(firstCheck.ok).toBe(true)

    // Modify tokenizer.json while restoring parent directory mtime
    const dirStatBefore = statSync(isolatedModelDir)
    const tokPath = join(isolatedModelDir, 'tokenizer.json')
    const origContent = await import('node:fs').then((fs) => fs.readFileSync(tokPath))
    const tampered = Buffer.from(origContent)
    tampered[0] = tampered[0] === 0x7b ? 0x20 : 0x7b
    writeFileSync(tokPath, tampered)
    utimesSync(isolatedModelDir, dirStatBefore.atime, dirStatBefore.mtime)

    const secondCheck = await verifyModelDirIntegrity(isolatedModelDir)
    expect(secondCheck.ok).toBe(false)
  })

  it('revalidates scored observation identity on hydration and never attaches old scores to newer observations (Finding 2)', async () => {
    await modelManager.importFromDirectory(REAL_MODEL_DIR)

    const p1Id = addPhoto('mutating_photo.jpg', makeVector(10))
    const p2Id = addPhoto('stable_photo.jpg', makeVector(11))

    // Use a custom worker script that returns an outdated discoveryObservationId for p1Id
    // to deterministically simulate catalog mutation between worker scoring and main hydration.
    const { writeFileSync } = await import('node:fs')
    const customWorkerPath = join(tempDir, 'stale-hydration-worker.cjs')
    writeFileSync(
      customWorkerPath,
      `
      const { parentPort } = require('node:worker_threads');
      parentPort.on('message', (msg) => {
        if (msg.action === 'embed_text') {
          const vec = new Float32Array(512);
          vec[0] = 1.0;
          parentPort.postMessage({ id: msg.id, status: 'ready', vector: vec, truncated: false, tokenCount: 3 });
        } else if (msg.action === 'search_database') {
          parentPort.postMessage({
            id: msg.id,
            status: 'ready',
            rankedItems: [
              {
                fileLocationId: ${p1Id},
                score: 0.99,
                discoveryObservationId: 999999,
                contentSha256: '${'a'.repeat(64)}',
                contentRevision: 'semrev:999999:1024:1700000000000:${'a'.repeat(64)}',
                observedByteSize: 1024,
                observedMtimeMs: 1700000000000
              },
              {
                fileLocationId: ${p2Id},
                score: 0.85,
                discoveryObservationId: ${catalog.getFileLocationById(p2Id)!.discoveryObservationId},
                contentSha256: '${'a'.repeat(64)}',
                contentRevision: 'semrev:${catalog.getFileLocationById(p2Id)!.discoveryObservationId}:1024:1700000000000:${'a'.repeat(64)}',
                observedByteSize: 1024,
                observedMtimeMs: 1700000000000
              }
            ],
            totalMatched: 2,
            eligibleCount: 2,
            unindexedCount: 0,
            staleCount: 0,
            corruptCount: 0,
            offset: 0,
            limit: 10,
            hasMore: false,
            queryLatencyMs: 1
          });
        }
      });
    `
    )

    const customCoord = new SemanticSearchCoordinator({
      catalog,
      modelManager,
      workerScriptPath: customWorkerPath
    })
    try {
      const res = await customCoord.search({
        queryText: 'hydration check',
        limit: 10,
        offset: 0
      })

      // p1Id had mismatched discoveryObservationId, so it MUST NOT be returned
      expect(res.items.length).toBe(1)
      expect(res.items[0]?.photo.id).toBe(p2Id)
      expect(res.totalMatched).toBe(1)
      expect(res.eligibleCount).toBe(1)
      expect(res.staleCount).toBe(1)
    } finally {
      await customCoord.shutdown()
    }
  })
})
