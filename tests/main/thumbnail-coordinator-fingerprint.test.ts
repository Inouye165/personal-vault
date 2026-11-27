/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import sharp from 'sharp'
import { ThumbnailCoordinator } from '../../src/main/services/thumbnails/coordinator'

describe('ThumbnailCoordinator Perceptual Fingerprinting (Stage 5C)', () => {
  let tempDir: string
  let cacheDir: string
  let photosDir: string
  let coordinator: ThumbnailCoordinator

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pv-coordinator-fp-test-'))
    cacheDir = join(tempDir, 'cache')
    photosDir = join(tempDir, 'photos')
    mkdirSync(photosDir, { recursive: true })
    mkdirSync(cacheDir, { recursive: true })
    coordinator = new ThumbnailCoordinator({
      cacheDir,
      approvedRoots: [photosDir],
      maxActiveJobs: 2,
      maxQueuedJobs: 10
    })
  })

  afterEach(async () => {
    if (coordinator) {
      await coordinator.shutdown()
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('computes perceptual fingerprint via worker threads with bounded concurrency', async () => {
    // Generate a valid decodable image file
    const imgPath = join(photosDir, 'sample.jpg')
    const imgBuf = await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 3,
        background: { r: 120, g: 80, b: 200 }
      }
    })
      .jpeg()
      .toBuffer()

    writeFileSync(imgPath, imgBuf)

    const result = await coordinator.requestFingerprint({
      locationId: 101,
      sourcePath: imgPath,
      expectedByteSize: imgBuf.length,
      expectedMtimeMs: null,
      expectedSha256: null,
      priority: 'low'
    })

    expect(result.status).toBe('ready')
    if (result.status === 'ready') {
      expect(result.locationId).toBe(101)
      expect(result.fingerprint).toHaveLength(16)
      expect(result.width).toBe(100)
      expect(result.height).toBe(100)
      expect(result.algorithmVersion).toBe('dhash64_v1')
      expect(result.bucket0).toBeGreaterThanOrEqual(0)
      expect(result.bucket1).toBeGreaterThanOrEqual(0)
      expect(result.bucket2).toBeGreaterThanOrEqual(0)
      expect(result.bucket3).toBeGreaterThanOrEqual(0)
    }
  })

  it('returns unsupported for unsupported formats (HEIC/RAW/SVG)', async () => {
    const svgPath = join(photosDir, 'test.svg')
    writeFileSync(svgPath, '<svg></svg>')

    const result = await coordinator.requestFingerprint({
      locationId: 102,
      sourcePath: svgPath,
      expectedByteSize: 11,
      expectedMtimeMs: null,
      expectedSha256: null
    })

    expect(result.status).toBe('unsupported')
  })
})
