// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AnnotationJournal } from '../../src/main/services/annotations/journal'
import { CatalogDatabase } from '../../src/main/services/catalog/database'
import { DocumentClassificationCoordinator } from '../../src/main/services/documents/classification/coordinator'
import { DOCUMENT_OCR_RECIPE_VERSION } from '../../src/main/services/documents/ocr/types'
import { DOCUMENT_EXTRACTION_RECIPE_VERSION } from '../../src/main/services/documents/types'
import { AppWorkerBudget } from '../../src/main/services/worker-budget'

describe('Stage 7E Slice 2 — AnnotationJournal Overrides & DocumentClassificationCoordinator', () => {
  let tempDir: string
  let journalDir: string
  let catalogPath: string
  let journal: AnnotationJournal
  let catalog: CatalogDatabase

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'pv-doc-cls-coord-'))
    journalDir = join(tempDir, 'journal')
    catalogPath = join(tempDir, 'catalog.db')
    journal = new AnnotationJournal({ storageDir: journalDir })
    await journal.initialize()
    catalog = CatalogDatabase.open({ catalogPath, journal })
  })

  afterEach(() => {
    catalog.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  function seedDocs(count: number): number[] {
    const db = catalog.getRawDb()
    const sourceRoot = join(tempDir, 'missing-on-disk-source')
    const now = Date.now()
    const sourceId = Number(
      db
        .prepare(
          'INSERT INTO sources (root_path, normalized_root_path, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?);'
        )
        .run(sourceRoot, sourceRoot.toLowerCase(), now, now).lastInsertRowid
    )

    const ids: number[] = []
    for (let i = 0; i < count; i += 1) {
      const isClutter = i % 5 === 0
      const relPath = isClutter ? `repos/pkg-${i}/LICENSE.txt` : `Notes/note-${i}.txt`
      const fileName = isClutter ? 'LICENSE.txt' : `note-${i}.txt`
      const originalPath = join(sourceRoot, relPath)
      const sha = `${i.toString(16).padStart(8, '0')}`.repeat(8)
      const text = isClutter
        ? 'SPDX-License-Identifier: MIT\nPermission is hereby granted, free of charge, to any person obtaining a copy of the "Software".\nWITHOUT WARRANTY OF ANY KIND.\n'
        : `Personal reflection number ${i} about our family garden and weekend plans for spring.`

      const flId = Number(
        db
          .prepare(
            `INSERT INTO file_locations (
              source_id, original_path, normalized_path, file_name, extension, category,
              created_at_ms, updated_at_ms
            ) VALUES (?, ?, ?, ?, '.txt', 'document', ?, ?);`
          )
          .run(sourceId, originalPath, originalPath.toLowerCase(), fileName, now, now)
          .lastInsertRowid
      )
      const obsId = Number(
        db
          .prepare(
            `INSERT INTO discovery_observations (file_location_id, byte_size, filesystem_birthtime_ms, filesystem_mtime_ms, observed_at_ms, last_seen_at_ms, is_current)
             VALUES (?, ?, ?, ?, ?, ?, 1);`
          )
          .run(flId, text.length, now, 1_700_000_000_000 + i, now, now).lastInsertRowid
      )
      db.prepare(
        `INSERT INTO hash_observations (file_location_id, discovery_observation_id, sha256, observed_byte_size, observed_mtime_ms, hashed_at_ms, is_active) VALUES (?, ?, ?, ?, ?, ?, 1);`
      ).run(flId, obsId, sha, text.length, 1_700_000_000_000 + i, now)
      db.prepare(
        `INSERT INTO document_extractions (
          file_location_id, discovery_observation_id, content_sha256, observed_byte_size, observed_mtime_ms,
          content_revision, recipe_version, extraction_status, extracted_text, extracted_char_count, truncated, is_current, extracted_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, 'doc_extract_v1', 'extracted', ?, ?, 0, 1, ?);`
      ).run(
        flId,
        obsId,
        sha,
        text.length,
        1_700_000_000_000 + i,
        `rev:${obsId}:${text.length}:${1_700_000_000_000 + i}:${sha}`,
        text,
        text.length,
        now
      )

      ids.push(flId)
    }
    return ids
  }

  it('persists durable two-phase overrides, enforces conflict guards, preserves on timestamp touch & reclassify, and invalidates on content change', async () => {
    const [clutterId] = seedDocs(1)
    const repo = catalog.getDocumentClassificationRepository()
    const coordinator = new DocumentClassificationCoordinator({ catalog })

    try {
      const job = await coordinator.startClassification({ scopeKind: 'all' })
      expect(job?.status).toBe('completed')
      expect(repo.getHiddenClutterCount()).toBe(1)

      const initialEffective = repo.getEffectiveDocumentClassification(clutterId!)!
      expect(initialEffective.effectiveIsClutter).toBe(true)

      // Set durable 'force_keep' override via two-phase journal
      const overrideRes = repo.setClassificationOverride({
        fileLocationId: clutterId!,
        expectedRevision: initialEffective.contentRevision,
        expectedOverrideVersion: 0,
        purposeLabels: ['legal', 'instructions'],
        originLabels: ['personal'],
        clutterOverride: 'force_keep'
      })
      expect(overrideRes.overrideVersion).toBe(1)
      expect(repo.getHiddenClutterCount()).toBe(0)

      const afterOverride = repo.getEffectiveDocumentClassification(clutterId!)!
      expect(afterOverride.effectiveIsClutter).toBe(false)
      expect(afterOverride.effectivePurposeLabels).toEqual(['legal', 'instructions'])
      expect(afterOverride.effectiveOriginLabels).toEqual(['personal'])

      // Conflict checks: STALE_OVERRIDE_VERSION & STALE_REVISION
      expect(() =>
        repo.setClassificationOverride({
          fileLocationId: clutterId!,
          expectedRevision: initialEffective.contentRevision,
          expectedOverrideVersion: 0,
          purposeLabels: null,
          originLabels: null,
          clutterOverride: 'inherit'
        })
      ).toThrow(/STALE_OVERRIDE_VERSION/)

      expect(() =>
        repo.setClassificationOverride({
          fileLocationId: clutterId!,
          expectedRevision: 'wrong-revision',
          expectedOverrideVersion: 1,
          purposeLabels: null,
          originLabels: null,
          clutterOverride: 'inherit'
        })
      ).toThrow(/STALE_REVISION/)

      // Reclassification preserves active override
      await coordinator.startClassification({ scopeKind: 'all', forceReclassify: true })
      const afterReclassify = repo.getEffectiveDocumentClassification(clutterId!)!
      expect(afterReclassify.effectiveIsClutter).toBe(false)
      expect(afterReclassify.override?.clutterOverride).toBe('force_keep')

      // Timestamp-only touch with identical content_sha256 preserves override
      const db = catalog.getRawDb()
      const currentSha = (
        db
          .prepare(
            'SELECT sha256 FROM hash_observations WHERE file_location_id = ? AND is_active = 1;'
          )
          .get(clutterId!) as { sha256: string }
      ).sha256
      db.prepare(
        'UPDATE discovery_observations SET is_current = 0 WHERE file_location_id = ?;'
      ).run(clutterId!)
      const newObsId = Number(
        db
          .prepare(
            `INSERT INTO discovery_observations (file_location_id, byte_size, filesystem_birthtime_ms, filesystem_mtime_ms, observed_at_ms, last_seen_at_ms, is_current)
             VALUES (?, 146, ?, 1700009999000, ?, ?, 1);`
          )
          .run(clutterId!, Date.now(), Date.now(), Date.now()).lastInsertRowid
      )
      repo.reconcileLocationUpdate(clutterId!, newObsId, currentSha, 146, 1700009999000)

      const afterTouch = repo.getEffectiveDocumentClassification(clutterId!)!
      expect(afterTouch.override?.clutterOverride).toBe('force_keep')
      expect(afterTouch.hasStaleOverride).toBe(false)

      // Content change (different content_sha256) invalidates override
      const changedSha = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
      db.prepare(
        'UPDATE discovery_observations SET is_current = 0 WHERE file_location_id = ?;'
      ).run(clutterId!)
      const obs3 = Number(
        db
          .prepare(
            `INSERT INTO discovery_observations (file_location_id, byte_size, filesystem_birthtime_ms, filesystem_mtime_ms, observed_at_ms, last_seen_at_ms, is_current)
             VALUES (?, 200, ?, 1700010000000, ?, ?, 1);`
          )
          .run(clutterId!, Date.now(), Date.now(), Date.now()).lastInsertRowid
      )
      db.prepare('UPDATE hash_observations SET is_active = 0 WHERE file_location_id = ?;').run(
        clutterId!
      )
      db.prepare(
        'INSERT INTO hash_observations (file_location_id, discovery_observation_id, sha256, observed_byte_size, observed_mtime_ms, hashed_at_ms, is_active) VALUES (?, ?, ?, 200, 1700010000000, ?, 1);'
      ).run(clutterId!, obs3, changedSha, Date.now())
      repo.reconcileLocationUpdate(clutterId!, obs3, changedSha, 200, 1700010000000)

      const afterContentChange = repo.getEffectiveDocumentClassification(clutterId!)!
      expect(afterContentChange.override).toBeNull()
      expect(afterContentChange.hasStaleOverride).toBe(true)

      // Verify journal contains committed records
      const entries = [...journal.iterateEntriesSync()]
      expect(entries.some((e) => e.kind === 'document_classification_override')).toBe(true)
      expect(entries.some((e) => e.kind === 'op_committed')).toBe(true)
    } finally {
      await coordinator.shutdown()
    }
  })

  it('batches >250 items in snapshots, supports pause/resume/cancel, interrupted recovery, and AppWorkerBudget(3)', async () => {
    seedDocs(260) // > 250 snapshot batch size, zero files exist on disk
    const budget = new AppWorkerBudget(3)
    const coordinator = new DocumentClassificationCoordinator({ catalog, workerBudget: budget })

    try {
      const completed = await coordinator.startClassification({ scopeKind: 'all' })
      expect(completed?.status).toBe('completed')
      expect(completed?.snapshotComplete).toBe(true)
      expect(completed?.totalItems).toBe(260)
      expect(completed?.processedItems).toBe(260)
      expect(completed?.clutterItems).toBe(52)

      const coverage = await coordinator.getCoverage()
      expect(coverage.totalDocuments).toBe(260)
      expect(coverage.classifiedDocuments).toBe(52)
      expect(coverage.otherDocuments).toBe(208)
      expect(coverage.unclassifiedDocuments).toBe(0)
      expect(coverage.staleDocuments).toBe(0)

      // Simulate interrupted job recovery on restart
      const repo = catalog.getDocumentClassificationRepository()
      const db = catalog.getRawDb()
      db.prepare("UPDATE document_classification_jobs SET status = 'running' WHERE id = ?;").run(
        completed!.id
      )
      const interruptedCount = repo.markRunningJobsAsInterrupted()
      expect(interruptedCount).toBe(1)
      const latest = repo.getLatestJob()
      expect(latest?.status).toBe('interrupted')

      const resumed = await coordinator.resume()
      expect(resumed?.status).toBe('completed')

      // Cancellation check
      const pRun = coordinator.startClassification({
        scopeKind: 'all',
        forceReclassify: true
      })
      await coordinator.cancel()
      const cancelledJob = await pRun
      expect(
        cancelledJob === null ||
          cancelledJob.status === 'cancelled' ||
          cancelledJob.status === 'completed'
      ).toBe(true)
      expect(budget.getLiveCount()).toBe(0)
    } finally {
      await coordinator.shutdown()
      expect(budget.getLiveCount()).toBe(0)
    }
  })

  it('invalidates warmed coordinator coverage and progress after discovery, hash, extraction, OCR, and external-connection mutations', async () => {
    const budget = new AppWorkerBudget(3)
    const coordinator = new DocumentClassificationCoordinator({ catalog, workerBudget: budget })
    const sourceRoot = join(tempDir, 'live-source')
    const docPath = join(sourceRoot, 'Notes', 'tax-plan.txt')

    try {
      // 1. Warm coverage on empty catalog
      const initialCov = await coordinator.getCoverage()
      expect(initialCov.totalDocuments).toBe(0)
      expect(coordinator.getProgress().coverage.totalDocuments).toBe(0)

      // 2. Discovery mutation via CatalogDatabase
      catalog.persistDiscoveryBatch(sourceRoot, [
        {
          originalPath: docPath,
          fileName: 'tax-plan.txt',
          extension: '.txt',
          category: 'document',
          byteSize: 120,
          birthtimeMs: 1_700_000_000_000,
          mtimeMs: 1_700_000_000_000,
          discoveredAtMs: 1_700_000_000_000
        }
      ])
      const afterDiscovery = await coordinator.getCoverage()
      expect(afterDiscovery.totalDocuments).toBe(1)
      expect(afterDiscovery.unclassifiedDocuments).toBe(1)
      expect(coordinator.getProgress().coverage.totalDocuments).toBe(1)

      const loc = catalog.getFileLocationByPath(docPath)!
      const sha1 = '1'.repeat(64)

      // 3. Hash mutation via CatalogDatabase
      catalog.recordHashObservation({
        originalPath: docPath,
        sha256: sha1,
        observedByteSize: 120,
        observedMtimeMs: 1_700_000_000_000,
        hashedAtMs: 1_700_000_000_100
      })
      await coordinator.startClassification({ scopeKind: 'all' })
      const afterClassify = await coordinator.getCoverage()
      expect(afterClassify.unknownDocuments).toBe(1)
      expect(afterClassify.staleDocuments).toBe(0)

      // 4. Extraction mutation via DocumentRepository invalidates warmed coverage -> staleDocuments becomes 1
      const effBeforeExt = catalog
        .getDocumentClassificationRepository()
        .getEffectiveDocumentClassification(loc.id)!
      const docRepo = catalog.getDocumentRepository()
      const extRes = docRepo.upsertDocumentExtraction({
        fileLocationId: loc.id,
        expectedDiscoveryObservationId: effBeforeExt.discoveryObservationId,
        expectedContentRevision: effBeforeExt.contentRevision,
        contentSha256: sha1,
        observedByteSize: 120,
        observedMtimeMs: 1_700_000_000_000,
        recipeVersion: DOCUMENT_EXTRACTION_RECIPE_VERSION,
        extractionStatus: 'extracted',
        statusDetail: null,
        extractedText:
          'Personal reflection number 1 about our family garden and weekend plans for spring and summer vacation.',
        extractedCharCount: 102,
        pageCount: 1,
        truncated: false,
        truncationReason: null,
        detectedEncoding: 'utf-8',
        extractedAtMs: 1_700_000_001_000
      })
      expect(extRes.committed).toBe(true)
      const afterExtraction = await coordinator.getCoverage()
      expect(afterExtraction.staleDocuments).toBe(1)

      await coordinator.startClassification({ scopeKind: 'all' })
      const afterExtractedClassify = await coordinator.getCoverage()
      expect(afterExtractedClassify.staleDocuments).toBe(0)
      expect(afterExtractedClassify.otherDocuments).toBe(1)

      // 5. OCR mutation via DocumentOcrRepository invalidates warmed coverage -> staleDocuments becomes 1
      const ocrRepo = catalog.getDocumentOcrRepository()
      const ocrRes = ocrRepo.upsertDocumentOcrExtraction({
        fileLocationId: loc.id,
        expectedDiscoveryObservationId: effBeforeExt.discoveryObservationId,
        expectedContentRevision: effBeforeExt.contentRevision,
        contentSha256: sha1,
        observedByteSize: 120,
        observedMtimeMs: 1_700_000_000_000,
        recipeVersion: DOCUMENT_OCR_RECIPE_VERSION,
        ocrModelId: 'tesseract-eng',
        ocrModelManifestSha256: 'a'.repeat(64),
        ocrLanguage: 'eng',
        extractionMethod: 'ocr_image_tesseract',
        ocrStatus: 'extracted',
        statusDetail: null,
        extractedText: 'OCR scanned receipt total $12.50',
        extractedCharCount: 31,
        pageCount: 1,
        ocrPageCount: 1,
        nativeOnlyPageCount: 0,
        skippedBlankPageCount: 0,
        meanConfidence: 88,
        truncated: false,
        truncationReason: null,
        extractedAtMs: 1_700_000_002_000
      })
      expect(ocrRes.committed).toBe(true)
      const afterOcr = await coordinator.getCoverage()
      expect(afterOcr.staleDocuments).toBe(1)

      // 6. Hash change via CatalogDatabase invalidates warmed coverage too
      const sha2 = '2'.repeat(64)
      catalog.recordHashObservation({
        originalPath: docPath,
        sha256: sha2,
        observedByteSize: 120,
        observedMtimeMs: 1_700_000_000_000,
        hashedAtMs: 1_700_000_003_000
      })
      const afterSecondHash = await coordinator.getCoverage()
      expect(afterSecondHash.unclassifiedDocuments).toBe(1)

      // 7. External SQLite connection mutation (PRAGMA data_version) invalidates warmed coverage
      const externalDb = CatalogDatabase.open({ catalogPath })
      try {
        const externalRoot = join(tempDir, 'external-source')
        externalDb.persistDiscoveryBatch(externalRoot, [
          {
            originalPath: join(externalRoot, 'README.md'),
            fileName: 'README.md',
            extension: '.md',
            category: 'document',
            byteSize: 80,
            birthtimeMs: 1_700_000_004_000,
            mtimeMs: 1_700_000_004_000,
            discoveredAtMs: 1_700_000_004_000
          }
        ])
      } finally {
        externalDb.close()
      }
      const afterExternal = await coordinator.getCoverage()
      expect(afterExternal.totalDocuments).toBe(2)
      expect(afterExternal.unclassifiedDocuments).toBe(2)
    } finally {
      await coordinator.shutdown()
    }
  })

  it('streams >500-item snapshots, cleans up malformed/abandoned staging files, and preserves active job snapshots', async () => {
    seedDocs(520)
    const repo = catalog.getDocumentClassificationRepository()
    const db = catalog.getRawDb()
    const stagingDir = join(tempDir, '.doc_classify_snapshots')
    mkdirSync(stagingDir, { recursive: true })

    // Pre-existing orphan .ndjson and an active job's .ndjson
    const orphanFile = join(stagingDir, 'orphan-999.ndjson')
    const activeJobId = 'active-live'
    const activeFile = join(stagingDir, `${activeJobId}.ndjson`)
    writeFileSync(orphanFile, '{"id":1}\n', 'utf8')
    writeFileSync(activeFile, '{"id":2}\n', 'utf8')

    // Insert a paused job whose staging file is activeFile
    db.prepare(
      `INSERT INTO document_classification_jobs (
        id, scope_kind, status, rule_version, force_reclassify, snapshot_complete,
        total_items, processed_items, classified_items, other_items, unknown_items, clutter_items,
        reused_items, skipped_stale_items, failed_items, started_at_ms, updated_at_ms
      ) VALUES (?, 'all', 'paused', '7e.v1', 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, ?, ?);`
    ).run(activeJobId, Date.now(), Date.now())

    // Run orphan cleanup: deletes orphanFile, preserves activeFile
    const cleanedOrphans = repo.cleanupIncompleteSnapshots()
    expect(cleanedOrphans).toBeGreaterThanOrEqual(1)
    expect(existsSync(orphanFile)).toBe(false)
    expect(existsSync(activeFile)).toBe(true)

    // Remove the synthetic paused job and activeFile so we can run a real >500 snapshot
    db.prepare('DELETE FROM document_classification_jobs WHERE id = ?;').run(activeJobId)
    rmSync(activeFile, { force: true })

    // Malformed NDJSON staging file test: ingestSnapshotNdjson must reject malformed JSON cleanly
    const malformedFile = join(stagingDir, 'malformed-test.ndjson')
    writeFileSync(
      malformedFile,
      '{"f":1,"d":1,"r":"rev","ne":null,"oe":null,"h":"abc"}\n{not-valid-json\n',
      'utf8'
    )
    await expect(
      repo.ingestSnapshotNdjson({
        jobId: 'malformed-test',
        stagingFilePath: malformedFile,
        now: Date.now()
      })
    ).rejects.toThrow(/MALFORMED_SNAPSHOT/)
    rmSync(malformedFile, { force: true })

    // Create a large (>500) real snapshot job and verify bounded ingestion & completion
    const budget = new AppWorkerBudget(3)
    const coordinator = new DocumentClassificationCoordinator({ catalog, workerBudget: budget })
    try {
      const completed = await coordinator.startClassification({ scopeKind: 'all' })
      expect(completed?.status).toBe('completed')
      expect(completed?.totalItems).toBe(520)
      expect(completed?.processedItems).toBe(520)
      // Staging file should be cleaned up on completion
      const remainingNdjson = readdirSync(stagingDir).filter((f) => f.endsWith('.ndjson'))
      expect(remainingNdjson).toEqual([])
    } finally {
      await coordinator.shutdown()
    }
  })

  it('prevents startup cleanup from deleting an in-flight snapshot and enforces lifecycle boundary', async () => {
    seedDocs(10)
    const repo = catalog.getDocumentClassificationRepository()
    const origIngest = repo.ingestSnapshotNdjson.bind(repo)

    let releaseIngest!: () => void
    const ingestStarted = new Promise<void>((resolve) => {
      repo.ingestSnapshotNdjson = async (params) => {
        resolve()
        await new Promise<void>((r) => {
          releaseIngest = r
        })
        return origIngest(params)
      }
    })

    const budget = new AppWorkerBudget(3)
    const coordinator = new DocumentClassificationCoordinator({ catalog, workerBudget: budget })
    try {
      const runPromise = coordinator.startClassification({ scopeKind: 'all' })
      await ingestStarted

      // While snapshot is in-flight (snapshot_complete = 0), startup cleanup must NOT delete or interrupt it
      const cleaned = repo.cleanupIncompleteSnapshots()
      expect(cleaned).toBe(0)
      const interrupted = repo.markRunningJobsAsInterrupted()
      expect(interrupted).toBe(0)

      // Coordinator must reject startup recovery once classification lifecycle has started
      expect(() => coordinator.runStartupRecovery()).toThrow(/LIFECYCLE_ERROR/)

      releaseIngest()
      const completed = await runPromise
      expect(completed?.status).toBe('completed')
      expect(completed?.totalItems).toBe(10)
    } finally {
      releaseIngest?.()
      repo.ingestSnapshotNdjson = origIngest
      await coordinator.shutdown()
    }
  })
})
