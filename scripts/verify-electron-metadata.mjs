#!/usr/bin/env node
/**
 * Personal Vault — Real Electron Photo Metadata Extraction & SQL Filters Verification (Stage 6C)
 *
 * Exercises Stage 6C end-to-end across real BrowserWindow, preload contextBridge,
 * Zod-validated IPC, SQLite Schema v10, shared worker-thread EXIF/header extraction,
 * and React DOM controls in both built and freshly packaged (unpacked) execution:
 *
 * 1. Packaged hygiene & sandboxed preload bundle verification (no external requires).
 * 2. Real binary EXIF/container image fixture scan (67 files: 52 Canon EOS R5 JPEGs for multi-page
 *    pagination + leap-day + DateTimeDigitized fallback + orientation 6 + exact duplicate,
 *    4 Sony ILCE-7RM5 JPEGs, 5 metadata-free PNG/WebP, 1 PNG disguised as .jpg mismatch,
 *    1 modification-date-only JPEG, 2 unsupported HEIC/CR2, 1 corrupt JPEG, 1 mutable JPEG).
 * 3. Extraction WITHOUT any semantic model installed (`state === 'missing'`), honest incomplete-coverage
 *    banner, and `unprocessed` vs extracted `Unknown` distinction before extraction.
 * 4. Active extraction via DOM controls, live progress observation, active cancellation, and full
 *    extraction completion with live SHA-256 content-reuse verification.
 * 5. Selected-photo provenance display separating File Facts, Inferred Capture Date (offset vs
 *    local wall-clock unknown timezone, fallback tag, never using modification tag or mtime),
 *    orientation-adjusted vs encoded dimensions, and extension/container mismatch warning.
 * 6. Every new SQL filter (capture date range + Unknown, camera + Unknown + facet search,
 *    lens + Unknown, orientation-adjusted min width/height + Unknown dimensions, file type
 *    detected_format vs filename_extension + Unknown) combined with Rating, Flag, and Collection
 *    via AND semantics, multi-page SQL pagination (>50 items), and clean Reset filters.
 * 7. Out-of-band source file modification + rescan invalidation (`stale` status + preserved history).
 * 8. Deterministic mid-job process kill (exit code 99), restart recovery (`interrupted`), late scan,
 *    and exact-scope resume (newly scanned photos excluded until next explicit extraction run).
 * 9. Concurrent interactive virtual-grid scrolling during active metadata extraction AND semantic
 *    indexing with strict unrelaxed bounds: rAF p95 <= 33 ms, main event-loop p95 < 100 ms,
 *    IPC p95 < 100 ms, liveWorkers <= 2, activeSemanticTasks <= 1, activeMetadataTasks <= 1,
 *    queuedJobs <= 64, mounted DOM cells <= 200.
 * 10. Strict original-source preservation invariance (SHA-256, byteSize, birthtimeMs, mtimeMs)
 *     plus honest reporting of OS filesystem access-time (`atimeMs`) behavior.
 *
 * Note on scale vs packaged runtime verification:
 *   50,001-photo repository SQL filter & job-snapshot scale is verified in `tests/main/catalog-photo-metadata.test.ts`
 *   (synthetic catalog rows). This real-Electron harness exercises ~99 real binary image files on disk
 *   through actual Chromium + preload + worker threads + ONNX + ExifReader/sharp execution.
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

// ============================================================================
// Raw Binary TIFF / EXIF 2.32 Fixture Builder (Zero Shared Code With Parser)
// ============================================================================

const TAG = {
  Make: 0x010f,
  Model: 0x0110,
  Orientation: 0x0112,
  DateTime: 0x0132,
  ExifIFDPointer: 0x8769,
  DateTimeOriginal: 0x9003,
  DateTimeDigitized: 0x9004,
  OffsetTimeOriginal: 0x9011,
  SubSecTimeOriginal: 0x9291,
  LensMake: 0xa433,
  LensModel: 0xa434
}

function buildTiffExif({ ifd0Tags = [], exifTags = [] }) {
  const hasExif = exifTags.length > 0
  const sortedIfd0 = [
    ...ifd0Tags,
    ...(hasExif ? [{ tagId: TAG.ExifIFDPointer, type: 'long', value: 0 }] : [])
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
      if (e.type === 'short') {
        dir.writeUInt16LE(3, off + 2)
        dir.writeUInt32LE(1, off + 4)
        dir.writeUInt16LE(Number(e.value) & 0xffff, off + 8)
      } else if (e.type === 'long') {
        const val =
          e.tagId === TAG.ExifIFDPointer && ptrOverride !== undefined
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
  return Buffer.concat([hdr, ifd0Buf, exifBuf, ...heapChunks])
}

async function makeExifJpeg({ width, height, color, ifd0Tags = [], exifTags = [] }) {
  const base = await sharp({
    create: { width, height, channels: 3, background: color }
  })
    .jpeg({ quality: 86 })
    .toBuffer()

  if (ifd0Tags.length === 0 && exifTags.length === 0) {
    return base
  }
  const tiff = buildTiffExif({ ifd0Tags, exifTags })
  const exifHdr = Buffer.from('Exif\0\0', 'ascii')
  const app1 = Buffer.alloc(4)
  app1[0] = 0xff
  app1[1] = 0xe1
  app1.writeUInt16BE(2 + exifHdr.length + tiff.length, 2)
  return Buffer.concat([base.subarray(0, 2), app1, exifHdr, tiff, base.subarray(2)])
}

function makeCanonCr2HeaderFixture() {
  const buf = Buffer.alloc(64)
  buf.write('II', 0, 'ascii')
  buf.writeUInt16LE(0x002a, 2)
  buf.writeUInt32LE(16, 4)
  buf.write('CR', 8, 'ascii')
  buf[10] = 0x02
  buf[11] = 0x00
  return buf
}

// ============================================================================
// Electron Launch & CDP Helpers
// ============================================================================

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
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && t.url && !t.url.startsWith('devtools:'))
      if (page) return page
    } catch (err) {
      lastError = err
    }
    await sleep(200)
  }
  throw new Error(`Timed out waiting for window on port ${port}: ${lastError?.message ?? 'none'}`)
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
        if (data.error) bad(new Error(data.error.message || 'CDP Error'))
        else ok(data.result)
      }
    }
    ws.onopen = () => {
      resolveCdp({
        send: (method, params = {}) =>
          new Promise((ok, bad) => {
            const id = nextId++
            const timer = setTimeout(() => {
              if (pending.delete(id)) {
                bad(new Error(`CDP timed out for ${method}`))
              }
            }, 30000)
            pending.set(id, { ok, bad, timer })
            ws.send(JSON.stringify({ id, method, params }))
          }),
        close: () => {
          for (const entry of pending.values()) {
            clearTimeout(entry.timer)
            entry.bad(new Error('CDP closed'))
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
      const ok = await evaluate(cdp, `typeof window.api === 'object' && window.api !== null`)
      if (ok) return true
    } catch {
      // retry
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
    const launchCwd = mkdtempSync(join(tmpdir(), 'pv-metadata-unpacked-cwd-'))
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
    if (!apiReady) throw new Error('window.api failed to initialize')
    return { child, cdp }
  } catch (err) {
    killTree(child)
    throw err
  }
}

async function runScanAndWait(cdp, roots) {
  const res = await evaluate(cdp, `window.api.startScan({ roots: ${JSON.stringify(roots)} })`)
  if (!res?.success) throw new Error(`startScan failed: ${JSON.stringify(res)}`)
  const jobId = res.job.jobId
  for (let i = 0; i < 160; i++) {
    const latest = await evaluate(cdp, `window.api.getLatestScanJob()`)
    if (
      latest?.job?.jobId === jobId &&
      (latest.job.status === 'completed' || latest.job.status === 'failed')
    ) {
      if (latest.job.status === 'failed') throw new Error(`Scan job ${jobId} failed`)
      return latest.job
    }
    await sleep(150)
  }
  throw new Error(`Scan job ${jobId} timed out`)
}

async function openPhotosAndMetadataPanel(cdp) {
  await evaluate(cdp, `window.api.setTab('photos')`)

  for (let i = 0; i < 60; i++) {
    const hasToggle = await evaluate(
      cdp,
      `(() => {
        if (document.querySelector('[data-testid="photos-toggle-metadata-filters"]')) return true
        const btn = Array.from(document.querySelectorAll('.nav-item')).find((b) =>
          b.textContent && b.textContent.includes('Photos')
        )
        if (btn) btn.click()
        return Boolean(document.querySelector('[data-testid="photos-toggle-metadata-filters"]'))
      })()`
    )
    if (hasToggle) break
    await sleep(150)
  }

  // Click Refresh to ensure latest scanned catalog is visible
  await evaluate(
    cdp,
    `(() => {
      const refreshBtn = Array.from(document.querySelectorAll('.photos-toolbar-actions button')).find(
        (b) => b.textContent && b.textContent.includes('Refresh')
      )
      if (refreshBtn) refreshBtn.click()
    })()`
  )
  await sleep(250)

  await evaluate(
    cdp,
    `(() => {
      const panel = document.querySelector('[data-testid="photo-metadata-filter-panel"]')
      if (!panel) {
        const toggle = document.querySelector('[data-testid="photos-toggle-metadata-filters"]')
        if (toggle) toggle.click()
      }
    })()`
  )

  for (let i = 0; i < 40; i++) {
    const ok = await evaluate(
      cdp,
      `Boolean(document.querySelector('[data-testid="photo-metadata-filter-panel"]'))`
    )
    if (ok) return
    await sleep(150)
  }
  throw new Error('PhotoMetadataFilterPanel failed to mount in DOM')
}

async function setReactInput(cdp, selector, value) {
  await evaluate(
    cdp,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) throw new Error('Input not found: ' + ${JSON.stringify(selector)})
      const proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
      proto.set.call(el, ${JSON.stringify(String(value))})
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    })()`
  )
}

async function setReactSelect(cdp, selector, value) {
  await evaluate(
    cdp,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) throw new Error('Select not found: ' + ${JSON.stringify(selector)})
      const proto = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')
      proto.set.call(el, ${JSON.stringify(String(value))})
      el.dispatchEvent(new Event('change', { bubbles: true }))
    })()`
  )
}

async function setCheckboxChecked(cdp, selector, desiredChecked) {
  await evaluate(
    cdp,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) throw new Error('Checkbox not found: ' + ${JSON.stringify(selector)})
      if (Boolean(el.checked) !== ${Boolean(desiredChecked)}) {
        el.click()
      }
    })()`
  )
}

async function waitForCountBadge(cdp, expectedCount, label, timeoutMs = 10000) {
  const expectedText = `${expectedCount.toLocaleString()} ${expectedCount === 1 ? 'photo' : 'photos'}`
  const deadline = Date.now() + timeoutMs
  let lastBadge = ''
  while (Date.now() < deadline) {
    lastBadge = await evaluate(
      cdp,
      `document.querySelector('.photos-count-info .count-badge')?.textContent?.trim() ?? ''`
    )
    if (lastBadge === expectedText) return
    await sleep(120)
  }
  throw new Error(`[${label}] Expected count badge "${expectedText}", got "${lastBadge}"`)
}

function snapshotDirectoryFiles(dirPath) {
  const map = new Map()
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) {
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

function assertDirectoryUnchangedAndCountAtimeUpdates(dirPath, baselineMap, label) {
  const currentMap = snapshotDirectoryFiles(dirPath)
  if (currentMap.size !== baselineMap.size) {
    throw new Error(
      `[${label}] File count changed in ${dirPath}: expected ${baselineMap.size}, got ${currentMap.size}`
    )
  }
  let atimeChangedCount = 0
  for (const [filePath, base] of baselineMap.entries()) {
    const cur = currentMap.get(filePath)
    if (!cur) throw new Error(`[${label}] Missing file ${filePath}`)
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
      atimeChangedCount++
    }
  }
  return { totalFiles: baselineMap.size, atimeChangedCount }
}

// ============================================================================
// Main Verification Flow
// ============================================================================

async function main() {
  console.log(
    `\n=== Personal Vault: Stage 6C Photo Metadata & SQL Filters Verification (${mode.toUpperCase()} mode) ===\n`
  )

  let passCount = 0
  function pass(msg) {
    passCount++
    console.log(`  [PASS ${passCount}] ${msg}`)
  }

  // 1. Preload sandbox bundling check + unpacked hygiene check
  const preloadJsPath = join(rootDir, 'out', 'preload', 'index.js')
  if (!existsSync(preloadJsPath)) {
    throw new Error(`Built preload script missing at ${preloadJsPath}. Run npm run build first.`)
  }
  const preloadCode = readFileSync(preloadJsPath, 'utf-8')
  const preloadRequires = [...preloadCode.matchAll(/\brequire\(["']([^"']+)["']\)/g)].map(
    (m) => m[1]
  )
  const illegalRequires = preloadRequires.filter((mod) => mod !== 'electron')
  if (illegalRequires.length > 0) {
    throw new Error(
      `Sandboxed preload bundle violated external require policy: ${illegalRequires.join(', ')}`
    )
  }
  pass('Sandboxed preload bundle verified (requires only "electron")')

  if (mode === 'unpacked') {
    const unpackedRoot = process.env.PV_UNPACKED_DIR || join(rootDir, 'dist', 'win-unpacked')
    if (
      !existsSync(join(unpackedRoot, 'Personal Vault.exe')) ||
      !existsSync(join(unpackedRoot, 'resources', 'app.asar'))
    ) {
      throw new Error(`Unpacked desktop build missing in ${unpackedRoot}`)
    }
    pass('Packaged unpacked desktop binary and app.asar verified present')
  }

  const cachedModelSource = join(
    rootDir,
    'spikes',
    'semantic-eval',
    '.model-cache',
    'Xenova--clip-vit-base-patch32'
  )
  const hasCachedClipModel = existsSync(
    join(cachedModelSource, 'onnx', 'vision_model_quantized.onnx')
  )
  if (!hasCachedClipModel) {
    throw new Error(
      `Local verified CLIP model cache missing at ${cachedModelSource}; required for concurrent semantic+metadata responsiveness check.`
    )
  }

  const tempBase = mkdtempSync(join(tmpdir(), 'pv-verify-metadata-6c-'))
  const userDataDir = join(tempBase, 'user-data')
  const immutablePhotosDir = join(tempBase, 'photos-immutable')
  const mutableDir = join(tempBase, 'photos-mutable')
  const crashBatchDir = join(tempBase, 'photos-crash-batch')
  const postCrashExtraDir = join(tempBase, 'photos-post-crash-extra')
  const concurrentLoadDir = join(tempBase, 'photos-concurrent-load')
  const offlineModelFixtureDir = join(tempBase, 'offline-model-source')

  for (const dir of [
    userDataDir,
    immutablePhotosDir,
    mutableDir,
    crashBatchDir,
    postCrashExtraDir,
    concurrentLoadDir,
    join(offlineModelFixtureDir, 'onnx')
  ]) {
    mkdirSync(dir, { recursive: true })
  }

  // Copy model artifacts into isolated offline import fixture directory for Phase 6 concurrent run
  for (const rel of [
    'config.json',
    'preprocessor_config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'special_tokens_map.json',
    'onnx/vision_model_quantized.onnx',
    'onnx/text_model_quantized.onnx'
  ]) {
    copyFileSync(join(cachedModelSource, rel), join(offlineModelFixtureDir, rel))
  }
  const offlineModelBaselines = snapshotDirectoryFiles(offlineModelFixtureDir)

  let currentApp = null

  try {
    console.log('[Setup] Generating 67 real binary image fixtures...')

    // 52 Canon EOS R5 + RF24-70mm F2.8 L IS USM JPEGs (enables >50 multi-page pagination)
    const canon001Buf = await makeExifJpeg({
      width: 600,
      height: 400,
      color: { r: 30, g: 95, b: 190 },
      ifd0Tags: [
        { tagId: TAG.Make, type: 'ascii', value: 'Canon' },
        { tagId: TAG.Model, type: 'ascii', value: 'Canon EOS R5' },
        { tagId: TAG.Orientation, type: 'short', value: 6 } // swaps 600x400 -> display 400x600!
      ],
      exifTags: [
        { tagId: TAG.DateTimeOriginal, type: 'ascii', value: '2024:02:29 08:15:30' },
        { tagId: TAG.SubSecTimeOriginal, type: 'ascii', value: '250' },
        { tagId: TAG.OffsetTimeOriginal, type: 'ascii', value: '+02:00' },
        { tagId: TAG.LensMake, type: 'ascii', value: 'Canon' },
        { tagId: TAG.LensModel, type: 'ascii', value: 'RF24-70mm F2.8 L IS USM' }
      ]
    })
    writeFileSync(join(immutablePhotosDir, 'canon_001.jpg'), canon001Buf)
    // Exact byte-identical copy for SHA-256 reuse check
    writeFileSync(join(immutablePhotosDir, 'canon_002_dup.jpg'), canon001Buf)

    // Fallback DateTimeDigitized without offset (local wall-clock unknown timezone) + 1920x1080
    const canon003Buf = await makeExifJpeg({
      width: 1920,
      height: 1080,
      color: { r: 60, g: 130, b: 170 },
      ifd0Tags: [
        { tagId: TAG.Make, type: 'ascii', value: 'Canon' },
        { tagId: TAG.Model, type: 'ascii', value: 'Canon EOS R5' },
        { tagId: TAG.Orientation, type: 'short', value: 1 }
      ],
      exifTags: [
        { tagId: TAG.DateTimeDigitized, type: 'ascii', value: '2024:06:15 14:20:00' },
        { tagId: TAG.LensMake, type: 'ascii', value: 'Canon' },
        { tagId: TAG.LensModel, type: 'ascii', value: 'RF24-70mm F2.8 L IS USM' }
      ]
    })
    writeFileSync(join(immutablePhotosDir, 'canon_003_fallback.jpg'), canon003Buf)

    for (let i = 4; i <= 52; i++) {
      const buf = await makeExifJpeg({
        width: 800,
        height: 600,
        color: { r: (i * 23) % 240, g: (i * 47) % 240, b: (i * 71) % 240 },
        ifd0Tags: [
          { tagId: TAG.Make, type: 'ascii', value: 'Canon' },
          { tagId: TAG.Model, type: 'ascii', value: 'Canon EOS R5' },
          { tagId: TAG.Orientation, type: 'short', value: 1 }
        ],
        exifTags: [
          {
            tagId: TAG.DateTimeOriginal,
            type: 'ascii',
            value: `2024:07:${String((i % 28) + 1).padStart(2, '0')} 10:00:00`
          },
          { tagId: TAG.OffsetTimeOriginal, type: 'ascii', value: '+00:00' },
          { tagId: TAG.LensMake, type: 'ascii', value: 'Canon' },
          { tagId: TAG.LensModel, type: 'ascii', value: 'RF24-70mm F2.8 L IS USM' }
        ]
      })
      writeFileSync(join(immutablePhotosDir, `canon_${String(i).padStart(3, '0')}.jpg`), buf)
    }

    // 4 Sony ILCE-7RM5 + FE 50mm F1.2 GM (2400x1600)
    for (let i = 1; i <= 4; i++) {
      const buf = await makeExifJpeg({
        width: 2400,
        height: 1600,
        color: { r: 180, g: 50 + i * 25, b: 90 },
        ifd0Tags: [
          { tagId: TAG.Make, type: 'ascii', value: 'SONY' },
          { tagId: TAG.Model, type: 'ascii', value: 'ILCE-7RM5' },
          { tagId: TAG.Orientation, type: 'short', value: 1 }
        ],
        exifTags: [
          { tagId: TAG.DateTimeOriginal, type: 'ascii', value: `2025:03:2${i} 18:45:00` },
          { tagId: TAG.OffsetTimeOriginal, type: 'ascii', value: '-05:00' },
          { tagId: TAG.LensMake, type: 'ascii', value: 'SONY' },
          { tagId: TAG.LensModel, type: 'ascii', value: 'FE 50mm F1.2 GM' }
        ]
      })
      writeFileSync(join(immutablePhotosDir, `sony_00${i}.jpg`), buf)
    }

    // 3 Metadata-free PNGs + 2 Metadata-free WebPs (640x480)
    for (let i = 1; i <= 3; i++) {
      const pngBuf = await sharp({
        create: { width: 640, height: 480, channels: 3, background: { r: 20 * i, g: 160, b: 120 } }
      })
        .png()
        .toBuffer()
      writeFileSync(join(immutablePhotosDir, `plain_00${i}.png`), pngBuf)
    }
    for (let i = 4; i <= 5; i++) {
      const webpBuf = await sharp({
        create: { width: 640, height: 480, channels: 3, background: { r: 140, g: 30 * i, b: 200 } }
      })
        .webp({ quality: 85 })
        .toBuffer()
      writeFileSync(join(immutablePhotosDir, `plain_00${i}.webp`), webpBuf)
    }

    // 1 Disguised PNG saved with .jpg extension (500x500)
    const disguisedPng = await sharp({
      create: { width: 500, height: 500, channels: 3, background: { r: 210, g: 140, b: 20 } }
    })
      .png()
      .toBuffer()
    writeFileSync(join(immutablePhotosDir, 'disguised_png_as_jpeg.jpg'), disguisedPng)

    // 1 Modification-date-only JPEG (IFD0 DateTime without DateTimeOriginal/DateTimeDigitized)
    const modOnlyJpeg = await makeExifJpeg({
      width: 640,
      height: 480,
      color: { r: 90, g: 90, b: 90 },
      ifd0Tags: [
        { tagId: TAG.Make, type: 'ascii', value: 'Nikon' },
        { tagId: TAG.Model, type: 'ascii', value: 'NIKON Z 8' },
        { tagId: TAG.DateTime, type: 'ascii', value: '2023:11:11 11:11:11' }
      ]
    })
    writeFileSync(join(immutablePhotosDir, 'mod_date_only.jpg'), modOnlyJpeg)

    // 1 Real HEIC + 1 Unsupported (Canon CR2) + 1 Corrupt JPEG
    writeFileSync(
      join(immutablePhotosDir, 'iphone_sample.heic'),
      readFileSync(join(__dirname, '../tests/fixtures/heic/portrait_exif6.heic'))
    )
    writeFileSync(join(immutablePhotosDir, 'raw_sample.cr2'), makeCanonCr2HeaderFixture())
    writeFileSync(
      join(immutablePhotosDir, 'corrupt_truncated.jpg'),
      Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x40, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00])
    )

    // 1 Mutable source photo in separate directory (for Phase 4 invalidation test)
    const mutableFilePath = join(mutableDir, 'mutable_source.jpg')
    const initialMutableBuf = await makeExifJpeg({
      width: 700,
      height: 500,
      color: { r: 100, g: 150, b: 200 },
      ifd0Tags: [
        { tagId: TAG.Make, type: 'ascii', value: 'Fujifilm' },
        { tagId: TAG.Model, type: 'ascii', value: 'X-T5' }
      ]
    })
    writeFileSync(mutableFilePath, initialMutableBuf)

    // Snapshot immutable source directory BEFORE launching Electron
    const immutableSourceBaseline = snapshotDirectoryFiles(immutablePhotosDir)

    // =========================================================================
    // Phase 1: Launch WITHOUT Semantic Model + Unprocessed vs Unknown Distinction
    // =========================================================================
    console.log('[Phase 1] Launching without semantic model and verifying unprocessed honesty...')
    const port1 = await getFreePort()
    currentApp = await launchApp(userDataDir, port1, {
      PV_METADATA_ITEM_DELAY_MS: '35'
    })
    let cdp = currentApp.cdp

    const modelStatusBefore = await evaluate(cdp, `window.api.getSemanticModelStatus()`)
    if (modelStatusBefore.state !== 'missing') {
      throw new Error(`Expected semantic model state 'missing', got: ${modelStatusBefore.state}`)
    }

    await runScanAndWait(cdp, [immutablePhotosDir, mutableDir])
    await openPhotosAndMetadataPanel(cdp)
    await waitForCountBadge(cdp, 67, 'Initial 67 scanned photos')

    const incompleteBannerBefore = await evaluate(
      cdp,
      `document.querySelector('[data-testid="metadata-incomplete-coverage-banner"]')?.textContent ?? ''`
    )
    if (!incompleteBannerBefore.includes('67 photos are not extracted yet')) {
      throw new Error(
        `Expected incomplete coverage banner for 67 unprocessed photos, got: ${incompleteBannerBefore}`
      )
    }

    // Select first visible photo before extraction -> must show Unknown (not extracted yet)
    await evaluate(cdp, `document.querySelector('.photo-cell:not(.photo-skeleton)')?.click()`)
    await sleep(250)
    const preExtractCaptureText = await evaluate(
      cdp,
      `(() => {
        const dts = Array.from(document.querySelectorAll('.details-list dt'))
        const cap = dts.find((el) => el.textContent === 'Capture Date')
        return cap?.nextElementSibling?.textContent ?? ''
      })()`
    )
    if (!preExtractCaptureText.includes('Unknown (not extracted yet)')) {
      throw new Error(
        `Expected "Unknown (not extracted yet)" before extraction, got: ${preExtractCaptureText}`
      )
    }

    // Toggle Unknown camera BEFORE extraction -> must return 0 photos (unprocessed != Unknown!)
    await setCheckboxChecked(cdp, '[data-testid="filter-only-unknown-camera"]', true)
    await waitForCountBadge(cdp, 0, 'Unprocessed excluded from Unknown camera filter')
    await evaluate(
      cdp,
      `document.querySelector('[data-testid="metadata-panel-reset-btn"]').click()`
    )
    await waitForCountBadge(cdp, 67, 'Reset after pre-extraction check')
    pass(
      'Without semantic model installed, UI honestly reports 67 unprocessed photos and excludes unprocessed records from Unknown filters'
    )

    // =========================================================================
    // Phase 2: Explicit Extraction, Progress, Active Cancellation & Completion
    // =========================================================================
    console.log(
      '[Phase 2] Exercising DOM extraction start, progress, cancellation, and completion...'
    )
    await evaluate(cdp, `document.querySelector('[data-testid="metadata-start-btn"]').click()`)

    let sawRunningProgress = false
    for (let i = 0; i < 60; i++) {
      const prog = await evaluate(cdp, `window.api.getPhotoMetadataProgress()`)
      if (prog.status === 'running' && prog.processedPhotos >= 2) {
        sawRunningProgress = true
        break
      }
      await sleep(60)
    }
    if (!sawRunningProgress) {
      throw new Error('Did not observe running metadata extraction progress before cancellation')
    }

    // Click Cancel button in DOM
    await evaluate(cdp, `document.querySelector('[data-testid="metadata-cancel-btn"]')?.click()`)

    let cancelledProg = null
    for (let i = 0; i < 60; i++) {
      const prog = await evaluate(cdp, `window.api.getPhotoMetadataProgress()`)
      const startReady = await evaluate(
        cdp,
        `(() => {
          const btn = document.querySelector('[data-testid="metadata-start-btn"]')
          return Boolean(btn && !btn.disabled)
        })()`
      )
      if (prog.status === 'cancelled' && startReady) {
        cancelledProg = prog
        break
      }
      await sleep(80)
    }
    if (!cancelledProg || cancelledProg.coverage.unprocessedCount === 0) {
      throw new Error(
        `Expected cancelled status with remaining unprocessed items, got: ${JSON.stringify(cancelledProg)}`
      )
    }
    pass(
      `Active cancellation stopped extraction cleanly (${cancelledProg.processedPhotos}/67 processed, ${cancelledProg.coverage.unprocessedCount} remaining unprocessed)`
    )

    // Now run remaining unprocessed photos to completion (still with semantic model missing!)
    await evaluate(cdp, `document.querySelector('[data-testid="metadata-start-btn"]').click()`)

    let completedProg = null
    for (let i = 0; i < 200; i++) {
      const prog = await evaluate(cdp, `window.api.getPhotoMetadataProgress()`)
      if (prog.status === 'completed' || prog.status === 'failed') {
        completedProg = prog
        break
      }
      await sleep(100)
    }
    if (!completedProg || completedProg.status !== 'completed') {
      throw new Error(`Expected extraction completion, got: ${JSON.stringify(completedProg)}`)
    }

    const cov = completedProg.coverage
    // 52 Canon + 4 Sony + 1 mod_date_only + 1 mutable + 1 HEIC = 59 extracted
    // 3 PNG + 2 WebP + 1 disguised PNG = 6 no_metadata
    // 1 unsupported (CR2), 1 failed (corrupt_truncated.jpg)
    if (
      cov.totalPhotos !== 67 ||
      cov.extractedCount !== 59 ||
      cov.noMetadataCount !== 6 ||
      cov.unsupportedCount !== 1 ||
      cov.failedCount !== 1 ||
      cov.unprocessedCount !== 0 ||
      cov.staleCount !== 0
    ) {
      throw new Error(`Unexpected coverage breakdown: ${JSON.stringify(cov)}`)
    }
    const modelStillMissing = await evaluate(cdp, `window.api.getSemanticModelStatus()`)
    if (modelStillMissing.state !== 'missing') {
      throw new Error('Semantic model state unexpectedly changed during metadata extraction')
    }
    pass(
      `Extraction completed without semantic model: 59 extracted (incl. HEIC), 6 no_metadata, 1 unsupported (CR2), 1 failed (corrupt JPEG), 0 unprocessed`
    )

    // =========================================================================
    // Phase 3: Selected-Photo Provenance + Every SQL Filter + Combinations + Pagination + Reset
    // =========================================================================
    console.log(
      '[Phase 3] Verifying selected-photo provenance, SQL filters, pagination, and reset...'
    )

    // Select canon_001.jpg, annotate 5 stars + Pick + collection "Field Picks", and inspect provenance
    await evaluate(
      cdp,
      `(() => {
        const cell = Array.from(document.querySelectorAll('.photo-cell')).find((el) =>
          el.getAttribute('aria-label')?.startsWith('canon_001.jpg,')
        )
        if (!cell) throw new Error('canon_001.jpg cell not mounted')
        cell.click()
      })()`
    )
    await sleep(300)

    const canon001Dom = await evaluate(
      cdp,
      `(() => {
        const tech = document.querySelector('[data-testid="photo-technical-metadata-section"]')?.textContent ?? ''
        const dts = Array.from(document.querySelectorAll('.details-list dt'))
        const cap = dts.find((el) => el.textContent === 'Capture Date')?.nextElementSibling?.textContent ?? ''
        return { tech, cap }
      })()`
    )
    if (
      !canon001Dom.tech.includes('Canon EOS R5') ||
      !canon001Dom.tech.includes('Canon RF24-70mm F2.8 L IS USM') ||
      !canon001Dom.tech.includes('400 × 600 px') ||
      !canon001Dom.tech.includes('600 × 400 px') ||
      !canon001Dom.tech.includes('Orientation 6') ||
      !canon001Dom.cap.includes('2024-02-29T08:15:30.250+02:00') ||
      !canon001Dom.cap.includes('DateTimeOriginal')
    ) {
      throw new Error(`canon_001.jpg provenance mismatch: ${JSON.stringify(canon001Dom)}`)
    }

    // Annotate canon_001.jpg: 5 Stars + Pick + Collection "Field Picks"
    await evaluate(cdp, `document.querySelector('button[aria-label="5 Stars"]')?.click()`)
    await sleep(200)
    await evaluate(cdp, `document.querySelector('button.btn-flag-pick')?.click()`)
    await sleep(200)
    await setReactInput(cdp, '.create-collection-form input.input-collection-name', 'Field Picks')
    await evaluate(
      cdp,
      `document.querySelector('.create-collection-form button[type="submit"]')?.click()`
    )
    for (let i = 0; i < 30; i++) {
      const hasAdd = await evaluate(
        cdp,
        `Boolean(document.querySelector('button[aria-label="Add to Field Picks"]'))`
      )
      if (hasAdd) break
      await sleep(100)
    }
    await evaluate(
      cdp,
      `document.querySelector('button[aria-label="Add to Field Picks"]')?.click()`
    )
    await sleep(250)

    // Verify canon_003_fallback.jpg (DateTimeDigitized fallback, local wall-clock unknown timezone)
    await evaluate(
      cdp,
      `(() => {
        const cell = Array.from(document.querySelectorAll('.photo-cell')).find((el) =>
          el.getAttribute('aria-label')?.startsWith('canon_003_fallback.jpg,')
        )
        if (!cell) throw new Error('canon_003_fallback.jpg cell not mounted')
        cell.click()
      })()`
    )
    await sleep(250)
    const fallbackCapText = await evaluate(
      cdp,
      `(() => {
        const dts = Array.from(document.querySelectorAll('.details-list dt'))
        return dts.find((el) => el.textContent === 'Capture Date')?.nextElementSibling?.textContent ?? ''
      })()`
    )
    if (
      !fallbackCapText.includes('2024-06-15T14:20:00') ||
      !fallbackCapText.includes('timezone unknown') ||
      !fallbackCapText.includes('DateTimeDigitized')
    ) {
      throw new Error(`canon_003_fallback.jpg date provenance mismatch: ${fallbackCapText}`)
    }

    // Filter to disguised_png_as_jpeg.jpg via detected_format = png (4 photos: 3 .png + 1 disguised .jpg)
    await setReactSelect(cdp, '[data-testid="filter-filetype-basis"]', 'detected_format')
    await sleep(200)
    await setReactSelect(cdp, '[data-testid="filter-filetype-value"]', 'png')
    await waitForCountBadge(cdp, 4, 'detected_format = png includes disguised .jpg')

    await evaluate(
      cdp,
      `(() => {
        const cell = Array.from(document.querySelectorAll('.photo-cell')).find((el) =>
          el.getAttribute('aria-label')?.startsWith('disguised_png_as_jpeg.jpg,')
        )
        if (!cell) throw new Error('disguised_png_as_jpeg.jpg not found in detected_format=png results')
        cell.click()
      })()`
    )
    await sleep(250)
    const mismatchTechText = await evaluate(
      cdp,
      `document.querySelector('[data-testid="photo-technical-metadata-section"]')?.textContent ?? ''`
    )
    if (!mismatchTechText.includes('Extension / container mismatch')) {
      throw new Error(`Expected extension/container mismatch badge, got: ${mismatchTechText}`)
    }

    // Switch basis to filename_extension = .png -> must return 3 photos (excluding disguised .jpg!)
    await setReactSelect(cdp, '[data-testid="filter-filetype-basis"]', 'filename_extension')
    await sleep(200)
    await setReactSelect(cdp, '[data-testid="filter-filetype-value"]', '.png')
    await waitForCountBadge(cdp, 3, 'filename_extension = .png excludes disguised .jpg')

    // Reset and test mod_date_only.jpg (Nikon Z 8) -> modification DateTime must NOT become Capture Date
    await evaluate(
      cdp,
      `document.querySelector('[data-testid="metadata-panel-reset-btn"]').click()`
    )
    await waitForCountBadge(cdp, 67, 'Reset before Nikon check')

    await setReactInput(cdp, '[data-testid="filter-camera-search"]', 'nikon')
    await sleep(250)
    await setReactSelect(cdp, '[data-testid="filter-camera-select"]', 'nikon z 8')
    await waitForCountBadge(cdp, 1, 'Camera search + select nikon z 8')

    await evaluate(cdp, `document.querySelector('.photo-cell:not(.photo-skeleton)')?.click()`)
    await sleep(250)
    const modOnlyCap = await evaluate(
      cdp,
      `(() => {
        const dts = Array.from(document.querySelectorAll('.details-list dt'))
        return dts.find((el) => el.textContent === 'Capture Date')?.nextElementSibling?.textContent ?? ''
      })()`
    )
    if (modOnlyCap !== 'Unknown') {
      throw new Error(
        `Expected modification-only DateTime tag to remain Unknown capture date, got: ${modOnlyCap}`
      )
    }
    pass(
      'Selected-photo provenance verified (leap-day +02:00, DateTimeDigitized wall-clock fallback, orientation-adjusted dimensions, container mismatch, and modification-date exclusion)'
    )

    // Test Camera filter + multi-page SQL pagination (52 Canon EOS R5 photos > 50 page size)
    await setReactInput(cdp, '[data-testid="filter-camera-search"]', '')
    await sleep(250)
    await setReactSelect(cdp, '[data-testid="filter-camera-select"]', 'canon eos r5')
    await waitForCountBadge(cdp, 52, 'Camera filter canon eos r5 (52 photos across 2 SQL pages)')

    // Scroll to bottom of filtered grid to trigger page 2 load (items 50..51 -> canon_052.jpg)
    await evaluate(
      cdp,
      `(() => {
        const el = document.querySelector('.photos-grid-container')
        if (el) { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')) }
      })()`
    )
    let page2Loaded = false
    for (let i = 0; i < 40; i++) {
      page2Loaded = await evaluate(
        cdp,
        `Array.from(document.querySelectorAll('.photo-cell')).some((el) =>
          el.getAttribute('aria-label')?.startsWith('canon_052.jpg,')
        )`
      )
      if (page2Loaded) break
      await sleep(120)
    }
    if (!page2Loaded) {
      throw new Error('Multi-page filtered SQL pagination failed to load canon_052.jpg on page 2')
    }

    // Unknown camera filter -> 6 photos (3 PNG + 2 WebP + 1 disguised PNG)
    await setCheckboxChecked(cdp, '[data-testid="filter-only-unknown-camera"]', true)
    await waitForCountBadge(cdp, 6, 'Unknown camera filter (6 metadata-free photos)')
    // Verify changing filter reset scroll position to 0
    const scrollAfterFilterChange = await evaluate(
      cdp,
      `document.querySelector('.photos-grid-container')?.scrollTop ?? -1`
    )
    if (scrollAfterFilterChange !== 0) {
      throw new Error(
        `Expected scrollTop reset to 0 on filter change, got: ${scrollAfterFilterChange}`
      )
    }
    await setCheckboxChecked(cdp, '[data-testid="filter-only-unknown-camera"]', false)

    // Lens filter + Unknown lens (8 photos without lens: 6 metadata-free + mod_date_only + mutable_source)
    await setReactSelect(cdp, '[data-testid="filter-lens-select"]', 'canon rf24-70mm f2.8 l is usm')
    await waitForCountBadge(cdp, 52, 'Lens filter canon rf24-70mm')
    await setCheckboxChecked(cdp, '[data-testid="filter-only-unknown-lens"]', true)
    await waitForCountBadge(cdp, 8, 'Unknown lens filter (8 extracted photos without Lens tags)')
    await setCheckboxChecked(cdp, '[data-testid="filter-only-unknown-lens"]', false)

    // Capture date range (leap day 2024-02-29 -> 2 photos: canon_001 + canon_002_dup) + Unknown capture date (+8 = 10)
    await setReactInput(cdp, '[data-testid="filter-date-from"]', '2024-02-29')
    await setReactInput(cdp, '[data-testid="filter-date-to"]', '2024-02-29')
    await waitForCountBadge(cdp, 2, 'Leap-date capture range 2024-02-29')
    await setCheckboxChecked(cdp, '[data-testid="filter-include-unknown-date"]', true)
    await waitForCountBadge(cdp, 10, 'Capture date range + Unknown capture date (2 + 8 = 10)')

    // Reset, then test orientation-adjusted minimum display dimensions + Unknown dimensions
    await evaluate(
      cdp,
      `document.querySelector('[data-testid="metadata-panel-reset-btn"]').click()`
    )
    await waitForCountBadge(cdp, 67, 'Reset before dimension filter')

    // 1920x1080 minimum display resolution -> 1 canon_003 (1920x1080) + 4 sony (2400x1600) = 5 photos
    await setReactInput(cdp, '[data-testid="filter-min-width"]', '1920')
    await setReactInput(cdp, '[data-testid="filter-min-height"]', '1080')
    await waitForCountBadge(cdp, 5, 'Orientation-adjusted min display 1920x1080 (5 photos)')
    // Include Unknown dimensions (+2: CR2 + corrupt JPEG = 7 photos)
    await setCheckboxChecked(cdp, '[data-testid="filter-include-unknown-dimensions"]', true)
    await waitForCountBadge(cdp, 7, 'Min display 1920x1080 + Unknown dimensions (5 + 2 = 7)')

    // Combined AND filter across Rating (5) + Flag (Pick) + Collection (Field Picks) +
    // Camera (canon eos r5) + Lens + Date (2024-02-01..2024-03-01) + Display Height >= 600 + Detected Format (jpeg)
    await evaluate(
      cdp,
      `document.querySelector('[data-testid="metadata-panel-reset-btn"]').click()`
    )
    await waitForCountBadge(cdp, 67, 'Reset before full AND combination')

    const fieldPicksValue = await evaluate(
      cdp,
      `(() => {
        const opts = Array.from(document.querySelectorAll('#filter-collection option'))
        return opts.find((o) => o.textContent?.includes('Field Picks'))?.value ?? ''
      })()`
    )
    if (!fieldPicksValue) throw new Error('Field Picks collection option missing in toolbar select')

    await setReactSelect(cdp, '#filter-rating', '5')
    await setReactSelect(cdp, '#filter-flag', 'pick')
    await setReactSelect(cdp, '#filter-collection', fieldPicksValue)
    await setReactSelect(cdp, '[data-testid="filter-camera-select"]', 'canon eos r5')
    await setReactSelect(cdp, '[data-testid="filter-lens-select"]', 'canon rf24-70mm f2.8 l is usm')
    await setReactInput(cdp, '[data-testid="filter-date-from"]', '2024-02-01')
    await setReactInput(cdp, '[data-testid="filter-date-to"]', '2024-03-01')
    // canon_001.jpg is encoded 600x400 with Orientation 6 -> display 400x600!
    await setReactInput(cdp, '[data-testid="filter-min-width"]', '400')
    await setReactInput(cdp, '[data-testid="filter-min-height"]', '600')
    await setReactSelect(cdp, '[data-testid="filter-filetype-basis"]', 'detected_format')
    await sleep(150)
    await setReactSelect(cdp, '[data-testid="filter-filetype-value"]', 'jpeg')
    await waitForCountBadge(
      cdp,
      1,
      'Combined Stage 5B + Stage 6C AND query -> 1 photo (canon_001.jpg)'
    )

    // Verify orientation swap: setting minWidthPx = 500 excludes canon_001.jpg because displayWidthPx is 400 (not encoded 600)!
    await setReactInput(cdp, '[data-testid="filter-min-width"]', '500')
    await waitForCountBadge(
      cdp,
      0,
      'Orientation-adjusted width check: minWidth=500 excludes 600x400 Orientation-6 portrait (display 400x600)'
    )

    // Reset all filters via toolbar button
    await evaluate(
      cdp,
      `Array.from(document.querySelectorAll('.photos-filter-actions button, .photos-filter-bar button')).find((b) =>
        b.textContent?.includes('Reset filters')
      )?.click()`
    )
    await waitForCountBadge(cdp, 67, 'Toolbar Reset filters restores all 67 photos')
    pass(
      'All Stage 6C SQL filters, Unknown distinctions, multi-page pagination, orientation-adjusted dimensions, Stage 5B AND combinations, and Reset filters verified'
    )

    // =========================================================================
    // Phase 4: Source-Change Invalidation & Preserved Historical Provenance
    // =========================================================================
    console.log('[Phase 4] Testing out-of-band source modification and stale invalidation...')
    const updatedMutableBuf = await makeExifJpeg({
      width: 1280,
      height: 960,
      color: { r: 220, g: 80, b: 60 },
      ifd0Tags: [
        { tagId: TAG.Make, type: 'ascii', value: 'Fujifilm' },
        { tagId: TAG.Model, type: 'ascii', value: 'GFX100 II' }
      ]
    })
    writeFileSync(mutableFilePath, updatedMutableBuf)

    await runScanAndWait(cdp, [mutableDir])
    await openPhotosAndMetadataPanel(cdp)
    await waitForCountBadge(cdp, 67, 'Phase 4 rescan count (67 photos)')

    // Refresh metadata coverage
    const staleProg = await evaluate(cdp, `window.api.getPhotoMetadataProgress()`)
    if (staleProg.coverage.staleCount !== 1) {
      throw new Error(
        `Expected staleCount === 1 after modifying scanned source file, got: ${JSON.stringify(staleProg.coverage)}`
      )
    }

    // Scroll to end of grid and wait for page 2 (mutable_source.jpg, item #67) to mount
    let mutableClicked = false
    for (let i = 0; i < 40; i++) {
      mutableClicked = await evaluate(
        cdp,
        `(() => {
          const grid = document.querySelector('.photos-grid-container')
          if (grid) {
            grid.scrollTop = grid.scrollHeight
            grid.dispatchEvent(new Event('scroll'))
          }
          const cell = Array.from(document.querySelectorAll('.photo-cell')).find((el) =>
            el.getAttribute('aria-label')?.startsWith('mutable_source.jpg,')
          )
          if (!cell) return false
          cell.click()
          return true
        })()`
      )
      if (mutableClicked) break
      await sleep(150)
    }
    if (!mutableClicked) {
      throw new Error('mutable_source.jpg cell not found after scrolling to page 2')
    }

    let staleDetailText = ''
    for (let i = 0; i < 30; i++) {
      staleDetailText = await evaluate(
        cdp,
        `document.querySelector('[data-testid="photo-technical-metadata-section"]')?.textContent ?? ''`
      )
      if (
        staleDetailText.includes('Stale') &&
        staleDetailText.includes('1 historical revision(s) preserved')
      ) {
        break
      }
      await sleep(120)
    }
    if (
      !staleDetailText.includes('Stale') ||
      !staleDetailText.includes('1 historical revision(s) preserved')
    ) {
      throw new Error(
        `Expected Stale status and preserved historical count on modified source, got: ${staleDetailText}`
      )
    }
    pass(
      'Source modification + rescan invalidated current metadata to Stale while preserving prior revision history'
    )

    // =========================================================================
    // Phase 5: Deterministic Mid-Job Process Kill, Restart & Exact-Scope Resume
    // =========================================================================
    console.log('[Phase 5] Testing deterministic mid-job process kill and exact-scope resume...')
    cdp.close()
    killTree(currentApp.child)
    currentApp = null
    await sleep(400)

    for (let i = 1; i <= 6; i++) {
      const buf = await makeExifJpeg({
        width: 900,
        height: 600,
        color: { r: 40 * i, g: 110, b: 150 },
        ifd0Tags: [
          { tagId: TAG.Make, type: 'ascii', value: 'Leica' },
          { tagId: TAG.Model, type: 'ascii', value: 'LEICA Q3' }
        ],
        exifTags: [{ tagId: TAG.DateTimeOriginal, type: 'ascii', value: `2025:05:0${i} 09:30:00` }]
      })
      writeFileSync(join(crashBatchDir, `crash_batch_${i}.jpg`), buf)
    }
    for (let i = 1; i <= 2; i++) {
      const buf = await makeExifJpeg({
        width: 960,
        height: 640,
        color: { r: 200, g: 60 * i, b: 80 },
        ifd0Tags: [
          { tagId: TAG.Make, type: 'ascii', value: 'Hasselblad' },
          { tagId: TAG.Model, type: 'ascii', value: 'X2D 100C' }
        ]
      })
      writeFileSync(join(postCrashExtraDir, `post_crash_extra_${i}.jpg`), buf)
    }

    const port2 = await getFreePort()
    currentApp = await launchApp(userDataDir, port2, {
      PV_METADATA_CRASH_AFTER_PROCESSED: '2',
      PV_METADATA_ITEM_DELAY_MS: '45'
    })
    cdp = currentApp.cdp

    // Scan 6 new Leica photos (plus 1 stale mutable_source.jpg = 7 pending scope items)
    await runScanAndWait(cdp, [crashBatchDir])
    await openPhotosAndMetadataPanel(cdp)
    await waitForCountBadge(cdp, 73, 'Phase 5 count (73 photos)')

    const exitPromise = new Promise((resolveExit) => {
      currentApp.child.once('exit', (code) => resolveExit(code))
    })

    for (let i = 0; i < 40; i++) {
      const clicked = await evaluate(
        cdp,
        `(() => {
          const btn = document.querySelector('[data-testid="metadata-start-btn"]')
          if (!btn || btn.disabled) return false
          btn.click()
          return true
        })()`
      )
      if (clicked) break
      await sleep(100)
    }

    const crashExitCode = await Promise.race([exitPromise, sleep(20000).then(() => 'timeout')])
    if (crashExitCode !== 99) {
      throw new Error(`Expected deterministic mid-job exit code 99, got: ${crashExitCode}`)
    }
    currentApp = null
    await sleep(400)
    pass(
      'Deterministic mid-job process kill (exit code 99) triggered after committing 2 metadata items'
    )

    // Relaunch cleanly with offline model import path configured for Phase 6
    const port3 = await getFreePort()
    currentApp = await launchApp(userDataDir, port3, {
      PV_TEST_MODEL_IMPORT_DIR: offlineModelFixtureDir,
      PV_TEST_WORKER_METADATA_DELAY_MS: '45',
      PV_TEST_WORKER_SEMANTIC_DELAY_MS: '45'
    })
    cdp = currentApp.cdp

    await openPhotosAndMetadataPanel(cdp)
    const interruptedProg = await evaluate(cdp, `window.api.getPhotoMetadataProgress()`)
    if (interruptedProg.status !== 'interrupted' || interruptedProg.processedPhotos !== 2) {
      throw new Error(
        `Expected interrupted status with 2 processed items after crash, got: ${JSON.stringify(interruptedProg)}`
      )
    }
    const authorizedScopeTotal = interruptedProg.totalPhotos // 7 (6 crashBatch + 1 stale mutable)
    if (authorizedScopeTotal !== 7) {
      throw new Error(`Expected snapshotted scope of 7 photos, got: ${authorizedScopeTotal}`)
    }

    // Scan 2 extra Hasselblad photos BEFORE clicking Resume Scope
    await runScanAndWait(cdp, [postCrashExtraDir])

    let resumeClicked = false
    for (let i = 0; i < 40; i++) {
      resumeClicked = await evaluate(
        cdp,
        `(() => {
          const btn = document.querySelector('[data-testid="metadata-resume-btn"]')
          if (!btn || btn.disabled) return false
          btn.click()
          return true
        })()`
      )
      if (resumeClicked) break
      await sleep(100)
    }
    if (!resumeClicked) {
      throw new Error('metadata-resume-btn was not mounted/enabled after crash recovery')
    }

    let resumedFinal = null
    for (let i = 0; i < 160; i++) {
      const p = await evaluate(cdp, `window.api.getPhotoMetadataProgress()`)
      if (p.status === 'completed' || p.status === 'failed') {
        resumedFinal = p
        break
      }
      await sleep(100)
    }
    if (!resumedFinal || resumedFinal.status !== 'completed') {
      throw new Error(
        `Expected resumed metadata job to complete, got: ${JSON.stringify(resumedFinal)}`
      )
    }
    if (
      resumedFinal.totalPhotos !== authorizedScopeTotal ||
      resumedFinal.coverage.unprocessedCount !== 2
    ) {
      throw new Error(
        `Exact-scope resume violated! Expected totalPhotos=${authorizedScopeTotal} and unprocessedCount=2, got: ${JSON.stringify(resumedFinal)}`
      )
    }
    pass(
      'Startup recovered interrupted job and resumed exact 7-photo scope while leaving 2 newly scanned photos unprocessed until next explicit run'
    )

    // =========================================================================
    // Phase 6: Concurrent Browsing During Metadata Extraction AND Semantic Indexing
    // =========================================================================
    console.log(
      '[Phase 6] Measuring interactive browsing during concurrent metadata extraction + semantic indexing...'
    )
    for (let i = 1; i <= 24; i++) {
      const buf = await makeExifJpeg({
        width: 720,
        height: 540,
        color: { r: (i * 31) % 240, g: (i * 59) % 240, b: (i * 97) % 240 },
        ifd0Tags: [
          { tagId: TAG.Make, type: 'ascii', value: 'Olympus' },
          { tagId: TAG.Model, type: 'ascii', value: 'OM-1 Mark II' }
        ],
        exifTags: [
          {
            tagId: TAG.DateTimeOriginal,
            type: 'ascii',
            value: `2025:08:${String((i % 28) + 1).padStart(2, '0')} 15:10:00`
          }
        ]
      })
      writeFileSync(join(concurrentLoadDir, `concurrent_${String(i).padStart(2, '0')}.jpg`), buf)
    }

    await runScanAndWait(cdp, [concurrentLoadDir])
    await openPhotosAndMetadataPanel(cdp)
    await waitForCountBadge(cdp, 99, '99 total catalog photos for concurrent workload')

    // Provision verified local CLIP model from offline folder so real ONNX semantic indexing competes concurrently
    const importedModel = await evaluate(cdp, `window.api.importSemanticModelFromFolder()`)
    if (importedModel.state !== 'ready') {
      throw new Error(`Offline semantic model import failed: ${JSON.stringify(importedModel)}`)
    }

    for (let i = 0; i < 40; i++) {
      const ready = await evaluate(
        cdp,
        `(() => {
          const btn = document.querySelector('[data-testid="metadata-start-btn"]')
          return Boolean(btn && !btn.disabled)
        })()`
      )
      if (ready) break
      await sleep(100)
    }

    // Start rAF frame interval recorder in renderer
    await evaluate(
      cdp,
      `(() => {
        window.__frameTimes = []
        window.__recording = true
        let last = performance.now()
        function tick(now) {
          if (!window.__recording) return
          window.__frameTimes.push(now - last)
          last = now
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })()`
    )

    // Start semantic indexing first so the vision session initializes
    await evaluate(cdp, `window.api.startSemanticIndexing()`)

    // Await semantic indexing active in worker pool before launching metadata extraction
    for (let i = 0; i < 80; i++) {
      const diag = await evaluate(cdp, `window.api.getPhotosDiagnostics()`)
      if ((diag?.activeSemanticTasks ?? 0) > 0 || (diag?.semanticModelLoadedWorkers ?? 0) > 0) {
        break
      }
      await sleep(80)
    }

    // Launch metadata extraction so BOTH jobs compete concurrently across the worker pool!
    await evaluate(cdp, `document.querySelector('[data-testid="metadata-start-btn"]').click()`)

    const ipcLatencies = []
    let peakLiveWorkers = 0
    let peakActiveWorkers = 0
    let peakTerminatingWorkers = 0
    let peakActiveSemanticTasks = 0
    let peakActiveMetadataTasks = 0
    let peakLoadedModelWorkers = 0
    let peakQueuedJobs = 0
    let peakMainEventLoopP95 = 0
    let peakMainProcessRssBytes = 0
    let peakWorkerIsolateHeapBytes = 0
    let peakMountedCells = 0
    let peakRendererJsHeapBytes = 0
    let sawConcurrentActivity = false
    let sawSimultaneousActiveTasks = false

    let finalMetaProg = null
    let finalSemProg = null

    for (let step = 0; step < 400; step++) {
      const scrollPos = (step % 12) * 320
      await evaluate(
        cdp,
        `(() => {
          const el = document.querySelector('.photos-grid-container')
          if (el) { el.scrollTop = ${scrollPos}; el.dispatchEvent(new Event('scroll')) }
        })()`
      )

      const t0 = performance.now()
      await evaluate(cdp, `window.api.getAppInfo()`)
      ipcLatencies.push(performance.now() - t0)

      const diag = await evaluate(cdp, `window.api.getPhotosDiagnostics()`)
      if (diag) {
        peakLiveWorkers = Math.max(peakLiveWorkers, diag.liveWorkers ?? diag.activeWorkers)
        peakActiveWorkers = Math.max(peakActiveWorkers, diag.activeWorkers)
        peakTerminatingWorkers = Math.max(peakTerminatingWorkers, diag.terminatingWorkers ?? 0)
        peakActiveSemanticTasks = Math.max(peakActiveSemanticTasks, diag.activeSemanticTasks ?? 0)
        peakActiveMetadataTasks = Math.max(peakActiveMetadataTasks, diag.activeMetadataTasks ?? 0)
        peakLoadedModelWorkers = Math.max(
          peakLoadedModelWorkers,
          diag.semanticModelLoadedWorkers ?? 0
        )
        peakQueuedJobs = Math.max(peakQueuedJobs, diag.queuedJobs)
        if ((diag.activeSemanticTasks ?? 0) > 0 || (diag.activeMetadataTasks ?? 0) > 0) {
          sawConcurrentActivity = true
        }
        if ((diag.activeSemanticTasks ?? 0) > 0 && (diag.activeMetadataTasks ?? 0) > 0) {
          sawSimultaneousActiveTasks = true
        }
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

      const [mProg, sProg] = await Promise.all([
        evaluate(cdp, `window.api.getPhotoMetadataProgress()`),
        evaluate(cdp, `window.api.getSemanticIndexProgress()`)
      ])
      if (mProg.status === 'running' && sProg.status === 'running') {
        sawConcurrentActivity = true
      }
      if (
        (mProg.status === 'completed' || mProg.status === 'failed') &&
        (sProg.status === 'completed' || sProg.status === 'failed')
      ) {
        finalMetaProg = mProg
        finalSemProg = sProg
        break
      }
      await sleep(50)
    }

    await evaluate(cdp, `window.__recording = false`)
    const rawFrameTimes = await evaluate(cdp, `window.__frameTimes`)

    if (!finalMetaProg || finalMetaProg.status !== 'completed') {
      throw new Error(
        `Expected metadata extraction completion, got: ${JSON.stringify(finalMetaProg)}`
      )
    }
    if (!finalSemProg || finalSemProg.status !== 'completed') {
      throw new Error(`Expected semantic indexing completion, got: ${JSON.stringify(finalSemProg)}`)
    }
    if (!sawConcurrentActivity) {
      throw new Error('Expected active worker sampling during concurrent metadata + semantic run')
    }
    if (!sawSimultaneousActiveTasks) {
      throw new Error(
        'Expected observed simultaneous active metadata and semantic worker tasks in diagnostics'
      )
    }
    if (finalMetaProg.coverage.unprocessedCount !== 0) {
      throw new Error(
        `Expected 0 unprocessed photos after final metadata run, got: ${finalMetaProg.coverage.unprocessedCount}`
      )
    }

    const frameTimes = (Array.isArray(rawFrameTimes) ? rawFrameTimes : [])
      .filter((t) => typeof t === 'number' && t > 0)
      .sort((a, b) => a - b)
    if (frameTimes.length < 50) {
      throw new Error(
        `Meaningful nonempty frame-sample set required; sampled only ${frameTimes.length} frames (bound >= 50)`
      )
    }
    const frameP95 = frameTimes[Math.floor(frameTimes.length * 0.95)] ?? 0
    const frameMax = frameTimes[frameTimes.length - 1] ?? 0

    ipcLatencies.sort((a, b) => a - b)
    const ipcP95 = ipcLatencies[Math.floor(ipcLatencies.length * 0.95)] ?? 0
    const ipcMax = ipcLatencies[ipcLatencies.length - 1] ?? 0

    console.log('\n================ Stage 6C Resource & Responsiveness Evidence ================')
    console.log(
      `  Execution mode: ${mode} (99 real image files on disk; 50,001-row SQL scale verified in Vitest)`
    )
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
      `  Task concurrency: peakActiveMetadataTasks=${peakActiveMetadataTasks} (bound <= 1), peakActiveSemanticTasks=${peakActiveSemanticTasks} (bound <= 1), peakLoadedModelWorkers=${peakLoadedModelWorkers} (bound <= 1)`
    )
    console.log(
      `  Queue & DOM bounds: peakQueuedJobs=${peakQueuedJobs} (bound <= 64), peakMountedCells=${peakMountedCells} (bound <= 200)`
    )
    console.log(
      `  Sampled memory maxima: Main RSS=${(peakMainProcessRssBytes / (1024 * 1024)).toFixed(2)} MiB, Worker Isolate Heap=${(peakWorkerIsolateHeapBytes / (1024 * 1024)).toFixed(2)} MiB, Renderer JS Heap=${(peakRendererJsHeapBytes / (1024 * 1024)).toFixed(2)} MiB`
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
    if (peakActiveMetadataTasks > 1) {
      throw new Error(`Peak active metadata tasks (${peakActiveMetadataTasks}) exceeded bound of 1`)
    }
    if (peakLoadedModelWorkers > 1) {
      throw new Error(`Peak loaded model workers (${peakLoadedModelWorkers}) exceeded bound of 1`)
    }
    if (peakQueuedJobs > 64) {
      throw new Error(`Peak queued jobs (${peakQueuedJobs}) exceeded bound of 64`)
    }
    if (peakMountedCells > 200) {
      throw new Error(`Peak mounted DOM cells (${peakMountedCells}) exceeded bound of 200`)
    }
    pass(
      'Interactive virtual-grid browsing during concurrent metadata extraction + ONNX semantic indexing satisfied all unrelaxed frame, event-loop, IPC, worker, queue, and DOM bounds'
    )

    // =========================================================================
    // Phase 7: Original-Source Preservation Invariance + Honest atime Report
    // =========================================================================
    const modelSourceReport = assertDirectoryUnchangedAndCountAtimeUpdates(
      offlineModelFixtureDir,
      offlineModelBaselines,
      'Offline Model Fixture Dir'
    )
    const photoSourceReport = assertDirectoryUnchangedAndCountAtimeUpdates(
      immutablePhotosDir,
      immutableSourceBaseline,
      'Immutable Photo Sources Dir'
    )
    console.log(
      `  [Source Preservation] ${photoSourceReport.totalFiles} source photos verified bitwise identical (SHA-256, byteSize, birthtimeMs, mtimeMs unchanged; OS updated atimeMs on ${photoSourceReport.atimeChangedCount}/${photoSourceReport.totalFiles} read-only opens — source files are never touched with utimes).`
    )
    if (modelSourceReport.totalFiles !== 7) {
      throw new Error('Unexpected model file count')
    }
    pass(
      'Bitwise source preservation invariance confirmed across all 66 immutable source photos and 7 model files (SHA-256, byte size, creation time, and modification time unchanged)'
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
      `\n>>> ALL ${passCount} REAL-ELECTRON STAGE 6C METADATA & SQL FILTER CHECKS PASSED (${mode.toUpperCase()}) <<<\n`
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
    await sleep(300)
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
      // ignore Windows transient handle release delay
    }
  }
}

main().catch((err) => {
  console.error('\nStage 6C Real-Electron Verification Failed:', err)
  process.exit(1)
})
