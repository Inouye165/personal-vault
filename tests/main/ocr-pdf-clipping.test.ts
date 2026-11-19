// @vitest-environment node
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CatalogDatabase } from '../../src/main/services/catalog'
import {
  DocumentOcrCoordinator,
  OcrEngineSession,
  OcrModelManager,
  extractDocumentOcrFromBuffer
} from '../../src/main/services/documents/ocr'
import { DOCUMENT_OCR_LIMITS } from '../../src/main/services/documents/ocr/types'
import { AppWorkerBudget } from '../../src/main/services/worker-budget'

const CACHED_MODEL_DIR = resolve(
  process.cwd(),
  'spikes',
  'ocr-eval',
  '.model-cache',
  'tessdata_fast_eng@65727574'
)
const HAS_CACHED_MODEL = existsSync(join(CACHED_MODEL_DIR, 'eng.traineddata'))

interface Canvas2D {
  fillStyle: string
  font: string
  textAlign: string
  textBaseline: string
  fillRect: (x: number, y: number, w: number, h: number) => void
  fillText: (text: string, x: number, y: number) => void
  getImageData: (x: number, y: number, w: number, h: number) => { data: Uint8ClampedArray }
}

interface NapiCanvasPkg {
  createCanvas: (w: number, h: number) => { getContext: (t: '2d') => Canvas2D }
}

function getCanvasPkg(): NapiCanvasPkg {
  const req = createRequire(pathToFileURL(join(process.cwd(), 'package.json')).href)
  return req('@napi-rs/canvas') as NapiCanvasPkg
}

function renderTextToRgbImage(
  width: number,
  height: number,
  draw: (ctx: Canvas2D) => void
): Buffer {
  const { createCanvas } = getCanvasPkg()
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  draw(ctx)
  const rgba = ctx.getImageData(0, 0, width, height).data
  const rgb = Buffer.allocUnsafe(width * height * 3)
  for (let i = 0, p = 0, q = 0; i < width * height; i++, p += 4, q += 3) {
    rgb[q] = rgba[p]!
    rgb[q + 1] = rgba[p + 1]!
    rgb[q + 2] = rgba[p + 2]!
  }
  return rgb
}

function buildPdfFromObjects(objects: readonly (string | Buffer)[]): Buffer {
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n', 'ascii')]
  const offsets: number[] = [0]
  let cursor = chunks[0]!.byteLength

  for (let i = 0; i < objects.length; i++) {
    offsets.push(cursor)
    const header = Buffer.from(`${i + 1} 0 obj\n`, 'ascii')
    const item = objects[i]!
    const body = typeof item === 'string' ? Buffer.from(item, 'latin1') : item
    const footer = Buffer.from('\nendobj\n', 'ascii')
    chunks.push(header, body, footer)
    cursor += header.byteLength + body.byteLength + footer.byteLength
  }

  const xrefOffset = cursor
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (let i = 1; i <= objects.length; i++) {
    xref += `${String(offsets[i]!).padStart(10, '0')} 00000 n \n`
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  chunks.push(Buffer.from(xref + trailer, 'ascii'))
  return Buffer.concat(chunks)
}

function buildImageObject(width: number, height: number, rgbBytes: Buffer): Buffer {
  const head = Buffer.from(
    `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${rgbBytes.byteLength} >>\nstream\n`,
    'ascii'
  )
  const tail = Buffer.from('\nendstream', 'ascii')
  return Buffer.concat([head, rgbBytes, tail])
}

function buildClippedImagePdf(opts: {
  readonly width: number
  readonly height: number
  readonly rgbBytes: Buffer
  readonly contentCommands: string
}): Buffer {
  const contentBuf = Buffer.from(opts.contentCommands, 'ascii')
  return buildPdfFromObjects([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${opts.width} ${opts.height}] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${contentBuf.byteLength} >>\nstream\n${opts.contentCommands}\nendstream`,
    buildImageObject(opts.width, opts.height, opts.rgbBytes)
  ])
}

function buildFormXObjectClippedPdf(opts: {
  readonly width: number
  readonly height: number
  readonly rgbBytes: Buffer
}): Buffer {
  const formCommands = [
    'q',
    `10 10 ${opts.width - 20} ${opts.height - 20} re W n`,
    `${opts.width} 0 0 ${opts.height} 0 0 cm`,
    '/Im0 Do',
    'Q'
  ].join('\n')
  const pageCommands = 'q\n/Fm0 Do\nQ'
  return buildPdfFromObjects([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${opts.width} ${opts.height}] /Resources << /XObject << /Fm0 5 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${pageCommands.length} >>\nstream\n${pageCommands}\nendstream`,
    `<< /Type /XObject /Subtype /Form /FormType 1 /BBox [0 0 ${opts.width} ${opts.height}] /Group << /Type /Group /S /Transparency /CS /DeviceRGB >> /Resources << /XObject << /Im0 6 0 R >> >> /Length ${formCommands.length} >>\nstream\n${formCommands}\nendstream`,
    buildImageObject(opts.width, opts.height, opts.rgbBytes)
  ])
}

describe('Stage 7C PDF clipping, Form XObject rendering, and error classification', () => {
  let tempDir = ''
  let session: OcrEngineSession | null = null

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pv-ocr-pdf-clip-'))
  })

  afterEach(async () => {
    session?.dispose()
    session = null
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it.skipIf(!HAS_CACHED_MODEL)(
    'preserves nonzero (W n), evenodd (W* n), and Form XObject transparency-group clipping during PDF OCR',
    async () => {
      session = new OcrEngineSession()
      const init = await session.ensureInitialized(CACHED_MODEL_DIR)
      expect(init.ok).toBe(true)

      const width = 640
      const height = 400

      // 1. Nonzero clip: upper region visible ("VISIBLE CLIPPED 42"), lower region outside clip ("HIDDEN OUTSIDE 99")
      const nonzeroImg = renderTextToRgbImage(width, height, (ctx) => {
        ctx.fillStyle = '#000000'
        ctx.font = 'bold 42px sans-serif'
        ctx.fillText('VISIBLE CLIPPED 42', 40, 100)
        ctx.fillText('HIDDEN OUTSIDE 99', 40, 320)
      })
      const nonzeroPdf = buildClippedImagePdf({
        width,
        height,
        rgbBytes: nonzeroImg,
        contentCommands: [
          'q',
          // PDF coordinates have origin at bottom-left: y=[220..390] corresponds to top half of image
          `0 220 ${width} 170 re W n`,
          `${width} 0 0 ${height} 0 0 cm`,
          '/Im0 Do',
          'Q'
        ].join('\n')
      })

      const nonzeroRes = await extractDocumentOcrFromBuffer(nonzeroPdf, '.pdf', session, {
        maxPdfPages: DOCUMENT_OCR_LIMITS.MAX_PDF_PAGES,
        maxExtractedChars: DOCUMENT_OCR_LIMITS.MAX_EXTRACTED_CHARS,
        perPageTimeoutMs: DOCUMENT_OCR_LIMITS.PER_PAGE_TIMEOUT_MS,
        pageDelayMs: 0
      })
      expect(nonzeroRes.status).toBe('extracted')
      expect(nonzeroRes.text?.toUpperCase()).toContain('VISIBLE CLIPPED 42')
      expect(nonzeroRes.text?.toUpperCase()).not.toContain('HIDDEN OUTSIDE 99')

      // 2. Evenodd clip (W* n): outer ring visible ("OUTER RING 77"), inner hole clipped out ("HOLE DECOY 88")
      const evenoddImg = renderTextToRgbImage(width, height, (ctx) => {
        ctx.fillStyle = '#000000'
        ctx.font = 'bold 38px sans-serif'
        ctx.fillText('OUTER RING 77', 40, 70)
        ctx.fillText('HOLE DECOY 88', 150, 220)
      })
      const evenoddPdf = buildClippedImagePdf({
        width,
        height,
        rgbBytes: evenoddImg,
        contentCommands: [
          'q',
          // Outer rectangle covers full page; inner hole covers y=[120..260] (middle)
          `0 0 ${width} ${height} re`,
          '80 120 480 140 re',
          'W* n',
          `${width} 0 0 ${height} 0 0 cm`,
          '/Im0 Do',
          'Q'
        ].join('\n')
      })

      const evenoddRes = await extractDocumentOcrFromBuffer(evenoddPdf, '.pdf', session, {
        maxPdfPages: DOCUMENT_OCR_LIMITS.MAX_PDF_PAGES,
        maxExtractedChars: DOCUMENT_OCR_LIMITS.MAX_EXTRACTED_CHARS,
        perPageTimeoutMs: DOCUMENT_OCR_LIMITS.PER_PAGE_TIMEOUT_MS,
        pageDelayMs: 0
      })
      expect(evenoddRes.status).toBe('extracted')
      expect(evenoddRes.text?.toUpperCase()).toContain('OUTER RING 77')
      expect(evenoddRes.text?.toUpperCase()).not.toContain('HOLE DECOY 88')

      // 3. Form XObject with /Group << /S /Transparency >> and clipping path
      const formImg = renderTextToRgbImage(width, height, (ctx) => {
        ctx.fillStyle = '#000000'
        ctx.font = 'bold 42px sans-serif'
        ctx.fillText('FORM XOBJECT 55', 60, 180)
      })
      const formPdf = buildFormXObjectClippedPdf({
        width,
        height,
        rgbBytes: formImg
      })

      const formRes = await extractDocumentOcrFromBuffer(formPdf, '.pdf', session, {
        maxPdfPages: DOCUMENT_OCR_LIMITS.MAX_PDF_PAGES,
        maxExtractedChars: DOCUMENT_OCR_LIMITS.MAX_EXTRACTED_CHARS,
        perPageTimeoutMs: DOCUMENT_OCR_LIMITS.PER_PAGE_TIMEOUT_MS,
        pageDelayMs: 0
      })
      expect(formRes.status).toBe('extracted')
      expect(formRes.text?.toUpperCase()).toContain('FORM XOBJECT 55')
    },
    30_000
  )

  it.skipIf(!HAS_CACHED_MODEL)(
    'distinguishes renderer/runtime failures from genuinely corrupt PDFs',
    async () => {
      session = new OcrEngineSession()
      const init = await session.ensureInitialized(CACHED_MODEL_DIR)
      expect(init.ok).toBe(true)

      const corruptPdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Broken', 'ascii')
      const corruptRes = await extractDocumentOcrFromBuffer(corruptPdf, '.pdf', session, {
        maxPdfPages: DOCUMENT_OCR_LIMITS.MAX_PDF_PAGES,
        maxExtractedChars: DOCUMENT_OCR_LIMITS.MAX_EXTRACTED_CHARS,
        perPageTimeoutMs: DOCUMENT_OCR_LIMITS.PER_PAGE_TIMEOUT_MS,
        pageDelayMs: 0
      })
      expect(corruptRes.status).toBe('corrupt_or_failed')
      expect(corruptRes.statusDetail).toMatch(/^Corrupt or unreadable PDF for OCR:/)

      const validImg = renderTextToRgbImage(320, 200, (ctx) => {
        ctx.fillStyle = '#000000'
        ctx.font = 'bold 30px sans-serif'
        ctx.fillText('TIMEOUT CHECK', 20, 100)
      })
      const validPdf = buildFormXObjectClippedPdf({
        width: 320,
        height: 200,
        rgbBytes: validImg
      })
      const runtimeFailRes = await extractDocumentOcrFromBuffer(validPdf, '.pdf', session, {
        maxPdfPages: DOCUMENT_OCR_LIMITS.MAX_PDF_PAGES,
        maxExtractedChars: DOCUMENT_OCR_LIMITS.MAX_EXTRACTED_CHARS,
        perPageTimeoutMs: -1,
        pageDelayMs: 0
      })
      expect(runtimeFailRes.status).toBe('corrupt_or_failed')
      expect(runtimeFailRes.statusDetail).toMatch(/^PDF OCR renderer\/runtime error:/)
    },
    20_000
  )

  it.skipIf(!HAS_CACHED_MODEL)(
    'retries a previously failed catalog item via selected OCR without rescanning or reinstalling model',
    async () => {
      const docsDir = join(tempDir, 'docs')
      const modelsRootDir = join(tempDir, 'models')
      await mkdir(docsDir, { recursive: true })

      const formImg = renderTextToRgbImage(640, 320, (ctx) => {
        ctx.fillStyle = '#000000'
        ctx.font = 'bold 42px sans-serif'
        ctx.fillText('RETRY CLIPPED 88', 60, 160)
      })
      const pdfBytes = buildFormXObjectClippedPdf({ width: 640, height: 320, rgbBytes: formImg })
      const pdfPath = join(docsDir, 'clipped_retry.pdf')
      await writeFile(pdfPath, pdfBytes)
      const sha256 = createHash('sha256').update(pdfBytes).digest('hex')

      const catalog = CatalogDatabase.open({ catalogPath: join(tempDir, 'catalog.db') })
      const modelManager = new OcrModelManager({
        modelsRootDir,
        getApprovedRoots: () => [docsDir],
        getVaultRoot: () => null
      })
      await modelManager.initialize()
      await modelManager.importFromDirectory(CACHED_MODEL_DIR)

      const workerBudget = new AppWorkerBudget(3)
      const coordinator = new DocumentOcrCoordinator({
        catalog,
        modelManager,
        workerBudget
      })
      coordinator.initialize()

      try {
        const fileStat = await stat(pdfPath)
        const modifiedMs = Math.trunc(fileStat.mtimeMs)
        catalog.persistDiscoveryBatch(docsDir, [
          {
            originalPath: pdfPath,
            fileName: 'clipped_retry.pdf',
            extension: '.pdf',
            category: 'document',
            byteSize: pdfBytes.byteLength,
            birthtimeMs: modifiedMs,
            mtimeMs: modifiedMs,
            discoveredAtMs: Date.now()
          }
        ])
        const page = catalog.getDocumentRepository().getDocumentsPage({ offset: 0, limit: 10 })
        const fileLocationId = page.items[0]!.fileLocationId
        const candidate = catalog
          .getDocumentRepository()
          .getDocumentExtractionCandidate(fileLocationId)!

        // Seed a previously failed OCR row (as from the earlier Path2D failure)
        const ocrRepo = catalog.getDocumentOcrRepository()
        ocrRepo.upsertDocumentOcrExtraction({
          fileLocationId,
          expectedDiscoveryObservationId: candidate.discoveryObservationId,
          expectedContentRevision: candidate.contentRevision,
          contentSha256: sha256,
          observedByteSize: pdfBytes.byteLength,
          observedMtimeMs: modifiedMs,
          recipeVersion: 'doc_ocr_v1',
          ocrModelId: modelManager.getStatus().modelId,
          ocrModelManifestSha256: modelManager.getStatus().modelManifestSha256,
          ocrLanguage: modelManager.getStatus().language,
          extractionMethod: 'ocr_pdf_tesseract',
          ocrStatus: 'corrupt_or_failed',
          statusDetail:
            "Corrupt or unreadable PDF for OCR: Failed to execute 'clip' on 'CanvasRenderingContext2D'",
          extractedText: null,
          extractedCharCount: 0,
          pageCount: null,
          ocrPageCount: 0,
          nativeOnlyPageCount: 0,
          skippedBlankPageCount: 0,
          meanConfidence: null,
          truncated: false,
          truncationReason: null,
          extractedAtMs: Date.now()
        })

        // Retry through selected OCR without rescanning or reinstalling the model
        await coordinator.ocrSelected({
          fileLocationIds: [fileLocationId],
          forceReocr: true
        })
        await coordinator.waitForIdle()
        const progress = coordinator.getProgress()
        expect(['completed', 'idle']).toContain(progress.status)

        const preview = coordinator.getOcrPreview(fileLocationId)
        expect(preview?.ocrStatus).toBe('extracted')
        expect(preview?.extractedText?.toUpperCase()).toContain('RETRY CLIPPED 88')
      } finally {
        await coordinator.shutdown()
        await modelManager.shutdown()
        catalog.close()
      }
    },
    30_000
  )
})
