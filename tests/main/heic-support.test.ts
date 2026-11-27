// @vitest-environment node
import { describe, expect, it, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ThumbnailCoordinator } from '../../src/main/services/thumbnails/coordinator'
import { preprocessImageForClip } from '../../src/main/services/thumbnails/decoder'
import { decodeHeicToRgba } from '../../src/main/services/thumbnails/heic-decoder'
import { extractDHash64FromImageBuffer } from '../../src/main/services/similarity/fingerprint'
import {
  extractPhotoMetadataFromFile,
  METADATA_PARSER_RECIPE_VERSION
} from '../../src/main/services/metadata'
import { extractPhotoMetadataFromBuffer } from '../../src/main/services/metadata/extractor'
import { CatalogDatabase } from '../../src/main/services/catalog'

const FIXTURES_DIR = resolve(__dirname, '..', 'fixtures', 'heic')

describe('HEIC/HEIF Support (Decoding, Metadata, Similarity, Semantic Input & Upgrade Recovery)', () => {
  const tempDirs: string[] = []
  const coordinators: ThumbnailCoordinator[] = []

  function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    tempDirs.push(dir)
    return dir
  }

  afterEach(async () => {
    while (coordinators.length > 0) {
      const c = coordinators.pop()!
      await c.shutdown()
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('decodes landscape and portrait (irot + EXIF Orientation=6) HEIC thumbnails without double-rotation', async () => {
    const sourceRoot = makeTempDir('pv-heic-src-')
    const cacheDir = makeTempDir('pv-heic-cache-')

    const landscapePath = join(sourceRoot, 'landscape.heic')
    const portraitPath = join(sourceRoot, 'portrait_exif6.heic')
    copyFileSync(join(FIXTURES_DIR, 'landscape.heic'), landscapePath)
    copyFileSync(join(FIXTURES_DIR, 'portrait_exif6.heic'), portraitPath)

    const coord = new ThumbnailCoordinator({
      cacheDir,
      approvedRoots: [sourceRoot]
    })
    coordinators.push(coord)
    await coord.initialize()

    const lStat = statSync(landscapePath)
    const lRes = await coord.requestThumbnail({
      locationId: 1,
      sourcePath: landscapePath,
      expectedByteSize: lStat.size,
      expectedMtimeMs: lStat.mtimeMs
    })
    expect(lRes.status).toBe('ready')
    if (lRes.status === 'ready') {
      expect(lRes.mimeType).toBe('image/webp')
      expect(lRes.width).toBe(160)
      expect(lRes.height).toBe(100)
    }

    const pStat = statSync(portraitPath)
    const pRes = await coord.requestThumbnail({
      locationId: 2,
      sourcePath: portraitPath,
      expectedByteSize: pStat.size,
      expectedMtimeMs: pStat.mtimeMs
    })
    expect(pRes.status).toBe('ready')
    if (pRes.status === 'ready') {
      expect(pRes.mimeType).toBe('image/webp')
      // Portrait 100x160 must stay portrait, never double-rotated to 160x100
      expect(pRes.width).toBe(100)
      expect(pRes.height).toBe(160)
    }
  })

  it('returns bounded error for corrupt HEIC and oversized pixel-limit HEIC without crashing workers', async () => {
    const sourceRoot = makeTempDir('pv-heic-err-src-')
    const cacheDir = makeTempDir('pv-heic-err-cache-')

    const corruptPath = join(sourceRoot, 'corrupt.heic')
    writeFileSync(
      corruptPath,
      Buffer.concat([
        Buffer.from([0x00, 0x00, 0x00, 0x18]),
        Buffer.from('ftypheic\x00\x00\x00\x00heic'),
        Buffer.from('CORRUPT_HEIC_PAYLOAD_BYTES')
      ])
    )
    const landscapePath = join(sourceRoot, 'landscape.heic')
    copyFileSync(join(FIXTURES_DIR, 'landscape.heic'), landscapePath)

    const coord = new ThumbnailCoordinator({
      cacheDir,
      approvedRoots: [sourceRoot],
      maxInputPixels: 1000 // 160x100 = 16,000 > 1,000
    })
    coordinators.push(coord)
    await coord.initialize()

    const cStat = statSync(corruptPath)
    const cRes = await coord.requestThumbnail({
      locationId: 10,
      sourcePath: corruptPath,
      expectedByteSize: cStat.size,
      expectedMtimeMs: cStat.mtimeMs
    })
    expect(cRes.status).toBe('error')

    const lStat = statSync(landscapePath)
    const lRes = await coord.requestThumbnail({
      locationId: 11,
      sourcePath: landscapePath,
      expectedByteSize: lStat.size,
      expectedMtimeMs: lStat.mtimeMs
    })
    expect(lRes.status).toBe('error')
    expect(coord.getDiagnostics().activeWorkers).toBe(0)
  })

  it('decodes HEIC into CLIP 224x224 RGB tensor and dhash64_v1 perceptual fingerprint', async () => {
    const sunsetBuf = readFileSync(join(FIXTURES_DIR, 'sunset_heic.heic'))
    const clipRes = await preprocessImageForClip(sunsetBuf)
    expect(clipRes.status).toBe('ready')
    if (clipRes.status === 'ready') {
      expect(clipRes.data.length).toBe(224 * 224 * 3)
    }

    const portraitBuf = readFileSync(join(FIXTURES_DIR, 'portrait_exif6.heic'))
    const fp = await extractDHash64FromImageBuffer(portraitBuf)
    expect(fp.fingerprint).toMatch(/^[0-9a-f]{16}$/)
    expect(fp.width).toBe(100)
    expect(fp.height).toBe(160)
  })

  it('extracts HEIC technical metadata (capture date, camera/lens, and non-double-swapped display dimensions)', async () => {
    const portraitMeta = await extractPhotoMetadataFromFile({
      sourcePath: join(FIXTURES_DIR, 'portrait_exif6.heic'),
      recordedExtension: '.heic',
      approvedRoots: [FIXTURES_DIR]
    })
    expect(portraitMeta.extractionStatus).toBe('extracted')
    expect(portraitMeta.detectedFormat).toBe('heic')
    expect(portraitMeta.extensionFormatMismatch).toBe(false)
    expect(portraitMeta.cameraDisplay).toBe('Apple iPhone 15 Pro Max')
    expect(portraitMeta.lensDisplay).toBe('iPhone 15 Pro Max back triple camera 6.765mm f/1.78')
    expect(portraitMeta.exifOrientation).toBe(6)
    expect(portraitMeta.displayWidthPx).toBe(100)
    expect(portraitMeta.displayHeightPx).toBe(160)
    expect(portraitMeta.captureUtcEpochMs).toBe(Date.parse('2024-04-21T09:22:06-10:00'))

    const landscapeMeta = await extractPhotoMetadataFromFile({
      sourcePath: join(FIXTURES_DIR, 'landscape.heic'),
      recordedExtension: '.heic',
      approvedRoots: [FIXTURES_DIR]
    })
    expect(landscapeMeta.extractionStatus).toBe('no_metadata')
    expect(landscapeMeta.detectedFormat).toBe('heic')
    expect(landscapeMeta.displayWidthPx).toBe(160)
    expect(landscapeMeta.displayHeightPx).toBe(100)
    expect(landscapeMeta.captureUtcEpochMs).toBeNull()
  })

  it('recovers previously unsupported HEIC metadata rows on upgrade without losing catalog or user annotations', async () => {
    const dbDir = makeTempDir('pv-heic-upgrade-')
    const dbPath = join(dbDir, 'vault-catalog.db')
    const sourceRoot = join(dbDir, 'photos')

    // 1. Create catalog, scan/insert a HEIC + JPG, add user rating/flag/collection, and record legacy UNSUPPORTED_HEIC_CONTAINER
    const db1 = CatalogDatabase.open({ catalogPath: dbPath })
    let heicFileLocationId = 0
    let colId: number
    try {
      db1.persistDiscoveryBatch(sourceRoot, [
        {
          originalPath: join(sourceRoot, 'IMG_1922.HEIC'),
          fileName: 'IMG_1922.HEIC',
          extension: '.heic',
          byteSize: 2048,
          birthtimeMs: 1000,
          mtimeMs: 2000,
          discoveredAtMs: 3000,
          category: 'photo'
        },
        {
          originalPath: join(sourceRoot, 'IMG_0008.JPG'),
          fileName: 'IMG_0008.JPG',
          extension: '.jpg',
          byteSize: 4096,
          birthtimeMs: 1000,
          mtimeMs: 2000,
          discoveredAtMs: 3000,
          category: 'photo'
        }
      ])

      const allFiles = db1.queryFileLocations({ category: 'photo', limit: 10 }).items
      const heicFile = allFiles.find((f) => f.fileName === 'IMG_1922.HEIC')!
      const jpgFile = allFiles.find((f) => f.fileName === 'IMG_0008.JPG')!
      heicFileLocationId = heicFile.id

      const col = db1.createCollection({ name: 'Favorites' })
      colId = col.id
      const heicRevision = `rev:${heicFile.discoveryObservationId}:2048:2000:unhashed`
      db1.setPhotoAnnotation({
        fileLocationId: heicFile.id,
        rating: 5,
        flag: 'pick',
        expectedRevision: heicRevision,
        expectedVersion: 0
      })
      db1.addCollectionMember({
        collectionId: col.id,
        fileLocationId: heicFile.id,
        expectedRevision: heicRevision
      })

      const seedJob = db1.createPhotoMetadataJob({
        parserRecipeVersion: METADATA_PARSER_RECIPE_VERSION
      })
      const seedItems = db1.getNextPendingPhotoMetadataJobItems(seedJob.id, 10)
      const heicItem = seedItems.find((i) => i.fileLocationId === heicFile.id)!
      const jpgItem = seedItems.find((i) => i.fileLocationId === jpgFile.id)!

      db1.completePhotoMetadataJobItem({
        jobId: seedJob.id,
        itemId: heicItem.id,
        reused: false,
        metadata: {
          fileLocationId: heicFile.id,
          discoveryObservationId: heicFile.discoveryObservationId,
          parserRecipeVersion: METADATA_PARSER_RECIPE_VERSION,
          extractionStatus: 'unsupported',
          contentSha256: 'a'.repeat(64),
          contentRevision: `${heicFile.discoveryObservationId}:${'a'.repeat(64)}`,
          observedByteSize: 2048,
          observedMtimeMs: 2000,
          recordedExtension: '.heic',
          detectedFormat: 'heic',
          extensionFormatMismatch: false,
          encodedWidthPx: null,
          encodedHeightPx: null,
          exifOrientation: null,
          displayWidthPx: null,
          displayHeightPx: null,
          captureDateSourceTag: null,
          rawCaptureDateText: null,
          captureSubseconds: null,
          captureOffsetMinutes: null,
          captureOffsetText: null,
          captureTimezoneStatus: 'unknown',
          captureCalendarDate: null,
          captureLocalIso: null,
          captureUtcEpochMs: null,
          captureDateParseError: null,
          captureDateConflict: null,
          cameraMakeRaw: null,
          cameraModelRaw: null,
          cameraDisplay: null,
          cameraNormalized: null,
          lensMakeRaw: null,
          lensModelRaw: null,
          lensDisplay: null,
          lensNormalized: null,
          rawMetadataJson: null,
          errorCode: 'UNSUPPORTED_HEIC_CONTAINER',
          errorMessage:
            'Detected HEIC/HEIF container; local HEVC codec decoding is not bundled offline'
        }
      })
      db1.completePhotoMetadataJobItem({
        jobId: seedJob.id,
        itemId: jpgItem.id,
        reused: false,
        metadata: {
          fileLocationId: jpgFile.id,
          discoveryObservationId: jpgFile.discoveryObservationId,
          parserRecipeVersion: METADATA_PARSER_RECIPE_VERSION,
          extractionStatus: 'extracted',
          contentSha256: 'b'.repeat(64),
          contentRevision: `${jpgFile.discoveryObservationId}:${'b'.repeat(64)}`,
          observedByteSize: 4096,
          observedMtimeMs: 2000,
          recordedExtension: '.jpg',
          detectedFormat: 'jpeg',
          extensionFormatMismatch: false,
          encodedWidthPx: 800,
          encodedHeightPx: 600,
          exifOrientation: 1,
          displayWidthPx: 800,
          displayHeightPx: 600,
          captureDateSourceTag: null,
          rawCaptureDateText: null,
          captureSubseconds: null,
          captureOffsetMinutes: null,
          captureOffsetText: null,
          captureTimezoneStatus: 'unknown',
          captureCalendarDate: null,
          captureLocalIso: null,
          captureUtcEpochMs: null,
          captureDateParseError: null,
          captureDateConflict: null,
          cameraMakeRaw: null,
          cameraModelRaw: null,
          cameraDisplay: null,
          cameraNormalized: null,
          lensMakeRaw: null,
          lensModelRaw: null,
          lensDisplay: null,
          lensNormalized: null,
          rawMetadataJson: null,
          errorCode: null,
          errorMessage: null
        }
      })
    } finally {
      db1.close()
    }

    // Simulate pre-upgrade v10 database state by removing migration 11 if present and setting version=10
    const rawDb = new DatabaseSync(dbPath)
    rawDb.exec('DELETE FROM schema_migrations WHERE version > 10;')
    rawDb.exec(
      "UPDATE photo_technical_metadata SET extraction_status = 'unsupported', is_current = 1 WHERE error_code = 'UNSUPPORTED_HEIC_CONTAINER';"
    )
    rawDb.close()

    // 2. Re-open with upgraded CatalogDatabase (runs migration 11)
    const db2 = CatalogDatabase.open({ catalogPath: dbPath })
    try {
      // Annotations preserved
      const annotation = db2.getPhotoAnnotation(heicFileLocationId)
      expect(annotation?.rating).toBe(5)
      expect(annotation?.flag).toBe('pick')
      expect(
        db2
          .queryFileLocations({ category: 'photo', collectionId: colId, limit: 10 })
          .items.some((i) => i.id === heicFileLocationId)
      ).toBe(true)

      // Coverage reflects HEIC is now stale (recovered from unsupported) while JPG stays extracted
      const cov = db2.getPhotoMetadataCoverage(METADATA_PARSER_RECIPE_VERSION)
      expect(cov.unsupportedCount).toBe(0)
      expect(cov.extractedCount).toBe(1)
      expect(cov.staleCount).toBe(1)

      // Metadata job snapshots only the recovered HEIC photo
      const job = db2.createPhotoMetadataJob({
        parserRecipeVersion: METADATA_PARSER_RECIPE_VERSION
      })
      expect(job.totalPhotos).toBe(1)
    } finally {
      db2.close()
    }
  })

  it('rejects excessive HEIC dimensions (200001x10 ispe) via resolveDimensions validation without double-rotation', async () => {
    const buf = Buffer.from(readFileSync(join(FIXTURES_DIR, 'landscape.heic')))
    const ispeIdx = buf.indexOf('ispe', 0, 'ascii')
    expect(ispeIdx).toBeGreaterThan(0)
    // Patch ispe width=200001, height=10 (full box: 4B version/flags, 4B width, 4B height)
    buf.writeUInt32BE(200001, ispeIdx + 8)
    buf.writeUInt32BE(10, ispeIdx + 12)

    const meta = await extractPhotoMetadataFromBuffer({
      fileBuffer: buf,
      recordedExtension: '.heic',
      observedByteSize: buf.length,
      observedMtimeMs: 1000,
      computedSha256: createHash('sha256').update(buf).digest('hex')
    })

    expect(meta.detectedFormat).toBe('heic')
    expect(meta.encodedWidthPx).toBeNull()
    expect(meta.encodedHeightPx).toBeNull()
    expect(meta.displayWidthPx).toBeNull()
    expect(meta.displayHeightPx).toBeNull()
    expect(meta.rawMetadataJson).toContain('Rejected excessive dimensions (200001x10 px)')
  })

  it('selects the actual HEIC primary image when not first, falls back to index 0 if none flagged, and frees every handle', async () => {
    const makeHandle = (opts: { w: number; h: number; primary: boolean; fill: number }) => {
      const free = vi.fn()
      return {
        get_width: () => opts.w,
        get_height: () => opts.h,
        is_primary: () => opts.primary,
        display: (
          imgData: { data: Uint8ClampedArray; width: number; height: number },
          cb: (res: unknown) => void
        ) => {
          imgData.data.fill(opts.fill)
          cb(imgData)
        },
        free
      }
    }

    const nonPrimaryFirst = makeHandle({ w: 32, h: 24, primary: false, fill: 10 })
    const primarySecond = makeHandle({ w: 80, h: 60, primary: true, fill: 222 })
    const fakeDecoder = {
      decode: () => [nonPrimaryFirst, primarySecond]
    }

    const res = await decodeHeicToRgba(Buffer.from('dummy'), 100_000_000, fakeDecoder)
    expect(res.width).toBe(80)
    expect(res.height).toBe(60)
    expect(res.data[0]).toBe(222)
    expect(nonPrimaryFirst.free).toHaveBeenCalledTimes(1)
    expect(primarySecond.free).toHaveBeenCalledTimes(1)

    // Fallback when no handle reports is_primary() === true
    const unflaggedFirst = makeHandle({ w: 40, h: 30, primary: false, fill: 77 })
    const unflaggedSecond = makeHandle({ w: 20, h: 20, primary: false, fill: 99 })
    const fallbackDecoder = {
      decode: () => [unflaggedFirst, unflaggedSecond]
    }

    const fallbackRes = await decodeHeicToRgba(Buffer.from('dummy'), 100_000_000, fallbackDecoder)
    expect(fallbackRes.width).toBe(40)
    expect(fallbackRes.height).toBe(30)
    expect(fallbackRes.data[0]).toBe(77)
    expect(unflaggedFirst.free).toHaveBeenCalledTimes(1)
    expect(unflaggedSecond.free).toHaveBeenCalledTimes(1)
  })
})
