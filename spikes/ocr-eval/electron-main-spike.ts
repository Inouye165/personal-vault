import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { Worker } from 'node:worker_threads'
import { app } from 'electron'
import { AppWorkerBudget } from '../../src/main/services/worker-budget'
import { resolveMainWorkerScriptPath } from '../../src/main/services/worker-path'
import { createSyntheticOcrFixtures } from './generate-ocr-fixtures.mjs'
import {
  NATIVE_EXTRACT_MAX_INPUT_BYTES,
  NATIVE_EXTRACT_RECIPE_VERSION,
  OCR_MAX_INPUT_BYTES,
  OCR_RECIPE_VERSION,
  PINNED_OCR_MANIFEST_SHA256,
  PINNED_OCR_MODEL_MANIFEST,
  composeDocumentExtractionTracks,
  readAndVerifySourceWithLimit
} from './ocr-core.mjs'

function parseArg(prefix: string): string | null {
  for (const arg of process.argv) {
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length)
    }
  }
  return null
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Spike assertion failed: ${message}`)
  }
}

class OcrWorkerClient {
  public readonly worker: Worker
  private nextId = 1
  private readonly pending = new Map<
    number,
    {
      resolve: (val: Record<string, unknown>) => void
      reject: (err: Error) => void
      onStarted?: () => void
    }
  >()

  public constructor(workerScriptPath: string) {
    this.worker = new Worker(workerScriptPath)
    this.worker.on('message', (msg: Record<string, unknown>) => {
      const id = typeof msg?.id === 'number' ? msg.id : -1
      const entry = this.pending.get(id)
      if (!entry) return
      if (msg.type === 'ocr-started') {
        entry.onStarted?.()
        return
      }
      this.pending.delete(id)
      entry.resolve(msg)
    })
    this.worker.on('error', (err) => {
      for (const [, entry] of this.pending) {
        entry.reject(err instanceof Error ? err : new Error(String(err)))
      }
      this.pending.clear()
    })
    this.worker.on('exit', (code) => {
      for (const [, entry] of this.pending) {
        entry.reject(new Error(`OCR worker exited with code ${code}`))
      }
      this.pending.clear()
    })
  }

  public request(
    payload: Record<string, unknown>,
    onStarted?: () => void
  ): Promise<Record<string, unknown>> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onStarted })
      this.worker.postMessage({ ...payload, id })
    })
  }

  public async shutdown(): Promise<Record<string, unknown>> {
    const ack = await this.request({ type: 'shutdown' })
    await this.worker.terminate()
    return ack
  }

  public async forceTerminate(): Promise<number> {
    return this.worker.terminate()
  }
}

async function runSpike(): Promise<Record<string, unknown>> {
  const modelDir = parseArg('--model-dir=')
  const reportPath = parseArg('--report-path=')
  if (!modelDir || !reportPath) {
    throw new Error('Both --model-dir=<path> and --report-path=<path> are required')
  }

  const loopHistogram = monitorEventLoopDelay({ resolution: 10 })
  loopHistogram.enable()

  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'pv-ocr-spike-userdata-'))
  app.setPath('userData', userDataDir)
  await app.whenReady()

  const workRoot = await mkdtemp(path.join(os.tmpdir(), 'pv-ocr-spike-fixtures-'))
  const fixturesDir = path.join(workRoot, 'approved-docs')
  const sizeTestDir = path.join(workRoot, 'size-bounds')
  const tamperModelDir = path.join(workRoot, 'tampered-model')
  await mkdir(sizeTestDir, { recursive: true })
  await mkdir(tamperModelDir, { recursive: true })

  try {
    // Snapshot pinned traineddata before any worker touches it
    const trainedDataPath = path.join(modelDir, 'eng.traineddata')
    const modelBeforeStat = await stat(trainedDataPath)
    const modelBeforeBytes = await readFile(trainedDataPath)
    const modelBeforeSha256 = createHash('sha256').update(modelBeforeBytes).digest('hex')

    // Create 100% synthetic fixtures inside approved temp directory
    const fixtures = await createSyntheticOcrFixtures(fixturesDir)

    // Verify scanned_only.pdf genuinely has ZERO native selectable text before OCR
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const scanCheckTask = pdfjs.getDocument({
      data: new Uint8Array(await readFile(fixtures.scannedPdf.filePath)),
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      disableStream: true,
      disableAutoFetch: true,
      verbosity: 0
    } as Parameters<typeof pdfjs.getDocument>[0])
    const scanDoc = await scanCheckTask.promise
    let preCheckSelectableChars = 0
    for (let p = 1; p <= scanDoc.numPages; p++) {
      const page = await scanDoc.getPage(p)
      const txt = await page.getTextContent()
      for (const item of txt.items) {
        if ('str' in item && typeof item.str === 'string') {
          preCheckSelectableChars += item.str.trim().length
        }
      }
      page.cleanup()
    }
    await scanDoc.cleanup?.()
    await scanCheckTask.destroy()
    assertCondition(
      preCheckSelectableChars === 0,
      `Expected scanned_only.pdf to have 0 selectable chars, found ${preCheckSelectableChars}`
    )

    // Resolve worker script path using Personal Vault's production worker-path helper
    const workerScriptPath = resolveMainWorkerScriptPath({
      workerFileName: 'ocr-worker.js',
      sourceEntryPath: path.join(__dirname, 'ocr-worker.js'),
      moduleDir: __dirname,
      appPath: app.getAppPath(),
      isPackaged: app.isPackaged,
      isTest: false
    })

    // Shared AppWorkerBudget(3) verification:
    // Spawn 2 busy dummy Worker threads + 1 reclaimable idle Worker thread (liveCount = 3)
    const workerBudget = new AppWorkerBudget(3)
    const maxObservedState = { maxLive: 0 }
    const recordLive = (): void => {
      const live = workerBudget.getLiveCount()
      if (live > maxObservedState.maxLive) {
        maxObservedState.maxLive = live
      }
    }
    const spawnIdleDummyWorker = (): Worker =>
      new Worker(
        'const { parentPort } = require("node:worker_threads"); parentPort.on("message", () => {});',
        { eval: true }
      )

    const busyThumbRes = workerBudget.tryReserve()
    assertCondition(busyThumbRes !== null, 'Expected thumbnail worker reservation')
    const busyThumbWorker = spawnIdleDummyWorker()
    workerBudget.promote(busyThumbRes, busyThumbWorker)

    const busyExtractRes = workerBudget.tryReserve()
    assertCondition(busyExtractRes !== null, 'Expected extract worker reservation')
    const busyExtractWorker = spawnIdleDummyWorker()
    workerBudget.promote(busyExtractRes, busyExtractWorker)

    const idleSemanticRes = workerBudget.tryReserve()
    assertCondition(idleSemanticRes !== null, 'Expected idle semantic worker reservation')
    let idleSemanticWorker: Worker | null = spawnIdleDummyWorker()
    workerBudget.promote(idleSemanticRes, idleSemanticWorker)
    recordLive()

    assertCondition(
      workerBudget.getLiveCount() === 3 && workerBudget.tryReserve() === null,
      'Expected 3 live workers and saturated budget before idle reclaim'
    )

    // Reclaim idle worker, then prove failed spawn/resolver releases reservation without leak
    await idleSemanticWorker.terminate()
    idleSemanticWorker = null
    assertCondition(workerBudget.getLiveCount() === 2, 'Expected 2 live workers after idle reclaim')

    let simulatedFailureReleased = false
    const transientRes = workerBudget.tryReserve()
    assertCondition(transientRes !== null, 'Expected transient reservation after idle reclaim')
    recordLive()
    try {
      throw new Error('SIMULATED_RESOLVER_FAILURE')
    } catch {
      workerBudget.releaseReservation(transientRes)
      simulatedFailureReleased =
        workerBudget.getReservedCount() === 0 && workerBudget.getLiveCount() === 2
    }
    assertCondition(simulatedFailureReleased, 'Reservation leaked on simulated spawn failure')

    // Re-populate idle worker to test real OCR contention reclaim from 3 -> 2 -> 3
    const idleRes2 = workerBudget.tryReserve()
    assertCondition(idleRes2 !== null, 'Expected second idle semantic reservation')
    idleSemanticWorker = spawnIdleDummyWorker()
    workerBudget.promote(idleRes2, idleSemanticWorker)
    recordLive()
    assertCondition(workerBudget.tryReserve() === null, 'Expected budget full before OCR spawn')

    await idleSemanticWorker.terminate()
    idleSemanticWorker = null

    const ocrRes = workerBudget.tryReserve()
    assertCondition(ocrRes !== null, 'Expected OCR worker budget reservation after idle reclaim')
    const client = new OcrWorkerClient(workerScriptPath)
    workerBudget.promote(ocrRes, client.worker)
    recordLive()
    assertCondition(
      workerBudget.getLiveCount() === 3 &&
        workerBudget.getWorkerCount() === 3 &&
        workerBudget.getReservedCount() === 0 &&
        maxObservedState.maxLive <= 3,
      `Worker budget exceeded cap of 3 (live=${workerBudget.getLiveCount()})`
    )

    const mainMemBefore = process.memoryUsage()

    // 1. Cold OCR on synthetic receipt PNG
    const coldReceipt = await client.request({
      type: 'ocr-file',
      filePath: fixtures.receiptPng.filePath,
      approvedRoots: [fixturesDir],
      expectedByteSize: fixtures.receiptPng.byteSize,
      expectedSha256: fixtures.receiptPng.sha256,
      modelDir
    })
    assertCondition(
      coldReceipt.status === 'extracted',
      `Receipt PNG failed: ${JSON.stringify(coldReceipt)}`
    )
    const receiptText = String(coldReceipt.text ?? '')
    assertCondition(receiptText.includes('PERSONAL VAULT MARKET'), 'Missing receipt header')
    assertCondition(receiptText.includes('48291'), 'Missing receipt number 48291')
    assertCondition(receiptText.includes('24.50'), 'Missing receipt total 24.50')

    // 2. Warm OCR on synthetic receipt PNG + TIFF
    const warmReceipt = await client.request({
      type: 'ocr-file',
      filePath: fixtures.receiptPng.filePath,
      approvedRoots: [fixturesDir],
      expectedByteSize: fixtures.receiptPng.byteSize,
      expectedSha256: fixtures.receiptPng.sha256,
      modelDir
    })
    assertCondition(warmReceipt.status === 'extracted', 'Warm receipt PNG OCR failed')

    const tiffReceipt = await client.request({
      type: 'ocr-file',
      filePath: fixtures.receiptTiff.filePath,
      approvedRoots: [fixturesDir],
      expectedByteSize: fixtures.receiptTiff.byteSize,
      expectedSha256: fixtures.receiptTiff.sha256,
      modelDir
    })
    assertCondition(tiffReceipt.status === 'extracted', 'TIFF receipt OCR failed')
    assertCondition(String(tiffReceipt.text ?? '').includes('48291'), 'Missing 48291 in TIFF OCR')

    // 3. Image-only scanned PDF (2 pages, zero selectable PDF text)
    const scannedPdfRes = await client.request({
      type: 'ocr-file',
      filePath: fixtures.scannedPdf.filePath,
      approvedRoots: [fixturesDir],
      expectedByteSize: fixtures.scannedPdf.byteSize,
      expectedSha256: fixtures.scannedPdf.sha256,
      modelDir
    })
    assertCondition(
      scannedPdfRes.status === 'extracted' &&
        scannedPdfRes.extractionMethod === 'ocr_pdf_tesseract' &&
        scannedPdfRes.ocrPageCount === 2,
      `Unexpected scanned PDF outcome: ${JSON.stringify(scannedPdfRes)}`
    )
    const scannedPdfText = String(scannedPdfRes.text ?? '')
    assertCondition(scannedPdfText.includes('77410'), 'Missing page 1 account ref 77410')
    assertCondition(scannedPdfText.includes('645.00'), 'Missing page 2 balance 645.00')
    assertCondition(scannedPdfText.includes('ALPHA99'), 'Missing page 2 code ALPHA99')

    // 4. Blank image & blank scanned PDF -> honest ocr_no_text
    const blankImgRes = await client.request({
      type: 'ocr-file',
      filePath: fixtures.blankPng.filePath,
      approvedRoots: [fixturesDir],
      expectedByteSize: fixtures.blankPng.byteSize,
      expectedSha256: fixtures.blankPng.sha256,
      modelDir
    })
    assertCondition(
      blankImgRes.status === 'ocr_no_text' &&
        blankImgRes.text === null &&
        blankImgRes.extractedCharCount === 0,
      `Expected honest ocr_no_text for blank PNG, got ${JSON.stringify(blankImgRes)}`
    )

    const blankPdfRes = await client.request({
      type: 'ocr-file',
      filePath: fixtures.blankScanPdf.filePath,
      approvedRoots: [fixturesDir],
      expectedByteSize: fixtures.blankScanPdf.byteSize,
      expectedSha256: fixtures.blankScanPdf.sha256,
      modelDir
    })
    assertCondition(
      blankPdfRes.status === 'ocr_no_text' &&
        blankPdfRes.text === null &&
        blankPdfRes.extractedCharCount === 0,
      `Expected honest ocr_no_text for blank PDF, got ${JSON.stringify(blankPdfRes)}`
    )

    // 5. Unsupported format check (.bmp)
    const dummyBmpPath = path.join(fixturesDir, 'unsupported_sample.bmp')
    await writeFile(dummyBmpPath, Buffer.from('BM6\x00\x00\x00', 'ascii'))
    const unsupportedRes = await client.request({
      type: 'ocr-file',
      filePath: dummyBmpPath,
      approvedRoots: [fixturesDir],
      modelDir
    })
    assertCondition(unsupportedRes.status === 'unsupported', 'Expected .bmp to return unsupported')
    await rm(dummyBmpPath, { force: true })

    // 6. Requirement 5b: Mixed 3-page PDF (Page 1 native, Page 2 scanned image, Page 3 blank vector)
    const mixedPdfRes = await client.request({
      type: 'ocr-file',
      filePath: fixtures.mixedPdf.filePath,
      approvedRoots: [fixturesDir],
      expectedByteSize: fixtures.mixedPdf.byteSize,
      expectedSha256: fixtures.mixedPdf.sha256,
      modelDir
    })
    assertCondition(
      mixedPdfRes.status === 'extracted' &&
        mixedPdfRes.extractionMethod === 'ocr_hybrid_pdf' &&
        mixedPdfRes.nativePageCount === 1 &&
        mixedPdfRes.ocrPageCount === 1 &&
        mixedPdfRes.skippedBlankPageCount === 1,
      `Unexpected mixed PDF result: ${JSON.stringify(mixedPdfRes)}`
    )
    const mixedText = String(mixedPdfRes.text ?? '')
    assertCondition(
      mixedText.includes('NATIVE POLICY SECTION 1001'),
      'Mixed PDF lost native text on page 1'
    )
    assertCondition(
      mixedText.includes('SCANNED ADDENDUM 2002') && mixedText.includes('88310'),
      'Mixed PDF missed OCR on scanned page 2'
    )

    // 7. Requirement 4: Offline integrity rejection for missing & tampered traineddata (0 network calls)
    const shutdownPrimary = await client.shutdown()
    assertCondition(
      shutdownPrimary.nestedWorkerAttempts === 0 && shutdownPrimary.networkAttempts === 0,
      'Primary worker attempted nested worker or network access'
    )

    const integrityRes = workerBudget.tryReserve()
    assertCondition(integrityRes !== null, 'Expected integrity check worker slot')
    const integrityClient = new OcrWorkerClient(workerScriptPath)
    workerBudget.promote(integrityRes, integrityClient.worker)

    const missingModelRes = await integrityClient.request({
      type: 'ocr-file',
      filePath: fixtures.receiptPng.filePath,
      approvedRoots: [fixturesDir],
      modelDir: path.join(workRoot, 'nonexistent-model-dir')
    })
    assertCondition(
      missingModelRes.status === 'corrupt_or_failed' &&
        missingModelRes.errorCode === 'ocr_model_missing' &&
        missingModelRes.networkAttempts === 0,
      `Unexpected missing model response: ${JSON.stringify(missingModelRes)}`
    )

    const tamperedTrainedPath = path.join(tamperModelDir, 'eng.traineddata')
    await copyFile(trainedDataPath, tamperedTrainedPath)
    const tamperedBuf = await readFile(tamperedTrainedPath)
    tamperedBuf[128] ^= 0xff
    await writeFile(tamperedTrainedPath, tamperedBuf)

    const tamperedModelRes = await integrityClient.request({
      type: 'ocr-file',
      filePath: fixtures.receiptPng.filePath,
      approvedRoots: [fixturesDir],
      modelDir: tamperModelDir
    })
    assertCondition(
      tamperedModelRes.status === 'corrupt_or_failed' &&
        tamperedModelRes.errorCode === 'ocr_model_hash_mismatch' &&
        tamperedModelRes.networkAttempts === 0,
      `Unexpected tampered model response: ${JSON.stringify(tamperedModelRes)}`
    )

    await integrityClient.shutdown()

    // 8. Active mid-OCR cancellation & clean worker recovery
    await busyThumbWorker.terminate()
    await busyExtractWorker.terminate()
    assertCondition(
      workerBudget.getLiveCount() === 0 &&
        workerBudget.getWorkerCount() === 0 &&
        workerBudget.getReservedCount() === 0,
      'Expected 0 live/reserved workers before cancellation test'
    )

    const cancelRes = workerBudget.tryReserve()
    assertCondition(cancelRes !== null, 'Expected cancel test slot')
    const cancelClient = new OcrWorkerClient(workerScriptPath)
    workerBudget.promote(cancelRes, cancelClient.worker)

    let startedResolve!: () => void
    const startedSignal = new Promise<void>((res) => {
      startedResolve = res
    })

    const cancelStartMs = performance.now()
    const inFlightPromise = cancelClient
      .request(
        {
          type: 'ocr-file',
          filePath: fixtures.scannedPdf.filePath,
          approvedRoots: [fixturesDir],
          modelDir,
          notifyStarted: true,
          simulatePageDelayMs: 300
        },
        () => startedResolve()
      )
      .catch((err: Error) => ({ cancelled: true, reason: err.message }))

    await startedSignal
    await cancelClient.forceTerminate()
    const cancelOutcome = await inFlightPromise
    const cancelLatencyMs = Number((performance.now() - cancelStartMs).toFixed(2))
    assertCondition(
      'cancelled' in cancelOutcome && cancelOutcome.cancelled === true,
      'Expected in-flight OCR request to reject cleanly on worker termination'
    )
    assertCondition(
      workerBudget.getLiveCount() === 0 &&
        workerBudget.getWorkerCount() === 0 &&
        workerBudget.getReservedCount() === 0,
      'Expected 0 live and 0 reserved slots immediately after active cancellation'
    )

    // Spawn fresh recovery worker after cancellation to prove clean recovery
    const recoveryResSlot = workerBudget.tryReserve()
    assertCondition(recoveryResSlot !== null, 'Expected recovery worker slot')
    const recoveryClient = new OcrWorkerClient(workerScriptPath)
    workerBudget.promote(recoveryResSlot, recoveryClient.worker)
    const recoveryRes = await recoveryClient.request({
      type: 'ocr-file',
      filePath: fixtures.receiptPng.filePath,
      approvedRoots: [fixturesDir],
      modelDir
    })
    assertCondition(recoveryRes.status === 'extracted', 'Post-cancel recovery OCR failed')
    const recoveryShutdown = await recoveryClient.shutdown()
    assertCondition(
      workerBudget.getLiveCount() === 0 &&
        workerBudget.getWorkerCount() === 0 &&
        workerBudget.getReservedCount() === 0,
      'Expected 0 live and 0 reserved workers after recovery shutdown'
    )

    // 9. Requirement 5a: Explicit 64 MiB OCR limit vs 32 MiB Stage 7B limit
    const file34MiB = path.join(sizeTestDir, 'synthetic_34mib.bin')
    const file65MiB = path.join(sizeTestDir, 'synthetic_65mib.bin')
    await writeFile(file34MiB, Buffer.alloc(34 * 1024 * 1024, 0x41))
    await writeFile(file65MiB, Buffer.alloc(65 * 1024 * 1024, 0x42))

    const check34Under32 = await readAndVerifySourceWithLimit({
      filePath: file34MiB,
      approvedRoots: [sizeTestDir],
      maxInputBytes: NATIVE_EXTRACT_MAX_INPUT_BYTES
    })
    const check34Under64 = await readAndVerifySourceWithLimit({
      filePath: file34MiB,
      approvedRoots: [sizeTestDir],
      maxInputBytes: OCR_MAX_INPUT_BYTES
    })
    const check65Under64 = await readAndVerifySourceWithLimit({
      filePath: file65MiB,
      approvedRoots: [sizeTestDir],
      maxInputBytes: OCR_MAX_INPUT_BYTES
    })
    assertCondition(
      check34Under32.status === 'truncated' &&
        check34Under64.status === 'ok' &&
        check34Under64.byteSize === 34 * 1024 * 1024 &&
        check65Under64.status === 'truncated' &&
        check65Under64.truncationReason === 'max_input_bytes_exceeded',
      'Explicit 64 MiB OCR input limit checks failed'
    )

    // 10. Requirement 5c: Dual-track coexistence & staleness verification
    const baseFact = {
      fileLocationId: 501,
      contentRevision: 1,
      sha256: fixtures.mixedPdf.sha256,
      byteSize: fixtures.mixedPdf.byteSize
    }
    const nativeRow = {
      isCurrent: true,
      recipeVersion: NATIVE_EXTRACT_RECIPE_VERSION,
      extractionMethod: 'pdfjs_text',
      status: 'extracted',
      contentRevision: 1,
      observedSha256: fixtures.mixedPdf.sha256,
      observedByteSize: fixtures.mixedPdf.byteSize,
      extractedCharCount: 108,
      ocrCandidatePageCount: 1,
      extractedText: '--- Page 1 ---\nNATIVE POLICY SECTION 1001'
    }
    const ocrRow = {
      isCurrent: true,
      recipeVersion: OCR_RECIPE_VERSION,
      extractionMethod: 'ocr_hybrid_pdf',
      status: 'extracted',
      ocrModelId: PINNED_OCR_MODEL_MANIFEST.modelId,
      ocrModelManifestSha256: PINNED_OCR_MANIFEST_SHA256,
      ocrLanguage: PINNED_OCR_MODEL_MANIFEST.language,
      contentRevision: 1,
      observedSha256: fixtures.mixedPdf.sha256,
      observedByteSize: fixtures.mixedPdf.byteSize,
      ocrPageCount: 1,
      meanConfidence: mixedPdfRes.meanConfidence,
      extractedCharCount: mixedText.length,
      extractedText: mixedText
    }
    const activePolicyV1 = {
      modelId: PINNED_OCR_MODEL_MANIFEST.modelId,
      manifestSha256: PINNED_OCR_MANIFEST_SHA256,
      language: PINNED_OCR_MODEL_MANIFEST.language
    }
    const activePolicyV2 = {
      ...activePolicyV1,
      manifestSha256: 'f'.repeat(64)
    }

    const bothCurrent = composeDocumentExtractionTracks({
      currentFileFact: baseFact,
      nativeRow,
      ocrRow,
      activeOcrPolicy: activePolicyV1
    })
    const ocrModelRotated = composeDocumentExtractionTracks({
      currentFileFact: baseFact,
      nativeRow,
      ocrRow,
      activeOcrPolicy: activePolicyV2
    })
    const sourceModified = composeDocumentExtractionTracks({
      currentFileFact: { ...baseFact, contentRevision: 2, sha256: '0'.repeat(64) },
      nativeRow,
      ocrRow,
      activeOcrPolicy: activePolicyV1
    })
    assertCondition(
      bothCurrent.nativeTrack?.status === 'extracted' &&
        bothCurrent.ocrTrack?.status === 'extracted' &&
        ocrModelRotated.nativeTrack?.status === 'extracted' &&
        ocrModelRotated.ocrTrack?.status === 'stale' &&
        sourceModified.nativeTrack?.status === 'stale' &&
        sourceModified.ocrTrack?.status === 'stale',
      'Dual-track coexistence/staleness invariants failed'
    )

    // 11. Post-run bitwise source preservation across all fixtures + pinned traineddata
    let preservedCount = 0
    for (const fx of Object.values(fixtures)) {
      const afterStat = await stat(fx.filePath)
      const afterSha = createHash('sha256')
        .update(await readFile(fx.filePath))
        .digest('hex')
      assertCondition(
        afterStat.size === fx.byteSize &&
          afterStat.mtimeMs === fx.mtimeMs &&
          afterSha === fx.sha256,
        `Source preservation violated for ${fx.fileName}`
      )
      preservedCount += 1
    }
    const modelAfterStat = await stat(trainedDataPath)
    const modelAfterSha256 = createHash('sha256')
      .update(await readFile(trainedDataPath))
      .digest('hex')
    assertCondition(
      modelAfterStat.size === modelBeforeStat.size &&
        modelAfterStat.mtimeMs === modelBeforeStat.mtimeMs &&
        modelAfterSha256 === modelBeforeSha256,
      'Pinned eng.traineddata mutated during spike'
    )

    loopHistogram.disable()
    const mainMemAfter = process.memoryUsage()

    const report = {
      passed: true,
      timestamp: new Date().toISOString(),
      runtime: {
        electronVersion: process.versions.electron,
        nodeVersion: process.versions.node,
        modulesAbi: process.versions.modules,
        isPackaged: app.isPackaged,
        appPath: app.getAppPath(),
        launchCwd: process.cwd(),
        resolvedWorkerScriptPath: workerScriptPath,
        engineInfo: coldReceipt.engineInfo
      },
      offlineAndIsolation: {
        nestedWorkerSpawns:
          Number(shutdownPrimary.nestedWorkerAttempts ?? 0) +
          Number(recoveryShutdown.nestedWorkerAttempts ?? 0),
        outboundNetworkAttempts:
          Number(shutdownPrimary.networkAttempts ?? 0) +
          Number(recoveryShutdown.networkAttempts ?? 0),
        missingModelCode: missingModelRes.errorCode,
        tamperedModelCode: tamperedModelRes.errorCode
      },
      latenciesMs: {
        coldEngineInitMs: coldReceipt.coldInitMs,
        coldReceiptPngTotalMs: coldReceipt.durationMs,
        warmReceiptPngMs: warmReceipt.durationMs,
        warmReceiptTiffMs: tiffReceipt.durationMs,
        scannedPdf2PagesMs: scannedPdfRes.durationMs,
        mixedPdf3PagesMs: mixedPdfRes.durationMs,
        blankPngMs: blankImgRes.durationMs,
        blankPdfMs: blankPdfRes.durationMs,
        activeCancelTerminationMs: cancelLatencyMs,
        postCancelRecoveryMs: recoveryRes.durationMs
      },
      eventLoopDelayMs: {
        p50Ms: Number((loopHistogram.percentile(50) / 1e6).toFixed(2)),
        p95Ms: Number((loopHistogram.percentile(95) / 1e6).toFixed(2)),
        p99Ms: Number((loopHistogram.percentile(99) / 1e6).toFixed(2)),
        maxMs: Number((loopHistogram.max / 1e6).toFixed(2))
      },
      memoryMiB: {
        mainRssBeforeMiB: Number((mainMemBefore.rss / (1024 * 1024)).toFixed(2)),
        mainRssAfterMiB: Number((mainMemAfter.rss / (1024 * 1024)).toFixed(2)),
        // Note: process.memoryUsage().rss inside a Node worker_thread is a point-in-time
        // whole-process RSS sample, NOT a worker-specific or continuous peak measurement.
        sampledProcessRssDuringPdfOcrMiB: Number(
          (
            ((scannedPdfRes.memoryUsage as { rss: number } | undefined)?.rss ?? 0) /
            (1024 * 1024)
          ).toFixed(2)
        ),
        sampledWorkerIsolateHeapUsedMiB: Number(
          (
            ((scannedPdfRes.memoryUsage as { heapUsed: number } | undefined)?.heapUsed ?? 0) /
            (1024 * 1024)
          ).toFixed(2)
        )
      },
      workerBudgetAndLifecycle: {
        budgetCap: workerBudget.getMaxLiveWorkers(),
        maxObservedLiveWorkers: maxObservedState.maxLive,
        simulatedSpawnFailureReleased: simulatedFailureReleased,
        finalLiveWorkers: workerBudget.getWorkerCount(),
        finalReservedWorkers: workerBudget.getReservedCount()
      },
      recognitionOutcomes: {
        receiptPng: {
          status: coldReceipt.status,
          meanConfidence: coldReceipt.meanConfidence,
          extractedCharCount: coldReceipt.extractedCharCount,
          sampleText: receiptText.replace(/\n+/g, ' | ')
        },
        receiptTiff: {
          status: tiffReceipt.status,
          meanConfidence: tiffReceipt.meanConfidence,
          extractedCharCount: tiffReceipt.extractedCharCount
        },
        scannedPdf: {
          preOcrSelectableChars: preCheckSelectableChars,
          status: scannedPdfRes.status,
          extractionMethod: scannedPdfRes.extractionMethod,
          ocrPageCount: scannedPdfRes.ocrPageCount,
          meanConfidence: scannedPdfRes.meanConfidence,
          extractedCharCount: scannedPdfRes.extractedCharCount,
          sampleText: scannedPdfText.replace(/\n+/g, ' | ')
        },
        blankPng: {
          status: blankImgRes.status,
          text: blankImgRes.text,
          extractedCharCount: blankImgRes.extractedCharCount
        },
        blankScanPdf: {
          status: blankPdfRes.status,
          text: blankPdfRes.text,
          extractedCharCount: blankPdfRes.extractedCharCount
        },
        mixedPdf: {
          status: mixedPdfRes.status,
          extractionMethod: mixedPdfRes.extractionMethod,
          nativePageCount: mixedPdfRes.nativePageCount,
          ocrPageCount: mixedPdfRes.ocrPageCount,
          skippedBlankPageCount: mixedPdfRes.skippedBlankPageCount,
          meanConfidence: mixedPdfRes.meanConfidence,
          pageDetails: mixedPdfRes.pageDetails
        },
        unsupportedBmpStatus: unsupportedRes.status
      },
      resolvedDesignDetails: {
        explicit64MiBLimit: {
          file34MiBUnder32MiB: check34Under32.status,
          file34MiBUnder64MiB: check34Under64.status,
          file65MiBUnder64MiB: check65Under64.status
        },
        coexistenceChecks: {
          bothCurrentTracks: {
            native: bothCurrent.nativeTrack?.status,
            ocr: bothCurrent.ocrTrack?.status
          },
          afterOcrModelChange: {
            native: ocrModelRotated.nativeTrack?.status,
            ocr: ocrModelRotated.ocrTrack?.status
          },
          afterSourceMutation: {
            native: sourceModified.nativeTrack?.status,
            ocr: sourceModified.ocrTrack?.status
          }
        }
      },
      sourcePreservation: {
        fixturesVerifiedUnchanged: preservedCount,
        trainedDataVerifiedUnchanged: true
      }
    }

    await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8')
    return report
  } finally {
    await rm(workRoot, { recursive: true, force: true }).catch(() => {})
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {})
  }
}

runSpike()
  .then(() => {
    app.exit(0)
  })
  .catch(async (err) => {
    const reportPath = parseArg('--report-path=')
    const errorPayload = {
      passed: false,
      error: err instanceof Error ? (err.stack ?? err.message) : String(err)
    }
    if (reportPath) {
      await writeFile(reportPath, JSON.stringify(errorPayload, null, 2), 'utf8').catch(() => {})
    }
    console.error(errorPayload.error)
    app.exit(1)
  })
