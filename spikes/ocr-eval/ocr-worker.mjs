import { readFile } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import Module, { createRequire } from 'node:module'
import net from 'node:net'
import path from 'node:path'
import tls from 'node:tls'
import { pathToFileURL } from 'node:url'
import { parentPort } from 'node:worker_threads'
import {
  OCR_LIMITS,
  OCR_MAX_INPUT_BYTES,
  OCR_RECIPE_VERSION,
  PINNED_OCR_MANIFEST_SHA256,
  PINNED_OCR_MODEL_MANIFEST,
  classifyPdfPageForOcr,
  readAndVerifySourceWithLimit,
  verifyPinnedTrainedData
} from './ocr-core.mjs'

const workerFileUrl = pathToFileURL(__filename).href
const requireFromWorker = createRequire(workerFileUrl)

// 1. Strict offline & zero-nested-worker guards inside the OCR worker thread.
let nestedWorkerAttempts = 0
let networkAttempts = 0

function forbidNestedWorker() {
  nestedWorkerAttempts += 1
  throw new Error('NESTED_WORKER_FORBIDDEN: OCR worker must never spawn nested worker threads')
}

function forbidNetwork(surface) {
  networkAttempts += 1
  throw new Error(`OFFLINE_NETWORK_FORBIDDEN: blocked outbound ${surface} in OCR worker`)
}

globalThis.Worker = new Proxy(function ForbiddenWorker() {}, {
  construct() {
    forbidNestedWorker()
  },
  apply() {
    forbidNestedWorker()
  }
})

const originalModuleLoad = Module._load
Module._load = function patchedModuleLoad(request, parent, isMain) {
  const loaded = originalModuleLoad.call(this, request, parent, isMain)
  if (request === 'worker_threads' || request === 'node:worker_threads') {
    return new Proxy(loaded, {
      get(target, prop, receiver) {
        if (prop === 'Worker') {
          return globalThis.Worker
        }
        return Reflect.get(target, prop, receiver)
      }
    })
  }
  return loaded
}

globalThis.fetch = async () => forbidNetwork('fetch')
globalThis.XMLHttpRequest = function ForbiddenXHR() {
  forbidNetwork('XMLHttpRequest')
}
http.request = () => forbidNetwork('http.request')
http.get = () => forbidNetwork('http.get')
https.request = () => forbidNetwork('https.request')
https.get = () => forbidNetwork('https.get')
net.connect = () => forbidNetwork('net.connect')
net.createConnection = () => forbidNetwork('net.createConnection')
tls.connect = () => forbidNetwork('tls.connect')

const IMAGE_PAINT_OPS = new Set([83, 84, 85, 86, 87, 88, 89])
const SUPPORTED_IMAGE_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.tif',
  '.tiff',
  '.gif',
  '.avif',
  '.heic',
  '.heif'
])

function resolveUnpackedAssetPath(resolvedPath) {
  if (resolvedPath.includes(`${path.sep}app.asar${path.sep}`)) {
    return resolvedPath.replace(
      `${path.sep}app.asar${path.sep}`,
      `${path.sep}app.asar.unpacked${path.sep}`
    )
  }
  return resolvedPath
}

let sharpMod = null
let canvasMod = null
let pdfjsMod = null

function getSharp() {
  if (!sharpMod) {
    sharpMod = requireFromWorker('sharp')
    sharpMod.cache(false)
    sharpMod.concurrency(1)
  }
  return sharpMod
}

function getCanvasModule() {
  if (!canvasMod) {
    canvasMod = requireFromWorker('@napi-rs/canvas')
    globalThis.DOMMatrix = canvasMod.DOMMatrix
    globalThis.ImageData = canvasMod.ImageData
    globalThis.Path2D = canvasMod.Path2D
  }
  return canvasMod
}

async function getPdfjsModule() {
  getCanvasModule()
  if (!pdfjsMod) {
    pdfjsMod = await import('pdfjs-dist/legacy/build/pdf.mjs')
  }
  return pdfjsMod
}

let engineState = null

async function ensureOcrEngine(modelDir) {
  if (engineState && engineState.modelDir === modelDir) {
    return {
      ok: true,
      coldInitMs: 0,
      engineInfo: engineState.info
    }
  }

  if (engineState) {
    shutdownOcrEngine()
  }

  const t0 = performance.now()
  const modelCheck = await verifyPinnedTrainedData(modelDir)
  if (!modelCheck.valid) {
    return {
      ok: false,
      errorCode: modelCheck.code,
      errorMessage: modelCheck.message
    }
  }

  const simdJsResolved = requireFromWorker.resolve('tesseract.js-core/tesseract-core-simd-lstm.js')
  const simdWasmResolved = resolveUnpackedAssetPath(simdJsResolved.replace(/\.js$/, '.wasm'))
  const wasmBinary = await readFile(simdWasmResolved)
  const factory = requireFromWorker(simdJsResolved)
  const tessModule = await factory({ wasmBinary })

  try {
    tessModule.FS.mkdir('/tessdata')
  } catch {
    // Already exists in MEMFS
  }
  tessModule.FS.writeFile('/tessdata/eng.traineddata', new Uint8Array(modelCheck.buffer))

  const api = new tessModule.TessBaseAPI()
  const initRc = api.Init(
    '/tessdata',
    PINNED_OCR_MODEL_MANIFEST.language,
    PINNED_OCR_MODEL_MANIFEST.engineOem
  )
  if (initRc !== 0) {
    api.End()
    tessModule.destroy(api)
    return {
      ok: false,
      errorCode: 'ocr_engine_init_failed',
      errorMessage: `TessBaseAPI.Init returned non-zero code ${initRc}`
    }
  }

  // Disable dictionary DAWGs only? Keep standard LSTM page seg mode 3 (AUTO).
  api.SetPageSegMode(3)

  const canvasResolved = resolveUnpackedAssetPath(requireFromWorker.resolve('@napi-rs/canvas'))
  const sharpResolved = resolveUnpackedAssetPath(requireFromWorker.resolve('sharp'))

  const coldInitMs = Number((performance.now() - t0).toFixed(2))
  const info = {
    tesseractVersion: api.Version(),
    simdJsPath: simdJsResolved,
    simdWasmPath: simdWasmResolved,
    wasmLoadedFromUnpackedAsar: simdWasmResolved.includes('app.asar.unpacked'),
    canvasPath: canvasResolved,
    sharpPath: sharpResolved,
    modelId: PINNED_OCR_MODEL_MANIFEST.modelId,
    manifestSha256: PINNED_OCR_MANIFEST_SHA256,
    trainedDataSha256: modelCheck.sha256,
    trainedDataBytes: modelCheck.byteSize
  }

  engineState = {
    modelDir,
    tessModule,
    api,
    info
  }

  return {
    ok: true,
    coldInitMs,
    engineInfo: info
  }
}

function shutdownOcrEngine() {
  if (!engineState) return
  try {
    engineState.api.End()
    engineState.tessModule.destroy(engineState.api)
  } catch {
    // Ignore teardown error
  } finally {
    engineState = null
  }
}

function buildPgmFromGrayscale(grayBytes, width, height) {
  const header = Buffer.from(`P5\n${width} ${height}\n255\n`, 'ascii')
  return Buffer.concat([header, grayBytes], header.length + grayBytes.length)
}

function buildPgmFromRgba(rgbaBytes, width, height) {
  const pixelCount = width * height
  const gray = Buffer.allocUnsafe(pixelCount)
  for (let i = 0, p = 0; i < pixelCount; i++, p += 4) {
    const a = rgbaBytes[p + 3]
    const r = a === 255 ? rgbaBytes[p] : ((rgbaBytes[p] * a + 255 * (255 - a)) / 255) | 0
    const g = a === 255 ? rgbaBytes[p + 1] : ((rgbaBytes[p + 1] * a + 255 * (255 - a)) / 255) | 0
    const b = a === 255 ? rgbaBytes[p + 2] : ((rgbaBytes[p + 2] * a + 255 * (255 - a)) / 255) | 0
    gray[i] = (77 * r + 150 * g + 29 * b) >> 8
  }
  return buildPgmFromGrayscale(gray, width, height)
}

function recognizePgmBuffer(pgmBuffer, dpi = OCR_LIMITS.RASTER_DPI) {
  const { tessModule, api } = engineState
  tessModule.FS.writeFile('/input', pgmBuffer)
  try {
    const setRc = api.SetImageFile(0, 0)
    if (setRc !== 0) {
      throw new Error(`TessBaseAPI.SetImageFile failed with code ${setRc}`)
    }
    api.SetSourceResolution(dpi)
    const rawText = api.GetUTF8Text() || ''
    const meanConfidence = api.MeanTextConf()
    const cleaned = rawText
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    return {
      text: cleaned,
      meanConfidence: cleaned.length > 0 ? meanConfidence : 0
    }
  } finally {
    api.Clear()
    try {
      tessModule.FS.unlink('/input')
    } catch {
      // Ignore if already unlinked
    }
  }
}

async function ocrImageBuffer(buffer) {
  const sharp = getSharp()
  const { data, info } = await sharp(buffer, {
    limitInputPixels: OCR_LIMITS.MAX_IMAGE_INPUT_PIXELS,
    failOn: 'error'
  })
    .rotate()
    .resize({
      width: OCR_LIMITS.MAX_RASTER_EDGE_PX,
      height: OCR_LIMITS.MAX_RASTER_EDGE_PX,
      fit: 'inside',
      withoutEnlargement: true
    })
    .flatten({ background: '#ffffff' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const pgm = buildPgmFromGrayscale(data, info.width, info.height)
  const recognized = recognizePgmBuffer(pgm, OCR_LIMITS.RASTER_DPI)
  const hasText = recognized.text.length > 0

  return {
    status: hasText ? 'extracted' : 'ocr_no_text',
    extractionMethod: 'ocr_image_tesseract',
    text: hasText ? recognized.text.slice(0, OCR_LIMITS.MAX_EXTRACTED_CHARS) : null,
    truncated: recognized.text.length > OCR_LIMITS.MAX_EXTRACTED_CHARS,
    pageCount: 1,
    ocrPageCount: 1,
    nativePageCount: 0,
    skippedBlankPageCount: 0,
    meanConfidence: hasText ? recognized.meanConfidence : null,
    pageDetails: [
      {
        pageNumber: 1,
        source: 'tesseract_ocr',
        width: info.width,
        height: info.height,
        charCount: recognized.text.length,
        confidence: hasText ? recognized.meanConfidence : null
      }
    ]
  }
}

function computeBoundedViewport(page) {
  const baseVp = page.getViewport({ scale: 1 })
  let scale = OCR_LIMITS.RASTER_DPI / 72
  const scaledW = baseVp.width * scale
  const scaledH = baseVp.height * scale

  const maxEdge = Math.max(scaledW, scaledH)
  if (maxEdge > OCR_LIMITS.MAX_RASTER_EDGE_PX) {
    scale *= OCR_LIMITS.MAX_RASTER_EDGE_PX / maxEdge
  }

  const pixels = baseVp.width * scale * (baseVp.height * scale)
  if (pixels > OCR_LIMITS.MAX_RASTER_PIXELS) {
    scale *= Math.sqrt(OCR_LIMITS.MAX_RASTER_PIXELS / pixels)
  }

  return page.getViewport({ scale })
}

async function extractNativePageText(page) {
  const content = await page.getTextContent()
  const parts = []
  for (const item of content.items) {
    if (item && typeof item.str === 'string') {
      parts.push(item.str)
      parts.push(item.hasEOL ? '\n' : ' ')
    }
  }
  return parts
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function countPageRasterOps(page) {
  const opList = await page.getOperatorList()
  let rasterOps = 0
  for (const fnId of opList.fnArray) {
    if (IMAGE_PAINT_OPS.has(fnId)) {
      rasterOps += 1
    }
  }
  return {
    rasterImageOpCount: rasterOps,
    // When an image paint op exists on a scanned page, treat coverage conservatively >= 0.25
    maxRasterCoverageRatio: rasterOps > 0 ? 1.0 : 0
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function ocrPdfBuffer(buffer, options = {}) {
  const pdfjs = await getPdfjsModule()
  const { createCanvas } = getCanvasModule()
  const maxPdfPages = options.maxPdfPages ?? OCR_LIMITS.MAX_PDF_PAGES
  const simulatePageDelayMs = options.simulatePageDelayMs ?? 0

  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    disableStream: true,
    disableAutoFetch: true,
    verbosity: 0
  })

  let pdfDoc = null
  try {
    pdfDoc = await loadingTask.promise
    const totalPages = pdfDoc.numPages
    const pagesToProcess = Math.min(totalPages, maxPdfPages)
    let truncated = totalPages > maxPdfPages
    let truncationReason = truncated
      ? `PDF page count (${totalPages}) exceeded ${maxPdfPages} page limit`
      : null

    const pageBlocks = []
    const pageDetails = []
    let ocrPageCount = 0
    let nativePageCount = 0
    let skippedBlankPageCount = 0
    const confidences = []
    let totalChars = 0

    for (let pageNum = 1; pageNum <= pagesToProcess; pageNum++) {
      if (simulatePageDelayMs > 0) {
        await sleep(simulatePageDelayMs)
      }

      const page = await pdfDoc.getPage(pageNum)
      try {
        const nativeText = await extractNativePageText(page)
        const selectableCharCount = nativeText.replace(/\s+/g, '').length
        const { rasterImageOpCount, maxRasterCoverageRatio } = await countPageRasterOps(page)

        const decision = classifyPdfPageForOcr({
          selectableCharCount,
          rasterImageOpCount,
          maxRasterCoverageRatio
        })

        if (!decision.needsOcr) {
          if (nativeText.length > 0) {
            nativePageCount += 1
            const block = `--- Page ${pageNum} ---\n${nativeText}`
            pageBlocks.push(block)
            totalChars += block.length
            pageDetails.push({
              pageNumber: pageNum,
              source: 'native_pdf_text',
              reason: decision.reason,
              selectableCharCount,
              rasterImageOpCount,
              charCount: nativeText.length,
              confidence: null
            })
          } else {
            skippedBlankPageCount += 1
            pageDetails.push({
              pageNumber: pageNum,
              source: 'blank_vector_skipped',
              reason: decision.reason,
              selectableCharCount: 0,
              rasterImageOpCount: 0,
              charCount: 0,
              confidence: null
            })
          }
          continue
        }

        // Rasterize this page at bounded 200 DPI via @napi-rs/canvas
        const viewport = computeBoundedViewport(page)
        const width = Math.max(1, Math.ceil(viewport.width))
        const height = Math.max(1, Math.ceil(viewport.height))
        const canvas = createCanvas(width, height)
        const ctx = canvas.getContext('2d')
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, width, height)

        await page.render({
          canvasContext: ctx,
          viewport,
          canvas
        }).promise

        const imageData = ctx.getImageData(0, 0, width, height)
        const pgm = buildPgmFromRgba(imageData.data, width, height)
        const effectiveDpi = Math.round(viewport.scale * 72)
        const recognized = recognizePgmBuffer(pgm, effectiveDpi)

        ocrPageCount += 1
        if (recognized.text.length > 0) {
          confidences.push(recognized.meanConfidence)
          const block = `--- Page ${pageNum} ---\n${recognized.text}`
          pageBlocks.push(block)
          totalChars += block.length
        }

        pageDetails.push({
          pageNumber: pageNum,
          source: 'tesseract_ocr',
          reason: decision.reason,
          selectableCharCount,
          rasterImageOpCount,
          width,
          height,
          effectiveDpi,
          charCount: recognized.text.length,
          confidence: recognized.text.length > 0 ? recognized.meanConfidence : null
        })

        if (totalChars >= OCR_LIMITS.MAX_EXTRACTED_CHARS) {
          truncated = true
          truncationReason = `OCR extracted text exceeded ${OCR_LIMITS.MAX_EXTRACTED_CHARS} character limit`
          break
        }
      } finally {
        page.cleanup()
      }
    }

    const joined = pageBlocks.join('\n\n').trim()
    const finalText =
      joined.length > OCR_LIMITS.MAX_EXTRACTED_CHARS
        ? joined.slice(0, OCR_LIMITS.MAX_EXTRACTED_CHARS)
        : joined
    const hasText = finalText.length > 0
    const meanConfidence =
      confidences.length > 0
        ? Number((confidences.reduce((a, b) => a + b, 0) / confidences.length).toFixed(2))
        : null

    const extractionMethod =
      nativePageCount > 0 && ocrPageCount > 0
        ? 'ocr_hybrid_pdf'
        : ocrPageCount > 0
          ? 'ocr_pdf_tesseract'
          : 'native_pdf_passthrough'

    return {
      status: truncated ? 'truncated' : hasText ? 'extracted' : 'ocr_no_text',
      extractionMethod,
      text: hasText ? finalText : null,
      truncated,
      truncationReason,
      pageCount: totalPages,
      ocrPageCount,
      nativePageCount,
      skippedBlankPageCount,
      meanConfidence,
      pageDetails
    }
  } finally {
    if (pdfDoc) {
      try {
        await pdfDoc.cleanup?.()
      } catch {
        // Ignore
      }
    }
    try {
      await loadingTask.destroy()
    } catch {
      // Ignore
    }
  }
}

async function handleOcrRequest(msg) {
  const tStart = performance.now()
  const ext = path.extname(msg.filePath).toLowerCase()

  if (ext !== '.pdf' && !SUPPORTED_IMAGE_EXTS.has(ext)) {
    return {
      id: msg.id,
      type: 'ocr-result',
      status: 'unsupported',
      recipeVersion: OCR_RECIPE_VERSION,
      statusDetail: `Extension ${ext || '(none)'} is unsupported for Stage 7C OCR`,
      nestedWorkerAttempts,
      networkAttempts,
      durationMs: Number((performance.now() - tStart).toFixed(2))
    }
  }

  const maxInputBytes = msg.maxInputBytes ?? OCR_MAX_INPUT_BYTES
  const sourceRead = await readAndVerifySourceWithLimit({
    filePath: msg.filePath,
    approvedRoots: msg.approvedRoots,
    maxInputBytes,
    expectedByteSize: msg.expectedByteSize,
    expectedSha256: msg.expectedSha256
  })

  if (sourceRead.status === 'truncated') {
    return {
      id: msg.id,
      type: 'ocr-result',
      status: 'truncated',
      recipeVersion: OCR_RECIPE_VERSION,
      truncationReason: sourceRead.truncationReason,
      observedBytes: sourceRead.observedBytes,
      maxInputBytes: sourceRead.maxInputBytes,
      nestedWorkerAttempts,
      networkAttempts,
      durationMs: Number((performance.now() - tStart).toFixed(2))
    }
  }

  if (sourceRead.status !== 'ok') {
    return {
      id: msg.id,
      type: 'ocr-result',
      status: 'corrupt_or_failed',
      recipeVersion: OCR_RECIPE_VERSION,
      errorCode: sourceRead.errorCode,
      errorMessage: sourceRead.errorMessage,
      nestedWorkerAttempts,
      networkAttempts,
      durationMs: Number((performance.now() - tStart).toFixed(2))
    }
  }

  const engineReady = await ensureOcrEngine(msg.modelDir)
  if (!engineReady.ok) {
    return {
      id: msg.id,
      type: 'ocr-result',
      status: 'corrupt_or_failed',
      recipeVersion: OCR_RECIPE_VERSION,
      errorCode: engineReady.errorCode,
      errorMessage: engineReady.errorMessage,
      nestedWorkerAttempts,
      networkAttempts,
      durationMs: Number((performance.now() - tStart).toFixed(2))
    }
  }

  if (msg.notifyStarted) {
    parentPort?.postMessage({
      id: msg.id,
      type: 'ocr-started',
      filePath: msg.filePath
    })
  }

  try {
    const outcome =
      ext === '.pdf'
        ? await ocrPdfBuffer(sourceRead.buffer, {
            maxPdfPages: msg.maxPdfPages,
            simulatePageDelayMs: msg.simulatePageDelayMs
          })
        : await ocrImageBuffer(sourceRead.buffer)

    return {
      id: msg.id,
      type: 'ocr-result',
      recipeVersion: OCR_RECIPE_VERSION,
      observedSha256: sourceRead.sha256,
      observedByteSize: sourceRead.byteSize,
      maxInputBytesUsed: sourceRead.maxInputBytes,
      coldInitMs: engineReady.coldInitMs,
      engineInfo: engineReady.engineInfo,
      ...outcome,
      extractedCharCount: outcome.text ? outcome.text.length : 0,
      nestedWorkerAttempts,
      networkAttempts,
      memoryUsage: process.memoryUsage(),
      durationMs: Number((performance.now() - tStart).toFixed(2))
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    return {
      id: msg.id,
      type: 'ocr-result',
      status: /PasswordException|password/i.test(errMsg)
        ? 'password_protected'
        : 'corrupt_or_failed',
      recipeVersion: OCR_RECIPE_VERSION,
      errorCode: 'ocr_processing_failed',
      errorMessage: errMsg,
      nestedWorkerAttempts,
      networkAttempts,
      durationMs: Number((performance.now() - tStart).toFixed(2))
    }
  }
}

parentPort?.on('message', async (msg) => {
  if (!msg || typeof msg !== 'object') return

  if (msg.type === 'shutdown') {
    shutdownOcrEngine()
    parentPort?.postMessage({
      id: msg.id,
      type: 'shutdown-ack',
      nestedWorkerAttempts,
      networkAttempts,
      memoryUsage: process.memoryUsage()
    })
    return
  }

  if (msg.type === 'ocr-file') {
    const response = await handleOcrRequest(msg)
    parentPort?.postMessage(response)
  }
})
