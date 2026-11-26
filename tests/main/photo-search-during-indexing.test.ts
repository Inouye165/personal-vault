// @vitest-environment node
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { CatalogDatabase } from '../../src/main/services/catalog/database'
import { ThumbnailCoordinator } from '../../src/main/services/thumbnails/coordinator'
import {
  SEMANTIC_EMBEDDING_DIMENSIONS,
  SEMANTIC_MODEL_COMMIT,
  SEMANTIC_MODEL_ID,
  SEMANTIC_PREPROCESSING_VERSION,
  SemanticIndexCoordinator,
  SemanticModelManager,
  SemanticSearchCoordinator
} from '../../src/main/services/semantic'
import { PhotoSearchCoordinator } from '../../src/main/services/search'
import { UnifiedSearchCoordinator } from '../../src/main/services/unified-search'
import { AppWorkerBudget } from '../../src/main/services/worker-budget'
import { PhotoMetadataCoordinator } from '../../src/main/services/metadata/coordinator'
import { createJpegFixture, buildGpsTags, EXIF_TAG_IDS } from '../helpers/exif-fixture-builder'

const OFFLINE_CLIP_MODEL_CACHE =
  'D:\\workspace\\personal-vault\\spikes\\semantic-eval\\.model-cache\\Xenova--clip-vit-base-patch32'

describe('Visual search responsiveness during active indexing & cooperative yielding', () => {
  const tempDirs: string[] = []
  const cleanups: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    for (const fn of cleanups.splice(0).reverse()) {
      try {
        await fn()
      } catch {
        // ignore cleanup errors
      }
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('deterministically holds indexing in progress, completes interactive visual search with partial results, yields cleanly, and resumes indexing', async () => {
    if (!existsSync(join(OFFLINE_CLIP_MODEL_CACHE, 'config.json'))) {
      return
    }

    const workDir = mkdtempSync(join(tmpdir(), 'pv-search-idx-hold-'))
    tempDirs.push(workDir)
    const photoDir = join(workDir, 'photos')
    const cacheDir = join(workDir, 'thumbs')
    const modelsRoot = join(workDir, 'models')
    const importDir = join(workDir, 'import-model')
    const catalogPath = join(workDir, 'catalog.db')
    mkdirSync(photoDir, { recursive: true })
    cpSync(OFFLINE_CLIP_MODEL_CACHE, importDir, { recursive: true })

    // Create 4 real JPEG photos: 1 already indexed, 3 queued for active indexing
    const sampleBuf = await createJpegFixture({
      ifd0Tags: [{ tagId: EXIF_TAG_IDS.Model, type: 'ascii', value: 'Canon EOS R5' }],
      exifTags: [
        { tagId: EXIF_TAG_IDS.DateTimeOriginal, type: 'ascii', value: '2025:06:06 10:00:00' }
      ],
      gpsTags: buildGpsTags({ lat: 44.6, lon: -110.5 }), // Yellowstone GPS
      littleEndian: true
    })
    const photoPaths = Array.from({ length: 4 }, (_, i) => {
      const p = join(photoDir, `photo_${i}.jpg`)
      writeFileSync(p, sampleBuf)
      return p
    })

    const catalog = CatalogDatabase.open({ catalogPath })
    cleanups.push(() => {
      if (!catalog.isClosed()) catalog.close()
    })

    const st0 = statSync(photoPaths[0]!)
    catalog.persistDiscoveryBatch(
      photoDir,
      photoPaths.map((p, i) => {
        const fileStat = statSync(p)
        return {
          originalPath: p,
          fileName: `photo_${i}.jpg`,
          extension: '.jpg',
          category: 'photo' as const,
          byteSize: fileStat.size,
          birthtimeMs: fileStat.birthtimeMs,
          mtimeMs: fileStat.mtimeMs,
          discoveredAtMs: Date.now()
        }
      })
    )

    const modelMgr = new SemanticModelManager({
      modelsRootDir: modelsRoot,
      getApprovedRoots: () => [photoDir],
      getVaultRoot: () => null
    })
    await modelMgr.initialize()
    const imp = await modelMgr.importFromDirectory(importDir)
    expect(imp.state).toBe('ready')

    // Pre-populate 1 indexed embedding so partial visual results can be returned immediately
    const raw = new DatabaseSync(catalogPath)
    const firstRow = raw
      .prepare(
        'SELECT f.id AS locId, d.id AS obsId FROM file_locations f JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1 ORDER BY f.id ASC LIMIT 1'
      )
      .get() as { locId: number; obsId: number }
    const vec = new Float32Array(SEMANTIC_EMBEDDING_DIMENSIONS)
    vec[0] = 1
    raw
      .prepare(
        `
        INSERT INTO photo_semantic_embeddings (
          file_id, file_location_id, discovery_observation_id, content_sha256, content_revision,
          source_path, observed_byte_size, observed_mtime_ms, model_id, model_commit, model_manifest_sha256,
          preprocessing_version, embedding_dimensions, embedding_blob, created_at_ms, is_current
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 512, ?, ?, 1)
      `
      )
      .run(
        firstRow.locId,
        firstRow.locId,
        firstRow.obsId,
        'a'.repeat(64),
        `semrev:${firstRow.obsId}:${st0.size}:${st0.mtimeMs}:${'a'.repeat(64)}`,
        photoPaths[0]!,
        st0.size,
        st0.mtimeMs,
        SEMANTIC_MODEL_ID,
        SEMANTIC_MODEL_COMMIT,
        modelMgr.getStatus().modelManifestSha256,
        SEMANTIC_PREPROCESSING_VERSION,
        Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength),
        Date.now()
      )
    raw.close()

    const budget = new AppWorkerBudget(3)
    const thumbCoord = new ThumbnailCoordinator({
      cacheDir,
      approvedRoots: () => [photoDir],
      maxAppLiveWorkers: 3,
      workerBudget: budget
    })
    await thumbCoord.initialize()
    cleanups.push(() => thumbCoord.shutdown())

    const searchCoord = new SemanticSearchCoordinator({
      catalog,
      modelManager: modelMgr,
      maxAppLiveWorkers: 3,
      workerBudget: budget,
      tryReleaseExternalIdleWorker: () => thumbCoord.releaseOneIdleWorker()
    })
    cleanups.push(() => searchCoord.shutdown())

    const unifiedCoord = new UnifiedSearchCoordinator({
      semanticSearchCoordinator: searchCoord
    })
    cleanups.push(() => unifiedCoord.shutdown())

    const metaCoord = new PhotoMetadataCoordinator({ catalog, thumbnailCoordinator: thumbCoord })
    metaCoord.initialize()
    await metaCoord.startExtraction()
    const metaDone = await metaCoord.waitForCompletion()
    expect(metaDone.coverage.extractedCount).toBe(4)
    cleanups.push(() => metaCoord.shutdown())

    const photoSearchCoord = new PhotoSearchCoordinator({
      catalog,
      unifiedSearchCoordinator: unifiedCoord,
      semanticModelManager: modelMgr,
      photoMetadataCoordinator: metaCoord
    })

    // Deterministic barrier: hold indexing item #1 in progress while interactive search runs
    let markIndexingHeld!: () => void
    const indexingHeld = new Promise<void>((resolve) => {
      markIndexingHeld = resolve
    })
    let releaseHeldIndexing!: () => void
    const heldIndexingGate = new Promise<void>((resolve) => {
      releaseHeldIndexing = resolve
    })
    let embedCalls = 0
    let embedStartedWhileSearchActive = 0

    const indexCoord = new SemanticIndexCoordinator({
      catalog,
      modelManager: modelMgr,
      thumbnailCoordinator: thumbCoord,
      shouldYieldToInteractiveSearch: () => searchCoord.hasActiveSearch(),
      embedSourceTask: async (params) => {
        embedCalls += 1
        if (searchCoord.hasActiveSearch()) {
          embedStartedWhileSearchActive += 1
        }
        if (embedCalls === 1) {
          markIndexingHeld()
          await heldIndexingGate
        }
        const outVec = new Float32Array(SEMANTIC_EMBEDDING_DIMENSIONS)
        outVec[0] = 1
        return {
          ok: true,
          sha256: 'b'.repeat(64),
          observedByteSize: params.expectedByteSize,
          observedMtimeMs: params.expectedMtimeMs,
          width: 64,
          height: 64,
          vector: outVec
        }
      }
    })
    indexCoord.initialize()
    // Register shutdown before release so reverse cleanup releases the gate first
    cleanups.push(() => indexCoord.shutdown())
    cleanups.push(() => releaseHeldIndexing())

    await indexCoord.startIndexing()
    await indexingHeld
    expect(indexCoord.getStatus().status).toBe('running')

    // 1. Visual search "hawaii" while indexing is held in progress -> completes and reports partial results
    const visualDuringActive = await photoSearchCoord.search({
      queryText: 'hawaii',
      minScore: -1
    })
    expect(visualDuringActive.mode).toBe('visual_only')
    expect(visualDuringActive.eligibleCount).toBe(1)
    expect(visualDuringActive.unindexedCount).toBe(3)
    expect(visualDuringActive.items).toHaveLength(1)
    expect(embedStartedWhileSearchActive).toBe(0)

    // 2. Concurrent same-query pagination (offset=0 and offset=50) serializes cleanly without timeout
    const [page0, page1] = await Promise.all([
      photoSearchCoord.search({ queryText: 'hawaii', offset: 0, limit: 50, minScore: -1 }),
      photoSearchCoord.search({ queryText: 'hawaii', offset: 50, limit: 50, minScore: -1 })
    ])
    expect(page0.items).toHaveLength(1)
    expect(page1.items).toHaveLength(0)

    // 3. Metadata-only GPS+date query during active indexing completes without touching visual model
    const gpsDateDuringActive = await photoSearchCoord.search({
      queryText: 'Show me Yellowstone in 2025'
    })
    expect(gpsDateDuringActive.mode).toBe('metadata_only')
    expect(gpsDateDuringActive.totalMatched).toBe(4)

    // 4. Release indexing and verify remaining items complete cleanly
    releaseHeldIndexing()
    const completed = await indexCoord.waitForCompletion()
    expect(completed.status).toBe('completed')
    expect(completed.currentIndexedPhotos).toBe(4)

    // 5. Filtered hybrid query after indexing completes
    const hybridAfter = await photoSearchCoord.search({ queryText: 'Mountains in Yellowstone' })
    expect(hybridAfter.mode).toBe('hybrid')
    expect(hybridAfter.filteredCandidateCount).toBe(4)
  }, 60_000)

  it('compares 7,974-photo catalog visual search latency across active, paused, and idle indexing plus GPS-and-date query', async () => {
    if (!existsSync(join(OFFLINE_CLIP_MODEL_CACHE, 'config.json'))) {
      return
    }

    const workDir = mkdtempSync(join(tmpdir(), 'pv-scale-timing-'))
    tempDirs.push(workDir)
    const photoDir = join(workDir, 'photos')
    const cacheDir = join(workDir, 'thumbs')
    const modelsRoot = join(workDir, 'models')
    const importDir = join(workDir, 'import-model')
    const catalogPath = join(workDir, 'catalog.db')
    mkdirSync(photoDir, { recursive: true })
    cpSync(OFFLINE_CLIP_MODEL_CACHE, importDir, { recursive: true })

    const sampleBuf = await sharp({
      create: { width: 320, height: 240, channels: 3, background: { r: 80, g: 150, b: 220 } }
    })
      .jpeg({ quality: 85 })
      .toBuffer()

    const realFiles = Array.from({ length: 160 }, (_, i) => {
      const p = join(photoDir, `img_${i}.jpg`)
      writeFileSync(p, sampleBuf)
      return p
    })

    const catalog = CatalogDatabase.open({ catalogPath })
    cleanups.push(() => {
      if (!catalog.isClosed()) catalog.close()
    })

    const st = statSync(realFiles[0]!)
    const now = Date.now()
    const rows = Array.from({ length: 7974 }, (_, i) => ({
      originalPath: i < realFiles.length ? realFiles[i]! : join(photoDir, `unseen_${i}.jpg`),
      fileName: `img_${i}.jpg`,
      extension: '.jpg',
      category: 'photo' as const,
      byteSize: st.size,
      birthtimeMs: st.birthtimeMs,
      mtimeMs: st.mtimeMs,
      discoveredAtMs: now
    }))
    for (let off = 0; off < rows.length; off += 500) {
      catalog.persistDiscoveryBatch(photoDir, rows.slice(off, off + 500))
    }

    const modelMgr = new SemanticModelManager({
      modelsRootDir: modelsRoot,
      getApprovedRoots: () => [photoDir],
      getVaultRoot: () => null
    })
    await modelMgr.initialize()
    await modelMgr.importFromDirectory(importDir)

    const raw = new DatabaseSync(catalogPath)
    const allIds = raw
      .prepare(
        'SELECT f.id AS locId, d.id AS obsId, f.original_path AS origPath FROM file_locations f JOIN discovery_observations d ON d.file_location_id = f.id AND d.is_current = 1 ORDER BY f.id ASC'
      )
      .all() as Array<{ locId: number; obsId: number; origPath: string }>
    raw.exec('BEGIN IMMEDIATE;')
    const insEmb = raw.prepare(`
      INSERT INTO photo_semantic_embeddings (
        file_id, file_location_id, discovery_observation_id, content_sha256, content_revision,
        source_path, observed_byte_size, observed_mtime_ms, model_id, model_commit, model_manifest_sha256,
        preprocessing_version, embedding_dimensions, embedding_blob, created_at_ms, is_current
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 512, ?, ?, 1)
    `)
    const vec = new Float32Array(SEMANTIC_EMBEDDING_DIMENSIONS)
    vec[0] = 1
    const blob = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength)
    const mSha = modelMgr.getStatus().modelManifestSha256
    for (let i = 0; i < 133; i++) {
      const r = allIds[i]!
      const sha = 'c'.repeat(64)
      insEmb.run(
        r.locId,
        r.locId,
        r.obsId,
        sha,
        `semrev:${r.obsId}:${st.size}:${st.mtimeMs}:${sha}`,
        r.origPath,
        st.size,
        st.mtimeMs,
        SEMANTIC_MODEL_ID,
        SEMANTIC_MODEL_COMMIT,
        mSha,
        SEMANTIC_PREPROCESSING_VERSION,
        blob,
        now
      )
    }
    raw.exec('COMMIT;')
    raw.close()

    const budget = new AppWorkerBudget(3)
    const thumbCoord = new ThumbnailCoordinator({
      cacheDir,
      approvedRoots: () => [photoDir],
      maxAppLiveWorkers: 3,
      workerBudget: budget
    })
    await thumbCoord.initialize()
    cleanups.push(() => thumbCoord.shutdown())

    const searchCoord = new SemanticSearchCoordinator({
      catalog,
      modelManager: modelMgr,
      maxAppLiveWorkers: 3,
      workerBudget: budget,
      tryReleaseExternalIdleWorker: () => thumbCoord.releaseOneIdleWorker()
    })
    cleanups.push(() => searchCoord.shutdown())

    const indexCoord = new SemanticIndexCoordinator({
      catalog,
      modelManager: modelMgr,
      thumbnailCoordinator: thumbCoord,
      shouldYieldToInteractiveSearch: () => searchCoord.hasActiveSearch()
    })
    indexCoord.initialize()
    cleanups.push(() => indexCoord.shutdown())

    await indexCoord.startIndexing()

    const tActive0 = performance.now()
    const resActive = await searchCoord.search({ queryText: 'hawaii' })
    const activeMs = performance.now() - tActive0
    expect(resActive.eligibleCount).toBeGreaterThanOrEqual(133)
    expect(resActive.unindexedCount).toBeGreaterThan(7000)

    await indexCoord.pauseIndexing()
    const tPaused0 = performance.now()
    const resPaused = await searchCoord.search({ queryText: 'hawaii sunset' })
    const pausedMs = performance.now() - tPaused0
    expect(resPaused.eligibleCount).toBeGreaterThanOrEqual(133)

    await indexCoord.cancelIndexing()
    const tIdle0 = performance.now()
    const resIdle = await searchCoord.search({ queryText: 'ocean beach' })
    const idleMs = performance.now() - tIdle0
    expect(resIdle.eligibleCount).toBeGreaterThanOrEqual(133)

    console.log('[BENCH] 7,974-photo search latencies (ms):', {
      activeMs: Math.round(activeMs),
      pausedMs: Math.round(pausedMs),
      idleMs: Math.round(idleMs)
    })

    expect(activeMs).toBeLessThan(15_000)
    expect(pausedMs).toBeLessThan(15_000)
    expect(idleMs).toBeLessThan(15_000)
  }, 60_000)
})
