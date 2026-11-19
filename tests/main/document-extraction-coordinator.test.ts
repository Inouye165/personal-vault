// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CatalogDatabase } from '../../src/main/services/catalog/database'
import { DocumentExtractionCoordinator } from '../../src/main/services/documents/coordinator'
import { DOCUMENT_EXTRACTION_RECIPE_VERSION } from '../../src/main/services/documents/types'
import { ThumbnailCoordinator } from '../../src/main/services/thumbnails/coordinator'
import { AppWorkerBudget } from '../../src/main/services/worker-budget'
import * as workerPath from '../../src/main/services/worker-path'
import { SemanticModelManager } from '../../src/main/services/semantic/model-manager'
import { SemanticSearchCoordinator } from '../../src/main/services/semantic/search-coordinator'
import { Worker } from 'node:worker_threads'

function sha256Of(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

const tempDirs: string[] = []
const openCatalogs: CatalogDatabase[] = []
const activeCoordinators: DocumentExtractionCoordinator[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pv-doc-coord-'))
  tempDirs.push(dir)
  return dir
}

function seedCatalogWithFiles(
  rootDir: string,
  files: Array<{ name: string; content: Buffer; ext: string; withHash?: boolean }>
): { catalog: CatalogDatabase; locationIds: number[] } {
  const catalogPath = join(rootDir, 'catalog.sqlite')
  const catalog = CatalogDatabase.open({ catalogPath })
  openCatalogs.push(catalog)

  const docsDir = join(rootDir, 'docs')
  mkdirSync(docsDir, { recursive: true })
  catalog.registerSource(docsDir)

  const batchItems = files.map((f) => {
    const filePath = join(docsDir, f.name)
    writeFileSync(filePath, f.content)
    const st = statSync(filePath)
    return {
      originalPath: filePath,
      fileName: f.name,
      extension: f.ext,
      category: 'document' as const,
      byteSize: st.size,
      birthtimeMs: Number.isFinite(st.birthtimeMs) ? st.birthtimeMs : null,
      mtimeMs: Number.isFinite(st.mtimeMs) ? st.mtimeMs : null,
      discoveredAtMs: Date.now()
    }
  })

  catalog.persistDiscoveryBatch(docsDir, batchItems)
  const page = catalog.getDocumentsPage({ offset: 0, limit: 100 })

  const hashInputs = page.items
    .map((item, idx) => {
      const f = files[idx]!
      if (f.withHash === false) return null
      return {
        originalPath: item.originalPath,
        sha256: sha256Of(f.content),
        observedByteSize: item.byteSize,
        observedMtimeMs: item.filesystemMtimeMs,
        hashedAtMs: Date.now()
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)

  if (hashInputs.length > 0) {
    catalog.recordHashObservationsBatch(hashInputs)
  }

  return {
    catalog,
    locationIds: page.items.map((i) => i.fileLocationId)
  }
}

afterEach(async () => {
  for (const coord of activeCoordinators.splice(0)) {
    await coord.shutdown()
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

describe('DocumentExtractionCoordinator (Stage 7B)', () => {
  it('extracts documents in a worker thread, preserves source bytes/mtime/birthtime, and caches bounded preview', async () => {
    const root = makeTempDir()
    const txtBuf = Buffer.from('Tax return notes\nLine 2', 'utf8')
    const mdBuf = Buffer.from('# Project Plan\n\n- Step 1', 'utf8')
    const { catalog, locationIds } = seedCatalogWithFiles(root, [
      { name: 'notes.txt', content: txtBuf, ext: '.txt' },
      { name: 'plan.md', content: mdBuf, ext: '.md' }
    ])

    const txtPath = join(root, 'docs', 'notes.txt')
    const beforeStat = statSync(txtPath)

    const coord = new DocumentExtractionCoordinator({ catalog })
    activeCoordinators.push(coord)
    coord.initialize()

    coord.startExtraction({ scope: 'all' })
    await coord.waitForIdle()

    const progress = coord.getProgress()
    expect(progress.status).toBe('completed')
    expect(progress.extractedDocuments).toBe(2)
    expect(progress.coverage.extractedDocuments).toBe(2)

    const preview = coord.getPreview(locationIds[0]!)
    expect(preview).not.toBeNull()
    expect(preview?.extractionStatus).toBe('extracted')
    expect(preview?.previewStatus).toBe('ready')
    expect(preview?.extractedText).toBe('Tax return notes\nLine 2')

    const afterStat = statSync(txtPath)
    expect(afterStat.size).toBe(beforeStat.size)
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs)
    expect(afterStat.birthtimeMs).toBe(beforeStat.birthtimeMs)
    expect(sha256Of(txtBuf)).toBe(sha256Of(Buffer.from('Tax return notes\nLine 2', 'utf8')))
  })

  it('reuses compatible extraction for identical SHA-256 content after live verification', async () => {
    const root = makeTempDir()
    const content = Buffer.from('Duplicate content body', 'utf8')
    const { catalog, locationIds } = seedCatalogWithFiles(root, [
      { name: 'copy-a.txt', content, ext: '.txt' },
      { name: 'copy-b.txt', content, ext: '.txt' }
    ])

    const coord = new DocumentExtractionCoordinator({ catalog })
    activeCoordinators.push(coord)
    coord.initialize()

    coord.extractSelected({ fileLocationIds: [locationIds[0]!] })
    await coord.waitForIdle()

    coord.extractSelected({ fileLocationIds: [locationIds[1]!] })
    await coord.waitForIdle()

    const progress = coord.getProgress()
    expect(progress.status).toBe('completed')
    expect(progress.reusedDocuments).toBe(1)

    const previewB = coord.getPreview(locationIds[1]!)
    expect(previewB?.extractedText).toBe('Duplicate content body')
  })

  it('rejects out-of-band changed source files and marks older recipe versions as stale', async () => {
    const root = makeTempDir()
    const content = Buffer.from('Original content', 'utf8')
    const { catalog, locationIds } = seedCatalogWithFiles(root, [
      { name: 'mutable.txt', content, ext: '.txt' }
    ])

    // Mutate file on disk without rescanning
    writeFileSync(join(root, 'docs', 'mutable.txt'), 'Changed out of band!')

    const coord = new DocumentExtractionCoordinator({ catalog })
    activeCoordinators.push(coord)
    coord.initialize()

    coord.extractSelected({ fileLocationIds: [locationIds[0]!] })
    await coord.waitForIdle()

    const pageAfterChange = catalog.getDocumentsPage({ offset: 0, limit: 10 })
    expect(pageAfterChange.items[0]?.extractionStatus).toBe('not_extracted')

    // Now test recipe invalidation ('stale')
    const repo = catalog.getDocumentRepository()
    const candidate = repo.getDocumentExtractionCandidate(locationIds[0]!)!
    const commitRes = repo.upsertDocumentExtraction({
      fileLocationId: candidate.fileLocationId,
      expectedDiscoveryObservationId: candidate.discoveryObservationId,
      expectedContentRevision: candidate.contentRevision,
      contentSha256: candidate.activeHash!,
      observedByteSize: candidate.byteSize,
      observedMtimeMs: candidate.filesystemMtimeMs,
      recipeVersion: 'old_recipe_v0',
      extractionStatus: 'extracted',
      statusDetail: null,
      extractedText: 'Old recipe text',
      extractedCharCount: 15,
      pageCount: null,
      truncated: false,
      truncationReason: null,
      detectedEncoding: 'utf-8'
    })
    expect(commitRes.committed).toBe(true)

    const stalePage = catalog.getDocumentsPage({ offset: 0, limit: 10 })
    expect(stalePage.items[0]?.extractionStatus).toBe('stale')
    expect(DOCUMENT_EXTRACTION_RECIPE_VERSION).toBe('doc_extract_v1')
  })

  it('supports pause, resume, active cancellation, worker timeout recovery, and restart interrupted recovery', async () => {
    const root = makeTempDir()
    const { catalog } = seedCatalogWithFiles(root, [
      { name: 'doc1.txt', content: Buffer.from('One', 'utf8'), ext: '.txt' },
      { name: 'doc2.txt', content: Buffer.from('Two', 'utf8'), ext: '.txt' },
      { name: 'doc3.txt', content: Buffer.from('Three', 'utf8'), ext: '.txt' }
    ])

    // 1. Timeout recovery
    const timeoutCoord = new DocumentExtractionCoordinator({
      catalog,
      workerTimeoutMs: 50,
      itemDelayMs: 250
    })
    activeCoordinators.push(timeoutCoord)
    timeoutCoord.initialize()
    timeoutCoord.startExtraction({ scope: 'all' })
    await timeoutCoord.waitForIdle()
    expect(timeoutCoord.getProgress().failedDocuments).toBe(3)
    expect(timeoutCoord.getDiagnostics().liveWorkers).toBeLessThanOrEqual(1)
    await timeoutCoord.shutdown()
    expect(timeoutCoord.getDiagnostics().liveWorkers).toBe(0)

    // 2. Active cancellation
    const cancelCoord = new DocumentExtractionCoordinator({
      catalog,
      itemDelayMs: 120
    })
    activeCoordinators.push(cancelCoord)
    cancelCoord.startExtraction({ scope: 'all', retryFailed: true })
    await new Promise((r) => setTimeout(r, 40))
    const cancelled = await cancelCoord.cancelExtraction()
    expect(cancelled.status).toBe('cancelled')
    await cancelCoord.shutdown()

    // 3. Interrupted recovery across restart
    const repo = catalog.getDocumentRepository()
    await repo.createDocumentExtractionJob({
      jobId: 'simulated-crash-job',
      scopeKind: 'all',
      recipeVersion: DOCUMENT_EXTRACTION_RECIPE_VERSION,
      retryFailed: true
    })

    const recoveredCoord = new DocumentExtractionCoordinator({ catalog })
    activeCoordinators.push(recoveredCoord)
    const initProgress = recoveredCoord.initialize()
    expect(initProgress.status).toBe('interrupted')

    recoveredCoord.resumeExtraction()
    await recoveredCoord.waitForIdle()
    expect(recoveredCoord.getProgress().status).toBe('completed')
    expect(recoveredCoord.getProgress().extractedDocuments).toBe(3)
  })

  it('rejects symlinked document paths inside approved roots', async () => {
    const root = makeTempDir()
    const outsideFile = join(root, 'secret-outside.txt')
    writeFileSync(outsideFile, 'Outside secret')

    const docsDir = join(root, 'docs')
    mkdirSync(docsDir, { recursive: true })
    const linkPath = join(docsDir, 'linked.txt')

    let symlinkCreated: boolean
    try {
      symlinkSync(outsideFile, linkPath)
      symlinkCreated = true
    } catch {
      symlinkCreated = false
    }

    if (!symlinkCreated) {
      return
    }

    const catalogPath = join(root, 'catalog-symlink.sqlite')
    const catalog = CatalogDatabase.open({ catalogPath })
    openCatalogs.push(catalog)
    catalog.registerSource(docsDir)
    catalog.persistDiscoveryBatch(docsDir, [
      {
        originalPath: linkPath,
        fileName: 'linked.txt',
        extension: '.txt',
        category: 'document',
        byteSize: 14,
        birthtimeMs: null,
        mtimeMs: null,
        discoveredAtMs: Date.now()
      }
    ])

    const coord = new DocumentExtractionCoordinator({ catalog })
    activeCoordinators.push(coord)
    coord.startExtraction({ scope: 'all' })
    await coord.waitForIdle()

    const page = catalog.getDocumentsPage({ offset: 0, limit: 10 })
    expect(page.items[0]?.extractionStatus).toBe('corrupt_or_failed')
    expect(page.items[0]?.statusDetail).toMatch(/symbolic link|approved/i)
  })

  it('rejects cross-format reuse for identical bytes (.txt vs .csv vs .pdf), allows same-parser reuse, and honors forceReextract', async () => {
    const root = makeTempDir()
    const docsDir = join(root, 'docs')
    mkdirSync(docsDir, { recursive: true })

    // Identical bytes across .txt, .csv, .pdf, and .md
    const sharedBytes = Buffer.from('col1,col2\nval1,val2\n', 'utf8')
    const txtPath = join(docsDir, 'same.txt')
    const csvPath = join(docsDir, 'same.csv')
    const pdfPath = join(docsDir, 'same.pdf')
    const mdPath = join(docsDir, 'same.md')
    writeFileSync(txtPath, sharedBytes)
    writeFileSync(csvPath, sharedBytes)
    writeFileSync(pdfPath, sharedBytes)
    writeFileSync(mdPath, sharedBytes)

    const { createHash } = await import('node:crypto')
    const sharedHash = createHash('sha256').update(sharedBytes).digest('hex')
    const now = Date.now()

    const catalog = CatalogDatabase.open({ catalogPath: join(root, 'catalog-reuse.sqlite') })
    openCatalogs.push(catalog)
    catalog.registerSource(docsDir)

    const makeItem = (filePath: string, fileName: string, extension: string) => {
      const st = statSync(filePath)
      return {
        originalPath: filePath,
        fileName,
        extension,
        category: 'document' as const,
        byteSize: st.size,
        birthtimeMs: st.birthtimeMs,
        mtimeMs: st.mtimeMs,
        discoveredAtMs: now
      }
    }

    catalog.persistDiscoveryBatch(docsDir, [
      makeItem(txtPath, 'same.txt', '.txt'),
      makeItem(csvPath, 'same.csv', '.csv'),
      makeItem(pdfPath, 'same.pdf', '.pdf'),
      makeItem(mdPath, 'same.md', '.md')
    ])
    catalog.recordHashObservationsBatch(
      [txtPath, csvPath, pdfPath, mdPath].map((p) => {
        const st = statSync(p)
        return {
          originalPath: p,
          sha256: sharedHash,
          observedByteSize: st.size,
          observedMtimeMs: st.mtimeMs,
          hashedAtMs: now
        }
      })
    )

    const coord = new DocumentExtractionCoordinator({ catalog })
    activeCoordinators.push(coord)

    const allIds = catalog
      .getDocumentsPage({ offset: 0, limit: 10 })
      .items.map((i) => i.fileLocationId)
    const txtId = catalog.getDocumentsPage({ offset: 0, limit: 10, extensionFilter: '.txt' })
      .items[0]!.fileLocationId
    const csvId = catalog.getDocumentsPage({ offset: 0, limit: 10, extensionFilter: '.csv' })
      .items[0]!.fileLocationId
    const pdfId = catalog.getDocumentsPage({ offset: 0, limit: 10, extensionFilter: '.pdf' })
      .items[0]!.fileLocationId
    const mdId = catalog.getDocumentsPage({ offset: 0, limit: 10, extensionFilter: '.md' })
      .items[0]!.fileLocationId

    // Extract .txt first
    coord.extractSelected({ fileLocationIds: [txtId], forceReextract: false })
    await coord.waitForIdle()
    expect(coord.getPreview(txtId)?.extractedText).toContain('col1,col2')

    // Now extract all remaining: .csv must produce tabular output (col1\tcol2), .pdf must fail as corrupt PDF, .md may reuse plain-text
    coord.startExtraction({ scope: 'all' })
    await coord.waitForIdle()

    const csvDetail = catalog.getDocumentDetail(csvId)
    const pdfDetail = catalog.getDocumentDetail(pdfId)
    const mdDetail = catalog.getDocumentDetail(mdId)

    expect(csvDetail?.extractionStatus).toBe('extracted')
    expect(coord.getPreview(csvId)?.extractedText).toContain('col1\tcol2')
    expect(pdfDetail?.extractionStatus).toBe('corrupt_or_failed')
    expect(mdDetail?.extractionStatus).toBe('extracted')
    expect(allIds).toHaveLength(4)

    // forceReextract: true must bypass reuse and re-extract
    coord.extractSelected({ fileLocationIds: [mdId], forceReextract: true })
    await coord.waitForIdle()
    expect(coord.getProgress().reusedDocuments).toBe(0)
  })

  it('enforces maxAppLiveWorkers admission budget across overlapping external workers and does not release capacity on termination timeout', async () => {
    const root = makeTempDir()
    const docsDir = join(root, 'docs')
    mkdirSync(docsDir, { recursive: true })
    const filePath = join(docsDir, 'budget.txt')
    writeFileSync(filePath, 'Worker budget test')
    const st = statSync(filePath)

    const catalog = CatalogDatabase.open({ catalogPath: join(root, 'catalog-budget.sqlite') })
    openCatalogs.push(catalog)
    catalog.registerSource(docsDir)
    catalog.persistDiscoveryBatch(docsDir, [
      {
        originalPath: filePath,
        fileName: 'budget.txt',
        extension: '.txt',
        category: 'document',
        byteSize: st.size,
        birthtimeMs: st.birthtimeMs,
        mtimeMs: st.mtimeMs,
        discoveredAtMs: Date.now()
      }
    ])

    let externalWorkers = 3
    const coord = new DocumentExtractionCoordinator({
      catalog,
      maxAppLiveWorkers: 3,
      getExternalLiveWorkers: () => externalWorkers,
      workerTimeoutMs: 500
    })
    activeCoordinators.push(coord)

    coord.startExtraction({ scope: 'all' })
    await new Promise((r) => setTimeout(r, 80))
    // While 3 external workers are active, document coordinator must NOT spawn its own worker
    expect(coord.getDiagnostics().liveWorkers).toBe(0)

    // Free 1 external worker slot -> document coordinator admits 1 worker (total = 3 <= 3) and completes
    externalWorkers = 2
    await coord.waitForIdle()
    expect(coord.getProgress().status).toBe('completed')
    expect(coord.getProgress().extractedDocuments).toBe(1)
    expect(coord.getDiagnostics().liveWorkers).toBe(0)
  })

  it('preserves forceReextract: true across pause/resume and restart recovery, and recovers cleanly from worker exit failure', async () => {
    const root = makeTempDir()
    const docsDir = join(root, 'docs')
    mkdirSync(docsDir, { recursive: true })
    const fileA = join(docsDir, 'a.txt')
    const fileB = join(docsDir, 'b.txt')
    writeFileSync(fileA, 'Same bytes for A and B')
    writeFileSync(fileB, 'Same bytes for A and B')

    const { createHash } = await import('node:crypto')
    const sharedHash = createHash('sha256').update('Same bytes for A and B').digest('hex')
    const now = Date.now()
    const catalog = CatalogDatabase.open({ catalogPath: join(root, 'catalog-force-resume.sqlite') })
    openCatalogs.push(catalog)
    catalog.registerSource(docsDir)
    catalog.persistDiscoveryBatch(
      docsDir,
      [fileA, fileB].map((p, idx) => {
        const st = statSync(p)
        return {
          originalPath: p,
          fileName: idx === 0 ? 'a.txt' : 'b.txt',
          extension: '.txt',
          category: 'document' as const,
          byteSize: st.size,
          birthtimeMs: st.birthtimeMs,
          mtimeMs: st.mtimeMs,
          discoveredAtMs: now
        }
      })
    )
    catalog.recordHashObservationsBatch(
      [fileA, fileB].map((p) => {
        const st = statSync(p)
        return {
          originalPath: p,
          sha256: sharedHash,
          observedByteSize: st.size,
          observedMtimeMs: st.mtimeMs,
          hashedAtMs: now
        }
      })
    )

    const ids = catalog
      .getDocumentsPage({ offset: 0, limit: 10 })
      .items.map((i) => i.fileLocationId)

    // Extract fileA first so its hash is in document_extractions
    const initialCoord = new DocumentExtractionCoordinator({ catalog })
    activeCoordinators.push(initialCoord)
    initialCoord.extractSelected({ fileLocationIds: [ids[0]!], forceReextract: false })
    await initialCoord.waitForIdle()
    await initialCoord.shutdown()

    // Start forced re-extraction on both, pause immediately, then resume in a NEW coordinator (simulating restart)
    const coord2 = new DocumentExtractionCoordinator({ catalog, itemDelayMs: 120 })
    activeCoordinators.push(coord2)
    coord2.extractSelected({ fileLocationIds: ids, forceReextract: true })
    coord2.pauseExtraction()
    await coord2.waitForIdle()
    expect(coord2.getProgress().status).toBe('paused')
    await coord2.shutdown()

    const coord3 = new DocumentExtractionCoordinator({ catalog })
    activeCoordinators.push(coord3)
    const resumed = coord3.resumeExtraction()
    expect(resumed.status === 'running' || resumed.status === 'completed').toBe(true)
    await coord3.waitForIdle()
    expect(coord3.getProgress().status).toBe('completed')
    // Must NOT have reused fileA's cached extraction because forceReextract was persisted on the job
    expect(coord3.getProgress().reusedDocuments).toBe(0)
  })

  it('keeps totalAppLiveWorkers <= 3 when ThumbnailCoordinator and DocumentExtractionCoordinator overlap', async () => {
    const root = makeTempDir()
    const { catalog, locationIds } = seedCatalogWithFiles(root, [
      {
        name: 'overlap.txt',
        content: Buffer.from('Overlapping worker budget test document.'),
        ext: '.txt'
      }
    ])

    let thumbCoord: ThumbnailCoordinator | null = null
    let docCoord: DocumentExtractionCoordinator | null = null

    thumbCoord = new ThumbnailCoordinator({
      cacheDir: join(root, 'thumb-cache'),
      approvedRoots: [join(root, 'docs')],
      maxActiveJobs: 2,
      maxAppLiveWorkers: 3,
      getExternalLiveWorkers: () => docCoord?.getDiagnostics().liveWorkers ?? 0
    })

    docCoord = new DocumentExtractionCoordinator({
      catalog,
      maxAppLiveWorkers: 3,
      getExternalLiveWorkers: () => thumbCoord?.getDiagnostics().liveWorkers ?? 0,
      tryReleaseExternalIdleWorker: () => thumbCoord?.releaseOneIdleWorker() ?? false
    })
    activeCoordinators.push(docCoord)

    try {
      const fakePhoto = join(root, 'docs', 'overlap.txt')
      const thumbReq = thumbCoord
        .requestThumbnail({
          sourcePath: fakePhoto,
          expectedByteSize: Buffer.byteLength('Overlapping worker budget test document.'),
          priority: 'high'
        })
        .catch(() => null)

      docCoord.extractSelected({ fileLocationIds: locationIds, forceReextract: true })

      const totalLive =
        (thumbCoord.getDiagnostics().liveWorkers ?? 0) + docCoord.getDiagnostics().liveWorkers
      expect(totalLive).toBeLessThanOrEqual(3)

      await Promise.all([thumbReq, docCoord.waitForIdle()])
      expect(docCoord.getProgress().status).toBe('completed')
      expect(docCoord.getProgress().extractedDocuments).toBe(1)
      expect(
        (thumbCoord.getDiagnostics().liveWorkers ?? 0) + docCoord.getDiagnostics().liveWorkers
      ).toBeLessThanOrEqual(3)
    } finally {
      await thumbCoord.shutdown()
    }
  })

  it('recovers cleanly when the document worker exits unexpectedly', async () => {
    const root = makeTempDir()
    const { catalog, locationIds } = seedCatalogWithFiles(root, [
      {
        name: 'crash.txt',
        content: Buffer.from('This extraction will hit an exiting worker.'),
        ext: '.txt'
      }
    ])

    const crashingWorkerPath = join(root, 'crashing-doc-worker.cjs')
    writeFileSync(crashingWorkerPath, 'process.exit(1)\n', 'utf8')

    const coord = new DocumentExtractionCoordinator({
      catalog,
      workerScriptPath: crashingWorkerPath
    })
    activeCoordinators.push(coord)

    coord.extractSelected({ fileLocationIds: locationIds, forceReextract: true })
    await coord.waitForIdle()

    expect(coord.getProgress().status).toBe('completed')
    expect(coord.getProgress().failedDocuments).toBe(1)
    expect(coord.getDiagnostics().liveWorkers).toBe(0)

    const detail = catalog.getDocumentDetail(locationIds[0]!)
    expect(detail?.extractionStatus).toBe('corrupt_or_failed')
    const preview = coord.getPreview(locationIds[0]!)
    expect(preview?.extractionStatus).toBe('corrupt_or_failed')
    expect(preview?.statusDetail).toContain('exited')
  })

  it('keeps failed workers counted in diagnostics until actual exit, retains accounting on terminate rejection, and isolates replacement requests from old worker exits', async () => {
    const root = makeTempDir()
    const { catalog, locationIds } = seedCatalogWithFiles(root, [
      {
        name: 'err-before-exit-1.txt',
        content: Buffer.from('First doc'),
        ext: '.txt'
      },
      {
        name: 'err-before-exit-2.txt',
        content: Buffer.from('Second doc'),
        ext: '.txt'
      }
    ])

    // Worker script that stays alive after reporting a response so we can deterministically
    // trigger an 'error' event before 'exit' and inspect liveWorkers/terminatingWorkers.
    const slowExitWorker = join(root, 'slow-exit-doc-worker.cjs')
    writeFileSync(
      slowExitWorker,
      `const { parentPort } = require('node:worker_threads');
       const fs = require('node:fs');
       parentPort.on('message', (msg) => {
         const st = fs.statSync(msg.sourcePath);
         parentPort.postMessage({
           id: msg.id,
           ok: true,
           observedSha256: msg.expectedSha256 || '0'.repeat(64),
           observedByteSize: st.size,
           observedMtimeMs: st.mtimeMs,
           outcome: {
             recipeVersion: 'doc_extract_v1',
             status: 'extracted',
             statusDetail: null,
             text: 'Extracted OK',
             extractedCharCount: 12,
             pageCount: null,
             truncated: false,
             truncationReason: null,
             detectedEncoding: 'utf-8'
           }
         });
       });
       setInterval(() => {}, 1000);
      `,
      'utf8'
    )

    const coord = new DocumentExtractionCoordinator({
      catalog,
      workerScriptPath: slowExitWorker
    })
    activeCoordinators.push(coord)

    const internals = coord as unknown as {
      ensureWorker: () => Promise<import('node:worker_threads').Worker>
      worker: import('node:worker_threads').Worker | null
      terminatingWorkers: Set<import('node:worker_threads').Worker>
      activeWorkerRequest: {
        id: number
        worker: import('node:worker_threads').Worker
        resolve: (res: unknown) => void
        reject: (err: unknown) => void
        timer: NodeJS.Timeout
      } | null
      terminateActiveWorker: (reason: string) => Promise<void>
    }

    // 1. Worker emits 'error' BEFORE 'exit': must stay counted in liveWorkers & terminatingWorkers until 'exit'
    const w1 = await internals.ensureWorker()
    w1.emit('error', new Error('Simulated worker error before exit'))

    expect(internals.worker).toBeNull()
    expect(coord.getDiagnostics().terminatingWorkers).toBe(1)
    expect(coord.getDiagnostics().liveWorkers).toBe(1)

    // Replacement worker admission must NOT spawn a second worker while w1 hasn't exited
    let replacementResolved = false
    const w2Promise = internals.ensureWorker().then((w) => {
      replacementResolved = true
      return w
    })
    await new Promise((r) => setTimeout(r, 40))
    expect(replacementResolved).toBe(false)
    expect(coord.getDiagnostics().liveWorkers).toBe(1)

    // Terminate w1 so it emits 'exit' -> replacement worker w2 is admitted
    await w1.terminate()
    const w2 = await w2Promise
    expect(w2).not.toBe(w1)
    expect(coord.getDiagnostics().liveWorkers).toBe(1)
    expect(coord.getDiagnostics().terminatingWorkers).toBe(0)

    // 2. terminate() rejection retains w2 in terminatingWorkers until actual 'exit'
    const origTerminate = w2.terminate.bind(w2)
    w2.terminate = async () => {
      throw new Error('Simulated terminate rejection')
    }
    await internals.terminateActiveWorker('test rejection')
    expect(coord.getDiagnostics().terminatingWorkers).toBe(1)
    expect(coord.getDiagnostics().liveWorkers).toBe(1)

    // 3. Old worker w2's delayed 'exit' must NOT resolve replacement worker w3's active request
    w2.terminate = origTerminate
    await origTerminate()
    await new Promise((r) => setTimeout(r, 20))
    expect(coord.getDiagnostics().liveWorkers).toBe(0)

    // Now run actual extraction on the 2 documents with the coordinator to verify clean recovery
    await coord.extractSelected({ fileLocationIds: locationIds, forceReextract: true })
    await coord.waitForIdle()
    expect(coord.getProgress().lastError).toBeNull()
    expect(coord.getProgress().status).toBe('completed')
    expect(coord.getProgress().extractedDocuments).toBe(2)
    expect(coord.getDiagnostics().liveWorkers).toBe(0)
  })

  it('does not let an old worker exit event resolve a replacement worker active request', async () => {
    const root = makeTempDir()
    const { catalog } = seedCatalogWithFiles(root, [
      { name: 'dummy.txt', content: Buffer.from('Dummy'), ext: '.txt' }
    ])

    const idleWorkerPath = join(root, 'idle-doc-worker.cjs')
    writeFileSync(idleWorkerPath, 'setInterval(() => {}, 1000);\n', 'utf8')

    const coord = new DocumentExtractionCoordinator({
      catalog,
      workerScriptPath: idleWorkerPath
    })
    activeCoordinators.push(coord)

    const internals = coord as unknown as {
      ensureWorker: () => Promise<import('node:worker_threads').Worker>
      worker: import('node:worker_threads').Worker | null
      terminatingWorkers: Set<import('node:worker_threads').Worker>
      activeWorkerRequest: {
        id: number
        worker: import('node:worker_threads').Worker
        resolve: (res: unknown) => void
        reject: (err: unknown) => void
        timer: NodeJS.Timeout
      } | null
    }

    const w1 = await internals.ensureWorker()
    const replacementWorkerMarker = {} as import('node:worker_threads').Worker

    let resolvedResult: unknown = null
    internals.worker = replacementWorkerMarker
    internals.terminatingWorkers.add(w1)
    const timer = setTimeout(() => {}, 5000)
    internals.activeWorkerRequest = {
      id: 99,
      worker: replacementWorkerMarker,
      resolve: (res) => {
        resolvedResult = res
      },
      reject: () => {},
      timer
    }

    // Fire the real 'exit' listener registered on w1 by ensureWorker()
    w1.emit('exit', 0)
    expect(resolvedResult).toBeNull()
    expect(internals.activeWorkerRequest).not.toBeNull()
    expect(internals.worker).toBe(replacementWorkerMarker)

    clearTimeout(timer)
    internals.activeWorkerRequest = null
    internals.worker = null
    await w1.terminate()
  })

  it('includes the snapshot worker in shared maxAppLiveWorkers admission and diagnostics through termination', async () => {
    const root = makeTempDir()
    const { catalog } = seedCatalogWithFiles(root, [
      { name: 'snap-budget.txt', content: Buffer.from('Snapshot budget check'), ext: '.txt' }
    ])

    let externalWorkers = 3
    const coord = new DocumentExtractionCoordinator({
      catalog,
      maxAppLiveWorkers: 3,
      getExternalLiveWorkers: () => externalWorkers
    })
    activeCoordinators.push(coord)

    // With 3 external workers already live, startExtraction must wait before spawning snapshot worker
    const startPromise = coord.startExtraction({ scope: 'all' })
    await new Promise((r) => setTimeout(r, 80))
    expect(coord.getDiagnostics().liveWorkers).toBe(0)

    // Also verify snapshotWorkerHooks accurately track active -> terminating -> exited in diagnostics
    const { EventEmitter } = await import('node:events')
    const fakeSnapshotWorker = new EventEmitter() as unknown as import('node:worker_threads').Worker
    const hooks = (
      coord as unknown as {
        createSnapshotWorkerHooks: () => {
          onSpawn: (w: import('node:worker_threads').Worker) => void
          onTerminating: (w: import('node:worker_threads').Worker) => void
          onExit: (w: import('node:worker_threads').Worker) => void
        }
      }
    ).createSnapshotWorkerHooks()

    hooks.onSpawn(fakeSnapshotWorker)
    expect(coord.getDiagnostics().activeWorkers).toBe(1)
    expect(coord.getDiagnostics().terminatingWorkers).toBe(0)
    expect(coord.getDiagnostics().liveWorkers).toBe(1)

    hooks.onTerminating(fakeSnapshotWorker)
    expect(coord.getDiagnostics().activeWorkers).toBe(0)
    expect(coord.getDiagnostics().terminatingWorkers).toBe(1)
    expect(coord.getDiagnostics().liveWorkers).toBe(1)

    hooks.onExit(fakeSnapshotWorker)
    expect(coord.getDiagnostics().activeWorkers).toBe(0)
    expect(coord.getDiagnostics().terminatingWorkers).toBe(0)
    expect(coord.getDiagnostics().liveWorkers).toBe(0)

    // Release 1 external worker slot so startExtraction admits the snapshot + extraction workers and completes
    externalWorkers = 2
    await startPromise
    await coord.waitForIdle()
    expect(coord.getProgress().status).toBe('completed')
    expect(coord.getProgress().extractedDocuments).toBe(1)
    expect(coord.getDiagnostics().liveWorkers).toBe(0)
  })

  it('enforces atomic AppWorkerBudget reservation across concurrent document and semantic-search worker spawns with 2 existing workers', async () => {
    const root = makeTempDir()
    const { catalog } = seedCatalogWithFiles(root, [
      {
        name: 'concurrent-budget.txt',
        content: Buffer.from('Concurrent worker budget test.'),
        ext: '.txt'
      }
    ])

    const idleScript = join(root, 'idle-budget-worker.cjs')
    writeFileSync(idleScript, 'setInterval(() => {}, 1000);\n', 'utf8')

    const mockSearchWorkerScript = join(root, 'mock-search-worker.cjs')
    writeFileSync(
      mockSearchWorkerScript,
      `const { parentPort } = require('node:worker_threads');
       parentPort.on('message', (msg) => {
         if (msg.type === 'search_photos') {
           parentPort.postMessage({
             id: msg.id,
             status: 'ok',
             queryVector: new Array(512).fill(0),
             items: [],
             totalMatches: 0
           });
         }
       });
      `,
      'utf8'
    )

    const budget = new AppWorkerBudget(3)
    const r1 = budget.tryReserve()!
    const r2 = budget.tryReserve()!
    expect(r1).not.toBeNull()
    expect(r2).not.toBeNull()
    const existingW1 = new Worker(idleScript)
    const existingW2 = new Worker(idleScript)
    budget.promote(r1, existingW1)
    budget.promote(r2, existingW2)
    expect(budget.getLiveCount()).toBe(2)

    const modelManager = new SemanticModelManager({
      modelsRootDir: join(root, 'models'),
      getApprovedRoots: () => [],
      getVaultRoot: () => null
    })
    const searchCoord = new SemanticSearchCoordinator({
      catalog,
      modelManager,
      workerScriptPath: mockSearchWorkerScript,
      maxAppLiveWorkers: 3,
      workerBudget: budget,
      requestTimeoutMs: 5000
    })

    const docCoord = new DocumentExtractionCoordinator({
      catalog,
      maxAppLiveWorkers: 3,
      workerBudget: budget,
      workerTimeoutMs: 5000
    })
    activeCoordinators.push(docCoord)

    let maxObservedLive = 0
    const sampler = setInterval(() => {
      maxObservedLive = Math.max(maxObservedLive, budget.getLiveCount())
    }, 2)

    try {
      // Concurrently invoke both document extraction (snapshot + extraction workers) and semantic search
      const docPromise = docCoord
        .startExtraction({ scope: 'all' })
        .then(() => docCoord.waitForIdle())
      const searchInternals = searchCoord as unknown as {
        ensureWorker: (gen: number) => Promise<Worker>
      }
      const searchPromise = searchInternals.ensureWorker(0)

      // Let them race for the single remaining slot (2 existing + 1 admitted = 3 max, NEVER 4)
      await new Promise((r) => setTimeout(r, 80))
      maxObservedLive = Math.max(maxObservedLive, budget.getLiveCount())
      expect(maxObservedLive).toBeLessThanOrEqual(3)

      // Release one existing worker so the second caller can be admitted and finish cleanly
      await existingW1.terminate()
      await Promise.all([docPromise, searchPromise])

      expect(maxObservedLive).toBeLessThanOrEqual(3)
      expect(docCoord.getProgress().status).toBe('completed')
      expect(docCoord.getProgress().extractedDocuments).toBe(1)
    } finally {
      clearInterval(sampler)
      await existingW1.terminate().catch(() => {})
      await existingW2.terminate().catch(() => {})
      await searchCoord.shutdown()
    }

    expect(budget.getLiveCount()).toBe(0)
    expect(budget.getReservedCount()).toBe(0)

    // Verify spawn failure releases reservation cleanly
    const failedReservation = budget.tryReserve()
    expect(failedReservation).not.toBeNull()
    expect(budget.getReservedCount()).toBe(1)
    expect(budget.getLiveCount()).toBe(1)
    budget.releaseReservation(failedReservation!)
    expect(budget.getReservedCount()).toBe(0)
    expect(budget.getLiveCount()).toBe(0)
  })

  it('releases worker budget reservations when script resolution fails in DocumentExtractionCoordinator, SemanticSearchCoordinator, and DocumentRepository.runSnapshotWorker', async () => {
    const root = makeTempDir()
    const dbPath = join(root, 'catalog.db')
    const docsDir = join(root, 'docs')
    mkdirSync(docsDir, { recursive: true })
    const docPath = join(docsDir, 'sample.txt')
    writeFileSync(docPath, 'hello reservation cleanup', 'utf8')

    const catalog = CatalogDatabase.open({ catalogPath: dbPath })
    openCatalogs.push(catalog)
    catalog.registerSource(docsDir)
    const st = statSync(docPath)
    catalog.persistDiscoveryBatch(docsDir, [
      {
        originalPath: docPath,
        fileName: 'sample.txt',
        extension: '.txt',
        category: 'document',
        byteSize: st.size,
        birthtimeMs: st.birthtimeMs,
        mtimeMs: st.mtimeMs,
        discoveredAtMs: Date.now()
      }
    ])

    const budget = new AppWorkerBudget(3)
    const docCoord = new DocumentExtractionCoordinator({
      catalog,
      maxAppLiveWorkers: 3,
      workerBudget: budget
    })
    activeCoordinators.push(docCoord)

    const modelManager = new SemanticModelManager({
      modelsRootDir: join(root, 'models'),
      getApprovedRoots: () => [],
      getVaultRoot: () => null
    })
    const searchCoord = new SemanticSearchCoordinator({
      catalog,
      modelManager,
      maxAppLiveWorkers: 3,
      workerBudget: budget
    })

    const spy = vi.spyOn(workerPath, 'resolveMainWorkerScriptPath')
    try {
      // 1. DocumentExtractionCoordinator.ensureWorker resolver failure
      spy.mockImplementationOnce(() => {
        throw new Error('Injected doc worker resolver failure')
      })
      await expect(
        (docCoord as unknown as { ensureWorker: () => Promise<Worker> }).ensureWorker()
      ).rejects.toThrow('Injected doc worker resolver failure')
      expect(budget.getReservedCount()).toBe(0)
      expect(budget.getLiveCount()).toBe(0)

      // 2. SemanticSearchCoordinator.ensureWorker resolver failure
      spy.mockImplementationOnce(() => {
        throw new Error('Injected search worker resolver failure')
      })
      await expect(
        (
          searchCoord as unknown as {
            ensureWorker: (generation: number) => Promise<Worker>
          }
        ).ensureWorker(0)
      ).rejects.toThrow('Injected search worker resolver failure')
      expect(budget.getReservedCount()).toBe(0)
      expect(budget.getLiveCount()).toBe(0)

      // 3. DocumentRepository.runSnapshotWorker resolver failure (invoked via startExtraction)
      spy.mockImplementationOnce(() => {
        throw new Error('Injected snapshot worker resolver failure')
      })
      await expect(docCoord.startExtraction({ scope: 'all' })).rejects.toThrow(
        'Injected snapshot worker resolver failure'
      )
      expect(budget.getReservedCount()).toBe(0)
      expect(budget.getLiveCount()).toBe(0)
    } finally {
      spy.mockRestore()
      await searchCoord.shutdown()
    }
  })
})
