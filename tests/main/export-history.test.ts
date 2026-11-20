// @vitest-environment node
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CatalogDatabase,
  CURRENT_SCHEMA_VERSION,
  MIGRATIONS,
  UnsupportedSchemaVersionError,
  type ExportJobItemRecord,
  type ExportJobRecord
} from '../../src/main/services/catalog'
import {
  EXPORT_COMPLETE_MARKER,
  EXPORT_IN_PROGRESS_MARKER,
  EXPORT_MANIFEST_FILENAME,
  type ExportBundleResult,
  type ExportItemInput
} from '../../src/main/services/export'

function sha256Bytes(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

function seedCatalogLocation(
  catalog: CatalogDatabase,
  sourceRoot: string,
  filePath: string,
  content: Buffer,
  category: 'photo' | 'document' = 'photo'
): {
  fileLocationId: number
  discoveryObservationId: number
  hashObservationId: number
  sha256: string
  byteSize: number
  filesystemBirthtimeMs: number | null
  filesystemMtimeMs: number | null
} {
  const db = catalog.getRawDb()
  const now = Date.now()
  const sha = sha256Bytes(content)
  const fileName = filePath.split(/[\\/]/).pop() ?? 'file.bin'
  const ext = fileName.includes('.') ? `.${fileName.split('.').pop()}` : ''
  const st = statSync(filePath)
  const filesystemBirthtimeMs = st.birthtimeMs
  const filesystemMtimeMs = st.mtimeMs

  const existingSource = db
    .prepare('SELECT id FROM sources WHERE normalized_root_path = ?;')
    .get(sourceRoot.toLowerCase()) as { id: number } | undefined

  const sourceId = existingSource
    ? existingSource.id
    : Number(
        db
          .prepare(
            'INSERT INTO sources (root_path, normalized_root_path, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?);'
          )
          .run(sourceRoot, sourceRoot.toLowerCase(), now, now).lastInsertRowid
      )

  const fileLocationId = Number(
    db
      .prepare(
        `INSERT INTO file_locations (
          source_id, original_path, normalized_path, file_name, extension, category,
          created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);`
      )
      .run(sourceId, filePath, filePath.toLowerCase(), fileName, ext, category, now, now)
      .lastInsertRowid
  )

  const discoveryObservationId = Number(
    db
      .prepare(
        `INSERT INTO discovery_observations (
          file_location_id, byte_size, filesystem_birthtime_ms, filesystem_mtime_ms,
          observed_at_ms, last_seen_at_ms, is_current
        ) VALUES (?, ?, ?, ?, ?, ?, 1);`
      )
      .run(fileLocationId, content.byteLength, filesystemBirthtimeMs, filesystemMtimeMs, now, now)
      .lastInsertRowid
  )

  const hashObservationId = Number(
    db
      .prepare(
        `INSERT INTO hash_observations (
          file_location_id, discovery_observation_id, sha256, observed_byte_size,
          observed_mtime_ms, hashed_at_ms, is_active
        ) VALUES (?, ?, ?, ?, ?, ?, 1);`
      )
      .run(
        fileLocationId,
        discoveryObservationId,
        sha,
        content.byteLength,
        filesystemMtimeMs,
        now + 10
      ).lastInsertRowid
  )

  return {
    fileLocationId,
    discoveryObservationId,
    hashObservationId,
    sha256: sha,
    byteSize: content.byteLength,
    filesystemBirthtimeMs,
    filesystemMtimeMs
  }
}

function buildExportItemInput(
  seeded: ReturnType<typeof seedCatalogLocation>,
  filePath: string,
  fileName: string,
  extension: string,
  category: 'photo' | 'document' = 'photo'
): ExportItemInput {
  const now = Date.now()
  return {
    fileLocationId: seeded.fileLocationId,
    discoveryObservationId: seeded.discoveryObservationId,
    hashObservationId: seeded.hashObservationId,
    originalPath: filePath,
    fileName,
    extension,
    category,
    recordedFacts: {
      byteSize: seeded.byteSize,
      filesystemBirthtimeMs: seeded.filesystemBirthtimeMs,
      filesystemMtimeMs: seeded.filesystemMtimeMs,
      firstDiscoveredAtMs: now - 500,
      lastSeenAtMs: now - 100,
      hashVerifiedAtMs: now
    },
    expectedSha256: seeded.sha256,
    vaultCopy: null,
    machineGenerated:
      category === 'photo'
        ? {
            kind: 'photo',
            metadataStatus: 'no_metadata',
            parserRecipeVersion: null,
            detectedFormat: 'jpeg',
            extensionFormatMismatch: false,
            encodedWidthPx: null,
            encodedHeightPx: null,
            exifOrientation: null,
            displayWidthPx: null,
            displayHeightPx: null,
            inferredCaptureDate: null,
            cameraDisplay: null,
            lensDisplay: null,
            dhash64: null
          }
        : {
            kind: 'document',
            nativeExtraction: {
              status: 'extracted',
              recipeVersion: 'doc_extract_v1',
              pageCount: 1,
              charCount: 12,
              truncated: false,
              text: 'secret text'
            },
            ocrExtraction: {
              status: 'not_processed',
              method: null,
              modelId: null,
              language: null,
              meanConfidence: null,
              truncated: false,
              text: null
            },
            automaticClassification: null
          },
    userOverridesAndAnnotations:
      category === 'photo'
        ? {
            kind: 'photo',
            rating: 4,
            flag: 'pick',
            collections: [],
            duplicateReview: null
          }
        : {
            kind: 'document',
            classificationOverride: null,
            effectiveClassification: {
              purposeLabels: [],
              originLabels: [],
              isClutter: false,
              resolvedFrom: 'unclassified'
            },
            duplicateReview: null
          }
  }
}

describe('Stage 8A Slice 2: Migration 16 & ExportRepository', () => {
  let tempRoot: string
  let dbPath: string
  let sourceRoot: string
  let vaultRoot: string
  let exportParentDir: string
  let userDataDir: string

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'pv-export-history-'))
    dbPath = join(tempRoot, 'catalog.sqlite')
    sourceRoot = join(tempRoot, 'sources')
    vaultRoot = join(tempRoot, 'vault')
    exportParentDir = join(tempRoot, 'exports')
    userDataDir = join(tempRoot, 'userdata')
    mkdirSync(sourceRoot, { recursive: true })
    mkdirSync(vaultRoot, { recursive: true })
    mkdirSync(exportParentDir, { recursive: true })
    mkdirSync(userDataDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true })
  })

  it('creates Migration 16 tables on a fresh database and sets CURRENT_SCHEMA_VERSION = 16', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(16)
    const catalog = CatalogDatabase.open({ catalogPath: dbPath })
    try {
      const versionRow = catalog
        .getRawDb()
        .prepare('SELECT MAX(version) AS max_version FROM schema_migrations;')
        .get() as { max_version: number }
      expect(versionRow.max_version).toBe(16)

      const tables = catalog
        .getRawDb()
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('export_jobs', 'export_job_items') ORDER BY name;"
        )
        .all() as Array<{ name: string }>
      expect(tables.map((t) => t.name)).toEqual(['export_job_items', 'export_jobs'])
    } finally {
      catalog.close()
    }
  })

  it('upgrades a schema 15 database with existing data to schema 16 and rejects future versions', () => {
    // Build a schema 15 database using migrations 1..15
    const raw = new DatabaseSync(dbPath)
    raw.exec('PRAGMA foreign_keys = ON;')
    raw.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        applied_at_ms INTEGER NOT NULL
      );
    `)
    for (const m of MIGRATIONS.filter((mig) => mig.version <= 15)) {
      raw.exec('PRAGMA foreign_keys = OFF;')
      raw.exec('BEGIN TRANSACTION;')
      m.up(raw)
      raw
        .prepare('INSERT INTO schema_migrations (version, name, applied_at_ms) VALUES (?, ?, ?);')
        .run(m.version, m.name, 1000)
      raw.exec('COMMIT;')
      raw.exec('PRAGMA foreign_keys = ON;')
    }

    // Seed existing v15 data
    try {
      raw
        .prepare(
          'INSERT INTO sources (root_path, normalized_root_path, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?);'
        )
        .run(sourceRoot, sourceRoot.toLowerCase(), 1000, 1000)
      raw
        .prepare(
          `INSERT INTO file_locations (
            source_id, original_path, normalized_path, file_name, extension, category,
            created_at_ms, updated_at_ms
          ) VALUES (1, ?, ?, 'v15.jpg', '.jpg', 'photo', 1000, 1000);`
        )
        .run(join(sourceRoot, 'v15.jpg'), join(sourceRoot, 'v15.jpg').toLowerCase())
    } finally {
      raw.close()
    }

    // Reopen with CatalogDatabase (should apply Migration 16)
    const catalog = CatalogDatabase.open({ catalogPath: dbPath })
    try {
      const versionRow = catalog
        .getRawDb()
        .prepare('SELECT MAX(version) AS max_version FROM schema_migrations;')
        .get() as { max_version: number }
      expect(versionRow.max_version).toBe(16)

      const existingLoc = catalog
        .getRawDb()
        .prepare('SELECT id, file_name FROM file_locations WHERE id = 1;')
        .get() as { id: number; file_name: string } | undefined
      expect(existingLoc?.file_name).toBe('v15.jpg')

      const repo = catalog.getExportRepository()
      const job = repo.createExportJob({
        id: 'job-after-upgrade',
        bundleDir: join(exportParentDir, 'upgrade-bundle'),
        bundleFolderName: 'upgrade-bundle',
        items: [
          {
            fileLocationId: 1,
            discoveryObservationId: 1,
            hashObservationId: 1,
            category: 'photo',
            originalFileName: 'v15.jpg',
            expectedSha256: 'a'.repeat(64),
            expectedByteSize: 123
          }
        ]
      })
      expect(job.status).toBe('running')
      expect(job.privacyOptions).toEqual({
        includeOriginalPaths: false,
        includeExtractedText: false
      })
    } finally {
      catalog.close()
    }

    // Future schema rejection
    const futureDbPath = join(tempRoot, 'future.sqlite')
    const futureRaw = new DatabaseSync(futureDbPath)
    futureRaw.exec(
      'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL, applied_at_ms INTEGER NOT NULL);'
    )
    futureRaw
      .prepare('INSERT INTO schema_migrations (version, name, applied_at_ms) VALUES (?, ?, ?);')
      .run(999, 'future_schema', 1000)
    futureRaw.close()

    expect(() => CatalogDatabase.open({ catalogPath: futureDbPath })).toThrow(
      UnsupportedSchemaVersionError
    )
  })

  it('persists verified export job history, privacy defaults, and per-item outcomes across database reopen while keeping source files read-only', async () => {
    const photoBytes = Buffer.from('photo-bytes-1')
    const docBytes = Buffer.from('secret text')
    const photoPath = join(sourceRoot, 'trip.jpg')
    const docPath = join(sourceRoot, 'notes.txt')
    writeFileSync(photoPath, photoBytes)
    writeFileSync(docPath, docBytes)

    const catalog = CatalogDatabase.open({ catalogPath: dbPath })
    try {
      const repo = catalog.getExportRepository()

      const s1 = seedCatalogLocation(catalog, sourceRoot, photoPath, photoBytes, 'photo')
      const s2 = seedCatalogLocation(catalog, sourceRoot, docPath, docBytes, 'document')

      const { result, job } = await repo.runExportWithHistory({
        exportJobId: 'job-verified-1',
        parentDir: exportParentDir,
        bundleFolderName: 'bundle-verified-1',
        sourceRoots: [sourceRoot],
        vaultRoots: [vaultRoot],
        userDataDir,
        vaultPath: vaultRoot,
        appVersion: '0.1.0',
        privacyOptions: {
          includeOriginalPaths: false,
          includeExtractedText: false
        },
        items: [
          buildExportItemInput(s1, photoPath, 'trip.jpg', '.jpg', 'photo'),
          buildExportItemInput(s2, docPath, 'notes.txt', '.txt', 'document')
        ]
      })

      expect(result.status).toBe('completed')
      expect(job.status).toBe('completed')
      expect(job.bundleVerified).toBe(true)
      expect(job.manifestPublished).toBe(true)
      expect(job.incompleteReasons).toEqual([])
      expect(job.exportedItems).toBe(2)
      expect(job.failedItems).toBe(0)
      expect(job.cancelledItems).toBe(0)
      expect(job.privacyOptions).toEqual({
        includeOriginalPaths: false,
        includeExtractedText: false
      })
    } finally {
      catalog.close()
    }

    // Reopen database and verify persistence
    const reopened = CatalogDatabase.open({ catalogPath: dbPath })
    try {
      const reopenedRepo = reopened.getExportRepository()
      const loaded = reopenedRepo.getExportJob('job-verified-1')
      expect(loaded).not.toBeNull()
      expect(loaded?.status).toBe('completed')
      expect(loaded?.bundleVerified).toBe(true)
      expect(loaded?.exportedItems).toBe(2)

      const list = reopenedRepo.listExportJobs({ limit: 10, offset: 0 })
      expect(list.total).toBe(1)
      expect(list.items[0]?.id).toBe('job-verified-1')

      const items = reopenedRepo.getExportJobItems('job-verified-1')
      expect(items.total).toBe(2)
      expect(items.items.every((i) => i.status === 'completed')).toBe(true)
      expect(items.items.map((i) => i.exportedFileName)).toEqual(['trip.jpg', 'notes.txt'])
      expect(items.items.map((i) => i.sidecarFileName)).toEqual([
        'trip.jpg.pv-meta.json',
        'notes.txt.pv-meta.json'
      ])
    } finally {
      reopened.close()
    }

    // Verify source files remain untouched byte-for-byte
    expect(readFileSync(photoPath)).toEqual(photoBytes)
    expect(readFileSync(docPath)).toEqual(docBytes)
  })

  it('never claims a completed bundle in history if the export core completion check fails', async () => {
    const photoBytes = Buffer.from('photo-for-tamper-check')
    const photoPath = join(sourceRoot, 'check.jpg')
    writeFileSync(photoPath, photoBytes)

    const catalog = CatalogDatabase.open({ catalogPath: dbPath })
    try {
      const repo = catalog.getExportRepository()
      const s1 = seedCatalogLocation(catalog, sourceRoot, photoPath, photoBytes, 'photo')

      const bundleDir = join(exportParentDir, 'incomplete-bundle')
      mkdirSync(bundleDir, { recursive: true })
      // Create an in-progress marker (missing completion marker & manifest)
      writeFileSync(join(bundleDir, EXPORT_IN_PROGRESS_MARKER), '{}')

      repo.createExportJob({
        id: 'job-tampered-1',
        bundleDir,
        bundleFolderName: 'incomplete-bundle',
        items: [
          {
            fileLocationId: s1.fileLocationId,
            discoveryObservationId: s1.discoveryObservationId,
            hashObservationId: s1.hashObservationId,
            category: 'photo',
            originalFileName: 'check.jpg',
            expectedSha256: s1.sha256,
            expectedByteSize: s1.byteSize
          }
        ]
      })

      const falseClaimResult: ExportBundleResult = {
        exportJobId: 'job-tampered-1',
        bundleDir,
        status: 'completed',
        manifestPublished: true,
        totalItems: 1,
        exportedItems: 1,
        failedItems: 0,
        cancelledItems: 0,
        vaultIntegrityWarnings: 0,
        errorCode: null,
        errorMessage: null,
        itemOutcomes: [
          {
            fileLocationId: s1.fileLocationId,
            status: 'completed',
            exportedFileName: 'check.jpg',
            sidecarFileName: 'check.jpg.pv-meta.json',
            byteSourceUsed: 'source_file',
            vaultIntegrityWarning: null,
            errorCode: null,
            errorMessage: null
          }
        ]
      }

      const finalized = repo.finalizeExportJob({ result: falseClaimResult })
      expect(finalized.status).toBe('failed')
      expect(finalized.bundleVerified).toBe(false)
      expect(finalized.incompleteReasons).toContain('in_progress_marker_present')
      expect(finalized.incompleteReasons).toContain('completion_marker_missing')
      expect(finalized.incompleteReasons).toContain('manifest_missing')

      // Also test verifyExportJobBundleOnDisk when a previously verified bundle loses its completion marker
      const validResult = await repo.runExportWithHistory({
        exportJobId: 'job-valid-then-broken',
        parentDir: exportParentDir,
        bundleFolderName: 'valid-then-broken',
        sourceRoots: [sourceRoot],
        vaultRoots: [vaultRoot],
        userDataDir,
        vaultPath: vaultRoot,
        appVersion: '0.1.0',
        privacyOptions: { includeOriginalPaths: false, includeExtractedText: false },
        items: [buildExportItemInput(s1, photoPath, 'check.jpg', '.jpg', 'photo')]
      })
      expect(validResult.job.status).toBe('completed')
      expect(validResult.job.bundleVerified).toBe(true)

      unlinkSync(join(validResult.result.bundleDir, EXPORT_COMPLETE_MARKER))
      const rechecked = repo.verifyExportJobBundleOnDisk('job-valid-then-broken')
      expect(rechecked?.status).toBe('failed')
      expect(rechecked?.bundleVerified).toBe(false)
      expect(rechecked?.incompleteReasons).toContain('completion_marker_missing')
    } finally {
      catalog.close()
    }
  })

  it('persists partial failure and cancellation outcomes accurately', async () => {
    const okBytes = Buffer.from('ok-photo')
    const okPath = join(sourceRoot, 'ok.jpg')
    const missingPath = join(sourceRoot, 'missing.jpg')
    writeFileSync(okPath, okBytes)

    const catalog = CatalogDatabase.open({ catalogPath: dbPath })
    try {
      const repo = catalog.getExportRepository()
      const sOk = seedCatalogLocation(catalog, sourceRoot, okPath, okBytes, 'photo')

      const missingBytes = Buffer.from('missing-photo')
      writeFileSync(missingPath, missingBytes)
      const sMissing = seedCatalogLocation(catalog, sourceRoot, missingPath, missingBytes, 'photo')
      unlinkSync(missingPath)

      // Partial failure: 1 ok + 1 missing
      const partial = await repo.runExportWithHistory({
        exportJobId: 'job-partial-fail',
        parentDir: exportParentDir,
        bundleFolderName: 'partial-fail-bundle',
        sourceRoots: [sourceRoot],
        vaultRoots: [vaultRoot],
        userDataDir,
        vaultPath: vaultRoot,
        appVersion: '0.1.0',
        privacyOptions: { includeOriginalPaths: false, includeExtractedText: false },
        items: [
          buildExportItemInput(sOk, okPath, 'ok.jpg', '.jpg', 'photo'),
          buildExportItemInput(sMissing, missingPath, 'missing.jpg', '.jpg', 'photo')
        ]
      })

      expect(partial.job.status).toBe('completed')
      expect(partial.job.bundleVerified).toBe(true)
      expect(partial.job.exportedItems).toBe(1)
      expect(partial.job.failedItems).toBe(1)

      const partialItems = repo.getExportJobItems('job-partial-fail')
      const failedItem = partialItems.items.find(
        (i) => i.fileLocationId === sMissing.fileLocationId
      )
      expect(failedItem?.status).toBe('failed')
      expect(failedItem?.errorCode).toBe('source_missing')

      // Cancellation mid-batch
      const secondBytes = Buffer.from('second-photo')
      const secondPath = join(sourceRoot, 'second.jpg')
      writeFileSync(secondPath, secondBytes)
      const sSecond = seedCatalogLocation(catalog, sourceRoot, secondPath, secondBytes, 'photo')

      const controller = new AbortController()
      const cancelled = await repo.runExportWithHistory(
        {
          exportJobId: 'job-cancelled-1',
          parentDir: exportParentDir,
          bundleFolderName: 'cancelled-bundle',
          sourceRoots: [sourceRoot],
          vaultRoots: [vaultRoot],
          userDataDir,
          vaultPath: vaultRoot,
          appVersion: '0.1.0',
          privacyOptions: { includeOriginalPaths: false, includeExtractedText: false },
          items: [
            buildExportItemInput(sOk, okPath, 'ok.jpg', '.jpg', 'photo'),
            buildExportItemInput(sSecond, secondPath, 'second.jpg', '.jpg', 'photo')
          ],
          signal: controller.signal
        },
        {
          hooks: {
            onChunkReadHook: () => {
              controller.abort()
            }
          }
        }
      )

      expect(cancelled.job.status).toBe('cancelled')
      expect(cancelled.job.cancelledItems).toBeGreaterThanOrEqual(1)
      const cancelledItems = repo.getExportJobItems('job-cancelled-1', { status: 'cancelled' })
      expect(cancelledItems.total).toBeGreaterThanOrEqual(1)
      expect(cancelledItems.items[0]?.errorCode).toBe('cancelled')
    } finally {
      catalog.close()
    }
  })

  it('marks running jobs and pending items as interrupted on restart recovery and handles retry & duplicate updates idempotently', async () => {
    const b1 = Buffer.from('item-1')
    const b2 = Buffer.from('item-2')
    const p1 = join(sourceRoot, 'i1.jpg')
    const p2 = join(sourceRoot, 'i2.jpg')
    writeFileSync(p1, b1)
    writeFileSync(p2, b2)

    const catalog = CatalogDatabase.open({ catalogPath: dbPath })
    const s1 = seedCatalogLocation(catalog, sourceRoot, p1, b1, 'photo')
    const s2 = seedCatalogLocation(catalog, sourceRoot, p2, b2, 'photo')

    const repo = catalog.getExportRepository()
    const interruptedDir = join(exportParentDir, 'interrupted-bundle')
    mkdirSync(interruptedDir, { recursive: true })
    writeFileSync(join(interruptedDir, EXPORT_IN_PROGRESS_MARKER), '{}')
    writeFileSync(join(interruptedDir, EXPORT_MANIFEST_FILENAME), '{}') // invalid manifest

    repo.createExportJob({
      id: 'job-interrupted-1',
      bundleDir: interruptedDir,
      bundleFolderName: 'interrupted-bundle',
      items: [
        {
          fileLocationId: s1.fileLocationId,
          discoveryObservationId: s1.discoveryObservationId,
          hashObservationId: s1.hashObservationId,
          category: 'photo',
          originalFileName: 'i1.jpg',
          expectedSha256: s1.sha256,
          expectedByteSize: s1.byteSize
        },
        {
          fileLocationId: s2.fileLocationId,
          discoveryObservationId: s2.discoveryObservationId,
          hashObservationId: s2.hashObservationId,
          category: 'photo',
          originalFileName: 'i2.jpg',
          expectedSha256: s2.sha256,
          expectedByteSize: s2.byteSize
        }
      ]
    })

    // Record s1 outcome twice (duplicate update) — counts must not double
    const s1Outcome = {
      fileLocationId: s1.fileLocationId,
      status: 'completed' as const,
      exportedFileName: 'i1.jpg',
      sidecarFileName: 'i1.jpg.pv-meta.json',
      byteSourceUsed: 'source_file' as const,
      vaultIntegrityWarning: null,
      errorCode: null,
      errorMessage: null
    }
    repo.recordExportItemOutcome({ jobId: 'job-interrupted-1', outcome: s1Outcome })
    repo.recordExportItemOutcome({ jobId: 'job-interrupted-1', outcome: s1Outcome })

    const beforeCrash = repo.getExportJob('job-interrupted-1')
    expect(beforeCrash?.exportedItems).toBe(1)
    catalog.close()

    // Simulate app restart
    const restarted = CatalogDatabase.open({ catalogPath: dbPath })
    try {
      const restartedRepo = restarted.getExportRepository()
      const changed = restartedRepo.markRunningJobsAsInterrupted(999999)
      expect(changed).toBe(1)

      // Idempotent second call
      expect(restartedRepo.markRunningJobsAsInterrupted(1000000)).toBe(0)

      const recovered = restartedRepo.getExportJob('job-interrupted-1')
      expect(recovered?.status).toBe('interrupted')
      expect(recovered?.bundleVerified).toBe(false)
      expect(recovered?.completedAtMs).toBeNull()
      expect(recovered?.exportedItems).toBe(1)
      expect(recovered?.incompleteReasons).toContain('in_progress_marker_present')
      expect(recovered?.incompleteReasons).toContain('completion_marker_missing')

      const items = restartedRepo.getExportJobItems('job-interrupted-1')
      const item1 = items.items.find((i) => i.fileLocationId === s1.fileLocationId)
      const item2 = items.items.find((i) => i.fileLocationId === s2.fileLocationId)
      expect(item1?.status).toBe('completed')
      expect(item2?.status).toBe('interrupted')

      // Retry with a new jobId & new bundle folder preserves prior interrupted record
      const vaultRelPath = join('files', s1.sha256.slice(0, 2), s1.sha256, 'i1.jpg')
      const vaultFilePath = join(vaultRoot, vaultRelPath)
      mkdirSync(join(vaultRoot, 'files', s1.sha256.slice(0, 2), s1.sha256), { recursive: true })
      writeFileSync(vaultFilePath, b1)

      const itemWithVault = {
        ...buildExportItemInput(s1, p1, 'i1.jpg', '.jpg', 'photo'),
        vaultCopy: {
          relativePath: vaultRelPath,
          verifiedSha256: s1.sha256,
          verifiedByteSize: s1.byteSize
        }
      }

      const retried = await restartedRepo.runExportWithHistory({
        exportJobId: 'job-retried-1',
        parentDir: exportParentDir,
        bundleFolderName: 'retried-bundle-1',
        sourceRoots: [sourceRoot],
        vaultRoots: [vaultRoot],
        userDataDir,
        vaultPath: vaultRoot,
        appVersion: '0.1.0',
        privacyOptions: { includeOriginalPaths: false, includeExtractedText: false },
        items: [itemWithVault, buildExportItemInput(s2, p2, 'i2.jpg', '.jpg', 'photo')]
      })
      expect(retried.job.status).toBe('completed')
      expect(retried.job.bundleVerified).toBe(true)

      const allJobs = restartedRepo.listExportJobs({ limit: 10, offset: 0 })
      expect(allJobs.total).toBe(2)
      expect(allJobs.items.map((j) => j.id)).toContain('job-interrupted-1')
      expect(allJobs.items.map((j) => j.id)).toContain('job-retried-1')

      // Source and vault files remain read-only / byte-for-byte identical
      expect(readFileSync(p1)).toEqual(b1)
      expect(readFileSync(p2)).toEqual(b2)
      expect(readFileSync(vaultFilePath)).toEqual(b1)
    } finally {
      restarted.close()
    }
  })

  it('rejects duplicate fileLocationId in createExportJob without partial inserts', () => {
    const b1 = Buffer.from('dup-item')
    const p1 = join(sourceRoot, 'dup.jpg')
    writeFileSync(p1, b1)

    const catalog = CatalogDatabase.open({ catalogPath: dbPath })
    try {
      const s1 = seedCatalogLocation(catalog, sourceRoot, p1, b1, 'photo')
      const repo = catalog.getExportRepository()

      expect(() =>
        repo.createExportJob({
          id: 'job-dup-loc',
          bundleDir: join(exportParentDir, 'dup-bundle'),
          bundleFolderName: 'dup-bundle',
          items: [
            {
              fileLocationId: s1.fileLocationId,
              discoveryObservationId: s1.discoveryObservationId,
              hashObservationId: s1.hashObservationId,
              category: 'photo',
              originalFileName: 'dup.jpg',
              expectedSha256: s1.sha256,
              expectedByteSize: s1.byteSize
            },
            {
              fileLocationId: s1.fileLocationId,
              discoveryObservationId: s1.discoveryObservationId,
              hashObservationId: s1.hashObservationId,
              category: 'photo',
              originalFileName: 'dup.jpg',
              expectedSha256: s1.sha256,
              expectedByteSize: s1.byteSize
            }
          ]
        })
      ).toThrow(/Duplicate fileLocationId/)

      expect(repo.getExportJob('job-dup-loc')).toBeNull()
    } finally {
      catalog.close()
    }
  })

  it('recomputes job counters and marks pending items failed when runExportWithHistory throws on a rejected destination', async () => {
    const b1 = Buffer.from('rejected-dest-photo')
    const p1 = join(sourceRoot, 'rej.jpg')
    writeFileSync(p1, b1)

    const existingBundleDir = join(exportParentDir, 'already-exists')
    mkdirSync(existingBundleDir, { recursive: true })
    const sentinelPath = join(existingBundleDir, 'keep-me.txt')
    writeFileSync(sentinelPath, 'untouched sentinel')

    const catalog = CatalogDatabase.open({ catalogPath: dbPath })
    try {
      const s1 = seedCatalogLocation(catalog, sourceRoot, p1, b1, 'photo')
      const repo = catalog.getExportRepository()

      await expect(
        repo.runExportWithHistory({
          exportJobId: 'job-rejected-dest',
          parentDir: exportParentDir,
          bundleFolderName: 'already-exists',
          sourceRoots: [sourceRoot],
          vaultRoots: [vaultRoot],
          userDataDir,
          vaultPath: vaultRoot,
          appVersion: '0.1.0',
          privacyOptions: { includeOriginalPaths: false, includeExtractedText: false },
          items: [buildExportItemInput(s1, p1, 'rej.jpg', '.jpg', 'photo')]
        })
      ).rejects.toThrow()

      const failedJob = repo.getExportJob('job-rejected-dest')
      expect(failedJob).not.toBeNull()
      expect(failedJob?.status).toBe('failed')
      expect(failedJob?.manifestPublished).toBe(false)
      expect(failedJob?.bundleVerified).toBe(false)
      expect(failedJob?.totalItems).toBe(1)
      expect(failedJob?.exportedItems).toBe(0)
      expect(failedJob?.failedItems).toBe(1)
      expect(failedJob?.cancelledItems).toBe(0)
      expect(failedJob?.vaultIntegrityWarnings).toBe(0)

      const failedItems = repo.getExportJobItems('job-rejected-dest')
      expect(failedItems.total).toBe(1)
      expect(failedItems.items[0]?.status).toBe('failed')
      expect(failedItems.items[0]?.errorMessage).toBeTruthy()

      // Existing destination remains untouched
      expect(readFileSync(sentinelPath, 'utf8')).toBe('untouched sentinel')
    } finally {
      catalog.close()
    }

    // Verify again after reopening the database
    const reopened = CatalogDatabase.open({ catalogPath: dbPath })
    try {
      const reopenedRepo = reopened.getExportRepository()
      const loaded = reopenedRepo.getExportJob('job-rejected-dest')
      expect(loaded?.status).toBe('failed')
      expect(loaded?.manifestPublished).toBe(false)
      expect(loaded?.bundleVerified).toBe(false)
      expect(loaded?.failedItems).toBe(1)
      expect(loaded?.exportedItems).toBe(0)
      const loadedItems = reopenedRepo.getExportJobItems('job-rejected-dest')
      expect(loadedItems.items[0]?.status).toBe('failed')
    } finally {
      reopened.close()
    }
  })

  it('rejects late recordExportItemOutcome and finalizeExportJob calls on terminal jobs while preserving verifyExportJobBundleOnDisk', async () => {
    const b1 = Buffer.from('terminal-guard-photo')
    const p1 = join(sourceRoot, 'term.jpg')
    writeFileSync(p1, b1)

    const catalog = CatalogDatabase.open({ catalogPath: dbPath })
    try {
      const s1 = seedCatalogLocation(catalog, sourceRoot, p1, b1, 'photo')
      const repo = catalog.getExportRepository()

      const { result, job } = await repo.runExportWithHistory({
        exportJobId: 'job-terminal-completed',
        parentDir: exportParentDir,
        bundleFolderName: 'terminal-completed',
        sourceRoots: [sourceRoot],
        vaultRoots: [vaultRoot],
        userDataDir,
        vaultPath: vaultRoot,
        appVersion: '0.1.0',
        privacyOptions: { includeOriginalPaths: false, includeExtractedText: false },
        items: [buildExportItemInput(s1, p1, 'term.jpg', '.jpg', 'photo')]
      })
      expect(job.status).toBe('completed')

      // Late outcome update after finalization must be rejected without mutating
      expect(() =>
        repo.recordExportItemOutcome({
          jobId: 'job-terminal-completed',
          outcome: {
            fileLocationId: s1.fileLocationId,
            status: 'failed',
            exportedFileName: null,
            sidecarFileName: null,
            byteSourceUsed: null,
            vaultIntegrityWarning: null,
            errorCode: 'source_missing',
            errorMessage: 'late error'
          }
        })
      ).toThrow(/terminal/i)

      // Late finalization after finalization must be rejected without mutating
      expect(() =>
        repo.finalizeExportJob({
          result: { ...result, status: 'cancelled' }
        })
      ).toThrow(/terminal/i)

      const afterRejected = repo.getExportJob('job-terminal-completed')
      expect(afterRejected?.status).toBe('completed')
      expect(afterRejected?.exportedItems).toBe(1)
      expect(afterRejected?.failedItems).toBe(0)

      // Explicit on-disk revalidation remains preserved
      unlinkSync(join(result.bundleDir, EXPORT_COMPLETE_MARKER))
      const revalidated = repo.verifyExportJobBundleOnDisk('job-terminal-completed')
      expect(revalidated?.status).toBe('failed')
      expect(revalidated?.bundleVerified).toBe(false)

      // Interrupted job also rejects late outcome / finalization calls
      const interruptedDir = join(exportParentDir, 'terminal-interrupted')
      mkdirSync(interruptedDir, { recursive: true })
      repo.createExportJob({
        id: 'job-terminal-interrupted',
        bundleDir: interruptedDir,
        bundleFolderName: 'terminal-interrupted',
        items: [
          {
            fileLocationId: s1.fileLocationId,
            discoveryObservationId: s1.discoveryObservationId,
            hashObservationId: s1.hashObservationId,
            category: 'photo',
            originalFileName: 'term.jpg',
            expectedSha256: s1.sha256,
            expectedByteSize: s1.byteSize
          }
        ]
      })
      expect(repo.markRunningJobsAsInterrupted(123456)).toBe(1)

      expect(() =>
        repo.recordExportItemOutcome({
          jobId: 'job-terminal-interrupted',
          outcome: {
            fileLocationId: s1.fileLocationId,
            status: 'completed',
            exportedFileName: 'term.jpg',
            sidecarFileName: 'term.jpg.pv-meta.json',
            byteSourceUsed: 'source_file',
            vaultIntegrityWarning: null,
            errorCode: null,
            errorMessage: null
          }
        })
      ).toThrow(/terminal/i)

      expect(() =>
        repo.finalizeExportJob({
          result: {
            exportJobId: 'job-terminal-interrupted',
            bundleDir: interruptedDir,
            status: 'completed',
            manifestPublished: false,
            totalItems: 1,
            exportedItems: 1,
            failedItems: 0,
            cancelledItems: 0,
            vaultIntegrityWarnings: 0,
            errorCode: null,
            errorMessage: null,
            itemOutcomes: []
          }
        })
      ).toThrow(/terminal/i)

      const interruptedJob = repo.getExportJob('job-terminal-interrupted')
      expect(interruptedJob?.status).toBe('interrupted')
      expect(interruptedJob?.exportedItems).toBe(0)
      expect(repo.getExportJobItems('job-terminal-interrupted').items[0]?.status).toBe(
        'interrupted'
      )
    } finally {
      catalog.close()
    }
  })

  it('preserves terminal interrupted state and original error when runExportWithHistory catch runs after interruption', async () => {
    const b1 = Buffer.from('in-flight-interrupted-photo')
    const p1 = join(sourceRoot, 'inflight.jpg')
    writeFileSync(p1, b1)

    const catalog = CatalogDatabase.open({ catalogPath: dbPath })
    try {
      const s1 = seedCatalogLocation(catalog, sourceRoot, p1, b1, 'photo')
      const repo = catalog.getExportRepository()

      let postInterruptionJob: ExportJobRecord | null = null
      let postInterruptionItems: readonly ExportJobItemRecord[] = []
      let triggered = false

      await expect(
        repo.runExportWithHistory(
          {
            exportJobId: 'job-catch-after-interrupt',
            parentDir: exportParentDir,
            bundleFolderName: 'catch-after-interrupt',
            sourceRoots: [sourceRoot],
            vaultRoots: [vaultRoot],
            userDataDir,
            vaultPath: vaultRoot,
            appVersion: '0.1.0',
            privacyOptions: { includeOriginalPaths: false, includeExtractedText: false },
            items: [buildExportItemInput(s1, p1, 'inflight.jpg', '.jpg', 'photo')]
          },
          {
            hooks: {
              onChunkReadHook: () => {
                if (triggered) return
                triggered = true
                expect(repo.markRunningJobsAsInterrupted(777777)).toBe(1)
                postInterruptionJob = repo.getExportJob('job-catch-after-interrupt')
                postInterruptionItems = repo.getExportJobItems('job-catch-after-interrupt').items
              }
            }
          }
        )
      ).rejects.toThrow(/Cannot modify terminal export job/i)

      expect(triggered).toBe(true)
      const snapshotJob = postInterruptionJob as ExportJobRecord | null
      expect(snapshotJob).not.toBeNull()
      expect(snapshotJob?.status).toBe('interrupted')
      expect(postInterruptionItems).toHaveLength(1)
      expect(postInterruptionItems[0]?.status).toBe('interrupted')

      // Entire persisted job and item records must match their post-interruption snapshots
      expect(repo.getExportJob('job-catch-after-interrupt')).toEqual(snapshotJob)
      expect(repo.getExportJobItems('job-catch-after-interrupt').items).toEqual(
        postInterruptionItems
      )
    } finally {
      catalog.close()
    }
  })
})
