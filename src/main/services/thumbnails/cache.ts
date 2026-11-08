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
  lstatSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  realpathSync
} from 'node:fs'
import { join, resolve, dirname, parse, relative, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import {
  THUMBNAIL_LIMITS,
  type ThumbnailCacheKeyParams,
  type ThumbnailDiskCacheOptions
} from './types'

export function readWebPDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (!buffer || buffer.length < 30) return null
  const riff = buffer.toString('ascii', 0, 4)
  const webp = buffer.toString('ascii', 8, 12)
  if (riff !== 'RIFF' || webp !== 'WEBP') {
    return null
  }
  const chunkHeader = buffer.toString('ascii', 12, 16)
  if (chunkHeader === 'VP8 ') {
    if (buffer.length < 30) return null
    const width = buffer.readUInt16LE(26) & 0x3fff
    const height = buffer.readUInt16LE(28) & 0x3fff
    if (width === 0 || height === 0) return null
    return { width, height }
  } else if (chunkHeader === 'VP8L') {
    if (buffer.length < 25) return null
    const b0 = buffer[21] ?? 0
    const b1 = buffer[22] ?? 0
    const b2 = buffer[23] ?? 0
    const b3 = buffer[24] ?? 0
    const width = 1 + (((b1 & 0x3f) << 8) | b0)
    const height = 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6))
    if (width === 0 || height === 0) return null
    return { width, height }
  } else if (chunkHeader === 'VP8X') {
    if (buffer.length < 30) return null
    const width = 1 + buffer.readUIntLE(24, 3)
    const height = 1 + buffer.readUIntLE(27, 3)
    if (width === 0 || height === 0) return null
    return { width, height }
  }
  return null
}

function assertCacheDirContainment(cacheDir: string): void {
  const resolved = resolve(cacheDir)
  const root = parse(resolved).root
  let current = root
  const rel = relative(root, resolved)
  if (rel) {
    const parts = rel.split(sep)
    for (const part of parts) {
      current = join(current, part)
      if (existsSync(current)) {
        const st = lstatSync(current)
        if (st.isSymbolicLink()) {
          throw new Error(
            `Symlink or junction redirection rejected in cache path segment: "${current}"`
          )
        }
      }
    }
  }
}

function validateCacheSeparation(
  cacheDir: string,
  sourceRoots?: readonly string[] | (() => readonly string[]),
  vaultPath?: string | (() => string | null)
): void {
  let canonicalCache: string
  try {
    canonicalCache = realpathSync(cacheDir)
  } catch {
    canonicalCache = resolve(cacheDir)
  }

  const effectiveRoots = typeof sourceRoots === 'function' ? sourceRoots() : sourceRoots
  if (effectiveRoots) {
    for (const root of effectiveRoots) {
      let canonicalRoot: string
      try {
        canonicalRoot = realpathSync(root)
      } catch {
        canonicalRoot = resolve(root)
      }
      if (
        canonicalCache === canonicalRoot ||
        canonicalCache.startsWith(canonicalRoot + '\\') ||
        canonicalCache.startsWith(canonicalRoot + '/') ||
        canonicalRoot.startsWith(canonicalCache + '\\') ||
        canonicalRoot.startsWith(canonicalCache + '/')
      ) {
        throw new Error(`Cache directory "${cacheDir}" overlaps with source root "${root}"`)
      }
    }
  }

  const effectiveVault = typeof vaultPath === 'function' ? vaultPath() : vaultPath
  if (effectiveVault) {
    let canonicalVault: string
    try {
      canonicalVault = realpathSync(effectiveVault)
    } catch {
      canonicalVault = resolve(effectiveVault)
    }
    if (
      canonicalCache === canonicalVault ||
      canonicalCache.startsWith(canonicalVault + '\\') ||
      canonicalCache.startsWith(canonicalVault + '/') ||
      canonicalVault.startsWith(canonicalCache + '\\') ||
      canonicalVault.startsWith(canonicalCache + '/')
    ) {
      throw new Error(
        `Cache directory "${cacheDir}" overlaps with vault directory "${effectiveVault}"`
      )
    }
  }
}

export class ThumbnailDiskCache {
  private readonly cacheDir: string
  private readonly maxSizeBytes: number
  private readonly sourceRoots?: readonly string[] | (() => readonly string[])
  private readonly vaultPath?: string | (() => string | null)

  constructor(options: ThumbnailDiskCacheOptions) {
    if (!options.cacheDir || typeof options.cacheDir !== 'string') {
      throw new TypeError('cacheDir must be a non-empty string')
    }
    this.cacheDir = resolve(options.cacheDir)
    this.maxSizeBytes = options.maxSizeBytes ?? THUMBNAIL_LIMITS.DISK_CACHE_BUDGET_BYTES
    this.sourceRoots = options.sourceRoots
    this.vaultPath = options.vaultPath

    this.assertSeparationAndContainment()

    if (!existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, { recursive: true })
    }
  }

  private assertSeparationAndContainment(): void {
    assertCacheDirContainment(this.cacheDir)
    validateCacheSeparation(this.cacheDir, this.sourceRoots, this.vaultPath)
  }

  public getCacheDir(): string {
    return this.cacheDir
  }

  /**
   * Deterministically computes a 64-hex SHA-256 cache key including content hash,
   * size, mtime, and decoder recipe version. Unhashed files bind to locationId
   * and normalized source path to prevent cross-file cache collision.
   */
  public computeCacheKey(params: ThumbnailCacheKeyParams): string {
    let identity: string
    if (params.sha256 && params.sha256.length === 64) {
      identity = `hash:${params.sha256.toLowerCase()}:${params.byteSize}:${params.mtimeMs ?? 'nomtime'}`
    } else {
      const locId = params.locationId !== undefined ? String(params.locationId) : 'noloc'
      const normPath = params.sourcePath ? resolve(params.sourcePath).toLowerCase() : 'nopath'
      identity = `unhashed:${locId}:${normPath}:${params.byteSize}:${params.mtimeMs ?? 'nomtime'}`
    }
    const content = `${identity}:${THUMBNAIL_LIMITS.RECIPE_VERSION}`
    return createHash('sha256').update(content).digest('hex')
  }

  /**
   * Reads a cached thumbnail by key. Validates WebP integrity; returns null
   * and unlinks corrupt or empty cache files.
   */
  public async get(key: string): Promise<Buffer | null> {
    this.assertValidKey(key)
    this.assertSeparationAndContainment()
    const filePath = join(this.cacheDir, `${key}.thumb`)

    if (!existsSync(filePath)) {
      return null
    }

    try {
      const lstat = lstatSync(filePath)
      if (lstat.isSymbolicLink() || !lstat.isFile()) {
        try {
          unlinkSync(filePath)
        } catch {
          // ignore
        }
        return null
      }

      if (lstat.size === 0) {
        try {
          unlinkSync(filePath)
        } catch {
          // ignore
        }
        return null
      }

      const buf = readFileSync(filePath)
      if (buf.length === 0 || readWebPDimensions(buf) === null) {
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
    this.assertSeparationAndContainment()
    if (!buffer || buffer.length === 0) {
      throw new Error('Cannot cache empty thumbnail buffer')
    }

    // Validate buffer integrity before caching
    if (readWebPDimensions(buffer) === null) {
      throw new Error('Cannot cache invalid or corrupt WebP thumbnail buffer')
    }

    const tempName = `.thumb_tmp_${process.pid}_${randomUUID()}`
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

      // Narrowly scoped test fixture barrier for deterministic publication interruption
      const barrierSignalFile = process.env.PV_TEST_PUBLICATION_BARRIER_SIGNAL
      if (barrierSignalFile) {
        try {
          writeFileSync(barrierSignalFile, `${tempPath}\n${targetPath}`)
        } catch {
          // ignore
        }
        if (process.env.PV_TEST_PUBLICATION_BARRIER_HOLD === '1') {
          const releaseFile = process.env.PV_TEST_PUBLICATION_BARRIER_RELEASE
          const deadline = Date.now() + 10000
          while (Date.now() < deadline) {
            if (releaseFile && existsSync(releaseFile)) {
              break
            }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
          }
        }
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
   * Strictly never touches unrelated files, symlinks, or directories.
   */
  public async cleanupStagingFiles(): Promise<void> {
    this.assertSeparationAndContainment()
    try {
      const files = readdirSync(this.cacheDir)
      for (const file of files) {
        // Strictly only target owned staging files matching .thumb_tmp_<pid>_<uuid>
        if (
          /^\.thumb_tmp_\d+_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
            file
          )
        ) {
          const fullPath = join(this.cacheDir, file)
          try {
            if (dirname(fullPath) === this.cacheDir) {
              const st = lstatSync(fullPath)
              if (st.isFile() && !st.isSymbolicLink() && !st.isDirectory()) {
                unlinkSync(fullPath)
              }
            }
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
            if (dirname(fullPath) === this.cacheDir) {
              const st = lstatSync(fullPath)
              if (st.isFile() && !st.isSymbolicLink()) {
                thumbEntries.push({
                  name: file,
                  fullPath,
                  size: st.size,
                  mtimeMs: st.mtimeMs
                })
                totalBytes += st.size
              }
            }
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
