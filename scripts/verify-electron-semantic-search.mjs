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
import { DatabaseSync } from 'node:sqlite'
import {
  assertSearchPerformanceAndResourceBounds,
  assertConcurrentWorkloadOverlap,
  assertLruEvictionAndReload
} from './verify-semantic-search-bounds.mjs'
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

const unpackedLaunchCwds = []

async function launchApp(userDataDir, port, extraEnv = {}) {
  const commonArgs = [`--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`]
  const env = { ...process.env, ...extraEnv }
  let child
  if (mode === 'unpacked') {
    const unpackedRoot = process.env.PV_UNPACKED_DIR || join(rootDir, 'dist', 'win-unpacked')
    const exePath = join(unpackedRoot, 'Personal Vault.exe')
    if (!existsSync(exePath)) {
      throw new Error(`Unpacked binary not found at ${exePath}. Run npm run build:unpack first.`)
    }
    const launchCwd = mkdtempSync(join(tmpdir(), 'pv-search-unpacked-cwd-'))
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
          atimeMs: st.atimeMs,
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
  let atimeUpdatedCount = 0
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
    if (Math.abs(cur.atimeMs - base.atimeMs) > 0.5) {
      atimeUpdatedCount++
    }
  }
  return { totalFiles: baselineMap.size, atimeUpdatedCount }
}

const EXIF_TAG = {
  Make: 0x010f,
  Model: 0x0110,
  ExifIFDPointer: 0x8769,
  DateTimeOriginal: 0x9003,
  OffsetTimeOriginal: 0x9011,
  LensModel: 0xa434
}

function injectJpegApp1Exif(jpegBuf, { ifd0Tags = [], exifTags = [] }) {
  const hasExif = exifTags.length > 0
  const sortedIfd0 = [
    ...ifd0Tags,
    ...(hasExif ? [{ tagId: EXIF_TAG.ExifIFDPointer, type: 'long', value: 0 }] : [])
  ].sort((a, b) => a.tagId - b.tagId)
  const sortedExif = [...exifTags].sort((a, b) => a.tagId - b.tagId)

  const ifd0Offset = 8
  const ifd0Len = 2 + sortedIfd0.length * 12 + 4
  const exifOffset = hasExif ? ifd0Offset + ifd0Len : 0
  const exifLen = hasExif ? 2 + sortedExif.length * 12 + 4 : 0
  let heapCursor = ifd0Offset + ifd0Len + exifLen
  const heapChunks = []

  const encodeDir = (entries, ptrOverride) => {
    const dir = Buffer.alloc(2 + entries.length * 12 + 4)
    dir.writeUInt16LE(entries.length, 0)
    entries.forEach((e, idx) => {
      const off = 2 + idx * 12
      dir.writeUInt16LE(e.tagId, off)
      if (e.type === 'long') {
        const val =
          e.tagId === EXIF_TAG.ExifIFDPointer && ptrOverride !== undefined
            ? ptrOverride
            : Number(e.value)
        dir.writeUInt16LE(4, off + 2)
        dir.writeUInt32LE(1, off + 4)
        dir.writeUInt32LE(val >>> 0, off + 8)
      } else {
        const strBytes = Buffer.from(`${String(e.value)}\0`, 'latin1')
        dir.writeUInt16LE(2, off + 2)
        dir.writeUInt32LE(strBytes.length, off + 4)
        if (strBytes.length <= 4) {
          strBytes.copy(dir, off + 8)
        } else {
          dir.writeUInt32LE(heapCursor, off + 8)
          const padded =
            strBytes.length % 2 === 1 ? Buffer.concat([strBytes, Buffer.from([0])]) : strBytes
          heapChunks.push(padded)
          heapCursor += padded.length
        }
      }
    })
    dir.writeUInt32LE(0, 2 + entries.length * 12)
    return dir
  }

  const ifd0Buf = encodeDir(sortedIfd0, exifOffset)
  const exifBuf = hasExif ? encodeDir(sortedExif) : Buffer.alloc(0)
  const hdr = Buffer.alloc(8)
  hdr.write('II', 0, 'ascii')
  hdr.writeUInt16LE(0x002a, 2)
  hdr.writeUInt32LE(ifd0Offset, 4)
  const tiff = Buffer.concat([hdr, ifd0Buf, exifBuf, ...heapChunks])
  const exifHdr = Buffer.from('Exif\0\0', 'ascii')
  const app1 = Buffer.alloc(4)
  app1[0] = 0xff
  app1[1] = 0xe1
  app1.writeUInt16BE(2 + exifHdr.length + tiff.length, 2)
  return Buffer.concat([jpegBuf.subarray(0, 2), app1, exifHdr, tiff, jpegBuf.subarray(2)])
}

async function waitForMetadataJob(cdp, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const p = await evaluate(cdp, `window.api.getPhotoMetadataProgress()`)
    if (p.status === 'completed') return p
    if (p.status === 'failed') {
      throw new Error(`Metadata extraction failed: ${p.lastError ?? 'unknown error'}`)
    }
    await sleep(150)
  }
  throw new Error('Metadata extraction timed out')
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
    const unpackedRoot = process.env.PV_UNPACKED_DIR || join(rootDir, 'dist', 'win-unpacked')
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
    const unpackedSpikesDir = join(unpackedRoot, 'resources', 'app.asar.unpacked', 'spikes')
    if (existsSync(unpackedSpikesDir)) {
      throw new Error(`Unexpected spikes directory bundled in unpacked app: ${unpackedSpikesDir}`)
    }
    pass(
      'Unpacked ONNX Runtime native binary installed in app.asar.unpacked with zero bundled spikes/'
    )
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

    if (f.fileName === 'red_sports_car.jpg') {
      buf = injectJpegApp1Exif(buf, {
        ifd0Tags: [
          { tagId: EXIF_TAG.Make, type: 'ascii', value: 'Canon' },
          { tagId: EXIF_TAG.Model, type: 'ascii', value: 'Canon EOS R5' }
        ],
        exifTags: [
          { tagId: EXIF_TAG.DateTimeOriginal, type: 'ascii', value: '2025:07:04 14:30:00' },
          { tagId: EXIF_TAG.OffsetTimeOriginal, type: 'ascii', value: '+02:00' },
          { tagId: EXIF_TAG.LensModel, type: 'ascii', value: 'RF 24-70mm F2.8L' }
        ]
      })
    }
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
  writeFileSync(
    join(photosDir, 'portrait_heic_sample.heic'),
    readFileSync(join(rootDir, 'tests', 'fixtures', 'heic', 'portrait_exif6.heic'))
  )

  const initialPhotoBaselines = snapshotDirectoryFiles(photosDir)
  pass(`Generated ${initialPhotoBaselines.size} distinct semantic photograph fixtures`)

  const port = await getFreePort()
  let app = null

  try {
    console.log('[Phase 2] Launching Electron app with isolated userData...')
    app = await launchApp(userDataDir, port, { PV_TEST_MODEL_IMPORT_DIR: offlineModelFixtureDir })
    pass('Electron application launched and window.api connected')

    // 5. Scan photos directory first so PhotosPanel mounts with discovered source root
    console.log('[Phase 3] Scanning photograph source root...')
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

    // 5b. Test unprovisioned search behavior & invalid/corrupt model recovery
    console.log('[Phase 4] Testing search behavior prior to model provisioning...')
    const unprovSearch = await evaluate(
      app.cdp,
      `window.api.searchPhotosSemantic({ queryText: 'sunset sky' })`
    )
    if (unprovSearch.modelStatus !== 'unprovisioned' || unprovSearch.items.length !== 0) {
      throw new Error(`Expected unprovisioned status, got: ${JSON.stringify(unprovSearch)}`)
    }
    pass('Search returns honest unprovisioned status and empty results when model is missing')

    // 5c. Test invalid/corrupt model import rejection and UI recovery banner
    console.log('[Phase 4b] Testing invalid/corrupt model import rejection and recovery...')
    // Navigate to Photos view so PhotosSearchBar is mounted and listening to onSemanticModelStatus
    for (let i = 0; i < 40; i++) {
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
      await sleep(100)
    }

    // Verify missing model notice is displayed before any model is installed
    let missingBannerText = ''
    for (let i = 0; i < 30; i++) {
      missingBannerText = await evaluate(
        app.cdp,
        `document.querySelector('[data-testid="search-model-missing-notice"]')?.textContent ?? ''`
      )
      if (missingBannerText.includes('not installed')) break
      await sleep(100)
    }
    if (!missingBannerText.includes('not installed')) {
      throw new Error(
        `Expected missing model banner in PhotosSearchBar, got: '${missingBannerText}'`
      )
    }

    writeFileSync(join(offlineModelFixtureDir, 'config.json'), '{"corrupt":true}', 'utf8')
    const corruptImportRes = await evaluate(app.cdp, `window.api.importSemanticModelFromFolder()`)
    if (corruptImportRes.state !== 'error' || !corruptImportRes.error) {
      throw new Error(
        `Expected corrupt model import to fail with state='error', got: ${JSON.stringify(corruptImportRes)}`
      )
    }
    let errorBannerText = ''
    for (let i = 0; i < 40; i++) {
      errorBannerText = await evaluate(
        app.cdp,
        `document.querySelector('[data-testid="search-model-error-notice"]')?.textContent ?? ''`
      )
      if (errorBannerText.includes('download or setup failed')) break
      await sleep(100)
    }
    if (!errorBannerText.includes('download or setup failed')) {
      throw new Error(
        `Expected PhotosSearchBar download/setup failure recovery banner, got: '${errorBannerText}'`
      )
    }
    // Restore valid config.json and refresh baseline snapshot
    copyFileSync(
      join(cachedModelSource, 'config.json'),
      join(offlineModelFixtureDir, 'config.json')
    )
    const restoredModelBaselines = snapshotDirectoryFiles(offlineModelFixtureDir)
    offlineModelBaselines.clear()
    for (const [k, v] of restoredModelBaselines.entries()) {
      offlineModelBaselines.set(k, v)
    }
    pass(
      'Invalid/corrupt model folder rejected with error state and clear UI recovery guidance banner'
    )

    // 6. Import verified model folder
    console.log('[Phase 5] Importing verified offline CLIP model folder...')
    const modelImportRes = await evaluate(app.cdp, `window.api.importSemanticModelFromFolder()`)
    if (modelImportRes.state !== 'ready') {
      throw new Error(`Model import did not reach ready state: ${JSON.stringify(modelImportRes)}`)
    }
    pass('Offline model folder verified and imported to ready state')

    // 8. Run semantic indexing and technical metadata extraction on discovered photos
    console.log('[Phase 6] Running semantic indexing and technical metadata extraction...')
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

    await evaluate(app.cdp, `window.api.startPhotoMetadataExtraction()`)
    const completedMeta = await waitForMetadataJob(app.cdp, 45000)
    if (completedMeta.processedPhotos !== initialPhotoBaselines.size) {
      throw new Error(
        `Expected ${initialPhotoBaselines.size} metadata-extracted photos, got ${completedMeta.processedPhotos}`
      )
    }
    pass(
      `Extracted EXIF/container metadata for ${completedMeta.processedPhotos} photos (extracted=${completedMeta.extractedPhotos}, absentMetadata=${completedMeta.absentMetadataPhotos})`
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

    // Query 2b: Verify indexed HEIC photo produced a semantic embedding and is reachable via search
    const heicSearchRes = await evaluate(
      app.cdp,
      `window.api.searchPhotosSemantic({ queryText: 'portrait photo', limit: 50, minScore: -1.0 })`
    )
    const matchedHeic = heicSearchRes.items.find(
      (item) => item.photo.fileName === 'portrait_heic_sample.heic'
    )
    if (
      !matchedHeic ||
      typeof matchedHeic.score !== 'number' ||
      !Number.isFinite(matchedHeic.score)
    ) {
      throw new Error(
        `Expected indexed HEIC photo 'portrait_heic_sample.heic' to be reachable via semantic search, got: ${JSON.stringify(heicSearchRes)}`
      )
    }
    pass(
      `Indexed HEIC photo 'portrait_heic_sample.heic' reachable via semantic search (score=${matchedHeic.score.toFixed(3)})`
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

    // 10b. Combined Stage 5B (rating, flag, collection) + Stage 6C (date, camera, lens, resolution, file-type, Unknown) filter-before-ranking
    const carPhoto = carRes.items[0].photo
    const carRev = `rev:${carPhoto.discoveryObservationId}:${carPhoto.byteSize}:${carPhoto.filesystemMtimeMs}:${carPhoto.activeHash}`
    await evaluate(
      app.cdp,
      `window.api.setPhotoAnnotation({
        fileLocationId: ${carPhoto.id},
        rating: 5,
        flag: 'pick',
        expectedRevision: ${JSON.stringify(carRev)},
        expectedVersion: 0
      })`
    )
    const favCol = await evaluate(
      app.cdp,
      `window.api.createCollection({ name: 'Stage 6E Favorites' })`
    )
    const favColId = favCol.collection.id
    await evaluate(
      app.cdp,
      `window.api.addCollectionMember({
        collectionId: ${favColId},
        fileLocationId: ${carPhoto.id},
        expectedRevision: ${JSON.stringify(carRev)}
      })`
    )

    const combinedFilterRes = await evaluate(
      app.cdp,
      `window.api.searchPhotosSemantic({
        queryText: 'bright red sports car automobile',
        ratingFilter: '5',
        flagFilter: 'pick',
        collectionId: ${favColId},
        captureDateFrom: '2025-07-01',
        captureDateTo: '2025-07-10',
        cameraNormalized: 'canon eos r5',
        lensNormalized: 'rf 24-70mm f2.8l',
        minWidthPx: 600,
        minHeightPx: 400,
        fileTypeBasis: 'detected_format',
        fileTypeValue: 'jpeg'
      })`
    )
    if (
      combinedFilterRes.totalMatched !== 1 ||
      combinedFilterRes.items[0]?.photo?.id !== carPhoto.id
    ) {
      throw new Error(
        `Combined Stage 5B + Stage 6C filter search expected only red_sports_car, got: ${JSON.stringify(combinedFilterRes)}`
      )
    }

    // Verify Unknown filters (onlyUnknownCamera, onlyUnknownLens, includeUnknownCaptureDate) exclude known-camera car photo and include unknown-camera forest photo
    const unknownFilterRes = await evaluate(
      app.cdp,
      `window.api.searchPhotosSemantic({
        queryText: 'lush green pine trees evergreen forest canopy',
        onlyUnknownCamera: true,
        onlyUnknownLens: true,
        includeUnknownCaptureDate: true,
        minWidthPx: 600,
        minHeightPx: 400,
        fileTypeBasis: 'detected_format',
        fileTypeValue: 'png'
      })`
    )
    if (
      unknownFilterRes.totalMatched !== 1 ||
      unknownFilterRes.items[0]?.photo?.id !== forestPhoto.id
    ) {
      throw new Error(
        `Unknown metadata filter search expected only evergreen_forest.png, got: ${JSON.stringify(unknownFilterRes)}`
      )
    }
    pass(
      'Combined rating, flag, collection, capture date, camera, lens, resolution, file-type, and Unknown filters verified before ranking'
    )

    // 10c. Query boundary validation (empty/whitespace and >500 chars rejected)
    let emptyRejected = false
    try {
      await evaluate(app.cdp, `window.api.searchPhotosSemantic({ queryText: '   ' })`)
    } catch {
      emptyRejected = true
    }
    let overLenRejected = false
    try {
      await evaluate(
        app.cdp,
        `window.api.searchPhotosSemantic({ queryText: ${JSON.stringify('x'.repeat(501))} })`
      )
    } catch {
      overLenRejected = true
    }
    if (!emptyRejected || !overLenRejected) {
      throw new Error(
        `Expected empty (${emptyRejected}) and >500-char (${overLenRejected}) queries to be rejected`
      )
    }
    pass('Query input bounds enforced: empty/whitespace and >500-character inputs rejected')

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

    // 12e & 12f: Controlled test-delay launch for deterministic queue saturation and 4-way concurrent workload overlap
    console.log(
      '[Phase 10b] Relaunching with isolated test delays (PV_TEST_SEARCH_DELAY_MS=250, PV_TEST_WORKER_*_DELAY_MS=120) for queue saturation & overlap proof...'
    )
    killTree(app.child)
    app = null
    await sleep(800)

    const portDelayed = await getFreePort()
    app = await launchApp(userDataDir, portDelayed, {
      PV_TEST_SEARCH_DELAY_MS: '250',
      PV_TEST_WORKER_METADATA_DELAY_MS: '120',
      PV_TEST_WORKER_SEMANTIC_DELAY_MS: '120',
      PV_TEST_WORKER_THUMBNAIL_DELAY_MS: '120'
    })

    // 12e. Queue saturation (> 16 concurrent pending requests) with explicit overload handling & recovery
    const saturationOutcomes = await evaluate(
      app.cdp,
      `(async () => {
        const reqs = []
        for (let i = 0; i < 22; i++) {
          reqs.push(
            window.api.searchPhotosSemantic({
              queryText: 'saturated queue test query',
              offset: i,
              limit: 1
            })
          )
        }
        const settled = await Promise.allSettled(reqs)
        const fulfilled = settled.filter((s) => s.status === 'fulfilled').length
        const overloaded = settled.filter(
          (s) =>
            s.status === 'rejected' &&
            String(s.reason?.message ?? s.reason).toLowerCase().includes('overload')
        ).length
        return { fulfilled, overloaded, total: settled.length }
      })()`
    )
    if (saturationOutcomes.overloaded === 0 || saturationOutcomes.fulfilled === 0) {
      throw new Error(
        `Expected queue saturation (>16 requests) to trigger SearchOverloadError while completing bounded requests, got: ${JSON.stringify(saturationOutcomes)}`
      )
    }
    pass(
      `Queue saturation handled explicitly (${saturationOutcomes.fulfilled} fulfilled, ${saturationOutcomes.overloaded} rejected with SearchOverloadError out of ${saturationOutcomes.total} concurrent requests)`
    )

    // 12f. Prove genuine concurrent workload overlap on fresh uncached, unindexed, un-extracted fixtures
    const overlapPhotosDir = join(tempBase, 'overlap_photos')
    mkdirSync(overlapPhotosDir, { recursive: true })
    for (let i = 1; i <= 6; i++) {
      await sharp({
        create: {
          width: 400,
          height: 300,
          channels: 3,
          background: { r: 20 * i, g: 140, b: 60 + 20 * i }
        }
      })
        .jpeg({ quality: 88 })
        .toFile(join(overlapPhotosDir, `overlap_${i}.jpg`))
    }
    const overlapScanRes = await evaluate(
      app.cdp,
      `window.api.startScan({ roots: [${JSON.stringify(overlapPhotosDir)}] })`
    )
    const overlapScanJobId = overlapScanRes?.job?.jobId ?? overlapScanRes?.jobId
    if (!overlapScanRes?.success || typeof overlapScanJobId !== 'number') {
      throw new Error(`Failed to start overlap scan job: ${JSON.stringify(overlapScanRes)}`)
    }
    await waitForScanJob(app.cdp, overlapScanJobId)

    const allPhotosAfterOverlapScan = await evaluate(
      app.cdp,
      `window.api.getPhotosPage({ offset: 0, limit: 50 })`
    )
    const overlapItems = allPhotosAfterOverlapScan.items.filter((p) =>
      p.fileName.startsWith('overlap_')
    )
    if (overlapItems.length !== 6) {
      throw new Error(`Expected 6 fresh overlap photos, found ${overlapItems.length}`)
    }

    const diagBeforeOverlap = await evaluate(app.cdp, `window.api.getPhotosDiagnostics()`)

    // Fire uncached thumbnail decodes, metadata extraction, semantic indexing, and semantic search together
    const overlapQueryText = 'lush green evergreen pine trees'
    const overlapStartEval = evaluate(
      app.cdp,
      `(async () => {
        const items = ${JSON.stringify(
          overlapItems.map((p) => ({
            id: p.id,
            byteSize: p.byteSize,
            filesystemMtimeMs: p.filesystemMtimeMs
          }))
        )}
        const tracker = {
          thumbnailsInFlight: items.length,
          thumbnailsStartedAtMs: null,
          thumbnailsEndedAtMs: null,
          thumbnailsCompleted: false,
          metadataStartedAtMs: null,
          metadataEndedAtMs: null,
          metadataJobId: null,
          metadataCompleted: false,
          metadataProcessed: 0,
          semanticStartedAtMs: null,
          semanticEndedAtMs: null,
          semanticJobId: null,
          semanticCompleted: false,
          semanticProcessed: 0,
          searchStartedAtMs: null,
          searchEndedAtMs: null,
          searchCompleted: false,
          searchResultCount: 0,
          searchTop: null
        }
        window.__stage6eOverlap = tracker

        const metaPromise = (async () => {
          tracker.metadataStartedAtMs = Date.now()
          const job = await window.api.startPhotoMetadataExtraction({ retryFailed: false })
          tracker.metadataJobId = job.jobId
          while (true) {
            const prog = await window.api.getPhotoMetadataProgress()
            if (
              prog.jobId === job.jobId &&
              (prog.status === 'completed' || prog.status === 'failed')
            ) {
              tracker.metadataEndedAtMs = Date.now()
              tracker.metadataCompleted = prog.status === 'completed'
              tracker.metadataProcessed = prog.processedPhotos ?? 0
              return { job, prog }
            }
            await new Promise((r) => setTimeout(r, 20))
          }
        })()

        const semanticPromise = (async () => {
          tracker.semanticStartedAtMs = Date.now()
          const job = await window.api.startSemanticIndexing()
          tracker.semanticJobId = job.jobId
          while (true) {
            const prog = await window.api.getSemanticIndexProgress()
            if (
              prog.jobId === job.jobId &&
              (prog.status === 'completed' || prog.status === 'failed')
            ) {
              tracker.semanticEndedAtMs = Date.now()
              tracker.semanticCompleted = prog.status === 'completed'
              tracker.semanticProcessed = prog.processedPhotos ?? 0
              return { job, prog }
            }
            await new Promise((r) => setTimeout(r, 20))
          }
        })()

        // Wait until both background jobs have registered their new jobIds and entered 'running'
        const readyDeadline = Date.now() + 5000
        while (Date.now() < readyDeadline) {
          if (tracker.metadataJobId != null && tracker.semanticJobId != null) {
            const [mProg, sProg] = await Promise.all([
              window.api.getPhotoMetadataProgress(),
              window.api.getSemanticIndexProgress()
            ])
            if (
              mProg.jobId === tracker.metadataJobId &&
              mProg.status === 'running' &&
              sProg.jobId === tracker.semanticJobId &&
              sProg.status === 'running'
            ) {
              break
            }
          }
          await new Promise((r) => setTimeout(r, 10))
        }

        const thumbsPromise = (async () => {
          tracker.thumbnailsStartedAtMs = Date.now()
          const results = await Promise.all(
            items.map(async (item) => {
              try {
                return await window.api.getThumbnail({
                  locationId: item.id,
                  expectedByteSize: item.byteSize,
                  expectedMtimeMs: item.filesystemMtimeMs,
                  priority: 'high'
                })
              } finally {
                tracker.thumbnailsInFlight = Math.max(0, tracker.thumbnailsInFlight - 1)
              }
            })
          )
          tracker.thumbnailsEndedAtMs = Date.now()
          tracker.thumbnailsCompleted = results.every((t) => t.status === 'ready')
          return results
        })()

        const searchPromise = (async () => {
          tracker.searchStartedAtMs = Date.now()
          const res = await window.api.searchPhotosSemantic({
            queryText: ${JSON.stringify(overlapQueryText)},
            offset: 0,
            limit: 5
          })
          tracker.searchEndedAtMs = Date.now()
          tracker.searchCompleted = true
          tracker.searchResultCount = res.items.length
          tracker.searchTop = res.items[0]?.photo?.fileName ?? null
          return res
        })()

        const [thumbs, metaRes, semRes, searchRes] = await Promise.all([
          thumbsPromise,
          metaPromise,
          semanticPromise,
          searchPromise
        ])

        return {
          thumbStatuses: thumbs.map((t) => t.status),
          metaStatus: metaRes.prog.status,
          indexStatus: semRes.prog.status,
          searchTop: searchRes.items[0]?.photo?.fileName ?? null,
          tracker
        }
      })()`
    )

    const overlapSamples = []
    const overlapDeadline = Date.now() + 30000
    while (Date.now() < overlapDeadline) {
      const poll = await evaluate(
        app.cdp,
        `(async () => {
          const [diag, metaProg, semProg] = await Promise.all([
            window.api.getPhotosDiagnostics(),
            window.api.getPhotoMetadataProgress(),
            window.api.getSemanticIndexProgress()
          ])
          return {
            timestampMs: Date.now(),
            diag,
            metaProg,
            semProg,
            tracker: window.__stage6eOverlap ?? null
          }
        })()`
      )
      overlapSamples.push({
        timestampMs: poll.timestampMs,
        thumbnailsInFlight: poll.tracker?.thumbnailsInFlight ?? 0,
        metadataJobId: poll.metaProg?.jobId ?? poll.tracker?.metadataJobId ?? null,
        metadataJobStatus: poll.metaProg?.status ?? 'idle',
        semanticJobId: poll.semProg?.jobId ?? poll.tracker?.semanticJobId ?? null,
        semanticJobStatus: poll.semProg?.status ?? 'idle',
        diag: poll.diag
      })
      if (
        poll.tracker?.thumbnailsCompleted &&
        poll.tracker?.searchCompleted &&
        (poll.metaProg.status === 'completed' || poll.metaProg.status === 'failed') &&
        (poll.semProg.status === 'completed' || poll.semProg.status === 'failed')
      ) {
        break
      }
      await sleep(25)
    }

    const overlapWorkRes = await overlapStartEval
    const diagAfterOverlap = await evaluate(app.cdp, `window.api.getPhotosDiagnostics()`)
    const deltaTotalDecodes =
      (diagAfterOverlap.totalDecodes ?? 0) - (diagBeforeOverlap.totalDecodes ?? 0)
    const deltaCacheMisses =
      (diagAfterOverlap.cacheMisses ?? 0) - (diagBeforeOverlap.cacheMisses ?? 0)
    const t = overlapWorkRes.tracker
    const overlapSummary = assertConcurrentWorkloadOverlap({
      samples: overlapSamples,
      deltaTotalDecodes,
      deltaCacheMisses,
      workflows: {
        thumbnails: {
          locationIds: overlapItems.map((p) => p.id),
          startedAtMs: t.thumbnailsStartedAtMs,
          endedAtMs: t.thumbnailsEndedAtMs,
          completed: t.thumbnailsCompleted,
          deltaTotalDecodes,
          deltaCacheMisses
        },
        metadata: {
          jobId: t.metadataJobId,
          startedAtMs: t.metadataStartedAtMs,
          endedAtMs: t.metadataEndedAtMs,
          completed: t.metadataCompleted,
          processedCount: t.metadataProcessed
        },
        semanticIndex: {
          jobId: t.semanticJobId,
          startedAtMs: t.semanticStartedAtMs,
          endedAtMs: t.semanticEndedAtMs,
          completed: t.semanticCompleted,
          processedCount: t.semanticProcessed
        },
        search: {
          queryText: overlapQueryText,
          startedAtMs: t.searchStartedAtMs,
          endedAtMs: t.searchEndedAtMs,
          completed: t.searchCompleted,
          resultCount: t.searchResultCount
        }
      }
    })
    if (
      overlapWorkRes.thumbStatuses.some((s) => s !== 'ready') ||
      !overlapWorkRes.searchTop?.includes('forest')
    ) {
      throw new Error(`Overlap workload results invalid: ${JSON.stringify(overlapWorkRes)}`)
    }
    const qualifyingSample = overlapSamples.find(
      (s) =>
        s.timestampMs >= overlapSummary.sharedIntervalStartMs &&
        s.timestampMs <= overlapSummary.sharedIntervalEndMs &&
        s.thumbnailsInFlight >= 1 &&
        s.metadataJobStatus === 'running' &&
        s.semanticJobStatus === 'running' &&
        (s.diag?.searchActiveCalls ?? 0) >= 1
    )
    console.log(
      `[INFO] Overlap trace: sharedInterval=[${overlapSummary.sharedIntervalStartMs}, ${overlapSummary.sharedIntervalEndMs}] (${overlapSummary.sharedOverlapDurationMs}ms), qualifyingSamples=${overlapSummary.qualifyingSampleCount}/${overlapSummary.sampleCount}, metaJobId=${overlapSummary.metadataJobId}, semJobId=${overlapSummary.semanticJobId}, sample=${JSON.stringify(
        {
          timestampMs: qualifyingSample?.timestampMs,
          thumbnailsInFlight: qualifyingSample?.thumbnailsInFlight,
          metadataJobStatus: qualifyingSample?.metadataJobStatus,
          semanticJobStatus: qualifyingSample?.semanticJobStatus,
          activeWorkers: qualifyingSample?.diag?.activeWorkers,
          liveWorkers: qualifyingSample?.diag?.liveWorkers,
          activeMetadataTasks: qualifyingSample?.diag?.activeMetadataTasks,
          activeSemanticTasks: qualifyingSample?.diag?.activeSemanticTasks,
          searchActiveCalls: qualifyingSample?.diag?.searchActiveCalls,
          totalAppLiveWorkers: qualifyingSample?.diag?.totalAppLiveWorkers
        }
      )}`
    )
    pass(
      `Proven correlated four-workflow overlap (${overlapSummary.sharedOverlapDurationMs}ms shared interval, ${overlapSummary.qualifyingSampleCount}/${overlapSummary.sampleCount} qualifying polls, decodes=${overlapSummary.deltaTotalDecodes}, misses=${overlapSummary.deltaCacheMisses}, peakActiveMeta=${overlapSummary.peakActiveMetadataTasks}, peakActiveSem=${overlapSummary.peakActiveSemanticTasks}, peakSearchActive=${overlapSummary.peakSearchActiveCalls}, peakTotalAppLiveWorkers=${overlapSummary.peakTotalAppLiveWorkers}<=3)`
    )

    // Relaunch without artificial test delays for uncontaminated production UI, scale & restart timings
    console.log(
      '[Phase 10c] Relaunching without test delays for production UI & scale verification...'
    )
    killTree(app.child)
    app = null
    await sleep(800)
    const portClean = await getFreePort()
    app = await launchApp(userDataDir, portClean)

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

    const totalRealPhotosCount = initialPhotoBaselines.size + overlapItems.length
    let totalCountText = ''
    for (let i = 0; i < 40; i++) {
      totalCountText = await evaluate(
        app.cdp,
        `document.querySelector('.photos-count-info .count-badge')?.textContent ?? ''`
      )
      if (totalCountText.includes(`${totalRealPhotosCount} photos`)) break
      await sleep(150)
    }

    if (!totalCountText.includes(`${totalRealPhotosCount} photos`)) {
      throw new Error(
        `Expected all ${totalRealPhotosCount} photos after clear, got '${totalCountText}'`
      )
    }
    pass(`Clearing search restored ordinary browsing with all ${totalRealPhotosCount} photographs`)

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

    // 14b. Large-Catalog Deep Pagination (>10,000), Corrupt Count & Main Heartbeat Check
    console.log(
      '[Phase 12b] Seeding 10,200 synthetic embeddings + 1 corrupt embedding for large-catalog real Electron check...'
    )
    const catalogDbPath = join(userDataDir, 'vault-catalog.db')
    const synthDb = new DatabaseSync(catalogDbPath)
    try {
      const refRow = synthDb
        .prepare(
          `SELECT source_id, model_id, model_commit, model_manifest_sha256, preprocessing_version, embedding_blob
           FROM photo_semantic_embeddings se
           JOIN file_locations f ON f.id = se.file_location_id
           LIMIT 1;`
        )
        .get()
      if (!refRow) {
        throw new Error('Expected at least one indexed photo in catalog for synthetic seeding')
      }

      const synthSha = 'e'.repeat(64)
      synthDb.exec('BEGIN TRANSACTION;')
      const insFile = synthDb.prepare(`
        INSERT INTO file_locations (
          source_id, original_path, normalized_path, file_name, extension, category,
          created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, '.jpg', 'photo', 1700000000000, 1700000000000);
      `)
      const insDisc = synthDb.prepare(`
        INSERT INTO discovery_observations (
          file_location_id, byte_size, filesystem_birthtime_ms, filesystem_mtime_ms,
          observed_at_ms, last_seen_at_ms, is_current
        ) VALUES (?, 2048, 1700000000000, 1700000000000, 1700000000000, 1700000000000, 1);
      `)
      const insHash = synthDb.prepare(`
        INSERT INTO hash_observations (
          file_location_id, discovery_observation_id, sha256,
          observed_byte_size, observed_mtime_ms, hashed_at_ms, is_active
        ) VALUES (?, ?, ?, 2048, 1700000000000, 1700000000000, 1);
      `)
      const insEmb = synthDb.prepare(`
        INSERT INTO photo_semantic_embeddings (
          file_id, file_location_id, discovery_observation_id,
          content_sha256, content_revision, source_path, observed_byte_size, observed_mtime_ms,
          model_id, model_commit, model_manifest_sha256, preprocessing_version,
          embedding_dimensions, embedding_blob, is_current, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, 2048, 1700000000000, ?, ?, ?, ?, 512, ?, 1, 1700000000000);
      `)

      const corruptBuf = Buffer.alloc(2048) // all zeros -> corrupt zero-norm vector
      for (let i = 0; i < 10_201; i++) {
        const fakePath = join(photosDir, `synthetic_scale_${i}.jpg`)
        const fRes = insFile.run(
          refRow.source_id,
          fakePath,
          fakePath.toLowerCase(),
          `synthetic_scale_${i}.jpg`
        )
        const fId = Number(fRes.lastInsertRowid)
        const dRes = insDisc.run(fId)
        const dId = Number(dRes.lastInsertRowid)
        insHash.run(fId, dId, synthSha)
        const rev = `semrev:${dId}:2048:1700000000000:${synthSha}`
        const blobToUse = i === 10_200 ? corruptBuf : refRow.embedding_blob
        insEmb.run(
          fId,
          fId,
          dId,
          synthSha,
          rev,
          fakePath,
          refRow.model_id,
          refRow.model_commit,
          refRow.model_manifest_sha256,
          refRow.preprocessing_version,
          blobToUse
        )
      }
      synthDb.exec('COMMIT;')
    } finally {
      synthDb.close()
    }

    const largeSearchPromise = evaluate(
      app.cdp,
      `window.api.searchPhotosSemantic({ queryText: 'natural landscape scenery', offset: 10050, limit: 25, minScore: -1.0 })`
    )
    const tLargeHb0 = Date.now()
    const largeHbInfo = await evaluate(app.cdp, `window.api.getAppInfo()`)
    const largeHbLatency = Date.now() - tLargeHb0
    const deepRes = await largeSearchPromise

    if (!largeHbInfo || !largeHbInfo.version || largeHbLatency > 200) {
      throw new Error(
        `Main process heartbeat delayed (${largeHbLatency}ms) during 10,200+ catalog search`
      )
    }
    if (deepRes.items.length !== 25 || deepRes.offset !== 10050) {
      throw new Error(
        `Deep pagination beyond 10,000 failed: items=${deepRes.items.length}, offset=${deepRes.offset}`
      )
    }
    if (deepRes.totalMatched < 10_200 || deepRes.corruptCount !== 1) {
      throw new Error(
        `Expected totalMatched >= 10200 and corruptCount === 1, got totalMatched=${deepRes.totalMatched}, corruptCount=${deepRes.corruptCount}`
      )
    }
    // Verify deterministic tie-breaking (score DESC, fileLocationId ASC) across tied synthetic items
    for (let k = 0; k < deepRes.items.length - 1; k++) {
      const a = deepRes.items[k]
      const b = deepRes.items[k + 1]
      if (a.score === b.score && a.photo.id >= b.photo.id) {
        throw new Error(
          `Deterministic tie-breaking violation at deep offset 10050: id ${a.photo.id} before ${b.photo.id} with equal score ${a.score}`
        )
      }
    }
    pass(
      `Large-catalog deep search (offset=10,050 across ${deepRes.totalMatched} matches, corruptCount=${deepRes.corruptCount}, deterministic tie-breaking verified) succeeded with responsive main heartbeat (${largeHbLatency}ms)`
    )

    // 14c. Real Renderer Virtual Grid Deep Pagination (>10,000), LRU Eviction Return, Corrupt Warning DOM, and Continuous Frame/Worker Diagnostics
    console.log(
      '[Phase 12c] Exercising real renderer virtual grid deep pagination (>10,000), >40-page LRU eviction return, and continuous rAF/worker diagnostics...'
    )
    // Start continuous rAF frame-interval sampler in renderer
    await evaluate(
      app.cdp,
      `(() => {
        window.__stage6eRafDeltas = []
        window.__stage6eRafRunning = true
        let last = performance.now()
        const tick = (now) => {
          if (!window.__stage6eRafRunning) return
          window.__stage6eRafDeltas.push(now - last)
          last = now
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })()`
    )

    // Submit query in Photos UI search bar over the 10,200+ catalog
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
    await sleep(100)
    await evaluate(
      app.cdp,
      `(() => {
        const submitBtn = document.querySelector('.photos-search-submit-btn')
        if (submitBtn) submitBtn.click()
      })()`
    )

    const expectedLargeMatchCount = totalRealPhotosCount + 10_200
    // Wait for expectedLargeMatchCount matches and corruptCount warning badge in DOM
    let largeMatchBadge = ''
    let corruptDomWarning = ''
    const largeDiagSamples = []
    let peakLargeMountedCells = 0

    const collectLargeDiagSample = async () => {
      const [diag, mountedCells] = await Promise.all([
        evaluate(app.cdp, `window.api.getPhotosDiagnostics()`),
        evaluate(app.cdp, `document.querySelectorAll('.photo-card').length`)
      ])
      largeDiagSamples.push(diag)
      peakLargeMountedCells = Math.max(peakLargeMountedCells, mountedCells)
    }

    for (let i = 0; i < 60; i++) {
      const domState = await evaluate(
        app.cdp,
        `({
          badge: document.querySelector('[data-testid="search-match-badge"]')?.textContent ?? '',
          corrupt: document.querySelector('[data-testid="search-corrupt-warning"]')?.textContent ?? ''
        })`
      )
      largeMatchBadge = domState.badge
      corruptDomWarning = domState.corrupt
      if (i % 2 === 0) {
        await collectLargeDiagSample()
      }
      if (
        largeMatchBadge.includes(String(expectedLargeMatchCount)) &&
        corruptDomWarning.includes('1 damaged')
      ) {
        break
      }
      await sleep(150)
    }
    if (
      !largeMatchBadge.includes(String(expectedLargeMatchCount)) ||
      !corruptDomWarning.includes('1 damaged')
    ) {
      throw new Error(
        `Expected DOM badge '${expectedLargeMatchCount} semantic matches' and '1 damaged' warning, got badge='${largeMatchBadge}', corrupt='${corruptDomWarning}'`
      )
    }
    pass(
      `Photos UI rendered large-catalog match badge ('${largeMatchBadge}') and corrupt vector warning ('${corruptDomWarning}')`
    )

    // Scroll virtual grid to bottom (beyond offset 10,000) and verify deep cards mount with similarity badges and bounded DOM cells (<= 200)
    await evaluate(
      app.cdp,
      `(() => {
        const grid = document.querySelector('.photos-grid-container')
        if (grid) {
          grid.scrollTop = Math.max(0, grid.scrollHeight - grid.clientHeight)
          grid.dispatchEvent(new Event('scroll', { bubbles: true }))
        }
      })()`
    )

    let deepGridState = null
    for (let i = 0; i < 60; i++) {
      deepGridState = await evaluate(
        app.cdp,
        `(() => {
          const cards = Array.from(document.querySelectorAll('.photo-card'))
          const names = cards.map((c) => c.querySelector('.photo-filename')?.textContent ?? '')
          const badges = cards.filter((c) => c.querySelector('.badge-similarity-score')).length
          const deepNames = names.filter((n) => n.startsWith('synthetic_scale_10'))
          return {
            mountedCells: cards.length,
            hasDeepSynthetic: deepNames.length >= 6 && !names.some((n) => n.includes('Loading')),
            badges,
            sampleNames: deepNames.slice(-3)
          }
        })()`
      )
      await collectLargeDiagSample()
      if (deepGridState.hasDeepSynthetic && deepGridState.badges > 0) break
      await sleep(150)
    }
    if (
      !deepGridState ||
      !deepGridState.hasDeepSynthetic ||
      deepGridState.badges === 0 ||
      deepGridState.mountedCells > 200
    ) {
      throw new Error(
        `Real renderer deep scroll (>10,000) failed or exceeded cell bounds: ${JSON.stringify(deepGridState)}`
      )
    }
    pass(
      `Real renderer virtual grid scrolled beyond offset 10,000 (${deepGridState.sampleNames.join(', ')}) with ${deepGridState.badges} similarity badges and ${deepGridState.mountedCells} mounted DOM cells (<= 200 bound)`
    )

    // Deterministically traverse > 40 distinct pages (1..44), waiting for each completed page load in cache,
    // verify Page 0 eviction, then return to scrollTop = 0 and verify Page 0 reload + retained page scores.
    const observedPagesSet = new Set([0])
    const totalScrollRange = await evaluate(
      app.cdp,
      `(() => {
        const grid = document.querySelector('.photos-grid-container')
        return grid ? Math.max(1, grid.scrollHeight - grid.clientHeight) : 1
      })()`
    )
    for (let p = 1; p <= 44; p++) {
      const targetScroll = Math.floor(((p * 50) / expectedLargeMatchCount) * totalScrollRange)
      await evaluate(
        app.cdp,
        `(() => {
          const grid = document.querySelector('.photos-grid-container')
          if (grid) {
            grid.scrollTop = ${targetScroll}
            grid.dispatchEvent(new Event('scroll', { bubbles: true }))
          }
        })()`
      )

      let pageLoaded = false
      for (let w = 0; w < 40; w++) {
        const cacheAttr = await evaluate(
          app.cdp,
          `document.querySelector('.photos-grid-container')?.getAttribute('data-cached-pages') ?? ''`
        )
        const cachedList = cacheAttr
          .split(',')
          .filter(Boolean)
          .map((n) => Number(n))
        for (const cp of cachedList) observedPagesSet.add(cp)
        if (cachedList.includes(p)) {
          pageLoaded = true
          break
        }
        await sleep(30)
      }
      if (!pageLoaded) {
        throw new Error(
          `Page ${p} did not complete loading into renderer cache during LRU traversal`
        )
      }
      if (p % 10 === 0) {
        await collectLargeDiagSample()
      }
    }

    const afterTraversalCache = await evaluate(
      app.cdp,
      `(() => {
        const grid = document.querySelector('.photos-grid-container')
        const rawPages = grid?.getAttribute('data-cached-pages') ?? ''
        const cachedPages = rawPages.split(',').filter(Boolean).map((n) => Number(n))
        return {
          cachedPageCount: Number(grid?.getAttribute('data-cached-page-count') ?? 0),
          cachedPages,
          searchScoreCount: Number(grid?.getAttribute('data-search-score-count') ?? 0)
        }
      })()`
    )
    const afterTraversal = {
      distinctPagesObserved: observedPagesSet.size,
      cachedPageCount: afterTraversalCache.cachedPageCount,
      cachedPages: afterTraversalCache.cachedPages,
      retainedSamplePage: 44,
      searchScoreCount: afterTraversalCache.searchScoreCount
    }

    // Return to evicted Page 0 (scrollTop = 0) and wait for reload
    await evaluate(
      app.cdp,
      `(() => {
        const grid = document.querySelector('.photos-grid-container')
        if (grid) {
          grid.scrollTop = 0
          grid.dispatchEvent(new Event('scroll', { bubbles: true }))
        }
      })()`
    )

    let returnedPage0State = null
    for (let i = 0; i < 60; i++) {
      returnedPage0State = await evaluate(
        app.cdp,
        `(() => {
          const grid = document.querySelector('.photos-grid-container')
          const rawPages = grid?.getAttribute('data-cached-pages') ?? ''
          const cachedPages = rawPages.split(',').filter(Boolean).map((n) => Number(n))
          const cards = Array.from(document.querySelectorAll('.photo-card'))
          const topCard = cards[0]
          const topName = topCard?.querySelector('.photo-filename')?.textContent ?? ''
          const topBadge = topCard?.querySelector('.badge-similarity-score')?.textContent ?? ''
          return {
            mountedCells: cards.length,
            topName,
            topBadge,
            cachedPageCount: Number(grid?.getAttribute('data-cached-page-count') ?? 0),
            cachedPages,
            searchScoreCount: Number(grid?.getAttribute('data-search-score-count') ?? 0)
          }
        })()`
      )
      await collectLargeDiagSample()
      if (
        returnedPage0State.cachedPages.includes(0) &&
        returnedPage0State.topName.includes('sunset_beach.jpg') &&
        returnedPage0State.topBadge.includes('% match')
      ) {
        break
      }
      await sleep(150)
    }
    if (
      !returnedPage0State ||
      !returnedPage0State.topName.includes('sunset_beach.jpg') ||
      !returnedPage0State.topBadge.includes('% match')
    ) {
      throw new Error(
        `Return to evicted Page 0 after >40-page traversal failed: ${JSON.stringify(returnedPage0State)}`
      )
    }

    assertLruEvictionAndReload({
      afterTraversal,
      afterReload: {
        cachedPageCount: returnedPage0State.cachedPageCount,
        cachedPages: returnedPage0State.cachedPages,
        searchScoreCount: returnedPage0State.searchScoreCount,
        mountedCells: returnedPage0State.mountedCells
      }
    })

    // Stop continuous rAF sampler and run fail-closed performance & resource assertions across all polled samples
    const rafSummary = await evaluate(
      app.cdp,
      `(() => {
        window.__stage6eRafRunning = false
        const deltas = (window.__stage6eRafDeltas ?? []).slice().sort((a, b) => a - b)
        const p95Idx = Math.min(deltas.length - 1, Math.floor(deltas.length * 0.95))
        const rafP95Ms = deltas.length > 0 ? deltas[p95Idx] : 0
        return { rafSamples: deltas.length, rafP95Ms }
      })()`
    )
    const boundsSummary = assertSearchPerformanceAndResourceBounds({
      rafSamples: rafSummary.rafSamples,
      rafP95Ms: rafSummary.rafP95Ms,
      peakMountedCells: peakLargeMountedCells,
      diagSamples: largeDiagSamples
    })
    pass(
      `LRU eviction (observed ${afterTraversal.distinctPagesObserved} pages, Page 0 evicted then reloaded while preserving ${returnedPage0State.searchScoreCount} scores) & fail-closed bounds verified across ${boundsSummary.diagSampleCount} polls (peakLiveWorkers=${boundsSummary.peakLiveWorkers}<=2, peakSearchLiveWorkers=${boundsSummary.peakSearchLiveWorkers}<=1, peakTotalAppLiveWorkers=${boundsSummary.peakTotalAppLiveWorkers}<=3, mainLoopP95=${boundsSummary.peakMainEventLoopDelayP95Ms.toFixed(1)}ms<100ms, mainLoopMax=${boundsSummary.peakMainEventLoopDelayMaxMs.toFixed(1)}ms<200ms, rAF p95=${boundsSummary.rafP95Ms.toFixed(1)}ms<=33ms across ${boundsSummary.rafSamples} frames, peakMountedCells=${boundsSummary.peakMountedCells}<=200, peakMainRSS=${(boundsSummary.peakMainRssBytes / (1024 * 1024)).toFixed(1)}MiB)`
    )

    // 14d. Restart persistence verification: relaunch app against persisted catalog & model without regenerating
    console.log(
      '[Phase 12d] Restarting Electron application to verify persisted catalog & model search without regeneration...'
    )
    killTree(app.child)
    app = null
    await sleep(1200)

    const portRestart = await getFreePort()
    app = await launchApp(userDataDir, portRestart)
    const restartModelStatus = await evaluate(app.cdp, `window.api.getSemanticModelStatus()`)
    if (restartModelStatus.state !== 'ready') {
      throw new Error(
        `Expected persisted model status 'ready' after restart, got: ${JSON.stringify(restartModelStatus)}`
      )
    }
    const restartSearchRes = await evaluate(
      app.cdp,
      `window.api.searchPhotosSemantic({ queryText: 'golden orange sunset over ocean horizon', offset: 0, limit: 5 })`
    )
    const restartDeepRes = await evaluate(
      app.cdp,
      `window.api.searchPhotosSemantic({ queryText: 'golden orange sunset over ocean horizon', offset: 10050, limit: 10, minScore: -1.0 })`
    )
    if (
      restartSearchRes.items[0]?.photo?.fileName !== 'sunset_beach.jpg' ||
      restartDeepRes.totalMatched < 10_200 ||
      restartDeepRes.corruptCount !== 1 ||
      restartDeepRes.items.length !== 10
    ) {
      throw new Error(
        `Post-restart persisted search failed: top=${restartSearchRes.items[0]?.photo?.fileName}, deepTotal=${restartDeepRes.totalMatched}`
      )
    }
    pass(
      `Post-restart search immediately served top match '${restartSearchRes.items[0].photo.fileName}' and deep offset 10,050 across ${restartDeepRes.totalMatched} persisted embeddings with zero re-indexing`
    )

    // 15. Source File Preservation Invariance
    console.log('[Phase 13] Verifying source file bitwise preservation invariance...')
    const photosPreservation = assertDirectoryUnchanged(
      photosDir,
      initialPhotoBaselines,
      'photos-source'
    )
    const modelPreservation = assertDirectoryUnchanged(
      offlineModelFixtureDir,
      offlineModelBaselines,
      'offline-model-source'
    )
    pass(
      `Source preservation verified: 100% byte size, SHA-256, birthtime, and mtime invariance across ${photosPreservation.totalFiles} photos (OS read atime updated on ${photosPreservation.atimeUpdatedCount}) and ${modelPreservation.totalFiles} model files (OS read atime updated on ${modelPreservation.atimeUpdatedCount})`
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
      `\n=== STAGE 6D/6E REAL ELECTRON VERIFICATION PASSED (${passCount}/${passCount} CHECKS) ===\n`
    )
  } catch (err) {
    console.error('\n[Verification Failure Inside Test]:', err)
    throw err
  } finally {
    if (app) {
      killTree(app.child)
      await sleep(1000)
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
      // Best-effort cleanup of temp directory on Windows
    }
  }
}

main().catch((err) => {
  console.error('\nVerification failed:', err)
  process.exit(1)
})
