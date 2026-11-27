/**
 * Personal Vault — Stage 7C Direct WASM OCR Engine & Bounded Rasterizer
 *
 * Runs strictly inside `document_ocr_worker` using:
 * - Direct `tesseract.js-core` (`TessBaseAPI`) WASM SIMD (with scalar fallback)
 *   and zero nested worker threads or remote fetches.
 * - `sharp` + `libheif-js` (`openSharpFromImageBuffer`) for bounded image prep.
 * - `pdfjs-dist` + `@napi-rs/canvas` for `200 DPI` bounded PDF page rasterization
 *   governed by the Conservative Mixed-Page Policy (`pdf-page-policy.ts`).
 */

import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'
import { openSharpFromImageBuffer } from '../../thumbnails/heic-decoder'
import { resolveOcrRuntimeAssets } from './assets'
import {
  OCR_ENGINE_OEM,
  OCR_MODEL_ID,
  OCR_MODEL_LANGUAGE,
  REQUIRED_OCR_MODEL_ARTIFACTS,
  computeOcrManifestSha256
} from './manifest'
import { verifyOcrModelDirectory } from './model-manager'
import {
  classifyPdfPageForOcr,
  inspectPdfPageForOcr,
  mergeNativeAndOcrPageText,
  type PdfPageLike
} from './pdf-page-policy'
import {
  DOCUMENT_OCR_LIMITS,
  DOCUMENT_OCR_RECIPE_VERSION,
  SUPPORTED_OCR_EXTENSIONS,
  SUPPORTED_OCR_IMAGE_EXTENSIONS,
  type DocumentOcrOptions,
  type DocumentOcrOutcome,
  type DocumentOcrPageDetail,
  type OcrModelArtifactSpec,
  type OcrRuntimeEngineTelemetry
} from './types'

interface EmscriptenFs {
  mkdir: (path: string) => void
  writeFile: (path: string, data: Uint8Array) => void
  unlink: (path: string) => void
}

interface TessBaseApiInstance {
  Version: () => string
  Init: (datapath: string, language: string, oem: number) => number
  SetPageSegMode: (psm: number) => void
  SetImageFile: (exif?: number, angle?: number) => number
  SetSourceResolution: (ppi: number) => void
  GetUTF8Text: () => string
  MeanTextConf: () => number
  Clear: () => void
  End: () => void
}

interface TessWasmModule {
  readonly FS: EmscriptenFs
  readonly TessBaseAPI: new () => TessBaseApiInstance
  destroy: (obj: TessBaseApiInstance) => void
}

type TessCoreFactory = (opts: { wasmBinary: Buffer }) => Promise<TessWasmModule>

interface Canvas2DContextLike {
  fillStyle: string
  fillRect: (x: number, y: number, w: number, h: number) => void
  getImageData: (x: number, y: number, w: number, h: number) => { data: Uint8ClampedArray }
}

interface CanvasInstanceLike {
  width: number
  height: number
  getContext: (
    type: '2d',
    options?: { readonly willReadFrequently?: boolean; readonly alpha?: boolean }
  ) => Canvas2DContextLike
}

interface NapiCanvasModule {
  createCanvas: (width: number, height: number) => CanvasInstanceLike
  DOMMatrix: unknown
  ImageData: unknown
  Path2D: unknown
}

function getRuntimeRequire(): NodeRequire {
  const anchorPath =
    typeof __filename === 'string' && __filename.length > 0
      ? __filename
      : join(process.cwd(), 'package.json')
  return createRequire(pathToFileURL(anchorPath).href)
}

let sharpConfigured = false
function ensureSharpConfigured(): void {
  if (!sharpConfigured) {
    sharp.cache(false)
    sharp.concurrency(1)
    sharpConfigured = true
  }
}

let cachedCanvasModule: NapiCanvasModule | null = null
function getCanvasModule(canvasPath: string): NapiCanvasModule {
  if (!cachedCanvasModule) {
    const req = getRuntimeRequire()
    const mod = req(canvasPath) as NapiCanvasModule
    const g = globalThis as Record<string, unknown>
    // Always align globals with the unpacked @napi-rs/canvas module so PDF.js Path2D/DOMMatrix
    // instances share constructor identity with every Canvas2D context (avoiding app.asar mismatch).
    g.DOMMatrix = mod.DOMMatrix
    g.ImageData = mod.ImageData
    g.Path2D = mod.Path2D
    cachedCanvasModule = mod
  }
  return cachedCanvasModule
}

function createPdfjsCanvasFactory(canvasPkg: NapiCanvasModule) {
  return class UnpackedNodeCanvasFactory {
    readonly #enableHWA: boolean

    constructor({ enableHWA = false }: { readonly enableHWA?: boolean } = {}) {
      this.#enableHWA = enableHWA
    }

    create(width: number, height: number) {
      if (width <= 0 || height <= 0) {
        throw new Error('Invalid canvas size')
      }
      const canvas = this._createCanvas(width, height)
      return {
        canvas,
        context: canvas.getContext('2d', { willReadFrequently: !this.#enableHWA })
      }
    }

    reset({ canvas }: { canvas: CanvasInstanceLike | null }, width: number, height: number) {
      if (!canvas) {
        throw new Error('Canvas is not specified')
      }
      if (width <= 0 || height <= 0) {
        throw new Error('Invalid canvas size')
      }
      canvas.width = width
      canvas.height = height
    }

    destroy(canvasAndContext: {
      canvas: CanvasInstanceLike | null
      context: Canvas2DContextLike | null
    }) {
      const { canvas } = canvasAndContext
      if (!canvas) {
        throw new Error('Canvas is not specified')
      }
      canvas.width = 0
      canvas.height = 0
      canvasAndContext.canvas = null
      canvasAndContext.context = null
    }

    getNoAlphaContext(canvas: CanvasInstanceLike) {
      return canvas.getContext('2d', {
        alpha: false,
        willReadFrequently: !this.#enableHWA
      })
    }

    _createCanvas(width: number, height: number): CanvasInstanceLike {
      return canvasPkg.createCanvas(width, height)
    }
  }
}

function normalizeExtension(ext: string): string {
  const trimmed = ext.trim().toLowerCase()
  if (!trimmed) return ''
  return trimmed.startsWith('.') ? trimmed : `.${trimmed}`
}

function buildPgmFromGrayscale(grayBytes: Uint8Array, width: number, height: number): Buffer {
  const header = Buffer.from(`P5\n${width} ${height}\n255\n`, 'ascii')
  return Buffer.concat([header, grayBytes], header.length + grayBytes.byteLength)
}

function buildPgmFromRgba(rgbaBytes: Uint8ClampedArray, width: number, height: number): Buffer {
  const pixelCount = width * height
  const gray = Buffer.allocUnsafe(pixelCount)
  for (let i = 0, p = 0; i < pixelCount; i++, p += 4) {
    const a = rgbaBytes[p + 3]!
    const r = a === 255 ? rgbaBytes[p]! : ((rgbaBytes[p]! * a + 255 * (255 - a)) / 255) | 0
    const g = a === 255 ? rgbaBytes[p + 1]! : ((rgbaBytes[p + 1]! * a + 255 * (255 - a)) / 255) | 0
    const b = a === 255 ? rgbaBytes[p + 2]! : ((rgbaBytes[p + 2]! * a + 255 * (255 - a)) / 255) | 0
    gray[i] = (77 * r + 150 * g + 29 * b) >> 8
  }
  return buildPgmFromGrayscale(gray, width, height)
}

function makeOutcome(
  partial: Omit<DocumentOcrOutcome, 'recipeVersion' | 'extractedCharCount'> & {
    extractedCharCount?: number
  }
): DocumentOcrOutcome {
  return {
    recipeVersion: DOCUMENT_OCR_RECIPE_VERSION,
    extractedCharCount: partial.extractedCharCount ?? (partial.text ? partial.text.length : 0),
    ...partial
  }
}

export class OcrEngineSession {
  private modelDir: string | null = null
  private manifestSha256: string | null = null
  private tessModule: TessWasmModule | null = null
  private api: TessBaseApiInstance | null = null
  private telemetry: OcrRuntimeEngineTelemetry | null = null

  public async ensureInitialized(
    modelDir: string,
    artifacts: readonly OcrModelArtifactSpec[] = REQUIRED_OCR_MODEL_ARTIFACTS
  ): Promise<
    | { readonly ok: true; readonly telemetry: OcrRuntimeEngineTelemetry }
    | { readonly ok: false; readonly errorCode: string; readonly errorMessage: string }
  > {
    const expectedManifestSha = computeOcrManifestSha256(artifacts)
    if (
      this.api &&
      this.tessModule &&
      this.telemetry &&
      this.modelDir === modelDir &&
      this.manifestSha256 === expectedManifestSha
    ) {
      return {
        ok: true,
        telemetry: { ...this.telemetry, coldInitMs: 0 }
      }
    }

    this.dispose()

    const t0 = performance.now()
    const verification = await verifyOcrModelDirectory(modelDir, artifacts)
    if (!verification.ok) {
      return {
        ok: false,
        errorCode: verification.code ?? 'OCR_MODEL_INVALID',
        errorMessage: verification.error ?? 'English OCR model failed integrity verification'
      }
    }

    const trainedSpec = artifacts[0]
    if (!trainedSpec) {
      return {
        ok: false,
        errorCode: 'OCR_MODEL_INVALID',
        errorMessage: 'No OCR model artifacts configured'
      }
    }

    const trainedDataBytes = await readFile(join(modelDir, trainedSpec.relativePath))
    const assets = resolveOcrRuntimeAssets()
    const req = getRuntimeRequire()

    let tessModule: TessWasmModule
    let wasmVariant: 'simd-lstm' | 'scalar-lstm' = 'simd-lstm'
    let wasmPathUsed = assets.simdWasmPath

    try {
      const wasmBinary = await readFile(assets.simdWasmPath)
      const simdFactory = req(assets.simdJsPath) as TessCoreFactory
      tessModule = await simdFactory({ wasmBinary })
    } catch {
      wasmVariant = 'scalar-lstm'
      wasmPathUsed = assets.scalarWasmPath
      const wasmBinary = await readFile(assets.scalarWasmPath)
      const scalarFactory = req(assets.scalarJsPath) as TessCoreFactory
      tessModule = await scalarFactory({ wasmBinary })
    }

    try {
      tessModule.FS.mkdir('/tessdata')
    } catch {
      // Directory already exists in MEMFS
    }
    tessModule.FS.writeFile('/tessdata/eng.traineddata', new Uint8Array(trainedDataBytes))

    const api = new tessModule.TessBaseAPI()
    const initRc = api.Init('/tessdata', OCR_MODEL_LANGUAGE, OCR_ENGINE_OEM)
    if (initRc !== 0) {
      api.End()
      tessModule.destroy(api)
      return {
        ok: false,
        errorCode: 'OCR_ENGINE_INIT_FAILED',
        errorMessage: `TessBaseAPI.Init failed with return code ${initRc}`
      }
    }

    api.SetPageSegMode(3) // PSM_AUTO

    const coldInitMs = Number((performance.now() - t0).toFixed(2))
    const telemetry: OcrRuntimeEngineTelemetry = {
      tesseractVersion: api.Version(),
      wasmVariant,
      wasmPath: wasmPathUsed,
      wasmLoadedFromUnpackedAsar: assets.wasmLoadedFromUnpackedAsar,
      canvasPath: assets.canvasPath,
      sharpPath: assets.sharpPath,
      modelId: OCR_MODEL_ID,
      modelManifestSha256: expectedManifestSha,
      trainedDataSha256: trainedSpec.sha256,
      trainedDataBytes: trainedDataBytes.byteLength,
      coldInitMs
    }

    this.modelDir = modelDir
    this.manifestSha256 = expectedManifestSha
    this.tessModule = tessModule
    this.api = api
    this.telemetry = telemetry

    return { ok: true, telemetry }
  }

  public recognizePgm(
    pgmBuffer: Buffer,
    dpi: number = DOCUMENT_OCR_LIMITS.RASTER_DPI
  ): { readonly text: string; readonly meanConfidence: number } {
    if (!this.tessModule || !this.api) {
      throw new Error('OcrEngineSession is not initialized')
    }

    this.tessModule.FS.writeFile('/input', pgmBuffer)
    try {
      const setRc = this.api.SetImageFile(0, 0)
      if (setRc !== 0) {
        throw new Error(`TessBaseAPI.SetImageFile failed with code ${setRc}`)
      }
      this.api.SetSourceResolution(dpi)
      const rawText = this.api.GetUTF8Text() || ''
      const meanConf = this.api.MeanTextConf()
      const cleaned = rawText
        .replace(/\r\n/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
      return {
        text: cleaned,
        meanConfidence: cleaned.length > 0 ? meanConf : 0
      }
    } finally {
      this.api.Clear()
      try {
        this.tessModule.FS.unlink('/input')
      } catch {
        // Ignore if already unlinked
      }
    }
  }

  public dispose(): void {
    if (!this.api || !this.tessModule) {
      this.api = null
      this.tessModule = null
      this.modelDir = null
      this.manifestSha256 = null
      this.telemetry = null
      return
    }
    try {
      this.api.End()
      this.tessModule.destroy(this.api)
    } catch {
      // Ignore teardown errors
    } finally {
      this.api = null
      this.tessModule = null
      this.modelDir = null
      this.manifestSha256 = null
      this.telemetry = null
    }
  }
}

async function extractImageOcr(
  buffer: Buffer,
  session: OcrEngineSession,
  maxExtractedChars: number
): Promise<DocumentOcrOutcome> {
  if (buffer.byteLength === 0) {
    return makeOutcome({
      status: 'ocr_no_text',
      extractionMethod: 'ocr_image_tesseract',
      text: null,
      pageCount: 1,
      ocrPageCount: 0,
      nativeOnlyPageCount: 0,
      skippedBlankPageCount: 0,
      meanConfidence: null,
      truncated: false,
      truncationReason: null,
      statusDetail: 'Empty image file (0 bytes)',
      pageDetails: []
    })
  }

  ensureSharpConfigured()
  try {
    const { image } = await openSharpFromImageBuffer(
      buffer,
      DOCUMENT_OCR_LIMITS.MAX_IMAGE_INPUT_PIXELS
    )
    const { data, info } = await image
      .resize({
        width: DOCUMENT_OCR_LIMITS.MAX_RASTER_EDGE_PX,
        height: DOCUMENT_OCR_LIMITS.MAX_RASTER_EDGE_PX,
        fit: 'inside',
        withoutEnlargement: true
      })
      .flatten({ background: '#ffffff' })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true })

    const pgm = buildPgmFromGrayscale(data, info.width, info.height)
    const recognized = session.recognizePgm(pgm, DOCUMENT_OCR_LIMITS.RASTER_DPI)
    const hasText = recognized.text.length > 0
    const isTruncated = recognized.text.length > maxExtractedChars
    const finalText = hasText ? recognized.text.slice(0, maxExtractedChars) : null
    const truncReason = isTruncated
      ? `OCR text exceeded ${maxExtractedChars} character limit`
      : null

    return makeOutcome({
      status: isTruncated ? 'truncated' : hasText ? 'extracted' : 'ocr_no_text',
      extractionMethod: 'ocr_image_tesseract',
      text: finalText,
      pageCount: 1,
      ocrPageCount: 1,
      nativeOnlyPageCount: 0,
      skippedBlankPageCount: 0,
      meanConfidence: hasText ? recognized.meanConfidence : null,
      truncated: isTruncated,
      truncationReason: truncReason,
      statusDetail: truncReason,
      pageDetails: [
        {
          pageNumber: 1,
          source: 'tesseract_ocr',
          reason: 'standalone_image',
          selectableCharCount: 0,
          rasterImageOpCount: 1,
          maxSingleRasterAreaRatio: 1,
          width: info.width,
          height: info.height,
          effectiveDpi: DOCUMENT_OCR_LIMITS.RASTER_DPI,
          charCount: recognized.text.length,
          confidence: hasText ? recognized.meanConfidence : null
        }
      ]
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return makeOutcome({
      status: 'corrupt_or_failed',
      extractionMethod: 'ocr_image_tesseract',
      text: null,
      pageCount: null,
      ocrPageCount: 0,
      nativeOnlyPageCount: 0,
      skippedBlankPageCount: 0,
      meanConfidence: null,
      truncated: false,
      truncationReason: null,
      statusDetail: `Corrupt or unreadable image for OCR: ${msg}`,
      pageDetails: []
    })
  }
}

function computeBoundedPageViewport<
  T extends { width: number; height: number; scale: number }
>(page: { getViewport: (opts: { scale: number }) => T }): T {
  const baseVp = page.getViewport({ scale: 1 })
  let scale = DOCUMENT_OCR_LIMITS.RASTER_DPI / 72
  const scaledW = baseVp.width * scale
  const scaledH = baseVp.height * scale

  const maxEdge = Math.max(scaledW, scaledH)
  if (maxEdge > DOCUMENT_OCR_LIMITS.MAX_RASTER_EDGE_PX) {
    scale *= DOCUMENT_OCR_LIMITS.MAX_RASTER_EDGE_PX / maxEdge
  }

  const areaPx = baseVp.width * scale * (baseVp.height * scale)
  if (areaPx > DOCUMENT_OCR_LIMITS.MAX_RASTER_PIXELS) {
    scale *= Math.sqrt(DOCUMENT_OCR_LIMITS.MAX_RASTER_PIXELS / areaPx)
  }

  return page.getViewport({ scale })
}

async function extractPdfOcr(
  buffer: Buffer,
  session: OcrEngineSession,
  options: {
    readonly maxPdfPages: number
    readonly maxExtractedChars: number
    readonly perPageTimeoutMs: number
    readonly pageDelayMs: number
  }
): Promise<DocumentOcrOutcome> {
  if (buffer.byteLength === 0) {
    return makeOutcome({
      status: 'ocr_no_text',
      extractionMethod: 'ocr_pdf_tesseract',
      text: null,
      pageCount: 0,
      ocrPageCount: 0,
      nativeOnlyPageCount: 0,
      skippedBlankPageCount: 0,
      meanConfidence: null,
      truncated: false,
      truncationReason: null,
      statusDetail: 'Empty PDF file (0 bytes)',
      pageDetails: []
    })
  }

  const assets = resolveOcrRuntimeAssets()
  const canvasPkg = getCanvasModule(assets.canvasPath)
  const CanvasFactory = createPdfjsCanvasFactory(canvasPkg)
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')

  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    standardFontDataUrl: assets.pdfjsStandardFontDataUrl,
    CanvasFactory,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    disableStream: true,
    disableAutoFetch: true,
    verbosity: 0
  } as Parameters<typeof pdfjs.getDocument>[0])

  let pdfDoc: Awaited<typeof loadingTask.promise> | null = null
  let phase: 'load' | 'inspect' | 'render' | 'recognize' = 'load'
  try {
    pdfDoc = await loadingTask.promise
    const totalPages = pdfDoc.numPages
    const pagesToProcess = Math.min(totalPages, options.maxPdfPages)
    let truncated = totalPages > options.maxPdfPages
    let truncationReason: string | null = truncated
      ? `PDF page count (${totalPages}) exceeded OCR limit of ${options.maxPdfPages} pages`
      : null

    const pageBlocks: string[] = []
    const pageDetails: DocumentOcrPageDetail[] = []
    const confidences: number[] = []
    let ocrPageCount = 0
    let nativeOnlyPageCount = 0
    let skippedBlankPageCount = 0
    let usedBothNativeAndOcr = false
    let totalChars = 0

    for (let pageNum = 1; pageNum <= pagesToProcess; pageNum++) {
      if (options.pageDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, options.pageDelayMs))
      }

      const pageStartMs = performance.now()
      phase = 'inspect'
      const page = await pdfDoc.getPage(pageNum)
      try {
        const inspection = await inspectPdfPageForOcr(page as unknown as PdfPageLike)
        const classification = classifyPdfPageForOcr(inspection)

        if (!classification.needsOcr) {
          if (inspection.nativeText.length > 0) {
            nativeOnlyPageCount += 1
            const block = `--- Page ${pageNum} ---\n${inspection.nativeText}`
            pageBlocks.push(block)
            totalChars += block.length
            pageDetails.push({
              pageNumber: pageNum,
              source: 'native_pdf_text',
              reason: classification.reason,
              selectableCharCount: inspection.selectableCharCount,
              rasterImageOpCount: inspection.rasterImageOpCount,
              maxSingleRasterAreaRatio: Number(inspection.maxSingleRasterAreaRatio.toFixed(4)),
              width: null,
              height: null,
              effectiveDpi: null,
              charCount: inspection.nativeText.length,
              confidence: null
            })
          } else {
            skippedBlankPageCount += 1
            pageDetails.push({
              pageNumber: pageNum,
              source: 'blank_vector_skipped',
              reason: classification.reason,
              selectableCharCount: 0,
              rasterImageOpCount: 0,
              maxSingleRasterAreaRatio: 0,
              width: null,
              height: null,
              effectiveDpi: null,
              charCount: 0,
              confidence: null
            })
          }
          continue
        }

        phase = 'render'
        const viewport = computeBoundedPageViewport(page)
        const width = Math.max(1, Math.ceil(viewport.width))
        const height = Math.max(1, Math.ceil(viewport.height))
        const canvas = canvasPkg.createCanvas(width, height)
        const ctx = canvas.getContext('2d')
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, width, height)

        await (
          page as unknown as {
            render: (params: {
              canvasContext: Canvas2DContextLike
              viewport: typeof viewport
              canvas: CanvasInstanceLike
            }) => { promise: Promise<void> }
          }
        ).render({
          canvasContext: ctx,
          viewport,
          canvas
        }).promise

        if (performance.now() - pageStartMs > options.perPageTimeoutMs) {
          throw new Error(
            `Page ${pageNum} rasterization exceeded ${options.perPageTimeoutMs} ms limit`
          )
        }

        phase = 'recognize'
        const imageData = ctx.getImageData(0, 0, width, height)
        const pgm = buildPgmFromRgba(imageData.data, width, height)
        const effectiveDpi = Math.round(viewport.scale * 72)
        const recognized = session.recognizePgm(pgm, effectiveDpi)

        ocrPageCount += 1
        const hasNativeOnPage = inspection.nativeText.length > 0
        if (hasNativeOnPage) {
          usedBothNativeAndOcr = true
        }
        const combinedPageText = hasNativeOnPage
          ? mergeNativeAndOcrPageText(inspection.nativeText, recognized.text)
          : recognized.text

        if (recognized.text.length > 0) {
          confidences.push(recognized.meanConfidence)
        }
        if (combinedPageText.length > 0) {
          const block = `--- Page ${pageNum} ---\n${combinedPageText}`
          pageBlocks.push(block)
          totalChars += block.length
        }

        pageDetails.push({
          pageNumber: pageNum,
          source: hasNativeOnPage ? 'native_and_tesseract_ocr' : 'tesseract_ocr',
          reason: classification.reason,
          selectableCharCount: inspection.selectableCharCount,
          rasterImageOpCount: inspection.rasterImageOpCount,
          maxSingleRasterAreaRatio: Number(inspection.maxSingleRasterAreaRatio.toFixed(4)),
          width,
          height,
          effectiveDpi,
          charCount: combinedPageText.length,
          confidence: recognized.text.length > 0 ? recognized.meanConfidence : null
        })

        if (totalChars >= options.maxExtractedChars) {
          truncated = true
          truncationReason = `OCR extracted text exceeded ${options.maxExtractedChars} character limit`
          break
        }
      } finally {
        page.cleanup()
      }
    }

    const joined = pageBlocks.join('\n\n').trim()
    const finalText =
      joined.length > options.maxExtractedChars
        ? joined.slice(0, options.maxExtractedChars)
        : joined
    const hasText = finalText.length > 0
    const meanConfidence =
      confidences.length > 0
        ? Number((confidences.reduce((a, b) => a + b, 0) / confidences.length).toFixed(2))
        : null

    const extractionMethod =
      (nativeOnlyPageCount > 0 || usedBothNativeAndOcr) && ocrPageCount > 0
        ? 'ocr_hybrid_pdf'
        : ocrPageCount > 0
          ? 'ocr_pdf_tesseract'
          : 'native_pdf_passthrough'

    return makeOutcome({
      status: truncated ? 'truncated' : hasText ? 'extracted' : 'ocr_no_text',
      extractionMethod,
      text: hasText ? finalText : null,
      pageCount: totalPages,
      ocrPageCount,
      nativeOnlyPageCount,
      skippedBlankPageCount,
      meanConfidence,
      truncated,
      truncationReason,
      statusDetail: truncated ? truncationReason : null,
      pageDetails
    })
  } catch (err: unknown) {
    const errName = err instanceof Error ? err.name : ''
    const errMsg = err instanceof Error ? err.message : String(err)
    if (errName === 'PasswordException' || /password/i.test(errMsg)) {
      return makeOutcome({
        status: 'password_protected',
        extractionMethod: 'ocr_pdf_tesseract',
        text: null,
        pageCount: null,
        ocrPageCount: 0,
        nativeOnlyPageCount: 0,
        skippedBlankPageCount: 0,
        meanConfidence: null,
        truncated: false,
        truncationReason: null,
        statusDetail: 'PDF is password protected or encrypted',
        pageDetails: []
      })
    }
    const isPdfFormatError =
      errName === 'InvalidPDFException' ||
      errName === 'FormatError' ||
      errName === 'MissingPDFException' ||
      errName === 'UnexpectedResponseException'
    const isRendererRuntimeError =
      !isPdfFormatError &&
      (phase === 'render' ||
        phase === 'recognize' ||
        err instanceof TypeError ||
        /CanvasRenderingContext2D|Path2D|DOMMatrix|Canvas|napi-rs|tesseract|exceeded .* ms limit/i.test(
          errMsg
        ))
    return makeOutcome({
      status: 'corrupt_or_failed',
      extractionMethod: 'ocr_pdf_tesseract',
      text: null,
      pageCount: null,
      ocrPageCount: 0,
      nativeOnlyPageCount: 0,
      skippedBlankPageCount: 0,
      meanConfidence: null,
      truncated: false,
      truncationReason: null,
      statusDetail: isRendererRuntimeError
        ? `PDF OCR renderer/runtime error: ${errMsg}`
        : `Corrupt or unreadable PDF for OCR: ${errMsg}`,
      pageDetails: []
    })
  } finally {
    if (pdfDoc) {
      try {
        await (pdfDoc as unknown as { cleanup?: () => Promise<void> }).cleanup?.()
      } catch {
        // Ignore cleanup error
      }
    }
    try {
      await loadingTask.destroy()
    } catch {
      // Ignore destroy error
    }
  }
}

export async function extractDocumentOcrFromBuffer(
  buffer: Buffer,
  extension: string,
  session: OcrEngineSession,
  options?: DocumentOcrOptions
): Promise<DocumentOcrOutcome> {
  const ext = normalizeExtension(extension)
  const maxInputBytes = options?.maxInputBytes ?? DOCUMENT_OCR_LIMITS.MAX_INPUT_BYTES
  const maxPdfPages = options?.maxPdfPages ?? DOCUMENT_OCR_LIMITS.MAX_PDF_PAGES
  const maxExtractedChars = options?.maxExtractedChars ?? DOCUMENT_OCR_LIMITS.MAX_EXTRACTED_CHARS
  const perPageTimeoutMs = options?.perPageTimeoutMs ?? DOCUMENT_OCR_LIMITS.PER_PAGE_TIMEOUT_MS
  const pageDelayMs = options?.pageDelayMs ?? 0

  if (!SUPPORTED_OCR_EXTENSIONS.has(ext)) {
    return makeOutcome({
      status: 'unsupported',
      extractionMethod: 'none',
      text: null,
      pageCount: null,
      ocrPageCount: 0,
      nativeOnlyPageCount: 0,
      skippedBlankPageCount: 0,
      meanConfidence: null,
      truncated: false,
      truncationReason: null,
      statusDetail: `Format ${ext || '(no extension)'} is not supported for offline OCR in Stage 7C`,
      pageDetails: []
    })
  }

  if (buffer.byteLength > maxInputBytes) {
    const reason = `Input file size (${buffer.byteLength} bytes) exceeded ${maxInputBytes} byte OCR limit`
    return makeOutcome({
      status: 'truncated',
      extractionMethod: 'none',
      text: null,
      pageCount: null,
      ocrPageCount: 0,
      nativeOnlyPageCount: 0,
      skippedBlankPageCount: 0,
      meanConfidence: null,
      truncated: true,
      truncationReason: reason,
      statusDetail: reason,
      pageDetails: []
    })
  }

  if (ext === '.pdf') {
    return extractPdfOcr(buffer, session, {
      maxPdfPages,
      maxExtractedChars,
      perPageTimeoutMs,
      pageDelayMs
    })
  }

  if (SUPPORTED_OCR_IMAGE_EXTENSIONS.has(ext)) {
    return extractImageOcr(buffer, session, maxExtractedChars)
  }

  return makeOutcome({
    status: 'unsupported',
    extractionMethod: 'none',
    text: null,
    pageCount: null,
    ocrPageCount: 0,
    nativeOnlyPageCount: 0,
    skippedBlankPageCount: 0,
    meanConfidence: null,
    truncated: false,
    truncationReason: null,
    statusDetail: `Format ${ext} is not supported for offline OCR in Stage 7C`,
    pageDetails: []
  })
}
