// @vitest-environment node
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CatalogDatabase } from '../../src/main/services/catalog/database'
import {
  AutoMetadataExtractionScheduler,
  METADATA_PARSER_RECIPE_VERSION,
  PhotoMetadataCoordinator
} from '../../src/main/services/metadata'
import { extractPhotoMetadataFromFile } from '../../src/main/services/metadata/extractor'
import { ThumbnailCoordinator } from '../../src/main/services/thumbnails/coordinator'
import { SemanticModelManager } from '../../src/main/services/semantic/model-manager'
import { SemanticIndexCoordinator } from '../../src/main/services/semantic/coordinator'
import { AutoSemanticIndexScheduler } from '../../src/main/services/semantic/auto-index-scheduler'
import {
  REQUIRED_MODEL_ARTIFACTS,
  SEMANTIC_EMBEDDING_DIMENSIONS,
  type SemanticModelArtifactSpec
} from '../../src/main/services/semantic/manifest'
import { PhotoSearchCoordinator } from '../../src/main/services/search/photo-search-coordinator'
import { copyAndVerifyFileToVault } from '../../src/main/services/vault/copier'
import { initializeVault } from '../../src/main/services/vault/identity'
import { buildGpsTags, createJpegFixture, EXIF_TAG_IDS } from '../helpers/exif-fixture-builder'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function buildDeterministicVector(seed: number): Float32Array {
  const vec = new Float32Array(SEMANTIC_EMBEDDING_DIMENSIONS)
  let sumSq = 0
  for (let i = 0; i < SEMANTIC_EMBEDDING_DIMENSIONS; i++) {
    const val = Math.sin((i + 1) * (seed + 1) * 0.13)
    vec[i] = val
    sumSq += val * val
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

function scanPhotoIntoCatalog(catalog: CatalogDatabase, rootDir: string, filePath: string): number {
  const st = statSync(filePath)
  const fileName = filePath.slice(
    Math.max(filePath.lastIndexOf('\\'), filePath.lastIndexOf('/')) + 1
  )
  catalog.persistDiscoveryBatch(rootDir, [
    {
      originalPath: filePath,
      fileName,
      extension: extname(filePath).toLowerCase(),
      category: 'photo',
      byteSize: st.size,
      birthtimeMs: st.birthtimeMs,
      mtimeMs: st.mtimeMs,
      discoveredAtMs: Date.now()
    }
  ])
  const page = catalog.queryFileLocations({ category: 'photo', limit: 200, offset: 0 })
  const found = page.items.find((i) => i.originalPath === filePath)
  if (!found) throw new Error(`Missing catalog entry for ${filePath}`)
  return found.id
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 5000,
  describeState?: () => string
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(20)
  }
  throw new Error(`Timed out waiting for condition${describeState ? `: ${describeState()}` : ''}`)
}

describe('Catalog repair on rescan, startup catch-up, attention items, and protection status', () => {
  let tempDir: string
  let rootDir: string
  let cacheDir: string
  let modelsDir: string
  let bundleDir: string
  let catalog: CatalogDatabase
  let thumbCoordinator: ThumbnailCoordinator
  let modelManager: SemanticModelManager
  let metaCoordinator: PhotoMetadataCoordinator | null = null
  let semanticCoordinator: SemanticIndexCoordinator | null = null

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'pv-catalog-repair-'))
    rootDir = join(tempDir, 'photos')
    cacheDir = join(tempDir, 'thumb-cache')
    modelsDir = join(tempDir, 'models')
    bundleDir = join(tempDir, 'model-bundle')
    mkdirSync(rootDir, { recursive: true })
    mkdirSync(cacheDir, { recursive: true })
    mkdirSync(modelsDir, { recursive: true })
    mkdirSync(bundleDir, { recursive: true })

    const specs = buildSyntheticModelDir(bundleDir)
    catalog = CatalogDatabase.open({ catalogPath: join(tempDir, 'vault-catalog.db') })
    thumbCoordinator = new ThumbnailCoordinator({
      cacheDir,
      approvedRoots: () => [rootDir],
      maxActiveJobs: 2,
      maxQueuedJobs: 64,
      jobTimeoutMs: 5_000
    })
    modelManager = new SemanticModelManager({
      modelsRootDir: modelsDir,
      getApprovedRoots: () => [bundleDir],
      getVaultRoot: () => null,
      artifacts: specs,
      verifyDirectoryOffMain: async () => ({ ok: true })
    })
    await modelManager.initialize()
    await modelManager.importFromDirectory(bundleDir)

    metaCoordinator = new PhotoMetadataCoordinator({
      catalog,
      thumbnailCoordinator: thumbCoordinator
    })
    metaCoordinator.initialize()

    semanticCoordinator = new SemanticIndexCoordinator({
      catalog,
      modelManager,
      thumbnailCoordinator: thumbCoordinator,
      embedSourceTask: async ({
        fileLocationId,
        sourcePath,
        expectedByteSize,
        expectedMtimeMs
      }) => {
        const buf = readFileSync(sourcePath)
        const sha256 = createHash('sha256').update(buf).digest('hex')
        return {
          ok: true,
          sha256,
          observedByteSize: expectedByteSize,
          observedMtimeMs: expectedMtimeMs,
          width: 64,
          height: 48,
          vector: buildDeterministicVector(fileLocationId)
        }
      }
    })
    semanticCoordinator.initialize()
  })

  afterEach(async () => {
    await metaCoordinator?.shutdown()
    await semanticCoordinator?.shutdown()
    await thumbCoordinator.shutdown()
    catalog.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('catches up unextracted metadata and partial visual index on startup and on unchanged rescan while preserving collections and annotations', async () => {
    const yellowstonePath = join(rootDir, 'yellowstone_gps.jpg')
    const noGpsPath = join(rootDir, 'no_gps.jpg')
    const corruptPath = join(rootDir, 'corrupt.jpg')
    const missingPath = join(rootDir, 'temporary_offline.jpg')

    writeFileSync(
      yellowstonePath,
      await createJpegFixture({
        width: 64,
        height: 48,
        ifd0Tags: [
          { tagId: EXIF_TAG_IDS.Make, type: 'ascii', value: 'Apple' },
          { tagId: EXIF_TAG_IDS.Model, type: 'ascii', value: 'iPhone 15 Pro' }
        ],
        exifTags: [
          { tagId: EXIF_TAG_IDS.DateTimeOriginal, type: 'ascii', value: '2025:09:22 10:15:00' },
          { tagId: EXIF_TAG_IDS.OffsetTimeOriginal, type: 'ascii', value: '-06:00' },
          { tagId: EXIF_TAG_IDS.LensMake, type: 'ascii', value: 'Apple' },
          { tagId: EXIF_TAG_IDS.LensModel, type: 'ascii', value: 'Main Camera 24mm' }
        ],
        gpsTags: buildGpsTags({ lat: 44.710567, lon: -110.505525 })
      })
    )

    writeFileSync(
      noGpsPath,
      await createJpegFixture({
        width: 64,
        height: 48,
        exifTags: [
          { tagId: EXIF_TAG_IDS.DateTimeOriginal, type: 'ascii', value: '2025:06:12 09:00:00' }
        ]
      })
    )

    writeFileSync(corruptPath, Buffer.from('not-a-valid-jpeg-payload'))
    const missingBytes = await createJpegFixture({ width: 48, height: 36 })
    writeFileSync(missingPath, missingBytes)

    const yellowId = scanPhotoIntoCatalog(catalog, rootDir, yellowstonePath)
    const noGpsId = scanPhotoIntoCatalog(catalog, rootDir, noGpsPath)
    const corruptId = scanPhotoIntoCatalog(catalog, rootDir, corruptPath)
    const missingId = scanPhotoIntoCatalog(catalog, rootDir, missingPath)
    const hiddenMissingPath = join(tempDir, 'temporary_offline_hidden.jpg')

    // Preserve user work: collection + annotation
    const col = catalog.createCollection({ name: 'Parks' })
    const rev = catalog.getPhotoRevisionString(yellowId)
    catalog.addCollectionMember({
      collectionId: col.id,
      fileLocationId: yellowId,
      expectedRevision: rev
    })
    catalog.setPhotoAnnotation({
      fileLocationId: yellowId,
      rating: 5,
      flag: 'pick',
      expectedRevision: rev,
      expectedVersion: 0
    })

    // Simulate external/offline photo unavailable before catch-up runs
    renameSync(missingPath, hiddenMissingPath)

    // Partial visual index: pre-populate only noGpsPath
    const modelStatus = modelManager.getStatus()
    const obsNoGps = catalog.getFileLocationById(noGpsId)!
    const noGpsBuf = readFileSync(noGpsPath)
    const noGpsSha = createHash('sha256').update(noGpsBuf).digest('hex')
    catalog.savePhotoSemanticEmbedding({
      fileId: null,
      fileLocationId: noGpsId,
      discoveryObservationId: obsNoGps.discoveryObservationId,
      contentSha256: noGpsSha,
      contentRevision: `semrev:${obsNoGps.discoveryObservationId}:${obsNoGps.byteSize}:${obsNoGps.filesystemMtimeMs ?? 0}:${noGpsSha}`,
      sourcePath: noGpsPath,
      observedByteSize: obsNoGps.byteSize,
      observedMtimeMs: obsNoGps.filesystemMtimeMs ?? 0,
      modelId: modelStatus.modelId,
      modelCommit: modelStatus.modelCommit,
      modelManifestSha256: modelStatus.modelManifestSha256,
      preprocessingVersion: modelStatus.preprocessingVersion,
      embeddingDimensions: SEMANTIC_EMBEDDING_DIMENSIONS,
      vector: buildDeterministicVector(noGpsId),
      width: 64,
      height: 48
    })

    const metaScheduler = new AutoMetadataExtractionScheduler({
      photoMetadataCoordinator: metaCoordinator!,
      isCatalogClosed: () => catalog.isClosed(),
      startupDelayMs: 0
    })

    const semScheduler = new AutoSemanticIndexScheduler({
      catalog,
      semanticIndexCoordinator: semanticCoordinator!,
      semanticModelManager: modelManager,
      isCatalogClosed: () => catalog.isClosed(),
      startupDelayMs: 0,
      settleDelayMs: 0
    })

    metaScheduler.initialize()
    semScheduler.initialize()

    await waitUntil(() => {
      const mc = metaCoordinator!.getProgress().coverage
      const sc = semanticCoordinator!.getStatus()
      return mc.unprocessedCount === 0 && sc.status === 'completed' && sc.currentIndexedPhotos >= 2
    })

    const afterCatchUpMeta = metaCoordinator!.getProgress().coverage
    expect(afterCatchUpMeta.extractedCount).toBe(2)
    expect(afterCatchUpMeta.failedCount + afterCatchUpMeta.unavailableCount).toBe(2)

    // Verify attention items list individual unavailable & failed files
    const attention = catalog.listPhotoMetadataAttentionItems({
      parserRecipeVersion: METADATA_PARSER_RECIPE_VERSION
    })
    expect(attention.totalCount).toBe(2)
    expect(attention.items.map((i) => i.fileName).sort()).toEqual([
      'corrupt.jpg',
      'temporary_offline.jpg'
    ])
    const corruptItem = attention.items.find((i) => i.fileLocationId === corruptId)!
    expect(corruptItem.extractionStatus).toBe('failed')
    expect(corruptItem.errorMessage).toBeTruthy()
    const missingItem = attention.items.find((i) => i.fileLocationId === missingId)!
    expect(missingItem.extractionStatus).toBe('unavailable')

    // Collections & annotations preserved
    expect(
      catalog
        .getCollectionMembershipsForPhoto({ fileLocationId: yellowId })
        .items.map((m) => m.collectionName)
    ).toEqual(['Parks'])
    expect(catalog.getPhotoAnnotation(yellowId)?.rating).toBe(5)

    // Date + GPS searches work immediately after catch-up saves metadata
    const searchCoord = new PhotoSearchCoordinator({
      catalog,
      unifiedSearchCoordinator: null,
      semanticModelManager: modelManager,
      photoMetadataCoordinator: metaCoordinator
    })
    const savedPlace = catalog.upsertSavedPlace({
      name: 'Yellowstone National Park',
      minLat: 44.1,
      maxLat: 45.1,
      minLon: -111.1,
      maxLon: -109.8,
      centerLat: 44.6,
      centerLon: -110.5
    })
    const combinedRes = await searchCoord.search({
      queryText: '',
      captureDateFrom: '2025-09-22',
      captureDateTo: '2025-09-22',
      filterOverrides: {
        place: {
          source: 'saved_place',
          savedPlaceId: savedPlace.id,
          label: 'Yellowstone National Park',
          normalizedLabel: 'yellowstone national park',
          gpsBounds: { minLat: 44.1, maxLat: 45.1, minLon: -111.1, maxLon: -109.8 }
        },
        date: null,
        camera: null,
        visualTerms: null
      },
      offset: 0,
      limit: 50
    })
    expect(combinedRes.totalMatched).toBe(1)
    expect(combinedRes.items[0]!.photo.id).toBe(yellowId)

    // Reconnect missingPath with exact original file (unplugged drive reconnected)
    // and trigger unchanged folder rescan -> unavailable item recovers!
    renameSync(hiddenMissingPath, missingPath)
    metaScheduler.onScanProgress({ jobId: 2, status: 'completed' })
    semScheduler.onScanProgress({ jobId: 2, status: 'completed' })

    await waitUntil(
      () => {
        const cov = metaCoordinator!.getProgress().coverage
        return cov.unavailableCount === 0 && cov.noMetadataCount + cov.extractedCount === 3
      },
      5000,
      () =>
        JSON.stringify({
          prog: metaCoordinator!.getProgress(),
          items: metaCoordinator!.getProgress().jobId
            ? catalog.listPhotoMetadataJobItems({ jobId: metaCoordinator!.getProgress().jobId! })
            : []
        })
    )

    metaScheduler.dispose()
    semScheduler.dispose()
  })

  it('respects explicit pause and cancellation on startup, resumes interrupted jobs, and restores verified copies byte-for-byte with embedded metadata', async () => {
    const imgPath = join(rootDir, 'yellowstone_protected.jpg')
    writeFileSync(
      imgPath,
      await createJpegFixture({
        width: 64,
        height: 48,
        ifd0Tags: [
          { tagId: EXIF_TAG_IDS.Make, type: 'ascii', value: 'Canon' },
          { tagId: EXIF_TAG_IDS.Model, type: 'ascii', value: 'Canon EOS R5' },
          { tagId: EXIF_TAG_IDS.Artist, type: 'ascii', value: 'Ron Preserved Tag' }
        ],
        exifTags: [
          { tagId: EXIF_TAG_IDS.DateTimeOriginal, type: 'ascii', value: '2025:09:22 14:30:00' },
          { tagId: EXIF_TAG_IDS.MakerNote, type: 'undefined', value: Buffer.from([1, 2, 3, 4, 5]) }
        ],
        gpsTags: buildGpsTags({ lat: 44.710567, lon: -110.505525 })
      })
    )
    const photoId = scanPhotoIntoCatalog(catalog, rootDir, imgPath)

    // Explicit pause / cancellation -> startup scheduler must NOT auto-start
    catalog.createPhotoMetadataJob({ parserRecipeVersion: METADATA_PARSER_RECIPE_VERSION })
    const latestMetaJob = catalog.getLatestPhotoMetadataJob()!
    catalog.updatePhotoMetadataJobStatus(latestMetaJob.id, 'paused')

    const semStatus = modelManager.getStatus()
    const semJob = catalog.createSemanticIndexJob({
      modelId: semStatus.modelId,
      modelCommit: semStatus.modelCommit,
      modelManifestSha256: semStatus.modelManifestSha256,
      preprocessingVersion: semStatus.preprocessingVersion
    })
    catalog.updateSemanticIndexJobStatus(semJob.id, 'cancelled')

    const metaScheduler = new AutoMetadataExtractionScheduler({
      photoMetadataCoordinator: metaCoordinator!,
      isCatalogClosed: () => catalog.isClosed(),
      startupDelayMs: 0
    })
    const semScheduler = new AutoSemanticIndexScheduler({
      catalog,
      semanticIndexCoordinator: semanticCoordinator!,
      semanticModelManager: modelManager,
      isCatalogClosed: () => catalog.isClosed(),
      startupDelayMs: 0,
      settleDelayMs: 0
    })

    metaScheduler.initialize()
    semScheduler.initialize()
    await sleep(60)
    expect(metaCoordinator!.getProgress().status).toBe('paused')
    expect(semanticCoordinator!.getStatus().status).toBe('cancelled')

    metaScheduler.dispose()
    semScheduler.dispose()

    // Mark both jobs interrupted (simulating app restart mid-work) -> startup MUST resume & complete!
    catalog.updatePhotoMetadataJobStatus(latestMetaJob.id, 'interrupted')
    catalog.updateSemanticIndexJobStatus(semJob.id, 'interrupted')

    const metaScheduler2 = new AutoMetadataExtractionScheduler({
      photoMetadataCoordinator: metaCoordinator!,
      isCatalogClosed: () => catalog.isClosed(),
      startupDelayMs: 0
    })
    const semScheduler2 = new AutoSemanticIndexScheduler({
      catalog,
      semanticIndexCoordinator: semanticCoordinator!,
      semanticModelManager: modelManager,
      isCatalogClosed: () => catalog.isClosed(),
      startupDelayMs: 0,
      settleDelayMs: 0
    })

    metaScheduler2.initialize()
    semScheduler2.initialize()
    await waitUntil(
      () =>
        metaCoordinator!.getProgress().coverage.extractedCount === 1 &&
        semanticCoordinator!.getStatus().currentIndexedPhotos === 1
    )

    // Verify protectionStatus before and after vault copy & backup
    const detailNoVault = catalog.getPhotoTechnicalMetadataDetail(
      photoId,
      METADATA_PARSER_RECIPE_VERSION
    )!
    expect(detailNoVault.protectionStatus?.cataloged).toBe(true)
    expect(detailNoVault.protectionStatus?.hasVerifiedVaultCopy).toBe(false)
    expect(detailNoVault.protectionStatus?.hasVerifiedBackup).toBe(false)

    // Create real verified vault copy + hash observation + read-only byte-for-byte check
    const originalBytes = readFileSync(imgPath)
    const sha256 = createHash('sha256').update(originalBytes).digest('hex')
    const st = statSync(imgPath)
    const now = Date.now()
    const [hashObs] = catalog.recordHashObservationsBatch([
      {
        originalPath: imgPath,
        sha256,
        observedByteSize: st.size,
        observedMtimeMs: st.mtimeMs,
        hashedAtMs: now
      }
    ])
    const loc = catalog.getFileLocationById(photoId)!

    const vaultPath = join(tempDir, 'vault')
    const vault = initializeVault({ vaultPath, vaultName: 'Protection Test Vault' })
    const catalogVault = catalog.registerVault({
      vaultId: vault.vaultId,
      vaultPath,
      name: vault.vaultName,
      createdAtMs: vault.createdAtMs
    })
    const copyRes = await copyAndVerifyFileToVault({
      vaultPath,
      vaultId: vault.vaultId,
      importJobId: 'test-import-1',
      source: {
        fileLocationId: photoId,
        discoveryObservationId: loc.discoveryObservationId,
        originalPath: imgPath,
        fileName: 'yellowstone_protected.jpg',
        extension: '.jpg',
        category: 'photo',
        recordedFacts: {
          byteSize: st.size,
          filesystemBirthtimeMs: st.birthtimeMs,
          filesystemMtimeMs: st.mtimeMs,
          firstDiscoveredAtMs: loc.firstDiscoveredAtMs,
          lastSeenAtMs: loc.lastSeenAtMs,
          hashObservationId: hashObs!.id,
          hashVerifiedAtMs: now
        },
        inferredMetadata: {
          inferredCaptureTimeMs: loc.inferredCaptureTimeMs
        },
        reviewDecisions: {
          isPreferred: false,
          duplicateReviewStatus: null
        },
        expectedByteSize: st.size,
        expectedSha256: sha256
      }
    })
    if (copyRes.status !== 'success') {
      throw new Error(`Unexpected vault copy result: ${JSON.stringify(copyRes)}`)
    }
    catalog.recordVaultCopy({
      vaultId: catalogVault.vaultId,
      sha256,
      byteSize: st.size,
      relativePath: copyRes.relativePath,
      manifestRelativePath: copyRes.manifestRelativePath,
      verifiedAtMs: Date.now()
    })

    // Confirm vault copy bytes are identical and EXIF/GPS + unknown MakerNote/Artist tags survive intact
    const copiedAbsPath = join(vaultPath, ...copyRes.relativePath.split('/'))
    const restoredBytes = readFileSync(copiedAbsPath)
    expect(restoredBytes.equals(originalBytes)).toBe(true)
    const parsedFromVault = await extractPhotoMetadataFromFile({
      sourcePath: copiedAbsPath,
      expectedByteSize: st.size
    })
    expect(parsedFromVault.captureCalendarDate).toBe('2025-09-22')
    expect(parsedFromVault.gpsLatitude).toBeCloseTo(44.710567, 4)
    expect(parsedFromVault.gpsLongitude).toBeCloseTo(-110.505525, 4)
    expect(parsedFromVault.unknownTagCount).toBeGreaterThanOrEqual(1)

    const detailWithVault = catalog.getPhotoTechnicalMetadataDetail(
      photoId,
      METADATA_PARSER_RECIPE_VERSION
    )!
    expect(detailWithVault.protectionStatus?.hasVerifiedVaultCopy).toBe(true)
    expect(detailWithVault.protectionStatus?.vaultCopyRelativePath).toBe(copyRes.relativePath)

    metaScheduler2.dispose()
    semScheduler2.dispose()
  })
})
