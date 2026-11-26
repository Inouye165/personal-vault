// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import sharp from 'sharp'
import { CatalogDatabase } from '../../src/main/services/catalog/database'
import { ScanJobCoordinator } from '../../src/main/services/jobs/coordinator'
import { PhotoMetadataCoordinator } from '../../src/main/services/metadata/coordinator'
import { ThumbnailCoordinator } from '../../src/main/services/thumbnails/coordinator'
import { PhotoSearchCoordinator } from '../../src/main/services/search'
import { executeSearchDatabaseQuery } from '../../src/main/services/semantic/search-worker'
import {
  computeManifestSha256,
  REQUIRED_MODEL_ARTIFACTS,
  SEMANTIC_EMBEDDING_DIMENSIONS,
  SEMANTIC_MODEL_COMMIT,
  SEMANTIC_MODEL_ID,
  SEMANTIC_PREPROCESSING_VERSION
} from '../../src/main/services/semantic'
import { IPC_CHANNELS } from '../../src/shared/contracts/channels'
import type {
  SemanticSearchRequest,
  SemanticSearchResponse
} from '../../src/shared/validation/ipc-schemas'
import {
  EXIF_TAG_IDS,
  buildGpsTags,
  buildRawTiffExifBuffer,
  createHeicWithExif,
  createJpegFixture
} from '../helpers/exif-fixture-builder'

const { registeredHandlers, mockIpcMain } = vi.hoisted(() => {
  const registeredHandlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  return {
    registeredHandlers,
    mockIpcMain: {
      handle: vi.fn((channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
        registeredHandlers.set(channel, handler)
      }),
      removeHandler: vi.fn((channel: string) => {
        registeredHandlers.delete(channel)
      })
    }
  }
})

vi.mock('electron', () => ({
  app: { getVersion: () => '0.1.0-test', isPackaged: false, getPath: () => tmpdir() },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: mockIpcMain
}))

import { registerIpcHandlers } from '../../src/main/ipc/handlers'

const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function makeNormalizedVector(axis: number): Float32Array {
  const vec = new Float32Array(SEMANTIC_EMBEDDING_DIMENSIONS)
  vec[axis] = 1.0
  return vec
}

function mixVectors(w0: number, w1: number): Float32Array {
  const vec = new Float32Array(SEMANTIC_EMBEDDING_DIMENSIONS)
  vec[0] = w0
  vec[1] = w1
  const norm = Math.hypot(w0, w1)
  if (norm > 0) {
    vec[0] /= norm
    vec[1] /= norm
  }
  return vec
}

async function waitForScanDone(coordinator: ScanJobCoordinator): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const latest = coordinator.getLatestJob()
    if (latest && (latest.status === 'completed' || latest.status === 'failed')) {
      if (latest.status !== 'completed') {
        throw new Error(`Scan failed: ${latest.errorMessage ?? 'unknown error'}`)
      }
      return
    }
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('Timed out waiting for scan completion')
}

async function waitForMetadataDone(coordinator: PhotoMetadataCoordinator): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const prog = coordinator.getProgress()
    if (prog.status === 'completed' || prog.status === 'failed') {
      if (prog.status !== 'completed') {
        throw new Error(`Metadata extraction failed (status=${prog.status})`)
      }
      return
    }
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('Timed out waiting for metadata extraction completion')
}

afterEach(() => {
  registeredHandlers.clear()
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('Metadata-aware offline photo search & filter-before-ranking integration', () => {
  it('answers metadata-only queries without a visual model and filters GPS/dates BEFORE visual ranking', async () => {
    const workDir = makeTempDir('pv-meta-search-')
    const photoDir = join(workDir, 'photos')
    mkdirSync(photoDir, { recursive: true })
    const catalogPath = join(workDir, 'catalog.db')
    const fixtureHeic = join(process.cwd(), 'tests/fixtures/heic/portrait_exif6.heic')

    // 1. Yellowstone mountain (2025-06-06) — HEIC
    const yellowstoneMountainPath = join(photoDir, 'yellowstone-mountain.heic')
    const ymExif = buildRawTiffExifBuffer({
      ifd0Tags: [
        { tagId: EXIF_TAG_IDS.Make, type: 'ascii', value: 'Apple' },
        { tagId: EXIF_TAG_IDS.Model, type: 'ascii', value: 'iPhone 15 Pro' }
      ],
      exifTags: [
        { tagId: EXIF_TAG_IDS.DateTimeOriginal, type: 'ascii', value: '2025:06:06 10:15:00' },
        { tagId: EXIF_TAG_IDS.OffsetTimeOriginal, type: 'ascii', value: '-06:00' }
      ],
      gpsTags: buildGpsTags({ lat: 44.4605, lon: -110.8281, altitudeM: 2245 }),
      littleEndian: true
    })
    writeFileSync(yellowstoneMountainPath, createHeicWithExif(ymExif, fixtureHeic))

    // 2. Yellowstone restaurant interior (2025-06-06) — JPEG (Canon EOS R5)
    const yellowstoneRestaurantPath = join(photoDir, 'yellowstone-restaurant.jpg')
    writeFileSync(
      yellowstoneRestaurantPath,
      await createJpegFixture({
        ifd0Tags: [
          { tagId: EXIF_TAG_IDS.Make, type: 'ascii', value: 'Canon' },
          { tagId: EXIF_TAG_IDS.Model, type: 'ascii', value: 'Canon EOS R5' }
        ],
        exifTags: [
          { tagId: EXIF_TAG_IDS.DateTimeOriginal, type: 'ascii', value: '2025:06:06 19:45:00' },
          { tagId: EXIF_TAG_IDS.OffsetTimeOriginal, type: 'ascii', value: '-06:00' }
        ],
        gpsTags: buildGpsTags({ lat: 44.725, lon: -110.491, altitudeM: 2380 }),
        littleEndian: true
      })
    )

    // 3. Colorado mountain OUTSIDE Yellowstone (2025-07-04) — JPEG
    const coloradoMountainPath = join(photoDir, 'colorado-mountain.jpg')
    writeFileSync(
      coloradoMountainPath,
      await createJpegFixture({
        ifd0Tags: [{ tagId: EXIF_TAG_IDS.Model, type: 'ascii', value: 'Canon EOS R5' }],
        exifTags: [
          { tagId: EXIF_TAG_IDS.DateTimeOriginal, type: 'ascii', value: '2025:07:04 08:00:00' }
        ],
        gpsTags: buildGpsTags({ lat: 39.7392, lon: -104.9903 }),
        littleEndian: true
      })
    )

    // 4. Recurring June 6 in 2023 + wedding week 2024-09-12 (no GPS)
    const recurring2023Path = join(photoDir, 'anniversary-2023.jpg')
    writeFileSync(
      recurring2023Path,
      await createJpegFixture({
        ifd0Tags: [{ tagId: EXIF_TAG_IDS.Model, type: 'ascii', value: 'Sony ILCE-7M4' }],
        exifTags: [
          { tagId: EXIF_TAG_IDS.DateTimeOriginal, type: 'ascii', value: '2023:06:06 12:00:00' }
        ],
        littleEndian: true
      })
    )

    const weddingPath = join(photoDir, 'wedding-toast.jpg')
    writeFileSync(
      weddingPath,
      await createJpegFixture({
        ifd0Tags: [{ tagId: EXIF_TAG_IDS.Model, type: 'ascii', value: 'Canon EOS R5' }],
        exifTags: [
          { tagId: EXIF_TAG_IDS.DateTimeOriginal, type: 'ascii', value: '2024:09:12 18:00:00' }
        ],
        littleEndian: true
      })
    )

    // 5. No-metadata PNG (no EXIF tags or GPS)
    const missingMetaPath = join(photoDir, 'plain-note.png')
    const plainPng = await sharp({
      create: { width: 32, height: 32, channels: 3, background: { r: 100, g: 120, b: 140 } }
    })
      .png()
      .toBuffer()
    writeFileSync(missingMetaPath, plainPng)

    // Record original byte hashes & mtimes before scanning/metadata extraction
    const beforeStats = new Map<string, { sha: string; mtimeMs: number }>()
    for (const p of [
      yellowstoneMountainPath,
      yellowstoneRestaurantPath,
      coloradoMountainPath,
      recurring2023Path,
      weddingPath,
      missingMetaPath
    ]) {
      const buf = readFileSync(p)
      beforeStats.set(p, {
        sha: createHash('sha256').update(buf).digest('hex'),
        mtimeMs: statSync(p).mtimeMs
      })
    }

    const catalog = CatalogDatabase.open({ catalogPath })
    const scanCoordinator = new ScanJobCoordinator({ catalog })
    await scanCoordinator.initialize()
    await scanCoordinator.startScan({ roots: [photoDir] })
    await waitForScanDone(scanCoordinator)

    const thumbnailCoordinator = new ThumbnailCoordinator({
      cacheDir: join(workDir, 'thumbs'),
      approvedRoots: () => catalog.getAllSourceRoots(),
      vaultPath: () => catalog.getActiveVault()?.vaultPath ?? null
    })
    await thumbnailCoordinator.initialize()
    const metaCoordinator = new PhotoMetadataCoordinator({ catalog, thumbnailCoordinator })
    metaCoordinator.initialize()
    await metaCoordinator.startExtraction()
    await waitForMetadataDone(metaCoordinator)

    // Verify original files remained 100% read-only
    for (const [p, expected] of beforeStats.entries()) {
      const shaAfter = createHash('sha256').update(readFileSync(p)).digest('hex')
      expect(shaAfter).toBe(expected.sha)
      expect(statSync(p).mtimeMs).toBe(expected.mtimeMs)
    }

    let modelState: 'missing' | 'ready' = 'missing'
    const semanticCalls: SemanticSearchRequest[] = []

    const fakeUnifiedCoordinator = {
      async searchPhotosFromTab(req: SemanticSearchRequest): Promise<SemanticSearchResponse> {
        semanticCalls.push(req)
        const queryVector = makeNormalizedVector(0) // Axis 0 represents "mountains"
        const res = executeSearchDatabaseQuery({
          catalogPath,
          queryVector,
          filters: {
            category: 'photo',
            ratingFilter: req.ratingFilter,
            flagFilter: req.flagFilter,
            collectionId: req.collectionId ?? null,
            captureDateFrom: req.captureDateFrom ?? null,
            captureDateTo: req.captureDateTo ?? null,
            captureMonth: req.captureMonth ?? null,
            captureDay: req.captureDay ?? null,
            includeUnknownCaptureDate: req.includeUnknownCaptureDate ?? false,
            gpsBounds: req.gpsBounds ?? null,
            userPlaceId: req.userPlaceId ?? null,
            userPlaceLabel: req.userPlaceLabel ?? null,
            cameraNormalized: req.cameraNormalized ?? null,
            onlyUnknownCamera: req.onlyUnknownCamera ?? false,
            lensNormalized: req.lensNormalized ?? null,
            onlyUnknownLens: req.onlyUnknownLens ?? false,
            minWidthPx: req.minWidthPx ?? null,
            minHeightPx: req.minHeightPx ?? null,
            includeUnknownDimensions: req.includeUnknownDimensions ?? false,
            fileTypeBasis: req.fileTypeBasis ?? 'detected_format',
            fileTypeValue: req.fileTypeValue ?? null,
            onlyUnknownDetectedFormat: req.onlyUnknownDetectedFormat ?? false
          },
          limit: req.limit ?? 50,
          offset: req.offset ?? 0,
          minScore: req.minScore ?? 0
        })
        return {
          items: res.rankedItems.map((item, idx) => ({
            photo: catalog.getFileLocationById(item.fileLocationId)! as never,
            score: item.score,
            rank: (req.offset ?? 0) + idx + 1
          })),
          totalMatched: res.totalMatched,
          eligibleCount: res.eligibleCount,
          unindexedCount: res.unindexedCount,
          staleCount: res.staleCount,
          corruptCount: res.corruptCount,
          offset: res.offset,
          limit: res.limit,
          hasMore: res.hasMore,
          queryLatencyMs: 1,
          truncated: false,
          tokenCount: 1,
          modelStatus: 'ready'
        }
      }
    }

    const searchCoordinator = new PhotoSearchCoordinator({
      catalog,
      unifiedSearchCoordinator: fakeUnifiedCoordinator as never,
      semanticModelManager: { getStatus: () => ({ state: modelState }) } as never,
      photoMetadataCoordinator: metaCoordinator
    })

    // Case 1: "Yellowstone in 2025" and "Show me Yellowstone in 2025" work WITHOUT visual model and include restaurant interior
    const yellowstone2025 = await searchCoordinator.search({ queryText: 'Yellowstone in 2025' })
    expect(yellowstone2025.mode).toBe('metadata_only')
    expect(yellowstone2025.visualModelRequired).toBe(false)
    expect(semanticCalls.length).toBe(0)
    expect(yellowstone2025.items.map((i) => i.photo.fileName).sort()).toEqual([
      'yellowstone-mountain.heic',
      'yellowstone-restaurant.jpg'
    ])

    const showMeYellowstone2025 = await searchCoordinator.search({
      queryText: 'Show me Yellowstone in 2025'
    })
    expect(showMeYellowstone2025.mode).toBe('metadata_only')
    expect(showMeYellowstone2025.visualModelRequired).toBe(false)
    expect(showMeYellowstone2025.interpretedFilters).toEqual(yellowstone2025.interpretedFilters)
    expect(showMeYellowstone2025.items.map((i) => i.photo.fileName).sort()).toEqual([
      'yellowstone-mountain.heic',
      'yellowstone-restaurant.jpg'
    ])
    expect(semanticCalls.length).toBe(0)

    // Case 1b: "My dog" and "Dog in the snow" remain pure visual searches (no define_event / define_place prompts)
    for (const pureVisualQuery of ['My dog', 'Dog in the snow']) {
      const visualRes = await searchCoordinator.search({ queryText: pureVisualQuery })
      expect(visualRes.mode).toBe('visual_only')
      expect(visualRes.visualModelRequired).toBe(true)
      expect(visualRes.clarification).toBeNull()
      expect(visualRes.interpretedFilters.place).toBeNull()
      expect(visualRes.interpretedFilters.date).toBeNull()
      expect(visualRes.interpretedFilters.visualTerms).toBe(pureVisualQuery)
    }

    // Case 2: Camera filter combines with location & date without inferring ownership
    const yellowstoneCanon = await searchCoordinator.search({
      queryText: 'Yellowstone on Canon EOS R5 in 2025'
    })
    expect(yellowstoneCanon.items.map((i) => i.photo.fileName)).toEqual([
      'yellowstone-restaurant.jpg'
    ])

    // Case 3: "June 6 of any year" matches June 6 across 2023 + 2025 without visual model
    const june6 = await searchCoordinator.search({ queryText: 'June 6 of any year' })
    expect(june6.mode).toBe('metadata_only')
    expect(june6.items.map((i) => i.photo.fileName).sort()).toEqual([
      'anniversary-2023.jpg',
      'yellowstone-mountain.heic',
      'yellowstone-restaurant.jpg'
    ])

    // Case 4: "My wedding week" prompts for date range, then returns matching photo once saved
    const weddingPrompt = await searchCoordinator.search({ queryText: 'My wedding week' })
    expect(weddingPrompt.mode).toBe('needs_clarification')
    expect(weddingPrompt.clarification?.kind).toBe('define_event')

    catalog.upsertSavedEvent({
      name: 'My wedding week',
      dateFrom: '2024-09-10',
      dateTo: '2024-09-16'
    })
    const weddingMatched = await searchCoordinator.search({ queryText: 'My wedding week' })
    expect(weddingMatched.mode).toBe('metadata_only')
    expect(weddingMatched.items.map((i) => i.photo.fileName)).toEqual(['wedding-toast.jpg'])

    // Case 5: Ambiguous "Springfield" prompts user offline
    const springfield = await searchCoordinator.search({ queryText: 'Springfield' })
    expect(springfield.mode).toBe('needs_clarification')
    expect(springfield.clarification?.kind).toBe('disambiguate_place')

    // Case 6: "Mountains in Yellowstone" while visual model missing -> prompts with filtered count;
    // bypass returns Yellowstone candidates without visual ranking
    const hybridUnprovisioned = await searchCoordinator.search({
      queryText: 'Mountains in Yellowstone'
    })
    expect(hybridUnprovisioned.mode).toBe('hybrid')
    expect(hybridUnprovisioned.visualModelRequired).toBe(true)
    expect(hybridUnprovisioned.filteredCandidateCount).toBe(2)

    const bypassed = await searchCoordinator.search({
      queryText: 'Mountains in Yellowstone',
      bypassVisualModel: true
    })
    expect(bypassed.mode).toBe('metadata_only')
    expect(bypassed.items.length).toBe(2)

    // Case 7: Insert visual embeddings and enable visual model -> filter Yellowstone GPS BEFORE top-1 ranking
    // Colorado mountain gets cosine 0.99 for "mountains", Yellowstone mountain gets 0.85,
    // Yellowstone restaurant interior gets 0.20. Even with limit=1, Colorado mountain must NOT steal rank 1!
    const rawDb = new DatabaseSync(catalogPath)
    try {
      const pageAll = catalog.queryFileLocations({ category: 'photo', offset: 0, limit: 50 })
      const byName = new Map(pageAll.items.map((p) => [p.fileName, p]))
      const insertVec = rawDb.prepare(`
        INSERT INTO photo_semantic_embeddings (
          file_id, file_location_id, discovery_observation_id,
          content_sha256, content_revision, source_path, observed_byte_size, observed_mtime_ms,
          model_id, model_commit, model_manifest_sha256, preprocessing_version,
          embedding_dimensions, embedding_blob, is_current, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?);
      `)
      const assignments: Array<[string, Float32Array]> = [
        ['colorado-mountain.jpg', mixVectors(0.99, 0.14)],
        ['yellowstone-mountain.heic', mixVectors(0.85, 0.52)],
        ['yellowstone-restaurant.jpg', mixVectors(0.2, 0.98)]
      ]
      const manifestSha = computeManifestSha256(REQUIRED_MODEL_ARTIFACTS)
      for (const [name, vec] of assignments) {
        const photo = byName.get(name)!
        const sha = photo.activeHash ?? 'a'.repeat(64)
        const mtime = photo.filesystemMtimeMs ?? 1700000000000
        const rev = `semrev:${photo.discoveryObservationId}:${photo.byteSize}:${mtime}:${sha}`
        insertVec.run(
          photo.id,
          photo.id,
          photo.discoveryObservationId,
          sha,
          rev,
          photo.originalPath,
          photo.byteSize,
          mtime,
          SEMANTIC_MODEL_ID,
          SEMANTIC_MODEL_COMMIT,
          manifestSha,
          SEMANTIC_PREPROCESSING_VERSION,
          SEMANTIC_EMBEDDING_DIMENSIONS,
          Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength),
          1700000000000
        )
      }
    } finally {
      rawDb.close()
    }

    modelState = 'ready'
    const top1MountainsInYellowstone = await searchCoordinator.search({
      queryText: 'Mountains in Yellowstone',
      limit: 1
    })
    expect(top1MountainsInYellowstone.mode).toBe('hybrid')
    expect(top1MountainsInYellowstone.visualModelRequired).toBe(false)
    expect(top1MountainsInYellowstone.filteredCandidateCount).toBe(2)
    expect(top1MountainsInYellowstone.totalMatched).toBe(2)
    expect(top1MountainsInYellowstone.items[0]?.photo.fileName).toBe('yellowstone-mountain.heic')

    // Case 8: User-assigned place includes an un-geotagged photo in place search while keeping storage separate
    const plainPhoto = catalog
      .queryFileLocations({ category: 'photo', offset: 0, limit: 50 })
      .items.find((p) => p.fileName === 'plain-note.png')!
    catalog.setPhotoUserPlace({
      fileLocationId: plainPhoto.id,
      placeLabel: 'Yellowstone National Park'
    })
    const withUserPlace = await searchCoordinator.search({ queryText: 'Yellowstone' })
    expect(withUserPlace.items.map((i) => i.photo.fileName).sort()).toEqual([
      'plain-note.png',
      'yellowstone-mountain.heic',
      'yellowstone-restaurant.jpg'
    ])
    const detail = catalog.getPhotoTechnicalMetadataDetail(plainPhoto.id)!
    expect(detail.currentMetadata?.gpsStatus).toBe('absent')
    expect(detail.userPlace?.placeLabel).toBe('Yellowstone National Park')

    // Case 9: Verify IPC boundary sender rejection across all new metadata-aware search & user-metadata channels
    registerIpcHandlers({
      validateSender: (event) => {
        const e = event as { senderId?: number }
        return e.senderId === 1
      },
      catalog,
      photoMetadataCoordinator: metaCoordinator,
      photoSearchCoordinator: searchCoordinator
    })

    const badEvent = { senderId: 999 }
    await expect(
      registeredHandlers.get(IPC_CHANNELS.PHOTOS_SEARCH_METADATA_AWARE)!(badEvent, {
        queryText: 'Yellowstone in 2025'
      })
    ).rejects.toThrow(/Unauthorized IPC sender/)

    await expect(
      registeredHandlers.get(IPC_CHANNELS.SAVED_EVENTS_UPSERT)!(badEvent, {
        name: 'Trip',
        dateFrom: '2024-01-01',
        dateTo: '2024-01-02'
      })
    ).rejects.toThrow(/Unauthorized IPC sender/)

    await expect(
      registeredHandlers.get(IPC_CHANNELS.SAVED_PLACES_UPSERT)!(badEvent, {
        name: 'Cabin',
        minLat: 38.9,
        maxLat: 39.2,
        minLon: -120.2,
        maxLon: -119.9
      })
    ).rejects.toThrow(/Unauthorized IPC sender/)

    await expect(
      registeredHandlers.get(IPC_CHANNELS.CAMERA_LABELS_UPSERT)!(badEvent, {
        cameraNormalized: 'canon eos r5',
        label: 'Main Body'
      })
    ).rejects.toThrow(/Unauthorized IPC sender/)

    const goodIpcRes = (await registeredHandlers.get(IPC_CHANNELS.PHOTOS_SEARCH_METADATA_AWARE)!(
      { senderId: 1 },
      { queryText: 'June 6 of any year' }
    )) as { items: Array<{ photo: { fileName: string } }> }
    expect(goodIpcRes.items.length).toBe(3)

    await metaCoordinator.shutdown()
    await thumbnailCoordinator.shutdown()
    await scanCoordinator.shutdown()
    catalog.close()
  })
})
