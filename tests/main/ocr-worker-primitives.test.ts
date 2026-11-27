// @vitest-environment node
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DOCUMENT_EXTRACTION_LIMITS } from '../../src/main/services/documents/types'
import { readAndVerifySourceWithExplicitLimit } from '../../src/main/services/documents/source-reader'
import { resolveOcrRuntimeAssets } from '../../src/main/services/documents/ocr/assets'
import { DOCUMENT_OCR_LIMITS } from '../../src/main/services/documents/ocr/types'
import { DocumentOcrWorkerRunner } from '../../src/main/services/documents/ocr/worker-runner'
import { AppWorkerBudget } from '../../src/main/services/worker-budget'
import { createOcrFoundationTestFixtures } from '../helpers/ocr-synthetic-fixtures'

const CACHED_SPIKE_MODEL_DIR = resolve(
  process.cwd(),
  'spikes',
  'ocr-eval',
  '.model-cache',
  'tessdata_fast_eng@65727574'
)
const CACHED_TRAINED_DATA_FILE = join(CACHED_SPIKE_MODEL_DIR, 'eng.traineddata')

describe('Production OCR Worker Primitives, Explicit Limits, and Shared AppWorkerBudget', () => {
  let tempRoot = ''

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'pv-ocr-primitives-'))
  })

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('enforces mandatory explicit maxInputBytes (32 MiB Stage 7B vs 64 MiB Stage 7C) and verifies source identity', async () => {
    const docsDir = join(tempRoot, 'docs')
    await mkdir(docsDir, { recursive: true })

    const file34MiB = join(docsDir, 'scan_34mib.pdf')
    const buf34 = Buffer.alloc(34 * 1024 * 1024, 0x41)
    await writeFile(file34MiB, buf34)
    const st34 = await stat(file34MiB)
    const sha34 = createHash('sha256').update(buf34).digest('hex')

    // Under Stage 7B 32 MiB limit -> oversizedBytes returned, buffer null, SHA-256 still verified
    const under32 = await readAndVerifySourceWithExplicitLimit({
      sourcePath: file34MiB,
      approvedRoots: [docsDir],
      expectedByteSize: st34.size,
      expectedMtimeMs: st34.mtimeMs,
      expectedSha256: sha34,
      maxInputBytes: DOCUMENT_EXTRACTION_LIMITS.MAX_INPUT_BYTES
    })
    expect(under32.ok).toBe(true)
    if (under32.ok) {
      expect(under32.buffer).toBeNull()
      expect(under32.oversizedBytes).toBe(34 * 1024 * 1024)
      expect(under32.observedSha256).toBe(sha34)
    }

    // Under Stage 7C 64 MiB explicit limit -> buffer returned intact
    const under64 = await readAndVerifySourceWithExplicitLimit({
      sourcePath: file34MiB,
      approvedRoots: [docsDir],
      expectedByteSize: st34.size,
      expectedMtimeMs: st34.mtimeMs,
      expectedSha256: sha34,
      maxInputBytes: DOCUMENT_OCR_LIMITS.MAX_INPUT_BYTES
    })
    expect(under64.ok).toBe(true)
    if (under64.ok) {
      expect(under64.buffer?.byteLength).toBe(34 * 1024 * 1024)
      expect(under64.oversizedBytes).toBeNull()
      expect(under64.observedSha256).toBe(sha34)
    }

    // Rejects SHA-256 mismatch
    const wrongSha = await readAndVerifySourceWithExplicitLimit({
      sourcePath: file34MiB,
      approvedRoots: [docsDir],
      expectedByteSize: st34.size,
      expectedMtimeMs: st34.mtimeMs,
      expectedSha256: '0'.repeat(64),
      maxInputBytes: DOCUMENT_OCR_LIMITS.MAX_INPUT_BYTES
    })
    expect(wrongSha.ok).toBe(false)
    if (!wrongSha.ok) {
      expect(wrongSha.errorCode).toBe('FILE_CHANGED')
    }
  })

  it('maps packaged app.asar paths to app.asar.unpacked for WASM and native OCR assets', () => {
    const resolved = resolveOcrRuntimeAssets({
      resolvePath: (specifier: string) =>
        join('C:\\Program Files\\Personal Vault\\resources\\app.asar\\node_modules', specifier)
    })
    expect(resolved.simdWasmPath).toContain('app.asar.unpacked')
    expect(resolved.scalarWasmPath).toContain('app.asar.unpacked')
    expect(resolved.simdJsPath).toContain('app.asar')
  })

  it('releases AppWorkerBudget reservations on spawn failure and rejects missing/tampered models or unsupported extensions offline without cached model weights', async () => {
    const tamperedModelDir = join(tempRoot, 'tampered-synthetic-model')
    const fixturesDir = join(tempRoot, 'unconditional-fixtures')
    await mkdir(tamperedModelDir, { recursive: true })
    await writeFile(join(tamperedModelDir, 'eng.traineddata'), Buffer.from('NOT_VALID_TESSDATA'))

    const fixtures = await createOcrFoundationTestFixtures(fixturesDir)
    const bmpPath = join(fixturesDir, 'legacy_scan.bmp')
    const bmpBytes = Buffer.from('BM_SYNTHETIC_UNSUPPORTED_HEADER')
    await writeFile(bmpPath, bmpBytes)
    const bmpStat = await stat(bmpPath)
    const bmpSha = createHash('sha256').update(bmpBytes).digest('hex')

    const workerBudget = new AppWorkerBudget(3)

    // 1. Spawn failure releases AppWorkerBudget reservation (0 leaked)
    const badRunner = new DocumentOcrWorkerRunner({
      workerBudget,
      workerScriptPath: join(tempRoot, 'missing-worker-script.js'),
      isPackaged: true
    })
    const failSpawnRes = await badRunner.runOcr({
      sourcePath: fixtures.receiptPng.filePath,
      extension: '.png',
      approvedRoots: [fixturesDir],
      expectedByteSize: fixtures.receiptPng.byteSize,
      expectedMtimeMs: fixtures.receiptPng.mtimeMs,
      expectedSha256: fixtures.receiptPng.sha256,
      modelDir: tamperedModelDir
    })
    expect(failSpawnRes.ok).toBe(false)
    expect(workerBudget.getReservedCount()).toBe(0)
    expect(workerBudget.getWorkerCount()).toBe(0)

    // 2. Real worker rejects missing & tampered models offline with 0 network attempts, and handles unsupported .bmp
    const runner = new DocumentOcrWorkerRunner({ workerBudget })
    try {
      const missingRes = await runner.runOcr({
        sourcePath: fixtures.receiptPng.filePath,
        extension: '.png',
        approvedRoots: [fixturesDir],
        expectedByteSize: fixtures.receiptPng.byteSize,
        expectedMtimeMs: fixtures.receiptPng.mtimeMs,
        expectedSha256: fixtures.receiptPng.sha256,
        modelDir: join(tempRoot, 'does-not-exist')
      })
      expect(missingRes.ok).toBe(false)
      if (!missingRes.ok) {
        expect(missingRes.errorCode).toBe('OCR_MODEL_MISSING')
        expect(missingRes.outboundNetworkAttempts).toBe(0)
        expect(missingRes.nestedWorkerAttempts).toBe(0)
      }

      const tamperedRes = await runner.runOcr({
        sourcePath: fixtures.receiptPng.filePath,
        extension: '.png',
        approvedRoots: [fixturesDir],
        expectedByteSize: fixtures.receiptPng.byteSize,
        expectedMtimeMs: fixtures.receiptPng.mtimeMs,
        expectedSha256: fixtures.receiptPng.sha256,
        modelDir: tamperedModelDir
      })
      expect(tamperedRes.ok).toBe(false)
      if (!tamperedRes.ok) {
        expect(tamperedRes.errorCode).toBe('OCR_MODEL_INVALID')
        expect(tamperedRes.outboundNetworkAttempts).toBe(0)
        expect(tamperedRes.nestedWorkerAttempts).toBe(0)
      }

      const bmpRes = await runner.runOcr({
        sourcePath: bmpPath,
        extension: '.bmp',
        approvedRoots: [fixturesDir],
        expectedByteSize: bmpStat.size,
        expectedMtimeMs: bmpStat.mtimeMs,
        expectedSha256: bmpSha,
        modelDir: tamperedModelDir
      })
      expect(bmpRes.ok).toBe(true)
      if (bmpRes.ok) {
        expect(bmpRes.outcome.status).toBe('unsupported')
        expect(bmpRes.outcome.extractionMethod).toBe('none')
        expect(bmpRes.outcome.text).toBeNull()
      }
    } finally {
      await runner.shutdown()
    }

    expect(workerBudget.getLiveCount()).toBe(0)
    expect(workerBudget.getWorkerCount()).toBe(0)
    expect(workerBudget.getReservedCount()).toBe(0)
  }, 30_000)

  it.skipIf(!existsSync(CACHED_TRAINED_DATA_FILE))(
    'performs offline OCR, handles blank/mixed/corrupt cases, respects AppWorkerBudget(3), cancels cleanly, and preserves sources',
    async () => {
      const trainedDataFile = CACHED_TRAINED_DATA_FILE
      expect(existsSync(trainedDataFile)).toBe(true)

      const modelDir = join(tempRoot, 'provisioned-model')
      const tamperedModelDir = join(tempRoot, 'tampered-model')
      const fixturesDir = join(tempRoot, 'approved-fixtures')
      await mkdir(modelDir, { recursive: true })
      await mkdir(tamperedModelDir, { recursive: true })
      await copyFile(trainedDataFile, join(modelDir, 'eng.traineddata'))

      const tamperedBytes = await readFile(trainedDataFile)
      tamperedBytes[64]! ^= 0xff
      await writeFile(join(tamperedModelDir, 'eng.traineddata'), tamperedBytes)

      const fixtures = await createOcrFoundationTestFixtures(fixturesDir)

      const workerBudget = new AppWorkerBudget(3)

      // Contention under AppWorkerBudget(3): 2 busy workers + 1 reclaimable idle worker
      const spawnDummy = (): Worker =>
        new Worker(
          'const { parentPort } = require("node:worker_threads"); parentPort.on("message", () => {});',
          { eval: true }
        )
      const r1 = workerBudget.tryReserve()!
      const busy1 = spawnDummy()
      workerBudget.promote(r1, busy1)
      const r2 = workerBudget.tryReserve()!
      const busy2 = spawnDummy()
      workerBudget.promote(r2, busy2)
      const r3 = workerBudget.tryReserve()!
      let idle3: Worker | null = spawnDummy()
      workerBudget.promote(r3, idle3)
      expect(workerBudget.getLiveCount()).toBe(3)

      const runner = new DocumentOcrWorkerRunner({
        workerBudget,
        tryReleaseExternalIdleWorker: async () => {
          if (idle3) {
            await idle3.terminate()
            idle3 = null
            return true
          }
          return false
        }
      })

      try {
        // Receipt PNG & TIFF
        const pngRes = await runner.runOcr({
          sourcePath: fixtures.receiptPng.filePath,
          extension: '.png',
          approvedRoots: [fixturesDir],
          expectedByteSize: fixtures.receiptPng.byteSize,
          expectedMtimeMs: fixtures.receiptPng.mtimeMs,
          expectedSha256: fixtures.receiptPng.sha256,
          modelDir
        })
        expect(workerBudget.getLiveCount()).toBeLessThanOrEqual(3)
        expect(pngRes.ok).toBe(true)
        if (pngRes.ok) {
          expect(pngRes.outcome.status).toBe('extracted')
          expect(pngRes.outcome.text).toContain('PERSONAL VAULT MARKET')
          expect(pngRes.outcome.text).toContain('48291')
          expect(pngRes.outcome.text).toContain('24.50')
          expect(pngRes.nestedWorkerAttempts).toBe(0)
          expect(pngRes.outboundNetworkAttempts).toBe(0)
        }

        const tiffRes = await runner.runOcr({
          sourcePath: fixtures.receiptTiff.filePath,
          extension: '.tiff',
          approvedRoots: [fixturesDir],
          expectedByteSize: fixtures.receiptTiff.byteSize,
          expectedMtimeMs: fixtures.receiptTiff.mtimeMs,
          expectedSha256: fixtures.receiptTiff.sha256,
          modelDir
        })
        expect(tiffRes.ok && tiffRes.outcome.status).toBe('extracted')

        // Scanned 2-page PDF
        const pdfRes = await runner.runOcr({
          sourcePath: fixtures.scannedPdf.filePath,
          extension: '.pdf',
          approvedRoots: [fixturesDir],
          expectedByteSize: fixtures.scannedPdf.byteSize,
          expectedMtimeMs: fixtures.scannedPdf.mtimeMs,
          expectedSha256: fixtures.scannedPdf.sha256,
          modelDir
        })
        expect(pdfRes.ok).toBe(true)
        if (pdfRes.ok) {
          expect(pdfRes.outcome.status).toBe('extracted')
          expect(pdfRes.outcome.ocrPageCount).toBe(2)
          expect(pdfRes.outcome.text).toContain('77410')
          expect(pdfRes.outcome.text).toContain('ALPHA99')
        }

        // Mixed policy PDF:
        // Page 1 = native body + small corner logo -> native_only (0 OCR)
        // Page 2 = native selectable header + scanned body -> OCR'd + native merged!
        // Page 3 = blank vector spacer -> skipped
        const mixedRes = await runner.runOcr({
          sourcePath: fixtures.mixedPolicyPdf.filePath,
          extension: '.pdf',
          approvedRoots: [fixturesDir],
          expectedByteSize: fixtures.mixedPolicyPdf.byteSize,
          expectedMtimeMs: fixtures.mixedPolicyPdf.mtimeMs,
          expectedSha256: fixtures.mixedPolicyPdf.sha256,
          modelDir
        })
        expect(mixedRes.ok).toBe(true)
        if (mixedRes.ok) {
          expect(mixedRes.outcome.status).toBe('extracted')
          expect(mixedRes.outcome.extractionMethod).toBe('ocr_hybrid_pdf')
          expect(mixedRes.outcome.nativeOnlyPageCount).toBe(1)
          expect(mixedRes.outcome.ocrPageCount).toBe(1)
          expect(mixedRes.outcome.skippedBlankPageCount).toBe(1)
          expect(mixedRes.outcome.text).toContain('DIGITAL COVER PAGE 1001')
          expect(mixedRes.outcome.text).toContain('SELECTABLE RUNNING HEADER')
          expect(mixedRes.outcome.text).toContain('SCANNED BODY CLAUSE 4410')
          expect(mixedRes.outcome.text).toContain('ZETA88')
        }

        // Blank image & blank PDF -> honest ocr_no_text
        const blankPngRes = await runner.runOcr({
          sourcePath: fixtures.blankPng.filePath,
          extension: '.png',
          approvedRoots: [fixturesDir],
          expectedByteSize: fixtures.blankPng.byteSize,
          expectedMtimeMs: fixtures.blankPng.mtimeMs,
          expectedSha256: fixtures.blankPng.sha256,
          modelDir
        })
        expect(blankPngRes.ok).toBe(true)
        if (blankPngRes.ok) {
          expect(blankPngRes.outcome.status).toBe('ocr_no_text')
          expect(blankPngRes.outcome.text).toBeNull()
          expect(blankPngRes.outcome.extractedCharCount).toBe(0)
        }

        const blankPdfRes = await runner.runOcr({
          sourcePath: fixtures.blankScanPdf.filePath,
          extension: '.pdf',
          approvedRoots: [fixturesDir],
          expectedByteSize: fixtures.blankScanPdf.byteSize,
          expectedMtimeMs: fixtures.blankScanPdf.mtimeMs,
          expectedSha256: fixtures.blankScanPdf.sha256,
          modelDir
        })
        expect(blankPdfRes.ok).toBe(true)
        if (blankPdfRes.ok) {
          expect(blankPdfRes.outcome.status).toBe('ocr_no_text')
          expect(blankPdfRes.outcome.text).toBeNull()
        }

        // Missing & tampered model -> rejected offline with 0 network attempts
        const missingModelRes = await runner.runOcr({
          sourcePath: fixtures.receiptPng.filePath,
          extension: '.png',
          approvedRoots: [fixturesDir],
          expectedByteSize: fixtures.receiptPng.byteSize,
          expectedMtimeMs: fixtures.receiptPng.mtimeMs,
          expectedSha256: fixtures.receiptPng.sha256,
          modelDir: join(tempRoot, 'missing-model-dir')
        })
        expect(missingModelRes.ok).toBe(false)
        if (!missingModelRes.ok) {
          expect(missingModelRes.errorCode).toBe('OCR_MODEL_MISSING')
          expect(missingModelRes.outboundNetworkAttempts).toBe(0)
        }

        const tamperedModelRes = await runner.runOcr({
          sourcePath: fixtures.receiptPng.filePath,
          extension: '.png',
          approvedRoots: [fixturesDir],
          expectedByteSize: fixtures.receiptPng.byteSize,
          expectedMtimeMs: fixtures.receiptPng.mtimeMs,
          expectedSha256: fixtures.receiptPng.sha256,
          modelDir: tamperedModelDir
        })
        expect(tamperedModelRes.ok).toBe(false)
        if (!tamperedModelRes.ok) {
          expect(tamperedModelRes.errorCode).toBe('OCR_MODEL_INVALID')
          expect(tamperedModelRes.outboundNetworkAttempts).toBe(0)
        }

        // Active cancellation mid-OCR + post-cancel recovery
        const slowPromise = runner.runOcr({
          sourcePath: fixtures.scannedPdf.filePath,
          extension: '.pdf',
          approvedRoots: [fixturesDir],
          expectedByteSize: fixtures.scannedPdf.byteSize,
          expectedMtimeMs: fixtures.scannedPdf.mtimeMs,
          expectedSha256: fixtures.scannedPdf.sha256,
          modelDir,
          pageDelayMs: 350
        })
        await new Promise((r) => setTimeout(r, 120))
        await runner.cancelActiveRequests()
        const cancelledRes = await slowPromise
        expect(cancelledRes.ok).toBe(false)
        if (!cancelledRes.ok) {
          expect(cancelledRes.errorCode).toBe('CANCELLED')
        }

        // Recovery run succeeds on fresh worker
        const recoveryRes = await runner.runOcr({
          sourcePath: fixtures.receiptPng.filePath,
          extension: '.png',
          approvedRoots: [fixturesDir],
          expectedByteSize: fixtures.receiptPng.byteSize,
          expectedMtimeMs: fixtures.receiptPng.mtimeMs,
          expectedSha256: fixtures.receiptPng.sha256,
          modelDir
        })
        expect(recoveryRes.ok && recoveryRes.outcome.status).toBe('extracted')
      } finally {
        await runner.shutdown()
        await busy1.terminate()
        await busy2.terminate()
        if (idle3) {
          await idle3.terminate()
        }
      }

      expect(workerBudget.getLiveCount()).toBe(0)
      expect(workerBudget.getWorkerCount()).toBe(0)
      expect(workerBudget.getReservedCount()).toBe(0)

      // Bitwise source preservation check across all synthetic fixtures
      for (const fx of Object.values(fixtures)) {
        const afterSt = await stat(fx.filePath)
        const afterSha = createHash('sha256')
          .update(await readFile(fx.filePath))
          .digest('hex')
        expect(afterSt.size).toBe(fx.byteSize)
        expect(afterSt.mtimeMs).toBe(fx.mtimeMs)
        expect(afterSha).toBe(fx.sha256)
      }
    },
    60_000
  )

  it('retains terminatingWorkers until confirmed exit even when terminate() rejects and blocks replacement spawn', async () => {
    const testRoot = tempRoot

    const docsDir = join(testRoot, 'docs')
    await mkdir(docsDir, { recursive: true })
    const docPath = join(docsDir, 'sample.txt')
    const docBytes = Buffer.from('OCR_RETIRE_TEST_DATA')
    await writeFile(docPath, docBytes)
    const docSt = await stat(docPath)
    const docSha = createHash('sha256').update(docBytes).digest('hex')

    const stubWorkerPath = join(testRoot, 'stub-ocr-worker.cjs')
    await writeFile(
      stubWorkerPath,
      `const { parentPort } = require('node:worker_threads');
const crypto = require('node:crypto');
parentPort.on('message', (msg) => {
  if (msg.type === 'verify_source') {
    parentPort.postMessage({
      id: msg.id,
      type: 'verify_result',
      ok: true,
      observedSha256: crypto.createHash('sha256').update(Buffer.from('OCR_RETIRE_TEST_DATA')).digest('hex'),
      observedByteSize: ${docBytes.length},
      observedMtimeMs: ${docSt.mtimeMs},
      nestedWorkerAttempts: 0,
      outboundNetworkAttempts: 0,
      durationMs: 1
    });
  }
});
`,
      'utf8'
    )

    const budget = new AppWorkerBudget(1)
    const runner = new DocumentOcrWorkerRunner({
      workerBudget: budget,
      workerScriptPath: stubWorkerPath,
      workerTimeoutMs: 5000
    })

    try {
      const initialVerify = await runner.verifySource({
        sourcePath: docPath,
        approvedRoots: [docsDir],
        expectedByteSize: docSt.size,
        expectedMtimeMs: docSt.mtimeMs,
        expectedSha256: docSha
      })
      expect(initialVerify.ok).toBe(true)
      expect(runner.getDiagnostics().ocrActiveWorkers).toBe(1)

      // Grab the active worker and stub terminate() to reject without exiting yet
      const liveWorker = (runner as unknown as { worker: Worker }).worker
      const originalTerminate = liveWorker.terminate.bind(liveWorker)
      liveWorker.terminate = () => Promise.reject(new Error('synthetic terminate failure'))

      // Cancel / retire while terminate() rejects: worker must remain tracked in terminatingWorkers
      await runner.cancelActiveRequests()
      expect(runner.getDiagnostics().ocrActiveWorkers).toBe(0)
      expect(runner.getDiagnostics().ocrTerminatingWorkers).toBe(1)
      expect(runner.getDiagnostics().ocrLiveWorkers).toBe(1)
      expect(budget.getLiveCount()).toBe(1)

      // Attempting to run a replacement request must NOT spawn a replacement while old worker is alive
      let replacementSettled = false
      const replacementPromise = runner
        .verifySource({
          sourcePath: docPath,
          approvedRoots: [docsDir],
          expectedByteSize: docSt.size,
          expectedMtimeMs: docSt.mtimeMs,
          expectedSha256: docSha
        })
        .then((res) => {
          replacementSettled = true
          return res
        })

      await new Promise((r) => setTimeout(r, 150))
      expect(replacementSettled).toBe(false)
      expect(runner.getDiagnostics().ocrActiveWorkers).toBe(0)
      expect(runner.getDiagnostics().ocrTerminatingWorkers).toBe(1)
      expect(budget.getLiveCount()).toBe(1)

      // Now allow the old worker to actually terminate and emit 'exit'
      await originalTerminate()
      const replacementRes = await replacementPromise
      expect(replacementSettled).toBe(true)
      expect(replacementRes.ok).toBe(true)
      expect(runner.getDiagnostics().ocrTerminatingWorkers).toBe(0)
      expect(runner.getDiagnostics().ocrLiveWorkers).toBe(1)
    } finally {
      await runner.shutdown()
    }

    expect(runner.getDiagnostics().ocrLiveWorkers).toBe(0)
    expect(budget.getLiveCount()).toBe(0)
    expect(budget.getReservedCount()).toBe(0)
  }, 15_000)
})
