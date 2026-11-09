/**
 * Personal Vault — Thumbnail Decoder (Stage 5A)
 *
 * Implements bounded, read-only source inspection, streaming SHA-256 validation,
 * format checking, and Sharp resizing with orientation preservation.
 */

import { open } from 'node:fs/promises'
import { realpathSync, lstatSync } from 'node:fs'
import { extname } from 'node:path'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { THUMBNAIL_LIMITS } from './types'
import { extractDHash64FromImageBuffer } from '../similarity/fingerprint'

// Configure sharp bounds
sharp.concurrency(1)
sharp.cache({ memory: 32, files: 0, items: 100 })

export interface DecodeInputParams {
  readonly sourcePath: string
  readonly expectedByteSize?: number
  readonly expectedMtimeMs?: number | null
  readonly expectedSha256?: string | null
  readonly maxDimension?: number
  readonly maxInputPixels?: number
  readonly maxSourceSizeBytes?: number
  readonly approvedRoots?: readonly string[]
}

export type DecodeResult =
  | {
      readonly status: 'ready'
      readonly buffer: Buffer
      readonly mimeType: string
      readonly width: number
      readonly height: number
    }
  | {
      readonly status: 'unsupported'
      readonly reason: string
    }
  | {
      readonly status: 'error'
      readonly code: string
      readonly message: string
    }

const SUPPORTED_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.jpe',
  '.jfif',
  '.png',
  '.webp',
  '.gif',
  '.avif',
  '.tif',
  '.tiff'
])

const HEIC_EXTENSIONS = new Set(['.heic', '.heif'])
const RAW_EXTENSIONS = new Set([
  '.cr2',
  '.cr3',
  '.nef',
  '.nrw',
  '.arw',
  '.srf',
  '.sr2',
  '.dng',
  '.rw2',
  '.raf',
  '.orf',
  '.pef',
  '.rwl'
])
const SVG_EXTENSIONS = new Set(['.svg', '.svgz'])

export type ReadSourceFileResult =
  | {
      readonly status: 'success'
      readonly fileBuffer: Buffer
      readonly computedSha256: string
    }
  | {
      readonly status: 'unsupported'
      readonly reason: string
    }
  | {
      readonly status: 'error'
      readonly code: string
      readonly message: string
    }

export type FingerprintDecodeResult =
  | {
      readonly status: 'ready'
      readonly fingerprint: string
      readonly bucket0: number
      readonly bucket1: number
      readonly bucket2: number
      readonly bucket3: number
      readonly width: number
      readonly height: number
      readonly algorithmVersion: string
      readonly computedSha256: string
    }
  | {
      readonly status: 'unsupported'
      readonly reason: string
    }
  | {
      readonly status: 'error'
      readonly code: string
      readonly message: string
    }

export async function readAndVerifySourceFile(
  params: DecodeInputParams
): Promise<ReadSourceFileResult> {
  const {
    sourcePath,
    expectedByteSize,
    expectedMtimeMs,
    expectedSha256,
    maxSourceSizeBytes = THUMBNAIL_LIMITS.MAX_SOURCE_SIZE_BYTES,
    approvedRoots
  } = params

  // 1. Root containment check if approved roots are supplied
  if (approvedRoots && approvedRoots.length > 0) {
    try {
      const canonicalSource = realpathSync(sourcePath)
      const isContained = approvedRoots.some((root) => {
        try {
          const canonicalRoot = realpathSync(root)
          return (
            canonicalSource === canonicalRoot ||
            canonicalSource.startsWith(canonicalRoot + '\\') ||
            canonicalSource.startsWith(canonicalRoot + '/')
          )
        } catch {
          return false
        }
      })
      if (!isContained) {
        return {
          status: 'error',
          code: 'ACCESS_DENIED',
          message: `Source path is outside approved roots: ${sourcePath}`
        }
      }
    } catch {
      return {
        status: 'error',
        code: 'ACCESS_DENIED',
        message: `Failed to resolve source path: ${sourcePath}`
      }
    }
  }

  // 2. Format / extension policy
  const ext = extname(sourcePath).toLowerCase()
  if (HEIC_EXTENSIONS.has(ext)) {
    return {
      status: 'unsupported',
      reason: 'HEIC format decoding requires unsupported external toolchains'
    }
  }
  if (RAW_EXTENSIONS.has(ext)) {
    return {
      status: 'unsupported',
      reason: 'RAW camera formats require unsupported external toolchains'
    }
  }
  if (SVG_EXTENSIONS.has(ext)) {
    return {
      status: 'unsupported',
      reason: 'SVG vector graphics cannot be rendered as raster thumbnails'
    }
  }
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    return {
      status: 'unsupported',
      reason: `Unsupported image format: ${ext || 'unknown'}`
    }
  }

  // 3. Descriptor pre-read, streaming read, and post-read verification
  let handle
  let fileBuffer: Buffer
  let canonicalPath: string
  let preLstat: import('node:fs').Stats
  let computedSha256: string
  try {
    preLstat = lstatSync(sourcePath)
    if (preLstat.isSymbolicLink() || !preLstat.isFile()) {
      return {
        status: 'error',
        code: 'NOT_A_REGULAR_FILE',
        message: 'Source is not a regular file or is a symbolic link'
      }
    }
    canonicalPath = realpathSync(sourcePath)

    if (preLstat.size > maxSourceSizeBytes) {
      return {
        status: 'error',
        code: 'OVERSIZED_SOURCE',
        message: `Source file size (${preLstat.size} bytes) exceeds limit (${maxSourceSizeBytes} bytes)`
      }
    }

    handle = await open(sourcePath, 'r')
    const preStat = await handle.stat()

    if (!preStat.isFile()) {
      return {
        status: 'error',
        code: 'NOT_A_REGULAR_FILE',
        message: 'Source is not a regular file'
      }
    }

    if (preStat.size > maxSourceSizeBytes) {
      return {
        status: 'error',
        code: 'OVERSIZED_SOURCE',
        message: `Source file size (${preStat.size} bytes) exceeds limit (${maxSourceSizeBytes} bytes)`
      }
    }

    if (preLstat.ino !== undefined && preStat.ino !== undefined) {
      if (preLstat.ino !== preStat.ino || preLstat.dev !== preStat.dev) {
        return {
          status: 'error',
          code: 'SOURCE_MODIFIED',
          message: 'Source file identity changed between lstat and open'
        }
      }
    }

    if (expectedByteSize !== undefined && preStat.size !== expectedByteSize) {
      return {
        status: 'error',
        code: 'SOURCE_MODIFIED',
        message: `Source size mismatch: expected ${expectedByteSize}, found ${preStat.size}`
      }
    }

    if (expectedMtimeMs !== null && expectedMtimeMs !== undefined) {
      if (Math.abs(preStat.mtimeMs - expectedMtimeMs) > 1.0) {
        return {
          status: 'error',
          code: 'SOURCE_MODIFIED',
          message: `Source modification time changed: expected ${expectedMtimeMs}, found ${preStat.mtimeMs}`
        }
      }
    }

    // Stream read into buffer while computing SHA-256 and enforcing source byte cap
    const hasher = createHash('sha256')
    const chunks: Buffer[] = []
    const chunkBuffer = Buffer.alloc(64 * 1024)
    let bytesRead = 0
    let totalRead = 0

    do {
      const readResult = await handle.read(chunkBuffer, 0, chunkBuffer.length, null)
      bytesRead = readResult.bytesRead
      if (bytesRead > 0) {
        totalRead += bytesRead
        if (totalRead > maxSourceSizeBytes) {
          return {
            status: 'error',
            code: 'OVERSIZED_SOURCE',
            message: `Source file exceeded max size limit (${maxSourceSizeBytes} bytes) during read`
          }
        }
        const slice = chunkBuffer.subarray(0, bytesRead)
        hasher.update(slice)
        chunks.push(Buffer.from(slice))
      }
    } while (bytesRead > 0)

    const postStat = await handle.stat()
    if (postStat.size !== preStat.size || Math.abs(postStat.mtimeMs - preStat.mtimeMs) > 1.0) {
      return {
        status: 'error',
        code: 'SOURCE_MODIFIED',
        message: 'Source file was modified during read'
      }
    }

    computedSha256 = hasher.digest('hex')
    if (expectedSha256 && computedSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
      return {
        status: 'error',
        code: 'SOURCE_MODIFIED',
        message: `Source content hash mismatch: expected ${expectedSha256}, computed ${computedSha256}`
      }
    }

    fileBuffer = Buffer.concat(chunks, totalRead)
  } catch (err: unknown) {
    return {
      status: 'error',
      code: 'READ_FAILED',
      message: err instanceof Error ? err.message : 'Failed to read source file'
    }
  } finally {
    if (handle) {
      try {
        await handle.close()
      } catch {
        // ignore
      }
    }
  }

  // 4. Post-read pathname and disk identity revalidation
  try {
    const postCanonical = realpathSync(sourcePath)
    if (postCanonical !== canonicalPath) {
      return {
        status: 'error',
        code: 'SOURCE_MODIFIED',
        message: 'Source file canonical path shifted after read'
      }
    }

    const liveStat = lstatSync(sourcePath)
    if (liveStat.isSymbolicLink() || !liveStat.isFile()) {
      return {
        status: 'error',
        code: 'SOURCE_MODIFIED',
        message: 'Source file replaced by non-file or link after read'
      }
    }
    if (liveStat.size !== fileBuffer.length) {
      return {
        status: 'error',
        code: 'SOURCE_MODIFIED',
        message: 'Source file size changed after read'
      }
    }
    if (preLstat.ino !== undefined && liveStat.ino !== undefined) {
      if (liveStat.ino !== preLstat.ino || liveStat.dev !== preLstat.dev) {
        return {
          status: 'error',
          code: 'SOURCE_MODIFIED',
          message: 'Source file inode/device shifted after read'
        }
      }
    }
  } catch (err: unknown) {
    return {
      status: 'error',
      code: 'SOURCE_MODIFIED',
      message: err instanceof Error ? err.message : 'Source path unavailable after read'
    }
  }

  return {
    status: 'success',
    fileBuffer,
    computedSha256
  }
}

export async function decodeThumbnail(params: DecodeInputParams): Promise<DecodeResult> {
  const {
    maxDimension = THUMBNAIL_LIMITS.MAX_DIMENSION_PX,
    maxInputPixels = THUMBNAIL_LIMITS.MAX_INPUT_PIXELS
  } = params

  const verified = await readAndVerifySourceFile(params)
  if (verified.status !== 'success') {
    return verified
  }

  // Sharp resize and encode to WebP
  try {
    const image = sharp(verified.fileBuffer, {
      limitInputPixels: maxInputPixels
    })

    const pipeline = image.rotate().resize({
      width: maxDimension,
      height: maxDimension,
      fit: 'inside',
      withoutEnlargement: true
    })

    const { data, info } = await pipeline
      .webp({ quality: 80 })
      .toBuffer({ resolveWithObject: true })

    return {
      status: 'ready',
      buffer: data,
      mimeType: 'image/webp',
      width: info.width,
      height: info.height
    }
  } catch (err: unknown) {
    return {
      status: 'error',
      code: 'DECODE_FAILED',
      message: err instanceof Error ? err.message : 'Failed to decode image'
    }
  }
}

export async function decodeFingerprint(
  params: DecodeInputParams
): Promise<FingerprintDecodeResult> {
  const { maxInputPixels = THUMBNAIL_LIMITS.MAX_INPUT_PIXELS } = params

  const verified = await readAndVerifySourceFile(params)
  if (verified.status !== 'success') {
    return verified
  }

  try {
    const fp = await extractDHash64FromImageBuffer(verified.fileBuffer, maxInputPixels)
    return {
      status: 'ready',
      fingerprint: fp.fingerprint,
      bucket0: fp.bucket0,
      bucket1: fp.bucket1,
      bucket2: fp.bucket2,
      bucket3: fp.bucket3,
      width: fp.width,
      height: fp.height,
      algorithmVersion: fp.algorithmVersion,
      computedSha256: verified.computedSha256
    }
  } catch (err: unknown) {
    return {
      status: 'error',
      code: 'DECODE_FAILED',
      message: err instanceof Error ? err.message : 'Failed to decode image for fingerprint'
    }
  }
}
