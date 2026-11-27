/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { CatalogDatabase } from '../../src/main/services/catalog/database'
import { ThumbnailCoordinator } from '../../src/main/services/thumbnails/coordinator'
import { SimilarityCoordinator } from '../../src/main/services/similarity/coordinator'
import {
  SEMANTIC_MODEL_ID,
  SEMANTIC_EMBEDDING_DIMENSIONS,
  REQUIRED_MODEL_ARTIFACTS,
  type SemanticModelArtifactSpec
} from '../../src/main/services/semantic/manifest'
import { SemanticModelManager } from '../../src/main/services/semantic/model-manager'
import { SemanticIndexCoordinator } from '../../src/main/services/semantic/coordinator'

function makeDeterministicUnitVector(seedHex: string): Float32Array {
  const vec = new Float32Array(SEMANTIC_EMBEDDING_DIMENSIONS)
  let sumSq = 0
  for (let i = 0; i < SEMANTIC_EMBEDDING_DIMENSIONS; i++) {
    const byteVal = parseInt(seedHex.slice((i * 2) % 56, ((i * 2) % 56) + 2), 16) || i + 1
    const v = ((byteVal % 100) - 50) / 50
    vec[i] = v
    sumSq += v * v
  }
  const norm = Math.sqrt(sumSq) || 1
  for (let i = 0; i < SEMANTIC_EMBEDDING_DIMENSIONS; i++) {
    vec[i] = (vec[i] ?? 0) / norm
  }
  return vec
}

function buildSyntheticModelDir(baseDir: string): SemanticModelArtifactSpec[] {
  return REQUIRED_MODEL_ARTIFACTS.map((entry, idx) => {
    const buf = Buffer.from(`synthetic-model-weight-${idx}-${entry.relativePath}`)
    const sha256 = createHash('sha256').update(buf).digest('hex')
    const fullPath = join(baseDir, ...entry.relativePath.split('/'))
    mkdirSync(dirname(fullPath), { recursive: true })
    writeFileSync(fullPath, buf)
    return {
      relativePath: entry.relativePath,
      byteSize: buf.byteLength,
      sha256
    }
  })
}

describe('Stage 6B — SemanticIndexCoordinator Resumable Indexing, Verification & Resource Governance', () => {
  let tempDir: string
  let dbPath: string
  let cacheDir: string
  let photosDir: string
  let modelsRootDir: string
  let vaultRootDir: string
  let modelBundleDir: string
  let specs: SemanticModelArtifactSpec[]
  let catalog: CatalogDatabase
  let thumbnailCoordinator: ThumbnailCoordinator
  let modelManager: SemanticModelManager
  let semanticCoordinator: SemanticIndexCoordinator

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'pv-sem-coord-test-'))
    dbPath = join(tempDir, 'catalog.db')
    cacheDir = join(tempDir, 'cache')
    photosDir = join(tempDir, 'photos')
    modelsRootDir = join(tempDir, 'models')
    vaultRootDir = join(tempDir, 'vault')
    modelBundleDir = join(tempDir, 'model-bundle')

    mkdirSync(cacheDir, { recursive: true })
    mkdirSync(photosDir, { recursive: true })
    mkdirSync(modelsRootDir, { recursive: true })
    mkdirSync(vaultRootDir, { recursive: true })
    mkdirSync(modelBundleDir, { recursive: true })

    specs = buildSyntheticModelDir(modelBundleDir)
    catalog = CatalogDatabase.open({ catalogPath: dbPath })
    thumbnailCoordinator = new ThumbnailCoordinator({
      cacheDir,
      approvedRoots: [photosDir],
      maxActiveJobs: 2,
      maxQueuedJobs: 64
    })

    modelManager = new SemanticModelManager({
      modelsRootDir,
      getApprovedRoots: () => [photosDir],
      getVaultRoot: () => vaultRootDir,
      artifacts: specs,
      verifyDirectoryOffMain: (dirPath, artifactSpecs) =>
        thumbnailCoordinator.verifyModelDirectory(dirPath, artifactSpecs)
    })
    await modelManager.initialize()
    await modelManager.importFromDirectory(modelBundleDir)

    semanticCoordinator = new SemanticIndexCoordinator({
      catalog,
      modelManager,
      thumbnailCoordinator,
      embedSourceTask: async (params) => {
        const verified = await thumbnailCoordinator.verifySourceFile({
          sourcePath: params.sourcePath,
          expectedByteSize: params.expectedByteSize,
          expectedMtimeMs: params.expectedMtimeMs
        })
        if (!verified.ok) {
          return verified
        }
        // Decode image in worker to validate format/dimensions
        const phash = await thumbnailCoordinator.computePerceptualHash({
          fileLocationId: params.fileLocationId,
          sourcePath: params.sourcePath,
          expectedByteSize: params.expectedByteSize,
          expectedMtimeMs: params.expectedMtimeMs
        })
        if (phash.status !== 'ok') {
          return {
            ok: false as const,
            category:
              phash.status === 'unsupported_format' ? ('unsupported' as const) : ('error' as const),
            errorCode: phash.errorCode,
            errorMessage: phash.errorMessage
          }
        }
        return {
          ok: true as const,
          sha256: verified.sha256,
          observedByteSize: verified.observedByteSize,
          observedMtimeMs: verified.observedMtimeMs,
          width: phash.width,
          height: phash.height,
          vector: makeDeterministicUnitVector(verified.sha256)
        }
      }
    })
  })

  afterEach(async () => {
    await semanticCoordinator.shutdown()
    await thumbnailCoordinator.shutdown()
    try {
      catalog.close()
    } catch {
      // ignore
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  async function addPhotoToCatalog(
    name: string,
    color: { r: number; g: number; b: number } | Buffer
  ): Promise<{ path: string; size: number; mtimeMs: number; birthtimeMs: number; sha256: string }> {
    const filePath = join(photosDir, name)
    const buf = Buffer.isBuffer(color)
      ? color
      : await sharp({
          create: { width: 120, height: 90, channels: 3, background: color }
        })
          .jpeg()
          .toBuffer()
    writeFileSync(filePath, buf)
    const st = statSync(filePath)
    const sha256 = createHash('sha256').update(buf).digest('hex')
    catalog.persistDiscoveryBatch(photosDir, [
      {
        originalPath: filePath,
        fileName: name,
        extension: name.slice(name.lastIndexOf('.')).toLowerCase(),
        category: 'photo',
        byteSize: st.size,
        birthtimeMs: st.birthtimeMs,
        mtimeMs: st.mtimeMs,
        discoveredAtMs: Date.now()
      }
    ])
    return {
      path: filePath,
      size: st.size,
      mtimeMs: st.mtimeMs,
      birthtimeMs: st.birthtimeMs,
      sha256
    }
  }

  it('indexes photos, preserves original source bytes/size/timestamps, and reports honest coverage', async () => {
    const p1 = await addPhotoToCatalog('red.jpg', { r: 220, g: 30, b: 30 })
    const p2 = await addPhotoToCatalog('green.jpg', { r: 30, g: 220, b: 30 })
    await addPhotoToCatalog('diagram.svg', Buffer.from('<svg></svg>'))
    await addPhotoToCatalog('corrupt.jpg', Buffer.from('not-a-valid-jpeg-stream'))

    const beforeRedBytes = readFileSync(p1.path)
    const beforeGreenBytes = readFileSync(p2.path)

    const started = await semanticCoordinator.startIndexing()
    expect(started.status).toBe('running')
    expect(started.totalPhotos).toBe(4)

    const completed = await semanticCoordinator.waitForCompletion()
    // Job with failures/unsupported files must not claim every photo was indexed
    expect(completed.status).toBe('completed')
    expect(completed.processedPhotos).toBe(2)
    expect(completed.unsupportedPhotos).toBe(1)
    expect(completed.failedPhotos).toBe(1)
    expect(completed.pendingPhotos).toBe(0)
    expect(completed.currentIndexedPhotos).toBe(2)

    // Verify source preservation invariance (bytes, size, birthtimeMs, mtimeMs unchanged)
    const st1After = statSync(p1.path)
    const st2After = statSync(p2.path)
    expect(readFileSync(p1.path).equals(beforeRedBytes)).toBe(true)
    expect(readFileSync(p2.path).equals(beforeGreenBytes)).toBe(true)
    expect(st1After.size).toBe(p1.size)
    expect(st1After.mtimeMs).toBe(p1.mtimeMs)
    expect(st1After.birthtimeMs).toBe(p1.birthtimeMs)
    expect(st2After.size).toBe(p2.size)
    expect(st2After.mtimeMs).toBe(p2.mtimeMs)
    expect(st2After.birthtimeMs).toBe(p2.birthtimeMs)
  })

  it('reuses embeddings for identical verified content only after validating current source contents on disk', async () => {
    const imgBuf = await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 10, g: 80, b: 200 } }
    })
      .jpeg()
      .toBuffer()

    const copyA = await addPhotoToCatalog('copyA.jpg', imgBuf)
    const copyB = await addPhotoToCatalog('copyB.jpg', imgBuf)
    const copyTampered = await addPhotoToCatalog('copyTampered.jpg', imgBuf)

    // Record catalog hashes as if hashing stage already ran
    for (const copy of [copyA, copyB, copyTampered]) {
      catalog.recordHashObservation({
        originalPath: copy.path,
        sha256: copy.sha256,
        observedByteSize: copy.size,
        observedMtimeMs: copy.mtimeMs,
        hashedAtMs: Date.now()
      })
    }

    // Mutate copyTampered on disk AFTER catalog hash was recorded (same byte length, different content)
    const mutatedBuf = Buffer.from(imgBuf)
    mutatedBuf[mutatedBuf.length - 10] = (mutatedBuf[mutatedBuf.length - 10] ?? 0) ^ 0xff
    writeFileSync(copyTampered.path, mutatedBuf)

    let inferenceCount = 0
    const customCoordinator = new SemanticIndexCoordinator({
      catalog,
      modelManager,
      thumbnailCoordinator,
      embedSourceTask: async (params) => {
        inferenceCount += 1
        const verified = await thumbnailCoordinator.verifySourceFile({
          sourcePath: params.sourcePath,
          expectedByteSize: params.expectedByteSize,
          expectedMtimeMs: params.expectedMtimeMs
        })
        if (!verified.ok) return verified
        return {
          ok: true as const,
          sha256: verified.sha256,
          observedByteSize: verified.observedByteSize,
          observedMtimeMs: verified.observedMtimeMs,
          width: 100,
          height: 100,
          vector: makeDeterministicUnitVector(verified.sha256)
        }
      }
    })

    await customCoordinator.startIndexing()
    const result = await customCoordinator.waitForCompletion()

    // copyA runs inference (1), copyB reuses verified embedding after live hash check (reused=1),
    // copyTampered fails live verification because disk content / mtime changed since catalog observation
    expect(inferenceCount).toBe(1)
    expect(result.processedPhotos).toBe(2)
    expect(result.reusedPhotos).toBe(1)
    expect(result.failedPhotos).toBe(1)

    await customCoordinator.shutdown()
  })

  it('rejects source revision changes that occur during processing before commit', async () => {
    const p1 = await addPhotoToCatalog('changing.jpg', { r: 90, g: 90, b: 90 })

    const raceCoordinator = new SemanticIndexCoordinator({
      catalog,
      modelManager,
      thumbnailCoordinator,
      embedSourceTask: async (params) => {
        const verified = await thumbnailCoordinator.verifySourceFile({
          sourcePath: params.sourcePath,
          expectedByteSize: params.expectedByteSize,
          expectedMtimeMs: params.expectedMtimeMs
        })
        if (!verified.ok) return verified

        // Simulate source file being modified on disk while inference was running
        writeFileSync(
          params.sourcePath,
          Buffer.concat([readFileSync(params.sourcePath), Buffer.from('extra')])
        )

        return {
          ok: true as const,
          sha256: verified.sha256,
          observedByteSize: verified.observedByteSize,
          observedMtimeMs: verified.observedMtimeMs,
          width: 120,
          height: 90,
          vector: makeDeterministicUnitVector(verified.sha256)
        }
      }
    })

    await raceCoordinator.startIndexing()
    const done = await raceCoordinator.waitForCompletion()
    expect(done.processedPhotos).toBe(0)
    expect(done.failedPhotos).toBe(1)
    expect(done.currentIndexedPhotos).toBe(0)

    const loc = catalog.getFileLocationByPath(p1.path)!
    expect(
      catalog.getPhotoSemanticEmbedding(
        loc.id,
        SEMANTIC_MODEL_ID,
        modelManager.getStatus().preprocessingVersion
      )
    ).toBeNull()

    await raceCoordinator.shutdown()
  })

  it('preserves exact authorized job scope on resume after new photos are scanned into the catalog', async () => {
    await addPhotoToCatalog('initial1.jpg', { r: 50, g: 10, b: 10 })
    await addPhotoToCatalog('initial2.jpg', { r: 10, g: 50, b: 10 })

    let processedCount = 0
    let pauseResolved = false
    const scopedCoordinator = new SemanticIndexCoordinator({
      catalog,
      modelManager,
      thumbnailCoordinator,
      embedSourceTask: async (params) => {
        const verified = await thumbnailCoordinator.verifySourceFile({
          sourcePath: params.sourcePath,
          expectedByteSize: params.expectedByteSize,
          expectedMtimeMs: params.expectedMtimeMs
        })
        if (!verified.ok) return verified
        processedCount += 1
        if (processedCount === 1) {
          // Pause job right after item 1 enters processing
          setTimeout(() => {
            void scopedCoordinator.pauseIndexing().then(() => {
              pauseResolved = true
            })
          }, 5)
          await new Promise((r) => setTimeout(r, 40))
        }
        return {
          ok: true as const,
          sha256: verified.sha256,
          observedByteSize: verified.observedByteSize,
          observedMtimeMs: verified.observedMtimeMs,
          width: 120,
          height: 90,
          vector: makeDeterministicUnitVector(verified.sha256)
        }
      }
    })

    const started = await scopedCoordinator.startIndexing()
    expect(started.totalPhotos).toBe(2)

    // Wait for pause to take effect
    for (let i = 0; i < 40 && !pauseResolved; i++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    const pausedJob = scopedCoordinator.getStatus()
    expect(pausedJob.status).toBe('paused')
    expect(pausedJob.totalPhotos).toBe(2)

    // Scan a brand new 3rd photo into the catalog while paused
    await addPhotoToCatalog('newly-scanned-later.jpg', { r: 10, g: 10, b: 200 })
    expect(scopedCoordinator.getStatus().totalCatalogPhotos).toBe(3)

    // Resume the paused job — must only complete the authorized 2-photo scope
    const resumed = await scopedCoordinator.resumeIndexing()
    expect(resumed.totalPhotos).toBe(2)
    const finished = await scopedCoordinator.waitForCompletion()
    expect(finished.status).toBe('completed')
    expect(finished.totalPhotos).toBe(2)
    expect(finished.processedPhotos).toBe(2)
    expect(finished.currentIndexedPhotos).toBe(2)
    expect(finished.totalCatalogPhotos).toBe(3)

    await scopedCoordinator.shutdown()
  })

  it('cancels active worker execution after entering processing, tracks terminating workers <= 2, and recovers capacity', async () => {
    await addPhotoToCatalog('long1.jpg', { r: 100, g: 100, b: 100 })
    await addPhotoToCatalog('long2.jpg', { r: 200, g: 200, b: 200 })

    let enteredWorkerProcessing = false
    const cancelCoordinator = new SemanticIndexCoordinator({
      catalog,
      modelManager,
      thumbnailCoordinator,
      embedSourceTask: async (params, signal) => {
        enteredWorkerProcessing = true
        // Wait inside processing until aborted
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => resolve(), 5000)
          signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer)
              reject(new Error('Aborted active semantic task'))
            },
            { once: true }
          )
        })
        const verified = await thumbnailCoordinator.verifySourceFile({
          sourcePath: params.sourcePath,
          expectedByteSize: params.expectedByteSize,
          expectedMtimeMs: params.expectedMtimeMs
        })
        if (!verified.ok) return verified
        return {
          ok: true as const,
          sha256: verified.sha256,
          observedByteSize: verified.observedByteSize,
          observedMtimeMs: verified.observedMtimeMs,
          width: 120,
          height: 90,
          vector: makeDeterministicUnitVector(verified.sha256)
        }
      }
    })

    await cancelCoordinator.startIndexing()
    for (let i = 0; i < 50 && !enteredWorkerProcessing; i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(enteredWorkerProcessing).toBe(true)

    const cancelled = await cancelCoordinator.cancelIndexing()
    expect(cancelled.status).toBe('cancelled')

    const diag = thumbnailCoordinator.getDiagnostics()
    expect(diag.liveWorkers).toBeLessThanOrEqual(2)
    expect(diag.activeWorkers).toBeLessThanOrEqual(2)

    // Verify capacity recovery: an interactive thumbnail request immediately succeeds
    const loc = catalog.getFileLocationByPath(join(photosDir, 'long1.jpg'))!
    const thumb = await thumbnailCoordinator.requestThumbnail({
      photoId: loc.id,
      fileLocationId: loc.id,
      sourcePath: loc.originalPath,
      expectedByteSize: loc.byteSize,
      expectedMtimeMs: loc.filesystemMtimeMs,
      discoveryObservationId: loc.discoveryObservationId,
      priority: 'high'
    })
    expect(thumb.status).toBe('ready')

    await cancelCoordinator.shutdown()
  })

  it('coexists with interactive thumbnails and perceptual similarity processing within <= 2 workers and <= 64 queue', async () => {
    const photos: Awaited<ReturnType<typeof addPhotoToCatalog>>[] = []
    for (let i = 0; i < 6; i++) {
      photos.push(
        await addPhotoToCatalog(`concurrent_${i}.jpg`, {
          r: (i * 40) % 255,
          g: (i * 70) % 255,
          b: (i * 110) % 255
        })
      )
    }

    const similarityCoordinator = new SimilarityCoordinator({
      catalog,
      thumbnailCoordinator
    })

    await semanticCoordinator.startIndexing()
    await similarityCoordinator.startAnalysis()

    // Concurrently fire high-priority interactive thumbnail requests
    const thumbPromises = photos.map((p) => {
      const loc = catalog.getFileLocationByPath(p.path)!
      return thumbnailCoordinator.requestThumbnail({
        photoId: loc.id,
        fileLocationId: loc.id,
        sourcePath: loc.originalPath,
        expectedByteSize: loc.byteSize,
        expectedMtimeMs: loc.filesystemMtimeMs,
        discoveryObservationId: loc.discoveryObservationId,
        priority: 'high'
      })
    })

    const diagDuring = thumbnailCoordinator.getDiagnostics()
    expect(diagDuring.liveWorkers).toBeLessThanOrEqual(2)
    expect(diagDuring.queuedJobs).toBeLessThanOrEqual(64)

    const thumbs = await Promise.all(thumbPromises)
    for (const t of thumbs) {
      expect(t.status).toBe('ready')
    }

    const [semDone, simDone] = await Promise.all([
      semanticCoordinator.waitForCompletion(),
      similarityCoordinator.waitForCompletion()
    ])
    expect(semDone.status).toBe('completed')
    expect(semDone.processedPhotos).toBe(6)
    expect(simDone.status).toBe('completed')
    expect(simDone.processedPhotos).toBe(6)

    const diagAfter = thumbnailCoordinator.getDiagnostics()
    expect(diagAfter.liveWorkers).toBeLessThanOrEqual(2)

    await similarityCoordinator.shutdown()
  })

  it('marks running jobs as interrupted on startup and runs real worker ONNX CLIP ViT-B/32 vision inference when model cache is present', async () => {
    const p1 = await addPhotoToCatalog('real1.jpg', { r: 240, g: 50, b: 30 })
    const p2 = await addPhotoToCatalog('real2.jpg', { r: 30, g: 50, b: 240 })

    // Create a running job directly in SQLite to simulate a sudden process kill
    const rawJob = catalog.createSemanticIndexJob({
      modelId: SEMANTIC_MODEL_ID,
      modelCommit: modelManager.getStatus().modelCommit,
      modelManifestSha256: modelManager.getStatus().modelManifestSha256,
      preprocessingVersion: modelManager.getStatus().preprocessingVersion
    })
    expect(rawJob.status).toBe('running')

    // Startup initialize() must identify and mark the running job as 'interrupted' without auto-resuming
    const startupStatus = semanticCoordinator.initialize()
    expect(startupStatus.status).toBe('interrupted')
    expect(startupStatus.pendingPhotos).toBe(2)

    // If the real evaluated CLIP model is cached locally, exercise real worker ONNX vision inference
    const cachedRealModelDir = join(
      process.cwd(),
      'spikes',
      'semantic-eval',
      '.model-cache',
      'Xenova--clip-vit-base-patch32'
    )
    if (statSync(cachedRealModelDir, { throwIfNoEntry: false })?.isDirectory()) {
      const realModelsRoot = join(tempDir, 'real-models')
      mkdirSync(realModelsRoot, { recursive: true })
      const realModelManager = new SemanticModelManager({
        modelsRootDir: realModelsRoot,
        getApprovedRoots: () => [photosDir],
        getVaultRoot: () => vaultRootDir,
        artifacts: REQUIRED_MODEL_ARTIFACTS,
        verifyDirectoryOffMain: (dirPath, artifactSpecs) =>
          thumbnailCoordinator.verifyModelDirectory(dirPath, artifactSpecs)
      })
      await realModelManager.initialize()
      const imported = await realModelManager.importFromDirectory(cachedRealModelDir)
      expect(imported.state).toBe('ready')

      const realSemanticCoordinator = new SemanticIndexCoordinator({
        catalog,
        modelManager: realModelManager,
        thumbnailCoordinator
      })

      // Cancel the old synthetic-manifest job and start a real ONNX indexing job
      await semanticCoordinator.cancelIndexing()
      await realSemanticCoordinator.startIndexing()
      const done = await realSemanticCoordinator.waitForCompletion()
      expect(done.status).toBe('completed')
      expect(done.processedPhotos).toBe(2)
      expect(done.currentIndexedPhotos).toBe(2)

      const loc1 = catalog.getFileLocationByPath(p1.path)!
      const loc2 = catalog.getFileLocationByPath(p2.path)!
      const emb1 = catalog.getPhotoSemanticEmbedding(
        loc1.id,
        SEMANTIC_MODEL_ID,
        realModelManager.getStatus().preprocessingVersion
      )
      const emb2 = catalog.getPhotoSemanticEmbedding(
        loc2.id,
        SEMANTIC_MODEL_ID,
        realModelManager.getStatus().preprocessingVersion
      )
      expect(emb1).not.toBeNull()
      expect(emb2).not.toBeNull()
      expect(emb1!.vector.length).toBe(512)
      expect(emb2!.vector.length).toBe(512)

      await realSemanticCoordinator.shutdown()
    }
  })
})
