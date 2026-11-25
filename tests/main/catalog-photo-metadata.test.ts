// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CatalogDatabase, CURRENT_SCHEMA_VERSION } from '../../src/main/services/catalog'
import { METADATA_PARSER_RECIPE_VERSION } from '../../src/main/services/metadata'

describe('Stage 6C — SQLite Photo Technical Metadata, Coverage, Facets & SQL Filters', () => {
  let tempDir: string
  let catalogPath: string
  let db: CatalogDatabase | null = null

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pv-catalog-meta-'))
    catalogPath = join(tempDir, 'catalog.db')
  })

  afterEach(() => {
    if (db && !db.isClosed()) {
      db.close()
    }
    db = null
    rmSync(tempDir, { recursive: true, force: true })
  })

  function makeSha(seed: number): string {
    return seed.toString(16).padStart(64, '0')
  }

  it('migrates to schema version >= 10 and initializes coverage with 0 counts', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(10)
    db = CatalogDatabase.open({ catalogPath })

    const coverage = db.getPhotoMetadataCoverage(METADATA_PARSER_RECIPE_VERSION)
    expect(coverage).toEqual({
      parserRecipeVersion: METADATA_PARSER_RECIPE_VERSION,
      totalPhotos: 0,
      extractedCount: 0,
      noMetadataCount: 0,
      unsupportedCount: 0,
      failedCount: 0,
      unavailableCount: 0,
      staleCount: 0,
      unprocessedCount: 0
    })
  })

  it('distinguishes unprocessed, extracted, no_metadata, unsupported, failed, and stale states while preserving history on rescan and recipe upgrades', () => {
    db = CatalogDatabase.open({ catalogPath })
    const rootPath = join(tempDir, 'photos')

    db.persistDiscoveryBatch(rootPath, [
      {
        originalPath: join(rootPath, 'p1.jpg'),
        fileName: 'p1.jpg',
        extension: '.jpg',
        byteSize: 1000,
        birthtimeMs: 100,
        mtimeMs: 200,
        discoveredAtMs: 300,
        category: 'photo'
      },
      {
        originalPath: join(rootPath, 'p2.png'),
        fileName: 'p2.png',
        extension: '.png',
        byteSize: 2000,
        birthtimeMs: 100,
        mtimeMs: 200,
        discoveredAtMs: 300,
        category: 'photo'
      },
      {
        originalPath: join(rootPath, 'p3.heic'),
        fileName: 'p3.heic',
        extension: '.heic',
        byteSize: 3000,
        birthtimeMs: 100,
        mtimeMs: 200,
        discoveredAtMs: 300,
        category: 'photo'
      },
      {
        originalPath: join(rootPath, 'p4-corrupt.jpg'),
        fileName: 'p4-corrupt.jpg',
        extension: '.jpg',
        byteSize: 4000,
        birthtimeMs: 100,
        mtimeMs: 200,
        discoveredAtMs: 300,
        category: 'photo'
      },
      {
        originalPath: join(rootPath, 'p5-unprocessed.jpg'),
        fileName: 'p5-unprocessed.jpg',
        extension: '.jpg',
        byteSize: 5000,
        birthtimeMs: 100,
        mtimeMs: 200,
        discoveredAtMs: 300,
        category: 'photo'
      }
    ])

    const allFiles = db.queryFileLocations({ category: 'photo', limit: 10 }).items
    const [p1, p2, p3, p4] = allFiles

    const job = db.createPhotoMetadataJob({
      parserRecipeVersion: METADATA_PARSER_RECIPE_VERSION
    })
    expect(job.totalPhotos).toBe(5)
    expect(job.pendingPhotos).toBe(5)

    const items = db.getNextPendingPhotoMetadataJobItems(job.id, 10)
    expect(items).toHaveLength(5)

    // Complete p1 as extracted, p2 as no_metadata, p3 as unsupported, p4 as failed; leave p5 pending/unprocessed
    db.completePhotoMetadataJobItem({
      jobId: job.id,
      itemId: items[0]!.id,
      reused: false,
      metadata: {
        fileLocationId: p1!.id,
        discoveryObservationId: p1!.discoveryObservationId,
        parserRecipeVersion: METADATA_PARSER_RECIPE_VERSION,
        extractionStatus: 'extracted',
        contentSha256: makeSha(1),
        contentRevision: `${p1!.discoveryObservationId}:${makeSha(1)}`,
        observedByteSize: 1000,
        observedMtimeMs: 200,
        recordedExtension: '.jpg',
        detectedFormat: 'jpeg',
        extensionFormatMismatch: false,
        encodedWidthPx: 4000,
        encodedHeightPx: 3000,
        exifOrientation: 6,
        displayWidthPx: 3000,
        displayHeightPx: 4000,
        captureDateSourceTag: 'DateTimeOriginal',
        rawCaptureDateText: '2024:05:01 10:20:30',
        captureSubseconds: '50',
        captureOffsetMinutes: -300,
        captureOffsetText: '-05:00',
        captureTimezoneStatus: 'offset_present',
        captureCalendarDate: '2024-05-01',
        captureLocalIso: '2024-05-01T10:20:30.50',
        captureUtcEpochMs: Date.parse('2024-05-01T10:20:30.500-05:00'),
        captureDateParseError: null,
        captureDateConflict: null,
        cameraMakeRaw: 'Canon',
        cameraModelRaw: 'Canon EOS R5',
        cameraDisplay: 'Canon EOS R5',
        cameraNormalized: 'canon eos r5',
        lensMakeRaw: 'Canon',
        lensModelRaw: 'RF 50mm F1.2L',
        lensDisplay: 'Canon RF 50mm F1.2L',
        lensNormalized: 'canon rf 50mm f1.2l',
        rawMetadataJson: '{"Make":"Canon"}',
        errorCode: null,
        errorMessage: null
      }
    })

    db.completePhotoMetadataJobItem({
      jobId: job.id,
      itemId: items[1]!.id,
      reused: false,
      metadata: {
        fileLocationId: p2!.id,
        discoveryObservationId: p2!.discoveryObservationId,
        parserRecipeVersion: METADATA_PARSER_RECIPE_VERSION,
        extractionStatus: 'no_metadata',
        contentSha256: makeSha(2),
        contentRevision: `${p2!.discoveryObservationId}:${makeSha(2)}`,
        observedByteSize: 2000,
        observedMtimeMs: 200,
        recordedExtension: '.png',
        detectedFormat: 'png',
        extensionFormatMismatch: false,
        encodedWidthPx: 1920,
        encodedHeightPx: 1080,
        exifOrientation: null,
        displayWidthPx: 1920,
        displayHeightPx: 1080,
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

    db.completePhotoMetadataJobItem({
      jobId: job.id,
      itemId: items[2]!.id,
      reused: false,
      metadata: {
        fileLocationId: p3!.id,
        discoveryObservationId: p3!.discoveryObservationId,
        parserRecipeVersion: METADATA_PARSER_RECIPE_VERSION,
        extractionStatus: 'unsupported',
        contentSha256: makeSha(3),
        contentRevision: `${p3!.discoveryObservationId}:${makeSha(3)}`,
        observedByteSize: 3000,
        observedMtimeMs: 200,
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
        errorMessage: 'HEIC decoding unsupported'
      }
    })

    db.completePhotoMetadataJobItem({
      jobId: job.id,
      itemId: items[3]!.id,
      reused: false,
      metadata: {
        fileLocationId: p4!.id,
        discoveryObservationId: p4!.discoveryObservationId,
        parserRecipeVersion: METADATA_PARSER_RECIPE_VERSION,
        extractionStatus: 'failed',
        contentSha256: makeSha(4),
        contentRevision: `${p4!.discoveryObservationId}:${makeSha(4)}`,
        observedByteSize: 4000,
        observedMtimeMs: 200,
        recordedExtension: '.jpg',
        detectedFormat: 'jpeg',
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
        errorCode: 'CORRUPT_IMAGE_HEADER',
        errorMessage: 'Corrupt JPEG header'
      }
    })

    const updatedJob = db.getPhotoMetadataJob(job.id)!
    expect(updatedJob.processedPhotos).toBe(2)
    expect(updatedJob.extractedPhotos).toBe(1)
    expect(updatedJob.absentMetadataPhotos).toBe(1)
    expect(updatedJob.unsupportedPhotos).toBe(1)
    expect(updatedJob.failedPhotos).toBe(1)
    expect(updatedJob.pendingPhotos).toBe(1)

    const cov1 = db.getPhotoMetadataCoverage(METADATA_PARSER_RECIPE_VERSION)
    expect(cov1).toEqual({
      parserRecipeVersion: METADATA_PARSER_RECIPE_VERSION,
      totalPhotos: 5,
      extractedCount: 1,
      noMetadataCount: 1,
      unsupportedCount: 1,
      failedCount: 1,
      unavailableCount: 0,
      staleCount: 0,
      unprocessedCount: 1
    })

    // Rescan p1 with modified mtime -> p1 becomes stale, historical row is preserved!
    db.persistDiscoveryBatch(rootPath, [
      {
        originalPath: p1!.originalPath,
        fileName: 'p1.jpg',
        extension: '.jpg',
        byteSize: 1000,
        birthtimeMs: 100,
        mtimeMs: 999,
        discoveredAtMs: 1000,
        category: 'photo'
      }
    ])

    const covAfterRescan = db.getPhotoMetadataCoverage(METADATA_PARSER_RECIPE_VERSION)
    expect(covAfterRescan.extractedCount).toBe(0)
    expect(covAfterRescan.staleCount).toBe(1)
    expect(covAfterRescan.unprocessedCount).toBe(1)

    const p1Detail = db.getPhotoTechnicalMetadataDetail(p1!.id, METADATA_PARSER_RECIPE_VERSION)!
    expect(p1Detail.effectiveStatus).toBe('stale')
    expect(p1Detail.historicalMetadataCount).toBe(1)
    expect(p1Detail.currentMetadata).toBeNull()

    // Reusable content lookup still finds historical verified content row by SHA-256 + byteSize + recipe!
    const reusable = db.findReusablePhotoTechnicalMetadata({
      contentSha256: makeSha(1),
      observedByteSize: 1000,
      parserRecipeVersion: METADATA_PARSER_RECIPE_VERSION
    })
    expect(reusable).not.toBeNull()
    expect(reusable?.cameraNormalized).toBe('canon eos r5')

    // Recipe upgrade ('exif_tech_v3') treats v2 rows as stale without erasing them
    const covNextRecipe = db.getPhotoMetadataCoverage('exif_tech_v3')
    expect(covNextRecipe.extractedCount).toBe(0)
    expect(covNextRecipe.noMetadataCount).toBe(0)
    expect(covNextRecipe.staleCount).toBe(4) // p1, p2, p3, p4 all had v1 rows
    expect(covNextRecipe.unprocessedCount).toBe(1) // p5 never extracted
  })

  it('rejects stale revision commits transactionally and isolates exact job scope from newly scanned photos', () => {
    db = CatalogDatabase.open({ catalogPath })
    const rootPath = join(tempDir, 'photos')

    db.persistDiscoveryBatch(rootPath, [
      {
        originalPath: join(rootPath, 'a.jpg'),
        fileName: 'a.jpg',
        extension: '.jpg',
        byteSize: 1200,
        birthtimeMs: 10,
        mtimeMs: 20,
        discoveredAtMs: 30,
        category: 'photo'
      }
    ])

    const job = db.createPhotoMetadataJob({
      parserRecipeVersion: METADATA_PARSER_RECIPE_VERSION
    })
    const pending = db.getNextPendingPhotoMetadataJobItems(job.id, 10)
    expect(pending).toHaveLength(1)

    // Scan an extra photo b.jpg while job is open -> must NOT appear in job's scope!
    db.persistDiscoveryBatch(rootPath, [
      {
        originalPath: join(rootPath, 'b.jpg'),
        fileName: 'b.jpg',
        extension: '.jpg',
        byteSize: 1500,
        birthtimeMs: 10,
        mtimeMs: 20,
        discoveredAtMs: 40,
        category: 'photo'
      }
    ])
    expect(db.getNextPendingPhotoMetadataJobItems(job.id, 10)).toHaveLength(1)

    // Modify a.jpg in catalog before worker commits -> transactional revision check rejects commit!
    db.persistDiscoveryBatch(rootPath, [
      {
        originalPath: join(rootPath, 'a.jpg'),
        fileName: 'a.jpg',
        extension: '.jpg',
        byteSize: 1999,
        birthtimeMs: 10,
        mtimeMs: 99,
        discoveredAtMs: 50,
        category: 'photo'
      }
    ])

    expect(() =>
      db!.completePhotoMetadataJobItem({
        jobId: job.id,
        itemId: pending[0]!.id,
        reused: false,
        metadata: {
          fileLocationId: pending[0]!.fileLocationId,
          discoveryObservationId: pending[0]!.discoveryObservationId,
          parserRecipeVersion: METADATA_PARSER_RECIPE_VERSION,
          extractionStatus: 'no_metadata',
          contentSha256: makeSha(99),
          contentRevision: 'stale',
          observedByteSize: 1200,
          observedMtimeMs: 20,
          recordedExtension: '.jpg',
          detectedFormat: 'jpeg',
          extensionFormatMismatch: false,
          encodedWidthPx: 100,
          encodedHeightPx: 100,
          exifOrientation: null,
          displayWidthPx: 100,
          displayHeightPx: 100,
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
    ).toThrow(/SOURCE_REVISION_CHANGED/)
  })

  it('applies combined SQL filters (date range + Unknown, camera + Unknown, lens + Unknown, display dimensions + Unknown, file type, rating, flag, collection) with AND before pagination and bounded facets', () => {
    db = CatalogDatabase.open({ catalogPath })
    const rootPath = join(tempDir, 'library')

    const names = [
      '01-canon-2024.jpg', // extracted: 2024-06-15, Canon EOS R5, RF 24-70, rotated 6 (encoded 4000x3000 -> display 3000x4000), jpeg, 5-star, pick, in Trip collection
      '02-sony-2023.jpg', // extracted: 2023-01-10, Sony ILCE-7M4, FE 35mm F1.4 GM, display 6000x4000, jpeg, 4-star, pick, in Trip collection
      '03-no-exif-png-as-jpg.jpg', // no_metadata: Unknown date/camera/lens, display 1920x1080, recorded .jpg / detected png (mismatch!), 5-star, pick, in Trip collection
      '04-heic-unsupported.heic', // unsupported: Unknown dimensions, detected heic, unrated
      '05-unprocessed.jpg' // unprocessed: NEVER matches metadata filters or Unknown!
    ]

    db.persistDiscoveryBatch(
      rootPath,
      names.map((n, i) => ({
        originalPath: join(rootPath, n),
        fileName: n,
        extension: n.endsWith('.heic') ? '.heic' : '.jpg',
        byteSize: 10_000 + i,
        birthtimeMs: 1000,
        mtimeMs: 2000,
        discoveredAtMs: 3000,
        category: 'photo' as const
      }))
    )

    const files = db.queryFileLocations({ category: 'photo', limit: 10 }).items
    const [f1, f2, f3, f4] = files

    // Add annotations & collection to f1, f2, f3
    const tripCol = db.createCollection({ name: 'Summer Trip' })
    for (const [file, stars] of [
      [f1!, 5],
      [f2!, 4],
      [f3!, 5]
    ] as const) {
      const rev = db.getPhotoRevisionString(file.id)
      db.setPhotoAnnotation({
        fileLocationId: file.id,
        expectedRevision: rev,
        expectedVersion: 0,
        rating: stars,
        flag: 'pick'
      })
      db.addCollectionMember({
        collectionId: tripCol.id,
        fileLocationId: file.id,
        expectedRevision: rev
      })
    }

    const job = db.createPhotoMetadataJob({ parserRecipeVersion: METADATA_PARSER_RECIPE_VERSION })
    const jobItems = db.getNextPendingPhotoMetadataJobItems(job.id, 10)

    // Save f1
    db.completePhotoMetadataJobItem({
      jobId: job.id,
      itemId: jobItems[0]!.id,
      reused: false,
      metadata: {
        fileLocationId: f1!.id,
        discoveryObservationId: f1!.discoveryObservationId,
        parserRecipeVersion: METADATA_PARSER_RECIPE_VERSION,
        extractionStatus: 'extracted',
        contentSha256: makeSha(101),
        contentRevision: 'r1',
        observedByteSize: f1!.byteSize,
        observedMtimeMs: 2000,
        recordedExtension: '.jpg',
        detectedFormat: 'jpeg',
        extensionFormatMismatch: false,
        encodedWidthPx: 4000,
        encodedHeightPx: 3000,
        exifOrientation: 6,
        displayWidthPx: 3000,
        displayHeightPx: 4000,
        captureDateSourceTag: 'DateTimeOriginal',
        rawCaptureDateText: '2024:06:15 18:00:00',
        captureSubseconds: null,
        captureOffsetMinutes: null,
        captureOffsetText: null,
        captureTimezoneStatus: 'local_wall_clock_unknown_tz',
        captureCalendarDate: '2024-06-15',
        captureLocalIso: '2024-06-15T18:00:00',
        captureUtcEpochMs: null,
        captureDateParseError: null,
        captureDateConflict: null,
        cameraMakeRaw: 'Canon',
        cameraModelRaw: 'Canon EOS R5',
        cameraDisplay: 'Canon EOS R5',
        cameraNormalized: 'canon eos r5',
        lensMakeRaw: 'Canon',
        lensModelRaw: 'RF 24-70mm F2.8',
        lensDisplay: 'Canon RF 24-70mm F2.8',
        lensNormalized: 'canon rf 24-70mm f2.8',
        rawMetadataJson: null,
        errorCode: null,
        errorMessage: null
      }
    })

    // Save f2
    db.completePhotoMetadataJobItem({
      jobId: job.id,
      itemId: jobItems[1]!.id,
      reused: false,
      metadata: {
        fileLocationId: f2!.id,
        discoveryObservationId: f2!.discoveryObservationId,
        parserRecipeVersion: METADATA_PARSER_RECIPE_VERSION,
        extractionStatus: 'extracted',
        contentSha256: makeSha(102),
        contentRevision: 'r2',
        observedByteSize: f2!.byteSize,
        observedMtimeMs: 2000,
        recordedExtension: '.jpg',
        detectedFormat: 'jpeg',
        extensionFormatMismatch: false,
        encodedWidthPx: 6000,
        encodedHeightPx: 4000,
        exifOrientation: 1,
        displayWidthPx: 6000,
        displayHeightPx: 4000,
        captureDateSourceTag: 'DateTimeOriginal',
        rawCaptureDateText: '2023:01:10 08:30:00',
        captureSubseconds: null,
        captureOffsetMinutes: 540,
        captureOffsetText: '+09:00',
        captureTimezoneStatus: 'offset_present',
        captureCalendarDate: '2023-01-10',
        captureLocalIso: '2023-01-10T08:30:00',
        captureUtcEpochMs: Date.parse('2023-01-10T08:30:00+09:00'),
        captureDateParseError: null,
        captureDateConflict: null,
        cameraMakeRaw: 'Sony',
        cameraModelRaw: 'ILCE-7M4',
        cameraDisplay: 'Sony ILCE-7M4',
        cameraNormalized: 'sony ilce-7m4',
        lensMakeRaw: 'Sony',
        lensModelRaw: 'FE 35mm F1.4 GM',
        lensDisplay: 'Sony FE 35mm F1.4 GM',
        lensNormalized: 'sony fe 35mm f1.4 gm',
        rawMetadataJson: null,
        errorCode: null,
        errorMessage: null
      }
    })

    // Save f3 (PNG disguised as .jpg, no EXIF)
    db.completePhotoMetadataJobItem({
      jobId: job.id,
      itemId: jobItems[2]!.id,
      reused: false,
      metadata: {
        fileLocationId: f3!.id,
        discoveryObservationId: f3!.discoveryObservationId,
        parserRecipeVersion: METADATA_PARSER_RECIPE_VERSION,
        extractionStatus: 'no_metadata',
        contentSha256: makeSha(103),
        contentRevision: 'r3',
        observedByteSize: f3!.byteSize,
        observedMtimeMs: 2000,
        recordedExtension: '.jpg',
        detectedFormat: 'png',
        extensionFormatMismatch: true,
        encodedWidthPx: 1920,
        encodedHeightPx: 1080,
        exifOrientation: null,
        displayWidthPx: 1920,
        displayHeightPx: 1080,
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

    // Save f4 (HEIC unsupported -> Unknown dimensions)
    db.completePhotoMetadataJobItem({
      jobId: job.id,
      itemId: jobItems[3]!.id,
      reused: false,
      metadata: {
        fileLocationId: f4!.id,
        discoveryObservationId: f4!.discoveryObservationId,
        parserRecipeVersion: METADATA_PARSER_RECIPE_VERSION,
        extractionStatus: 'unsupported',
        contentSha256: makeSha(104),
        contentRevision: 'r4',
        observedByteSize: f4!.byteSize,
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
        errorMessage: 'HEIC unsupported'
      }
    })
    // Leave f5 unprocessed!

    // 1. Capture Date Range filter
    const date2024 = db.queryFileLocations({
      category: 'photo',
      parserRecipeVersion: METADATA_PARSER_RECIPE_VERSION,
      captureDateFrom: '2024-01-01',
      captureDateTo: '2024-12-31'
    })
    expect(date2024.items.map((x) => x.id)).toEqual([f1!.id])

    // 2. Capture Date Unknown ONLY -> matches f3 (extracted no_metadata), excludes f4 (unsupported) and f5 (unprocessed)!
    const unknownDateOnly = db.queryFileLocations({
      category: 'photo',
      parserRecipeVersion: METADATA_PARSER_RECIPE_VERSION,
      includeUnknownCaptureDate: true
    })
    expect(unknownDateOnly.items.map((x) => x.id)).toEqual([f3!.id])

    // 3. Capture Date Range + Unknown -> matches f1 AND f3!
    const date2024OrUnknown = db.queryFileLocations({
      category: 'photo',
      parserRecipeVersion: METADATA_PARSER_RECIPE_VERSION,
      captureDateFrom: '2024-01-01',
      captureDateTo: '2024-12-31',
      includeUnknownCaptureDate: true
    })
    expect(date2024OrUnknown.items.map((x) => x.id)).toEqual([f1!.id, f3!.id])

    // 4. Camera & Lens filters + Unknown
    expect(
      db
        .queryFileLocations({
          category: 'photo',
          parserRecipeVersion: METADATA_PARSER_RECIPE_VERSION,
          cameraNormalized: 'canon eos r5'
        })
        .items.map((x) => x.id)
    ).toEqual([f1!.id])
    expect(
      db
        .queryFileLocations({
          category: 'photo',
          parserRecipeVersion: METADATA_PARSER_RECIPE_VERSION,
          onlyUnknownCamera: true
        })
        .items.map((x) => x.id)
    ).toEqual([f3!.id])
    expect(
      db
        .queryFileLocations({
          category: 'photo',
          parserRecipeVersion: METADATA_PARSER_RECIPE_VERSION,
          lensNormalized: 'sony fe 35mm f1.4 gm'
        })
        .items.map((x) => x.id)
    ).toEqual([f2!.id])
    expect(
      db
        .queryFileLocations({
          category: 'photo',
          parserRecipeVersion: METADATA_PARSER_RECIPE_VERSION,
          onlyUnknownLens: true
        })
        .items.map((x) => x.id)
    ).toEqual([f3!.id])

    // 5. Orientation-adjusted display dimension filter:
    // f1 encoded is 4000x3000 with Orientation=6 -> display is 3000x4000!
    // Filtering minWidthPx=3500 must match ONLY f2 (6000x4000), NOT f1 (displayWidth=3000)!
    expect(
      db
        .queryFileLocations({
          category: 'photo',
          parserRecipeVersion: METADATA_PARSER_RECIPE_VERSION,
          minWidthPx: 3500
        })
        .items.map((x) => x.id)
    ).toEqual([f2!.id])

    // Filtering minHeightPx=4000 matches BOTH f1 (display 3000x4000) and f2 (display 6000x4000)!
    expect(
      db
        .queryFileLocations({
          category: 'photo',
          parserRecipeVersion: METADATA_PARSER_RECIPE_VERSION,
          minHeightPx: 4000
        })
        .items.map((x) => x.id)
    ).toEqual([f1!.id, f2!.id])

    // Unknown dimensions only -> matches f4 (HEIC unsupported with null display dimensions), excludes f5 (unprocessed)!
    expect(
      db
        .queryFileLocations({
          category: 'photo',
          parserRecipeVersion: METADATA_PARSER_RECIPE_VERSION,
          includeUnknownDimensions: true
        })
        .items.map((x) => x.id)
    ).toEqual([f4!.id])

    // 6. File Type basis distinction: detected_format vs filename_extension!
    // f3 is a PNG named .jpg:
    expect(
      db
        .queryFileLocations({
          category: 'photo',
          parserRecipeVersion: METADATA_PARSER_RECIPE_VERSION,
          fileTypeBasis: 'detected_format',
          fileTypeValue: 'png'
        })
        .items.map((x) => x.id)
    ).toEqual([f3!.id])

    expect(
      db
        .queryFileLocations({
          category: 'photo',
          parserRecipeVersion: METADATA_PARSER_RECIPE_VERSION,
          fileTypeBasis: 'detected_format',
          fileTypeValue: 'jpeg'
        })
        .items.map((x) => x.id)
    ).toEqual([f1!.id, f2!.id])

    expect(
      db
        .queryFileLocations({
          category: 'photo',
          fileTypeBasis: 'filename_extension',
          fileTypeValue: '.jpg'
        })
        .items.map((x) => x.id)
    ).toHaveLength(4) // f1, f2, f3, f5 all have .jpg filename suffix

    // 7. Combined AND filter with Rating (5), Flag ('pick'), Collection (tripCol.id), and Pagination (limit=1)
    const combinedPage1 = db.queryFileLocations({
      category: 'photo',
      parserRecipeVersion: METADATA_PARSER_RECIPE_VERSION,
      ratingFilter: '4',
      flagFilter: 'pick',
      collectionId: tripCol.id,
      minHeightPx: 4000,
      fileTypeBasis: 'detected_format',
      fileTypeValue: 'jpeg',
      limit: 1,
      offset: 0
    })
    expect(combinedPage1.totalCount).toBe(2)
    expect(combinedPage1.hasMore).toBe(true)
    expect(combinedPage1.items.map((x) => x.id)).toEqual([f1!.id])

    const combinedPage2 = db.queryFileLocations({
      category: 'photo',
      parserRecipeVersion: METADATA_PARSER_RECIPE_VERSION,
      ratingFilter: '4',
      flagFilter: 'pick',
      collectionId: tripCol.id,
      minHeightPx: 4000,
      fileTypeBasis: 'detected_format',
      fileTypeValue: 'jpeg',
      limit: 1,
      offset: 1
    })
    expect(combinedPage2.totalCount).toBe(2)
    expect(combinedPage2.hasMore).toBe(false)
    expect(combinedPage2.items.map((x) => x.id)).toEqual([f2!.id])

    // 8. Bounded searchable/paginated camera & lens facets
    const camFacetsAll = db.getPhotoMetadataFacets({
      field: 'camera',
      parserRecipeVersion: METADATA_PARSER_RECIPE_VERSION,
      limit: 1,
      offset: 0
    })
    expect(camFacetsAll.items).toHaveLength(1)
    expect(camFacetsAll.hasMore).toBe(true)
    expect(camFacetsAll.unknownCount).toBe(1) // f3
    expect(camFacetsAll.unprocessedCount).toBe(1) // f5

    const sonySearch = db.getPhotoMetadataFacets({
      field: 'camera',
      parserRecipeVersion: METADATA_PARSER_RECIPE_VERSION,
      search: 'ilce',
      limit: 10,
      offset: 0
    })
    expect(sonySearch.items).toEqual([
      {
        normalizedValue: 'sony ilce-7m4',
        displayLabel: 'Sony ILCE-7M4',
        count: 1
      }
    ])
  })

  it('scales bounded job snapshotting and SQL filtering across 50,001 catalog photos without collection-size caps', () => {
    db = CatalogDatabase.open({ catalogPath })
    const rootPath = join(tempDir, 'scale-50k')

    const total = 50_001
    const batchSize = 500
    for (let start = 0; start < total; start += batchSize) {
      const end = Math.min(total, start + batchSize)
      const batch = []
      for (let i = start; i < end; i++) {
        batch.push({
          originalPath: join(rootPath, `img_${String(i).padStart(6, '0')}.jpg`),
          fileName: `img_${String(i).padStart(6, '0')}.jpg`,
          extension: '.jpg',
          byteSize: 2048 + (i % 100),
          birthtimeMs: 1_700_000_000_000,
          mtimeMs: 1_700_000_000_000 + i,
          discoveredAtMs: 1_700_000_000_000,
          category: 'photo' as const
        })
      }
      db.persistDiscoveryBatch(rootPath, batch)
    }

    const job = db.createPhotoMetadataJob({
      parserRecipeVersion: METADATA_PARSER_RECIPE_VERSION
    })
    expect(job.totalPhotos).toBe(50_001)
    expect(job.pendingPhotos).toBe(50_001)

    const cov = db.getPhotoMetadataCoverage(METADATA_PARSER_RECIPE_VERSION)
    expect(cov.totalPhotos).toBe(50_001)
    expect(cov.unprocessedCount).toBe(50_001)

    const next16 = db.getNextPendingPhotoMetadataJobItems(job.id, 16)
    expect(next16).toHaveLength(16)
  }, 30_000)
})
