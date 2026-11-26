#!/usr/bin/env node
/**
 * Real Two-Build Windows Auto-Updater End-to-End Verification
 *
 * Uses isolated appId (`com.personalvault.updatertest`), isolated install dir,
 * isolated disposable profile (`%APPDATA%\personal-vault-updater-test`), and a loopback HTTP
 * feed server to verify:
 *  1. "Later" keeps the old version (0.1.0) across clean quit & relaunch.
 *  2. Failed update download (HTTP 500) leaves the old app (0.1.0) usable.
 *  3. Active backup job completes before quitting; "Update now" / "Retry"
 *     silently installs 0.1.1 via NSIS and automatically relaunches 0.1.1.
 *  4. Post-update profile, catalog, annotations, collections, active vault,
 *     completed backup snapshot, and source/vault SHA-256 hashes are preserved.
 *  5. Ron's existing installed Personal Vault copy is never modified.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { buildReleaseBundle } from './build-release.mjs'
import { verifyReleaseBundle } from './verify-release-bundle.mjs'

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
const UPDATER_CACHE_DIR = join(
  process.env.LOCALAPPDATA || '',
  'personal-vault-updater-test-updater'
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

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      server.close(() => resolvePort(port))
    })
  })
}

function snapshotRonInstallation() {
  const psScript = `
    $out = [ordered]@{
      exeExists = Test-Path '${RON_INSTALLED_EXE.replace(/'/g, "''")}'
      exeSha256 = if (Test-Path '${RON_INSTALLED_EXE.replace(/'/g, "''")}') { (Get-FileHash '${RON_INSTALLED_EXE.replace(/'/g, "''")}' -Algorithm SHA256).Hash } else { $null }
      installLocation = (Get-ItemProperty '${RON_REG_KEY}' -ErrorAction SilentlyContinue).InstallLocation
      displayVersion = (Get-ItemProperty '${RON_UNINSTALL_KEY}' -ErrorAction SilentlyContinue).DisplayVersion
      shortcutTarget = if (Test-Path '${RON_SHORTCUT.replace(/'/g, "''")}') { (New-Object -ComObject WScript.Shell).CreateShortcut('${RON_SHORTCUT.replace(/'/g, "''")}').TargetPath } else { $null }
    }
    $out | ConvertTo-Json -Compress
  `
  const res = spawnSync('powershell.exe', ['-NoProfile', '-Command', psScript], {
    encoding: 'utf8',
    stdio: 'pipe'
  })
  if (res.status !== 0) {
    throw new Error(`Failed snapshotting Ron installation: ${res.stderr || res.stdout}`)
  }
  return JSON.parse(res.stdout.trim())
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
        `App exited before opening a CDP page (code ${child.exitCode}, signal ${child.signalCode})`
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
          send,
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

async function launchTestApp(exePath, profileDir, cwd, extraEnv = {}) {
  const port = await freePort()
  const child = spawn(
    exePath,
    [`--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`],
    {
      cwd,
      env: {
        ...process.env,
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

  const exited = new Promise((resolveExit) => {
    child.once('exit', (code, signal) => resolveExit({ code, signal }))
  })

  let cdp
  try {
    const page = await findPageTarget(port, Date.now() + 30_000, child)
    cdp = await connectCdp(page.webSocketDebuggerUrl)
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      const ready = await cdp.evaluate(
        `Boolean(window.api && typeof window.api.getAppInfo === 'function' && typeof window.api.getUpdateState === 'function')`
      )
      if (ready) break
      await sleep(200)
    }
    if (Date.now() >= deadline) throw new Error('Timed out waiting for Electron bridge')
  } catch (error) {
    cdp?.close()
    killTree(child)
    throw launchError ?? error
  }

  return {
    child,
    cdp,
    exited,
    getStderr: () => stderr,
    closeGracefully: async () => {
      try {
        await cdp.evaluate('window.close()')
      } catch {
        // Ignore if window already closed
      }
      cdp.close()
      const exitInfo = await Promise.race([exited, sleep(15_000).then(() => ({ timedOut: true }))])
      if (exitInfo && 'timedOut' in exitInfo) {
        killTree(child)
        throw new Error('Timed out waiting for app to close cleanly')
      }
      return exitInfo
    },
    forceShutdown: async () => {
      cdp.close()
      killTree(child)
      await sleep(400)
    }
  }
}

function startLoopbackFeedServer(bundleDir) {
  let mode = 'serve-v2'

  const server = createHttpServer((req, res) => {
    const reqUrl = new URL(req.url || '/', 'http://127.0.0.1')
    const relPath = decodeURIComponent(reqUrl.pathname).replace(/^\/+/, '')

    if (!relPath || relPath.includes('..') || relPath.includes('/') || relPath.includes('\\')) {
      res.writeHead(404)
      res.end('Not found')
      return
    }

    const filePath = join(bundleDir, relPath)
    if (!existsSync(filePath)) {
      res.writeHead(404)
      res.end('Not found')
      return
    }

    if (relPath !== 'latest.yml' && mode === 'fail-download') {
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end('Simulated update download failure (HTTP 500)')
      return
    }

    const totalSize = statSync(filePath).size
    const contentType = relPath.endsWith('.yml')
      ? 'text/yaml; charset=utf-8'
      : 'application/octet-stream'
    const rangeHeader = req.headers.range

    if (rangeHeader && typeof rangeHeader === 'string') {
      const m = rangeHeader.match(/^bytes=(\d+)-(\d*)$/)
      if (m) {
        const start = Number(m[1])
        const end = m[2] ? Math.min(totalSize - 1, Number(m[2])) : totalSize - 1
        if (start <= end && start < totalSize) {
          res.writeHead(206, {
            'Content-Type': contentType,
            'Content-Range': `bytes ${start}-${end}/${totalSize}`,
            'Content-Length': String(end - start + 1),
            'Accept-Ranges': 'bytes'
          })
          if (req.method === 'HEAD') {
            res.end()
            return
          }
          createReadStream(filePath, { start, end }).pipe(res)
          return
        }
      }
    }

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': String(totalSize),
      'Accept-Ranges': 'bytes'
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    createReadStream(filePath).pipe(res)
  })

  return new Promise((resolveServer, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolveServer({
        url: `http://127.0.0.1:${port}`,
        setMode: (nextMode) => {
          mode = nextMode
        },
        close: () =>
          new Promise((ok) => {
            server.close(() => ok())
          })
      })
    })
  })
}

async function buildNoisyPhotoFixture(targetPath) {
  const width = 384
  const height = 384
  const raw = Buffer.alloc(width * height * 3)
  let seed = 0x9e3779b9
  for (let i = 0; i < raw.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0
    raw[i] = (seed >>> 24) & 0xff
  }
  await sharp(raw, { raw: { width, height, channels: 3 } })
    .png()
    .toFile(targetPath)
}

function runNsisInstaller(exePath, installDir) {
  const res = spawnSync(exePath, ['/S', `/D=${installDir}`], {
    stdio: 'pipe',
    timeout: 180_000
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
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (!existsSync(expectedRemovedFile)) {
      return
    }
    await sleep(300)
  }
  throw new Error(`Timed out waiting for ${expectedRemovedFile} removal`)
}

async function waitForCondition(fn, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let lastVal
  while (Date.now() < deadline) {
    lastVal = await fn()
    if (lastVal) return lastVal
    await sleep(150)
  }
  throw new Error(`Timed out waiting for: ${description} (last=${JSON.stringify(lastVal)})`)
}

async function closeWindowByPid(pid) {
  // On Windows, `taskkill /pid <pid>` without `/F` sends WM_CLOSE to the window so Electron
  // runs its normal `before-quit` -> `shutdownServicesForQuit()` -> `catalog.close()` path.
  spawnSync('taskkill', ['/pid', String(pid)], { stdio: 'ignore' })
  const deadline = Date.now() + 20_000
  const checkAlive = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { 'alive' } else { 'gone' }`
  while (Date.now() < deadline) {
    const res = spawnSync('powershell.exe', ['-NoProfile', '-Command', checkAlive], {
      encoding: 'utf8',
      stdio: 'pipe'
    })
    if (res.stdout.trim() === 'gone') {
      return
    }
    await sleep(300)
  }
  spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
  throw new Error(`Auto-relaunched PID ${pid} did not close cleanly after WM_CLOSE`)
}

async function main() {
  const ronBefore = snapshotRonInstallation()
  console.log(`[INFO] Snapshot of Ron's existing install: ${JSON.stringify(ronBefore)}`)

  const workRoot = mkdtempSync(join(tmpdir(), 'pv-updater-e2e-'))
  const distV1Dir = join(workRoot, 'dist-v1')
  const distV2Dir = join(workRoot, 'dist-v2')
  const installDir = join(workRoot, 'installed-app')
  const appDataDir = process.env.APPDATA || ''
  assert(appDataDir, 'APPDATA environment variable is required')
  const profileDir = join(appDataDir, 'personal-vault-updater-test')
  const fixturesDir = join(workRoot, 'fixtures')
  const vaultDir = join(workRoot, 'vault')
  const backupDir = join(workRoot, 'backup')
  const installedExe = join(installDir, 'Personal Vault Updater Test.exe')
  const uninstallerExe = join(installDir, 'Uninstall Personal Vault Updater Test.exe')

  rmSync(UPDATER_CACHE_DIR, { recursive: true, force: true, maxRetries: 15, retryDelay: 300 })
  rmSync(profileDir, { recursive: true, force: true, maxRetries: 15, retryDelay: 300 })
  mkdirSync(profileDir, { recursive: true })

  let feedServer
  let activeSession = null

  try {
    // 1. Build Vite once and produce two isolated test installers (0.1.0 and 0.1.1)
    console.log('[INFO] Building isolated updater test installers (0.1.0 and 0.1.1)...')
    const v1Summary = await buildReleaseBundle({
      mode: 'test-updater',
      version: '0.1.0',
      'output-dir': distV1Dir
    })
    const v2Summary = await buildReleaseBundle({
      mode: 'test-updater',
      version: '0.1.1',
      'output-dir': distV2Dir,
      'skip-vite-build': 'true'
    })
    const verifiedV2 = await verifyReleaseBundle(distV2Dir, { expectedTag: 'v0.1.1' })
    assert(verifiedV2.valid, 'Build 2 release bundle failed verification')
    console.log(
      `[PASS] 1. Built & verified 0.1.0 (${v1Summary.exeFileName}) and 0.1.1 (${v2Summary.exeFileName})`
    )

    // 2. Install Build 1 (0.1.0) into isolated dir and prepare disposable fixtures
    runNsisInstaller(join(distV1Dir, v1Summary.exeFileName), installDir)
    assert(existsSync(installedExe), `Installed exe missing at ${installedExe}`)
    assert(existsSync(uninstallerExe), `Uninstaller missing at ${uninstallerExe}`)

    mkdirSync(fixturesDir, { recursive: true })
    const photoPath = join(fixturesDir, 'noisy-sample.png')
    const txtPath = join(fixturesDir, 'disposable-note.txt')
    await buildNoisyPhotoFixture(photoPath)
    writeFileSync(txtPath, 'Personal Vault updater end-to-end disposable document fixture.', 'utf8')
    const sourceHashesBefore = {
      photo: sha256File(photoPath),
      txt: sha256File(txtPath)
    }

    feedServer = await startLoopbackFeedServer(distV2Dir)
    const feedEnv = {
      PV_UPDATE_FEED_URL: feedServer.url,
      PV_ALLOW_LOOPBACK_UPDATE_URL: '1',
      PV_UPDATE_CHECK_DELAY_MS: '200'
    }

    // 3. Launch Build 1 (0.1.0), seed disposable catalog/vault/backup, and test "Later"
    activeSession = await launchTestApp(installedExe, profileDir, workRoot, feedEnv)
    let backupDestId
    let photoId
    let photoRevision
    try {
      const appInfo1 = await activeSession.cdp.evaluate('window.api.getAppInfo()')
      assert(
        appInfo1.version === '0.1.0',
        `Expected initial version 0.1.0, got ${appInfo1.version}`
      )

      await activeSession.cdp.evaluate(
        `window.api.startScan(${JSON.stringify({ roots: [fixturesDir] })})`
      )
      await waitForCondition(async () => {
        const j = await activeSession.cdp.evaluate('window.api.getLatestScanJob()')
        if (j?.job?.status === 'failed') throw new Error(`Scan failed: ${JSON.stringify(j)}`)
        return j?.job?.status === 'completed' ? j : null
      }, 'scan completion')

      const photos = await activeSession.cdp.evaluate(
        'window.api.getPhotosPage({ limit: 10, offset: 0 })'
      )
      assert(photos.items.length === 1, `Expected 1 photo, got ${photos.items.length}`)
      photoId = photos.items[0].id
      const item = photos.items[0]
      photoRevision = `rev:${item.discoveryObservationId}:${item.byteSize}:${item.filesystemMtimeMs ?? 'null'}:${item.activeHash ?? 'unhashed'}`
      const annRes = await activeSession.cdp.evaluate(
        `window.api.setPhotoAnnotation(${JSON.stringify({
          fileLocationId: photoId,
          expectedRevision: photoRevision,
          expectedVersion: 0,
          rating: 5,
          flag: 'pick'
        })})`
      )
      assert(annRes.success, `Failed setting annotation: ${JSON.stringify(annRes)}`)

      const initVault = await activeSession.cdp.evaluate(
        `window.api.initializeVault(${JSON.stringify({ vaultPath: vaultDir, vaultName: 'Updater E2E Vault' })})`
      )
      const candidates = await activeSession.cdp.evaluate(
        `window.api.getImportCandidates(${JSON.stringify({ vaultId: initVault.vault.vaultId, limit: 20, offset: 0 })})`
      )
      assert(
        candidates.items.length === 2,
        `Expected 2 import candidates, got ${candidates.items.length}`
      )
      await activeSession.cdp.evaluate(
        `window.api.startImport(${JSON.stringify({
          vaultId: initVault.vault.vaultId,
          fileLocationIds: candidates.items.map((c) => c.fileLocationId)
        })})`
      )
      await waitForCondition(async () => {
        const j = await activeSession.cdp.evaluate('window.api.getLatestImportJob()')
        if (j?.job?.status === 'failed') throw new Error(`Import failed: ${JSON.stringify(j)}`)
        return j?.job?.status === 'completed' ? j : null
      }, 'vault import completion')

      const backupDest = await activeSession.cdp.evaluate(
        `window.api.configureBackupDestination(${JSON.stringify({
          name: 'Updater Test Local Backup',
          kind: 'local_fs',
          targetPath: backupDir,
          maxBytesPerSecond: 65536
        })})`
      )
      backupDestId = backupDest.id

      // Scenario A: Wait for 0.1.1 prompt, click "Later", quit cleanly, and verify still on 0.1.0
      await waitForCondition(
        () =>
          activeSession.cdp.evaluate(
            `Boolean(document.querySelector('[data-testid="update-later-btn"]'))`
          ),
        'update available banner (Later button)'
      )
      await activeSession.cdp.evaluate(
        `document.querySelector('[data-testid="update-later-btn"]').click()`
      )
      await waitForCondition(async () => {
        const st = await activeSession.cdp.evaluate('window.api.getUpdateState()')
        return st.phase === 'deferred' && st.availableVersion === '0.1.1'
      }, 'deferred update state after clicking Later')

      assert(
        activeSession.cdp.runtimeErrors.length === 0,
        'Unexpected renderer errors in Session 1'
      )
      const exit1 = await activeSession.closeGracefully()
      assert(exit1.code === 0, `Expected clean exit after Later, got ${JSON.stringify(exit1)}`)
      activeSession = null
    } finally {
      if (activeSession) {
        await activeSession.forceShutdown()
        activeSession = null
      }
    }

    // 4. Relaunch Build 1 -> confirm still 0.1.0, test failed download, then active backup + Update now/Retry
    activeSession = await launchTestApp(installedExe, profileDir, workRoot, feedEnv)
    let backupJobId
    const startupLogPath = join(profileDir, 'startup.log')
    try {
      const appInfo2 = await activeSession.cdp.evaluate('window.api.getAppInfo()')
      assert(
        appInfo2.version === '0.1.0',
        `Expected version 0.1.0 after choosing Later, got ${appInfo2.version}`
      )
      console.log('[PASS] 2. "Later" preserved 0.1.0 across clean close and relaunch')

      // Scenario B: Failed download leaves old app running & usable
      await waitForCondition(
        () =>
          activeSession.cdp.evaluate(
            `Boolean(document.querySelector('[data-testid="update-now-btn"]'))`
          ),
        'update available banner on second launch'
      )
      feedServer.setMode('fail-download')
      await activeSession.cdp.evaluate(
        `document.querySelector('[data-testid="update-now-btn"]').click()`
      )
      await waitForCondition(async () => {
        const st = await activeSession.cdp.evaluate('window.api.getUpdateState()')
        return st.phase === 'error' && st.failedStage === 'download'
      }, 'download failure error state')

      const stillRunningInfo = await activeSession.cdp.evaluate('window.api.getAppInfo()')
      assert(stillRunningInfo.version === '0.1.0', 'Failed download must keep 0.1.0 running')
      const colRes = await activeSession.cdp.evaluate(
        `window.api.createCollection(${JSON.stringify({ name: 'After Failed Update' })})`
      )
      assert(
        colRes.collection?.id,
        `App must remain usable after failed download: ${JSON.stringify(colRes)}`
      )
      const addMemRes = await activeSession.cdp.evaluate(
        `window.api.addCollectionMember(${JSON.stringify({
          collectionId: colRes.collection.id,
          fileLocationId: photoId,
          expectedRevision: photoRevision
        })})`
      )
      assert(
        addMemRes.success,
        `Adding collection member after failed update failed: ${JSON.stringify(addMemRes)}`
      )
      console.log('[PASS] 3. Failed download surfaced error while keeping 0.1.0 usable')

      // Scenario C: Start throttled local backup, click Retry, verify backup finishes and auto-relaunch occurs
      feedServer.setMode('serve-v2')
      const logOffsetBeforeInstall = existsSync(startupLogPath)
        ? readFileSync(startupLogPath, 'utf8').length
        : 0
      const build1Pid = activeSession.child.pid

      const startedBackup = await activeSession.cdp.evaluate(
        `window.api.startBackup(${JSON.stringify({ destinationId: backupDestId })})`
      )
      backupJobId = startedBackup.id
      assert(backupJobId, 'Expected started backup job id')

      await activeSession.cdp.evaluate(
        `document.querySelector('[data-testid="update-retry-btn"]').click()`
      )

      // Wait for Build 1 to exit cleanly via quitAndInstall(true, true) (do NOT force-kill it!)
      activeSession.cdp.close()
      const build1Exit = await Promise.race([
        activeSession.exited,
        sleep(90_000).then(() => ({ timedOut: true }))
      ])
      assert(
        !('timedOut' in build1Exit),
        'Timed out waiting for Build 1 to drain active backup and quit for update'
      )
      activeSession = null

      const installLogTail = readFileSync(startupLogPath, 'utf8').slice(logOffsetBeforeInstall)
      assert(
        installLogTail.includes(
          'Waiting for active jobs before update install: vaultWrite=false, backupJob=true'
        ),
        `Expected UpdateCoordinator to wait for active backup job in startup.log, got:\n${installLogTail}`
      )
      assert(
        installLogTail.includes(
          'Drained active jobs; shutting down services before installing 0.1.1'
        ),
        `Expected UpdateCoordinator drain completion log in startup.log, got:\n${installLogTail}`
      )

      // Wait for NSIS --updated to automatically relaunch Build 2 (0.1.1) into profileDir
      const relaunched = await waitForCondition(
        () => {
          if (!existsSync(startupLogPath)) return null
          const tail = readFileSync(startupLogPath, 'utf8').slice(logOffsetBeforeInstall)
          const startMatch = tail.match(/\[PID:(\d+)\] Process start: version=0\.1\.1\b.*--updated/)
          if (!startMatch) return null
          const newPid = Number(startMatch[1])
          if (newPid === build1Pid) return null
          const readyPattern = new RegExp(`\\[PID:${newPid}\\] window ready-to-show fired`)
          const dbPattern = new RegExp(`\\[PID:${newPid}\\] CatalogDatabase\\.open completed`)
          if (readyPattern.test(tail) && dbPattern.test(tail)) {
            return { pid: newPid }
          }
          return null
        },
        'automatic relaunch of upgraded 0.1.1 process',
        90_000
      )

      console.log(`[PASS] 4. Upgraded silently and auto-relaunched 0.1.1 (PID ${relaunched.pid})`)
      await sleep(500)
      await closeWindowByPid(relaunched.pid)
      const relaunchLogTail = readFileSync(startupLogPath, 'utf8').slice(logOffsetBeforeInstall)
      assert(
        new RegExp(`\\[PID:${relaunched.pid}\\] catalog closed`).test(relaunchLogTail),
        `Expected auto-relaunched PID ${relaunched.pid} to close catalog cleanly on WM_CLOSE`
      )
    } finally {
      if (activeSession) {
        await activeSession.forceShutdown()
        activeSession = null
      }
    }

    // 5. Launch upgraded 0.1.1 with CDP to verify version, catalog, annotations, collections, vault & backup hashes
    activeSession = await launchTestApp(installedExe, profileDir, workRoot, {
      PV_DISABLE_AUTO_UPDATE: '1'
    })
    try {
      const upgradedInfo = await activeSession.cdp.evaluate('window.api.getAppInfo()')
      assert(
        upgradedInfo.version === '0.1.1',
        `Expected upgraded appInfo.version === 0.1.1, got ${upgradedInfo.version}`
      )

      const photosAfter = await activeSession.cdp.evaluate(
        'window.api.getPhotosPage({ limit: 10, offset: 0 })'
      )
      assert(
        photosAfter.totalCount === 1,
        `Expected 1 photo after update, got ${photosAfter.totalCount}`
      )

      const docsAfter = await activeSession.cdp.evaluate(
        'window.api.getDocumentsPage({ limit: 10, offset: 0 })'
      )
      assert(docsAfter.totalCount === 1, `Expected 1 doc after update, got ${docsAfter.totalCount}`)

      const annAfter = await activeSession.cdp.evaluate(
        `window.api.getPhotoAnnotation(${JSON.stringify({ fileLocationId: photoId })})`
      )
      assert(
        annAfter.annotation?.rating === 5 && annAfter.annotation?.flag === 'pick',
        `Annotation lost after update: ${JSON.stringify(annAfter)}`
      )

      const collectionsAfter = await activeSession.cdp.evaluate('window.api.listCollections({})')
      assert(
        collectionsAfter.items.some((c) => c.name === 'After Failed Update'),
        'Collection created after failed update did not survive upgrade'
      )
      const membershipsAfter = await activeSession.cdp.evaluate(
        `window.api.getPhotoMemberships(${JSON.stringify({ fileLocationId: photoId })})`
      )
      assert(
        membershipsAfter.items?.some((c) => c.collectionName === 'After Failed Update'),
        `Photo collection membership did not survive upgrade: ${JSON.stringify(membershipsAfter)}`
      )

      const vaultAfter = await activeSession.cdp.evaluate('window.api.getActiveVault()')
      assert(
        vaultAfter.vault?.name === 'Updater E2E Vault',
        `Active vault lost after upgrade: ${JSON.stringify(vaultAfter)}`
      )

      const backupJobAfter = await activeSession.cdp.evaluate(
        `window.api.getBackupJob(${JSON.stringify(backupJobId)})`
      )
      assert(
        backupJobAfter?.status === 'completed',
        `Expected active backup job to complete before quit, got: ${JSON.stringify(backupJobAfter)}`
      )

      const verifyBackup = await activeSession.cdp.evaluate(
        `window.api.verifyRecoveryPoint(${JSON.stringify({
          destinationKind: 'local_fs',
          backupRepoDir: backupDir,
          snapshotId: backupJobAfter.snapshotId
        })})`
      )
      assert(
        verifyBackup.verifiedFileCount >= 2 &&
          verifyBackup.hasVault === true &&
          verifyBackup.hasAnnotations === true,
        `Backup recovery point failed verification after update: ${JSON.stringify(verifyBackup)}`
      )

      // Verify exact vault payload SHA-256 hashes and source invariance
      const vaultHashes = new Set(
        collectFilesRecursive(join(vaultDir, 'files'))
          .filter((f) => !f.endsWith('manifest.json'))
          .map((f) => sha256File(f))
      )
      assert(vaultHashes.has(sourceHashesBefore.photo), 'Vault photo hash mismatch after update')
      assert(vaultHashes.has(sourceHashesBefore.txt), 'Vault doc hash mismatch after update')
      assert(sha256File(photoPath) === sourceHashesBefore.photo, 'Source photo modified!')
      assert(sha256File(txtPath) === sourceHashesBefore.txt, 'Source txt modified!')
      assert(activeSession.cdp.runtimeErrors.length === 0, 'Unexpected renderer errors on 0.1.1')

      console.log(
        '[PASS] 5. Verified 0.1.1 profile, catalog, annotations, collections, vault SHA-256, source invariance, and completed backup'
      )

      const exitFinal = await activeSession.closeGracefully()
      assert(exitFinal.code === 0, `Expected clean final exit, got ${JSON.stringify(exitFinal)}`)
      activeSession = null
    } finally {
      if (activeSession) {
        await activeSession.forceShutdown()
        activeSession = null
      }
    }
  } finally {
    await feedServer?.close()
    if (existsSync(uninstallerExe)) {
      try {
        await runNsisUninstaller(uninstallerExe, installedExe)
      } catch (err) {
        console.warn(`[WARN] Cleanup uninstaller failed: ${err.message}`)
      }
    }
    rmSync(UPDATER_CACHE_DIR, { recursive: true, force: true, maxRetries: 15, retryDelay: 300 })
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 15, retryDelay: 300 })
    rmSync(workRoot, { recursive: true, force: true, maxRetries: 15, retryDelay: 300 })
    assert(!existsSync(profileDir), `Disposable test AppData was not cleaned up: ${profileDir}`)
    assert(
      !existsSync(UPDATER_CACHE_DIR),
      `Disposable updater cache was not cleaned up: ${UPDATER_CACHE_DIR}`
    )

    const ronAfter = snapshotRonInstallation()
    assert(
      JSON.stringify(ronAfter) === JSON.stringify(ronBefore),
      `Ron's installed copy changed! before=${JSON.stringify(ronBefore)} after=${JSON.stringify(ronAfter)}`
    )
    console.log(
      '[PASS] 6. Cleaned up isolated test artifacts and verified Ron installation untouched'
    )
  }
}

main().catch((err) => {
  console.error(`[FAIL] ${err instanceof Error ? err.stack || err.message : String(err)}`)
  process.exit(1)
})
