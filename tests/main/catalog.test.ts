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
  MigrationError,
  FileMetadataConflictError,
  CURRENT_SCHEMA_VERSION,
  isObservationTimestampMatching,
  normalizePathForLookup,
  isSameOrDescendantPath,
  getEffectiveRoots
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

    it('keeps isClosed() false if underlying db.close() throws', () => {
      db = CatalogDatabase.open({ catalogPath })
      const rawDb = db.getRawDatabaseForTesting()
      const originalClose = rawDb.close.bind(rawDb)
      rawDb.close = () => {
        throw new Error('Forced close failure')
      }

      expect(() => db!.close()).toThrow('Forced close failure')
      expect(db.isClosed()).toBe(false)

      // Restore and close properly
      rawDb.close = originalClose
      db.close()
      expect(db.isClosed()).toBe(true)
    })
  })

  describe('Schema Migrations and Reopening Durability', () => {
    it('records migrations up to current version', () => {
      db = CatalogDatabase.open({ catalogPath })
      const rawDb = new DatabaseSync(catalogPath)
      try {
        const migrations = rawDb
          .prepare(
            'SELECT version, name, applied_at_ms FROM schema_migrations ORDER BY version ASC'
          )
          .all() as Array<{ version: number; name: string; applied_at_ms: number }>

        expect(migrations.length).toBeGreaterThanOrEqual(1)
        expect(migrations[migrations.length - 1]?.version).toBe(CURRENT_SCHEMA_VERSION)
      } finally {
        rawDb.close()
      }
    })

    it('migrates original baa82e6 schema (v1 without discovery_observations) to v2 preserving all data and active hashes', () => {
      // 1. Manually construct a database matching the exact baa82e6 schema layout
      const rawDb = new DatabaseSync(catalogPath)
      try {
        rawDb.exec(`
          CREATE TABLE schema_migrations (
            version INTEGER PRIMARY KEY NOT NULL,
            name TEXT NOT NULL,
            applied_at_ms INTEGER NOT NULL
          );
          INSERT INTO schema_migrations (version, name, applied_at_ms)
          VALUES (1, 'initial_catalog_schema', 1700000000000);

          CREATE TABLE sources (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            root_path TEXT NOT NULL,
            normalized_root_path TEXT NOT NULL UNIQUE,
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL
          );

          CREATE TABLE file_locations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
            original_path TEXT NOT NULL,
            normalized_path TEXT NOT NULL UNIQUE,
            file_name TEXT NOT NULL,
            extension TEXT NOT NULL,
            category TEXT NOT NULL CHECK (category IN ('photo', 'document')),
            byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
            filesystem_birthtime_ms INTEGER,
            filesystem_mtime_ms INTEGER,
            inferred_capture_time_ms INTEGER,
            first_discovered_at_ms INTEGER NOT NULL,
            last_seen_at_ms INTEGER NOT NULL
          );

          CREATE TABLE hash_observations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_location_id INTEGER NOT NULL REFERENCES file_locations(id) ON DELETE CASCADE,
            sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
            observed_byte_size INTEGER NOT NULL CHECK (observed_byte_size >= 0),
            observed_mtime_ms INTEGER,
            hashed_at_ms INTEGER NOT NULL,
            is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
          );

          INSERT INTO sources (id, root_path, normalized_root_path, created_at_ms, updated_at_ms)
          VALUES (1, 'D:\\Photos', 'd:\\photos', 1700000000000, 1700000000000);

          INSERT INTO file_locations (
            id, source_id, original_path, normalized_path, file_name, extension, category,
            byte_size, filesystem_birthtime_ms, filesystem_mtime_ms, inferred_capture_time_ms,
            first_discovered_at_ms, last_seen_at_ms
          ) VALUES (
            1, 1, 'D:\\Photos\\lake.jpg', 'd:\\photos\\lake.jpg', 'lake.jpg', 'jpg', 'photo',
            5000, 1690000000000, 1690000500000, NULL, 1700000010000, 1700000020000
          );

          INSERT INTO hash_observations (
            id, file_location_id, sha256, observed_byte_size, observed_mtime_ms, hashed_at_ms, is_active
          ) VALUES (
            1, 1, '${'f'.repeat(64)}', 5000, 1690000500000, 1700000030000, 1
          );
        `)
      } finally {
        rawDb.close()
      }

      // 2. Open catalog using CatalogDatabase: must run migration to v2 cleanly
      db = CatalogDatabase.open({ catalogPath })

      // 3. Verify migration table has version 2
      const checkDb = new DatabaseSync(catalogPath)
      try {
        const row = checkDb
          .prepare('SELECT MAX(version) as max_version FROM schema_migrations')
          .get() as { max_version: number }
        expect(row.max_version).toBe(CURRENT_SCHEMA_VERSION)
      } finally {
        checkDb.close()
      }

      // 4. Verify queryFileLocations returns the file with preserved facts and active hash
      const files = db.queryFileLocations()
      expect(files.items).toHaveLength(1)
      const file = files.items[0]!
      expect(file.originalPath).toBe('D:\\Photos\\lake.jpg')
      expect(file.byteSize).toBe(5000)
      expect(file.filesystemBirthtimeMs).toBe(1690000000000)
      expect(file.filesystemMtimeMs).toBe(1690000500000)
      expect(file.activeHash).toBe('f'.repeat(64))

      // 5. Verify discovery observation was created and linked to the active hash
      const discHistory = db.getDiscoveryObservationsForFile(file.id)
      expect(discHistory.items).toHaveLength(1)
      expect(discHistory.items[0]?.isCurrent).toBe(true)
      expect(discHistory.items[0]?.byteSize).toBe(5000)

      const hashHistory = db.getHashObservationsForFile(file.id)
      expect(hashHistory.items).toHaveLength(1)
      expect(hashHistory.items[0]?.isActive).toBe(true)
      expect(hashHistory.items[0]?.discoveryObservationId).toBe(discHistory.items[0]!.id)

      // 6. Verify durability across reopen
      db.close()
      db = CatalogDatabase.open({ catalogPath })
      const reopened = db.getFileLocationByPath('D:\\Photos\\lake.jpg')
      expect(reopened?.activeHash).toBe('f'.repeat(64))
    })

    it('migrates revised 25a1b4f schema (v1 with discovery_observations) to v2 idempotently', () => {
      // 1. Manually construct a database matching the 25a1b4f layout
      const rawDb = new DatabaseSync(catalogPath)
      try {
        rawDb.exec(`
          CREATE TABLE schema_migrations (
            version INTEGER PRIMARY KEY NOT NULL,
            name TEXT NOT NULL,
            applied_at_ms INTEGER NOT NULL
          );
          INSERT INTO schema_migrations (version, name, applied_at_ms)
          VALUES (1, 'initial_catalog_schema', 1700000000000);

          CREATE TABLE sources (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            root_path TEXT NOT NULL,
            normalized_root_path TEXT NOT NULL UNIQUE,
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL
          );

          CREATE TABLE file_locations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
            original_path TEXT NOT NULL UNIQUE,
            normalized_path TEXT NOT NULL,
            file_name TEXT NOT NULL,
            extension TEXT NOT NULL,
            category TEXT NOT NULL CHECK (category IN ('photo', 'document')),
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL
          );

          CREATE TABLE discovery_observations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_location_id INTEGER NOT NULL REFERENCES file_locations(id) ON DELETE CASCADE,
            byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
            filesystem_birthtime_ms INTEGER,
            filesystem_mtime_ms INTEGER,
            inferred_capture_time_ms INTEGER,
            observed_at_ms INTEGER NOT NULL,
            last_seen_at_ms INTEGER NOT NULL,
            is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1))
          );
          CREATE UNIQUE INDEX idx_disc_obs_current ON discovery_observations(file_location_id) WHERE is_current = 1;

          CREATE TABLE hash_observations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_location_id INTEGER NOT NULL REFERENCES file_locations(id) ON DELETE CASCADE,
            discovery_observation_id INTEGER NOT NULL REFERENCES discovery_observations(id) ON DELETE CASCADE,
            sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
            observed_byte_size INTEGER NOT NULL CHECK (observed_byte_size >= 0),
            observed_mtime_ms INTEGER,
            hashed_at_ms INTEGER NOT NULL,
            is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
          );
          CREATE UNIQUE INDEX idx_hash_obs_current ON hash_observations(discovery_observation_id) WHERE is_active = 1;

          INSERT INTO sources (id, root_path, normalized_root_path, created_at_ms, updated_at_ms)
          VALUES (1, 'D:\\Docs', 'd:\\docs', 1700000000000, 1700000000000);

          INSERT INTO file_locations (
            id, source_id, original_path, normalized_path, file_name, extension, category,
            created_at_ms, updated_at_ms
          ) VALUES (
            1, 1, 'D:\\Docs\\manual.pdf', 'd:\\docs\\manual.pdf', 'manual.pdf', 'pdf', 'document',
            1700000010000, 1700000020000
          );

          INSERT INTO discovery_observations (
            id, file_location_id, byte_size, filesystem_birthtime_ms, filesystem_mtime_ms,
            inferred_capture_time_ms, observed_at_ms, last_seen_at_ms, is_current
          ) VALUES (
            1, 1, 1234, 1690000000000, 1690000100000, NULL, 1700000010000, 1700000020000, 1
          );

          INSERT INTO hash_observations (
            id, file_location_id, discovery_observation_id, sha256,
            observed_byte_size, observed_mtime_ms, hashed_at_ms, is_active
          ) VALUES (
            1, 1, 1, '${'e'.repeat(64)}', 1234, 1690000100000, 1700000030000, 1
          );
        `)
      } finally {
        rawDb.close()
      }

      // 2. Open catalog
      db = CatalogDatabase.open({ catalogPath })

      // 3. Verify max version is 2
      const checkDb = new DatabaseSync(catalogPath)
      try {
        const row = checkDb
          .prepare('SELECT MAX(version) as max_version FROM schema_migrations')
          .get() as { max_version: number }
        expect(row.max_version).toBe(CURRENT_SCHEMA_VERSION)
      } finally {
        checkDb.close()
      }

      const files = db.queryFileLocations()
      expect(files.items).toHaveLength(1)
      expect(files.items[0]?.activeHash).toBe('e'.repeat(64))
    })

    it('rejects corrupted or unrecognized version 1 schema layout with MigrationError', () => {
      const rawDb = new DatabaseSync(catalogPath)
      try {
        rawDb.exec(`
          CREATE TABLE schema_migrations (
            version INTEGER PRIMARY KEY NOT NULL,
            name TEXT NOT NULL,
            applied_at_ms INTEGER NOT NULL
          );
          INSERT INTO schema_migrations (version, name, applied_at_ms)
          VALUES (1, 'initial_catalog_schema', 1700000000000);

          -- Unexpected layout: corrupt table with completely wrong columns
          CREATE TABLE file_locations (
            id INTEGER PRIMARY KEY,
            random_column TEXT
          );
        `)
      } finally {
        rawDb.close()
      }

      expect(() => CatalogDatabase.open({ catalogPath })).toThrow(MigrationError)
    })

    it('safely reopens an existing catalog without re-running migrations or losing data', () => {
      db = CatalogDatabase.open({ catalogPath })
      const source = db.registerSource('D:\\Photos')
      expect(source.id).toBeGreaterThan(0)
      db.close()

      // Reopen
      db = CatalogDatabase.open({ catalogPath })
      const sources = db.listSources()
      expect(sources.items).toHaveLength(1)
      expect(sources.items[0]?.rootPath).toBe('D:\\Photos')
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
                created_at_ms, updated_at_ms
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              99999,
              'D:\\Photos\\missing.jpg',
              'd:\\photos\\missing.jpg',
              'missing.jpg',
              'jpg',
              'photo',
              Date.now(),
              Date.now()
            )
        }).toThrow(/FOREIGN KEY/i)

        // Attempting to insert a hash observation referencing a non-existent file_location_id must fail
        expect(() => {
          rawDb
            .prepare(
              `INSERT INTO hash_observations (
                file_location_id, discovery_observation_id, sha256, observed_byte_size, observed_mtime_ms, hashed_at_ms, is_active
              ) VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              99999,
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

    it('correctly evaluates path containment across Windows and POSIX path formats', () => {
      // Windows drive root
      expect(isSameOrDescendantPath('C:\\', 'C:\\Photos\\image.jpg', 'win32')).toBe(true)
      expect(isSameOrDescendantPath('C:/', 'c:\\photos', 'win32')).toBe(true)
      expect(isSameOrDescendantPath('C:\\', 'D:\\Photos', 'win32')).toBe(false)

      // Windows directory with and without trailing slash
      expect(isSameOrDescendantPath('C:\\Photos', 'C:\\Photos\\2026\\pic.jpg', 'win32')).toBe(true)
      expect(isSameOrDescendantPath('C:/Photos/', 'C:\\Photos\\2026', 'win32')).toBe(true)
      expect(isSameOrDescendantPath('c:\\photos', 'C:/Photos', 'win32')).toBe(true) // exact same

      // Windows sibling-prefix protection (crucial boundary check)
      expect(isSameOrDescendantPath('C:\\Photos', 'C:\\Photos_Backup', 'win32')).toBe(false)
      expect(isSameOrDescendantPath('C:\\Photos', 'C:\\Photos-2026', 'win32')).toBe(false)

      // Windows UNC root
      expect(isSameOrDescendantPath('\\\\server\\share', '\\\\server\\share\\child', 'win32')).toBe(
        true
      )
      expect(
        isSameOrDescendantPath('\\\\server\\share\\', '\\\\server\\share\\child', 'win32')
      ).toBe(true)
      expect(
        isSameOrDescendantPath('\\\\server\\share', '\\\\server\\share2\\child', 'win32')
      ).toBe(false)

      // POSIX root and subdirectories
      expect(isSameOrDescendantPath('/', '/photos/image.jpg', 'linux')).toBe(true)
      expect(isSameOrDescendantPath('/photos', '/photos/sub/pic.jpg', 'linux')).toBe(true)
      expect(isSameOrDescendantPath('/photos/', '/photos/sub', 'linux')).toBe(true)
      expect(isSameOrDescendantPath('/photos', '/photos_other', 'linux')).toBe(false)
    })

    it('getEffectiveRoots prunes overlapping and duplicate roots across platforms', () => {
      // Windows: parent + child in either order
      const winRoots1 = getEffectiveRoots(['C:\\photos', 'C:\\photos\\child'], 'win32')
      expect(winRoots1).toEqual(['C:\\photos'])

      const winRoots2 = getEffectiveRoots(['C:\\photos\\child', 'C:\\photos'], 'win32')
      expect(winRoots2).toEqual(['C:\\photos'])

      // Windows: case-insensitive duplicates and trailing slashes
      const winDupes = getEffectiveRoots(['C:\\photos', 'c:/photos/', 'C:\\Photos\\'], 'win32')
      expect(winDupes).toEqual(['C:\\photos'])

      // Windows: sibling directories preserved
      const winSiblings = getEffectiveRoots(['C:\\photos', 'C:\\photos_backup'], 'win32')
      expect(winSiblings).toEqual(['C:\\photos', 'C:\\photos_backup'])

      // Windows: multiple drives preserved
      const winDrives = getEffectiveRoots(['C:\\photos', 'D:\\photos'], 'win32')
      expect(winDrives).toEqual(['C:\\photos', 'D:\\photos'])

      // POSIX: root / prunes all subdirectories
      const posixRoot = getEffectiveRoots(['/', '/var/log', '/home/user'], 'linux')
      expect(posixRoot).toEqual(['/'])

      // POSIX: overlapping subdirectories
      const posixSub = getEffectiveRoots(['/home/user/photos', '/home/user'], 'linux')
      expect(posixSub).toEqual(['/home/user'])

      // POSIX: siblings preserved
      const posixSib = getEffectiveRoots(['/photos', '/photos_backup'], 'linux')
      expect(posixSib).toEqual(['/photos', '/photos_backup'])
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
      expect(history.items).toHaveLength(1)
      expect(history.items[0]?.sha256).toBe(oldHash)
      expect(history.items[0]?.isActive).toBe(false)

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
      expect(historyAfterRehash.items).toHaveLength(2)
      expect(historyAfterRehash.items.find((h) => h.sha256 === oldHash)?.isActive).toBe(false)
      expect(historyAfterRehash.items.find((h) => h.sha256 === newHash)?.isActive).toBe(true)
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

    it('enforces Stage 2B precision contract for timestamp comparison', () => {
      // Direct unit tests for isObservationTimestampMatching
      expect(isObservationTimestampMatching(1000.1, 1000.8)).toBe(false)
      expect(isObservationTimestampMatching(1000.1, 1000.1)).toBe(true)
      expect(isObservationTimestampMatching(1000.4, 1000)).toBe(true)
      expect(isObservationTimestampMatching(1001.0, 1000)).toBe(false)
      expect(isObservationTimestampMatching(null, 1000)).toBe(false)
      expect(isObservationTimestampMatching(1000, null)).toBe(false)
      expect(isObservationTimestampMatching(null, null)).toBe(true)

      // Integration test with CatalogDatabase:
      db = CatalogDatabase.open({ catalogPath })
      const originalPath = 'D:\\Photos\\fractional.jpg'

      // Discovery recorded fractional mtime 1000.1
      db.persistDiscoveryBatch('D:\\Photos', [
        {
          originalPath,
          fileName: 'fractional.jpg',
          extension: 'jpg',
          byteSize: 500,
          birthtimeMs: null,
          mtimeMs: 1000.1,
          discoveredAtMs: 2000,
          category: 'photo'
        }
      ])

      // Attempt to record hash observation with differing fractional mtime 1000.8 must fail!
      expect(() => {
        db!.recordHashObservation({
          originalPath,
          sha256: 'b'.repeat(64),
          observedByteSize: 500,
          observedMtimeMs: 1000.8,
          hashedAtMs: 2500
        })
      }).toThrow(/mtime mismatch/i)

      // Record hash observation with exact fractional mtime 1000.1 must succeed!
      expect(() => {
        db!.recordHashObservation({
          originalPath,
          sha256: 'c'.repeat(64),
          observedByteSize: 500,
          observedMtimeMs: 1000.1,
          hashedAtMs: 2600
        })
      }).not.toThrow()

      expect(db.getFileLocationByPath(originalPath)?.activeHash).toBe('c'.repeat(64))
    })

    it('detects creation timestamp changes (birthtimeMs) and preserves both observations in history', () => {
      db = CatalogDatabase.open({ catalogPath })
      const originalPath = 'D:\\Photos\\birthtime.jpg'
      const hash = 'a'.repeat(64)

      // Initial discovery with birthtimeMs: 10, mtime: 100, size: 50
      db.persistDiscoveryBatch('D:\\Photos', [
        {
          originalPath,
          fileName: 'birthtime.jpg',
          extension: 'jpg',
          byteSize: 50,
          birthtimeMs: 10,
          mtimeMs: 100,
          discoveredAtMs: 1000,
          category: 'photo'
        }
      ])

      db.recordHashObservation({
        originalPath,
        sha256: hash,
        observedByteSize: 50,
        observedMtimeMs: 100,
        hashedAtMs: 1050
      })

      const initialFile = db.getFileLocationByPath(originalPath)
      expect(initialFile?.activeHash).toBe(hash)
      expect(initialFile?.filesystemBirthtimeMs).toBe(10)

      // Subsequent discovery: birthtime changed from 10 to 20, size and mtime unchanged!
      const updateRes = db.persistDiscoveryBatch('D:\\Photos', [
        {
          originalPath,
          fileName: 'birthtime.jpg',
          extension: 'jpg',
          byteSize: 50,
          birthtimeMs: 20, // Changed!
          mtimeMs: 100,
          discoveredAtMs: 2000,
          category: 'photo'
        }
      ])

      expect(updateRes.updatedCount).toBe(1)
      expect(updateRes.invalidatedHashCount).toBe(1)

      const updatedFile = db.getFileLocationByPath(originalPath)
      expect(updatedFile?.filesystemBirthtimeMs).toBe(20)
      expect(updatedFile?.activeHash).toBeNull() // active hash invalidated!

      // Verify both observations are preserved in history
      const history = db.getDiscoveryObservationsForFile(updatedFile!.id)
      expect(history.totalCount).toBe(2)
      expect(history.items[0]?.filesystemBirthtimeMs).toBe(20)
      expect(history.items[0]?.isCurrent).toBe(true)
      expect(history.items[1]?.filesystemBirthtimeMs).toBe(10)
      expect(history.items[1]?.isCurrent).toBe(false)
    })

    it('detects birthtimeMs transitions between null and known values', () => {
      db = CatalogDatabase.open({ catalogPath })
      const originalPath = 'D:\\Photos\\birthtime-null.jpg'

      // Initial discovery with birthtimeMs: null
      db.persistDiscoveryBatch('D:\\Photos', [
        {
          originalPath,
          fileName: 'birthtime-null.jpg',
          extension: 'jpg',
          byteSize: 50,
          birthtimeMs: null,
          mtimeMs: 100,
          discoveredAtMs: 1000,
          category: 'photo'
        }
      ])

      // Transition from null to 50
      const toValueRes = db.persistDiscoveryBatch('D:\\Photos', [
        {
          originalPath,
          fileName: 'birthtime-null.jpg',
          extension: 'jpg',
          byteSize: 50,
          birthtimeMs: 50,
          mtimeMs: 100,
          discoveredAtMs: 2000,
          category: 'photo'
        }
      ])
      expect(toValueRes.updatedCount).toBe(1)

      // Transition from 50 back to null
      const toNullRes = db.persistDiscoveryBatch('D:\\Photos', [
        {
          originalPath,
          fileName: 'birthtime-null.jpg',
          extension: 'jpg',
          byteSize: 50,
          birthtimeMs: null,
          mtimeMs: 100,
          discoveredAtMs: 3000,
          category: 'photo'
        }
      ])
      expect(toNullRes.updatedCount).toBe(1)

      // Idempotent retry: same facts again with birthtimeMs: null
      const retryRes = db.persistDiscoveryBatch('D:\\Photos', [
        {
          originalPath,
          fileName: 'birthtime-null.jpg',
          extension: 'jpg',
          byteSize: 50,
          birthtimeMs: null,
          mtimeMs: 100,
          discoveredAtMs: 4000,
          category: 'photo'
        }
      ])
      expect(retryRes.unchangedCount).toBe(1)
      expect(retryRes.updatedCount).toBe(0)

      const file = db.getFileLocationByPath(originalPath)!
      const history = db.getDiscoveryObservationsForFile(file.id)
      expect(history.totalCount).toBe(3)
    })

    it('validates discovery candidate inputs strictly', () => {
      db = CatalogDatabase.open({ catalogPath })

      // Negative size
      expect(() => {
        db!.persistDiscoveryBatch('D:\\Photos', [
          {
            originalPath: 'D:\\Photos\\bad1.jpg',
            fileName: 'bad1.jpg',
            extension: 'jpg',
            byteSize: -1,
            birthtimeMs: null,
            mtimeMs: 1000,
            discoveredAtMs: 1000,
            category: 'photo'
          }
        ])
      }).toThrow(RangeError)

      // Non-finite mtime
      expect(() => {
        db!.persistDiscoveryBatch('D:\\Photos', [
          {
            originalPath: 'D:\\Photos\\bad2.jpg',
            fileName: 'bad2.jpg',
            extension: 'jpg',
            byteSize: 100,
            birthtimeMs: null,
            mtimeMs: NaN,
            discoveredAtMs: 1000,
            category: 'photo'
          }
        ])
      }).toThrow(RangeError)

      // Non-finite birthtime
      expect(() => {
        db!.persistDiscoveryBatch('D:\\Photos', [
          {
            originalPath: 'D:\\Photos\\bad3.jpg',
            fileName: 'bad3.jpg',
            extension: 'jpg',
            byteSize: 100,
            birthtimeMs: Infinity,
            mtimeMs: 1000,
            discoveredAtMs: 1000,
            category: 'photo'
          }
        ])
      }).toThrow(RangeError)
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

  describe('Stage 2C Corrections and Regression Suite', () => {
    it('rolls back previously unregistered source registration when batch persistence fails', () => {
      db = CatalogDatabase.open({ catalogPath })
      const newSourceRoot = 'D:\\UnregisteredSource'

      expect(db.getSourceByPath(newSourceRoot)).toBeNull()

      const valid: DiscoveryCandidateInput = {
        originalPath: 'D:\\UnregisteredSource\\valid.jpg',
        fileName: 'valid.jpg',
        extension: 'jpg',
        byteSize: 100,
        birthtimeMs: null,
        mtimeMs: 1000,
        discoveredAtMs: Date.now(),
        category: 'photo'
      }
      const invalid = {
        originalPath: 'D:\\UnregisteredSource\\bad.jpg',
        fileName: 'bad.jpg',
        extension: 'jpg',
        byteSize: -1, // Constraint violation
        birthtimeMs: null,
        mtimeMs: 1000,
        discoveredAtMs: Date.now(),
        category: 'photo' as const
      } as unknown as DiscoveryCandidateInput

      expect(() => {
        db!.persistDiscoveryBatch(newSourceRoot, [valid, invalid])
      }).toThrow()

      // Full rollback must include the source root registration!
      expect(db.getSourceByPath(newSourceRoot)).toBeNull()
    })

    it('rejects oversized discovery and hash batches before database mutation', () => {
      db = CatalogDatabase.open({ catalogPath })
      const oversizedDiscovery: DiscoveryCandidateInput[] = Array.from(
        { length: 1001 },
        (_, i) => ({
          originalPath: `D:\\Photos\\f_${i}.jpg`,
          fileName: `f_${i}.jpg`,
          extension: 'jpg',
          byteSize: 10,
          birthtimeMs: null,
          mtimeMs: 1000,
          discoveredAtMs: Date.now(),
          category: 'photo'
        })
      )

      expect(() => {
        db!.persistDiscoveryBatch('D:\\Photos', oversizedDiscovery)
      }).toThrow(RangeError)

      const oversizedHash = Array.from({ length: 1001 }, (_, i) => ({
        originalPath: `D:\\Photos\\f_${i}.jpg`,
        sha256: 'a'.repeat(64),
        observedByteSize: 10,
        observedMtimeMs: 1000,
        hashedAtMs: Date.now()
      }))

      expect(() => {
        db!.recordHashObservationsBatch(oversizedHash)
      }).toThrow(RangeError)
    })

    it('validates pagination parameters as finite safe integers', () => {
      db = CatalogDatabase.open({ catalogPath })

      expect(() => db!.queryFileLocations({ offset: -1 })).toThrow(RangeError)
      expect(() => db!.queryFileLocations({ limit: 0 })).toThrow(RangeError)
      expect(() => db!.queryFileLocations({ limit: 1001 })).toThrow(RangeError)
      expect(() => db!.queryFileLocations({ offset: 1.5 })).toThrow(RangeError)
      expect(() => db!.queryFileLocations({ limit: NaN })).toThrow(RangeError)

      expect(() => db!.listSources({ offset: -5 })).toThrow(RangeError)
      expect(() => db!.listSources({ limit: 0 })).toThrow(RangeError)
    })

    it('rejects unsupported future schema in read-only mode and preserves DELETE journal mode without mutation', () => {
      // Create raw DB with journal_mode = DELETE and future schema version 999
      const rawDb = new DatabaseSync(catalogPath)
      try {
        rawDb.exec('PRAGMA journal_mode = DELETE;')
        rawDb.exec(
          'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at_ms INTEGER);'
        )
        rawDb.exec(
          "INSERT INTO schema_migrations (version, name, applied_at_ms) VALUES (999, 'future_schema', 123456);"
        )
        rawDb.exec('CREATE TABLE custom_future_table (id INTEGER PRIMARY KEY, data TEXT);')
        rawDb.exec("INSERT INTO custom_future_table (data) VALUES ('sensitive_data');")
      } finally {
        rawDb.close()
      }

      // Read-only open must reject unsupported future schema
      expect(() => CatalogDatabase.open({ catalogPath, readOnly: true })).toThrow(
        UnsupportedSchemaVersionError
      )

      // Read-write open must also reject unsupported future schema
      expect(() => CatalogDatabase.open({ catalogPath })).toThrow(UnsupportedSchemaVersionError)

      // Verify journal mode and data were NOT mutated (remains DELETE mode, not converted to WAL)
      const verifyDb = new DatabaseSync(catalogPath)
      try {
        const journalMode = verifyDb.prepare('PRAGMA journal_mode;').get() as {
          journal_mode: string
        }
        expect(journalMode.journal_mode.toLowerCase()).toBe('delete')
        const row = verifyDb
          .prepare('SELECT data FROM custom_future_table WHERE id = 1;')
          .get() as { data: string }
        expect(row.data).toBe('sensitive_data')
      } finally {
        verifyDb.close()
      }
    })

    it('preserves immutable discovery history when file changes without overwriting prior facts', () => {
      db = CatalogDatabase.open({ catalogPath })
      const originalPath = 'D:\\Photos\\evolving.jpg'

      // Discovery 1: size 1000, mtime 1000
      db.persistDiscoveryBatch('D:\\Photos', [
        {
          originalPath,
          fileName: 'evolving.jpg',
          extension: 'jpg',
          byteSize: 1000,
          birthtimeMs: 500,
          mtimeMs: 1000,
          discoveredAtMs: 10000,
          category: 'photo'
        }
      ])

      const hash1 = '1'.repeat(64)
      db.recordHashObservation({
        originalPath,
        sha256: hash1,
        observedByteSize: 1000,
        observedMtimeMs: 1000,
        hashedAtMs: 11000
      })

      const file1 = db.getFileLocationByPath(originalPath)!
      expect(file1.byteSize).toBe(1000)
      expect(file1.activeHash).toBe(hash1)

      // Discovery 2: file modified! size 2000, mtime 2000
      db.persistDiscoveryBatch('D:\\Photos', [
        {
          originalPath,
          fileName: 'evolving.jpg',
          extension: 'jpg',
          byteSize: 2000,
          birthtimeMs: 500,
          mtimeMs: 2000,
          discoveredAtMs: 20000,
          category: 'photo'
        }
      ])

      const file2 = db.getFileLocationByPath(originalPath)!
      expect(file2.byteSize).toBe(2000)
      expect(file2.filesystemMtimeMs).toBe(2000)
      expect(file2.activeHash).toBeNull() // Old hash is NOT inherited!

      // Check discovery history: both observations are preserved!
      const history = db.getDiscoveryObservationsForFile(file2.id)
      expect(history.totalCount).toBe(2)
      expect(history.items[0]?.byteSize).toBe(2000) // current
      expect(history.items[0]?.isCurrent).toBe(true)
      expect(history.items[1]?.byteSize).toBe(1000) // prior facts preserved!
      expect(history.items[1]?.isCurrent).toBe(false)
      expect(history.items[1]?.filesystemMtimeMs).toBe(1000)

      // Hash history: hash 1 is tied to discovery observation 1
      const hashHistory = db.getHashObservationsForFile(file2.id)
      expect(hashHistory.totalCount).toBe(1)
      expect(hashHistory.items[0]?.sha256).toBe(hash1)
      expect(hashHistory.items[0]?.isActive).toBe(false)
    })

    it('enforces strict SHA-256 hex format, conservative null mtime matching, and numeric validation', () => {
      db = CatalogDatabase.open({ catalogPath })
      const originalPath = 'D:\\Photos\\val.jpg'

      db.persistDiscoveryBatch('D:\\Photos', [
        {
          originalPath,
          fileName: 'val.jpg',
          extension: 'jpg',
          byteSize: 500,
          birthtimeMs: null,
          mtimeMs: null, // Discovery recorded NULL
          discoveredAtMs: Date.now(),
          category: 'photo'
        }
      ])

      // Reject non-hex characters in SHA-256
      expect(() =>
        db!.recordHashObservation({
          originalPath,
          sha256: 'z'.repeat(64),
          observedByteSize: 500,
          observedMtimeMs: null,
          hashedAtMs: Date.now()
        })
      ).toThrow(/hex/i)

      // Reject wrong length
      expect(() =>
        db!.recordHashObservation({
          originalPath,
          sha256: 'a'.repeat(63),
          observedByteSize: 500,
          observedMtimeMs: null,
          hashedAtMs: Date.now()
        })
      ).toThrow()

      // Conservative null timestamp matching:
      // Discovery recorded mtime is null, but observation supplies a number -> REJECT!
      expect(() =>
        db!.recordHashObservation({
          originalPath,
          sha256: 'a'.repeat(64),
          observedByteSize: 500,
          observedMtimeMs: 1000,
          hashedAtMs: Date.now()
        })
      ).toThrow(/mtime mismatch/i)

      // Discovery recorded null, observation supplies null -> ACCEPT!
      expect(() =>
        db!.recordHashObservation({
          originalPath,
          sha256: 'a'.repeat(64),
          observedByteSize: 500,
          observedMtimeMs: null,
          hashedAtMs: Date.now()
        })
      ).not.toThrow()
    })

    it('preserves backslashes as valid filename characters on POSIX', () => {
      const posixPath = '/photos/vacation/my\\file.jpg'
      const normalized = normalizePathForLookup(posixPath, 'linux')
      expect(normalized).toBe(posixPath)
    })

    it('does not silently discard differing recorded facts when normalized keys collide on Windows', () => {
      db = CatalogDatabase.open({ catalogPath })

      const file1: DiscoveryCandidateInput = {
        originalPath: 'D:\\Folder\\case.jpg',
        fileName: 'case.jpg',
        extension: 'jpg',
        byteSize: 100,
        birthtimeMs: null,
        mtimeMs: 1000,
        discoveredAtMs: 10000,
        category: 'photo'
      }

      const file2: DiscoveryCandidateInput = {
        originalPath: 'D:\\Folder\\CASE.jpg',
        fileName: 'CASE.jpg',
        extension: 'jpg',
        byteSize: 200,
        birthtimeMs: null,
        mtimeMs: 2000,
        discoveredAtMs: 10000,
        category: 'photo'
      }

      // Persist both distinct files (such as from a case-sensitive NTFS directory or cross-platform drive)
      db.persistDiscoveryBatch('D:\\Folder', [file1, file2])

      const rec1 = db.getFileLocationByPath('D:\\Folder\\case.jpg')
      const rec2 = db.getFileLocationByPath('D:\\Folder\\CASE.jpg')

      expect(rec1).not.toBeNull()
      expect(rec2).not.toBeNull()
      expect(rec1?.byteSize).toBe(100)
      expect(rec2?.byteSize).toBe(200)
      expect(rec1?.fileName).toBe('case.jpg')
      expect(rec2?.fileName).toBe('CASE.jpg')
    })
  })

  describe('Immutable Recorded Metadata & Conflict Policy', () => {
    it('rejects conflicting fileName when size and timestamps are unchanged', () => {
      db = CatalogDatabase.open({ catalogPath })
      const originalPath = 'D:\\Photos\\lake.jpg'

      // Initial discovery
      db.persistDiscoveryBatch('D:\\Photos', [
        {
          originalPath,
          fileName: 'lake.jpg',
          extension: 'jpg',
          byteSize: 1000,
          birthtimeMs: 500,
          mtimeMs: 1000,
          discoveredAtMs: 10000,
          category: 'photo'
        }
      ])

      // Candidate with conflicting fileName, but unchanged size/timestamps
      expect(() => {
        db!.persistDiscoveryBatch('D:\\Photos', [
          {
            originalPath,
            fileName: 'pond.jpg', // Conflicting fileName
            extension: 'jpg',
            byteSize: 1000,
            birthtimeMs: 500,
            mtimeMs: 1000,
            discoveredAtMs: 20000,
            category: 'photo'
          }
        ])
      }).toThrow(FileMetadataConflictError)

      // Verify original facts are preserved in database
      const file = db.getFileLocationByPath(originalPath)!
      expect(file.fileName).toBe('lake.jpg')
    })

    it('rejects conflicting fileName when combined with changed size or timestamps without invalidating active hash', () => {
      db = CatalogDatabase.open({ catalogPath })
      const originalPath = 'D:\\Photos\\lake.jpg'
      const hash = 'a'.repeat(64)

      // Initial discovery & hash
      db.persistDiscoveryBatch('D:\\Photos', [
        {
          originalPath,
          fileName: 'lake.jpg',
          extension: 'jpg',
          byteSize: 1000,
          birthtimeMs: 500,
          mtimeMs: 1000,
          discoveredAtMs: 10000,
          category: 'photo'
        }
      ])

      db.recordHashObservation({
        originalPath,
        sha256: hash,
        observedByteSize: 1000,
        observedMtimeMs: 1000,
        hashedAtMs: 11000
      })

      expect(db.getFileLocationByPath(originalPath)?.activeHash).toBe(hash)

      // Candidate with conflicting fileName AND changed content (size 2000, mtime 2000)
      expect(() => {
        db!.persistDiscoveryBatch('D:\\Photos', [
          {
            originalPath,
            fileName: 'different.jpg', // Conflicting fileName
            extension: 'jpg',
            byteSize: 2000, // Changed size
            birthtimeMs: 500,
            mtimeMs: 2000, // Changed mtime
            discoveredAtMs: 20000,
            category: 'photo'
          }
        ])
      }).toThrow(FileMetadataConflictError)

      // Verify database state is untouched: active hash is NOT invalidated, observations are not added
      const file = db.getFileLocationByPath(originalPath)!
      expect(file.fileName).toBe('lake.jpg')
      expect(file.byteSize).toBe(1000)
      expect(file.activeHash).toBe(hash)

      const history = db.getDiscoveryObservationsForFile(file.id)
      expect(history.totalCount).toBe(1)
    })

    it('rejects conflicting extension or category for both unchanged and changed content facts', () => {
      db = CatalogDatabase.open({ catalogPath })
      const docPath = 'D:\\Docs\\notes.txt'
      const photoPath = 'D:\\Photos\\sunset.png'

      db.persistDiscoveryBatch('D:\\Docs', [
        {
          originalPath: docPath,
          fileName: 'notes.txt',
          extension: 'txt',
          byteSize: 300,
          birthtimeMs: null,
          mtimeMs: 1000,
          discoveredAtMs: 10000,
          category: 'document'
        }
      ])

      db.persistDiscoveryBatch('D:\\Photos', [
        {
          originalPath: photoPath,
          fileName: 'sunset.png',
          extension: 'png',
          byteSize: 500,
          birthtimeMs: null,
          mtimeMs: 1000,
          discoveredAtMs: 10000,
          category: 'photo'
        }
      ])

      // 1. Conflicting extension with unchanged content facts
      expect(() => {
        db!.persistDiscoveryBatch('D:\\Docs', [
          {
            originalPath: docPath,
            fileName: 'notes.txt',
            extension: 'md', // Conflicting extension
            byteSize: 300,
            birthtimeMs: null,
            mtimeMs: 1000,
            discoveredAtMs: 20000,
            category: 'document'
          }
        ])
      }).toThrow(FileMetadataConflictError)

      // 2. Conflicting category with unchanged content facts
      expect(() => {
        db!.persistDiscoveryBatch('D:\\Photos', [
          {
            originalPath: photoPath,
            fileName: 'sunset.png',
            extension: 'png',
            byteSize: 500,
            birthtimeMs: null,
            mtimeMs: 1000,
            discoveredAtMs: 20000,
            category: 'document' // Conflicting category
          }
        ])
      }).toThrow(FileMetadataConflictError)

      // 3. Conflicting extension with changed content facts
      expect(() => {
        db!.persistDiscoveryBatch('D:\\Docs', [
          {
            originalPath: docPath,
            fileName: 'notes.txt',
            extension: 'pdf', // Conflicting extension
            byteSize: 999, // Changed size
            birthtimeMs: null,
            mtimeMs: 2000, // Changed mtime
            discoveredAtMs: 30000,
            category: 'document'
          }
        ])
      }).toThrow(FileMetadataConflictError)

      // 4. Conflicting category with changed content facts
      expect(() => {
        db!.persistDiscoveryBatch('D:\\Photos', [
          {
            originalPath: photoPath,
            fileName: 'sunset.png',
            extension: 'png',
            byteSize: 999, // Changed size
            birthtimeMs: null,
            mtimeMs: 2000, // Changed mtime
            discoveredAtMs: 30000,
            category: 'document' // Conflicting category
          }
        ])
      }).toThrow(FileMetadataConflictError)

      // Verify facts remain untouched
      expect(db.getFileLocationByPath(docPath)?.extension).toBe('txt')
      expect(db.getFileLocationByPath(photoPath)?.category).toBe('photo')
    })

    it('rolls back the entire batch including source registration, observations, and hash invalidation on conflict', () => {
      db = CatalogDatabase.open({ catalogPath })
      const existingPath = 'D:\\Existing\\item.jpg'
      const existingHash = 'b'.repeat(64)

      // Seed an existing file and active hash
      db.persistDiscoveryBatch('D:\\Existing', [
        {
          originalPath: existingPath,
          fileName: 'item.jpg',
          extension: 'jpg',
          byteSize: 500,
          birthtimeMs: 100,
          mtimeMs: 200,
          discoveredAtMs: 5000,
          category: 'photo'
        }
      ])
      db.recordHashObservation({
        originalPath: existingPath,
        sha256: existingHash,
        observedByteSize: 500,
        observedMtimeMs: 200,
        hashedAtMs: 6000
      })

      const newSourceRoot = 'D:\\BrandNewSource'
      const validNewFile: DiscoveryCandidateInput = {
        originalPath: 'D:\\BrandNewSource\\valid.jpg',
        fileName: 'valid.jpg',
        extension: 'jpg',
        byteSize: 800,
        birthtimeMs: 100,
        mtimeMs: 200,
        discoveredAtMs: 10000,
        category: 'photo'
      }

      // Candidate that conflicts with existingPath's recorded fileName
      const conflictingCandidate: DiscoveryCandidateInput = {
        originalPath: existingPath,
        fileName: 'conflicting-name.jpg', // Conflict!
        extension: 'jpg',
        byteSize: 1200, // Changed content (would have invalidated hash if not rolled back)
        birthtimeMs: 100,
        mtimeMs: 800,
        discoveredAtMs: 10000,
        category: 'photo'
      }

      // Batch persistence with earlier valid write and later conflict
      expect(() => {
        db!.persistDiscoveryBatch(newSourceRoot, [validNewFile, conflictingCandidate])
      }).toThrow(FileMetadataConflictError)

      // Complete rollback verification:
      // 1. Source was NOT registered
      expect(db.getSourceByPath(newSourceRoot)).toBeNull()
      // 2. Valid new file was NOT inserted
      expect(db.getFileLocationByPath('D:\\BrandNewSource\\valid.jpg')).toBeNull()
      // 3. Existing file's active hash was NOT invalidated
      const existingFile = db.getFileLocationByPath(existingPath)!
      expect(existingFile.activeHash).toBe(existingHash)
      expect(existingFile.fileName).toBe('item.jpg')
      expect(existingFile.byteSize).toBe(500)
      // 4. Discovery observations were NOT added
      expect(db.getDiscoveryObservationsForFile(existingFile.id).totalCount).toBe(1)
    })

    it('remains idempotent on identical retries with identical metadata', () => {
      db = CatalogDatabase.open({ catalogPath })
      const originalPath = 'D:\\Photos\\same.jpg'

      const candidate: DiscoveryCandidateInput = {
        originalPath,
        fileName: 'same.jpg',
        extension: 'jpg',
        byteSize: 600,
        birthtimeMs: 100,
        mtimeMs: 200,
        discoveredAtMs: 5000,
        category: 'photo'
      }

      const res1 = db.persistDiscoveryBatch('D:\\Photos', [candidate])
      expect(res1.insertedCount).toBe(1)

      const res2 = db.persistDiscoveryBatch('D:\\Photos', [candidate])
      expect(res2.insertedCount).toBe(0)
      expect(res2.updatedCount).toBe(0)
      expect(res2.unchangedCount).toBe(1)
      expect(res2.invalidatedHashCount).toBe(0)

      expect(db.getFileLocationByPath(originalPath)?.fileName).toBe('same.jpg')
    })

    it('treats a genuinely different exact path as a separate location', () => {
      db = CatalogDatabase.open({ catalogPath })
      const path1 = 'D:\\Photos\\lake.jpg'
      const path2 = 'D:\\Photos\\lake-renamed.jpg'

      db.persistDiscoveryBatch('D:\\Photos', [
        {
          originalPath: path1,
          fileName: 'lake.jpg',
          extension: 'jpg',
          byteSize: 1000,
          birthtimeMs: 100,
          mtimeMs: 200,
          discoveredAtMs: 5000,
          category: 'photo'
        }
      ])

      // Different exact path: should succeed as a distinct location
      const res = db.persistDiscoveryBatch('D:\\Photos', [
        {
          originalPath: path2,
          fileName: 'lake-renamed.jpg',
          extension: 'jpg',
          byteSize: 1000,
          birthtimeMs: 100,
          mtimeMs: 200,
          discoveredAtMs: 6000,
          category: 'photo'
        }
      ])

      expect(res.insertedCount).toBe(1)

      const loc1 = db.getFileLocationByPath(path1)
      const loc2 = db.getFileLocationByPath(path2)

      expect(loc1).not.toBeNull()
      expect(loc2).not.toBeNull()
      expect(loc1!.id).not.toBe(loc2!.id)
      expect(loc1!.fileName).toBe('lake.jpg')
      expect(loc2!.fileName).toBe('lake-renamed.jpg')
    })
  })
})
