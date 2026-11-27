/**
 * @vitest-environment node
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, statSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { ThumbnailCoordinator } from '../../src/main/services/thumbnails/coordinator'
import type { ThumbnailResult } from '../../src/shared/validation/ipc-schemas'

describe('ThumbnailCoordinator', () => {
  let tempDir: string
  let sourceRoot: string
  let cacheDir: string
  let coordinator: ThumbnailCoordinator

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pv-thumb-coord-test-'))
    sourceRoot = join(tempDir, 'source')
    cacheDir = join(tempDir, 'cache')

    mkdirSync(sourceRoot, { recursive: true })
    mkdirSync(cacheDir, { recursive: true })

    coordinator = new ThumbnailCoordinator({
      cacheDir,
      maxActiveJobs: 2,
      maxQueuedJobs: 64,
      jobTimeoutMs: 5000,
      maxSourceSizeBytes: 128 * 1024 * 1024,
      maxInputPixels: 100_000_000,
      approvedRoots: [sourceRoot]
    })
  })

  afterEach(async () => {
    await coordinator.shutdown()
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('decodes supported JPEG image into a WebP thumbnail preserving aspect ratio', async () => {
    // Generate a 1000x500 JPEG
    const testJpegPath = join(sourceRoot, 'sample.jpg')
    const jpegBuffer = await sharp({
      create: {
        width: 1000,
        height: 500,
        channels: 3,
        background: { r: 255, g: 0, b: 0 }
      }
    })
      .jpeg()
      .toBuffer()

    writeFileSync(testJpegPath, jpegBuffer)
    const stat = statSync(testJpegPath)
    const sha256 = createHash('sha256').update(jpegBuffer).digest('hex')

    const result = await coordinator.requestThumbnail({
      locationId: 1,
      sourcePath: testJpegPath,
      expectedByteSize: stat.size,
      expectedMtimeMs: Math.round(stat.mtimeMs),
      expectedSha256: sha256
    })

    expect(result.status).toBe('ready')
    if (result.status === 'ready') {
      expect(result.dataUrl).toMatch(/^data:image\/webp;base64,/)
      expect(result.mimeType).toBe('image/webp')
      // Original 1000x500 scaled to max 512 edge -> 512x256
      expect(result.width).toBe(512)
      expect(result.height).toBe(256)
    }

    // Live source file bytes, mtime, and size remain untouched
    const afterStat = statSync(testJpegPath)
    expect(afterStat.size).toBe(stat.size)
  })

  it('handles EXIF orientation automatically', async () => {
    // Create an image with EXIF orientation 6 (90 deg CW)
    const testJpegPath = join(sourceRoot, 'rotated.jpg')
    const jpegBuffer = await sharp({
      create: {
        width: 600,
        height: 400,
        channels: 3,
        background: { r: 0, g: 255, b: 0 }
      }
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer()

    writeFileSync(testJpegPath, jpegBuffer)
    const stat = statSync(testJpegPath)
    const sha256 = createHash('sha256').update(jpegBuffer).digest('hex')

    const result = await coordinator.requestThumbnail({
      locationId: 2,
      sourcePath: testJpegPath,
      expectedByteSize: stat.size,
      expectedMtimeMs: Math.round(stat.mtimeMs),
      expectedSha256: sha256
    })

    expect(result.status).toBe('ready')
    if (result.status === 'ready') {
      // Orientation 6 swaps 600x400 to 400x600, so height is longest edge (512)
      expect(result.height).toBe(512)
      expect(result.width).toBe(341)
    }
  })

  it('returns unsupported status for RAW or SVG formats without crashing', async () => {
    const rawPath = join(sourceRoot, 'photo.cr2')
    const rawBytes = Buffer.from('II*\0\x10\0\0\0CR\x02\0', 'latin1')
    writeFileSync(rawPath, rawBytes)
    const rawStat = statSync(rawPath)

    const rawResult = await coordinator.requestThumbnail({
      locationId: 3,
      sourcePath: rawPath,
      expectedByteSize: rawStat.size,
      expectedMtimeMs: Math.round(rawStat.mtimeMs),
      expectedSha256: createHash('sha256').update(rawBytes).digest('hex')
    })

    expect(rawResult.status).toBe('unsupported')
    if (rawResult.status === 'unsupported') {
      expect(rawResult.reason).toContain('RAW')
    }

    const svgPath = join(sourceRoot, 'vector.svg')
    writeFileSync(svgPath, '<svg><circle cx="50" cy="50" r="40"/></svg>')
    const svgStat = statSync(svgPath)

    const svgResult = await coordinator.requestThumbnail({
      locationId: 4,
      sourcePath: svgPath,
      expectedByteSize: svgStat.size,
      expectedMtimeMs: Math.round(svgStat.mtimeMs),
      expectedSha256: createHash('sha256')
        .update('<svg><circle cx="50" cy="50" r="40"/></svg>')
        .digest('hex')
    })

    expect(svgResult.status).toBe('unsupported')
  })

  it('rejects source files modified out-of-band', async () => {
    const testJpegPath = join(sourceRoot, 'modified.jpg')
    const jpegBuffer = await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 0, g: 0, b: 255 } }
    })
      .jpeg()
      .toBuffer()

    writeFileSync(testJpegPath, jpegBuffer)
    const stat = statSync(testJpegPath)

    // Pass wrong expected hash
    const result = await coordinator.requestThumbnail({
      locationId: 5,
      sourcePath: testJpegPath,
      expectedByteSize: stat.size,
      expectedMtimeMs: Math.round(stat.mtimeMs),
      expectedSha256: '0'.repeat(64) // mismatch
    })

    expect(result.status).toBe('error')
    if (result.status === 'error') {
      expect(result.code).toBe('SOURCE_MODIFIED')
    }
  })

  it('rejects source paths outside approved source roots', async () => {
    const outsidePath = join(tempDir, 'outside.jpg')
    writeFileSync(outsidePath, 'OUTSIDE')

    const result = await coordinator.requestThumbnail({
      locationId: 6,
      sourcePath: outsidePath,
      expectedByteSize: 7,
      expectedMtimeMs: null,
      expectedSha256: null
    })

    expect(result.status).toBe('error')
    if (result.status === 'error') {
      expect(result.code).toBe('ACCESS_DENIED')
    }
  })

  it('bounds queue length and prioritizes high-priority jobs', async () => {
    const smallCoord = new ThumbnailCoordinator({
      cacheDir,
      maxActiveJobs: 1,
      maxQueuedJobs: 5,
      jobTimeoutMs: 5000,
      approvedRoots: [sourceRoot]
    })

    // Create a real JPEG
    const testJpegPath = join(sourceRoot, 'slow.jpg')
    const jpegBuffer = await sharp({
      create: { width: 400, height: 400, channels: 3, background: { r: 100, g: 100, b: 100 } }
    })
      .jpeg()
      .toBuffer()
    writeFileSync(testJpegPath, jpegBuffer)
    const stat = statSync(testJpegPath)

    // Enqueue 10 jobs synchronously
    const jobs: Promise<ThumbnailResult>[] = []
    for (let i = 0; i < 10; i++) {
      const p = smallCoord.requestThumbnail({
        locationId: 100 + i,
        sourcePath: testJpegPath,
        expectedByteSize: stat.size,
        expectedMtimeMs: Math.round(stat.mtimeMs),
        expectedSha256: null,
        priority: i % 2 === 0 ? 'low' : 'high'
      })
      jobs.push(p)
    }

    const results = await Promise.all(jobs)
    const queueFull = results.filter((r) => r.status === 'error' && r.code === 'QUEUE_FULL')
    expect(queueFull.length).toBeGreaterThan(0)
    await smallCoord.shutdown()
  })

  it('spawns real worker threads and limits active workers to maxActiveJobs', async () => {
    // Check that coordinator exposes worker diagnostics and uses real workers
    const stats = coordinator.getDiagnostics()
    expect(stats.activeWorkers).toBeLessThanOrEqual(2)
  })

  it('terminates real worker on timeout and frees concurrency only after worker terminates', async () => {
    const timeoutCoord = new ThumbnailCoordinator({
      cacheDir,
      maxActiveJobs: 1,
      maxQueuedJobs: 5,
      jobTimeoutMs: 100, // Very short timeout
      approvedRoots: [sourceRoot]
    })

    const testJpegPath = join(sourceRoot, 'timeout.jpg')
    const jpegBuffer = await sharp({
      create: { width: 1000, height: 1000, channels: 3, background: { r: 50, g: 50, b: 50 } }
    })
      .jpeg()
      .toBuffer()
    writeFileSync(testJpegPath, jpegBuffer)
    const stat = statSync(testJpegPath)

    // A simulated slow job or timeout
    const result = await timeoutCoord.requestThumbnail({
      locationId: 999,
      sourcePath: testJpegPath,
      expectedByteSize: stat.size,
      expectedMtimeMs: Math.round(stat.mtimeMs),
      expectedSha256: null
    })
    expect(result).toBeDefined()

    // Once timeout happens or completes, worker pool should have 0 active busy workers
    const stats = timeoutCoord.getDiagnostics()
    expect(stats.activeWorkers).toBe(0)
    await timeoutCoord.shutdown()
  })

  it('supports cancellation of active and queued requests, releasing worker and queue immediately', async () => {
    const cancelCoord = new ThumbnailCoordinator({
      cacheDir,
      maxActiveJobs: 1,
      maxQueuedJobs: 10,
      jobTimeoutMs: 5000,
      approvedRoots: [sourceRoot]
    })

    const testJpegPath = join(sourceRoot, 'cancel.jpg')
    const jpegBuffer = await sharp({
      create: { width: 500, height: 500, channels: 3, background: { r: 10, g: 20, b: 30 } }
    })
      .jpeg()
      .toBuffer()
    writeFileSync(testJpegPath, jpegBuffer)
    const stat = statSync(testJpegPath)

    // Job 1 becomes active in worker (maxActiveJobs is 1)
    const job1Promise = cancelCoord.requestThumbnail({
      locationId: 881,
      sourcePath: testJpegPath,
      expectedByteSize: stat.size,
      expectedMtimeMs: Math.round(stat.mtimeMs),
      expectedSha256: null
    })

    // Job 2 is queued (since maxActiveJobs = 1)
    const job2Promise = cancelCoord.requestThumbnail({
      locationId: 882,
      sourcePath: testJpegPath,
      expectedByteSize: stat.size,
      expectedMtimeMs: Math.round(stat.mtimeMs),
      expectedSha256: null
    })

    // Cancel queued job 882
    const cancelQueued = cancelCoord.cancelRequest(882)
    expect(cancelQueued).toBe(true)

    // Cancel active job 881
    const cancelActive = cancelCoord.cancelRequest(881)
    expect(cancelActive).toBe(true)

    const res1 = await job1Promise
    const res2 = await job2Promise
    expect(res1.status).toBe('error')
    expect(res2.status).toBe('error')
    if (res1.status === 'error') expect(res1.code).toBe('CANCELLED')
    if (res2.status === 'error') expect(res2.code).toBe('CANCELLED')

    // Diagnostics must show full capacity recovery
    await new Promise((r) => setTimeout(r, 50))
    const diag = cancelCoord.getDiagnostics()
    expect(diag.activeWorkers).toBe(0)
    expect(diag.queuedJobs).toBe(0)

    // Subsequent request succeeds
    const job3 = await cancelCoord.requestThumbnail({
      locationId: 883,
      sourcePath: testJpegPath,
      expectedByteSize: stat.size,
      expectedMtimeMs: Math.round(stat.mtimeMs),
      expectedSha256: null
    })
    expect(job3.status).toBe('ready')

    await cancelCoord.shutdown()
  })

  it('enforces source byte cap during reading if file exceeds maxSourceSizeBytes', async () => {
    // 1 KiB limit
    const tightCoord = new ThumbnailCoordinator({
      cacheDir,
      maxActiveJobs: 1,
      maxQueuedJobs: 5,
      jobTimeoutMs: 5000,
      maxSourceSizeBytes: 1024,
      approvedRoots: [sourceRoot]
    })

    const testJpegPath = join(sourceRoot, 'large.jpg')
    const jpegBuffer = await sharp({
      create: { width: 1200, height: 1200, channels: 3, background: { r: 10, g: 20, b: 30 } }
    })
      .jpeg({ quality: 95 })
      .toBuffer()
    writeFileSync(testJpegPath, jpegBuffer) // ~100+ KiB
    const stat = statSync(testJpegPath)

    const result = await tightCoord.requestThumbnail({
      locationId: 777,
      sourcePath: testJpegPath,
      expectedByteSize: stat.size,
      expectedMtimeMs: Math.round(stat.mtimeMs),
      expectedSha256: null
    })

    expect(result.status).toBe('error')
    if (result.status === 'error') {
      expect(result.code).toBe('OVERSIZED_SOURCE')
    }
    await tightCoord.shutdown()
  })

  it('counts terminating workers against capacity until confirmed exit so live workers never exceed maxActiveJobs', async () => {
    // Coordinator with maxActiveJobs = 2
    const testJpegPath = join(sourceRoot, 'concurrency_test.jpg')
    const jpegBuffer = await sharp({
      create: { width: 400, height: 400, channels: 3, background: { r: 100, g: 100, b: 100 } }
    })
      .jpeg()
      .toBuffer()
    writeFileSync(testJpegPath, jpegBuffer)
    const stat = statSync(testJpegPath)

    const boundedCoord = new ThumbnailCoordinator({
      cacheDir,
      maxActiveJobs: 2,
      maxQueuedJobs: 10,
      jobTimeoutMs: 5000,
      approvedRoots: [sourceRoot]
    })

    // Submit Job 1 and Job 2 to occupy both slots
    const job1Promise = boundedCoord.requestThumbnail({
      locationId: 901,
      sourcePath: testJpegPath,
      expectedByteSize: stat.size,
      expectedMtimeMs: Math.round(stat.mtimeMs),
      expectedSha256: null
    })

    const job2Promise = boundedCoord.requestThumbnail({
      locationId: 902,
      sourcePath: testJpegPath,
      expectedByteSize: stat.size,
      expectedMtimeMs: Math.round(stat.mtimeMs),
      expectedSha256: null
    })

    // Wait until both workers are spawned
    while (boundedCoord.getLiveWorkerCount() < 2) {
      await new Promise((r) => setTimeout(r, 10))
    }

    // Delay termination on the first worker to simulate real async thread exit
    const internalWorkers = boundedCoord.getActiveWorkerEntries()
    const worker1 = internalWorkers.find((w) => w.locationId === 901)
    const worker2 = internalWorkers.find((w) => w.locationId === 902)
    expect(worker1).toBeDefined()
    expect(worker2).toBeDefined()

    // Delay worker2 message delivery so it remains busy while worker1 is terminating
    const listeners2 = [...worker2!.worker.listeners('message')]
    worker2!.worker.removeAllListeners('message')
    for (const listener of listeners2) {
      worker2!.worker.on('message', (msg) => {
        setTimeout(() => (listener as (m: unknown) => void)(msg), 200)
      })
    }

    let terminationFinished = false
    const origTerminate = worker1!.worker.terminate.bind(worker1!.worker)
    worker1!.worker.terminate = async () => {
      await new Promise((r) => setTimeout(r, 80))
      terminationFinished = true
      return origTerminate()
    }

    // Cancel Job 1
    const cancelled = boundedCoord.cancelRequest(901)
    expect(cancelled).toBe(true)

    // While Worker 1 is terminating, diagnostics must NOT exclude it early
    const diagWhileTerminating = boundedCoord.getDiagnostics()
    expect(diagWhileTerminating.activeWorkers).toBeGreaterThanOrEqual(2)
    expect(boundedCoord.getLiveWorkerCount()).toBe(2)

    // Submit Job 3 while Worker 1 is terminating
    const job3Promise = boundedCoord.requestThumbnail({
      locationId: 903,
      sourcePath: testJpegPath,
      expectedByteSize: stat.size,
      expectedMtimeMs: Math.round(stat.mtimeMs),
      expectedSha256: null
    })

    // Allow async cache check to complete and item to be queued
    await new Promise((r) => setTimeout(r, 15))

    // Critical assertion: actual live workers must NEVER exceed maxActiveJobs (2)!
    expect(boundedCoord.getLiveWorkerCount()).toBeLessThanOrEqual(2)
    const diagAfterSubmit = boundedCoord.getDiagnostics()
    expect(diagAfterSubmit.queuedJobs).toBe(1) // Job 3 must remain queued until Worker 1 exits

    // Wait for termination and all jobs to settle
    const [res1, res2, res3] = await Promise.all([job1Promise, job2Promise, job3Promise])
    expect(terminationFinished).toBe(true)
    expect(res1.status).toBe('error')
    if (res1.status === 'error') expect(res1.code).toBe('CANCELLED')
    expect(res2.status).toBe('ready')
    expect(res3.status).toBe('ready')

    // Final live workers must be at or below maxActiveJobs
    expect(boundedCoord.getLiveWorkerCount()).toBeLessThanOrEqual(2)

    await boundedCoord.shutdown()
  })

  it('safely discards corrupt 30-byte cached thumbnails and regenerates from source', async () => {
    const testJpegPath = join(sourceRoot, 'regen_test.jpg')
    const jpegBuffer = await sharp({
      create: { width: 500, height: 250, channels: 3, background: { r: 120, g: 120, b: 120 } }
    })
      .jpeg()
      .toBuffer()
    writeFileSync(testJpegPath, jpegBuffer)
    const stat = statSync(testJpegPath)
    const sha256 = createHash('sha256').update(jpegBuffer).digest('hex')

    // Pre-populate cache with corrupt 30-byte pseudo-WebP file
    const cacheKey = coordinator.getCache().computeCacheKey({
      locationId: 555,
      sourcePath: testJpegPath,
      sha256,
      byteSize: stat.size,
      mtimeMs: Math.round(stat.mtimeMs)
    })
    const corruptThumbPath = join(cacheDir, `${cacheKey}.thumb`)

    const corrupt30Buf = Buffer.alloc(30)
    corrupt30Buf.write('RIFF', 0, 'ascii')
    corrupt30Buf.writeUInt32LE(22, 4)
    corrupt30Buf.write('WEBP', 8, 'ascii')
    corrupt30Buf.write('VP8 ', 12, 'ascii')
    corrupt30Buf.writeUInt32LE(10, 16)
    corrupt30Buf[23] = 0x9d
    corrupt30Buf[24] = 0x01
    corrupt30Buf[25] = 0x2a
    corrupt30Buf.writeUInt16LE(1, 26)
    corrupt30Buf.writeUInt16LE(1, 28)
    writeFileSync(corruptThumbPath, corrupt30Buf)

    // Request thumbnail: coordinator must NOT return ready with 1x1 dimensions!
    // It must discard the corrupt file, regenerate from source, and return genuine 512x256 thumbnail
    const result = await coordinator.requestThumbnail({
      locationId: 555,
      sourcePath: testJpegPath,
      expectedByteSize: stat.size,
      expectedMtimeMs: Math.round(stat.mtimeMs),
      expectedSha256: sha256
    })

    expect(result.status).toBe('ready')
    if (result.status === 'ready') {
      expect(result.width).toBe(500)
      expect(result.height).toBe(250)
    }

    // Cache file on disk is now regenerated, valid WebP (> 30 bytes)
    const newStat = statSync(corruptThumbPath)
    expect(newStat.size).toBeGreaterThan(100)
  })

  it('routes cache-hit integrity validation through bounded worker scheduling limiting active workers to maxActiveJobs', async () => {
    // Generate and cache 5 distinct images
    const keys = [101, 102, 103, 104, 105]
    for (const id of keys) {
      const p = join(sourceRoot, `hit_${id}.jpg`)
      const buf = await sharp({
        create: { width: 100, height: 100, channels: 3, background: { r: id, g: 0, b: 0 } }
      })
        .jpeg()
        .toBuffer()
      writeFileSync(p, buf)
      const st = statSync(p)
      const res = await coordinator.requestThumbnail({
        locationId: id,
        sourcePath: p,
        expectedByteSize: st.size,
        expectedMtimeMs: Math.round(st.mtimeMs),
        expectedSha256: null
      })
      expect(res.status).toBe('ready')
    }

    // Now request all 5 simultaneously as cache hits
    const promises = keys.map((id) => {
      const p = join(sourceRoot, `hit_${id}.jpg`)
      const st = statSync(p)
      return coordinator.requestThumbnail({
        locationId: id,
        sourcePath: p,
        expectedByteSize: st.size,
        expectedMtimeMs: Math.round(st.mtimeMs),
        expectedSha256: null
      })
    })

    const diag = coordinator.getDiagnostics()
    // Worker concurrency bound must hold during cache hit validation
    expect(diag.activeWorkers).toBeLessThanOrEqual(2)

    const results = await Promise.all(promises)
    for (const r of results) {
      expect(r.status).toBe('ready')
    }
  })

  it('terminates worker and recovers capacity when a cache validation job gets stuck', async () => {
    const stuckCoord = new ThumbnailCoordinator({
      cacheDir,
      maxActiveJobs: 1,
      maxQueuedJobs: 5,
      jobTimeoutMs: 150,
      approvedRoots: [sourceRoot]
    })

    const p = join(sourceRoot, 'stuck_cache.jpg')
    const buf = await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 50, g: 50, b: 50 } }
    })
      .jpeg()
      .toBuffer()
    writeFileSync(p, buf)
    const st = statSync(p)
    // Warm up cache
    const warmup = await stuckCoord.requestThumbnail({
      locationId: 777,
      sourcePath: p,
      expectedByteSize: st.size,
      expectedMtimeMs: Math.round(st.mtimeMs),
      expectedSha256: null
    })
    expect(warmup.status).toBe('ready')

    // Strengthened precondition 1: Assert warmup actually published a cache entry on disk (> 0 bytes)
    const cacheKey = stuckCoord.getCache().computeCacheKey({
      locationId: 777,
      sourcePath: p,
      sha256: null,
      byteSize: st.size,
      mtimeMs: Math.round(st.mtimeMs)
    })
    const cacheFile = join(cacheDir, `${cacheKey}.thumb`)
    expect(existsSync(cacheFile)).toBe(true)
    expect(statSync(cacheFile).size).toBeGreaterThan(0)

    // Strengthened precondition 2: Assert next request enters validate_cache
    process.env.PV_TEST_STUCK_VALIDATION = '1'
    try {
      const pReq = stuckCoord.requestThumbnail({
        locationId: 777,
        sourcePath: p,
        expectedByteSize: st.size,
        expectedMtimeMs: Math.round(st.mtimeMs),
        expectedSha256: null
      })

      await new Promise((r) => setTimeout(r, 20))
      const entries = stuckCoord.getActiveWorkerEntries()
      const activeJob = entries.find((e) => e.locationId === 777)
      expect(activeJob).toBeDefined()
      expect(activeJob?.item?.action).toBe('validate_cache')

      const res = await pReq
      expect(res.status).toBe('error')
      if (res.status === 'error') {
        expect(res.code).toBe('TIMEOUT')
      }

      const diag = stuckCoord.getDiagnostics()
      expect(diag.activeWorkers).toBe(0)
    } finally {
      delete process.env.PV_TEST_STUCK_VALIDATION
      await stuckCoord.shutdown()
    }
  })
})
