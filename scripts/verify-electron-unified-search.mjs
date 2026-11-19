#!/usr/bin/env node
/**
 * Personal Vault — Stage 7F Slice 3 Real Electron Unified Search Verification
 *
 * Exercises built and isolated unpacked Electron from a neutral cwd (`tmpdir()`):
 * 1. Sandboxed preload check (`out/preload/index.js` requires only `electron`) & unpacked
 *    native ONNX runtime / zero `spikes/` packaging check.
 * 2. Offline partial-availability check: BGE provisioned & indexed while CLIP is missing ->
 *    All Items search delivers Documents results, discloses Photos unprovisioned, and performs
 *    0 automatic downloads.
 * 3. Full mixed-media indexing (22 indexed photos + 1 unindexed, 23 indexed documents incl.
 *    native, OCR PDF, oversized truncated ledger, clutter README.md + 1 unindexed doc track).
 * 4. Independent modality delivery via deterministic worker barriers (Photos fast / Docs held,
 *    and Docs fast / Photos held), Native/OCR provenance, inert `<pre>` XSS safety, and
 *    partial-index disclosures.
 * 5. Independent modality paging (limit=20, Next page preserves other section) & explicitly
 *    scoped quick filters (`Hide clutter`, `Doc extension`, `Text source`, `Photo format`) +
 *    `aria-live` scope disclosures and modality toggling.
 * 6. Corrupt model state, queue saturation (`overloaded`), and isolated per-modality error/retry.
 * 7. Deterministic concurrency races: rapid query replacement, Clear, Escape, and navigation
 *    while both workers are held at barriers -> late results never overwrite newer results or
 *    restore cleared search, and destination tab searches are never cancelled by unified cleanup.
 * 8. Real rendered Chromium layout & keyboard flows at 480x820 and 360x480 (content viewport,
 *    jump links, Tab/Enter/Escape reachability, focus restoration, zero overflow/clipping).
 * 9. Restart persistence (models, OCR, classification, CLIP/BGE indexes, clutter filtering)
 *    and 100% bitwise source & model-cache preservation.
 */

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'
import electronPath from 'electron'
import sharp from 'sharp'

const __dirname = resolve(fileURLToPath(import.meta.url), '..')
const rootDir = resolve(__dirname, '..')
const mode = process.argv.includes('--mode=unpacked') ? 'unpacked' : 'built'
const shouldRebuild = process.argv.includes('--rebuild')
const executableArg =
  process.argv.find((arg) => arg.startsWith('--exe=')) ??
  process.argv.find((arg) => arg.startsWith('--executable='))
const explicitExecutable = executableArg
  ? executableArg.startsWith('--exe=')
    ? executableArg.slice('--exe='.length)
    : executableArg.slice('--executable='.length)
  : null

const cachedClipModelDir = resolve(
  rootDir,
  'spikes',
  'semantic-eval',
  '.model-cache',
  'Xenova--clip-vit-base-patch32'
)
const cachedBgeModelDir = resolve(
  rootDir,
  'spikes',
  'doc-semantic-eval',
  '.model-cache',
  'bge-small-en-v1.5'
)
const cachedOcrModelDir = resolve(
  rootDir,
  'spikes',
  'ocr-eval',
  '.model-cache',
  'tessdata_fast_eng@65727574'
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function snapshotTree(dirPath) {
  const snap = new Map()
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(abs)
      } else if (entry.isFile()) {
        const st = statSync(abs)
        snap.set(abs, {
          size: st.size,
          birthtimeMs: st.birthtimeMs,
          mtimeMs: st.mtimeMs,
          sha: sha256File(abs)
        })
      }
    }
  }
  walk(dirPath)
  return snap
}

function assertTreePreserved(dirPath, baseline, label) {
  const current = snapshotTree(dirPath)
  if (current.size !== baseline.size) {
    throw new Error(`[${label}] File count changed: ${baseline.size} -> ${current.size}`)
  }
  for (const [abs, prev] of baseline.entries()) {
    const cur = current.get(abs)
    if (!cur) throw new Error(`[${label}] Missing file: ${abs}`)
    if (cur.size !== prev.size) {
      throw new Error(`[${label}] Byte size changed for ${abs}: ${prev.size} -> ${cur.size}`)
    }
    if (cur.sha !== prev.sha) {
      throw new Error(`[${label}] SHA-256 changed for ${abs}`)
    }
    if (Math.abs(cur.mtimeMs - prev.mtimeMs) > 0.5) {
      throw new Error(`[${label}] mtimeMs changed for ${abs}: ${prev.mtimeMs} -> ${cur.mtimeMs}`)
    }
    if (Math.abs(cur.birthtimeMs - prev.birthtimeMs) > 0.5) {
      throw new Error(
        `[${label}] birthtimeMs changed for ${abs}: ${prev.birthtimeMs} -> ${cur.birthtimeMs}`
      )
    }
  }
}

function assertCatalogFactsMatchDisk(photos, docs, diskBaselines, label) {
  const expectedByPath = new Map()
  for (const base of diskBaselines) {
    for (const [abs, facts] of base.entries()) {
      expectedByPath.set(abs, facts)
    }
  }
  if (photos.length + docs.length !== expectedByPath.size) {
    throw new Error(
      `[${label}] Catalog count mismatch: photos=${photos.length}, docs=${docs.length}, disk=${expectedByPath.size}`
    )
  }
  for (const p of photos) {
    const disk = expectedByPath.get(p.originalPath)
    if (!disk) throw new Error(`[${label}] Unknown photo path in catalog: ${p.originalPath}`)
    if (p.byteSize !== disk.size) {
      throw new Error(`[${label}] Photo byteSize mismatch for ${p.originalPath}`)
    }
    if (p.activeHash?.toLowerCase() !== disk.sha.toLowerCase()) {
      throw new Error(`[${label}] Photo activeHash mismatch for ${p.originalPath}`)
    }
    if (
      p.filesystemMtimeMs === null ||
      Math.abs(p.filesystemMtimeMs - disk.mtimeMs) > 1 ||
      p.filesystemBirthtimeMs === null ||
      Math.abs(p.filesystemBirthtimeMs - disk.birthtimeMs) > 1
    ) {
      throw new Error(`[${label}] Photo timestamps mismatch for ${p.originalPath}`)
    }
    if (p.inferredCaptureTimeMs !== null) {
      throw new Error(
        `[${label}] Synthetic photo unexpectedly fabricated inferredCaptureTimeMs=${p.inferredCaptureTimeMs}`
      )
    }
  }
  for (const d of docs) {
    const disk = expectedByPath.get(d.originalPath)
    if (!disk) throw new Error(`[${label}] Unknown doc path in catalog: ${d.originalPath}`)
    if (d.byteSize !== disk.size) {
      throw new Error(`[${label}] Doc byteSize mismatch for ${d.originalPath}`)
    }
    if (d.activeHash?.toLowerCase() !== disk.sha.toLowerCase()) {
      throw new Error(`[${label}] Doc activeHash mismatch for ${d.originalPath}`)
    }
    if (
      d.filesystemMtimeMs === null ||
      Math.abs(d.filesystemMtimeMs - disk.mtimeMs) > 1 ||
      d.filesystemBirthtimeMs === null ||
      Math.abs(d.filesystemBirthtimeMs - disk.birthtimeMs) > 1
    ) {
      throw new Error(`[${label}] Doc timestamps mismatch for ${d.originalPath}`)
    }
  }
}

function buildSyntheticScannedPdf(textLines) {
  const canvas = createCanvas(900, 320)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, 900, 320)
  ctx.fillStyle = '#000000'
  ctx.font = 'bold 40px sans-serif'
  textLines.forEach((line, idx) => ctx.fillText(line, 36, 95 + idx * 75))
  const jpegBuf = canvas.toBuffer('image/jpeg', 92)
  const streamContent = 'q 500 0 0 180 56 500 cm /Im0 Do Q'
  const obj1 = '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'
  const obj2 = '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n'
  const obj3 =
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n'
  const obj4Head = Buffer.from(
    `4 0 obj\n<< /Type /XObject /Subtype /Image /Width 900 /Height 320 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBuf.length} >>\nstream\n`,
    'latin1'
  )
  const obj4Tail = Buffer.from('\nendstream\nendobj\n', 'latin1')
  const obj5 = `5 0 obj\n<< /Length ${Buffer.byteLength(streamContent, 'latin1')} >>\nstream\n${streamContent}\nendstream\nendobj\n`
  const chunks = [Buffer.from('%PDF-1.4\n', 'latin1')]
  const offsets = [0]
  let pos = chunks[0].length
  const push = (b) => {
    offsets.push(pos)
    chunks.push(b)
    pos += b.length
  }
  push(Buffer.from(obj1, 'latin1'))
  push(Buffer.from(obj2, 'latin1'))
  push(Buffer.from(obj3, 'latin1'))
  offsets.push(pos)
  chunks.push(obj4Head, jpegBuf, obj4Tail)
  pos += obj4Head.length + jpegBuf.length + obj4Tail.length
  push(Buffer.from(obj5, 'latin1'))
  const xrefPos = pos
  let xref = 'xref\n0 6\n0000000000 65535 f \n'
  for (let i = 1; i <= 5; i += 1) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  xref += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`
  chunks.push(Buffer.from(xref, 'latin1'))
  return Buffer.concat(chunks)
}

function getFreePort() {
  return new Promise((resolvePort, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close((err) => (err ? reject(err) : resolvePort(port)))
    })
  })
}

async function waitForCdpTarget(port, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      if (res.ok) {
        const targets = await res.json()
        const target = targets.find(
          (t) =>
            t.type === 'page' &&
            typeof t.webSocketDebuggerUrl === 'string' &&
            !t.url.startsWith('devtools://')
        )
        if (target) return target
      }
    } catch {
      // retry
    }
    await sleep(200)
  }
  throw new Error(`Timed out waiting for CDP target on port ${port}`)
}

async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', rej, { once: true })
  })
  let msgId = 1
  const pending = new Map()
  const runtimeErrors = []
  const rejectAll = (reason) => {
    for (const { reject: pReject } of pending.values()) {
      pReject(new Error(reason))
    }
    pending.clear()
  }
  ws.addEventListener('close', () => rejectAll('CDP WebSocket closed'))
  ws.addEventListener('error', () => rejectAll('CDP WebSocket error'))
  ws.onmessage = (evt) => {
    const data = JSON.parse(String(evt.data))
    if (data.id && pending.has(data.id)) {
      const { resolve: pResolve, reject: pReject } = pending.get(data.id)
      pending.delete(data.id)
      if (data.error) pReject(new Error(data.error.message))
      else pResolve(data.result)
    } else if (data.method === 'Runtime.exceptionThrown') {
      runtimeErrors.push(JSON.stringify(data.params?.exceptionDetails ?? data.params))
    } else if (data.method === 'Runtime.consoleAPICalled' && data.params?.type === 'error') {
      runtimeErrors.push(
        `console.error: ${JSON.stringify(data.params.args?.map((a) => a.value ?? a.description))}`
      )
    }
  }
  const call = (method, params = {}) => {
    const id = msgId++
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          rej(new Error(`CDP call timed out: ${method}`))
        }
      }, 25000)
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          res(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          rej(e)
        }
      })
      ws.send(JSON.stringify({ id, method, params }))
    })
  }
  const evaluate = async (expression) => {
    const res = await call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (res.exceptionDetails) {
      throw new Error(
        `Renderer evaluation error: ${res.exceptionDetails.text} ${JSON.stringify(res.exceptionDetails.exception)}`
      )
    }
    return res.result?.value
  }
  await call('Runtime.enable')
  return { ws, call, evaluate, runtimeErrors }
}

function launchElectron(userDataDir, port, extraEnv = {}) {
  const neutralCwd = tmpdir()
  const commonArgs = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-sandbox'
  ]
  const env = {
    ...process.env,
    PV_TEST_MODEL_IMPORT_DIR: cachedClipModelDir,
    PV_TEST_DOC_MODEL_IMPORT_DIR: cachedBgeModelDir,
    PV_TEST_OCR_MODEL_IMPORT_DIR: cachedOcrModelDir,
    ...extraEnv
  }

  if (mode === 'unpacked') {
    const unpackedDir =
      process.env.PV_UNPACKED_DIR || join(rootDir, 'dist-stage-7f-verify', 'win-unpacked')
    const exePath = explicitExecutable || join(unpackedDir, 'Personal Vault.exe')
    if (!existsSync(exePath)) {
      throw new Error(`Unpacked executable not found: ${exePath}`)
    }
    return spawn(exePath, commonArgs, { cwd: neutralCwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  }

  return spawn(String(electronPath), [rootDir, ...commonArgs], {
    cwd: neutralCwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

async function stopElectron(proc, ws) {
  try {
    ws?.close()
  } catch {
    // ignore
  }
  if (!proc || proc.killed || proc.exitCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    proc.kill('SIGKILL')
  }
  await sleep(350)
}

async function waitForCondition(evaluate, expr, description, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const val = await evaluate(expr)
    if (val) return val
    await sleep(100)
  }
  throw new Error(`Timed out waiting for: ${description}`)
}

async function waitForFile(filePath, description, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return
    await sleep(25)
  }
  throw new Error(`Timed out waiting for file (${description}): ${filePath}`)
}

async function submitHeaderQuery(evaluate, queryText, useEnterKey = true) {
  await evaluate(`(() => {
    const input = document.querySelector('header input[type="search"]');
    if (!input) throw new Error('Header search input missing');
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(queryText)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    if (${useEnterKey ? 'true' : 'false'}) {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    } else {
      input.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }
  })()`)
}

async function main() {
  console.log(
    `\n=== Personal Vault: Stage 7F Slice 3 Unified Search Verification (${mode.toUpperCase()}) ===\n`
  )

  if (mode === 'unpacked' && shouldRebuild) {
    console.log('[INFO] Rebuilding isolated unpacked executable in dist-stage-7f-verify...')
    const res = spawnSync(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['electron-builder', '--win', 'dir', '--config.directories.output=dist-stage-7f-verify'],
      { cwd: rootDir, stdio: 'inherit', shell: true }
    )
    if (res.status !== 0) {
      throw new Error(`electron-builder failed with exit code ${res.status}`)
    }
  }

  if (mode === 'unpacked') {
    const unpackedDir =
      process.env.PV_UNPACKED_DIR || join(rootDir, 'dist-stage-7f-verify', 'win-unpacked')
    const ortBinding = join(
      unpackedDir,
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
      throw new Error(`Missing unpacked ONNX Runtime native binary: ${ortBinding}`)
    }
    const unpackedSpikes = join(unpackedDir, 'resources', 'app.asar.unpacked', 'spikes')
    if (existsSync(unpackedSpikes)) {
      throw new Error(`Unexpected spikes/ bundled in unpacked app: ${unpackedSpikes}`)
    }
    console.log(
      '[PASS] 1a. Unpacked native ONNX Runtime binding verified with zero bundled spikes/'
    )
  }

  const preloadPath = join(rootDir, 'out', 'preload', 'index.js')
  if (!existsSync(preloadPath)) {
    throw new Error(`Missing compiled preload bundle: ${preloadPath}. Run npm run build first.`)
  }
  const preloadCode = readFileSync(preloadPath, 'utf8')
  const preloadRequires = [...preloadCode.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1])
  if (!preloadRequires.every((m) => m === 'electron')) {
    throw new Error(
      `Sandboxed preload requires non-electron modules: ${preloadRequires.join(', ')}`
    )
  }
  console.log('[PASS] 1. Sandboxed preload check: requires=[electron]')

  for (const [label, dir] of [
    ['CLIP', cachedClipModelDir],
    ['BGE', cachedBgeModelDir],
    ['OCR', cachedOcrModelDir]
  ]) {
    if (!existsSync(dir)) {
      throw new Error(`Missing cached ${label} model directory: ${dir}`)
    }
  }
  const clipCacheBaseline = snapshotTree(cachedClipModelDir)
  const bgeCacheBaseline = snapshotTree(cachedBgeModelDir)
  const ocrCacheBaseline = snapshotTree(cachedOcrModelDir)

  const tempRoot = mkdtempSync(join(tmpdir(), `pv-unified-s3-${mode}-`))
  const userDataDir = join(tempRoot, 'user-data')
  const barrierDir = join(tempRoot, 'barriers')
  const fixturesMain = join(tempRoot, 'fixtures-main')
  const fixturesUnindexed = join(tempRoot, 'fixtures-unindexed')
  const photosDir = join(fixturesMain, 'photos')
  const docsDir = join(fixturesMain, 'documents')
  const docsRepoDir = join(docsDir, 'repos', 'pkg-0')
  mkdirSync(userDataDir, { recursive: true })
  mkdirSync(barrierDir, { recursive: true })
  mkdirSync(photosDir, { recursive: true })
  mkdirSync(docsRepoDir, { recursive: true })
  mkdirSync(join(fixturesUnindexed, 'photos'), { recursive: true })
  mkdirSync(join(fixturesUnindexed, 'documents'), { recursive: true })

  // Generate 22 synthetic mixed-format photos
  const heroPhotos = [
    {
      name: 'mountain_sunrise.jpg',
      format: 'jpeg',
      svg: `<svg width="480" height="360" xmlns="http://www.w3.org/2000/svg">
        <rect width="480" height="360" fill="#4ea8de"/>
        <circle cx="370" cy="85" r="42" fill="#ffe066"/>
        <polygon points="150,90 10,330 290,330" fill="#495057"/>
        <polygon points="150,90 105,170 150,155 195,170" fill="#ffffff"/>
        <polygon points="320,120 170,330 470,330" fill="#6c757d"/>
        <polygon points="320,120 270,195 320,180 370,195" fill="#f8f9fa"/>
      </svg>`
    },
    {
      name: 'bicycle_park.png',
      format: 'png',
      svg: `<svg width="480" height="360" xmlns="http://www.w3.org/2000/svg">
        <rect width="480" height="240" fill="#90e0ef"/>
        <rect y="240" width="480" height="120" fill="#52b788"/>
        <circle cx="150" cy="240" r="48" fill="none" stroke="#1b4332" stroke-width="10"/>
        <circle cx="330" cy="240" r="48" fill="none" stroke="#1b4332" stroke-width="10"/>
        <line x1="150" y1="240" x2="235" y2="180" stroke="#d90429" stroke-width="10"/>
        <line x1="235" y1="180" x2="330" y2="240" stroke="#d90429" stroke-width="10"/>
        <line x1="150" y1="240" x2="255" y2="240" stroke="#d90429" stroke-width="10"/>
      </svg>`
    },
    {
      name: 'receipt_counter.webp',
      format: 'webp',
      svg: `<svg width="480" height="360" xmlns="http://www.w3.org/2000/svg">
        <rect width="480" height="360" fill="#8d99ae"/>
        <rect x="130" y="30" width="220" height="300" fill="#ffffff" stroke="#2b2d42" stroke-width="4"/>
        <rect x="155" y="65" width="170" height="14" fill="#2b2d42"/>
        <rect x="155" y="105" width="130" height="10" fill="#6c757d"/>
        <rect x="155" y="135" width="150" height="10" fill="#6c757d"/>
        <rect x="155" y="255" width="170" height="16" fill="#d90429"/>
      </svg>`
    },
    {
      name: 'sunset_beach.jpg',
      format: 'jpeg',
      svg: `<svg width="480" height="360" xmlns="http://www.w3.org/2000/svg">
        <rect width="480" height="230" fill="#ff784f"/>
        <circle cx="240" cy="180" r="56" fill="#fff3b0"/>
        <rect y="230" width="480" height="130" fill="#1d3557"/>
      </svg>`
    },
    {
      name: 'evergreen_forest.png',
      format: 'png',
      svg: `<svg width="480" height="360" xmlns="http://www.w3.org/2000/svg">
        <rect width="480" height="360" fill="#cfe8ff"/>
        <rect y="270" width="480" height="90" fill="#2d6a4f"/>
        <polygon points="140,70 50,270 230,270" fill="#1b4332"/>
        <polygon points="320,60 220,270 420,270" fill="#081c15"/>
      </svg>`
    }
  ]

  for (const p of heroPhotos) {
    const pipeline = sharp(Buffer.from(p.svg))
    const buf =
      p.format === 'png'
        ? await pipeline.png().toBuffer()
        : p.format === 'webp'
          ? await pipeline.webp().toBuffer()
          : await pipeline.jpeg({ quality: 90 }).toBuffer()
    writeFileSync(join(photosDir, p.name), buf)
  }

  // 17 additional landscape/mountain/outdoor photos so Page 1 -> Page 2 (limit=20) works
  for (let i = 1; i <= 17; i++) {
    const r = (40 + i * 11) % 220
    const g = (110 + i * 7) % 220
    const b = (160 + i * 5) % 240
    const svg = `<svg width="320" height="240" xmlns="http://www.w3.org/2000/svg">
      <rect width="320" height="240" fill="rgb(${r},${g},${b})"/>
      <polygon points="160,${40 + (i % 5) * 8} 30,220 290,220" fill="#495057"/>
      <polygon points="160,${40 + (i % 5) * 8} 120,110 200,110" fill="#f8f9fa"/>
    </svg>`
    const buf =
      i % 4 === 0
        ? await sharp(Buffer.from(svg)).png().toBuffer()
        : await sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer()
    writeFileSync(
      join(
        photosDir,
        `gallery_outdoor_${String(i).padStart(2, '0')}.${i % 4 === 0 ? 'png' : 'jpg'}`
      ),
      buf
    )
  }

  // 23 synthetic documents in fixturesMain/documents
  writeFileSync(
    join(docsDir, 'mountain_trail_guide.txt'),
    'Personal Mountain Trail Guide and Packing Notes.\n' +
      'Ridge hike starts at Pine Lake trailhead, climbs 2,400 feet to Alpine Summit.\n' +
      'Pack headlamp, rain shell, water filter, and bicycle lock for base camp.\n',
    'utf8'
  )
  writeFileSync(
    join(docsDir, 'bicycle_repair_notes.md'),
    '# Bicycle Tune-Up & Mountain Bike Maintenance\n' +
      'Inspect hydraulic disc brakes, lubricate chain, true front wheel, and check tire pressure.\n' +
      'Safety probe: <script>window.__pvUnifiedXss = 1</script> kept inert.\n',
    'utf8'
  )
  writeFileSync(
    join(docsDir, 'grocery_receipt.txt'),
    'Receipt #402\nOat milk $4.20\nApples $3.80\nSubtotal: $8.00\nTotal: $8.64\nPaid Card\n',
    'utf8'
  )
  writeFileSync(
    join(docsDir, 'scanned_ocr_receipt.pdf'),
    buildSyntheticScannedPdf([
      'PHARMACY PRESCRIPTION RECEIPT',
      'BICYCLE HELMET FIRST AID KIT',
      'COPAY TOTAL DUE 45 USD'
    ])
  )
  writeFileSync(
    join(docsDir, 'oversized_mountain_ledger.txt'),
    'Annual mountain bicycle trail switch ledger entry and ridge weather inspection.\n' +
      'Routine calibration log line for alpine weather station.\n'.repeat(18000),
    'utf8'
  )
  writeFileSync(
    join(docsRepoDir, 'README.md'),
    '# pkg-0 Mountain Telemetry Utility\n\n' +
      'SPDX-License-Identifier: MIT\n\n' +
      'Install dependencies from `package.json` and build using `tsconfig.json` for mountain bicycle telemetry.\n\n' +
      '```bash\nnpm install\nnpm run build\n```\n',
    'utf8'
  )
  for (let i = 1; i <= 17; i++) {
    const ext = i % 3 === 0 ? 'md' : 'txt'
    writeFileSync(
      join(docsDir, `doc_outdoor_${String(i).padStart(2, '0')}.${ext}`),
      `Outdoor journal entry ${i}: mountain bicycle trail loop #${i}, alpine pass notes, and receipt checklist.\n`,
      'utf8'
    )
  }

  // Unindexed items scanned later to produce genuine unindexedCount >= 1 & unindexedTracks >= 1
  const unindexedPhotoBuf = await sharp({
    create: { width: 240, height: 180, channels: 3, background: { r: 90, g: 150, b: 200 } }
  })
    .jpeg({ quality: 85 })
    .toBuffer()
  writeFileSync(join(fixturesUnindexed, 'photos', 'unindexed_photo.jpg'), unindexedPhotoBuf)
  writeFileSync(
    join(fixturesUnindexed, 'documents', 'unindexed_late_note.txt'),
    'Late unindexed mountain bicycle note added after initial indexing.\n',
    'utf8'
  )

  const fixturesMainBaseline = snapshotTree(fixturesMain)
  const fixturesUnindexedBaseline = snapshotTree(fixturesUnindexed)
  console.log(
    `[PASS] 2. Synthetic mixed-media fixtures created (${fixturesMainBaseline.size} main + ${fixturesUnindexedBaseline.size} unindexed files)`
  )

  let proc = null
  let cdp = null

  try {
    const port1 = await getFreePort()
    proc = launchElectron(userDataDir, port1, { PV_TEST_SEARCH_BARRIER_DIR: barrierDir })
    const target1 = await waitForCdpTarget(port1)
    cdp = await connectCdp(target1.webSocketDebuggerUrl)

    await waitForCondition(
      cdp.evaluate,
      `Boolean(window.api && typeof window.api.searchUnifiedPhotos === 'function' && typeof window.api.searchUnifiedDocuments === 'function' && typeof window.api.cancelUnifiedSearch === 'function')`,
      'window.api unified search mount'
    )

    // Verify zero automatic downloads on initial startup
    const initModels = await cdp.evaluate(`(async () => ({
      clip: await window.api.getSemanticModelStatus(),
      bge: await window.api.getDocSemanticModelStatus(),
      ocr: await window.api.getOcrModelStatus()
    }))()`)
    if (initModels.clip.state !== 'missing' || initModels.bge.state !== 'unprovisioned') {
      throw new Error(
        `Unexpected auto-provisioned models on clean userData: ${JSON.stringify(initModels)}`
      )
    }

    // Scan fixturesMain
    await cdp.evaluate(`(async () => {
      const start = await window.api.startScan({ roots: [${JSON.stringify(fixturesMain)}] });
      if (!start.success) throw new Error('Scan start failed: ' + JSON.stringify(start));
      for (let i = 0; i < 120; i++) {
        const latest = await window.api.getLatestScanJob();
        if (latest?.job?.status === 'completed') return true;
        if (latest?.job?.status === 'failed') throw new Error('Scan failed: ' + JSON.stringify(latest.job));
        await new Promise((r) => setTimeout(r, 150));
      }
      throw new Error('Scan timed out');
    })()`)

    // Provision ONLY BGE + OCR in Documents tab, extract, OCR, classify, and index documents (leave CLIP missing!)
    await cdp.evaluate(`(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('Documents'));
      btn?.click();
    })()`)
    await waitForCondition(
      cdp.evaluate,
      `Boolean(document.querySelector('[data-testid="doc-semantic-model-import-btn"]'))`,
      'Documents tab mount'
    )
    await cdp.evaluate(`(async () => {
      document.querySelector('[data-testid="documents-extract-scope-btn"]')?.click();
      for (let i = 0; i < 160; i++) {
        const p = await window.api.getDocumentExtractionProgress();
        if (p?.status === 'completed') break;
        if (p?.status === 'failed') throw new Error('Extraction failed: ' + JSON.stringify(p));
        await new Promise((r) => setTimeout(r, 150));
      }

      document.querySelector('[data-testid="ocr-model-import-btn"]')?.click();
      for (let i = 0; i < 80; i++) {
        const st = await window.api.getOcrModelStatus();
        if (st?.state === 'ready') break;
        await new Promise((r) => setTimeout(r, 150));
      }

      document.querySelector('[data-testid="documents-ocr-scope-btn"]')?.click();
      for (let i = 0; i < 200; i++) {
        const p = await window.api.getDocumentOcrProgress();
        if (p?.status === 'completed') break;
        if (p?.status === 'failed') throw new Error('OCR failed: ' + JSON.stringify(p));
        await new Promise((r) => setTimeout(r, 150));
      }

      document.querySelector('[data-testid="documents-classify-start-btn"]')?.click();
      for (let i = 0; i < 120; i++) {
        const p = await window.api.getDocumentClassificationProgress();
        if (p?.status === 'completed') break;
        if (p?.status === 'failed') throw new Error('Classify failed: ' + JSON.stringify(p));
        await new Promise((r) => setTimeout(r, 150));
      }

      document.querySelector('[data-testid="doc-semantic-model-import-btn"]')?.click();
      for (let i = 0; i < 80; i++) {
        const st = await window.api.getDocSemanticModelStatus();
        if (st?.state === 'ready') break;
        await new Promise((r) => setTimeout(r, 150));
      }

      document.querySelector('[data-testid="doc-semantic-index-start-btn"]')?.click();
      for (let i = 0; i < 240; i++) {
        const p = await window.api.getDocumentSemanticProgress();
        if (p?.status === 'completed') return p;
        if (p?.status === 'failed') throw new Error('Doc semantic indexing failed: ' + JSON.stringify(p));
        await new Promise((r) => setTimeout(r, 150));
      }
      throw new Error('Doc semantic indexing timed out');
    })()`)

    // Navigate to All Items while CLIP is STILL missing -> verify partial availability & 0 auto-downloads
    await cdp.evaluate(`(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('All Items'));
      btn?.click();
    })()`)
    await waitForCondition(
      cdp.evaluate,
      `Boolean(document.querySelector('header input[type="search"]:not(:disabled)'))`,
      'enabled header search input in All Items'
    )
    await submitHeaderQuery(cdp.evaluate, 'mountain')
    await waitForCondition(
      cdp.evaluate,
      `Boolean(document.querySelector('[data-testid="unified-documents-count"]')) && document.querySelector('[data-testid="unified-photos-section"]')?.textContent?.includes('Photo search model is not installed.')`,
      'partial availability (BGE ready, CLIP unprovisioned)'
    )
    const clipStillMissing = await cdp.evaluate(`window.api.getSemanticModelStatus()`)
    if (clipStillMissing.state !== 'missing') {
      throw new Error(
        `CLIP model unexpectedly changed state without import: ${JSON.stringify(clipStillMissing)}`
      )
    }
    console.log(
      '[PASS] 3. Partial availability & offline safety verified (Documents ready while Photos unprovisioned; 0 automatic downloads)'
    )

    // Provision CLIP via Open Photos tab button, extract photo metadata, index photos
    await cdp.evaluate(`(() => {
      const btn = Array.from(document.querySelectorAll('[data-testid="unified-photos-section"] button')).find((b) =>
        b.textContent?.includes('Open Photos tab')
      );
      btn?.click();
    })()`)
    await waitForCondition(
      cdp.evaluate,
      `Array.from(document.querySelectorAll('button')).some((b) => b.textContent?.includes('Photos'))`,
      'Photos tab navigation'
    )
    await cdp.evaluate(`(async () => {
      const imp = await window.api.importSemanticModelFromFolder();
      if (imp.state !== 'ready') throw new Error('CLIP import failed: ' + JSON.stringify(imp));
      await window.api.startPhotoMetadataExtraction({ retryFailed: false });
      for (let i = 0; i < 120; i++) {
        const p = await window.api.getPhotoMetadataProgress();
        if (p.status === 'completed') break;
        if (p.status === 'failed') throw new Error('Metadata failed: ' + JSON.stringify(p));
        await new Promise((r) => setTimeout(r, 150));
      }
      await window.api.startSemanticIndexing();
      for (let i = 0; i < 240; i++) {
        const p = await window.api.getSemanticIndexProgress();
        if (p.status === 'completed') return p;
        if (p.status === 'failed') throw new Error('CLIP indexing failed: ' + JSON.stringify(p));
        await new Promise((r) => setTimeout(r, 150));
      }
      throw new Error('CLIP indexing timed out');
    })()`)

    // Scan fixturesUnindexed and extract text on unindexed_late_note.txt WITHOUT indexing it (for unindexed disclosures)
    await cdp.evaluate(`(async () => {
      await window.api.startScan({ roots: [${JSON.stringify(fixturesUnindexed)}] });
      for (let i = 0; i < 120; i++) {
        const latest = await window.api.getLatestScanJob();
        if (latest?.job?.status === 'completed') break;
        await new Promise((r) => setTimeout(r, 150));
      }
      const page = await window.api.getDocumentsPage({ offset: 0, limit: 50, filenameQuery: 'unindexed_late_note' });
      const late = page.items[0];
      if (!late) throw new Error('Missing unindexed_late_note.txt after scan');
      await window.api.extractSelectedDocuments({ fileLocationIds: [late.fileLocationId] });
      for (let i = 0; i < 80; i++) {
        const p = await window.api.getDocumentExtractionProgress();
        if (p?.status === 'completed') break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('All Items'));
      btn?.click();
    })()`)
    await waitForCondition(
      cdp.evaluate,
      `Boolean(document.querySelector('header input[type="search"]:not(:disabled)'))`,
      'All Items ready after indexing'
    )
    const initialCatalogFacts = await cdp.evaluate(`(async () => {
      const photos = await window.api.getPhotosPage({ offset: 0, limit: 100 });
      const docs = await window.api.getDocumentsPage({ offset: 0, limit: 100 });
      return { photos: photos.items, docs: docs.items };
    })()`)
    assertCatalogFactsMatchDisk(
      initialCatalogFacts.photos,
      initialCatalogFacts.docs,
      [fixturesMainBaseline, fixturesUnindexedBaseline],
      'initial-scan'
    )
    console.log(
      `[PASS] 4. Mixed-media CLIP + BGE + OCR + Classification + unindexed fixtures & recorded facts verified (${initialCatalogFacts.photos.length} photos, ${initialCatalogFacts.docs.length} docs)`
    )

    // 5a. Independent delivery: Photos resolves while Documents is held at barrier
    const bgeMtnReady = join(barrierDir, 'bge_mtn.ready')
    const bgeMtnGate = join(barrierDir, 'bge_mtn.gate')
    writeFileSync(
      join(barrierDir, 'barriers.json'),
      JSON.stringify({
        bge: { mountain: { readyFile: bgeMtnReady, gateFile: bgeMtnGate } }
      }),
      'utf8'
    )
    await submitHeaderQuery(cdp.evaluate, 'mountain')
    await waitForFile(bgeMtnReady, 'bge mountain barrier entry')
    await waitForCondition(
      cdp.evaluate,
      `Boolean(document.querySelector('[data-testid="unified-photos-count"]'))`,
      'Photos section ready while Documents still pending'
    )
    const independent1 = await cdp.evaluate(`(() => ({
      photosReady: Boolean(document.querySelector('[data-testid="unified-photos-count"]')),
      photosCountText: document.querySelector('[data-testid="unified-photos-count"]')?.textContent ?? '',
      docsText: document.querySelector('[data-testid="unified-documents-section"]')?.textContent ?? '',
      docsHasCount: Boolean(document.querySelector('[data-testid="unified-documents-count"]'))
    }))()`)
    if (
      !independent1.photosReady ||
      independent1.docsHasCount ||
      !independent1.docsText.includes('Searching documents')
    ) {
      throw new Error(`Independent delivery (Photos first) failed: ${JSON.stringify(independent1)}`)
    }
    writeFileSync(bgeMtnGate, 'go', 'utf8')
    await waitForCondition(
      cdp.evaluate,
      `Boolean(document.querySelector('[data-testid="unified-documents-count"]'))`,
      'Documents ready after barrier release'
    )

    // 5b. Independent delivery: Documents resolves while Photos is held at barrier
    const clipBikeReady = join(barrierDir, 'clip_bike.ready')
    const clipBikeGate = join(barrierDir, 'clip_bike.gate')
    writeFileSync(
      join(barrierDir, 'barriers.json'),
      JSON.stringify({
        clip: { bicycle: { readyFile: clipBikeReady, gateFile: clipBikeGate } }
      }),
      'utf8'
    )
    await submitHeaderQuery(cdp.evaluate, 'bicycle')
    await waitForFile(clipBikeReady, 'clip bicycle barrier entry')
    await waitForCondition(
      cdp.evaluate,
      `Boolean(document.querySelector('[data-testid="unified-documents-count"]'))`,
      'Documents section ready while Photos still pending'
    )
    const independent2 = await cdp.evaluate(`(() => ({
      docsReady: Boolean(document.querySelector('[data-testid="unified-documents-count"]')),
      photosHasCount: Boolean(document.querySelector('[data-testid="unified-photos-count"]')),
      photosText: document.querySelector('[data-testid="unified-photos-section"]')?.textContent ?? '',
      xssFlag: Boolean(window.__pvUnifiedXss)
    }))()`)
    if (
      !independent2.docsReady ||
      independent2.photosHasCount ||
      !independent2.photosText.includes('Searching photos') ||
      independent2.xssFlag
    ) {
      throw new Error(
        `Independent delivery (Documents first) failed: ${JSON.stringify(independent2)}`
      )
    }
    writeFileSync(clipBikeGate, 'go', 'utf8')
    await waitForCondition(
      cdp.evaluate,
      `Boolean(document.querySelector('[data-testid="unified-photos-count"]'))`,
      'Photos ready after barrier release'
    )
    writeFileSync(join(barrierDir, 'barriers.json'), '{}', 'utf8')

    // Verify provenance badges, uncalibrated labels, partial-index disclosures, inert <pre>
    const provenanceCheck = await cdp.evaluate(`(() => {
      const photosSec = document.querySelector('[data-testid="unified-photos-section"]')?.textContent ?? '';
      const docsSec = document.querySelector('[data-testid="unified-documents-section"]')?.textContent ?? '';
      const hasClipBadge = photosSec.includes('% CLIP similarity');
      const hasBgeBadge = docsSec.includes('% BGE similarity');
      const hasNativeBadge = docsSec.includes('Native text');
      const hasPre = Boolean(document.querySelector('pre.unified-doc-snippet'));
      const hasUnindexedPhoto = photosSec.includes('1 unindexed photos');
      const hasUnindexedDoc = docsSec.includes('1 unindexed document tracks');
      return { hasClipBadge, hasBgeBadge, hasNativeBadge, hasPre, hasUnindexedPhoto, hasUnindexedDoc };
    })()`)
    if (
      !provenanceCheck.hasClipBadge ||
      !provenanceCheck.hasBgeBadge ||
      !provenanceCheck.hasNativeBadge ||
      !provenanceCheck.hasPre ||
      !provenanceCheck.hasUnindexedPhoto ||
      !provenanceCheck.hasUnindexedDoc
    ) {
      throw new Error(
        `Provenance/partial-index disclosure check failed: ${JSON.stringify(provenanceCheck)}`
      )
    }
    console.log(
      '[PASS] 5. Independent bidirectional delivery, CLIP/BGE separation, Native provenance, and unindexed disclosures verified'
    )

    // 5c. OCR provenance & oversized partial-index disclosure
    await submitHeaderQuery(cdp.evaluate, 'pharmacy prescription copay bicycle helmet')
    await waitForCondition(
      cdp.evaluate,
      `(document.querySelector('[data-testid="unified-documents-section"]')?.textContent ?? '').includes('OCR text (machine-recognized)')`,
      'OCR provenance badge in unified search'
    )
    await submitHeaderQuery(cdp.evaluate, 'annual mountain bicycle trail switch ledger')
    await waitForCondition(
      cdp.evaluate,
      `Boolean(document.querySelector('[data-testid^="unified-doc-partial-"]'))`,
      'oversized Partially indexed disclosure badge in unified search'
    )
    await submitHeaderQuery(cdp.evaluate, `mountain ${'a '.repeat(85).trim()}`)
    await waitForCondition(
      cdp.evaluate,
      `(document.querySelector('[data-testid="unified-photos-section"]')?.textContent ?? '').includes('Query truncated to 77 CLIP tokens.')`,
      '77-token CLIP truncation disclosure in unified search'
    )
    console.log(
      '[PASS] 5b. OCR text (machine-recognized) provenance, oversized Partially indexed, & 77-token CLIP truncation disclosures verified'
    )

    // 6. Paging (limit=20, independent per-modality Next) & scoped quick filters
    await submitHeaderQuery(cdp.evaluate, 'mountain')
    await waitForCondition(
      cdp.evaluate,
      `Boolean(document.querySelector('[data-testid="unified-photos-next-btn"]:not(:disabled)')) && Boolean(document.querySelector('[data-testid="unified-documents-next-btn"]:not(:disabled)'))`,
      'both modalities have Next page (> 20 results)'
    )
    const page1Snapshot = await cdp.evaluate(`(() => ({
      photoFirst: document.querySelector('.unified-photo-card .unified-result-title-btn')?.textContent ?? '',
      docFirst: document.querySelector('.unified-doc-card .unified-result-title-btn')?.textContent ?? '',
      docCount: document.querySelector('[data-testid="unified-documents-count"]')?.textContent ?? ''
    }))()`)
    await cdp.evaluate(`document.querySelector('[data-testid="unified-photos-next-btn"]')?.click()`)
    await waitForCondition(
      cdp.evaluate,
      `document.querySelector('#unified-photos-section .unified-pagination-info')?.textContent?.includes('Page 2')`,
      'Photos page 2'
    )
    const afterPhotosPage2 = await cdp.evaluate(`(() => ({
      photoFirst: document.querySelector('.unified-photo-card .unified-result-title-btn')?.textContent ?? '',
      docFirst: document.querySelector('.unified-doc-card .unified-result-title-btn')?.textContent ?? '',
      docPageInfo: document.querySelector('#unified-documents-section .unified-pagination-info')?.textContent ?? ''
    }))()`)
    if (
      afterPhotosPage2.photoFirst === page1Snapshot.photoFirst ||
      afterPhotosPage2.docFirst !== page1Snapshot.docFirst ||
      !afterPhotosPage2.docPageInfo.includes('Page 1')
    ) {
      throw new Error(
        `Independent Photos paging failed: ${JSON.stringify({ page1Snapshot, afterPhotosPage2 })}`
      )
    }
    await cdp.evaluate(
      `document.querySelector('[data-testid="unified-documents-next-btn"]')?.click()`
    )
    await waitForCondition(
      cdp.evaluate,
      `document.querySelector('#unified-documents-section .unified-pagination-info')?.textContent?.includes('Page 2')`,
      'Documents page 2'
    )
    await cdp.evaluate(`document.querySelector('[data-testid="unified-photos-prev-btn"]')?.click()`)
    await waitForCondition(
      cdp.evaluate,
      `document.querySelector('#unified-photos-section .unified-pagination-info')?.textContent?.includes('Page 1')`,
      'Photos back to page 1'
    )

    // Scoped quick filters: Hide clutter + Doc extension + Photo format + scope disclosures + modality toggle
    await submitHeaderQuery(cdp.evaluate, 'pkg-0 mountain telemetry')
    await waitForCondition(
      cdp.evaluate,
      `Array.from(document.querySelectorAll('.unified-doc-card .unified-result-title-btn')).some((b) => b.textContent === 'README.md')`,
      'README.md visible in Unified Search under Show all'
    )
    await cdp.evaluate(`(() => {
      const cb = document.querySelector('[data-testid="unified-doc-hide-clutter"]');
      cb.click();
    })()`)
    await waitForCondition(
      cdp.evaluate,
      `Boolean(document.querySelector('[data-testid="unified-filter-scope-disclosure"]')) && Boolean(document.querySelector('[data-testid="unified-doc-clutter-disclosure"]')) && !document.querySelector('[data-testid="unified-documents-section"]')?.textContent?.includes('Searching documents') && !Array.from(document.querySelectorAll('.unified-doc-card .unified-result-title-btn')).some((b) => b.textContent === 'README.md')`,
      'Hide clutter excludes README.md in UI and shows scope/clutter disclosures'
    )

    // Apply Text source (ocr), Doc extension (.md) and Photo format (png) via UI
    await cdp.evaluate(`(() => {
      const tsSel = document.querySelector('[data-testid="unified-doc-text-source"]');
      if (tsSel._valueTracker) tsSel._valueTracker.setValue('__force__');
      tsSel.value = 'ocr';
      tsSel.dispatchEvent(new Event('change', { bubbles: true }));
    })()`)
    await waitForCondition(
      cdp.evaluate,
      `Boolean(document.querySelector('[data-testid="unified-documents-count"]')) && Array.from(document.querySelectorAll('.unified-doc-card')).every((c) => c.textContent.includes('OCR text (machine-recognized)'))`,
      'Text source filter ocr'
    )
    await cdp.evaluate(`(() => {
      const tsSel = document.querySelector('[data-testid="unified-doc-text-source"]');
      if (tsSel._valueTracker) tsSel._valueTracker.setValue('__force__');
      tsSel.value = '';
      tsSel.dispatchEvent(new Event('change', { bubbles: true }));
    })()`)
    await waitForCondition(
      cdp.evaluate,
      `Boolean(document.querySelector('[data-testid="unified-documents-count"]'))`,
      'Text source filter reset to all'
    )
    await cdp.evaluate(`(() => {
      const extSel = document.querySelector('[data-testid="unified-doc-extension"]');
      if (extSel._valueTracker) extSel._valueTracker.setValue('__force__');
      extSel.value = '.md';
      extSel.dispatchEvent(new Event('change', { bubbles: true }));
    })()`)
    await waitForCondition(
      cdp.evaluate,
      `Boolean(document.querySelector('[data-testid="unified-documents-count"]')) && Array.from(document.querySelectorAll('.unified-doc-card .unified-result-title-btn')).every((b) => b.textContent.endsWith('.md'))`,
      'Doc extension filter .md'
    )
    await cdp.evaluate(`(() => {
      const pSel = document.querySelector('[data-testid="unified-photo-format-value"]');
      if (pSel._valueTracker) pSel._valueTracker.setValue('__force__');
      pSel.value = 'png';
      pSel.dispatchEvent(new Event('change', { bubbles: true }));
    })()`)
    await waitForCondition(
      cdp.evaluate,
      `Boolean(document.querySelector('[data-testid="unified-photos-count"]')) && Array.from(document.querySelectorAll('.unified-photo-card .unified-result-title-btn')).every((b) => b.textContent.endsWith('.png'))`,
      'Photo format filter png'
    )
    await cdp.evaluate(`(() => {
      const bSel = document.querySelector('[data-testid="unified-photo-format-basis"]');
      if (bSel._valueTracker) bSel._valueTracker.setValue('__force__');
      bSel.value = 'filename_extension';
      bSel.dispatchEvent(new Event('change', { bubbles: true }));
    })()`)
    await waitForCondition(
      cdp.evaluate,
      `Array.from(document.querySelectorAll('[data-testid="unified-photo-format-value"] option')).some((o) => o.value === '.jpg')`,
      'Photo filename_extension facets loaded'
    )
    await cdp.evaluate(`(() => {
      const pSel = document.querySelector('[data-testid="unified-photo-format-value"]');
      if (pSel._valueTracker) pSel._valueTracker.setValue('__force__');
      pSel.value = '.jpg';
      pSel.dispatchEvent(new Event('change', { bubbles: true }));
    })()`)
    await waitForCondition(
      cdp.evaluate,
      `Boolean(document.querySelector('[data-testid="unified-photos-count"]')) && Array.from(document.querySelectorAll('.unified-photo-card .unified-result-title-btn')).every((b) => b.textContent.endsWith('.jpg'))`,
      'Photo filename_extension filter .jpg'
    )
    await cdp.evaluate(
      `document.querySelector('[data-testid="unified-reset-filters-btn"]')?.click()`
    )
    await waitForCondition(
      cdp.evaluate,
      `!document.querySelector('[data-testid="unified-filter-scope-disclosure"]')`,
      'reset quick filters'
    )

    // Modality switch: Documents disables photo filters; Photos disables doc filters; back to All
    await cdp.evaluate(
      `document.querySelector('[data-testid="unified-modality-documents"]')?.click()`
    )
    await waitForCondition(
      cdp.evaluate,
      `!document.querySelector('[data-testid="unified-photos-section"]') && document.querySelector('[data-testid="unified-photo-format-basis"]')?.matches(':disabled') === true`,
      'Documents-only modality'
    )
    await cdp.evaluate(`document.querySelector('[data-testid="unified-modality-photos"]')?.click()`)
    await waitForCondition(
      cdp.evaluate,
      `!document.querySelector('[data-testid="unified-documents-section"]') && document.querySelector('[data-testid="unified-doc-hide-clutter"]')?.matches(':disabled') === true`,
      'Photos-only modality'
    )
    await cdp.evaluate(`document.querySelector('[data-testid="unified-modality-all"]')?.click()`)
    await waitForCondition(
      cdp.evaluate,
      `Boolean(document.querySelector('[data-testid="unified-photos-section"]')) && Boolean(document.querySelector('[data-testid="unified-documents-section"]'))`,
      'All modality restored'
    )
    console.log(
      '[PASS] 6. Independent paging, scoped quick filters, disclosures & modality switching verified'
    )

    // 7. Per-modality failure states: error + isolated UI Retry, corrupt model (overload verified in Session 2)
    // 7a. Isolated Documents UI error + Retry Documents while Photos stays ready
    const docFailFlag = join(barrierDir, 'doc_fail.flag')
    writeFileSync(docFailFlag, 'fail', 'utf8')
    writeFileSync(
      join(barrierDir, 'barriers.json'),
      JSON.stringify({ bge: { 'retry test': { failIfExists: docFailFlag } } }),
      'utf8'
    )
    await submitHeaderQuery(cdp.evaluate, 'retry test')
    await waitForCondition(
      cdp.evaluate,
      `Boolean(document.querySelector('[data-testid="unified-photos-count"]')) && Boolean(document.querySelector('[data-testid="unified-documents-retry-btn"]'))`,
      'Documents error + Retry button while Photos ready'
    )
    unlinkSync(docFailFlag)
    writeFileSync(join(barrierDir, 'barriers.json'), '{}', 'utf8')
    await cdp.evaluate(
      `document.querySelector('[data-testid="unified-documents-retry-btn"]')?.click()`
    )
    await waitForCondition(
      cdp.evaluate,
      `Boolean(document.querySelector('[data-testid="unified-documents-count"]')) && Boolean(document.querySelector('[data-testid="unified-photos-count"]'))`,
      'Documents recovered after isolated retry'
    )

    // 7a2. Isolated Photos UI error + Retry Photos while Documents stays ready
    const photoFailFlag = join(barrierDir, 'photo_fail.flag')
    writeFileSync(photoFailFlag, 'fail', 'utf8')
    writeFileSync(
      join(barrierDir, 'barriers.json'),
      JSON.stringify({ clip: { 'photo retry test': { failIfExists: photoFailFlag } } }),
      'utf8'
    )
    await submitHeaderQuery(cdp.evaluate, 'photo retry test')
    await waitForCondition(
      cdp.evaluate,
      `Boolean(document.querySelector('[data-testid="unified-documents-count"]')) && Boolean(document.querySelector('[data-testid="unified-photos-retry-btn"]'))`,
      'Photos error + Retry button while Documents ready'
    )
    unlinkSync(photoFailFlag)
    writeFileSync(join(barrierDir, 'barriers.json'), '{}', 'utf8')
    await cdp.evaluate(
      `document.querySelector('[data-testid="unified-photos-retry-btn"]')?.click()`
    )
    await waitForCondition(
      cdp.evaluate,
      `Boolean(document.querySelector('[data-testid="unified-photos-count"]')) && Boolean(document.querySelector('[data-testid="unified-documents-count"]'))`,
      'Photos recovered after isolated retry'
    )

    // 7c. Corrupt BGE model file in userData -> Documents shows corrupt while Photos stays ready; restore cleanly
    const bgeTokCfg = join(
      userDataDir,
      'models',
      'doc-semantic',
      'Xenova--bge-small-en-v1.5@ea104dac',
      'tokenizer_config.json'
    )
    const bgeTokBackup = readFileSync(bgeTokCfg)
    try {
      writeFileSync(bgeTokCfg, '{"corrupt":true}\n', 'utf8')
      await submitHeaderQuery(cdp.evaluate, 'corrupt model probe')
      await waitForCondition(
        cdp.evaluate,
        `Boolean(document.querySelector('[data-testid="unified-photos-count"]')) && (document.querySelector('[data-testid="unified-documents-section"]')?.textContent ?? '').includes('Document search model is corrupt or invalid.')`,
        'Documents corrupt notice while Photos ready'
      )
    } finally {
      writeFileSync(bgeTokCfg, bgeTokBackup)
    }

    // 7d. Corrupt CLIP model file in userData -> Photos fails integrity check while Documents stays ready; restore cleanly
    const clipTokCfg = join(
      userDataDir,
      'semantic-models',
      'Xenova--clip-vit-base-patch32@6b7c5237',
      'tokenizer_config.json'
    )
    const clipTokBackup = readFileSync(clipTokCfg)
    try {
      writeFileSync(clipTokCfg, '{"corrupt":true}\n', 'utf8')
      await submitHeaderQuery(cdp.evaluate, 'corrupt clip probe')
      await waitForCondition(
        cdp.evaluate,
        `Boolean(document.querySelector('[data-testid="unified-documents-count"]')) && Boolean(document.querySelector('[data-testid="unified-photos-retry-btn"]'))`,
        'Photos failure notice while Documents ready'
      )
    } finally {
      writeFileSync(clipTokCfg, clipTokBackup)
    }
    console.log(
      '[PASS] 7. Isolated per-modality error/Retry and corrupt-model partial availability verified'
    )

    // 8. Deterministic concurrency races: rapid replacement, Clear, Escape, and tab navigation
    // 8a. Rapid query replacement
    const r1ClipReady = join(barrierDir, 'r1_clip.ready')
    const r1ClipGate = join(barrierDir, 'r1_clip.gate')
    const r1BgeReady = join(barrierDir, 'r1_bge.ready')
    const r1BgeGate = join(barrierDir, 'r1_bge.gate')
    writeFileSync(
      join(barrierDir, 'barriers.json'),
      JSON.stringify({
        clip: { 'slow race query': { readyFile: r1ClipReady, gateFile: r1ClipGate } },
        bge: { 'slow race query': { readyFile: r1BgeReady, gateFile: r1BgeGate } }
      }),
      'utf8'
    )
    await submitHeaderQuery(cdp.evaluate, 'slow race query')
    await waitForFile(r1ClipReady, 'slow race clip ready')
    await waitForFile(r1BgeReady, 'slow race bge ready')
    await submitHeaderQuery(cdp.evaluate, 'bicycle')
    await waitForCondition(
      cdp.evaluate,
      `Boolean(document.querySelector('[data-testid="unified-photos-count"]')) && Boolean(document.querySelector('[data-testid="unified-documents-count"]')) && (document.querySelector('.unified-search-subtitle')?.textContent ?? '').includes('bicycle')`,
      'bicycle replaces slow race query'
    )
    writeFileSync(r1ClipGate, 'go', 'utf8')
    writeFileSync(r1BgeGate, 'go', 'utf8')
    await sleep(300)
    const afterRaceReplace = await cdp.evaluate(
      `document.querySelector('.unified-search-subtitle')?.textContent ?? ''`
    )
    if (!afterRaceReplace.includes('bicycle')) {
      throw new Error(`Late query overwrote newer query: ${afterRaceReplace}`)
    }

    // 8b. Clear button while BOTH modalities pending
    const r2ClipReady = join(barrierDir, 'r2_clip.ready')
    const r2ClipGate = join(barrierDir, 'r2_clip.gate')
    const r2BgeReady = join(barrierDir, 'r2_bge.ready')
    const r2BgeGate = join(barrierDir, 'r2_bge.gate')
    writeFileSync(
      join(barrierDir, 'barriers.json'),
      JSON.stringify({
        clip: { 'slow clear query': { readyFile: r2ClipReady, gateFile: r2ClipGate } },
        bge: { 'slow clear query': { readyFile: r2BgeReady, gateFile: r2BgeGate } }
      }),
      'utf8'
    )
    await submitHeaderQuery(cdp.evaluate, 'slow clear query')
    await waitForFile(r2ClipReady, 'slow clear clip ready')
    await waitForFile(r2BgeReady, 'slow clear bge ready')
    await cdp.evaluate(
      `document.querySelector('[data-testid="unified-search-clear-btn"]')?.click()`
    )
    await waitForCondition(
      cdp.evaluate,
      `!document.querySelector('[data-testid="unified-search-panel"]') && document.body.innerText.includes('Catalog Inventory')`,
      'Clear restores Catalog Inventory'
    )
    const clearFocusOk = await cdp.evaluate(
      `document.activeElement === document.querySelector('header input[type="search"]')`
    )
    if (!clearFocusOk) {
      throw new Error('Clear search did not restore focus to Header search input')
    }
    writeFileSync(r2ClipGate, 'go', 'utf8')
    writeFileSync(r2BgeGate, 'go', 'utf8')
    await sleep(300)
    const stayedCleared = await cdp.evaluate(
      `!document.querySelector('[data-testid="unified-search-panel"]')`
    )
    if (!stayedCleared) {
      throw new Error('Late results restored cleared unified search panel after Clear')
    }

    // 8c. Escape key while pending
    const r3ClipReady = join(barrierDir, 'r3_clip.ready')
    const r3ClipGate = join(barrierDir, 'r3_clip.gate')
    const r3BgeReady = join(barrierDir, 'r3_bge.ready')
    const r3BgeGate = join(barrierDir, 'r3_bge.gate')
    writeFileSync(
      join(barrierDir, 'barriers.json'),
      JSON.stringify({
        clip: { 'slow escape query': { readyFile: r3ClipReady, gateFile: r3ClipGate } },
        bge: { 'slow escape query': { readyFile: r3BgeReady, gateFile: r3BgeGate } }
      }),
      'utf8'
    )
    await submitHeaderQuery(cdp.evaluate, 'slow escape query')
    await waitForFile(r3ClipReady, 'slow escape clip ready')
    await waitForFile(r3BgeReady, 'slow escape bge ready')
    await cdp.evaluate(`(() => {
      const input = document.querySelector('header input[type="search"]');
      input.focus();
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
    })()`)
    await waitForCondition(
      cdp.evaluate,
      `!document.querySelector('[data-testid="unified-search-panel"]') && document.body.innerText.includes('Catalog Inventory')`,
      'Escape restores Catalog Inventory'
    )
    const escapeFocusOk = await cdp.evaluate(
      `document.activeElement === document.querySelector('header input[type="search"]')`
    )
    if (!escapeFocusOk) {
      throw new Error('Escape search did not restore focus to Header search input')
    }
    writeFileSync(r3ClipGate, 'go', 'utf8')
    writeFileSync(r3BgeGate, 'go', 'utf8')
    await sleep(300)
    const stayedClearedAfterEscape = await cdp.evaluate(
      `!document.querySelector('[data-testid="unified-search-panel"]')`
    )
    if (!stayedClearedAfterEscape) {
      throw new Error('Late results restored cleared unified search panel after Escape')
    }

    // 8d. Navigation away while pending -> start Photos tab search -> delayed unified gate cannot cancel Photos tab
    const r4ClipReady = join(barrierDir, 'r4_clip.ready')
    const r4ClipGate = join(barrierDir, 'r4_clip.gate')
    const r4BgeReady = join(barrierDir, 'r4_bge.ready')
    const r4BgeGate = join(barrierDir, 'r4_bge.gate')
    writeFileSync(
      join(barrierDir, 'barriers.json'),
      JSON.stringify({
        clip: { 'slow nav query': { readyFile: r4ClipReady, gateFile: r4ClipGate } },
        bge: { 'slow nav query': { readyFile: r4BgeReady, gateFile: r4BgeGate } }
      }),
      'utf8'
    )
    await submitHeaderQuery(cdp.evaluate, 'slow nav query')
    await waitForFile(r4ClipReady, 'slow nav clip ready')
    await waitForFile(r4BgeReady, 'slow nav bge ready')
    await cdp.evaluate(`(() => {
      const btn = Array.from(document.querySelectorAll('.nav-item')).find((b) => b.textContent?.includes('Photos'));
      btn?.click();
    })()`)
    await waitForCondition(
      cdp.evaluate,
      `Boolean(document.querySelector('.photos-search-input'))`,
      'Photos tab search input'
    )
    writeFileSync(r4ClipGate, 'go', 'utf8')
    writeFileSync(r4BgeGate, 'go', 'utf8')
    await cdp.evaluate(`(() => {
      const input = document.querySelector('.photos-search-input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'sunset beach');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    })()`)
    await waitForCondition(
      cdp.evaluate,
      `(document.querySelector('.photos-search-feedback')?.textContent ?? '').includes('match')`,
      'Photos tab search completes cleanly after unified navigation'
    )
    // Stale unified cancel from an older ownerGen must be a harmless no-op
    const staleCancelRes = await cdp.evaluate(`window.api.cancelUnifiedSearch({
      ownerSurface: 'unified',
      ownerGen: 1,
      modality: 'all'
    })`)
    if (staleCancelRes?.cancelled !== false) {
      throw new Error(
        `Expected stale unified cancel to be no-op, got: ${JSON.stringify(staleCancelRes)}`
      )
    }
    writeFileSync(join(barrierDir, 'barriers.json'), '{}', 'utf8')
    await cdp.evaluate(`(() => {
      const btn = Array.from(document.querySelectorAll('.nav-item')).find((b) => b.textContent?.includes('All Items'));
      btn?.click();
    })()`)
    await waitForCondition(
      cdp.evaluate,
      `Boolean(document.querySelector('header input[type="search"]:not(:disabled)'))`,
      'Return to All Items'
    )
    // Verify returning to All Items after nav-away cancellation shows cancelled state, Clear works, and remounted search works
    const navBackState = await cdp.evaluate(`(() => ({
      hasPanel: Boolean(document.querySelector('[data-testid="unified-search-panel"]')),
      text: document.querySelector('[data-testid="unified-search-panel"]')?.textContent ?? ''
    }))()`)
    if (
      navBackState.hasPanel &&
      !navBackState.text.includes('cancelled') &&
      !navBackState.text.includes('paused')
    ) {
      throw new Error(
        `Unexpected unified search state on return from Photos tab: ${JSON.stringify(navBackState)}`
      )
    }
    if (navBackState.hasPanel) {
      await cdp.evaluate(
        `document.querySelector('[data-testid="unified-search-clear-btn"]')?.click()`
      )
      await waitForCondition(
        cdp.evaluate,
        `!document.querySelector('[data-testid="unified-search-panel"]') && document.body.innerText.includes('Catalog Inventory')`,
        'Clear after returning from Photos tab'
      )
    }
    await submitHeaderQuery(cdp.evaluate, 'bicycle')
    await waitForCondition(
      cdp.evaluate,
      `Boolean(document.querySelector('[data-testid="unified-photos-count"]')) && Boolean(document.querySelector('[data-testid="unified-documents-count"]'))`,
      'Fresh search after All Items remount'
    )
    await cdp.evaluate(
      `document.querySelector('[data-testid="unified-search-clear-btn"]')?.click()`
    )
    await waitForCondition(
      cdp.evaluate,
      `!document.querySelector('[data-testid="unified-search-panel"]') && document.body.innerText.includes('Catalog Inventory')`,
      'Clear remounted search before viewport checks'
    )
    console.log(
      '[PASS] 8. Deterministic concurrency races (replace, Clear, Escape, navigation & remount) verified'
    )

    // 9. Real rendered layout & keyboard flows at 480x820 and 360x480
    const layoutResults = {}
    for (const vp of [
      { width: 480, height: 820, label: '480x820' },
      { width: 360, height: 480, label: '360x480' }
    ]) {
      await cdp.call('Emulation.setDeviceMetricsOverride', {
        width: vp.width,
        height: vp.height,
        deviceScaleFactor: 1,
        mobile: false
      })
      await sleep(250)

      // Focus Header search input, submit via real CDP Enter key
      await cdp.evaluate(`(() => {
        const input = document.querySelector('header input[type="search"]');
        input.focus();
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, 'mountain');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`)
      await cdp.call('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13
      })
      await cdp.call('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13
      })

      await waitForCondition(
        cdp.evaluate,
        `Boolean(document.querySelector('[data-testid="unified-photos-count"]')) && Boolean(document.querySelector('[data-testid="unified-documents-count"]')) && Boolean(document.querySelector('[data-testid="unified-jump-links"]'))`,
        `narrow unified search results at ${vp.label}`
      )

      const metrics = await cdp.evaluate(`(() => {
        const docEl = document.documentElement;
        const contentArea = document.querySelector('.content-area');
        const panel = document.querySelector('[data-testid="unified-search-panel"]');
        const jumpLinks = document.querySelector('[data-testid="unified-jump-links"]');
        const overflowing = [];
        for (const el of document.querySelectorAll('.top-bar button, .top-bar input, [data-testid="unified-search-panel"] button, [data-testid="unified-search-panel"] select, [data-testid="unified-search-panel"] input, .unified-photo-card, .unified-doc-card, .unified-modality-section, .unified-filter-group, .unified-coverage-notes, .unified-pagination, pre.unified-doc-snippet')) {
          const st = getComputedStyle(el);
          if (st.display === 'none' || st.visibility === 'hidden') continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          if (r.right > window.innerWidth + 1 || r.left < -1) {
            overflowing.push({ tag: el.tagName, testId: el.getAttribute('data-testid'), cls: el.className, left: Math.round(r.left), right: Math.round(r.right) });
          }
        }
        return {
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          docScrollWidth: docEl.scrollWidth,
          contentClientWidth: contentArea?.clientWidth ?? null,
          contentClientHeight: contentArea?.clientHeight ?? null,
          contentScrollWidth: contentArea?.scrollWidth ?? null,
          panelScrollWidth: panel?.scrollWidth ?? null,
          panelClientWidth: panel?.clientWidth ?? null,
          jumpLinksVisible: Boolean(jumpLinks),
          overflowing
        };
      })()`)

      if (
        metrics.innerWidth !== vp.width ||
        metrics.innerHeight !== vp.height ||
        metrics.docScrollWidth > vp.width + 1 ||
        (metrics.contentScrollWidth ?? 0) > (metrics.contentClientWidth ?? 0) + 1 ||
        (metrics.panelScrollWidth ?? 0) > (metrics.panelClientWidth ?? 0) + 1 ||
        !metrics.jumpLinksVisible ||
        metrics.overflowing.length > 0
      ) {
        throw new Error(`Narrow layout check failed at ${vp.label}: ${JSON.stringify(metrics)}`)
      }

      // Keyboard reachability via real CDP Tab events + Jump to Documents focus + Escape focus restore
      const visitedTags = []
      for (let t = 0; t < 18; t++) {
        await cdp.call('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: 'Tab',
          code: 'Tab',
          windowsVirtualKeyCode: 9
        })
        await cdp.call('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'Tab',
          code: 'Tab',
          windowsVirtualKeyCode: 9
        })
        const activeInfo = await cdp.evaluate(`(() => {
          const a = document.activeElement;
          return {
            tag: a?.tagName ?? null,
            testId: a?.getAttribute?.('data-testid') ?? null,
            text: a?.textContent?.trim()?.slice(0, 32) ?? null
          };
        })()`)
        visitedTags.push(activeInfo)
      }
      const reachedClear = visitedTags.some((v) => v.testId === 'unified-search-clear-btn')
      const reachedModality = visitedTags.some((v) => v.testId?.startsWith('unified-modality-'))
      const reachedFilter = visitedTags.some(
        (v) => v.testId?.startsWith('unified-photo-') || v.testId?.startsWith('unified-doc-')
      )
      const reachedResult = visitedTags.some((v) =>
        /^unified-(photo|doc)-item-/.test(v.testId ?? '')
      )
      if (!reachedClear || !reachedModality || !reachedFilter || !reachedResult) {
        throw new Error(
          `Keyboard Tab reachability incomplete at ${vp.label}: ${JSON.stringify(visitedTags)}`
        )
      }

      // Activate Jump to Documents and confirm focus moves to #unified-documents-heading
      await cdp.evaluate(`(() => {
        const jumpBtn = Array.from(document.querySelectorAll('[data-testid="unified-jump-links"] button')).find((b) =>
          b.textContent?.includes('Jump to Documents')
        );
        jumpBtn?.focus();
      })()`)
      await cdp.call('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        text: '\r',
        unmodifiedText: '\r',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13
      })
      await cdp.call('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13
      })
      await sleep(100)
      const jumpedFocusId = await cdp.evaluate(`document.activeElement?.id ?? null`)
      if (jumpedFocusId !== 'unified-documents-heading') {
        throw new Error(
          `Jump to Documents did not focus heading at ${vp.label}: got ${jumpedFocusId}`
        )
      }

      // Expand first document result card via keyboard Enter and confirm path details do not overflow narrow viewport
      await cdp.evaluate(
        `document.querySelector('.unified-doc-card .unified-result-title-btn')?.focus()`
      )
      await cdp.call('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        text: '\r',
        unmodifiedText: '\r',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13
      })
      await cdp.call('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13
      })
      await waitForCondition(
        cdp.evaluate,
        `Boolean(document.querySelector('[data-testid^="unified-doc-details-"]'))`,
        `expanded document card details at ${vp.label}`
      )
      const detailsOverflow = await cdp.evaluate(`(() => {
        const d = document.querySelector('[data-testid^="unified-doc-details-"]');
        const r = d?.getBoundingClientRect();
        return r ? { right: Math.round(r.right), innerWidth: window.innerWidth, scrollW: d.scrollWidth, clientW: d.clientWidth } : null;
      })()`)
      if (
        !detailsOverflow ||
        detailsOverflow.right > vp.width + 1 ||
        detailsOverflow.scrollW > detailsOverflow.clientW + 1
      ) {
        throw new Error(
          `Expanded doc details overflowed at ${vp.label}: ${JSON.stringify(detailsOverflow)}`
        )
      }

      // Escape in Header search input restores Catalog Inventory and keeps focus on search input
      await cdp.evaluate(`document.querySelector('header input[type="search"]')?.focus()`)
      await cdp.call('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27
      })
      await cdp.call('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27
      })
      await waitForCondition(
        cdp.evaluate,
        `!document.querySelector('[data-testid="unified-search-panel"]') && document.body.innerText.includes('Catalog Inventory')`,
        `Escape clear at ${vp.label}`
      )
      const escFocusOk = await cdp.evaluate(
        `document.activeElement === document.querySelector('header input[type="search"]')`
      )
      if (!escFocusOk) {
        throw new Error(`Focus not restored to Header search input after Escape at ${vp.label}`)
      }

      layoutResults[vp.label] = metrics
    }
    await cdp.call('Emulation.clearDeviceMetricsOverride')
    console.log(
      `[PASS] 9. Real 480x820 & 360x480 layout + keyboard flows verified: ${JSON.stringify(layoutResults)}`
    )

    // 10. Restart persistence check (Session 2 against persisted userDataDir)
    if (cdp.runtimeErrors.length > 0) {
      throw new Error(`Runtime/console errors in Session 1: ${cdp.runtimeErrors.join(' | ')}`)
    }
    await stopElectron(proc, cdp.ws)
    proc = null
    cdp = null

    const port2 = await getFreePort()
    proc = launchElectron(userDataDir, port2, { PV_TEST_SEARCH_BARRIER_DIR: barrierDir })
    const target2 = await waitForCdpTarget(port2)
    const cdp2 = await connectCdp(target2.webSocketDebuggerUrl)
    cdp = cdp2

    await waitForCondition(
      cdp2.evaluate,
      `Boolean(window.api && document.querySelector('header input[type="search"]:not(:disabled)'))`,
      'enabled header search after restart'
    )
    const persisted = await cdp2.evaluate(`(async () => {
      const clip = await window.api.getSemanticModelStatus();
      const bge = await window.api.getDocSemanticModelStatus();
      const ocr = await window.api.getOcrModelStatus();
      const clipIdx = await window.api.getSemanticIndexProgress();
      const bgeIdx = await window.api.getDocumentSemanticProgress();
      const clsPage = await window.api.getDocumentsPage({ offset: 0, limit: 50, clutterFilter: 'hide_clutter' });
      const allPhotos = await window.api.getPhotosPage({ offset: 0, limit: 100 });
      const allDocs = await window.api.getDocumentsPage({ offset: 0, limit: 100 });
      return {
        clipState: clip.state,
        bgeState: bge.state,
        ocrState: ocr.state,
        indexedPhotos: clipIdx.currentIndexedPhotos,
        indexedDocs: bgeIdx.coverage.indexedDocuments,
        hiddenClutterCount: clsPage.hiddenClutterCount,
        readmeHidden: !clsPage.items.some((i) => i.fileName === 'README.md'),
        photos: allPhotos.items,
        docs: allDocs.items
      };
    })()`)
    assertCatalogFactsMatchDisk(
      persisted.photos,
      persisted.docs,
      [fixturesMainBaseline, fixturesUnindexedBaseline],
      'post-restart'
    )
    const persistedSummary = {
      clipState: persisted.clipState,
      bgeState: persisted.bgeState,
      ocrState: persisted.ocrState,
      indexedPhotos: persisted.indexedPhotos,
      indexedDocs: persisted.indexedDocs,
      hiddenClutterCount: persisted.hiddenClutterCount,
      readmeHidden: persisted.readmeHidden
    }
    if (
      persisted.clipState !== 'ready' ||
      persisted.bgeState !== 'ready' ||
      persisted.ocrState !== 'ready' ||
      persisted.indexedPhotos !== 22 ||
      persisted.indexedDocs !== 23 ||
      persisted.hiddenClutterCount !== 1 ||
      !persisted.readmeHidden
    ) {
      throw new Error(`Restart persistence mismatch: ${JSON.stringify(persistedSummary)}`)
    }

    await submitHeaderQuery(cdp2.evaluate, 'mountain')
    await waitForCondition(
      cdp2.evaluate,
      `Boolean(document.querySelector('[data-testid="unified-photos-count"]')) && Boolean(document.querySelector('[data-testid="unified-documents-count"]'))`,
      'unified search after restart without re-indexing'
    )
    await submitHeaderQuery(cdp2.evaluate, 'pharmacy prescription copay bicycle helmet')
    await waitForCondition(
      cdp2.evaluate,
      `(document.querySelector('[data-testid="unified-documents-section"]')?.textContent ?? '').includes('OCR text (machine-recognized)')`,
      'OCR provenance preserved in unified search after restart'
    )
    const restartDiag = await cdp2.evaluate(`window.api.getPhotosDiagnostics()`)
    if ((restartDiag?.totalAppLiveWorkers ?? 0) > 3) {
      throw new Error(`Worker budget exceeded after restart: ${JSON.stringify(restartDiag)}`)
    }
    if (cdp2.runtimeErrors.length > 0) {
      throw new Error(`Runtime/console errors in Session 2: ${cdp2.runtimeErrors.join(' | ')}`)
    }
    console.log(
      `[PASS] 10. Restart persistence, recorded catalog facts, OCR provenance & offline invariants verified (${JSON.stringify(persistedSummary)})`
    )

    // 10b. Bounded queue saturation / overload check over real unified IPC
    const ovReady = join(barrierDir, 'ov.ready')
    const ovGate = join(barrierDir, 'ov.gate')
    writeFileSync(
      join(barrierDir, 'barriers.json'),
      JSON.stringify({ bge: { 'overload probe': { readyFile: ovReady, gateFile: ovGate } } }),
      'utf8'
    )
    const overloadPromise = cdp2.evaluate(`(async () => {
      const reqs = [];
      for (let i = 0; i < 19; i++) {
        reqs.push(window.api.searchUnifiedDocuments({
          query: 'overload probe',
          ownerSurface: 'unified',
          ownerGen: 99995,
          offset: i,
          limit: 1
        }));
      }
      return Promise.all(reqs);
    })()`)
    await waitForFile(ovReady, 'overload probe barrier entry')
    await sleep(150)
    writeFileSync(ovGate, 'go', 'utf8')
    const overloadRes = await overloadPromise
    const overloadedCount = overloadRes.filter((r) => r.status === 'overloaded').length
    const readyCount = overloadRes.filter((r) => r.status === 'ready').length
    if (overloadedCount === 0 || readyCount === 0) {
      throw new Error(
        `Expected overloaded + ready mix, got: ${JSON.stringify({ overloadedCount, readyCount })}`
      )
    }
    console.log(
      `[PASS] 10b. Queue saturation / overloaded status verified (${readyCount} ready, ${overloadedCount} overloaded)`
    )

    await stopElectron(proc, cdp2.ws)
    proc = null
    cdp = null

    assertTreePreserved(fixturesMain, fixturesMainBaseline, 'fixturesMain')
    assertTreePreserved(fixturesUnindexed, fixturesUnindexedBaseline, 'fixturesUnindexed')
    assertTreePreserved(cachedClipModelDir, clipCacheBaseline, 'cachedClipModelDir')
    assertTreePreserved(cachedBgeModelDir, bgeCacheBaseline, 'cachedBgeModelDir')
    assertTreePreserved(cachedOcrModelDir, ocrCacheBaseline, 'cachedOcrModelDir')
    console.log(
      `[PASS] 11. 100% bitwise source & model-cache preservation verified (${fixturesMainBaseline.size + fixturesUnindexedBaseline.size} fixtures + 3 model caches)`
    )
    console.log(`\n[verify-unified-search] ALL REAL-ELECTRON CHECKS PASSED (${mode}).`)
  } finally {
    await stopElectron(proc, cdp?.ws)
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error('[verify-unified-search] FAILED:', err)
  process.exit(1)
})
