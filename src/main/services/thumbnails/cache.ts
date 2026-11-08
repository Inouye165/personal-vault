/**
 * Personal Vault — Disposable Disk Cache for Thumbnails (Stage 5A)
 *
 * Implements bounded, atomic, disposable thumbnail disk storage with
 * LRU eviction obeying strict budget limits. Never deletes or mutates
 * source files, vault files, or unrelated items.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import {
  THUMBNAIL_LIMITS,
  type ThumbnailCacheKeyParams,
  type ThumbnailDiskCacheOptions
} from './types'

export class ThumbnailDiskCache {
  private readonly cacheDir: string
  private readonly maxSizeBytes: number

  constructor(options: ThumbnailDiskCacheOptions) {
    if (!options.cacheDir || typeof options.cacheDir !== 'string') {
      throw new TypeError('cacheDir must be a non-empty string')
    }
    this.cacheDir = resolve(options.cacheDir)
    this.maxSizeBytes = options.maxSizeBytes ?? THUMBNAIL_LIMITS.DISK_CACHE_BUDGET_BYTES

    if (!existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, { recursive: true })
    }
  }

  public getCacheDir(): string {
    return this.cacheDir
  }

  /**
   * Deterministically computes a 64-hex SHA-256 cache key including content hash,
   * size, mtime, and decoder recipe version.
   */
  public computeCacheKey(params: ThumbnailCacheKeyParams): string {
    const content = `${params.sha256 ?? 'unhashed'}:${params.byteSize}:${params.mtimeMs ?? 'nomtime'}:${THUMBNAIL_LIMITS.RECIPE_VERSION}`
    return createHash('sha256').update(content).digest('hex')
  }

  /**
   * Reads a cached thumbnail by key. Returns null if missing or corrupted.
   */
  public async get(key: string): Promise<Buffer | null> {
    this.assertValidKey(key)
    const filePath = join(this.cacheDir, `${key}.thumb`)

    if (!existsSync(filePath)) {
      return null
    }

    try {
      const stat = statSync(filePath)
      if (stat.size === 0) {
        // Discard 0-byte corrupt entry
        try {
          unlinkSync(filePath)
        } catch {
          // ignore
        }
        return null
      }

      const buf = readFileSync(filePath)
      if (buf.length === 0) {
        try {
          unlinkSync(filePath)
        } catch {
          // ignore
        }
        return null
      }

      // Update access time for LRU tracking
      try {
        const now = new Date()
        utimesSync(filePath, now, now)
      } catch {
        // Non-fatal if touch fails
      }

      return buf
    } catch {
      return null
    }
  }

  /**
   * Atomically stores a thumbnail buffer under the given key.
   */
  public async put(key: string, buffer: Buffer): Promise<void> {
    this.assertValidKey(key)
    if (!buffer || buffer.length === 0) {
      throw new Error('Cannot cache empty thumbnail buffer')
    }

    const tempName = `.thumb_tmp_${randomUUID()}`
    const tempPath = join(this.cacheDir, tempName)
    const targetPath = join(this.cacheDir, `${key}.thumb`)

    try {
      // Exclusive creation to prevent collisions
      writeFileSync(tempPath, buffer, { flag: 'wx' })

      // Verify written size
      const stat = statSync(tempPath)
      if (stat.size !== buffer.length) {
        throw new Error('Staging thumbnail write incomplete')
      }

      // Atomic publication
      renameSync(tempPath, targetPath)

      // Evict older entries if budget exceeded
      this.evictIfNeeded()
    } catch (err) {
      try {
        if (existsSync(tempPath)) {
          unlinkSync(tempPath)
        }
      } catch {
        // ignore
      }
      throw err
    }
  }

  /**
   * Cleans up abandoned temporary staging files demonstrably owned by this cache.
   */
  public async cleanupStagingFiles(): Promise<void> {
    try {
      const files = readdirSync(this.cacheDir)
      for (const file of files) {
        if (file.startsWith('.thumb_tmp_')) {
          const fullPath = join(this.cacheDir, file)
          try {
            unlinkSync(fullPath)
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }
  }

  /**
   * Evicts oldest app-owned `.thumb` files if cache exceeds the configured budget.
   * Strictly never touches unrelated files or files outside cacheDir.
   */
  private evictIfNeeded(): void {
    try {
      const files = readdirSync(this.cacheDir)
      const thumbEntries: Array<{ name: string; fullPath: string; size: number; mtimeMs: number }> =
        []
      let totalBytes = 0

      for (const file of files) {
        // Strictly only touch valid 64-hex .thumb files
        if (/^[a-f0-9]{64}\.thumb$/.test(file)) {
          const fullPath = join(this.cacheDir, file)
          try {
            const st = statSync(fullPath)
            thumbEntries.push({
              name: file,
              fullPath,
              size: st.size,
              mtimeMs: st.mtimeMs
            })
            totalBytes += st.size
          } catch {
            // skip if stat fails
          }
        }
      }

      if (totalBytes <= this.maxSizeBytes) {
        return
      }

      // Sort by mtime ascending (oldest first)
      thumbEntries.sort((a, b) => a.mtimeMs - b.mtimeMs)

      for (const entry of thumbEntries) {
        if (totalBytes <= this.maxSizeBytes) {
          break
        }
        try {
          unlinkSync(entry.fullPath)
          totalBytes -= entry.size
        } catch {
          // ignore
        }
      }
    } catch {
      // Non-fatal if eviction check fails
    }
  }

  private assertValidKey(key: string): void {
    if (!key || typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) {
      throw new Error(`Invalid thumbnail cache key: ${String(key)}`)
    }
  }
}
