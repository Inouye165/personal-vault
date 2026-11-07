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
  CURRENT_SCHEMA_VERSION
} from '../../src/main/services/catalog'

describe('Stage 2D — SQLite Catalog Scan Jobs and Checkpoints', () => {
  let testDir: string
  let catalogPath: string
  let db: CatalogDatabase | null = null

  beforeEach(async () => {
    testDir = await fs.mkdtemp(join(tmpdir(), 'pv-scan-jobs-catalog-test-'))
    catalogPath = join(testDir, 'catalog.db')
  })

  afterEach(async () => {
    if (db && !db.isClosed()) {
      db.close()
    }
    db = null
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {})
  })

  describe('Schema Migrations 3 and 4', () => {
    it('sets CURRENT_SCHEMA_VERSION to 4 and creates scan_jobs, scan_job_errors, and scan_job_files tables with is_dismissed column', () => {
      expect(CURRENT_SCHEMA_VERSION).toBe(4)
      db = CatalogDatabase.open({ catalogPath })

      const raw = new DatabaseSync(catalogPath)
      try {
        const tables = raw
          .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;")
          .all() as Array<{ name: string }>
        const names = tables.map((t) => t.name)
        expect(names).toContain('scan_jobs')
        expect(names).toContain('scan_job_errors')
        expect(names).toContain('scan_job_files')

        const cols = raw.prepare("PRAGMA table_info('scan_jobs');").all() as Array<{ name: string }>
        expect(cols.map((c) => c.name)).toContain('is_dismissed')

        const version = raw
          .prepare('SELECT MAX(version) as max_version FROM schema_migrations;')
          .get() as { max_version: number }
        expect(version.max_version).toBe(4)
      } finally {
        raw.close()
      }
    })

    it('migrates a v3 catalog cleanly to v4 without data loss', () => {
      // Create a v3 catalog directly
      const raw = new DatabaseSync(catalogPath)
      try {
        raw.exec(`
          CREATE TABLE schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at_ms INTEGER NOT NULL,
            name TEXT NOT NULL
          );
          INSERT INTO schema_migrations VALUES (1, 1000, 'initial_catalog_schema');
          INSERT INTO schema_migrations VALUES (2, 2000, 'discovery_observations_and_strict_hashes');
          INSERT INTO schema_migrations VALUES (3, 3000, 'scan_jobs_and_checkpoints');

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
            category TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL
          );

          CREATE TABLE discovery_observations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_location_id INTEGER NOT NULL REFERENCES file_locations(id) ON DELETE CASCADE,
            byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
            filesystem_birthtime_ms NUMERIC,
            filesystem_mtime_ms NUMERIC,
            inferred_capture_time_ms INTEGER,
            observed_at_ms INTEGER NOT NULL,
            last_seen_at_ms INTEGER NOT NULL,
            is_current INTEGER NOT NULL DEFAULT 1
          );

          CREATE TABLE hash_observations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_location_id INTEGER NOT NULL REFERENCES file_locations(id) ON DELETE CASCADE,
            discovery_observation_id INTEGER NOT NULL REFERENCES discovery_observations(id) ON DELETE CASCADE,
            sha256 TEXT NOT NULL,
            observed_byte_size INTEGER NOT NULL,
            observed_mtime_ms NUMERIC,
            hashed_at_ms INTEGER NOT NULL,
            is_active INTEGER NOT NULL DEFAULT 1
          );

          CREATE TABLE scan_jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            status TEXT NOT NULL,
            roots_json TEXT NOT NULL,
            phase TEXT NOT NULL,
            discovered_count INTEGER NOT NULL DEFAULT 0,
            hashed_count INTEGER NOT NULL DEFAULT 0,
            total_files_to_hash INTEGER NOT NULL DEFAULT 0,
            total_bytes INTEGER NOT NULL DEFAULT 0,
            hashed_bytes INTEGER NOT NULL DEFAULT 0,
            skipped_count INTEGER NOT NULL DEFAULT 0,
            error_count INTEGER NOT NULL DEFAULT 0,
            error_message TEXT,
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL,
            started_at_ms INTEGER NOT NULL,
            completed_at_ms INTEGER
          );

          CREATE TABLE scan_job_errors (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id INTEGER NOT NULL REFERENCES scan_jobs(id) ON DELETE CASCADE,
            path TEXT NOT NULL,
            code TEXT NOT NULL,
            message TEXT NOT NULL,
            phase TEXT NOT NULL,
            occurred_at_ms INTEGER NOT NULL
          );

          INSERT INTO scan_jobs (status, roots_json, phase, created_at_ms, updated_at_ms, started_at_ms)
          VALUES ('completed', '["D:/photos"]', 'completed', 100, 200, 100);
        `)
      } finally {
        raw.close()
      }

      // Open via CatalogDatabase -> runs migration 4
      db = CatalogDatabase.open({ catalogPath })

      const raw2 = new DatabaseSync(catalogPath)
      try {
        const version = raw2
          .prepare('SELECT MAX(version) as max_version FROM schema_migrations;')
          .get() as { max_version: number }
        expect(version.max_version).toBe(4)

        const job = raw2.prepare('SELECT * FROM scan_jobs WHERE id = 1;').get() as {
          status: string
          is_dismissed: number
        }
        expect(job.status).toBe('completed')
        expect(job.is_dismissed).toBe(0)
      } finally {
        raw2.close()
      }
    })

    it('records and queries job-scoped files and dismissal', () => {
      db = CatalogDatabase.open({ catalogPath })
      const job = db.createScanJob({ roots: ['D:/photos'] })

      db.persistDiscoveryBatch(
        'D:/photos',
        [
          {
            originalPath: 'D:/photos/1.jpg',
            fileName: '1.jpg',
            extension: '.jpg',
            category: 'photo',
            byteSize: 100,
            birthtimeMs: null,
            mtimeMs: null,
            discoveredAtMs: 100
          }
        ],
        job.id
      )

      const unhashed = db.getUnhashedFilesForJob(job.id)
      expect(unhashed).toHaveLength(1)
      expect(unhashed[0]?.originalPath).toBe('D:/photos/1.jpg')

      const count = db.countUnhashedFilesForJob(job.id)
      expect(count.count).toBe(1)
      expect(count.totalBytes).toBe(100)

      // Test dismissal
      expect(db.getLatestScanJob({ unDismissedOnly: true })?.id).toBe(job.id)
      db.dismissScanJob(job.id)
      expect(db.getLatestScanJob({ unDismissedOnly: true })).toBeNull()
      // Still returned if unDismissedOnly is false
      expect(db.getLatestScanJob()?.id).toBe(job.id)
    })

    it('migrates a v2 catalog cleanly to v3 without data loss', () => {
      // Create a v2 catalog directly
      const raw = new DatabaseSync(catalogPath)
      try {
        raw.exec(`
          CREATE TABLE schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at_ms INTEGER NOT NULL,
            name TEXT NOT NULL
          );
          INSERT INTO schema_migrations VALUES (1, 1000, 'initial_catalog_schema');
          INSERT INTO schema_migrations VALUES (2, 2000, 'discovery_observations_and_strict_hashes');

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
            category TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL
          );

          CREATE TABLE discovery_observations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_location_id INTEGER NOT NULL REFERENCES file_locations(id) ON DELETE CASCADE,
            byte_size INTEGER NOT NULL,
            filesystem_birthtime_ms NUMERIC,
            filesystem_mtime_ms NUMERIC,
            inferred_capture_time_ms INTEGER,
            observed_at_ms INTEGER NOT NULL,
            last_seen_at_ms INTEGER NOT NULL,
            is_current INTEGER NOT NULL DEFAULT 1
          );

          CREATE TABLE hash_observations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_location_id INTEGER NOT NULL REFERENCES file_locations(id) ON DELETE CASCADE,
            discovery_observation_id INTEGER NOT NULL REFERENCES discovery_observations(id) ON DELETE CASCADE,
            sha256 TEXT NOT NULL,
            observed_byte_size INTEGER NOT NULL,
            observed_mtime_ms NUMERIC,
            hashed_at_ms INTEGER NOT NULL,
            is_active INTEGER NOT NULL DEFAULT 1
          );

          INSERT INTO sources VALUES (1, 'D:/photos', 'd:/photos', 1000, 1000);
          INSERT INTO file_locations VALUES (1, 1, 'D:/photos/pic.jpg', 'd:/photos/pic.jpg', 'pic.jpg', '.jpg', 'photo', 1000, 1000);
          INSERT INTO discovery_observations VALUES (1, 1, 1024, 1000, 1000, NULL, 1000, 1000, 1);
        `)
      } finally {
        raw.close()
      }

      // Open with CatalogDatabase which runs migrations to v3
      db = CatalogDatabase.open({ catalogPath })
      const sources = db.listSources()
      expect(sources.items).toHaveLength(1)
      expect(sources.items[0]?.rootPath).toBe('D:/photos')

      const raw2 = new DatabaseSync(catalogPath)
      try {
        const version = raw2
          .prepare('SELECT MAX(version) as max_version FROM schema_migrations;')
          .get() as { max_version: number }
        expect(version.max_version).toBe(CURRENT_SCHEMA_VERSION)
      } finally {
        raw2.close()
      }
    })

    it('rejects unsupported future schema version > 4 without altering database', () => {
      const raw = new DatabaseSync(catalogPath)
      try {
        raw.exec(`
          CREATE TABLE schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at_ms INTEGER NOT NULL,
            name TEXT NOT NULL
          );
          INSERT INTO schema_migrations VALUES (999, 1000, 'future_alien_schema');
        `)
      } finally {
        raw.close()
      }

      expect(() => CatalogDatabase.open({ catalogPath })).toThrow(UnsupportedSchemaVersionError)
    })
  })

  describe('Scan Jobs CRUD and Lifecycle', () => {
    it('creates, retrieves, and updates scan jobs', () => {
      db = CatalogDatabase.open({ catalogPath })

      const job = db.createScanJob({
        roots: ['D:/photos', 'D:/docs'],
        nowMs: 10_000
      })

      expect(job.id).toBeGreaterThan(0)
      expect(job.status).toBe('running')
      expect(job.phase).toBe('discovery')
      expect(job.roots).toEqual(['D:/photos', 'D:/docs'])
      expect(job.discoveredCount).toBe(0)
      expect(job.hashedCount).toBe(0)
      expect(job.startedAtMs).toBe(10_000)

      const fetched = db.getScanJob(job.id)
      expect(fetched).not.toBeNull()
      expect(fetched?.roots).toEqual(['D:/photos', 'D:/docs'])

      // Update progress
      db.updateScanJobProgress(job.id, {
        discoveredCount: 15,
        totalBytes: 50_000,
        skippedCount: 2,
        phase: 'discovery',
        nowMs: 11_000
      })

      const afterProgress = db.getScanJob(job.id)
      expect(afterProgress?.discoveredCount).toBe(15)
      expect(afterProgress?.totalBytes).toBe(50_000)
      expect(afterProgress?.skippedCount).toBe(2)
      expect(afterProgress?.updatedAtMs).toBe(11_000)

      // Transition to paused
      db.updateScanJobStatus(job.id, 'paused', { nowMs: 12_000 })
      const pausedJob = db.getScanJob(job.id)
      expect(pausedJob?.status).toBe('paused')

      // Transition back to running
      db.updateScanJobStatus(job.id, 'running', { nowMs: 13_000 })
      expect(db.getScanJob(job.id)?.status).toBe('running')

      // Transition to completed
      db.updateScanJobStatus(job.id, 'completed', { nowMs: 15_000, completedAtMs: 15_000 })
      const completedJob = db.getScanJob(job.id)
      expect(completedJob?.status).toBe('completed')
      expect(completedJob?.completedAtMs).toBe(15_000)
    })

    it('records and retrieves scan job errors with cascade deletion', () => {
      db = CatalogDatabase.open({ catalogPath })

      const job = db.createScanJob({
        roots: ['D:/photos'],
        nowMs: 1000
      })

      db.recordScanJobError(job.id, {
        path: 'D:/photos/corrupt.jpg',
        code: 'permission_denied',
        message: 'EACCES: permission denied',
        phase: 'hashing',
        occurredAtMs: 1500
      })

      const errors = db.getScanJobErrors(job.id)
      expect(errors).toHaveLength(1)
      expect(errors[0]?.path).toBe('D:/photos/corrupt.jpg')
      expect(errors[0]?.code).toBe('permission_denied')
      expect(errors[0]?.phase).toBe('hashing')

      // Check job errorCount was updated
      const updatedJob = db.getScanJob(job.id)
      expect(updatedJob?.errorCount).toBe(1)
    })

    it('marks running jobs as interrupted on restart recovery', () => {
      db = CatalogDatabase.open({ catalogPath })

      const job1 = db.createScanJob({ roots: ['D:/photos'], nowMs: 1000 })
      db.updateScanJobProgress(job1.id, { discoveredCount: 50, nowMs: 1500 })

      // Another job already completed
      const job2 = db.createScanJob({ roots: ['D:/docs'], nowMs: 2000 })
      db.updateScanJobStatus(job2.id, 'completed', { nowMs: 3000, completedAtMs: 3000 })

      // Simulate crash and reopen: markRunningJobsAsInterrupted
      const interruptedCount = db.markRunningJobsAsInterrupted(4000)
      expect(interruptedCount).toBe(1)

      const recoveredJob1 = db.getScanJob(job1.id)
      expect(recoveredJob1?.status).toBe('interrupted')
      expect(recoveredJob1?.discoveredCount).toBe(50) // committed work preserved!
      expect(recoveredJob1?.updatedAtMs).toBe(4000)

      const unchangedJob2 = db.getScanJob(job2.id)
      expect(unchangedJob2?.status).toBe('completed')
    })

    it('identifies active scan jobs correctly', () => {
      db = CatalogDatabase.open({ catalogPath })
      expect(db.getActiveScanJob()).toBeNull()

      const job = db.createScanJob({ roots: ['D:/photos'], nowMs: 1000 })
      expect(db.getActiveScanJob()?.id).toBe(job.id)

      db.updateScanJobStatus(job.id, 'paused', { nowMs: 2000 })
      expect(db.getActiveScanJob()?.id).toBe(job.id)

      db.updateScanJobStatus(job.id, 'completed', { nowMs: 3000, completedAtMs: 3000 })
      expect(db.getActiveScanJob()).toBeNull()
    })
  })

  describe('Unhashed Files Query for Roots', () => {
    it('returns only files belonging to target roots that lack active verified hashes', () => {
      db = CatalogDatabase.open({ catalogPath })

      // Register two sources and files
      db.persistDiscoveryBatch('D:/photos', [
        {
          originalPath: 'D:/photos/p1.jpg',
          fileName: 'p1.jpg',
          extension: '.jpg',
          category: 'photo',
          byteSize: 1000,
          birthtimeMs: 100,
          mtimeMs: 200,
          discoveredAtMs: 500
        },
        {
          originalPath: 'D:/photos/p2.jpg',
          fileName: 'p2.jpg',
          extension: '.jpg',
          category: 'photo',
          byteSize: 2000,
          birthtimeMs: 100,
          mtimeMs: 200,
          discoveredAtMs: 500
        }
      ])

      db.persistDiscoveryBatch('D:/other', [
        {
          originalPath: 'D:/other/o1.jpg',
          fileName: 'o1.jpg',
          extension: '.jpg',
          category: 'photo',
          byteSize: 3000,
          birthtimeMs: 100,
          mtimeMs: 200,
          discoveredAtMs: 500
        }
      ])

      // Initially both photos are unhashed for D:/photos
      let unhashed = db.getUnhashedFilesForRoots(['D:/photos'])
      expect(unhashed).toHaveLength(2)
      expect(unhashed.map((u) => u.originalPath).sort()).toEqual([
        'D:/photos/p1.jpg',
        'D:/photos/p2.jpg'
      ])

      const counts = db.countUnhashedFilesForRoots(['D:/photos'])
      expect(counts.count).toBe(2)
      expect(counts.totalBytes).toBe(3000)

      // Now hash p1.jpg
      db.recordHashObservation({
        originalPath: 'D:/photos/p1.jpg',
        sha256: 'a'.repeat(64),
        observedByteSize: 1000,
        observedMtimeMs: 200,
        hashedAtMs: 1000
      })

      // Query unhashed again: only p2 remains!
      unhashed = db.getUnhashedFilesForRoots(['D:/photos'])
      expect(unhashed).toHaveLength(1)
      expect(unhashed[0]?.originalPath).toBe('D:/photos/p2.jpg')

      const countsAfter = db.countUnhashedFilesForRoots(['D:/photos'])
      expect(countsAfter.count).toBe(1)
      expect(countsAfter.totalBytes).toBe(2000)

      // Query pagination
      const page = db.getUnhashedFilesForRoots(['D:/photos'], { limit: 1, offset: 0 })
      expect(page).toHaveLength(1)
      expect(page[0]?.originalPath).toBe('D:/photos/p2.jpg')

      const emptyPage = db.getUnhashedFilesForRoots(['D:/photos'], { limit: 1, offset: 1 })
      expect(emptyPage).toHaveLength(0)
    })

    it('re-hashes a modified file whose observation changed', () => {
      db = CatalogDatabase.open({ catalogPath })

      db.persistDiscoveryBatch('D:/photos', [
        {
          originalPath: 'D:/photos/p1.jpg',
          fileName: 'p1.jpg',
          extension: '.jpg',
          category: 'photo',
          byteSize: 1000,
          birthtimeMs: 100,
          mtimeMs: 200,
          discoveredAtMs: 500
        }
      ])

      db.recordHashObservation({
        originalPath: 'D:/photos/p1.jpg',
        sha256: 'a'.repeat(64),
        observedByteSize: 1000,
        observedMtimeMs: 200,
        hashedAtMs: 1000
      })

      // 0 unhashed
      expect(db.countUnhashedFilesForRoots(['D:/photos']).count).toBe(0)

      // File modified on disk -> new discovery batch with changed mtime
      db.persistDiscoveryBatch('D:/photos', [
        {
          originalPath: 'D:/photos/p1.jpg',
          fileName: 'p1.jpg',
          extension: '.jpg',
          category: 'photo',
          byteSize: 1200, // changed size
          birthtimeMs: 100,
          mtimeMs: 300, // changed mtime
          discoveredAtMs: 600
        }
      ])

      // Now p1 is unhashed again because new observation has no active hash!
      const unhashed = db.getUnhashedFilesForRoots(['D:/photos'])
      expect(unhashed).toHaveLength(1)
      expect(unhashed[0]?.byteSize).toBe(1200)
    })
  })

  describe('Catalog Counts for Vault Status', () => {
    it('counts total sources and file locations accurately', () => {
      db = CatalogDatabase.open({ catalogPath })
      expect(db.countSources()).toBe(0)
      expect(db.countFileLocations()).toBe(0)

      db.persistDiscoveryBatch('D:/photos', [
        {
          originalPath: 'D:/photos/p1.jpg',
          fileName: 'p1.jpg',
          extension: '.jpg',
          category: 'photo',
          byteSize: 1000,
          birthtimeMs: null,
          mtimeMs: null,
          discoveredAtMs: 500
        }
      ])
      db.persistDiscoveryBatch('D:/docs', [
        {
          originalPath: 'D:/docs/d1.pdf',
          fileName: 'd1.pdf',
          extension: '.pdf',
          category: 'document',
          byteSize: 5000,
          birthtimeMs: null,
          mtimeMs: null,
          discoveredAtMs: 500
        }
      ])

      expect(db.countSources()).toBe(2)
      expect(db.countFileLocations()).toBe(2)
    })
  })
})
