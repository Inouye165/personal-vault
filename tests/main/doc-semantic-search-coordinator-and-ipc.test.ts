// @vitest-environment node
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CatalogDatabase, buildDocumentContentRevision } from '../../src/main/services/catalog'
import {
  computeNormalizedTextSha256,
  DOC_SEMANTIC_EMBEDDING_DIMENSIONS,
  DocSearchCancelledError,
  DocSearchOverloadError,
  DocSemanticModelManager,
  DocumentSearchCoordinator,
  DocumentSemanticCoordinator,
  DocumentSemanticWorkerRunner,
  l2NormalizeDocVector,
  normalizeDocumentText,
  type DocSemanticModelArtifactSpec
} from '../../src/main/services/documents/semantic'
import { DEFAULT_DOC_SEMANTIC_COMPATIBILITY_SPEC } from '../../src/main/services/catalog/document-semantic-snapshot-query'
import { DOCUMENT_EXTRACTION_RECIPE_VERSION } from '../../src/main/services/documents/types'
import { AppWorkerBudget } from '../../src/main/services/worker-budget'
import { IPC_CHANNELS } from '../../src/shared/contracts/channels'
import { registerDocumentIpcHandlers } from '../../src/main/ipc/document-handlers'
import { DocSemanticSearchCancelResponseSchema } from '../../src/shared/validation/document-schemas'

const REPO_ROOT = resolve(__dirname, '../..')
const BUILT_SEARCH_WORKER = join(REPO_ROOT, 'out', 'main', 'doc_search_worker.js')
const CACHED_BGE_DIR = join(
  REPO_ROOT,
  'spikes',
  'doc-semantic-eval',
  '.model-cache',
  'bge-small-en-v1.5'
)

function sha256Hex(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex')
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

function makeUnitVec(seed: number): Float32Array {
  const raw = new Float32Array(DOC_SEMANTIC_EMBEDDING_DIMENSIONS)
  raw[0] = Math.cos(seed)
  raw[1] = Math.sin(seed)
  raw[2] = 0.1
  return l2NormalizeDocVector(raw, DOC_SEMANTIC_EMBEDDING_DIMENSIONS)
}

function seedIndexedDocument(
  catalog: CatalogDatabase,
  fileName: string,
  text: string,
  vecSeed: number,
  manifestSha256?: string
): number {
  const db = catalog.getRawDatabaseForTesting()
  const now = 1_700_000_000_000
  let src = db.prepare('SELECT id FROM sources LIMIT 1;').get() as { id: number } | undefined
  if (!src) {
    const res = db
      .prepare(
        `INSERT INTO sources (root_path, normalized_root_path, created_at_ms, updated_at_ms)
         VALUES ('D:\\fixtures\\docs', 'd:\\fixtures\\docs', ?, ?);`
      )
      .run(now, now)
    src = { id: Number(res.lastInsertRowid) }
  }
  const sha = sha256Hex(fileName)
  const fRes = db
    .prepare(
      `INSERT INTO file_locations (
         source_id, original_path, normalized_path, file_name, extension, category, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, '.txt', 'document', ?, ?);`
    )
    .run(
      src.id,
      `D:\\fixtures\\docs\\${fileName}`,
      `d:\\fixtures\\docs\\${fileName}`,
      fileName,
      now,
      now
    )
  const fileId = Number(fRes.lastInsertRowid)
  const dRes = db
    .prepare(
      `INSERT INTO discovery_observations (
         file_location_id, byte_size, filesystem_birthtime_ms, filesystem_mtime_ms, observed_at_ms, last_seen_at_ms, is_current
       ) VALUES (?, 512, ?, ?, ?, ?, 1);`
    )
    .run(fileId, now, now, now, now)
  const obsId = Number(dRes.lastInsertRowid)
  db.prepare(
    `INSERT INTO hash_observations (
       file_location_id, discovery_observation_id, sha256, observed_byte_size, observed_mtime_ms, hashed_at_ms, is_active
     ) VALUES (?, ?, ?, 512, ?, ?, 1);`
  ).run(fileId, obsId, sha, now, now)
  const rev = buildDocumentContentRevision({
    discoveryObservationId: obsId,
    byteSize: 512,
    filesystemMtimeMs: now,
    activeHash: sha
  })
  const eRes = db
    .prepare(
      `INSERT INTO document_extractions (
         file_location_id, discovery_observation_id, content_sha256, observed_byte_size, observed_mtime_ms,
         content_revision, recipe_version, extraction_status, extracted_text, extracted_char_count, is_current, extracted_at_ms
       ) VALUES (?, ?, ?, 512, ?, ?, ?, 'extracted', ?, ?, 1, ?);`
    )
    .run(fileId, obsId, sha, now, rev, DOCUMENT_EXTRACTION_RECIPE_VERSION, text, text.length, now)

  const norm = normalizeDocumentText(text)
  catalog.getDocumentSemanticRepository().commitTrackChunks({
    jobId: null,
    fileLocationId: fileId,
    textSourceKind: 'native',
    discoveryObservationId: obsId,
    observedByteSize: 512,
    observedMtimeMs: now,
    contentSha256: sha,
    contentRevision: rev,
    sourceExtractionId: Number(eRes.lastInsertRowid),
    sourceRecipeVersion: DOCUMENT_EXTRACTION_RECIPE_VERSION,
    sourceOcrModelId: null,
    sourceOcrModelManifestSha256: null,
    sourceOcrLanguage: null,
    normalizedTextSha256: computeNormalizedTextSha256(norm),
    compat: manifestSha256
      ? { ...DEFAULT_DOC_SEMANTIC_COMPATIBILITY_SPEC, docModelManifestSha256: manifestSha256 }
      : DEFAULT_DOC_SEMANTIC_COMPATIBILITY_SPEC,
    status: 'indexed',
    normalizedCharCount: norm.length,
    indexedCharCount: norm.length,
    coverageRatio: 1,
    truncated: false,
    truncationReason: null,
    totalTokenCount: 5,
    uniqueIndexedTokenCount: 5,
    emittedChunkTokenSum: 5,
    chunks: [
      {
        chunk: {
          chunkIndex: 0,
          charOffsetStart: 0,
          charOffsetEnd: norm.length,
          contentTokenCount: 5,
          text: norm
        },
        vector: makeUnitVec(vecSeed)
      }
    ]
  })
  return fileId
}

/** Persists the scored identity the mock worker reports, mirroring the real worker's snapshot. */
function writeScoredIdentityForMock(
  catalog: CatalogDatabase,
  dir: string,
  fileId: number,
  manifestSha256: string
): void {
  const chunk = catalog
    .getRawDatabaseForTesting()
    .prepare(
      'SELECT id FROM document_semantic_chunks WHERE file_location_id = ? AND is_current = 1;'
    )
    .get(fileId) as { id: number }
  const identity = catalog
    .getDocumentSemanticRepository()
    .readChunkSearchIdentity(Number(chunk.id), {
      ...DEFAULT_DOC_SEMANTIC_COMPATIBILITY_SPEC,
      docModelManifestSha256: manifestSha256
    })
  writeFileSync(join(dir, 'scored-identity.json'), JSON.stringify(identity), 'utf8')
}

describe('Stage 7D Slice 3 — DocumentSearchCoordinator & IPC Handlers', () => {
  let tempDir: string
  let dbPath: string
  let catalog: CatalogDatabase
  let modelsRoot: string
  let sourceModelDir: string
  let artifacts: DocSemanticModelArtifactSpec[]
  let mockSearchWorkerPath: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pv-doc-sem-s3-'))
    dbPath = join(tempDir, 'catalog.db')
    catalog = CatalogDatabase.open({ catalogPath: dbPath })
    modelsRoot = join(tempDir, 'models')
    sourceModelDir = join(tempDir, 'source-model')
    mkdirSync(modelsRoot, { recursive: true })
    mkdirSync(sourceModelDir, { recursive: true })
    artifacts = createSyntheticModel(sourceModelDir)
    mockSearchWorkerPath = join(tempDir, 'mock-doc-search-worker.cjs')
    writeFileSync(
      mockSearchWorkerPath,
      `
const { parentPort } = require('node:worker_threads');
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const identityPath = join(__dirname, 'scored-identity.json');
parentPort.on('message', (msg) => {
  if (msg.type === 'abort_and_exit') {
    process.exit(0);
    return;
  }
  if (msg.type === 'search') {
    const delay = msg.delayMs || 15;
    const scoredIdentity = existsSync(identityPath)
      ? JSON.parse(readFileSync(identityPath, 'utf8'))
      : undefined;
    setTimeout(() => {
      parentPort.postMessage({
        id: msg.id,
        ok: true,
        items: [{
          fileLocationId: 1,
          score: 0.91,
          winningChunkId: scoredIdentity ? scoredIdentity.chunkId : 1,
          winningChunkIndex: 0,
          textSourceKind: 'native',
          charOffsetStart: 0,
          charOffsetEnd: 20,
          truncated: false,
          normalizedCharCount: 20,
          indexedCharCount: 20,
          coverageRatio: 1,
          originalPath: 'D:\\\\fixtures\\\\docs\\\\doc1.txt',
          fileName: 'doc1.txt',
          extension: '.txt',
          winningSnippet: 'Cloud invoice $1,250',
          scoredIdentity
        }],
        totalMatched: 1,
        hasMore: false,
        eligibleChunkCount: 1,
        corruptChunkCount: 0,
        queryTokenCount: 6,
        queryTruncated: false,
        queryLatencyMs: delay,
        nestedWorkerAttempts: 0,
        outboundNetworkAttempts: 0
      });
    }, delay);
  }
});
`,
      'utf8'
    )
  })

  afterEach(() => {
    if (catalog && !catalog.isClosed()) {
      catalog.close()
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('releases AppWorkerBudget synchronously on missing worker path and handles concurrent same-query pages, supersession, and overload', async () => {
    const modelManager = new DocSemanticModelManager({
      modelsRootDir: modelsRoot,
      getApprovedRoots: () => ['D:\\fixtures\\docs'],
      getVaultRoot: () => null,
      artifacts
    })
    await modelManager.importFromDirectory(sourceModelDir)
    const manifestSha = modelManager.getStatus().manifestSha256
    const seededId = seedIndexedDocument(
      catalog,
      'doc1.txt',
      'Cloud invoice $1,250',
      0.1,
      manifestSha
    )
    writeScoredIdentityForMock(catalog, tempDir, seededId, manifestSha)

    // 1. Missing worker path releases reservation synchronously
    const budget = new AppWorkerBudget(3)
    const missingCoordinator = new DocumentSearchCoordinator({
      catalog,
      modelManager,
      workerBudget: budget,
      isPackaged: true,
      appPath: tempDir,
      workerScriptPath: join(tempDir, 'nonexistent-search-worker.js')
    })
    await expect(missingCoordinator.search({ query: 'invoice' })).rejects.toThrow()
    expect(budget.getWorkerCount()).toBe(0)
    expect(budget.getReservedCount()).toBe(0)
    await missingCoordinator.shutdown()

    // 2. Concurrent same-query pages do NOT cancel each other; newer query supersedes older query
    const searchCoordinator = new DocumentSearchCoordinator({
      catalog,
      modelManager,
      workerBudget: budget,
      workerScriptPath: mockSearchWorkerPath,
      maxPendingRequests: 3
    })

    const page1 = searchCoordinator.search({ query: 'cloud invoice', offset: 0, limit: 1 })
    const page2 = searchCoordinator.search({ query: 'cloud invoice', offset: 1, limit: 1 })
    const [r1, r2] = await Promise.all([page1, page2])
    expect(r1.items).toHaveLength(1)
    expect(r2.items).toHaveLength(1)

    // Supersede slow older query with a new query
    const slowOld = searchCoordinator.search({ query: 'slow old query', delayMs: 400 })
    const slowOldExpect = expect(slowOld).rejects.toThrow(DocSearchCancelledError)
    await new Promise((r) => setTimeout(r, 20))
    const fastNew = await searchCoordinator.search({ query: 'fast new query', delayMs: 5 })
    expect(fastNew.items).toHaveLength(1)
    await slowOldExpect

    // Overload > maxPendingRequests (3)
    const p1 = searchCoordinator.search({ query: 'same-q', offset: 0, delayMs: 80 })
    const p2 = searchCoordinator.search({ query: 'same-q', offset: 1, delayMs: 80 })
    const p3 = searchCoordinator.search({ query: 'same-q', offset: 2, delayMs: 80 })
    const p4 = searchCoordinator.search({ query: 'same-q', offset: 3, delayMs: 80 })
    await expect(p4).rejects.toThrow(DocSearchOverloadError)
    await Promise.all([p1, p2, p3])

    await searchCoordinator.shutdown()
    expect(budget.getWorkerCount()).toBe(0)
    expect(budget.getReservedCount()).toBe(0)
  })

  it('enforces bidirectional Zod validation and path-injection rejection across Stage 7D IPC handlers', async () => {
    const modelManager = new DocSemanticModelManager({
      modelsRootDir: modelsRoot,
      getApprovedRoots: () => ['D:\\fixtures\\docs'],
      getVaultRoot: () => null,
      artifacts
    })
    await modelManager.importFromDirectory(sourceModelDir)
    const manifestSha = modelManager.getStatus().manifestSha256
    const seededId = seedIndexedDocument(
      catalog,
      'doc1.txt',
      'Cloud invoice $1,250',
      0.1,
      manifestSha
    )
    writeScoredIdentityForMock(catalog, tempDir, seededId, manifestSha)

    const budget = new AppWorkerBudget(3)
    const workerRunner = new DocumentSemanticWorkerRunner({
      workerBudget: budget,
      workerScriptPath: join(tempDir, 'mock-embed.cjs')
    })
    const indexCoordinator = new DocumentSemanticCoordinator({
      catalog,
      modelManager,
      workerRunner,
      workerBudget: budget
    })
    const searchCoordinator = new DocumentSearchCoordinator({
      catalog,
      modelManager,
      indexCoordinator,
      workerBudget: budget,
      workerScriptPath: mockSearchWorkerPath
    })

    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    registerDocumentIpcHandlers({
      handle: (channel, fn) => {
        handlers.set(channel, fn as (...args: unknown[]) => unknown)
      },
      catalog,
      docSemanticModelManager: modelManager,
      docSemanticCoordinator: indexCoordinator,
      docSearchCoordinator: searchCoordinator,
      selectDocSemanticModelDirectory: async () => sourceModelDir
    })

    // Reject path injection on DOC_SEMANTIC_MODEL_IMPORT
    await expect(
      handlers.get(IPC_CHANNELS.DOC_SEMANTIC_MODEL_IMPORT)!('/malicious/path')
    ).rejects.toThrow(/does not accept renderer path arguments/i)

    // Valid native import succeeds
    const imported = (await handlers.get(IPC_CHANNELS.DOC_SEMANTIC_MODEL_IMPORT)!()) as {
      state: string
    }
    expect(imported.state).toBe('ready')

    // Reject empty or > 500 char search query
    await expect(handlers.get(IPC_CHANNELS.DOC_SEMANTIC_SEARCH)!({ query: '   ' })).rejects.toThrow(
      /Invalid doc-semantic:search request/i
    )
    await expect(
      handlers.get(IPC_CHANNELS.DOC_SEMANTIC_SEARCH)!({ query: 'a'.repeat(501) })
    ).rejects.toThrow(/Invalid doc-semantic:search request/i)

    // Valid search & cancel roundtrip
    const searchRes = (await handlers.get(IPC_CHANNELS.DOC_SEMANTIC_SEARCH)!({
      query: 'cloud invoice'
    })) as { totalMatched: number; items: Array<{ fileName: string }> }
    expect(searchRes.totalMatched).toBe(1)
    expect(searchRes.items[0]!.fileName).toBe('doc1.txt')

    const cancelRes = (await handlers.get(IPC_CHANNELS.DOC_SEMANTIC_SEARCH_CANCEL)!()) as {
      cancelled: boolean
    }
    expect(cancelRes.cancelled).toBe(true)
    expect(DocSemanticSearchCancelResponseSchema.safeParse(cancelRes).success).toBe(true)
    expect(Object.keys(cancelRes)).toEqual(['cancelled'])

    await searchCoordinator.shutdown()
    await indexCoordinator.shutdown()
    await workerRunner.shutdown()
  })

  it('executes real built doc_search_worker end-to-end when built worker and cached BGE model exist', async () => {
    if (!existsSync(BUILT_SEARCH_WORKER) || !existsSync(CACHED_BGE_DIR)) {
      return
    }
    const modelManager = new DocSemanticModelManager({
      modelsRootDir: modelsRoot,
      getApprovedRoots: () => ['D:\\fixtures\\docs'],
      getVaultRoot: () => null
    })
    await modelManager.importFromDirectory(CACHED_BGE_DIR)

    const budget = new AppWorkerBudget(3)
    const indexCoordinator = new DocumentSemanticCoordinator({
      catalog,
      modelManager,
      workerBudget: budget,
      workerScriptPath: join(REPO_ROOT, 'out', 'main', 'document_semantic_worker.js'),
      snapshotWorkerScriptPath: join(REPO_ROOT, 'out', 'main', 'document_snapshot_worker.js')
    })
    indexCoordinator.initialize()

    const db = catalog.getRawDatabaseForTesting()
    const now = 1_700_000_000_000
    const srcRes = db
      .prepare(
        `INSERT INTO sources (root_path, normalized_root_path, created_at_ms, updated_at_ms)
         VALUES ('D:\\fixtures\\docs', 'd:\\fixtures\\docs', ?, ?);`
      )
      .run(now, now)
    const srcId = Number(srcRes.lastInsertRowid)
    const insertDoc = (name: string, text: string) => {
      const sha = sha256Hex(name)
      const f = db
        .prepare(
          `INSERT INTO file_locations (source_id, original_path, normalized_path, file_name, extension, category, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, '.txt', 'document', ?, ?);`
        )
        .run(srcId, `D:\\fixtures\\docs\\${name}`, `d:\\fixtures\\docs\\${name}`, name, now, now)
      const fid = Number(f.lastInsertRowid)
      const d = db
        .prepare(
          `INSERT INTO discovery_observations (file_location_id, byte_size, filesystem_birthtime_ms, filesystem_mtime_ms, observed_at_ms, last_seen_at_ms, is_current)
           VALUES (?, 512, ?, ?, ?, ?, 1);`
        )
        .run(fid, now, now, now, now)
      const oid = Number(d.lastInsertRowid)
      db.prepare(
        `INSERT INTO hash_observations (file_location_id, discovery_observation_id, sha256, observed_byte_size, observed_mtime_ms, hashed_at_ms, is_active)
         VALUES (?, ?, ?, 512, ?, ?, 1);`
      ).run(fid, oid, sha, now, now)
      const rev = buildDocumentContentRevision({
        discoveryObservationId: oid,
        byteSize: 512,
        filesystemMtimeMs: now,
        activeHash: sha
      })
      db.prepare(
        `INSERT INTO document_extractions (file_location_id, discovery_observation_id, content_sha256, observed_byte_size, observed_mtime_ms, content_revision, recipe_version, extraction_status, extracted_text, extracted_char_count, is_current, extracted_at_ms)
         VALUES (?, ?, ?, 512, ?, ?, 'doc_extract_v1', 'extracted', ?, ?, 1, ?);`
      ).run(fid, oid, sha, now, rev, text, text.length, now)
    }

    insertDoc(
      'cloud-invoice.txt',
      'Northwind Cloud Infrastructure Invoice #INV-2026-441. Total due: $1,250.00.'
    )
    insertDoc(
      'lease.txt',
      'Residential apartment lease agreement. Monthly rent $2,400 due on the 1st.'
    )

    await indexCoordinator.startIndexing({ scopeKind: 'unindexed_or_stale' })

    const searchCoordinator = new DocumentSearchCoordinator({
      catalog,
      modelManager,
      indexCoordinator,
      workerBudget: budget,
      workerScriptPath: BUILT_SEARCH_WORKER
    })

    const res = await searchCoordinator.search({ query: 'cloud infrastructure invoice total due' })
    expect(res.totalMatched).toBe(2)
    expect(res.items[0]!.fileName).toBe('cloud-invoice.txt')
    expect(searchCoordinator.getDiagnostics().nestedWorkerAttempts).toBe(0)
    expect(searchCoordinator.getDiagnostics().outboundNetworkAttempts).toBe(0)

    await searchCoordinator.shutdown()
    await indexCoordinator.shutdown()
    expect(budget.getWorkerCount()).toBe(0)
  }, 60000)
})
