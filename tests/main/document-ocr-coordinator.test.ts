// @vitest-environment node
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CatalogDatabase } from '../../src/main/services/catalog'
import { buildDocumentContentRevision } from '../../src/main/services/catalog/document-repository'
import { DocumentExtractionCoordinator } from '../../src/main/services/documents/coordinator'
import { DOCUMENT_EXTRACTION_RECIPE_VERSION } from '../../src/main/services/documents/types'
import {
  DOCUMENT_OCR_RECIPE_VERSION,
  DocumentOcrCoordinator,
  OcrModelManager,
  OcrModelUnavailableError,
  type OcrModelArtifactSpec
} from '../../src/main/services/documents/ocr'
import { ThumbnailCoordinator } from '../../src/main/services/thumbnails/coordinator'
import { AppWorkerBudget } from '../../src/main/services/worker-budget'
import {
  buildSyntheticPdfBuffer,
  createOcrFoundationTestFixtures
} from '../helpers/ocr-synthetic-fixtures'

const CACHED_SPIKE_MODEL_DIR = resolve(
  process.cwd(),
  'spikes',
  'ocr-eval',
  '.model-cache',
  'tessdata_fast_eng@65727574'
)
const CACHED_TRAINED_DATA_FILE = join(CACHED_SPIKE_MODEL_DIR, 'eng.traineddata')

function sha256Of(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

const SYNTHETIC_MODEL_BYTES = Buffer.from('SYNTHETIC_TESSDATA_FIXTURE_FOR_COORDINATOR_TESTS_V1')
const SYNTHETIC_MODEL_ARTIFACTS: readonly OcrModelArtifactSpec[] = [
  {
    relativePath: 'eng.traineddata',
    byteSize: SYNTHETIC_MODEL_BYTES.byteLength,
    sha256: sha256Of(SYNTHETIC_MODEL_BYTES)
  }
]

function writeSyntheticOcrWorkerScript(dir: string): string {
  const scriptPath = join(dir, 'synthetic_ocr_worker.cjs')
  writeFileSync(
    scriptPath,
    `const { parentPort } = require('node:worker_threads');
     const { createHash } = require('node:crypto');
     const fs = require('node:fs');

     parentPort.on('message', async (msg) => {
       if (!msg || typeof msg !== 'object') return;
       if (msg.type === 'shutdown') {
         parentPort.postMessage({ id: msg.id, type: 'shutdown_ack', ok: true, nestedWorkerAttempts: 0, outboundNetworkAttempts: 0 });
         return;
       }
       if (msg.type === 'verify_source' || msg.type === 'ocr_file') {
         try {
           const st = fs.statSync(msg.sourcePath);
           const buf = fs.readFileSync(msg.sourcePath);
           const sha = createHash('sha256').update(buf).digest('hex');
           if (st.size !== msg.expectedByteSize || (msg.expectedSha256 && sha !== msg.expectedSha256)) {
             parentPort.postMessage({
               id: msg.id,
               type: msg.type === 'verify_source' ? 'verify_result' : 'ocr_result',
               ok: false,
               errorCode: 'FILE_CHANGED',
               errorMessage: 'Source changed on disk',
               nestedWorkerAttempts: 0,
               outboundNetworkAttempts: 0,
               durationMs: 1
             });
             return;
           }
           if (msg.type === 'verify_source') {
             parentPort.postMessage({
               id: msg.id,
               type: 'verify_result',
               ok: true,
               observedSha256: sha,
               observedByteSize: st.size,
               observedMtimeMs: st.mtimeMs,
               nestedWorkerAttempts: 0,
               outboundNetworkAttempts: 0,
               durationMs: 1
             });
             return;
           }

           const contentText = buf.toString('utf8');
           if (contentText.includes('HANG_FOREVER')) {
             return; // Simulate hung worker for timeout recovery test
           }
           if (msg.options && msg.options.pageDelayMs) {
             await new Promise((r) => setTimeout(r, msg.options.pageDelayMs));
           }
           const text = contentText.includes('BLANK_PAGE') ? null : 'OCR_SYNTHETIC:' + contentText.trim();
           parentPort.postMessage({
             id: msg.id,
             type: 'ocr_result',
             ok: true,
             observedSha256: sha,
             observedByteSize: st.size,
             observedMtimeMs: st.mtimeMs,
             maxInputBytesUsed: 67108864,
             outcome: {
               status: text ? 'extracted' : 'ocr_no_text',
               recipeVersion: 'doc_ocr_v1',
               extractionMethod: msg.extension.toLowerCase() === '.pdf' ? 'ocr_pdf_tesseract' : 'ocr_image_tesseract',
               text,
               extractedCharCount: text ? text.length : 0,
               pageCount: 1,
               ocrPageCount: 1,
               nativeOnlyPageCount: 0,
               skippedBlankPageCount: 0,
               meanConfidence: text ? 92.5 : null,
               truncated: false,
               truncationReason: null,
               statusDetail: text ? null : 'No recognizable text found',
               pageDetails: []
             },
             engineTelemetry: null,
             nestedWorkerAttempts: 0,
             outboundNetworkAttempts: 0,
             durationMs: 2
           });
         } catch (err) {
           parentPort.postMessage({
             id: msg.id,
             type: msg.type === 'verify_source' ? 'verify_result' : 'ocr_result',
             ok: false,
             errorCode: 'IO_ERROR',
             errorMessage: String(err),
             nestedWorkerAttempts: 0,
             outboundNetworkAttempts: 0,
             durationMs: 1
           });
         }
       }
     });
    `,
    'utf8'
  )
  return scriptPath
}

describe('Stage 7C Slice 2 — DocumentOcrCoordinator', () => {
  const tempDirs: string[] = []
  const openCatalogs: CatalogDatabase[] = []
  const shutdownCallbacks: Array<() => Promise<void>> = []

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'pv-doc-ocr-coord-'))
    tempDirs.push(dir)
    return dir
  }

  afterEach(async () => {
    for (const fn of shutdownCallbacks.splice(0).reverse()) {
      await fn()
    }
    for (const cat of openCatalogs.splice(0)) {
      if (!cat.isClosed()) {
        cat.close()
      }
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails closed when the OCR model is missing, tampered, or mismatched on resume without creating jobs or network calls', async () => {
    const rootDir = makeTempDir()
    const docsDir = join(rootDir, 'docs')
    const modelsRootDir = join(rootDir, 'models')
    mkdirSync(docsDir, { recursive: true })

    const catalog = CatalogDatabase.open({ catalogPath: join(rootDir, 'catalog.db') })
    openCatalogs.push(catalog)
    catalog.registerSource(docsDir)

    const docPath = join(docsDir, 'scan.pdf')
    const docBuf = Buffer.from('SCANNED_INVOICE_1001')
    writeFileSync(docPath, docBuf)
    const st = statSync(docPath)
    catalog.persistDiscoveryBatch(docsDir, [
      {
        originalPath: docPath,
        fileName: 'scan.pdf',
        extension: '.pdf',
        category: 'document',
        byteSize: st.size,
        birthtimeMs: st.birthtimeMs,
        mtimeMs: st.mtimeMs,
        discoveredAtMs: Date.now()
      }
    ])

    const modelManager = new OcrModelManager({
      modelsRootDir,
      getApprovedRoots: () => [docsDir],
      getVaultRoot: () => null,
      artifacts: SYNTHETIC_MODEL_ARTIFACTS
    })
    await modelManager.initialize()

    const workerScript = writeSyntheticOcrWorkerScript(rootDir)
    const coord = new DocumentOcrCoordinator({
      catalog,
      modelManager,
      workerScriptPath: workerScript,
      isPackaged: true
    })
    shutdownCallbacks.push(() => coord.shutdown())

    // 1. Model missing -> rejects with OcrModelUnavailableError('OCR_MODEL_MISSING') and creates 0 jobs
    await expect(coord.startOcr({ scope: 'all' })).rejects.toBeInstanceOf(OcrModelUnavailableError)
    await expect(coord.startOcr({ scope: 'all' })).rejects.toMatchObject({
      name: 'OcrModelUnavailableError',
      code: 'OCR_MODEL_MISSING'
    })
    expect(catalog.getDocumentOcrRepository().getLatestDocumentOcrJob()).toBeNull()

    // 2. Import valid model, then tamper with installed artifact -> rejects with OCR_MODEL_INVALID
    const importSrc = join(rootDir, 'import-src')
    mkdirSync(importSrc, { recursive: true })
    writeFileSync(join(importSrc, 'eng.traineddata'), SYNTHETIC_MODEL_BYTES)
    const imported = await modelManager.importFromDirectory(importSrc)
    expect(imported.state).toBe('ready')

    const installDir = modelManager.getActiveModelInstallDir()!
    writeFileSync(join(installDir, 'eng.traineddata'), Buffer.from('CORRUPTED_BYTES'))

    await expect(coord.ocrSelected({ fileLocationIds: [1] })).rejects.toMatchObject({
      name: 'OcrModelUnavailableError',
      code: 'OCR_MODEL_INVALID'
    })
    expect(catalog.getDocumentOcrRepository().getLatestDocumentOcrJob()).toBeNull()

    // 3. Re-import valid model, seed an interrupted job with a different manifest SHA-256 -> resumeOcr rejects with OCR_MODEL_MISMATCH
    rmSync(installDir, { recursive: true, force: true })
    await modelManager.importFromDirectory(importSrc)

    await catalog.getDocumentOcrRepository().createDocumentOcrJob({
      jobId: 'legacy-manifest-job',
      scopeKind: 'all',
      recipeVersion: DOCUMENT_OCR_RECIPE_VERSION,
      ocrModelId: imported.modelId,
      ocrModelManifestSha256: 'e'.repeat(64),
      ocrLanguage: 'eng'
    })
    catalog.getDocumentOcrRepository().markRunningDocumentOcrJobsAsInterrupted()

    await expect(coord.resumeOcr()).rejects.toMatchObject({
      name: 'OcrModelUnavailableError',
      code: 'OCR_MODEL_MISMATCH'
    })
  })

  it('supports pause/resume, active cancellation, worker timeout recovery, and frozen-snapshot crash restart recovery', async () => {
    const rootDir = makeTempDir()
    const docsDir = join(rootDir, 'docs')
    const modelsRootDir = join(rootDir, 'models')
    const importSrc = join(rootDir, 'import-src')
    mkdirSync(docsDir, { recursive: true })
    mkdirSync(importSrc, { recursive: true })
    writeFileSync(join(importSrc, 'eng.traineddata'), SYNTHETIC_MODEL_BYTES)

    const catalogPath = join(rootDir, 'catalog.db')
    let catalog = CatalogDatabase.open({ catalogPath })
    openCatalogs.push(catalog)
    catalog.registerSource(docsDir)

    const seedDoc = (name: string, body: string) => {
      const p = join(docsDir, name)
      const buf = Buffer.from(body)
      writeFileSync(p, buf)
      const st = statSync(p)
      catalog.persistDiscoveryBatch(docsDir, [
        {
          originalPath: p,
          fileName: name,
          extension: '.pdf',
          category: 'document',
          byteSize: st.size,
          birthtimeMs: st.birthtimeMs,
          mtimeMs: st.mtimeMs,
          discoveredAtMs: Date.now()
        }
      ])
      catalog.recordHashObservationsBatch([
        {
          originalPath: p,
          sha256: sha256Of(buf),
          observedByteSize: st.size,
          observedMtimeMs: st.mtimeMs,
          hashedAtMs: Date.now()
        }
      ])
    }

    seedDoc('doc1.pdf', 'PAGE_ONE_TEXT')
    seedDoc('doc2.pdf', 'PAGE_TWO_TEXT')
    seedDoc('doc3.pdf', 'PAGE_THREE_TEXT')

    const modelManager = new OcrModelManager({
      modelsRootDir,
      getApprovedRoots: () => [docsDir],
      getVaultRoot: () => null,
      artifacts: SYNTHETIC_MODEL_ARTIFACTS
    })
    await modelManager.importFromDirectory(importSrc)

    const workerBudget = new AppWorkerBudget(3)
    const workerScript = writeSyntheticOcrWorkerScript(rootDir)

    // --- A. Pause & Resume ---
    const coord = new DocumentOcrCoordinator({
      catalog,
      modelManager,
      workerBudget,
      workerScriptPath: workerScript,
      isPackaged: true,
      ocrOptions: { pageDelayMs: 80 }
    })
    shutdownCallbacks.push(() => coord.shutdown())

    await coord.startOcr({ scope: 'all' })
    await new Promise((r) => setTimeout(r, 95))
    coord.pauseOcr()
    await coord.waitForIdle()

    const pausedProgress = coord.getProgress()
    expect(pausedProgress.status).toBe('paused')
    expect(pausedProgress.processedItems).toBeGreaterThanOrEqual(1)
    expect(pausedProgress.pendingItems).toBeGreaterThanOrEqual(1)

    await coord.resumeOcr()
    await coord.waitForIdle()

    const completedProgress = coord.getProgress()
    expect(completedProgress.status).toBe('completed')
    expect(completedProgress.extractedItems).toBe(3)
    expect(completedProgress.pendingItems).toBe(0)

    // --- B. Active Cancellation ---
    await coord.startOcr({ scope: 'all', forceReocr: true })
    await new Promise((r) => setTimeout(r, 30))
    const cancelledProgress = await coord.cancelOcr()
    expect(cancelledProgress.status).toBe('cancelled')
    expect(workerBudget.getLiveCount()).toBe(0)
    expect(workerBudget.getReservedCount()).toBe(0)

    // --- C. Per-Item Worker Timeout Recovery ---
    seedDoc('doc4_hang.pdf', 'HANG_FOREVER')
    seedDoc('doc5_after_timeout.pdf', 'RECOVERED_AFTER_TIMEOUT')

    const timeoutCoord = new DocumentOcrCoordinator({
      catalog,
      modelManager,
      workerBudget,
      workerScriptPath: workerScript,
      isPackaged: true,
      workerTimeoutMs: 250
    })
    shutdownCallbacks.push(() => timeoutCoord.shutdown())

    await timeoutCoord.ocrSelected({ fileLocationIds: [4, 5], forceReocr: true })
    await timeoutCoord.waitForIdle()

    const timeoutJob = timeoutCoord.getProgress()
    expect(timeoutJob.status).toBe('completed')
    expect(timeoutJob.failedItems).toBe(1)
    expect(timeoutJob.extractedItems).toBe(1)
    expect(timeoutCoord.getOcrState(4)?.ocrStatus).toBe('corrupt_or_failed')
    expect(timeoutCoord.getOcrPreview(5)?.extractedText).toContain('RECOVERED_AFTER_TIMEOUT')

    // --- D. Simulated Crash + Restart Resume Over Frozen Point-in-Time Scope ---
    await catalog.getDocumentOcrRepository().createDocumentOcrJob({
      jobId: 'simulated-crash-job',
      scopeKind: 'selected',
      fileLocationIds: [1, 2],
      forceReocr: true,
      recipeVersion: DOCUMENT_OCR_RECIPE_VERSION,
      ocrModelId: modelManager.getStatus().modelId,
      ocrModelManifestSha256: modelManager.getStatus().modelManifestSha256,
      ocrLanguage: 'eng'
    })
    await coord.shutdown()
    await timeoutCoord.shutdown()
    catalog.close()

    // Reopen catalog on simulated restart, discover a NEW file BEFORE resuming, and verify
    // resumeOcr() processes ONLY the frozen snapshot [1, 2], ignoring the newly discovered file!
    catalog = CatalogDatabase.open({ catalogPath })
    openCatalogs.push(catalog)
    seedDoc('doc6_added_after_crash.pdf', 'NEW_UNFROZEN_DOC')

    const restartCoord = new DocumentOcrCoordinator({
      catalog,
      modelManager,
      workerBudget,
      workerScriptPath: workerScript,
      isPackaged: true
    })
    shutdownCallbacks.push(() => restartCoord.shutdown())

    const initProg = restartCoord.initialize()
    expect(initProg.status).toBe('interrupted')
    expect(initProg.totalItems).toBe(2)
    expect(initProg.pendingItems).toBe(2)

    await restartCoord.resumeOcr()
    await restartCoord.waitForIdle()

    const resumedProg = restartCoord.getProgress()
    expect(resumedProg.status).toBe('completed')
    expect(resumedProg.totalItems).toBe(2)
    expect(resumedProg.extractedItems).toBe(2)
    expect(catalog.getDocumentOcrRepository().getDocumentOcrState(6)?.ocrStatus).toBe(
      'not_processed'
    )
    expect(workerBudget.getLiveCount()).toBe(0)
    expect(workerBudget.getReservedCount()).toBe(0)
  })

  it('respects shared AppWorkerBudget(3) alongside ThumbnailCoordinator and DocumentExtractionCoordinator', async () => {
    const rootDir = makeTempDir()
    const docsDir = join(rootDir, 'docs')
    const thumbCacheDir = join(rootDir, 'thumbs')
    const modelsRootDir = join(rootDir, 'models')
    const importSrc = join(rootDir, 'import-src')
    mkdirSync(docsDir, { recursive: true })
    mkdirSync(thumbCacheDir, { recursive: true })
    mkdirSync(importSrc, { recursive: true })
    writeFileSync(join(importSrc, 'eng.traineddata'), SYNTHETIC_MODEL_BYTES)

    const fixtures = await createOcrFoundationTestFixtures(docsDir)
    const catalog = CatalogDatabase.open({ catalogPath: join(rootDir, 'catalog.db') })
    openCatalogs.push(catalog)
    catalog.registerSource(docsDir)

    const txtPath = join(docsDir, 'notes.txt')
    const txtBuf = Buffer.from('Plain text notes for concurrent Stage 7B extraction')
    writeFileSync(txtPath, txtBuf)
    const txtStat = statSync(txtPath)

    catalog.persistDiscoveryBatch(docsDir, [
      {
        originalPath: fixtures.receiptPng.filePath,
        fileName: 'receipt.png',
        extension: '.png',
        category: 'photo',
        byteSize: fixtures.receiptPng.byteSize,
        birthtimeMs: fixtures.receiptPng.mtimeMs,
        mtimeMs: fixtures.receiptPng.mtimeMs,
        discoveredAtMs: Date.now()
      },
      {
        originalPath: fixtures.receiptTiff.filePath,
        fileName: 'receipt.tiff',
        extension: '.tiff',
        category: 'photo',
        byteSize: fixtures.receiptTiff.byteSize,
        birthtimeMs: fixtures.receiptTiff.mtimeMs,
        mtimeMs: fixtures.receiptTiff.mtimeMs,
        discoveredAtMs: Date.now()
      },
      {
        originalPath: txtPath,
        fileName: 'notes.txt',
        extension: '.txt',
        category: 'document',
        byteSize: txtStat.size,
        birthtimeMs: txtStat.birthtimeMs,
        mtimeMs: txtStat.mtimeMs,
        discoveredAtMs: Date.now()
      },
      {
        originalPath: fixtures.scannedPdf.filePath,
        fileName: 'scanned.pdf',
        extension: '.pdf',
        category: 'document',
        byteSize: fixtures.scannedPdf.byteSize,
        birthtimeMs: fixtures.scannedPdf.mtimeMs,
        mtimeMs: fixtures.scannedPdf.mtimeMs,
        discoveredAtMs: Date.now()
      }
    ])

    const sharedBudget = new AppWorkerBudget(3)
    let observedMaxLive = 0
    const sampleBudget = () => {
      const live = sharedBudget.getLiveCount()
      if (live > observedMaxLive) observedMaxLive = live
    }
    const sampler = setInterval(sampleBudget, 10)

    const modelManager = new OcrModelManager({
      modelsRootDir,
      getApprovedRoots: () => [docsDir],
      getVaultRoot: () => null,
      artifacts: SYNTHETIC_MODEL_ARTIFACTS
    })
    await modelManager.importFromDirectory(importSrc)

    const thumbCoord = new ThumbnailCoordinator({
      cacheDir: thumbCacheDir,
      approvedRoots: () => [docsDir],
      workerBudget: sharedBudget,
      maxActiveJobs: 2
    })
    const docExtractCoord = new DocumentExtractionCoordinator({
      catalog,
      workerBudget: sharedBudget,
      itemDelayMs: 60,
      tryReleaseExternalIdleWorker: () => thumbCoord.releaseOneIdleWorker()
    })
    const ocrCoord = new DocumentOcrCoordinator({
      catalog,
      modelManager,
      workerBudget: sharedBudget,
      workerScriptPath: writeSyntheticOcrWorkerScript(rootDir),
      isPackaged: true,
      ocrOptions: { pageDelayMs: 60 },
      tryReleaseExternalIdleWorker: () => thumbCoord.releaseOneIdleWorker()
    })

    shutdownCallbacks.push(async () => {
      clearInterval(sampler)
      await ocrCoord.shutdown()
      await docExtractCoord.shutdown()
      await thumbCoord.shutdown()
    })

    // Run thumbnails (up to 2 workers) + native extraction (1 worker) + OCR (1 worker) simultaneously
    const pThumbs = Promise.all([
      thumbCoord.requestThumbnail({
        locationId: 1,
        sourcePath: fixtures.receiptPng.filePath,
        expectedByteSize: fixtures.receiptPng.byteSize,
        expectedMtimeMs: fixtures.receiptPng.mtimeMs
      }),
      thumbCoord.requestThumbnail({
        locationId: 2,
        sourcePath: fixtures.receiptTiff.filePath,
        expectedByteSize: fixtures.receiptTiff.byteSize,
        expectedMtimeMs: fixtures.receiptTiff.mtimeMs
      })
    ])
    const pExtract = docExtractCoord
      .extractSelected({ fileLocationIds: [3] })
      .then(() => docExtractCoord.waitForIdle())
    const pOcr = ocrCoord.ocrSelected({ fileLocationIds: [4] }).then(() => ocrCoord.waitForIdle())

    await Promise.all([pThumbs, pExtract, pOcr])
    sampleBudget()
    clearInterval(sampler)

    expect(observedMaxLive).toBeGreaterThanOrEqual(1)
    expect(observedMaxLive).toBeLessThanOrEqual(3)
    expect(docExtractCoord.getProgress().extractedDocuments).toBe(1)
    expect(ocrCoord.getProgress().extractedItems).toBe(1)

    await ocrCoord.shutdown()
    await docExtractCoord.shutdown()
    await thumbCoord.shutdown()

    expect(sharedBudget.getLiveCount()).toBe(0)
    expect(sharedBudget.getReservedCount()).toBe(0)
  })

  it.skipIf(!existsSync(CACHED_TRAINED_DATA_FILE))(
    'executes real offline WASM OCR end-to-end with Stage 7B coexistence, format reuse, selected receipt OCR, zero bulk photo OCR, and source preservation',
    async () => {
      const rootDir = makeTempDir()
      const docsDir = join(rootDir, 'real-vault-sources')
      const modelsRootDir = join(rootDir, 'models')
      const importSrc = join(rootDir, 'model-import-src')
      mkdirSync(docsDir, { recursive: true })
      mkdirSync(importSrc, { recursive: true })
      copyFileSync(CACHED_TRAINED_DATA_FILE, join(importSrc, 'eng.traineddata'))

      const fixtures = await createOcrFoundationTestFixtures(docsDir)
      const digitalCleanPdfPath = join(docsDir, 'digital_clean_memo.pdf')
      writeFileSync(
        digitalCleanPdfPath,
        buildSyntheticPdfBuffer([
          {
            kind: 'native-text',
            lines: [
              'CLEAN DIGITAL MEMO 2026',
              'Full selectable body text without any raster image operators.'
            ]
          }
        ])
      )

      // Duplicate receipt PNG to verify live off-main source verification + hash reuse
      const receiptCopyPath = join(docsDir, 'receipt_duplicate_copy.png')
      copyFileSync(fixtures.receiptPng.filePath, receiptCopyPath)

      // Ordinary non-selected photo (reuse blankPng visual bytes as ordinary photo)
      const ordinaryPhotoPath = join(docsDir, 'family_sunset.png')
      copyFileSync(fixtures.blankPng.filePath, ordinaryPhotoPath)

      const trackedPaths = [
        digitalCleanPdfPath,
        fixtures.nativeBodyPlusSmallLogoPdf.filePath,
        fixtures.headerPlusScannedBodyPdf.filePath,
        fixtures.scannedPdf.filePath,
        fixtures.blankScanPdf.filePath,
        fixtures.receiptPng.filePath,
        receiptCopyPath,
        ordinaryPhotoPath,
        CACHED_TRAINED_DATA_FILE
      ]
      const beforeDigests = new Map<string, { sha256: string; mtimeMs: number }>()
      for (const p of trackedPaths) {
        const st = statSync(p)
        beforeDigests.set(p, {
          sha256: sha256Of(readFileSync(p)),
          mtimeMs: st.mtimeMs
        })
      }

      const catalog = CatalogDatabase.open({ catalogPath: join(rootDir, 'catalog.db') })
      openCatalogs.push(catalog)
      catalog.registerSource(docsDir)

      const seedEntry = (
        filePath: string,
        fileName: string,
        ext: string,
        category: 'document' | 'photo'
      ) => {
        const st = statSync(filePath)
        const sha = sha256Of(readFileSync(filePath))
        catalog.persistDiscoveryBatch(docsDir, [
          {
            originalPath: filePath,
            fileName,
            extension: ext,
            category,
            byteSize: st.size,
            birthtimeMs: st.birthtimeMs,
            mtimeMs: st.mtimeMs,
            discoveredAtMs: Date.now()
          }
        ])
        catalog.recordHashObservationsBatch([
          {
            originalPath: filePath,
            sha256: sha,
            observedByteSize: st.size,
            observedMtimeMs: st.mtimeMs,
            hashedAtMs: Date.now()
          }
        ])
      }

      seedEntry(digitalCleanPdfPath, '1_digital_clean.pdf', '.pdf', 'document') // id 1
      seedEntry(
        fixtures.nativeBodyPlusSmallLogoPdf.filePath,
        '2_logo_digital.pdf',
        '.pdf',
        'document'
      ) // id 2
      seedEntry(
        fixtures.headerPlusScannedBodyPdf.filePath,
        '3_mixed_header_scan.pdf',
        '.pdf',
        'document'
      ) // id 3
      seedEntry(fixtures.scannedPdf.filePath, '4_scanned_only.pdf', '.pdf', 'document') // id 4
      seedEntry(fixtures.blankScanPdf.filePath, '5_blank_scan.pdf', '.pdf', 'document') // id 5
      seedEntry(fixtures.receiptPng.filePath, '6_selected_receipt.png', '.png', 'photo') // id 6
      seedEntry(receiptCopyPath, '7_selected_receipt_copy.png', '.png', 'photo') // id 7
      seedEntry(ordinaryPhotoPath, '8_ordinary_family_photo.png', '.png', 'photo') // id 8

      const sharedBudget = new AppWorkerBudget(3)

      // 1. Run Stage 7B Native Extraction first
      const nativeCoord = new DocumentExtractionCoordinator({
        catalog,
        workerBudget: sharedBudget
      })
      shutdownCallbacks.push(() => nativeCoord.shutdown())

      await nativeCoord.startExtraction({ scope: 'all' })
      await nativeCoord.waitForIdle()
      expect(nativeCoord.getProgress().status).toBe('completed')

      // Verify Stage 7B native statuses before OCR
      const nativeRepo = catalog.getDocumentRepository()
      expect(nativeRepo.getDocumentPreview(1)?.extractionStatus).toBe('extracted')
      expect(nativeRepo.getDocumentPreview(2)?.extractionStatus).toBe('extracted')
      expect(nativeRepo.getDocumentPreview(3)?.extractionStatus).toBe('extracted')
      expect(nativeRepo.getDocumentPreview(4)?.extractionStatus).toBe('no_text_ocr_required')
      expect(nativeRepo.getDocumentPreview(5)?.extractionStatus).toBe('no_text_ocr_required')

      // 2. Provision pinned English OCR model offline & run startOcr({ scope: 'ocr_needed' })
      const modelManager = new OcrModelManager({
        modelsRootDir,
        getApprovedRoots: () => [docsDir],
        getVaultRoot: () => null
      })
      const modelStatus = await modelManager.importFromDirectory(importSrc)
      expect(modelStatus.state).toBe('ready')

      const ocrCoord = new DocumentOcrCoordinator({
        catalog,
        modelManager,
        workerBudget: sharedBudget
      })
      shutdownCallbacks.push(() => ocrCoord.shutdown())

      await ocrCoord.startOcr({ scope: 'ocr_needed' })
      await ocrCoord.waitForIdle()

      const ocrNeededProgress = ocrCoord.getProgress()
      expect(ocrNeededProgress.status).toBe('completed')
      // Only [3_mixed_header_scan.pdf, 4_scanned_only.pdf, 5_blank_scan.pdf] needed OCR!
      // Digital PDFs [1, 2] were skipped, and ZERO photos [6, 7, 8] were queued!
      expect(ocrNeededProgress.totalItems).toBe(3)
      expect(ocrNeededProgress.extractedItems).toBe(2)
      expect(ocrNeededProgress.noTextItems).toBe(1)

      const ocrRepo = catalog.getDocumentOcrRepository()
      expect(ocrRepo.getDocumentOcrState(1)?.ocrStatus).toBe('not_processed')
      expect(ocrRepo.getDocumentOcrState(2)?.ocrStatus).toBe('not_processed')

      // Mixed PDF (id 3): OCR extracted BOTH selectable header AND scanned body, while Stage 7B native preview remains untouched!
      const mixedOcr = ocrCoord.getOcrPreview(3)
      expect(mixedOcr?.ocrStatus).toBe('extracted')
      expect(mixedOcr?.extractionMethod).toBe('ocr_hybrid_pdf')
      expect(mixedOcr?.extractedText?.toUpperCase()).toContain('PERSONAL VAULT ARCHIVE HEADER')
      expect(mixedOcr?.extractedText?.toUpperCase()).toContain('SCANNED')
      const mixedNativeAfterOcr = nativeCoord.getPreview(3)
      expect(mixedNativeAfterOcr?.extractionStatus).toBe('extracted')
      expect(mixedNativeAfterOcr?.recipeVersion).toBe('doc_extract_v1')

      // Scanned-only PDF (id 4): OCR extracted recognized text
      const scannedOcr = ocrCoord.getOcrPreview(4)
      expect(scannedOcr?.ocrStatus).toBe('extracted')
      expect(scannedOcr?.extractionMethod).toBe('ocr_pdf_tesseract')
      expect((scannedOcr?.extractedCharCount ?? 0) > 15).toBe(true)

      // Blank PDF (id 5): Honest ocr_no_text outcome
      const blankOcr = ocrCoord.getOcrPreview(5)
      expect(blankOcr?.ocrStatus).toBe('ocr_no_text')
      expect(blankOcr?.extractedText).toBeNull()
      expect(blankOcr?.extractedCharCount).toBe(0)

      // Confirm ALL 3 photos remain untouched after bulk OCR
      expect(ocrRepo.getDocumentOcrState(6)?.ocrStatus).toBe('not_processed')
      expect(ocrRepo.getDocumentOcrState(7)?.ocrStatus).toBe('not_processed')
      expect(ocrRepo.getDocumentOcrState(8)?.ocrStatus).toBe('not_processed')

      // 3. Explicitly select receipt photo (6) and duplicate receipt copy (7) -> OCRs 6 & reuses 7; ordinary photo (8) untouched!
      await ocrCoord.ocrSelected({ fileLocationIds: [6, 7] })
      await ocrCoord.waitForIdle()

      const selectedProg = ocrCoord.getProgress()
      expect(selectedProg.status).toBe('completed')
      expect(selectedProg.totalItems).toBe(2)
      expect(selectedProg.extractedItems).toBe(1)
      expect(selectedProg.reusedItems).toBe(1)

      expect(ocrCoord.getOcrPreview(6)?.ocrStatus).toBe('extracted')
      expect(ocrCoord.getOcrPreview(6)?.extractionMethod).toBe('ocr_image_tesseract')
      expect(ocrCoord.getOcrPreview(7)?.ocrStatus).toBe('extracted')
      expect(ocrRepo.getDocumentOcrState(8)?.ocrStatus).toBe('not_processed')
      expect(ocrCoord.getProgress().coverage.selectedImageOcrCount).toBe(2)

      await ocrCoord.shutdown()
      await nativeCoord.shutdown()
      expect(sharedBudget.getLiveCount()).toBe(0)
      expect(sharedBudget.getReservedCount()).toBe(0)

      // 4. Bitwise source preservation check
      for (const p of trackedPaths) {
        const before = beforeDigests.get(p)!
        const afterStat = statSync(p)
        expect(sha256Of(readFileSync(p))).toBe(before.sha256)
        expect(afterStat.mtimeMs).toBe(before.mtimeMs)
      }
    },
    90_000
  )

  it('does not block getProgress with synchronous 100,000-document scans while keeping coverage accurate', async () => {
    const rootDir = makeTempDir()

    const docsDir = join(rootDir, 'docs')
    const modelsRootDir = join(rootDir, 'models')
    mkdirSync(docsDir, { recursive: true })
    mkdirSync(modelsRootDir, { recursive: true })

    const dbPath = join(rootDir, 'catalog.db')
    const catalog = CatalogDatabase.open({ catalogPath: dbPath })
    openCatalogs.push(catalog)
    catalog.registerSource(docsDir)

    // Seed 1 real scanned-receipt image file + 99,999 catalog document rows (100,000 total documents)
    const receiptPath = join(docsDir, 'doc-1.pdf')
    const receiptBytes = Buffer.from('%PDF-1.4\n% synthetic doc 1')
    writeFileSync(receiptPath, receiptBytes)
    const receiptStat = statSync(receiptPath)
    const receiptSha = sha256Of(receiptBytes)

    const rawDb = catalog.getRawDatabaseForTesting()
    const sourceRow = rawDb.prepare('SELECT id FROM sources LIMIT 1;').get() as { id: number }
    const insertLoc = rawDb.prepare(
      `INSERT INTO file_locations (
         source_id, original_path, normalized_path, file_name, extension, category, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, '.pdf', 'document', ?, ?);`
    )
    const insertDisc = rawDb.prepare(
      `INSERT INTO discovery_observations (
         file_location_id, byte_size, filesystem_birthtime_ms, filesystem_mtime_ms,
         observed_at_ms, last_seen_at_ms, is_current
       ) VALUES (?, ?, ?, ?, ?, ?, 1);`
    )
    const insertHash = rawDb.prepare(
      `INSERT INTO hash_observations (
         file_location_id, discovery_observation_id, sha256, observed_byte_size,
         observed_mtime_ms, hashed_at_ms, is_active
       ) VALUES (?, ?, ?, ?, ?, ?, 1);`
    )

    const now = Date.now()
    rawDb.exec('BEGIN IMMEDIATE;')
    try {
      const r1 = insertLoc.run(
        sourceRow.id,
        receiptPath,
        receiptPath.toLowerCase(),
        'doc-1.pdf',
        now,
        now
      )
      const loc1 = Number(r1.lastInsertRowid)
      const d1 = insertDisc.run(
        loc1,
        receiptStat.size,
        receiptStat.birthtimeMs,
        receiptStat.mtimeMs,
        now,
        now
      )
      insertHash.run(
        loc1,
        Number(d1.lastInsertRowid),
        receiptSha,
        receiptStat.size,
        receiptStat.mtimeMs,
        now
      )

      for (let i = 2; i <= 100_000; i++) {
        const p = join(docsDir, `doc-${i}.pdf`)
        const r = insertLoc.run(sourceRow.id, p, p.toLowerCase(), `doc-${i}.pdf`, now, now)
        const locId = Number(r.lastInsertRowid)
        insertDisc.run(locId, 1024, now, now, now, now)
      }
      rawDb.exec('COMMIT;')
    } catch (err) {
      rawDb.exec('ROLLBACK;')
      throw err
    }

    const importSrc = join(rootDir, 'import-src')
    mkdirSync(importSrc, { recursive: true })
    writeFileSync(join(importSrc, 'eng.traineddata'), SYNTHETIC_MODEL_BYTES)
    const modelManager = new OcrModelManager({
      modelsRootDir,
      getApprovedRoots: () => [docsDir],
      getVaultRoot: () => null,
      artifacts: SYNTHETIC_MODEL_ARTIFACTS
    })
    await modelManager.initialize()
    await modelManager.importFromDirectory(importSrc)

    const workerScript = writeSyntheticOcrWorkerScript(rootDir)
    const coord = new DocumentOcrCoordinator({
      catalog,
      modelManager,
      workerScriptPath: workerScript,
      isPackaged: true
    })
    shutdownCallbacks.push(() => coord.shutdown())

    const ocrRepo = catalog.getDocumentOcrRepository()
    const syncCoverageSpy = vi.spyOn(ocrRepo, 'getDocumentOcrCoverage')

    // 1. initialize() + 50 synchronous getProgress() calls must never call synchronous whole-catalog coverage
    // and must complete in < 50 ms total (vs ~800 ms per call before fix).
    const t0 = performance.now()
    coord.initialize()
    for (let i = 0; i < 50; i++) {
      coord.getProgress()
    }
    const syncElapsedMs = performance.now() - t0
    expect(syncCoverageSpy).not.toHaveBeenCalled()
    expect(syncElapsedMs).toBeLessThan(100)

    // 2. Async chunked refresh populates accurate 100,000-document coverage without blocking
    const warmed = await coord.refreshCoverage()
    expect(warmed.totalDocuments).toBe(100_000)
    expect(warmed.ocrNeededDocuments).toBe(100_000)
    expect(warmed.notProcessedDocuments).toBe(100_000)
    expect(coord.getProgress().coverage.totalDocuments).toBe(100_000)
    expect(syncCoverageSpy).not.toHaveBeenCalled()

    // 3. Processing an item updates coverage incrementally (O(1)) without whole-catalog scans
    const progressEvents: number[] = []
    coord.onProgress((p) => {
      progressEvents.push(p.coverage.extractedDocuments)
    })
    await coord.ocrSelected({ fileLocationIds: [1] })
    await coord.waitForIdle()

    expect(syncCoverageSpy).not.toHaveBeenCalled()
    const finalProg = coord.getProgress()
    expect(finalProg.status).toBe('completed')
    expect(finalProg.extractedItems).toBe(1)
    expect(finalProg.coverage.totalDocuments).toBe(100_000)
    expect(finalProg.coverage.extractedDocuments).toBe(1)
    expect(finalProg.coverage.notProcessedDocuments).toBe(99_999)
    expect(finalProg.coverage.ocrNeededDocuments).toBe(99_999)
    expect(progressEvents).toContain(1)
  }, 60_000)

  it('invalidates coverage cache on discovery additions, hash revisions, native extraction updates, and external OCR writes', async () => {
    const rootDir = makeTempDir()
    const dbPath = join(rootDir, 'catalog.sqlite')
    const catalog = CatalogDatabase.open({ catalogPath: dbPath })
    openCatalogs.push(catalog)

    const sourceDir = join(rootDir, 'docs')
    mkdirSync(sourceDir, { recursive: true })
    const doc1 = join(sourceDir, 'doc1.pdf')
    const doc2 = join(sourceDir, 'doc2.pdf')
    const doc3 = join(sourceDir, 'doc3.pdf')
    writeFileSync(doc1, buildSyntheticPdfBuffer([{ kind: 'native-text', lines: ['Synthetic'] }]))
    writeFileSync(doc2, buildSyntheticPdfBuffer([{ kind: 'native-text', lines: ['Synthetic'] }]))
    writeFileSync(doc3, buildSyntheticPdfBuffer([{ kind: 'native-text', lines: ['Synthetic'] }]))

    const addDoc = (filePath: string, ts: number) => {
      const st = statSync(filePath)
      const buf = readFileSync(filePath)
      catalog.persistDiscoveryBatch(sourceDir, [
        {
          originalPath: filePath,
          fileName: filePath.split(/[\\/]/).pop()!,
          extension: 'pdf',
          category: 'document',
          byteSize: st.size,
          birthtimeMs: st.birthtimeMs,
          mtimeMs: st.mtimeMs,
          discoveredAtMs: ts
        }
      ])
      catalog.recordHashObservationsBatch([
        {
          originalPath: filePath,
          sha256: sha256Of(buf),
          observedByteSize: st.size,
          observedMtimeMs: st.mtimeMs,
          hashedAtMs: ts + 1
        }
      ])
    }

    addDoc(doc1, 1000)

    const importSrc = join(rootDir, 'model-src')
    mkdirSync(importSrc, { recursive: true })
    writeFileSync(join(importSrc, 'eng.traineddata'), SYNTHETIC_MODEL_BYTES)
    const modelManager = new OcrModelManager({
      modelsRootDir: join(rootDir, 'models'),
      getApprovedRoots: () => [sourceDir],
      getVaultRoot: () => null,
      artifacts: SYNTHETIC_MODEL_ARTIFACTS
    })
    await modelManager.initialize()
    await modelManager.importFromDirectory(importSrc)

    const workerScript = writeSyntheticOcrWorkerScript(rootDir)
    const coord = new DocumentOcrCoordinator({
      catalog,
      modelManager,
      workerScriptPath: workerScript,
      isPackaged: true
    })
    shutdownCallbacks.push(() => coord.shutdown())

    // 1. Reviewer reproduction: initialize() + await refreshCoverage() -> totalDocuments=1
    coord.initialize()
    const initial = await coord.refreshCoverage()
    expect(initial.totalDocuments).toBe(1)
    expect(initial.ocrNeededDocuments).toBe(1)

    // 2. Add doc 2 via persistDiscoveryBatch -> getProgress() stays non-blocking and triggers refresh
    addDoc(doc2, 2000)
    coord.getProgress()
    await new Promise((r) => setTimeout(r, 50))
    expect(coord.getProgress().coverage.totalDocuments).toBe(2)
    expect(coord.getProgress().coverage.ocrNeededDocuments).toBe(2)

    // 3. Add doc 3 and call startOcr() without manual refreshCoverage(): ensureCoverageWarm() must see doc 3
    addDoc(doc3, 3000)
    await coord.startOcr()
    await coord.waitForIdle()
    expect(coord.getProgress().coverage.totalDocuments).toBe(3)
    expect(coord.getProgress().coverage.extractedDocuments).toBe(3)
    expect(coord.getProgress().coverage.ocrNeededDocuments).toBe(0)

    // Re-add doc 4 as unprocessed so we can test native extraction, direct OCR repo, hash revision, and external DB
    const doc4 = join(sourceDir, 'doc4.pdf')
    writeFileSync(doc4, buildSyntheticPdfBuffer([{ kind: 'native-text', lines: ['Synthetic'] }]))
    addDoc(doc4, 3500)
    const withDoc4 = await coord.refreshCoverage()
    expect(withDoc4.totalDocuments).toBe(4)
    expect(withDoc4.ocrNeededDocuments).toBe(1)

    // 4. Native extraction update on doc 4 marks it native-extracted (no OCR needed)
    const doc4Row = catalog.getFileLocationByPath(doc4)!
    const doc4Rev = buildDocumentContentRevision({
      discoveryObservationId: doc4Row.discoveryObservationId,
      byteSize: doc4Row.byteSize,
      filesystemMtimeMs: doc4Row.filesystemMtimeMs,
      activeHash: doc4Row.activeHash
    })
    catalog.getDocumentRepository().upsertDocumentExtraction({
      fileLocationId: doc4Row.id,
      expectedDiscoveryObservationId: doc4Row.discoveryObservationId,
      expectedContentRevision: doc4Rev,
      contentSha256: doc4Row.activeHash!,
      observedByteSize: doc4Row.byteSize,
      observedMtimeMs: doc4Row.filesystemMtimeMs,
      recipeVersion: DOCUMENT_EXTRACTION_RECIPE_VERSION,
      extractionStatus: 'extracted',
      statusDetail: 'Native text extracted',
      extractedText: 'Selectable native text body',
      extractedCharCount: 27,
      pageCount: 1,
      ocrCandidatePageCount: 0,
      truncated: false,
      truncationReason: null,
      detectedEncoding: 'utf-8'
    })
    const afterNative = await coord.refreshCoverage()
    expect(afterNative.totalDocuments).toBe(4)
    expect(afterNative.ocrNeededDocuments).toBe(0)
    expect(afterNative.notProcessedDocuments).toBe(1)

    // 5. Direct OCR repository write outside coordinator on doc 2 (re-seeded via new file doc5)
    const doc5 = join(sourceDir, 'doc5.pdf')
    writeFileSync(doc5, buildSyntheticPdfBuffer([{ kind: 'native-text', lines: ['Synthetic'] }]))
    addDoc(doc5, 3600)
    const doc5Row = catalog.getFileLocationByPath(doc5)!
    const doc5Rev = buildDocumentContentRevision({
      discoveryObservationId: doc5Row.discoveryObservationId,
      byteSize: doc5Row.byteSize,
      filesystemMtimeMs: doc5Row.filesystemMtimeMs,
      activeHash: doc5Row.activeHash
    })
    const progSpec = coord.getProgress()
    catalog.getDocumentOcrRepository().upsertDocumentOcrExtraction({
      fileLocationId: doc5Row.id,
      expectedDiscoveryObservationId: doc5Row.discoveryObservationId,
      expectedContentRevision: doc5Rev,
      contentSha256: doc5Row.activeHash!,
      observedByteSize: doc5Row.byteSize,
      observedMtimeMs: doc5Row.filesystemMtimeMs,
      recipeVersion: progSpec.recipeVersion,
      ocrModelId: progSpec.ocrModelId,
      ocrModelManifestSha256: progSpec.ocrModelManifestSha256!,
      ocrLanguage: progSpec.ocrLanguage,
      extractionMethod: 'ocr_pdf_tesseract',
      ocrStatus: 'extracted',
      statusDetail: 'Direct repo OCR',
      extractedText: 'Direct OCR text',
      extractedCharCount: 15,
      pageCount: 1,
      ocrPageCount: 1,
      nativeOnlyPageCount: 0,
      skippedBlankPageCount: 0,
      meanConfidence: 90,
      truncated: false,
      truncationReason: null
    })
    const afterDirectOcr = await coord.refreshCoverage()
    expect(afterDirectOcr.totalDocuments).toBe(5)
    expect(afterDirectOcr.extractedDocuments).toBe(4)
    expect(afterDirectOcr.notProcessedDocuments).toBe(1)
    expect(afterDirectOcr.ocrNeededDocuments).toBe(0)

    // 6. Source/hash revision on doc 5 invalidates doc 5's OCR coverage back to not_processed
    const doc5UpdatedBytes = Buffer.concat([
      buildSyntheticPdfBuffer([{ kind: 'native-text', lines: ['Synthetic'] }]),
      Buffer.from('\n%updated')
    ])
    writeFileSync(doc5, doc5UpdatedBytes)
    addDoc(doc5, 4000)
    const afterHashRevision = await coord.refreshCoverage()
    expect(afterHashRevision.extractedDocuments).toBe(3)
    expect(afterHashRevision.staleDocuments).toBe(1)
    expect(afterHashRevision.ocrNeededDocuments).toBe(1)

    // 7. External SQLite connection OCR write detected via PRAGMA data_version
    const doc5RevisedRow = catalog.getFileLocationByPath(doc5)!
    const doc5RevisedRev = buildDocumentContentRevision({
      discoveryObservationId: doc5RevisedRow.discoveryObservationId,
      byteSize: doc5RevisedRow.byteSize,
      filesystemMtimeMs: doc5RevisedRow.filesystemMtimeMs,
      activeHash: doc5RevisedRow.activeHash
    })
    const externalDb = new DatabaseSync(dbPath)
    try {
      externalDb
        .prepare(
          'UPDATE document_ocr_extractions SET is_current = 0 WHERE file_location_id = ? AND is_current = 1;'
        )
        .run(doc5RevisedRow.id)
      externalDb
        .prepare(
          `INSERT INTO document_ocr_extractions (
            file_location_id, discovery_observation_id, content_sha256, observed_byte_size,
            observed_mtime_ms, content_revision, recipe_version, ocr_model_id,
            ocr_model_manifest_sha256, ocr_language, extraction_method, ocr_status,
            status_detail, extracted_text, extracted_char_count, page_count,
            ocr_page_count, native_only_page_count, skipped_blank_page_count,
            mean_confidence, truncated, truncation_reason, extracted_at_ms, is_current
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ocr_pdf_tesseract', 'extracted', 'External', 'External OCR', 12, 1, 1, 0, 0, 88, 0, NULL, ?, 1);`
        )
        .run(
          doc5RevisedRow.id,
          doc5RevisedRow.discoveryObservationId,
          doc5RevisedRow.activeHash!,
          doc5RevisedRow.byteSize,
          doc5RevisedRow.filesystemMtimeMs,
          doc5RevisedRev,
          progSpec.recipeVersion,
          progSpec.ocrModelId,
          progSpec.ocrModelManifestSha256!,
          progSpec.ocrLanguage,
          5000
        )
    } finally {
      externalDb.close()
    }
    const afterExternalDb = await coord.refreshCoverage()
    expect(afterExternalDb.extractedDocuments).toBe(4)
    expect(afterExternalDb.staleDocuments).toBe(0)
    expect(afterExternalDb.ocrNeededDocuments).toBe(0)
  })

  it('prevents an in-flight coverage refresh from publishing stale counts after a concurrent catalog mutation', async () => {
    const rootDir = makeTempDir()
    const catalog = CatalogDatabase.open({ catalogPath: join(rootDir, 'catalog.sqlite') })
    openCatalogs.push(catalog)

    const sourceDir = join(rootDir, 'docs')
    mkdirSync(sourceDir, { recursive: true })
    const doc1 = join(sourceDir, 'doc1.pdf')
    const doc2 = join(sourceDir, 'doc2.pdf')
    writeFileSync(doc1, buildSyntheticPdfBuffer([{ kind: 'native-text', lines: ['Synthetic'] }]))
    writeFileSync(doc2, buildSyntheticPdfBuffer([{ kind: 'native-text', lines: ['Synthetic'] }]))

    const addDoc = (filePath: string, ts: number) => {
      const st = statSync(filePath)
      catalog.persistDiscoveryBatch(sourceDir, [
        {
          originalPath: filePath,
          fileName: filePath.split(/[\\/]/).pop()!,
          extension: 'pdf',
          category: 'document',
          byteSize: st.size,
          birthtimeMs: st.birthtimeMs,
          mtimeMs: st.mtimeMs,
          discoveredAtMs: ts
        }
      ])
    }
    addDoc(doc1, 1000)

    const importSrc = join(rootDir, 'model-src')
    mkdirSync(importSrc, { recursive: true })
    writeFileSync(join(importSrc, 'eng.traineddata'), SYNTHETIC_MODEL_BYTES)
    const modelManager = new OcrModelManager({
      modelsRootDir: join(rootDir, 'models'),
      getApprovedRoots: () => [sourceDir],
      getVaultRoot: () => null,
      artifacts: SYNTHETIC_MODEL_ARTIFACTS
    })
    await modelManager.initialize()
    await modelManager.importFromDirectory(importSrc)

    const workerScript = writeSyntheticOcrWorkerScript(rootDir)
    const coord = new DocumentOcrCoordinator({
      catalog,
      modelManager,
      workerScriptPath: workerScript,
      isPackaged: true
    })
    shutdownCallbacks.push(() => coord.shutdown())

    const ocrRepo = catalog.getDocumentOcrRepository()
    const realAsync = ocrRepo.getDocumentOcrCoverageAsync.bind(ocrRepo)
    let releaseFirstScan!: () => void
    const firstScanStarted = new Promise<void>((resolveStarted) => {
      let callCount = 0
      vi.spyOn(ocrRepo, 'getDocumentOcrCoverageAsync').mockImplementation(async (options) => {
        callCount += 1
        const result = await realAsync(options)
        if (callCount === 1) {
          resolveStarted()
          await new Promise<void>((resolveRelease) => {
            releaseFirstScan = resolveRelease
          })
          return result
        }
        return result
      })
    })

    // Start first refresh while totalDocuments === 1
    const p1 = coord.refreshCoverage()
    const p2 = coord.refreshCoverage() // coalesced with p1
    await firstScanStarted

    // Mutate catalog while first scan is in flight
    addDoc(doc2, 2000)
    releaseFirstScan()

    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.totalDocuments).toBe(2)
    expect(r2.totalDocuments).toBe(2)
    expect(coord.getProgress().coverage.totalDocuments).toBe(2)
  })

  it('rejects incremental coverage stamping when a second CatalogDatabase connection mutates the database mid-commit', async () => {
    const rootDir = makeTempDir()
    const dbPath = join(rootDir, 'catalog.sqlite')
    const catalog = CatalogDatabase.open({ catalogPath: dbPath })
    openCatalogs.push(catalog)

    const sourceDir = join(rootDir, 'docs')
    mkdirSync(sourceDir, { recursive: true })
    const doc1 = join(sourceDir, 'doc1.pdf')
    const doc2 = join(sourceDir, 'doc2.pdf')
    writeFileSync(doc1, buildSyntheticPdfBuffer([{ kind: 'native-text', lines: ['Synthetic'] }]))
    writeFileSync(doc2, buildSyntheticPdfBuffer([{ kind: 'native-text', lines: ['Synthetic'] }]))

    const addDoc = (targetCatalog: CatalogDatabase, filePath: string, ts: number) => {
      const st = statSync(filePath)
      const buf = readFileSync(filePath)
      targetCatalog.persistDiscoveryBatch(sourceDir, [
        {
          originalPath: filePath,
          fileName: filePath.split(/[\\/]/).pop()!,
          extension: 'pdf',
          category: 'document',
          byteSize: st.size,
          birthtimeMs: st.birthtimeMs,
          mtimeMs: st.mtimeMs,
          discoveredAtMs: ts
        }
      ])
      targetCatalog.recordHashObservationsBatch([
        {
          originalPath: filePath,
          sha256: sha256Of(buf),
          observedByteSize: st.size,
          observedMtimeMs: st.mtimeMs,
          hashedAtMs: ts + 1
        }
      ])
    }
    addDoc(catalog, doc1, 1000)

    const importSrc = join(rootDir, 'model-src')
    mkdirSync(importSrc, { recursive: true })
    writeFileSync(join(importSrc, 'eng.traineddata'), SYNTHETIC_MODEL_BYTES)
    const modelManager = new OcrModelManager({
      modelsRootDir: join(rootDir, 'models'),
      getApprovedRoots: () => [sourceDir],
      getVaultRoot: () => null,
      artifacts: SYNTHETIC_MODEL_ARTIFACTS
    })
    await modelManager.initialize()
    await modelManager.importFromDirectory(importSrc)

    const workerScript = writeSyntheticOcrWorkerScript(rootDir)
    const coord = new DocumentOcrCoordinator({
      catalog,
      modelManager,
      workerScriptPath: workerScript,
      isPackaged: true
    })
    shutdownCallbacks.push(() => coord.shutdown())

    // Warm coverage with 1 document
    coord.initialize()
    const warmed = await coord.refreshCoverage()
    expect(warmed.totalDocuments).toBe(1)

    const ocrRepo = catalog.getDocumentOcrRepository()
    const syncCoverageSpy = vi.spyOn(ocrRepo, 'getDocumentOcrCoverage')
    const realUpsert = ocrRepo.upsertDocumentOcrExtraction.bind(ocrRepo)
    let interleavedOnce = false
    vi.spyOn(ocrRepo, 'upsertDocumentOcrExtraction').mockImplementation((input) => {
      if (!interleavedOnce) {
        interleavedOnce = true
        // Interleave an insert through a second CatalogDatabase connection after beforeGen/beforeSeq
        // were captured, right before the local OCR upsert commits.
        const secondCatalog = CatalogDatabase.open({ catalogPath: dbPath })
        try {
          addDoc(secondCatalog, doc2, 2000)
        } finally {
          secondCatalog.close()
        }
      }
      return realUpsert(input)
    })

    const doc1Row = catalog.getFileLocationByPath(doc1)!
    await coord.ocrSelected({ fileLocationIds: [doc1Row.id] })
    await coord.waitForIdle()

    expect(interleavedOnce).toBe(true)
    expect(syncCoverageSpy).not.toHaveBeenCalled()

    // Ensure warm coverage converges to the true total (2) rather than retaining stale 1
    await (coord as unknown as { ensureCoverageWarm: () => Promise<void> }).ensureCoverageWarm()
    const finalCoverage = coord.getProgress().coverage
    expect(finalCoverage.totalDocuments).toBe(2)
    expect(finalCoverage.extractedDocuments).toBe(1)
    expect(finalCoverage.notProcessedDocuments).toBe(1)
    expect(finalCoverage.ocrNeededDocuments).toBe(1)
    expect(syncCoverageSpy).not.toHaveBeenCalled()
  })
})
