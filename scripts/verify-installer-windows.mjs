#!/usr/bin/env node
/**
 * Personal Vault — Stage 8C-1 Clean-Environment Windows Installer Verification
 *
 * Tests the actual NSIS installer (`dist/Personal Vault Setup <version>.exe`):
 * 1. Silent install into an isolated clean directory (`/S /D=<installDir>`).
 * 2. Launches the actual installed `Personal Vault.exe` with isolated `--user-data-dir`
 *    and verifies launch, window.api bridge, startup.log secret hygiene, thumbnails,
 *    OCR (offline tessdata_fast), semantic search (offline CLIP + BGE), photo annotations,
 *    and verified vault import using disposable fixtures.
 * 3. Case A (Older Profile Upgrade): Creates a genuine v1 `vault-catalog.db` with sample
 *    rows and verifies the installed app migrates it cleanly to schema v19 without data loss.
 * 4. Case B (Build Upgrade, Uninstall, Reinstall):
 *    - Upgrades the installed build in-place via the NSIS installer and verifies catalog,
 *      annotations, and vault files (SHA-256) survive.
 *    - Uninstalls via `Uninstall Personal Vault.exe /S` and verifies profile + vault data
 *      remain preserved on disk.
 *    - Reinstalls via the NSIS installer, relaunches, and verifies catalog, annotations,
 *      and vault file SHA-256 hashes match the original disposable fixtures.
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
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'
import sharp from 'sharp'

const __dirname = resolve(fileURLToPath(import.meta.url), '..')
const rootDir = resolve(__dirname, '..')
const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'))
const installerExe = join(rootDir, 'dist', `Personal Vault Setup ${pkg.version}.exe`)

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

function assert(cond, message) {
  if (!cond) {
    throw new Error(`Assertion failed: ${message}`)
  }
}

function sha256Buffer(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

function sha256File(filePath) {
  return sha256Buffer(readFileSync(filePath))
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

async function findPageTarget(port, deadline, child) {
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Electron exited before opening a CDP page (code ${child.exitCode}, signal ${child.signalCode})`
      )
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && t.url && !t.url.startsWith('devtools:'))
      if (page) return page
    } catch {
      // CDP not listening yet
    }
    await sleep(250)
  }
  throw new Error('Timed out waiting for Electron CDP page target')
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

async function launchInstalledApp(exePath, userDataDir, cwd, extraEnv = {}) {
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

  let stderr = ''
  let launchError
  child.on('error', (error) => {
    launchError = error
  })
  child.stderr.on('data', (d) => {
    stderr += d.toString()
  })

  let cdp
  try {
    const page = await findPageTarget(port, Date.now() + 30_000, child)
    cdp = await connectCdp(page.webSocketDebuggerUrl)
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      const ready = await cdp.evaluate(
        `Boolean(window.api && typeof window.api.getAppInfo === 'function')`
      )
      if (ready) break
      await sleep(200)
    }
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the Electron bridge')
  } catch (error) {
    cdp?.close()
    killTree(child)
    throw launchError ?? error
  }

  return {
    child,
    cdp,
    getStderr: () => stderr,
    shutdown: async () => {
      cdp.close()
      killTree(child)
      await sleep(500)
    }
  }
}

function runNsisInstaller(exePath, installDir) {
  const res = spawnSync(exePath, ['/S', `/D=${installDir}`], {
    stdio: 'pipe',
    timeout: 120_000
  })
  if (res.status !== 0) {
    throw new Error(
      `NSIS installer failed with exit ${res.status}: ${res.stderr?.toString() || res.stdout?.toString()}`
    )
  }
}

async function runNsisUninstaller(uninstallerExe, expectedRemovedFile) {
  const res = spawnSync(uninstallerExe, ['/S'], {
    stdio: 'pipe',
    timeout: 120_000
  })
  if (res.status !== 0) {
    throw new Error(`NSIS uninstaller failed with exit ${res.status}`)
  }
  // NSIS uninstaller spawns a temporary copy in %TEMP% and exits immediately,
  // so wait for the target executable to actually be removed.
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (!existsSync(expectedRemovedFile)) {
      return
    }
    await sleep(300)
  }
  throw new Error(`Timed out waiting for ${expectedRemovedFile} to be removed by uninstaller`)
}

function collectFilesRecursive(dir) {
  const files = []
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) files.push(full)
    }
  }
  walk(dir)
  return files
}

async function buildDisposableFixtures(fixturesDir) {
  mkdirSync(fixturesDir, { recursive: true })

  // 1. Photo fixture: sunny-mountain.png (generated via sharp)
  const photoPath = join(fixturesDir, 'sunny-mountain.png')
  const svgPhoto = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240">
    <rect width="320" height="140" fill="#38bdf8"/>
    <circle cx="260" cy="50" r="24" fill="#fde047"/>
    <polygon points="0,240 110,90 220,240" fill="#475569"/>
    <polygon points="120,240 230,75 320,240" fill="#334155"/>
    <rect y="200" width="320" height="40" fill="#15803d"/>
  </svg>`
  await sharp(Buffer.from(svgPhoto)).png().toFile(photoPath)

  // 2. Scanned image-only PDF fixture for OCR
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
  let xref = `xref\n0 6\n0000000000 65535 f \n`
  for (let i = 1; i <= 5; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  xref += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`
  chunks.push(Buffer.from(xref, 'latin1'))
  writeFileSync(pdfPath, Buffer.concat(chunks))

  // 3. Text document fixture for BGE semantic search
  const txtPath = join(fixturesDir, 'tax-receipt-2025.txt')
  writeFileSync(
    txtPath,
    'Quarterly municipal property tax payment receipt for parcel 4481-B. Paid in full.',
    'utf8'
  )

  return {
    photoPath,
    pdfPath,
    txtPath,
    hashes: {
      photo: sha256File(photoPath),
      pdf: sha256File(pdfPath),
      txt: sha256File(txtPath)
    }
  }
}

function createOlderV1Profile(olderProfileDir, fixturesDir, photoPath, photoSha256) {
  mkdirSync(olderProfileDir, { recursive: true })
  const dbPath = join(olderProfileDir, 'vault-catalog.db')
  const db = new DatabaseSync(dbPath)
  const now = Date.now() - 86_400_000
  const st = statSync(photoPath)

  db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      applied_at_ms INTEGER NOT NULL
    );
    CREATE TABLE sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      root_path TEXT NOT NULL,
      normalized_root_path TEXT NOT NULL UNIQUE,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE file_locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      original_path TEXT NOT NULL,
      normalized_path TEXT NOT NULL UNIQUE,
      file_name TEXT NOT NULL,
      extension TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('photo', 'document')),
      byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
      filesystem_birthtime_ms NUMERIC,
      filesystem_mtime_ms NUMERIC,
      inferred_capture_time_ms INTEGER,
      first_discovered_at_ms INTEGER NOT NULL,
      last_seen_at_ms INTEGER NOT NULL
    );
    CREATE TABLE hash_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_location_id INTEGER NOT NULL REFERENCES file_locations(id) ON DELETE CASCADE,
      sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
      observed_byte_size INTEGER NOT NULL CHECK (observed_byte_size >= 0),
      observed_mtime_ms NUMERIC,
      hashed_at_ms INTEGER NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
    );
  `)

  const normRoot = fixturesDir.replace(/\\/g, '/').toLowerCase()
  const normFile = photoPath.replace(/\\/g, '/').toLowerCase()

  const srcRes = db
    .prepare(
      'INSERT INTO sources (root_path, normalized_root_path, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?)'
    )
    .run(fixturesDir, normRoot, now, now)

  const fileRes = db
    .prepare(
      `INSERT INTO file_locations (
        source_id, original_path, normalized_path, file_name, extension, category,
        byte_size, filesystem_birthtime_ms, filesystem_mtime_ms, inferred_capture_time_ms,
        first_discovered_at_ms, last_seen_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      srcRes.lastInsertRowid,
      photoPath,
      normFile,
      'sunny-mountain.png',
      '.png',
      'photo',
      st.size,
      st.birthtimeMs,
      st.mtimeMs,
      null,
      now,
      now
    )

  db.prepare(
    `INSERT INTO hash_observations (
      file_location_id, sha256, observed_byte_size, observed_mtime_ms, hashed_at_ms, is_active
    ) VALUES (?, ?, ?, ?, ?, 1)`
  ).run(fileRes.lastInsertRowid, photoSha256, st.size, st.mtimeMs, now)

  db.prepare('INSERT INTO schema_migrations (version, name, applied_at_ms) VALUES (?, ?, ?)').run(
    1,
    'initial_catalog_schema',
    now
  )
  db.close()
}

function verifyVaultAndSourceHashes(vaultDir, fixtures) {
  const vaultFiles = collectFilesRecursive(join(vaultDir, 'files'))
  const vaultFileHashes = new Map()
  for (const f of vaultFiles) {
    if (f.endsWith('manifest.json')) continue
    vaultFileHashes.set(sha256File(f), f)
  }
  assert(vaultFileHashes.has(fixtures.hashes.photo), 'Vault photo SHA-256 mismatch')
  assert(vaultFileHashes.has(fixtures.hashes.pdf), 'Vault PDF SHA-256 mismatch')
  assert(vaultFileHashes.has(fixtures.hashes.txt), 'Vault TXT SHA-256 mismatch')

  assert(sha256File(fixtures.photoPath) === fixtures.hashes.photo, 'Source photo modified!')
  assert(sha256File(fixtures.pdfPath) === fixtures.hashes.pdf, 'Source PDF modified!')
  assert(sha256File(fixtures.txtPath) === fixtures.hashes.txt, 'Source TXT modified!')
}

function buildOlderInstaller(oldVersion, outputDir) {
  const electronBuilderBin = join(rootDir, 'node_modules', '.bin', 'electron-builder.cmd')
  const res = spawnSync(
    electronBuilderBin,
    [
      '--win',
      'nsis',
      '--x64',
      `-c.extraMetadata.version=${oldVersion}`,
      `-c.directories.output=${outputDir}`
    ],
    {
      cwd: rootDir,
      stdio: 'pipe',
      shell: true,
      timeout: 180_000
    }
  )
  if (res.status !== 0) {
    throw new Error(
      `Building older ${oldVersion} installer failed (exit ${res.status}): ${res.stderr?.toString() || res.stdout?.toString()}`
    )
  }
  const oldInstaller = join(outputDir, `Personal Vault Setup ${oldVersion}.exe`)
  assert(existsSync(oldInstaller), `Expected older installer at ${oldInstaller}`)
  return oldInstaller
}

async function main() {
  assert(
    existsSync(installerExe),
    `Installer missing at ${installerExe}. Run npm run build:installer first.`
  )
  assert(existsSync(cachedClipModelDir), `CLIP cache missing: ${cachedClipModelDir}`)
  assert(existsSync(cachedBgeModelDir), `BGE cache missing: ${cachedBgeModelDir}`)
  assert(existsSync(cachedOcrModelDir), `OCR cache missing: ${cachedOcrModelDir}`)

  const installerSha256 = sha256File(installerExe)
  console.log(`[INFO] Installer: ${installerExe}`)
  console.log(`[INFO] Installer SHA-256: ${installerSha256}`)

  const workRoot = mkdtempSync(join(tmpdir(), 'pv-8c1-clean-'))
  console.log(
    `[INFO] Environment: isolated temporary directory on current Windows host (${workRoot})`
  )
  const oldDistDir = join(workRoot, 'old-dist')
  const installDir = join(workRoot, 'installed-app')
  const profileDir = join(workRoot, 'profile')
  const olderProfileDir = join(workRoot, 'older-profile')
  const fixturesDir = join(workRoot, 'fixtures')
  const vaultDir = join(workRoot, 'vault')
  const installedExe = join(installDir, 'Personal Vault.exe')
  const uninstallerExe = join(installDir, 'Uninstall Personal Vault.exe')
  const olderVersion = '0.0.9'

  try {
    // 1. Build distinct older installer (0.0.9) and perform fresh NSIS silent install
    const olderInstallerExe = buildOlderInstaller(olderVersion, oldDistDir)
    runNsisInstaller(olderInstallerExe, installDir)
    assert(existsSync(installedExe), `Installed exe missing at ${installedExe}`)
    assert(existsSync(uninstallerExe), `Uninstaller missing at ${uninstallerExe}`)
    assert(
      existsSync(join(installDir, 'THIRD_PARTY_NOTICES.md')),
      'THIRD_PARTY_NOTICES.md missing in installDir'
    )
    assert(
      existsSync(join(installDir, 'LICENSE.electron.txt')),
      'LICENSE.electron.txt missing in installDir'
    )
    assert(
      existsSync(join(installDir, 'LICENSES.chromium.html')),
      'LICENSES.chromium.html missing in installDir'
    )
    assert(!existsSync(join(installDir, 'resources', 'spikes')), 'spikes/ must not be packaged')
    console.log(
      `[PASS] 1. Isolated Windows NSIS install (${olderVersion}) & bundled notice/license layout verified`
    )

    // 2. Build disposable fixtures and seed catalog, annotation & vault on older installed version (0.0.9)
    const fixtures = await buildDisposableFixtures(fixturesDir)

    let session = await launchInstalledApp(installedExe, profileDir, workRoot)
    try {
      const appInfoBefore = await session.cdp.evaluate('window.api.getAppInfo()')
      assert(
        appInfoBefore.version === olderVersion,
        `Expected older installed version ${olderVersion}, got ${appInfoBefore.version}`
      )

      const scanRes = await session.cdp.evaluate(
        `window.api.startScan(${JSON.stringify({ roots: [fixturesDir] })})`
      )
      assert(scanRes.success, `startScan failed: ${JSON.stringify(scanRes)}`)

      await session.cdp.evaluate(`(async () => {
        for (let i = 0; i < 120; i++) {
          const job = await window.api.getLatestScanJob();
          if (job?.job?.status === 'completed') return job;
          if (job?.job?.status === 'failed') throw new Error('Scan failed: ' + JSON.stringify(job));
          await new Promise(r => setTimeout(r, 150));
        }
        throw new Error('Scan timed out');
      })()`)

      const photosPage = await session.cdp.evaluate(
        'window.api.getPhotosPage({ limit: 10, offset: 0 })'
      )
      assert(photosPage.items.length === 1, `Expected 1 photo, got ${photosPage.items.length}`)
      const photoItem = photosPage.items[0]

      const ann0 = await session.cdp.evaluate(
        `window.api.getPhotoAnnotation(${JSON.stringify({ fileLocationId: photoItem.id })})`
      )
      const expectedRevision =
        ann0.annotation?.revision ??
        `rev:${photoItem.discoveryObservationId}:${photoItem.byteSize}:${photoItem.filesystemMtimeMs ?? 'null'}:${photoItem.activeHash ?? 'unhashed'}`
      const setAnn = await session.cdp.evaluate(
        `window.api.setPhotoAnnotation(${JSON.stringify({
          fileLocationId: photoItem.id,
          expectedRevision,
          expectedVersion: ann0.annotation?.version ?? 0,
          rating: 5,
          flag: 'pick'
        })})`
      )
      assert(setAnn.success, `setPhotoAnnotation failed: ${JSON.stringify(setAnn)}`)

      const initVault = await session.cdp.evaluate(
        `window.api.initializeVault(${JSON.stringify({ vaultPath: vaultDir, vaultName: 'Stage 8C1 Test Vault' })})`
      )
      assert(initVault.vault?.vaultId, `initializeVault failed: ${JSON.stringify(initVault)}`)
      const candidates = await session.cdp.evaluate(
        `window.api.getImportCandidates(${JSON.stringify({
          vaultId: initVault.vault.vaultId,
          limit: 20,
          offset: 0
        })})`
      )
      const candidateIds = candidates.items.map((c) => c.fileLocationId ?? c.id)
      assert(candidateIds.length === 3, `Expected 3 import candidates, got ${candidateIds.length}`)
      const importRes = await session.cdp.evaluate(
        `window.api.startImport(${JSON.stringify({
          vaultId: initVault.vault.vaultId,
          fileLocationIds: candidateIds
        })})`
      )
      assert(importRes.job?.id, `startImport failed: ${JSON.stringify(importRes)}`)
      await session.cdp.evaluate(`(async () => {
        for (let i = 0; i < 120; i++) {
          const latest = await window.api.getLatestImportJob();
          if (latest?.job?.status === 'completed') return latest;
          if (latest?.job?.status === 'failed') throw new Error('Import failed: ' + JSON.stringify(latest));
          await new Promise(r => setTimeout(r, 150));
        }
        throw new Error('Import timed out');
      })()`)
    } finally {
      await session.shutdown()
    }

    // 3. Distinct-version installer upgrade (0.0.9 -> 0.1.0), then verify version, preservation, hashes, thumbnails, OCR, semantic search
    runNsisInstaller(installerExe, installDir)
    session = await launchInstalledApp(installedExe, profileDir, workRoot)
    try {
      const appInfoAfter = await session.cdp.evaluate('window.api.getAppInfo()')
      assert(
        appInfoAfter.version === pkg.version,
        `Expected upgraded installed version ${pkg.version}, got ${appInfoAfter.version}`
      )

      const photosAfterUpgrade = await session.cdp.evaluate(
        'window.api.getPhotosPage({ limit: 10, offset: 0 })'
      )
      assert(photosAfterUpgrade.items.length === 1, 'Catalog photo lost after version upgrade')
      const photoItem = photosAfterUpgrade.items[0]

      const annAfterUpgrade = await session.cdp.evaluate(
        `window.api.getPhotoAnnotation(${JSON.stringify({ fileLocationId: photoItem.id })})`
      )
      assert(
        annAfterUpgrade.annotation?.rating === 5 && annAfterUpgrade.annotation?.flag === 'pick',
        'Photo annotation lost after version upgrade'
      )

      const docsAfterUpgrade = await session.cdp.evaluate(
        'window.api.getDocumentsPage({ limit: 20, offset: 0 })'
      )
      assert(docsAfterUpgrade.items.length === 2, 'Catalog documents lost after version upgrade')

      const activeVaultAfterUpgrade = await session.cdp.evaluate('window.api.getActiveVault()')
      assert(
        activeVaultAfterUpgrade.vault?.name === 'Stage 8C1 Test Vault',
        `Active vault lost after version upgrade: ${JSON.stringify(activeVaultAfterUpgrade)}`
      )

      verifyVaultAndSourceHashes(vaultDir, fixtures)
      console.log(
        `[PASS] 2A. Distinct-version installer upgrade (${olderVersion} -> ${pkg.version}) preserved catalog, annotations, active vault, and exact SHA-256 vault/source hashes`
      )

      // Verify thumbnail generation on upgraded 0.1.0 installed app
      const thumbRes = await session.cdp.evaluate(
        `window.api.getThumbnail(${JSON.stringify({ locationId: photoItem.id })})`
      )
      assert(
        thumbRes.status === 'ready' && thumbRes.dataUrl,
        `Thumbnail failed: ${JSON.stringify(thumbRes)}`
      )

      // Document extraction + OCR
      await session.cdp.evaluate('window.api.startDocumentExtraction()')
      await session.cdp.evaluate(`(async () => {
        for (let i = 0; i < 120; i++) {
          const p = await window.api.getDocumentExtractionProgress();
          if (p?.status === 'completed') return p;
          if (p?.status === 'failed') throw new Error('Extraction failed: ' + JSON.stringify(p));
          await new Promise(r => setTimeout(r, 150));
        }
        throw new Error('Extraction timed out');
      })()`)

      await session.cdp.evaluate('window.api.importOcrModel()')
      await session.cdp.evaluate(`(async () => {
        for (let i = 0; i < 80; i++) {
          const st = await window.api.getOcrModelStatus();
          if (st?.state === 'ready') return st;
          await new Promise(r => setTimeout(r, 150));
        }
        throw new Error('OCR model import timed out');
      })()`)

      await session.cdp.evaluate('window.api.startDocumentOcr()')
      await session.cdp.evaluate(`(async () => {
        for (let i = 0; i < 160; i++) {
          const p = await window.api.getDocumentOcrProgress();
          if (p?.status === 'completed') return p;
          if (p?.status === 'failed') throw new Error('OCR failed: ' + JSON.stringify(p));
          await new Promise(r => setTimeout(r, 150));
        }
        throw new Error('OCR timed out');
      })()`)

      const docsPage = await session.cdp.evaluate(
        'window.api.getDocumentsPage({ limit: 20, offset: 0 })'
      )
      const pdfDoc = docsPage.items.find((d) => d.fileName === 'scanned-invoice.pdf')
      assert(pdfDoc, 'scanned-invoice.pdf not found in catalog')
      const ocrPreview = await session.cdp.evaluate(
        `window.api.getDocumentOcrPreview(${JSON.stringify({ fileLocationId: pdfDoc.fileLocationId })})`
      )
      const ocrText = ocrPreview?.preview?.extractedText || ''
      assert(
        /INVOICE|420|ORDER|7781/i.test(ocrText),
        `OCR preview did not contain expected text: ${JSON.stringify(ocrPreview)}`
      )

      // Semantic search (CLIP + BGE)
      await session.cdp.evaluate('window.api.importSemanticModelFromFolder()')
      await session.cdp.evaluate(`(async () => {
        for (let i = 0; i < 80; i++) {
          const st = await window.api.getSemanticModelStatus();
          if (st?.state === 'ready') return st;
          await new Promise(r => setTimeout(r, 150));
        }
        throw new Error('CLIP model import timed out');
      })()`)
      await session.cdp.evaluate('window.api.startSemanticIndexing()')
      await session.cdp.evaluate(`(async () => {
        for (let i = 0; i < 160; i++) {
          const p = await window.api.getSemanticIndexProgress();
          if (p?.status === 'completed') return p;
          if (p?.status === 'failed') throw new Error('CLIP indexing failed: ' + JSON.stringify(p));
          await new Promise(r => setTimeout(r, 150));
        }
        throw new Error('CLIP indexing timed out');
      })()`)

      await session.cdp.evaluate('window.api.importDocSemanticModel()')
      await session.cdp.evaluate(`(async () => {
        for (let i = 0; i < 80; i++) {
          const st = await window.api.getDocSemanticModelStatus();
          if (st?.state === 'ready') return st;
          await new Promise(r => setTimeout(r, 150));
        }
        throw new Error('BGE model import timed out');
      })()`)
      await session.cdp.evaluate('window.api.startDocumentSemanticIndexing()')
      await session.cdp.evaluate(`(async () => {
        for (let i = 0; i < 160; i++) {
          const p = await window.api.getDocumentSemanticProgress();
          if (p?.status === 'completed') return p;
          if (p?.status === 'failed') throw new Error('BGE indexing failed: ' + JSON.stringify(p));
          await new Promise(r => setTimeout(r, 150));
        }
        throw new Error('BGE indexing timed out');
      })()`)

      const photoSearch = await session.cdp.evaluate(
        `window.api.searchUnifiedPhotos(${JSON.stringify({
          query: 'mountain',
          ownerSurface: 'unified',
          ownerGen: 1,
          offset: 0,
          limit: 10
        })})`
      )
      assert(
        photoSearch.result?.items?.some((item) => item.photo?.fileName === 'sunny-mountain.png'),
        `Photo semantic search missed sunny-mountain.png: ${JSON.stringify(photoSearch)}`
      )

      const docSearch = await session.cdp.evaluate(
        `window.api.searchUnifiedDocuments(${JSON.stringify({
          query: 'municipal property tax receipt',
          ownerSurface: 'unified',
          ownerGen: 1,
          offset: 0,
          limit: 10
        })})`
      )
      assert(
        docSearch.result?.items?.some(
          (item) => (item.fileName ?? item.document?.fileName) === 'tax-receipt-2025.txt'
        ),
        `Doc semantic search missed tax-receipt-2025.txt: ${JSON.stringify(docSearch)}`
      )
      assert(
        session.cdp.runtimeErrors.length === 0,
        `Runtime errors: ${session.cdp.runtimeErrors.join('; ')}`
      )
    } finally {
      await session.shutdown()
    }

    const startupLog = readFileSync(join(profileDir, 'startup.log'), 'utf8')
    assert(
      !/accessToken|refreshToken|recoverySecret|PV_GOOGLE_CLIENT_SECRET/i.test(startupLog),
      'Secret leak in startup.log'
    )
    console.log(
      `[PASS] 2B. Installed app (${pkg.version}) launch, thumbnails, OCR, semantic search, and startup.log verified`
    )

    // 4. Case A (Schema Migration — separate): Older v1 profile upgrade
    createOlderV1Profile(olderProfileDir, fixturesDir, fixtures.photoPath, fixtures.hashes.photo)
    session = await launchInstalledApp(installedExe, olderProfileDir, workRoot)
    try {
      const migratedPhotos = await session.cdp.evaluate(
        'window.api.getPhotosPage({ limit: 10, offset: 0 })'
      )
      assert(
        migratedPhotos.items.length === 1 &&
          migratedPhotos.items[0].fileName === 'sunny-mountain.png',
        `Older v1 profile migration lost photo row: ${JSON.stringify(migratedPhotos)}`
      )
    } finally {
      await session.shutdown()
    }
    const migratedDb = new DatabaseSync(join(olderProfileDir, 'vault-catalog.db'))
    const versionRow = migratedDb
      .prepare('SELECT MAX(version) as max_version FROM schema_migrations;')
      .get()
    migratedDb.close()
    assert(
      versionRow.max_version === 19,
      `Expected migrated schema version 19, got ${versionRow.max_version}`
    )
    console.log(
      '[PASS] 3A. Schema migration (v1 -> v19) on older profile preserved existing catalog row'
    )

    // 5. Case B (Uninstall & Same-Version Reinstall — separate):
    await runNsisUninstaller(uninstallerExe, installedExe)
    assert(existsSync(join(profileDir, 'vault-catalog.db')), 'Catalog DB deleted on uninstall!')
    assert(existsSync(join(vaultDir, 'vault.json')), 'Vault identity deleted on uninstall!')
    console.log(
      '[PASS] 3B1. Uninstall removed app binary while preserving profile catalog and vault files'
    )

    runNsisInstaller(installerExe, installDir)
    session = await launchInstalledApp(installedExe, profileDir, workRoot)
    try {
      const appInfoReinstall = await session.cdp.evaluate('window.api.getAppInfo()')
      assert(
        appInfoReinstall.version === pkg.version,
        `Unexpected version after reinstall: ${appInfoReinstall.version}`
      )
      const photosAfterReinstall = await session.cdp.evaluate(
        'window.api.getPhotosPage({ limit: 10, offset: 0 })'
      )
      assert(photosAfterReinstall.items.length === 1, 'Catalog photo lost after reinstall')
      const annAfterReinstall = await session.cdp.evaluate(
        `window.api.getPhotoAnnotation(${JSON.stringify({ fileLocationId: photosAfterReinstall.items[0].id })})`
      )
      assert(
        annAfterReinstall.annotation?.rating === 5 && annAfterReinstall.annotation?.flag === 'pick',
        'Photo annotation lost after reinstall'
      )
      const docsAfterReinstall = await session.cdp.evaluate(
        'window.api.getDocumentsPage({ limit: 20, offset: 0 })'
      )
      assert(docsAfterReinstall.items.length === 2, 'Catalog documents lost after reinstall')
    } finally {
      await session.shutdown()
    }

    verifyVaultAndSourceHashes(vaultDir, fixtures)
    console.log(
      `[PASS] 3B2. Same-version reinstall (${pkg.version}) preserved catalog, annotations, and exact SHA-256 vault & fixture hashes`
    )
  } finally {
    if (existsSync(uninstallerExe)) {
      await runNsisUninstaller(uninstallerExe, installedExe).catch(() => {})
    }
    rmSync(workRoot, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error('[FAIL]', err)
  process.exit(1)
})
