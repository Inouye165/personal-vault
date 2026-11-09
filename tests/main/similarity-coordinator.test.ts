/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import sharp from 'sharp'
import { CatalogDatabase } from '../../src/main/services/catalog/database'
import { ThumbnailCoordinator } from '../../src/main/services/thumbnails/coordinator'
import { SimilarityCoordinator } from '../../src/main/services/similarity/coordinator'

describe('Stage 5C — SimilarityCoordinator Orchestration & Resumability', () => {
  let tempDir: string
  let dbPath: string
  let cacheDir: string
  let photosDir: string
  let catalog: CatalogDatabase
  let thumbnailCoordinator: ThumbnailCoordinator
  let similarityCoordinator: SimilarityCoordinator

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pv-sim-coord-test-'))
    dbPath = join(tempDir, 'catalog.db')
    cacheDir = join(tempDir, 'cache')
    photosDir = join(tempDir, 'photos')
    mkdirSync(cacheDir, { recursive: true })
    mkdirSync(photosDir, { recursive: true })

    catalog = CatalogDatabase.open({ catalogPath: dbPath })
    thumbnailCoordinator = new ThumbnailCoordinator({
      cacheDir,
      approvedRoots: [photosDir],
      maxActiveJobs: 2,
      maxQueuedJobs: 32
    })
    similarityCoordinator = new SimilarityCoordinator({
      catalog,
      thumbnailCoordinator
    })
  })

  afterEach(async () => {
    await similarityCoordinator.shutdown()
    await thumbnailCoordinator.shutdown()
    try {
      catalog.close()
    } catch {
      // ignore
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('runs analysis to completion, tracks unsupported/error files, and finds candidates', async () => {
    // Create image 1 (valid)
    const img1Path = join(photosDir, 'img1.jpg')
    const img1Buf = await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 255, g: 0, b: 0 } }
    })
      .jpeg()
      .toBuffer()
    writeFileSync(img1Path, img1Buf)

    // Create image 2 (valid derivative of img1)
    const img2Path = join(photosDir, 'img2.jpg')
    const img2Buf = await sharp(img1Buf).jpeg({ quality: 60 }).toBuffer()
    writeFileSync(img2Path, img2Buf)

    // Create image 3 (unsupported format: SVG)
    const img3Path = join(photosDir, 'img3.svg')
    writeFileSync(img3Path, '<svg></svg>')

    // Register photos in catalog
    const st1 = statSync(img1Path)
    const st2 = statSync(img2Path)
    const st3 = statSync(img3Path)
    catalog.persistDiscoveryBatch(photosDir, [
      {
        originalPath: img1Path,
        fileName: 'img1.jpg',
        extension: '.jpg',
        category: 'photo',
        byteSize: st1.size,
        birthtimeMs: st1.birthtimeMs,
        mtimeMs: st1.mtimeMs,
        discoveredAtMs: 1000
      },
      {
        originalPath: img2Path,
        fileName: 'img2.jpg',
        extension: '.jpg',
        category: 'photo',
        byteSize: st2.size,
        birthtimeMs: st2.birthtimeMs,
        mtimeMs: st2.mtimeMs,
        discoveredAtMs: 1000
      },
      {
        originalPath: img3Path,
        fileName: 'img3.svg',
        extension: '.svg',
        category: 'photo',
        byteSize: st3.size,
        birthtimeMs: st3.birthtimeMs,
        mtimeMs: st3.mtimeMs,
        discoveredAtMs: 1000
      }
    ])

    const job = await similarityCoordinator.startAnalysis()
    expect(job.status).toBe('running')
    expect(job.totalPhotos).toBe(3)

    // Await completion
    const completedJob = await similarityCoordinator.waitForCompletion()
    expect(completedJob.status).toBe('completed')
    expect(completedJob.processedPhotos).toBe(2)
    expect(completedJob.unsupportedPhotos).toBe(1)
    expect(completedJob.errorPhotos).toBe(0)
    expect(completedJob.candidatePairsFound).toBeGreaterThanOrEqual(1)

    // Verify candidate pair in database
    const pairsRes = catalog.getSimilarityCandidatePairs({ page: 1, pageSize: 10 })
    expect(pairsRes.totalCount).toBeGreaterThanOrEqual(1)
  })

  it('handles cancellation truthfully without marking job as completed', async () => {
    // Seed 10 valid images
    const batch = []
    for (let i = 0; i < 10; i++) {
      const p = join(photosDir, `img_${i}.jpg`)
      const buf = await sharp({
        create: { width: 50, height: 50, channels: 3, background: { r: i * 20, g: 0, b: 0 } }
      })
        .jpeg()
        .toBuffer()
      writeFileSync(p, buf)
      const st = statSync(p)
      batch.push({
        originalPath: p,
        fileName: `img_${i}.jpg`,
        extension: '.jpg',
        category: 'photo' as const,
        byteSize: st.size,
        birthtimeMs: st.birthtimeMs,
        mtimeMs: st.mtimeMs,
        discoveredAtMs: 1000
      })
    }
    catalog.persistDiscoveryBatch(photosDir, batch)

    await similarityCoordinator.startAnalysis()
    // Immediately cancel
    similarityCoordinator.cancelAnalysis()

    const finalProgress = similarityCoordinator.getProgress()
    expect(finalProgress.status).toBe('cancelled')
    expect(finalProgress.status).not.toBe('completed')
  })

  it('recovers interrupted job on restart and resumes only originally authorized scope', async () => {
    // Seed 4 images
    const batch = []
    for (let i = 0; i < 4; i++) {
      const p = join(photosDir, `item_${i}.jpg`)
      const buf = await sharp({
        create: { width: 50, height: 50, channels: 3, background: { r: i * 30, g: 50, b: 50 } }
      })
        .jpeg()
        .toBuffer()
      writeFileSync(p, buf)
      const st = statSync(p)
      batch.push({
        originalPath: p,
        fileName: `item_${i}.jpg`,
        extension: '.jpg',
        category: 'photo' as const,
        byteSize: st.size,
        birthtimeMs: st.birthtimeMs,
        mtimeMs: st.mtimeMs,
        discoveredAtMs: 1000
      })
    }
    catalog.persistDiscoveryBatch(photosDir, batch)

    // Create an interrupted job directly in catalog
    const locs = catalog.queryFileLocations({ category: 'photo', offset: 0, limit: 10 }).items
    const jobRecord = catalog.createSimilarityJob({
      jobId: 'interrupted-job-1',
      algorithmVersion: 'dhash64_v1',
      totalPhotos: 4,
      photoLocationIds: locs.map((l) => l.id)
    })
    catalog.markRunningSimilarityJobsAsInterrupted()

    // Add a NEW 5th photo to catalog AFTER the job was created
    const p5 = join(photosDir, 'item_5_new.jpg')
    const buf5 = await sharp({
      create: { width: 50, height: 50, channels: 3, background: { r: 200, g: 200, b: 200 } }
    })
      .jpeg()
      .toBuffer()
    writeFileSync(p5, buf5)
    const st5 = statSync(p5)
    catalog.persistDiscoveryBatch(photosDir, [
      {
        originalPath: p5,
        fileName: 'item_5_new.jpg',
        extension: '.jpg',
        category: 'photo',
        byteSize: st5.size,
        birthtimeMs: st5.birthtimeMs,
        mtimeMs: st5.mtimeMs,
        discoveredAtMs: 1000
      }
    ])

    // Resume the interrupted job
    const resumed = await similarityCoordinator.resumeAnalysis(jobRecord.jobId)
    expect(resumed.status).toBe('running')
    // Resumed scope MUST be 4, NOT 5!
    expect(resumed.totalPhotos).toBe(4)

    const completed = await similarityCoordinator.waitForCompletion()
    expect(completed.status).toBe('completed')
    expect(completed.totalPhotos).toBe(4)
    expect(completed.processedPhotos).toBe(4)
  })
})
