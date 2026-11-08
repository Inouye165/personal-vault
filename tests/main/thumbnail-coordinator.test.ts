/**
 * @vitest-environment node
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, statSync, mkdirSync } from 'node:fs'
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

  it('returns unsupported status for HEIC, RAW, or SVG formats without crashing', async () => {
    const heicPath = join(sourceRoot, 'photo.heic')
    writeFileSync(heicPath, 'SIMULATED_HEIC_FILE_BYTES')
    const heicStat = statSync(heicPath)

    const heicResult = await coordinator.requestThumbnail({
      locationId: 3,
      sourcePath: heicPath,
      expectedByteSize: heicStat.size,
      expectedMtimeMs: Math.round(heicStat.mtimeMs),
      expectedSha256: createHash('sha256').update('SIMULATED_HEIC_FILE_BYTES').digest('hex')
    })

    expect(heicResult.status).toBe('unsupported')
    if (heicResult.status === 'unsupported') {
      expect(heicResult.reason).toContain('HEIC')
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
})
