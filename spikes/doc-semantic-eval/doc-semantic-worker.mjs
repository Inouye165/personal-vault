/**
 * Personal Vault — Stage 7D Document Semantic Evaluation Spike: Worker
 *
 * Runs inside Node worker_threads under Electron (`ELECTRON_RUN_AS_NODE=1`),
 * enforcing zero outbound network calls during tokenizer + ONNX inference.
 */

import { existsSync, readFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { join } from 'node:path'
import tls from 'node:tls'
import { parentPort } from 'node:worker_threads'
import { getHeapStatistics } from 'node:v8'
import { Tokenizer } from '@huggingface/tokenizers'
import * as ort from 'onnxruntime-node'
import { chunkDocumentTextTokenizerAware } from './chunker.mjs'

let outboundNetworkAttempts = 0
function blockNetwork(name) {
  outboundNetworkAttempts += 1
  throw new Error(`OFFLINE_GUARD: blocked outbound ${name} attempt during Stage 7D evaluation`)
}

globalThis.fetch = () => {
  blockNetwork('fetch')
}
http.request = () => blockNetwork('http.request')
http.get = () => blockNetwork('http.get')
https.request = () => blockNetwork('https.request')
https.get = () => blockNetwork('https.get')
net.connect = () => blockNetwork('net.connect')
tls.connect = () => blockNetwork('tls.connect')

let loadedSession = null
let loadedTokenizer = null
let loadedPooling = 'cls'
let loadedMaxLength = 512
let loadedNeedsTokenTypeIds = true

function l2Normalize(vec) {
  let sumSq = 0
  for (let i = 0; i < vec.length; i += 1) {
    sumSq += vec[i] * vec[i]
  }
  const norm = Math.sqrt(sumSq)
  if (!Number.isFinite(norm) || norm <= 1e-12) {
    throw new Error('Zero or non-finite embedding norm')
  }
  const out = new Float32Array(vec.length)
  for (let i = 0; i < vec.length; i += 1) {
    out[i] = vec[i] / norm
  }
  return out
}

async function loadModel(modelDir, modelKey, pooling, maxLength = 512) {
  const t0 = performance.now()
  const tokenizerJsonPath = join(modelDir, 'tokenizer.json')
  const tokenizerConfigPath = join(modelDir, 'tokenizer_config.json')
  const onnxPath = join(modelDir, 'onnx', 'model_quantized.onnx')

  if (!existsSync(tokenizerJsonPath) || !existsSync(onnxPath)) {
    const err = new Error(`Missing model artifacts in ${modelDir}`)
    err.code = 'DOC_MODEL_MISSING'
    throw err
  }

  if (loadedSession) {
    await loadedSession.release()
    loadedSession = null
    loadedTokenizer = null
  }

  const tokenizerJson = JSON.parse(readFileSync(tokenizerJsonPath, 'utf8'))
  const tokenizerConfig = existsSync(tokenizerConfigPath)
    ? JSON.parse(readFileSync(tokenizerConfigPath, 'utf8'))
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
  loadedPooling = pooling
  loadedMaxLength = maxLength
  loadedNeedsTokenTypeIds = session.inputNames.includes('token_type_ids')

  const loadMs = performance.now() - t0
  return {
    modelKey,
    inputNames: [...session.inputNames],
    outputNames: [...session.outputNames],
    loadMs
  }
}

async function embedText(text, options = {}) {
  if (!loadedSession || !loadedTokenizer) {
    throw new Error('Model not loaded')
  }

  const delayMs = options.delayMs ?? 0
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }

  const t0 = performance.now()
  const encoded = loadedTokenizer.encode(text)
  const rawIds = Array.from(encoded.ids)
  const rawMask = Array.from(encoded.attention_mask ?? rawIds.map(() => 1))
  const truncated = rawIds.length > loadedMaxLength

  const seqLen = Math.min(rawIds.length, loadedMaxLength)
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
    inputIdsBig[i] = BigInt(ids[i])
    attentionMaskBig[i] = BigInt(mask[i])
    tokenTypeIdsBig[i] = 0n
  }

  const feeds = {
    input_ids: new ort.Tensor('int64', inputIdsBig, [1, seqLen]),
    attention_mask: new ort.Tensor('int64', attentionMaskBig, [1, seqLen])
  }
  if (loadedNeedsTokenTypeIds) {
    feeds.token_type_ids = new ort.Tensor('int64', tokenTypeIdsBig, [1, seqLen])
  }

  if (options.notifyInferenceStart && options.msgId !== undefined) {
    parentPort.postMessage({ type: 'inference_started', id: options.msgId, seqLen })
  }

  const repeatCount = Math.max(1, options.repeatCount ?? 1)
  let outputs
  for (let r = 0; r < repeatCount; r += 1) {
    outputs = await loadedSession.run(feeds)
  }
  const hiddenTensor = outputs.last_hidden_state ?? outputs[loadedSession.outputNames[0]]
  const dims = hiddenTensor.dims
  const data = hiddenTensor.data
  const hiddenSize = dims[dims.length - 1]

  const pooled = new Float32Array(hiddenSize)
  if (loadedPooling === 'cls') {
    for (let j = 0; j < hiddenSize; j += 1) {
      pooled[j] = data[j]
    }
  } else {
    let maskSum = 0
    for (let t = 0; t < seqLen; t += 1) {
      const m = mask[t]
      if (m > 0) {
        maskSum += m
        const rowOffset = t * hiddenSize
        for (let j = 0; j < hiddenSize; j += 1) {
          pooled[j] += data[rowOffset + j] * m
        }
      }
    }
    const denom = Math.max(maskSum, 1e-9)
    for (let j = 0; j < hiddenSize; j += 1) {
      pooled[j] /= denom
    }
  }

  const normalized = l2Normalize(pooled)
  const embedMs = performance.now() - t0
  const mem = process.memoryUsage()
  const heap = getHeapStatistics()

  return {
    vector: Array.from(normalized),
    dimensions: hiddenSize,
    tokenCount: seqLen,
    rawTokenCount: rawIds.length,
    truncated,
    embedMs,
    outboundNetworkAttempts,
    sampledProcessRssMiB: Number((mem.rss / (1024 * 1024)).toFixed(2)),
    sampledWorkerHeapUsedMiB: Number((mem.heapUsed / (1024 * 1024)).toFixed(2)),
    sampledWorkerHeapLimitMiB: Number((heap.heap_size_limit / (1024 * 1024)).toFixed(2))
  }
}

parentPort.on('message', async (msg) => {
  try {
    if (msg.type === 'load') {
      const result = await loadModel(msg.modelDir, msg.modelKey, msg.pooling, msg.maxLength)
      parentPort.postMessage({ id: msg.id, ok: true, result })
    } else if (msg.type === 'chunk') {
      if (!loadedTokenizer) {
        throw new Error('Model/tokenizer not loaded')
      }
      const result = chunkDocumentTextTokenizerAware(msg.text, loadedTokenizer, msg.options)
      parentPort.postMessage({ id: msg.id, ok: true, result })
    } else if (msg.type === 'embed') {
      const result = await embedText(msg.text, {
        delayMs: msg.delayMs,
        notifyInferenceStart: msg.notifyInferenceStart,
        repeatCount: msg.repeatCount,
        msgId: msg.id
      })
      parentPort.postMessage({ id: msg.id, ok: true, result })
    } else if (msg.type === 'unload') {
      if (loadedSession) {
        await loadedSession.release()
        loadedSession = null
        loadedTokenizer = null
      }
      parentPort.postMessage({ id: msg.id, ok: true, result: { unloaded: true } })
    } else {
      parentPort.postMessage({ id: msg.id, ok: false, error: `Unknown message type: ${msg.type}` })
    }
  } catch (err) {
    parentPort.postMessage({
      id: msg.id,
      ok: false,
      code: err?.code ?? 'WORKER_ERROR',
      error: err instanceof Error ? err.message : String(err)
    })
  }
})
