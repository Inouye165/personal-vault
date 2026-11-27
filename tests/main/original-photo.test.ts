// @vitest-environment node
import { createHash } from 'node:crypto'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decodeOriginalPhoto } from '../../src/main/services/thumbnails/decoder'

function sha256(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

describe('Stage 8D: decodeOriginalPhoto', () => {
  let workDir: string

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'pv-8d-orig-'))
  })

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  it('decodes landscape and EXIF-rotated portrait JPEGs at full resolution while keeping sources read-only', async () => {
    const landscapePath = join(workDir, 'landscape.jpg')
    await sharp({
      create: { width: 1200, height: 800, channels: 3, background: { r: 20, g: 120, b: 180 } }
    })
      .jpeg({ quality: 90 })
      .toFile(landscapePath)

    // Create a 900x600 buffer with EXIF Orientation=6 (90 deg CW -> displayed 600x900 portrait)
    const portraitPath = join(workDir, 'portrait_exif6.jpg')
    await sharp({
      create: { width: 900, height: 600, channels: 3, background: { r: 180, g: 40, b: 90 } }
    })
      .withMetadata({ orientation: 6 })
      .jpeg({ quality: 90 })
      .toFile(portraitPath)

    const landBefore = sha256(landscapePath)
    const portBefore = sha256(portraitPath)

    const landRes = await decodeOriginalPhoto({
      sourcePath: landscapePath,
      approvedRoots: [workDir]
    })
    expect(landRes.status).toBe('ready')
    if (landRes.status === 'ready') {
      expect(landRes.width).toBe(1200)
      expect(landRes.height).toBe(800)
      expect(landRes.mimeType).toBe('image/webp')
    }

    const portRes = await decodeOriginalPhoto({
      sourcePath: portraitPath,
      approvedRoots: [workDir]
    })
    expect(portRes.status).toBe('ready')
    if (portRes.status === 'ready') {
      expect(portRes.width).toBe(600)
      expect(portRes.height).toBe(900)
    }

    expect(sha256(landscapePath)).toBe(landBefore)
    expect(sha256(portraitPath)).toBe(portBefore)
  })

  it('decodes HEIC fixtures preserving orientation and handles missing or corrupt files cleanly', async () => {
    const heicSrc = resolve(__dirname, '../fixtures/heic/portrait_exif6.heic')
    const heicCopy = join(workDir, 'portrait_exif6.heic')
    copyFileSync(heicSrc, heicCopy)
    const heicBefore = sha256(heicCopy)

    const heicRes = await decodeOriginalPhoto({
      sourcePath: heicCopy,
      approvedRoots: [workDir]
    })
    if (heicRes.status !== 'ready') {
      throw new Error(`Unexpected HEIC decode result: ${JSON.stringify(heicRes)}`)
    }
    expect(heicRes.status).toBe('ready')
    if (heicRes.status === 'ready') {
      expect(heicRes.height).toBeGreaterThan(heicRes.width)
    }
    expect(sha256(heicCopy)).toBe(heicBefore)

    const missingPath = join(workDir, 'gone.jpg')
    const missingRes = await decodeOriginalPhoto({
      sourcePath: missingPath,
      approvedRoots: [workDir]
    })
    expect(missingRes.status).toBe('error')
    if (missingRes.status === 'error') {
      expect(missingRes.message).toMatch(
        /Failed to resolve source path|ENOENT|no such file|not found/i
      )
    }

    const corruptPath = join(workDir, 'corrupt.jpg')
    writeFileSync(corruptPath, 'not-a-valid-jpeg')
    const corruptRes = await decodeOriginalPhoto({
      sourcePath: corruptPath,
      approvedRoots: [workDir]
    })
    expect(corruptRes.status).toBe('error')

    // Ensure missing after deletion also reports missing-file error
    unlinkSync(heicCopy)
    const deletedRes = await decodeOriginalPhoto({
      sourcePath: heicCopy,
      approvedRoots: [workDir]
    })
    expect(deletedRes.status).toBe('error')
  })
})
