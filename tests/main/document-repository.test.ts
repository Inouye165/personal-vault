// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  buildDocumentContentRevision,
  CatalogDatabase,
  DatabaseClosedError
} from '../../src/main/services/catalog'
import { DocumentExtractionCoordinator } from '../../src/main/services/documents/coordinator'

describe('Stage 7A — DocumentRepository', () => {
  let tempDir: string
  let dbPath: string
  let catalog: CatalogDatabase

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pv-doc-repo-'))
    dbPath = join(tempDir, 'catalog.db')
    catalog = CatalogDatabase.open({ catalogPath: dbPath })
  })

  afterEach(() => {
    if (!catalog.isClosed()) {
      catalog.close()
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  function seedMixedCatalog() {
    const sourceRoot = join(tempDir, 'docs-source')
    catalog.persistDiscoveryBatch(sourceRoot, [
      {
        originalPath: join(sourceRoot, 'receipt_2025.pdf'),
        fileName: 'receipt_2025.pdf',
        extension: '.pdf',
        category: 'document',
        byteSize: 4096,
        birthtimeMs: 1_690_000_000_000,
        mtimeMs: 1_695_000_000_000,
        discoveredAtMs: 1_700_000_000_000
      },
      {
        originalPath: join(sourceRoot, 'notes_100%.md'),
        fileName: 'notes_100%.md',
        extension: '.MD',
        category: 'document',
        byteSize: 512,
        birthtimeMs: null,
        mtimeMs: null,
        discoveredAtMs: 1_700_000_000_000
      },
      {
        originalPath: join(sourceRoot, 'manual_v1.txt'),
        fileName: 'manual_v1.txt',
        extension: '.txt',
        category: 'document',
        byteSize: 1024,
        birthtimeMs: 1_691_000_000_000,
        mtimeMs: 1_696_000_000_000,
        discoveredAtMs: 1_700_000_000_000
      },
      {
        originalPath: join(sourceRoot, 'contract.pdf'),
        fileName: 'contract.pdf',
        extension: '.pdf',
        category: 'document',
        byteSize: 8192,
        birthtimeMs: 1_692_000_000_000,
        mtimeMs: 1_697_000_000_000,
        discoveredAtMs: 1_700_000_000_000
      },
      {
        originalPath: join(sourceRoot, 'sunset.jpg'),
        fileName: 'sunset.jpg',
        extension: '.jpg',
        category: 'photo',
        byteSize: 2048,
        birthtimeMs: 1_693_000_000_000,
        mtimeMs: 1_698_000_000_000,
        discoveredAtMs: 1_700_000_000_000
      }
    ])

    const page = catalog.getDocumentsPage({ offset: 0, limit: 50 })
    const pdfReceipt = page.items.find((i) => i.fileName === 'receipt_2025.pdf')!
    catalog.recordHashObservationsBatch([
      {
        originalPath: pdfReceipt.originalPath,
        sha256: 'a'.repeat(64),
        observedByteSize: 4096,
        observedMtimeMs: 1_695_000_000_000,
        hashedAtMs: 1_700_000_001_000
      }
    ])

    return { sourceRoot }
  }

  it('lists only category=document items deterministically with pagination and honest status', () => {
    seedMixedCatalog()

    const page1 = catalog.getDocumentsPage({ offset: 0, limit: 2 })
    expect(page1.totalCount).toBe(4)
    expect(page1.items).toHaveLength(2)
    expect(page1.items.every((item) => item.extractionStatus === 'not_extracted')).toBe(true)
    expect(page1.items.every((item) => item.previewStatus === 'not_extracted')).toBe(true)
    expect(page1.items.map((item) => item.fileName)).toEqual(['receipt_2025.pdf', 'notes_100%.md'])

    const page2 = catalog.getDocumentsPage({ offset: 2, limit: 2 })
    expect(page2.totalCount).toBe(4)
    expect(page2.items.map((item) => item.fileName)).toEqual(['manual_v1.txt', 'contract.pdf'])

    // Null timestamps and unhashed state remain explicitly null (never fabricated)
    const mdItem = page1.items[1]!
    expect(mdItem.filesystemBirthtimeMs).toBeNull()
    expect(mdItem.filesystemMtimeMs).toBeNull()
    expect(mdItem.activeHash).toBeNull()
    expect(mdItem.activeHashVerifiedAtMs).toBeNull()

    // Hashed item includes active SHA-256 and verification timestamp
    const pdfItem = page1.items[0]!
    expect(pdfItem.activeHash).toBe('a'.repeat(64))
    expect(pdfItem.activeHashVerifiedAtMs).toBe(1_700_000_001_000)
  })

  it('filters by extension and escaped filename substring', () => {
    seedMixedCatalog()

    const pdfs = catalog.getDocumentsPage({
      offset: 0,
      limit: 50,
      extensionFilter: '.pdf'
    })
    expect(pdfs.totalCount).toBe(2)
    expect(pdfs.items.map((i) => i.fileName)).toEqual(['receipt_2025.pdf', 'contract.pdf'])

    // Literal '%' in filenameQuery must not act as a wildcard matching everything
    const percentMatch = catalog.getDocumentsPage({
      offset: 0,
      limit: 50,
      filenameQuery: '100%'
    })
    expect(percentMatch.totalCount).toBe(1)
    expect(percentMatch.items[0]!.fileName).toBe('notes_100%.md')

    // Case-insensitive extension filter matches .MD
    const mdFilter = catalog.getDocumentsPage({
      offset: 0,
      limit: 50,
      extensionFilter: '.md'
    })
    expect(mdFilter.totalCount).toBe(1)
    expect(mdFilter.items[0]!.fileName).toBe('notes_100%.md')
  })

  it('returns full recorded detail provenance and excludes non-document items', () => {
    const { sourceRoot } = seedMixedCatalog()
    const page = catalog.getDocumentsPage({ offset: 0, limit: 50 })
    const target = page.items.find((i) => i.fileName === 'receipt_2025.pdf')!

    const detail = catalog.getDocumentDetail(target.fileLocationId)
    expect(detail).not.toBeNull()
    expect(detail!.sourceRootPath).toBe(sourceRoot)
    expect(detail!.originalPath).toBe(join(sourceRoot, 'receipt_2025.pdf'))
    expect(detail!.activeHash).toBe('a'.repeat(64))
    expect(detail!.extractionStatus).toBe('not_extracted')
    expect(detail!.previewStatus).toBe('not_extracted')

    // Photo record ID must return null from getDocumentDetail
    const photoPage = catalog.queryFileLocations({ category: 'photo', offset: 0, limit: 10 })
    expect(photoPage.items).toHaveLength(1)
    expect(catalog.getDocumentDetail(photoPage.items[0]!.id)).toBeNull()
  })

  it('paginates extension facets without silently truncating available extensions', () => {
    seedMixedCatalog()

    const facetsPage1 = catalog.getDocumentExtensionFacets({ offset: 0, limit: 2 })
    expect(facetsPage1.totalCount).toBe(3)
    expect(facetsPage1.items).toEqual([
      { extension: '.pdf', count: 2 },
      { extension: '.md', count: 1 }
    ])

    const facetsPage2 = catalog.getDocumentExtensionFacets({ offset: 2, limit: 2 })
    expect(facetsPage2.totalCount).toBe(3)
    expect(facetsPage2.items).toEqual([{ extension: '.txt', count: 1 }])
  })

  it('throws DatabaseClosedError when catalog is closed', () => {
    catalog.close()
    expect(() => catalog.getDocumentsPage({ offset: 0, limit: 20 })).toThrow(DatabaseClosedError)
    expect(() => catalog.getDocumentDetail(1)).toThrow(DatabaseClosedError)
    expect(() => catalog.getDocumentExtensionFacets({ offset: 0, limit: 20 })).toThrow(
      DatabaseClosedError
    )
  })

  it('snapshots large catalogs (> 500 documents) via bounded async batches in createDocumentExtractionJob without full-catalog array materialization or event-loop blocking', async () => {
    const sourceRoot = join(tempDir, 'large-docs')
    catalog.registerSource(sourceRoot)
    const now = Date.now()
    const totalDocs = 1200
    const batch: Array<{
      originalPath: string
      fileName: string
      extension: string
      category: 'document'
      byteSize: number
      birthtimeMs: number | null
      mtimeMs: number | null
      discoveredAtMs: number
    }> = []
    for (let i = 1; i <= totalDocs; i++) {
      const ext = i % 3 === 0 ? '.md' : '.txt'
      batch.push({
        originalPath: join(sourceRoot, `doc_${String(i).padStart(4, '0')}${ext}`),
        fileName: `doc_${String(i).padStart(4, '0')}${ext}`,
        extension: ext,
        category: 'document',
        byteSize: 100 + i,
        birthtimeMs: now - 1000,
        mtimeMs: now - 500,
        discoveredAtMs: now
      })
      if (batch.length === 500) {
        catalog.persistDiscoveryBatch(sourceRoot, batch.splice(0, batch.length))
      }
    }
    if (batch.length > 0) {
      catalog.persistDiscoveryBatch(sourceRoot, batch)
    }

    const repo = catalog.getDocumentRepository()
    const allJob = await repo.createDocumentExtractionJob({
      jobId: 'large-all-job',
      scopeKind: 'all',
      recipeVersion: 'doc_extract_v1'
    })
    expect(allJob.totalDocuments).toBe(totalDocs)
    expect(allJob.pendingDocuments).toBe(totalDocs)

    const filteredJob = await repo.createDocumentExtractionJob({
      jobId: 'large-md-job',
      scopeKind: 'filtered',
      extensionFilter: '.md',
      recipeVersion: 'doc_extract_v1'
    })
    expect(filteredJob.totalDocuments).toBe(400)
  })

  it('keeps the event loop responsive during large snapshot creation, preserves upper scope bound, and cleans up on cancellation', async () => {
    const sourceRoot = join(tempDir, 'responsive-docs')
    catalog.registerSource(sourceRoot)
    const now = Date.now()
    const totalDocs = 15000
    for (let start = 1; start <= totalDocs; start += 500) {
      const batch = []
      const end = Math.min(totalDocs, start + 499)
      for (let i = start; i <= end; i++) {
        batch.push({
          originalPath: join(sourceRoot, `item_${i}.txt`),
          fileName: `item_${i}.txt`,
          extension: '.txt',
          category: 'document' as const,
          byteSize: 100 + i,
          birthtimeMs: now - 1000,
          mtimeMs: now - 500,
          discoveredAtMs: now
        })
      }
      catalog.persistDiscoveryBatch(sourceRoot, batch)
    }

    const repo = catalog.getDocumentRepository()

    // Measure event-loop ticks during async snapshotting
    let timerTicks = 0
    let maxGapMs = 0
    let lastTick = performance.now()
    const timer = setInterval(() => {
      const nowPerf = performance.now()
      maxGapMs = Math.max(maxGapMs, nowPerf - lastTick)
      lastTick = nowPerf
      timerTicks++
    }, 5)

    const job = await repo.createDocumentExtractionJob({
      jobId: 'responsive-15k-job',
      scopeKind: 'all',
      recipeVersion: 'doc_extract_v1',
      batchSize: 250,
      onBatchInserted: (batchIdx) => {
        if (batchIdx === 1) {
          // Insert an extra document while snapshotting is yielding — must NOT leak into responsive-15k-job
          catalog.persistDiscoveryBatch(sourceRoot, [
            {
              originalPath: join(sourceRoot, 'late_added.txt'),
              fileName: 'late_added.txt',
              extension: '.txt',
              category: 'document',
              byteSize: 42,
              birthtimeMs: now,
              mtimeMs: now,
              discoveredAtMs: now
            }
          ])
        }
      }
    })
    clearInterval(timer)

    expect(job.totalDocuments).toBe(totalDocs)
    expect(job.pendingDocuments).toBe(totalDocs)
    expect(timerTicks).toBeGreaterThanOrEqual(2)
    expect(maxGapMs).toBeLessThan(200)
    expect(readdirSync(tempDir).filter((f) => f.includes('.snapshot-'))).toEqual([])

    // Verify cancellation mid-snapshot cleans up partial items, staging file, and marks job cancelled
    let batchesSeen = 0
    const cancelledJob = await repo.createDocumentExtractionJob({
      jobId: 'cancelled-mid-snapshot',
      scopeKind: 'all',
      recipeVersion: 'doc_extract_v1',
      batchSize: 250,
      shouldCancel: () => {
        batchesSeen++
        return batchesSeen >= 3
      }
    })
    expect(cancelledJob.status).toBe('cancelled')
    expect(cancelledJob.totalDocuments).toBe(0)
    expect(cancelledJob.pendingDocuments).toBe(0)
    expect(readdirSync(tempDir).filter((f) => f.includes('.snapshot-'))).toEqual([])

    // Verify failure mid-snapshot rolls back the incomplete job and cleans up the staging file
    await expect(
      repo.createDocumentExtractionJob({
        jobId: 'failed-mid-snapshot',
        scopeKind: 'all',
        recipeVersion: 'doc_extract_v1',
        batchSize: 250,
        onBatchInserted: (batchIdx) => {
          if (batchIdx === 1) {
            throw new Error('Simulated snapshot failure')
          }
        }
      })
    ).rejects.toThrow('Simulated snapshot failure')
    expect(repo.getDocumentExtractionJob('failed-mid-snapshot')).toBeNull()
    expect(readdirSync(tempDir).filter((f) => f.includes('.snapshot-'))).toEqual([])
  })

  it('freezes existing-document revisions and filter membership against concurrent updates between batchSize=1 batches', async () => {
    const sourceRoot = join(tempDir, 'frozen-scope')
    catalog.registerSource(sourceRoot)
    const now = Date.now()
    catalog.persistDiscoveryBatch(sourceRoot, [
      {
        originalPath: join(sourceRoot, 'doc1.txt'),
        fileName: 'doc1.txt',
        extension: '.txt',
        category: 'document',
        byteSize: 100,
        birthtimeMs: now - 1000,
        mtimeMs: now - 500,
        discoveredAtMs: now
      },
      {
        originalPath: join(sourceRoot, 'doc2.txt'),
        fileName: 'doc2.txt',
        extension: '.txt',
        category: 'document',
        byteSize: 200,
        birthtimeMs: now - 1000,
        mtimeMs: now - 500,
        discoveredAtMs: now
      },
      {
        originalPath: join(sourceRoot, 'doc3.txt'),
        fileName: 'doc3.txt',
        extension: '.txt',
        category: 'document',
        byteSize: 300,
        birthtimeMs: now - 1000,
        mtimeMs: now - 500,
        discoveredAtMs: now
      }
    ])

    const initialPage = catalog.getDocumentsPage({ offset: 0, limit: 10 })
    const doc2Initial = initialPage.items.find((d) => d.fileName === 'doc2.txt')!
    const doc3Initial = initialPage.items.find((d) => d.fileName === 'doc3.txt')!
    const doc2FrozenRev = buildDocumentContentRevision({
      discoveryObservationId: doc2Initial.discoveryObservationId,
      byteSize: doc2Initial.byteSize,
      filesystemMtimeMs: doc2Initial.filesystemMtimeMs,
      activeHash: doc2Initial.activeHash
    })

    const repo = catalog.getDocumentRepository()
    const job = await repo.createDocumentExtractionJob({
      jobId: 'frozen-snapshot-job',
      scopeKind: 'filtered',
      extensionFilter: '.txt',
      recipeVersion: 'doc_extract_v1',
      batchSize: 1,
      onBatchInserted: (batchIndex) => {
        if (batchIndex === 1) {
          // Mutate doc2's discovery observation and doc3's extension between batches
          catalog.persistDiscoveryBatch(sourceRoot, [
            {
              originalPath: join(sourceRoot, 'doc2.txt'),
              fileName: 'doc2.txt',
              extension: '.txt',
              category: 'document',
              byteSize: 9999,
              birthtimeMs: now - 1000,
              mtimeMs: now + 5000,
              discoveredAtMs: now + 5000
            }
          ])
          const rawDb = catalog.getRawDatabaseForTesting()
          rawDb
            .prepare("UPDATE file_locations SET extension = '.md' WHERE id = ?;")
            .run(doc3Initial.fileLocationId)
        }
      }
    })

    expect(job.snapshotComplete).toBe(true)
    expect(job.totalDocuments).toBe(3)
    expect(job.pendingDocuments).toBe(3)

    const items = repo.getNextPendingDocumentExtractionJobItems('frozen-snapshot-job', 10)
    expect(items.map((i) => i.fileLocationId)).toContain(doc3Initial.fileLocationId)
    const doc2Item = items.find((i) => i.fileLocationId === doc2Initial.fileLocationId)!
    expect(doc2Item.discoveryObservationId).toBe(doc2Initial.discoveryObservationId)
    expect(doc2Item.contentRevision).toBe(doc2FrozenRev)
  })

  it('discards incomplete scope construction on restart after actual process termination mid-snapshot', async () => {
    const sourceRoot = join(tempDir, 'crash-scope')
    catalog.registerSource(sourceRoot)
    const now = Date.now()
    catalog.persistDiscoveryBatch(sourceRoot, [
      {
        originalPath: join(sourceRoot, 'a.txt'),
        fileName: 'a.txt',
        extension: '.txt',
        category: 'document',
        byteSize: 10,
        birthtimeMs: now,
        mtimeMs: now,
        discoveredAtMs: now
      },
      {
        originalPath: join(sourceRoot, 'b.txt'),
        fileName: 'b.txt',
        extension: '.txt',
        category: 'document',
        byteSize: 20,
        birthtimeMs: now,
        mtimeMs: now,
        discoveredAtMs: now
      },
      {
        originalPath: join(sourceRoot, 'c.txt'),
        fileName: 'c.txt',
        extension: '.txt',
        category: 'document',
        byteSize: 30,
        birthtimeMs: now,
        mtimeMs: now,
        discoveredAtMs: now
      }
    ])
    catalog.close()

    // Bundle a small child script that opens the catalog, begins a batchSize=1 job,
    // and terminates immediately after batch 1 commits.
    const childEntryTs = join(tempDir, 'child-crash-snapshot.ts')
    const childBundleCjs = join(tempDir, 'child-crash-snapshot.cjs')
    writeFileSync(
      childEntryTs,
      `import { CatalogDatabase } from ${JSON.stringify(resolve(__dirname, '../../src/main/services/catalog/database.ts'))};
       async function main() {
         const catalog = CatalogDatabase.open({ catalogPath: ${JSON.stringify(dbPath)} });
         const repo = catalog.getDocumentRepository();
         await repo.createDocumentExtractionJob({
           jobId: 'crashed-scope-job',
           scopeKind: 'all',
           recipeVersion: 'doc_extract_v1',
           batchSize: 1,
           onBatchInserted: (batchIndex) => {
             if (batchIndex === 1) {
               process.exit(42);
             }
           }
         });
       }
       main().catch((err) => { console.error(err); process.exit(1); });
      `,
      'utf8'
    )

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const esbuild = require('esbuild') as typeof import('esbuild')
    esbuild.buildSync({
      entryPoints: [resolve(__dirname, '../../src/main/services/documents/snapshot-worker.ts')],
      outfile: join(tempDir, 'document_snapshot_worker.js'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      external: ['electron', 'node:sqlite']
    })
    esbuild.buildSync({
      entryPoints: [childEntryTs],
      outfile: childBundleCjs,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      external: ['electron', 'node:sqlite', 'esbuild']
    })

    const childEnv: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production' }
    delete childEnv.VITEST

    let childExitCode: number | null = null
    try {
      execFileSync(process.execPath, [childBundleCjs], {
        stdio: 'pipe',
        timeout: 10000,
        env: childEnv
      })
    } catch (err) {
      childExitCode = (err as { status?: number }).status ?? null
    }
    expect(childExitCode).toBe(42)

    // Reopen catalog and verify partial job (snapshot_complete = 0) exists before initialize()
    catalog = CatalogDatabase.open({ catalogPath: dbPath })
    const rawDb = catalog.getRawDatabaseForTesting()
    const rawBefore = rawDb
      .prepare(
        "SELECT id, status, snapshot_complete, total_documents FROM document_extraction_jobs WHERE id = 'crashed-scope-job';"
      )
      .get() as
      { id: string; status: string; snapshot_complete: number; total_documents: number } | undefined
    expect(rawBefore).toBeDefined()
    expect(rawBefore?.snapshot_complete).toBe(0)
    const itemsBefore = rawDb
      .prepare(
        "SELECT COUNT(*) AS cnt FROM document_extraction_job_items WHERE job_id = 'crashed-scope-job';"
      )
      .get() as { cnt: number }
    expect(itemsBefore.cnt).toBe(1)

    // Coordinator.initialize() must discard the incomplete scope rather than marking it interrupted/resumable
    const coord = new DocumentExtractionCoordinator({ catalog })
    const initProgress = coord.initialize()
    expect(initProgress.status).toBe('idle')
    expect(initProgress.totalDocuments).toBe(0)

    const rawAfter = rawDb
      .prepare("SELECT id FROM document_extraction_jobs WHERE id = 'crashed-scope-job';")
      .get()
    expect(rawAfter).toBeUndefined()
    const itemsAfter = rawDb
      .prepare(
        "SELECT COUNT(*) AS cnt FROM document_extraction_job_items WHERE job_id = 'crashed-scope-job';"
      )
      .get() as { cnt: number }
    expect(itemsAfter.cnt).toBe(0)
    expect(existsSync(`${dbPath}.snapshot-crashed-scope-job.tmp`)).toBe(false)
    expect(readdirSync(tempDir).filter((f) => f.includes('.snapshot-'))).toEqual([])
  })
})
