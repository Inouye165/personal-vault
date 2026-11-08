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
import sharp from 'sharp'
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

export async function validateWebPIntegrity(
  buffer: Buffer,
  maxBytes: number = THUMBNAIL_LIMITS.MAX_THUMBNAIL_BYTES
): Promise<{ width: number; height: number } | null> {
  if (!buffer || buffer.length < 30 || buffer.length > maxBytes) {
    return null
  }
  const dims = readWebPDimensions(buffer)
  if (
    !dims ||
    dims.width <= 0 ||
    dims.height <= 0 ||
    dims.width > THUMBNAIL_LIMITS.MAX_DIMENSION_PX ||
    dims.height > THUMBNAIL_LIMITS.MAX_DIMENSION_PX
  ) {
    return null
  }
  try {
    const meta = await sharp(buffer).metadata()
    if (
      meta.format !== 'webp' ||
      !meta.width ||
      !meta.height ||
      meta.width > THUMBNAIL_LIMITS.MAX_DIMENSION_PX ||
      meta.height > THUMBNAIL_LIMITS.MAX_DIMENSION_PX
    ) {
      return null
    }
    await sharp(buffer).stats()
    return { width: meta.width, height: meta.height }
  } catch {
    return null
  }
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
  private readonly maxThumbnailSizeBytes: number
  private readonly sourceRoots?: readonly string[] | (() => readonly string[])
  private readonly vaultPath?: string | (() => string | null)
  private readonly customValidator?:
    | ((
        buffer: Buffer
      ) =>
        | Promise<{ width: number; height: number } | null>
        | { width: number; height: number }
        | null)
    | false
  private putQueue: Promise<void> = Promise.resolve()

  constructor(options: ThumbnailDiskCacheOptions) {
    if (!options.cacheDir || typeof options.cacheDir !== 'string') {
      throw new TypeError('cacheDir must be a non-empty string')
    }
    this.cacheDir = resolve(options.cacheDir)
    this.maxSizeBytes = options.maxSizeBytes ?? THUMBNAIL_LIMITS.DISK_CACHE_BUDGET_BYTES
    this.maxThumbnailSizeBytes =
      options.maxThumbnailSizeBytes ?? THUMBNAIL_LIMITS.MAX_THUMBNAIL_BYTES
    this.sourceRoots = options.sourceRoots
    this.vaultPath = options.vaultPath
    this.customValidator = options.validateBuffer

    this.assertSeparationAndContainment()

    if (!existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, { recursive: true })
    }
  }

  private async validateIntegrity(
    buffer: Buffer
  ): Promise<{ width: number; height: number } | null> {
    if (this.customValidator === false) {
      return readWebPDimensions(buffer)
    }
    if (typeof this.customValidator === 'function') {
      try {
        return await this.customValidator(buffer)
      } catch {
        return null
      }
    }
    return validateWebPIntegrity(buffer, this.maxThumbnailSizeBytes)
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

      if (lstat.size === 0 || lstat.size > this.maxThumbnailSizeBytes) {
        try {
          unlinkSync(filePath)
        } catch {
          // ignore
        }
        return null
      }

      const buf = readFileSync(filePath)
      if (buf.length === 0 || buf.length > this.maxThumbnailSizeBytes) {
        try {
          unlinkSync(filePath)
        } catch {
          // ignore
        }
        return null
      }

      const dims = await this.validateIntegrity(buf)
      if (!dims) {
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
   * Deletes a cached thumbnail file by key if it exists.
   */
  public delete(key: string): void {
    this.assertValidKey(key)
    this.assertSeparationAndContainment()
    const filePath = join(this.cacheDir, `${key}.thumb`)
    if (existsSync(filePath)) {
      try {
        unlinkSync(filePath)
      } catch {
        // ignore
      }
    }
  }

  /**
   * Atomically stores a thumbnail buffer under the given key.
   * Serializes concurrent put operations to prevent budget races.
   */
  public async put(key: string, buffer: Buffer): Promise<void> {
    const previous = this.putQueue
    let releaseLock!: () => void
    this.putQueue = new Promise<void>((r) => {
      releaseLock = r
    })
    try {
      await previous
      await this.executePut(key, buffer)
    } finally {
      releaseLock()
    }
  }

  private async executePut(key: string, buffer: Buffer): Promise<void> {
    this.assertValidKey(key)
    this.assertSeparationAndContainment()
    if (!buffer || buffer.length === 0) {
      throw new Error('Cannot cache empty thumbnail buffer')
    }

    if (buffer.length > this.maxThumbnailSizeBytes) {
      throw new Error(
        `Thumbnail buffer size (${buffer.length} bytes) exceeds maximum allowed size (${this.maxThumbnailSizeBytes} bytes)`
      )
    }

    // Validate buffer integrity before caching
    const dims = await this.validateIntegrity(buffer)
    if (!dims) {
      throw new Error('Cannot cache invalid or corrupt WebP thumbnail buffer')
    }

    // Reserve capacity before creating temporary staging files (counts existing target and staging bytes)
    this.reserveCapacity(buffer.length)

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

      if (process.env.PV_TEST_STAGING_FAILURE === '1') {
        throw new Error('Simulated staging disk failure: ENOSPC')
      }

      const usageRecordFile = process.env.PV_TEST_RECORD_STAGING_USAGE_FILE
      if (usageRecordFile) {
        try {
          const files = readdirSync(this.cacheDir)
          let currentBytes = 0
          for (const f of files) {
            currentBytes += statSync(join(this.cacheDir, f)).size
          }
          writeFileSync(usageRecordFile, String(currentBytes))
        } catch {
          // ignore
        }
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

      // Atomic publication with Windows retry for delete-pending / handle-release latency
      this.publishFile(tempPath, targetPath)
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

  private publishFile(tempPath: string, targetPath: string): void {
    const isWindows = process.platform === 'win32'
    const maxAttempts = isWindows ? 8 : 1
    let lastErr: unknown

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        renameSync(tempPath, targetPath)
        return
      } catch (err: unknown) {
        lastErr = err
        const code = (err as NodeJS.ErrnoException)?.code
        if (
          isWindows &&
          (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') &&
          attempt < maxAttempts - 1
        ) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15 * (attempt + 1))
          continue
        }
        throw err
      }
    }
    throw lastErr
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
   * Returns all demonstrably app-owned disk entries (both .thumb and .thumb_tmp_ files)
   * in the cache directory.
   */
  private getOwnedDiskEntries(): {
    thumbs: Array<{ name: string; fullPath: string; size: number; mtimeMs: number }>
    stagingBytes: number
    totalOwnedBytes: number
  } {
    const thumbs: Array<{ name: string; fullPath: string; size: number; mtimeMs: number }> = []
    let stagingBytes = 0
    let totalOwnedBytes = 0

    if (!existsSync(this.cacheDir)) {
      return { thumbs, stagingBytes, totalOwnedBytes: 0 }
    }

    try {
      const files = readdirSync(this.cacheDir)
      for (const file of files) {
        if (/^[0-9a-fA-F]{64}\.thumb$/.test(file)) {
          const fullPath = join(this.cacheDir, file)
          try {
            if (dirname(fullPath) === this.cacheDir) {
              const st = lstatSync(fullPath)
              if (st.isFile() && !st.isSymbolicLink() && !st.isDirectory()) {
                thumbs.push({
                  name: file,
                  fullPath,
                  size: st.size,
                  mtimeMs: st.mtimeMs
                })
                totalOwnedBytes += st.size
              }
            }
          } catch {
            // skip
          }
        } else if (
          /^\.thumb_tmp_\d+_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
            file
          )
        ) {
          const fullPath = join(this.cacheDir, file)
          try {
            if (dirname(fullPath) === this.cacheDir) {
              const st = lstatSync(fullPath)
              if (st.isFile() && !st.isSymbolicLink() && !st.isDirectory()) {
                stagingBytes += st.size
                totalOwnedBytes += st.size
              }
            }
          } catch {
            // skip
          }
        }
      }
    } catch {
      // ignore
    }

    return { thumbs, stagingBytes, totalOwnedBytes }
  }

  /**
   * Reserves capacity in the cache before staging/publication.
   * Evicts oldest app-owned `.thumb` files if needed.
   * Counts existing target bytes and staging bytes.
   * Throws if the required capacity exceeds total budget or eviction fails to free enough space.
   */
  private reserveCapacity(neededBytes: number): void {
    if (neededBytes > this.maxSizeBytes) {
      throw new Error(
        `Required thumbnail capacity (${neededBytes} bytes) exceeds total disk cache budget (${this.maxSizeBytes} bytes)`
      )
    }

    const { thumbs, totalOwnedBytes } = this.getOwnedDiskEntries()
    let currentBytes = totalOwnedBytes

    if (currentBytes + neededBytes <= this.maxSizeBytes) {
      return
    }

    // Sort by mtime ascending (oldest first)
    thumbs.sort((a, b) => a.mtimeMs - b.mtimeMs)

    for (const entry of thumbs) {
      if (currentBytes + neededBytes <= this.maxSizeBytes) {
        break
      }
      try {
        if (process.env.PV_TEST_EVICTION_UNLINK_FAIL === '1') {
          throw new Error('EPERM: operation not permitted, unlink')
        }
        unlinkSync(entry.fullPath)
        currentBytes -= entry.size
      } catch {
        // Failed eviction of this file; cannot subtract
      }
    }

    if (currentBytes + neededBytes > this.maxSizeBytes) {
      throw new Error(
        `Failed to free sufficient capacity in cache: needed ${neededBytes} bytes, current total ${currentBytes} bytes exceeds budget ${this.maxSizeBytes} bytes`
      )
    }
  }

  private assertValidKey(key: string): void {
    if (!key || typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) {
      throw new Error(`Invalid thumbnail cache key: ${String(key)}`)
    }
  }
}
