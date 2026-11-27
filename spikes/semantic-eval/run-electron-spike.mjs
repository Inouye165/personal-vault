#!/usr/bin/env node
/**
 * Personal Vault — Stage 6A Offline Semantic Search Feasibility Spike (Real Electron Harness)
 *
 * Launches under the real Electron binary (ELECTRON_RUN_AS_NODE=1, matching verify-electron-sqlite.mjs)
 * and exercises:
 * 1. Model provisioning checksum verification (Xenova/clip-vit-base-patch32 quantized ONNX)
 * 2. Nonpersonal synthetic fixture generation and source-preservation baseline recording
 * 3. Worker-thread execution isolation (onnxruntime-node + @huggingface/tokenizers + sharp)
 *    with Electron main-thread event-loop delay monitoring (monitorEventLoopDelay)
 * 4. Cold model initialization latency, warm per-image decode/inference latency, throughput,
 *    and peak RSS/heap memory tracking
 * 5. Versioned embedding record persistence and revision invalidation check
 * 6. Natural-language text query evaluation across 7 explicit queries with positive/negative
 *    examples and declared relevance rubric
 * 7. Error, unsupported-format, missing-model, and cooperative/active cancellation verification
 *    (confirming incomplete work never claims success and worker capacity recovers)
 * 8. Synthetic vector index scan cost benchmark at 1k, 10k, 25k, and 50k items
 * 9. Bitwise source file preservation invariance check
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

// ---------------------------------------------------------------------------
// Outer Node Launcher -> Re-invokes under real Electron binary
// ---------------------------------------------------------------------------
if (!process.versions.electron) {
  const electronPath = require('../../node_modules/electron')
  console.log(`[semantic-eval] Re-launching spike under real Electron binary: ${electronPath}`)
  const child = spawnSync(
    electronPath,
    [fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    {
      cwd: __dirname,
      stdio: 'inherit',
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        ELECTRON_NO_ATTACH_CONSOLE: '1'
      }
    }
  )
  process.exit(child.status ?? 1)
}

// ---------------------------------------------------------------------------
// Inner Real Electron Execution
// ---------------------------------------------------------------------------
import { ensureModelDownloaded, MODEL_CACHE_DIR } from './fetch-model.mjs'
import { EVALUATION_QUERIES, generateSyntheticFixtures } from './generate-fixtures.mjs'
import {
  CLIP_EMBEDDING_DIMENSIONS,
  CLIP_MODEL_ID,
  CLIP_PREPROCESSING_VERSION,
  createVersionedEmbeddingRecord,
  isEmbeddingRecordCurrent,
  rankSemanticMatches
} from './semantic-core.mjs'
import { runSyntheticIndexBenchmark } from './benchmark-index.mjs'

class BoundedSemanticSpikeCoordinator {
  constructor(workerScriptPath) {
    this.workerScriptPath = workerScriptPath
    this.worker = null
    this.nextId = 1
    this.pending = new Map()
    this.isTerminating = false
  }

  ensureWorker() {
    if (this.worker && !this.isTerminating) return this.worker
    const w = new Worker(this.workerScriptPath)
    w.on('message', (msg) => {
      const entry = this.pending.get(msg.id)
      if (entry) {
        this.pending.delete(msg.id)
        entry.resolve(msg)
      }
    })
    w.on('error', (err) => {
      for (const [, entry] of this.pending) {
        entry.resolve({
          status: 'error',
          code: 'WORKER_CRASHED',
          message: err.message
        })
      }
      this.pending.clear()
    })
    this.worker = w
    return w
  }

  sendJob(payload) {
    const w = this.ensureWorker()
    const id = this.nextId++
    return new Promise((resolveJob) => {
      this.pending.set(id, { resolve: resolveJob })
      w.postMessage({ id, ...payload })
    })
  }

  async cancelAllAndTerminate() {
    if (!this.worker) return
    this.isTerminating = true
    for (const [, entry] of this.pending) {
      entry.resolve({
        status: 'error',
        code: 'CANCELLED',
        message: 'Semantic worker request cancelled'
      })
    }
    this.pending.clear()
    await this.worker.terminate()
    this.worker = null
    this.isTerminating = false
  }

  async shutdown() {
    if (this.worker) {
      await this.worker.terminate()
      this.worker = null
    }
  }
}

async function runSpike() {
  console.log('\n========================================================================')
  console.log(' Personal Vault — Stage 6A Offline Semantic Search Spike (Real Electron)')
  console.log('========================================================================')
  console.log(
    `  Runtime: Electron ${process.versions.electron} | Node ${process.versions.node} | V8 ${process.versions.v8}`
  )
  console.log(`  Platform: ${process.platform} (${process.arch})`)

  const loopMonitor = monitorEventLoopDelay({ resolution: 10 })
  loopMonitor.enable()

  const tempFixtureDir = mkdtempSync(join(tmpdir(), 'pv-stage6a-fixtures-'))
  const workerPath = join(__dirname, 'semantic-worker.mjs')
  const coordinator = new BoundedSemanticSpikeCoordinator(workerPath)

  try {
    // 1. Verify / provision local model cache
    console.log('\n[1/8] Verifying offline ONNX model cache & SHA-256 checksums...')
    const modelManifest = await ensureModelDownloaded()
    console.log(
      `      Verified ${modelManifest.files.length} files (${(modelManifest.totalBytes / (1024 * 1024)).toFixed(2)} MiB total).`
    )

    // 2. Generate synthetic nonpersonal fixtures & record source preservation baseline
    console.log('\n[2/8] Generating synthetic nonpersonal fixtures & recording baselines...')
    const { validFixtures, unsupportedPath, corruptPath } =
      await generateSyntheticFixtures(tempFixtureDir)
    const allFixturePaths = [...validFixtures.map((f) => f.filePath), unsupportedPath, corruptPath]
    const sourceBaselines = new Map()
    for (const p of allFixturePaths) {
      const st = statSync(p)
      const buf = readFileSync(p)
      sourceBaselines.set(p, {
        size: st.size,
        mtimeMs: st.mtimeMs,
        sha256: createHash('sha256').update(buf).digest('hex')
      })
    }
    console.log(
      `      Generated ${validFixtures.length} decodable photos + 1 unsupported HEIC + 1 corrupt JPEG.`
    )

    // 3. Missing-model honest failure check
    console.log('\n[3/8] Verifying missing-model failure behavior (no silent downloads)...')
    const missingModelRes = await coordinator.sendJob({
      action: 'embed_image',
      modelDir: join(tempFixtureDir, 'non-existent-model-dir'),
      sourcePath: validFixtures[0].filePath
    })
    if (missingModelRes.status !== 'error' || missingModelRes.code !== 'MISSING_MODEL') {
      throw new Error(`Expected MISSING_MODEL error, got: ${JSON.stringify(missingModelRes)}`)
    }
    console.log(`      Verified: Missing model cleanly returns code="${missingModelRes.code}".`)

    // 4. Unsupported format & corrupt image handling
    console.log('\n[4/8] Verifying unsupported format (HEIC) and corrupt image handling...')
    const unsupportedRes = await coordinator.sendJob({
      action: 'embed_image',
      modelDir: MODEL_CACHE_DIR,
      sourcePath: unsupportedPath
    })
    if (unsupportedRes.status !== 'unsupported') {
      throw new Error(`Expected status="unsupported", got: ${JSON.stringify(unsupportedRes)}`)
    }
    const corruptRes = await coordinator.sendJob({
      action: 'embed_image',
      modelDir: MODEL_CACHE_DIR,
      sourcePath: corruptPath
    })
    if (corruptRes.status !== 'error' || corruptRes.code !== 'DECODE_FAILED') {
      throw new Error(`Expected DECODE_FAILED on corrupt JPEG, got: ${JSON.stringify(corruptRes)}`)
    }
    if (corruptRes.coldLoadMs > 0) {
      // If corrupt image test loaded the model first, reset worker so Step 5 measures true cold load + first inference
      await coordinator.shutdown()
    }
    console.log(
      `      Verified: HEIC -> status="${unsupportedRes.status}", Corrupt JPEG -> status="${corruptRes.status}" (${corruptRes.code}).`
    )

    // Terminate worker before Step 5 so Step 5 measures true cold session creation + first image inference
    await coordinator.shutdown()

    // 5. Image embedding extraction (cold load + warm throughput + versioned records)
    console.log('\n[5/8] Computing image embeddings & versioned records for synthetic fixtures...')
    const indexEntries = []
    const versionedRecords = []
    const warmImageTimesMs = []
    const warmDecodeTimesMs = []
    const warmInferTimesMs = []
    let coldLoadMs = 0
    let peakWorkerRssBytes = 0
    let peakWorkerHeapBytes = 0

    const batchStart = performance.now()
    for (let i = 0; i < validFixtures.length; i++) {
      const fix = validFixtures[i]
      const res = await coordinator.sendJob({
        action: 'embed_image',
        modelDir: MODEL_CACHE_DIR,
        sourcePath: fix.filePath
      })
      if (res.status !== 'ready') {
        throw new Error(`Failed to embed fixture ${fix.fileName}: ${JSON.stringify(res)}`)
      }
      if (res.timings.coldLoadMs > 0) {
        coldLoadMs = res.timings.coldLoadMs
      }
      warmDecodeTimesMs.push(res.timings.decodeMs)
      warmInferTimesMs.push(res.timings.inferMs)
      warmImageTimesMs.push(res.timings.totalMs)
      if (res.memory.rssBytes > peakWorkerRssBytes) peakWorkerRssBytes = res.memory.rssBytes
      if (res.memory.heapUsedBytes > peakWorkerHeapBytes)
        peakWorkerHeapBytes = res.memory.heapUsedBytes

      const floatVec = new Float32Array(res.vector)
      const normCheck = Math.sqrt(floatVec.reduce((acc, v) => acc + v * v, 0))
      if (Math.abs(normCheck - 1.0) > 1e-4) {
        throw new Error(`Vector for ${fix.fileName} is not unit L2 normalized: norm=${normCheck}`)
      }

      const record = createVersionedEmbeddingRecord({
        fileLocationId: i + 1,
        discoveryObservationId: 100 + i,
        sha256: res.sha256,
        byteSize: res.byteSize,
        mtimeMs: res.mtimeMs,
        modelId: res.modelId,
        preprocessingVersion: res.preprocessingVersion,
        dimensions: res.dimensions,
        vector: floatVec
      })
      versionedRecords.push(record)

      indexEntries.push({
        fileLocationId: i + 1,
        id: fix.id,
        fileName: fix.fileName,
        category: fix.category,
        vector: floatVec
      })
    }
    const batchTotalMs = performance.now() - batchStart

    // Verify revision invalidation contract on first record
    const sampleRec = versionedRecords[0]
    const validWhenUnchanged = isEmbeddingRecordCurrent(sampleRec, {
      discoveryObservationId: sampleRec.discoveryObservationId,
      byteSize: sampleRec.byteSize,
      mtimeMs: validFixtures[0].mtimeMs ?? Number(sampleRec.contentRevision.split(':')[3]),
      sha256: sampleRec.contentSha256
    })
    const invalidWhenHashChanged = isEmbeddingRecordCurrent(sampleRec, {
      discoveryObservationId: sampleRec.discoveryObservationId,
      byteSize: sampleRec.byteSize,
      mtimeMs: Number(sampleRec.contentRevision.split(':')[3]),
      sha256: 'f'.repeat(64)
    })
    const invalidWhenModelChanged = isEmbeddingRecordCurrent(sampleRec, {
      discoveryObservationId: sampleRec.discoveryObservationId,
      byteSize: sampleRec.byteSize,
      mtimeMs: Number(sampleRec.contentRevision.split(':')[3]),
      sha256: sampleRec.contentSha256,
      modelId: 'Xenova/other-model@1'
    })
    if (!validWhenUnchanged || invalidWhenHashChanged || invalidWhenModelChanged) {
      throw new Error('Versioned embedding record revision invalidation check failed')
    }

    const avgImageTotalMs = warmImageTimesMs.reduce((a, b) => a + b, 0) / warmImageTimesMs.length
    const avgDecodeMs = warmDecodeTimesMs.reduce((a, b) => a + b, 0) / warmDecodeTimesMs.length
    const avgInferMs = warmInferTimesMs.reduce((a, b) => a + b, 0) / warmInferTimesMs.length
    const throughputImgsPerSec = 1000 / avgImageTotalMs

    console.log(`      Cold ONNX session + tokenizer load: ${coldLoadMs.toFixed(2)} ms`)
    console.log(
      `      Warm image embedding mean: ${avgImageTotalMs.toFixed(2)} ms (decode: ${avgDecodeMs.toFixed(2)} ms, vision ONNX: ${avgInferMs.toFixed(2)} ms)`
    )
    console.log(
      `      Warm single-worker throughput: ${throughputImgsPerSec.toFixed(2)} images/sec`
    )
    console.log(
      `      Worker peak RSS: ${(peakWorkerRssBytes / (1024 * 1024)).toFixed(2)} MiB | Worker heap: ${(peakWorkerHeapBytes / (1024 * 1024)).toFixed(2)} MiB`
    )

    // 6. Text query embedding & ranked retrieval rubric verification
    console.log('\n[6/8] Evaluating natural-language text queries against relevance rubric...')
    const queryResultsSummary = []
    const textInferTimesMs = []

    for (const q of EVALUATION_QUERIES) {
      const qRes = await coordinator.sendJob({
        action: 'embed_text',
        modelDir: MODEL_CACHE_DIR,
        queryText: q.queryText
      })
      if (qRes.status !== 'ready') {
        throw new Error(`Text query embedding failed for "${q.queryText}": ${JSON.stringify(qRes)}`)
      }
      textInferTimesMs.push(qRes.inferMs)
      const qVec = new Float32Array(qRes.vector)
      const ranked = rankSemanticMatches(qVec, indexEntries, { topK: indexEntries.length })

      const top1 = ranked[0]
      const positiveScores = q.positiveIds.map(
        (pid) => ranked.find((r) => r.id === pid)?.score ?? -1
      )
      const negativeScores = q.negativeIds.map(
        (nid) => ranked.find((r) => r.id === nid)?.score ?? 1
      )
      const minPositiveScore = Math.min(...positiveScores)
      const maxPositiveScore = Math.max(...positiveScores)
      const maxNegativeScore = Math.max(...negativeScores)
      const margin = maxPositiveScore - maxNegativeScore
      const allPositivesAboveNegatives = minPositiveScore > maxNegativeScore
      const top1IsPositive = q.positiveIds.includes(top1.id)

      console.log(`      Query [${q.id}]: "${q.queryText}" (${qRes.inferMs.toFixed(2)} ms)`)
      console.log(
        `        Top-1: ${top1.fileName} (score=${top1.score.toFixed(4)}) | maxPos=${maxPositiveScore.toFixed(4)}, minPos=${minPositiveScore.toFixed(4)}, maxNeg=${maxNegativeScore.toFixed(4)}, margin=+${margin.toFixed(4)}`
      )

      if (!top1IsPositive || !allPositivesAboveNegatives) {
        throw new Error(
          `Rubric failure on query ${q.id}: top1=${top1.id}, minPos=${minPositiveScore}, maxNeg=${maxNegativeScore}`
        )
      }

      queryResultsSummary.push({
        queryId: q.id,
        queryText: q.queryText,
        inferMs: Number(qRes.inferMs.toFixed(2)),
        top1File: top1.fileName,
        top1Score: Number(top1.score.toFixed(4)),
        minPositiveScore: Number(minPositiveScore.toFixed(4)),
        maxNegativeScore: Number(maxNegativeScore.toFixed(4)),
        margin: Number(margin.toFixed(4)),
        passedRubric: top1IsPositive && allPositivesAboveNegatives
      })
    }

    const avgTextInferMs = textInferTimesMs.reduce((a, b) => a + b, 0) / textInferTimesMs.length
    console.log(
      `      All ${EVALUATION_QUERIES.length}/${EVALUATION_QUERIES.length} queries passed rubric. Mean text query latency: ${avgTextInferMs.toFixed(2)} ms.`
    )

    // 7. Active cancellation & worker recovery verification
    console.log('\n[7/8] Verifying active job cancellation and worker capacity recovery...')
    const slowJobPromise = coordinator.sendJob({
      action: 'embed_image',
      modelDir: MODEL_CACHE_DIR,
      sourcePath: validFixtures[0].filePath,
      simulateSlowMs: 5000
    })
    await new Promise((r) => setTimeout(r, 80))
    await coordinator.cancelAllAndTerminate()
    const cancelledRes = await slowJobPromise
    if (cancelledRes.status !== 'error' || cancelledRes.code !== 'CANCELLED') {
      throw new Error(`Expected CANCELLED on aborted job, got: ${JSON.stringify(cancelledRes)}`)
    }
    // Verify subsequent request spawns fresh worker and succeeds
    const recoveryRes = await coordinator.sendJob({
      action: 'embed_text',
      modelDir: MODEL_CACHE_DIR,
      queryText: 'recovery check after cancellation'
    })
    if (recoveryRes.status !== 'ready') {
      throw new Error(`Worker failed to recover after cancellation: ${JSON.stringify(recoveryRes)}`)
    }
    console.log(
      `      Verified: Cancelled job returned status="error", code="CANCELLED" (never claimed success) and worker recovered cleanly.`
    )

    // 8. Synthetic index scan cost benchmark + main event-loop responsiveness + source invariance
    console.log('\n[8/8] Running synthetic index scan benchmark & verifying source preservation...')
    const indexBenchmark = runSyntheticIndexBenchmark([1_000, 10_000, 25_000, 50_000])

    const mainDelayP95Ms = loopMonitor.percentile(95) / 1e6
    const mainDelayMaxMs = loopMonitor.max / 1e6
    const mainMem = process.memoryUsage()

    for (const [filePath, base] of sourceBaselines.entries()) {
      const st = statSync(filePath)
      const buf = readFileSync(filePath)
      const sha = createHash('sha256').update(buf).digest('hex')
      if (st.size !== base.size || st.mtimeMs !== base.mtimeMs || sha !== base.sha256) {
        throw new Error(`Source preservation violated for ${filePath}`)
      }
    }

    console.log(
      `      Main thread event-loop delay during worker inference: p95=${mainDelayP95Ms.toFixed(2)} ms, max=${mainDelayMaxMs.toFixed(2)} ms`
    )
    console.log(`      Main process RSS: ${(mainMem.rss / (1024 * 1024)).toFixed(2)} MiB`)
    console.log('      Source preservation invariance: 100% bitwise identical across all fixtures.')

    console.log('\n=== STAGE 6A REAL ELECTRON SEMANTIC EVALUATION SPIKE PASSED ===\n')
    console.log(
      JSON.stringify(
        {
          environment: {
            electron: process.versions.electron,
            node: process.versions.node,
            platform: process.platform,
            arch: process.arch
          },
          model: {
            modelId: CLIP_MODEL_ID,
            preprocessingVersion: CLIP_PREPROCESSING_VERSION,
            dimensions: CLIP_EMBEDDING_DIMENSIONS,
            totalModelDiskBytes: modelManifest.totalBytes,
            totalModelDiskMiB: Number((modelManifest.totalBytes / (1024 * 1024)).toFixed(2))
          },
          performance: {
            coldLoadMs: Number(coldLoadMs.toFixed(2)),
            warmImageDecodeMeanMs: Number(avgDecodeMs.toFixed(2)),
            warmImageInferMeanMs: Number(avgInferMs.toFixed(2)),
            warmImageTotalMeanMs: Number(avgImageTotalMs.toFixed(2)),
            warmThroughputImagesPerSec: Number(throughputImgsPerSec.toFixed(2)),
            warmTextQueryMeanMs: Number(avgTextInferMs.toFixed(2)),
            batchTotalMs: Number(batchTotalMs.toFixed(2)),
            workerPeakRssMiB: Number((peakWorkerRssBytes / (1024 * 1024)).toFixed(2)),
            workerPeakHeapMiB: Number((peakWorkerHeapBytes / (1024 * 1024)).toFixed(2)),
            mainRssMiB: Number((mainMem.rss / (1024 * 1024)).toFixed(2)),
            mainEventLoopDelayP95Ms: Number(mainDelayP95Ms.toFixed(2)),
            mainEventLoopDelayMaxMs: Number(mainDelayMaxMs.toFixed(2))
          },
          queryRubricResults: queryResultsSummary,
          syntheticIndexBenchmark: indexBenchmark
        },
        null,
        2
      )
    )
  } finally {
    loopMonitor.disable()
    await coordinator.shutdown()
    rmSync(tempFixtureDir, { recursive: true, force: true })
  }
}

runSpike().catch((err) => {
  console.error('\n[semantic-eval] SPIKE FAILED:', err)
  process.exit(1)
})
