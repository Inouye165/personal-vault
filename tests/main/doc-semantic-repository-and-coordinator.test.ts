// @vitest-environment node
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
import {
  DEFAULT_DOC_SEMANTIC_COMPATIBILITY_SPEC,
  type DocSemanticCompatibilitySpec
} from '../../src/main/services/catalog/document-semantic-snapshot-query'
import {
  computeNormalizedTextSha256,
  DOC_SEMANTIC_EMBEDDING_DIMENSIONS,
  DocSemanticModelManager,
  DocumentSemanticCoordinator,
  DocumentSemanticWorkerRunner,
  l2NormalizeDocVector,
  normalizeDocumentText,
  type DocSemanticModelArtifactSpec
} from '../../src/main/services/documents/semantic'
import { DOCUMENT_EXTRACTION_RECIPE_VERSION } from '../../src/main/services/documents/types'
import {
  DOCUMENT_OCR_RECIPE_VERSION,
  OCR_MODEL_ID,
  OCR_MODEL_LANGUAGE,
  PINNED_OCR_MANIFEST_SHA256
} from '../../src/main/services/documents/ocr'
import { AppWorkerBudget } from '../../src/main/services/worker-budget'

const REPO_ROOT = resolve(__dirname, '../..')
const BUILT_SNAPSHOT_WORKER = join(REPO_ROOT, 'out', 'main', 'document_snapshot_worker.js')

function sha256Hex(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex')
}

function makeUnitVec(seed: number): Float32Array {
  const raw = new Float32Array(DOC_SEMANTIC_EMBEDDING_DIMENSIONS)
  raw[0] = Math.cos(seed)
  raw[1] = Math.sin(seed)
  raw[2] = 0.1
  return l2NormalizeDocVector(raw, DOC_SEMANTIC_EMBEDDING_DIMENSIONS)
}

function createSyntheticModel(dir: string): DocSemanticModelArtifactSpec[] {
  const files: Array<{ relativePath: string; content: Buffer }> = [
    { relativePath: 'config.json', content: Buffer.from('{"hidden_size":384}\n', 'utf8') },
    { relativePath: 'tokenizer.json', content: Buffer.from('{"version":"1.0"}\n', 'utf8') },
    {
      relativePath: 'tokenizer_config.json',
      content: Buffer.from('{"model_max_length":512}\n', 'utf8')
    },
    {
      relativePath: 'special_tokens_map.json',
      content: Buffer.from('{"cls_token":"[CLS]"}\n', 'utf8')
    },
    { relativePath: 'onnx/model_quantized.onnx', content: Buffer.from('SYNTH_ONNX_MODEL', 'utf8') }
  ]
  const specs: DocSemanticModelArtifactSpec[] = []
  for (const f of files) {
    const abs = join(dir, f.relativePath)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, f.content)
    specs.push({
      relativePath: f.relativePath,
      byteSize: f.content.byteLength,
      sha256: sha256Hex(f.content)
    })
  }
  return specs
}

async function waitForCondition(
  predicate: () => boolean,
  description: string,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}`)
    }
    await new Promise((r) => setTimeout(r, 5))
  }
}

function waitForFile(filePath: string, description: string, timeoutMs = 5_000): Promise<void> {
  return waitForCondition(() => existsSync(filePath), description, timeoutMs)
}

function writeMockSemanticWorker(
  workerPath: string,
  options: { readonly slowDocReadyFile?: string; readonly slowDocGateFile?: string } = {}
): void {
  const slowDocReadyJson = JSON.stringify(options.slowDocReadyFile ?? null)
  const slowDocGateJson = JSON.stringify(options.slowDocGateFile ?? null)
  writeFileSync(
    workerPath,
    `
const { parentPort } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const slowDocReadyFile = ${slowDocReadyJson};
const slowDocGateFile = ${slowDocGateJson};

async function waitForGate(gateFile) {
  if (!gateFile || fs.existsSync(gateFile)) return;
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (fs.existsSync(gateFile)) {
        clearInterval(timer);
        resolve();
      }
    }, 5);
  });
}

parentPort.on('message', async (msg) => {
  if (msg.type === 'abort_and_exit') {
    process.exit(0);
    return;
  }
  if (msg.type === 'verify_model') {
    const ok = fs.existsSync(path.join(msg.modelDir, 'config.json'));
    parentPort.postMessage({
      id: msg.id,
      ok: true,
      verifyResult: ok ? { ok: true } : { ok: false, code: 'DOC_MODEL_MISSING', error: 'Missing config.json' },
      nestedWorkerAttempts: 0,
      outboundNetworkAttempts: 0
    });
    return;
  }
  if (msg.type === 'chunk_text') {
    const normalized = String(msg.text || '').replace(/\\r\\n?/g, '\\n').trim();
    const sha = require('node:crypto').createHash('sha256').update(normalized, 'utf8').digest('hex');
    const chunks = normalized.length === 0 ? [] : [{
      chunkIndex: 0,
      charOffsetStart: 0,
      charOffsetEnd: normalized.length,
      contentTokenCount: Math.max(1, normalized.split(/\\s+/).length),
      text: normalized
    }];
    parentPort.postMessage({
      id: msg.id,
      ok: true,
      chunkResult: {
        recipeVersion: 'doc_tok_chunk_v1',
        chunks,
        normalizedTextSha256: sha,
        normalizedCharCount: normalized.length,
        indexedCharCount: normalized.length,
        coverageRatio: 1,
        truncated: false,
        truncationReason: null,
        totalTokenCount: chunks.length ? chunks[0].contentTokenCount : 0,
        uniqueIndexedTokenCount: chunks.length ? chunks[0].contentTokenCount : 0,
        emittedChunkTokenSum: chunks.length ? chunks[0].contentTokenCount : 0,
        maxChunksPerDocument: 128,
        maxTextCharsForIndexing: 500000,
        maxContentTokensPerChunk: 510,
        overlapTokens: 64
      },
      nestedWorkerAttempts: 0,
      outboundNetworkAttempts: 0
    });
    return;
  }
  if (msg.type === 'embed_chunk' || msg.type === 'embed_query') {
    const text = String(msg.text || msg.query || '').toLowerCase();
    const vec = new Float32Array(384);
    if (text.includes('invoice') || text.includes('cloud')) {
      vec[0] = 0.95; vec[1] = 0.3122;
    } else if (text.includes('lease') || text.includes('rent')) {
      vec[0] = 0.2; vec[1] = 0.9798;
    } else {
      vec[0] = 0.6; vec[1] = 0.8;
    }
    if (msg.type === 'embed_chunk' && text.includes('slow_doc') && slowDocReadyFile && slowDocGateFile) {
      fs.writeFileSync(slowDocReadyFile, 'ready', 'utf8');
      await waitForGate(slowDocGateFile);
    } else {
      const delay = text.includes('slow_doc') ? 180 : 5;
      await new Promise((r) => setTimeout(r, delay));
    }
    parentPort.postMessage({
      id: msg.id,
      ok: true,
      embedResult: {
        vector: Array.from(vec),
        dimensions: 384,
        tokenCount: 8,
        rawTokenCount: 8,
        truncated: false,
        embedMs: 5
      },
      nestedWorkerAttempts: 0,
      outboundNetworkAttempts: 0
    });
  }
});
`,
    'utf8'
  )
}

interface SeededDoc {
  fileLocationId: number
  discoveryObservationId: number
  byteSize: number
  mtimeMs: number
  sha256: string
  contentRevision: string
  nativeExtractionId?: number
  ocrExtractionId?: number
}

function seedCatalogDocument(
  catalog: CatalogDatabase,
  options: {
    fileName: string
    sha256: string
    nativeText?: string
    ocrText?: string
  }
): SeededDoc {
  const db = catalog.getRawDatabaseForTesting()
  const now = 1_700_000_000_000
  let sourceRow = db.prepare('SELECT id FROM sources LIMIT 1;').get() as { id: number } | undefined
  if (!sourceRow) {
    const srcRes = db
      .prepare(
        `INSERT INTO sources (root_path, normalized_root_path, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?);`
      )
      .run('D:\\fixtures\\docs', 'd:\\fixtures\\docs', now, now)
    sourceRow = { id: Number(srcRes.lastInsertRowid) }
  }

  const ext = options.fileName.includes('.')
    ? '.' + options.fileName.split('.').pop()!.toLowerCase()
    : '.txt'
  const byteSize = 1024
  const mtimeMs = 1_700_000_001_000

  const fRes = db
    .prepare(
      `INSERT INTO file_locations (
         source_id, original_path, normalized_path,
         file_name, extension, category, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, 'document', ?, ?);`
    )
    .run(
      sourceRow.id,
      `D:\\fixtures\\docs\\${options.fileName}`,
      `d:\\fixtures\\docs\\${options.fileName}`,
      options.fileName,
      ext,
      now,
      now
    )
  const fileLocationId = Number(fRes.lastInsertRowid)

  const dRes = db
    .prepare(
      `INSERT INTO discovery_observations (
         file_location_id, byte_size, filesystem_birthtime_ms, filesystem_mtime_ms, observed_at_ms, last_seen_at_ms, is_current
       ) VALUES (?, ?, ?, ?, ?, ?, 1);`
    )
    .run(fileLocationId, byteSize, now, mtimeMs, now, now)
  const discoveryObservationId = Number(dRes.lastInsertRowid)

  db.prepare(
    `INSERT INTO hash_observations (
       file_location_id, discovery_observation_id, sha256, observed_byte_size, observed_mtime_ms, hashed_at_ms, is_active
     ) VALUES (?, ?, ?, ?, ?, ?, 1);`
  ).run(fileLocationId, discoveryObservationId, options.sha256, byteSize, mtimeMs, now)

  const contentRevision = buildDocumentContentRevision({
    discoveryObservationId,
    byteSize,
    filesystemMtimeMs: mtimeMs,
    activeHash: options.sha256
  })

  let nativeExtractionId: number | undefined
  if (options.nativeText !== undefined) {
    const eRes = db
      .prepare(
        `INSERT INTO document_extractions (
           file_location_id, discovery_observation_id, content_sha256,
           observed_byte_size, observed_mtime_ms, content_revision, recipe_version,
           extraction_status, extracted_text, extracted_char_count, is_current, extracted_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'extracted', ?, ?, 1, ?);`
      )
      .run(
        fileLocationId,
        discoveryObservationId,
        options.sha256,
        byteSize,
        mtimeMs,
        contentRevision,
        DOCUMENT_EXTRACTION_RECIPE_VERSION,
        options.nativeText,
        options.nativeText.length,
        now
      )
    nativeExtractionId = Number(eRes.lastInsertRowid)
  }

  let ocrExtractionId: number | undefined
  if (options.ocrText !== undefined) {
    const oRes = db
      .prepare(
        `INSERT INTO document_ocr_extractions (
           file_location_id, discovery_observation_id, content_sha256,
           observed_byte_size, observed_mtime_ms, content_revision, recipe_version,
           ocr_model_id, ocr_model_manifest_sha256, ocr_language,
           extraction_method, ocr_status, extracted_text, extracted_char_count, is_current, extracted_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ocr_pdf_tesseract', 'extracted', ?, ?, 1, ?);`
      )
      .run(
        fileLocationId,
        discoveryObservationId,
        options.sha256,
        byteSize,
        mtimeMs,
        contentRevision,
        DOCUMENT_OCR_RECIPE_VERSION,
        OCR_MODEL_ID,
        PINNED_OCR_MANIFEST_SHA256,
        OCR_MODEL_LANGUAGE,
        options.ocrText,
        options.ocrText.length,
        now
      )
    ocrExtractionId = Number(oRes.lastInsertRowid)
  }

  return {
    fileLocationId,
    discoveryObservationId,
    byteSize,
    mtimeMs,
    sha256: options.sha256,
    contentRevision,
    nativeExtractionId,
    ocrExtractionId
  }
}

describe('Stage 7D Slice 2 — Migration 14, DocumentSemanticRepository & DocumentSemanticCoordinator', () => {
  let tempDir: string
  let dbPath: string
  let catalog: CatalogDatabase
  let modelsRoot: string
  let sourceModelDir: string
  let artifacts: DocSemanticModelArtifactSpec[]
  let mockWorkerPath: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pv-doc-sem-s2-'))
    dbPath = join(tempDir, 'catalog.db')
    catalog = CatalogDatabase.open({ catalogPath: dbPath })
    modelsRoot = join(tempDir, 'models')
    sourceModelDir = join(tempDir, 'source-model')
    mkdirSync(modelsRoot, { recursive: true })
    mkdirSync(sourceModelDir, { recursive: true })
    artifacts = createSyntheticModel(sourceModelDir)
    mockWorkerPath = join(tempDir, 'mock-doc-sem-worker.cjs')
    writeMockSemanticWorker(mockWorkerPath)
  })

  afterEach(() => {
    if (catalog && !catalog.isClosed()) {
      catalog.close()
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('bumps CURRENT_SCHEMA_VERSION to >= 14, upgrades a v13 catalog, and rejects future schemas', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(14)

    const raw = catalog.getRawDatabaseForTesting()
    const tables = raw
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (
           'document_semantic_tracks',
           'document_semantic_chunks',
           'document_semantic_jobs',
           'document_semantic_job_items'
         ) ORDER BY name ASC;`
      )
      .all() as Array<{ name: string }>
    expect(tables.map((t) => t.name)).toEqual([
      'document_semantic_chunks',
      'document_semantic_job_items',
      'document_semantic_jobs',
      'document_semantic_tracks'
    ])
    catalog.close()

    // Upgrade from v13
    const v13Path = join(tempDir, 'v13.db')
    const rawV13 = new DatabaseSync(v13Path)
    rawV13.exec('PRAGMA foreign_keys = ON;')
    rawV13.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        applied_at_ms INTEGER NOT NULL
      );
    `)
    for (const m of MIGRATIONS.filter((item) => item.version <= 13)) {
      rawV13.exec('BEGIN;')
      m.up(rawV13)
      rawV13
        .prepare('INSERT INTO schema_migrations (version, name, applied_at_ms) VALUES (?, ?, ?);')
        .run(m.version, m.name, 1_700_000_000_000)
      rawV13.exec('COMMIT;')
    }
    rawV13.close()

    const upgraded = CatalogDatabase.open({ catalogPath: v13Path })
    expect(upgraded.isClosed()).toBe(false)
    upgraded.close()

    // Reject future v999
    const futurePath = join(tempDir, 'future.db')
    const rawFuture = new DatabaseSync(futurePath)
    rawFuture.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        applied_at_ms INTEGER NOT NULL
      );
      INSERT INTO schema_migrations (version, name, applied_at_ms) VALUES (999, 'future', 1000);
    `)
    rawFuture.close()
    expect(() => CatalogDatabase.open({ catalogPath: futurePath })).toThrow(
      UnsupportedSchemaVersionError
    )
  })

  it('enforces dual-track coexistence, non-reuse on changed extracted text from identical original bytes, stale-commit rejection, and corrupt vector exclusion', () => {
    const repo = catalog.getDocumentSemanticRepository()
    const doc = seedCatalogDocument(catalog, {
      fileName: 'dual-tax.pdf',
      sha256: 'a'.repeat(64),
      nativeText: 'Cloud infrastructure invoice cover sheet.',
      ocrText: 'Scanned municipal property tax assessment.'
    })

    const compat: DocSemanticCompatibilitySpec = DEFAULT_DOC_SEMANTIC_COMPATIBILITY_SPEC
    const normNative = normalizeDocumentText('Cloud infrastructure invoice cover sheet.')
    const normOcr = normalizeDocumentText('Scanned municipal property tax assessment.')

    // Commit both native and ocr tracks
    const resNative = repo.commitTrackChunks({
      jobId: null,
      fileLocationId: doc.fileLocationId,
      textSourceKind: 'native',
      discoveryObservationId: doc.discoveryObservationId,
      observedByteSize: doc.byteSize,
      observedMtimeMs: doc.mtimeMs,
      contentSha256: doc.sha256,
      contentRevision: doc.contentRevision,
      sourceExtractionId: doc.nativeExtractionId!,
      sourceRecipeVersion: DOCUMENT_EXTRACTION_RECIPE_VERSION,
      sourceOcrModelId: null,
      sourceOcrModelManifestSha256: null,
      sourceOcrLanguage: null,
      normalizedTextSha256: computeNormalizedTextSha256(normNative),
      compat,
      status: 'indexed',
      normalizedCharCount: normNative.length,
      indexedCharCount: normNative.length,
      coverageRatio: 1,
      truncated: false,
      truncationReason: null,
      totalTokenCount: 6,
      uniqueIndexedTokenCount: 6,
      emittedChunkTokenSum: 6,
      chunks: [
        {
          chunk: {
            chunkIndex: 0,
            charOffsetStart: 0,
            charOffsetEnd: normNative.length,
            contentTokenCount: 6,
            text: normNative
          },
          vector: makeUnitVec(0.2)
        }
      ]
    })
    expect(resNative.committed).toBe(true)

    const resOcr = repo.commitTrackChunks({
      jobId: null,
      fileLocationId: doc.fileLocationId,
      textSourceKind: 'ocr',
      discoveryObservationId: doc.discoveryObservationId,
      observedByteSize: doc.byteSize,
      observedMtimeMs: doc.mtimeMs,
      contentSha256: doc.sha256,
      contentRevision: doc.contentRevision,
      sourceExtractionId: doc.ocrExtractionId!,
      sourceRecipeVersion: DOCUMENT_OCR_RECIPE_VERSION,
      sourceOcrModelId: OCR_MODEL_ID,
      sourceOcrModelManifestSha256: PINNED_OCR_MANIFEST_SHA256,
      sourceOcrLanguage: OCR_MODEL_LANGUAGE,
      normalizedTextSha256: computeNormalizedTextSha256(normOcr),
      compat,
      status: 'indexed',
      normalizedCharCount: normOcr.length,
      indexedCharCount: normOcr.length,
      coverageRatio: 1,
      truncated: false,
      truncationReason: null,
      totalTokenCount: 6,
      uniqueIndexedTokenCount: 6,
      emittedChunkTokenSum: 6,
      chunks: [
        {
          chunk: {
            chunkIndex: 0,
            charOffsetStart: 0,
            charOffsetEnd: normOcr.length,
            contentTokenCount: 6,
            text: normOcr
          },
          vector: makeUnitVec(0.05) // closer to query 0.05 than native 0.2
        }
      ]
    })
    expect(resOcr.committed).toBe(true)

    // Search selects winning OCR chunk
    const search1 = repo.searchDocumentChunksBounded(makeUnitVec(0.05), { compat })
    expect(search1.totalMatched).toBe(1)
    expect(search1.items[0]!.textSourceKind).toBe('ocr')

    // Re-extract native text with IDENTICAL original bytes (same sha256/observation) -> different text!
    const raw = catalog.getRawDatabaseForTesting()
    const newNativeText = 'Updated re-extracted apartment lease agreement.'
    raw
      .prepare('UPDATE document_extractions SET extracted_text = ? WHERE id = ?;')
      .run(newNativeText, doc.nativeExtractionId!)

    // Must NOT reuse old vectors for the new normalized_text_sha256
    const newNormHash = computeNormalizedTextSha256(normalizeDocumentText(newNativeText))
    const reuse = repo.findReusableTrackChunks({
      compat,
      textSourceKind: 'native',
      normalizedTextSha256: newNormHash,
      sourceRecipeVersion: DOCUMENT_EXTRACTION_RECIPE_VERSION,
      sourceOcrModelId: null,
      sourceOcrModelManifestSha256: null,
      sourceOcrLanguage: null
    })
    expect(reuse).toBeNull()

    // Coverage marks native track stale while OCR track remains indexed
    const cov = repo.getCoverage(compat)
    expect(cov.staleTracks).toBe(1)
    expect(cov.indexedTracks).toBe(1)

    // Stale-commit rejection: attempting to commit old normalizedTextSha256 returns REVISION_MISMATCH
    const staleCommit = repo.commitTrackChunks({
      jobId: null,
      fileLocationId: doc.fileLocationId,
      textSourceKind: 'native',
      discoveryObservationId: doc.discoveryObservationId,
      observedByteSize: doc.byteSize,
      observedMtimeMs: doc.mtimeMs,
      contentSha256: doc.sha256,
      contentRevision: doc.contentRevision,
      sourceExtractionId: doc.nativeExtractionId!,
      sourceRecipeVersion: DOCUMENT_EXTRACTION_RECIPE_VERSION,
      sourceOcrModelId: null,
      sourceOcrModelManifestSha256: null,
      sourceOcrLanguage: null,
      normalizedTextSha256: computeNormalizedTextSha256(normNative), // old hash!
      compat,
      status: 'indexed',
      normalizedCharCount: normNative.length,
      indexedCharCount: normNative.length,
      coverageRatio: 1,
      truncated: false,
      truncationReason: null,
      totalTokenCount: 6,
      uniqueIndexedTokenCount: 6,
      emittedChunkTokenSum: 6,
      chunks: []
    })
    expect(staleCommit.committed).toBe(false)
    expect(staleCommit.reason).toBe('REVISION_MISMATCH')

    // Corrupt vector exclusion: corrupt the OCR chunk blob in SQLite
    raw
      .prepare(
        "UPDATE document_semantic_chunks SET embedding_vector = X'010203' WHERE text_source_kind = 'ocr';"
      )
      .run()
    const searchAfterCorrupt = repo.searchDocumentChunksBounded(makeUnitVec(0.05), { compat })
    expect(searchAfterCorrupt.corruptChunkCount).toBe(1)
    expect(searchAfterCorrupt.totalMatched).toBe(0)
    expect(repo.getCoverage(compat).corruptChunks).toBe(1)
  })

  it('cleans up incomplete snapshots, recovers interrupted jobs, and coordinates pause/resume/cancel/off-main verification under AppWorkerBudget(3)', async () => {
    const repo = catalog.getDocumentSemanticRepository()
    const raw = catalog.getRawDatabaseForTesting()

    // Seed incomplete snapshot job (snapshot_complete = 0) + leftover .tmp file + interrupted running job
    writeFileSync(join(tempDir, '.doc-semantic-snapshot-deadbeef.tmp'), '{"f":1}\n', 'utf8')
    raw
      .prepare(
        `INSERT INTO document_semantic_jobs (
           id, scope_kind, status, doc_model_id, doc_model_commit, doc_model_manifest_sha256,
           chunking_recipe_version, snapshot_complete, started_at_ms, updated_at_ms
         ) VALUES ('deadbeef', 'all', 'running', 'm', 'c', 's', 'r', 0, 1000, 1000);`
      )
      .run()
    raw
      .prepare(
        `INSERT INTO document_semantic_jobs (
           id, scope_kind, status, doc_model_id, doc_model_commit, doc_model_manifest_sha256,
           chunking_recipe_version, snapshot_complete, started_at_ms, updated_at_ms
         ) VALUES ('crashed-job', 'all', 'running', 'm', 'c', 's', 'r', 1, 2000, 2000);`
      )
      .run()

    const modelManager = new DocSemanticModelManager({
      modelsRootDir: modelsRoot,
      getApprovedRoots: () => ['D:\\fixtures\\docs'],
      getVaultRoot: () => null,
      artifacts
    })
    await modelManager.importFromDirectory(sourceModelDir)

    const slowDocReadyFile = join(tempDir, 'slow-doc-embed.ready')
    const slowDocGateFile = join(tempDir, 'slow-doc-embed.gate')
    writeMockSemanticWorker(mockWorkerPath, { slowDocReadyFile, slowDocGateFile })

    let verifyCallsOnWorker = 0
    let onVerifyEntered: (() => void) | null = null
    const budget = new AppWorkerBudget(3)
    const runner = new DocumentSemanticWorkerRunner({
      workerBudget: budget,
      workerScriptPath: mockWorkerPath,
      workerTimeoutMs: 10_000
    })
    const origVerify = runner.verifyModelDirectory.bind(runner)
    runner.verifyModelDirectory = async (...args) => {
      verifyCallsOnWorker += 1
      onVerifyEntered?.()
      return origVerify(...args)
    }

    const coordinator = new DocumentSemanticCoordinator({
      catalog,
      modelManager,
      workerRunner: runner,
      workerBudget: budget,
      snapshotWorkerScriptPath: existsSync(BUILT_SNAPSHOT_WORKER)
        ? BUILT_SNAPSHOT_WORKER
        : undefined
    })

    coordinator.initialize()
    expect(repo.getJob('deadbeef')).toBeNull()
    expect(readdirSync(tempDir).some((n) => n.startsWith('.doc-semantic-snapshot-'))).toBe(false)
    expect(repo.getJob('crashed-job')?.status).toBe('interrupted')

    // Seed two synthetic documents
    seedCatalogDocument(catalog, {
      fileName: 'cloud-invoice.txt',
      sha256: 'b'.repeat(64),
      nativeText: 'Cloud infrastructure invoice total due $1250.'
    })
    seedCatalogDocument(catalog, {
      fileName: 'apartment-lease.pdf',
      sha256: 'c'.repeat(64),
      ocrText: 'slow_doc Apartment lease monthly rent $2400.'
    })

    // Start indexing and synchronize pause strictly with slow_doc embed_chunk inside worker
    const startPromise = coordinator.startIndexing({ scopeKind: 'unindexed_or_stale' })
    await waitForFile(slowDocReadyFile, 'slow_doc embed_chunk to enter worker')
    const pausedProgress = await coordinator.pauseIndexing()
    const pausedJob = await startPromise
    expect(verifyCallsOnWorker).toBeGreaterThanOrEqual(1)
    expect(pausedProgress.status).toBe('paused')
    expect(pausedProgress.processedItems).toBe(1)
    expect(pausedProgress.pendingItems).toBe(1)
    expect(pausedJob?.status).toBe('paused')

    // Release slow_doc gate and resume to completion
    writeFileSync(slowDocGateFile, 'go', 'utf8')
    const resumed = await coordinator.resumeIndexing()
    expect(resumed?.status).toBe('completed')
    expect(resumed?.processedItems).toBe(2)
    expect(resumed?.indexedItems).toBe(2)

    // Search via coordinator
    const searchRes = await coordinator.searchDocuments('cloud invoice')
    expect(searchRes.totalMatched).toBe(2)
    expect(searchRes.items[0]!.fileName).toBe('cloud-invoice.txt')

    // Cancellation during admission (hold all 3 AppWorkerBudget slots)
    await runner.releaseIdleWorker()
    const r1 = budget.tryReserve()!
    const r2 = budget.tryReserve()!
    const r3 = budget.tryReserve()!
    expect(r1).not.toBeNull()
    expect(r2).not.toBeNull()
    expect(r3).not.toBeNull()
    const verifyEntered = new Promise<void>((res) => {
      onVerifyEntered = () => {
        onVerifyEntered = null
        res()
      }
    })
    const blockedStart = coordinator.startIndexing({ scopeKind: 'all', forceReindex: true })
    const blockedExpect = expect(blockedStart).rejects.toThrow(/CANCELLED/)
    await verifyEntered
    await coordinator.cancelIndexing()
    budget.releaseReservation(r1)
    budget.releaseReservation(r2)
    budget.releaseReservation(r3)
    await blockedExpect

    await coordinator.shutdown()
    await runner.shutdown()
    expect(budget.getWorkerCount()).toBe(0)
    expect(budget.getReservedCount()).toBe(0)
  })

  it('awaits snapshot worker exit on cancellation and invalidates semantic coverage after same-connection scan/hash mutations', async () => {
    const repo = catalog.getDocumentSemanticRepository()
    const slowSnapWorker = join(tempDir, 'slow-snapshot-worker.cjs')
    writeFileSync(
      slowSnapWorker,
      `
setTimeout(() => {
  process.exit(0);
}, 5000);
`,
      'utf8'
    )

    const budget = new AppWorkerBudget(3)
    let cancelFlag = false
    const snapPromise = repo.createSnapshotJob({
      jobId: 'snap-cancel-test',
      input: {
        scopeKind: 'all',
        compat: DEFAULT_DOC_SEMANTIC_COMPATIBILITY_SPEC
      },
      workerBudget: budget,
      shouldCancel: () => cancelFlag,
      workerScriptPath: slowSnapWorker
    })
    const snapExpect = expect(snapPromise).rejects.toThrow(/CANCELLED/)
    await waitForCondition(() => budget.getWorkerCount() === 1, 'snapshot worker to spawn')
    cancelFlag = true
    await snapExpect
    // Snapshot worker exit must already be confirmed when createSnapshotJob rejects
    expect(budget.getWorkerCount()).toBe(0)
    expect(budget.getReservedCount()).toBe(0)
    expect(repo.getJob('snap-cancel-test')).toBeNull()

    // Same-connection scan/hash mutation coverage invalidation
    const doc = seedCatalogDocument(catalog, {
      fileName: 'scan-hash-invalidation.txt',
      sha256: 'd'.repeat(64),
      nativeText: 'Original text before re-hash.'
    })

    const modelManager = new DocSemanticModelManager({
      modelsRootDir: modelsRoot,
      getApprovedRoots: () => ['D:\\fixtures\\docs'],
      getVaultRoot: () => null,
      artifacts
    })
    await modelManager.importFromDirectory(sourceModelDir)

    const runner = new DocumentSemanticWorkerRunner({
      workerBudget: budget,
      workerScriptPath: mockWorkerPath
    })
    const coordinator = new DocumentSemanticCoordinator({
      catalog,
      modelManager,
      workerRunner: runner,
      workerBudget: budget,
      snapshotWorkerScriptPath: existsSync(BUILT_SNAPSHOT_WORKER)
        ? BUILT_SNAPSHOT_WORKER
        : undefined
    })
    coordinator.initialize()
    await coordinator.startIndexing({ scopeKind: 'unindexed_or_stale' })
    const covBefore = await coordinator.refreshCoverage()
    expect(covBefore.indexedTracks).toBe(1)
    expect(covBefore.staleTracks).toBe(0)

    // Mutate hash via same-connection CatalogDatabase.recordHashObservation
    catalog.recordHashObservation({
      originalPath: `D:\\fixtures\\docs\\scan-hash-invalidation.txt`,
      observedByteSize: doc.byteSize,
      observedMtimeMs: doc.mtimeMs,
      sha256: 'e'.repeat(64),
      hashedAtMs: Date.now()
    })

    const covAfterHash = await coordinator.refreshCoverage()
    expect(covAfterHash.totalExtractableTracks).toBe(0)
    expect(covAfterHash.indexedTracks).toBe(0)

    await coordinator.shutdown()
    await runner.shutdown()
  })
})
