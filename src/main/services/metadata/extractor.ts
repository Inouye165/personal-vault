/**
 * Personal Vault — Stage 6C Bounded Read-Only Photo Metadata Extractor
 *
 * Performs strict approved-root containment, descriptor stability checks, streaming SHA-256
 * verification, magic-byte container identification, header-only dimension reading via `sharp`,
 * and bounded EXIF extraction via `exifreader` without full raster pixel decoding.
 */

import { createHash } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { extname } from 'node:path'
import * as ExifReader from 'exifreader'
import sharp, { type Metadata as SharpMetadata } from 'sharp'
import { resolveCaptureDate } from './date-policy'
import {
  cleanMetadataString,
  computeExtensionFormatMismatch,
  normalizeCameraAndLens,
  normalizeRecordedExtension,
  resolveDimensions
} from './normalize'
import {
  METADATA_LIMITS,
  METADATA_PARSER_RECIPE_VERSION,
  type DetectedContainerFormat,
  type ExtractedPhotoMetadataResult,
  type SupportedMetadataContainerFormat
} from './types'

export interface ExtractPhotoMetadataInput {
  readonly sourcePath: string
  readonly recordedExtension?: string
  readonly expectedByteSize?: number
  readonly expectedMtimeMs?: number | null
  readonly expectedSha256?: string | null
  readonly maxSourceSizeBytes?: number
  readonly approvedRoots?: readonly string[]
}

export type VerifiedSourceBytesResult =
  | {
      readonly status: 'success'
      readonly fileBuffer: Buffer
      readonly computedSha256: string
      readonly observedByteSize: number
      readonly observedMtimeMs: number
    }
  | {
      readonly status: 'error'
      readonly code: string
      readonly message: string
    }

const TIFF_BASED_RAW_EXTENSIONS = new Set(['.nef', '.nrw', '.arw', '.srf', '.sr2', '.pef', '.rwl'])

/**
 * Reads and verifies a source file in strictly read-only mode without filtering by filename extension.
 * Enforces approved-root containment, symlink rejection, pre/post fstat checks, streaming SHA-256,
 * and post-read canonical path & inode stability.
 */
export async function readAndVerifySourceBytesForMetadata(
  params: ExtractPhotoMetadataInput
): Promise<VerifiedSourceBytesResult> {
  const {
    sourcePath,
    expectedByteSize,
    expectedMtimeMs,
    expectedSha256,
    maxSourceSizeBytes = METADATA_LIMITS.MAX_SOURCE_SIZE_BYTES,
    approvedRoots
  } = params

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

  let handle
  let fileBuffer: Buffer
  let canonicalPath: string
  let preLstat: import('node:fs').Stats
  let computedSha256: string
  let observedMtimeMs: number

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
    observedMtimeMs = preStat.mtimeMs

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
    computedSha256,
    observedByteSize: fileBuffer.length,
    observedMtimeMs
  }
}

function hasAdobeDngTagInTiff(buf: Buffer, littleEndian: boolean): boolean {
  if (buf.length < 14) return false
  const ifd0Offset = littleEndian ? buf.readUInt32LE(4) : buf.readUInt32BE(4)
  if (ifd0Offset < 8 || ifd0Offset + 2 > buf.length) return false
  const entryCount = littleEndian ? buf.readUInt16LE(ifd0Offset) : buf.readUInt16BE(ifd0Offset)
  const maxEntries = Math.min(entryCount, 256)
  for (let i = 0; i < maxEntries; i++) {
    const entryOff = ifd0Offset + 2 + i * 12
    if (entryOff + 12 > buf.length) break
    const tagId = littleEndian ? buf.readUInt16LE(entryOff) : buf.readUInt16BE(entryOff)
    if (tagId === 0xc612) {
      return true
    }
  }
  return false
}

/**
 * Inspects actual magic bytes / container headers without trusting filename extension.
 */
export function detectContainerSignature(
  buf: Buffer,
  recordedExt: string
): DetectedContainerFormat | null {
  if (buf.length < 4) return null

  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'jpeg'
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'png'
  }

  // GIF: GIF87a or GIF89a
  if (
    buf.length >= 6 &&
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) &&
    buf[5] === 0x61
  ) {
    return 'gif'
  }

  // WebP: RIFF....WEBP
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'webp'
  }

  // Fujifilm RAF: FUJIFILMCCD-RAW
  if (buf.length >= 15 && buf.toString('ascii', 0, 15) === 'FUJIFILMCCD-RAW') {
    return 'raf'
  }

  // Panasonic RW2: 49 49 55 00
  if (buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x55 && buf[3] === 0x00) {
    return 'rw2'
  }

  // Olympus ORF: 49 49 52 4F ("IIRO") or 49 49 52 53 ("IIRS")
  if (
    buf[0] === 0x49 &&
    buf[1] === 0x49 &&
    buf[2] === 0x52 &&
    (buf[3] === 0x4f || buf[3] === 0x53)
  ) {
    return 'orf'
  }

  // BMP: "BM" + plausible file size header
  if (buf.length >= 14 && buf[0] === 0x42 && buf[1] === 0x4d) {
    const declaredSize = buf.readUInt32LE(2)
    if (declaredSize === buf.length || declaredSize >= 26) {
      return 'bmp'
    }
  }

  // ISO-BMFF (`....ftyp`)
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') {
    const boxSize = buf.readUInt32BE(0)
    const scanEnd = Math.min(buf.length, Math.max(12, Math.min(boxSize || 64, 64)))
    const majorBrand = buf.toString('ascii', 8, 12)
    const brands = new Set<string>([majorBrand])
    for (let off = 16; off + 4 <= scanEnd; off += 4) {
      brands.add(buf.toString('ascii', off, off + 4))
    }

    if (brands.has('crx ')) return 'cr3'
    if (brands.has('avif') || brands.has('avis')) return 'avif'
    if (
      brands.has('heic') ||
      brands.has('heix') ||
      brands.has('hevc') ||
      brands.has('hevx') ||
      brands.has('mif1') ||
      brands.has('msf1')
    ) {
      return 'heic'
    }
    return null
  }

  // TIFF / TIFF-based RAW (`II\x2a\x00` or `MM\x00\x2a`)
  const isLittleTiff = buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00
  const isBigTiff = buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a

  if (isLittleTiff || isBigTiff) {
    // Canon CR2 signature at offset 8: 'C', 'R', 0x02, 0x00
    if (
      buf.length >= 12 &&
      buf[8] === 0x43 &&
      buf[9] === 0x52 &&
      buf[10] === 0x02 &&
      buf[11] === 0x00
    ) {
      return 'cr2'
    }
    if (hasAdobeDngTagInTiff(buf, isLittleTiff)) {
      return 'dng'
    }
    if (TIFF_BASED_RAW_EXTENSIONS.has(recordedExt)) {
      if (recordedExt === '.nef' || recordedExt === '.nrw') return 'nef'
      if (recordedExt === '.arw' || recordedExt === '.srf' || recordedExt === '.sr2') return 'arw'
      if (recordedExt === '.pef') return 'pef'
      return 'raw_tiff'
    }
    return 'tiff'
  }

  return null
}

function isSupportedMetadataFormat(
  fmt: DetectedContainerFormat
): fmt is SupportedMetadataContainerFormat {
  return (
    fmt === 'jpeg' ||
    fmt === 'png' ||
    fmt === 'webp' ||
    fmt === 'gif' ||
    fmt === 'avif' ||
    fmt === 'tiff' ||
    fmt === 'heic'
  )
}

/**
 * Checks JPEG APPn segments and PNG metadata chunks for structural truncation or oversized
 * metadata payloads (`> MAX_METADATA_PARSE_BYTES`) before running `ExifReader.load`.
 */
function inspectEmbeddedMetadataSegments(
  buf: Buffer,
  format: SupportedMetadataContainerFormat
):
  | {
      readonly ok: true
      readonly hasEmbeddedExifMarker: boolean
      readonly totalMetadataBytes: number
    }
  | {
      readonly ok: false
      readonly code: 'OVERSIZED_METADATA' | 'MALFORMED_METADATA'
      readonly message: string
    } {
  if (format === 'jpeg') {
    let offset = 2
    let totalMeta = 0
    let hasExif = false
    while (offset + 4 <= buf.length) {
      if (buf[offset] !== 0xff) {
        break
      }
      // Skip fill 0xFF bytes
      while (offset < buf.length && buf[offset] === 0xff) {
        offset++
      }
      if (offset >= buf.length) break
      const marker = buf[offset]!
      offset++
      // SOS (0xDA) or EOI (0xD9) ends header metadata markers
      if (marker === 0xda || marker === 0xd9) break
      // Standalone markers without length
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue
      if (offset + 2 > buf.length) {
        return {
          ok: false,
          code: 'MALFORMED_METADATA',
          message: 'Truncated JPEG marker length in header'
        }
      }
      const segLen = buf.readUInt16BE(offset)
      if (segLen < 2 || offset + segLen > buf.length) {
        return {
          ok: false,
          code: 'MALFORMED_METADATA',
          message: 'Truncated or out-of-bounds JPEG header segment'
        }
      }
      if (marker >= 0xe1 && marker <= 0xef) {
        totalMeta += segLen - 2
        if (totalMeta > METADATA_LIMITS.MAX_METADATA_PARSE_BYTES) {
          return {
            ok: false,
            code: 'OVERSIZED_METADATA',
            message: `Embedded JPEG metadata (${totalMeta} bytes) exceeds ${METADATA_LIMITS.MAX_METADATA_PARSE_BYTES}-byte limit`
          }
        }
        if (
          marker === 0xe1 &&
          segLen >= 8 &&
          buf.toString('ascii', offset + 2, offset + 8) === 'Exif\0\0'
        ) {
          hasExif = true
          const tiffSlice = buf.subarray(offset + 8, offset + segLen)
          const tiffValid = validateTiffExifSlice(tiffSlice)
          if (!tiffValid.ok) {
            return {
              ok: false,
              code: 'MALFORMED_METADATA',
              message: tiffValid.message
            }
          }
        }
      }
      offset += segLen
    }
    return { ok: true, hasEmbeddedExifMarker: hasExif, totalMetadataBytes: totalMeta }
  }

  if (format === 'png') {
    let offset = 8
    let totalMeta = 0
    let hasExif = false
    while (offset + 12 <= buf.length) {
      const chunkLen = buf.readUInt32BE(offset)
      const chunkType = buf.toString('ascii', offset + 4, offset + 8)
      if (offset + 12 + chunkLen > buf.length) {
        return {
          ok: false,
          code: 'MALFORMED_METADATA',
          message: `Truncated PNG chunk "${chunkType}"`
        }
      }
      if (
        chunkType === 'eXIf' ||
        chunkType === 'tEXt' ||
        chunkType === 'zTXt' ||
        chunkType === 'iTXt'
      ) {
        totalMeta += chunkLen
        if (totalMeta > METADATA_LIMITS.MAX_METADATA_PARSE_BYTES) {
          return {
            ok: false,
            code: 'OVERSIZED_METADATA',
            message: `Embedded PNG metadata (${totalMeta} bytes) exceeds ${METADATA_LIMITS.MAX_METADATA_PARSE_BYTES}-byte limit`
          }
        }
        if (chunkType === 'eXIf') {
          hasExif = true
          const tiffSlice = buf.subarray(offset + 8, offset + 8 + chunkLen)
          const tiffValid = validateTiffExifSlice(tiffSlice)
          if (!tiffValid.ok) {
            return {
              ok: false,
              code: 'MALFORMED_METADATA',
              message: tiffValid.message
            }
          }
        }
      }
      if (chunkType === 'IEND') break
      offset += 12 + chunkLen
    }
    return { ok: true, hasEmbeddedExifMarker: hasExif, totalMetadataBytes: totalMeta }
  }

  return { ok: true, hasEmbeddedExifMarker: false, totalMetadataBytes: 0 }
}

function validateTiffExifSlice(
  tiffSlice: Buffer
): { readonly ok: true } | { readonly ok: false; readonly message: string } {
  if (tiffSlice.length < 14) {
    return { ok: false, message: 'Truncated TIFF/EXIF block (< 14 bytes)' }
  }
  const isLE =
    tiffSlice[0] === 0x49 && tiffSlice[1] === 0x49 && tiffSlice[2] === 0x2a && tiffSlice[3] === 0x00
  const isBE =
    tiffSlice[0] === 0x4d && tiffSlice[1] === 0x4d && tiffSlice[2] === 0x00 && tiffSlice[3] === 0x2a
  if (!isLE && !isBE) {
    return { ok: false, message: 'Invalid byte-order signature in TIFF/EXIF block' }
  }
  const ifd0Offset = isLE ? tiffSlice.readUInt32LE(4) : tiffSlice.readUInt32BE(4)
  if (ifd0Offset < 8 || ifd0Offset + 2 > tiffSlice.length) {
    return { ok: false, message: `Out-of-bounds IFD0 offset (${ifd0Offset}) in TIFF/EXIF block` }
  }
  const entryCount = isLE ? tiffSlice.readUInt16LE(ifd0Offset) : tiffSlice.readUInt16BE(ifd0Offset)
  if (ifd0Offset + 2 + entryCount * 12 > tiffSlice.length) {
    return { ok: false, message: 'Truncated IFD0 directory entries in TIFF/EXIF block' }
  }
  return { ok: true }
}

function extractRawStringTag(tagObj: unknown): string | null {
  if (!tagObj || typeof tagObj !== 'object') return null
  const val = (tagObj as { value?: unknown; description?: unknown }).value
  if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'string') {
    return val[0]
  }
  if (typeof val === 'string') {
    return val
  }
  const desc = (tagObj as { description?: unknown }).description
  if (typeof desc === 'string') {
    return desc
  }
  return null
}

function extractRawNumberTag(tagObj: unknown): number | null {
  if (!tagObj || typeof tagObj !== 'object') return null
  const val = (tagObj as { value?: unknown }).value
  if (typeof val === 'number' && Number.isFinite(val)) {
    return val
  }
  if (
    Array.isArray(val) &&
    val.length > 0 &&
    typeof val[0] === 'number' &&
    Number.isFinite(val[0])
  ) {
    return val[0]
  }
  return null
}

function serializeBoundedRawEvidence(evidence: Record<string, unknown>): string | null {
  const cleanedEntries = Object.entries(evidence).filter(
    ([, v]) => v !== null && v !== undefined && v !== ''
  )
  if (cleanedEntries.length === 0) return null
  const obj = Object.fromEntries(cleanedEntries)
  const json = JSON.stringify(obj)
  if (Buffer.byteLength(json, 'utf8') <= METADATA_LIMITS.MAX_RAW_EVIDENCE_JSON_BYTES) {
    return json
  }
  // Deterministically bound oversized JSON
  return JSON.stringify({
    truncatedEvidence: true,
    preview: json.slice(0, METADATA_LIMITS.MAX_RAW_EVIDENCE_JSON_BYTES - 128)
  })
}

function buildEmptyFailureResult(params: {
  extractionStatus: 'unsupported' | 'failed'
  recordedExtension: string
  detectedFormat: DetectedContainerFormat | null
  contentSha256: string | null
  observedByteSize: number | null
  observedMtimeMs: number | null
  errorCode: string
  errorMessage: string
}): ExtractedPhotoMetadataResult {
  return {
    extractionStatus: params.extractionStatus,
    parserRecipeVersion: METADATA_PARSER_RECIPE_VERSION,
    contentSha256: params.contentSha256,
    observedByteSize: params.observedByteSize,
    observedMtimeMs: params.observedMtimeMs,
    recordedExtension: params.recordedExtension,
    detectedFormat: params.detectedFormat,
    extensionFormatMismatch: computeExtensionFormatMismatch(
      params.recordedExtension,
      params.detectedFormat
    ),
    encodedWidthPx: null,
    encodedHeightPx: null,
    exifOrientation: null,
    displayWidthPx: null,
    displayHeightPx: null,
    captureDateSourceTag: null,
    rawCaptureDateText: null,
    captureSubseconds: null,
    captureOffsetMinutes: null,
    captureOffsetText: null,
    captureTimezoneStatus: 'unknown',
    captureCalendarDate: null,
    captureLocalIso: null,
    captureUtcEpochMs: null,
    captureDateParseError: null,
    captureDateConflict: null,
    cameraMakeRaw: null,
    cameraModelRaw: null,
    cameraDisplay: null,
    cameraNormalized: null,
    lensMakeRaw: null,
    lensModelRaw: null,
    lensDisplay: null,
    lensNormalized: null,
    rawMetadataJson: null,
    errorCode: params.errorCode,
    errorMessage: params.errorMessage
  }
}

/**
 * Parses technical metadata from an already verified in-memory source buffer.
 */
export async function extractPhotoMetadataFromBuffer(params: {
  fileBuffer: Buffer
  recordedExtension: string
  computedSha256: string
  observedByteSize: number
  observedMtimeMs: number
}): Promise<ExtractedPhotoMetadataResult> {
  const recordedExt = normalizeRecordedExtension(params.recordedExtension)
  const detectedSig = detectContainerSignature(params.fileBuffer, recordedExt)

  if (!detectedSig) {
    return buildEmptyFailureResult({
      extractionStatus: 'failed',
      recordedExtension: recordedExt,
      detectedFormat: null,
      contentSha256: params.computedSha256,
      observedByteSize: params.observedByteSize,
      observedMtimeMs: params.observedMtimeMs,
      errorCode: 'CORRUPT_OR_UNRECOGNIZED_HEADER',
      errorMessage: 'File header does not match any recognized image or RAW container signature'
    })
  }

  if (!isSupportedMetadataFormat(detectedSig)) {
    const isBmp = detectedSig === 'bmp'
    return buildEmptyFailureResult({
      extractionStatus: 'unsupported',
      recordedExtension: recordedExt,
      detectedFormat: detectedSig,
      contentSha256: params.computedSha256,
      observedByteSize: params.observedByteSize,
      observedMtimeMs: params.observedMtimeMs,
      errorCode: isBmp ? 'UNSUPPORTED_BMP_CONTAINER' : 'UNSUPPORTED_RAW_CONTAINER',
      errorMessage: isBmp
        ? 'Detected BMP container; BMP raster metadata pipeline is not enabled'
        : `Detected ${detectedSig.toUpperCase()} camera RAW container; offline RAW demosaicing/decoding is not bundled`
    })
  }

  // Pre-inspect embedded metadata segments for truncation or oversized payloads (> 4 MiB)
  const segCheck = inspectEmbeddedMetadataSegments(params.fileBuffer, detectedSig)
  if (!segCheck.ok) {
    return buildEmptyFailureResult({
      extractionStatus: 'failed',
      recordedExtension: recordedExt,
      detectedFormat: detectedSig,
      contentSha256: params.computedSha256,
      observedByteSize: params.observedByteSize,
      observedMtimeMs: params.observedMtimeMs,
      errorCode: segCheck.code,
      errorMessage: segCheck.message
    })
  }

  // Header-only container validation via sharp().metadata() (does NOT decode full pixel raster)
  let sharpMeta: SharpMetadata
  try {
    sharpMeta = await sharp(params.fileBuffer, { limitInputPixels: false }).metadata()
  } catch (err: unknown) {
    return buildEmptyFailureResult({
      extractionStatus: 'failed',
      recordedExtension: recordedExt,
      detectedFormat: detectedSig,
      contentSha256: params.computedSha256,
      observedByteSize: params.observedByteSize,
      observedMtimeMs: params.observedMtimeMs,
      errorCode: 'CORRUPT_IMAGE_HEADER',
      errorMessage: err instanceof Error ? err.message : 'Failed to read image container header'
    })
  }

  if (sharpMeta.exif && sharpMeta.exif.length > METADATA_LIMITS.MAX_METADATA_PARSE_BYTES) {
    return buildEmptyFailureResult({
      extractionStatus: 'failed',
      recordedExtension: recordedExt,
      detectedFormat: detectedSig,
      contentSha256: params.computedSha256,
      observedByteSize: params.observedByteSize,
      observedMtimeMs: params.observedMtimeMs,
      errorCode: 'OVERSIZED_METADATA',
      errorMessage: `EXIF buffer (${sharpMeta.exif.length} bytes) exceeds ${METADATA_LIMITS.MAX_METADATA_PARSE_BYTES}-byte limit`
    })
  }

  let exifTags: Record<string, unknown> = {}
  if (detectedSig !== 'gif') {
    try {
      const expanded = ExifReader.load(params.fileBuffer, {
        expanded: true,
        includeUnknown: false,
        decompress: {
          maxDecompressedSize: METADATA_LIMITS.MAX_METADATA_PARSE_BYTES
        },
        includeTags: {
          file: true,
          png: true,
          riff: true,
          exif: [
            'Make',
            'Model',
            'LensMake',
            'LensModel',
            'Orientation',
            'DateTimeOriginal',
            'DateTimeDigitized',
            'DateTime',
            'OffsetTimeOriginal',
            'OffsetTimeDigitized',
            'OffsetTime',
            'SubSecTimeOriginal',
            'SubSecTimeDigitized',
            'SubSecTime',
            'PixelXDimension',
            'PixelYDimension',
            'ImageWidth',
            'ImageLength'
          ]
        }
      })
      if (expanded.exif && typeof expanded.exif === 'object') {
        exifTags = expanded.exif as Record<string, unknown>
      }
    } catch (err: unknown) {
      const isMissingMeta =
        err instanceof Error &&
        (err.name === 'MetadataMissingError' || /No Exif data/i.test(err.message))
      if (!isMissingMeta) {
        return buildEmptyFailureResult({
          extractionStatus: 'failed',
          recordedExtension: recordedExt,
          detectedFormat: detectedSig,
          contentSha256: params.computedSha256,
          observedByteSize: params.observedByteSize,
          observedMtimeMs: params.observedMtimeMs,
          errorCode: 'MALFORMED_METADATA',
          errorMessage:
            err instanceof Error ? err.message : 'Failed to parse embedded EXIF metadata'
        })
      }
    }
  }

  const rawDateTimeOriginal = extractRawStringTag(exifTags.DateTimeOriginal)
  const rawOffsetTimeOriginal = extractRawStringTag(exifTags.OffsetTimeOriginal)
  const rawSubSecTimeOriginal = extractRawStringTag(exifTags.SubSecTimeOriginal)
  const rawDateTimeDigitized = extractRawStringTag(exifTags.DateTimeDigitized)
  const rawOffsetTimeDigitized = extractRawStringTag(exifTags.OffsetTimeDigitized)
  const rawSubSecTimeDigitized = extractRawStringTag(exifTags.SubSecTimeDigitized)
  const rawModifyDateTime = cleanMetadataString(extractRawStringTag(exifTags.DateTime)).cleaned
  const rawModifyOffsetTime = cleanMetadataString(extractRawStringTag(exifTags.OffsetTime)).cleaned

  const rawMake = extractRawStringTag(exifTags.Make)
  const rawModel = extractRawStringTag(exifTags.Model)
  const rawLensMake = extractRawStringTag(exifTags.LensMake)
  const rawLensModel = extractRawStringTag(exifTags.LensModel)
  const rawOrientation =
    extractRawNumberTag(exifTags.Orientation) ??
    (typeof sharpMeta.orientation === 'number' ? sharpMeta.orientation : null)

  const dateRes = resolveCaptureDate({
    dateTimeOriginalRaw: rawDateTimeOriginal,
    offsetTimeOriginalRaw: rawOffsetTimeOriginal,
    subSecTimeOriginalRaw: rawSubSecTimeOriginal,
    dateTimeDigitizedRaw: rawDateTimeDigitized,
    offsetTimeDigitizedRaw: rawOffsetTimeDigitized,
    subSecTimeDigitizedRaw: rawSubSecTimeDigitized
  })

  const camLensRes = normalizeCameraAndLens({
    cameraMake: rawMake,
    cameraModel: rawModel,
    lensMake: rawLensMake,
    lensModel: rawLensModel
  })

  // Sharp/libheif applies HEIF `irot` container rotation to `sharpMeta.width`/`height`
  // while leaving `sharpMeta.orientation` undefined, even when EXIF `Orientation` is 5-8.
  // Un-swap before calling `resolveDimensions` so all dimension/orientation validation runs
  // identically without double-rotating display dimensions.
  const swappedByExif = rawOrientation !== null && rawOrientation >= 5 && rawOrientation <= 8
  const heicAlreadyOriented = detectedSig === 'heic' && sharpMeta.orientation === undefined
  const dimRes = resolveDimensions({
    encodedWidth:
      heicAlreadyOriented && swappedByExif ? (sharpMeta.height ?? null) : (sharpMeta.width ?? null),
    encodedHeight:
      heicAlreadyOriented && swappedByExif ? (sharpMeta.width ?? null) : (sharpMeta.height ?? null),
    exifOrientation: rawOrientation
  })

  const hasAnyEmbeddedExifTag =
    rawDateTimeOriginal !== null ||
    rawDateTimeDigitized !== null ||
    rawModifyDateTime !== null ||
    camLensRes.cameraMakeRaw !== null ||
    camLensRes.cameraModelRaw !== null ||
    camLensRes.lensMakeRaw !== null ||
    camLensRes.lensModelRaw !== null ||
    rawOrientation !== null ||
    segCheck.hasEmbeddedExifMarker ||
    Boolean(sharpMeta.exif && sharpMeta.exif.length > 0)

  const rawMetadataJson = serializeBoundedRawEvidence({
    DateTimeOriginal:
      cleanMetadataString(rawDateTimeOriginal).cleaned ?? rawDateTimeOriginal?.slice(0, 64),
    OffsetTimeOriginal:
      cleanMetadataString(rawOffsetTimeOriginal).cleaned ?? rawOffsetTimeOriginal?.slice(0, 32),
    SubSecTimeOriginal: cleanMetadataString(rawSubSecTimeOriginal).cleaned,
    DateTimeDigitized:
      cleanMetadataString(rawDateTimeDigitized).cleaned ?? rawDateTimeDigitized?.slice(0, 64),
    OffsetTimeDigitized:
      cleanMetadataString(rawOffsetTimeDigitized).cleaned ?? rawOffsetTimeDigitized?.slice(0, 32),
    SubSecTimeDigitized: cleanMetadataString(rawSubSecTimeDigitized).cleaned,
    ImageModifyDateTime: rawModifyDateTime,
    ImageModifyOffsetTime: rawModifyOffsetTime,
    Make: camLensRes.cameraMakeRaw,
    Model: camLensRes.cameraModelRaw,
    LensMake: camLensRes.lensMakeRaw,
    LensModel: camLensRes.lensModelRaw,
    Orientation: rawOrientation,
    dimensionWarning: dimRes.dimensionWarning,
    captureDateParseError: dateRes.captureDateParseError,
    captureDateConflict: dateRes.captureDateConflict,
    stringsTruncated: camLensRes.wasTruncated || undefined
  })

  return {
    extractionStatus: hasAnyEmbeddedExifTag ? 'extracted' : 'no_metadata',
    parserRecipeVersion: METADATA_PARSER_RECIPE_VERSION,
    contentSha256: params.computedSha256,
    observedByteSize: params.observedByteSize,
    observedMtimeMs: params.observedMtimeMs,
    recordedExtension: recordedExt,
    detectedFormat: detectedSig,
    extensionFormatMismatch: computeExtensionFormatMismatch(recordedExt, detectedSig),

    encodedWidthPx: dimRes.encodedWidthPx,
    encodedHeightPx: dimRes.encodedHeightPx,
    exifOrientation: dimRes.exifOrientation,
    displayWidthPx: dimRes.displayWidthPx,
    displayHeightPx: dimRes.displayHeightPx,

    captureDateSourceTag: dateRes.captureDateSourceTag,
    rawCaptureDateText: dateRes.rawCaptureDateText,
    captureSubseconds: dateRes.captureSubseconds,
    captureOffsetMinutes: dateRes.captureOffsetMinutes,
    captureOffsetText: dateRes.captureOffsetText,
    captureTimezoneStatus: dateRes.captureTimezoneStatus,
    captureCalendarDate: dateRes.captureCalendarDate,
    captureLocalIso: dateRes.captureLocalIso,
    captureUtcEpochMs: dateRes.captureUtcEpochMs,
    captureDateParseError: dateRes.captureDateParseError,
    captureDateConflict: dateRes.captureDateConflict,

    cameraMakeRaw: camLensRes.cameraMakeRaw,
    cameraModelRaw: camLensRes.cameraModelRaw,
    cameraDisplay: camLensRes.cameraDisplay,
    cameraNormalized: camLensRes.cameraNormalized,
    lensMakeRaw: camLensRes.lensMakeRaw,
    lensModelRaw: camLensRes.lensModelRaw,
    lensDisplay: camLensRes.lensDisplay,
    lensNormalized: camLensRes.lensNormalized,

    rawMetadataJson,
    errorCode: null,
    errorMessage: null
  }
}

/**
 * Full read-only source verification + metadata extraction entrypoint for worker execution.
 */
export async function extractPhotoMetadataFromFile(
  input: ExtractPhotoMetadataInput
): Promise<ExtractedPhotoMetadataResult> {
  const recordedExt = normalizeRecordedExtension(
    input.recordedExtension ?? extname(input.sourcePath)
  )

  const verified = await readAndVerifySourceBytesForMetadata(input)
  if (verified.status !== 'success') {
    return buildEmptyFailureResult({
      extractionStatus: 'failed',
      recordedExtension: recordedExt,
      detectedFormat: null,
      contentSha256: null,
      observedByteSize: null,
      observedMtimeMs: null,
      errorCode: verified.code,
      errorMessage: verified.message
    })
  }

  return extractPhotoMetadataFromBuffer({
    fileBuffer: verified.fileBuffer,
    recordedExtension: recordedExt,
    computedSha256: verified.computedSha256,
    observedByteSize: verified.observedByteSize,
    observedMtimeMs: verified.observedMtimeMs
  })
}
