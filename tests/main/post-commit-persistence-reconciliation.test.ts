/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { CatalogDatabase } from '../../src/main/services/catalog/database'
import { AnnotationJournal } from '../../src/main/services/annotations/journal'

describe('Bounded Reconciliation & Safe Reconcile Method (Findings 1 & 2)', () => {
  let tempDir: string
  let catalogPath: string
  let annotationsDir: string
  let catalog: CatalogDatabase
  let journal: AnnotationJournal

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'pv-bounded-rec-test-'))
    catalogPath = join(tempDir, 'catalog.db')
    annotationsDir = join(tempDir, 'annotations')

    journal = new AnnotationJournal({ storageDir: annotationsDir })
    await journal.initialize()

    catalog = CatalogDatabase.open({ catalogPath, journal })
    catalog.registerSource(join(tempDir, 'source'))
    catalog.persistDiscoveryBatch(join(tempDir, 'source'), [
      {
        originalPath: join(tempDir, 'source', 'photo1.jpg'),
        fileName: 'photo1.jpg',
        extension: '.jpg',
        byteSize: 1024,
        birthtimeMs: 1000,
        mtimeMs: 2000,
        discoveredAtMs: 1000,
        category: 'photo'
      }
    ])
  })

  afterEach(() => {
    try {
      catalog?.close()
    } catch {
      // ignore
    }
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('reconciles 150 pending operations using bounded iteration without accumulating array in memory', () => {
    // Prevent appendCommitRecordSync from writing
    const origAppendCommit = journal.appendCommitRecordSync.bind(journal)
    journal.appendCommitRecordSync = () => {
      throw new Error('Simulated persistence barrier failure')
    }

    // Generate 150 distinct committed collection operations
    for (let i = 1; i <= 150; i++) {
      const res = catalog.createCollection({ name: `Collection ${i}` })
      expect(res.persistencePending).toBe(true)
    }

    // Restore appendCommitRecordSync
    journal.appendCommitRecordSync = origAppendCommit

    // Reconcile: must process all 150 unterminated committed records
    const reconcileResult = catalog.reconcileJournalWithDatabase()
    expect(reconcileResult.reconciledCount).toBe(150)

    // Inspect journal file: must contain op_committed for all 150 without duplicate collections
    const journalPath = join(annotationsDir, 'review-journal.jsonl')
    const content = readFileSync(journalPath, 'utf8')
    const commitCount = (content.match(/"kind":"op_committed"/g) || []).length
    expect(commitCount).toBe(150)

    // Re-running reconciliation is idempotent and yields 0 remaining
    const secondReconcile = catalog.reconcileJournalWithDatabase()
    expect(secondReconcile.reconciledCount).toBe(0)
  })

  it('provides safe reconciliation without repeating an already committed SQLite mutation', () => {
    const rev = catalog.getPhotoRevisionString(1)

    // Simulate post-commit failure
    let commitFailed = true
    const origAppendCommit = journal.appendCommitRecordSync.bind(journal)
    journal.appendCommitRecordSync = (params) => {
      if (commitFailed) {
        throw new Error('Post-commit disk stall')
      }
      return origAppendCommit(params)
    }

    const ann = catalog.setPhotoAnnotation({
      fileLocationId: 1,
      expectedRevision: rev,
      expectedVersion: 0,
      rating: 4,
      flag: 'pick'
    })
    expect(ann.persistencePending).toBe(true)
    expect(ann.rating).toBe(4)

    // At this point, SQLite has version 1. Calling setPhotoAnnotation again with expectedVersion: 0 would FAIL with conflict!
    // Instead, safe reconciliation finalizes the journal without re-invoking the mutation:
    commitFailed = false
    const rec = catalog.reconcileJournalWithDatabase()
    expect(rec.reconciledCount).toBe(1)

    // Check annotation in DB: remains version 1, rating 4
    const dbAnn = catalog.getPhotoAnnotation(1)
    expect(dbAnn?.version).toBe(1)
    expect(dbAnn?.rating).toBe(4)
    expect(dbAnn?.flag).toBe('pick')
  })
})
