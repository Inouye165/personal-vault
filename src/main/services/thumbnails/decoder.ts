/**
 * Personal Vault — Thumbnail Decoder (Stage 5A)
 *
 * Implements bounded, read-only source inspection, streaming SHA-256 validation,
 * format checking, and Sharp resizing with orientation preservation.
 */

import { open } from 'node:fs/promises'
import { realpathSync, lstatSync, existsSync } from 'node:fs'
import { extname, join, relative, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { THUMBNAIL_LIMITS } from './types'
import {
  identifyNonPhotoImage,
  readPhotoshopThumbnail,
  unsupportedPhotoReason
} from './file-content'
import { extractDHash64FromImageBuffer } from '../similarity/fingerprint'
import { HeicDecodeError, openSharpFromImageBuffer } from './heic-decoder'
import {
  CLIP_IMAGE_SIZE,
  CLIP_MEAN,
  CLIP_STD,
  SEMANTIC_EMBEDDING_DIMENSIONS,
  type SemanticModelArtifactSpec
} from '../semantic/manifest'
import { normalizeEmbeddingVector } from '../semantic/vector'

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
  '.tiff',
  '.heic',
  '.heif'
])

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
      readonly observedByteSize: number
      readonly observedMtimeMs: number
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
    computedSha256,
    observedByteSize: fileBuffer.length,
    observedMtimeMs
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

  const format = identifyNonPhotoImage(verified.fileBuffer)
  const photoshopPreview =
    format === 'Photoshop document' ? readPhotoshopThumbnail(verified.fileBuffer) : null
  if (format && !photoshopPreview) {
    return { status: 'unsupported', reason: unsupportedPhotoReason(format) }
  }

  // Shared bounded decode (Sharp + libheif-js WASM for HEIC) and WebP resize
  try {
    const { image } = await openSharpFromImageBuffer(
      photoshopPreview ?? verified.fileBuffer,
      maxInputPixels
    )

    const pipeline = image.resize({
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
      code: err instanceof HeicDecodeError ? err.code : 'DECODE_FAILED',
      message: err instanceof Error ? err.message : 'Failed to decode image'
    }
  }
}

/**
 * Decodes a photograph at full resolution (no resizing) with EXIF/HEIC orientation
 * preserved, strictly read-only through `readAndVerifySourceFile`.
 */
export async function decodeOriginalPhoto(params: DecodeInputParams): Promise<DecodeResult> {
  const { maxInputPixels = THUMBNAIL_LIMITS.MAX_INPUT_PIXELS } = params

  const verified = await readAndVerifySourceFile(params)
  if (verified.status !== 'success') {
    return verified
  }
  const format = identifyNonPhotoImage(verified.fileBuffer)
  if (format) return { status: 'unsupported', reason: unsupportedPhotoReason(format) }

  try {
    const { image } = await openSharpFromImageBuffer(verified.fileBuffer, maxInputPixels)
    const { data, info } = await image.webp({ quality: 92 }).toBuffer({ resolveWithObject: true })

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
      code: err instanceof HeicDecodeError ? err.code : 'DECODE_FAILED',
      message: err instanceof Error ? err.message : 'Failed to decode original image'
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
  const format = identifyNonPhotoImage(verified.fileBuffer)
  if (format) return { status: 'unsupported', reason: unsupportedPhotoReason(format) }

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

export interface SemanticDecodeInputParams extends DecodeInputParams {
  readonly modelInstallDir: string
}

export type SemanticDecodeResult =
  | {
      readonly status: 'ready'
      readonly vector: Float32Array
      readonly width: number
      readonly height: number
      readonly computedSha256: string
      readonly observedByteSize: number
      readonly observedMtimeMs: number
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

let cachedOrtModule: typeof import('onnxruntime-node') | null = null
let cachedVisionSession: import('onnxruntime-node').InferenceSession | null = null
let cachedVisionModelPath: string | null = null

async function getOrLoadVisionSession(
  modelInstallDir: string
): Promise<import('onnxruntime-node').InferenceSession> {
  const visionPath = join(modelInstallDir, 'onnx', 'vision_model_quantized.onnx')
  if (cachedVisionSession && cachedVisionModelPath === visionPath) {
    return cachedVisionSession
  }

  await releaseSemanticModelSessionInWorker()

  if (!cachedOrtModule) {
    cachedOrtModule = await import('onnxruntime-node')
  }

  cachedVisionSession = await cachedOrtModule.InferenceSession.create(visionPath, {
    executionProviders: ['cpu'],
    intraOpNumThreads: 2,
    interOpNumThreads: 1
  })
  cachedVisionModelPath = visionPath
  return cachedVisionSession
}

export async function releaseSemanticModelSessionInWorker(): Promise<void> {
  if (cachedVisionSession) {
    try {
      await cachedVisionSession.release()
    } catch {
      // ignore release errors
    }
    cachedVisionSession = null
    cachedVisionModelPath = null
  }
}

export async function verifyModelArtifactsInWorker(
  directoryPath: string,
  specs: readonly SemanticModelArtifactSpec[]
): Promise<{ ok: boolean; error?: string }> {
  try {
    if (!existsSync(directoryPath)) {
      return { ok: false, error: 'Model directory does not exist' }
    }
    const rootStat = lstatSync(directoryPath)
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      return { ok: false, error: 'Model directory is not a canonical directory' }
    }
    const canonicalRoot = realpathSync(directoryPath)

    for (const spec of specs) {
      if (!spec.relativePath || isAbsolute(spec.relativePath) || spec.relativePath.includes('\\')) {
        return { ok: false, error: `Unsafe artifact path: ${spec.relativePath}` }
      }
      const parts = spec.relativePath.split('/')
      if (parts.some((p) => !p || p === '.' || p === '..')) {
        return { ok: false, error: `Unsafe traversal in artifact path: ${spec.relativePath}` }
      }

      let cur = directoryPath
      for (const seg of parts) {
        cur = join(cur, seg)
        if (!existsSync(cur)) {
          return { ok: false, error: `Missing model artifact: ${spec.relativePath}` }
        }
        const st = lstatSync(cur)
        if (st.isSymbolicLink()) {
          return { ok: false, error: `Symlink or junction rejected: ${spec.relativePath}` }
        }
      }

      const canonicalFile = realpathSync(cur)
      const rel = relative(canonicalRoot.toLowerCase(), canonicalFile.toLowerCase())
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
        return { ok: false, error: `Artifact escapes model directory: ${spec.relativePath}` }
      }

      const fileStat = lstatSync(cur)
      if (!fileStat.isFile() || fileStat.size !== spec.byteSize) {
        return {
          ok: false,
          error: `Size mismatch on ${spec.relativePath}: expected ${spec.byteSize}, got ${fileStat.size}`
        }
      }

      const handle = await open(cur, 'r')
      try {
        const hash = createHash('sha256')
        const buf = Buffer.allocUnsafe(64 * 1024)
        let totalRead = 0
        while (true) {
          const { bytesRead } = await handle.read(buf, 0, buf.length, totalRead)
          if (bytesRead <= 0) break
          hash.update(buf.subarray(0, bytesRead))
          totalRead += bytesRead
        }
        if (totalRead !== spec.byteSize) {
          return { ok: false, error: `Read size mismatch on ${spec.relativePath}` }
        }
        const digest = hash.digest('hex')
        if (digest.toLowerCase() !== spec.sha256.toLowerCase()) {
          return { ok: false, error: `SHA-256 digest mismatch on ${spec.relativePath}` }
        }
      } finally {
        await handle.close()
      }
    }

    return { ok: true }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

export async function preprocessImageForClip(
  fileBuffer: Buffer,
  maxInputPixels: number = THUMBNAIL_LIMITS.MAX_INPUT_PIXELS
): Promise<
  | {
      readonly status: 'ready'
      readonly data: Buffer
      readonly width: number
      readonly height: number
    }
  | { readonly status: 'error'; readonly code: string; readonly message: string }
> {
  try {
    const meta = await sharp(fileBuffer, { limitInputPixels: false }).metadata()
    if (!meta.width || !meta.height) {
      return {
        status: 'error',
        code: 'DECODE_FAILED',
        message: 'Image metadata missing width or height'
      }
    }
    if (meta.width * meta.height > maxInputPixels) {
      return {
        status: 'error',
        code: 'OVERSIZED_DIMENSIONS',
        message: `Image dimensions (${meta.width}x${meta.height}) exceed ${maxInputPixels} pixel limit`
      }
    }

    const { image } = await openSharpFromImageBuffer(fileBuffer, maxInputPixels)
    const { data, info } = await image
      .toColorspace('srgb')
      .removeAlpha()
      .resize(CLIP_IMAGE_SIZE, CLIP_IMAGE_SIZE, {
        fit: 'cover',
        position: 'centre',
        kernel: sharp.kernel.cubic
      })
      .raw()
      .toBuffer({ resolveWithObject: true })

    if (info.width !== CLIP_IMAGE_SIZE || info.height !== CLIP_IMAGE_SIZE || info.channels !== 3) {
      return {
        status: 'error',
        code: 'PREPROCESS_FAILED',
        message: `Unexpected preprocessed buffer shape: ${info.width}x${info.height}x${info.channels}`
      }
    }
    return {
      status: 'ready',
      data,
      width: meta.width,
      height: meta.height
    }
  } catch (err: unknown) {
    return {
      status: 'error',
      code: err instanceof HeicDecodeError ? err.code : 'DECODE_FAILED',
      message: err instanceof Error ? err.message : 'Failed to decode image for semantic embedding'
    }
  }
}

export async function decodeSemanticEmbedding(
  params: SemanticDecodeInputParams
): Promise<SemanticDecodeResult> {
  const { maxInputPixels = THUMBNAIL_LIMITS.MAX_INPUT_PIXELS, modelInstallDir } = params

  const verified = await readAndVerifySourceFile(params)
  if (verified.status !== 'success') {
    return verified
  }
  const format = identifyNonPhotoImage(verified.fileBuffer)
  if (format) return { status: 'unsupported', reason: unsupportedPhotoReason(format) }

  const prep = await preprocessImageForClip(verified.fileBuffer, maxInputPixels)
  if (prep.status !== 'ready') {
    return prep
  }

  const rawPixels = prep.data
  const origWidth = prep.width
  const origHeight = prep.height

  try {
    const numPixels = CLIP_IMAGE_SIZE * CLIP_IMAGE_SIZE
    const tensorData = new Float32Array(3 * numPixels)
    for (let i = 0; i < numPixels; i++) {
      const r = (rawPixels[i * 3] ?? 0) / 255.0
      const g = (rawPixels[i * 3 + 1] ?? 0) / 255.0
      const b = (rawPixels[i * 3 + 2] ?? 0) / 255.0
      tensorData[i] = (r - CLIP_MEAN[0]) / CLIP_STD[0]
      tensorData[numPixels + i] = (g - CLIP_MEAN[1]) / CLIP_STD[1]
      tensorData[2 * numPixels + i] = (b - CLIP_MEAN[2]) / CLIP_STD[2]
    }

    const session = await getOrLoadVisionSession(modelInstallDir)
    const ort = cachedOrtModule!
    const pixelValues = new ort.Tensor('float32', tensorData, [
      1,
      3,
      CLIP_IMAGE_SIZE,
      CLIP_IMAGE_SIZE
    ])

    const outputs = await session.run({ pixel_values: pixelValues })
    const outputTensor = outputs.image_embeds ?? Object.values(outputs)[0]
    if (!outputTensor || !(outputTensor.data instanceof Float32Array)) {
      return {
        status: 'error',
        code: 'INFERENCE_FAILED',
        message: 'ONNX vision session did not return Float32Array image_embeds'
      }
    }

    const normalized = normalizeEmbeddingVector(outputTensor.data, SEMANTIC_EMBEDDING_DIMENSIONS)
    return {
      status: 'ready',
      vector: normalized,
      width: origWidth,
      height: origHeight,
      computedSha256: verified.computedSha256,
      observedByteSize: verified.observedByteSize,
      observedMtimeMs: verified.observedMtimeMs
    }
  } catch (err: unknown) {
    return {
      status: 'error',
      code: 'INFERENCE_FAILED',
      message: err instanceof Error ? err.message : 'ONNX vision inference failed'
    }
  }
}
