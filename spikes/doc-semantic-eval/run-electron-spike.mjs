#!/usr/bin/env node
/**
 * Personal Vault — Stage 7D Document Semantic Evaluation Spike: Electron Runner
 *
 * Executes under Electron (`ELECTRON_RUN_AS_NODE=1`) to verify N-API v6
 * `onnxruntime-node` + `@huggingface/tokenizers` in a Node worker thread,
 * test tokenizer-aware chunking & normalized-text offsets, measure
 * latency/memory/event-loop bounds, test pre-inference AND in-flight ONNX
 * cancellation/recovery, and run an expanded synthetic feasibility check.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { normalizeDocumentText, SYNTHETIC_DOCUMENTS, SYNTHETIC_EVAL_QUERIES } from './chunker.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')
const ELECTRON_EXE = resolve(REPO_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const WORKER_PATH = resolve(__dirname, 'doc-semantic-worker.mjs')
const CACHE_ROOT = resolve(__dirname, '.model-cache')

const BGE_QUERY_PREFIX = 'Represent this sentence for searching relevant passages: '

if (!process.versions.electron) {
  if (!existsSync(ELECTRON_EXE)) {
    throw new Error(`Electron binary not found at ${ELECTRON_EXE}`)
  }
  const res = spawnSync(ELECTRON_EXE, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })
  process.exit(res.status ?? 1)
}

function dotProduct(a, b) {
  let sum = 0
  for (let i = 0; i < a.length; i += 1) {
    sum += a[i] * b[i]
  }
  return sum
}

function percentile(values, p) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

class SpikeWorkerClient {
  constructor() {
    this.worker = new Worker(WORKER_PATH)
    this.nextId = 1
    this.pending = new Map()
    this.onHandshake = null

    this.worker.on('message', (msg) => {
      if (msg.type === 'inference_started') {
        if (this.onHandshake) {
          this.onHandshake(msg)
        }
        return
      }
      const entry = this.pending.get(msg.id)
      if (!entry) return
      this.pending.delete(msg.id)
      if (msg.ok) {
        entry.resolve(msg.result)
      } else {
        const err = new Error(msg.error)
        err.code = msg.code
        entry.reject(err)
      }
    })
    this.worker.on('error', (err) => {
      for (const entry of this.pending.values()) entry.reject(err)
      this.pending.clear()
    })
    this.worker.on('exit', (code) => {
      for (const entry of this.pending.values()) {
        const err = new Error(`Worker exited with code ${code}`)
        err.code = 'WORKER_TERMINATED'
        entry.reject(err)
      }
      this.pending.clear()
    })
  }

  call(type, payload) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker.postMessage({ id, type, ...payload })
    })
  }

  async terminate() {
    await this.worker.terminate()
  }
}

async function testChunkerOffsetsAndTruncation(client) {
  const sample =
    '  \r\nFirst paragraph.\r\n\r\nSecond paragraph with token-dense numbers: 12345678901234567890.\r\n  '
  const normalized = normalizeDocumentText(sample)
  const chunkRes = await client.call('chunk', {
    text: sample,
    options: { maxContentTokensPerChunk: 12, overlapTokens: 3, maxChunksPerDocument: 128 }
  })

  for (const c of chunkRes.chunks) {
    const sliced = normalized.slice(c.charOffsetStart, c.charOffsetEnd)
    if (sliced !== c.text) {
      throw new Error(`Offset mismatch at chunk ${c.chunkIndex}: "${sliced}" !== "${c.text}"`)
    }
  }

  // Test explicit truncation disclosure when maxChunksPerDocument is hit
  const longText = Array.from(
    { length: 30 },
    (_, i) => `Sentence number ${i + 1} with extra tokens.`
  ).join(' ')
  const truncRes = await client.call('chunk', {
    text: longText,
    options: { maxContentTokensPerChunk: 20, overlapTokens: 4, maxChunksPerDocument: 2 }
  })
  if (!truncRes.truncated || truncRes.truncationReason !== 'max_chunks_reached') {
    throw new Error(`Expected max_chunks_reached truncation, got ${JSON.stringify(truncRes)}`)
  }

  return {
    offsetInvariantVerified: true,
    sampleChunkCount: chunkRes.chunks.length,
    truncationDisclosureVerified: true,
    truncationExample: {
      normalizedCharCount: truncRes.normalizedCharCount,
      indexedCharCount: truncRes.indexedCharCount,
      coverageRatio: truncRes.coverageRatio,
      truncated: truncRes.truncated,
      truncationReason: truncRes.truncationReason
    }
  }
}

async function evaluateModel(modelSpec) {
  const client = new SpikeWorkerClient()
  const modelDir = join(CACHE_ROOT, modelSpec.key)

  try {
    const loadInfo = await client.call('load', {
      modelDir,
      modelKey: modelSpec.key,
      pooling: modelSpec.pooling,
      maxLength: modelSpec.maxLength
    })

    const chunkerCheck = modelSpec.runChunkerCheck
      ? await testChunkerOffsetsAndTruncation(client)
      : undefined

    const chunkVectors = []
    const chunkLatencies = []
    let maxProcessRssMiB = 0
    let maxWorkerHeapMiB = 0
    let totalOutboundNet = 0
    let truncatedChunksCount = 0

    for (const doc of SYNTHETIC_DOCUMENTS) {
      const normalized = normalizeDocumentText(doc.text)
      const chunkRes = await client.call('chunk', {
        text: doc.text,
        options: {
          maxContentTokensPerChunk: modelSpec.maxLength - 2,
          overlapTokens: Math.min(64, Math.floor((modelSpec.maxLength - 2) / 4))
        }
      })

      for (const ch of chunkRes.chunks) {
        if (normalized.slice(ch.charOffsetStart, ch.charOffsetEnd) !== ch.text) {
          throw new Error(`Normalized offset invariant failed for ${doc.id} chunk ${ch.chunkIndex}`)
        }
        const res = await client.call('embed', { text: ch.text })
        if (res.truncated) truncatedChunksCount += 1
        chunkLatencies.push(res.embedMs)
        maxProcessRssMiB = Math.max(maxProcessRssMiB, res.sampledProcessRssMiB)
        maxWorkerHeapMiB = Math.max(maxWorkerHeapMiB, res.sampledWorkerHeapUsedMiB)
        totalOutboundNet += res.outboundNetworkAttempts
        chunkVectors.push({
          docId: doc.id,
          fileLocationId: doc.fileLocationId,
          fileName: doc.fileName,
          textSourceKind: doc.textSourceKind,
          recipeVersion: doc.recipeVersion,
          chunkIndex: ch.chunkIndex,
          charOffsetStart: ch.charOffsetStart,
          charOffsetEnd: ch.charOffsetEnd,
          tokenCount: res.tokenCount,
          truncated: res.truncated,
          vector: Float32Array.from(res.vector)
        })
      }
    }

    const queryLatencies = []
    const queryResults = []
    let top1Correct = 0
    let mrrSum = 0

    for (const q of SYNTHETIC_EVAL_QUERIES) {
      const prompt = modelSpec.queryPrefix ? `${modelSpec.queryPrefix}${q.query}` : q.query
      const qRes = await client.call('embed', { text: prompt })
      queryLatencies.push(qRes.embedMs)
      totalOutboundNet += qRes.outboundNetworkAttempts
      const qVec = Float32Array.from(qRes.vector)

      // Document-level max-chunk aggregation keyed by fileLocationId
      const bestByFileLocation = new Map()
      for (const cv of chunkVectors) {
        const score = dotProduct(qVec, cv.vector)
        const prev = bestByFileLocation.get(cv.fileLocationId)
        if (!prev || score > prev.score) {
          bestByFileLocation.set(cv.fileLocationId, {
            fileLocationId: cv.fileLocationId,
            docId: cv.docId,
            fileName: cv.fileName,
            textSourceKind: cv.textSourceKind,
            recipeVersion: cv.recipeVersion,
            winningChunkIndex: cv.chunkIndex,
            score
          })
        }
      }

      const ranked = [...bestByFileLocation.values()].sort(
        (a, b) => b.score - a.score || a.fileLocationId - b.fileLocationId
      )
      const rankIdx = ranked.findIndex((r) => r.fileLocationId === q.expectedFileLocationId)
      const rank = rankIdx >= 0 ? rankIdx + 1 : null
      const top1MatchesSourceKind = rank === 1 && ranked[0]?.textSourceKind === q.expectedSourceKind
      if (top1MatchesSourceKind) top1Correct += 1
      if (rank !== null) mrrSum += 1 / rank

      const expectedEntry = ranked.find((r) => r.fileLocationId === q.expectedFileLocationId)
      const topDistractor = ranked.find((r) => r.fileLocationId !== q.expectedFileLocationId)
      const margin =
        expectedEntry && topDistractor ? expectedEntry.score - topDistractor.score : null

      queryResults.push({
        id: q.id,
        expectedFileLocationId: q.expectedFileLocationId,
        expectedSourceKind: q.expectedSourceKind,
        top1FileLocationId: ranked[0]?.fileLocationId ?? null,
        top1SourceKind: ranked[0]?.textSourceKind ?? null,
        top1Score: Number((ranked[0]?.score ?? 0).toFixed(4)),
        top1ChunkIndex: ranked[0]?.winningChunkIndex ?? null,
        expectedRank: rank,
        marginOverBestOther: margin !== null ? Number(margin.toFixed(4)) : null,
        secondFileName: ranked[1]?.fileName ?? null,
        secondScore: Number((ranked[1]?.score ?? 0).toFixed(4))
      })
    }

    const avgChunkMs = chunkLatencies.reduce((a, b) => a + b, 0) / chunkLatencies.length
    const avgQueryMs = queryLatencies.reduce((a, b) => a + b, 0) / queryLatencies.length

    return {
      modelKey: modelSpec.key,
      queryPrefixUsed: Boolean(modelSpec.queryPrefix),
      maxLength: modelSpec.maxLength,
      dimensions: chunkVectors[0] ? chunkVectors[0].vector.length : 0,
      chunkCount: chunkVectors.length,
      truncatedChunksCount,
      coldLoadMs: Number(loadInfo.loadMs.toFixed(2)),
      warmChunkMeanMs: Number(avgChunkMs.toFixed(2)),
      warmChunkP95Ms: Number(percentile(chunkLatencies, 95).toFixed(2)),
      warmQueryMeanMs: Number(avgQueryMs.toFixed(2)),
      sampledProcessRssMiB: maxProcessRssMiB,
      sampledWorkerHeapUsedMiB: maxWorkerHeapMiB,
      outboundNetworkAttempts: totalOutboundNet,
      top1Accuracy: `${top1Correct}/${SYNTHETIC_EVAL_QUERIES.length}`,
      mrr: Number((mrrSum / SYNTHETIC_EVAL_QUERIES.length).toFixed(4)),
      meanMargin: Number(
        (
          queryResults.reduce((s, r) => s + (r.marginOverBestOther ?? 0), 0) / queryResults.length
        ).toFixed(4)
      ),
      chunkerCheck,
      queryResults
    }
  } finally {
    await client.terminate()
  }
}

async function testPreInferenceDelayCancellation() {
  const client = new SpikeWorkerClient()
  const modelDir = join(CACHE_ROOT, 'bge-small-en-v1.5')
  await client.call('load', {
    modelDir,
    modelKey: 'bge-small-en-v1.5',
    pooling: 'cls',
    maxLength: 512
  })

  const t0 = performance.now()
  const delayedPromise = client.call('embed', {
    text: 'pre-inference delay cancellation test payload',
    delayMs: 2000
  })

  await new Promise((r) => setTimeout(r, 40))
  await client.terminate()
  const cancelMs = performance.now() - t0

  let rejectedCode = null
  try {
    await delayedPromise
  } catch (err) {
    rejectedCode = err?.code ?? 'UNKNOWN'
  }

  return {
    kind: 'pre_inference_delay_cancel',
    cancelledRejectedCode: rejectedCode,
    cancelTerminateMs: Number(cancelMs.toFixed(2))
  }
}

async function testInFlightInferenceCancellationAndRecovery() {
  const client = new SpikeWorkerClient()
  const modelDir = join(CACHE_ROOT, 'bge-small-en-v1.5')
  await client.call('load', {
    modelDir,
    modelKey: 'bge-small-en-v1.5',
    pooling: 'cls',
    maxLength: 512
  })

  const longPayload = Array.from({ length: 120 }, (_, i) => `token${i} clause`).join(' ')
  let handshakeSeen = null
  const handshakePromise = new Promise((resolve) => {
    client.onHandshake = (msg) => {
      handshakeSeen = msg
      resolve(msg)
    }
  })

  const t0 = performance.now()
  const inflightPromise = client.call('embed', {
    text: longPayload,
    notifyInferenceStart: true,
    repeatCount: 25
  })

  await handshakePromise
  const terminateStart = performance.now()
  await client.terminate()
  const cancelTerminateMs = performance.now() - terminateStart

  let rejectedCode = null
  try {
    await inflightPromise
  } catch (err) {
    rejectedCode = err?.code ?? 'UNKNOWN'
  }

  const recoveryClient = new SpikeWorkerClient()
  const recT0 = performance.now()
  await recoveryClient.call('load', {
    modelDir,
    modelKey: 'bge-small-en-v1.5',
    pooling: 'cls',
    maxLength: 512
  })
  const recRes = await recoveryClient.call('embed', { text: 'post-inflight-cancel recovery query' })
  const recoveryMs = performance.now() - recT0
  await recoveryClient.terminate()

  return {
    kind: 'in_flight_onnx_inference_cancel',
    inferenceStartedHandshakeReceived: Boolean(handshakeSeen),
    handshakeSeqLen: handshakeSeen?.seqLen ?? null,
    cancelledRejectedCode: rejectedCode,
    cancelTerminateMs: Number(cancelTerminateMs.toFixed(2)),
    totalElapsedMs: Number((performance.now() - t0).toFixed(2)),
    recoveryDimensions: recRes.dimensions,
    recoveryTotalMs: Number(recoveryMs.toFixed(2))
  }
}

async function main() {
  const elHistogram = monitorEventLoopDelay({ resolution: 10 })
  elHistogram.enable()

  const bgeWithPrefix = await evaluateModel({
    key: 'bge-small-en-v1.5',
    pooling: 'cls',
    maxLength: 512,
    queryPrefix: BGE_QUERY_PREFIX,
    runChunkerCheck: true
  })

  const minilm = await evaluateModel({
    key: 'all-MiniLM-L6-v2',
    pooling: 'mean',
    maxLength: 256,
    queryPrefix: '',
    runChunkerCheck: false
  })

  const preInferenceCancel = await testPreInferenceDelayCancellation()
  const inFlightCancel = await testInFlightInferenceCancellationAndRecovery()

  elHistogram.disable()

  const report = {
    runtime: {
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
      modulesAbi: process.versions.modules,
      platform: process.platform,
      arch: process.arch
    },
    parentEventLoopDelayMs: {
      p50: Number((elHistogram.percentile(50) / 1e6).toFixed(2)),
      p95: Number((elHistogram.percentile(95) / 1e6).toFixed(2)),
      max: Number((elHistogram.max / 1e6).toFixed(2))
    },
    models: [bgeWithPrefix, minilm],
    cancellation: {
      preInferenceCancel,
      inFlightCancel
    }
  }

  console.log(JSON.stringify(report, null, 2))
}

await main()
