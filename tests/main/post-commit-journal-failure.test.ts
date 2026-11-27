/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { CatalogDatabase } from '../../src/main/services/catalog/database'
import { AnnotationJournal } from '../../src/main/services/annotations/journal'

describe('Post-COMMIT Journal Failure Handling (Finding 1)', () => {
  let tempDir: string
  let catalogPath: string
  let annotationsDir: string
  let catalog: CatalogDatabase
  let journal: AnnotationJournal

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'pv-post-commit-test-'))
    catalogPath = join(tempDir, 'catalog.db')
    annotationsDir = join(tempDir, 'annotations')

    journal = new AnnotationJournal({ storageDir: annotationsDir })
    await journal.initialize()

    catalog = CatalogDatabase.open({ catalogPath, journal })

    // Register a source and add a test photo
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

  it('never appends op_aborted when appendCommitRecordSync fails post-COMMIT', () => {
    const photoId = 1
    const rev = catalog.getPhotoRevisionString(photoId)

    // Simulate journal failure ONLY during appendCommitRecordSync (after SQLite COMMIT)
    let commitCalled = false
    const origAppendCommit = journal.appendCommitRecordSync.bind(journal)
    journal.appendCommitRecordSync = () => {
      commitCalled = true
      throw new Error('Simulated ENOSPC on appendCommitRecordSync')
    }

    // Mutation should return with persistencePending: true without appending op_aborted
    const result = catalog.setPhotoAnnotation({
      fileLocationId: photoId,
      expectedRevision: rev,
      expectedVersion: 0,
      rating: 5,
      flag: 'pick'
    })

    expect(commitCalled).toBe(true)

    // Database MUST be committed (not rolled back)
    const currentAnn = catalog.getPhotoAnnotation(photoId)
    expect(currentAnn).not.toBeNull()
    expect(currentAnn?.rating).toBe(5)
    expect(currentAnn?.flag).toBe('pick')
    expect(currentAnn?.version).toBe(1)

    // Either returned with persistencePending: true, or if thrown, signaled committed
    if (result) {
      expect(result.persistencePending).toBe(true)
    }

    // Inspect journal file: MUST NOT contain op_aborted!
    const journalPath = join(annotationsDir, 'review-journal.jsonl')
    const journalContent = readFileSync(journalPath, 'utf8')
    expect(journalContent).not.toContain('op_aborted')
    expect(journalContent).toContain('photo_annotation')

    // Restore appendCommitRecordSync
    journal.appendCommitRecordSync = origAppendCommit

    // Reconcile startup / runtime reconciliation: must append op_committed for the committed work!
    catalog.reconcileJournalWithDatabase()

    const reconciledContent = readFileSync(journalPath, 'utf8')
    expect(reconciledContent).toContain('op_committed')
    expect(reconciledContent).not.toContain('op_aborted')
  })

  it('handles post-COMMIT failure consistently across collection mutations without contradictory abort records', () => {
    let commitCallCount = 0
    journal.appendCommitRecordSync = () => {
      commitCallCount++
      throw new Error('Simulated disk full during appendCommitRecordSync')
    }

    // 1. Create collection post-commit failure
    const colResult = catalog.createCollection({ name: 'Landscape Favorites' })
    expect(colResult.name).toBe('Landscape Favorites')
    expect(colResult.persistencePending).toBe(true)

    // Verify committed in SQLite
    const colInDb = catalog.getCollectionById(colResult.id)
    expect(colInDb).not.toBeNull()
    expect(colInDb?.name).toBe('Landscape Favorites')

    // 2. Rename collection post-commit failure
    const renameResult = catalog.renameCollection({
      collectionId: colResult.id,
      name: 'Epic Landscapes'
    })
    expect(renameResult.name).toBe('Epic Landscapes')
    expect(renameResult.persistencePending).toBe(true)

    // 3. Add collection member post-commit failure
    const rev = catalog.getPhotoRevisionString(1)
    const addResult = catalog.addCollectionMember({
      collectionId: colResult.id,
      fileLocationId: 1,
      expectedRevision: rev
    })
    expect(addResult.success).toBe(true)
    expect(addResult.persistencePending).toBe(true)

    // 4. Remove collection member post-commit failure
    const rmResult = catalog.removeCollectionMember({
      collectionId: colResult.id,
      fileLocationId: 1,
      expectedRevision: rev
    })
    expect(rmResult.success).toBe(true)
    expect(rmResult.persistencePending).toBe(true)

    expect(commitCallCount).toBe(4)

    // None of these committed mutations should have written op_aborted
    const journalPath = join(annotationsDir, 'review-journal.jsonl')
    const journalContent = readFileSync(journalPath, 'utf8')
    expect(journalContent).not.toContain('op_aborted')
  })
})
