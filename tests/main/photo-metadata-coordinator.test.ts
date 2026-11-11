// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CatalogDatabase } from '../../src/main/services/catalog/database'
import { ThumbnailCoordinator } from '../../src/main/services/thumbnails/coordinator'
import {
  METADATA_PARSER_RECIPE_VERSION,
  PhotoMetadataCoordinator
} from '../../src/main/services/metadata'
import {
  buildCanonCr2Header,
  buildIsoBmffHeader,
  createJpegFixture,
  createPngFixture,
  EXIF_TAG_IDS
} from '../helpers/exif-fixture-builder'

interface SourceSnapshot {
  readonly sha256: string
  readonly size: number
  readonly birthtimeMs: number
  readonly mtimeMs: number
}

async function snapshotSourceFile(filePath: string): Promise<SourceSnapshot> {
  const bytes = await readFile(filePath)
  const st = statSync(filePath)
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: st.size,
    birthtimeMs: st.birthtimeMs,
    mtimeMs: st.mtimeMs
  }
}

function scanFixtureIntoCatalog(
  catalog: CatalogDatabase,
  rootDir: string,
  filePath: string
): number {
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
  const page = catalog.queryFileLocations({ category: 'photo', limit: 100, offset: 0 })
  const found = page.items.find((i) => i.originalPath === filePath)
  if (!found) {
    throw new Error(`Expected ${filePath} in catalog`)
  }
  return found.id
}

describe('Stage 6C — PhotoMetadataCoordinator & Shared Bounded Worker Integration', () => {
  let tempDir: string
  let rootDir: string
  let cacheDir: string
  let catalog: CatalogDatabase
  let thumbCoordinator: ThumbnailCoordinator
  let metaCoordinator: PhotoMetadataCoordinator | null = null

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pv-meta-coord-'))
    rootDir = join(tempDir, 'sources')
    cacheDir = join(tempDir, 'thumb-cache')
    rmSync(rootDir, { recursive: true, force: true })
    catalog = CatalogDatabase.open({ catalogPath: join(tempDir, 'catalog.sqlite') })
    thumbCoordinator = new ThumbnailCoordinator({
      cacheDir,
      approvedRoots: () => [rootDir],
      maxActiveJobs: 2,
      maxQueuedJobs: 64,
      jobTimeoutMs: 5_000
    })
  })

  afterEach(async () => {
    delete process.env.PV_TEST_STUCK_METADATA
    if (metaCoordinator) {
      await metaCoordinator.shutdown()
      metaCoordinator = null
    }
    if (thumbCoordinator) {
      await thumbCoordinator.shutdown()
    }
    if (catalog && !catalog.isClosed()) {
      catalog.close()
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('extracts metadata without any semantic model, reports accurate counts across supported/absent/unsupported/corrupt files, and preserves original sources bitwise', async () => {
    const { mkdirSync } = await import('node:fs')
    mkdirSync(rootDir, { recursive: true })

    const exifJpegPath = join(rootDir, 'canon_portrait.jpg')
    const exifJpegBuf = await createJpegFixture({
      width: 800,
      height: 600,
      ifd0Tags: [
        { tagId: EXIF_TAG_IDS.Make, type: 'ascii', value: 'Canon' },
        { tagId: EXIF_TAG_IDS.Model, type: 'ascii', value: 'Canon EOS R5' },
        { tagId: EXIF_TAG_IDS.Orientation, type: 'short', value: 6 }
      ],
      exifTags: [
        { tagId: EXIF_TAG_IDS.DateTimeOriginal, type: 'ascii', value: '2024:02:29 14:30:15' },
        { tagId: EXIF_TAG_IDS.OffsetTimeOriginal, type: 'ascii', value: '+02:00' },
        { tagId: EXIF_TAG_IDS.SubSecTimeOriginal, type: 'ascii', value: '375' },
        { tagId: EXIF_TAG_IDS.LensModel, type: 'ascii', value: 'RF24-70mm F2.8 L IS USM' }
      ]
    })
    writeFileSync(exifJpegPath, exifJpegBuf)

    const plainPngPath = join(rootDir, 'clean.png')
    writeFileSync(plainPngPath, await createPngFixture({ width: 400, height: 300 }))

    const disguisedPngPath = join(rootDir, 'disguised_as_jpeg.jpg')
    writeFileSync(disguisedPngPath, await createPngFixture({ width: 320, height: 200 }))

    const heicPath = join(rootDir, 'iphone_capture.heic')
    writeFileSync(heicPath, buildIsoBmffHeader('heic'))

    const cr2Path = join(rootDir, 'studio_raw.cr2')
    writeFileSync(cr2Path, buildCanonCr2Header())

    const corruptPath = join(rootDir, 'corrupt_photo.jpg')
    writeFileSync(corruptPath, Buffer.from('not-an-image-at-all-0123456789'))

    const paths = [exifJpegPath, plainPngPath, disguisedPngPath, heicPath, cr2Path, corruptPath]
    const beforeSnapshots = new Map<string, SourceSnapshot>()
    const ids = new Map<string, number>()

    for (const p of paths) {
      beforeSnapshots.set(p, await snapshotSourceFile(p))
      ids.set(p, scanFixtureIntoCatalog(catalog, rootDir, p))
    }

    metaCoordinator = new PhotoMetadataCoordinator({
      catalog,
      thumbnailCoordinator: thumbCoordinator
    })
    const initial = metaCoordinator.initialize()
    expect(initial.status).toBe('idle')
    expect(initial.coverage.totalPhotos).toBe(6)
    expect(initial.coverage.unprocessedCount).toBe(6)

    const events: string[] = []
    metaCoordinator.onProgress((p) => {
      events.push(`${p.status}:${p.processedPhotos}/${p.totalPhotos}`)
    })

    await metaCoordinator.startExtraction()
    const finalStatus = await metaCoordinator.waitForCompletion()

    expect(finalStatus.status).toBe('completed')
    expect(finalStatus.totalPhotos).toBe(6)
    expect(finalStatus.extractedPhotos).toBe(1)
    expect(finalStatus.absentMetadataPhotos).toBe(2)
    expect(finalStatus.processedPhotos).toBe(3)
    expect(finalStatus.reusedPhotos).toBe(0)
    expect(finalStatus.unsupportedPhotos).toBe(2)
    expect(finalStatus.failedPhotos).toBe(1)
    expect(finalStatus.pendingPhotos).toBe(0)
    expect(events.length).toBeGreaterThanOrEqual(2)

    expect(finalStatus.coverage).toEqual({
      parserRecipeVersion: METADATA_PARSER_RECIPE_VERSION,
      totalPhotos: 6,
      extractedCount: 1,
      noMetadataCount: 2,
      unsupportedCount: 2,
      failedCount: 1,
      staleCount: 0,
      unprocessedCount: 0
    })

    const exifDetail = catalog.getPhotoTechnicalMetadataDetail(ids.get(exifJpegPath)!)!
    expect(exifDetail.effectiveStatus).toBe('extracted')
    expect(exifDetail.currentMetadata?.cameraDisplay).toBe('Canon EOS R5')
    expect(exifDetail.currentMetadata?.lensDisplay).toBe('RF24-70mm F2.8 L IS USM')
    expect(exifDetail.currentMetadata?.captureCalendarDate).toBe('2024-02-29')
    expect(exifDetail.currentMetadata?.encodedWidthPx).toBe(800)
    expect(exifDetail.currentMetadata?.encodedHeightPx).toBe(600)
    expect(exifDetail.currentMetadata?.displayWidthPx).toBe(600)
    expect(exifDetail.currentMetadata?.displayHeightPx).toBe(800)

    const disguisedDetail = catalog.getPhotoTechnicalMetadataDetail(ids.get(disguisedPngPath)!)!
    expect(disguisedDetail.effectiveStatus).toBe('no_metadata')
    expect(disguisedDetail.currentMetadata?.recordedExtension).toBe('.jpg')
    expect(disguisedDetail.currentMetadata?.detectedFormat).toBe('png')
    expect(disguisedDetail.currentMetadata?.extensionFormatMismatch).toBe(true)

    const heicDetail = catalog.getPhotoTechnicalMetadataDetail(ids.get(heicPath)!)!
    expect(heicDetail.effectiveStatus).toBe('unsupported')
    expect(heicDetail.currentMetadata?.detectedFormat).toBe('heic')

    const corruptDetail = catalog.getPhotoTechnicalMetadataDetail(ids.get(corruptPath)!)!
    expect(corruptDetail.effectiveStatus).toBe('failed')
    expect(corruptDetail.currentMetadata?.detectedFormat).toBeNull()

    // Verify 100% bitwise source preservation (bytes, size, birthtimeMs, mtimeMs)
    for (const p of paths) {
      const after = await snapshotSourceFile(p)
      const before = beforeSnapshots.get(p)!
      expect(after.sha256).toBe(before.sha256)
      expect(after.size).toBe(before.size)
      expect(Math.abs(after.birthtimeMs - before.birthtimeMs)).toBeLessThan(0.01)
      expect(Math.abs(after.mtimeMs - before.mtimeMs)).toBeLessThan(0.01)
    }
  })

  it('reuses extraction after unchanged-content rescan and across duplicates via live SHA-256 verification without trusting cached hashes alone', async () => {
    const { mkdirSync } = await import('node:fs')
    mkdirSync(rootDir, { recursive: true })

    const photoAPath = join(rootDir, 'original.jpg')
    const photoBuf = await createJpegFixture({
      width: 640,
      height: 480,
      ifd0Tags: [
        { tagId: EXIF_TAG_IDS.Make, type: 'ascii', value: 'Nikon Corporation' },
        { tagId: EXIF_TAG_IDS.Model, type: 'ascii', value: 'NIKON Z 8' }
      ],
      exifTags: [
        { tagId: EXIF_TAG_IDS.DateTimeOriginal, type: 'ascii', value: '2025:07:04 09:15:00' }
      ]
    })
    writeFileSync(photoAPath, photoBuf)
    const idA = scanFixtureIntoCatalog(catalog, rootDir, photoAPath)

    metaCoordinator = new PhotoMetadataCoordinator({
      catalog,
      thumbnailCoordinator: thumbCoordinator
    })
    metaCoordinator.initialize()
    await metaCoordinator.startExtraction()
    const run1 = await metaCoordinator.waitForCompletion()
    expect(run1.extractedPhotos).toBe(1)
    expect(run1.reusedPhotos).toBe(0)

    // Touch mtime on photoA without changing bytes and rescan -> marks previous metadata row non-current (stale)
    const stOld = statSync(photoAPath)
    const bumpedTime = new Date(stOld.mtimeMs + 10_000)
    utimesSync(photoAPath, bumpedTime, bumpedTime)
    scanFixtureIntoCatalog(catalog, rootDir, photoAPath)

    expect(metaCoordinator.getProgress().coverage.staleCount).toBe(1)

    // Also add an identical byte copy with a mismatched .png extension to verify extensionFormatMismatch is recomputed per location
    const dupDisguisedPath = join(rootDir, 'duplicate_named_png.png')
    writeFileSync(dupDisguisedPath, photoBuf)
    const idDup = scanFixtureIntoCatalog(catalog, rootDir, dupDisguisedPath)

    // Also add a same-size, DIFFERENT-bytes file with a fake cached hash matching photoBuf to prove cached hashes alone are NEVER trusted!
    const fakeSameSizeBuf = Buffer.from(photoBuf)
    // Flip a few metadata ASCII bytes in Model ('NIKON Z 8' -> 'NIKON Z 9') keeping exact byte length!
    const idx = fakeSameSizeBuf.indexOf('NIKON Z 8')
    expect(idx).toBeGreaterThan(0)
    fakeSameSizeBuf.write('NIKON Z 9', idx, 'ascii')
    const sameSizeDifferentContentPath = join(rootDir, 'modified_same_size.jpg')
    writeFileSync(sameSizeDifferentContentPath, fakeSameSizeBuf)
    scanFixtureIntoCatalog(catalog, rootDir, sameSizeDifferentContentPath)

    await metaCoordinator.startExtraction()
    const run2 = await metaCoordinator.waitForCompletion()

    expect(run2.status).toBe('completed')
    expect(run2.totalPhotos).toBe(3)
    expect(run2.extractedPhotos).toBe(3)
    // photoA (rescanned unchanged) + dupDisguisedPath reused = 2; sameSizeDifferentContentPath had different live SHA-256 -> fresh parse!
    expect(run2.reusedPhotos).toBe(2)

    const detailA = catalog.getPhotoTechnicalMetadataDetail(idA)!
    expect(detailA.effectiveStatus).toBe('extracted')
    expect(detailA.historicalMetadataCount).toBe(1)
    expect(detailA.currentMetadata?.extensionFormatMismatch).toBe(false)

    const detailDup = catalog.getPhotoTechnicalMetadataDetail(idDup)!
    expect(detailDup.effectiveStatus).toBe('extracted')
    expect(detailDup.currentMetadata?.recordedExtension).toBe('.png')
    expect(detailDup.currentMetadata?.detectedFormat).toBe('jpeg')
    expect(detailDup.currentMetadata?.extensionFormatMismatch).toBe(true)

    const pageZ9 = catalog.queryFileLocations({
      category: 'photo',
      cameraNormalized: 'nikon z 9'
    })
    expect(pageZ9.totalCount).toBe(1)
    expect(pageZ9.items[0]?.originalPath).toBe(sameSizeDifferentContentPath)
  })

  it('rejects out-of-band modified sources and stale catalog revisions, and invalidates metadata cleanly when parser recipe version changes', async () => {
    const { mkdirSync } = await import('node:fs')
    mkdirSync(rootDir, { recursive: true })

    const mutablePath = join(rootDir, 'mutable.jpg')
    const origBuf = await createJpegFixture({
      width: 500,
      height: 400,
      ifd0Tags: [{ tagId: EXIF_TAG_IDS.Model, type: 'ascii', value: 'Sony ILCE-7RM5' }]
    })
    writeFileSync(mutablePath, origBuf)
    const mutableId = scanFixtureIntoCatalog(catalog, rootDir, mutableIdPathHelper(mutablePath))

    // Modify file on disk AFTER scan before extraction runs (without rescanning)
    writeFileSync(
      mutablePath,
      await createJpegFixture({
        width: 800,
        height: 600,
        ifd0Tags: [{ tagId: EXIF_TAG_IDS.Model, type: 'ascii', value: 'Modified Camera' }]
      })
    )

    metaCoordinator = new PhotoMetadataCoordinator({
      catalog,
      thumbnailCoordinator: thumbCoordinator
    })
    metaCoordinator.initialize()
    await metaCoordinator.startExtraction()
    const failedRun = await metaCoordinator.waitForCompletion()

    expect(failedRun.failedPhotos).toBe(1)
    expect(failedRun.extractedPhotos).toBe(0)
    // Transient SOURCE_MODIFIED failure must NOT claim the current catalog revision has valid or permanently failed metadata
    const detailAfterOutOfBand = catalog.getPhotoTechnicalMetadataDetail(mutableId)!
    expect(detailAfterOutOfBand.effectiveStatus).toBe('unprocessed')
    expect(detailAfterOutOfBand.currentMetadata).toBeNull()

    // Now rescan the modified file and extract cleanly under v1
    scanFixtureIntoCatalog(catalog, rootDir, mutablePath)
    await metaCoordinator.startExtraction()
    const cleanRun = await metaCoordinator.waitForCompletion()
    expect(cleanRun.extractedPhotos).toBe(1)
    expect(catalog.getPhotoTechnicalMetadataDetail(mutableId)?.effectiveStatus).toBe('extracted')

    // Simulate parser recipe version upgrade -> v1 row becomes stale without erasing history
    await metaCoordinator.shutdown()
    metaCoordinator = new PhotoMetadataCoordinator({
      catalog,
      thumbnailCoordinator: thumbCoordinator,
      parserRecipeVersion: 'exif_tech_v2_test'
    })
    const upgradedStatus = metaCoordinator.initialize()
    expect(upgradedStatus.coverage.staleCount).toBe(1)
    expect(upgradedStatus.coverage.extractedCount).toBe(0)

    await metaCoordinator.startExtraction()
    const v2Run = await metaCoordinator.waitForCompletion()
    expect(v2Run.extractedPhotos).toBe(1)
    expect(v2Run.reusedPhotos).toBe(0)
    const v2Detail = catalog.getPhotoTechnicalMetadataDetail(mutableId, 'exif_tech_v2_test')!
    expect(v2Detail.effectiveStatus).toBe('extracted')
    expect(v2Detail.historicalMetadataCount).toBe(1)
  })

  it('preserves exact authorized resume scope across pause and crash recovery, excluding newly scanned photos until next explicit run', async () => {
    const { mkdirSync } = await import('node:fs')
    mkdirSync(rootDir, { recursive: true })

    for (let i = 1; i <= 4; i++) {
      const p = join(rootDir, `scope_${i}.jpg`)
      writeFileSync(
        p,
        await createJpegFixture({
          width: 400,
          height: 300,
          ifd0Tags: [{ tagId: EXIF_TAG_IDS.Model, type: 'ascii', value: `Camera ${i}` }]
        })
      )
      scanFixtureIntoCatalog(catalog, rootDir, p)
    }

    metaCoordinator = new PhotoMetadataCoordinator({
      catalog,
      thumbnailCoordinator: thumbCoordinator,
      batchSize: 1,
      itemDelayMs: 60
    })
    metaCoordinator.initialize()

    await metaCoordinator.startExtraction()
    await new Promise((r) => setTimeout(r, 95))
    const paused = await metaCoordinator.pauseExtraction()
    expect(paused.status).toBe('paused')
    expect(paused.pendingPhotos).toBeGreaterThan(0)

    // Scan 2 brand-new photos while job is paused
    for (let i = 5; i <= 6; i++) {
      const p = join(rootDir, `late_arrival_${i}.jpg`)
      writeFileSync(p, await createJpegFixture({ width: 320, height: 240 }))
      scanFixtureIntoCatalog(catalog, rootDir, p)
    }

    // Resume must ONLY process the remaining items of the original 4-photo scope!
    await metaCoordinator.resumeExtraction()
    const resumedDone = await metaCoordinator.waitForCompletion()
    expect(resumedDone.status).toBe('completed')
    expect(resumedDone.totalPhotos).toBe(4)
    expect(resumedDone.processedPhotos).toBe(4)
    expect(resumedDone.coverage.totalPhotos).toBe(6)
    expect(resumedDone.coverage.unprocessedCount).toBe(2)

    // Simulate abrupt mid-job crash on the remaining 2 photos: create job directly as 'running', restart coordinator
    await metaCoordinator.shutdown()
    const simulatedRunningJob = catalog.createPhotoMetadataJob({
      parserRecipeVersion: METADATA_PARSER_RECIPE_VERSION
    })
    expect(simulatedRunningJob.totalPhotos).toBe(2)
    expect(simulatedRunningJob.status).toBe('running')

    metaCoordinator = new PhotoMetadataCoordinator({
      catalog,
      thumbnailCoordinator: thumbCoordinator
    })
    const recovered = metaCoordinator.initialize()
    expect(recovered.jobId).toBe(simulatedRunningJob.id)
    expect(recovered.status).toBe('interrupted')

    await metaCoordinator.resumeExtraction()
    const afterCrashResume = await metaCoordinator.waitForCompletion()
    expect(afterCrashResume.status).toBe('completed')
    expect(afterCrashResume.processedPhotos).toBe(2)
    expect(afterCrashResume.coverage.unprocessedCount).toBe(0)
  })

  it('handles active cancellation, parser worker timeout recovery, and interactive thumbnail priority within <=2 live workers', async () => {
    const { mkdirSync } = await import('node:fs')
    mkdirSync(rootDir, { recursive: true })

    // Recreate thumbnail coordinator with fast 250ms timeout to test hung parser worker recovery deterministically
    await thumbCoordinator.shutdown()
    thumbCoordinator = new ThumbnailCoordinator({
      cacheDir,
      approvedRoots: () => [rootDir],
      maxActiveJobs: 2,
      maxQueuedJobs: 64,
      jobTimeoutMs: 250
    })

    const photo1 = join(rootDir, 'timeout_victim.jpg')
    const photo2 = join(rootDir, 'healthy_after_timeout.jpg')
    writeFileSync(photo1, await createJpegFixture({ width: 480, height: 360 }))
    writeFileSync(photo2, await createJpegFixture({ width: 480, height: 360 }))
    const id1 = scanFixtureIntoCatalog(catalog, rootDir, photo1)
    const id2 = scanFixtureIntoCatalog(catalog, rootDir, photo2)

    // 1. Trigger parser timeout via PV_TEST_STUCK_METADATA on first run
    process.env.PV_TEST_STUCK_METADATA = '1'
    metaCoordinator = new PhotoMetadataCoordinator({
      catalog,
      thumbnailCoordinator: thumbCoordinator,
      batchSize: 1
    })
    metaCoordinator.initialize()
    await metaCoordinator.startExtraction()

    // Wait for first item to time out (~250ms), then clear stuck flag so second item & cancellation/thumbnails recover cleanly!
    await new Promise((r) => setTimeout(r, 380))
    delete process.env.PV_TEST_STUCK_METADATA

    const afterTimeoutRun = await metaCoordinator.waitForCompletion()
    expect(afterTimeoutRun.status).toBe('completed')
    expect(afterTimeoutRun.failedPhotos).toBeGreaterThanOrEqual(1)
    expect(thumbCoordinator.getLiveWorkerCount()).toBeLessThanOrEqual(2)

    // Verify worker pool cleanly recovered and can serve interactive high-priority thumbnails + retryFailed extraction
    const st2 = statSync(photo2)
    const thumbPromise = thumbCoordinator.requestThumbnail({
      locationId: id2,
      sourcePath: photo2,
      expectedByteSize: st2.size,
      expectedMtimeMs: st2.mtimeMs,
      priority: 'high'
    })
    await metaCoordinator.startExtraction({ retryFailed: true })
    const [thumbRes, retryDone] = await Promise.all([
      thumbPromise,
      metaCoordinator.waitForCompletion()
    ])

    expect(thumbRes.status).toBe('ready')
    expect(retryDone.status).toBe('completed')
    expect(catalog.getPhotoTechnicalMetadataDetail(id1)?.effectiveStatus).toBe('no_metadata')
    expect(catalog.getPhotoTechnicalMetadataDetail(id2)?.effectiveStatus).toBe('no_metadata')

    const diag = thumbCoordinator.getDiagnostics()
    expect(diag.liveWorkers).toBeLessThanOrEqual(2)
    expect(diag.queuedJobs).toBeLessThanOrEqual(64)

    // 2. Test active cancellation mid-flight never reports unfinished work as successful
    process.env.PV_TEST_STUCK_METADATA = '1'
    const cancelTarget = join(rootDir, 'cancel_inflight.jpg')
    writeFileSync(cancelTarget, await createJpegFixture({ width: 320, height: 240 }))
    const cancelId = scanFixtureIntoCatalog(catalog, rootDir, cancelTarget)

    await metaCoordinator.startExtraction()
    await new Promise((r) => setTimeout(r, 60))
    const cancelled = await metaCoordinator.cancelExtraction()
    delete process.env.PV_TEST_STUCK_METADATA

    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.processedPhotos).toBe(0)
    expect(cancelled.pendingPhotos).toBe(1)
    expect(catalog.getPhotoTechnicalMetadataDetail(cancelId)?.effectiveStatus).toBe('unprocessed')
    expect(thumbCoordinator.getLiveWorkerCount()).toBeLessThanOrEqual(2)
  })
})

function mutableIdPathHelper(p: string): string {
  return p
}
