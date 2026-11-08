/**
 * @vitest-environment node
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  mkdirSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
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
    const abandonedTmp = join(cacheDir, `.thumb_tmp_${process.pid}_${randomUUID()}`)
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

  it('cleans only demonstrably owned staging files and never touches unrelated files, subdirectories, or files with matching prefix', async () => {
    const cache = new ThumbnailDiskCache({ cacheDir, maxSizeBytes: 1024 * 1024 })
    const ownedTmp = join(
      cacheDir,
      `.thumb_tmp_${process.pid}_11111111-2222-3333-4444-555555555555`
    )
    const unrelatedPrefixFile = join(cacheDir, '.thumb_tmp_important_document.pdf')
    const unrelatedPrefixDir = join(cacheDir, '.thumb_tmp_directory')
    const otherTmp = join(cacheDir, 'other_file.tmp')

    mkdirSync(unrelatedPrefixDir, { recursive: true })
    writeFileSync(ownedTmp, 'owned staging')
    writeFileSync(unrelatedPrefixFile, 'keep this critical document')
    writeFileSync(otherTmp, 'keep this too')

    await cache.cleanupStagingFiles()

    expect(existsSync(ownedTmp)).toBe(false)
    expect(existsSync(unrelatedPrefixFile)).toBe(true) // Filename prefix alone MUST NOT authorize deletion
    expect(existsSync(unrelatedPrefixDir)).toBe(true) // Directories must never be deleted
    expect(existsSync(otherTmp)).toBe(true)
  })

  it('dynamically validates separation when sourceRoots or vaultPath changes after initialization', async () => {
    let dynamicRoots = [join(tempDir, 'sources')]
    let dynamicVault: string | null = null
    const cache = new ThumbnailDiskCache({
      cacheDir,
      sourceRoots: () => dynamicRoots,
      vaultPath: () => dynamicVault
    })

    const validWebp = await sharp({
      create: { width: 10, height: 10, channels: 3, background: { r: 1, g: 2, b: 3 } }
    })
      .webp()
      .toBuffer()
    const key = 'a'.repeat(64)
    await cache.put(key, validWebp)
    expect(await cache.get(key)).not.toBeNull()

    // Dynamically change source roots to overlap with cacheDir
    dynamicRoots = [cacheDir]

    // Subsequent operations must strictly reject due to separation violation
    await expect(cache.get(key)).rejects.toThrow(/overlaps/i)
    await expect(cache.put(key, validWebp)).rejects.toThrow(/overlaps/i)
    await expect(cache.cleanupStagingFiles()).rejects.toThrow(/overlaps/i)

    // Revert source roots, now change vault to overlap with cacheDir
    dynamicRoots = [join(tempDir, 'sources')]
    dynamicVault = cacheDir

    await expect(cache.get(key)).rejects.toThrow(/overlaps/i)
    await expect(cache.put(key, validWebp)).rejects.toThrow(/overlaps/i)
  })

  it('rejects path traversal or symlinks inside cache directory', async () => {
    const cache = new ThumbnailDiskCache({ cacheDir, maxSizeBytes: 1024 * 1024 })
    await expect(cache.get('../traversal')).rejects.toThrow()
    await expect(cache.get('valid64key/nested')).rejects.toThrow()
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

  it('rejects corrupt 30-byte header-only WebP buffers that pass basic header parsing but fail image integrity', async () => {
    const cache = new ThumbnailDiskCache({ cacheDir, maxSizeBytes: 1024 * 1024 })
    const key = cache.computeCacheKey({
      locationId: 99,
      sourcePath: join(tempDir, 'photo99.jpg'),
      sha256: '9'.repeat(64),
      byteSize: 3000,
      mtimeMs: 1700000000000
    })

    // Construct the reviewer's exact 30-byte buffer:
    // RIFF at 0, length 22 at 4, WEBP at 8, VP8-space at 12, length 10 at 16,
    // start code 0x9d, 0x01, 0x2a at 23-25, 1x1 dimensions at 26/28
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

    const thumbFile = join(cacheDir, `${key}.thumb`)
    writeFileSync(thumbFile, corrupt30Buf)

    // Must be rejected as corrupt, unlinked from disk, and return null
    const retrieved = await cache.get(key)
    expect(retrieved).toBeNull()
    expect(existsSync(thumbFile)).toBe(false)
  })

  it('rejects oversized entries before reading or allocating contents', async () => {
    const cache = new ThumbnailDiskCache({
      cacheDir,
      maxSizeBytes: 10 * 1024 * 1024,
      maxThumbnailSizeBytes: 1024 * 1024 // 1 MiB limit
    })
    const key = 'e'.repeat(64)

    // Oversized buffer on put (1.5 MiB)
    const oversizedBuf = Buffer.alloc(1.5 * 1024 * 1024)
    await expect(cache.put(key, oversizedBuf)).rejects.toThrow(/oversized|exceeds/i)

    // Pre-existing oversized file on disk should be rejected via stat check without allocating into memory
    const thumbFile = join(cacheDir, `${key}.thumb`)
    writeFileSync(thumbFile, Buffer.alloc(1.5 * 1024 * 1024))
    const retrieved = await cache.get(key)
    expect(retrieved).toBeNull()
    expect(existsSync(thumbFile)).toBe(false)
  })

  it('reserves capacity before staging and rejects entry when budget cannot accommodate it', async () => {
    const validWebp = await sharp({
      create: { width: 10, height: 10, channels: 3, background: { r: 1, g: 1, b: 1 } }
    })
      .webp()
      .toBuffer()

    // Budget smaller than the thumbnail size
    const tinyCache = new ThumbnailDiskCache({
      cacheDir,
      maxSizeBytes: validWebp.length - 10
    })

    const key = 'f'.repeat(64)
    await expect(tinyCache.put(key, validWebp)).rejects.toThrow(/budget|capacity/i)

    // Verify no temporary files were created or left behind
    const files = readdirSync(cacheDir)
    expect(files.filter((f) => f.startsWith('.thumb_tmp_'))).toHaveLength(0)
  })

  it('handles failed eviction safely without leaving staging files or claiming capacity', async () => {
    const validWebp = await sharp({
      create: { width: 10, height: 10, channels: 3, background: { r: 1, g: 1, b: 1 } }
    })
      .webp()
      .toBuffer()

    const cache = new ThumbnailDiskCache({
      cacheDir,
      maxSizeBytes: validWebp.length
    })

    const key1 = 'a'.repeat(64)
    const key2 = 'b'.repeat(64)
    await cache.put(key1, validWebp)

    process.env.PV_TEST_EVICTION_UNLINK_FAIL = '1'
    try {
      // Putting key2 requires evicting key1. Since key1 eviction fails, put must reject
      await expect(cache.put(key2, validWebp)).rejects.toThrow(/capacity|budget/i)

      // Verify no temporary staging files left behind
      const files = readdirSync(cacheDir)
      expect(files.filter((f) => f.startsWith('.thumb_tmp_'))).toHaveLength(0)
    } finally {
      delete process.env.PV_TEST_EVICTION_UNLINK_FAIL
    }
  })

  it('handles interrupted staging safely and leaves no orphan staging files', async () => {
    const validWebp = await sharp({
      create: { width: 10, height: 10, channels: 3, background: { r: 1, g: 1, b: 1 } }
    })
      .webp()
      .toBuffer()

    const cache = new ThumbnailDiskCache({
      cacheDir,
      maxSizeBytes: 1024 * 1024
    })

    const key = 'd'.repeat(64)
    process.env.PV_TEST_STAGING_FAILURE = '1'

    try {
      await expect(cache.put(key, validWebp)).rejects.toThrow(/ENOSPC/)
      // Staging file must have been cleaned up in the catch block
      const files = readdirSync(cacheDir)
      expect(files.filter((f) => f.startsWith('.thumb_tmp_'))).toHaveLength(0)
    } finally {
      delete process.env.PV_TEST_STAGING_FAILURE
    }
  })

  it('counts existing target bytes plus staging bytes during replacement and keeps disk usage within budget before publication', async () => {
    const validWebp = await sharp({
      create: { width: 10, height: 10, channels: 3, background: { r: 10, g: 20, b: 30 } }
    })
      .webp()
      .toBuffer()

    const budget = validWebp.length
    const cache = new ThumbnailDiskCache({
      cacheDir,
      maxSizeBytes: budget
    })

    const key = '1'.repeat(64)
    await cache.put(key, validWebp)
    expect(await cache.get(key)).not.toBeNull()

    const recordFile = join(tempDir, 'staging_usage.txt')
    process.env.PV_TEST_RECORD_STAGING_USAGE_FILE = recordFile

    try {
      // Put replacement
      await cache.put(key, validWebp)

      // Measure actual disk usage before publication
      expect(existsSync(recordFile)).toBe(true)
      const recordedUsage = parseInt(readFileSync(recordFile, 'utf8'), 10)

      // Reviewer reproduction check: under 100-byte budget, replacing 100-byte file must NOT hit 200 bytes!
      expect(recordedUsage).toBeLessThanOrEqual(budget)
    } finally {
      delete process.env.PV_TEST_RECORD_STAGING_USAGE_FILE
    }
  })
})
