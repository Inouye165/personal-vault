#!/usr/bin/env node
/**
 * Personal Vault — Real Electron Semantic Model Provisioning & Resumable Index Verification (Stage 6B)
 *
 * Exercises Stage 6B end-to-end across real Electron BrowserWindow, preload contextBridge,
 * Zod-validated IPC, SQLite Schema v9, worker-thread ONNX CPU vision inference, and React DOM controls
 * in both built and freshly packaged (unpacked) execution:
 *
 * 1. Packaged hygiene & native ONNX Runtime resolution from app.asar.unpacked (when --mode=unpacked).
 * 2. Deterministic download failure & redirect/digest rejection via local loopback HTTP fixture server.
 * 3. Explicit offline verified model folder import via DOM controls and strict source folder invariance.
 * 4. Realistic decodable photograph fixture scan (JPEG, PNG, WebP) + unsupported (.svg) + corrupt (.jpg)
 *    + live source revision modification before indexing.
 * 5. Active indexing start, progress, pause/resume, active cancellation, and honest partial coverage counts.
 * 6. Deterministic mid-job process kill (exit code 99), startup interrupted-job detection, new photo scan,
 *    and exact-scope resume (never silently adding newly discovered photos to the resumed job).
 * 7. Interactive virtual-grid browsing and perceptual similarity competition during active semantic indexing
 *    with measured rAF frame interval p95 (<= 33 ms), main event-loop delay p95 (< 100 ms), IPC round-trip
 *    latency (< 100 ms), worker/queue bounds (<= 2 live workers, <= 64 queue), DOM cell bounds (<= 200),
 *    sampled process-wide RSS vs worker-isolate heap, and bitwise source file preservation invariance.
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
  utimesSync,
  writeFileSync
} from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
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
      const data = JSON.parse(String(message.data))
      if (data.id && pending.has(data.id)) {
        const { ok, bad, timer } = pending.get(data.id)
        clearTimeout(timer)
        pending.delete(data.id)
        if (data.error) {
          bad(new Error(data.error.message || 'CDP Error'))
        } else {
          ok(data.result)
        }
      }
    }
    ws.onopen = () => {
      resolveCdp({
        send: (method, params = {}) =>
          new Promise((ok, bad) => {
            const id = nextId++
            const timer = setTimeout(() => {
              if (pending.delete(id)) {
                bad(
                  new Error(
                    `CDP timed out for method: ${method} (${JSON.stringify(params).slice(0, 140)})`
                  )
                )
              }
            }, 30000)
            pending.set(id, { ok, bad, timer })
            ws.send(JSON.stringify({ id, method, params }))
          }),
        close: () => {
          for (const entry of pending.values()) {
            clearTimeout(entry.timer)
            entry.bad(new Error('CDP connection closed'))
          }
          pending.clear()
          try {
            ws.close()
          } catch {
            // ignore
          }
        }
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

const unpackedLaunchCwds = []

async function launchApp(userDataDir, port, extraEnv = {}) {
  const commonArgs = [`--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`]
  const env = { ...process.env, ...extraEnv }
  let child
  if (mode === 'unpacked') {
    const exePath = join(rootDir, 'dist', 'win-unpacked', 'Personal Vault.exe')
    if (!existsSync(exePath)) {
      throw new Error(`Unpacked binary not found at ${exePath}. Run npm run build:unpack first.`)
    }
    const launchCwd = mkdtempSync(join(tmpdir(), 'pv-semindex-unpacked-cwd-'))
    unpackedLaunchCwds.push(launchCwd)
    child = spawn(exePath, commonArgs, {
      cwd: launchCwd,
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

async function openPhotosAndSemanticPanel(cdp) {
  await evaluate(cdp, `window.api.setTab('photos')`)

  for (let i = 0; i < 60; i++) {
    const hasToggle = await evaluate(
      cdp,
      `(() => {
        if (document.querySelector('[data-testid="photos-toggle-semantic-index"]')) return true
        const btn = Array.from(document.querySelectorAll('.nav-item')).find((b) =>
          b.textContent && b.textContent.includes('Photos')
        )
        if (btn) btn.click()
        return Boolean(document.querySelector('[data-testid="photos-toggle-semantic-index"]'))
      })()`
    )
    if (hasToggle) break
    await sleep(150)
  }

  for (let i = 0; i < 60; i++) {
    const hasPanel = await evaluate(
      cdp,
      `(() => {
        const panel = document.querySelector('[data-testid="semantic-index-panel"]')
        if (panel) return true
        const toggle = document.querySelector('[data-testid="photos-toggle-semantic-index"]')
        if (toggle) toggle.click()
        return Boolean(document.querySelector('[data-testid="semantic-index-panel"]'))
      })()`
    )
    if (hasPanel) return
    await sleep(150)
  }
  throw new Error('SemanticIndexPanel failed to mount in DOM')
}

async function runScanAndWait(cdp, roots) {
  const res = await evaluate(cdp, `window.api.startScan({ roots: ${JSON.stringify(roots)} })`)
  if (!res?.success) {
    throw new Error(`startScan failed: ${JSON.stringify(res)}`)
  }
  const jobId = res.job.jobId
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

async function main() {
  console.log(
    `\n=== Personal Vault: Stage 6B Semantic Model & Resumable Index Verification (${mode.toUpperCase()} mode) ===\n`
  )

  let passCount = 0
  function pass(msg) {
    passCount++
    console.log(`  [PASS ${passCount}] ${msg}`)
  }

  // 1. In unpacked mode, verify packaged bundle hygiene & native ONNX Runtime resolution
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
    const noticesInResources =
      existsSync(join(unpackedRoot, 'resources', 'app.asar')) &&
      !existsSync(join(unpackedRoot, 'resources', 'app.asar.unpacked', 'spikes'))
    if (!noticesInResources) {
      throw new Error('Packaged bundle hygiene check failed (unexpected spikes directory)')
    }
    pass(
      'Packaged app.asar.unpacked contains native onnxruntime_binding.node and excludes spikes/ directory'
    )
  }

  // Locate pinned local model artifacts from Stage 6A evaluation cache to create an isolated read-only import fixture
  const cachedModelSource = join(
    rootDir,
    'spikes',
    'semantic-eval',
    '.model-cache',
    'Xenova--clip-vit-base-patch32'
  )
  if (!existsSync(join(cachedModelSource, 'onnx', 'vision_model_quantized.onnx'))) {
    throw new Error(
      `Local verified model fixture not found at ${cachedModelSource}. Cannot run offline model import verification.`
    )
  }

  const tempBase = mkdtempSync(join(tmpdir(), 'pv-verify-semantic-6b-'))
  const userDataDir = join(tempBase, 'user-data')
  const offlineModelFixtureDir = join(tempBase, 'offline-model-source')
  const photosDir = join(tempBase, 'photos-primary')
  const extraPhotosDir = join(tempBase, 'photos-late-addition')

  mkdirSync(userDataDir, { recursive: true })
  mkdirSync(join(offlineModelFixtureDir, 'onnx'), { recursive: true })
  mkdirSync(photosDir, { recursive: true })
  mkdirSync(extraPhotosDir, { recursive: true })

  // Copy model artifacts into isolated offline import fixture directory so we can verify source invariance
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

  // Local HTTP fixture server for deterministic download failure tests
  let httpMode = 'corrupt-digest'
  const httpServer = createHttpServer((req, res) => {
    if (httpMode === 'disallowed-redirect') {
      res.writeHead(302, { Location: 'https://evil-untrusted-host.example.com/model.onnx' })
      res.end()
      return
    }
    // Return corrupt payload with wrong digest for config.json (exact length 4524 bytes)
    const badPayload = Buffer.from(
      '{"corrupt":true,"padding":"' + 'x'.repeat(4500) + '"}',
      'utf-8'
    ).subarray(0, 4524)
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': String(badPayload.byteLength)
    })
    res.end(badPayload)
  })

  await new Promise((resolveListen) => httpServer.listen(0, '127.0.0.1', resolveListen))
  const httpPort = httpServer.address().port
  const localDownloadBaseUrl = `http://127.0.0.1:${httpPort}/Xenova/clip-vit-base-patch32/resolve/main`

  let currentApp = null

  try {
    // 2. Generate realistic decodable image fixtures (JPEG, PNG, WebP) + unsupported (.svg) + corrupt (.jpg)
    console.log('[Phase 1] Generating decodable photograph fixtures...')
    const createdPhotoPaths = []
    for (let i = 1; i <= 18; i++) {
      const r = (i * 37) % 255
      const g = (i * 73) % 255
      const b = (i * 119) % 255
      const ext = i % 3 === 0 ? 'png' : i % 5 === 0 ? 'webp' : 'jpg'
      const fileName = `photo_${String(i).padStart(3, '0')}.${ext}`
      const fullPath = join(photosDir, fileName)
      let pipeline = sharp({
        create: {
          width: 320 + (i % 4) * 40,
          height: 240 + (i % 3) * 40,
          channels: 3,
          background: { r, g, b }
        }
      })
      if (ext === 'png') pipeline = pipeline.png()
      else if (ext === 'webp') pipeline = pipeline.webp({ quality: 85 })
      else pipeline = pipeline.jpeg({ quality: 88 })

      const buf = await pipeline.toBuffer()
      writeFileSync(fullPath, buf)
      createdPhotoPaths.push(fullPath)
    }

    // Exact duplicate content photo (named zz_ so it sorts after photo_001.jpg and is still pending when Phase 5 starts)
    const dupSourceBuf = readFileSync(createdPhotoPaths[0])
    const dupPath = join(photosDir, 'zz_photo_001_exact_duplicate.jpg')
    writeFileSync(dupPath, dupSourceBuf)
    createdPhotoPaths.push(dupPath)

    // Unsupported Apple HEIC file (cataloged as photo by discovery policy, classified as unsupported by decoder)
    const unsupportedPath = join(photosDir, 'iphone_unsupported.heic')
    writeFileSync(unsupportedPath, Buffer.from('FAKE_APPLE_HEIC_IMAGE_PAYLOAD'))

    // Corrupt JPEG file
    const corruptPath = join(photosDir, 'corrupt_image.jpg')
    writeFileSync(corruptPath, Buffer.from('CORRUPT_JPEG_BINARY_STREAM_INVALID'))

    // Photo that will be modified on disk AFTER scan to verify live source revision rejection
    const mutablePhotoPath = join(photosDir, 'photo_mutable_revision.jpg')
    const mutableInitialBuf = await sharp({
      create: { width: 300, height: 300, channels: 3, background: { r: 200, g: 50, b: 50 } }
    })
      .jpeg()
      .toBuffer()
    writeFileSync(mutablePhotoPath, mutableInitialBuf)

    // Snapshot immutable source files (all except mutablePhotoPath which we intentionally mutate in Phase 3)
    const immutableSourceDirBaseline = new Map()
    for (const p of [...createdPhotoPaths, unsupportedPath, corruptPath]) {
      const st = statSync(p)
      const buf = readFileSync(p)
      immutableSourceDirBaseline.set(p, {
        size: st.size,
        birthtimeMs: st.birthtimeMs,
        mtimeMs: st.mtimeMs,
        sha: createHash('sha256').update(buf).digest('hex')
      })
    }

    // 3. Launch Electron with local loopback HTTP server to verify deterministic download failure & redirect rejection
    console.log(
      '[Phase 2] Verifying model status, ~149 MiB disclosure, and download failure handling...'
    )
    const port1 = await getFreePort()
    currentApp = await launchApp(userDataDir, port1, {
      PV_ALLOW_LOOPBACK_MODEL_URL: '1',
      PV_SEMANTIC_DOWNLOAD_BASE_URL: localDownloadBaseUrl,
      PV_TEST_MODEL_IMPORT_DIR: offlineModelFixtureDir,
      PV_SEMANTIC_ITEM_DELAY_MS: '60'
    })
    let cdp = currentApp.cdp

    await runScanAndWait(cdp, [photosDir])
    await openPhotosAndSemanticPanel(cdp)

    // Verify initial state is missing, ~149 MiB is displayed, and no auto-download occurred
    const initialDomCheck = await evaluate(
      cdp,
      `(() => {
        const badge = document.querySelector('[data-testid="semantic-model-state-badge"]')?.textContent ?? ''
        const cardText = document.querySelector('[data-testid="semantic-model-card"]')?.textContent ?? ''
        const noteText = document.querySelector('[data-testid="semantic-scope-note"]')?.textContent ?? ''
        return { badge, cardText, noteText }
      })()`
    )
    if (!initialDomCheck.badge.includes('MISSING')) {
      throw new Error(`Expected initial model badge MISSING, got: ${initialDomCheck.badge}`)
    }
    if (
      !initialDomCheck.cardText.includes('149 MiB') &&
      !initialDomCheck.cardText.includes('148.6 MiB')
    ) {
      throw new Error(
        `Expected ~149 MiB requirement in model card, got: ${initialDomCheck.cardText}`
      )
    }
    if (
      !initialDomCheck.noteText.includes('offline semantic search') ||
      !initialDomCheck.noteText.includes('not factual labels')
    ) {
      throw new Error(
        `Expected scope & non-factual explanation in panel, got: ${initialDomCheck.noteText}`
      )
    }
    pass(
      'Initial UI shows MISSING state, ~149 MiB requirement, and honest Stage 6D scope without auto-downloading'
    )

    // Click Download button against local fixture server returning corrupt digest
    httpMode = 'corrupt-digest'
    await evaluate(
      cdp,
      `document.querySelector('[data-testid="semantic-model-download-btn"]').click()`
    )

    let downloadFailedState = null
    for (let i = 0; i < 40; i++) {
      const st = await evaluate(cdp, `window.api.getSemanticModelStatus()`)
      if (st.state === 'error') {
        downloadFailedState = st
        break
      }
      await sleep(150)
    }
    if (!downloadFailedState || !/SHA-256.*mismatch/i.test(downloadFailedState.error ?? '')) {
      throw new Error(
        `Expected SHA-256 mismatch error state from corrupt download, got: ${JSON.stringify(downloadFailedState)}`
      )
    }

    // Test disallowed redirect host rejection via local HTTP server
    httpMode = 'disallowed-redirect'
    await evaluate(
      cdp,
      `document.querySelector('[data-testid="semantic-model-download-btn"]').click()`
    )
    let redirectFailedState = null
    for (let i = 0; i < 40; i++) {
      const st = await evaluate(cdp, `window.api.getSemanticModelStatus()`)
      if (st.state === 'error' && /Disallowed download host/i.test(st.error ?? '')) {
        redirectFailedState = st
        break
      }
      await sleep(150)
    }
    if (!redirectFailedState) {
      throw new Error('Expected disallowed redirect host rejection from local HTTP fixture server')
    }
    pass(
      'Download provisioning deterministically rejects corrupt SHA-256 digests and untrusted redirect hosts'
    )

    // 4. Import verified offline model folder via DOM button and verify source folder invariance
    console.log('[Phase 3] Importing verified offline model folder via DOM control...')
    await evaluate(
      cdp,
      `document.querySelector('[data-testid="semantic-model-import-btn"]').click()`
    )

    let modelReadyStatus = null
    for (let i = 0; i < 80; i++) {
      const st = await evaluate(cdp, `window.api.getSemanticModelStatus()`)
      if (st.state === 'ready') {
        modelReadyStatus = st
        break
      }
      if (st.state === 'error') {
        throw new Error(`Offline model import failed: ${st.error}`)
      }
      await sleep(200)
    }
    if (!modelReadyStatus) {
      throw new Error('Timed out waiting for offline model import to reach ready state')
    }
    assertDirectoryUnchanged(
      offlineModelFixtureDir,
      offlineModelBaselines,
      'Offline Model Import Source Folder'
    )
    pass(
      'Offline model folder imported into app-managed storage, verified off-main, and left selected source folder 100% untouched'
    )

    // 5. Modify mutablePhotoPath on disk BEFORE starting indexing so its live revision differs from catalog snapshot
    console.log(
      '[Phase 4] Exercising indexing start, pause/resume, active cancel, and completion...'
    )
    const mutatedBuf = await sharp({
      create: { width: 320, height: 320, channels: 3, background: { r: 10, g: 220, b: 90 } }
    })
      .jpeg({ quality: 95 })
      .toBuffer()
    writeFileSync(mutablePhotoPath, mutatedBuf)
    const futureDate = new Date(Date.now() + 60_000)
    utimesSync(mutablePhotoPath, futureDate, futureDate)

    // Start indexing via DOM button
    await evaluate(
      cdp,
      `document.querySelector('[data-testid="semantic-index-start-btn"]').click()`
    )

    // Wait until at least 1 photo is processed, then click Pause via DOM
    for (let i = 0; i < 80; i++) {
      const p = await evaluate(cdp, `window.api.getSemanticIndexProgress()`)
      if (p.status === 'running' && p.processedPhotos >= 1) {
        break
      }
      await sleep(100)
    }

    await evaluate(
      cdp,
      `(() => {
        const btn = document.querySelector('[data-testid="semantic-index-pause-btn"]')
        if (btn) btn.click()
      })()`
    )

    let pausedProg = null
    for (let i = 0; i < 60; i++) {
      const p = await evaluate(cdp, `window.api.getSemanticIndexProgress()`)
      if (p.status === 'paused') {
        pausedProg = p
        break
      }
      await sleep(100)
    }
    if (!pausedProg) {
      throw new Error('Indexing job did not transition to paused state')
    }

    // Resume via DOM button
    await evaluate(
      cdp,
      `document.querySelector('[data-testid="semantic-index-resume-btn"]').click()`
    )
    for (let i = 0; i < 40; i++) {
      const p = await evaluate(cdp, `window.api.getSemanticIndexProgress()`)
      if (p.status === 'running') break
      await sleep(100)
    }

    // Cancel active job via DOM button
    await evaluate(
      cdp,
      `document.querySelector('[data-testid="semantic-index-cancel-btn"]').click()`
    )
    let cancelledProg = null
    for (let i = 0; i < 60; i++) {
      const p = await evaluate(cdp, `window.api.getSemanticIndexProgress()`)
      if (p.status === 'cancelled') {
        cancelledProg = p
        break
      }
      await sleep(100)
    }
    if (!cancelledProg) {
      throw new Error('Indexing job did not transition to cancelled state')
    }
    pass('Indexing start, pause, resume, and active cancellation verified via DOM controls')

    // Now start a fresh indexing job and scroll the virtualized photo grid + trigger similarity while indexing runs!
    console.log(
      '[Phase 5] Competing interactive browsing & perceptual similarity during active semantic indexing...'
    )
    await evaluate(
      cdp,
      `(() => {
        window.__frameTimes = []
        window.__recording = true
        let last = performance.now()
        function loop(now) {
          window.__frameTimes.push(now - last)
          last = now
          if (window.__recording) requestAnimationFrame(loop)
        }
        requestAnimationFrame(loop)
      })()`
    )

    await evaluate(
      cdp,
      `document.querySelector('[data-testid="semantic-index-start-btn"]').click()`
    )

    // Also start perceptual similarity analysis concurrently (non-blocking) to compete for the shared worker pool
    await evaluate(cdp, `(window.api.startSimilarityAnalysis().catch(() => {}), true)`)

    const ipcLatencies = []
    let peakLiveWorkers = 0
    let peakActiveWorkers = 0
    let peakTerminatingWorkers = 0
    let peakActiveSemanticTasks = 0
    let peakLoadedModelWorkers = 0
    let peakQueuedJobs = 0
    let peakMountedCells = 0
    let peakMainEventLoopP95 = 0
    let peakMainProcessRssBytes = 0
    let peakWorkerIsolateHeapBytes = 0
    let peakRendererJsHeapBytes = 0

    let finalProgress = null
    for (let step = 0; step < 200; step++) {
      // Scroll grid container back and forth
      const scrollPos = (step % 6) * 180
      await evaluate(
        cdp,
        `(() => {
          const el = document.querySelector('.photos-grid-container')
          if (el) { el.scrollTop = ${scrollPos}; el.dispatchEvent(new Event('scroll')) }
        })()`
      )

      // Measure IPC round-trip latency
      const t0 = performance.now()
      await evaluate(cdp, `window.api.getAppInfo()`)
      ipcLatencies.push(performance.now() - t0)

      // Sample diagnostics
      const diag = await evaluate(cdp, `window.api.getPhotosDiagnostics()`)
      if (diag) {
        peakLiveWorkers = Math.max(peakLiveWorkers, diag.liveWorkers ?? diag.activeWorkers)
        peakActiveWorkers = Math.max(peakActiveWorkers, diag.activeWorkers)
        peakTerminatingWorkers = Math.max(peakTerminatingWorkers, diag.terminatingWorkers ?? 0)
        peakActiveSemanticTasks = Math.max(peakActiveSemanticTasks, diag.activeSemanticTasks ?? 0)
        peakLoadedModelWorkers = Math.max(
          peakLoadedModelWorkers,
          diag.semanticModelLoadedWorkers ?? 0
        )
        peakQueuedJobs = Math.max(peakQueuedJobs, diag.queuedJobs)
        if (typeof diag.mainEventLoopDelayP95Ms === 'number') {
          peakMainEventLoopP95 = Math.max(peakMainEventLoopP95, diag.mainEventLoopDelayP95Ms)
        }
        if (typeof diag.mainProcessRssBytes === 'number') {
          peakMainProcessRssBytes = Math.max(peakMainProcessRssBytes, diag.mainProcessRssBytes)
        }
        if (typeof diag.workerIsolatePeakHeapUsedBytes === 'number') {
          peakWorkerIsolateHeapBytes = Math.max(
            peakWorkerIsolateHeapBytes,
            diag.workerIsolatePeakHeapUsedBytes
          )
        }
      }

      const domStats = await evaluate(
        cdp,
        `({
          mounted: document.querySelectorAll('.photo-cell').length,
          heap: window.performance?.memory?.usedJSHeapSize ?? 0
        })`
      )
      peakMountedCells = Math.max(peakMountedCells, domStats.mounted)
      peakRendererJsHeapBytes = Math.max(peakRendererJsHeapBytes, domStats.heap)

      const prog = await evaluate(cdp, `window.api.getSemanticIndexProgress()`)
      if (prog.status === 'completed' || prog.status === 'failed') {
        finalProgress = prog
        break
      }
      await sleep(120)
    }

    await evaluate(cdp, `window.__recording = false`)
    const rawFrameTimes = await evaluate(cdp, `window.__frameTimes`)

    if (!finalProgress || finalProgress.status !== 'completed') {
      throw new Error(`Expected indexing job to complete, got: ${JSON.stringify(finalProgress)}`)
    }

    // Verify exact honest counts:
    // Total catalog photos = 19 decodable + 1 unsupported SVG + 1 corrupt JPG + 1 mutated revision = 22 photos
    // Already indexed before this job (during Phase 4 before cancel) remain current and are not re-queued,
    // or are counted in currentIndexedPhotos.
    // Specifically: currentIndexedPhotos must be 19 (all 19 valid decodable photos),
    // unsupportedPhotos = 1 (diagram_unsupported.svg),
    // failedPhotos = 2 (corrupt_image.jpg + photo_mutable_revision.jpg whose revision changed after scan),
    // reusedPhotos >= 1 (photo_001_exact_duplicate.jpg reused verified embedding from photo_001.jpg).
    if (finalProgress.currentIndexedPhotos !== 19) {
      throw new Error(
        `Expected currentIndexedPhotos === 19, got ${finalProgress.currentIndexedPhotos} (${JSON.stringify(finalProgress)})`
      )
    }
    if (finalProgress.unsupportedPhotos !== 1) {
      throw new Error(`Expected unsupportedPhotos === 1, got ${finalProgress.unsupportedPhotos}`)
    }
    if (finalProgress.failedPhotos !== 2) {
      throw new Error(
        `Expected failedPhotos === 2 (1 corrupt + 1 mutated source revision), got ${finalProgress.failedPhotos}`
      )
    }
    if (finalProgress.reusedPhotos < 1) {
      throw new Error(
        `Expected at least 1 reused embedding for identical verified content, got ${finalProgress.reusedPhotos}`
      )
    }

    // Verify DOM partial-coverage banner is honest (does not claim every photo was indexed)
    const summaryText = await evaluate(
      cdp,
      `document.querySelector('[data-testid="semantic-index-summary"]')?.textContent ?? ''`
    )
    if (!summaryText.includes('Completed with partial coverage')) {
      throw new Error(
        `Expected honest partial coverage notice when unsupported/failed items exist, got: ${summaryText}`
      )
    }

    // Verify paginated job items query works without loading full index
    const failedItemsPage = await evaluate(
      cdp,
      `window.api.getSemanticIndexJobItems({ jobId: ${JSON.stringify(finalProgress.jobId)}, status: 'failed', page: 1, pageSize: 10 })`
    )
    if (failedItemsPage.totalCount !== 2 || failedItemsPage.items.length !== 2) {
      throw new Error(
        `Expected 2 paginated failed job items, got: ${JSON.stringify(failedItemsPage)}`
      )
    }
    pass(
      `Completed job reports honest partial coverage (19/22 indexed, ${finalProgress.reusedPhotos} reused, 1 unsupported, 2 failed) and rejects mutated source revision`
    )

    // Evaluate responsiveness & resource bounds during indexing + browsing + similarity competition
    const frameTimes = (Array.isArray(rawFrameTimes) ? rawFrameTimes : [])
      .filter((t) => typeof t === 'number' && t > 0)
      .sort((a, b) => a - b)
    const frameP95 = frameTimes[Math.floor(frameTimes.length * 0.95)] ?? 0
    const frameMax = frameTimes[frameTimes.length - 1] ?? 0

    ipcLatencies.sort((a, b) => a - b)
    const ipcP95 = ipcLatencies[Math.floor(ipcLatencies.length * 0.95)] ?? 0
    const ipcMax = ipcLatencies[ipcLatencies.length - 1] ?? 0

    console.log('\n================ Stage 6B Resource & Responsiveness Evidence ================')
    console.log(`  Execution mode: ${mode}`)
    console.log(`  Frame intervals sampled: ${frameTimes.length}`)
    console.log(
      `  Frame interval p95: ${frameP95.toFixed(2)} ms (bound <= 33 ms), max: ${frameMax.toFixed(2)} ms`
    )
    console.log(
      `  Main event-loop delay p95: ${peakMainEventLoopP95.toFixed(2)} ms (bound < 100 ms)`
    )
    console.log(
      `  IPC round-trip latency p95: ${ipcP95.toFixed(2)} ms (bound < 100 ms), max: ${ipcMax.toFixed(2)} ms`
    )
    console.log(
      `  Worker bounds: peakLiveWorkers=${peakLiveWorkers} (bound <= 2), peakActiveWorkers=${peakActiveWorkers}, peakTerminating=${peakTerminatingWorkers}`
    )
    console.log(
      `  Semantic session bounds: peakActiveSemanticTasks=${peakActiveSemanticTasks} (bound <= 1), peakLoadedModelWorkers=${peakLoadedModelWorkers} (bound <= 1)`
    )
    console.log(
      `  Queue & DOM bounds: peakQueuedJobs=${peakQueuedJobs} (bound <= 64), peakMountedCells=${peakMountedCells} (bound <= 200)`
    )
    console.log(
      `  Sampled memory maxima (sampled periodic maxima, distinct from continuous OS watermark):`
    )
    console.log(
      `    Main process RSS max sampled: ${(peakMainProcessRssBytes / (1024 * 1024)).toFixed(2)} MiB`
    )
    console.log(
      `    Worker isolate JS heap max sampled: ${(peakWorkerIsolateHeapBytes / (1024 * 1024)).toFixed(2)} MiB`
    )
    console.log(
      `    Renderer JS heap max sampled: ${(peakRendererJsHeapBytes / (1024 * 1024)).toFixed(2)} MiB`
    )
    console.log('=============================================================================\n')

    if (frameP95 > 33) {
      throw new Error(`Frame interval p95 (${frameP95.toFixed(2)} ms) exceeded 33 ms bound`)
    }
    if (peakMainEventLoopP95 >= 100) {
      throw new Error(
        `Main event-loop delay p95 (${peakMainEventLoopP95.toFixed(2)} ms) exceeded 100 ms bound`
      )
    }
    if (ipcP95 >= 100) {
      throw new Error(`IPC round-trip p95 (${ipcP95.toFixed(2)} ms) exceeded 100 ms bound`)
    }
    if (peakLiveWorkers > 2) {
      throw new Error(`Peak live workers (${peakLiveWorkers}) exceeded bound of 2`)
    }
    if (peakActiveSemanticTasks > 1) {
      throw new Error(`Peak active semantic tasks (${peakActiveSemanticTasks}) exceeded bound of 1`)
    }
    if (peakLoadedModelWorkers > 1) {
      throw new Error(
        `Peak loaded semantic model sessions (${peakLoadedModelWorkers}) exceeded bound of 1`
      )
    }
    if (peakQueuedJobs > 64) {
      throw new Error(`Peak queued jobs (${peakQueuedJobs}) exceeded bound of 64`)
    }
    if (peakMountedCells > 200) {
      throw new Error(`Peak mounted DOM cells (${peakMountedCells}) exceeded bound of 200`)
    }
    pass(
      'Browsing and perceptual similarity competition during semantic indexing met all frame, event-loop, IPC, worker, session, queue, and DOM bounds'
    )

    // 6. Close app and relaunch with PV_SEMANTIC_CRASH_AFTER_PROCESSED=2 on a newly scanned batch to test deterministic mid-job process kill & exact-scope resume
    console.log('[Phase 6] Testing deterministic mid-job process kill and exact-scope resume...')
    cdp.close()
    killTree(currentApp.child)
    currentApp = null
    await sleep(500)

    // Create 5 new unique photos in extraPhotosDir (plus 2 more added AFTER the crash)
    const batch1Dir = join(extraPhotosDir, 'batch1')
    const batch2Dir = join(extraPhotosDir, 'batch2')
    mkdirSync(batch1Dir, { recursive: true })
    mkdirSync(batch2Dir, { recursive: true })

    for (let i = 1; i <= 5; i++) {
      const buf = await sharp({
        create: {
          width: 260 + i * 10,
          height: 260 + i * 10,
          channels: 3,
          background: { r: 10 + i * 20, g: 180 - i * 15, b: 90 + i * 10 }
        }
      })
        .jpeg({ quality: 92 })
        .toBuffer()
      writeFileSync(join(batch1Dir, `crash_batch1_${i}.jpg`), buf)
    }

    for (let i = 1; i <= 2; i++) {
      const buf = await sharp({
        create: {
          width: 290 + i * 10,
          height: 290 + i * 10,
          channels: 3,
          background: { r: 220, g: 40 * i, b: 160 }
        }
      })
        .jpeg({ quality: 92 })
        .toBuffer()
      writeFileSync(join(batch2Dir, `post_crash_new_${i}.jpg`), buf)
    }

    const port2 = await getFreePort()
    currentApp = await launchApp(userDataDir, port2, {
      PV_SEMANTIC_CRASH_AFTER_PROCESSED: '2',
      PV_SEMANTIC_ITEM_DELAY_MS: '50'
    })
    cdp = currentApp.cdp

    // Verify persisted vectors & coverage survived restart (19/22 indexed)
    const persistedAfterRestart = await evaluate(cdp, `window.api.getSemanticIndexProgress()`)
    if (persistedAfterRestart.currentIndexedPhotos !== 19) {
      throw new Error(
        `Expected 19 persisted vectors after restart, got ${persistedAfterRestart.currentIndexedPhotos}`
      )
    }
    pass('Persisted embeddings and coverage (19 photos) verified intact after restart')

    // Scan batch1Dir (5 new photos -> 27 total catalog photos)
    await runScanAndWait(cdp, [batch1Dir])
    await openPhotosAndSemanticPanel(cdp)

    const exitPromise = new Promise((resolveExit) => {
      currentApp.child.once('exit', (code) => resolveExit(code))
    })

    // Start indexing via DOM button; process will deterministically exit(99) after 2 photos are committed
    await evaluate(
      cdp,
      `document.querySelector('[data-testid="semantic-index-start-btn"]').click()`
    )

    const crashExitCode = await Promise.race([exitPromise, sleep(20000).then(() => 'timeout')])
    if (crashExitCode !== 99) {
      throw new Error(`Expected deterministic mid-job exit code 99, got: ${crashExitCode}`)
    }
    currentApp = null
    await sleep(400)
    pass(
      'Deterministic mid-job process kill (exit code 99) triggered after committing 2 embeddings'
    )

    // Relaunch after crash (without PV_SEMANTIC_CRASH_AFTER_PROCESSED)
    const port3 = await getFreePort()
    currentApp = await launchApp(userDataDir, port3)
    cdp = currentApp.cdp

    await openPhotosAndSemanticPanel(cdp)
    const interruptedProg = await evaluate(cdp, `window.api.getSemanticIndexProgress()`)
    if (interruptedProg.status !== 'interrupted') {
      throw new Error(
        `Expected startup to identify interrupted job, got status: ${interruptedProg.status}`
      )
    }
    if (interruptedProg.processedPhotos !== 2) {
      throw new Error(
        `Expected exactly 2 committed photos before crash, got: ${interruptedProg.processedPhotos}`
      )
    }
    const snapshottedTotalBeforeResume = interruptedProg.totalPhotos

    // Now scan batch2Dir (2 brand-new photos) BEFORE clicking Resume
    await runScanAndWait(cdp, [batch2Dir])

    // Click Resume via DOM button (#semantic-index-resume-btn)
    await evaluate(
      cdp,
      `document.querySelector('[data-testid="semantic-index-resume-btn"]').click()`
    )

    let resumedFinal = null
    for (let i = 0; i < 120; i++) {
      const p = await evaluate(cdp, `window.api.getSemanticIndexProgress()`)
      if (p.status === 'completed' || p.status === 'failed') {
        resumedFinal = p
        break
      }
      await sleep(150)
    }
    if (!resumedFinal || resumedFinal.status !== 'completed') {
      throw new Error(`Expected resumed job to complete, got: ${JSON.stringify(resumedFinal)}`)
    }
    if (resumedFinal.totalPhotos !== snapshottedTotalBeforeResume) {
      throw new Error(
        `Resumed job altered authorized scope! Expected ${snapshottedTotalBeforeResume}, got ${resumedFinal.totalPhotos}`
      )
    }
    // 19 previously indexed + 5 from batch1Dir = 24 indexed; the 2 from batch2Dir were NOT silently included in the resumed job!
    if (resumedFinal.currentIndexedPhotos !== 24 || resumedFinal.totalCatalogPhotos !== 29) {
      throw new Error(
        `Expected 24/29 indexed after exact-scope resume (excluding 2 newly scanned batch2 photos), got ${resumedFinal.currentIndexedPhotos}/${resumedFinal.totalCatalogPhotos}`
      )
    }
    pass(
      'Startup identified interrupted job and resumed exact snapshotted scope (24/29 indexed; 2 newly scanned photos excluded until next explicit job)'
    )

    // 7. Verify strict source file preservation invariance across all non-mutated source photos
    assertDirectoryUnchanged(
      offlineModelFixtureDir,
      offlineModelBaselines,
      'Final Offline Model Source Invariance'
    )
    for (const [filePath, base] of immutableSourceDirBaseline.entries()) {
      const st = statSync(filePath)
      const buf = readFileSync(filePath)
      const sha = createHash('sha256').update(buf).digest('hex')
      if (
        st.size !== base.size ||
        sha !== base.sha ||
        Math.abs(st.mtimeMs - base.mtimeMs) > 0.5 ||
        Math.abs(st.birthtimeMs - base.birthtimeMs) > 0.5
      ) {
        throw new Error(`Source file preservation violated for ${filePath}`)
      }
    }
    pass(
      'Source preservation invariance confirmed: original bytes, byte sizes, creation timestamps (birthtimeMs), and modification timestamps (mtimeMs) unchanged'
    )

    for (const dir of unpackedLaunchCwds) {
      const leftover = existsSync(dir) ? readdirSync(dir) : []
      if (leftover.length > 0) {
        throw new Error(`Unpacked launch wrote into cwd (${dir}): ${leftover.join(', ')}`)
      }
    }
    if (mode === 'unpacked') {
      pass('Unpacked binary launched from neutral cwd with zero launch-directory writes')
    }

    console.log(
      `\n>>> ALL ${passCount} REAL-ELECTRON STAGE 6B SEMANTIC INDEX CHECKS PASSED (${mode.toUpperCase()}) <<<\n`
    )
  } finally {
    if (currentApp) {
      try {
        currentApp.cdp.close()
      } catch {
        // ignore
      }
      killTree(currentApp.child)
    }
    try {
      httpServer.close()
    } catch {
      // ignore
    }
    for (const dir of unpackedLaunchCwds) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }
    try {
      rmSync(tempBase, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
}

main().catch((err) => {
  console.error('\nStage 6B Real-Electron Verification Failed:', err)
  process.exit(1)
})
