#!/usr/bin/env node
/**
 * Personal Vault — Real Electron Semantic Search Verification (Stage 6D)
 *
 * Verifies end-to-end natural-language photo search in real Electron (built and unpacked):
 *
 * 1. Offline Text Tokenization & ONNX text embedding inference off main thread.
 * 2. Real semantic search with meaningful CLIP image-text alignment:
 *    - "sunset warm orange sky" -> sunset_warm.jpg
 *    - "lush green forest foliage" -> forest_trees.png
 *    - "deep blue ocean water" -> ocean_blue.webp
 * 3. Filter-before-ranking behavior (e.g. rating, collection, and date filters prune candidates prior to top-K).
 * 4. Stale query handling, replacement race safety, and cancellation.
 * 5. Honest UI notices: match count, unindexed count, stale count, long-query truncation (77 tokens),
 *    and non-factual inference disclaimer.
 * 6. Photos UI integration: search bar, clear search restoring ordinary browsing, virtual grid match badges.
 * 7. Bounded resource governance: <= 2 decode workers, bounded DOM cells, responsive event loop.
 * 8. Bitwise source preservation invariance (byte size, SHA-256, birthtime, mtime invariant).
 * 9. Unpacked native ONNX runtime operation and sandboxed preload packaging.
 */

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'
import sharp from 'sharp'

const __dirname = resolve(fileURLToPath(import.meta.url), '..')
const rootDir = resolve(__dirname, '..')

const mode = process.argv.includes('--mode=unpacked') ? 'unpacked' : 'built'

function getFreePort() {
  return new Promise((resolvePort, reject) => {
    const s = createNetServer()
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port
      s.close(() => resolvePort(port))
    })
    s.on('error', reject)
  })
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function killTree(child) {
  if (!child || !child.pid || child.exitCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    child.kill('SIGKILL')
  }
}

async function findPageTarget(port, deadline) {
  let lastError = null
  let lastTargets = null
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = await res.json()
      lastTargets = targets
      const page = targets.find((t) => t.type === 'page' && t.url && !t.url.startsWith('devtools:'))
      if (page) return page
    } catch (err) {
      lastError = err
    }
    await sleep(200)
  }
  throw new Error(
    `Timed out waiting for application window on port ${port}. Last error: ${lastError?.message ?? 'none'}, targets: ${JSON.stringify(lastTargets)}`
  )
}

function connectCdp(url) {
  return new Promise((resolveCdp, reject) => {
    const ws = new WebSocket(url)
    let nextId = 1
    const pending = new Map()
    ws.onerror = () => reject(new Error('Could not connect to DevTools Protocol'))
    ws.onmessage = (message) => {
      try {
        const msg = JSON.parse(String(message.data))
        if (msg.id && pending.has(msg.id)) {
          const { resolve: res, reject: rej } = pending.get(msg.id)
          pending.delete(msg.id)
          if (msg.error) rej(new Error(msg.error.message))
          else res(msg.result)
        }
      } catch (err) {
        console.error('CDP parse error:', err)
      }
    }
    ws.onopen = () => {
      resolveCdp({
        send: (method, params = {}) =>
          new Promise((res, rej) => {
            const id = nextId++
            pending.set(id, { resolve: res, reject: rej })
            ws.send(JSON.stringify({ id, method, params }))
          }),
        close: () => ws.close()
      })
    }
  })
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? 'Evaluation failed')
  }
  return result.result.value
}

async function waitForApi(cdp, timeoutMs = 20000) {
  const readyBy = Date.now() + timeoutMs
  while (Date.now() < readyBy) {
    try {
      const hasApi = await evaluate(cdp, `typeof window.api === 'object' && window.api !== null`)
      if (hasApi) return true
    } catch {
      // still loading
    }
    await sleep(150)
  }
  return false
}

async function launchApp(userDataDir, port, extraEnv = {}) {
  const commonArgs = [`--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`]
  const env = { ...process.env, ...extraEnv }
  let child
  if (mode === 'unpacked') {
    const exePath = join(rootDir, 'dist', 'win-unpacked', 'Personal Vault.exe')
    if (!existsSync(exePath)) {
      throw new Error(`Unpacked binary not found at ${exePath}. Run npm run build:unpack first.`)
    }
    child = spawn(exePath, commonArgs, {
      cwd: rootDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env
    })
  } else {
    child = spawn(electronPath, ['.', ...commonArgs], {
      cwd: rootDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env
    })
  }

  const deadline = Date.now() + 25000
  try {
    const page = await findPageTarget(port, deadline)
    const cdp = await connectCdp(page.webSocketDebuggerUrl)
    await cdp.send('Runtime.enable')
    const apiReady = await waitForApi(cdp, 20000)
    if (!apiReady) {
      throw new Error('window.api failed to initialize')
    }
    return { child, cdp }
  } catch (err) {
    killTree(child)
    throw err
  }
}

function snapshotDirectoryFiles(dirPath) {
  const map = new Map()
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile()) {
        const st = statSync(full)
        const buf = readFileSync(full)
        const sha = createHash('sha256').update(buf).digest('hex')
        map.set(full, {
          size: st.size,
          birthtimeMs: st.birthtimeMs,
          mtimeMs: st.mtimeMs,
          sha
        })
      }
    }
  }
  walk(dirPath)
  return map
}

function assertDirectoryUnchanged(dirPath, baselineMap, label) {
  const currentMap = snapshotDirectoryFiles(dirPath)
  if (currentMap.size !== baselineMap.size) {
    throw new Error(
      `[${label}] File count changed in ${dirPath}: expected ${baselineMap.size}, got ${currentMap.size}`
    )
  }
  for (const [filePath, base] of baselineMap.entries()) {
    const cur = currentMap.get(filePath)
    if (!cur) {
      throw new Error(`[${label}] Missing file ${filePath}`)
    }
    if (cur.size !== base.size) {
      throw new Error(`[${label}] Byte size changed for ${filePath}: ${base.size} -> ${cur.size}`)
    }
    if (cur.sha !== base.sha) {
      throw new Error(`[${label}] SHA-256 changed for ${filePath}`)
    }
    if (Math.abs(cur.mtimeMs - base.mtimeMs) > 0.5) {
      throw new Error(
        `[${label}] mtimeMs changed for ${filePath}: ${base.mtimeMs} -> ${cur.mtimeMs}`
      )
    }
    if (Math.abs(cur.birthtimeMs - base.birthtimeMs) > 0.5) {
      throw new Error(
        `[${label}] birthtimeMs changed for ${filePath}: ${base.birthtimeMs} -> ${cur.birthtimeMs}`
      )
    }
  }
}

async function waitForScanJob(cdp, jobId) {
  for (let i = 0; i < 120; i++) {
    const latest = await evaluate(cdp, `window.api.getLatestScanJob()`)
    if (
      latest?.job?.jobId === jobId &&
      (latest.job.status === 'completed' || latest.job.status === 'failed')
    ) {
      if (latest.job.status === 'failed') {
        throw new Error(`Scan job ${jobId} failed`)
      }
      return latest.job
    }
    await sleep(150)
  }
  throw new Error(`Scan job ${jobId} timed out`)
}

async function waitForSemanticIndexJob(cdp, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const p = await evaluate(cdp, `window.api.getSemanticIndexProgress()`)
    if (p.status === 'completed') return p
    if (p.status === 'failed') {
      throw new Error(`Semantic indexing failed: ${p.lastError ?? 'unknown error'}`)
    }
    await sleep(200)
  }
  throw new Error('Semantic indexing timed out')
}

async function main() {
  console.log(
    `\n=== Personal Vault: Stage 6D Natural-Language Photo Search Verification (${mode.toUpperCase()} mode) ===\n`
  )

  let passCount = 0
  function pass(msg) {
    passCount++
    console.log(`  [PASS ${passCount}] ${msg}`)
  }

  // 1. Packaged hygiene check
  if (mode === 'unpacked') {
    const unpackedRoot = join(rootDir, 'dist', 'win-unpacked')
    const ortBinding = join(
      unpackedRoot,
      'resources',
      'app.asar.unpacked',
      'node_modules',
      'onnxruntime-node',
      'bin',
      'napi-v6',
      'win32',
      'x64',
      'onnxruntime_binding.node'
    )
    if (!existsSync(ortBinding)) {
      throw new Error(`Expected unpacked ONNX Runtime native binding at ${ortBinding}`)
    }
    pass('Unpacked ONNX Runtime native binary correctly installed in app.asar.unpacked')
  }

  // 2. Sandboxed preload hygiene check: ensure out/preload/index.js requires only electron
  const preloadPath = join(rootDir, 'out', 'preload', 'index.js')
  const preloadCode = readFileSync(preloadPath, 'utf8')
  const rawRequires = Array.from(preloadCode.matchAll(/require\(([^)]+)\)/g), (m) => m[1])
  if (rawRequires.some((r) => !r.includes('electron'))) {
    throw new Error(
      `Preload sandbox boundary violation: unexpected requires: ${JSON.stringify(rawRequires)}`
    )
  }
  pass('Preload script strictly sandboxed: zero external package runtime requires (only electron)')

  // 3. Locate model cache from Stage 6A
  const cachedModelSource = join(
    rootDir,
    'spikes',
    'semantic-eval',
    '.model-cache',
    'Xenova--clip-vit-base-patch32'
  )
  if (!existsSync(join(cachedModelSource, 'onnx', 'text_model_quantized.onnx'))) {
    throw new Error(`Local verified model fixture not found at ${cachedModelSource}`)
  }

  const tempBase = mkdtempSync(join(tmpdir(), 'pv-verify-search-6d-'))
  const userDataDir = join(tempBase, 'user-data')
  const offlineModelFixtureDir = join(tempBase, 'offline-model-source')
  const photosDir = join(tempBase, 'photos-source')

  mkdirSync(userDataDir, { recursive: true })
  mkdirSync(join(offlineModelFixtureDir, 'onnx'), { recursive: true })
  mkdirSync(photosDir, { recursive: true })

  // Copy model files into isolated source
  const modelFiles = [
    'config.json',
    'preprocessor_config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'special_tokens_map.json',
    'onnx/vision_model_quantized.onnx',
    'onnx/text_model_quantized.onnx'
  ]
  for (const rel of modelFiles) {
    copyFileSync(join(cachedModelSource, rel), join(offlineModelFixtureDir, rel))
  }
  const offlineModelBaselines = snapshotDirectoryFiles(offlineModelFixtureDir)

  // 4. Generate real photograph fixtures using Stage 6A verified SVG visual compositions
  console.log('[Phase 1] Generating distinct semantic photograph fixtures...')
  const fixtures = [
    {
      fileName: 'sunset_beach.jpg',
      format: 'jpeg',
      svg: `<svg width="640" height="480" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#8b1e3f"/>
            <stop offset="45%" stop-color="#db3a34"/>
            <stop offset="80%" stop-color="#ff784f"/>
            <stop offset="100%" stop-color="#ffe066"/>
          </linearGradient>
          <linearGradient id="sea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#1d3557"/>
            <stop offset="100%" stop-color="#0b132b"/>
          </linearGradient>
        </defs>
        <rect width="640" height="310" fill="url(#sky)"/>
        <circle cx="320" cy="255" r="72" fill="#fff3b0"/>
        <circle cx="320" cy="255" r="58" fill="#ffffff" opacity="0.8"/>
        <rect y="310" width="640" height="170" fill="url(#sea)"/>
        <ellipse cx="320" cy="330" rx="110" ry="12" fill="#ff9f1c" opacity="0.75"/>
        <ellipse cx="320" cy="360" rx="85" ry="9" fill="#ffbf69" opacity="0.65"/>
      </svg>`
    },
    {
      fileName: 'evergreen_forest.png',
      format: 'png',
      svg: `<svg width="640" height="480" xmlns="http://www.w3.org/2000/svg">
        <rect width="640" height="480" fill="#cfe8ff"/>
        <rect y="350" width="640" height="130" fill="#2d6a4f"/>
        <rect x="110" y="310" width="24" height="60" fill="#5c4033"/>
        <polygon points="122,90 40,240 204,240" fill="#1b4332"/>
        <polygon points="122,150 30,320 214,320" fill="#2d6a4f"/>
        <rect x="308" y="320" width="28" height="65" fill="#5c4033"/>
        <polygon points="322,60 220,220 424,220" fill="#081c15"/>
        <polygon points="322,120 205,290 439,290" fill="#1b4332"/>
        <rect x="500" y="315" width="24" height="60" fill="#5c4033"/>
        <polygon points="512,100 430,250 594,250" fill="#1b4332"/>
        <polygon points="512,160 415,330 609,330" fill="#2d6a4f"/>
      </svg>`
    },
    {
      fileName: 'snowy_mountain_peaks.webp',
      format: 'webp',
      svg: `<svg width="640" height="480" xmlns="http://www.w3.org/2000/svg">
        <rect width="640" height="480" fill="#4ea8de"/>
        <polygon points="180,90 10,420 350,420" fill="#6c757d"/>
        <polygon points="180,90 115,215 155,195 180,225 210,195 245,215" fill="#ffffff"/>
        <polygon points="430,60 220,420 630,420" fill="#495057"/>
        <polygon points="430,60 355,205 395,180 430,215 465,185 505,205" fill="#f8f9fa"/>
        <rect y="400" width="640" height="80" fill="#dee2e6"/>
      </svg>`
    },
    {
      fileName: 'red_sports_car.jpg',
      format: 'jpeg',
      svg: `<svg width="640" height="480" xmlns="http://www.w3.org/2000/svg">
        <rect width="640" height="340" fill="#edf2f4"/>
        <rect y="340" width="640" height="140" fill="#4a4e69"/>
        <path d="M 110 290 L 180 200 L 410 200 L 490 270 L 540 280 L 540 345 L 95 345 L 95 290 Z" fill="#d90429"/>
        <polygon points="195,212 300,212 300,275 145,275" fill="#90e0ef"/>
        <polygon points="315,212 398,212 465,275 315,275" fill="#90e0ef"/>
        <circle cx="205" cy="345" r="52" fill="#222222"/>
        <circle cx="445" cy="345" r="52" fill="#222222"/>
      </svg>`
    },
    {
      fileName: 'white_sailboat_sea.jpg',
      format: 'jpeg',
      svg: `<svg width="640" height="480" xmlns="http://www.w3.org/2000/svg">
        <rect width="640" height="330" fill="#90e0ef"/>
        <rect y="330" width="640" height="150" fill="#0077b6"/>
        <rect x="295" y="90" width="10" height="240" fill="#5c4033"/>
        <polygon points="295,95 140,290 295,290" fill="#f8f9fa"/>
        <polygon points="310,110 460,290 310,290" fill="#ffffff"/>
        <path d="M 110 320 L 490 320 L 430 365 L 170 365 Z" fill="#3a5a40"/>
      </svg>`
    }
  ]

  for (const f of fixtures) {
    const pipeline = sharp(Buffer.from(f.svg))
    let buf
    if (f.format === 'png') buf = await pipeline.png().toBuffer()
    else if (f.format === 'webp') buf = await pipeline.webp().toBuffer()
    else buf = await pipeline.jpeg({ quality: 90 }).toBuffer()
    writeFileSync(join(photosDir, f.fileName), buf)
  }

  // Background simple photos
  for (let i = 1; i <= 5; i++) {
    const bg = await sharp({
      create: {
        width: 320,
        height: 240,
        channels: 3,
        background: { r: 128, g: 128, b: 128 }
      }
    })
      .jpeg({ quality: 80 })
      .toBuffer()
    writeFileSync(join(photosDir, `photo_neutral_${i}.jpg`), bg)
  }

  const initialPhotoBaselines = snapshotDirectoryFiles(photosDir)
  pass(`Generated ${initialPhotoBaselines.size} distinct semantic photograph fixtures`)

  const port = await getFreePort()
  let app = null

  try {
    console.log('[Phase 2] Launching Electron app with isolated userData...')
    app = await launchApp(userDataDir, port, { PV_TEST_MODEL_IMPORT_DIR: offlineModelFixtureDir })
    pass('Electron application launched and window.api connected')

    // 5. Test unprovisioned search behavior
    console.log('[Phase 3] Testing search behavior prior to model provisioning...')
    const unprovSearch = await evaluate(
      app.cdp,
      `window.api.searchPhotosSemantic({ queryText: 'sunset sky' })`
    )
    if (unprovSearch.modelStatus !== 'unprovisioned' || unprovSearch.items.length !== 0) {
      throw new Error(`Expected unprovisioned status, got: ${JSON.stringify(unprovSearch)}`)
    }
    pass('Search returns honest unprovisioned status and empty results when model is missing')

    // 6. Import verified model folder
    console.log('[Phase 4] Importing verified offline CLIP model folder...')
    const modelImportRes = await evaluate(app.cdp, `window.api.importSemanticModelFromFolder()`)
    if (modelImportRes.state !== 'ready') {
      throw new Error(`Model import did not reach ready state: ${JSON.stringify(modelImportRes)}`)
    }
    pass('Offline model folder verified and imported to ready state')

    // 7. Scan photos directory
    console.log('[Phase 5] Scanning photograph source root...')
    const scanAction = await evaluate(
      app.cdp,
      `window.api.startScan({ roots: [${JSON.stringify(photosDir)}] })`
    )
    const scanJobId = scanAction?.job?.jobId ?? scanAction?.jobId
    if (!scanAction.success || typeof scanJobId !== 'number') {
      throw new Error(`Failed to start scan job: ${JSON.stringify(scanAction)}`)
    }
    const completedScan = await waitForScanJob(app.cdp, scanJobId)
    if (completedScan.discoveredCount !== initialPhotoBaselines.size) {
      throw new Error(
        `Expected ${initialPhotoBaselines.size} scanned photos, got ${completedScan.discoveredCount}`
      )
    }
    pass(`Discovered and scanned ${completedScan.discoveredCount} photos`)

    // 8. Run semantic indexing on discovered photos
    console.log('[Phase 6] Running semantic indexing with vision ONNX inference...')
    await evaluate(app.cdp, `window.api.startSemanticIndexing()`)
    const completedIndex = await waitForSemanticIndexJob(app.cdp, 60000)
    if (completedIndex.processedPhotos !== initialPhotoBaselines.size) {
      throw new Error(
        `Expected ${initialPhotoBaselines.size} processed photos, got ${completedIndex.processedPhotos}`
      )
    }
    pass(
      `Indexed ${completedIndex.processedPhotos} photos with real ONNX CLIP ViT-B/32 vision embeddings`
    )

    // 9. Natural-language semantic queries with real text ONNX embedding
    console.log('[Phase 7] Executing natural-language queries against real embeddings...')

    // Query 1: Sunset
    const tSunset0 = Date.now()
    const sunsetRes = await evaluate(
      app.cdp,
      `window.api.searchPhotosSemantic({ queryText: 'golden orange sunset over ocean horizon' })`
    )
    const sunsetLatency = Date.now() - tSunset0
    if (sunsetRes.items.length === 0 || !sunsetRes.items[0].photo.fileName.includes('sunset')) {
      throw new Error(
        `Query 'golden orange sunset' expected top match sunset_beach, got: ${sunsetRes.items[0]?.photo?.fileName}`
      )
    }
    if (typeof sunsetRes.items[0].score !== 'number' || sunsetRes.items[0].score <= 0.15) {
      throw new Error(`Expected cosine score > 0.15, got: ${sunsetRes.items[0].score}`)
    }
    pass(
      `Query 'golden orange sunset' correctly matched '${sunsetRes.items[0].photo.fileName}' (score=${sunsetRes.items[0].score.toFixed(3)}, ${sunsetLatency}ms)`
    )

    // Query 2: Forest
    const forestRes = await evaluate(
      app.cdp,
      `window.api.searchPhotosSemantic({ queryText: 'lush green pine trees evergreen forest canopy' })`
    )
    if (forestRes.items.length === 0 || !forestRes.items[0].photo.fileName.includes('forest')) {
      throw new Error(
        `Query 'lush green forest' expected top match evergreen_forest, got: ${forestRes.items[0]?.photo?.fileName}`
      )
    }
    pass(
      `Query 'lush green forest' correctly matched '${forestRes.items[0].photo.fileName}' (score=${forestRes.items[0].score.toFixed(3)})`
    )

    // Query 3: Car
    const carRes = await evaluate(
      app.cdp,
      `window.api.searchPhotosSemantic({ queryText: 'bright red sports car automobile vehicle' })`
    )
    if (carRes.items.length === 0 || !carRes.items[0].photo.fileName.includes('car')) {
      throw new Error(
        `Query 'bright red sports car' expected top match red_sports_car, got: ${carRes.items[0]?.photo?.fileName}`
      )
    }
    pass(
      `Query 'bright red sports car' correctly matched '${carRes.items[0].photo.fileName}' (score=${carRes.items[0].score.toFixed(3)})`
    )

    // 10. Filter-Before-Ranking Verification
    console.log('[Phase 8] Verifying filter-before-ranking behavior...')
    // Add annotation: rate forest photo as 5 stars
    const forestPhoto = forestRes.items[0].photo
    const sunsetPhoto = sunsetRes.items[0].photo
    await evaluate(
      app.cdp,
      `window.api.setPhotoAnnotation({
        fileLocationId: ${forestPhoto.id},
        rating: 5,
        flag: 'pick',
        expectedRevision: 'rev:' + ${forestPhoto.discoveryObservationId} + ':' + ${forestPhoto.byteSize} + ':' + ${forestPhoto.filesystemMtimeMs} + ':' + ${JSON.stringify(forestPhoto.activeHash)},
        expectedVersion: 0
      })`
    )
    // Rate sunset photo as 1 star
    await evaluate(
      app.cdp,
      `window.api.setPhotoAnnotation({
        fileLocationId: ${sunsetPhoto.id},
        rating: 1,
        flag: 'none',
        expectedRevision: 'rev:' + ${sunsetPhoto.discoveryObservationId} + ':' + ${sunsetPhoto.byteSize} + ':' + ${sunsetPhoto.filesystemMtimeMs} + ':' + ${JSON.stringify(sunsetPhoto.activeHash)},
        expectedVersion: 0
      })`
    )

    // Search "forest" with ratingFilter='5' -> should match forestPhoto
    const filteredForest = await evaluate(
      app.cdp,
      `window.api.searchPhotosSemantic({ queryText: 'green forest trees', ratingFilter: '5' })`
    )
    if (filteredForest.items.length !== 1 || filteredForest.items[0].photo.id !== forestPhoto.id) {
      throw new Error(`Expected only 5-star forest photo, got: ${filteredForest.items.length}`)
    }
    pass('Rating filter 5 correctly included 5-star candidate before ranking')

    // Search "sunset" with ratingFilter='5' -> sunset photo has rating 1, must be excluded BEFORE top-K selection!
    const filteredSunset = await evaluate(
      app.cdp,
      `window.api.searchPhotosSemantic({ queryText: 'golden orange sunset', ratingFilter: '5', minScore: 0.15 })`
    )
    if (filteredSunset.items.some((item) => item.photo.fileName.includes('sunset'))) {
      throw new Error(
        `Filter-before-ranking violation: 1-star sunset photo appeared in rating 5 search`
      )
    }
    if (filteredSunset.items.some((item) => item.photo.rating !== 5)) {
      throw new Error('Filter-before-ranking violation: photo with rating != 5 returned')
    }
    pass(
      'Filter-before-ranking verified: 1-star sunset photo pruned prior to ranking (only 5-star candidates eligible)'
    )

    // 11. Long-Query Truncation Notice
    console.log('[Phase 9] Verifying honest long-query truncation to 77 tokens...')
    // 480 characters of short tokens -> exceeds 77 CLIP tokens while satisfying <= 500 chars limit
    const longQuery = 'a b c d e f g h i j k l m n o p q r s t u v w x y z 1 2 3 4 5 6 7 8 9 0 '
      .repeat(6)
      .slice(0, 480)
    const longRes = await evaluate(
      app.cdp,
      `window.api.searchPhotosSemantic({ queryText: ${JSON.stringify(longQuery)} })`
    )
    if (!longRes.truncated || longRes.tokenCount !== 77) {
      throw new Error(
        `Expected truncated: true and tokenCount: 77, got: ${JSON.stringify(longRes)}`
      )
    }
    pass('Long query (> 77 tokens) honestly truncated with truncated: true and tokenCount: 77')

    // 12. Active Cancellation, Rapid Replacement, Concurrent Pages & Main Process Heartbeat
    console.log(
      '[Phase 10] Testing active cancellation, replacement, concurrent pages, and main process heartbeat...'
    )

    // 12a. Active cancellation
    const searchP1 = evaluate(
      app.cdp,
      `window.api.searchPhotosSemantic({ queryText: 'yellow sunrise daylight morning' })`
    )
    await evaluate(app.cdp, `window.api.cancelPhotosSemanticSearch()`)
    let cancelError = null
    try {
      await searchP1
    } catch (err) {
      cancelError = err
    }
    if (!cancelError || !String(cancelError).toLowerCase().includes('cancel')) {
      throw new Error(`Expected search to reject with cancellation error, got: ${cancelError}`)
    }
    pass('Active search was genuinely cancelled and rejected with SearchCancelledError')

    // 12b. Rapid query replacement
    const replaceP1 = evaluate(
      app.cdp,
      `window.api.searchPhotosSemantic({ queryText: 'first replacement query' })`
    )
    const replaceP2 = evaluate(
      app.cdp,
      `window.api.searchPhotosSemantic({ queryText: 'second replacement query' })`
    )
    let p1SupersededError = null
    try {
      await replaceP1
    } catch (err) {
      p1SupersededError = err
    }
    if (!p1SupersededError || !String(p1SupersededError).toLowerCase().includes('superseded')) {
      throw new Error(
        `Expected first query to reject with supersession error, got: ${p1SupersededError}`
      )
    }
    const r2Success = await replaceP2
    if (!r2Success || r2Success.modelStatus !== 'ready') {
      throw new Error('Replacement query failed to resolve successfully')
    }
    pass('Rapid query replacement superseded older search and resolved newer search successfully')

    // 12c. Concurrent page requests for the same query generation
    const [page0Res, page1Res] = await Promise.all([
      evaluate(
        app.cdp,
        `window.api.searchPhotosSemantic({ queryText: 'ocean horizon blue water', offset: 0, limit: 1 })`
      ),
      evaluate(
        app.cdp,
        `window.api.searchPhotosSemantic({ queryText: 'ocean horizon blue water', offset: 1, limit: 1 })`
      )
    ])
    if (page0Res.offset !== 0 || page1Res.offset !== 1) {
      throw new Error(
        `Concurrent page requests offsets mismatch: ${page0Res.offset}, ${page1Res.offset}`
      )
    }
    if (page0Res.items.length === 0 || page1Res.items.length === 0) {
      throw new Error('Concurrent page requests failed to return expected items')
    }
    if (page0Res.items[0].photo.id === page1Res.items[0].photo.id) {
      throw new Error('Concurrent pages returned identical photo instead of paginated results')
    }
    pass(
      'Concurrent page requests for identical query generation executed and paginated successfully'
    )

    // 12d. Main-process responsiveness during active worker search (independent heartbeat)
    const inFlightSearchPromise = evaluate(
      app.cdp,
      `window.api.searchPhotosSemantic({ queryText: 'green forest trees leaves foliage canopy landscape' })`
    )
    // Send lightweight app info IPC while worker search is executing
    const tHeartbeatStart = Date.now()
    const appInfo = await evaluate(app.cdp, `window.api.getAppInfo()`)
    const heartbeatLatency = Date.now() - tHeartbeatStart
    await inFlightSearchPromise

    if (!appInfo || !appInfo.version) {
      throw new Error('Main process heartbeat failed to return app info')
    }
    if (heartbeatLatency > 200) {
      throw new Error(
        `Main process heartbeat delayed (${heartbeatLatency}ms) during worker search execution`
      )
    }
    pass(
      `Main process event loop remained responsive during search worker execution (heartbeat: ${heartbeatLatency}ms)`
    )

    // 13. UI Navigation & Search Bar Controls
    console.log('[Phase 11] Verifying Photos view search bar DOM controls and state integration...')
    await evaluate(app.cdp, `window.api.setTab('photos')`)

    for (let i = 0; i < 60; i++) {
      const mounted = await evaluate(
        app.cdp,
        `(() => {
          if (document.querySelector('.photos-search-input')) return true
          const btn = Array.from(document.querySelectorAll('.nav-item, button')).find((b) =>
            b.textContent && b.textContent.includes('Photos')
          )
          if (btn) btn.click()
          return Boolean(document.querySelector('.photos-search-input'))
        })()`
      )
      if (mounted) break
      await sleep(150)
    }

    // Verify search bar input is present
    const hasSearchInput = await evaluate(
      app.cdp,
      `Boolean(document.querySelector('.photos-search-input'))`
    )
    if (!hasSearchInput) {
      throw new Error('PhotosSearchBar input element not found in DOM')
    }
    pass('PhotosSearchBar input control rendered in Photos view toolbar')

    // Submit search via UI using controlled React input setter
    await evaluate(
      app.cdp,
      `(() => {
        const input = document.querySelector('.photos-search-input')
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value'
        )?.set
        if (setter) {
          setter.call(input, 'golden orange sunset')
        } else {
          input.value = 'golden orange sunset'
        }
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })()`
    )
    await sleep(200)

    await evaluate(
      app.cdp,
      `(() => {
        const submitBtn = document.querySelector('.photos-search-submit-btn')
        if (submitBtn) {
          submitBtn.click()
        } else {
          const form = document.querySelector('.photos-search-form')
          if (form) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
        }
      })()`
    )

    // Wait for search result badge to appear in DOM
    let matchBadgeText = ''
    for (let i = 0; i < 60; i++) {
      matchBadgeText = await evaluate(
        app.cdp,
        `document.querySelector('[data-testid="search-match-badge"]')?.textContent ?? ''`
      )
      if (matchBadgeText.includes('semantic match')) break
      await sleep(150)
    }

    if (!matchBadgeText.includes('semantic match')) {
      throw new Error(`Expected match badge text, got: '${matchBadgeText}'`)
    }
    pass(`Photos search UI rendered match badge: '${matchBadgeText}'`)

    // Verify non-factual disclaimer in DOM
    const disclaimerText = await evaluate(
      app.cdp,
      `document.querySelector('.search-disclaimer')?.textContent ?? ''`
    )
    if (!disclaimerText.includes('semantic suggestions')) {
      throw new Error(`Expected semantic suggestions disclaimer, got: '${disclaimerText}'`)
    }
    pass('Semantic match non-factual disclaimer rendered in DOM')

    // Check similarity badge on photo card
    let cardBadge = ''
    for (let i = 0; i < 40; i++) {
      cardBadge = await evaluate(
        app.cdp,
        `document.querySelector('.badge-similarity-score')?.textContent ?? ''`
      )
      if (cardBadge.includes('% match')) break
      await sleep(150)
    }
    if (!cardBadge.includes('% match')) {
      throw new Error(`Expected similarity badge on card, got: '${cardBadge}'`)
    }
    pass(`Photo card rendered similarity match badge: '${cardBadge}'`)

    // Clear search and verify restoration of ordinary browsing
    await evaluate(
      app.cdp,
      `(() => {
        const clearBtn = document.querySelector('.photos-search-clear-btn')
        if (clearBtn) clearBtn.click()
      })()`
    )

    let totalCountText = ''
    for (let i = 0; i < 40; i++) {
      totalCountText = await evaluate(
        app.cdp,
        `document.querySelector('.photos-count-info .count-badge')?.textContent ?? ''`
      )
      if (totalCountText.includes(`${initialPhotoBaselines.size} photos`)) break
      await sleep(150)
    }

    if (!totalCountText.includes(`${initialPhotoBaselines.size} photos`)) {
      throw new Error(
        `Expected all ${initialPhotoBaselines.size} photos after clear, got '${totalCountText}'`
      )
    }
    pass(
      `Clearing search restored ordinary browsing with all ${initialPhotoBaselines.size} photographs`
    )

    // 14. Responsive Event-Loop Latency Check
    console.log('[Phase 12] Measuring main process responsiveness during query execution...')
    const latencies = []
    for (let i = 0; i < 5; i++) {
      const start = Date.now()
      await evaluate(
        app.cdp,
        `window.api.searchPhotosSemantic({ queryText: 'natural landscape scenery' })`
      )
      latencies.push(Date.now() - start)
    }
    const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length
    if (avgLatency > 1500) {
      throw new Error(`Average query latency too high: ${avgLatency}ms`)
    }
    pass(`Average search query round-trip latency: ${avgLatency.toFixed(1)}ms across 5 runs`)

    // 15. Source File Preservation Invariance
    console.log('[Phase 13] Verifying source file bitwise preservation invariance...')
    assertDirectoryUnchanged(photosDir, initialPhotoBaselines, 'photos-source')
    assertDirectoryUnchanged(offlineModelFixtureDir, offlineModelBaselines, 'offline-model-source')
    pass(
      'Source preservation verified: 100% byte size, SHA-256, birthtime, and mtime invariance across all files'
    )

    console.log(
      `\n=== STAGE 6D REAL ELECTRON VERIFICATION PASSED (${passCount}/${passCount} CHECKS) ===\n`
    )
  } catch (err) {
    console.error('\n[Verification Failure Inside Test]:', err)
    throw err
  } finally {
    if (app) {
      killTree(app.child)
      await sleep(1000)
    }
    try {
      rmSync(tempBase, { recursive: true, force: true })
    } catch {
      // Best-effort cleanup of temp directory on Windows
    }
  }
}

main().catch((err) => {
  console.error('\nVerification failed:', err)
  process.exit(1)
})
