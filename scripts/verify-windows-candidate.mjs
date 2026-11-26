#!/usr/bin/env node
/**
 * Personal Vault — Host-Safe Windows Closeout Candidate Verification
 *
 * Safely verifies the exact built Windows installer candidate (`dist/Personal Vault Setup <version>.exe`)
 * on a host that already has Ron's personal installation (`D:\pv-stage-8d-trial\app\Personal Vault`),
 * without touching Ron's installed executable, registry entries, Start Menu shortcut, active profile, or vault:
 *
 * 1. Snapshots Ron's existing installation & registry state before and after execution.
 * 2. Verifies `dist/Personal Vault Setup <version>.exe` embeds the pinned Microsoft-signed `vc_redist.x64.exe`
 *    and extracts `$PLUGINSDIR/app-64.7z` byte-for-byte matching `dist/win-unpacked/` (zero `spikes/`).
 * 3. Launches the exact extracted candidate `Personal Vault.exe` against isolated `%TEMP%` profiles and
 *    disposable fixtures to verify:
 *    - Merged UI (Light/Dark Appearance menu + restart persistence, Photos onboarding, Top results + Details score)
 *    - HEIC & full-res JPEG thumbnails + lazy Open original viewer + A->B->A selection-change race
 *    - Offline CLIP photo search, EXIF metadata, PDF/TXT extraction + OCR, BGE document search, Unified search
 *    - Duplicate review & preferred location persistence, photo annotations, verified vault import
 *    - Selective export to an explicit non-default folder with privacy defaults & on-disk verification
 *    - Local backup, verification, isolated restore & catalog recovery from vault manifests (originals deleted)
 *    - 100% source-file SHA-256, byte size, birthtime, and mtime invariance
 * 4. Runs an isolated-appId (`com.personalvault.verifytest`, shortcuts disabled) NSIS install, `0.0.9 -> 0.1.0`
 *    upgrade, `v1 -> v19` catalog migration, uninstall data preservation, and `0.1.0` reinstall check.
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
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'
import sharp from 'sharp'

const __dirname = resolve(fileURLToPath(import.meta.url), '..')
const rootDir = resolve(__dirname, '..')
const require = createRequire(import.meta.url)

const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'))
const installerExe = join(rootDir, 'dist', `Personal Vault Setup ${pkg.version}.exe`)
const unpackedExe = join(rootDir, 'dist', 'win-unpacked', 'Personal Vault.exe')
const unpackedAsar = join(rootDir, 'dist', 'win-unpacked', 'resources', 'app.asar')

const PINNED_VCREDIST_SHA256 = 'cc0ff0eb1dc3f5188ae6300faef32bf5beeba4bdd6e8e445a9184072096b713b'

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

const RON_INSTALLED_EXE = 'D:\\pv-stage-8d-trial\\app\\Personal Vault\\Personal Vault.exe'
const RON_REG_KEY = 'HKCU:\\Software\\02482fee-70a8-5995-90c5-41322563d01a'
const RON_UNINSTALL_KEY =
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\02482fee-70a8-5995-90c5-41322563d01a'
const RON_SHORTCUT = join(
  process.env.APPDATA || '',
  'Microsoft',
  'Windows',
  'Start Menu',
  'Programs',
  'Personal Vault.lnk'
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function assert(cond, message) {
  if (!cond) {
    throw new Error(`Assertion failed: ${message}`)
  }
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex').toLowerCase()
}

function snapshotTree(dir) {
  const out = new Map()
  const walk = (cur) => {
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      const full = join(cur, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile()) {
        const st = statSync(full)
        out.set(full.slice(dir.length + 1).replace(/\\/g, '/'), {
          fullPath: full,
          sha256: sha256File(full),
          size: st.size,
          birthtimeMs: st.birthtimeMs,
          mtimeMs: st.mtimeMs
        })
      }
    }
  }
  walk(dir)
  return out
}

function assertTreeBitwiseUnchanged(dir, baseline, label) {
  const after = snapshotTree(dir)
  assert(
    after.size === baseline.size,
    `[${label}] File count changed: before=${baseline.size}, after=${after.size}`
  )
  for (const [rel, b] of baseline.entries()) {
    const a = after.get(rel)
    assert(a, `[${label}] Missing file after operation: ${rel}`)
    assert(a.size === b.size, `[${label}] Byte size changed for ${rel}: ${b.size} -> ${a.size}`)
    assert(a.sha256 === b.sha256, `[${label}] SHA-256 changed for ${rel}`)
    assert(
      Math.abs(a.mtimeMs - b.mtimeMs) <= 0.5,
      `[${label}] mtimeMs changed for ${rel}: ${b.mtimeMs} -> ${a.mtimeMs}`
    )
    assert(
      Math.abs(a.birthtimeMs - b.birthtimeMs) <= 0.5,
      `[${label}] birthtimeMs changed for ${rel}: ${b.birthtimeMs} -> ${a.birthtimeMs}`
    )
  }
}

function readRegistrySnapshot(regPath) {
  if (process.platform !== 'win32') return null
  const escaped = regPath.replace(/'/g, "''")
  const res = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `if (Test-Path '${escaped}') { Get-ItemProperty -Path '${escaped}' | ConvertTo-Json -Compress } else { 'MISSING' }`
    ],
    { encoding: 'utf8', stdio: 'pipe' }
  )
  return (res.stdout || '').trim()
}

function snapshotRonInstallation() {
  return {
    exeExists: existsSync(RON_INSTALLED_EXE),
    exeSha256: existsSync(RON_INSTALLED_EXE) ? sha256File(RON_INSTALLED_EXE) : null,
    regApp: readRegistrySnapshot(RON_REG_KEY),
    regUninstall: readRegistrySnapshot(RON_UNINSTALL_KEY),
    shortcutExists: Boolean(RON_SHORTCUT) && existsSync(RON_SHORTCUT),
    shortcutSha256:
      Boolean(RON_SHORTCUT) && existsSync(RON_SHORTCUT) ? sha256File(RON_SHORTCUT) : null
  }
}

function assertRonInstallationUnchanged(before) {
  const after = snapshotRonInstallation()
  assert(
    JSON.stringify(after) === JSON.stringify(before),
    `Ron's existing installation changed!\nBefore: ${JSON.stringify(before)}\nAfter:  ${JSON.stringify(after)}`
  )
}

async function resolve7zExecutable() {
  // Full 7z-x64.exe (+ 7z.dll) supports NSIS containers ($PLUGINSDIR/app-64.7z & vc_redist.x64.exe),
  // whereas standalone 7za.exe skips the NSIS header and carves only the first embedded 7z stream.
  const vendor7z = join(rootDir, 'node_modules', 'electron-winstaller', 'vendor', '7z-x64.exe')
  if (existsSync(vendor7z)) return vendor7z
  try {
    const { getPath7za } = require('app-builder-lib/out/toolsets/7zip.js')
    const p = await getPath7za()
    if (p && existsSync(p)) return p
  } catch {
    // fallback failed
  }
  throw new Error('Could not locate 7z-x64.exe / 7za.exe to inspect installer archive')
}

function extractArchive(sevenZipExe, archivePath, outDir, filesToExtract = []) {
  mkdirSync(outDir, { recursive: true })
  const args = ['x', '-y', `-o${outDir}`, archivePath, ...filesToExtract]
  const res = spawnSync(sevenZipExe, args, { stdio: 'pipe', encoding: 'utf8', timeout: 120_000 })
  if (res.status !== 0) {
    throw new Error(
      `7z extract failed for ${archivePath} (exit ${res.status}): ${res.stderr || res.stdout}`
    )
  }
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

function killTree(child) {
  if (!child || !child.pid || child.exitCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    child.kill('SIGKILL')
  }
}

async function findPageTarget(port, deadline, child, getLogs) {
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Electron exited early (code=${child.exitCode}, signal=${child.signalCode}): ${getLogs()}`
      )
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && t.url && !t.url.startsWith('devtools:'))
      if (page?.webSocketDebuggerUrl) return page
    } catch {
      // retry
    }
    await sleep(200)
  }
  throw new Error(`Timed out waiting for Electron CDP page target: ${getLogs()}`)
}

function connectCdp(url) {
  return new Promise((resolveCdp, reject) => {
    const ws = new WebSocket(url)
    let nextId = 1
    const pending = new Map()
    const runtimeErrors = []

    ws.onerror = () => reject(new Error('Could not connect to DevTools WebSocket'))
    ws.onmessage = (message) => {
      const data = JSON.parse(String(message.data))
      if (data.id && pending.has(data.id)) {
        const { ok, bad } = pending.get(data.id)
        pending.delete(data.id)
        data.error ? bad(new Error(data.error.message)) : ok(data.result)
      } else if (data.method === 'Runtime.exceptionThrown') {
        runtimeErrors.push(JSON.stringify(data.params))
      }
    }

    const send = (method, params = {}) =>
      new Promise((ok, bad) => {
        const id = nextId++
        pending.set(id, { ok, bad })
        ws.send(JSON.stringify({ id, method, params }))
      })

    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true
      })
      if (result.exceptionDetails) {
        throw new Error(
          result.exceptionDetails.exception?.description ||
            result.exceptionDetails.text ||
            'Renderer evaluation threw'
        )
      }
      return result.result?.value
    }

    ws.onopen = async () => {
      try {
        await send('Runtime.enable')
        resolveCdp({
          evaluate,
          runtimeErrors,
          close: () => {
            try {
              ws.close()
            } catch {
              // ignore
            }
          }
        })
      } catch (err) {
        reject(err)
      }
    }
  })
}

async function launchCandidateApp(exePath, userDataDir, cwd, extraEnv = {}) {
  const port = await freePort()
  const child = spawn(
    exePath,
    [`--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`],
    {
      cwd,
      env: {
        ...process.env,
        PV_TEST_MODEL_IMPORT_DIR: cachedClipModelDir,
        PV_TEST_DOC_MODEL_IMPORT_DIR: cachedBgeModelDir,
        PV_TEST_OCR_MODEL_IMPORT_DIR: cachedOcrModelDir,
        ...extraEnv
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  const logs = []
  const pushLog = (chunk) => {
    logs.push(chunk.toString('utf8'))
    if (logs.length > 40) logs.shift()
  }
  child.stdout?.on('data', pushLog)
  child.stderr?.on('data', pushLog)
  const getLogs = () => logs.join('').trim() || '(no output)'

  let cdp
  try {
    const page = await findPageTarget(port, Date.now() + 30_000, child, getLogs)
    cdp = await connectCdp(page.webSocketDebuggerUrl)
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      const ready = await cdp.evaluate(
        `Boolean(window.api && typeof window.api.getAppInfo === 'function' && document.querySelector('#main-sidebar'))`
      )
      if (ready) break
      await sleep(200)
    }
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for candidate Electron UI/bridge')
    }
  } catch (err) {
    cdp?.close()
    killTree(child)
    throw err
  }

  return {
    child,
    cdp,
    shutdown: async () => {
      cdp.close()
      killTree(child)
      await sleep(500)
    }
  }
}

async function createFixtures(fixturesDir) {
  mkdirSync(fixturesDir, { recursive: true })

  // 1. Full-res landscape & portrait JPEGs
  const landscapeJpg = join(fixturesDir, 'fullres-landscape.jpg')
  await sharp({
    create: { width: 4032, height: 3024, channels: 3, background: { r: 235, g: 130, b: 45 } }
  })
    .jpeg({ quality: 88 })
    .toFile(landscapeJpg)

  const portraitJpg = join(fixturesDir, 'fullres-portrait.jpg')
  await sharp({
    create: { width: 3024, height: 4032, channels: 3, background: { r: 30, g: 120, b: 195 } }
  })
    .jpeg({ quality: 88 })
    .toFile(portraitJpg)

  // 2. Repo HEIC fixtures
  const heicDir = join(rootDir, 'tests', 'fixtures', 'heic')
  for (const name of ['landscape.heic', 'portrait_exif6.heic', 'sunset_heic.heic']) {
    copyFileSync(join(heicDir, name), join(fixturesDir, name))
  }

  // 3. Exact duplicate PNG pair (visually distinct green scene for CLIP too)
  const dupBytes = await sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240">
        <rect width="320" height="140" fill="#38bdf8"/>
        <circle cx="260" cy="50" r="24" fill="#fde047"/>
        <polygon points="0,240 110,90 220,240" fill="#475569"/>
        <rect y="200" width="320" height="40" fill="#15803d"/>
      </svg>`
    )
  )
    .png()
    .toBuffer()
  writeFileSync(join(fixturesDir, 'dup-a.png'), dupBytes)
  const nestedDupDir = join(fixturesDir, 'nested')
  mkdirSync(nestedDupDir, { recursive: true })
  writeFileSync(join(nestedDupDir, 'dup-b.png'), dupBytes)

  // 4. Scanned image-only PDF for OCR
  const pdfPath = join(fixturesDir, 'scanned-invoice.pdf')
  const canvas = createCanvas(900, 360)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, 900, 360)
  ctx.fillStyle = '#000000'
  ctx.font = 'bold 48px sans-serif'
  ctx.fillText('INVOICE TOTAL 420 USD', 48, 130)
  ctx.fillText('ORDER REF 7781', 48, 220)
  const jpegBuf = canvas.toBuffer('image/jpeg', 92)

  const streamContent = 'q 500 0 0 200 56 500 cm /Im0 Do Q'
  const obj1 = '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'
  const obj2 = '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n'
  const obj3 =
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n'
  const obj4Header = Buffer.from(
    `4 0 obj\n<< /Type /XObject /Subtype /Image /Width 900 /Height 360 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBuf.length} >>\nstream\n`,
    'latin1'
  )
  const obj4Footer = Buffer.from('\nendstream\nendobj\n', 'latin1')
  const obj5 = `5 0 obj\n<< /Length ${Buffer.byteLength(streamContent, 'latin1')} >>\nstream\n${streamContent}\nendstream\nendobj\n`

  const chunks = [Buffer.from('%PDF-1.4\n', 'latin1')]
  const offsets = [0]
  let pos = chunks[0].length
  const pushBuf = (b) => {
    offsets.push(pos)
    chunks.push(b)
    pos += b.length
  }
  pushBuf(Buffer.from(obj1, 'latin1'))
  pushBuf(Buffer.from(obj2, 'latin1'))
  pushBuf(Buffer.from(obj3, 'latin1'))
  offsets.push(pos)
  chunks.push(obj4Header, jpegBuf, obj4Footer)
  pos += obj4Header.length + jpegBuf.length + obj4Footer.length
  pushBuf(Buffer.from(obj5, 'latin1'))
  const xrefPos = pos
  let xref = 'xref\n0 6\n0000000000 65535 f \n'
  for (let i = 1; i <= 5; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  xref += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`
  chunks.push(Buffer.from(xref, 'latin1'))
  writeFileSync(pdfPath, Buffer.concat(chunks))

  // 5. Text receipt document for extraction, classification, BGE search, and export
  const txtPath = join(fixturesDir, 'tax-receipt-2025.txt')
  writeFileSync(
    txtPath,
    'Receipt #4481-B\nPaid in full: $125.00 municipal property tax assessment for parcel 4481-B.\nDate: 2025-10-12\nTotal: $125.00',
    'utf8'
  )

  return {
    landscapeJpg,
    portraitJpg,
    pdfPath,
    txtPath,
    hashes: {
      landscapeJpg: sha256File(landscapeJpg),
      portraitJpg: sha256File(portraitJpg),
      dupPng: createHash('sha256').update(dupBytes).digest('hex').toLowerCase(),
      pdf: sha256File(pdfPath),
      txt: sha256File(txtPath)
    }
  }
}

function buildIsolatedNsisInstaller(version, outputDir) {
  const electronBuilderCli = join(rootDir, 'node_modules', 'electron-builder', 'cli.js')
  const res = spawnSync(
    process.execPath,
    [
      electronBuilderCli,
      '--win',
      'nsis',
      '--x64',
      '-c.appId=com.personalvault.verifytest',
      '-c.productName=Personal Vault VerifyTest',
      '-c.nsis.shortcutName=Personal Vault VerifyTest',
      '-c.nsis.createDesktopShortcut=false',
      '-c.nsis.createStartMenuShortcut=false',
      `-c.extraMetadata.version=${version}`,
      `-c.directories.output=${outputDir}`
    ],
    {
      cwd: rootDir,
      stdio: 'pipe',
      timeout: 240_000
    }
  )
  if (res.status !== 0) {
    throw new Error(
      `Building isolated NSIS ${version} installer failed (exit ${res.status}): ${res.stderr?.toString() || res.stdout?.toString()}`
    )
  }
  const exe = join(outputDir, `Personal Vault VerifyTest Setup ${version}.exe`)
  assert(existsSync(exe), `Expected isolated installer at ${exe}`)
  return exe
}

function runSilentInstaller(exePath, installDir) {
  const res = spawnSync(exePath, ['/S', `/D=${installDir}`], {
    stdio: 'pipe',
    timeout: 180_000
  })
  if (res.status !== 0) {
    throw new Error(
      `Silent NSIS install failed (${res.status}): ${res.stderr?.toString() || res.stdout?.toString()}`
    )
  }
}

async function runSilentUninstaller(uninstallerExe, expectedRemovedFile) {
  const res = spawnSync(uninstallerExe, ['/S'], { stdio: 'pipe', timeout: 120_000 })
  if (res.status !== 0) {
    throw new Error(`Silent NSIS uninstall failed (${res.status})`)
  }
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (!existsSync(expectedRemovedFile)) return
    await sleep(300)
  }
  throw new Error(`Timed out waiting for ${expectedRemovedFile} removal during uninstall`)
}

function seedV1Catalog(v1ProfileDir, fixturesDir, photoPath, photoSha256) {
  mkdirSync(v1ProfileDir, { recursive: true })
  const dbPath = join(v1ProfileDir, 'vault-catalog.db')
  const db = new DatabaseSync(dbPath)
  const now = Date.now() - 86_400_000
  const st = statSync(photoPath)
  db.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL, applied_at_ms INTEGER NOT NULL);
    CREATE TABLE sources (id INTEGER PRIMARY KEY AUTOINCREMENT, root_path TEXT NOT NULL, normalized_root_path TEXT NOT NULL UNIQUE, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
    CREATE TABLE file_locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      original_path TEXT NOT NULL, normalized_path TEXT NOT NULL UNIQUE, file_name TEXT NOT NULL, extension TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('photo', 'document')), byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
      filesystem_birthtime_ms NUMERIC, filesystem_mtime_ms NUMERIC, inferred_capture_time_ms INTEGER,
      first_discovered_at_ms INTEGER NOT NULL, last_seen_at_ms INTEGER NOT NULL
    );
    CREATE TABLE hash_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, file_location_id INTEGER NOT NULL REFERENCES file_locations(id) ON DELETE CASCADE,
      sha256 TEXT NOT NULL CHECK (length(sha256) = 64), observed_byte_size INTEGER NOT NULL CHECK (observed_byte_size >= 0),
      observed_mtime_ms NUMERIC, hashed_at_ms INTEGER NOT NULL, is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
    );
  `)
  const normRoot = fixturesDir.replace(/\\/g, '/').toLowerCase()
  const normFile = photoPath.replace(/\\/g, '/').toLowerCase()
  const sRes = db
    .prepare(
      'INSERT INTO sources (root_path, normalized_root_path, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?)'
    )
    .run(fixturesDir, normRoot, now, now)
  const fRes = db
    .prepare(
      `INSERT INTO file_locations (
        source_id, original_path, normalized_path, file_name, extension, category, byte_size,
        filesystem_birthtime_ms, filesystem_mtime_ms, inferred_capture_time_ms, first_discovered_at_ms, last_seen_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      sRes.lastInsertRowid,
      photoPath,
      normFile,
      'fullres-landscape.jpg',
      '.jpg',
      'photo',
      st.size,
      st.birthtimeMs,
      st.mtimeMs,
      null,
      now,
      now
    )
  db.prepare(
    'INSERT INTO hash_observations (file_location_id, sha256, observed_byte_size, observed_mtime_ms, hashed_at_ms, is_active) VALUES (?, ?, ?, ?, ?, 1)'
  ).run(fRes.lastInsertRowid, photoSha256, st.size, st.mtimeMs, now)
  db.prepare('INSERT INTO schema_migrations (version, name, applied_at_ms) VALUES (?, ?, ?)').run(
    1,
    'initial_catalog_schema',
    now
  )
  db.close()
}

async function main() {
  const skipNsisLifecycle = process.argv.includes('--skip-nsis-lifecycle')
  assert(
    existsSync(installerExe),
    `Installer missing: ${installerExe}. Run npm run build:installer first.`
  )
  assert(
    existsSync(unpackedExe),
    `Unpacked exe missing: ${unpackedExe}. Run npm run build:installer first.`
  )
  assert(existsSync(unpackedAsar), `Unpacked app.asar missing: ${unpackedAsar}`)
  assert(existsSync(cachedClipModelDir), `CLIP cache missing: ${cachedClipModelDir}`)
  assert(existsSync(cachedBgeModelDir), `BGE cache missing: ${cachedBgeModelDir}`)
  assert(existsSync(cachedOcrModelDir), `OCR cache missing: ${cachedOcrModelDir}`)

  const ronBefore = snapshotRonInstallation()
  const installerSha256 = sha256File(installerExe)
  const unpackedExeSha256 = sha256File(unpackedExe)
  const unpackedAsarSha256 = sha256File(unpackedAsar)
  console.log(`[INFO] Candidate Installer: ${installerExe} (${statSync(installerExe).size} bytes)`)
  console.log(`[INFO] Candidate Installer SHA-256: ${installerSha256}`)
  console.log(`[INFO] Unpacked Exe SHA-256: ${unpackedExeSha256}`)

  const workRoot = mkdtempSync(join(tmpdir(), 'pv-win-closeout-'))
  const nsisExtractDir = join(workRoot, 'nsis-extracted')
  const candidateAppDir = join(workRoot, 'candidate-app')
  const fixturesDir = join(workRoot, 'fixtures')
  const profileDir = join(workRoot, 'profile')
  const vaultDir = join(workRoot, 'vault')
  const nonDefaultExportDir = join(workRoot, 'custom-nondefault-export-target')
  const backupRepoDir = join(workRoot, 'backup-repo')
  const restoreProfileDir = join(workRoot, 'restored', 'profile')
  const restoreVaultDir = join(workRoot, 'restored', 'vault')
  const recoverySourcesDir = join(workRoot, 'recovery-sources')
  const recoverySeedProfileDir = join(workRoot, 'recovery-seed-profile')
  const recoveryVaultDir = join(workRoot, 'recovery-vault')
  const recoveryProfileDir = join(workRoot, 'recovery-profile')
  const neutralCwd = join(workRoot, 'neutral-cwd')

  mkdirSync(nonDefaultExportDir, { recursive: true })
  mkdirSync(backupRepoDir, { recursive: true })
  mkdirSync(neutralCwd, { recursive: true })

  let isoUninstallerExe = null
  let isoInstalledExe = null

  try {
    // 1. Extract & verify the exact NSIS installer payload against dist/win-unpacked
    const sevenZipExe = await resolve7zExecutable()
    extractArchive(sevenZipExe, installerExe, nsisExtractDir, [
      '$PLUGINSDIR\\app-64.7z',
      '$PLUGINSDIR\\vc_redist.x64.exe'
    ])
    const app64Path = join(nsisExtractDir, '$PLUGINSDIR', 'app-64.7z')
    const embeddedVcRedist = join(nsisExtractDir, '$PLUGINSDIR', 'vc_redist.x64.exe')
    assert(existsSync(app64Path), `Missing $PLUGINSDIR/app-64.7z in ${installerExe}`)
    assert(existsSync(embeddedVcRedist), `Missing $PLUGINSDIR/vc_redist.x64.exe in ${installerExe}`)
    assert(
      sha256File(embeddedVcRedist) === PINNED_VCREDIST_SHA256,
      `Embedded vc_redist.x64.exe SHA-256 mismatch`
    )
    extractArchive(sevenZipExe, app64Path, candidateAppDir)

    const candidateExe = join(candidateAppDir, 'Personal Vault.exe')
    const candidateAsar = join(candidateAppDir, 'resources', 'app.asar')
    assert(existsSync(candidateExe), 'Extracted candidate Personal Vault.exe missing')
    assert(existsSync(candidateAsar), 'Extracted candidate app.asar missing')
    assert(
      existsSync(join(candidateAppDir, 'THIRD_PARTY_NOTICES.md')),
      'THIRD_PARTY_NOTICES.md missing'
    )
    assert(
      existsSync(join(candidateAppDir, 'LICENSE.electron.txt')),
      'LICENSE.electron.txt missing'
    )
    assert(
      existsSync(join(candidateAppDir, 'LICENSES.chromium.html')),
      'LICENSES.chromium.html missing'
    )
    assert(
      !existsSync(join(candidateAppDir, 'resources', 'spikes')),
      'spikes/ must not be packaged'
    )
    assert(
      sha256File(candidateExe) === unpackedExeSha256,
      'Installer Personal Vault.exe differs from win-unpacked'
    )
    assert(
      sha256File(candidateAsar) === unpackedAsarSha256,
      'Installer app.asar differs from win-unpacked'
    )
    console.log(
      '[PASS] 1. Extracted candidate installer payload matches dist/win-unpacked and embeds pinned vc_redist.x64.exe'
    )

    // 2. Prepare fixtures & snapshot baselines
    const fixtures = await createFixtures(fixturesDir)
    const fixturesBaseline = snapshotTree(fixturesDir)

    // Launch exact extracted candidate binary
    let app = await launchCandidateApp(candidateExe, profileDir, neutralCwd)
    let exportJobId = ''
    let dupGroupSha = ''
    let dupGroupByteSize = 0
    let dupPreferredId = 0
    let ratedPhotoId = 0
    let completedSnapshotId = ''
    let expectedVaultFiles = new Map()

    try {
      // Phase A: Merged UI (Theme, Photos onboarding)
      const uiInit = await app.cdp.evaluate(`(async () => {
        const themeBefore = document.documentElement.dataset.theme;
        document.querySelector('[data-testid="app-menu-btn"]')?.click();
        await new Promise((r) => setTimeout(r, 50));
        document.querySelector('[data-testid="theme-option-dark"]')?.click();
        await new Promise((r) => setTimeout(r, 50));
        const themeAfter = document.documentElement.dataset.theme;
        const storedTheme = localStorage.getItem('pv.appearance.theme');

        const photosBtn = Array.from(document.querySelectorAll('#main-sidebar button')).find(
          (b) => /^Photos$/i.test((b.textContent || '').trim())
        );
        photosBtn?.click();
        let hasEmptyState = false;
        let hasEmptyAddPhotos = false;
        for (let i = 0; i < 40; i++) {
          const emptySec = document.querySelector('.empty-state-container');
          const addBtn = Array.from(emptySec?.querySelectorAll('button') || []).find((b) =>
            /Add photos/i.test(b.textContent || '')
          );
          hasEmptyState = Boolean(emptySec);
          hasEmptyAddPhotos = Boolean(addBtn);
          if (hasEmptyState && hasEmptyAddPhotos) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        return {
          themeBefore,
          themeAfter,
          storedTheme,
          hasEmptyState,
          hasEmptyAddPhotos
        };
      })()`)
      assert(
        uiInit.themeBefore === 'light',
        `Expected default light theme, got ${uiInit.themeBefore}`
      )
      assert(
        uiInit.themeAfter === 'dark' && uiInit.storedTheme === 'dark',
        'Dark theme toggle failed'
      )
      assert(
        uiInit.hasEmptyState && uiInit.hasEmptyAddPhotos,
        `Empty-state Photos onboarding UI missing: ${JSON.stringify(uiInit)}`
      )
      console.log(
        '[PASS] Phase A. Merged Light/Dark Appearance menu & empty-state Add photos onboarding verified'
      )

      // Phase B: Scan + Photos toolbar/search onboarding + HEIC / Full-res JPEG thumbnails + Open original + A->B->A race
      const phaseB = await app.cdp.evaluate(`(async () => {
        const scanStart = await window.api.startScan({ roots: [${JSON.stringify(fixturesDir)}] });
        if (!scanStart.success) throw new Error('startScan failed');
        for (let i = 0; i < 200; i++) {
          const latest = await window.api.getLatestScanJob();
          if (latest?.job?.status === 'completed') break;
          if (latest?.job?.status === 'failed') throw new Error('Scan failed');
          await new Promise((r) => setTimeout(r, 100));
        }

        let hasAddPhotos = false;
        let hasEnableSearch = false;
        for (let i = 0; i < 40; i++) {
          hasAddPhotos = Boolean(document.querySelector('[data-testid="photos-add-photos-btn"]'));
          hasEnableSearch = Boolean(document.querySelector('[data-testid="turn-on-photo-search-btn"]'));
          if (hasAddPhotos && hasEnableSearch) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        if (!hasAddPhotos || !hasEnableSearch) {
          throw new Error('Populated Photos onboarding buttons missing: ' + JSON.stringify({ hasAddPhotos, hasEnableSearch }));
        }

        const photosPage = await window.api.getPhotosPage({ limit: 50, offset: 0 });
        const byName = Object.fromEntries(photosPage.items.map((p) => [p.fileName, p]));
        const expectedDims = {
          'fullres-landscape.jpg': [4032, 3024],
          'fullres-portrait.jpg': [3024, 4032],
          'landscape.heic': [160, 100],
          'portrait_exif6.heic': [100, 160],
          'sunset_heic.heic': [256, 256]
        };

        const thumbResults = {};
        const origResults = {};
        for (const [name, [expW, expH]] of Object.entries(expectedDims)) {
          const item = byName[name];
          if (!item) throw new Error('Missing scanned photo ' + name);
          const thumb = await window.api.getThumbnail({ locationId: item.id, priority: 'high' });
          if (thumb.status !== 'ready' || !thumb.dataUrl) {
            throw new Error('Thumbnail not ready for ' + name + ': ' + JSON.stringify(thumb));
          }
          thumbResults[name] = { width: thumb.width, height: thumb.height };

          const orig = await window.api.getOriginalPhoto({ locationId: item.id });
          if (orig.status !== 'ready' || orig.width !== expW || orig.height !== expH) {
            throw new Error('Original mismatch for ' + name + ': ' + JSON.stringify({ status: orig.status, w: orig.width, h: orig.height, expW, expH }));
          }
          origResults[name] = { width: orig.width, height: orig.height };
        }

        // UI Open original + A -> B -> A race in Photos tab
        const photoA = byName['portrait_exif6.heic'];
        const photoB = byName['landscape.heic'];
        for (let i = 0; i < 40; i++) {
          if (
            document.getElementById('photo-cell-' + photoA.id) &&
            document.getElementById('photo-cell-' + photoB.id)
          ) {
            break;
          }
          await new Promise((r) => setTimeout(r, 100));
        }
        document.getElementById('photo-cell-' + photoA.id)?.click();
        for (let i = 0; i < 30; i++) {
          if (document.querySelector('[data-testid="photos-open-original-btn"]')) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        document.querySelector('[data-testid="photos-open-original-btn"]')?.click();
        let modalOpened = false;
        for (let i = 0; i < 60; i++) {
          const img = document.querySelector('[data-testid="photos-original-img"]');
          const dims = document.querySelector('[data-testid="photos-original-dims"]')?.textContent || '';
          if (img && dims.includes('100') && dims.includes('160')) {
            modalOpened = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 100));
        }
        if (!modalOpened) throw new Error('Open original modal did not render portrait_exif6.heic (100x160)');

        // Switch A -> B -> A and verify modal closes and stays closed
        document.getElementById('photo-cell-' + photoB.id)?.click();
        await new Promise((r) => setTimeout(r, 80));
        const closedOnB = !document.querySelector('[data-testid="photos-original-modal"]');
        document.getElementById('photo-cell-' + photoA.id)?.click();
        await new Promise((r) => setTimeout(r, 80));
        const stayedClosedOnReturnA = !document.querySelector('[data-testid="photos-original-modal"]');

        return { totalPhotos: photosPage.totalCount, thumbResults, origResults, modalOpened, closedOnB, stayedClosedOnReturnA };
      })()`)
      assert(phaseB.totalPhotos === 7, `Expected 7 photos, got ${phaseB.totalPhotos}`)
      assert(
        phaseB.closedOnB && phaseB.stayedClosedOnReturnA,
        `Open original A->B->A race failed: ${JSON.stringify(phaseB)}`
      )
      console.log(
        '[PASS] Phase B. Scan, HEIC/JPEG thumbnails, Open original dimensions & A->B->A race verified'
      )

      // Phase C: Offline Models, EXIF, CLIP search, Document Extraction/OCR/BGE/Classification & Unified search
      const phaseC = await app.cdp.evaluate(`(async () => {
        await window.api.importSemanticModelFromFolder();
        await window.api.importOcrModel();
        await window.api.importDocSemanticModel();
        for (let i = 0; i < 80; i++) {
          const [c, o, b] = await Promise.all([
            window.api.getSemanticModelStatus(),
            window.api.getOcrModelStatus(),
            window.api.getDocSemanticModelStatus()
          ]);
          if (c.state === 'ready' && o.state === 'ready' && b.state === 'ready') break;
          await new Promise((r) => setTimeout(r, 150));
        }

        await window.api.startPhotoMetadataExtraction();
        await window.api.startSemanticIndexing();
        await window.api.startDocumentExtraction();
        await window.api.startDocumentOcr();
        await window.api.startDocumentClassification();

        for (let i = 0; i < 300; i++) {
          const [pm, si, de, docr, dcls] = await Promise.all([
            window.api.getPhotoMetadataProgress(),
            window.api.getSemanticIndexProgress(),
            window.api.getDocumentExtractionProgress(),
            window.api.getDocumentOcrProgress(),
            window.api.getDocumentClassificationProgress()
          ]);
          const done = [pm, si, de, docr, dcls].every((p) => p.status === 'completed');
          const bad = [pm, si, de, docr, dcls].find((p) => p.status === 'failed');
          if (bad) throw new Error('Background job failed: ' + JSON.stringify(bad));
          if (done) break;
          await new Promise((r) => setTimeout(r, 150));
        }

        await window.api.startDocumentSemanticIndexing();
        for (let i = 0; i < 200; i++) {
          const ds = await window.api.getDocumentSemanticProgress();
          if (ds.status === 'completed') break;
          if (ds.status === 'failed') throw new Error('Doc semantic indexing failed: ' + JSON.stringify(ds));
          await new Promise((r) => setTimeout(r, 150));
        }

        // Photos UI Top results + Details score UX check
        const input = document.querySelector('.photos-search-input');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, 'sunset sky mountains');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 50));
        document.querySelector('.photos-search-submit-btn')?.click();

        let topVisible = false;
        for (let i = 0; i < 60; i++) {
          if (document.querySelector('[data-testid="photos-top-results"] .photo-featured-card')) {
            topVisible = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 100));
        }
        if (!topVisible) throw new Error('Photos Top results did not appear');
        if (document.querySelectorAll('.badge-similarity-score').length !== 0) {
          throw new Error('Unexpected raw % match overlay on thumbnails');
        }
        document.querySelector('[data-testid="photos-top-results"] .photo-featured-card')?.click();
        let detailScore = '';
        for (let i = 0; i < 40; i++) {
          detailScore = document.querySelector('[data-testid="photo-search-similarity-detail"]')?.textContent || '';
          if (/not a probability/i.test(detailScore)) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        if (!/not a probability/i.test(detailScore)) {
          throw new Error('Search Relevance detail missing: ' + detailScore);
        }
        document.querySelector('.photos-search-clear-btn')?.click();

        // Check OCR + Documents + Copy text button + Unified search
        const docsPage = await window.api.getDocumentsPage({ limit: 20, offset: 0 });
        const pdfDoc = docsPage.items.find((d) => d.fileName === 'scanned-invoice.pdf');
        const txtDoc = docsPage.items.find((d) => d.fileName === 'tax-receipt-2025.txt');
        if (!pdfDoc || !txtDoc) throw new Error('Missing expected documents');
        const ocrPrev = await window.api.getDocumentOcrPreview({ fileLocationId: pdfDoc.fileLocationId });
        const ocrText = ocrPrev?.preview?.extractedText || '';
        if (!/INVOICE|420|ORDER|7781/i.test(ocrText)) {
          throw new Error('OCR preview missing invoice text: ' + JSON.stringify(ocrPrev));
        }

        const docsNav = Array.from(document.querySelectorAll('#main-sidebar button')).find(
          (b) => /^Documents$/i.test((b.textContent || '').trim())
        );
        docsNav?.click();
        let txtBtn = null;
        for (let i = 0; i < 40; i++) {
          txtBtn = Array.from(document.querySelectorAll('button')).find((el) =>
            (el.querySelector('.documents-row-title')?.textContent || '').includes('tax-receipt-2025.txt')
          );
          if (txtBtn) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        txtBtn?.click();
        let hasCopyBtn = false;
        const canClipboard = typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function';
        if (canClipboard) {
          for (let i = 0; i < 30; i++) {
            if (document.querySelector('[data-testid="document-copy-extracted-text-btn"]')) {
              hasCopyBtn = true;
              break;
            }
            await new Promise((r) => setTimeout(r, 100));
          }
        }

        const docSearch = await window.api.searchDocumentsSemantic({ query: 'INVOICE 420', offset: 0, limit: 10 });
        const [uniPhotos, uniDocs] = await Promise.all([
          window.api.searchUnifiedPhotos({ query: 'sunset mountain', ownerSurface: 'unified', ownerGen: 99, offset: 0, limit: 10 }),
          window.api.searchUnifiedDocuments({ query: 'municipal property tax receipt', ownerSurface: 'unified', ownerGen: 99, offset: 0, limit: 10 })
        ]);
        if (!uniPhotos.result?.items?.length || !uniDocs.result?.items?.length || !docSearch.items?.length) {
          throw new Error('Search returned empty results: ' + JSON.stringify({
            uniPhotos: uniPhotos.result?.items?.length,
            uniPhotosStatus: uniPhotos.status,
            uniDocs: uniDocs.result?.items?.length,
            uniDocsStatus: uniDocs.status,
            docSearch: docSearch.items?.length
          }));
        }

        return {
          ocrTextLength: ocrText.length,
          canClipboard,
          hasCopyBtn,
          uniPhotosCount: uniPhotos.result.items.length,
          uniDocsCount: uniDocs.result.items.length,
          docSearchCount: docSearch.items.length,
          txtLocationId: txtDoc.fileLocationId
        };
      })()`)
      assert(
        !phaseC.canClipboard || phaseC.hasCopyBtn,
        'Copy text button did not appear despite clipboard API availability'
      )
      console.log(
        `[PASS] Phase C. Search (CLIP + OCR + BGE + Unified) & merged UI verified: ${JSON.stringify(phaseC)}`
      )

      // Phase D: Duplicates review, photo annotations & verified vault import
      const phaseD = await app.cdp.evaluate(`(async () => {
        const groups = await window.api.getDuplicateGroups({ offset: 0, limit: 10 });
        if (groups.totalCount !== 1) throw new Error('Expected 1 duplicate group, got ' + groups.totalCount);
        const group = groups.items[0];
        const members = await window.api.getDuplicateGroupMembers({ sha256: group.sha256, byteSize: group.byteSize, offset: 0, limit: 10 });
        if (members.items.length !== 2) throw new Error('Expected 2 dup members');
        const prefId = members.items[0].fileLocationId;
        await window.api.setDuplicateReview({
          sha256: group.sha256,
          byteSize: group.byteSize,
          status: 'reviewed',
          preferredLocationId: prefId,
          expectedGroupSignature: group.groupSignature
        });

        const photos = await window.api.getPhotosPage({ limit: 50, offset: 0 });
        const targetPhoto = photos.items.find((p) => p.fileName === 'sunset_heic.heic');
        const ann0 = await window.api.getPhotoAnnotation({ fileLocationId: targetPhoto.id });
        const rev = ann0.annotation?.revision ?? ('rev:' + targetPhoto.discoveryObservationId + ':' + targetPhoto.byteSize + ':' + (targetPhoto.filesystemMtimeMs ?? 'null') + ':' + (targetPhoto.activeHash ?? 'unhashed'));
        await window.api.setPhotoAnnotation({
          fileLocationId: targetPhoto.id,
          expectedRevision: rev,
          expectedVersion: ann0.annotation?.version ?? 0,
          rating: 5,
          flag: 'pick'
        });

        const init = await window.api.initializeVault({ vaultPath: ${JSON.stringify(vaultDir)}, vaultName: 'Closeout Candidate Vault' });
        const cands = await window.api.getImportCandidates({ vaultId: init.vault.vaultId, offset: 0, limit: 50 });
        await window.api.startImport({ vaultId: init.vault.vaultId, fileLocationIds: cands.items.map((c) => c.fileLocationId) });
        for (let i = 0; i < 200; i++) {
          const latest = await window.api.getLatestImportJob();
          if (latest?.job?.status === 'completed') break;
          if (latest?.job?.status === 'failed') throw new Error('Import failed');
          await new Promise((r) => setTimeout(r, 100));
        }

        return {
          dupSha: group.sha256,
          dupByteSize: group.byteSize,
          prefId,
          ratedPhotoId: targetPhoto.id,
          candidateCount: cands.items.length
        };
      })()`)
      dupGroupSha = phaseD.dupSha
      dupGroupByteSize = phaseD.dupByteSize
      dupPreferredId = phaseD.prefId
      ratedPhotoId = phaseD.ratedPhotoId
      assert(
        phaseD.candidateCount === 9,
        `Expected 9 import candidates, got ${phaseD.candidateCount}`
      )
      console.log('[PASS] Phase D. Duplicate review, annotations & verified vault import verified')

      // Snapshot vault payloads (excluding manifest.json / vault.json)
      const vaultTree = snapshotTree(join(vaultDir, 'files'))
      for (const [rel, meta] of vaultTree.entries()) {
        if (!rel.endsWith('manifest.json')) {
          expectedVaultFiles.set(rel, meta.sha256)
        }
      }
      assert(
        expectedVaultFiles.size === 8,
        `Expected 8 deduplicated vault payload files, got ${expectedVaultFiles.size}`
      )

      // Phase E: Selective export to explicit non-default folder
      const phaseE = await app.cdp.evaluate(`(async () => {
        const docs = await window.api.getDocumentsPage({ limit: 20, offset: 0 });
        const txtDoc = docs.items.find((d) => d.fileName === 'tax-receipt-2025.txt');
        const job = await window.api.startExport({
          parentDir: ${JSON.stringify(nonDefaultExportDir)},
          bundleFolderName: 'closeout-nondefault-bundle',
          fileLocationIds: [${ratedPhotoId}, txtDoc.fileLocationId],
          privacyOptions: { includeOriginalPaths: false, includeExtractedText: false }
        });
        let finalJob = job;
        for (let i = 0; i < 120; i++) {
          finalJob = await window.api.getExportJob(job.id);
          if (finalJob && (finalJob.status === 'completed' || finalJob.status === 'failed')) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        const verifiedJob = await window.api.verifyExportJob(job.id);
        return { finalJob, verifiedJob };
      })()`)
      exportJobId = phaseE.finalJob.id
      assert(
        phaseE.finalJob.status === 'completed' &&
          phaseE.finalJob.bundleVerified === true &&
          phaseE.verifiedJob.bundleVerified === true &&
          phaseE.finalJob.exportedItems === 2,
        `Non-default folder export failed: ${JSON.stringify(phaseE)}`
      )
      const bundleDir = phaseE.finalJob.bundleDir
      assert(
        sha256File(join(bundleDir, 'tax-receipt-2025.txt')) === fixtures.hashes.txt,
        'Exported tax-receipt-2025.txt SHA-256 mismatch'
      )
      const txtSidecar = readFileSync(join(bundleDir, 'tax-receipt-2025.txt.pv-meta.json'), 'utf8')
      assert(!txtSidecar.includes(fixturesDir), 'Default export leaked source path')
      assert(!txtSidecar.includes('municipal property tax'), 'Default export leaked extracted text')
      console.log(
        '[PASS] Phase E. Selective export to explicit non-default folder & privacy defaults verified'
      )
    } finally {
      await app.shutdown()
    }

    // Phase F: Restart persistence (Dark theme, duplicate review, annotations, active vault, export history, startup.log hygiene)
    app = await launchCandidateApp(candidateExe, profileDir, neutralCwd)
    try {
      const phaseF = await app.cdp.evaluate(`(async () => {
        const themeAfterRestart = document.documentElement.dataset.theme;
        const groups = await window.api.getDuplicateGroups({ offset: 0, limit: 10 });
        const g = groups.items[0];
        const ann = await window.api.getPhotoAnnotation({ fileLocationId: ${ratedPhotoId} });
        const activeVault = await window.api.getActiveVault();
        const expJob = await window.api.getExportJob(${JSON.stringify(exportJobId)});
        return { themeAfterRestart, g, ann: ann.annotation, vaultPath: activeVault.vault?.vaultPath, expJob };
      })()`)
      assert(phaseF.themeAfterRestart === 'dark', 'Dark theme did not persist across restart')
      assert(
        phaseF.g.sha256 === dupGroupSha &&
          phaseF.g.byteSize === dupGroupByteSize &&
          phaseF.g.reviewStatus === 'reviewed' &&
          phaseF.g.preferredLocationId === dupPreferredId,
        `Duplicate review lost across restart: ${JSON.stringify(phaseF.g)}`
      )
      assert(
        phaseF.ann?.rating === 5 && phaseF.ann?.flag === 'pick',
        'Photo annotation lost across restart'
      )
      assert(phaseF.vaultPath === vaultDir, 'Active vault lost across restart')
      assert(phaseF.expJob?.bundleVerified === true, 'Export job history lost across restart')

      const startupLog = readFileSync(join(profileDir, 'startup.log'), 'utf8')
      assert(
        !/accessToken|refreshToken|recoverySecret|PV_GOOGLE_CLIENT_SECRET/i.test(startupLog),
        'Sensitive token/secret found in startup.log'
      )
      console.log(
        '[PASS] Phase F. Restart persistence (Dark theme, reviews, annotations, vault, export) & log hygiene verified'
      )

      // Phase G: Local backup, verify & isolated restore
      const phaseG = await app.cdp.evaluate(`(async () => {
        const dest = await window.api.configureBackupDestination({
          name: 'Closeout Local Backup',
          kind: 'local_fs',
          targetPath: ${JSON.stringify(backupRepoDir)}
        });
        const job = await window.api.startBackup({ destinationId: dest.id });
        let done = job;
        for (let i = 0; i < 200; i++) {
          done = await window.api.getBackupJob(job.id);
          if (done && (done.status === 'completed' || done.status === 'failed')) break;
          await new Promise((r) => setTimeout(r, 150));
        }
        if (!done || done.status !== 'completed') {
          throw new Error('Local backup failed: ' + JSON.stringify(done));
        }
        const verified = await window.api.verifyRecoveryPoint({
          backupRepoDir: ${JSON.stringify(backupRepoDir)},
          snapshotId: done.snapshotId
        });
        const restored = await window.api.restoreRecoveryPoint({
          backupRepoDir: ${JSON.stringify(backupRepoDir)},
          snapshotId: done.snapshotId,
          targetProfileDir: ${JSON.stringify(restoreProfileDir)},
          targetVaultDir: ${JSON.stringify(restoreVaultDir)}
        });
        return { snapshotId: done.snapshotId, verified, restored };
      })()`)
      completedSnapshotId = phaseG.snapshotId
      assert(phaseG.verified.hasVault === true, 'Backup verification missing vault')

      // Compare every restored vault payload against expectedVaultFiles
      for (const [rel, expSha] of expectedVaultFiles.entries()) {
        const restoredFile = join(restoreVaultDir, 'files', rel)
        assert(existsSync(restoredFile), `Missing restored vault file: ${rel}`)
        assert(sha256File(restoredFile) === expSha, `Restored vault SHA-256 mismatch: ${rel}`)
      }
    } finally {
      await app.shutdown()
    }

    // Launch restored profile in candidate exe
    app = await launchCandidateApp(candidateExe, restoreProfileDir, neutralCwd)
    try {
      const restoredCheck = await app.cdp.evaluate(`(async () => {
        const activeVault = await window.api.getActiveVault();
        const ann = await window.api.getPhotoAnnotation({ fileLocationId: ${ratedPhotoId} });
        const groups = await window.api.getDuplicateGroups({ offset: 0, limit: 10 });
        return { vaultPath: activeVault.vault?.vaultPath, ann: ann.annotation, group: groups.items[0] };
      })()`)
      assert(restoredCheck.vaultPath === restoreVaultDir, 'Restored vault path mismatch')
      assert(
        restoredCheck.ann?.rating === 5 && restoredCheck.ann?.flag === 'pick',
        'Restored annotation mismatch'
      )
      assert(restoredCheck.group?.reviewStatus === 'reviewed', 'Restored duplicate review mismatch')
      console.log(
        `[PASS] Phase G. Local backup (${completedSnapshotId}), verify & isolated restore verified (8/8 vault payloads match SHA-256)`
      )
    } finally {
      await app.shutdown()
    }

    // Phase H: Catalog recovery from vault manifests after original sources are deleted
    mkdirSync(recoverySourcesDir, { recursive: true })
    copyFileSync(fixtures.landscapeJpg, join(recoverySourcesDir, 'recover-photo.jpg'))
    copyFileSync(fixtures.pdfPath, join(recoverySourcesDir, 'recover-scan.pdf'))
    copyFileSync(fixtures.txtPath, join(recoverySourcesDir, 'recover-note.txt'))

    app = await launchCandidateApp(candidateExe, recoverySeedProfileDir, neutralCwd)
    try {
      await app.cdp.evaluate(`(async () => {
        await window.api.startScan({ roots: [${JSON.stringify(recoverySourcesDir)}] });
        for (let i = 0; i < 160; i++) {
          const latest = await window.api.getLatestScanJob();
          if (latest?.job?.status === 'completed') break;
          await new Promise((r) => setTimeout(r, 100));
        }
        const vInit = await window.api.initializeVault({ vaultPath: ${JSON.stringify(recoveryVaultDir)}, vaultName: 'Recovery Vault' });
        const cands = await window.api.getImportCandidates({ vaultId: vInit.vault.vaultId, offset: 0, limit: 20 });
        await window.api.startImport({ vaultId: vInit.vault.vaultId, fileLocationIds: cands.items.map((c) => c.fileLocationId) });
        for (let i = 0; i < 160; i++) {
          const latest = await window.api.getLatestImportJob();
          if (latest?.job?.status === 'completed') break;
          await new Promise((r) => setTimeout(r, 100));
        }
      })()`)
    } finally {
      await app.shutdown()
    }

    const recoveryVaultBaseline = snapshotTree(recoveryVaultDir)
    rmSync(recoverySourcesDir, { recursive: true, force: true })
    assert(!existsSync(recoverySourcesDir), 'Disposable recovery sources should be deleted')

    app = await launchCandidateApp(candidateExe, recoverySeedProfileDir, neutralCwd)
    try {
      const recRes = await app.cdp.evaluate(`window.api.recoverCatalogFromVault({
        sourceVaultDir: ${JSON.stringify(recoveryVaultDir)},
        targetProfileDir: ${JSON.stringify(recoveryProfileDir)}
      })`)
      assert(
        recRes.recoveredVaultCopies === 3,
        `Expected 3 recovered copies, got ${recRes.recoveredVaultCopies}`
      )
    } finally {
      await app.shutdown()
    }

    app = await launchCandidateApp(candidateExe, recoveryProfileDir, neutralCwd)
    try {
      const recWorkflows = await app.cdp.evaluate(`(async () => {
        await window.api.importSemanticModelFromFolder();
        await window.api.importOcrModel();
        for (let i = 0; i < 80; i++) {
          const [c, o] = await Promise.all([window.api.getSemanticModelStatus(), window.api.getOcrModelStatus()]);
          if (c.state === 'ready' && o.state === 'ready') break;
          await new Promise((r) => setTimeout(r, 100));
        }
        const photos = await window.api.getPhotosPage({ offset: 0, limit: 10 });
        const thumb = await window.api.getThumbnail({ locationId: photos.items[0].id, priority: 'high' });
        if (thumb.status !== 'ready') throw new Error('Recovered thumbnail failed: ' + JSON.stringify(thumb));

        await window.api.startPhotoMetadataExtraction();
        await window.api.startSemanticIndexing();
        await window.api.startDocumentExtraction();
        await window.api.startDocumentOcr();
        for (let i = 0; i < 240; i++) {
          const [pm, si, de, docr] = await Promise.all([
            window.api.getPhotoMetadataProgress(),
            window.api.getSemanticIndexProgress(),
            window.api.getDocumentExtractionProgress(),
            window.api.getDocumentOcrProgress()
          ]);
          const bad = [pm, si, de, docr].find((p) => p.status === 'failed');
          if (bad) throw new Error('Recovered coordinator failed: ' + JSON.stringify(bad));
          if ([pm, si, de, docr].every((p) => p.status === 'completed')) break;
          await new Promise((r) => setTimeout(r, 150));
        }

        const activeVault = await window.api.getActiveVault();
        let readOnlyError = '';
        try {
          await window.api.startImport({
            vaultId: activeVault.vault.vaultId,
            fileLocationIds: [photos.items[0].id]
          });
          throw new Error('Expected startImport into recovered read-only vault to fail');
        } catch (err) {
          readOnlyError = err && err.message ? err.message : String(err);
          if (!/read-only/i.test(readOnlyError)) {
            throw new Error('Expected read-only vault error, got: ' + readOnlyError);
          }
        }
        return { thumbStatus: thumb.status, readOnlyError };
      })()`)
      assert(recWorkflows.thumbStatus === 'ready', 'Recovered photo thumbnail not ready')
      assert(
        /read-only/i.test(recWorkflows.readOnlyError),
        'Recovered vault did not reject import as read-only'
      )
      assert(
        app.cdp.runtimeErrors.length === 0,
        `Runtime errors in recovered profile: ${app.cdp.runtimeErrors.join('; ')}`
      )
    } finally {
      await app.shutdown()
    }
    assertTreeBitwiseUnchanged(recoveryVaultDir, recoveryVaultBaseline, 'recovery-vault')
    console.log(
      '[PASS] Phase H. Catalog recovery from vault manifests + all recovered coordinators + vault invariance verified'
    )

    // Phase I: Main source fixtures invariance + neutral CWD write check
    assertTreeBitwiseUnchanged(fixturesDir, fixturesBaseline, 'fixtures-source')
    assert(
      readdirSync(neutralCwd).length === 0,
      'Candidate wrote files into neutral working directory'
    )
    console.log(
      '[PASS] Phase I. Source preservation (100% bitwise & timestamp invariance) & clean CWD verified'
    )

    // 4. Isolated-appId NSIS lifecycle test (0.0.9 -> 0.1.0, v1 -> v19, uninstall, reinstall)
    if (!skipNsisLifecycle) {
      const isoOldDist = join(workRoot, 'iso-old-dist')
      const isoNewDist = join(workRoot, 'iso-new-dist')
      const isoInstallDir = join(workRoot, 'iso-install')
      const isoProfileDir = join(workRoot, 'iso-profile')
      const isoV1ProfileDir = join(workRoot, 'iso-v1-profile')
      const isoVaultDir = join(workRoot, 'iso-vault')
      isoInstalledExe = join(isoInstallDir, 'Personal Vault VerifyTest.exe')
      isoUninstallerExe = join(isoInstallDir, 'Uninstall Personal Vault VerifyTest.exe')

      const isoOldInstaller = buildIsolatedNsisInstaller('0.0.9', isoOldDist)
      const isoNewInstaller = buildIsolatedNsisInstaller(pkg.version, isoNewDist)

      runSilentInstaller(isoOldInstaller, isoInstallDir)
      assert(existsSync(isoInstalledExe), 'Isolated 0.0.9 installed exe missing')

      app = await launchCandidateApp(isoInstalledExe, isoProfileDir, neutralCwd)
      try {
        await app.cdp.evaluate(`(async () => {
          const info = await window.api.getAppInfo();
          if (info.version !== '0.0.9') throw new Error('Expected 0.0.9, got ' + info.version);
          await window.api.startScan({ roots: [${JSON.stringify(fixturesDir)}] });
          for (let i = 0; i < 160; i++) {
            const l = await window.api.getLatestScanJob();
            if (l?.job?.status === 'completed') break;
            await new Promise((r) => setTimeout(r, 100));
          }
          const photos = await window.api.getPhotosPage({ limit: 50, offset: 0 });
          const p0 = photos.items[0];
          const rev = 'rev:' + p0.discoveryObservationId + ':' + p0.byteSize + ':' + (p0.filesystemMtimeMs ?? 'null') + ':' + (p0.activeHash ?? 'unhashed');
          await window.api.setPhotoAnnotation({ fileLocationId: p0.id, expectedRevision: rev, expectedVersion: 0, rating: 4, flag: 'pick' });
          const v = await window.api.initializeVault({ vaultPath: ${JSON.stringify(isoVaultDir)}, vaultName: 'Iso Upgrade Vault' });
          const cands = await window.api.getImportCandidates({ vaultId: v.vault.vaultId, offset: 0, limit: 20 });
          await window.api.startImport({ vaultId: v.vault.vaultId, fileLocationIds: cands.items.map((c) => c.fileLocationId) });
          for (let i = 0; i < 160; i++) {
            const l = await window.api.getLatestImportJob();
            if (l?.job?.status === 'completed') break;
            await new Promise((r) => setTimeout(r, 100));
          }
        })()`)
      } finally {
        await app.shutdown()
      }

      runSilentInstaller(isoNewInstaller, isoInstallDir)
      app = await launchCandidateApp(isoInstalledExe, isoProfileDir, neutralCwd)
      try {
        const upg = await app.cdp.evaluate(`(async () => {
          const info = await window.api.getAppInfo();
          const photos = await window.api.getPhotosPage({ limit: 50, offset: 0 });
          const ann = await window.api.getPhotoAnnotation({ fileLocationId: photos.items[0].id });
          const v = await window.api.getActiveVault();
          return { version: info.version, photoCount: photos.totalCount, ann: ann.annotation, vaultName: v.vault?.name };
        })()`)
        assert(upg.version === pkg.version, `Upgrade version mismatch: ${upg.version}`)
        assert(
          upg.photoCount === 7 && upg.ann?.rating === 4 && upg.vaultName === 'Iso Upgrade Vault',
          'Upgrade lost data'
        )
      } finally {
        await app.shutdown()
      }

      // v1 -> v19 migration
      seedV1Catalog(
        isoV1ProfileDir,
        fixturesDir,
        fixtures.landscapeJpg,
        fixtures.hashes.landscapeJpg
      )
      app = await launchCandidateApp(isoInstalledExe, isoV1ProfileDir, neutralCwd)
      try {
        const mig = await app.cdp.evaluate(`window.api.getPhotosPage({ limit: 10, offset: 0 })`)
        assert(
          mig.items.length === 1 && mig.items[0].fileName === 'fullres-landscape.jpg',
          'v1 migration lost row'
        )
      } finally {
        await app.shutdown()
      }
      const migDb = new DatabaseSync(join(isoV1ProfileDir, 'vault-catalog.db'))
      const maxVer = migDb.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v
      migDb.close()
      assert(maxVer === 19, `Expected schema v19 after migration, got ${maxVer}`)

      // Uninstall preserves profile & vault; reinstall restores binary & preserves data
      await runSilentUninstaller(isoUninstallerExe, isoInstalledExe)
      assert(existsSync(join(isoProfileDir, 'vault-catalog.db')), 'Uninstall deleted catalog DB')
      assert(existsSync(join(isoVaultDir, 'vault.json')), 'Uninstall deleted vault.json')

      runSilentInstaller(isoNewInstaller, isoInstallDir)
      app = await launchCandidateApp(isoInstalledExe, isoProfileDir, neutralCwd)
      try {
        const re = await app.cdp.evaluate(`(async () => {
          const photos = await window.api.getPhotosPage({ limit: 50, offset: 0 });
          const ann = await window.api.getPhotoAnnotation({ fileLocationId: photos.items[0].id });
          return { photoCount: photos.totalCount, rating: ann.annotation?.rating };
        })()`)
        assert(re.photoCount === 7 && re.rating === 4, 'Reinstall lost profile state')
      } finally {
        await app.shutdown()
      }
      assertTreeBitwiseUnchanged(fixturesDir, fixturesBaseline, 'fixtures-after-nsis')
      console.log(
        '[PASS] 4. Isolated-appId NSIS lifecycle (0.0.9 -> 0.1.0 upgrade, v1 -> v19 migration, uninstall retention, reinstall) verified'
      )
    }

    assertRonInstallationUnchanged(ronBefore)
    console.log(
      "[PASS] 5. Ron's existing installed Personal Vault, registry keys, and Start Menu shortcut 100% untouched"
    )
    console.log('\n=== WINDOWS CANDIDATE VERIFICATION PASSED ===\n')
  } finally {
    if (isoUninstallerExe && isoInstalledExe && existsSync(isoUninstallerExe)) {
      await runSilentUninstaller(isoUninstallerExe, isoInstalledExe).catch(() => {})
    }
    assertRonInstallationUnchanged(ronBefore)
    try {
      rmSync(workRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
    } catch {
      // Ignore transient Windows handle release delay
    }
  }
}

main().catch((err) => {
  console.error('[FAIL]', err)
  process.exit(1)
})
