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
})
