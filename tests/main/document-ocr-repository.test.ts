// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CatalogDatabase,
  CURRENT_SCHEMA_VERSION,
  UnsupportedSchemaVersionError,
  buildDocumentContentRevision
} from '../../src/main/services/catalog'
import { MIGRATIONS } from '../../src/main/services/catalog/migrations'
import { DOCUMENT_EXTRACTION_RECIPE_VERSION } from '../../src/main/services/documents/types'
import {
  DOCUMENT_OCR_RECIPE_VERSION,
  OCR_MODEL_ID,
  OCR_MODEL_LANGUAGE,
  PINNED_OCR_MANIFEST_SHA256
} from '../../src/main/services/documents/ocr'

describe('Stage 7C Slice 2 — Migration 13 & DocumentOcrRepository', () => {
  let tempDir: string
  let dbPath: string
  let catalog: CatalogDatabase

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pv-doc-ocr-repo-'))
    dbPath = join(tempDir, 'catalog.db')
    catalog = CatalogDatabase.open({ catalogPath: dbPath })
  })

  afterEach(() => {
    if (catalog && !catalog.isClosed()) {
      catalog.close()
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('bumps CURRENT_SCHEMA_VERSION to 13, upgrades a v12 catalog preserving Stage 7B data, and rejects future v14 schemas', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(13)

    // Verify fresh v13 tables & columns exist
    const rawFresh = catalog.getRawDatabaseForTesting()
    const tables = rawFresh
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (
           'document_extractions',
           'document_ocr_extractions',
           'document_ocr_jobs',
           'document_ocr_job_items'
         ) ORDER BY name ASC;`
      )
      .all() as Array<{ name: string }>
    expect(tables.map((t) => t.name)).toEqual([
      'document_extractions',
      'document_ocr_extractions',
      'document_ocr_job_items',
      'document_ocr_jobs'
    ])

    const docExtCols = rawFresh.prepare('PRAGMA table_info(document_extractions);').all() as Array<{
      name: string
    }>
    expect(docExtCols.some((c) => c.name === 'ocr_candidate_page_count')).toBe(true)
    catalog.close()

    // Construct an authentic v12 SQLite database with pre-existing Stage 7B native extraction data
    const v12Path = join(tempDir, 'legacy-v12.db')
    const rawV12 = new DatabaseSync(v12Path)
    try {
      rawV12.exec('PRAGMA foreign_keys = ON;')
      rawV12.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          applied_at_ms INTEGER NOT NULL
        );
      `)
      for (const m of MIGRATIONS.filter((item) => item.version <= 12)) {
        rawV12.exec('BEGIN;')
        m.up(rawV12)
        rawV12
          .prepare('INSERT INTO schema_migrations (version, name, applied_at_ms) VALUES (?, ?, ?);')
          .run(m.version, m.name, 1_700_000_000_000)
        rawV12.exec('COMMIT;')
      }

      // Seed v12 source, file_location, observation, hash, and native document_extraction row
      rawV12
        .prepare(
          `INSERT INTO sources (root_path, normalized_root_path, created_at_ms, updated_at_ms)
           VALUES ('D:\\docs', 'd:\\docs', 1000, 1000);`
        )
        .run()
      rawV12
        .prepare(
          `INSERT INTO file_locations (
             source_id, original_path, normalized_path, file_name, extension, category, created_at_ms, updated_at_ms
           ) VALUES (1, 'D:\\docs\\legacy.pdf', 'd:\\docs\\legacy.pdf', 'legacy.pdf', '.pdf', 'document', 1000, 1000);`
        )
        .run()
      rawV12
        .prepare(
          `INSERT INTO discovery_observations (
             file_location_id, byte_size, filesystem_birthtime_ms, filesystem_mtime_ms, observed_at_ms, last_seen_at_ms, is_current
           ) VALUES (1, 4096, 900, 950, 1000, 1000, 1);`
        )
        .run()
      rawV12
        .prepare(
          `INSERT INTO hash_observations (
             file_location_id, discovery_observation_id, sha256, observed_byte_size, observed_mtime_ms, hashed_at_ms, is_active
           ) VALUES (1, 1, ?, 4096, 950, 1005, 1);`
        )
        .run('b'.repeat(64))
      const v12Rev = buildDocumentContentRevision({
        discoveryObservationId: 1,
        byteSize: 4096,
        filesystemMtimeMs: 950,
        activeHash: 'b'.repeat(64)
      })
      rawV12
        .prepare(
          `INSERT INTO document_extractions (
             file_location_id, discovery_observation_id, content_sha256, observed_byte_size,
             observed_mtime_ms, content_revision, recipe_version, extraction_status,
             status_detail, extracted_text, extracted_char_count, page_count,
             truncated, truncation_reason, detected_encoding, extracted_at_ms, is_current
           ) VALUES (1, 1, ?, 4096, 950, ?, 'doc_extract_v1', 'extracted', NULL, 'Legacy native PDF text', 22, 2, 0, NULL, NULL, 1010, 1);`
        )
        .run('b'.repeat(64), v12Rev)
    } finally {
      rawV12.close()
    }

    // Upgrade v12 -> v13 via CatalogDatabase.open
    const upgraded = CatalogDatabase.open({ catalogPath: v12Path })
    try {
      const preview = upgraded.getDocumentRepository().getDocumentPreview(1)
      expect(preview?.extractionStatus).toBe('extracted')
      expect(preview?.extractedText).toBe('Legacy native PDF text')

      const ocrState = upgraded.getDocumentOcrRepository().getDocumentOcrState(1)
      expect(ocrState?.ocrStatus).toBe('not_processed')
    } finally {
      upgraded.close()
    }

    // Future v14 database must be rejected with UnsupportedSchemaVersionError without mutating DB
    const v14Path = join(tempDir, 'future-v14.db')
    const rawV14 = new DatabaseSync(v14Path)
    rawV14.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        applied_at_ms INTEGER NOT NULL
      );
      INSERT INTO schema_migrations (version, name, applied_at_ms) VALUES (999, 'future_schema', 1000);
    `)
    rawV14.close()

    expect(() => CatalogDatabase.open({ catalogPath: v14Path })).toThrow(
      UnsupportedSchemaVersionError
    )
  })

  it('preserves native extraction and OCR independently with distinct model/recipe/revision staleness rules', () => {
    const sourceRoot = join(tempDir, 'coexist-docs')
    catalog.registerSource(sourceRoot)
    const pdfPath = join(sourceRoot, 'mixed_statement.pdf')

    catalog.persistDiscoveryBatch(sourceRoot, [
      {
        originalPath: pdfPath,
        fileName: 'mixed_statement.pdf',
        extension: '.pdf',
        category: 'document',
        byteSize: 8192,
        birthtimeMs: 1_700_000_000_000,
        mtimeMs: 1_700_000_050_000,
        discoveredAtMs: 1_700_000_100_000
      }
    ])
    const sha1 = 'c'.repeat(64)
    catalog.recordHashObservationsBatch([
      {
        originalPath: pdfPath,
        sha256: sha1,
        observedByteSize: 8192,
        observedMtimeMs: 1_700_000_050_000,
        hashedAtMs: 1_700_000_101_000
      }
    ])

    const nativeRepo = catalog.getDocumentRepository()
    const ocrRepo = catalog.getDocumentOcrRepository()
    const cand = nativeRepo.getDocumentExtractionCandidate(1)!

    // 1. Persist Stage 7B native extraction (header text, 1 OCR candidate page)
    const nativeCommit = nativeRepo.upsertDocumentExtraction({
      fileLocationId: 1,
      expectedDiscoveryObservationId: cand.discoveryObservationId,
      expectedContentRevision: cand.contentRevision,
      contentSha256: sha1,
      observedByteSize: cand.byteSize,
      observedMtimeMs: cand.filesystemMtimeMs,
      recipeVersion: DOCUMENT_EXTRACTION_RECIPE_VERSION,
      extractionStatus: 'extracted',
      statusDetail: null,
      extractedText: 'STATEMENT HEADER ONLY',
      extractedCharCount: 21,
      pageCount: 2,
      ocrCandidatePageCount: 1,
      truncated: false,
      truncationReason: null,
      detectedEncoding: null
    })
    expect(nativeCommit.committed).toBe(true)

    // 2. Persist Stage 7C OCR extraction on the SAME fileLocationId
    const ocrCommit = ocrRepo.upsertDocumentOcrExtraction({
      fileLocationId: 1,
      expectedDiscoveryObservationId: cand.discoveryObservationId,
      expectedContentRevision: cand.contentRevision,
      contentSha256: sha1,
      observedByteSize: cand.byteSize,
      observedMtimeMs: cand.filesystemMtimeMs,
      recipeVersion: DOCUMENT_OCR_RECIPE_VERSION,
      ocrModelId: OCR_MODEL_ID,
      ocrModelManifestSha256: PINNED_OCR_MANIFEST_SHA256,
      ocrLanguage: OCR_MODEL_LANGUAGE,
      extractionMethod: 'ocr_hybrid_pdf',
      ocrStatus: 'extracted',
      statusDetail: null,
      extractedText: 'STATEMENT HEADER ONLY\n\nSCANNED LINE ITEMS TOTAL 42.19',
      extractedCharCount: 53,
      pageCount: 2,
      ocrPageCount: 1,
      nativeOnlyPageCount: 1,
      skippedBlankPageCount: 0,
      meanConfidence: 91.5,
      truncated: false,
      truncationReason: null
    })
    expect(ocrCommit.committed).toBe(true)

    // Verify native extraction was NOT overwritten or marked stale
    const nativePreview = nativeRepo.getDocumentPreview(1)
    expect(nativePreview?.extractionStatus).toBe('extracted')
    expect(nativePreview?.extractedText).toBe('STATEMENT HEADER ONLY')
    expect(nativePreview?.recipeVersion).toBe('doc_extract_v1')

    // Verify OCR extraction has independent provenance & text
    const ocrPreview = ocrRepo.getDocumentOcrPreview(1)
    expect(ocrPreview?.ocrStatus).toBe('extracted')
    expect(ocrPreview?.extractionMethod).toBe('ocr_hybrid_pdf')
    expect(ocrPreview?.ocrModelId).toBe(OCR_MODEL_ID)
    expect(ocrPreview?.ocrModelManifestSha256).toBe(PINNED_OCR_MANIFEST_SHA256)
    expect(ocrPreview?.ocrLanguage).toBe('eng')
    expect(ocrPreview?.ocrPageCount).toBe(1)
    expect(ocrPreview?.nativeOnlyPageCount).toBe(1)
    expect(ocrPreview?.meanConfidence).toBeCloseTo(91.5)
    expect(ocrPreview?.extractedText).toContain('SCANNED LINE ITEMS TOTAL 42.19')

    // 3. Rotating OCR model manifest marks ONLY OCR stale; native remains 'extracted'
    const rotatedOcrState = ocrRepo.getDocumentOcrState(1, {
      ocrModelManifestSha256: 'f'.repeat(64)
    })
    expect(rotatedOcrState?.ocrStatus).toBe('stale')
    expect(nativeRepo.getDocumentPreview(1)?.extractionStatus).toBe('extracted')

    // 4. Changing native recipe marks ONLY native stale; OCR remains 'extracted'
    expect(
      nativeRepo.getDocumentPreview(1, { recipeVersion: 'doc_extract_v2' })?.extractionStatus
    ).toBe('stale')
    expect(ocrRepo.getDocumentOcrState(1)?.ocrStatus).toBe('extracted')

    // 5. Source file modification + rescan advances observation -> marks BOTH tracks stale
    catalog.persistDiscoveryBatch(sourceRoot, [
      {
        originalPath: pdfPath,
        fileName: 'mixed_statement.pdf',
        extension: '.pdf',
        category: 'document',
        byteSize: 9000,
        birthtimeMs: 1_700_000_000_000,
        mtimeMs: 1_700_000_200_000,
        discoveredAtMs: 1_700_000_200_000
      }
    ])
    expect(nativeRepo.getDocumentPreview(1)?.extractionStatus).toBe('stale')
    expect(ocrRepo.getDocumentOcrState(1)?.ocrStatus).toBe('stale')
  })

  it('rejects stale OCR commits (REVISION_MISMATCH) and enforces format-group + model-pinned reuse', () => {
    const sourceRoot = join(tempDir, 'reuse-root')
    catalog.registerSource(sourceRoot)
    const pngPath = join(sourceRoot, 'receipt_a.png')
    const tiffPath = join(sourceRoot, 'receipt_b.tiff')
    const pdfPath = join(sourceRoot, 'scan.pdf')
    const sharedHash = 'd'.repeat(64)

    catalog.persistDiscoveryBatch(sourceRoot, [
      {
        originalPath: pngPath,
        fileName: 'receipt_a.png',
        extension: '.png',
        category: 'photo',
        byteSize: 2048,
        birthtimeMs: 1000,
        mtimeMs: 2000,
        discoveredAtMs: 3000
      },
      {
        originalPath: tiffPath,
        fileName: 'receipt_b.tiff',
        extension: '.tiff',
        category: 'photo',
        byteSize: 2048,
        birthtimeMs: 1000,
        mtimeMs: 2000,
        discoveredAtMs: 3000
      },
      {
        originalPath: pdfPath,
        fileName: 'scan.pdf',
        extension: '.pdf',
        category: 'document',
        byteSize: 2048,
        birthtimeMs: 1000,
        mtimeMs: 2000,
        discoveredAtMs: 3000
      }
    ])

    catalog.recordHashObservationsBatch([
      {
        originalPath: pngPath,
        sha256: sharedHash,
        observedByteSize: 2048,
        observedMtimeMs: 2000,
        hashedAtMs: 3100
      },
      {
        originalPath: tiffPath,
        sha256: sharedHash,
        observedByteSize: 2048,
        observedMtimeMs: 2000,
        hashedAtMs: 3100
      },
      {
        originalPath: pdfPath,
        sha256: sharedHash,
        observedByteSize: 2048,
        observedMtimeMs: 2000,
        hashedAtMs: 3100
      }
    ])

    const ocrRepo = catalog.getDocumentOcrRepository()
    const pngCand = ocrRepo.getDocumentOcrCandidate(1)!
    expect(pngCand.category).toBe('photo')

    // Commit OCR for receipt_a.png
    const commitOk = ocrRepo.upsertDocumentOcrExtraction({
      fileLocationId: 1,
      expectedDiscoveryObservationId: pngCand.discoveryObservationId,
      expectedContentRevision: pngCand.contentRevision,
      contentSha256: sharedHash,
      observedByteSize: 2048,
      observedMtimeMs: 2000,
      recipeVersion: DOCUMENT_OCR_RECIPE_VERSION,
      ocrModelId: OCR_MODEL_ID,
      ocrModelManifestSha256: PINNED_OCR_MANIFEST_SHA256,
      ocrLanguage: OCR_MODEL_LANGUAGE,
      extractionMethod: 'ocr_image_tesseract',
      ocrStatus: 'extracted',
      statusDetail: null,
      extractedText: 'RECEIPT TOTAL 19.99',
      extractedCharCount: 19,
      pageCount: 1,
      ocrPageCount: 1,
      nativeOnlyPageCount: 0,
      skippedBlankPageCount: 0,
      meanConfidence: 89,
      truncated: false,
      truncationReason: null
    })
    expect(commitOk.committed).toBe(true)

    // Compatible reuse within raster_image_ocr group (.png -> .tiff) succeeds
    const reusableForTiff = ocrRepo.findReusableDocumentOcrExtraction({
      contentSha256: sharedHash,
      recipeVersion: DOCUMENT_OCR_RECIPE_VERSION,
      ocrModelId: OCR_MODEL_ID,
      ocrModelManifestSha256: PINNED_OCR_MANIFEST_SHA256,
      ocrLanguage: OCR_MODEL_LANGUAGE,
      targetExtension: '.tiff'
    })
    expect(reusableForTiff).not.toBeNull()
    expect(reusableForTiff?.extractedText).toBe('RECEIPT TOTAL 19.99')

    // Cross-group reuse (.png -> .pdf) MUST return null
    const crossGroupForPdf = ocrRepo.findReusableDocumentOcrExtraction({
      contentSha256: sharedHash,
      recipeVersion: DOCUMENT_OCR_RECIPE_VERSION,
      ocrModelId: OCR_MODEL_ID,
      ocrModelManifestSha256: PINNED_OCR_MANIFEST_SHA256,
      ocrLanguage: OCR_MODEL_LANGUAGE,
      targetExtension: '.pdf'
    })
    expect(crossGroupForPdf).toBeNull()

    // Different model manifest MUST return null
    const differentManifestReuse = ocrRepo.findReusableDocumentOcrExtraction({
      contentSha256: sharedHash,
      recipeVersion: DOCUMENT_OCR_RECIPE_VERSION,
      ocrModelId: OCR_MODEL_ID,
      ocrModelManifestSha256: '1'.repeat(64),
      ocrLanguage: OCR_MODEL_LANGUAGE,
      targetExtension: '.png'
    })
    expect(differentManifestReuse).toBeNull()

    // Stale commit rejection: advance scan.pdf observation before committing stale snapshot
    const pdfStaleCand = ocrRepo.getDocumentOcrCandidate(3)!
    catalog.persistDiscoveryBatch(sourceRoot, [
      {
        originalPath: pdfPath,
        fileName: 'scan.pdf',
        extension: '.pdf',
        category: 'document',
        byteSize: 4096,
        birthtimeMs: 1000,
        mtimeMs: 5000,
        discoveredAtMs: 5000
      }
    ])

    const staleCommit = ocrRepo.upsertDocumentOcrExtraction({
      fileLocationId: 3,
      expectedDiscoveryObservationId: pdfStaleCand.discoveryObservationId,
      expectedContentRevision: pdfStaleCand.contentRevision,
      contentSha256: sharedHash,
      observedByteSize: 2048,
      observedMtimeMs: 2000,
      recipeVersion: DOCUMENT_OCR_RECIPE_VERSION,
      ocrModelId: OCR_MODEL_ID,
      ocrModelManifestSha256: PINNED_OCR_MANIFEST_SHA256,
      ocrLanguage: OCR_MODEL_LANGUAGE,
      extractionMethod: 'ocr_pdf_tesseract',
      ocrStatus: 'extracted',
      statusDetail: null,
      extractedText: 'STALE TEXT',
      extractedCharCount: 10,
      pageCount: 1,
      ocrPageCount: 1,
      nativeOnlyPageCount: 0,
      skippedBlankPageCount: 0,
      meanConfidence: 80,
      truncated: false,
      truncationReason: null
    })
    expect(staleCommit).toEqual({ committed: false, reason: 'REVISION_MISMATCH' })
    expect(ocrRepo.getDocumentOcrState(3)?.ocrStatus).toBe('not_processed')
  })

  it('scopes ocr_needed conservatively, allows selected document images, and NEVER bulk-OCRs ordinary photos', async () => {
    const sourceRoot = join(tempDir, 'scope-root')
    catalog.registerSource(sourceRoot)

    const now = 1_700_000_000_000
    const mib = 1024 * 1024
    catalog.persistDiscoveryBatch(sourceRoot, [
      {
        originalPath: join(sourceRoot, 'digital_clean.pdf'),
        fileName: 'digital_clean.pdf',
        extension: '.pdf',
        category: 'document',
        byteSize: 10_000,
        birthtimeMs: now,
        mtimeMs: now,
        discoveredAtMs: now
      },
      {
        originalPath: join(sourceRoot, 'scanned_only.pdf'),
        fileName: 'scanned_only.pdf',
        extension: '.pdf',
        category: 'document',
        byteSize: 20_000,
        birthtimeMs: now,
        mtimeMs: now,
        discoveredAtMs: now
      },
      {
        originalPath: join(sourceRoot, 'mixed_header_scan.pdf'),
        fileName: 'mixed_header_scan.pdf',
        extension: '.pdf',
        category: 'document',
        byteSize: 30_000,
        birthtimeMs: now,
        mtimeMs: now,
        discoveredAtMs: now
      },
      {
        originalPath: join(sourceRoot, 'large_scan_40mib.pdf'),
        fileName: 'large_scan_40mib.pdf',
        extension: '.pdf',
        category: 'document',
        byteSize: 40 * mib,
        birthtimeMs: now,
        mtimeMs: now,
        discoveredAtMs: now
      },
      {
        originalPath: join(sourceRoot, 'oversize_70mib.pdf'),
        fileName: 'oversize_70mib.pdf',
        extension: '.pdf',
        category: 'document',
        byteSize: 70 * mib,
        birthtimeMs: now,
        mtimeMs: now,
        discoveredAtMs: now
      },
      {
        originalPath: join(sourceRoot, 'ordinary_vacation.jpg'),
        fileName: 'ordinary_vacation.jpg',
        extension: '.jpg',
        category: 'photo',
        byteSize: 500_000,
        birthtimeMs: now,
        mtimeMs: now,
        discoveredAtMs: now
      },
      {
        originalPath: join(sourceRoot, 'selected_receipt.png'),
        fileName: 'selected_receipt.png',
        extension: '.png',
        category: 'photo',
        byteSize: 250_000,
        birthtimeMs: now,
        mtimeMs: now,
        discoveredAtMs: now
      }
    ])

    const nativeRepo = catalog.getDocumentRepository()
    const ocrRepo = catalog.getDocumentOcrRepository()

    // Seed native extraction statuses for the PDFs
    const seedNative = (
      id: number,
      status: 'extracted' | 'no_text_ocr_required' | 'truncated',
      ocrCandidatePageCount: number | null
    ) => {
      const c = nativeRepo.getDocumentExtractionCandidate(id)!
      nativeRepo.upsertDocumentExtraction({
        fileLocationId: id,
        expectedDiscoveryObservationId: c.discoveryObservationId,
        expectedContentRevision: c.contentRevision,
        contentSha256: String(id).repeat(64).slice(0, 64),
        observedByteSize: c.byteSize,
        observedMtimeMs: c.filesystemMtimeMs,
        recipeVersion: DOCUMENT_EXTRACTION_RECIPE_VERSION,
        extractionStatus: status,
        statusDetail: null,
        extractedText: status === 'extracted' ? 'Native text' : null,
        extractedCharCount: status === 'extracted' ? 11 : 0,
        pageCount: 1,
        ocrCandidatePageCount,
        truncated: status === 'truncated',
        truncationReason: status === 'truncated' ? 'Exceeded 32 MiB native limit' : null,
        detectedEncoding: null
      })
    }

    seedNative(1, 'extracted', 0) // digital_clean.pdf -> no OCR needed
    seedNative(2, 'no_text_ocr_required', 1) // scanned_only.pdf -> OCR needed
    seedNative(3, 'extracted', 1) // mixed_header_scan.pdf -> OCR needed!
    seedNative(4, 'truncated', null) // large_scan_40mib.pdf (32..64 MiB) -> OCR needed!
    seedNative(5, 'truncated', null) // oversize_70mib.pdf (> 64 MiB) -> skipped in ocr_needed

    // 1. Bulk ocr_needed scope: queues ONLY [2, 3, 4]; ZERO photos queued!
    const neededJob = await ocrRepo.createDocumentOcrJob({
      jobId: 'ocr-needed-1',
      scopeKind: 'ocr_needed',
      recipeVersion: DOCUMENT_OCR_RECIPE_VERSION,
      ocrModelId: OCR_MODEL_ID,
      ocrModelManifestSha256: PINNED_OCR_MANIFEST_SHA256,
      ocrLanguage: OCR_MODEL_LANGUAGE
    })
    const neededItems = ocrRepo.getNextPendingDocumentOcrJobItems(neededJob.id, 20)
    expect(neededItems.map((i) => i.fileLocationId)).toEqual([2, 3, 4])

    // 2. Bulk 'all' and 'filtered' scopes: NEVER queue category='photo' items (6, 7)!
    const allDocsJob = await ocrRepo.createDocumentOcrJob({
      jobId: 'ocr-all-docs-1',
      scopeKind: 'all',
      recipeVersion: DOCUMENT_OCR_RECIPE_VERSION,
      ocrModelId: OCR_MODEL_ID,
      ocrModelManifestSha256: PINNED_OCR_MANIFEST_SHA256,
      ocrLanguage: OCR_MODEL_LANGUAGE
    })
    const allDocsItems = ocrRepo.getNextPendingDocumentOcrJobItems(allDocsJob.id, 20)
    expect(allDocsItems.map((i) => i.fileLocationId)).toEqual([1, 2, 3, 4, 5])
    expect(allDocsItems.some((i) => i.fileLocationId === 6 || i.fileLocationId === 7)).toBe(false)

    // 3. Explicit 'selected' scope: allows explicitly selected document image (7) + document (2),
    // deduplicating IDs while leaving unselected ordinary photo (6) unqueued!
    const selectedJob = await ocrRepo.createDocumentOcrJob({
      jobId: 'ocr-selected-1',
      scopeKind: 'selected',
      fileLocationIds: [7, 2, 7],
      recipeVersion: DOCUMENT_OCR_RECIPE_VERSION,
      ocrModelId: OCR_MODEL_ID,
      ocrModelManifestSha256: PINNED_OCR_MANIFEST_SHA256,
      ocrLanguage: OCR_MODEL_LANGUAGE
    })
    const selectedItems = ocrRepo.getNextPendingDocumentOcrJobItems(selectedJob.id, 20)
    expect(selectedItems.map((i) => i.fileLocationId)).toEqual([2, 7])
  })

  it('discards incomplete OCR scope snapshots (snapshot_complete = 0) on startup while marking complete running jobs interrupted', async () => {
    const sourceRoot = join(tempDir, 'crash-ocr-scope')
    catalog.registerSource(sourceRoot)
    const now = Date.now()
    catalog.persistDiscoveryBatch(sourceRoot, [
      {
        originalPath: join(sourceRoot, 'scan1.pdf'),
        fileName: 'scan1.pdf',
        extension: '.pdf',
        category: 'document',
        byteSize: 1000,
        birthtimeMs: now,
        mtimeMs: now,
        discoveredAtMs: now
      },
      {
        originalPath: join(sourceRoot, 'scan2.pdf'),
        fileName: 'scan2.pdf',
        extension: '.pdf',
        category: 'document',
        byteSize: 2000,
        birthtimeMs: now,
        mtimeMs: now,
        discoveredAtMs: now
      },
      {
        originalPath: join(sourceRoot, 'scan3.pdf'),
        fileName: 'scan3.pdf',
        extension: '.pdf',
        category: 'document',
        byteSize: 3000,
        birthtimeMs: now,
        mtimeMs: now,
        discoveredAtMs: now
      }
    ])

    // Create one complete running job first (snapshot_complete = 1)
    const completeJob = await catalog.getDocumentOcrRepository().createDocumentOcrJob({
      jobId: 'complete-running-ocr-job',
      scopeKind: 'all',
      recipeVersion: DOCUMENT_OCR_RECIPE_VERSION,
      ocrModelId: OCR_MODEL_ID,
      ocrModelManifestSha256: PINNED_OCR_MANIFEST_SHA256,
      ocrLanguage: OCR_MODEL_LANGUAGE
    })
    expect(completeJob.snapshotComplete).toBe(true)
    expect(completeJob.status).toBe('running')
    catalog.close()

    // Spawn a child process that crashes mid-snapshot (batchSize = 1 -> exit(42) on batch 1)
    const childEntryTs = join(tempDir, 'child-crash-ocr-snapshot.ts')
    const childBundleCjs = join(tempDir, 'child-crash-ocr-snapshot.cjs')
    writeFileSync(
      childEntryTs,
      `import { CatalogDatabase } from ${JSON.stringify(resolve(__dirname, '../../src/main/services/catalog/database.ts'))};
       async function main() {
         const catalog = CatalogDatabase.open({ catalogPath: ${JSON.stringify(dbPath)} });
         const repo = catalog.getDocumentOcrRepository();
         await repo.createDocumentOcrJob({
           jobId: 'crashed-ocr-scope-job',
           scopeKind: 'all',
           recipeVersion: 'doc_ocr_v1',
           ocrModelId: ${JSON.stringify(OCR_MODEL_ID)},
           ocrModelManifestSha256: ${JSON.stringify(PINNED_OCR_MANIFEST_SHA256)},
           ocrLanguage: 'eng',
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

    catalog = CatalogDatabase.open({ catalogPath: dbPath })
    const rawDb = catalog.getRawDatabaseForTesting()
    const crashedBefore = rawDb
      .prepare(
        "SELECT id, snapshot_complete FROM document_ocr_jobs WHERE id = 'crashed-ocr-scope-job';"
      )
      .get() as { id: string; snapshot_complete: number } | undefined
    expect(crashedBefore?.snapshot_complete).toBe(0)

    // Startup recovery deletes snapshot_complete=0 job & tmp files, and marks complete running job interrupted
    catalog.getDocumentOcrRepository().markRunningDocumentOcrJobsAsInterrupted()

    const crashedAfter = rawDb
      .prepare("SELECT id FROM document_ocr_jobs WHERE id = 'crashed-ocr-scope-job';")
      .get()
    expect(crashedAfter).toBeUndefined()
    expect(readdirSync(tempDir).filter((f) => f.includes('.ocr-snapshot-'))).toEqual([])

    const interruptedJob = catalog
      .getDocumentOcrRepository()
      .getDocumentOcrJob('complete-running-ocr-job')
    expect(interruptedJob?.status).toBe('interrupted')
    expect(interruptedJob?.pendingItems).toBe(3)
  })
})
