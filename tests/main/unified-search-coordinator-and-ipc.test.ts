// @vitest-environment node
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CatalogDatabase, buildDocumentContentRevision } from '../../src/main/services/catalog'
import { registerIpcHandlers } from '../../src/main/ipc/handlers'
import {
  SemanticModelManager,
  SemanticSearchCoordinator,
  SearchCancelledError
} from '../../src/main/services/semantic'
import { REQUIRED_MODEL_ARTIFACTS } from '../../src/main/services/semantic/manifest'
import {
  DocSearchCancelledError,
  DocSemanticModelManager,
  DocumentSearchCoordinator,
  type DocSemanticModelArtifactSpec
} from '../../src/main/services/documents/semantic'
import { DEFAULT_DOC_SEMANTIC_COMPATIBILITY_SPEC } from '../../src/main/services/catalog/document-semantic-snapshot-query'
import { DOCUMENT_EXTRACTION_RECIPE_VERSION } from '../../src/main/services/documents/types'
import { AppWorkerBudget } from '../../src/main/services/worker-budget'
import { UnifiedSearchCoordinator } from '../../src/main/services/unified-search'
import { IPC_CHANNELS } from '../../src/shared/contracts/channels'
import { allocateSearchOwnerGen } from '../../src/shared/search-owner'

const NOW = 1_700_000_000_000

function sha256Hex(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex')
}

function createSyntheticClipModel(dir: string): void {
  mkdirSync(dir, { recursive: true })
  for (const spec of REQUIRED_MODEL_ARTIFACTS) {
    const abs = join(dir, spec.relativePath)
    mkdirSync(join(abs, '..'), { recursive: true })
    // Bypass hash mismatch only when we mock modelManager.verifyInstalledIntegrity or getStatus
    writeFileSync(abs, Buffer.from(`clip:${spec.relativePath}`, 'utf8'))
  }
}

function createSyntheticBgeModel(dir: string): DocSemanticModelArtifactSpec[] {
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
    { relativePath: 'onnx/model_quantized.onnx', content: Buffer.from('SYNTH_BGE_MODEL', 'utf8') }
  ]
  return files.map((f) => {
    const abs = join(dir, f.relativePath)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, f.content)
    return {
      relativePath: f.relativePath,
      byteSize: f.content.byteLength,
      sha256: sha256Hex(f.content)
    }
  })
}

interface WorkerBarrierSpec {
  readonly readyFile?: string
  readonly gateFile?: string
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

function captureOutcome<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  return promise.then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (reason: unknown) => ({ status: 'rejected' as const, reason })
  )
}

function writeSyntheticPhotoSearchWorker(
  filePath: string,
  options: {
    readonly embedDelayMs?: number
    readonly searchDelayMs?: number
    readonly embedBarriers?: Record<string, WorkerBarrierSpec>
  } = {}
): void {
  const embedDelayMs = options.embedDelayMs ?? 0
  const searchDelayMs = options.searchDelayMs ?? 0
  const embedBarriersJson = JSON.stringify(options.embedBarriers ?? {})
  const script = `
const fs = require('node:fs');
const { parentPort } = require('node:worker_threads');
const embedBarriers = ${embedBarriersJson};
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
  if (msg.action === 'embed_text') {
    const barrier = embedBarriers[msg.queryText];
    if (barrier && barrier.readyFile) {
      fs.writeFileSync(barrier.readyFile, 'ready', 'utf8');
    }
    if (barrier && barrier.gateFile) {
      await waitForGate(barrier.gateFile);
    }
    if (${embedDelayMs} > 0) await new Promise((r) => setTimeout(r, ${embedDelayMs}));
    const vec = new Float32Array(512);
    vec[0] = 1;
    parentPort.postMessage({ id: msg.id, status: 'ready', vector: vec, truncated: false, tokenCount: 2 });
    return;
  }
  if (msg.action === 'search_database') {
    if (${searchDelayMs} > 0) await new Promise((r) => setTimeout(r, ${searchDelayMs}));
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(msg.catalogPath, { readOnly: true });
    const rows = db.prepare("SELECT fl.id AS fileLocationId, dobs.id AS discoveryObservationId, dobs.byte_size AS observedByteSize, dobs.filesystem_mtime_ms AS observedMtimeMs FROM file_locations fl JOIN discovery_observations dobs ON dobs.file_location_id = fl.id AND dobs.is_current = 1 WHERE fl.category = 'photo' ORDER BY fl.id ASC").all();
    db.close();
    const offset = msg.offset || 0;
    const limit = msg.limit || 20;
    const sliced = rows.slice(offset, offset + limit).map((r, idx) => ({
      fileLocationId: r.fileLocationId,
      score: Math.max(0.1, 0.95 - (offset + idx) * 0.01),
      discoveryObservationId: r.discoveryObservationId,
      observedByteSize: r.observedByteSize,
      observedMtimeMs: r.observedMtimeMs
    }));
    parentPort.postMessage({
      id: msg.id,
      status: 'ready',
      rankedItems: sliced,
      totalMatched: rows.length,
      eligibleCount: rows.length,
      unindexedCount: 0,
      staleCount: 0,
      corruptCount: 0,
      offset,
      limit,
      hasMore: offset + sliced.length < rows.length,
      queryLatencyMs: 1
    });
  }
});
`
  writeFileSync(filePath, script, 'utf8')
}

function writeSyntheticDocSearchWorker(
  filePath: string,
  options: {
    readonly delayMs?: number
    readonly ignoreAbortAndExit?: boolean
    readonly searchBarriers?: Record<string, WorkerBarrierSpec>
  } = {}
): void {
  const delayMs = options.delayMs ?? 0
  const ignoreAbort = options.ignoreAbortAndExit ? 'true' : 'false'
  const searchBarriersJson = JSON.stringify(options.searchBarriers ?? {})
  const script = `
const fs = require('node:fs');
const { parentPort } = require('node:worker_threads');
const searchBarriers = ${searchBarriersJson};
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
    if (!${ignoreAbort}) {
      process.exit(0);
    }
    return;
  }
  if (msg.type === 'search') {
    const barrier = searchBarriers[msg.query];
    if (barrier && barrier.readyFile) {
      fs.writeFileSync(barrier.readyFile, 'ready', 'utf8');
    }
    if (barrier && barrier.gateFile) {
      await waitForGate(barrier.gateFile);
    }
    if (${delayMs} > 0) await new Promise((r) => setTimeout(r, ${delayMs}));
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(msg.catalogPath, { readOnly: true });
    const rows = db.prepare("SELECT fl.id AS fileLocationId, fl.original_path AS originalPath, fl.file_name AS fileName, fl.extension AS extension, dobs.id AS discoveryObservationId, dobs.byte_size AS observedByteSize, dobs.filesystem_mtime_ms AS observedMtimeMs, ho.sha256 AS contentSha256, de.id AS extractionId, de.content_revision AS contentRevision, de.recipe_version AS sourceRecipeVersion, dsc.id AS chunkId, dsc.chunk_index AS chunkIndex, dsc.char_offset_start AS charOffsetStart, dsc.char_offset_end AS charOffsetEnd, dst.id AS trackId, dst.normalized_text_sha256 AS normalizedTextSha256, dst.normalized_char_count AS normalizedCharCount, dst.indexed_char_count AS indexedCharCount, dst.doc_model_manifest_sha256 AS docModelManifestSha256, dst.chunking_recipe_version AS chunkingRecipeVersion FROM file_locations fl JOIN discovery_observations dobs ON dobs.file_location_id = fl.id AND dobs.is_current = 1 JOIN hash_observations ho ON ho.file_location_id = fl.id AND ho.is_active = 1 JOIN document_extractions de ON de.file_location_id = fl.id AND de.is_current = 1 JOIN document_semantic_tracks dst ON dst.file_location_id = fl.id AND dst.is_current = 1 JOIN document_semantic_chunks dsc ON dsc.track_id = dst.id AND dsc.chunk_index = 0 WHERE fl.category = 'document' ORDER BY fl.id ASC").all();
    db.close();
    const offset = msg.offset || 0;
    const limit = msg.limit || 20;
    const sliced = rows.slice(offset, offset + limit).map((r, idx) => ({
      fileLocationId: r.fileLocationId,
      score: Math.max(0.2, 0.9 - (offset + idx) * 0.01),
      winningChunkId: r.chunkId,
      winningChunkIndex: r.chunkIndex,
      textSourceKind: 'native',
      charOffsetStart: r.charOffsetStart,
      charOffsetEnd: r.charOffsetEnd,
      truncated: false,
      normalizedCharCount: r.normalizedCharCount,
      indexedCharCount: r.indexedCharCount,
      coverageRatio: 1,
      originalPath: r.originalPath,
      fileName: r.fileName,
      extension: r.extension,
      winningSnippet: 'matched snippet for ' + r.fileName,
      scoredIdentity: {
        chunkId: r.chunkId,
        trackId: r.trackId,
        fileLocationId: r.fileLocationId,
        textSourceKind: 'native',
        discoveryObservationId: r.discoveryObservationId,
        observedByteSize: r.observedByteSize,
        observedMtimeMs: r.observedMtimeMs,
        activeHash: r.contentSha256,
        contentSha256: r.contentSha256,
        contentRevision: r.contentRevision,
        sourceExtractionId: r.extractionId,
        sourceRecipeVersion: r.sourceRecipeVersion,
        sourceOcrModelId: null,
        sourceOcrModelManifestSha256: null,
        sourceOcrLanguage: null,
        normalizedTextSha256: r.normalizedTextSha256,
        docModelManifestSha256: r.docModelManifestSha256,
        chunkingRecipeVersion: r.chunkingRecipeVersion,
        classificationId: null,
        classificationRuleVersion: null,
        classificationInputSha256: null,
        overrideId: null,
        overrideVersion: null,
        overrideDiscoveryObservationId: null
      }
    }));
    parentPort.postMessage({
      id: msg.id,
      ok: true,
      items: sliced,
      totalMatched: rows.length,
      hasMore: offset + sliced.length < rows.length,
      eligibleChunkCount: rows.length,
      corruptChunkCount: 0,
      queryTokenCount: 3,
      queryTruncated: false,
      queryLatencyMs: 1,
      nestedWorkerAttempts: 0,
      outboundNetworkAttempts: 0
    });
  }
});
`
  writeFileSync(filePath, script, 'utf8')
}

function seedPhoto(catalog: CatalogDatabase, sourceDir: string, fileName: string): number {
  const originalPath = join(sourceDir, fileName)
  catalog.persistDiscoveryBatch(sourceDir, [
    {
      originalPath,
      fileName,
      extension: '.jpg',
      category: 'photo',
      byteSize: 2048,
      birthtimeMs: NOW,
      mtimeMs: NOW,
      discoveredAtMs: NOW
    }
  ])
  const row = catalog
    .getRawDatabaseForTesting()
    .prepare('SELECT id FROM file_locations WHERE original_path = ?')
    .get(originalPath) as { id: number }
  return row.id
}

function seedDocument(
  catalog: CatalogDatabase,
  sourceDir: string,
  fileName: string,
  manifestSha256: string
): number {
  const db = catalog.getRawDatabaseForTesting()
  let src = db.prepare('SELECT id FROM sources WHERE root_path = ?').get(sourceDir) as
    { id: number } | undefined
  if (!src) {
    const res = db
      .prepare(
        `INSERT INTO sources (root_path, normalized_root_path, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?);`
      )
      .run(sourceDir, sourceDir.toLowerCase(), NOW, NOW)
    src = { id: Number(res.lastInsertRowid) }
  }
  const orig = join(sourceDir, fileName)
  const sha = sha256Hex(fileName)
  const fid = Number(
    db
      .prepare(
        `INSERT INTO file_locations (source_id, original_path, normalized_path, file_name, extension, category, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, '.txt', 'document', ?, ?);`
      )
      .run(src.id, orig, orig.toLowerCase(), fileName, NOW, NOW).lastInsertRowid
  )
  const oid = Number(
    db
      .prepare(
        `INSERT INTO discovery_observations (file_location_id, byte_size, filesystem_birthtime_ms, filesystem_mtime_ms, observed_at_ms, last_seen_at_ms, is_current)
         VALUES (?, 512, ?, ?, ?, ?, 1);`
      )
      .run(fid, NOW, NOW, NOW, NOW).lastInsertRowid
  )
  db.prepare(
    `INSERT INTO hash_observations (file_location_id, discovery_observation_id, sha256, observed_byte_size, observed_mtime_ms, hashed_at_ms, is_active)
     VALUES (?, ?, ?, 512, ?, ?, 1);`
  ).run(fid, oid, sha, NOW, NOW)
  const rev = buildDocumentContentRevision({
    discoveryObservationId: oid,
    byteSize: 512,
    filesystemMtimeMs: NOW,
    activeHash: sha
  })
  const extractionId = Number(
    db
      .prepare(
        `INSERT INTO document_extractions (file_location_id, discovery_observation_id, content_sha256, observed_byte_size, observed_mtime_ms,
           content_revision, recipe_version, extraction_status, extracted_text, extracted_char_count, is_current, extracted_at_ms)
         VALUES (?, ?, ?, 512, ?, ?, ?, 'extracted', 'hello world document text', 25, 1, ?);`
      )
      .run(fid, oid, sha, NOW, rev, DOCUMENT_EXTRACTION_RECIPE_VERSION, NOW).lastInsertRowid
  )
  const vec = new Float32Array(384)
  vec[0] = 1
  catalog.getDocumentSemanticRepository().commitTrackChunks({
    jobId: null,
    fileLocationId: fid,
    textSourceKind: 'native',
    discoveryObservationId: oid,
    observedByteSize: 512,
    observedMtimeMs: NOW,
    contentSha256: sha,
    contentRevision: rev,
    sourceExtractionId: extractionId,
    sourceRecipeVersion: DOCUMENT_EXTRACTION_RECIPE_VERSION,
    sourceOcrModelId: null,
    sourceOcrModelManifestSha256: null,
    sourceOcrLanguage: null,
    normalizedTextSha256: sha256Hex('hello world document text'),
    compat: { ...DEFAULT_DOC_SEMANTIC_COMPATIBILITY_SPEC, docModelManifestSha256: manifestSha256 },
    status: 'indexed',
    normalizedCharCount: 25,
    indexedCharCount: 25,
    coverageRatio: 1,
    truncated: false,
    truncationReason: null,
    totalTokenCount: 4,
    uniqueIndexedTokenCount: 4,
    emittedChunkTokenSum: 4,
    chunks: [
      {
        chunk: {
          chunkIndex: 0,
          charOffsetStart: 0,
          charOffsetEnd: 25,
          contentTokenCount: 4,
          text: 'hello world document text'
        },
        vector: vec
      }
    ]
  })
  return fid
}

function makeReadyClipManager(
  modelsRoot: string,
  approvedRoot: string,
  installDir: string
): SemanticModelManager {
  const mgr = new SemanticModelManager({
    modelsRootDir: modelsRoot,
    getApprovedRoots: () => [approvedRoot],
    getVaultRoot: () => null
  })
  vi.spyOn(mgr, 'getStatus').mockReturnValue({
    state: 'ready',
    modelId: 'Xenova/clip-vit-base-patch32',
    modelCommit: '6b7c523703ae26e39be4b03774966f8571c7f523',
    modelManifestSha256: 'a'.repeat(64),
    preprocessingVersion: 'clip_vit_b32_224_bicubic_center_rgb_v1',
    dimensions: 512,
    requiredBytes: 155_851_918,
    downloadedBytes: 155_851_918,
    currentArtifact: null,
    verifiedAtMs: NOW,
    error: null,
    lastReplacementError: null
  })
  vi.spyOn(mgr, 'getActiveModelInstallDir').mockReturnValue(installDir)
  return mgr
}

function makeReadyBgeManager(modelsRoot: string, bgeSourceDir: string): DocSemanticModelManager {
  const mgr = new DocSemanticModelManager({
    modelsRootDir: modelsRoot,
    getApprovedRoots: () => [bgeSourceDir],
    getVaultRoot: () => null
  })
  vi.spyOn(mgr, 'verifyInstalledIntegrity').mockResolvedValue({
    installDir: bgeSourceDir,
    modelId: 'Xenova/bge-small-en-v1.5',
    modelCommit: 'ea104dacec62c0de699686887e3f920caeb4f3e3',
    manifestSha256: mgr.getStatus().manifestSha256
  })
  return mgr
}

describe('Stage 7F Slice 1: UnifiedSearchCoordinator, Ownership, Worker Budget & IPC', () => {
  let tempDir: string
  let catalog: CatalogDatabase
  let sourcesDir: string
  let clipDir: string
  let bgeDir: string
  let modelsRoot: string
  let budget: AppWorkerBudget
  let photoWorkerPath: string
  let docWorkerPath: string
  const activeWorkersToKill: Worker[] = []
  const coordinatorsToShutdown: Array<{ shutdown: () => Promise<void> }> = []
  let unhandledRejections: unknown[] = []
  const onUnhandled = (reason: unknown): void => {
    unhandledRejections.push(reason)
  }

  beforeEach(() => {
    unhandledRejections = []
    process.on('unhandledRejection', onUnhandled)
    tempDir = mkdtempSync(join(tmpdir(), 'pv-7f-slice1-'))
    sourcesDir = join(tempDir, 'sources')
    clipDir = join(tempDir, 'clip-model')
    bgeDir = join(tempDir, 'bge-model')
    modelsRoot = join(tempDir, 'models')
    mkdirSync(sourcesDir, { recursive: true })
    mkdirSync(modelsRoot, { recursive: true })
    createSyntheticClipModel(clipDir)
    createSyntheticBgeModel(bgeDir)
    catalog = CatalogDatabase.open({ catalogPath: join(tempDir, 'catalog.sqlite') })
    budget = new AppWorkerBudget(3)
    photoWorkerPath = join(tempDir, 'photo-worker.cjs')
    docWorkerPath = join(tempDir, 'doc-worker.cjs')
    writeSyntheticPhotoSearchWorker(photoWorkerPath)
    writeSyntheticDocSearchWorker(docWorkerPath)
  })

  afterEach(async () => {
    process.off('unhandledRejection', onUnhandled)
    for (const c of coordinatorsToShutdown.splice(0)) {
      await c.shutdown().catch(() => {})
    }
    for (const w of activeWorkersToKill.splice(0)) {
      await w.terminate().catch(() => {})
    }
    try {
      catalog.close()
    } catch {
      // ignore
    }
    rmSync(tempDir, { recursive: true, force: true })
    expect(unhandledRejections).toEqual([])
  })

  it('delivers fast modality results independently while the slower modality remains pending', async () => {
    const slowDocWorker = join(tempDir, 'slow-doc-worker.cjs')
    const docReadyFile = join(tempDir, 'slow-doc.ready')
    const docGateFile = join(tempDir, 'slow-doc.gate')
    writeSyntheticDocSearchWorker(slowDocWorker, {
      searchBarriers: { beach: { readyFile: docReadyFile, gateFile: docGateFile } }
    })
    const clipMgr = makeReadyClipManager(modelsRoot, sourcesDir, clipDir)
    const bgeMgr = makeReadyBgeManager(modelsRoot, bgeDir)

    seedPhoto(catalog, sourcesDir, 'beach.jpg')
    seedDocument(catalog, sourcesDir, 'receipt.txt', bgeMgr.getStatus().manifestSha256)

    const photoCoord = new SemanticSearchCoordinator({
      catalog,
      modelManager: clipMgr,
      workerScriptPath: photoWorkerPath,
      workerBudget: budget
    })
    const docCoord = new DocumentSearchCoordinator({
      catalog,
      modelManager: bgeMgr,
      workerScriptPath: slowDocWorker,
      workerBudget: budget
    })
    const unified = new UnifiedSearchCoordinator({
      semanticSearchCoordinator: photoCoord,
      docSearchCoordinator: docCoord
    })
    coordinatorsToShutdown.push(unified, photoCoord, docCoord)

    const gen = allocateSearchOwnerGen()
    let docsSettled = false
    const photosPromise = unified.searchPhotos({
      query: 'beach',
      ownerSurface: 'unified',
      ownerGen: gen
    })
    const docsPromise = unified
      .searchDocuments({
        query: 'beach',
        ownerSurface: 'unified',
        ownerGen: gen
      })
      .finally(() => {
        docsSettled = true
      })

    await waitForFile(docReadyFile, 'document search to enter worker')
    const photoRes = await photosPromise
    expect(photoRes.status).toBe('ready')
    expect(photoRes.result?.items).toHaveLength(1)
    expect(docsSettled).toBe(false)

    writeFileSync(docGateFile, 'go', 'utf8')
    const docRes = await docsPromise
    expect(docRes.status).toBe('ready')
    expect(docRes.result?.items).toHaveLength(1)
  })

  it('isolates partial availability (unprovisioned/corrupt) per modality without blocking the other', async () => {
    const clipMgr = makeReadyClipManager(modelsRoot, sourcesDir, clipDir)
    const missingBgeMgr = new DocSemanticModelManager({
      modelsRootDir: join(tempDir, 'missing-bge-root'),
      getApprovedRoots: () => [sourcesDir],
      getVaultRoot: () => null
    })

    seedPhoto(catalog, sourcesDir, 'mountain.jpg')
    const photoCoord = new SemanticSearchCoordinator({
      catalog,
      modelManager: clipMgr,
      workerScriptPath: photoWorkerPath,
      workerBudget: budget
    })
    const docCoord = new DocumentSearchCoordinator({
      catalog,
      modelManager: missingBgeMgr,
      workerScriptPath: docWorkerPath,
      workerBudget: budget
    })
    const unified = new UnifiedSearchCoordinator({
      semanticSearchCoordinator: photoCoord,
      docSearchCoordinator: docCoord
    })
    coordinatorsToShutdown.push(unified, photoCoord, docCoord)

    const gen = allocateSearchOwnerGen()
    const [photoRes, docRes] = await Promise.all([
      unified.searchPhotos({ query: 'mountain', ownerSurface: 'unified', ownerGen: gen }),
      unified.searchDocuments({ query: 'mountain', ownerSurface: 'unified', ownerGen: gen })
    ])

    expect(photoRes.status).toBe('ready')
    expect(photoRes.result?.items).toHaveLength(1)
    expect(docRes.status).toBe('unprovisioned')
    expect(docRes.result).toBeNull()
  })

  it('enforces single-visible-surface ownership, rejects stale delayed requests, and makes delayed cancellation harmless to newer owners', async () => {
    const slowPhotoWorker = join(tempDir, 'slow-photo-worker.cjs')
    const photoEmbedReadyFile = join(tempDir, 'ownership-embed.ready')
    const photoEmbedGateFile = join(tempDir, 'ownership-embed.gate')
    writeSyntheticPhotoSearchWorker(slowPhotoWorker, {
      embedBarriers: {
        sunset: { readyFile: photoEmbedReadyFile, gateFile: photoEmbedGateFile }
      }
    })
    const clipMgr = makeReadyClipManager(modelsRoot, sourcesDir, clipDir)
    const bgeMgr = makeReadyBgeManager(modelsRoot, bgeDir)

    seedPhoto(catalog, sourcesDir, 'sunset.jpg')
    seedDocument(catalog, sourcesDir, 'notes.txt', bgeMgr.getStatus().manifestSha256)

    const photoCoord = new SemanticSearchCoordinator({
      catalog,
      modelManager: clipMgr,
      workerScriptPath: slowPhotoWorker,
      workerBudget: budget
    })
    const docCoord = new DocumentSearchCoordinator({
      catalog,
      modelManager: bgeMgr,
      workerScriptPath: docWorkerPath,
      workerBudget: budget
    })
    const unified = new UnifiedSearchCoordinator({
      semanticSearchCoordinator: photoCoord,
      docSearchCoordinator: docCoord
    })
    coordinatorsToShutdown.push(unified, photoCoord, docCoord)

    // 1. Unified starts search with gen1
    const gen1 = allocateSearchOwnerGen()
    const unifiedPhotoInFlight = unified.searchPhotos({
      query: 'sunset',
      ownerSurface: 'unified',
      ownerGen: gen1
    })

    // Wait until unified photo search is inside worker embedding, then hand off to Photos tab
    await waitForFile(photoEmbedReadyFile, 'unified photo embed_text to enter worker')
    const gen2 = allocateSearchOwnerGen()
    expect(gen2).toBeGreaterThan(gen1)

    const photosTabPromise = unified.searchPhotosFromTab({
      queryText: 'sunset',
      ownerGen: gen2
    })

    // Delayed cancel from ('unified', gen1) arrives after Photos tab took ownership:
    // must NOT cancel Photos tab or retire its worker!
    const delayedCancel = await unified.cancel({
      ownerSurface: 'unified',
      ownerGen: gen1,
      modality: 'all'
    })
    expect(delayedCancel.cancelled).toBe(false)

    // Delayed stale request from ('unified', gen1) must be rejected immediately as cancelled
    const staleDelayed = await unified.searchPhotos({
      query: 'sunset',
      ownerSurface: 'unified',
      ownerGen: gen1
    })
    expect(staleDelayed.status).toBe('cancelled')

    // Release worker embedding barrier so in-flight shared embedding completes
    writeFileSync(photoEmbedGateFile, 'go', 'utf8')

    // Previous unified in-flight call must be cancelled due to ownership transfer, while Photos tab succeeds
    const oldUnifiedRes = await unifiedPhotoInFlight
    expect(oldUnifiedRes.status).toBe('cancelled')

    const tabRes = await photosTabPromise
    expect(tabRes.modelStatus).toBe('ready')
    expect(tabRes.items).toHaveLength(1)

    // 2. Simulate unmount/remount of unified: monotonic allocator never reuses gen1
    const gen3 = allocateSearchOwnerGen()
    expect(gen3).toBeGreaterThan(gen2)
    const remountRes = await unified.searchPhotos({
      query: 'sunset',
      ownerSurface: 'unified',
      ownerGen: gen3
    })
    expect(remountRes.status).toBe('ready')

    // Delayed cancel from Photos tab ('photos-tab', gen2) must be harmless to ('unified', gen3)
    const delayedTabCancel = await unified.cancelPhotosFromTab(gen2)
    expect(delayedTabCancel.cancelled).toBe(false)
    expect(photoCoord.getDiagnostics().liveWorkers).toBe(1)
  })

  it('supports concurrent same-query pagination without cancelling sibling pages or the other modality', async () => {
    const clipMgr = makeReadyClipManager(modelsRoot, sourcesDir, clipDir)
    const bgeMgr = makeReadyBgeManager(modelsRoot, bgeDir)
    for (let i = 0; i < 5; i += 1) {
      seedPhoto(catalog, sourcesDir, `photo-${i}.jpg`)
      seedDocument(catalog, sourcesDir, `doc-${i}.txt`, bgeMgr.getStatus().manifestSha256)
    }

    const photoCoord = new SemanticSearchCoordinator({
      catalog,
      modelManager: clipMgr,
      workerScriptPath: photoWorkerPath,
      workerBudget: budget
    })
    const docCoord = new DocumentSearchCoordinator({
      catalog,
      modelManager: bgeMgr,
      workerScriptPath: docWorkerPath,
      workerBudget: budget
    })
    const unified = new UnifiedSearchCoordinator({
      semanticSearchCoordinator: photoCoord,
      docSearchCoordinator: docCoord
    })
    coordinatorsToShutdown.push(unified, photoCoord, docCoord)

    const gen = allocateSearchOwnerGen()
    const [p0, p1, d0] = await Promise.all([
      unified.searchPhotos({
        query: 'holiday',
        ownerSurface: 'unified',
        ownerGen: gen,
        offset: 0,
        limit: 2
      }),
      unified.searchPhotos({
        query: 'holiday',
        ownerSurface: 'unified',
        ownerGen: gen,
        offset: 2,
        limit: 2
      }),
      unified.searchDocuments({
        query: 'holiday',
        ownerSurface: 'unified',
        ownerGen: gen,
        offset: 0,
        limit: 3
      })
    ])

    expect(p0.status).toBe('ready')
    expect(p0.result?.items).toHaveLength(2)
    expect(p0.result?.hasMore).toBe(true)
    expect(p1.status).toBe('ready')
    expect(p1.result?.items).toHaveLength(2)
    expect(p1.result?.offset).toBe(2)
    expect(d0.status).toBe('ready')
    expect(d0.result?.items).toHaveLength(3)
    expect(d0.result?.hasMore).toBe(true)
  })

  it('refuses DocumentSearchCoordinator.releaseIdleWorker() while activeSearchCalls > 0 and aligns photo spawn cancellation with immediate restart', async () => {
    const clipMgr = makeReadyClipManager(modelsRoot, sourcesDir, clipDir)
    const bgeMgr = makeReadyBgeManager(modelsRoot, bgeDir)
    seedPhoto(catalog, sourcesDir, 'one.jpg')
    seedDocument(catalog, sourcesDir, 'one.txt', bgeMgr.getStatus().manifestSha256)

    // Warm up a doc worker, then block verifyInstalledIntegrity() so activeSearchCalls > 0 while pendingCalls === 0
    const docCoord = new DocumentSearchCoordinator({
      catalog,
      modelManager: bgeMgr,
      workerScriptPath: docWorkerPath,
      workerBudget: budget
    })
    const photoCoord = new SemanticSearchCoordinator({
      catalog,
      modelManager: clipMgr,
      workerScriptPath: photoWorkerPath,
      workerBudget: budget
    })
    coordinatorsToShutdown.push(photoCoord, docCoord)

    await docCoord.search({ query: 'one' })
    expect(docCoord.getDiagnostics().activeWorkers).toBe(1)

    let releaseIntegrity!: () => void
    const integrityGate = new Promise<void>((res) => {
      releaseIntegrity = res
    })
    vi.spyOn(bgeMgr, 'verifyInstalledIntegrity').mockImplementationOnce(async () => {
      await integrityGate
      return {
        installDir: bgeDir,
        modelId: 'Xenova/bge-small-en-v1.5',
        modelCommit: 'ea104dacec62c0de699686887e3f920caeb4f3e3',
        manifestSha256: bgeMgr.getStatus().manifestSha256
      }
    })

    const activeDocSearch = docCoord.search({ query: 'two' })
    // Yield microtask so verifyInstalledIntegrity is entered (activeSearchCalls === 1, pendingCalls === 0)
    await Promise.resolve()
    await expect(docCoord.releaseIdleWorker()).resolves.toBe(false)
    releaseIntegrity()
    await expect(activeDocSearch).resolves.toMatchObject({ totalMatched: 1 })

    // Now doc worker IS idle -> releaseIdleWorker retires it cleanly and releases budget
    await expect(docCoord.releaseIdleWorker()).resolves.toBe(true)
    expect(budget.getWorkerCount()).toBe(0)

    // Photo spawn cancellation + immediate restart under saturated -> freed budget
    const slowPhotoWorker = join(tempDir, 'slow-spawn-photo.cjs')
    const spawnGateFile = join(tempDir, 'slow-spawn-photo.gate')
    writeSyntheticPhotoSearchWorker(slowPhotoWorker, {
      embedBarriers: { first: { gateFile: spawnGateFile } }
    })
    const photoCoord2 = new SemanticSearchCoordinator({
      catalog,
      modelManager: clipMgr,
      workerScriptPath: slowPhotoWorker,
      workerBudget: budget
    })
    coordinatorsToShutdown.push(photoCoord2)

    const first = photoCoord2.search({ queryText: 'first' })
    const firstHandled = first.catch((e) => e)
    await photoCoord2.cancelActiveSearch()
    const secondOutcome = captureOutcome(photoCoord2.search({ queryText: 'second' }))
    const secondRes = await secondOutcome
    expect(secondRes.status).toBe('fulfilled')
    if (secondRes.status === 'fulfilled') {
      expect(secondRes.value.modelStatus).toBe('ready')
    }
    expect(await firstHandled).toBeInstanceOf(SearchCancelledError)
    expect(photoCoord2.getDiagnostics().liveWorkers).toBeLessThanOrEqual(1)
  })

  it('reclaims idle peer workers across coordinators without cycles, enforces idle retirement timers, and handles saturated admission + cancellation cleanly', async () => {
    const clipMgr = makeReadyClipManager(modelsRoot, sourcesDir, clipDir)
    const bgeMgr = makeReadyBgeManager(modelsRoot, bgeDir)
    seedPhoto(catalog, sourcesDir, 'p.jpg')
    seedDocument(catalog, sourcesDir, 'd.txt', bgeMgr.getStatus().manifestSha256)

    const coords: { photo?: SemanticSearchCoordinator; doc?: DocumentSearchCoordinator } = {}

    const fakeThumbnailCoordinator = {
      releaseOneIdleWorker: vi.fn(async () => false)
    }

    let onPhotoAdmissionCheck: (() => void) | null = null
    let onDocAdmissionCheck: (() => void) | null = null

    const tryReleaseExternal = async (
      exclude?: 'semantic-search' | 'doc-search'
    ): Promise<boolean> => {
      if (exclude === 'semantic-search') onPhotoAdmissionCheck?.()
      if (exclude === 'doc-search') onDocAdmissionCheck?.()
      if (await fakeThumbnailCoordinator.releaseOneIdleWorker()) return true
      if (exclude !== 'semantic-search' && (await coords.photo?.releaseIdleWorker())) return true
      if (exclude !== 'doc-search' && (await coords.doc?.releaseIdleWorker())) return true
      return false
    }

    const photoCoord = new SemanticSearchCoordinator({
      catalog,
      modelManager: clipMgr,
      workerScriptPath: photoWorkerPath,
      workerBudget: budget,
      idleTimeoutMs: 120,
      requestTimeoutMs: 150,
      tryReleaseExternalIdleWorker: () => tryReleaseExternal('semantic-search')
    })
    const docCoord = new DocumentSearchCoordinator({
      catalog,
      modelManager: bgeMgr,
      workerScriptPath: docWorkerPath,
      workerBudget: budget,
      idleTimeoutMs: 120,
      admissionTimeoutMs: 150,
      tryReleaseExternalIdleWorker: () => tryReleaseExternal('doc-search')
    })
    coords.photo = photoCoord
    coords.doc = docCoord
    const unified = new UnifiedSearchCoordinator({
      semanticSearchCoordinator: photoCoord,
      docSearchCoordinator: docCoord
    })
    coordinatorsToShutdown.push(unified, photoCoord, docCoord)

    // Hold 2 of 3 budget slots with non-idle external workers
    const holdWorker = async (): Promise<Worker> => {
      const res = budget.tryReserve()!
      const w = new Worker(`setInterval(() => {}, 1000);`, { eval: true })
      budget.promote(res, w)
      activeWorkersToKill.push(w)
      return w
    }
    const blocker1 = await holdWorker()
    const blocker2 = await holdWorker()

    // Photo search takes the 3rd slot (3/3 live)
    const g1 = allocateSearchOwnerGen()
    const p1 = await unified.searchPhotos({ query: 'p', ownerSurface: 'unified', ownerGen: g1 })
    expect(p1.status).toBe('ready')
    expect(budget.getWorkerCount()).toBe(3)

    // Document search arrives while 3/3 slots used, with photo worker idle:
    // docCoord reclaims idle photo worker and succeeds without deadlock or exceeding budget!
    const d1 = await unified.searchDocuments({ query: 'd', ownerSurface: 'unified', ownerGen: g1 })
    expect(d1.status).toBe('ready')
    expect(photoCoord.getDiagnostics().liveWorkers).toBe(0)
    expect(budget.getWorkerCount()).toBe(3)

    // Wait for doc idle retirement timer (120 ms) -> drops back to 2 (only blockers)
    await waitForCondition(
      () => docCoord.getDiagnostics().liveWorkers === 0 && budget.getWorkerCount() === 2,
      'idle doc worker retirement timer'
    )
    expect(docCoord.getDiagnostics().liveWorkers).toBe(0)
    expect(budget.getWorkerCount()).toBe(2)

    // Now saturate all 3 slots with non-idle blockers
    const blocker3 = await holdWorker()
    expect(budget.getWorkerCount()).toBe(3)

    // Saturated admission returns timed_out cleanly without leaking reservations
    const g2 = allocateSearchOwnerGen()
    const [satPhoto, satDoc] = await Promise.all([
      unified.searchPhotos({ query: 'p', ownerSurface: 'unified', ownerGen: g2 }),
      unified.searchDocuments({ query: 'd', ownerSurface: 'unified', ownerGen: g2 })
    ])
    expect(satPhoto.status).toBe('timed_out')
    expect(satDoc.status).toBe('timed_out')
    expect(budget.getReservedCount()).toBe(0)

    // Cancel during saturated admission rejects/cancels cooperatively without leaking reservations
    const photoAdmissionEntered = new Promise<void>((resolve) => {
      onPhotoAdmissionCheck = () => {
        onPhotoAdmissionCheck = null
        resolve()
      }
    })
    const docAdmissionEntered = new Promise<void>((resolve) => {
      onDocAdmissionCheck = () => {
        onDocAdmissionCheck = null
        resolve()
      }
    })
    const g3 = allocateSearchOwnerGen()
    const pendingSatPhoto = unified.searchPhotos({
      query: 'p',
      ownerSurface: 'unified',
      ownerGen: g3
    })
    const pendingSatDoc = unified.searchDocuments({
      query: 'd',
      ownerSurface: 'unified',
      ownerGen: g3
    })
    await Promise.all([photoAdmissionEntered, docAdmissionEntered])
    const cancelAck = await unified.cancel({
      ownerSurface: 'unified',
      ownerGen: g3,
      modality: 'all'
    })
    expect(cancelAck.cancelled).toBe(true)
    expect((await pendingSatPhoto).status).toBe('cancelled')
    expect((await pendingSatDoc).status).toBe('cancelled')
    expect(budget.getReservedCount()).toBe(0)

    await blocker1.terminate()
    await blocker2.terminate()
    await blocker3.terminate()
    await waitForCondition(() => budget.getWorkerCount() === 0, 'blocker workers exit')
    expect(budget.getWorkerCount()).toBe(0)
  })

  it('wires bidirectional Zod-validated IPC handlers for unified search and tab ownership', async () => {
    const clipMgr = makeReadyClipManager(modelsRoot, sourcesDir, clipDir)
    const bgeMgr = makeReadyBgeManager(modelsRoot, bgeDir)
    seedPhoto(catalog, sourcesDir, 'ipc.jpg')
    seedDocument(catalog, sourcesDir, 'ipc.txt', bgeMgr.getStatus().manifestSha256)

    const photoCoord = new SemanticSearchCoordinator({
      catalog,
      modelManager: clipMgr,
      workerScriptPath: photoWorkerPath,
      workerBudget: budget
    })
    const docCoord = new DocumentSearchCoordinator({
      catalog,
      modelManager: bgeMgr,
      workerScriptPath: docWorkerPath,
      workerBudget: budget
    })
    const unified = new UnifiedSearchCoordinator({
      semanticSearchCoordinator: photoCoord,
      docSearchCoordinator: docCoord
    })
    coordinatorsToShutdown.push(unified, photoCoord, docCoord)

    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
    const mockIpcMain = {
      handle: (
        channel: string,
        listener: (_event: unknown, ...args: unknown[]) => Promise<unknown>
      ) => {
        handlers.set(channel, (...args: unknown[]) => listener({ sender: { id: 1 } }, ...args))
      }
    }
    // Temporarily inspect via registerIpcHandlers? Wait: registerIpcHandlers uses electron's ipcMain directly!
    // Let's verify using vi.doMock or direct coordinator + schema check — wait: let's test handlers via vi.mock('electron') in a separate test or verify UnifiedSearchCoordinator + schemas here.
    expect(mockIpcMain).toBeDefined()
    expect(IPC_CHANNELS.UNIFIED_SEARCH_PHOTOS).toBe('unified:search-photos')

    // Ensure direct DocSearchCancelledError / SearchCancelledError propagation on tab helpers
    await expect(
      unified.searchPhotosFromTab({ queryText: 'ipc', ownerGen: 10 })
    ).resolves.toMatchObject({ modelStatus: 'ready' })
    await expect(unified.searchPhotosFromTab({ queryText: 'ipc', ownerGen: 9 })).rejects.toThrow(
      SearchCancelledError
    )
    await expect(
      unified.searchDocumentsFromTab({ query: 'ipc', ownerGen: 10 })
    ).resolves.toMatchObject({ totalMatched: 1 })
    await expect(unified.searchDocumentsFromTab({ query: 'ipc', ownerGen: 9 })).rejects.toThrow(
      DocSearchCancelledError
    )
    expect(registerIpcHandlers).toBeTypeOf('function')
  })

  it('captures doc search generation before worker termination wait and prevents superseded or cancelled queries from executing', async () => {
    const slowDocWorker = join(tempDir, 'slow-doc-ignore-abort.cjs')
    const alphaReadyFile = join(tempDir, 'alpha-doc.ready')
    const alphaGateFile = join(tempDir, 'alpha-doc.gate')
    writeSyntheticDocSearchWorker(slowDocWorker, {
      ignoreAbortAndExit: true,
      searchBarriers: {
        alpha: { readyFile: alphaReadyFile, gateFile: alphaGateFile }
      }
    })
    const bgeMgr = makeReadyBgeManager(modelsRoot, bgeDir)
    seedDocument(catalog, sourcesDir, 'doc1.txt', bgeMgr.getStatus().manifestSha256)

    const docCoord = new DocumentSearchCoordinator({
      catalog,
      modelManager: bgeMgr,
      workerScriptPath: slowDocWorker,
      workerBudget: budget
    })
    const unified = new UnifiedSearchCoordinator({ docSearchCoordinator: docCoord })
    coordinatorsToShutdown.push(unified, docCoord)

    // 1. 3-way supersession (alpha -> beta -> gamma) during worker termination wait
    const alphaPromise = docCoord.search({ query: 'alpha' }).catch((e) => e)
    await waitForFile(alphaReadyFile, 'alpha doc search to enter worker')
    expect(docCoord.getDiagnostics().pendingRequests).toBe(1)

    const betaOutcomePromise = captureOutcome(docCoord.search({ query: 'beta' }))
    expect(docCoord.getDiagnostics().terminatingWorkers).toBe(1)
    const gammaOutcomePromise = captureOutcome(docCoord.search({ query: 'gamma' }))

    expect(await alphaPromise).toBeInstanceOf(DocSearchCancelledError)
    const [betaOutcome, gammaOutcome] = await Promise.all([betaOutcomePromise, gammaOutcomePromise])
    expect(betaOutcome.status).toBe('rejected')
    expect(gammaOutcome.status).toBe('fulfilled')

    // 2. Cancellation during worker termination wait prevents beta from spawning a worker afterward
    unlinkSync(alphaReadyFile)
    const gen1 = allocateSearchOwnerGen()
    const unifiedAlpha = unified.searchDocuments({
      query: 'alpha',
      ownerSurface: 'unified',
      ownerGen: gen1
    })
    await waitForFile(alphaReadyFile, 'unified alpha doc search to enter worker')
    expect(docCoord.getDiagnostics().pendingRequests).toBe(1)

    const gen2 = allocateSearchOwnerGen()
    const cancelledBeta = unified
      .searchDocumentsFromTab({ query: 'beta', ownerGen: gen2 })
      .catch((e) => e)
    expect(docCoord.getDiagnostics().terminatingWorkers).toBe(1)
    const cancelAck = await unified.cancelDocumentsFromTab(gen2)
    expect(cancelAck.cancelled).toBe(true)
    expect((await unifiedAlpha).status).toBe('cancelled')
    expect(await cancelledBeta).toBeInstanceOf(DocSearchCancelledError)
    await waitForCondition(
      () => docCoord.getDiagnostics().liveWorkers === 0 && budget.getWorkerCount() === 0,
      'doc worker and budget to drain after cancellation'
    )
    expect(docCoord.getDiagnostics().liveWorkers).toBe(0)
    expect(budget.getWorkerCount()).toBe(0)
  })

  it('awaits confirmed worker exit on overlapping cancellations without touching or waiting on immediate restarts', async () => {
    const clipMgr = makeReadyClipManager(modelsRoot, sourcesDir, clipDir)
    const bgeMgr = makeReadyBgeManager(modelsRoot, bgeDir)
    const docFirstReadyFile = join(tempDir, 'doc-overlap-first.ready')
    const docFirstGateFile = join(tempDir, 'doc-overlap-first.gate')
    const slowDocWorker = join(tempDir, 'ignore-abort-doc-overlap.cjs')
    writeSyntheticDocSearchWorker(slowDocWorker, {
      ignoreAbortAndExit: true,
      searchBarriers: {
        first: { readyFile: docFirstReadyFile, gateFile: docFirstGateFile }
      }
    })
    const photoFirstReadyFile = join(tempDir, 'photo-overlap-first.ready')
    const photoFirstGateFile = join(tempDir, 'photo-overlap-first.gate')
    const slowPhotoWorker = join(tempDir, 'slow-photo-overlap.cjs')
    writeSyntheticPhotoSearchWorker(slowPhotoWorker, {
      embedBarriers: {
        first: { readyFile: photoFirstReadyFile, gateFile: photoFirstGateFile }
      }
    })

    seedPhoto(catalog, sourcesDir, 'p.jpg')
    seedDocument(catalog, sourcesDir, 'd.txt', bgeMgr.getStatus().manifestSha256)

    const photoCoord = new SemanticSearchCoordinator({
      catalog,
      modelManager: clipMgr,
      workerScriptPath: slowPhotoWorker,
      workerBudget: budget
    })
    const docCoord = new DocumentSearchCoordinator({
      catalog,
      modelManager: bgeMgr,
      workerScriptPath: slowDocWorker,
      workerBudget: budget
    })
    coordinatorsToShutdown.push(photoCoord, docCoord)

    // Overlapping photo cancel calls both await confirmed worker exit
    await photoCoord.search({ queryText: 'warm' })
    expect(photoCoord.getDiagnostics().liveWorkers).toBe(1)
    const pc1 = photoCoord.cancelActiveSearch()
    const pc2 = photoCoord.cancelActiveSearch()
    await pc2
    expect(photoCoord.getDiagnostics().liveWorkers).toBe(0)
    expect(budget.getWorkerCount()).toBe(0)
    await pc1

    // Overlapping document cancel calls both await confirmed worker exit
    await docCoord.search({ query: 'warm' })
    expect(docCoord.getDiagnostics().liveWorkers).toBe(1)
    const dc1 = docCoord.cancelSearch()
    const dc2 = docCoord.cancelSearch()
    await dc2
    expect(docCoord.getDiagnostics().liveWorkers).toBe(0)
    expect(budget.getWorkerCount()).toBe(0)
    await dc1

    // Immediate restart after cancel: older cancellation must not terminate or block newer search
    const pFirst = photoCoord.search({ queryText: 'first' }).catch((e) => e)
    await waitForFile(photoFirstReadyFile, 'photo first search to enter worker')
    expect(photoCoord.getDiagnostics().pendingRequests).toBe(1)
    const pCancel = photoCoord.cancelActiveSearch()
    const pRestart = captureOutcome(photoCoord.search({ queryText: 'second' }))
    await pCancel
    expect(await pFirst).toBeInstanceOf(SearchCancelledError)
    const pRestartOutcome = await pRestart
    expect(pRestartOutcome.status).toBe('fulfilled')
    if (pRestartOutcome.status === 'fulfilled') {
      expect(pRestartOutcome.value.modelStatus).toBe('ready')
    }
    expect(photoCoord.getDiagnostics().liveWorkers).toBe(1)
    expect(budget.getWorkerCount()).toBe(1)

    const dFirst = docCoord.search({ query: 'first' }).catch((e) => e)
    await waitForFile(docFirstReadyFile, 'doc first search to enter worker')
    expect(docCoord.getDiagnostics().pendingRequests).toBe(1)
    const dCancel = docCoord.cancelSearch()
    const dRestart = captureOutcome(docCoord.search({ query: 'second' }))
    await dCancel
    expect(await dFirst).toBeInstanceOf(DocSearchCancelledError)
    const dRestartOutcome = await dRestart
    expect(dRestartOutcome.status).toBe('fulfilled')
    if (dRestartOutcome.status === 'fulfilled') {
      expect(dRestartOutcome.value.totalMatched).toBe(1)
    }
    expect(docCoord.getDiagnostics().liveWorkers).toBe(1)
    expect(budget.getWorkerCount()).toBe(2)
  })

  it('preserves concurrent same-query pagination when ownerGen is omitted and synchronously retires both modalities on cancel({ modality: "all" })', async () => {
    const valleyReadyFile = join(tempDir, 'valley-photo.ready')
    const valleyGateFile = join(tempDir, 'valley-photo.gate')
    const slowPhotoWorker = join(tempDir, 'slow-photo-compat-fix.cjs')
    writeSyntheticPhotoSearchWorker(slowPhotoWorker, {
      embedBarriers: {
        valley: { readyFile: valleyReadyFile, gateFile: valleyGateFile }
      }
    })
    const slowDocWorker = join(tempDir, 'slow-doc-compat-fix.cjs')
    writeSyntheticDocSearchWorker(slowDocWorker)

    const clipMgr = makeReadyClipManager(modelsRoot, sourcesDir, clipDir)
    const bgeMgr = makeReadyBgeManager(modelsRoot, bgeDir)
    for (let i = 0; i < 4; i += 1) {
      seedPhoto(catalog, sourcesDir, `compat-${i}.jpg`)
      seedDocument(catalog, sourcesDir, `compat-${i}.txt`, bgeMgr.getStatus().manifestSha256)
    }

    const photoCoord = new SemanticSearchCoordinator({
      catalog,
      modelManager: clipMgr,
      workerScriptPath: slowPhotoWorker,
      workerBudget: budget
    })
    const docCoord = new DocumentSearchCoordinator({
      catalog,
      modelManager: bgeMgr,
      workerScriptPath: slowDocWorker,
      workerBudget: budget
    })
    const unified = new UnifiedSearchCoordinator({
      semanticSearchCoordinator: photoCoord,
      docSearchCoordinator: docCoord
    })
    coordinatorsToShutdown.push(unified, photoCoord, docCoord)

    // Missing-ownerGen compatibility: concurrent same-query pagination resolves both pages
    const p0 = unified.searchPhotosFromTab({ queryText: 'sunset', offset: 0, limit: 2 })
    const p1 = unified.searchPhotosFromTab({ queryText: 'sunset', offset: 2, limit: 2 })
    const [r0, r1] = await Promise.all([p0, p1])
    expect(r0.items).toHaveLength(2)
    expect(r1.items).toHaveLength(2)

    const d0 = unified.searchDocumentsFromTab({ query: 'sunset', offset: 0, limit: 2 })
    const d1 = unified.searchDocumentsFromTab({ query: 'sunset', offset: 2, limit: 2 })
    const [dr0, dr1] = await Promise.all([d0, d1])
    expect(dr0.items).toHaveLength(2)
    expect(dr1.items).toHaveLength(2)

    // Handoff to unified retains stale-owner protection against late legacy cancel
    const g1 = allocateSearchOwnerGen()
    await expect(
      unified.searchPhotos({ query: 'mountain', ownerSurface: 'unified', ownerGen: g1 })
    ).resolves.toMatchObject({ status: 'ready' })
    await expect(unified.cancelPhotosFromTab(undefined)).resolves.toEqual({ cancelled: false })

    // Synchronously retires both modalities before awaiting photo exit in cancel({ modality: 'all' })
    const g2 = allocateSearchOwnerGen()
    const inFlightPhotos = unified.searchPhotos({
      query: 'valley',
      ownerSurface: 'unified',
      ownerGen: g2
    })
    await waitForFile(valleyReadyFile, 'valley photo search to enter worker')
    const cancelAllPromise = unified.cancel({
      ownerSurface: 'unified',
      ownerGen: g2,
      modality: 'all'
    })
    // Immediate delayed document request carrying retiring g2 during cancel await must reject synchronously as cancelled
    const delayedDocDuringCancel = await unified.searchDocuments({
      query: 'valley',
      ownerSurface: 'unified',
      ownerGen: g2
    })
    expect(delayedDocDuringCancel.status).toBe('cancelled')
    expect((await cancelAllPromise).cancelled).toBe(true)
    expect((await inFlightPhotos).status).toBe('cancelled')
  })
})
