// @vitest-environment node
import { createHash } from 'node:crypto'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CatalogDatabase } from '../../src/main/services/catalog/database'
import { runMigrations } from '../../src/main/services/catalog/migrations'
import { discoverFiles } from '../../src/main/services/discovery/scanner'
import { VideoMediaReconciler } from '../../src/main/services/video/reconciler'

function box(type: string, payload: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(8 + payload.length, 0)
  header.write(type, 4, 'ascii')
  return Buffer.concat([header, payload])
}

function fullBox(type: string, version: number, flags: number, payload: Buffer): Buffer {
  const vf = Buffer.alloc(4)
  vf.writeUInt32BE(((version & 0xff) << 24) | (flags & 0xffffff), 0)
  return box(type, Buffer.concat([vf, payload]))
}

function makeQuickTimeHevcBytes(): Buffer {
  const ftypPayload = Buffer.alloc(12)
  ftypPayload.write('qt  ', 0, 'ascii')
  ftypPayload.write('qt  ', 8, 'ascii')
  const mvhdPayload = Buffer.alloc(96)
  mvhdPayload.writeUInt32BE(1000, 8)
  mvhdPayload.writeUInt32BE(3200, 12)
  const tkhdPayload = Buffer.alloc(80)
  tkhdPayload.writeUInt32BE(1, 8)
  tkhdPayload.writeUInt32BE(1920 << 16, 72)
  tkhdPayload.writeUInt32BE(1080 << 16, 76)
  const hdlrPayload = Buffer.alloc(24)
  hdlrPayload.write('vide', 4, 'ascii')
  const stsdCount = Buffer.alloc(4)
  stsdCount.writeUInt32BE(1, 0)
  const stsd = fullBox('stsd', 0, 0, Buffer.concat([stsdCount, box('hvc1', Buffer.alloc(24))]))
  const videTrak = box(
    'trak',
    Buffer.concat([
      fullBox('tkhd', 0, 3, tkhdPayload),
      box(
        'mdia',
        Buffer.concat([fullBox('hdlr', 0, 0, hdlrPayload), box('minf', box('stbl', stsd))])
      )
    ])
  )
  const moov = box('moov', Buffer.concat([fullBox('mvhd', 0, 0, mvhdPayload), videTrak]))
  return Buffer.concat([box('ftyp', ftypPayload), box('mdat', Buffer.from([1, 2, 3, 4])), moov])
}

function sha256(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

describe('video catalog migration, discovery, and in-place reclassification', () => {
  let workDir: string

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'pv-vid-cat-'))
  })

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  it('discovers .mp4/.mov and mislabeled IMG_1450.JPG as videos while keeping HEIC as photo and source files read-only', async () => {
    const sourceDir = join(workDir, 'library')
    const catalogPath = join(workDir, 'catalog.db')
    const heicPath = join(sourceDir, 'portrait.heic')
    const mislabeledPath = join(sourceDir, 'IMG_1450.JPG')
    const mp4Path = join(sourceDir, 'clip.mp4')

    const { mkdirSync } = await import('node:fs')
    mkdirSync(sourceDir, { recursive: true })
    copyFileSync(resolve(__dirname, '../fixtures/heic/portrait_exif6.heic'), heicPath)
    writeFileSync(mislabeledPath, makeQuickTimeHevcBytes())

    const mp4Ftyp = Buffer.alloc(12)
    mp4Ftyp.write('mp42', 0, 'ascii')
    mp4Ftyp.write('mp42', 8, 'ascii')
    const mp4Moov = makeQuickTimeHevcBytes().subarray(20) // reuse mdat+moov
    writeFileSync(mp4Path, Buffer.concat([box('ftyp', mp4Ftyp), mp4Moov]))

    const beforeMislabeledHash = sha256(mislabeledPath)
    const beforeHeicHash = sha256(heicPath)

    const discovered = await discoverFiles({ roots: [sourceDir] })
    expect(discovered.candidates).toHaveLength(3)

    const db = CatalogDatabase.open({ catalogPath })
    try {
      db.persistDiscoveryBatch(
        sourceDir,
        discovered.candidates.map((c) => ({
          originalPath: c.absolutePath,
          fileName: c.fileName,
          extension: c.extension,
          byteSize: c.byteSize,
          birthtimeMs: c.filesystemCreatedAt ? Date.parse(c.filesystemCreatedAt) : null,
          mtimeMs: c.filesystemModifiedAt ? Date.parse(c.filesystemModifiedAt) : null,
          discoveredAtMs: Date.now(),
          category: c.candidateKind,
          mediaKind: c.mediaKind,
          videoMetadata: c.videoMetadata
            ? {
                containerFormat: c.videoMetadata.container,
                videoCodec: c.videoMetadata.videoCodec,
                audioCodec: c.videoMetadata.audioCodec,
                durationMs: c.videoMetadata.durationMs,
                widthPx: c.videoMetadata.widthPx,
                heightPx: c.videoMetadata.heightPx,
                isPlayableStructure: c.videoMetadata.isPlayableStructure,
                structureError: c.videoMetadata.structureError,
                inspectedAtMs: Date.now()
              }
            : null
        }))
      )

      const counts = db.getVisualLibraryMediaCounts()
      expect(counts).toEqual({ totalCount: 3, photoCount: 1, videoCount: 2 })

      const videos = db.queryFileLocations({ category: 'photo', mediaKindFilter: 'video' })
      expect(videos.totalCount).toBe(2)
      const mislabeled = videos.items.find((i) => i.fileName === 'IMG_1450.JPG')
      expect(mislabeled).toBeDefined()
      expect(mislabeled?.extension).toBe('.jpg')
      expect(mislabeled?.mediaKind).toBe('video')
      expect(mislabeled?.videoContainer).toBe('quicktime')
      expect(mislabeled?.videoCodec).toBe('hevc')

      const photos = db.queryFileLocations({ category: 'photo', mediaKindFilter: 'photo' })
      expect(photos.totalCount).toBe(1)
      expect(photos.items[0]?.fileName).toBe('portrait.heic')
      expect(photos.items[0]?.mediaKind).toBe('photo')

      // Photo metadata coverage only counts actual photos, not videos
      expect(db.getPhotoMetadataCoverage().totalPhotos).toBe(1)
    } finally {
      db.close()
    }

    expect(sha256(mislabeledPath)).toBe(beforeMislabeledHash)
    expect(sha256(heicPath)).toBe(beforeHeicHash)
  })

  it('reclassifies existing pre-migration catalog entries in place preserving IDs, ratings, collections, vault copies, and backups', async () => {
    const sourceDir = join(workDir, 'legacy')
    const catalogPath = join(workDir, 'legacy-catalog.db')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(sourceDir, { recursive: true })

    const mislabeledPath = join(sourceDir, 'IMG_1450.JPG')
    const videoBytes = makeQuickTimeHevcBytes()
    writeFileSync(mislabeledPath, videoBytes)
    const fileSha = sha256(mislabeledPath)

    // Simulate an older schema v22 database (before media_kind existed)
    const rawDb = new DatabaseSync(catalogPath)
    // Run migrations up to 22 by opening and seeding, or running migrations then rolling back v23?
    // Even simpler: run all migrations, then verify existing uninspected row (`media_kind = 'photo'`, `media_kind_inspected_at_ms = NULL`)
    runMigrations(rawDb)
    rawDb.close()

    const db = CatalogDatabase.open({ catalogPath })
    try {
      // Insert legacy photo entry without mediaKind inspection
      db.persistDiscoveryBatch(sourceDir, [
        {
          originalPath: mislabeledPath,
          fileName: 'IMG_1450.JPG',
          extension: '.jpg',
          byteSize: videoBytes.length,
          birthtimeMs: 1700000000000,
          mtimeMs: 1700000000000,
          discoveredAtMs: 1700000000000,
          category: 'photo'
        }
      ])

      const beforeRecord = db.getFileLocationByPath(mislabeledPath)!
      expect(beforeRecord.mediaKind).toBe('photo')
      db.recordHashObservation({
        originalPath: mislabeledPath,
        sha256: fileSha,
        observedByteSize: videoBytes.length,
        observedMtimeMs: 1700000000000,
        hashedAtMs: 1700000001000
      })

      const revision = db.getPhotoRevisionString(beforeRecord.id)
      db.setPhotoAnnotation({
        fileLocationId: beforeRecord.id,
        expectedRevision: revision,
        expectedVersion: 0,
        rating: 5,
        flag: 'pick'
      })
      const collection = db.createCollection({ name: 'Hawaii' })
      db.addCollectionMember({
        collectionId: collection.id,
        fileLocationId: beforeRecord.id,
        expectedRevision: revision
      })
      db.registerVault({
        vaultId: 'v-test',
        vaultPath: join(workDir, 'vault'),
        name: 'Vault',
        createdAtMs: 1700000000000
      })
      db.recordVaultCopy({
        vaultId: 'v-test',
        sha256: fileSha,
        byteSize: videoBytes.length,
        relativePath: `files/${fileSha.slice(0, 2)}/${fileSha}/IMG_1450.JPG`,
        manifestRelativePath: `manifests/${fileSha.slice(0, 2)}/${fileSha}.json`,
        verifiedAtMs: 1700000002000
      })

      // Run in-place reconciler
      const reconciler = new VideoMediaReconciler({ catalog: db, startupDelayMs: 0 })
      const count = await reconciler.reconcileNow()
      expect(count).toBe(1)

      const afterRecord = db.getFileLocationById(beforeRecord.id)!
      expect(afterRecord.id).toBe(beforeRecord.id)
      expect(afterRecord.mediaKind).toBe('video')
      expect(afterRecord.fileName).toBe('IMG_1450.JPG')
      expect(afterRecord.extension).toBe('.jpg')
      expect(afterRecord.rating).toBe(5)
      expect(afterRecord.flag).toBe('pick')
      expect(afterRecord.videoContainer).toBe('quicktime')
      expect(afterRecord.videoCodec).toBe('hevc')

      const memberships = db.getCollectionMembershipsForPhoto({ fileLocationId: beforeRecord.id })
      expect(memberships.items.map((m) => m.collectionName)).toEqual(['Hawaii'])

      const vaultCopy = db.getVaultCopy('v-test', fileSha, videoBytes.length)
      expect(vaultCopy).not.toBeNull()
      expect(sha256(mislabeledPath)).toBe(fileSha)
    } finally {
      db.close()
    }
  })
})
