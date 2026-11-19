#!/usr/bin/env node
/**
 * Personal Vault — Stage 7E Planning & Evaluation: Synthetic Multi-Label Classification Runner
 *
 * Executes offline under Electron (`ELECTRON_RUN_AS_NODE=1`) with outbound network calls
 * monkey-patched to fail closed (`outboundNetworkAttempts === 0`).
 *
 * Compares:
 *   1. `naive_path_ext_baseline`: Naive single-keyword / `.md`/`.txt` heuristic (demonstrates false-hide hazard)
 *   2. Active deterministic prototype (`DETERMINISTIC_RULE_VERSION`): Conservative multi-signal classifier (0 models)
 *   3. `bge_proto_standalone_eval`: Uncalibrated zero-shot BGE-small-en-v1.5 prototype cosine similarity alone
 *   4. `hybrid_rules_plus_bge_v1_eval`: Conservative rules + optional BGE purpose fallback on `other` ("Other / No structured match")
 *      (strictly barred from marking clutter or overriding rules)
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { dirname, join, resolve } from 'node:path'
import tls from 'node:tls'
import { fileURLToPath } from 'node:url'
import { ORIGIN_LABELS, PURPOSE_LABELS, SYNTHETIC_CLASSIFICATION_CORPUS } from './corpus.mjs'
import { getRuntimeEnvironmentInfo, runAllStage7ERegressions } from './regressions.mjs'
import { classifyWithDeterministicRules, DETERMINISTIC_RULE_VERSION } from './rules-prototype.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')
const ELECTRON_EXE = resolve(REPO_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const CACHED_BGE_DIR = resolve(
  REPO_ROOT,
  'spikes',
  'doc-semantic-eval',
  '.model-cache',
  'bge-small-en-v1.5'
)

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

let outboundNetworkAttempts = 0
function blockNetwork(apiName) {
  outboundNetworkAttempts += 1
  throw new Error(`OFFLINE_GUARD: blocked outbound ${apiName} attempt during Stage 7E evaluation`)
}

globalThis.fetch = () => blockNetwork('fetch')
http.request = () => blockNetwork('http.request')
http.get = () => blockNetwork('http.get')
https.request = () => blockNetwork('https.request')
https.get = () => blockNetwork('https.get')
net.connect = () => blockNetwork('net.connect')
tls.connect = () => blockNetwork('tls.connect')

// ─── 1. Naive Path/Keyword Baseline (Demonstrates Why Single Signals Fail) ───
function classifyNaiveBaseline(doc) {
  const combined = `${doc.relativePath}\n${doc.fileName}\n${doc.text ?? ''}`
  const purposeLabels = []
  if (/\b(?:legal|lease|agreement|license|deed)\b/i.test(combined)) purposeLabels.push('legal')
  if (/\b(?:list|checklist|todo|inventory)\b/i.test(combined) || doc.extension === '.csv') {
    purposeLabels.push('lists')
  }
  if (/\b(?:instructions|guide|steps|setup|readme)\b/i.test(combined)) {
    purposeLabels.push('instructions')
  }
  if (/\b(?:receipt|invoice|paid|tax)\b/i.test(combined)) purposeLabels.push('receipts')
  if (/\b(?:recipe|recipes|cookbook|risotto|focaccia)\b/i.test(combined)) {
    purposeLabels.push('recipes')
  }

  const originLabels = []
  const isDevPathOrExt =
    /\b(?:dev|projects?|repos?|code|typescript|git|readme)\b/i.test(combined) ||
    doc.extension === '.md'
  const isSysPathOrName = /\b(?:system|app|log|crash|program|export)\b/i.test(combined)

  if (isDevPathOrExt) originLabels.push('software_project')
  if (isSysPathOrName) originLabels.push('application_system')
  if (originLabels.length === 0 && doc.text) originLabels.push('personal')

  return {
    purposeLabels,
    purposeStatus: doc.text ? (purposeLabels.length > 0 ? 'classified' : 'other') : 'unknown',
    originLabels,
    originStatus: originLabels.length > 0 ? 'classified' : 'unknown',
    isClutterCandidate:
      originLabels.includes('software_project') || originLabels.includes('application_system')
  }
}

// ─── 2. Optional Local BGE-small-en-v1.5 Prototype Helper (Zero Downloads) ───
const PINNED_BGE_ONNX_SHA256 = '6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4'
const PINNED_BGE_TOK_SHA256 = 'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66'
const BGE_QUERY_PREFIX = 'Represent this sentence for searching relevant passages: '

const PURPOSE_PROTOTYPES = {
  legal: [
    'Legal contract, signed agreement, residential lease, terms of obligation, license grant, or binding covenant between parties',
    'Mutual cost-sharing agreement, written understanding, promissory obligation, or formal legal notice signed by parties'
  ],
  lists: [
    'Checklist, shopping list, errands list, bulleted task backlog, or structured inventory list of items'
  ],
  instructions: [
    'Step-by-step operating instructions, setup guide, troubleshooting procedure, or post-procedure patient care directions',
    'How-to manual explaining what precautions to follow, how to operate equipment, or recovery care steps'
  ],
  receipts: [
    'Purchase receipt, paid invoice, billing statement, itemized charges, subtotal, sales tax, and payment tender'
  ],
  recipes: [
    'Cooking or baking recipe describing food ingredients, kitchen preparation, simmering, roasting, or traditional family dish'
  ],
  other: [
    'Personal letter, eulogy speech, diary reflection, narrative journal entry, or technical software architecture prose and system logs'
  ]
}

const ORIGIN_PROTOTYPES = {
  personal: [
    'Personal household document, family letter, home maintenance, medical care, cooking recipe, personal shopping, or consumer receipt'
  ],
  software_project: [
    'Software engineering repository documentation, open-source package README, source code API reference, or developer release backlog'
  ],
  application_system: [
    'Automated background daemon log file, operating system crash stack trace dump, process telemetry, or device driver installer EULA'
  ]
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function l2Normalize(vec) {
  let sumSq = 0
  for (let i = 0; i < vec.length; i += 1) sumSq += vec[i] * vec[i]
  const norm = Math.sqrt(sumSq)
  const out = new Float32Array(vec.length)
  for (let i = 0; i < vec.length; i += 1) out[i] = vec[i] / norm
  return out
}

function dot(a, b) {
  let s = 0
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i]
  return s
}

async function loadCachedBgeClassifierIfPresent() {
  const onnxPath = join(CACHED_BGE_DIR, 'onnx', 'model_quantized.onnx')
  const tokPath = join(CACHED_BGE_DIR, 'tokenizer.json')
  const tokCfgPath = join(CACHED_BGE_DIR, 'tokenizer_config.json')
  if (!existsSync(onnxPath) || !existsSync(tokPath)) {
    return null
  }
  if (
    sha256File(onnxPath) !== PINNED_BGE_ONNX_SHA256 ||
    sha256File(tokPath) !== PINNED_BGE_TOK_SHA256
  ) {
    throw new Error('Cached BGE artifact SHA-256 mismatch; refusing to load tampered file')
  }

  const { Tokenizer } = await import('@huggingface/tokenizers')
  const ort = await import('onnxruntime-node')

  const tokenizer = new Tokenizer(
    JSON.parse(readFileSync(tokPath, 'utf8')),
    existsSync(tokCfgPath) ? JSON.parse(readFileSync(tokCfgPath, 'utf8')) : {}
  )
  const session = await ort.InferenceSession.create(onnxPath, {
    executionProviders: ['cpu'],
    intraOpNumThreads: 2,
    interOpNumThreads: 1,
    enableCpuMemArena: false
  })
  const needsTokenTypeIds = session.inputNames.includes('token_type_ids')

  async function embed(text, isQueryPrototype = false) {
    const input = isQueryPrototype ? `${BGE_QUERY_PREFIX}${text}` : text
    const enc = tokenizer.encode(input)
    const seqLen = Math.min(enc.ids.length, 512)
    const ids = new BigInt64Array(seqLen)
    const mask = new BigInt64Array(seqLen)
    const types = new BigInt64Array(seqLen)
    for (let i = 0; i < seqLen; i += 1) {
      ids[i] = BigInt(enc.ids[i])
      mask[i] = 1n
      types[i] = 0n
    }
    if (enc.ids.length > 512 && seqLen >= 2) {
      ids[seqLen - 1] = 102n
    }
    const feeds = {
      input_ids: new ort.Tensor('int64', ids, [1, seqLen]),
      attention_mask: new ort.Tensor('int64', mask, [1, seqLen])
    }
    if (needsTokenTypeIds) {
      feeds.token_type_ids = new ort.Tensor('int64', types, [1, seqLen])
    }
    const outputs = await session.run(feeds)
    const tensor = outputs.last_hidden_state ?? outputs[session.outputNames[0]]
    const hidden = tensor.dims[tensor.dims.length - 1]
    return l2Normalize(tensor.data.subarray(0, hidden))
  }

  const purposeVecs = {}
  for (const [label, prompts] of Object.entries(PURPOSE_PROTOTYPES)) {
    purposeVecs[label] = []
    for (const p of prompts) {
      purposeVecs[label].push(await embed(p, true))
    }
  }
  const originVecs = {}
  for (const [label, prompts] of Object.entries(ORIGIN_PROTOTYPES)) {
    originVecs[label] = []
    for (const p of prompts) {
      originVecs[label].push(await embed(p, true))
    }
  }

  return {
    async scoreDocument(doc) {
      if (!doc.text || doc.text.trim().length < 80) {
        return null
      }
      const t0 = performance.now()
      const docVec = await embed(doc.text.trim(), false)
      const purposeSim = {}
      for (const [label, vecs] of Object.entries(purposeVecs)) {
        purposeSim[label] = Math.max(...vecs.map((v) => dot(docVec, v)))
      }
      const originSim = {}
      for (const [label, vecs] of Object.entries(originVecs)) {
        originSim[label] = Math.max(...vecs.map((v) => dot(docVec, v)))
      }
      const elapsedMs = performance.now() - t0
      return { purposeSim, originSim, elapsedMs }
    },
    async release() {
      await session.release()
    }
  }
}

function classifyStandaloneBge(doc, bgeScores) {
  if (!doc.text || doc.text.trim().length < 80 || !bgeScores) {
    return {
      purposeLabels: [],
      purposeStatus: 'unknown',
      originLabels: [],
      originStatus: 'unknown',
      isClutterCandidate: false
    }
  }
  const { purposeSim, originSim } = bgeScores
  const otherScore = purposeSim.other
  const rankedPurposes = PURPOSE_LABELS.map((l) => ({ label: l, score: purposeSim[l] })).sort(
    (a, b) => b.score - a.score
  )
  const topPurpose = rankedPurposes[0]
  const purposeLabels = []
  if (topPurpose.score >= 0.56 && topPurpose.score - otherScore >= 0.015) {
    for (const cand of rankedPurposes) {
      if (cand.score >= 0.56 && topPurpose.score - cand.score <= 0.025 && cand.score > otherScore) {
        purposeLabels.push(cand.label)
      }
    }
  }

  const rankedOrigins = ORIGIN_LABELS.map((l) => ({ label: l, score: originSim[l] })).sort(
    (a, b) => b.score - a.score
  )
  const originLabels = rankedOrigins[0].score >= 0.54 ? [rankedOrigins[0].label] : []

  return {
    purposeLabels,
    purposeStatus: purposeLabels.length > 0 ? 'classified' : 'other',
    originLabels,
    originStatus: originLabels.length > 0 ? 'classified' : 'unknown',
    isClutterCandidate:
      originLabels[0] === 'software_project' || originLabels[0] === 'application_system'
  }
}

function classifyHybridRulesPlusBge(doc, rulePred, bgeScores) {
  if (!bgeScores || rulePred.purposeStatus === 'unknown') {
    return rulePred
  }
  const purposeLabels = [...rulePred.purposeLabels]
  // Only consult BGE when deterministic purpose rules abstained (`other`) AND the document is NOT software/system clutter!
  if (purposeLabels.length === 0 && !rulePred.isClutterCandidate) {
    const otherScore = bgeScores.purposeSim.other
    const rankedPurposes = PURPOSE_LABELS.map((l) => ({
      label: l,
      score: bgeScores.purposeSim[l]
    })).sort((a, b) => b.score - a.score)
    const best = rankedPurposes[0]
    const second = rankedPurposes[1]
    // Relative margin gating over both `other` prototype and runner-up (BGE passage-query cosines sit in ~0.45..0.62)
    if (
      best.score >= 0.48 &&
      best.score - otherScore >= 0.08 &&
      best.score - second.score >= 0.05
    ) {
      purposeLabels.push(best.label)
    }
  }

  const originLabels = [...rulePred.originLabels]
  if (originLabels.length === 0 && !rulePred.isClutterCandidate) {
    const personalScore = bgeScores.originSim.personal
    const swScore = bgeScores.originSim.software_project
    const sysScore = bgeScores.originSim.application_system
    if (personalScore >= 0.58 && personalScore - Math.max(swScore, sysScore) >= 0.04) {
      originLabels.push('personal')
    }
  }

  return {
    ...rulePred,
    purposeLabels,
    purposeStatus: purposeLabels.length > 0 ? 'classified' : 'other',
    originLabels,
    originStatus: originLabels.length > 0 ? 'classified' : 'unknown',
    // Invariant: Local embedding fallback NEVER promotes a document into `isClutterCandidate = true`.
    isClutterCandidate: rulePred.isClutterCandidate
  }
}

// ─── 3. Per-Label & Clutter-Safety Metrics Evaluator ─────────────────────────
function computeBinaryMetrics(tp, fp, fn) {
  const precision = tp + fp === 0 ? 1.0 : tp / (tp + fp)
  const recall = tp + fn === 0 ? 1.0 : tp / (tp + fn)
  const f1 = precision + recall === 0 ? 0.0 : (2 * precision * recall) / (precision + recall)
  return { tp, fp, fn, precision, recall, f1 }
}

function evaluatePredictions(corpus, predictions) {
  const purposeMetrics = {}
  for (const label of PURPOSE_LABELS) {
    let tp = 0
    let fp = 0
    let fn = 0
    for (let i = 0; i < corpus.length; i += 1) {
      const gold = corpus[i].expectedPurposes.includes(label)
      const pred = predictions[i].purposeLabels.includes(label)
      if (gold && pred) tp += 1
      else if (!gold && pred) fp += 1
      else if (gold && !pred) fn += 1
    }
    purposeMetrics[label] = computeBinaryMetrics(tp, fp, fn)
  }

  for (const fallback of ['other', 'unknown']) {
    let tp = 0
    let fp = 0
    let fn = 0
    for (let i = 0; i < corpus.length; i += 1) {
      const gold = corpus[i].expectedFallbackStatus === fallback
      const pred = predictions[i].purposeStatus === fallback
      if (gold && pred) tp += 1
      else if (!gold && pred) fp += 1
      else if (gold && !pred) fn += 1
    }
    purposeMetrics[`status:${fallback}`] = computeBinaryMetrics(tp, fp, fn)
  }

  const originMetrics = {}
  for (const label of ORIGIN_LABELS) {
    let tp = 0
    let fp = 0
    let fn = 0
    for (let i = 0; i < corpus.length; i += 1) {
      const gold = corpus[i].expectedOrigins.includes(label)
      const pred = predictions[i].originLabels.includes(label)
      if (gold && pred) tp += 1
      else if (!gold && pred) fp += 1
      else if (gold && !pred) fn += 1
    }
    originMetrics[label] = computeBinaryMetrics(tp, fp, fn)
  }

  {
    let tp = 0
    let fp = 0
    let fn = 0
    for (let i = 0; i < corpus.length; i += 1) {
      const gold = corpus[i].expectedOrigins.length === 0
      const pred = predictions[i].originStatus === 'unknown'
      if (gold && pred) tp += 1
      else if (!gold && pred) fp += 1
      else if (gold && !pred) fn += 1
    }
    originMetrics['origin:unknown'] = computeBinaryMetrics(tp, fp, fn)
  }

  // Clutter safety metrics
  let valuablePersonalTotal = 0
  let valuablePersonalFalselyHidden = 0
  const falselyHiddenIds = []
  let clutterTp = 0
  let clutterFp = 0
  let clutterFn = 0
  const missedPurposeDetails = []
  const extraPurposeDetails = []

  const missedOriginDetails = []
  const clutterDiffDetails = []

  for (let i = 0; i < corpus.length; i += 1) {
    const doc = corpus[i]
    const pred = predictions[i]
    if (doc.valuablePersonal) {
      valuablePersonalTotal += 1
      if (pred.isClutterCandidate) {
        valuablePersonalFalselyHidden += 1
        falselyHiddenIds.push(doc.id)
      }
    }
    if (doc.expectedClutterCandidate && pred.isClutterCandidate) clutterTp += 1
    else if (!doc.expectedClutterCandidate && pred.isClutterCandidate) {
      clutterFp += 1
      clutterDiffDetails.push(`${doc.id} FALSE_CLUTTER`)
    } else if (doc.expectedClutterCandidate && !pred.isClutterCandidate) {
      clutterFn += 1
      clutterDiffDetails.push(`${doc.id} MISSED_CLUTTER (origins=[${pred.originLabels.join(',')}])`)
    }

    for (const g of doc.expectedOrigins) {
      if (!pred.originLabels.includes(g)) {
        missedOriginDetails.push(
          `${doc.id} missed origin:${g} (got [${pred.originLabels.join(',')}])`
        )
      }
    }

    for (const g of doc.expectedPurposes) {
      if (!pred.purposeLabels.includes(g)) {
        missedPurposeDetails.push(
          `${doc.id} missed purpose:${g} (got [${pred.purposeLabels.join(',')}], status=${pred.purposeStatus})`
        )
      }
    }
    for (const p of pred.purposeLabels) {
      if (!doc.expectedPurposes.includes(p)) {
        extraPurposeDetails.push(
          `${doc.id} extra purpose:${p} (expected [${doc.expectedPurposes.join(',')}])`
        )
      }
    }
  }

  return {
    purposeMetrics,
    originMetrics,
    clutter: {
      ...computeBinaryMetrics(clutterTp, clutterFp, clutterFn),
      valuablePersonalTotal,
      valuablePersonalFalselyHidden,
      valuablePersonalFalseHideRate:
        valuablePersonalTotal === 0 ? 0 : valuablePersonalFalselyHidden / valuablePersonalTotal,
      falselyHiddenIds
    },
    missedPurposeDetails,
    extraPurposeDetails,
    missedOriginDetails,
    clutterDiffDetails
  }
}

function printSummary(title, evalResult, timingInfo) {
  console.log(`\n=== ${title} ===`)
  if (timingInfo) {
    console.log(
      `Timing: total=${timingInfo.totalMs.toFixed(2)} ms, mean/doc=${timingInfo.meanMs.toFixed(3)} ms`
    )
  }
  console.log(
    `Clutter Safety: falselyHiddenValuablePersonal = ${evalResult.clutter.valuablePersonalFalselyHidden}/${evalResult.clutter.valuablePersonalTotal} (${(evalResult.clutter.valuablePersonalFalseHideRate * 100).toFixed(1)}%), Clutter P=${(evalResult.clutter.precision * 100).toFixed(1)}% R=${(evalResult.clutter.recall * 100).toFixed(1)}% F1=${(evalResult.clutter.f1 * 100).toFixed(1)}% (TP=${evalResult.clutter.tp}, FP=${evalResult.clutter.fp}, FN=${evalResult.clutter.fn})`
  )
  if (evalResult.clutter.falselyHiddenIds.length > 0) {
    console.log(`  Falsely hidden personal docs: ${evalResult.clutter.falselyHiddenIds.join(', ')}`)
  }
  console.log('Per-Label Purpose Metrics:')
  for (const [label, m] of Object.entries(evalResult.purposeMetrics)) {
    const displayLabel =
      label === 'status:other'
        ? 'status:other (Other / No structured match)'
        : label === 'status:unknown'
          ? 'status:unknown (Unreadable / Insufficient)'
          : label
    console.log(
      `  ${displayLabel.padEnd(43)} TP=${String(m.tp).padStart(2)} FP=${String(m.fp).padStart(2)} FN=${String(m.fn).padStart(2)} | P=${(m.precision * 100).toFixed(1).padStart(5)}% R=${(m.recall * 100).toFixed(1).padStart(5)}% F1=${(m.f1 * 100).toFixed(1).padStart(5)}%`
    )
  }
  console.log('Per-Label Origin Metrics:')
  for (const [label, m] of Object.entries(evalResult.originMetrics)) {
    console.log(
      `  ${label.padEnd(18)} TP=${String(m.tp).padStart(2)} FP=${String(m.fp).padStart(2)} FN=${String(m.fn).padStart(2)} | P=${(m.precision * 100).toFixed(1).padStart(5)}% R=${(m.recall * 100).toFixed(1).padStart(5)}% F1=${(m.f1 * 100).toFixed(1).padStart(5)}%`
    )
  }
  if (evalResult.missedPurposeDetails.length > 0) {
    console.log(`  Missed purposes: ${evalResult.missedPurposeDetails.join(' | ')}`)
  }
  if (evalResult.extraPurposeDetails.length > 0) {
    console.log(`  False-positive purposes: ${evalResult.extraPurposeDetails.join(' | ')}`)
  }
  if (evalResult.missedOriginDetails.length > 0) {
    console.log(`  Missed origins: ${evalResult.missedOriginDetails.join(' | ')}`)
  }
  if (evalResult.clutterDiffDetails.length > 0) {
    console.log(`  Clutter diffs: ${evalResult.clutterDiffDetails.join(' | ')}`)
  }
}

async function main() {
  const envInfo = getRuntimeEnvironmentInfo()
  console.log(
    `Personal Vault Stage 7E Synthetic Evaluation — Prototype: ${DETERMINISTIC_RULE_VERSION}`
  )
  console.log(
    `Runtime Environment: Electron ${envInfo.electron}, Node ${envInfo.node}, V8 ${envInfo.v8}, OS ${envInfo.platform}/${envInfo.arch} (${envInfo.osRelease}), CPU ${envInfo.cpuModel} (${envInfo.logicalCores} logical cores)`
  )
  console.log(`Tuning Corpus size: ${SYNTHETIC_CLASSIFICATION_CORPUS.length} synthetic documents`)

  const naivePreds = SYNTHETIC_CLASSIFICATION_CORPUS.map((doc) => classifyNaiveBaseline(doc))
  const naiveEval = evaluatePredictions(SYNTHETIC_CLASSIFICATION_CORPUS, naivePreds)
  printSummary('1. Naive Single-Keyword / Extension Baseline (Counter-Example)', naiveEval, null)

  const tRules0 = performance.now()
  const rulePreds = SYNTHETIC_CLASSIFICATION_CORPUS.map((doc) =>
    classifyWithDeterministicRules(doc)
  )
  const rulesTotalMs = performance.now() - tRules0
  for (const pred of rulePreds) {
    if (pred.ruleVersion !== DETERMINISTIC_RULE_VERSION) {
      throw new Error(
        `Prototype version mismatch: expected ${DETERMINISTIC_RULE_VERSION}, got ${pred.ruleVersion}`
      )
    }
  }
  const rulesEval = evaluatePredictions(SYNTHETIC_CLASSIFICATION_CORPUS, rulePreds)
  printSummary(`2. Conservative Deterministic Rules (${DETERMINISTIC_RULE_VERSION})`, rulesEval, {
    totalMs: rulesTotalMs,
    meanMs: rulesTotalMs / SYNTHETIC_CLASSIFICATION_CORPUS.length
  })

  const bge = await loadCachedBgeClassifierIfPresent()
  if (bge) {
    try {
      const bgeScoreList = []
      let bgeEmbedTotalMs = 0
      let embeddedDocs = 0
      for (const doc of SYNTHETIC_CLASSIFICATION_CORPUS) {
        const sc = await bge.scoreDocument(doc)
        bgeScoreList.push(sc)
        if (sc) {
          bgeEmbedTotalMs += sc.elapsedMs
          embeddedDocs += 1
        }
      }

      const standaloneBgePreds = SYNTHETIC_CLASSIFICATION_CORPUS.map((doc, idx) =>
        classifyStandaloneBge(doc, bgeScoreList[idx])
      )
      const standaloneBgeEval = evaluatePredictions(
        SYNTHETIC_CLASSIFICATION_CORPUS,
        standaloneBgePreds
      )
      printSummary(
        '3. Standalone BGE-small-en-v1.5 Prototype Similarity (Uncalibrated Model Alone)',
        standaloneBgeEval,
        {
          totalMs: bgeEmbedTotalMs,
          meanMs: embeddedDocs > 0 ? bgeEmbedTotalMs / embeddedDocs : 0
        }
      )

      const hybridPreds = SYNTHETIC_CLASSIFICATION_CORPUS.map((doc, idx) =>
        classifyHybridRulesPlusBge(doc, rulePreds[idx], bgeScoreList[idx])
      )
      const hybridEval = evaluatePredictions(SYNTHETIC_CLASSIFICATION_CORPUS, hybridPreds)
      printSummary(
        `4. Hybrid Conservative Rules (${DETERMINISTIC_RULE_VERSION}) + Optional BGE Purpose Fallback (No Clutter Promotion)`,
        hybridEval,
        {
          totalMs: rulesTotalMs + bgeEmbedTotalMs,
          meanMs: (rulesTotalMs + bgeEmbedTotalMs) / SYNTHETIC_CLASSIFICATION_CORPUS.length
        }
      )

      console.log('\n--- Diagnostic BGE Cosine Scores on Subtle Prose Cases ---')
      for (const targetId of [
        'doc-19-adv-narrative-recipe-in-system-dir',
        'doc-20-adv-journal-keyword-trap',
        'doc-27-informal-neighbor-agreement',
        'doc-28-narrative-post-op-care'
      ]) {
        const idx = SYNTHETIC_CLASSIFICATION_CORPUS.findIndex((d) => d.id === targetId)
        if (idx >= 0 && bgeScoreList[idx]) {
          console.log(
            `  ${targetId}:`,
            JSON.stringify({
              purposeSim: Object.fromEntries(
                Object.entries(bgeScoreList[idx].purposeSim).map(([k, v]) => [
                  k,
                  Number(v.toFixed(4))
                ])
              ),
              originSim: Object.fromEntries(
                Object.entries(bgeScoreList[idx].originSim).map(([k, v]) => [
                  k,
                  Number(v.toFixed(4))
                ])
              )
            })
          )
        }
      }
    } finally {
      await bge.release()
    }
  } else {
    console.log(
      '\n[INFO] Local cached BGE model not present in spikes/doc-semantic-eval/.model-cache; skipped optional BGE comparison (0 downloads performed).'
    )
  }

  console.log('\n=== 5. Permanent Adversarial Regression Suite (Findings 1–5) ===')
  const regSummary = runAllStage7ERegressions()
  for (const probe of regSummary.runtimeProbes) {
    console.log(
      `  [Runtime Probe] ${probe.name.padEnd(38)} input=${probe.inputChars} chars, inspected=${probe.inspectedChars} chars | cold=${probe.coldMs.toFixed(3)} ms, warmMedian=${probe.medianWarmMs.toFixed(3)} ms, warmMax=${probe.maxWarmMs.toFixed(3)} ms`
    )
  }
  console.log(
    `  [Evidence Independence] ${regSummary.independenceStats.isolatedTriggerCount} isolated single-trigger probes verified (<= 1 family/label, 0 clutter); ${regSummary.independenceStats.bannedLiteralCount} corpus-specific literals verified absent.`
  )
  console.log(
    `  [Fence, OCR & Version Regressions] All ${regSummary.passedChecks} regression groups passed under ${regSummary.ruleVersion}.`
  )

  if (outboundNetworkAttempts !== 0) {
    throw new Error(`Expected 0 outbound network attempts, got ${outboundNetworkAttempts}`)
  }
  if (rulesEval.clutter.valuablePersonalFalselyHidden !== 0) {
    throw new Error(
      `Conservative rules falsely hid valuable personal documents: ${rulesEval.clutter.falselyHiddenIds.join(', ')}`
    )
  }
  console.log(
    `\n[PASS] ${DETERMINISTIC_RULE_VERSION}: outboundNetworkAttempts = ${outboundNetworkAttempts}, 0 valuable personal documents hidden, all adversarial regressions passed.`
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
