/**
 * Personal Vault — Stage 6A Semantic Evaluation Spike: Worker Thread
 *
 * Runs outside the Electron main process inside a Node worker_threads.Worker.
 * Handles:
 * - Lazy initialization of ONNX Runtime sessions (vision + text) and CLIP tokenizer
 * - Explicit missing-model validation (returns structured MISSING_MODEL without downloading)
 * - Read-only source file inspection, size/pixel limits, and streaming SHA-256 verification
 * - Sharp EXIF orientation (.rotate()), shortest-edge 224 resize + 224x224 center crop
 * - Image embedding extraction (512-d L2-normalized Float32Array)
 * - Text query embedding extraction (512-d L2-normalized Float32Array)
 */

import { parentPort } from 'node:worker_threads'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { createRequire } from 'node:module'
import ort from 'onnxruntime-node'
import { Tokenizer } from '@huggingface/tokenizers'
import {
  CLIP_EMBEDDING_DIMENSIONS,
  CLIP_MODEL_ID,
  CLIP_PREPROCESSING_VERSION,
  l2NormalizeFloat32,
  rgb224ToClipPlanarFloat32
} from './semantic-core.mjs'

const require = createRequire(import.meta.url)
const sharp = require('../../node_modules/sharp')

// Bound Sharp concurrency inside worker
sharp.concurrency(1)
sharp.cache({ memory: 32, files: 0, items: 50 })

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

const MAX_SOURCE_SIZE_BYTES = 128 * 1024 * 1024 // 128 MiB
const MAX_INPUT_PIXELS = 100_000_000 // 100 MP

let activeModelDir = null
let visionSession = null
let textSession = null
let clipTokenizer = null

function checkModelFilesExist(modelDir) {
  if (!modelDir || !existsSync(modelDir)) {
    return { ok: false, missing: modelDir || '<empty>' }
  }
  const required = [
    'config.json',
    'preprocessor_config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'onnx/vision_model_quantized.onnx',
    'onnx/text_model_quantized.onnx'
  ]
  for (const rel of required) {
    const full = join(modelDir, rel)
    if (!existsSync(full)) {
      return { ok: false, missing: rel }
    }
  }
  return { ok: true }
}

async function ensureSessionsLoaded(modelDir) {
  const check = checkModelFilesExist(modelDir)
  if (!check.ok) {
    return {
      status: 'error',
      code: 'MISSING_MODEL',
      message: `Offline model artifact missing (${check.missing}). Provision model before running semantic analysis.`
    }
  }

  if (visionSession && textSession && clipTokenizer && activeModelDir === modelDir) {
    return { status: 'ready', coldLoadMs: 0 }
  }

  const t0 = performance.now()
  const sessionOptions = {
    intraOpNumThreads: 2,
    interOpNumThreads: 1,
    executionProviders: ['cpu']
  }

  visionSession = await ort.InferenceSession.create(
    join(modelDir, 'onnx', 'vision_model_quantized.onnx'),
    sessionOptions
  )
  textSession = await ort.InferenceSession.create(
    join(modelDir, 'onnx', 'text_model_quantized.onnx'),
    sessionOptions
  )

  const tokJson = JSON.parse(readFileSync(join(modelDir, 'tokenizer.json'), 'utf8'))
  const tokCfg = JSON.parse(readFileSync(join(modelDir, 'tokenizer_config.json'), 'utf8'))
  clipTokenizer = new Tokenizer(tokJson, tokCfg)
  activeModelDir = modelDir

  const coldLoadMs = performance.now() - t0
  return { status: 'ready', coldLoadMs }
}

async function readSourceReadOnly(sourcePath, maxBytes = MAX_SOURCE_SIZE_BYTES) {
  const ext = extname(sourcePath).toLowerCase()
  if (HEIC_EXTENSIONS.has(ext)) {
    return {
      status: 'unsupported',
      reason: 'HEIC/HEIF format requires unsupported external codecs'
    }
  }
  if (RAW_EXTENSIONS.has(ext)) {
    return {
      status: 'unsupported',
      reason: 'Camera RAW format requires unsupported external toolchains'
    }
  }
  if (SVG_EXTENSIONS.has(ext)) {
    return {
      status: 'unsupported',
      reason: 'Vector SVG graphics are excluded from photograph embedding'
    }
  }
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    return {
      status: 'unsupported',
      reason: `Unsupported file extension: ${ext || 'none'}`
    }
  }

  let handle = null
  try {
    const preLstat = lstatSync(sourcePath)
    if (preLstat.isSymbolicLink() || !preLstat.isFile()) {
      return {
        status: 'error',
        code: 'NOT_A_REGULAR_FILE',
        message: 'Source is not a regular file or is a symbolic link'
      }
    }
    if (preLstat.size > maxBytes) {
      return {
        status: 'error',
        code: 'OVERSIZED_SOURCE',
        message: `Source file (${preLstat.size} bytes) exceeds 128 MiB limit`
      }
    }
    const canonicalBefore = realpathSync(sourcePath)

    handle = await open(sourcePath, 'r')
    const preStat = await handle.stat()
    if (preStat.size > maxBytes) {
      return {
        status: 'error',
        code: 'OVERSIZED_SOURCE',
        message: `Source file (${preStat.size} bytes) exceeds 128 MiB limit`
      }
    }

    const hasher = createHash('sha256')
    const chunks = []
    const chunkBuf = Buffer.alloc(64 * 1024)
    let totalRead = 0
    let bytesRead = 0

    do {
      const res = await handle.read(chunkBuf, 0, chunkBuf.length, null)
      bytesRead = res.bytesRead
      if (bytesRead > 0) {
        totalRead += bytesRead
        if (totalRead > maxBytes) {
          return {
            status: 'error',
            code: 'OVERSIZED_SOURCE',
            message: 'Source exceeded max size during streaming read'
          }
        }
        const slice = chunkBuf.subarray(0, bytesRead)
        hasher.update(slice)
        chunks.push(Buffer.from(slice))
      }
    } while (bytesRead > 0)

    const postStat = await handle.stat()
    if (postStat.size !== preStat.size || Math.abs(postStat.mtimeMs - preStat.mtimeMs) > 1.0) {
      return {
        status: 'error',
        code: 'SOURCE_MODIFIED',
        message: 'Source file modified during read'
      }
    }

    const canonicalAfter = realpathSync(sourcePath)
    if (canonicalAfter !== canonicalBefore) {
      return {
        status: 'error',
        code: 'SOURCE_MODIFIED',
        message: 'Source canonical path shifted during read'
      }
    }

    return {
      status: 'success',
      buffer: Buffer.concat(chunks, totalRead),
      byteSize: totalRead,
      mtimeMs: preStat.mtimeMs,
      sha256: hasher.digest('hex')
    }
  } catch (err) {
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
}

async function handleEmbedImage(msg) {
  const { modelDir, sourcePath, simulateSlowMs } = msg
  const readRes = await readSourceReadOnly(sourcePath)
  if (readRes.status !== 'success') {
    return readRes
  }

  const loadRes = await ensureSessionsLoaded(modelDir)
  if (loadRes.status !== 'ready') {
    return loadRes
  }

  if (simulateSlowMs && simulateSlowMs > 0) {
    await new Promise((r) => setTimeout(r, simulateSlowMs))
  }

  const tDecodeStart = performance.now()
  let rgbData
  let origWidth
  let origHeight
  try {
    const img = sharp(readRes.buffer, { limitInputPixels: MAX_INPUT_PIXELS })
    const meta = await img.metadata()
    origWidth = meta.width ?? null
    origHeight = meta.height ?? null

    // CLIP standard preprocessing:
    // 1. Auto-orient via EXIF (.rotate())
    // 2. Resize shortest edge to 224 and center-crop 224x224 (fit: 'cover', position: 'centre', kernel: 'cubic')
    // 3. Flatten/ensure 3-channel sRGB uint8
    const { data, info } = await sharp(readRes.buffer, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .toColorspace('srgb')
      .removeAlpha()
      .resize(224, 224, {
        fit: 'cover',
        position: 'centre',
        kernel: sharp.kernel.cubic
      })
      .raw()
      .toBuffer({ resolveWithObject: true })

    if (info.width !== 224 || info.height !== 224 || info.channels !== 3) {
      return {
        status: 'error',
        code: 'DECODE_FAILED',
        message: `Unexpected decoded buffer shape: ${info.width}x${info.height}x${info.channels}`
      }
    }
    rgbData = data
  } catch (err) {
    return {
      status: 'error',
      code: 'DECODE_FAILED',
      message: err instanceof Error ? err.message : 'Sharp image decode failed'
    }
  }
  const decodeMs = performance.now() - tDecodeStart

  const tInferStart = performance.now()
  try {
    const planarFloat32 = rgb224ToClipPlanarFloat32(rgbData, 224, 224)
    const inputTensor = new ort.Tensor('float32', planarFloat32, [1, 3, 224, 224])
    const outputs = await visionSession.run({ pixel_values: inputTensor })
    const rawEmbed = outputs.image_embeds?.data
    if (!rawEmbed || rawEmbed.length !== CLIP_EMBEDDING_DIMENSIONS) {
      return {
        status: 'error',
        code: 'INFERENCE_FAILED',
        message: 'Invalid image_embeds output tensor from vision session'
      }
    }

    const { vector, rawNorm } = l2NormalizeFloat32(rawEmbed)
    const inferMs = performance.now() - tInferStart
    const mem = process.memoryUsage()

    return {
      status: 'ready',
      vector: Array.from(vector),
      rawNorm,
      dimensions: CLIP_EMBEDDING_DIMENSIONS,
      modelId: CLIP_MODEL_ID,
      preprocessingVersion: CLIP_PREPROCESSING_VERSION,
      sha256: readRes.sha256,
      byteSize: readRes.byteSize,
      mtimeMs: readRes.mtimeMs,
      width: origWidth,
      height: origHeight,
      timings: {
        coldLoadMs: loadRes.coldLoadMs,
        decodeMs,
        inferMs,
        totalMs: decodeMs + inferMs
      },
      memory: {
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
        externalBytes: mem.external
      }
    }
  } catch (err) {
    return {
      status: 'error',
      code: 'INFERENCE_FAILED',
      message: err instanceof Error ? err.message : 'ONNX vision inference failed'
    }
  }
}

async function handleEmbedText(msg) {
  const { modelDir, queryText } = msg
  const loadRes = await ensureSessionsLoaded(modelDir)
  if (loadRes.status !== 'ready') {
    return loadRes
  }

  const trimmed = typeof queryText === 'string' ? queryText.trim() : ''
  if (!trimmed) {
    return {
      status: 'error',
      code: 'EMPTY_QUERY',
      message: 'Query text cannot be empty'
    }
  }

  const t0 = performance.now()
  try {
    const encoded = clipTokenizer.encode(trimmed)
    // CLIP context window is 77 tokens (BOS=49406 ... EOS=49407)
    const ids = encoded.ids.slice(0, 77)
    if (ids[ids.length - 1] !== 49407) {
      ids[ids.length - 1] = 49407
    }
    const inputIds = new BigInt64Array(ids.map(BigInt))
    const inputTensor = new ort.Tensor('int64', inputIds, [1, inputIds.length])
    const outputs = await textSession.run({ input_ids: inputTensor })
    const rawEmbed = outputs.text_embeds?.data
    if (!rawEmbed || rawEmbed.length !== CLIP_EMBEDDING_DIMENSIONS) {
      return {
        status: 'error',
        code: 'INFERENCE_FAILED',
        message: 'Invalid text_embeds output tensor from text session'
      }
    }

    const { vector, rawNorm } = l2NormalizeFloat32(rawEmbed)
    const inferMs = performance.now() - t0
    const mem = process.memoryUsage()

    return {
      status: 'ready',
      vector: Array.from(vector),
      rawNorm,
      tokenCount: ids.length,
      truncated: encoded.ids.length > 77,
      dimensions: CLIP_EMBEDDING_DIMENSIONS,
      modelId: CLIP_MODEL_ID,
      inferMs,
      memory: {
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed
      }
    }
  } catch (err) {
    return {
      status: 'error',
      code: 'INFERENCE_FAILED',
      message: err instanceof Error ? err.message : 'ONNX text inference failed'
    }
  }
}

if (parentPort) {
  parentPort.on('message', async (msg) => {
    try {
      if (msg.action === 'embed_image') {
        const res = await handleEmbedImage(msg)
        parentPort.postMessage({ id: msg.id, ...res })
      } else if (msg.action === 'embed_text') {
        const res = await handleEmbedText(msg)
        parentPort.postMessage({ id: msg.id, ...res })
      } else {
        parentPort.postMessage({
          id: msg.id,
          status: 'error',
          code: 'UNKNOWN_ACTION',
          message: `Unknown worker action: ${msg.action}`
        })
      }
    } catch (err) {
      parentPort.postMessage({
        id: msg.id,
        status: 'error',
        code: 'WORKER_EXCEPTION',
        message: err instanceof Error ? err.message : String(err)
      })
    }
  })
}
