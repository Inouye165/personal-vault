// @vitest-environment node
/**
 * Stage 7D Slice 3 — Independent-review regression tests.
 *
 * 1. Search supersession during worker admission must not inherit the older query's
 *    cancellation through a shared `spawningWorkerPromise`.
 * 2. Main-process revalidation must compare the identity actually scored by the worker
 *    (source observation, active hash/content revision, extraction provenance, semantic
 *    track/chunk compatibility and currency) and never show stale items as current.
 * 3. Real built worker attaches scored identities, OCR provenance, and partial-index metadata.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CatalogDatabase, buildDocumentContentRevision } from '../../src/main/services/catalog'
import type { DocSearchScoredIdentity } from '../../src/main/services/catalog/document-semantic-repository'
import { DEFAULT_DOC_SEMANTIC_COMPATIBILITY_SPEC } from '../../src/main/services/catalog/document-semantic-snapshot-query'
import {
  computeNormalizedTextSha256,
  DOC_SEMANTIC_EMBEDDING_DIMENSIONS,
  DocSearchCancelledError,
  DocSearchStaleError,
  DocSemanticModelManager,
  DocumentSearchCoordinator,
  l2NormalizeDocVector,
  normalizeDocumentText,
  type DocSemanticModelArtifactSpec
} from '../../src/main/services/documents/semantic'
import { DOCUMENT_EXTRACTION_RECIPE_VERSION } from '../../src/main/services/documents/types'
import { AppWorkerBudget } from '../../src/main/services/worker-budget'

const REPO_ROOT = resolve(__dirname, '../..')
const BUILT_SEARCH_WORKER = join(REPO_ROOT, 'out', 'main', 'doc_search_worker.js')
const CACHED_BGE_DIR = join(
  REPO_ROOT,
  'spikes',
  'doc-semantic-eval',
  '.model-cache',
  'bge-small-en-v1.5'
)
const NOW = 1_700_000_000_000
const COMPAT = DEFAULT_DOC_SEMANTIC_COMPATIBILITY_SPEC

function sha256Hex(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex')
}

function createSyntheticModel(dir: string): DocSemanticModelArtifactSpec[] {
  const files: Array<{ relativePath: string; content: Buffer }> = [
    { relativePath: 'config.json', content: Buffer.from('{"hidden_size":384}\n', 'utf8') },
    { relativePath: 'tokenizer.json', content: Buffer.from('{"version":"1.0"}\n', 'utf8') },
    { relativePath: 'tokenizer_config.json', content: Buffer.from('{"model_max_length":512}\n') },
    { relativePath: 'special_tokens_map.json', content: Buffer.from('{"cls_token":"[CLS]"}\n') },
    { relativePath: 'onnx/model_quantized.onnx', content: Buffer.from('SYNTH_ONNX_MODEL', 'utf8') }
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

function makeUnitVec(seed: number): Float32Array {
  const raw = new Float32Array(DOC_SEMANTIC_EMBEDDING_DIMENSIONS)
  raw[0] = Math.cos(seed)
  raw[1] = Math.sin(seed)
  raw[2] = 0.1
  return l2NormalizeDocVector(raw, DOC_SEMANTIC_EMBEDDING_DIMENSIONS)
}

interface SeededDoc {
  readonly fileLocationId: number
  readonly discoveryObservationId: number
  readonly sourceId: number
  readonly chunkId: number
}

function seedNativeIndexedDocument(
  catalog: CatalogDatabase,
  fileName: string,
  text: string,
  manifestSha256?: string
): SeededDoc {
  const db = catalog.getRawDatabaseForTesting()
  let src = db.prepare('SELECT id FROM sources LIMIT 1;').get() as { id: number } | undefined
  if (!src) {
    const res = db
      .prepare(
        `INSERT INTO sources (root_path, normalized_root_path, created_at_ms, updated_at_ms)
         VALUES ('D:\\fixtures\\docs', 'd:\\fixtures\\docs', ?, ?);`
      )
      .run(NOW, NOW)
    src = { id: Number(res.lastInsertRowid) }
  }
  const sha = sha256Hex(fileName)
  const fid = Number(
    db
      .prepare(
        `INSERT INTO file_locations (source_id, original_path, normalized_path, file_name, extension, category, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, '.txt', 'document', ?, ?);`
      )
      .run(
        src.id,
        `D:\\fixtures\\docs\\${fileName}`,
        `d:\\fixtures\\docs\\${fileName}`,
        fileName,
        NOW,
        NOW
      ).lastInsertRowid
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
         VALUES (?, ?, ?, 512, ?, ?, ?, 'extracted', ?, ?, 1, ?);`
      )
      .run(fid, oid, sha, NOW, rev, DOCUMENT_EXTRACTION_RECIPE_VERSION, text, text.length, NOW)
      .lastInsertRowid
  )
  const norm = normalizeDocumentText(text)
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
    normalizedTextSha256: computeNormalizedTextSha256(norm),
    compat: manifestSha256 ? { ...COMPAT, docModelManifestSha256: manifestSha256 } : COMPAT,
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
        vector: makeUnitVec(0.1)
      }
    ]
  })
  const chunk = db
    .prepare(
      'SELECT id FROM document_semantic_chunks WHERE file_location_id = ? AND is_current = 1;'
    )
    .get(fid) as { id: number }
  return {
    fileLocationId: fid,
    discoveryObservationId: oid,
    sourceId: src.id,
    chunkId: Number(chunk.id)
  }
}

function buildItem(
  doc: SeededDoc,
  identity: DocSearchScoredIdentity | null,
  fileName = 'doc1.txt'
) {
  return {
    fileLocationId: doc.fileLocationId,
    score: 0.9,
    winningChunkId: doc.chunkId,
    winningChunkIndex: 0,
    textSourceKind: 'native',
    charOffsetStart: 0,
    charOffsetEnd: 20,
    truncated: false,
    normalizedCharCount: 20,
    indexedCharCount: 20,
    coverageRatio: 1,
    originalPath: `D:\\fixtures\\docs\\${fileName}`,
    fileName,
    extension: '.txt',
    winningSnippet: 'Cloud invoice $1,250',
    ...(identity ? { scoredIdentity: identity } : {})
  }
}

function buildResponse(items: unknown[], totalMatched = items.length) {
  return {
    ok: true,
    items,
    totalMatched,
    hasMore: false,
    eligibleChunkCount: totalMatched,
    corruptChunkCount: 0,
    queryTokenCount: 4,
    queryTruncated: false,
    queryLatencyMs: 3,
    nestedWorkerAttempts: 0,
    outboundNetworkAttempts: 0
  }
}

describe('Stage 7D Slice 3 — independent-review regressions', () => {
  let tempDir: string
  let catalog: CatalogDatabase
  let modelManager: DocSemanticModelManager
  let queueWorkerPath: string
  let responsesPath: string
  let countPath: string

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'pv-doc-sem-fix-'))
    catalog = CatalogDatabase.open({ catalogPath: join(tempDir, 'catalog.db') })
    const modelsRoot = join(tempDir, 'models')
    const sourceModelDir = join(tempDir, 'source-model')
    mkdirSync(modelsRoot, { recursive: true })
    mkdirSync(sourceModelDir, { recursive: true })
    const artifacts = createSyntheticModel(sourceModelDir)
    modelManager = new DocSemanticModelManager({
      modelsRootDir: modelsRoot,
      getApprovedRoots: () => ['D:\\fixtures\\docs'],
      getVaultRoot: () => null,
      artifacts
    })
    await modelManager.importFromDirectory(sourceModelDir)

    responsesPath = join(tempDir, 'responses.json')
    countPath = join(tempDir, 'request-count.txt')
    writeFileSync(responsesPath, JSON.stringify([buildResponse([])]), 'utf8')
    queueWorkerPath = join(tempDir, 'queue-doc-search-worker.cjs')
    // Deterministic scripted worker: returns the Nth scripted response for the Nth search.
    writeFileSync(
      queueWorkerPath,
      `
const { parentPort } = require('node:worker_threads');
const { readFileSync, writeFileSync } = require('node:fs');
let n = 0;
parentPort.on('message', (msg) => {
  if (msg.type === 'abort_and_exit') { process.exit(0); return; }
  const responses = JSON.parse(readFileSync(${JSON.stringify(responsesPath)}, 'utf8'));
  const resp = responses[Math.min(n, responses.length - 1)];
  n += 1;
  writeFileSync(${JSON.stringify(countPath)}, String(n), 'utf8');
  setTimeout(() => parentPort.postMessage({ ...resp, id: msg.id }), msg.delayMs || 5);
});
`,
      'utf8'
    )
  })

  afterEach(() => {
    if (catalog && !catalog.isClosed()) catalog.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  const requestCount = (): number =>
    existsSync(countPath) ? Number(readFileSync(countPath, 'utf8')) : 0
  const scriptResponses = (responses: unknown[]): void =>
    writeFileSync(responsesPath, JSON.stringify(responses), 'utf8')

  describe('1. supersession during worker admission', () => {
    it('lets a newer query succeed after it supersedes an older query waiting on saturated AppWorkerBudget', async () => {
      const budget = new AppWorkerBudget(3)
      const held = [budget.tryReserve()!, budget.tryReserve()!, budget.tryReserve()!]
      const coordinator = new DocumentSearchCoordinator({
        catalog,
        modelManager,
        workerBudget: budget,
        workerScriptPath: queueWorkerPath
      })

      const queryA = coordinator.search({ query: 'older query A' })
      const queryAOutcome = queryA.then(
        () => 'resolved',
        (err: unknown) => err
      )
      await new Promise((r) => setTimeout(r, 80))

      const queryB = coordinator.search({ query: 'newer query B' })
      const queryBOutcome = queryB.then(
        (value) => value,
        (err: unknown) => err
      )
      // Let query B reach worker admission while query A's spawn is still waiting for capacity.
      await new Promise((r) => setTimeout(r, 80))

      budget.releaseReservation(held[2]!)

      expect(await queryAOutcome).toBeInstanceOf(DocSearchCancelledError)
      const bResult = await queryBOutcome
      expect(bResult).not.toBeInstanceOf(Error)
      expect((bResult as { totalMatched: number }).totalMatched).toBe(0)

      // Exactly one search worker spawned and counted until confirmed exit.
      expect(budget.getWorkerCount()).toBe(1)
      await coordinator.shutdown()
      expect(budget.getWorkerCount()).toBe(0)
      budget.releaseReservation(held[0]!)
      budget.releaseReservation(held[1]!)
      expect(budget.getReservedCount()).toBe(0)
    })

    it('still cancels admission on shutdown and releases the pending reservation', async () => {
      const budget = new AppWorkerBudget(3)
      const held = [budget.tryReserve()!, budget.tryReserve()!, budget.tryReserve()!]
      const coordinator = new DocumentSearchCoordinator({
        catalog,
        modelManager,
        workerBudget: budget,
        workerScriptPath: queueWorkerPath
      })
      const pending = coordinator.search({ query: 'waiting for capacity' })
      const outcome = pending.then(
        () => 'resolved',
        (err: unknown) => err
      )
      await new Promise((r) => setTimeout(r, 60))
      await coordinator.shutdown()
      expect(await outcome).toBeInstanceOf(DocSearchCancelledError)
      expect(budget.getReservedCount()).toBe(3)
      expect(budget.getWorkerCount()).toBe(0)
      for (const r of held) budget.releaseReservation(r)
    })

    it('still cancels admission on explicit cancelSearch without spawning a worker', async () => {
      const budget = new AppWorkerBudget(3)
      const held = [budget.tryReserve()!, budget.tryReserve()!, budget.tryReserve()!]
      const coordinator = new DocumentSearchCoordinator({
        catalog,
        modelManager,
        workerBudget: budget,
        workerScriptPath: queueWorkerPath
      })
      const outcome = coordinator.search({ query: 'cancel me' }).then(
        () => 'resolved',
        (err: unknown) => err
      )
      await new Promise((r) => setTimeout(r, 60))
      await coordinator.cancelSearch()
      expect(await outcome).toBeInstanceOf(DocSearchCancelledError)
      budget.releaseReservation(held[2]!)
      await new Promise((r) => setTimeout(r, 60))
      expect(budget.getWorkerCount()).toBe(0)
      expect(budget.getReservedCount()).toBe(2)
      await coordinator.shutdown()
      budget.releaseReservation(held[0]!)
      budget.releaseReservation(held[1]!)
    })

    it('F1: lets query B succeed when started immediately after unawaited cancelSearch() during saturated admission', async () => {
      const budget = new AppWorkerBudget(3)
      const held = [budget.tryReserve()!, budget.tryReserve()!, budget.tryReserve()!]

      let resolveAEntered!: () => void
      const aEnteredAdmission = new Promise<void>((r) => {
        resolveAEntered = r
      })
      let releaseABarrier!: (released: boolean) => void
      const aReleaseGate = new Promise<boolean>((r) => {
        releaseABarrier = r
      })
      let callIndex = 0

      const coordinator = new DocumentSearchCoordinator({
        catalog,
        modelManager,
        workerBudget: budget,
        workerScriptPath: queueWorkerPath,
        tryReleaseExternalIdleWorker: async () => {
          callIndex += 1
          if (callIndex === 1) {
            resolveAEntered()
            return await aReleaseGate
          }
          return false
        }
      })

      // 1. Start query A and wait deterministically until it is inside admission
      const queryA = coordinator.search({ query: 'query A' }).then(
        () => 'resolved',
        (err: unknown) => err
      )
      await aEnteredAdmission

      // 2. Start cancelSearch() WITHOUT awaiting completion, then immediately start query B
      const cancelPromise = coordinator.cancelSearch('user cancelled A')
      const queryB = coordinator.search({ query: 'query B' }).then(
        (val) => val,
        (err: unknown) => err
      )

      // 3. Release capacity and unblock barriers
      budget.releaseReservation(held[2]!)
      releaseABarrier(false)

      await cancelPromise
      expect(await queryA).toBeInstanceOf(DocSearchCancelledError)
      const bResult = await queryB
      expect(bResult).not.toBeInstanceOf(Error)
      expect((bResult as { totalMatched: number }).totalMatched).toBe(0)

      expect(budget.getWorkerCount()).toBe(1)
      await coordinator.shutdown()
      expect(budget.getWorkerCount()).toBe(0)
      budget.releaseReservation(held[0]!)
      budget.releaseReservation(held[1]!)
      expect(budget.getReservedCount()).toBe(0)
    })

    it('F1: older spawn delayed idle-worker release cannot clear or retire newer spawn/worker', async () => {
      const budget = new AppWorkerBudget(3)
      const held = [budget.tryReserve()!, budget.tryReserve()!, budget.tryReserve()!]

      let resolveAEntered!: () => void
      const aEnteredAdmission = new Promise<void>((r) => {
        resolveAEntered = r
      })
      let resolveBEntered!: () => void
      const bEnteredAdmission = new Promise<void>((r) => {
        resolveBEntered = r
      })
      let releaseAGate!: (released: boolean) => void
      const aGate = new Promise<boolean>((r) => {
        releaseAGate = r
      })
      let releaseBGate!: (released: boolean) => void
      const bGate = new Promise<boolean>((r) => {
        releaseBGate = r
      })
      let callCount = 0

      const coordinator = new DocumentSearchCoordinator({
        catalog,
        modelManager,
        workerBudget: budget,
        workerScriptPath: queueWorkerPath,
        tryReleaseExternalIdleWorker: async () => {
          callCount += 1
          if (callCount === 1) {
            resolveAEntered()
            return await aGate
          }
          if (callCount === 2) {
            resolveBEntered()
            return await bGate
          }
          return false
        }
      })

      const queryA = coordinator.search({ query: 'query A' }).then(
        () => 'resolved',
        (err: unknown) => err
      )
      await aEnteredAdmission

      // Cancel A without awaiting, then start B so B creates its own spawn while A is still blocked
      const cancelPromise = coordinator.cancelSearch('cancel A')
      const queryB = coordinator.search({ query: 'query B' }).then(
        (val) => val,
        (err: unknown) => err
      )
      await bEnteredAdmission

      // Unblock B first so B reserves capacity and spawns worker W1, THEN unblock A's delayed release
      budget.releaseReservation(held[2]!)
      releaseBGate(true)
      const bResult = await queryB
      expect(bResult).not.toBeInstanceOf(Error)
      expect(budget.getWorkerCount()).toBe(1)

      // Now unblock A's delayed release: A must cancel cleanly WITHOUT retiring B's worker or clearing active state
      releaseAGate(true)
      await cancelPromise
      expect(await queryA).toBeInstanceOf(DocSearchCancelledError)
      expect(budget.getWorkerCount()).toBe(1)

      // A subsequent search still reuses B's healthy worker (still 1 live worker)
      const followUp = await coordinator.search({ query: 'query B' })
      expect(followUp.totalMatched).toBe(0)
      expect(budget.getWorkerCount()).toBe(1)

      await coordinator.shutdown()
      expect(budget.getWorkerCount()).toBe(0)
      budget.releaseReservation(held[0]!)
      budget.releaseReservation(held[1]!)
      expect(budget.getReservedCount()).toBe(0)
    })
  })

  describe('2. scored-identity revalidation', () => {
    const synthCompat = () => ({
      ...COMPAT,
      docModelManifestSha256: modelManager.getStatus().manifestSha256
    })
    const makeCoordinator = (): DocumentSearchCoordinator =>
      new DocumentSearchCoordinator({
        catalog,
        modelManager,
        workerBudget: new AppWorkerBudget(3),
        workerScriptPath: queueWorkerPath
      })

    it('exposes the scored identity of a current compatible chunk', () => {
      const c = synthCompat()
      const doc = seedNativeIndexedDocument(
        catalog,
        'doc1.txt',
        'Cloud invoice $1,250',
        c.docModelManifestSha256
      )
      const repo = catalog.getDocumentSemanticRepository()
      const identity = repo.readChunkSearchIdentity(doc.chunkId, c)
      expect(identity).not.toBeNull()
      expect(identity!.chunkId).toBe(doc.chunkId)
      expect(identity!.fileLocationId).toBe(doc.fileLocationId)
      expect(identity!.discoveryObservationId).toBe(doc.discoveryObservationId)
      expect(identity!.activeHash).toBe(sha256Hex('doc1.txt'))
      expect(repo.revalidateScoredSearchItem(buildItem(doc, identity) as never, c)).toBe(true)
      expect(repo.revalidateScoredSearchItem(buildItem(doc, null) as never, c)).toBe(false)
    })

    it('returns unchanged items without leaking internal scored identity', async () => {
      const c = synthCompat()
      const doc = seedNativeIndexedDocument(
        catalog,
        'doc1.txt',
        'Cloud invoice $1,250',
        c.docModelManifestSha256
      )
      const identity = catalog
        .getDocumentSemanticRepository()
        .readChunkSearchIdentity(doc.chunkId, c)
      scriptResponses([buildResponse([buildItem(doc, identity)])])
      const coordinator = makeCoordinator()
      const res = await coordinator.search({ query: 'cloud invoice' })
      expect(res.items).toHaveLength(1)
      expect(res.totalMatched).toBe(1)
      expect('scoredIdentity' in (res.items[0] as object)).toBe(false)
      expect(requestCount()).toBe(1)
      await coordinator.shutdown()
    })

    it('retries when the discovery observation changes between scoring and hydration', async () => {
      const c = synthCompat()
      const doc = seedNativeIndexedDocument(
        catalog,
        'doc1.txt',
        'Cloud invoice $1,250',
        c.docModelManifestSha256
      )
      const identity = catalog
        .getDocumentSemanticRepository()
        .readChunkSearchIdentity(doc.chunkId, c)
      scriptResponses([buildResponse([buildItem(doc, identity)]), buildResponse([])])
      catalog.persistDiscoveryBatch('D:\\fixtures\\docs', [
        {
          originalPath: 'D:\\fixtures\\docs\\doc1.txt',
          fileName: 'doc1.txt',
          extension: '.txt',
          category: 'document',
          byteSize: 999,
          birthtimeMs: NOW,
          mtimeMs: NOW + 5000,
          discoveredAtMs: NOW + 5000
        }
      ])
      const coordinator = makeCoordinator()
      const res = await coordinator.search({ query: 'cloud invoice' })
      expect(res.items).toHaveLength(0)
      expect(res.totalMatched).toBe(0)
      expect(requestCount()).toBe(2)
      await coordinator.shutdown()
    })

    it('retries when the active content hash changes between scoring and hydration', async () => {
      const c = synthCompat()
      const doc = seedNativeIndexedDocument(
        catalog,
        'doc1.txt',
        'Cloud invoice $1,250',
        c.docModelManifestSha256
      )
      const identity = catalog
        .getDocumentSemanticRepository()
        .readChunkSearchIdentity(doc.chunkId, c)
      scriptResponses([buildResponse([buildItem(doc, identity)]), buildResponse([])])
      catalog
        .getRawDatabaseForTesting()
        .prepare('UPDATE hash_observations SET sha256 = ? WHERE file_location_id = ?;')
        .run(sha256Hex('changed-bytes'), doc.fileLocationId)
      const coordinator = makeCoordinator()
      const res = await coordinator.search({ query: 'cloud invoice' })
      expect(res.items).toHaveLength(0)
      expect(requestCount()).toBe(2)
      await coordinator.shutdown()
    })

    it('retries when the document is re-extracted between scoring and hydration', async () => {
      const c = synthCompat()
      const doc = seedNativeIndexedDocument(
        catalog,
        'doc1.txt',
        'Cloud invoice $1,250',
        c.docModelManifestSha256
      )
      const identity = catalog
        .getDocumentSemanticRepository()
        .readChunkSearchIdentity(doc.chunkId, c)
      scriptResponses([buildResponse([buildItem(doc, identity)]), buildResponse([])])
      const db = catalog.getRawDatabaseForTesting()
      const rev = buildDocumentContentRevision({
        discoveryObservationId: doc.discoveryObservationId,
        byteSize: 512,
        filesystemMtimeMs: NOW,
        activeHash: sha256Hex('doc1.txt')
      })
      db.prepare('UPDATE document_extractions SET is_current = 0 WHERE file_location_id = ?;').run(
        doc.fileLocationId
      )
      db.prepare(
        `INSERT INTO document_extractions (file_location_id, discovery_observation_id, content_sha256, observed_byte_size, observed_mtime_ms,
           content_revision, recipe_version, extraction_status, extracted_text, extracted_char_count, is_current, extracted_at_ms)
         VALUES (?, ?, ?, 512, ?, ?, ?, 'extracted', 'Re-extracted different text', 27, 1, ?);`
      ).run(
        doc.fileLocationId,
        doc.discoveryObservationId,
        sha256Hex('doc1.txt'),
        NOW,
        rev,
        DOCUMENT_EXTRACTION_RECIPE_VERSION,
        NOW + 1
      )
      const coordinator = makeCoordinator()
      const res = await coordinator.search({ query: 'cloud invoice' })
      expect(res.items).toHaveLength(0)
      expect(requestCount()).toBe(2)
      await coordinator.shutdown()
    })

    it('rejects items whose scored identity differs from the current compatible identity', async () => {
      const c = synthCompat()
      const doc = seedNativeIndexedDocument(
        catalog,
        'doc1.txt',
        'Cloud invoice $1,250',
        c.docModelManifestSha256
      )
      const identity = catalog
        .getDocumentSemanticRepository()
        .readChunkSearchIdentity(doc.chunkId, c)!
      const forged = { ...identity, normalizedTextSha256: 'f'.repeat(64) }
      scriptResponses([
        buildResponse([buildItem(doc, forged)]),
        buildResponse([buildItem(doc, identity)])
      ])
      const coordinator = makeCoordinator()
      const res = await coordinator.search({ query: 'cloud invoice' })
      expect(res.items).toHaveLength(1)
      expect(res.totalMatched).toBe(1)
      expect(requestCount()).toBe(2)
      await coordinator.shutdown()
    })

    it('fails explicitly with DocSearchStaleError after bounded retries instead of returning inconsistent counts', async () => {
      const c = synthCompat()
      const doc = seedNativeIndexedDocument(
        catalog,
        'doc1.txt',
        'Cloud invoice $1,250',
        c.docModelManifestSha256
      )
      scriptResponses([buildResponse([buildItem(doc, null)], 7)])
      const coordinator = makeCoordinator()
      const outcome = await coordinator.search({ query: 'cloud invoice' }).then(
        () => null,
        (err: unknown) => err
      )
      expect(outcome).toBeInstanceOf(DocSearchStaleError)
      expect((outcome as { code: string }).code).toBe('DOC_SEARCH_STALE')
      expect(requestCount()).toBe(3)
      await coordinator.shutdown()
    })
  })

  it('real built worker attaches valid scored identities and preserves OCR provenance and partial-index metadata', async () => {
    if (!existsSync(BUILT_SEARCH_WORKER) || !existsSync(CACHED_BGE_DIR)) {
      return
    }
    const realModelsRoot = join(tempDir, 'real-models')
    mkdirSync(realModelsRoot, { recursive: true })
    const realModelManager = new DocSemanticModelManager({
      modelsRootDir: realModelsRoot,
      getApprovedRoots: () => ['D:\\fixtures\\docs'],
      getVaultRoot: () => null
    })
    await realModelManager.importFromDirectory(CACHED_BGE_DIR)

    const db = catalog.getRawDatabaseForTesting()
    const srcId = Number(
      db
        .prepare(
          `INSERT INTO sources (root_path, normalized_root_path, created_at_ms, updated_at_ms)
           VALUES ('D:\\fixtures\\docs', 'd:\\fixtures\\docs', ?, ?);`
        )
        .run(NOW, NOW).lastInsertRowid
    )
    const sha = sha256Hex('synthetic-scanned-receipt.pdf')
    const fid = Number(
      db
        .prepare(
          `INSERT INTO file_locations (source_id, original_path, normalized_path, file_name, extension, category, created_at_ms, updated_at_ms)
           VALUES (?, 'D:\\fixtures\\docs\\synthetic-scanned-receipt.pdf', 'd:\\fixtures\\docs\\synthetic-scanned-receipt.pdf', 'synthetic-scanned-receipt.pdf', '.pdf', 'document', ?, ?);`
        )
        .run(srcId, NOW, NOW).lastInsertRowid
    )
    const oid = Number(
      db
        .prepare(
          `INSERT INTO discovery_observations (file_location_id, byte_size, filesystem_birthtime_ms, filesystem_mtime_ms, observed_at_ms, last_seen_at_ms, is_current)
           VALUES (?, 2048, ?, ?, ?, ?, 1);`
        )
        .run(fid, NOW, NOW, NOW, NOW).lastInsertRowid
    )
    db.prepare(
      `INSERT INTO hash_observations (file_location_id, discovery_observation_id, sha256, observed_byte_size, observed_mtime_ms, hashed_at_ms, is_active)
       VALUES (?, ?, ?, 2048, ?, ?, 1);`
    ).run(fid, oid, sha, NOW, NOW)
    const rev = buildDocumentContentRevision({
      discoveryObservationId: oid,
      byteSize: 2048,
      filesystemMtimeMs: NOW,
      activeHash: sha
    })
    const ocrText = 'Scanned hardware receipt total due $1,250.00'
    const ocrId = Number(
      db
        .prepare(
          `INSERT INTO document_ocr_extractions (file_location_id, discovery_observation_id, content_sha256, observed_byte_size, observed_mtime_ms,
             content_revision, recipe_version, ocr_model_id, ocr_model_manifest_sha256, ocr_language, extraction_method, ocr_status,
             extracted_text, extracted_char_count, page_count, ocr_page_count, truncated, is_current, extracted_at_ms)
           VALUES (?, ?, ?, 2048, ?, ?, ?, ?, ?, ?, 'ocr_pdf_tesseract', 'extracted', ?, ?, 1, 1, 0, 1, ?);`
        )
        .run(
          fid,
          oid,
          sha,
          NOW,
          rev,
          COMPAT.ocrRecipeVersion!,
          COMPAT.ocrModelId!,
          COMPAT.ocrModelManifestSha256!,
          COMPAT.ocrLanguage!,
          ocrText,
          ocrText.length,
          NOW
        ).lastInsertRowid
    )
    const norm = normalizeDocumentText(ocrText)
    catalog.getDocumentSemanticRepository().commitTrackChunks({
      jobId: null,
      fileLocationId: fid,
      textSourceKind: 'ocr',
      discoveryObservationId: oid,
      observedByteSize: 2048,
      observedMtimeMs: NOW,
      contentSha256: sha,
      contentRevision: rev,
      sourceExtractionId: ocrId,
      sourceRecipeVersion: COMPAT.ocrRecipeVersion!,
      sourceOcrModelId: COMPAT.ocrModelId!,
      sourceOcrModelManifestSha256: COMPAT.ocrModelManifestSha256!,
      sourceOcrLanguage: COMPAT.ocrLanguage!,
      normalizedTextSha256: computeNormalizedTextSha256(norm),
      compat: COMPAT,
      status: 'truncated',
      normalizedCharCount: 200_000,
      indexedCharCount: 100_000,
      coverageRatio: 0.5,
      truncated: true,
      truncationReason: 'max_chunks_reached',
      totalTokenCount: 2000,
      uniqueIndexedTokenCount: 1000,
      emittedChunkTokenSum: 1000,
      chunks: [
        {
          chunk: {
            chunkIndex: 0,
            charOffsetStart: 0,
            charOffsetEnd: norm.length,
            contentTokenCount: 8,
            text: norm
          },
          vector: makeUnitVec(0.5)
        }
      ]
    })

    const coordinator = new DocumentSearchCoordinator({
      catalog,
      modelManager: realModelManager,
      workerBudget: new AppWorkerBudget(3),
      workerScriptPath: BUILT_SEARCH_WORKER
    })
    const res = await coordinator.search({ query: 'hardware receipt', textSourceKindFilter: 'ocr' })
    expect(res.totalMatched).toBe(1)
    expect(res.items[0]!.textSourceKind).toBe('ocr')
    expect(res.items[0]!.truncated).toBe(true)
    expect(res.items[0]!.normalizedCharCount).toBe(200_000)
    expect(res.items[0]!.indexedCharCount).toBe(100_000)
    expect(res.items[0]!.coverageRatio).toBe(0.5)
    expect(res.items[0]!.winningSnippet).toContain('hardware receipt')
    expect('scoredIdentity' in (res.items[0] as object)).toBe(false)
    await coordinator.shutdown()
  }, 60000)
})
