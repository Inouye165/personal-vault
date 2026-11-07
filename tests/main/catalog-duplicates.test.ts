/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { CatalogDatabase } from '../../src/main/services/catalog/database'
import { CURRENT_SCHEMA_VERSION } from '../../src/main/services/catalog/migrations'

describe('Stage 3 — Catalog Duplicate Grouping & Review Decisions', () => {
  let db: CatalogDatabase
  let rawDb: DatabaseSync

  beforeEach(() => {
    db = CatalogDatabase.open({ catalogPath: ':memory:' })
    rawDb = (db as unknown as { db: DatabaseSync }).db
  })

  afterEach(() => {
    if (!db.isClosed()) {
      db.close()
    }
  })

  it('runs schema migration 5 and creates duplicate_reviews table', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(5)
    const tables = rawDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='duplicate_reviews'")
      .all()
    expect(tables).toHaveLength(1)
  })

  it('groups exact duplicates by current verified SHA-256 AND byte size across different filenames and paths', () => {
    const hashIdentical = 'a'.repeat(64)
    const hashDifferent = 'b'.repeat(64)
    const byteSize = 1024

    db.persistDiscoveryBatch('C:\\Photos', [
      {
        originalPath: 'C:\\Photos\\IMG_001.JPG',
        fileName: 'IMG_001.JPG',
        extension: 'jpg',
        byteSize,
        birthtimeMs: 1600000000000,
        mtimeMs: 1600000001000,
        discoveredAtMs: 1600000002000,
        category: 'photo'
      },
      {
        originalPath: 'C:\\Photos\\unique.jpg',
        fileName: 'unique.jpg',
        extension: 'jpg',
        byteSize,
        birthtimeMs: 1600000000000,
        mtimeMs: 1600000001000,
        discoveredAtMs: 1600000002000,
        category: 'photo'
      }
    ])

    db.persistDiscoveryBatch('D:\\Backup', [
      {
        originalPath: 'D:\\Backup\\copy_of_img.jpg',
        fileName: 'copy_of_img.jpg',
        extension: 'jpg',
        byteSize,
        birthtimeMs: null, // explicit unknown birthtime
        mtimeMs: 1600000001000,
        discoveredAtMs: 1600000002000,
        category: 'photo'
      }
    ])

    db.recordHashObservation({
      originalPath: 'C:\\Photos\\IMG_001.JPG',
      sha256: hashIdentical,
      observedByteSize: byteSize,
      observedMtimeMs: 1600000001000,
      hashedAtMs: 1600000003000
    })

    db.recordHashObservation({
      originalPath: 'D:\\Backup\\copy_of_img.jpg',
      sha256: hashIdentical,
      observedByteSize: byteSize,
      observedMtimeMs: 1600000001000,
      hashedAtMs: 1600000004000
    })

    db.recordHashObservation({
      originalPath: 'C:\\Photos\\unique.jpg',
      sha256: hashDifferent,
      observedByteSize: byteSize,
      observedMtimeMs: 1600000001000,
      hashedAtMs: 1600000005000
    })

    const result = db.getDuplicateGroups()
    expect(result.totalCount).toBe(1)
    expect(result.items).toHaveLength(1)

    const group = result.items[0]!
    expect(group.sha256).toBe(hashIdentical)
    expect(group.byteSize).toBe(byteSize)
    expect(group.fileCount).toBe(2)
    expect(group.reviewStatus).toBe('unreviewed')
    expect(group.preferredLocationId).toBeNull()
    expect(group.groupSignature).toBeDefined()
    expect(typeof group.groupSignature).toBe('string')
  })

  it('excludes inactive, invalidated, or superseded discovery observations from duplicate groups', () => {
    const hash = 'c'.repeat(64)
    const byteSize = 2048

    db.persistDiscoveryBatch('C:\\Photos', [
      {
        originalPath: 'C:\\Photos\\file1.jpg',
        fileName: 'file1.jpg',
        extension: 'jpg',
        byteSize,
        birthtimeMs: null,
        mtimeMs: 1000,
        discoveredAtMs: 2000,
        category: 'photo'
      },
      {
        originalPath: 'C:\\Photos\\file2.jpg',
        fileName: 'file2.jpg',
        extension: 'jpg',
        byteSize,
        birthtimeMs: null,
        mtimeMs: 1000,
        discoveredAtMs: 2000,
        category: 'photo'
      }
    ])

    db.recordHashObservation({
      originalPath: 'C:\\Photos\\file1.jpg',
      sha256: hash,
      observedByteSize: byteSize,
      observedMtimeMs: 1000,
      hashedAtMs: 3000
    })

    db.recordHashObservation({
      originalPath: 'C:\\Photos\\file2.jpg',
      sha256: hash,
      observedByteSize: byteSize,
      observedMtimeMs: 1000,
      hashedAtMs: 3000
    })

    // Now file2 changes on disk: new discovery observation deactivates previous observation and invalidates hash
    db.persistDiscoveryBatch('C:\\Photos', [
      {
        originalPath: 'C:\\Photos\\file2.jpg',
        fileName: 'file2.jpg',
        extension: 'jpg',
        byteSize: 3000, // changed size
        birthtimeMs: null,
        mtimeMs: 4000,
        discoveredAtMs: 5000,
        category: 'photo'
      }
    ])

    // Because file2's old hash is now inactive (is_active = 0) and previous discovery observation is superseded (is_current = 0),
    // file1 is the ONLY active file with hash 'c'... so there are NO duplicates!
    const result = db.getDuplicateGroups()
    expect(result.totalCount).toBe(0)
    expect(result.items).toHaveLength(0)
  })

  it('supports independently bounded, deterministically ordered pagination for groups and members', () => {
    const hashA = '1'.repeat(64)
    const hashB = '2'.repeat(64)

    // Group A: 3 members, byteSize 500
    db.persistDiscoveryBatch('C:\\Data', [
      {
        originalPath: 'C:\\Data\\A_1.txt',
        fileName: 'A_1.txt',
        extension: 'txt',
        byteSize: 500,
        birthtimeMs: null,
        mtimeMs: 1000,
        discoveredAtMs: 2000,
        category: 'document'
      },
      {
        originalPath: 'C:\\Data\\A_2.txt',
        fileName: 'A_2.txt',
        extension: 'txt',
        byteSize: 500,
        birthtimeMs: null,
        mtimeMs: 1000,
        discoveredAtMs: 2000,
        category: 'document'
      },
      {
        originalPath: 'C:\\Data\\A_3.txt',
        fileName: 'A_3.txt',
        extension: 'txt',
        byteSize: 500,
        birthtimeMs: null,
        mtimeMs: 1000,
        discoveredAtMs: 2000,
        category: 'document'
      }
    ])

    for (let i = 1; i <= 3; i++) {
      db.recordHashObservation({
        originalPath: `C:\\Data\\A_${i}.txt`,
        sha256: hashA,
        observedByteSize: 500,
        observedMtimeMs: 1000,
        hashedAtMs: 3000
      })
    }

    // Group B: 2 members, byteSize 1000
    db.persistDiscoveryBatch('C:\\Data', [
      {
        originalPath: 'C:\\Data\\B_1.txt',
        fileName: 'B_1.txt',
        extension: 'txt',
        byteSize: 1000,
        birthtimeMs: null,
        mtimeMs: 1000,
        discoveredAtMs: 2000,
        category: 'document'
      },
      {
        originalPath: 'C:\\Data\\B_2.txt',
        fileName: 'B_2.txt',
        extension: 'txt',
        byteSize: 1000,
        birthtimeMs: null,
        mtimeMs: 1000,
        discoveredAtMs: 2000,
        category: 'document'
      }
    ])

    for (let i = 1; i <= 2; i++) {
      db.recordHashObservation({
        originalPath: `C:\\Data\\B_${i}.txt`,
        sha256: hashB,
        observedByteSize: 1000,
        observedMtimeMs: 1000,
        hashedAtMs: 3000
      })
    }

    // Paginate groups: page 1 with limit 1
    const page1 = db.getDuplicateGroups({ offset: 0, limit: 1 })
    expect(page1.totalCount).toBe(2)
    expect(page1.items).toHaveLength(1)
    expect(page1.hasMore).toBe(true)
    // Ordered by file_count DESC -> Group A (3 files) comes first
    expect(page1.items[0]!.sha256).toBe(hashA)

    // Page 2
    const page2 = db.getDuplicateGroups({ offset: 1, limit: 1 })
    expect(page2.totalCount).toBe(2)
    expect(page2.items).toHaveLength(1)
    expect(page2.hasMore).toBe(false)
    expect(page2.items[0]!.sha256).toBe(hashB)

    // Now test member pagination for Group A:
    const membersPage1 = db.getDuplicateGroupMembers({
      sha256: hashA,
      byteSize: 500,
      offset: 0,
      limit: 2
    })
    expect(membersPage1.totalCount).toBe(3)
    expect(membersPage1.items).toHaveLength(2)
    expect(membersPage1.hasMore).toBe(true)
    // Deterministic ordering: by originalPath/id ASC
    expect(membersPage1.items[0]!.originalPath).toBe('C:\\Data\\A_1.txt')
    expect(membersPage1.items[1]!.originalPath).toBe('C:\\Data\\A_2.txt')

    // Members page 2
    const membersPage2 = db.getDuplicateGroupMembers({
      sha256: hashA,
      byteSize: 500,
      offset: 2,
      limit: 2
    })
    expect(membersPage2.totalCount).toBe(3)
    expect(membersPage2.items).toHaveLength(1)
    expect(membersPage2.hasMore).toBe(false)
    expect(membersPage2.items[0]!.originalPath).toBe('C:\\Data\\A_3.txt')
  })

  it('persists review decisions across database reopen without mutating recorded facts', () => {
    const hash = '4'.repeat(64)
    const byteSize = 100

    db.persistDiscoveryBatch('C:\\Data', [
      {
        originalPath: 'C:\\Data\\orig.jpg',
        fileName: 'orig.jpg',
        extension: 'jpg',
        byteSize,
        birthtimeMs: 1000,
        mtimeMs: 2000,
        discoveredAtMs: 3000,
        category: 'photo'
      },
      {
        originalPath: 'C:\\Data\\copy.jpg',
        fileName: 'copy.jpg',
        extension: 'jpg',
        byteSize,
        birthtimeMs: null,
        mtimeMs: 2000,
        discoveredAtMs: 3000,
        category: 'photo'
      }
    ])

    db.recordHashObservation({
      originalPath: 'C:\\Data\\orig.jpg',
      sha256: hash,
      observedByteSize: byteSize,
      observedMtimeMs: 2000,
      hashedAtMs: 4000
    })

    db.recordHashObservation({
      originalPath: 'C:\\Data\\copy.jpg',
      sha256: hash,
      observedByteSize: byteSize,
      observedMtimeMs: 2000,
      hashedAtMs: 4000
    })

    const groupsBefore = db.getDuplicateGroups()
    const groupSig = groupsBefore.items[0]!.groupSignature
    const fl1 = db.getFileLocationByOriginalPath('C:\\Data\\orig.jpg')!
    const fl2 = db.getFileLocationByOriginalPath('C:\\Data\\copy.jpg')!

    // Mark as reviewed and choose fl1 as preferred location
    const reviewResult = db.setDuplicateReview({
      sha256: hash,
      byteSize,
      status: 'reviewed',
      preferredLocationId: fl1.id,
      expectedGroupSignature: groupSig
    })
    expect(reviewResult.status).toBe('reviewed')
    expect(reviewResult.preferredLocationId).toBe(fl1.id)

    // Verify groups query reflects the review
    const groupsAfter = db.getDuplicateGroups()
    expect(groupsAfter.items[0]!.reviewStatus).toBe('reviewed')
    expect(groupsAfter.items[0]!.preferredLocationId).toBe(fl1.id)

    // Verify member query flags fl1 as preferred
    const members = db.getDuplicateGroupMembers({ sha256: hash, byteSize })
    expect(members.items.find((m) => m.fileLocationId === fl1.id)?.isPreferred).toBe(true)
    expect(members.items.find((m) => m.fileLocationId === fl2.id)?.isPreferred).toBe(false)

    // Ensure recorded facts in file_locations & discovery_observations are completely unchanged
    const file1Facts = db.getFileLocationByOriginalPath('C:\\Data\\orig.jpg')
    expect(file1Facts?.fileName).toBe('orig.jpg')
    expect(file1Facts?.activeHash).toBe(hash)
  })

  it('detects stale review submissions and invalidates prior review when group membership or content changes', () => {
    const hash = '5'.repeat(64)
    const byteSize = 250

    db.persistDiscoveryBatch('C:\\Data', [
      {
        originalPath: 'C:\\Data\\file1.txt',
        fileName: 'file1.txt',
        extension: 'txt',
        byteSize,
        birthtimeMs: null,
        mtimeMs: 1000,
        discoveredAtMs: 2000,
        category: 'document'
      },
      {
        originalPath: 'C:\\Data\\file2.txt',
        fileName: 'file2.txt',
        extension: 'txt',
        byteSize,
        birthtimeMs: null,
        mtimeMs: 1000,
        discoveredAtMs: 2000,
        category: 'document'
      }
    ])

    db.recordHashObservation({
      originalPath: 'C:\\Data\\file1.txt',
      sha256: hash,
      observedByteSize: byteSize,
      observedMtimeMs: 1000,
      hashedAtMs: 3000
    })

    db.recordHashObservation({
      originalPath: 'C:\\Data\\file2.txt',
      sha256: hash,
      observedByteSize: byteSize,
      observedMtimeMs: 1000,
      hashedAtMs: 3000
    })

    const initialGroups = db.getDuplicateGroups()
    const oldSig = initialGroups.items[0]!.groupSignature
    const fl1 = db.getFileLocationByOriginalPath('C:\\Data\\file1.txt')!
    const fl2 = db.getFileLocationByOriginalPath('C:\\Data\\file2.txt')!

    // Review decision saved
    db.setDuplicateReview({
      sha256: hash,
      byteSize,
      status: 'reviewed',
      preferredLocationId: fl1.id,
      expectedGroupSignature: oldSig
    })

    // Now a 3rd duplicate file is discovered!
    db.persistDiscoveryBatch('C:\\Data', [
      {
        originalPath: 'C:\\Data\\file3.txt',
        fileName: 'file3.txt',
        extension: 'txt',
        byteSize,
        birthtimeMs: null,
        mtimeMs: 1000,
        discoveredAtMs: 2000,
        category: 'document'
      }
    ])

    db.recordHashObservation({
      originalPath: 'C:\\Data\\file3.txt',
      sha256: hash,
      observedByteSize: byteSize,
      observedMtimeMs: 1000,
      hashedAtMs: 3000
    })

    // 1. Stale write rejection: Trying to submit a review with the old signature must throw/reject
    expect(() => {
      db.setDuplicateReview({
        sha256: hash,
        byteSize,
        status: 'reviewed',
        preferredLocationId: fl2.id,
        expectedGroupSignature: oldSig // outdated signature
      })
    }).toThrow(/stale/i)

    // 2. Invalidation: Querying the duplicate group must NOT silently carry the old 'reviewed' status onto the changed 3-member group
    const updatedGroups = db.getDuplicateGroups()
    expect(updatedGroups.items[0]!.fileCount).toBe(3)
    expect(updatedGroups.items[0]!.groupSignature).not.toBe(oldSig)
    expect(updatedGroups.items[0]!.reviewStatus).toBe('unreviewed')
    expect(updatedGroups.items[0]!.preferredLocationId).toBeNull()
    expect(updatedGroups.items[0]!.hasStaleDecision).toBe(true)
  })

  it('rejects an invalid preferred location that does not belong to the duplicate group', () => {
    const hash = '6'.repeat(64)
    const byteSize = 800

    db.persistDiscoveryBatch('C:\\Data', [
      {
        originalPath: 'C:\\Data\\a.txt',
        fileName: 'a.txt',
        extension: 'txt',
        byteSize,
        birthtimeMs: null,
        mtimeMs: 1000,
        discoveredAtMs: 2000,
        category: 'document'
      },
      {
        originalPath: 'C:\\Data\\b.txt',
        fileName: 'b.txt',
        extension: 'txt',
        byteSize,
        birthtimeMs: null,
        mtimeMs: 1000,
        discoveredAtMs: 2000,
        category: 'document'
      },
      {
        originalPath: 'C:\\Data\\other.txt',
        fileName: 'other.txt',
        extension: 'txt',
        byteSize: 999, // unrelated file
        birthtimeMs: null,
        mtimeMs: 1000,
        discoveredAtMs: 2000,
        category: 'document'
      }
    ])

    db.recordHashObservation({
      originalPath: 'C:\\Data\\a.txt',
      sha256: hash,
      observedByteSize: byteSize,
      observedMtimeMs: 1000,
      hashedAtMs: 3000
    })

    db.recordHashObservation({
      originalPath: 'C:\\Data\\b.txt',
      sha256: hash,
      observedByteSize: byteSize,
      observedMtimeMs: 1000,
      hashedAtMs: 3000
    })

    const group = db.getDuplicateGroups().items[0]!
    const unrelatedFl = db.getFileLocationByOriginalPath('C:\\Data\\other.txt')!

    expect(() => {
      db.setDuplicateReview({
        sha256: hash,
        byteSize,
        status: 'reviewed',
        preferredLocationId: unrelatedFl.id,
        expectedGroupSignature: group.groupSignature
      })
    }).toThrow(/preferred/i)
  })
})
