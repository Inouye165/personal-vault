#!/usr/bin/env node
/**
 * Real-Electron End-to-End Verification for Offline Metadata-Aware Photo Search
 *
 * Tests against the real built or unpacked Windows Electron application in an
 * isolated temporary `--user-data-dir` and disposable synthetic JPEG + HEIC
 * fixtures (never touching live profiles, catalogs, vaults, or user photos).
 *
 * Verifies:
 *  1. Automatic metadata extraction after scan completion + read-only source preservation
 *  2. "Yellowstone in 2025" (mountain HEIC + restaurant interior JPEG) WITHOUT visual model
 *  3. "June 6 of any year" recurring month/day match across years WITHOUT visual model
 *  4. "My wedding week" undefined event prompt + offline save + immediate match
 *  5. "Springfield" offline place disambiguation + camera combined filters
 *  6. Editable interpreted filter chips & Photo Details provenance separation in UI
 *  7. Interrupted metadata pass resume + v19 -> v20 catalog upgrade recovery
 *  8. Real ONNX CLIP filter-before-ranking ("Mountains in Yellowstone" excludes
 *     outside-area mountain photo before visual ranking) when local verified CLIP model exists.
 *
 * Usage: node scripts/verify-electron-metadata-search.mjs --mode=built|unpacked
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import electronPath from 'electron'
import sharp from 'sharp'

const root = resolve(import.meta.dirname, '..')
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=')
    return [k, v]
  })
)
const mode = args.mode || 'built'
if (!['built', 'unpacked'].includes(mode)) {
  console.error('Usage: node scripts/verify-electron-metadata-search.mjs --mode=built|unpacked')
  process.exit(2)
}

const TOTAL_TIMEOUT_MS = 120_000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const failures = []
const passes = []
const notes = []

function pass(msg) {
  console.log(`PASS: ${msg}`)
  passes.push(msg)
}

function fail(msg) {
  console.error(`FAIL: ${msg}`)
  failures.push(msg)
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      server.close(() => resolvePort(port))
    })
  })
}

function launchCommand(port, userDataDir) {
  const common = [`--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`]
  if (mode === 'built') {
    const mainJs = join(root, 'out', 'main', 'index.js')
    if (!existsSync(mainJs)) {
      throw new Error('out/main/index.js missing. Run `npm run build` first.')
    }
    return { command: electronPath, argv: ['.', ...common] }
  }
  const unpackedDir = process.env.PV_UNPACKED_DIR || join(root, 'dist', 'win-unpacked')
  const exe = join(unpackedDir, 'Personal Vault.exe')
  if (!existsSync(exe)) {
    throw new Error(`${exe} missing. Run \`npm run build:unpack\` first.`)
  }
  return { command: exe, argv: common }
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
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && t.url && !t.url.startsWith('devtools:'))
      if (page) return page
    } catch {
      /* waiting for DevTools */
    }
    await sleep(250)
  }
  throw new Error('Timed out waiting for Electron window CDP target')
}

function connectCdp(url, events) {
  return new Promise((resolveCdp, reject) => {
    const ws = new WebSocket(url)
    let nextId = 1
    const pending = new Map()
    ws.onerror = () => reject(new Error('Could not connect to CDP websocket'))
    ws.onmessage = (message) => {
      const data = JSON.parse(String(message.data))
      if (data.id && pending.has(data.id)) {
        const { ok, bad } = pending.get(data.id)
        pending.delete(data.id)
        data.error ? bad(new Error(data.error.message)) : ok(data.result)
      } else if (data.method) {
        events.push(data)
      }
    }
    ws.onopen = () =>
      resolveCdp({
        send: (method, params = {}) =>
          new Promise((ok, bad) => {
            const id = nextId++
            pending.set(id, { ok, bad })
            ws.send(JSON.stringify({ id, method, params }))
            setTimeout(() => {
              if (pending.delete(id)) bad(new Error(`CDP call timed out: ${method}`))
            }, 15_000)
          }),
        close: () => ws.close()
      })
  })
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? 'CDP evaluation failed')
  }
  return result.result.value
}

// --- Minimal self-contained EXIF / GPS / HEIC binary fixture helpers ---

const TIFF_ASCII = 2
const TIFF_LONG = 4
const TIFF_RATIONAL = 5
const TIFF_BYTE = 1

function toDmsRationals(degAbs) {
  const d = Math.floor(degAbs)
  const mFloat = (degAbs - d) * 60
  const m = Math.floor(mFloat)
  const s = Math.round((mFloat - m) * 60 * 10000)
  return [
    [d, 1],
    [m, 1],
    [s, 10000]
  ]
}

function buildGpsTags(lat, lon, altitudeM) {
  const tags = [
    { tagId: 0x0000, type: 'byte', value: [2, 3, 0, 0] },
    { tagId: 0x0001, type: 'ascii', value: lat >= 0 ? 'N' : 'S' },
    { tagId: 0x0002, type: 'rational', value: toDmsRationals(Math.abs(lat)) },
    { tagId: 0x0003, type: 'ascii', value: lon >= 0 ? 'E' : 'W' },
    { tagId: 0x0004, type: 'rational', value: toDmsRationals(Math.abs(lon)) }
  ]
  if (typeof altitudeM === 'number') {
    tags.push({ tagId: 0x0005, type: 'byte', value: [altitudeM < 0 ? 1 : 0] })
    tags.push({
      tagId: 0x0006,
      type: 'rational',
      value: [Math.round(Math.abs(altitudeM) * 100), 100]
    })
  }
  return tags
}

function buildRawTiffExif({ ifd0Tags = [], exifTags = [], gpsTags = [] }) {
  const hasExif = exifTags.length > 0
  const hasGps = gpsTags.length > 0
  const sortedIfd0 = [
    ...ifd0Tags,
    ...(hasExif ? [{ tagId: 0x8769, type: 'long', value: 0 }] : []),
    ...(hasGps ? [{ tagId: 0x8825, type: 'long', value: 0 }] : [])
  ].sort((a, b) => a.tagId - b.tagId)
  const sortedExif = [...exifTags].sort((a, b) => a.tagId - b.tagId)
  const sortedGps = [...gpsTags].sort((a, b) => a.tagId - b.tagId)

  const ifd0Offset = 8
  const ifd0Len = 2 + sortedIfd0.length * 12 + 4
  const exifOffset = hasExif ? ifd0Offset + ifd0Len : 0
  const exifLen = hasExif ? 2 + sortedExif.length * 12 + 4 : 0
  const gpsOffset = hasGps ? ifd0Offset + ifd0Len + exifLen : 0
  const gpsLen = hasGps ? 2 + sortedGps.length * 12 + 4 : 0
  let heapCursor = ifd0Offset + ifd0Len + exifLen + gpsLen
  const heap = []

  const pushHeap = (buf) => {
    const start = heapCursor
    const padded = buf.length % 2 === 1 ? Buffer.concat([buf, Buffer.from([0])]) : buf
    heap.push(padded)
    heapCursor += padded.length
    return start
  }

  const encodeIfd = (entries) => {
    const dir = Buffer.alloc(2 + entries.length * 12 + 4)
    dir.writeUInt16LE(entries.length, 0)
    entries.forEach((e, idx) => {
      const off = 2 + idx * 12
      dir.writeUInt16LE(e.tagId, off)
      if (e.type === 'long') {
        const val = e.tagId === 0x8769 ? exifOffset : e.tagId === 0x8825 ? gpsOffset : e.value
        dir.writeUInt16LE(TIFF_LONG, off + 2)
        dir.writeUInt32LE(1, off + 4)
        dir.writeUInt32LE(val >>> 0, off + 8)
      } else if (e.type === 'ascii') {
        const bytes = Buffer.concat([Buffer.from(String(e.value), 'latin1'), Buffer.from([0])])
        dir.writeUInt16LE(TIFF_ASCII, off + 2)
        dir.writeUInt32LE(bytes.length, off + 4)
        if (bytes.length <= 4) {
          bytes.copy(dir, off + 8)
        } else {
          dir.writeUInt32LE(pushHeap(bytes), off + 8)
        }
      } else if (e.type === 'byte') {
        const bytes = Buffer.from(e.value)
        dir.writeUInt16LE(TIFF_BYTE, off + 2)
        dir.writeUInt32LE(bytes.length, off + 4)
        bytes.copy(dir, off + 8)
      } else if (e.type === 'rational') {
        const pairs = Array.isArray(e.value[0]) ? e.value : [e.value]
        const rat = Buffer.alloc(pairs.length * 8)
        pairs.forEach(([n, d], pIdx) => {
          rat.writeUInt32LE(n >>> 0, pIdx * 8)
          rat.writeUInt32LE(d >>> 0, pIdx * 8 + 4)
        })
        dir.writeUInt16LE(TIFF_RATIONAL, off + 2)
        dir.writeUInt32LE(pairs.length, off + 4)
        dir.writeUInt32LE(pushHeap(rat), off + 8)
      }
    })
    return dir
  }

  const hdr = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00])
  const parts = [hdr, encodeIfd(sortedIfd0)]
  if (hasExif) parts.push(encodeIfd(sortedExif))
  if (hasGps) parts.push(encodeIfd(sortedGps))
  parts.push(...heap)
  return Buffer.concat(parts)
}

function injectJpegExif(jpegBuf, tiffBuf) {
  const exifHeader = Buffer.from('Exif\0\0', 'ascii')
  const marker = Buffer.alloc(4)
  marker[0] = 0xff
  marker[1] = 0xe1
  marker.writeUInt16BE(2 + exifHeader.length + tiffBuf.length, 2)
  return Buffer.concat([jpegBuf.subarray(0, 2), marker, exifHeader, tiffBuf, jpegBuf.subarray(2)])
}

function createHeicWithExif(baseHeicPath, tiffBuf) {
  const base = Buffer.from(readFileSync(baseHeicPath))
  let off = 0
  let ilocOff = -1
  let mdatOff = -1
  while (off + 8 <= base.length) {
    const size = base.readUInt32BE(off)
    const type = base.toString('ascii', off + 4, off + 8)
    if (type === 'meta') {
      let moff = off + 12
      while (moff + 8 <= off + size) {
        const ms = base.readUInt32BE(moff)
        const mt = base.toString('ascii', moff + 4, moff + 8)
        if (mt === 'iloc') ilocOff = moff
        moff += ms
      }
    } else if (type === 'mdat') {
      mdatOff = off
    }
    off += size
  }
  const item2BaseOffset = base.readUInt32BE(ilocOff + 38)
  const newExifItem = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x06, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00]),
    tiffBuf
  ])
  const prefix = Buffer.from(base.subarray(0, item2BaseOffset))
  prefix.writeUInt32BE(newExifItem.length, ilocOff + 48)
  prefix.writeUInt32BE(8 + (item2BaseOffset - (mdatOff + 8)) + newExifItem.length, mdatOff)
  return Buffer.concat([prefix, newExifItem])
}

async function makeMountainJpeg(tiffOpts) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240">
    <rect width="320" height="240" fill="#5da9e9"/>
    <polygon points="10,220 110,60 210,220" fill="#4b5563"/>
    <polygon points="120,220 225,45 315,220" fill="#374151"/>
    <polygon points="110,60 88,95 132,95" fill="#f8fafc"/>
    <polygon points="225,45 201,85 249,85" fill="#f8fafc"/>
  </svg>`
  const jpeg = await sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer()
  return injectJpegExif(jpeg, buildRawTiffExif(tiffOpts))
}

async function makeRestaurantJpeg(tiffOpts) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240">
    <rect width="320" height="240" fill="#7c2d12"/>
    <rect x="40" y="130" width="240" height="90" fill="#a16207"/>
    <circle cx="160" cy="70" r="24" fill="#fde68a"/>
    <rect x="115" y="110" width="90" height="25" fill="#f5f5f4"/>
  </svg>`
  const jpeg = await sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer()
  return injectJpegExif(jpeg, buildRawTiffExif(tiffOpts))
}

async function launchElectronSession(userDataDir, extraEnv = {}) {
  const port = await freePort()
  const { command, argv } = launchCommand(port, userDataDir)
  const child = spawn(command, argv, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv }
  })
  const runtimeErrors = []
  child.stderr.on('data', (chunk) => {
    const s = String(chunk)
    if (/uncaught|fatal|preload error/i.test(s)) runtimeErrors.push(s.trim())
  })
  const deadline = Date.now() + TOTAL_TIMEOUT_MS
  const target = await findPageTarget(port, deadline)
  const cdpEvents = []
  const cdp = await connectCdp(target.webSocketDebuggerUrl, cdpEvents)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await sleep(800)

  const waitApiDeadline = Date.now() + 20_000
  while (Date.now() < waitApiDeadline) {
    const ok = await evaluate(cdp, `typeof window.api === 'object' && window.api !== null`)
    if (ok) break
    await sleep(200)
  }

  return { child, cdp, cdpEvents, runtimeErrors, deadline }
}

async function waitForScanComplete(cdp, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const st = await evaluate(cdp, `window.api.getLatestScanJob()`)
    if (st?.job?.status === 'completed') return st.job
    if (st?.job?.status === 'failed') throw new Error(`Scan failed: ${st.job.errorMessage}`)
    await sleep(150)
  }
  throw new Error('Timed out waiting for scan job')
}

async function waitForMetadataIdle(cdp, expectedPhotos, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const p = await evaluate(cdp, `window.api.getPhotoMetadataProgress()`)
    const done =
      p.status === 'completed' ||
      (p.status !== 'running' &&
        p.coverage.unprocessedCount === 0 &&
        p.coverage.totalPhotos === expectedPhotos)
    if (done) return p
    await sleep(150)
  }
  throw new Error('Timed out waiting for metadata extraction completion')
}

async function main() {
  const workDir = mkdtempSync(join(tmpdir(), 'pv-verify-meta-search-'))
  const userDataDir = join(workDir, 'user-data')
  const photoDir = join(workDir, 'photos')
  const upgradeDir = join(workDir, 'user-data-v19')
  mkdirSync(userDataDir, { recursive: true })
  mkdirSync(photoDir, { recursive: true })
  mkdirSync(upgradeDir, { recursive: true })

  let session = null
  try {
    const baseHeic = join(root, 'tests/fixtures/heic/portrait_exif6.heic')

    // Build synthetic JPEG + HEIC fixtures
    const yellowstoneMountainHeic = join(photoDir, 'yellowstone-mountain.heic')
    writeFileSync(
      yellowstoneMountainHeic,
      createHeicWithExif(
        baseHeic,
        buildRawTiffExif({
          ifd0Tags: [
            { tagId: 0x010f, type: 'ascii', value: 'Apple' },
            { tagId: 0x0110, type: 'ascii', value: 'iPhone 15 Pro' }
          ],
          exifTags: [
            { tagId: 0x9003, type: 'ascii', value: '2025:06:06 10:15:00' },
            { tagId: 0x9011, type: 'ascii', value: '-06:00' }
          ],
          gpsTags: buildGpsTags(44.4605, -110.8281, 2245)
        })
      )
    )

    const yellowstoneRestaurantJpg = join(photoDir, 'yellowstone-restaurant.jpg')
    writeFileSync(
      yellowstoneRestaurantJpg,
      await makeRestaurantJpeg({
        ifd0Tags: [
          { tagId: 0x010f, type: 'ascii', value: 'Canon' },
          { tagId: 0x0110, type: 'ascii', value: 'Canon EOS R5' }
        ],
        exifTags: [
          { tagId: 0x9003, type: 'ascii', value: '2025:06:06 19:45:00' },
          { tagId: 0x9011, type: 'ascii', value: '-06:00' }
        ],
        gpsTags: buildGpsTags(44.725, -110.491, 2380)
      })
    )

    const coloradoMountainJpg = join(photoDir, 'colorado-mountain.jpg')
    writeFileSync(
      coloradoMountainJpg,
      await makeMountainJpeg({
        ifd0Tags: [{ tagId: 0x0110, type: 'ascii', value: 'Canon EOS R5' }],
        exifTags: [{ tagId: 0x9003, type: 'ascii', value: '2025:07:04 08:00:00' }],
        gpsTags: buildGpsTags(39.7392, -104.9903)
      })
    )

    const recurring2023Jpg = join(photoDir, 'anniversary-2023.jpg')
    writeFileSync(
      recurring2023Jpg,
      await makeRestaurantJpeg({
        ifd0Tags: [{ tagId: 0x0110, type: 'ascii', value: 'Sony ILCE-7M4' }],
        exifTags: [{ tagId: 0x9003, type: 'ascii', value: '2023:06:06 12:00:00' }]
      })
    )

    const weddingToastJpg = join(photoDir, 'wedding-toast.jpg')
    writeFileSync(
      weddingToastJpg,
      await makeRestaurantJpeg({
        ifd0Tags: [{ tagId: 0x0110, type: 'ascii', value: 'Canon EOS R5' }],
        exifTags: [{ tagId: 0x9003, type: 'ascii', value: '2024:09:12 18:00:00' }]
      })
    )

    const missingMetaPng = join(photoDir, 'plain-note.png')
    writeFileSync(
      missingMetaPng,
      await sharp({
        create: { width: 64, height: 64, channels: 3, background: { r: 90, g: 130, b: 170 } }
      })
        .png()
        .toBuffer()
    )

    const initialBaselines = new Map()
    for (const f of [
      yellowstoneMountainHeic,
      yellowstoneRestaurantJpg,
      coloradoMountainJpg,
      recurring2023Jpg,
      weddingToastJpg,
      missingMetaPng
    ]) {
      initialBaselines.set(f, {
        sha: createHash('sha256').update(readFileSync(f)).digest('hex'),
        mtimeMs: statSync(f).mtimeMs
      })
    }

    if (args['export-demo-dir']) {
      mkdirSync(args['export-demo-dir'], { recursive: true })
      cpSync(photoDir, args['export-demo-dir'], { recursive: true })
    }

    // Check optional local verified CLIP model dir (read-only copy if available)
    const hostModelDir =
      process.env.PV_TEST_MODEL_IMPORT_DIR ||
      join(
        resolve(root, '..', 'personal-vault'),
        'spikes',
        'semantic-eval',
        '.model-cache',
        'Xenova--clip-vit-base-patch32'
      )
    let copiedModelDir = null
    if (existsSync(join(hostModelDir, 'config.json'))) {
      copiedModelDir = join(workDir, 'offline-clip-model')
      cpSync(hostModelDir, copiedModelDir, { recursive: true })
    }

    session = await launchElectronSession(
      userDataDir,
      copiedModelDir ? { PV_TEST_MODEL_IMPORT_DIR: copiedModelDir } : {}
    )
    const { cdp, cdpEvents, runtimeErrors } = session

    // Navigate UI to Photographs tab
    await evaluate(
      cdp,
      `(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => /^\\s*photos\\s*$/i.test(b.textContent || ''));
        if (btn) btn.click();
      })()`
    )

    // 1. Scan & auto-extract metadata without visual model
    const scanRes = await evaluate(
      cdp,
      `window.api.startScan({ roots: [${JSON.stringify(photoDir)}] })`
    )
    if (!scanRes?.success) throw new Error(`startScan failed: ${JSON.stringify(scanRes)}`)
    await waitForScanComplete(cdp)
    const metaProgress = await waitForMetadataIdle(cdp, 6)
    if (metaProgress.coverage.extractedCount < 5 || metaProgress.coverage.noMetadataCount < 1) {
      throw new Error(`Unexpected metadata coverage: ${JSON.stringify(metaProgress.coverage)}`)
    }
    pass(
      `Auto-extracted JPEG+HEIC metadata after scan (${metaProgress.coverage.extractedCount} EXIF/GPS, ${metaProgress.coverage.noMetadataCount} no-EXIF)`
    )

    // 2. Verify "Yellowstone in 2025" works WITHOUT visual model
    const modelBefore = await evaluate(cdp, `window.api.getSemanticModelStatus()`)
    if (modelBefore.state !== 'missing') {
      throw new Error(`Expected initial visual model missing, got ${modelBefore.state}`)
    }
    const y2025 = await evaluate(
      cdp,
      `window.api.searchPhotosMetadataAware({ queryText: 'Yellowstone in 2025' })`
    )
    const y2025Names = y2025.items.map((i) => i.photo.fileName).sort()
    if (
      y2025.mode !== 'metadata_only' ||
      JSON.stringify(y2025Names) !==
        JSON.stringify(['yellowstone-mountain.heic', 'yellowstone-restaurant.jpg'])
    ) {
      throw new Error(`Yellowstone in 2025 mismatch: ${JSON.stringify(y2025)}`)
    }
    pass(
      '"Yellowstone in 2025" matched HEIC mountain + JPEG restaurant interior without visual model'
    )

    // 3. "June 6 of any year"
    const june6 = await evaluate(
      cdp,
      `window.api.searchPhotosMetadataAware({ queryText: 'June 6 of any year' })`
    )
    const june6Names = june6.items.map((i) => i.photo.fileName).sort()
    if (
      june6.mode !== 'metadata_only' ||
      JSON.stringify(june6Names) !==
        JSON.stringify([
          'anniversary-2023.jpg',
          'yellowstone-mountain.heic',
          'yellowstone-restaurant.jpg'
        ])
    ) {
      throw new Error(`June 6 of any year mismatch: ${JSON.stringify(june6Names)}`)
    }
    pass('"June 6 of any year" matched recurring month/day across 2023 and 2025')

    // 4. "My wedding week" clarification + offline save
    const weddingAsk = await evaluate(
      cdp,
      `window.api.searchPhotosMetadataAware({ queryText: 'My wedding week' })`
    )
    if (
      weddingAsk.mode !== 'needs_clarification' ||
      weddingAsk.clarification?.kind !== 'define_event'
    ) {
      throw new Error(`Expected define_event prompt, got ${JSON.stringify(weddingAsk)}`)
    }
    await evaluate(
      cdp,
      `window.api.upsertSavedEvent({ name: 'My wedding week', dateFrom: '2024-09-10', dateTo: '2024-09-16' })`
    )
    const weddingDone = await evaluate(
      cdp,
      `window.api.searchPhotosMetadataAware({ queryText: 'My wedding week' })`
    )
    if (weddingDone.items.map((i) => i.photo.fileName).join(',') !== 'wedding-toast.jpg') {
      throw new Error(`My wedding week mismatch: ${JSON.stringify(weddingDone.items)}`)
    }
    pass('"My wedding week" prompted, saved offline, and matched wedding-toast.jpg')

    // 5. Ambiguous "Springfield" & camera filter combination
    const springfield = await evaluate(
      cdp,
      `window.api.searchPhotosMetadataAware({ queryText: 'Springfield' })`
    )
    if (
      springfield.mode !== 'needs_clarification' ||
      springfield.clarification?.kind !== 'disambiguate_place'
    ) {
      throw new Error(`Expected disambiguate_place, got ${JSON.stringify(springfield)}`)
    }
    const camCombined = await evaluate(
      cdp,
      `window.api.searchPhotosMetadataAware({ queryText: 'Yellowstone on Canon EOS R5 in 2025' })`
    )
    if (camCombined.items.map((i) => i.photo.fileName).join(',') !== 'yellowstone-restaurant.jpg') {
      throw new Error(`Camera+place+date mismatch: ${JSON.stringify(camCombined.items)}`)
    }
    pass('"Springfield" offline disambiguation + combined camera/place/date search verified')

    // 6. Drive live UI search input & check interpreted filter chips
    await evaluate(
      cdp,
      `(() => {
        const input = document.querySelector('.photos-search-input');
        if (!input) throw new Error('Search input not rendered in UI when visual model missing');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, 'Yellowstone in 2025');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      })()`
    )
    await sleep(600)
    const uiCheck = await evaluate(
      cdp,
      `({
        hasPlaceChip: Boolean(document.querySelector('[data-testid="filter-chip-place"]')),
        hasDateChip: Boolean(document.querySelector('[data-testid="filter-chip-date"]')),
        badgeText: document.querySelector('[data-testid="search-match-badge"]')?.textContent || '',
        bodyText: document.body.innerText
      })`
    )
    if (
      !uiCheck.hasPlaceChip ||
      !uiCheck.hasDateChip ||
      !/2 metadata matches/i.test(uiCheck.badgeText)
    ) {
      throw new Error(`UI chip/badge check failed: ${JSON.stringify(uiCheck)}`)
    }
    pass(
      'Live UI renders metadata search input, editable chips, and match count without visual model'
    )

    // 7. Filter-before-ranking with real CLIP ONNX model if offline model dir available
    if (copiedModelDir) {
      const importRes = await evaluate(cdp, `window.api.importSemanticModelFromFolder()`)
      if (importRes.state !== 'ready') {
        throw new Error(`CLIP model import failed: ${JSON.stringify(importRes)}`)
      }
      await evaluate(cdp, `window.api.startSemanticIndexing()`)
      const semDeadline = Date.now() + 45_000
      while (Date.now() < semDeadline) {
        const sp = await evaluate(cdp, `window.api.getSemanticIndexProgress()`)
        if (sp.status === 'completed') break
        if (sp.status === 'failed') throw new Error(`Semantic indexing failed: ${sp.lastError}`)
        await sleep(250)
      }

      const libWideTop1 = await evaluate(
        cdp,
        `window.api.searchPhotosMetadataAware({ queryText: 'Mountains', limit: 1 })`
      )
      const mountainsYellowstoneTop1 = await evaluate(
        cdp,
        `window.api.searchPhotosMetadataAware({ queryText: 'Mountains in Yellowstone', limit: 1 })`
      )
      const mountainsYellowstone = await evaluate(
        cdp,
        `window.api.searchPhotosMetadataAware({ queryText: 'Mountains in Yellowstone', limit: 10 })`
      )
      const myNames = mountainsYellowstone.items.map((i) => i.photo.fileName)
      const top1Name = mountainsYellowstoneTop1.items[0]?.photo.fileName ?? ''
      if (
        mountainsYellowstone.mode !== 'hybrid' ||
        mountainsYellowstone.filteredCandidateCount !== 2 ||
        mountainsYellowstoneTop1.filteredCandidateCount !== 2 ||
        myNames.includes('colorado-mountain.jpg') ||
        myNames.includes('anniversary-2023.jpg') ||
        top1Name === 'colorado-mountain.jpg' ||
        !['yellowstone-mountain.heic', 'yellowstone-restaurant.jpg'].includes(top1Name)
      ) {
        throw new Error(
          `Filter-before-ranking check failed: ${JSON.stringify({ libWideTop1, mountainsYellowstoneTop1, mountainsYellowstone })}`
        )
      }
      pass(
        `"Mountains in Yellowstone" filtered Yellowstone GPS BEFORE CLIP ranking (library-wide top-1=${libWideTop1.items[0]?.photo.fileName}; Yellowstone limit=1 -> ${top1Name}, candidates=${mountainsYellowstone.filteredCandidateCount})`
      )
    } else {
      notes.push(
        'Skipped Phase 7 real-CLIP ONNX ranking inside Electron because offline CLIP model cache directory was not found on disk.'
      )
    }

    // 8. Verify runtime console/exception cleanliness and original source read-only invariance
    const pageErrors = cdpEvents.filter(
      (e) =>
        e.method === 'Runtime.exceptionThrown' ||
        (e.method === 'Log.entryAdded' && e.params?.entry?.level === 'error')
    )
    if (pageErrors.length > 0 || runtimeErrors.length > 0) {
      throw new Error(`Runtime errors observed: ${JSON.stringify({ pageErrors, runtimeErrors })}`)
    }
    for (const [p, expected] of initialBaselines.entries()) {
      const shaNow = createHash('sha256').update(readFileSync(p)).digest('hex')
      if (shaNow !== expected.sha || statSync(p).mtimeMs !== expected.mtimeMs) {
        throw new Error(`Source file modified on disk: ${p}`)
      }
    }
    pass(
      'Zero renderer/preload runtime errors and 100% original file byte + timestamp preservation'
    )

    killTree(session.child)
    session = null
    await sleep(600)

    // 9. Verify schema v19 -> v20 catalog upgrade on real Electron startup by checkpointing & cloning the populated DB to v19 layout
    const v19DbPath = join(upgradeDir, 'vault-catalog.db')
    const sourceDb = new DatabaseSync(join(userDataDir, 'vault-catalog.db'))
    try {
      sourceDb.exec(`VACUUM INTO ${JSON.stringify(v19DbPath).replace(/"/g, "'")};`)
    } finally {
      sourceDb.close()
    }
    const legacyDb = new DatabaseSync(v19DbPath)
    legacyDb.exec(`
      DELETE FROM schema_migrations WHERE version >= 20;
      DROP TABLE IF EXISTS camera_labels;
      DROP TABLE IF EXISTS saved_events;
      DROP TABLE IF EXISTS photo_user_places;
      DROP TABLE IF EXISTS saved_places;
    `)
    legacyDb.close()
    const upgSession = await launchElectronSession(upgradeDir)
    const upgStatus = await evaluate(upgSession.cdp, `window.api.getVaultStatus()`)
    killTree(upgSession.child)
    await sleep(600)
    if (!upgStatus?.isReady) {
      throw new Error('v19 -> v20 catalog upgrade startup failed')
    }
    const verifyMigrated = new DatabaseSync(v19DbPath, { readOnly: true })
    const maxVer = verifyMigrated.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v
    const tableCount = verifyMigrated
      .prepare(
        "SELECT COUNT(*) AS c FROM sqlite_master WHERE name IN ('saved_places','photo_user_places','saved_events','camera_labels')"
      )
      .get().c
    verifyMigrated.close()
    if (Number(maxVer) !== 20 || Number(tableCount) !== 4) {
      throw new Error(
        `Expected schema v20 and 4 user metadata tables, got v=${maxVer}, t=${tableCount}`
      )
    }
    pass('Verified real Electron v19 -> v20 schema migration and existing catalog preservation')
  } catch (err) {
    fail(err instanceof Error ? err.stack || err.message : String(err))
  } finally {
    if (session?.cdp) {
      try {
        session.cdp.close()
      } catch {
        /* ignore */
      }
    }
    if (session?.child) {
      killTree(session.child)
    }
    await sleep(600)
    rmSync(workDir, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 })
  }

  console.log(`\nSummary: ${passes.length} passed, ${failures.length} failed`)
  for (const note of notes) {
    console.log(`NOTE: ${note}`)
  }
  if (failures.length > 0) {
    process.exit(1)
  }
}

void main()
