/**
 * Personal Vault — Stage 7D Slice 3 Isolated Document Search Worker (`doc_search_worker.js`)
 *
 * Executes strictly outside Electron main and renderer inside a Node `worker_threads.Worker`:
 * - Guards against nested Worker spawns and outbound network calls (`0` attempts).
 * - Revalidates the pinned BGE model directory off-main before loading `@huggingface/tokenizers`
 *   and `onnxruntime-node` CPU session.
 * - Embeds queries with `DOC_SEMANTIC_QUERY_PREFIX` (`<= 500` chars, `512`-token window).
 * - Streams candidate chunks from read-only SQLite inside a WAL `BEGIN DEFERRED` ... `ROLLBACK`
 *   snapshot and ranks via `rankDocumentChunksStreaming` (O(1) doc accumulator + bounded heap /
 *   disk-backed SQLite fallback).
 */

import { existsSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import tls from 'node:tls'
import workerThreads, { parentPort } from 'node:worker_threads'
import { Tokenizer } from '@huggingface/tokenizers'
import * as ort from 'onnxruntime-node'
import { DocumentSemanticRepository } from '../../catalog/document-semantic-repository'
import type {
  DocSemanticCompatibilitySpec,
  DocTextSourceKind
} from '../../catalog/document-semantic-snapshot-query'
import {
  DOC_SEMANTIC_EMBEDDING_DIMENSIONS,
  DOC_SEMANTIC_MAX_SEQ_LENGTH,
  DOC_SEMANTIC_QUERY_PREFIX
} from './manifest'
import { verifyDocSemanticDirectoryIntegrity } from './model-manager'
import { applySearchTestBarrier } from '../../search-test-barrier'
import type { HydratedDocSearchItem } from '../../catalog/document-semantic-repository'
import type {
  DocumentClutterFilter,
  DocumentOriginFilter,
  DocumentPurposeFilter
} from '../../../../shared/validation/document-schemas'
import type { DocSemanticModelArtifactSpec } from './types'
import { l2NormalizeDocVector } from './vector'

let nestedWorkerAttempts = 0
let outboundNetworkAttempts = 0

function installWorkerIsolationGuards(): void {
  const originalFetch = globalThis.fetch
  if (typeof originalFetch === 'function') {
    globalThis.fetch = (() => {
      outboundNetworkAttempts += 1
      return Promise.reject(
        new Error('NETWORK_BLOCKED: Outbound network disabled in doc search worker')
      )
    }) as typeof fetch
  }

  const blockNetwork = (label: string) => {
    return () => {
      outboundNetworkAttempts += 1
      throw new Error(`NETWORK_BLOCKED: ${label} is disabled in doc search worker`)
    }
  }

  ;(http as unknown as Record<string, unknown>).request = blockNetwork('http.request')
  ;(http as unknown as Record<string, unknown>).get = blockNetwork('http.get')
  ;(https as unknown as Record<string, unknown>).request = blockNetwork('https.request')
  ;(https as unknown as Record<string, unknown>).get = blockNetwork('https.get')
  ;(net as unknown as Record<string, unknown>).connect = blockNetwork('net.connect')
  ;(net as unknown as Record<string, unknown>).createConnection =
    blockNetwork('net.createConnection')
  ;(tls as unknown as Record<string, unknown>).connect = blockNetwork('tls.connect')

  const OriginalWorker = workerThreads.Worker
  ;(workerThreads as unknown as Record<string, unknown>).Worker = new Proxy(OriginalWorker, {
    construct() {
      nestedWorkerAttempts += 1
      throw new Error('NESTED_WORKER_BLOCKED: Nested workers are disabled in doc search worker')
    }
  })
}

installWorkerIsolationGuards()

export type DocSearchWorkerRequest =
  | {
      readonly id: number
      readonly type: 'search'
      readonly catalogPath: string
      readonly modelDir: string
      readonly artifacts: readonly DocSemanticModelArtifactSpec[]
      readonly compat: DocSemanticCompatibilitySpec
      readonly query: string
      readonly limit: number
      readonly offset: number
      readonly extensionFilter?: string | null
      readonly filenameQuery?: string
      readonly textSourceKindFilter?: DocTextSourceKind | null
      readonly purposeFilter?: DocumentPurposeFilter | null
      readonly originFilter?: DocumentOriginFilter | null
      readonly clutterFilter?: DocumentClutterFilter
      readonly delayMs?: number
    }
  | {
      readonly id: number
      readonly type: 'abort_and_exit'
    }

export type DocSearchWorkerResponse =
  | {
      readonly id: number
      readonly ok: true
      readonly items: readonly HydratedDocSearchItem[]
      readonly totalMatched: number
      readonly hasMore: boolean
      readonly eligibleChunkCount: number
      readonly corruptChunkCount: number
      readonly queryTokenCount: number
      readonly queryTruncated: boolean
      readonly queryLatencyMs: number
      readonly nestedWorkerAttempts: number
      readonly outboundNetworkAttempts: number
    }
  | {
      readonly id: number
      readonly ok: false
      readonly errorCode: string
      readonly errorMessage: string
      readonly nestedWorkerAttempts: number
      readonly outboundNetworkAttempts: number
    }

let loadedModelDir: string | null = null
let loadedTokenizer: Tokenizer | null = null
let loadedSession: ort.InferenceSession | null = null
let loadedNeedsTokenTypeIds = true
let abortRequested = false
let inFlightCount = 0

async function releaseModelSession(): Promise<void> {
  if (loadedSession) {
    try {
      await loadedSession.release()
    } catch {
      // ignore release errors
    }
  }
  loadedSession = null
  loadedTokenizer = null
  loadedModelDir = null
}

async function ensureModelLoaded(
  modelDir: string,
  artifacts: readonly DocSemanticModelArtifactSpec[]
): Promise<void> {
  const integrity = await verifyDocSemanticDirectoryIntegrity(modelDir, artifacts)
  if (!integrity.ok) {
    await releaseModelSession()
    const err = new Error(integrity.error ?? 'Document semantic model integrity check failed')
    ;(err as Error & { code?: string }).code = integrity.code ?? 'DOC_MODEL_INVALID'
    throw err
  }

  if (loadedSession && loadedTokenizer && loadedModelDir === modelDir) {
    return
  }
  await releaseModelSession()

  const tokJson = existsSync(`${modelDir}/tokenizer.json`)
    ? await import('node:fs/promises').then((fs) =>
        fs.readFile(`${modelDir}/tokenizer.json`, 'utf8')
      )
    : '{}'
  const tokCfgRaw = existsSync(`${modelDir}/tokenizer_config.json`)
    ? await import('node:fs/promises').then((fs) =>
        fs.readFile(`${modelDir}/tokenizer_config.json`, 'utf8')
      )
    : '{}'
  const tokenizer = new Tokenizer(JSON.parse(tokJson), JSON.parse(tokCfgRaw))

  const session = await ort.InferenceSession.create(`${modelDir}/onnx/model_quantized.onnx`, {
    executionProviders: ['cpu'],
    intraOpNumThreads: 2,
    interOpNumThreads: 1,
    enableCpuMemArena: false
  })

  loadedTokenizer = tokenizer
  loadedSession = session
  loadedModelDir = modelDir
  loadedNeedsTokenTypeIds = session.inputNames.includes('token_type_ids')
}

async function embedQuery(query: string): Promise<{
  readonly vector: Float32Array
  readonly tokenCount: number
  readonly truncated: boolean
}> {
  if (!loadedSession || !loadedTokenizer) {
    throw new Error('Model is not loaded')
  }
  const encoded = loadedTokenizer.encode(`${DOC_SEMANTIC_QUERY_PREFIX}${query}`)
  const rawIds = Array.from(encoded.ids)
  const rawMask = Array.from(encoded.attention_mask ?? rawIds.map(() => 1))
  const truncated = rawIds.length > DOC_SEMANTIC_MAX_SEQ_LENGTH
  const seqLen = Math.min(rawIds.length, DOC_SEMANTIC_MAX_SEQ_LENGTH)
  const ids = rawIds.slice(0, seqLen)
  const mask = rawMask.slice(0, seqLen)
  if (truncated && seqLen >= 2 && rawIds[rawIds.length - 1] === 102) {
    ids[seqLen - 1] = 102
  }

  const inputIdsBig = new BigInt64Array(seqLen)
  const attentionMaskBig = new BigInt64Array(seqLen)
  const tokenTypeIdsBig = new BigInt64Array(seqLen)
  for (let i = 0; i < seqLen; i += 1) {
    inputIdsBig[i] = BigInt(ids[i] ?? 0)
    attentionMaskBig[i] = BigInt(mask[i] ?? 1)
    tokenTypeIdsBig[i] = 0n
  }

  const feeds: Record<string, ort.Tensor> = {
    input_ids: new ort.Tensor('int64', inputIdsBig, [1, seqLen]),
    attention_mask: new ort.Tensor('int64', attentionMaskBig, [1, seqLen])
  }
  if (loadedNeedsTokenTypeIds) {
    feeds.token_type_ids = new ort.Tensor('int64', tokenTypeIdsBig, [1, seqLen])
  }

  if (abortRequested) {
    const err = new Error('CANCELLED: Document search aborted')
    ;(err as Error & { code?: string }).code = 'CANCELLED'
    throw err
  }
  const outputs = await loadedSession.run(feeds)
  if (abortRequested) {
    const err = new Error('CANCELLED: Document search aborted')
    ;(err as Error & { code?: string }).code = 'CANCELLED'
    throw err
  }

  const hidden =
    outputs.last_hidden_state ?? outputs[loadedSession.outputNames[0] ?? 'last_hidden_state']
  if (!hidden) {
    throw new Error('ONNX output tensor missing')
  }
  const data = hidden.data as Float32Array
  const clsVec = new Float32Array(DOC_SEMANTIC_EMBEDDING_DIMENSIONS)
  for (let j = 0; j < DOC_SEMANTIC_EMBEDDING_DIMENSIONS; j += 1) {
    clsVec[j] = data[j] ?? 0
  }

  return {
    vector: l2NormalizeDocVector(clsVec, DOC_SEMANTIC_EMBEDDING_DIMENSIONS),
    tokenCount: seqLen,
    truncated
  }
}

if (parentPort) {
  parentPort.on('message', async (msg: DocSearchWorkerRequest) => {
    if (msg.type === 'abort_and_exit') {
      abortRequested = true
      if (inFlightCount === 0) {
        await releaseModelSession().catch(() => {})
        process.exit(0)
      }
      return
    }

    inFlightCount += 1
    let db: DatabaseSync | null = null
    try {
      const t0 = performance.now()
      if (msg.delayMs && msg.delayMs > 0) {
        await new Promise((r) => setTimeout(r, msg.delayMs))
      }
      if (abortRequested) {
        const err = new Error('CANCELLED: Document search aborted')
        ;(err as Error & { code?: string }).code = 'CANCELLED'
        throw err
      }

      await ensureModelLoaded(msg.modelDir, msg.artifacts)
      await applySearchTestBarrier('bge', msg.query, () => abortRequested)
      const embedded = await embedQuery(msg.query)

      db = new DatabaseSync(msg.catalogPath, {
        readOnly: true,
        timeout: 5000,
        enableForeignKeyConstraints: true
      })
      const repo = new DocumentSemanticRepository(db, msg.catalogPath)
      const ranked = repo.searchDocumentChunksBounded(embedded.vector, {
        compat: msg.compat,
        limit: msg.limit,
        offset: msg.offset,
        extensionFilter: msg.extensionFilter,
        filenameQuery: msg.filenameQuery,
        textSourceKindFilter: msg.textSourceKindFilter,
        purposeFilter: msg.purposeFilter,
        originFilter: msg.originFilter,
        clutterFilter: msg.clutterFilter
      })

      const resp: DocSearchWorkerResponse = {
        id: msg.id,
        ok: true,
        items: ranked.items,
        totalMatched: ranked.totalMatched,
        hasMore: ranked.hasMore,
        eligibleChunkCount: ranked.eligibleChunkCount,
        corruptChunkCount: ranked.corruptChunkCount,
        queryTokenCount: embedded.tokenCount,
        queryTruncated: embedded.truncated,
        queryLatencyMs: Math.round((performance.now() - t0) * 100) / 100,
        nestedWorkerAttempts,
        outboundNetworkAttempts
      }
      parentPort!.postMessage(resp)
    } catch (err) {
      const code = (err as { code?: string } | null)?.code ?? 'DOC_SEARCH_FAILED'
      const resp: DocSearchWorkerResponse = {
        id: msg.id,
        ok: false,
        errorCode: code,
        errorMessage: err instanceof Error ? err.message : String(err),
        nestedWorkerAttempts,
        outboundNetworkAttempts
      }
      parentPort!.postMessage(resp)
    } finally {
      if (db) {
        try {
          db.close()
        } catch {
          // ignore close errors
        }
      }
      inFlightCount = Math.max(0, inFlightCount - 1)
      if (abortRequested && inFlightCount === 0) {
        await releaseModelSession().catch(() => {})
        process.exit(0)
      }
    }
  })
}
