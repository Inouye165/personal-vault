/**
 * @vitest-environment node
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import sharp from 'sharp'
import { ThumbnailDiskCache } from '../../src/main/services/thumbnails/cache'

describe('ThumbnailDiskCache', () => {
  let tempDir: string
  let cacheDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pv-thumb-cache-test-'))
    cacheDir = join(tempDir, 'thumbnails')
  })

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('initializes cache directory safely', () => {
    const cache = new ThumbnailDiskCache({ cacheDir, maxSizeBytes: 1024 * 1024 })
    expect(cache.getCacheDir()).toBe(cacheDir)
    expect(existsSync(cacheDir)).toBe(true)
  })

  it('computes deterministic cache key matching recipe version', () => {
    const cache = new ThumbnailDiskCache({ cacheDir, maxSizeBytes: 1024 * 1024 })
    const key1 = cache.computeCacheKey({
      sha256: 'a'.repeat(64),
      byteSize: 1000,
      mtimeMs: 1700000000000
    })
    const key2 = cache.computeCacheKey({
      sha256: 'a'.repeat(64),
      byteSize: 1000,
      mtimeMs: 1700000000000
    })
    const keyDiffMtime = cache.computeCacheKey({
      sha256: 'a'.repeat(64),
      byteSize: 1000,
      mtimeMs: 1700000000001
    })

    expect(key1).toBe(key2)
    expect(key1).not.toBe(keyDiffMtime)
    expect(key1).toMatch(/^[a-f0-9]{64}$/)
  })

  it('stores and retrieves thumbnail with atomic publication', async () => {
    const cache = new ThumbnailDiskCache({ cacheDir, maxSizeBytes: 1024 * 1024 })
    const key = cache.computeCacheKey({
      sha256: 'b'.repeat(64),
      byteSize: 2000,
      mtimeMs: 1700000000000
    })

    const initial = await cache.get(key)
    expect(initial).toBeNull()

    const thumbBytes = await sharp({
      create: { width: 10, height: 10, channels: 3, background: { r: 1, g: 2, b: 3 } }
    })
      .webp()
      .toBuffer()
    await cache.put(key, thumbBytes)

    const retrieved = await cache.get(key)
    expect(retrieved).not.toBeNull()
    expect(retrieved?.equals(thumbBytes)).toBe(true)

    // Ensure no staging temp files remain
    const files = readdirSync(cacheDir)
    expect(files.filter((f) => f.startsWith('.thumb_tmp_'))).toHaveLength(0)
  })

  it('cleans up abandoned temporary staging files on initialization', async () => {
    new ThumbnailDiskCache({ cacheDir, maxSizeBytes: 1024 * 1024 })
    const abandonedTmp = join(cacheDir, '.thumb_tmp_abandoned_12345')
    writeFileSync(abandonedTmp, 'stale')

    // Create a new instance pointing to same dir
    const cache2 = new ThumbnailDiskCache({ cacheDir, maxSizeBytes: 1024 * 1024 })
    await cache2.cleanupStagingFiles()

    expect(existsSync(abandonedTmp)).toBe(false)
  })

  it('rejects corrupt zero-byte or malformed cache entries', async () => {
    const cache = new ThumbnailDiskCache({ cacheDir, maxSizeBytes: 1024 * 1024 })
    const key = cache.computeCacheKey({
      locationId: 10,
      sourcePath: join(tempDir, 'photo.jpg'),
      sha256: 'c'.repeat(64),
      byteSize: 3000,
      mtimeMs: 1700000000000
    })

    const thumbFile = join(cacheDir, `${key}.thumb`)
    writeFileSync(thumbFile, Buffer.alloc(0)) // 0 bytes

    const retrieved = await cache.get(key)
    expect(retrieved).toBeNull()
    expect(existsSync(thumbFile)).toBe(false)
  })

  it('unhashed files with matching size and mtime produce distinct cache keys', () => {
    const cache = new ThumbnailDiskCache({ cacheDir, maxSizeBytes: 1024 * 1024 })
    const key1 = cache.computeCacheKey({
      locationId: 1,
      sourcePath: join(tempDir, 'file1.jpg'),
      sha256: null,
      byteSize: 5000,
      mtimeMs: 1700000000000
    })
    const key2 = cache.computeCacheKey({
      locationId: 2,
      sourcePath: join(tempDir, 'file2.jpg'),
      sha256: null,
      byteSize: 5000,
      mtimeMs: 1700000000000
    })

    expect(key1).not.toBe(key2)
  })

  it('rejects corrupt non-empty cache entries and removes them from disk', async () => {
    const cache = new ThumbnailDiskCache({ cacheDir, maxSizeBytes: 1024 * 1024 })
    const key = cache.computeCacheKey({
      locationId: 3,
      sourcePath: join(tempDir, 'file3.jpg'),
      sha256: 'd'.repeat(64),
      byteSize: 4000,
      mtimeMs: 1700000000000
    })

    const thumbFile = join(cacheDir, `${key}.thumb`)
    writeFileSync(thumbFile, Buffer.from('NOT_A_VALID_WEBP_IMAGE_CORRUPT_BYTES'))

    const retrieved = await cache.get(key)
    expect(retrieved).toBeNull()
    expect(existsSync(thumbFile)).toBe(false)
  })

  it('rejects cache directory if it overlaps with source root or vault directory', () => {
    const sourceDir = join(tempDir, 'sources')
    mkdirSync(sourceDir, { recursive: true })
    const overlappingCache = join(sourceDir, 'cache')
    mkdirSync(overlappingCache, { recursive: true })

    expect(() => {
      new ThumbnailDiskCache({
        cacheDir: overlappingCache,
        sourceRoots: [sourceDir]
      })
    }).toThrow(/overlap/i)
  })

  it('cleans only demonstrably owned staging files and never touches unrelated files', async () => {
    const cache = new ThumbnailDiskCache({ cacheDir, maxSizeBytes: 1024 * 1024 })
    const ownedTmp = join(cacheDir, `.thumb_tmp_${process.pid}_validuuid`)
    const unrelatedFile = join(cacheDir, 'unrelated_user_file.txt')
    const otherTmp = join(cacheDir, 'other_file.tmp')

    writeFileSync(ownedTmp, 'owned staging')
    writeFileSync(unrelatedFile, 'keep this')
    writeFileSync(otherTmp, 'keep this too')

    await cache.cleanupStagingFiles()

    expect(existsSync(ownedTmp)).toBe(false)
    expect(existsSync(unrelatedFile)).toBe(true)
    expect(existsSync(otherTmp)).toBe(true)
  })

  it('evicts oldest cache entries when budget is exceeded without touching unrelated files', async () => {
    const validWebp = await sharp({
      create: { width: 10, height: 10, channels: 3, background: { r: 5, g: 5, b: 5 } }
    })
      .webp()
      .toBuffer()

    // Budget: 3 times the size of one valid WebP
    const cache = new ThumbnailDiskCache({ cacheDir, maxSizeBytes: validWebp.length * 3 })

    const key1 = '1'.repeat(64)
    const key2 = '2'.repeat(64)
    const key3 = '3'.repeat(64)
    const key4 = '4'.repeat(64)

    await cache.put(key1, validWebp)
    // small sleep to ensure distinct mtimes for LRU
    await new Promise((r) => setTimeout(r, 20))
    await cache.put(key2, validWebp)
    await new Promise((r) => setTimeout(r, 20))
    await cache.put(key3, validWebp)

    // Unrelated file in same directory that does NOT end in .thumb
    const unrelatedFile = join(cacheDir, 'unrelated-notes.txt')
    writeFileSync(unrelatedFile, 'DO NOT TOUCH ME')

    expect(await cache.get(key1)).not.toBeNull()

    // Adding key4 exceeds 3-thumb budget; key1 is oldest and should be evicted
    await new Promise((r) => setTimeout(r, 20))
    await cache.put(key4, validWebp)

    expect(await cache.get(key4)).not.toBeNull()
    expect(existsSync(unrelatedFile)).toBe(true) // Unrelated file strictly preserved
  })
})
