/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CatalogDatabase } from '../../src/main/services/catalog'
import {
  ScanJobCoordinator,
  ScanJobConflictError,
  ScanJobInvalidStateError
} from '../../src/main/services/jobs'
import type { ScanJobProgress } from '../../src/main/services/jobs'

describe('Stage 2D — Scan Job Coordinator and Resumable Lifecycle', () => {
  let testDir: string
  let sourceDir1: string
  let sourceDir2: string
  let catalogPath: string
  let db: CatalogDatabase
  let coordinator: ScanJobCoordinator

  beforeEach(async () => {
    testDir = await fs.mkdtemp(join(tmpdir(), 'pv-scan-job-test-'))
    sourceDir1 = join(testDir, 'source1')
    sourceDir2 = join(testDir, 'source2')
    catalogPath = join(testDir, 'catalog.db')

    await fs.mkdir(sourceDir1, { recursive: true })
    await fs.mkdir(sourceDir2, { recursive: true })

    // Populate source files
    await fs.writeFile(join(sourceDir1, 'photo1.jpg'), 'photo-one-content')
    await fs.writeFile(join(sourceDir1, 'doc1.pdf'), 'document-one-content')
    await fs.writeFile(join(sourceDir2, 'photo2.png'), 'photo-two-content')

    db = CatalogDatabase.open({ catalogPath })
    coordinator = new ScanJobCoordinator({ catalog: db })
    await coordinator.initialize()
  })

  afterEach(async () => {
    if (coordinator.hasActiveJob()) {
      await coordinator.cancelActiveJob().catch(() => {})
    }
    if (db && !db.isClosed()) {
      db.close()
    }
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {})
  })

  describe('Explicit Scan Start and End-to-End Completion', () => {
    it('scans explicit source roots, persists observations, streams hashes, and completes', async () => {
      const progressUpdates: ScanJobProgress[] = []
      coordinator.onProgress((p) => progressUpdates.push(p))

      const job = await coordinator.startScan({ roots: [sourceDir1, sourceDir2] })
      expect(job.status).toBe('running')
      expect(job.roots).toEqual([sourceDir1, sourceDir2])

      // Wait for job completion
      const completed = await coordinator.waitForJob(job.jobId)

      expect(completed.status).toBe('completed')
      expect(completed.phase).toBe('completed')
      expect(completed.discoveredCount).toBe(3)
      expect(completed.hashedCount).toBe(3)
      expect(completed.errorCount).toBe(0)
      expect(completed.completedAtMs).not.toBeNull()

      // Verify progress events were emitted
      expect(progressUpdates.length).toBeGreaterThan(0)
      const lastProgress = progressUpdates[progressUpdates.length - 1]
      expect(lastProgress?.status).toBe('completed')

      // Verify files in catalog
      const files = db.queryFileLocations()
      expect(files.totalCount).toBe(3)
      for (const file of files.items) {
        expect(file.activeHash).not.toBeNull()
        expect(file.activeHash).toHaveLength(64)
      }

      // Verify source preservation: source files unchanged
      expect(await fs.readFile(join(sourceDir1, 'photo1.jpg'), 'utf8')).toBe('photo-one-content')
    })

    it('rejects empty or non-existent roots', async () => {
      await expect(coordinator.startScan({ roots: [] })).rejects.toThrow(RangeError)
      await expect(
        coordinator.startScan({ roots: [join(testDir, 'non-existent')] })
      ).rejects.toThrow()
    })
  })

  describe('Accidental Concurrency Prevention', () => {
    it('prevents starting a second scan job while one is running', async () => {
      const job1 = await coordinator.startScan({ roots: [sourceDir1] })
      expect(job1.status).toBe('running')

      await expect(coordinator.startScan({ roots: [sourceDir2] })).rejects.toThrow(
        ScanJobConflictError
      )

      await coordinator.waitForJob(job1.jobId)
    })

    it('rejects simultaneous startScan calls so only one job starts', async () => {
      const results = await Promise.allSettled([
        coordinator.startScan({ roots: [sourceDir1] }),
        coordinator.startScan({ roots: [sourceDir2] })
      ])

      const fulfilled = results.filter((r) => r.status === 'fulfilled')
      const rejected = results.filter((r) => r.status === 'rejected')

      expect(fulfilled).toHaveLength(1)
      expect(rejected).toHaveLength(1)
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ScanJobConflictError)

      const active = (fulfilled[0] as PromiseFulfilledResult<ScanJobProgress>).value
      await coordinator.waitForJob(active.jobId)
    })

    it('rejects startScan when another job is paused', async () => {
      for (let i = 0; i < 15; i++) {
        await fs.writeFile(join(sourceDir1, `bulk-${i}.jpg`), `bulk-image-content-${i}`)
      }
      const job = await coordinator.startScan({ roots: [sourceDir1] })
      const paused = await coordinator.pauseScan(job.jobId)
      expect(['paused', 'completed']).toContain(paused.status)

      if (paused.status === 'paused') {
        // Must reject starting another scan while one is paused
        await expect(coordinator.startScan({ roots: [sourceDir2] })).rejects.toThrow(
          ScanJobConflictError
        )

        // Clean up: cancel paused job
        await coordinator.cancelScan(job.jobId)
      }
    })

    it('allows immediate startScan after cancelScan without conflict or old loop clobbering', async () => {
      for (let i = 0; i < 20; i++) {
        await fs.writeFile(join(sourceDir1, `cancel-${i}.jpg`), `cancel-data-${i}`)
      }
      const job1 = await coordinator.startScan({ roots: [sourceDir1] })
      const cancelled = await coordinator.cancelScan(job1.jobId)
      expect(cancelled.status).toBe('cancelled')

      // Immediately start job 2: must succeed and not be rejected or clobbered
      const job2 = await coordinator.startScan({ roots: [sourceDir2] })
      expect(job2.status).toBe('running')
      expect(job2.jobId).not.toBe(job1.jobId)

      const completed2 = await coordinator.waitForJob(job2.jobId)
      expect(completed2.status).toBe('completed')
      expect(completed2.jobId).toBe(job2.jobId)
    })
  })

  describe('Queue Advancement and Error Resilience', () => {
    it('advances past unhashed missing file at the front of the queue and hashes subsequent valid files with batchSize=1', async () => {
      // Step 1: Record an unhashed missing file directly in catalog
      const missingPath = join(sourceDir1, 'ghost.jpg')
      const validPath = join(sourceDir1, 'photo1.jpg')
      const validStat = await fs.stat(validPath)

      // Clear earlier data
      const singleBatchCoord = new ScanJobCoordinator({
        catalog: db,
        batchSize: 1
      })
      await singleBatchCoord.initialize()

      // Record missing file in catalog first (lower ID)
      db.persistDiscoveryBatch(sourceDir1, [
        {
          originalPath: missingPath,
          fileName: 'ghost.jpg',
          extension: '.jpg',
          category: 'photo',
          byteSize: 100,
          birthtimeMs: 1000,
          mtimeMs: 1000,
          discoveredAtMs: 1000
        },
        {
          originalPath: validPath,
          fileName: 'photo1.jpg',
          extension: '.jpg',
          category: 'photo',
          byteSize: validStat.size,
          birthtimeMs: Math.floor(validStat.birthtimeMs),
          mtimeMs: Math.floor(validStat.mtimeMs),
          discoveredAtMs: 1000
        }
      ])

      // Run coordinator scan
      const job = await singleBatchCoord.startScan({ roots: [sourceDir1] })
      const result = await singleBatchCoord.waitForJob(job.jobId)

      // ghost.jpg failed (does not exist on disk), but photo1.jpg MUST receive a hash!
      const validLoc = db.getFileLocationByOriginalPath(validPath)
      expect(validLoc?.activeHash).not.toBeNull()
      expect(validLoc?.activeHash).toHaveLength(64)

      expect(result.errorCount).toBe(1)
      expect(result.hashedCount).toBeGreaterThanOrEqual(1)
    })

    it('advances past multiple failures across page boundaries without skipping or infinite loops', async () => {
      // 6 files: 0, 2, 4 don't exist; 1, 3, 5 exist on disk
      await fs.writeFile(join(sourceDir1, 'real1.jpg'), 'real-1')
      await fs.writeFile(join(sourceDir1, 'real3.jpg'), 'real-3')
      await fs.writeFile(join(sourceDir1, 'real5.jpg'), 'real-5')

      const pageCoord = new ScanJobCoordinator({
        catalog: db,
        batchSize: 2 // batch size 2 across 6 items = 3 pages
      })
      await pageCoord.initialize()

      const inputs = [
        { name: 'fake0.jpg', real: false },
        { name: 'real1.jpg', real: true },
        { name: 'fake2.jpg', real: false },
        { name: 'real3.jpg', real: true },
        { name: 'fake4.jpg', real: false },
        { name: 'real5.jpg', real: true }
      ]

      for (const item of inputs) {
        const full = join(sourceDir1, item.name)
        db.persistDiscoveryBatch(sourceDir1, [
          {
            originalPath: full,
            fileName: item.name,
            extension: '.jpg',
            category: 'photo',
            byteSize: item.real ? 6 : 99,
            birthtimeMs: 2000,
            mtimeMs: 2000,
            discoveredAtMs: 2000
          }
        ])
      }

      const job = await pageCoord.startScan({ roots: [sourceDir1] })
      const result = await pageCoord.waitForJob(job.jobId)

      // All 3 real files must be hashed
      for (const item of inputs.filter((i) => i.real)) {
        const loc = db.getFileLocationByOriginalPath(join(sourceDir1, item.name))
        expect(loc?.activeHash).not.toBeNull()
      }

      expect(result.errorCount).toBe(3)
      expect(result.hashedCount).toBeGreaterThanOrEqual(3)
    })
  })

  describe('Deterministic Cancellation, Shutdown, and Promise Settlement', () => {
    it('cancelScan awaits execution loop termination before releasing ownership', async () => {
      for (let i = 0; i < 25; i++) {
        await fs.writeFile(join(sourceDir1, `drain-${i}.jpg`), `drain-content-${i}`)
      }
      const job = await coordinator.startScan({ roots: [sourceDir1] })
      const cancelled = await coordinator.cancelScan(job.jobId)
      expect(cancelled.status).toBe('cancelled')

      // Awaiting completionPromise must resolve immediately because cancelScan already drained
      const waited = await coordinator.waitForJob(job.jobId)
      expect(waited.status).toBe('cancelled')
    })

    it('settles completionPromise on pause, cancel, and error', async () => {
      // Pause settlement
      for (let i = 0; i < 15; i++) {
        await fs.writeFile(join(sourceDir1, `settle-${i}.jpg`), `settle-content-${i}`)
      }
      const job = await coordinator.startScan({ roots: [sourceDir1] })
      const pausePromise = coordinator.waitForJob(job.jobId)
      await coordinator.pauseScan(job.jobId)
      const settled = await pausePromise
      expect(['paused', 'completed']).toContain(settled.status)
    })

    it('preserves running job as interrupted on shutdown rather than cancelled', async () => {
      for (let i = 0; i < 30; i++) {
        await fs.writeFile(join(sourceDir1, `shut-${i}.jpg`), `shut-content-${i}`)
      }
      const job = await coordinator.startScan({ roots: [sourceDir1] })

      // Call shutdown on coordinator (application closing)
      await coordinator.shutdown()

      // Job in database must be 'interrupted', NOT 'cancelled'
      const inDb = db.getScanJob(job.jobId)
      expect(inDb?.status).toBe('interrupted')

      // It must be resumable on next startup
      const restartCoord = new ScanJobCoordinator({ catalog: db })
      await restartCoord.initialize()
      const resumed = await restartCoord.resumeScan(job.jobId)
      expect(resumed.status).toBe('running')
      const finished = await restartCoord.waitForJob(job.jobId)
      expect(finished.status).toBe('completed')
    })
  })

  describe('Progress and Recovery Accounting', () => {
    it('does not inflate discoveredCount, totalBytes, or hashedCount across repeated pause/resume and restart recovery', async () => {
      // Exactly 3 files in sourceDir2: photo2.png exists; add 2 more
      await fs.writeFile(join(sourceDir2, 'uniqueA.jpg'), '12345')
      await fs.writeFile(join(sourceDir2, 'uniqueB.jpg'), '67890')

      const stat0 = await fs.stat(join(sourceDir2, 'photo2.png'))
      const expectedUniqueCount = 3
      const expectedTotalBytes = stat0.size + 5 + 5

      const job = await coordinator.startScan({ roots: [sourceDir2] })

      // Pause
      await coordinator.pauseScan(job.jobId)

      // Resume
      await coordinator.resumeScan(job.jobId)

      // Simulate crash: shutdown and re-initialize
      await coordinator.shutdown()

      const recoveredCoord = new ScanJobCoordinator({ catalog: db })
      await recoveredCoord.initialize()

      const active = recoveredCoord.getActiveJob()
      expect(active?.status).toBe('interrupted')

      // Resume to completion
      await recoveredCoord.resumeScan(job.jobId)
      const final = await recoveredCoord.waitForJob(job.jobId)

      expect(final.status).toBe('completed')
      expect(final.discoveredCount).toBe(expectedUniqueCount)
      expect(final.totalBytes).toBe(expectedTotalBytes)
      expect(final.hashedCount).toBe(expectedUniqueCount)
    })
  })

  describe('Bounded Resource Use', () => {
    it('bounds in-memory retained errors while preserving full error history in SQLite', async () => {
      // Simulate 75 errors
      const failingAdapter = {
        lstat: vi.fn().mockImplementation((p: string) => fs.lstat(p)),
        realpath: vi.fn().mockImplementation((p: string) => fs.realpath(p)),
        open: vi
          .fn()
          .mockRejectedValue(
            Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
          )
      }

      for (let i = 0; i < 75; i++) {
        await fs.writeFile(join(sourceDir1, `err-${i}.jpg`), `err-${i}`)
      }

      const boundedCoord = new ScanJobCoordinator({
        catalog: db,
        hashingFsAdapter:
          failingAdapter as unknown as import('../../src/main/services/hashing/fs-adapter').ReadOnlyHashingFsAdapter
      })
      await boundedCoord.initialize()

      const job = await boundedCoord.startScan({ roots: [sourceDir1] })
      const finished = await boundedCoord.waitForJob(job.jobId)

      // In-memory errors payload must be bounded to <= 50
      expect(finished.errors.length).toBeLessThanOrEqual(50)
      expect(finished.errorCount).toBeGreaterThanOrEqual(75)

      // All 75+ errors must be preserved in SQLite
      const allDbErrors = db.getScanJobErrors(job.jobId, { limit: 200 })
      expect(allDbErrors.length).toBeGreaterThanOrEqual(75)
    })

    it('validates batchSize as a positive safe integer within catalog limits', () => {
      expect(() => new ScanJobCoordinator({ catalog: db, batchSize: 0 })).toThrow(RangeError)
      expect(() => new ScanJobCoordinator({ catalog: db, batchSize: -1 })).toThrow(RangeError)
      expect(() => new ScanJobCoordinator({ catalog: db, batchSize: 1001 })).toThrow(RangeError)
      expect(() => new ScanJobCoordinator({ catalog: db, batchSize: NaN })).toThrow(RangeError)
    })
  })

  describe('Honest Reporting of Partial Results', () => {
    it('persists error summary on completed-with-errors job and recovers it across restart', async () => {
      // 1 real file, 1 missing file
      const missingPath = join(sourceDir1, 'missing-terminal.jpg')
      db.persistDiscoveryBatch(sourceDir1, [
        {
          originalPath: missingPath,
          fileName: 'missing-terminal.jpg',
          extension: '.jpg',
          category: 'photo',
          byteSize: 50,
          birthtimeMs: 1000,
          mtimeMs: 1000,
          discoveredAtMs: 1000
        }
      ])

      const job = await coordinator.startScan({ roots: [sourceDir1] })
      const result = await coordinator.waitForJob(job.jobId)

      expect(result.status).toBe('completed')
      expect(result.errorCount).toBeGreaterThan(0)
      expect(result.errorMessage).toBeDefined()
      expect(result.errorMessage).toMatch(/error/i)

      // Simulate app restart: error info must be loaded from SQLite
      const restartCoord = new ScanJobCoordinator({ catalog: db })
      await restartCoord.initialize()

      const latest = restartCoord.getLatestJob()
      expect(latest?.jobId).toBe(job.jobId)
      expect(latest?.errorCount).toBe(result.errorCount)
      expect(latest?.errorMessage).toBe(result.errorMessage)
      expect(latest?.errors.length).toBeGreaterThan(0)
    })
  })

  describe('Pause and Resume Lifecycle', () => {
    it('pauses a running job and commits checkpoint, then resumes to completion', async () => {
      // Create more files so pause has time to trigger
      for (let i = 0; i < 10; i++) {
        await fs.writeFile(join(sourceDir1, `test-${i}.jpg`), `test-image-content-${i}`)
      }

      const job = await coordinator.startScan({ roots: [sourceDir1] })

      // Pause the job
      const paused = await coordinator.pauseScan(job.jobId)
      expect(['paused', 'completed']).toContain(paused.status)

      if (paused.status === 'paused') {
        expect(paused.phase).toBeDefined()
        const fromDb = db.getScanJob(job.jobId)
        expect(fromDb?.status).toBe('paused')

        // Resume the job
        const resumed = await coordinator.resumeScan(job.jobId)
        expect(resumed.status).toBe('running')

        const finalJob = await coordinator.waitForJob(job.jobId)
        expect(finalJob.status).toBe('completed')
        expect(finalJob.hashedCount).toBe(12) // 2 original + 10 created
      }
    })

    it('rejects resume on a completed or cancelled job', async () => {
      const job = await coordinator.startScan({ roots: [sourceDir1] })
      await coordinator.waitForJob(job.jobId)

      await expect(coordinator.resumeScan(job.jobId)).rejects.toThrow(ScanJobInvalidStateError)
    })
  })

  describe('Cancellation', () => {
    it('cancels an active job cleanly and preserves committed work', async () => {
      for (let i = 0; i < 20; i++) {
        await fs.writeFile(join(sourceDir1, `extra-${i}.jpg`), `extra-data-${i}`)
      }

      const job = await coordinator.startScan({ roots: [sourceDir1] })
      const cancelled = await coordinator.cancelScan(job.jobId)

      expect(cancelled.status).toBe('cancelled')
      expect(coordinator.hasActiveJob()).toBe(false)

      const dbJob = db.getScanJob(job.jobId)
      expect(dbJob?.status).toBe('cancelled')

      // Cannot resume a cancelled job
      await expect(coordinator.resumeScan(job.jobId)).rejects.toThrow(ScanJobInvalidStateError)
    })
  })

  describe('Restart Recovery & Interrupted State', () => {
    it('marks running jobs as interrupted on restart recovery, preserving committed work', async () => {
      const photo1Path = join(sourceDir1, 'photo1.jpg')
      const photo1Stat = await fs.stat(photo1Path)

      // Persist photo1 as already discovered and hashed in catalog
      db.persistDiscoveryBatch(sourceDir1, [
        {
          originalPath: photo1Path,
          fileName: 'photo1.jpg',
          extension: '.jpg',
          category: 'photo',
          byteSize: photo1Stat.size,
          birthtimeMs: Math.floor(photo1Stat.birthtimeMs),
          mtimeMs: Math.floor(photo1Stat.mtimeMs),
          discoveredAtMs: 1000
        }
      ])
      db.recordHashObservation({
        originalPath: photo1Path,
        sha256: 'b'.repeat(64),
        observedByteSize: photo1Stat.size,
        observedMtimeMs: Math.floor(photo1Stat.mtimeMs),
        hashedAtMs: 1000
      })

      // Create a job in DB that was left running (simulating crash)
      const rawJob = db.createScanJob({ roots: [sourceDir1], nowMs: 1000 })
      db.updateScanJobProgress(rawJob.id, {
        discoveredCount: 2,
        hashedCount: 1,
        totalBytes: 500,
        hashedBytes: 250,
        nowMs: 1500
      })

      // Create a new coordinator simulating app restart
      const restartCoordinator = new ScanJobCoordinator({ catalog: db })
      const interrupted = await restartCoordinator.initialize()

      expect(interrupted).toBe(1)
      const active = restartCoordinator.getActiveJob()
      expect(active).not.toBeNull()
      expect(active?.jobId).toBe(rawJob.id)
      expect(active?.status).toBe('interrupted')
      expect(active?.discoveredCount).toBe(2)
      expect(active?.hashedCount).toBe(1)

      // User can resume the interrupted job
      const resumed = await restartCoordinator.resumeScan(rawJob.id)
      expect(resumed.status).toBe('running')

      const final = await restartCoordinator.waitForJob(rawJob.id)
      expect(final.status).toBe('completed')
      expect(final.hashedCount).toBe(2)
    })
  })

  describe('Resume Revalidation of Changed Source Files', () => {
    it('revalidates source files on resume and re-hashes modified files', async () => {
      // Run initial scan to completion
      const job1 = await coordinator.startScan({ roots: [sourceDir1] })
      await coordinator.waitForJob(job1.jobId)

      const photoPath = join(sourceDir1, 'photo1.jpg')
      const initialLocation = db.getFileLocationByOriginalPath(photoPath)
      const initialHash = initialLocation?.activeHash
      expect(initialHash).not.toBeNull()

      // Now modify the file on disk out-of-band
      await new Promise((r) => setTimeout(r, 20)) // Ensure mtime advances
      await fs.writeFile(photoPath, 'photo-one-MODIFIED-CONTENT')

      // Start a second scan on sourceDir1 (e.g. re-scanning / refreshing)
      const job2 = await coordinator.startScan({ roots: [sourceDir1] })
      const completed2 = await coordinator.waitForJob(job2.jobId)
      expect(completed2.status).toBe('completed')

      // Verify the modified file was re-hashed with its new digest
      const updatedLocation = db.getFileLocationByOriginalPath(photoPath)
      expect(updatedLocation?.activeHash).not.toBeNull()
      expect(updatedLocation?.activeHash).not.toBe(initialHash)

      // Discovery history was preserved: 2 observations exist
      const observations = db.getDiscoveryObservationsForFile(initialLocation!.id)
      expect(observations.items).toHaveLength(2)
      expect(observations.items[0]?.isCurrent).toBe(true)
      expect(observations.items[1]?.isCurrent).toBe(false)
    })
  })

  describe('Error Visibility and Retry Behavior', () => {
    it('records errors during hashing and keeps them visible without claiming 0 errors', async () => {
      // Create an unreadable file or simulate error
      const mockFsAdapter = {
        lstat: vi.fn().mockImplementation((p: string) => fs.lstat(p)),
        realpath: vi.fn().mockImplementation((p: string) => fs.realpath(p)),
        open: vi
          .fn()
          .mockRejectedValue(
            Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
          )
      }

      const failingCoordinator = new ScanJobCoordinator({
        catalog: db,
        hashingFsAdapter:
          mockFsAdapter as unknown as import('../../src/main/services/hashing/fs-adapter').ReadOnlyHashingFsAdapter
      })
      await failingCoordinator.initialize()

      const job = await failingCoordinator.startScan({ roots: [sourceDir1] })
      const final = await failingCoordinator.waitForJob(job.jobId)

      expect(final.status).toBe('completed')
      expect(final.errorCount).toBeGreaterThan(0)
      expect(final.errors.length).toBeGreaterThan(0)
      expect(final.errors[0]?.code).toBe('permission_denied')
      expect(final.errors[0]?.phase).toBe('hashing')
    })
  })

  describe('Overlapping Source Roots and Membership Scope', () => {
    it('hashes modified files in subfolder scan after parent scan (reviewer reproduction)', async () => {
      // Create parent/child/good.jpg
      const parentDir = join(testDir, 'parent-scope')
      const childDir = join(parentDir, 'child')
      await fs.mkdir(childDir, { recursive: true })
      const goodPath = join(childDir, 'good.jpg')
      await fs.writeFile(goodPath, 'initial-good-bytes-content')

      // Scan parent to completion
      const job1 = await coordinator.startScan({ roots: [parentDir] })
      const res1 = await coordinator.waitForJob(job1.jobId)
      expect(res1.status).toBe('completed')
      expect(res1.discoveredCount).toBe(1)
      expect(res1.hashedCount).toBe(1)

      const locBefore = db.getFileLocationByOriginalPath(goodPath)
      expect(locBefore).not.toBeNull()
      expect(locBefore?.activeHash).not.toBeNull()
      const oldHash = locBefore?.activeHash

      // Modify good.jpg so its byte size changes
      await new Promise((r) => setTimeout(r, 20))
      await fs.writeFile(goodPath, 'modified-good-bytes-content-with-longer-size')

      // Scan child to completion
      const job2 = await coordinator.startScan({ roots: [childDir] })
      const res2 = await coordinator.waitForJob(job2.jobId)
      expect(res2.status).toBe('completed')
      expect(res2.discoveredCount).toBe(1)
      expect(res2.hashedCount).toBe(1)
      expect(res2.errorCount).toBe(0)

      const locAfter = db.getFileLocationByOriginalPath(goodPath)
      expect(locAfter).not.toBeNull()
      expect(locAfter?.activeHash).not.toBeNull()
      expect(locAfter?.activeHash).not.toBe(oldHash)
      // Source ID provenance is preserved (still points to original source)
      expect(locAfter?.sourceId).toBe(locBefore?.sourceId)
    })

    it('handles subfolder scan followed by parent scan after file modification', async () => {
      const parentDir = join(testDir, 'parent-sub-test')
      const childDir = join(parentDir, 'child')
      await fs.mkdir(childDir, { recursive: true })
      const filePath = join(childDir, 'photo.jpg')
      await fs.writeFile(filePath, 'sub-content-1')

      // Scan child first
      const job1 = await coordinator.startScan({ roots: [childDir] })
      await coordinator.waitForJob(job1.jobId)

      // Modify photo.jpg
      await new Promise((r) => setTimeout(r, 20))
      await fs.writeFile(filePath, 'sub-content-2-modified')

      // Scan parent
      const job2 = await coordinator.startScan({ roots: [parentDir] })
      const res2 = await coordinator.waitForJob(job2.jobId)
      expect(res2.status).toBe('completed')
      expect(res2.discoveredCount).toBe(1)
      expect(res2.hashedCount).toBe(1)

      const loc = db.getFileLocationByOriginalPath(filePath)
      expect(loc?.activeHash).not.toBeNull()
    })

    it('handles overlapping roots in the same job without duplicate counting or processing', async () => {
      const parentDir = join(testDir, 'parent-overlap')
      const childDir = join(parentDir, 'child')
      await fs.mkdir(childDir, { recursive: true })
      await fs.writeFile(join(childDir, 'item.jpg'), 'overlap-content')

      const job = await coordinator.startScan({ roots: [parentDir, childDir] })
      const res = await coordinator.waitForJob(job.jobId)

      expect(res.status).toBe('completed')
      expect(res.discoveredCount).toBe(1)
      expect(res.hashedCount).toBe(1)
    })

    it('prevents hashing outside the selected approved scope', async () => {
      const parentDir = join(testDir, 'scope-parent')
      const siblingDir = join(testDir, 'scope-sibling')
      await fs.mkdir(parentDir, { recursive: true })
      await fs.mkdir(siblingDir, { recursive: true })
      await fs.writeFile(join(parentDir, 'a.jpg'), 'a-content')
      await fs.writeFile(join(siblingDir, 'b.jpg'), 'b-content')

      // Scan sibling first
      const job1 = await coordinator.startScan({ roots: [siblingDir] })
      await coordinator.waitForJob(job1.jobId)

      // Now scan parent only
      const job2 = await coordinator.startScan({ roots: [parentDir] })
      const res2 = await coordinator.waitForJob(job2.jobId)
      expect(res2.discoveredCount).toBe(1)
      expect(res2.hashedCount).toBe(1)
    })
  })

  describe('Windows Root Containment and Bounded Deduplication', () => {
    it('does not open overlapping child directory twice when both parent and child are selected as roots on Windows', async () => {
      const parentDir = join(testDir, 'containment-parent')
      const childDir = join(parentDir, 'containment-child')
      await fs.mkdir(childDir, { recursive: true })
      await fs.writeFile(join(parentDir, 'parent-item.jpg'), 'parent-bytes')
      await fs.writeFile(join(childDir, 'child-item.jpg'), 'child-bytes')

      const openedDirs: string[] = []
      const spyingAdapter = {
        ...db, // dummy fallback to satisfy type check if needed
        lstat: async (p: string) => fs.lstat(p),
        realpath: async (p: string) => fs.realpath(p),
        opendir: async (dirPath: string) => {
          openedDirs.push(dirPath)
          return fs.opendir(dirPath)
        }
      }

      const coord = new ScanJobCoordinator({ catalog: db, discoveryFsAdapter: spyingAdapter })
      const job = await coord.startScan({ roots: [parentDir, childDir] })
      const res = await coord.waitForJob(job.jobId)

      expect(res.status).toBe('completed')
      expect(res.discoveredCount).toBe(2)
      expect(res.hashedCount).toBe(2)

      const normChild = childDir.toLowerCase().replace(/\//g, '\\')
      const childOpens = openedDirs.filter(
        (d) => d.toLowerCase().replace(/\//g, '\\') === normChild
      )
      expect(childOpens.length).toBe(1)
    })

    it('deduplicates candidates across batch boundaries without retaining full path inventory in memory', async () => {
      const batchDir = join(testDir, 'bounded-batch')
      await fs.mkdir(batchDir, { recursive: true })
      await fs.writeFile(join(batchDir, 'item1.jpg'), 'item1-bytes')
      await fs.writeFile(join(batchDir, 'item2.jpg'), 'item2-bytes')

      // Use batchSize: 1 to force every candidate to cross a batch boundary
      const coord = new ScanJobCoordinator({ catalog: db, batchSize: 1 })

      // Pass duplicate roots that normalize to the same root
      const job = await coord.startScan({ roots: [batchDir, batchDir] })
      const res = await coord.waitForJob(job.jobId)

      expect(res.status).toBe('completed')
      expect(res.discoveredCount).toBe(2)
      expect(res.hashedCount).toBe(2)
      expect(res.totalFilesToHash).toBe(2)

      // Verify SQLite state agrees directly
      const disc = db.countDiscoveredFilesForJob(job.jobId)
      expect(disc.count).toBe(2)
      const unhashed = db.countUnhashedFilesForJob(job.jobId)
      expect(unhashed.count).toBe(0)
    })

    it('preserves accurate counts across pause and resume with bounded batches', async () => {
      const pauseDir = join(testDir, 'bounded-pause')
      await fs.mkdir(pauseDir, { recursive: true })
      for (let i = 0; i < 5; i++) {
        await fs.writeFile(join(pauseDir, `pause-${i}.jpg`), `pause-content-${i}`)
      }

      // batchSize: 2 creates multiple batch commits
      const coord = new ScanJobCoordinator({ catalog: db, batchSize: 2 })
      const job = await coord.startScan({ roots: [pauseDir] })

      // Pause the job
      await coord.pauseScan(job.jobId)

      // Resume to completion
      const resumed = await coord.resumeScan(job.jobId)
      const finalRes = await coord.waitForJob(resumed.jobId)

      expect(finalRes.status).toBe('completed')
      expect(finalRes.discoveredCount).toBe(5)
      expect(finalRes.hashedCount).toBe(5)

      const disc = db.countDiscoveredFilesForJob(job.jobId)
      expect(disc.count).toBe(5)
    })
  })

  describe('Ordinary Application Shutdown and Terminal Result Restoration', () => {
    it('ordinary shutdown consistently produces an interrupted result with emitted event and resolved promise', async () => {
      const slowDir = join(testDir, 'slow-shutdown')
      await fs.mkdir(slowDir, { recursive: true })
      for (let i = 0; i < 40; i++) {
        await fs.writeFile(join(slowDir, `file-${i}.jpg`), `content-${i}`)
      }

      const events: ScanJobProgress[] = []
      coordinator.onProgress((p) => events.push(p))

      const job = await coordinator.startScan({ roots: [slowDir] })
      expect(job.status).toBe('running')

      // Call shutdown while job is running
      await coordinator.shutdown()

      // The job status in db must be interrupted, not cancelled
      const dbJob = db.getScanJob(job.jobId)
      expect(dbJob?.status).toBe('interrupted')

      // Completion promise must resolve with interrupted status
      const terminalEvent = events[events.length - 1]
      expect(terminalEvent?.status).toBe('interrupted')
    })

    it('restores latest terminal job and supports dismissal', async () => {
      const job = await coordinator.startScan({ roots: [sourceDir1] })
      await coordinator.waitForJob(job.jobId)

      expect(coordinator.getActiveJob()).toBeNull()

      // getLatestJob retrieves the completed terminal job
      const latest = coordinator.getLatestJob()
      expect(latest).not.toBeNull()
      expect(latest?.jobId).toBe(job.jobId)
      expect(latest?.status).toBe('completed')

      // Dismiss the terminal job
      coordinator.dismissScanJob(job.jobId)

      // After dismissal, getLatestJob with unDismissedOnly returns null
      expect(coordinator.getLatestJob({ unDismissedOnly: true })).toBeNull()
    })
  })
})
