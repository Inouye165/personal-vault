/**
 * Personal Vault — Stage 7D Dedicated Document Semantic Worker (`document_semantic_worker`)
 *
 * Executes strictly outside Electron main and renderer processes.
 * Enforces:
 * 1. Runtime prohibition of nested `worker_threads.Worker` spawns (`nestedWorkerAttempts === 0`).
 * 2. Runtime prohibition of outbound network activity (`outboundNetworkAttempts === 0`).
 * 3. Off-main byte-size + SHA-256 verification of pinned model artifacts prior to loading.
 * 4. CPU-only ONNX Runtime execution (`intraOpNumThreads: 2`, `interOpNumThreads: 1`,
 *    `enableCpuMemArena: false`) and 384-d L2-normalized Float32Array outputs.
 */

import { existsSync, readFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import Module from 'node:module'
import net from 'node:net'
import { join } from 'node:path'
import tls from 'node:tls'
import { parentPort } from 'node:worker_threads'
import { Tokenizer } from '@huggingface/tokenizers'
import * as ort from 'onnxruntime-node'
import { chunkDocumentTextTokenizerAware } from './chunker'
import {
  DOC_SEMANTIC_EMBEDDING_DIMENSIONS,
  DOC_SEMANTIC_MAX_SEQ_LENGTH,
  DOC_SEMANTIC_QUERY_PREFIX,
  computeDocSemanticManifestSha256
} from './manifest'
import { verifyDocSemanticDirectoryIntegrity } from './model-manager'
import type {
  DocSemanticModelArtifactSpec,
  DocSemanticWorkerRequestMessage,
  DocSemanticWorkerResponseMessage
} from './types'
import { l2NormalizeDocVector } from './vector'

let nestedWorkerAttempts = 0
let outboundNetworkAttempts = 0
let guardsInstalled = false

function forbidNestedWorker(): never {
  nestedWorkerAttempts += 1
  throw new Error(
    'NESTED_WORKER_FORBIDDEN: document semantic worker must not spawn nested worker threads'
  )
}

function forbidNetwork(surface: string): never {
  outboundNetworkAttempts += 1
  throw new Error(
    `OFFLINE_NETWORK_FORBIDDEN: outbound ${surface} is prohibited in document semantic worker`
  )
}

function installWorkerIsolationGuards(): void {
  if (guardsInstalled) return
  guardsInstalled = true

  const forbiddenWorkerProxy = new Proxy(function ForbiddenWorker() {}, {
    construct() {
      return forbidNestedWorker()
    },
    apply() {
      return forbidNestedWorker()
    }
  })

  const g = globalThis as Record<string, unknown>
  g.Worker = forbiddenWorkerProxy
  g.fetch = async () => forbidNetwork('fetch')
  g.XMLHttpRequest = function ForbiddenXHR() {
    forbidNetwork('XMLHttpRequest')
  }

  const modInternal = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown
  }
  const origLoad = modInternal._load
  modInternal._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
    const loaded = origLoad.call(this, request, parent, isMain)
    if (request === 'worker_threads' || request === 'node:worker_threads') {
      return new Proxy(loaded as object, {
        get(target, prop, receiver) {
          if (prop === 'Worker') {
            return forbiddenWorkerProxy
          }
          return Reflect.get(target, prop, receiver)
        }
      })
    }
    return loaded
  }

  ;(http as unknown as Record<string, unknown>).request = () => forbidNetwork('http.request')
  ;(http as unknown as Record<string, unknown>).get = () => forbidNetwork('http.get')
  ;(https as unknown as Record<string, unknown>).request = () => forbidNetwork('https.request')
  ;(https as unknown as Record<string, unknown>).get = () => forbidNetwork('https.get')
  ;(net as unknown as Record<string, unknown>).connect = () => forbidNetwork('net.connect')
  ;(net as unknown as Record<string, unknown>).createConnection = () =>
    forbidNetwork('net.createConnection')
  ;(tls as unknown as Record<string, unknown>).connect = () => forbidNetwork('tls.connect')
}

installWorkerIsolationGuards()

let loadedModelDir: string | null = null
let loadedManifestSha: string | null = null
let loadedTokenizer: Tokenizer | null = null
let loadedSession: ort.InferenceSession | null = null
let loadedNeedsTokenTypeIds = true

async function unloadSession(): Promise<void> {
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
  loadedManifestSha = null
}

async function ensureModelLoaded(
  modelDir: string,
  artifacts: readonly DocSemanticModelArtifactSpec[]
): Promise<{
  readonly loadMs: number
  readonly inputNames: readonly string[]
  readonly outputNames: readonly string[]
}> {
  const manifestSha = computeDocSemanticManifestSha256(artifacts)
  if (
    loadedSession &&
    loadedTokenizer &&
    loadedModelDir === modelDir &&
    loadedManifestSha === manifestSha
  ) {
    return {
      loadMs: 0,
      inputNames: [...loadedSession.inputNames],
      outputNames: [...loadedSession.outputNames]
    }
  }

  const verify = await verifyDocSemanticDirectoryIntegrity(modelDir, artifacts)
  if (!verify.ok) {
    await unloadSession()
    const err = new Error(verify.error ?? 'Document semantic model integrity check failed')
    ;(err as Error & { code?: string }).code = verify.code ?? 'DOC_MODEL_INVALID'
    throw err
  }

  await unloadSession()

  const t0 = performance.now()
  const tokenizerJsonPath = join(modelDir, 'tokenizer.json')
  const tokenizerConfigPath = join(modelDir, 'tokenizer_config.json')
  const onnxPath = join(modelDir, 'onnx', 'model_quantized.onnx')

  const tokenizerJson = JSON.parse(readFileSync(tokenizerJsonPath, 'utf8')) as Record<
    string,
    unknown
  >
  const tokenizerConfig = existsSync(tokenizerConfigPath)
    ? (JSON.parse(readFileSync(tokenizerConfigPath, 'utf8')) as Record<string, unknown>)
    : {}

  const tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig)
  const session = await ort.InferenceSession.create(onnxPath, {
    executionProviders: ['cpu'],
    intraOpNumThreads: 2,
    interOpNumThreads: 1,
    enableCpuMemArena: false
  })

  loadedTokenizer = tokenizer
  loadedSession = session
  loadedModelDir = modelDir
  loadedManifestSha = manifestSha
  loadedNeedsTokenTypeIds = session.inputNames.includes('token_type_ids')

  return {
    loadMs: performance.now() - t0,
    inputNames: [...session.inputNames],
    outputNames: [...session.outputNames]
  }
}

let abortRequested = false
let inFlightMessageCount = 0

async function runTextInference(
  msgId: number,
  text: string,
  options: {
    readonly delayMs?: number
    readonly notifyInferenceStart?: boolean
    readonly repeatCount?: number
  } = {}
) {
  if (!loadedSession || !loadedTokenizer) {
    throw new Error('Model is not loaded')
  }

  const delayMs = options.delayMs ?? 0
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }

  const t0 = performance.now()
  const encoded = loadedTokenizer.encode(text)
  const rawIds = Array.from(encoded.ids)
  const rawMask = Array.from(encoded.attention_mask ?? rawIds.map(() => 1))
  const truncated = rawIds.length > DOC_SEMANTIC_MAX_SEQ_LENGTH

  const seqLen = Math.min(rawIds.length, DOC_SEMANTIC_MAX_SEQ_LENGTH)
  const ids = rawIds.slice(0, seqLen)
  const mask = rawMask.slice(0, seqLen)

  // Preserve [SEP] (102) at final position if truncated
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

  if (options.notifyInferenceStart && parentPort) {
    const handshake: DocSemanticWorkerResponseMessage = {
      type: 'inference_started',
      id: msgId,
      seqLen
    }
    parentPort.postMessage(handshake)
  }

  const repeatCount = Math.max(1, Math.floor(options.repeatCount ?? 1))
  let outputs: ort.InferenceSession.OnnxValueMapType | null = null
  for (let r = 0; r < repeatCount; r += 1) {
    if (abortRequested) {
      const abortErr = new Error('CANCELLED: Document semantic inference aborted')
      ;(abortErr as Error & { code?: string }).code = 'CANCELLED'
      throw abortErr
    }
    outputs = await loadedSession.run(feeds)
  }
  if (abortRequested) {
    const abortErr = new Error('CANCELLED: Document semantic inference aborted')
    ;(abortErr as Error & { code?: string }).code = 'CANCELLED'
    throw abortErr
  }

  const hiddenTensor =
    outputs!.last_hidden_state ?? outputs![loadedSession.outputNames[0] ?? 'last_hidden_state']
  if (!hiddenTensor) {
    throw new Error('ONNX output tensor missing')
  }

  const dims = hiddenTensor.dims
  const hiddenSize = dims[dims.length - 1] ?? 0
  if (hiddenSize !== DOC_SEMANTIC_EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Unexpected hidden dimension ${hiddenSize}; expected ${DOC_SEMANTIC_EMBEDDING_DIMENSIONS}`
    )
  }

  const data = hiddenTensor.data as Float32Array
  const clsVec = new Float32Array(hiddenSize)
  for (let j = 0; j < hiddenSize; j += 1) {
    clsVec[j] = data[j] ?? 0
  }

  const normalized = l2NormalizeDocVector(clsVec, DOC_SEMANTIC_EMBEDDING_DIMENSIONS)
  return {
    vector: Array.from(normalized),
    dimensions: DOC_SEMANTIC_EMBEDDING_DIMENSIONS,
    tokenCount: seqLen,
    rawTokenCount: rawIds.length,
    truncated,
    embedMs: performance.now() - t0
  }
}

if (parentPort) {
  parentPort.on('message', async (msg: DocSemanticWorkerRequestMessage) => {
    if (msg.type === 'abort_and_exit') {
      abortRequested = true
      if (inFlightMessageCount === 0) {
        await unloadSession().catch(() => {})
        process.exit(0)
      }
      return
    }
    inFlightMessageCount += 1
    try {
      if (msg.type === 'verify_model') {
        const verifyResult = await verifyDocSemanticDirectoryIntegrity(msg.modelDir, msg.artifacts)
        const resp: DocSemanticWorkerResponseMessage = {
          id: msg.id,
          ok: true,
          verifyResult,
          nestedWorkerAttempts,
          outboundNetworkAttempts
        }
        parentPort!.postMessage(resp)
      } else if (msg.type === 'load_model') {
        const loadResult = await ensureModelLoaded(msg.modelDir, msg.artifacts)
        const resp: DocSemanticWorkerResponseMessage = {
          id: msg.id,
          ok: true,
          loadResult: { loaded: true, ...loadResult },
          nestedWorkerAttempts,
          outboundNetworkAttempts
        }
        parentPort!.postMessage(resp)
      } else if (msg.type === 'chunk_text') {
        await ensureModelLoaded(msg.modelDir, msg.artifacts)
        const chunkResult = chunkDocumentTextTokenizerAware(msg.text, loadedTokenizer!, msg.options)
        const resp: DocSemanticWorkerResponseMessage = {
          id: msg.id,
          ok: true,
          chunkResult,
          nestedWorkerAttempts,
          outboundNetworkAttempts
        }
        parentPort!.postMessage(resp)
      } else if (msg.type === 'embed_chunk') {
        await ensureModelLoaded(msg.modelDir, msg.artifacts)
        const embedResult = await runTextInference(msg.id, msg.text, {
          delayMs: msg.delayMs,
          notifyInferenceStart: msg.notifyInferenceStart,
          repeatCount: msg.repeatCount
        })
        const resp: DocSemanticWorkerResponseMessage = {
          id: msg.id,
          ok: true,
          embedResult,
          nestedWorkerAttempts,
          outboundNetworkAttempts
        }
        parentPort!.postMessage(resp)
      } else if (msg.type === 'embed_query') {
        await ensureModelLoaded(msg.modelDir, msg.artifacts)
        const trimmed = msg.query.trim()
        if (!trimmed) {
          throw new Error('EMPTY_QUERY: Document search query cannot be empty')
        }
        const prefixed = `${DOC_SEMANTIC_QUERY_PREFIX}${trimmed}`
        const embedResult = await runTextInference(msg.id, prefixed, {
          delayMs: msg.delayMs,
          notifyInferenceStart: msg.notifyInferenceStart,
          repeatCount: msg.repeatCount
        })
        const resp: DocSemanticWorkerResponseMessage = {
          id: msg.id,
          ok: true,
          embedResult,
          nestedWorkerAttempts,
          outboundNetworkAttempts
        }
        parentPort!.postMessage(resp)
      } else if (msg.type === 'unload') {
        await unloadSession()
        const resp: DocSemanticWorkerResponseMessage = {
          id: msg.id,
          ok: true,
          nestedWorkerAttempts,
          outboundNetworkAttempts
        }
        parentPort!.postMessage(resp)
      }
    } catch (err) {
      const code = (err as { code?: string } | null)?.code ?? 'DOC_SEMANTIC_WORKER_ERROR'
      const resp: DocSemanticWorkerResponseMessage = {
        id: msg.id,
        ok: false,
        errorCode: code,
        errorMessage: err instanceof Error ? err.message : String(err),
        nestedWorkerAttempts,
        outboundNetworkAttempts
      }
      parentPort!.postMessage(resp)
    } finally {
      inFlightMessageCount = Math.max(0, inFlightMessageCount - 1)
      if (abortRequested && inFlightMessageCount === 0) {
        await unloadSession().catch(() => {})
        process.exit(0)
      }
    }
  })
}
