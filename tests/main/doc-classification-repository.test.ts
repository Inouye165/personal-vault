// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AnnotationJournal } from '../../src/main/services/annotations/journal'
import { CatalogDatabase } from '../../src/main/services/catalog/database'
import { CURRENT_SCHEMA_VERSION } from '../../src/main/services/catalog/migrations'
import { classifyWithDeterministicRules } from '../../src/main/services/documents/classification/rules'

describe('Stage 7E Slice 2 — Migration 15 & DocumentClassificationRepository', () => {
  let tempDir: string
  let catalog: CatalogDatabase

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pv-doc-cls-repo-'))
    catalog = CatalogDatabase.open({ catalogPath: join(tempDir, 'catalog.db') })
  })

  afterEach(() => {
    catalog.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  function seedDocumentLocation(params: {
    sourceRoot?: string
    relativePath: string
    fileName: string
    extension: string
    byteSize?: number
    mtimeMs?: number
    sha256?: string
    nativeText?: string | null
  }): { fileLocationId: number; discoveryObservationId: number; extractionId: number | null } {
    const db = catalog.getRawDb()
    const sourceRoot = params.sourceRoot ?? join(tempDir, 'source')
    const now = Date.now()

    const existingSource = db
      .prepare('SELECT id FROM sources WHERE root_path = ?;')
      .get(sourceRoot) as { id: number } | undefined
    const sourceId = existingSource
      ? existingSource.id
      : Number(
          db
            .prepare(
              'INSERT INTO sources (root_path, normalized_root_path, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?);'
            )
            .run(sourceRoot, sourceRoot.toLowerCase(), now, now).lastInsertRowid
        )

    const originalPath = join(sourceRoot, params.relativePath)
    const byteSize = params.byteSize ?? 256
    const mtimeMs = params.mtimeMs ?? 1_700_000_000_000
    const sha256 =
      params.sha256 ?? 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

    const fileLocationId = Number(
      db
        .prepare(
          `INSERT INTO file_locations (
            source_id, original_path, normalized_path, file_name, extension, category,
            created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, 'document', ?, ?);`
        )
        .run(
          sourceId,
          originalPath,
          originalPath.toLowerCase(),
          params.fileName,
          params.extension,
          now,
          now
        ).lastInsertRowid
    )

    const discoveryObservationId = Number(
      db
        .prepare(
          `INSERT INTO discovery_observations (file_location_id, byte_size, filesystem_birthtime_ms, filesystem_mtime_ms, observed_at_ms, last_seen_at_ms, is_current)
           VALUES (?, ?, ?, ?, ?, ?, 1);`
        )
        .run(fileLocationId, byteSize, now, mtimeMs, now, now).lastInsertRowid
    )

    db.prepare(
      `INSERT INTO hash_observations (file_location_id, discovery_observation_id, sha256, observed_byte_size, observed_mtime_ms, hashed_at_ms, is_active)
       VALUES (?, ?, ?, ?, ?, ?, 1);`
    ).run(fileLocationId, discoveryObservationId, sha256, byteSize, mtimeMs, now)

    let extractionId: number | null = null
    if (params.nativeText !== undefined && params.nativeText !== null) {
      extractionId = Number(
        db
          .prepare(
            `INSERT INTO document_extractions (
              file_location_id, discovery_observation_id, content_sha256, observed_byte_size, observed_mtime_ms,
              content_revision, recipe_version, extraction_status, extracted_text, extracted_char_count, truncated, is_current, extracted_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, 'doc_extract_v1', 'extracted', ?, ?, 0, 1, ?);`
          )
          .run(
            fileLocationId,
            discoveryObservationId,
            sha256,
            byteSize,
            mtimeMs,
            `rev:${discoveryObservationId}:${byteSize}:${mtimeMs}:${sha256}`,
            params.nativeText,
            params.nativeText.length,
            now
          ).lastInsertRowid
      )
    }

    return { fileLocationId, discoveryObservationId, extractionId }
  }

  it('applies Migration 15 tables and indexes cleanly', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(15)
    const tables = catalog
      .getRawDb()
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'document_classification%';"
      )
      .all() as Array<{ name: string }>
    const names = tables.map((t) => t.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'document_classifications',
        'document_classification_labels',
        'document_classification_overrides',
        'document_classification_jobs',
        'document_classification_job_items'
      ])
    )
  })

  it('commits classification with full provenance, rejects REVISION_MISMATCH stale writes, and never hides stale rows', () => {
    const repo = catalog.getDocumentClassificationRepository()
    const clutterText =
      'SPDX-License-Identifier: MIT\n' +
      'Permission is hereby granted, free of charge, to any person obtaining a copy of the "Software".\n' +
      'WITHOUT WARRANTY OF ANY KIND.\n'

    const seeded = seedDocumentLocation({
      relativePath: 'repos/app/LICENSE.txt',
      fileName: 'LICENSE.txt',
      extension: '.txt',
      nativeText: clutterText
    })

    const candidate = repo.getCandidateForLocation(seeded.fileLocationId)!
    expect(candidate).not.toBeNull()
    const result = classifyWithDeterministicRules({
      fileLocationId: seeded.fileLocationId,
      fileName: candidate.row.file_name,
      extension: candidate.row.extension,
      relativePath: candidate.resolved.relativePath,
      extractionStatus: candidate.resolved.extractionStatus,
      textSourceKind: candidate.resolved.textSourceKind,
      ocrMeanConfidence: candidate.resolved.ocrMeanConfidence,
      nativeTruncated: candidate.resolved.nativeTruncated,
      ocrTruncated: candidate.resolved.ocrTruncated,
      text: candidate.resolved.text
    })
    expect(result.isClutterCandidate).toBe(true)

    const commitOk = repo.commitClassificationResult({
      fileLocationId: seeded.fileLocationId,
      expectedDiscoveryObservationId: seeded.discoveryObservationId,
      expectedContentRevision: candidate.resolved.contentRevision,
      expectedNativeExtractionId: candidate.resolved.nativeExtractionId,
      expectedOcrExtractionId: candidate.resolved.ocrExtractionId,
      expectedNormalizedInputSha256: candidate.resolved.normalizedInputSha256,
      sourceRootPath: candidate.row.source_root_path,
      resolved: candidate.resolved,
      row: candidate.row,
      result
    })
    expect(commitOk.status).toBe('committed')
    expect(repo.getHiddenClutterCount()).toBe(1)

    const effective = repo.getEffectiveDocumentClassification(seeded.fileLocationId)!
    expect(effective.effectiveIsClutter).toBe(true)
    expect(effective.isStale).toBe(false)
    expect(effective.effectivePurposeLabels).toContain('legal')
    expect(effective.effectiveOriginLabels).toContain('software_project')

    // Simulate a newer discovery observation (file modified on rescan) -> stale classification must NOT hide document
    const db = catalog.getRawDb()
    const newSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    db.prepare('UPDATE discovery_observations SET is_current = 0 WHERE file_location_id = ?;').run(
      seeded.fileLocationId
    )
    const newObsId = Number(
      db
        .prepare(
          `INSERT INTO discovery_observations (file_location_id, byte_size, filesystem_birthtime_ms, filesystem_mtime_ms, observed_at_ms, last_seen_at_ms, is_current)
           VALUES (?, 300, ?, 1700000005000, ?, ?, 1);`
        )
        .run(seeded.fileLocationId, Date.now(), Date.now(), Date.now()).lastInsertRowid
    )
    db.prepare('UPDATE hash_observations SET is_active = 0 WHERE file_location_id = ?;').run(
      seeded.fileLocationId
    )
    db.prepare(
      'INSERT INTO hash_observations (file_location_id, discovery_observation_id, sha256, observed_byte_size, observed_mtime_ms, hashed_at_ms, is_active) VALUES (?, ?, ?, 300, 1700000005000, ?, 1);'
    ).run(seeded.fileLocationId, newObsId, newSha, Date.now())

    // Stale commit using OLD expectedDiscoveryObservationId must be atomically rejected with REVISION_MISMATCH
    const staleCommit = repo.commitClassificationResult({
      fileLocationId: seeded.fileLocationId,
      expectedDiscoveryObservationId: seeded.discoveryObservationId,
      expectedContentRevision: candidate.resolved.contentRevision,
      expectedNativeExtractionId: candidate.resolved.nativeExtractionId,
      expectedOcrExtractionId: candidate.resolved.ocrExtractionId,
      expectedNormalizedInputSha256: candidate.resolved.normalizedInputSha256,
      sourceRootPath: candidate.row.source_root_path,
      resolved: candidate.resolved,
      row: candidate.row,
      result
    })
    expect(staleCommit.status).toBe('revision_mismatch')
    expect(newObsId).toBeGreaterThan(seeded.discoveryObservationId)

    // Stale classification must NOT hide the document
    expect(repo.getHiddenClutterCount()).toBe(0)
    const afterStale = repo.getEffectiveDocumentClassification(seeded.fileLocationId)!
    expect(afterStale.isStale).toBe(true)
    expect(afterStale.effectiveIsClutter).toBe(false)
  })

  it('evaluates path-dependent rules per location without cross-path hash-reuse bugs', () => {
    const repo = catalog.getDocumentClassificationRepository()
    const sharedHash = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
    const sharedText =
      '2026-11-01T06:10:00Z [INFO] service boot\n' +
      '2026-11-01T06:10:01Z [INFO] socket ready\n' +
      '2026-11-01T06:10:02Z [WARN] retry scheduled\n' +
      '2026-11-01T06:10:03Z [INFO] cycle done\n'

    const loc1 = seedDocumentLocation({
      relativePath: 'AppLogs/service.log',
      fileName: 'service.log',
      extension: '.log',
      sha256: sharedHash,
      nativeText: sharedText
    })
    const loc2 = seedDocumentLocation({
      relativePath: 'Personal/diary-note.txt',
      fileName: 'diary-note.txt',
      extension: '.txt',
      sha256: sharedHash,
      nativeText:
        'Personal reflection from our family trip to the coast with mom and dad.\n' + sharedText
    })

    const c1 = repo.getCandidateForLocation(loc1.fileLocationId)!
    const c2 = repo.getCandidateForLocation(loc2.fileLocationId)!
    expect(c1.resolved.relativePath).toBe('AppLogs/service.log')
    expect(c2.resolved.relativePath).toBe('Personal/diary-note.txt')
    expect(c1.resolved.normalizedInputSha256).not.toBe(c2.resolved.normalizedInputSha256)
  })

  it('reconciles classification overrides through CatalogDatabase discovery/hash paths (timestamp touch vs content change vs unverified hash)', async () => {
    const journalDir = join(tempDir, 'journal-rec')
    const journal = new AnnotationJournal({ storageDir: journalDir })
    await journal.initialize()
    const dbWithJournal = CatalogDatabase.open({
      catalogPath: join(tempDir, 'catalog-rec.db'),
      journal
    })

    try {
      const sourceRoot = join(tempDir, 'src-rec')
      const origPath = join(sourceRoot, 'repos', 'app', 'LICENSE.txt')
      const shaA = '1'.repeat(64)
      const shaB = '2'.repeat(64)

      dbWithJournal.persistDiscoveryBatch(sourceRoot, [
        {
          originalPath: origPath,
          fileName: 'LICENSE.txt',
          extension: '.txt',
          category: 'document',
          byteSize: 120,
          birthtimeMs: 1_700_000_000_000,
          mtimeMs: 1_700_000_000_000,
          discoveredAtMs: 1_700_000_000_000
        }
      ])
      dbWithJournal.recordHashObservation({
        originalPath: origPath,
        sha256: shaA,
        observedByteSize: 120,
        observedMtimeMs: 1_700_000_000_000,
        hashedAtMs: 1_700_000_000_000
      })

      const repo = dbWithJournal.getDocumentClassificationRepository()
      const loc = dbWithJournal.getFileLocationByPath(origPath)!
      const eff0 = repo.getEffectiveDocumentClassification(loc.id)!

      repo.setClassificationOverride({
        fileLocationId: loc.id,
        expectedRevision: eff0.contentRevision,
        expectedOverrideVersion: 0,
        purposeLabels: ['legal'],
        originLabels: ['personal'],
        clutterOverride: 'force_keep'
      })

      // 1. Timestamp-only rescan via CatalogDatabase (no manual reconcileLocationUpdate call!)
      dbWithJournal.persistDiscoveryBatch(sourceRoot, [
        {
          originalPath: origPath,
          fileName: 'LICENSE.txt',
          extension: '.txt',
          category: 'document',
          byteSize: 120,
          birthtimeMs: 1_700_000_000_000,
          mtimeMs: 1_700_000_010_000,
          discoveredAtMs: 1_700_000_010_000
        }
      ])

      // Before hash is verified on the new observation, override is NOT blindly applied to unverified observation
      const unverifiedEff = repo.getEffectiveDocumentClassification(loc.id)!
      expect(unverifiedEff.override).toBeNull()
      expect(unverifiedEff.hasUnverifiedOverride).toBe(true)
      expect(unverifiedEff.latestOverrideVersion).toBe(1)
      expect(repo.getCoverage().overriddenDocuments).toBe(0)

      // Optimistic concurrency: hidden unverified override cannot be overwritten with expectedOverrideVersion: 0
      expect(() =>
        repo.setClassificationOverride({
          fileLocationId: loc.id,
          expectedRevision: unverifiedEff.contentRevision,
          expectedOverrideVersion: 0,
          purposeLabels: ['other' as never],
          originLabels: null,
          clutterOverride: 'inherit'
        })
      ).toThrow(/STALE_OVERRIDE_VERSION/)

      // Record matching shaA on new observation -> override is preserved and re-anchored!
      dbWithJournal.recordHashObservation({
        originalPath: origPath,
        sha256: shaA,
        observedByteSize: 120,
        observedMtimeMs: 1_700_000_010_000,
        hashedAtMs: 1_700_000_010_000
      })
      const afterMatchingHash = repo.getEffectiveDocumentClassification(loc.id)!
      expect(afterMatchingHash.override?.clutterOverride).toBe('force_keep')
      expect(afterMatchingHash.override?.discoveryObservationId).toBe(
        afterMatchingHash.discoveryObservationId
      )

      // 2. Content change (new mtime + different shaB) -> invalidates override permanently
      dbWithJournal.persistDiscoveryBatch(sourceRoot, [
        {
          originalPath: origPath,
          fileName: 'LICENSE.txt',
          extension: '.txt',
          category: 'document',
          byteSize: 120,
          birthtimeMs: 1_700_000_000_000,
          mtimeMs: 1_700_000_020_000,
          discoveredAtMs: 1_700_000_020_000
        }
      ])
      dbWithJournal.recordHashObservation({
        originalPath: origPath,
        sha256: shaB,
        observedByteSize: 120,
        observedMtimeMs: 1_700_000_020_000,
        hashedAtMs: 1_700_000_020_000
      })
      const afterChangedHash = repo.getEffectiveDocumentClassification(loc.id)!
      expect(afterChangedHash.override).toBeNull()
      expect(afterChangedHash.hasStaleOverride).toBe(true)
      expect(afterChangedHash.latestOverrideVersion).toBe(1)
      expect(repo.getCoverage().overriddenDocuments).toBe(0)

      // Stale override cannot be silently overwritten with expectedOverrideVersion: 0
      expect(() =>
        repo.setClassificationOverride({
          fileLocationId: loc.id,
          expectedRevision: afterChangedHash.contentRevision,
          expectedOverrideVersion: 0,
          purposeLabels: ['lists'],
          originLabels: ['personal'],
          clutterOverride: 'force_keep'
        })
      ).toThrow(/STALE_OVERRIDE_VERSION/)

      // Explicit acknowledgement of latestOverrideVersion (1) succeeds -> version 2
      const updatedOverride = repo.setClassificationOverride({
        fileLocationId: loc.id,
        expectedRevision: afterChangedHash.contentRevision,
        expectedOverrideVersion: afterChangedHash.latestOverrideVersion,
        purposeLabels: ['lists'],
        originLabels: ['personal'],
        clutterOverride: 'force_keep'
      })
      expect(updatedOverride.overrideVersion).toBe(2)

      // Reset override clears active override, advances version to 3, and leaves hasStaleOverride = false
      const resetRes = repo.resetClassificationOverride({
        fileLocationId: loc.id,
        expectedRevision: afterChangedHash.contentRevision,
        expectedOverrideVersion: 2
      })
      expect(resetRes.overrideVersion).toBe(3)
      const afterReset = repo.getEffectiveDocumentClassification(loc.id)!
      expect(afterReset.override).toBeNull()
      expect(afterReset.hasStaleOverride).toBe(false)
      expect(afterReset.latestOverrideVersion).toBe(3)
    } finally {
      dbWithJournal.close()
    }
  })

  it('handles pre-commit journal failure (rollback) and post-commit journal failure (persistencePending + recovery)', async () => {
    const journalDir = join(tempDir, 'journal-fail')
    const journal = new AnnotationJournal({ storageDir: journalDir })
    await journal.initialize()
    const dbWithJournal = CatalogDatabase.open({
      catalogPath: join(tempDir, 'catalog-fail.db'),
      journal
    })

    try {
      const sourceRoot = join(tempDir, 'src-fail')
      const origPath = join(sourceRoot, 'Notes', 'note.txt')
      dbWithJournal.persistDiscoveryBatch(sourceRoot, [
        {
          originalPath: origPath,
          fileName: 'note.txt',
          extension: '.txt',
          category: 'document',
          byteSize: 90,
          birthtimeMs: 1_700_000_000_000,
          mtimeMs: 1_700_000_000_000,
          discoveredAtMs: 1_700_000_000_000
        }
      ])
      const loc = dbWithJournal.getFileLocationByPath(origPath)!
      const repo = dbWithJournal.getDocumentClassificationRepository()
      const eff = repo.getEffectiveDocumentClassification(loc.id)!

      // 1. Pre-commit journal failure -> rolls back DB cleanly
      const origAppend = journal.appendDocumentClassificationOverrideSync.bind(journal)
      journal.appendDocumentClassificationOverrideSync = () => {
        throw new Error('DISK_FULL_BEFORE_COMMIT')
      }
      expect(() =>
        repo.setClassificationOverride({
          fileLocationId: loc.id,
          expectedRevision: eff.contentRevision,
          expectedOverrideVersion: 0,
          purposeLabels: ['lists'],
          originLabels: ['personal'],
          clutterOverride: 'force_keep'
        })
      ).toThrow(/DISK_FULL_BEFORE_COMMIT/)
      expect(repo.getEffectiveDocumentClassification(loc.id)!.override).toBeNull()
      journal.appendDocumentClassificationOverrideSync = origAppend

      // 2. Post-commit journal failure -> DB committed, returns persistencePending: true, recoverable on restart
      const origCommitSync = journal.appendCommitRecordSync.bind(journal)
      journal.appendCommitRecordSync = () => {
        throw new Error('DISK_IO_AFTER_COMMIT')
      }
      const res = repo.setClassificationOverride({
        fileLocationId: loc.id,
        expectedRevision: eff.contentRevision,
        expectedOverrideVersion: 0,
        purposeLabels: ['lists'],
        originLabels: ['personal'],
        clutterOverride: 'force_keep'
      })
      expect(res.persistencePending).toBe(true)
      expect(repo.getEffectiveDocumentClassification(loc.id)!.override?.clutterOverride).toBe(
        'force_keep'
      )

      // Restore journal & reconcile idempotently
      journal.appendCommitRecordSync = origCommitSync
      const rec = dbWithJournal.reconcileJournalWithDatabase()
      expect(rec.reconciledCount).toBeGreaterThanOrEqual(1)
      const entries = [...journal.iterateEntriesSync()]
      expect(entries.some((e) => e.kind === 'op_committed')).toBe(true)
    } finally {
      dbWithJournal.close()
    }
  })
})
