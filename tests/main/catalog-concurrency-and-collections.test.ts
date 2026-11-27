/**
 * @vitest-environment node
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CatalogDatabase } from '../../src/main/services/catalog/database'
import { AnnotationJournal } from '../../src/main/services/annotations/journal'

describe('Catalog Review Concurrency & Collections (Findings 4 & 5)', () => {
  let tempDir: string
  let dbPath: string
  let journalDir: string
  let catalog: CatalogDatabase

  beforeEach(async () => {
    tempDir = join(
      process.cwd(),
      'temp',
      `test-catalog-concurrency-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    )
    await fs.mkdir(tempDir, { recursive: true })
    dbPath = join(tempDir, 'catalog.sqlite')
    journalDir = join(tempDir, 'journal')
    await fs.mkdir(journalDir, { recursive: true })

    const journal = new AnnotationJournal({ storageDir: journalDir })
    journal.initializeSync()

    catalog = CatalogDatabase.open({
      catalogPath: dbPath,
      journal
    })
  })

  afterEach(async () => {
    try {
      catalog?.close()
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore
    }
  })

  function insertPhotoFixture(
    path: string,
    size: number,
    mtime: number,
    hash: string
  ): { locationId: number; revision: string } {
    const sourceRoot = 'C:\\photos'
    try {
      catalog.registerSource(sourceRoot)
    } catch {
      // Source may already be registered
    }

    catalog.persistDiscoveryBatch(sourceRoot, [
      {
        originalPath: path,
        fileName: path.split('\\').pop()!,
        extension: '.jpg',
        category: 'photo',
        byteSize: size,
        birthtimeMs: 1700000000000,
        mtimeMs: mtime,
        discoveredAtMs: Date.now()
      }
    ])

    const loc = catalog.getFileLocationByPath(path)!

    catalog.recordHashObservation({
      originalPath: path,
      sha256: hash,
      observedByteSize: size,
      observedMtimeMs: mtime,
      hashedAtMs: Date.now()
    })

    const revision = catalog.getPhotoRevisionString(loc.id)
    return { locationId: loc.id, revision }
  }

  it('requires and validates expectedRevision in addCollectionMember, rejecting stale revisions', () => {
    const { locationId, revision } = insertPhotoFixture(
      'C:\\photos\\test1.jpg',
      1000,
      1700000001000,
      'a'.repeat(64)
    )
    const collection = catalog.createCollection({ name: 'Landscapes' })

    // Stale revision must be rejected
    expect(() =>
      (catalog as unknown as { addCollectionMember: (p: unknown) => unknown }).addCollectionMember({
        collectionId: collection.id,
        fileLocationId: locationId,
        expectedRevision: 'stale-rev:wrong-hash'
      })
    ).toThrow(/STALE_REVISION/)

    // Valid revision must succeed
    const res = (
      catalog as unknown as { addCollectionMember: (p: unknown) => { success: boolean } }
    ).addCollectionMember({
      collectionId: collection.id,
      fileLocationId: locationId,
      expectedRevision: revision
    })
    expect(res.success).toBe(true)
  })

  it('requires and validates expectedRevision in removeCollectionMember, rejecting stale revisions', () => {
    const { locationId, revision } = insertPhotoFixture(
      'C:\\photos\\test2.jpg',
      1000,
      1700000001000,
      'b'.repeat(64)
    )
    const collection = catalog.createCollection({ name: 'Nature' })
    ;(catalog as unknown as { addCollectionMember: (p: unknown) => void }).addCollectionMember({
      collectionId: collection.id,
      fileLocationId: locationId,
      expectedRevision: revision
    })

    // Stale revision must be rejected
    expect(() =>
      (
        catalog as unknown as { removeCollectionMember: (p: unknown) => unknown }
      ).removeCollectionMember({
        collectionId: collection.id,
        fileLocationId: locationId,
        expectedRevision: 'stale-rev:different'
      })
    ).toThrow(/STALE_REVISION/)

    // Valid revision succeeds
    const res = (
      catalog as unknown as { removeCollectionMember: (p: unknown) => { success: boolean } }
    ).removeCollectionMember({
      collectionId: collection.id,
      fileLocationId: locationId,
      expectedRevision: revision
    })
    expect(res.success).toBe(true)
  })

  it('supports bounded pagination for collections and photo memberships', () => {
    // Create 15 collections
    for (let i = 1; i <= 15; i++) {
      catalog.createCollection({ name: `Folder ${String(i).padStart(2, '0')}` })
    }

    // Paginate with limit 5, offset 0
    const page1 = catalog.listCollections({ offset: 0, limit: 5 })
    expect(page1.items.length).toBe(5)
    expect(page1.totalCount).toBe(15)
    expect(page1.hasMore).toBe(true)

    // Paginate offset 10, limit 5
    const page3 = catalog.listCollections({ offset: 10, limit: 5 })
    expect(page3.items.length).toBe(5)
    expect(page3.hasMore).toBe(false)
  })

  it('maintains consistent collection counts, photo badges, and queries under content revision changes', () => {
    const { locationId, revision } = insertPhotoFixture(
      'C:\\photos\\modifiable.jpg',
      5000,
      1700000001000,
      'c'.repeat(64)
    )
    const collection = catalog.createCollection({ name: 'Architecture' })
    ;(catalog as unknown as { addCollectionMember: (p: unknown) => void }).addCollectionMember({
      collectionId: collection.id,
      fileLocationId: locationId,
      expectedRevision: revision
    })

    catalog.setPhotoAnnotation({
      fileLocationId: locationId,
      expectedRevision: revision,
      expectedVersion: 0,
      rating: 5,
      flag: 'pick'
    })

    // Initially: collection has photo_count 1, queryFileLocations with collectionId returns 1
    const beforeList = catalog.listCollections({ offset: 0, limit: 10 })
    const archBefore = beforeList.items.find((c) => c.name === 'Architecture')
    expect(archBefore?.photoCount).toBe(1)

    const queriedBefore = catalog.queryFileLocations({
      category: 'photo',
      collectionId: collection.id,
      offset: 0,
      limit: 10
    })
    expect(queriedBefore.items.length).toBe(1)

    // Now simulate external file modification (size and hash change during rescan)
    const sourceRoot = 'C:\\photos'
    catalog.persistDiscoveryBatch(sourceRoot, [
      {
        originalPath: 'C:\\photos\\modifiable.jpg',
        fileName: 'modifiable.jpg',
        extension: '.jpg',
        category: 'photo',
        byteSize: 9999, // size changed!
        birthtimeMs: 1700000000000,
        mtimeMs: 1700000050000,
        discoveredAtMs: Date.now()
      }
    ])
    catalog.recordHashObservation({
      originalPath: 'C:\\photos\\modifiable.jpg',
      sha256: 'd'.repeat(64), // new hash!
      observedByteSize: 9999,
      observedMtimeMs: 1700000050000,
      hashedAtMs: Date.now()
    })

    // Reconcile annotations and memberships (must be set-based without full materialization)
    catalog.reconcilePhotoAnnotations(locationId)

    // After content change:
    // 1. collection photoCount must be 0
    const afterList = catalog.listCollections({ offset: 0, limit: 10 })
    const archAfter = afterList.items.find((c) => c.name === 'Architecture')
    expect(archAfter?.photoCount).toBe(0)

    // 2. queryFileLocations with collectionId must be 0
    const queriedAfter = catalog.queryFileLocations({
      category: 'photo',
      collectionId: collection.id,
      offset: 0,
      limit: 10
    })
    expect(queriedAfter.items.length).toBe(0)

    // 3. getCollectionMembershipsForPhoto must be 0
    const membershipsAfter = catalog.getCollectionMembershipsForPhoto({
      fileLocationId: locationId,
      offset: 0,
      limit: 10
    })
    expect(membershipsAfter.items.length).toBe(0)
  })
})
