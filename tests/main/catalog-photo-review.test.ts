/**
 * @vitest-environment node
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AnnotationJournal } from '../../src/main/services/annotations/journal'
import { CatalogDatabase } from '../../src/main/services/catalog/database'
import { UnsupportedSchemaVersionError } from '../../src/main/services/catalog/errors'
import { CURRENT_SCHEMA_VERSION } from '../../src/main/services/catalog/migrations'

describe('CatalogDatabase Stage 5B Photo Review & Collections', () => {
  let tempDir: string
  let catalogPath: string
  let journalDir: string
  let catalog: CatalogDatabase
  let journal: AnnotationJournal

  beforeEach(async () => {
    tempDir = join(
      process.cwd(),
      'temp',
      `test-catalog-review-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    )
    await fs.mkdir(tempDir, { recursive: true })
    catalogPath = join(tempDir, 'catalog.db')
    journalDir = join(tempDir, 'annotations')

    journal = new AnnotationJournal({ storageDir: journalDir })
    await journal.initialize()

    catalog = CatalogDatabase.open({ catalogPath, journal })
  })

  afterEach(async () => {
    try {
      catalog.close()
    } catch {
      // Ignore
    }
    try {
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore
    }
  })

  it('runs Migration 7 and checks schema version', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(7)
    const tables = catalog
      .getRawDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table';")
      .all() as { name: string }[]
    const tableNames = tables.map((t) => t.name)
    expect(tableNames).toContain('photo_annotations')
    expect(tableNames).toContain('collections')
    expect(tableNames).toContain('collection_memberships')
  })

  it('safeguards against opening newer schema versions', () => {
    catalog
      .getRawDb()
      .exec(
        "INSERT INTO schema_migrations (version, name, applied_at_ms) VALUES (999, 'future', 1);"
      )
    catalog.close()

    expect(() => CatalogDatabase.open({ catalogPath })).toThrow(UnsupportedSchemaVersionError)
  })

  describe('Collection Management', () => {
    it('creates collections with normalized names and rejects duplicates case-insensitively', () => {
      const c1 = catalog.createCollection({ name: 'Summer Vacation' })
      expect(c1.id).toBeGreaterThan(0)
      expect(c1.name).toBe('Summer Vacation')
      expect(c1.normalizedName).toBe('summer vacation')

      // Case-insensitive duplicate rejection
      expect(() => catalog.createCollection({ name: 'summer vacation' })).toThrow(/already exists/i)
      expect(() => catalog.createCollection({ name: '  Summer VACATION  ' })).toThrow(
        /already exists/i
      )
    })

    it('rejects invalid collection names (empty, whitespace-only, > 80 chars, control chars)', () => {
      expect(() => catalog.createCollection({ name: '' })).toThrow()
      expect(() => catalog.createCollection({ name: '    ' })).toThrow()
      expect(() => catalog.createCollection({ name: 'A'.repeat(81) })).toThrow()
      expect(() => catalog.createCollection({ name: 'Invalid\nName' })).toThrow()
      expect(() => catalog.createCollection({ name: 'Null\x00Byte' })).toThrow()
    })

    it('renames collections and enforces uniqueness', () => {
      const c1 = catalog.createCollection({ name: 'Trips' })
      catalog.createCollection({ name: 'Family' })

      const renamed = catalog.renameCollection({ collectionId: c1.id, name: 'Vacations' })
      expect(renamed.name).toBe('Vacations')
      expect(renamed.normalizedName).toBe('vacations')

      // Conflict with existing
      expect(() => catalog.renameCollection({ collectionId: c1.id, name: 'family' })).toThrow(
        /already exists/i
      )
    })

    it('lists collections with pagination and accurate photo count', () => {
      catalog.createCollection({ name: 'Col B' })
      catalog.createCollection({ name: 'Col A' })

      const list = catalog.listCollections({ offset: 0, limit: 10 })
      expect(list.totalCount).toBe(2)
      expect(list.items.length).toBe(2)
    })
  })

  describe('Photo Annotations (Ratings & Flags)', () => {
    const sourceRoot = 'C:\\test\\photos'
    let photo1Id: number
    let photo2Id: number

    beforeEach(() => {
      catalog.registerSource(sourceRoot)

      // Seed photo 1
      catalog.persistDiscoveryBatch(sourceRoot, [
        {
          originalPath: 'C:\\test\\photos\\p1.jpg',
          fileName: 'p1.jpg',
          extension: '.jpg',
          category: 'photo',
          byteSize: 1000,
          birthtimeMs: 1700000000000,
          mtimeMs: 1700000000000,
          discoveredAtMs: 1700000000000
        },
        {
          originalPath: 'C:\\test\\photos\\sub\\p1_copy.jpg',
          fileName: 'p1_copy.jpg',
          extension: '.jpg',
          category: 'photo',
          byteSize: 1000,
          birthtimeMs: 1700000000000,
          mtimeMs: 1700000000000,
          discoveredAtMs: 1700000000000
        }
      ])

      const p1 = catalog.getFileLocationByPath('C:\\test\\photos\\p1.jpg')!
      const p2 = catalog.getFileLocationByPath('C:\\test\\photos\\sub\\p1_copy.jpg')!
      photo1Id = p1.id
      photo2Id = p2.id

      catalog.recordHashObservation({
        originalPath: 'C:\\test\\photos\\p1.jpg',
        sha256: '1'.repeat(64),
        observedByteSize: 1000,
        observedMtimeMs: 1700000000000,
        hashedAtMs: 1700000000000
      })

      catalog.recordHashObservation({
        originalPath: 'C:\\test\\photos\\sub\\p1_copy.jpg',
        sha256: '1'.repeat(64),
        observedByteSize: 1000,
        observedMtimeMs: 1700000000000,
        hashedAtMs: 1700000000000
      })
    })

    it('sets, updates, and clears rating and flag', () => {
      const rev1 = catalog.getPhotoRevisionString(photo1Id)

      // Set rating 4, flag pick
      const a1 = catalog.setPhotoAnnotation({
        fileLocationId: photo1Id,
        expectedRevision: rev1,
        expectedVersion: 0,
        rating: 4,
        flag: 'pick'
      })

      expect(a1.rating).toBe(4)
      expect(a1.flag).toBe('pick')
      expect(a1.version).toBe(1)

      // Fetch annotation
      const fetched = catalog.getPhotoAnnotation(photo1Id)
      expect(fetched?.rating).toBe(4)
      expect(fetched?.flag).toBe('pick')

      // Clear rating, change flag to reject
      const a2 = catalog.setPhotoAnnotation({
        fileLocationId: photo1Id,
        expectedRevision: rev1,
        expectedVersion: 1,
        rating: null,
        flag: 'reject'
      })
      expect(a2.rating).toBeNull()
      expect(a2.flag).toBe('reject')
      expect(a2.version).toBe(2)

      // Clear flag to none
      const a3 = catalog.setPhotoAnnotation({
        fileLocationId: photo1Id,
        expectedRevision: rev1,
        expectedVersion: 2,
        rating: null,
        flag: 'none'
      })
      expect(a3.flag).toBe('none')
    })

    it('keeps duplicate photos at distinct paths independently annotated', () => {
      const rev1 = catalog.getPhotoRevisionString(photo1Id)
      const rev2 = catalog.getPhotoRevisionString(photo2Id)

      catalog.setPhotoAnnotation({
        fileLocationId: photo1Id,
        expectedRevision: rev1,
        expectedVersion: 0,
        rating: 5,
        flag: 'pick'
      })

      catalog.setPhotoAnnotation({
        fileLocationId: photo2Id,
        expectedRevision: rev2,
        expectedVersion: 0,
        rating: 1,
        flag: 'reject'
      })

      expect(catalog.getPhotoAnnotation(photo1Id)?.rating).toBe(5)
      expect(catalog.getPhotoAnnotation(photo1Id)?.flag).toBe('pick')
      expect(catalog.getPhotoAnnotation(photo2Id)?.rating).toBe(1)
      expect(catalog.getPhotoAnnotation(photo2Id)?.flag).toBe('reject')
    })

    it('rejects stale writes when expected revision or version does not match', () => {
      const rev1 = catalog.getPhotoRevisionString(photo1Id)

      catalog.setPhotoAnnotation({
        fileLocationId: photo1Id,
        expectedRevision: rev1,
        expectedVersion: 0,
        rating: 3,
        flag: 'none'
      })

      // Try writing with stale version 0
      expect(() =>
        catalog.setPhotoAnnotation({
          fileLocationId: photo1Id,
          expectedRevision: rev1,
          expectedVersion: 0,
          rating: 4,
          flag: 'pick'
        })
      ).toThrow(/STALE_ANNOTATION_VERSION/i)

      // Try writing with invalid revision
      expect(() =>
        catalog.setPhotoAnnotation({
          fileLocationId: photo1Id,
          expectedRevision: 'wrong-revision',
          expectedVersion: 1,
          rating: 4,
          flag: 'pick'
        })
      ).toThrow(/STALE_REVISION/i)
    })

    it('preserves annotations across unchanged rescan', () => {
      const rev1 = catalog.getPhotoRevisionString(photo1Id)
      catalog.setPhotoAnnotation({
        fileLocationId: photo1Id,
        expectedRevision: rev1,
        expectedVersion: 0,
        rating: 5,
        flag: 'pick'
      })

      // Simulate unchanged rescan: same mtime, same size
      catalog.persistDiscoveryBatch(sourceRoot, [
        {
          originalPath: 'C:\\test\\photos\\p1.jpg',
          fileName: 'p1.jpg',
          extension: '.jpg',
          category: 'photo',
          byteSize: 1000,
          birthtimeMs: 1700000000000,
          mtimeMs: 1700000000000,
          discoveredAtMs: 1700000050000
        }
      ])

      const ann = catalog.getPhotoAnnotation(photo1Id)
      expect(ann?.rating).toBe(5)
      expect(ann?.flag).toBe('pick')
    })

    it('preserves annotations when mtime changes but verified content hash is identical', () => {
      const rev1 = catalog.getPhotoRevisionString(photo1Id)
      catalog.setPhotoAnnotation({
        fileLocationId: photo1Id,
        expectedRevision: rev1,
        expectedVersion: 0,
        rating: 5,
        flag: 'pick'
      })

      // File touched: mtime changed -> new discovery observation
      catalog.persistDiscoveryBatch(sourceRoot, [
        {
          originalPath: 'C:\\test\\photos\\p1.jpg',
          fileName: 'p1.jpg',
          extension: '.jpg',
          category: 'photo',
          byteSize: 1000,
          birthtimeMs: 1700000000000,
          mtimeMs: 1700000099000, // touched
          discoveredAtMs: 1700000100000
        }
      ])

      // Verified hashing establishes equivalence (same sha256)
      catalog.recordHashObservation({
        originalPath: 'C:\\test\\photos\\p1.jpg',
        sha256: '1'.repeat(64),
        observedByteSize: 1000,
        observedMtimeMs: 1700000099000,
        hashedAtMs: 1700000105000
      })

      const ann = catalog.getPhotoAnnotation(photo1Id)
      expect(ann?.rating).toBe(5)
      expect(ann?.flag).toBe('pick')
    })

    it('invalidates active annotation when content changes (different hash or unhashed with changed size/mtime)', () => {
      const rev1 = catalog.getPhotoRevisionString(photo1Id)
      catalog.setPhotoAnnotation({
        fileLocationId: photo1Id,
        expectedRevision: rev1,
        expectedVersion: 0,
        rating: 5,
        flag: 'pick'
      })

      // File content edited: new size and new hash
      catalog.persistDiscoveryBatch(sourceRoot, [
        {
          originalPath: 'C:\\test\\photos\\p1.jpg',
          fileName: 'p1.jpg',
          extension: '.jpg',
          category: 'photo',
          byteSize: 2000, // changed size
          birthtimeMs: 1700000000000,
          mtimeMs: 1700000099000,
          discoveredAtMs: 1700000100000
        }
      ])
      catalog.recordHashObservation({
        originalPath: 'C:\\test\\photos\\p1.jpg',
        sha256: '2'.repeat(64), // changed hash
        observedByteSize: 2000,
        observedMtimeMs: 1700000099000,
        hashedAtMs: 1700000105000
      })

      // The new revision must present as unreviewed!
      const ann = catalog.getPhotoAnnotation(photo1Id)
      expect(ann).toBeNull()

      // Prior annotation history remains preserved in database
      const history = catalog.getPhotoAnnotationHistory(photo1Id)
      expect(history.length).toBe(1)
      expect(history[0]!.rating).toBe(5)
      expect(history[0]!.isCurrent).toBe(false)
    })
  })

  describe('Memberships and SQL Filtering', () => {
    const sourceRoot = 'C:\\photos'
    let photos: number[] = []
    let col1: number
    let col2: number

    beforeEach(() => {
      catalog.registerSource(sourceRoot)

      photos = []
      const batch = []
      // Create 5 photos
      for (let i = 1; i <= 5; i++) {
        batch.push({
          originalPath: `C:\\photos\\img_${i}.jpg`,
          fileName: `img_${i}.jpg`,
          extension: '.jpg',
          category: 'photo' as const,
          byteSize: 1000 * i,
          birthtimeMs: 1700000000000,
          mtimeMs: 1700000000000,
          discoveredAtMs: 1700000000000
        })
      }
      catalog.persistDiscoveryBatch(sourceRoot, batch)

      for (let i = 1; i <= 5; i++) {
        const item = catalog.getFileLocationByPath(`C:\\photos\\img_${i}.jpg`)!
        photos.push(item.id)
      }

      col1 = catalog.createCollection({ name: 'Landscape' }).id
      col2 = catalog.createCollection({ name: 'Favorites' }).id

      // Annotate photos:
      // Photo 1: 5 stars, pick, col1
      // Photo 2: 4 stars, pick, col1 + col2
      // Photo 3: 2 stars, reject, col2
      // Photo 4: unrated, none, col1
      // Photo 5: unrated, none, no collection
      const p0 = photos[0]!
      const p1 = photos[1]!
      const p2 = photos[2]!
      const p3 = photos[3]!

      catalog.setPhotoAnnotation({
        fileLocationId: p0,
        expectedRevision: catalog.getPhotoRevisionString(p0),
        expectedVersion: 0,
        rating: 5,
        flag: 'pick'
      })
      catalog.addCollectionMember({
        collectionId: col1,
        fileLocationId: p0,
        expectedRevision: catalog.getPhotoRevisionString(p0)
      })

      catalog.setPhotoAnnotation({
        fileLocationId: p1,
        expectedRevision: catalog.getPhotoRevisionString(p1),
        expectedVersion: 0,
        rating: 4,
        flag: 'pick'
      })
      catalog.addCollectionMember({
        collectionId: col1,
        fileLocationId: p1,
        expectedRevision: catalog.getPhotoRevisionString(p1)
      })
      catalog.addCollectionMember({
        collectionId: col2,
        fileLocationId: p1,
        expectedRevision: catalog.getPhotoRevisionString(p1)
      })

      catalog.setPhotoAnnotation({
        fileLocationId: p2,
        expectedRevision: catalog.getPhotoRevisionString(p2),
        expectedVersion: 0,
        rating: 2,
        flag: 'reject'
      })
      catalog.addCollectionMember({
        collectionId: col2,
        fileLocationId: p2,
        expectedRevision: catalog.getPhotoRevisionString(p2)
      })

      catalog.addCollectionMember({
        collectionId: col1,
        fileLocationId: p3,
        expectedRevision: catalog.getPhotoRevisionString(p3)
      })
    })

    it('manages collection memberships idempotently and removes membership', () => {
      const p0 = photos[0]!
      // Adding duplicate membership is idempotent
      const res1 = catalog.addCollectionMember({
        collectionId: col1,
        fileLocationId: p0,
        expectedRevision: catalog.getPhotoRevisionString(p0)
      })
      expect(res1.isNew).toBe(false)

      const memberships = catalog.getCollectionMembershipsForPhoto({ fileLocationId: p0 })
      expect(memberships.totalCount).toBe(1)
      expect(memberships.items[0]!.collectionName).toBe('Landscape')

      // Remove membership
      const removed = catalog.removeCollectionMember({
        collectionId: col1,
        fileLocationId: p0,
        expectedRevision: catalog.getPhotoRevisionString(p0)
      })
      expect(removed.success).toBe(true)

      const after = catalog.getCollectionMembershipsForPhoto({ fileLocationId: p0 })
      expect(after.totalCount).toBe(0)
    })

    it('filters photos by rating in SQL (all, unrated, 1..5 stars)', () => {
      // All
      expect(
        catalog.queryFileLocations({ category: 'photo', ratingFilter: 'all' }).totalCount
      ).toBe(5)

      // Unrated (photos 4 and 5)
      const unrated = catalog.queryFileLocations({ category: 'photo', ratingFilter: 'unrated' })
      expect(unrated.totalCount).toBe(2)
      expect(unrated.items.map((i) => i.id)).toEqual([photos[3], photos[4]])

      // 4 stars or higher (photos 1 and 2)
      const fourPlus = catalog.queryFileLocations({ category: 'photo', ratingFilter: '4' })
      expect(fourPlus.totalCount).toBe(2)
      expect(fourPlus.items.map((i) => i.id)).toEqual([photos[0], photos[1]])

      // 5 stars only (photo 1)
      const fiveOnly = catalog.queryFileLocations({ category: 'photo', ratingFilter: '5' })
      expect(fiveOnly.totalCount).toBe(1)
      expect(fiveOnly.items[0]!.id).toBe(photos[0])
    })

    it('filters photos by flag in SQL (all, none, pick, reject)', () => {
      const picks = catalog.queryFileLocations({ category: 'photo', flagFilter: 'pick' })
      expect(picks.totalCount).toBe(2)
      expect(picks.items.map((i) => i.id)).toEqual([photos[0], photos[1]])

      const rejects = catalog.queryFileLocations({ category: 'photo', flagFilter: 'reject' })
      expect(rejects.totalCount).toBe(1)
      expect(rejects.items[0]!.id).toBe(photos[2])

      const nones = catalog.queryFileLocations({ category: 'photo', flagFilter: 'none' })
      expect(nones.totalCount).toBe(2)
      expect(nones.items.map((i) => i.id)).toEqual([photos[3], photos[4]])
    })

    it('filters photos by collection and combines filters with AND', () => {
      // In Col 1 (Landscape): photos 1, 2, 4
      const inCol1 = catalog.queryFileLocations({ category: 'photo', collectionId: col1 })
      expect(inCol1.totalCount).toBe(3)

      // Combined: in Col 1 AND flag pick AND rating >= 4 -> photos 1 and 2
      const combined = catalog.queryFileLocations({
        category: 'photo',
        collectionId: col1,
        flagFilter: 'pick',
        ratingFilter: '4'
      })
      expect(combined.totalCount).toBe(2)

      // Combined: in Col 1 AND flag pick AND rating 5 -> photo 1 only
      const fivePickCol1 = catalog.queryFileLocations({
        category: 'photo',
        collectionId: col1,
        flagFilter: 'pick',
        ratingFilter: '5'
      })
      expect(fivePickCol1.totalCount).toBe(1)
      expect(fivePickCol1.items[0]!.id).toBe(photos[0])
    })

    it('rolls back database transaction and fails if journal write fails', async () => {
      const failingJournal = new AnnotationJournal({
        storageDir: journalDir,
        customAppenderSync: () => {
          throw new Error('ENOSPC: Simulated disk failure')
        }
      })
      await failingJournal.initialize()

      const failingCatalog = CatalogDatabase.open({ catalogPath, journal: failingJournal })

      try {
        const p4 = photos[4]!
        const rev = failingCatalog.getPhotoRevisionString(p4)
        expect(() =>
          failingCatalog.setPhotoAnnotation({
            fileLocationId: p4,
            expectedRevision: rev,
            expectedVersion: 0,
            rating: 3,
            flag: 'none'
          })
        ).toThrow('ENOSPC')

        // Must NOT have saved in database
        expect(failingCatalog.getPhotoAnnotation(p4)).toBeNull()
      } finally {
        failingCatalog.close()
      }
    })
  })
})
