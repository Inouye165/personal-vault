/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import {
  CatalogDatabase,
  UnsupportedSchemaVersionError,
  DatabaseClosedError,
  normalizePathForLookup
} from '../../src/main/services/catalog'
import type { DiscoveryCandidateInput } from '../../src/main/services/catalog'

describe('Stage 2C — SQLite Catalog Schema and Inventory Persistence', () => {
  let testDir: string
  let catalogPath: string
  let db: CatalogDatabase | null = null

  beforeEach(async () => {
    testDir = await fs.mkdtemp(join(tmpdir(), 'pv-catalog-test-'))
    catalogPath = join(testDir, 'catalog.db')
  })

  afterEach(async () => {
    if (db && !db.isClosed()) {
      db.close()
    }
    db = null
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {})
  })

  describe('Initialization and Lifecycle', () => {
    it('initializes explicitly at a caller-supplied path without import-time side effects', async () => {
      expect(db).toBeNull()
      // File should not exist before opening
      await expect(fs.access(catalogPath)).rejects.toThrow()

      db = CatalogDatabase.open({ catalogPath })
      expect(db.isClosed()).toBe(false)

      // Database file was created explicitly
      const stat = await fs.stat(catalogPath)
      expect(stat.isFile()).toBe(true)
    })

    it('creates missing parent directories if needed for catalog file', async () => {
      const nestedPath = join(testDir, 'nested', 'deep', 'vault-catalog.db')
      db = CatalogDatabase.open({ catalogPath: nestedPath })
      expect(db.isClosed()).toBe(false)
      const stat = await fs.stat(nestedPath)
      expect(stat.isFile()).toBe(true)
    })

    it('supports deterministic cleanup and rejects operations once closed', () => {
      db = CatalogDatabase.open({ catalogPath })
      expect(db.isClosed()).toBe(false)

      db.close()
      expect(db.isClosed()).toBe(true)

      // Subsequent operations should throw DatabaseClosedError
      expect(() => db!.listSources()).toThrow(DatabaseClosedError)

      // Calling close again is idempotent and does not throw
      expect(() => db!.close()).not.toThrow()
    })
  })

  describe('Schema Migrations and Reopening Durability', () => {
    it('applies initial migration version 1 and records migration history', () => {
      db = CatalogDatabase.open({ catalogPath })
      const rawDb = new DatabaseSync(catalogPath)
      try {
        const migrations = rawDb
          .prepare(
            'SELECT version, name, applied_at_ms FROM schema_migrations ORDER BY version ASC'
          )
          .all() as Array<{ version: number; name: string; applied_at_ms: number }>

        expect(migrations.length).toBeGreaterThanOrEqual(1)
        expect(migrations[0]?.version).toBe(1)
        expect(migrations[0]?.name).toBe('initial_catalog_schema')
        expect(typeof migrations[0]?.applied_at_ms).toBe('number')
      } finally {
        rawDb.close()
      }
    })

    it('safely reopens an existing catalog without re-running migrations or losing data', () => {
      db = CatalogDatabase.open({ catalogPath })
      const source = db.registerSource('D:\\Photos')
      expect(source.id).toBeGreaterThan(0)
      db.close()

      // Reopen
      db = CatalogDatabase.open({ catalogPath })
      const sources = db.listSources()
      expect(sources).toHaveLength(1)
      expect(sources[0]?.rootPath).toBe('D:\\Photos')
    })

    it('fails safely without modifying the database when encountering an unsupported future schema version', () => {
      // First initialize schema v1
      db = CatalogDatabase.open({ catalogPath })
      db.close()

      // Manually set schema version to an unsupported future version (e.g. 999)
      const rawDb = new DatabaseSync(catalogPath)
      try {
        rawDb
          .prepare('INSERT INTO schema_migrations (version, name, applied_at_ms) VALUES (?, ?, ?)')
          .run(999, 'future_version', Date.now())
      } finally {
        rawDb.close()
      }

      // Reopening should throw UnsupportedSchemaVersionError
      expect(() => CatalogDatabase.open({ catalogPath })).toThrow(UnsupportedSchemaVersionError)

      // Verify the database was not modified or corrupted
      const checkDb = new DatabaseSync(catalogPath)
      try {
        const row = checkDb
          .prepare('SELECT MAX(version) as max_version FROM schema_migrations')
          .get() as { max_version: number }
        expect(row.max_version).toBe(999)
      } finally {
        checkDb.close()
      }
    })
  })

  describe('Foreign Key Enforcement and Relationships', () => {
    it('enforces foreign keys when inserting file locations or hash observations', () => {
      db = CatalogDatabase.open({ catalogPath })
      const rawDb = new DatabaseSync(catalogPath)
      try {
        // Attempting to insert a file location referencing a non-existent source_id must fail
        expect(() => {
          rawDb
            .prepare(
              `INSERT INTO file_locations (
                source_id, original_path, normalized_path, file_name, extension, category,
                byte_size, filesystem_birthtime_ms, filesystem_mtime_ms, inferred_capture_time_ms,
                first_discovered_at_ms, last_seen_at_ms
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              99999,
              'D:\\Photos\\missing.jpg',
              'd:\\photos\\missing.jpg',
              'missing.jpg',
              'jpg',
              'photo',
              100,
              null,
              null,
              null,
              Date.now(),
              Date.now()
            )
        }).toThrow(/FOREIGN KEY/i)

        // Attempting to insert a hash observation referencing a non-existent file_location_id must fail
        expect(() => {
          rawDb
            .prepare(
              `INSERT INTO hash_observations (
                file_location_id, sha256, observed_byte_size, observed_mtime_ms, hashed_at_ms, is_active
              ) VALUES (?, ?, ?, ?, ?, ?)`
            )
            .run(
              99999,
              'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
              0,
              null,
              Date.now(),
              1
            )
        }).toThrow(/FOREIGN KEY/i)
      } finally {
        rawDb.close()
      }
    })

    it('cascades deletion from source to file locations and hash observations', () => {
      db = CatalogDatabase.open({ catalogPath })
      const source = db.registerSource('D:\\Photos')

      const candidate: DiscoveryCandidateInput = {
        originalPath: 'D:\\Photos\\cascade.jpg',
        fileName: 'cascade.jpg',
        extension: 'jpg',
        byteSize: 1024,
        birthtimeMs: 1700000000000,
        mtimeMs: 1700001000000,
        discoveredAtMs: 1700002000000,
        category: 'photo'
      }

      db.persistDiscoveryBatch('D:\\Photos', [candidate])
      const file = db.getFileLocationByPath('D:\\Photos\\cascade.jpg')
      expect(file).not.toBeNull()

      db.recordHashObservation({
        originalPath: 'D:\\Photos\\cascade.jpg',
        sha256: 'a'.repeat(64),
        observedByteSize: 1024,
        observedMtimeMs: 1700001000000,
        hashedAtMs: 1700003000000
      })

      // Delete the source directly in raw db
      const rawDb = new DatabaseSync(catalogPath)
      try {
        rawDb.prepare('DELETE FROM sources WHERE id = ?').run(source.id)
      } finally {
        rawDb.close()
      }

      // Both file_location and hash_observation should be gone via ON DELETE CASCADE
      expect(db.getFileLocationByPath('D:\\Photos\\cascade.jpg')).toBeNull()
      const rawCheck = new DatabaseSync(catalogPath)
      try {
        const hashes = rawCheck.prepare('SELECT * FROM hash_observations').all()
        expect(hashes).toHaveLength(0)
      } finally {
        rawCheck.close()
      }
    })
  })

  describe('Discovery Facts and Source Preservation', () => {
    it('preserves exact original filenames, paths, and Unicode characters verbatim', () => {
      db = CatalogDatabase.open({ catalogPath })
      const originalPath = 'D:\\Fotos 2024\\日本語\\東京_タワー 🌸.JPG'
      const fileName = '東京_タワー 🌸.JPG'

      const candidate: DiscoveryCandidateInput = {
        originalPath,
        fileName,
        extension: 'jpg',
        byteSize: 4096,
        birthtimeMs: 1700000000000,
        mtimeMs: 1700000500000,
        discoveredAtMs: 1700001000000,
        category: 'photo'
      }

      db.persistDiscoveryBatch('D:\\Fotos 2024', [candidate])

      const record = db.getFileLocationByPath(originalPath)
      expect(record).not.toBeNull()
      expect(record?.originalPath).toBe(originalPath)
      expect(record?.fileName).toBe(fileName)
      expect(record?.extension).toBe('jpg')
      expect(record?.category).toBe('photo')
    })

    it('keeps filesystem dates distinct from capture dates and preserves null timestamps', () => {
      db = CatalogDatabase.open({ catalogPath })
      const candidate: DiscoveryCandidateInput = {
        originalPath: 'D:\\Docs\\nodate.txt',
        fileName: 'nodate.txt',
        extension: 'txt',
        byteSize: 50,
        birthtimeMs: null,
        mtimeMs: null,
        discoveredAtMs: 1700000000000,
        category: 'document'
      }

      db.persistDiscoveryBatch('D:\\Docs', [candidate])

      const record = db.getFileLocationByPath('D:\\Docs\\nodate.txt')
      expect(record).not.toBeNull()
      expect(record?.filesystemBirthtimeMs).toBeNull()
      expect(record?.filesystemMtimeMs).toBeNull()
      expect(record?.inferredCaptureTimeMs).toBeNull()
    })

    it('preserves separate normalized lookup keys without altering original paths', () => {
      const original = 'D:/Photos/SubFolder/Image.JPG'
      const normalizedWin = normalizePathForLookup(original, 'win32')
      expect(normalizedWin).toBe('d:\\photos\\subfolder\\image.jpg')

      const originalPosix = '/Volumes/Photos/SubFolder/Image.JPG'
      const normalizedPosix = normalizePathForLookup(originalPosix, 'linux')
      expect(normalizedPosix).toBe('/Volumes/Photos/SubFolder/Image.JPG')
    })
  })

  describe('Duplicate Content Preservation at Different Paths', () => {
    it('preserves multiple file locations with identical SHA-256 hashes without merging or losing metadata', () => {
      db = CatalogDatabase.open({ catalogPath })
      const sha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

      const fileA: DiscoveryCandidateInput = {
        originalPath: 'D:\\Photos\\Album1\\pic.jpg',
        fileName: 'pic.jpg',
        extension: 'jpg',
        byteSize: 2048,
        birthtimeMs: 1600000000000,
        mtimeMs: 1600000100000,
        discoveredAtMs: 1700000000000,
        category: 'photo'
      }

      const fileB: DiscoveryCandidateInput = {
        originalPath: 'D:\\Backup\\OldFiles\\different_name.jpg',
        fileName: 'different_name.jpg',
        extension: 'jpg',
        byteSize: 2048,
        birthtimeMs: 1650000000000, // Different creation time
        mtimeMs: 1600000100000,
        discoveredAtMs: 1700000000000,
        category: 'photo'
      }

      db.persistDiscoveryBatch('D:\\Photos', [fileA])
      db.persistDiscoveryBatch('D:\\Backup', [fileB])

      db.recordHashObservation({
        originalPath: fileA.originalPath,
        sha256,
        observedByteSize: 2048,
        observedMtimeMs: 1600000100000,
        hashedAtMs: 1700000500000
      })

      db.recordHashObservation({
        originalPath: fileB.originalPath,
        sha256,
        observedByteSize: 2048,
        observedMtimeMs: 1600000100000,
        hashedAtMs: 1700000600000
      })

      // Verify both locations exist independently with their own metadata
      const recordA = db.getFileLocationByPath(fileA.originalPath)
      const recordB = db.getFileLocationByPath(fileB.originalPath)

      expect(recordA).not.toBeNull()
      expect(recordB).not.toBeNull()
      expect(recordA?.id).not.toBe(recordB?.id)
      expect(recordA?.originalPath).toBe(fileA.originalPath)
      expect(recordB?.originalPath).toBe(fileB.originalPath)
      expect(recordA?.fileName).toBe('pic.jpg')
      expect(recordB?.fileName).toBe('different_name.jpg')
      expect(recordA?.filesystemBirthtimeMs).toBe(1600000000000)
      expect(recordB?.filesystemBirthtimeMs).toBe(1650000000000)
      expect(recordA?.activeHash).toBe(sha256)
      expect(recordB?.activeHash).toBe(sha256)

      // Query duplicate groups
      const duplicates = db.getDuplicateGroups()
      expect(duplicates.totalCount).toBe(1)
      expect(duplicates.items[0]?.sha256).toBe(sha256)
      expect(duplicates.items[0]?.fileCount).toBe(2)
      expect(duplicates.items[0]?.locations).toHaveLength(2)
    })
  })

  describe('Changed-File Observations and Hash Invalidation', () => {
    it('invalidates existing active hash when discovery observes modified file size or mtime', () => {
      db = CatalogDatabase.open({ catalogPath })
      const originalPath = 'D:\\Photos\\editable.jpg'
      const oldHash = '1'.repeat(64)

      // 1. Initial scan
      const candidateV1: DiscoveryCandidateInput = {
        originalPath,
        fileName: 'editable.jpg',
        extension: 'jpg',
        byteSize: 1000,
        birthtimeMs: 1700000000000,
        mtimeMs: 1700000000000,
        discoveredAtMs: 1700000000000,
        category: 'photo'
      }
      db.persistDiscoveryBatch('D:\\Photos', [candidateV1])

      // 2. Hash observation recorded
      db.recordHashObservation({
        originalPath,
        sha256: oldHash,
        observedByteSize: 1000,
        observedMtimeMs: 1700000000000,
        hashedAtMs: 1700000050000
      })

      const beforeChange = db.getFileLocationByPath(originalPath)
      expect(beforeChange?.activeHash).toBe(oldHash)

      // 3. New scan observes changed file (modified mtime and size)
      const candidateV2: DiscoveryCandidateInput = {
        originalPath,
        fileName: 'editable.jpg',
        extension: 'jpg',
        byteSize: 1250, // Changed!
        birthtimeMs: 1700000000000,
        mtimeMs: 1700001000000, // Changed!
        discoveredAtMs: 1700002000000,
        category: 'photo'
      }
      const batchResult = db.persistDiscoveryBatch('D:\\Photos', [candidateV2])
      expect(batchResult.updatedCount).toBe(1)
      expect(batchResult.invalidatedHashCount).toBe(1)

      // 4. Critical check: Active hash is now NULL, old hash is NOT presented as verified
      const afterChange = db.getFileLocationByPath(originalPath)
      expect(afterChange?.byteSize).toBe(1250)
      expect(afterChange?.filesystemMtimeMs).toBe(1700001000000)
      expect(afterChange?.activeHash).toBeNull()

      // History of observations: old observation is marked inactive
      const history = db.getHashObservationsForFile(afterChange!.id)
      expect(history).toHaveLength(1)
      expect(history[0]?.sha256).toBe(oldHash)
      expect(history[0]?.isActive).toBe(false)

      // 5. Subsequent hashing verifies the new content
      const newHash = '2'.repeat(64)
      db.recordHashObservation({
        originalPath,
        sha256: newHash,
        observedByteSize: 1250,
        observedMtimeMs: 1700001000000,
        hashedAtMs: 1700003000000
      })

      const afterRehash = db.getFileLocationByPath(originalPath)
      expect(afterRehash?.activeHash).toBe(newHash)

      const historyAfterRehash = db.getHashObservationsForFile(afterChange!.id)
      expect(historyAfterRehash).toHaveLength(2)
      expect(historyAfterRehash.find((h) => h.sha256 === oldHash)?.isActive).toBe(false)
      expect(historyAfterRehash.find((h) => h.sha256 === newHash)?.isActive).toBe(true)
    })

    it('rejects recording a hash observation if observed size or mtime does not match current discovery facts', () => {
      db = CatalogDatabase.open({ catalogPath })
      const originalPath = 'D:\\Photos\\stale.jpg'

      db.persistDiscoveryBatch('D:\\Photos', [
        {
          originalPath,
          fileName: 'stale.jpg',
          extension: 'jpg',
          byteSize: 500,
          birthtimeMs: null,
          mtimeMs: 1700000000000,
          discoveredAtMs: 1700000000000,
          category: 'photo'
        }
      ])

      // Attempting to record hash with mismatching size should fail
      expect(() => {
        db!.recordHashObservation({
          originalPath,
          sha256: 'a'.repeat(64),
          observedByteSize: 999, // Mismatch!
          observedMtimeMs: 1700000000000,
          hashedAtMs: Date.now()
        })
      }).toThrow(/mismatch/i)
    })
  })

  describe('Repeated Persistence and Idempotency', () => {
    it('does not create duplicate rows when persisting identical discovery candidates repeatedly', () => {
      db = CatalogDatabase.open({ catalogPath })
      const originalPath = 'D:\\Photos\\same.jpg'

      const candidate: DiscoveryCandidateInput = {
        originalPath,
        fileName: 'same.jpg',
        extension: 'jpg',
        byteSize: 1000,
        birthtimeMs: 1600000000000,
        mtimeMs: 1600000000000,
        discoveredAtMs: 1700000000000,
        category: 'photo'
      }

      const res1 = db.persistDiscoveryBatch('D:\\Photos', [candidate])
      expect(res1.insertedCount).toBe(1)
      expect(res1.unchangedCount).toBe(0)

      // Re-scan with identical facts at a later discovery timestamp
      const res2 = db.persistDiscoveryBatch('D:\\Photos', [
        { ...candidate, discoveredAtMs: 1700005000000 }
      ])
      expect(res2.insertedCount).toBe(0)
      expect(res2.unchangedCount).toBe(1)

      const files = db.queryFileLocations({ limit: 10 })
      expect(files.totalCount).toBe(1)
      expect(files.items[0]?.firstDiscoveredAtMs).toBe(1700000000000)
      expect(files.items[0]?.lastSeenAtMs).toBe(1700005000000)
    })
  })

  describe('Transactional Batch Rollback', () => {
    it('rolls back the entire batch transaction if any candidate causes a failure', () => {
      db = CatalogDatabase.open({ catalogPath })

      const valid1: DiscoveryCandidateInput = {
        originalPath: 'D:\\Photos\\valid1.jpg',
        fileName: 'valid1.jpg',
        extension: 'jpg',
        byteSize: 100,
        birthtimeMs: null,
        mtimeMs: null,
        discoveredAtMs: Date.now(),
        category: 'photo'
      }

      const invalid = {
        originalPath: 'D:\\Photos\\bad.jpg',
        fileName: 'bad.jpg',
        extension: 'jpg',
        byteSize: -50, // Invalid negative byte size violates check constraint
        birthtimeMs: null,
        mtimeMs: null,
        discoveredAtMs: Date.now(),
        category: 'photo' as const
      } as unknown as DiscoveryCandidateInput

      const valid2: DiscoveryCandidateInput = {
        originalPath: 'D:\\Photos\\valid2.jpg',
        fileName: 'valid2.jpg',
        extension: 'jpg',
        byteSize: 200,
        birthtimeMs: null,
        mtimeMs: null,
        discoveredAtMs: Date.now(),
        category: 'photo'
      }

      // Persisting batch containing invalid candidate must fail
      expect(() => {
        db!.persistDiscoveryBatch('D:\\Photos', [valid1, invalid, valid2])
      }).toThrow()

      // Transaction rollback: none of the candidates should exist
      const files = db.queryFileLocations()
      expect(files.totalCount).toBe(0)
    })
  })

  describe('Bounded and Paginated Reads', () => {
    it('supports bounded, paginated catalog queries with accurate totals', () => {
      db = CatalogDatabase.open({ catalogPath })

      const candidates: DiscoveryCandidateInput[] = Array.from({ length: 15 }, (_, i) => ({
        originalPath: `D:\\Photos\\img_${String(i).padStart(3, '0')}.jpg`,
        fileName: `img_${String(i).padStart(3, '0')}.jpg`,
        extension: 'jpg',
        byteSize: 1000 + i,
        birthtimeMs: null,
        mtimeMs: 1700000000000 + i,
        discoveredAtMs: 1700000000000,
        category: 'photo'
      }))

      db.persistDiscoveryBatch('D:\\Photos', candidates)

      // Page 1: 5 items
      const page1 = db.queryFileLocations({ offset: 0, limit: 5 })
      expect(page1.totalCount).toBe(15)
      expect(page1.items).toHaveLength(5)
      expect(page1.offset).toBe(0)
      expect(page1.limit).toBe(5)
      expect(page1.hasMore).toBe(true)
      expect(page1.items[0]?.fileName).toBe('img_000.jpg')

      // Page 2: 5 items
      const page2 = db.queryFileLocations({ offset: 5, limit: 5 })
      expect(page2.totalCount).toBe(15)
      expect(page2.items).toHaveLength(5)
      expect(page2.hasMore).toBe(true)
      expect(page2.items[0]?.fileName).toBe('img_005.jpg')

      // Page 3: 5 items (last page)
      const page3 = db.queryFileLocations({ offset: 10, limit: 5 })
      expect(page3.totalCount).toBe(15)
      expect(page3.items).toHaveLength(5)
      expect(page3.hasMore).toBe(false)
      expect(page3.items[4]?.fileName).toBe('img_014.jpg')
    })

    it('provides aggregate catalog statistics', () => {
      db = CatalogDatabase.open({ catalogPath })

      db.persistDiscoveryBatch('D:\\Photos', [
        {
          originalPath: 'D:\\Photos\\p1.jpg',
          fileName: 'p1.jpg',
          extension: 'jpg',
          byteSize: 1000,
          birthtimeMs: null,
          mtimeMs: null,
          discoveredAtMs: Date.now(),
          category: 'photo'
        }
      ])

      db.persistDiscoveryBatch('D:\\Docs', [
        {
          originalPath: 'D:\\Docs\\d1.pdf',
          fileName: 'd1.pdf',
          extension: 'pdf',
          byteSize: 3000,
          birthtimeMs: null,
          mtimeMs: null,
          discoveredAtMs: Date.now(),
          category: 'document'
        }
      ])

      db.recordHashObservation({
        originalPath: 'D:\\Photos\\p1.jpg',
        sha256: 'a'.repeat(64),
        observedByteSize: 1000,
        observedMtimeMs: null,
        hashedAtMs: Date.now()
      })

      const stats = db.getCatalogStats()
      expect(stats.totalSources).toBe(2)
      expect(stats.totalFiles).toBe(2)
      expect(stats.totalPhotos).toBe(1)
      expect(stats.totalDocuments).toBe(1)
      expect(stats.totalBytes).toBe(4000)
      expect(stats.hashedFiles).toBe(1)
      expect(stats.unhashedFiles).toBe(1)
    })

    it('filters query results by sourceId, category, hasActiveHash, and sha256', () => {
      db = CatalogDatabase.open({ catalogPath })

      db.persistDiscoveryBatch('D:\\Photos', [
        {
          originalPath: 'D:\\Photos\\p1.jpg',
          fileName: 'p1.jpg',
          extension: 'jpg',
          byteSize: 1000,
          birthtimeMs: null,
          mtimeMs: null,
          discoveredAtMs: Date.now(),
          category: 'photo'
        },
        {
          originalPath: 'D:\\Photos\\p2.jpg',
          fileName: 'p2.jpg',
          extension: 'jpg',
          byteSize: 2000,
          birthtimeMs: null,
          mtimeMs: null,
          discoveredAtMs: Date.now(),
          category: 'photo'
        }
      ])

      db.persistDiscoveryBatch('D:\\Docs', [
        {
          originalPath: 'D:\\Docs\\d1.pdf',
          fileName: 'd1.pdf',
          extension: 'pdf',
          byteSize: 3000,
          birthtimeMs: null,
          mtimeMs: null,
          discoveredAtMs: Date.now(),
          category: 'document'
        }
      ])

      db.recordHashObservation({
        originalPath: 'D:\\Photos\\p1.jpg',
        sha256: 'a'.repeat(64),
        observedByteSize: 1000,
        observedMtimeMs: null,
        hashedAtMs: Date.now()
      })

      // Filter by category
      const photos = db.queryFileLocations({ category: 'photo' })
      expect(photos.totalCount).toBe(2)

      const docs = db.queryFileLocations({ category: 'document' })
      expect(docs.totalCount).toBe(1)
      expect(docs.items[0]?.fileName).toBe('d1.pdf')

      // Filter by hasActiveHash
      const hashed = db.queryFileLocations({ hasActiveHash: true })
      expect(hashed.totalCount).toBe(1)
      expect(hashed.items[0]?.fileName).toBe('p1.jpg')

      const unhashed = db.queryFileLocations({ hasActiveHash: false })
      expect(unhashed.totalCount).toBe(2)

      // Filter by sha256
      const byHash = db.queryFileLocations({ sha256: 'a'.repeat(64) })
      expect(byHash.totalCount).toBe(1)
      expect(byHash.items[0]?.fileName).toBe('p1.jpg')
    })
  })

  describe('Batch Hash Observations and Sub-Millisecond Tolerance', () => {
    it('records batch hash observations transactionally with rollback on failure', () => {
      db = CatalogDatabase.open({ catalogPath })

      db.persistDiscoveryBatch('D:\\Photos', [
        {
          originalPath: 'D:\\Photos\\b1.jpg',
          fileName: 'b1.jpg',
          extension: 'jpg',
          byteSize: 100,
          birthtimeMs: null,
          mtimeMs: 1000,
          discoveredAtMs: Date.now(),
          category: 'photo'
        },
        {
          originalPath: 'D:\\Photos\\b2.jpg',
          fileName: 'b2.jpg',
          extension: 'jpg',
          byteSize: 200,
          birthtimeMs: null,
          mtimeMs: 2000,
          discoveredAtMs: Date.now(),
          category: 'photo'
        }
      ])

      // Successful batch
      const results = db.recordHashObservationsBatch([
        {
          originalPath: 'D:\\Photos\\b1.jpg',
          sha256: '1'.repeat(64),
          observedByteSize: 100,
          observedMtimeMs: 1000,
          hashedAtMs: Date.now()
        },
        {
          originalPath: 'D:\\Photos\\b2.jpg',
          sha256: '2'.repeat(64),
          observedByteSize: 200,
          observedMtimeMs: 2000,
          hashedAtMs: Date.now()
        }
      ])
      expect(results).toHaveLength(2)

      // Failing batch with 1 mismatch: rolls back entire batch
      expect(() => {
        db!.recordHashObservationsBatch([
          {
            originalPath: 'D:\\Photos\\b1.jpg',
            sha256: '3'.repeat(64),
            observedByteSize: 100,
            observedMtimeMs: 1000,
            hashedAtMs: Date.now()
          },
          {
            originalPath: 'D:\\Photos\\b2.jpg',
            sha256: '4'.repeat(64),
            observedByteSize: 9999, // Mismatch!
            observedMtimeMs: 2000,
            hashedAtMs: Date.now()
          }
        ])
      }).toThrow(/mismatch/i)

      // Previous active hashes remain unchanged
      expect(db.getFileLocationByPath('D:\\Photos\\b1.jpg')?.activeHash).toBe('1'.repeat(64))
      expect(db.getFileLocationByPath('D:\\Photos\\b2.jpg')?.activeHash).toBe('2'.repeat(64))
    })

    it('tolerates sub-millisecond mtime differences (< 1.0 ms) and rejects shifts >= 1.0 ms', () => {
      db = CatalogDatabase.open({ catalogPath })

      db.persistDiscoveryBatch('D:\\Photos', [
        {
          originalPath: 'D:\\Photos\\subms.jpg',
          fileName: 'subms.jpg',
          extension: 'jpg',
          byteSize: 500,
          birthtimeMs: null,
          mtimeMs: 1700000000000,
          discoveredAtMs: Date.now(),
          category: 'photo'
        }
      ])

      // Accept sub-millisecond difference of 0.4 ms (< 1.0 ms)
      expect(() => {
        db!.recordHashObservation({
          originalPath: 'D:\\Photos\\subms.jpg',
          sha256: '5'.repeat(64),
          observedByteSize: 500,
          observedMtimeMs: 1700000000000.4,
          hashedAtMs: Date.now()
        })
      }).not.toThrow()

      expect(db.getFileLocationByPath('D:\\Photos\\subms.jpg')?.activeHash).toBe('5'.repeat(64))

      // Reject shift of 1.5 ms (>= 1.0 ms)
      expect(() => {
        db!.recordHashObservation({
          originalPath: 'D:\\Photos\\subms.jpg',
          sha256: '6'.repeat(64),
          observedByteSize: 500,
          observedMtimeMs: 1700000001500,
          hashedAtMs: Date.now()
        })
      }).toThrow(/mismatch/i)
    })
  })

  describe('Source Preservation & Read-Only Invariance', () => {
    it('catalog persistence never touches, modifies, or writes to source files', async () => {
      // Create real dummy source files on disk
      const sourceDir = join(testDir, 'real_source')
      await fs.mkdir(sourceDir, { recursive: true })
      const sourceFilePath = join(sourceDir, 'original.jpg')
      const originalBytes = Buffer.from('RAW_SOURCE_PHOTO_BYTES_XYZ_123')
      await fs.writeFile(sourceFilePath, originalBytes)

      const preStat = await fs.stat(sourceFilePath)

      db = CatalogDatabase.open({ catalogPath })
      db.persistDiscoveryBatch(sourceDir, [
        {
          originalPath: sourceFilePath,
          fileName: 'original.jpg',
          extension: 'jpg',
          byteSize: originalBytes.length,
          birthtimeMs: preStat.birthtimeMs,
          mtimeMs: preStat.mtimeMs,
          discoveredAtMs: Date.now(),
          category: 'photo'
        }
      ])

      db.recordHashObservation({
        originalPath: sourceFilePath,
        sha256: '7'.repeat(64),
        observedByteSize: originalBytes.length,
        observedMtimeMs: preStat.mtimeMs,
        hashedAtMs: Date.now()
      })

      // Query and verify catalog
      const record = db.getFileLocationByPath(sourceFilePath)
      expect(record?.activeHash).toBe('7'.repeat(64))

      // Verify the source file on disk is completely untouched
      const postStat = await fs.stat(sourceFilePath)
      const postBytes = await fs.readFile(sourceFilePath)

      expect(postBytes.equals(originalBytes)).toBe(true)
      expect(postStat.size).toBe(preStat.size)
      expect(postStat.mtimeMs).toBe(preStat.mtimeMs)
      expect(postStat.birthtimeMs).toBe(preStat.birthtimeMs)
    })
  })
})
