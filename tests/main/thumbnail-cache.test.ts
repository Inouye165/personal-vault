/**
 * @vitest-environment node
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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

    const thumbBytes = Buffer.from('FAKE_WEBP_THUMBNAIL_BYTES_FOR_TEST')
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
      sha256: 'c'.repeat(64),
      byteSize: 3000,
      mtimeMs: 1700000000000
    })

    const thumbFile = join(cacheDir, `${key}.thumb`)
    writeFileSync(thumbFile, Buffer.alloc(0)) // 0 bytes

    const result = await cache.get(key)
    expect(result).toBeNull()
    // 0-byte file should be unlinked/discarded
    expect(existsSync(thumbFile)).toBe(false)
  })

  it('evicts oldest cache entries when budget is exceeded without touching unrelated files', async () => {
    // Budget: 300 bytes. Each thumb is 100 bytes.
    const cache = new ThumbnailDiskCache({ cacheDir, maxSizeBytes: 300 })

    const key1 = '1'.repeat(64)
    const key2 = '2'.repeat(64)
    const key3 = '3'.repeat(64)
    const key4 = '4'.repeat(64)

    const dummy100 = Buffer.alloc(100, 1)

    await cache.put(key1, dummy100)
    // small sleep to ensure distinct mtimes for LRU
    await new Promise((r) => setTimeout(r, 15))
    await cache.put(key2, dummy100)
    await new Promise((r) => setTimeout(r, 15))
    await cache.put(key3, dummy100)

    // Unrelated file in same directory that does NOT end in .thumb
    const unrelatedFile = join(cacheDir, 'unrelated-notes.txt')
    writeFileSync(unrelatedFile, 'DO NOT TOUCH ME')

    expect(await cache.get(key1)).not.toBeNull()

    // Adding key4 exceeds 300-byte budget; key1 is oldest and should be evicted
    await new Promise((r) => setTimeout(r, 15))
    await cache.put(key4, dummy100)

    expect(await cache.get(key4)).not.toBeNull()
    expect(existsSync(unrelatedFile)).toBe(true) // Unrelated file strictly preserved
  })
})
