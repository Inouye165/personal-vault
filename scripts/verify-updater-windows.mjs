#!/usr/bin/env node
/**
 * Real Three-Build Windows Auto-Updater End-to-End Verification
 *
 * Uses isolated appId (`com.personalvault.updatertest`), isolated install dir,
 * isolated disposable profile (`%APPDATA%\personal-vault-updater-test`), and a loopback HTTP
 * feed server to verify the complete Windows update lifecycle in order:
 *  1. Install pre-updater 0.1.0 (built from baseline commit 37aff43) in the isolated test
 *     environment and create a small catalog with sample photos, EXIF metadata, annotation,
 *     collection, verified vault, and throttled backup destination.
 *  2. Manually install the first updater-enabled build (0.1.1) over 0.1.0. Verify that the
 *     same catalog opens with its data intact and the app displays version 0.1.1.
 *  3. Serve a newer installer (0.1.2) through the loopback test feed. Verify "Update available",
 *     "Later" (preserving 0.1.1 across clean quit & relaunch), failed download recovery,
 *     "Update now" / "Retry", download progress, waiting for an active backup job to finish,
 *     and automatic silent NSIS install + relaunch at 0.1.2 with the same catalog & hashes.
 *  4. Verify Ron's live installed Personal Vault copy, registry, Start Menu & taskbar shortcuts,
 *     production catalog, and disposable source files remain 100% untouched.
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
import { join, resolve } from 'node:path'
import { Transform } from 'node:stream'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { buildReleaseBundle } from './build-release.mjs'
import { verifyReleaseBundle } from './verify-release-bundle.mjs'

const __dirname = resolve(fileURLToPath(import.meta.url), '..')
const rootDir = resolve(__dirname, '..')
const PRE_UPDATER_BASELINE_COMMIT = '37aff43'

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
const RON_TASKBAR_SHORTCUT = join(
  process.env.APPDATA || '',
  'Microsoft',
  'Internet Explorer',
  'Quick Launch',
  'User Pinned',
  'TaskBar',
  'Personal Vault.lnk'
)
const RON_PROD_CATALOG = join(process.env.APPDATA || '', 'Personal Vault', 'vault-catalog.db')
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
  const parsed = JSON.parse(res.stdout.trim())
  const prodCatalogExists = existsSync(RON_PROD_CATALOG)
  const prodCatalogStat = prodCatalogExists ? statSync(RON_PROD_CATALOG) : null
  return {
    ...parsed,
    taskbarShortcutExists: Boolean(RON_TASKBAR_SHORTCUT) && existsSync(RON_TASKBAR_SHORTCUT),
    taskbarShortcutSha256:
      Boolean(RON_TASKBAR_SHORTCUT) && existsSync(RON_TASKBAR_SHORTCUT)
        ? sha256File(RON_TASKBAR_SHORTCUT)
        : null,
    prodCatalogExists,
    prodCatalogSize: prodCatalogStat ? prodCatalogStat.size : null,
    prodCatalogMtimeMs: prodCatalogStat ? prodCatalogStat.mtimeMs : null
  }
}

function runCommandChecked(command, args, cwd, label) {
  const res = spawnSync(command, args, {
    cwd,
    stdio: 'pipe',
    encoding: 'utf8',
    shell: command !== process.execPath && process.platform === 'win32',
    timeout: 300_000
  })
  if (res.status !== 0) {
    throw new Error(
      `${label} failed with exit ${res.status}:\n${res.stderr || ''}\n${res.stdout || ''}`
    )
  }
  return res.stdout
}

function buildPreUpdaterBaselineInstaller(workRoot, distV0Dir) {
  const worktreeDir = join(workRoot, 'preupdater-wt')
  const junctionDir = join(worktreeDir, 'node_modules')
  const tempCfgPath = join(workRoot, 'preupdater-builder.json')
  const vcRedistSrc = join(rootDir, 'build', 'vc_redist.x64.exe')
  assert(existsSync(vcRedistSrc), `Verified VC++ redistributable missing at ${vcRedistSrc}`)

  runCommandChecked(
    'git',
    ['worktree', 'add', '--detach', worktreeDir, PRE_UPDATER_BASELINE_COMMIT],
    rootDir,
    `Create detached worktree at ${PRE_UPDATER_BASELINE_COMMIT}`
  )

  try {
    runCommandChecked(
      'cmd.exe',
      ['/c', 'mklink', '/J', junctionDir, join(rootDir, 'node_modules')],
      worktreeDir,
      'Create node_modules junction for pre-updater baseline build'
    )
    runCommandChecked('npm', ['run', 'build'], worktreeDir, 'Build pre-updater 0.1.0 Vite bundles')

    const builderOverride = {
      appId: 'com.personalvault.updatertest',
      productName: 'Personal Vault Updater Test',
      extraMetadata: {
        name: 'personal-vault-updater-test',
        version: '0.1.0'
      },
      files: [
        { from: join(worktreeDir, 'out'), to: 'out', filter: ['**/*'] },
        'package.json',
        'THIRD_PARTY_NOTICES.md',
        '!node_modules/tesseract.js-core/*.wasm.js',
        '!node_modules/tesseract.js-core/tesseract-core.js',
        '!node_modules/tesseract.js-core/tesseract-core.wasm',
        '!node_modules/tesseract.js-core/tesseract-core-simd.js',
        '!node_modules/tesseract.js-core/tesseract-core-simd.wasm',
        '!node_modules/tesseract.js-core/tesseract-core-relaxedsimd*.js',
        '!node_modules/tesseract.js-core/tesseract-core-relaxedsimd*.wasm'
      ],
      asarUnpack: [
        'node_modules/sharp/**/*',
        'node_modules/@img/**/*',
        'node_modules/@napi-rs/**/*',
        'node_modules/tesseract.js-core/*.wasm',
        'node_modules/onnxruntime-node/bin/napi-v6/win32/x64/**/*'
      ],
      extraFiles: ['THIRD_PARTY_NOTICES.md'],
      directories: {
        output: distV0Dir,
        buildResources: 'build'
      },
      win: {
        icon: 'build/icon.ico',
        target: [{ target: 'nsis', arch: ['x64'] }]
      },
      nsis: {
        oneClick: false,
        allowToChangeInstallationDirectory: true,
        perMachine: false,
        deleteAppDataOnUninstall: false,
        artifactName: 'Personal-Vault-UpdaterTest-Setup-${version}.${ext}',
        shortcutName: 'Personal Vault Updater Test',
        createDesktopShortcut: false,
        createStartMenuShortcut: false,
        include: 'build/installer.nsh'
      }
    }
    writeFileSync(tempCfgPath, `${JSON.stringify(builderOverride, null, 2)}\n`, 'utf8')

    const ebBin = join(rootDir, 'node_modules', '.bin', 'electron-builder.cmd')
    runCommandChecked(
      ebBin,
      ['--win', 'nsis', '--x64', '--publish', 'never', '--config', tempCfgPath],
      rootDir,
      'Package pre-updater 0.1.0 NSIS installer'
    )

    const exePath = join(distV0Dir, 'Personal-Vault-UpdaterTest-Setup-0.1.0.exe')
    assert(existsSync(exePath), `Pre-updater 0.1.0 installer missing at ${exePath}`)
    return exePath
  } finally {
    if (existsSync(junctionDir)) {
      spawnSync('cmd.exe', ['/c', 'rmdir', junctionDir], { stdio: 'ignore' })
    }
    assert(
      !existsSync(junctionDir),
      `Refusing to remove worktree while junction still exists: ${junctionDir}`
    )
    spawnSync('git', ['worktree', 'remove', '--force', worktreeDir], {
      cwd: rootDir,
      stdio: 'ignore'
    })
  }
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

async function launchTestApp(exePath, profileDir, cwd, extraEnv = {}, options = {}) {
  const expectUpdaterBridge = options.expectUpdaterBridge !== false
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

  let stdout = ''
  let stderr = ''
  let launchError
  child.on('error', (error) => {
    launchError = error
  })
  child.stdout.on('data', (d) => {
    stdout += d.toString()
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
    const bridgeExpr = expectUpdaterBridge
      ? `Boolean(window.api && typeof window.api.getAppInfo === 'function' && typeof window.api.getUpdateState === 'function' && document.querySelector('.sidebar-footer'))`
      : `Boolean(window.api && typeof window.api.getAppInfo === 'function' && document.querySelector('.sidebar-footer'))`
    while (Date.now() < deadline) {
      const ready = await cdp.evaluate(bridgeExpr)
      if (ready) break
      await sleep(200)
    }
    if (Date.now() >= deadline) throw new Error('Timed out waiting for Electron bridge')
  } catch (error) {
    cdp?.close()
    killTree(child)
    const startupLogPath = join(profileDir, 'startup.log')
    const startupLog = existsSync(startupLogPath)
      ? readFileSync(startupLogPath, 'utf8')
      : '(missing)'
    const baseErr = launchError ?? error
    const msg = baseErr instanceof Error ? baseErr.message : String(baseErr)
    throw new Error(
      `${msg}\n--- stdout ---\n${stdout.slice(-2000)}\n--- stderr ---\n${stderr.slice(-2000)}\n--- startup.log ---\n${startupLog.slice(-4000)}`,
      { cause: error }
    )
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

function createPacedStream(filePath, streamOpts) {
  const source = createReadStream(filePath, {
    ...streamOpts,
    highWaterMark: 2 * 1024 * 1024
  })
  const throttle = new Transform({
    transform(chunk, _encoding, callback) {
      setTimeout(() => callback(null, chunk), 18)
    }
  })
  source.on('error', (err) => throttle.destroy(err))
  return source.pipe(throttle)
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
    const openStream = (opts) =>
      relPath.endsWith('.exe')
        ? createPacedStream(filePath, opts)
        : createReadStream(filePath, opts)

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
          openStream({ start, end }).pipe(res)
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
    openStream().pipe(res)
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
  const width = 512
  const height = 512
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

async function buildExifPhotoFixture(targetPath) {
  await sharp({
    create: { width: 640, height: 480, channels: 3, background: { r: 62, g: 128, b: 196 } }
  })
    .jpeg({ quality: 90 })
    .withExif({
      IFD0: {
        Make: 'TestCam',
        Model: 'PV-100'
      },
      IFD2: {
        DateTimeOriginal: '2025:06:15 14:30:00'
      }
    })
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
  const distV0Dir = join(workRoot, 'dist-v0')
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
    // 0. Build 3 isolated test installers: pre-updater 0.1.0, updater-enabled 0.1.1, feed release 0.1.2
    console.log(
      '[INFO] Building isolated test installers (pre-updater 0.1.0, updater-enabled 0.1.1, feed 0.1.2)...'
    )
    const v0ExePath = buildPreUpdaterBaselineInstaller(workRoot, distV0Dir)
    const v1Summary = await buildReleaseBundle({
      mode: 'test-updater',
      version: '0.1.1',
      'output-dir': distV1Dir
    })
    const v2Summary = await buildReleaseBundle({
      mode: 'test-updater',
      version: '0.1.2',
      'output-dir': distV2Dir,
      'skip-vite-build': 'true'
    })
    const verifiedV1 = await verifyReleaseBundle(distV1Dir, { expectedTag: 'v0.1.1' })
    const verifiedV2 = await verifyReleaseBundle(distV2Dir, { expectedTag: 'v0.1.2' })
    assert(verifiedV1.valid && verifiedV2.valid, 'Release bundle verification failed')
    console.log(
      `[PASS] 0. Built 0.1.0 baseline, ${v1Summary.exeFileName} (0.1.1), and ${v2Summary.exeFileName} (0.1.2)`
    )

    // Step 1: Install pre-updater 0.1.0 and create sample catalog with photos, EXIF metadata, and a collection
    runNsisInstaller(v0ExePath, installDir)
    assert(existsSync(installedExe), `Installed exe missing at ${installedExe}`)
    assert(existsSync(uninstallerExe), `Uninstaller missing at ${uninstallerExe}`)

    mkdirSync(fixturesDir, { recursive: true })
    const noisyPhotoPath = join(fixturesDir, 'noisy-sample.png')
    const exifPhotoPath = join(fixturesDir, 'exif-sample.jpg')
    const txtPath = join(fixturesDir, 'disposable-note.txt')
    await buildNoisyPhotoFixture(noisyPhotoPath)
    await buildExifPhotoFixture(exifPhotoPath)
    writeFileSync(txtPath, 'Personal Vault updater end-to-end disposable document fixture.', 'utf8')
    const sourceHashesBefore = {
      noisyPhoto: sha256File(noisyPhotoPath),
      exifPhoto: sha256File(exifPhotoPath),
      txt: sha256File(txtPath)
    }

    let exifPhotoId
    let exifPhotoRevision
    let preUpdateCollectionId
    let backupDestId

    activeSession = await launchTestApp(
      installedExe,
      profileDir,
      workRoot,
      {},
      { expectUpdaterBridge: false }
    )
    try {
      const appInfo0 = await activeSession.cdp.evaluate('window.api.getAppInfo()')
      assert(
        appInfo0.version === '0.1.0',
        `Expected initial version 0.1.0, got ${appInfo0.version}`
      )
      const hasUpdaterOnV0 = await activeSession.cdp.evaluate(
        'typeof window.api.getUpdateState !== "undefined"'
      )
      assert(!hasUpdaterOnV0, 'Pre-updater 0.1.0 build should not expose getUpdateState')
      const footer0 = await activeSession.cdp.evaluate(
        `document.querySelector('.sidebar-footer')?.textContent || ''`
      )
      assert(
        footer0.includes('Version 0.1.0'),
        `Expected Version 0.1.0 in sidebar, got: ${footer0}`
      )

      await activeSession.cdp.evaluate(
        `window.api.startScan(${JSON.stringify({ roots: [fixturesDir] })})`
      )
      await waitForCondition(async () => {
        const j = await activeSession.cdp.evaluate('window.api.getLatestScanJob()')
        if (j?.job?.status === 'failed') throw new Error(`Scan failed: ${JSON.stringify(j)}`)
        return j?.job?.status === 'completed' ? j : null
      }, 'scan completion on 0.1.0')

      await activeSession.cdp.evaluate('window.api.startPhotoMetadataExtraction({})')
      await waitForCondition(async () => {
        const p = await activeSession.cdp.evaluate('window.api.getPhotoMetadataProgress()')
        if (p?.status === 'failed') throw new Error(`Metadata failed: ${JSON.stringify(p)}`)
        return p?.status === 'completed' ? p : null
      }, 'photo metadata extraction on 0.1.0')

      const photos = await activeSession.cdp.evaluate(
        'window.api.getPhotosPage({ limit: 20, offset: 0 })'
      )
      assert(photos.items.length === 2, `Expected 2 photos, got ${photos.items.length}`)
      const exifItem = photos.items.find((p) => p.fileName === 'exif-sample.jpg')
      assert(exifItem, 'exif-sample.jpg missing from 0.1.0 catalog')
      exifPhotoId = exifItem.id
      exifPhotoRevision = `rev:${exifItem.discoveryObservationId}:${exifItem.byteSize}:${exifItem.filesystemMtimeMs ?? 'null'}:${exifItem.activeHash ?? 'unhashed'}`

      const meta0 = await activeSession.cdp.evaluate(
        `window.api.getPhotoMetadataDetail(${JSON.stringify({ fileLocationId: exifPhotoId })})`
      )
      assert(
        meta0.detail?.currentMetadata?.extractionStatus === 'extracted' &&
          meta0.detail?.currentMetadata?.cameraMakeRaw === 'TestCam' &&
          meta0.detail?.currentMetadata?.cameraModelRaw === 'PV-100' &&
          meta0.detail?.currentMetadata?.captureCalendarDate === '2025-06-15',
        `Unexpected EXIF metadata on 0.1.0: ${JSON.stringify(meta0)}`
      )

      const annRes = await activeSession.cdp.evaluate(
        `window.api.setPhotoAnnotation(${JSON.stringify({
          fileLocationId: exifPhotoId,
          expectedRevision: exifPhotoRevision,
          expectedVersion: 0,
          rating: 5,
          flag: 'pick'
        })})`
      )
      assert(annRes.success, `Failed setting annotation: ${JSON.stringify(annRes)}`)

      const col0 = await activeSession.cdp.evaluate(
        `window.api.createCollection(${JSON.stringify({ name: 'Pre-Update Collection' })})`
      )
      assert(col0.collection?.id, `Failed creating collection on 0.1.0: ${JSON.stringify(col0)}`)
      preUpdateCollectionId = col0.collection.id
      const mem0 = await activeSession.cdp.evaluate(
        `window.api.addCollectionMember(${JSON.stringify({
          collectionId: preUpdateCollectionId,
          fileLocationId: exifPhotoId,
          expectedRevision: exifPhotoRevision
        })})`
      )
      assert(mem0.success, `Failed adding collection member on 0.1.0: ${JSON.stringify(mem0)}`)

      const initVault = await activeSession.cdp.evaluate(
        `window.api.initializeVault(${JSON.stringify({ vaultPath: vaultDir, vaultName: 'Updater E2E Vault' })})`
      )
      const candidates = await activeSession.cdp.evaluate(
        `window.api.getImportCandidates(${JSON.stringify({ vaultId: initVault.vault.vaultId, limit: 20, offset: 0 })})`
      )
      assert(
        candidates.items.length === 3,
        `Expected 3 import candidates, got ${candidates.items.length}`
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
      }, 'vault import completion on 0.1.0')

      const backupDest = await activeSession.cdp.evaluate(
        `window.api.configureBackupDestination(${JSON.stringify({
          name: 'Updater Test Local Backup',
          kind: 'local_fs',
          targetPath: backupDir,
          maxBytesPerSecond: 65536
        })})`
      )
      backupDestId = backupDest.id

      assert(
        activeSession.cdp.runtimeErrors.length === 0,
        'Unexpected renderer errors in pre-updater 0.1.0 session'
      )
      const exit0 = await activeSession.closeGracefully()
      assert(exit0.code === 0, `Expected clean exit on 0.1.0, got ${JSON.stringify(exit0)}`)
      activeSession = null
      console.log(
        '[PASS] 1. Installed pre-updater 0.1.0 and seeded photos, EXIF metadata, annotation, collection, and vault'
      )
    } finally {
      if (activeSession) {
        await activeSession.forceShutdown()
        activeSession = null
      }
    }

    // Step 2 & 3a: Manually install updater-enabled 0.1.1 over 0.1.0, verify catalog + version, then test "Update available" & "Later"
    runNsisInstaller(join(distV1Dir, v1Summary.exeFileName), installDir)

    feedServer = await startLoopbackFeedServer(distV2Dir)
    const feedEnv = {
      PV_UPDATE_FEED_URL: feedServer.url,
      PV_ALLOW_LOOPBACK_UPDATE_URL: '1',
      PV_UPDATE_CHECK_DELAY_MS: '200'
    }

    activeSession = await launchTestApp(installedExe, profileDir, workRoot, feedEnv)
    try {
      const appInfo1 = await activeSession.cdp.evaluate('window.api.getAppInfo()')
      assert(
        appInfo1.version === '0.1.1',
        `Expected manual upgrade version 0.1.1, got ${appInfo1.version}`
      )
      const footer1 = await activeSession.cdp.evaluate(
        `document.querySelector('.sidebar-footer')?.textContent || ''`
      )
      assert(
        footer1.includes('Version 0.1.1'),
        `Expected Version 0.1.1 in sidebar, got: ${footer1}`
      )

      const photos1 = await activeSession.cdp.evaluate(
        'window.api.getPhotosPage({ limit: 20, offset: 0 })'
      )
      assert(
        photos1.totalCount === 2,
        `Expected 2 photos after manual 0.1.1 install, got ${photos1.totalCount}`
      )
      const docs1 = await activeSession.cdp.evaluate(
        'window.api.getDocumentsPage({ limit: 20, offset: 0 })'
      )
      assert(
        docs1.totalCount === 1,
        `Expected 1 doc after manual 0.1.1 install, got ${docs1.totalCount}`
      )
      const meta1 = await activeSession.cdp.evaluate(
        `window.api.getPhotoMetadataDetail(${JSON.stringify({ fileLocationId: exifPhotoId })})`
      )
      assert(
        meta1.detail?.currentMetadata?.cameraMakeRaw === 'TestCam' &&
          meta1.detail?.currentMetadata?.cameraModelRaw === 'PV-100' &&
          meta1.detail?.currentMetadata?.captureCalendarDate === '2025-06-15',
        `EXIF metadata lost after manual 0.1.1 install: ${JSON.stringify(meta1)}`
      )
      const ann1 = await activeSession.cdp.evaluate(
        `window.api.getPhotoAnnotation(${JSON.stringify({ fileLocationId: exifPhotoId })})`
      )
      assert(
        ann1.annotation?.rating === 5 && ann1.annotation?.flag === 'pick',
        `Annotation lost after manual 0.1.1 install: ${JSON.stringify(ann1)}`
      )
      const mem1 = await activeSession.cdp.evaluate(
        `window.api.getPhotoMemberships(${JSON.stringify({ fileLocationId: exifPhotoId })})`
      )
      assert(
        mem1.items?.some((c) => c.collectionName === 'Pre-Update Collection'),
        `Collection membership lost after manual 0.1.1 install: ${JSON.stringify(mem1)}`
      )
      const vault1 = await activeSession.cdp.evaluate('window.api.getActiveVault()')
      assert(
        vault1.vault?.name === 'Updater E2E Vault',
        `Active vault lost after manual 0.1.1 install: ${JSON.stringify(vault1)}`
      )
      console.log(
        '[PASS] 2. Manual install of updater-enabled 0.1.1 over 0.1.0 preserved catalog, EXIF metadata, collection, vault, and displays Version 0.1.1'
      )

      // Wait for 0.1.2 prompt, check copy, click "Later", quit cleanly, and verify still on 0.1.1
      await waitForCondition(
        () =>
          activeSession.cdp.evaluate(
            `Boolean(document.querySelector('[data-testid="update-later-btn"]'))`
          ),
        'update available banner (Later button)'
      )
      const availText = await activeSession.cdp.evaluate(
        `document.querySelector('[data-testid="update-banner"]')?.textContent || ''`
      )
      assert(
        /Update available/i.test(availText) &&
          availText.includes('0.1.2') &&
          /close and reopen automatically/i.test(availText),
        `Unexpected Update available banner text: ${availText}`
      )

      await activeSession.cdp.evaluate(
        `document.querySelector('[data-testid="update-later-btn"]').click()`
      )
      await waitForCondition(async () => {
        const st = await activeSession.cdp.evaluate('window.api.getUpdateState()')
        return st.phase === 'deferred' && st.availableVersion === '0.1.2'
      }, 'deferred update state after clicking Later')
      const deferredBtnText = await activeSession.cdp.evaluate(
        `document.querySelector('[data-testid="sidebar-update-btn"]')?.textContent || ''`
      )
      assert(
        deferredBtnText.includes('Update available (0.1.2)'),
        `Expected deferred sidebar indicator, got: ${deferredBtnText}`
      )

      assert(
        activeSession.cdp.runtimeErrors.length === 0,
        'Unexpected renderer errors in 0.1.1 Session 1'
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

    // Step 4 & 3b: Relaunch 0.1.1 -> confirm still 0.1.1, simulate failed download, then retry with active backup -> auto-relaunch 0.1.2
    activeSession = await launchTestApp(installedExe, profileDir, workRoot, feedEnv)
    let backupJobId
    const startupLogPath = join(profileDir, 'startup.log')
    try {
      const appInfo2 = await activeSession.cdp.evaluate('window.api.getAppInfo()')
      assert(
        appInfo2.version === '0.1.1',
        `Expected version 0.1.1 after choosing Later, got ${appInfo2.version}`
      )
      console.log('[PASS] 3A. "Later" preserved 0.1.1 across clean close and relaunch')

      // Simulate failed download (HTTP 500) -> old app remains usable and retryable
      await waitForCondition(
        () =>
          activeSession.cdp.evaluate(
            `Boolean(document.querySelector('[data-testid="update-now-btn"]'))`
          ),
        'update available banner on second 0.1.1 launch'
      )
      feedServer.setMode('fail-download')
      await activeSession.cdp.evaluate(
        `document.querySelector('[data-testid="update-now-btn"]').click()`
      )
      await waitForCondition(async () => {
        const st = await activeSession.cdp.evaluate('window.api.getUpdateState()')
        return st.phase === 'error' && st.failedStage === 'download'
      }, 'download failure error state')

      const errBannerText = await activeSession.cdp.evaluate(
        `document.querySelector('[data-testid="update-banner"]')?.textContent || ''`
      )
      assert(
        /Update download failed/i.test(errBannerText) && /0\.1\.1/.test(errBannerText),
        `Unexpected download error banner text: ${errBannerText}`
      )

      const stillRunningInfo = await activeSession.cdp.evaluate('window.api.getAppInfo()')
      assert(stillRunningInfo.version === '0.1.1', 'Failed download must keep 0.1.1 running')
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
          fileLocationId: exifPhotoId,
          expectedRevision: exifPhotoRevision
        })})`
      )
      assert(
        addMemRes.success,
        `Adding collection member after failed update failed: ${JSON.stringify(addMemRes)}`
      )
      console.log(
        '[PASS] 4. Failed download surfaced error while keeping 0.1.1 usable and retryable'
      )

      // Retry with active throttled backup -> observe download progress, waiting_for_jobs, clean drain, and 0.1.2 auto-relaunch
      feedServer.setMode('serve-v2')
      const logOffsetBeforeInstall = existsSync(startupLogPath)
        ? readFileSync(startupLogPath, 'utf8').length
        : 0
      const build1Pid = activeSession.child.pid

      await activeSession.cdp.evaluate(`(() => {
        window.__pvUpdateTrace = [];
        window.__pvUpdateUnsub?.();
        window.__pvUpdateUnsub = window.api.onUpdateState((s) => {
          window.__pvUpdateTrace.push({
            phase: s.phase,
            percent: s.downloadProgress?.percent ?? null,
            transferredBytes: s.downloadProgress?.transferredBytes ?? null,
            totalBytes: s.downloadProgress?.totalBytes ?? null,
            activeJobs: s.activeJobs
          });
        });
      })()`)

      const startedBackup = await activeSession.cdp.evaluate(
        `window.api.startBackup(${JSON.stringify({ destinationId: backupDestId })})`
      )
      backupJobId = startedBackup.id
      assert(backupJobId, 'Expected started backup job id')

      await activeSession.cdp.evaluate(
        `document.querySelector('[data-testid="update-retry-btn"]').click()`
      )

      // Confirm download progress and waiting_for_jobs UI states before closing CDP
      const traceAndDom = await waitForCondition(
        async () => {
          const info = await activeSession.cdp.evaluate(`(() => {
          const trace = window.__pvUpdateTrace || [];
          const banner = document.querySelector('[data-testid="update-banner"]');
          const waiting = trace.some((t) => t.phase === 'waiting_for_jobs' && t.activeJobs?.backupActive);
          return {
            trace,
            waiting,
            bannerText: banner?.textContent || ''
          };
        })()`)
          return info.waiting ? info : null
        },
        'downloading progress and waiting_for_jobs UI state',
        60_000
      )

      const downloadEvents = traceAndDom.trace.filter((t) => t.phase === 'downloading')
      assert(
        downloadEvents.some((t) => (t.totalBytes ?? 0) > 0 && (t.transferredBytes ?? 0) > 0),
        `Expected real download progress events with non-zero bytes, got: ${JSON.stringify(downloadEvents)}`
      )
      assert(
        /Waiting for active backup job/i.test(traceAndDom.bannerText),
        `Expected waiting_for_jobs banner text while backup active, got: ${traceAndDom.bannerText}`
      )
      console.log(
        `[PASS] 3B. Observed download progress (${downloadEvents.length} events) and waiting_for_jobs banner during active backup`
      )

      // Wait for 0.1.1 to exit cleanly via quitAndInstall(true, true) after draining backup
      activeSession.cdp.close()
      const build1Exit = await Promise.race([
        activeSession.exited,
        sleep(90_000).then(() => ({ timedOut: true }))
      ])
      assert(
        !('timedOut' in build1Exit),
        'Timed out waiting for 0.1.1 to drain active backup and quit for update'
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
          'Drained active jobs; shutting down services before installing 0.1.2'
        ),
        `Expected UpdateCoordinator drain completion log in startup.log, got:\n${installLogTail}`
      )

      // Wait for NSIS --updated to automatically relaunch Build 2 (0.1.2)
      const relaunched = await waitForCondition(
        () => {
          if (!existsSync(startupLogPath)) return null
          const tail = readFileSync(startupLogPath, 'utf8').slice(logOffsetBeforeInstall)
          const startMatch = tail.match(/\[PID:(\d+)\] Process start: version=0\.1\.2\b.*--updated/)
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
        'automatic relaunch of upgraded 0.1.2 process',
        90_000
      )

      console.log(`[PASS] 3C. Upgraded silently and auto-relaunched 0.1.2 (PID ${relaunched.pid})`)
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

    // Verify upgraded 0.1.2 with CDP: version, catalog, metadata, annotations, both collections, vault, backup & source invariance
    activeSession = await launchTestApp(installedExe, profileDir, workRoot, {
      PV_DISABLE_AUTO_UPDATE: '1'
    })
    try {
      const upgradedInfo = await activeSession.cdp.evaluate('window.api.getAppInfo()')
      assert(
        upgradedInfo.version === '0.1.2',
        `Expected upgraded appInfo.version === 0.1.2, got ${upgradedInfo.version}`
      )
      const footer2 = await activeSession.cdp.evaluate(
        `document.querySelector('.sidebar-footer')?.textContent || ''`
      )
      assert(
        footer2.includes('Version 0.1.2'),
        `Expected Version 0.1.2 in sidebar, got: ${footer2}`
      )

      const photosAfter = await activeSession.cdp.evaluate(
        'window.api.getPhotosPage({ limit: 20, offset: 0 })'
      )
      assert(
        photosAfter.totalCount === 2,
        `Expected 2 photos after update, got ${photosAfter.totalCount}`
      )

      const docsAfter = await activeSession.cdp.evaluate(
        'window.api.getDocumentsPage({ limit: 20, offset: 0 })'
      )
      assert(docsAfter.totalCount === 1, `Expected 1 doc after update, got ${docsAfter.totalCount}`)

      const metaAfter = await activeSession.cdp.evaluate(
        `window.api.getPhotoMetadataDetail(${JSON.stringify({ fileLocationId: exifPhotoId })})`
      )
      assert(
        metaAfter.detail?.currentMetadata?.cameraMakeRaw === 'TestCam' &&
          metaAfter.detail?.currentMetadata?.cameraModelRaw === 'PV-100' &&
          metaAfter.detail?.currentMetadata?.captureCalendarDate === '2025-06-15',
        `EXIF metadata lost after 0.1.2 update: ${JSON.stringify(metaAfter)}`
      )

      const annAfter = await activeSession.cdp.evaluate(
        `window.api.getPhotoAnnotation(${JSON.stringify({ fileLocationId: exifPhotoId })})`
      )
      assert(
        annAfter.annotation?.rating === 5 && annAfter.annotation?.flag === 'pick',
        `Annotation lost after 0.1.2 update: ${JSON.stringify(annAfter)}`
      )

      const collectionsAfter = await activeSession.cdp.evaluate('window.api.listCollections({})')
      assert(
        collectionsAfter.items.some((c) => c.name === 'Pre-Update Collection') &&
          collectionsAfter.items.some((c) => c.name === 'After Failed Update'),
        `Expected both collections to survive upgrade: ${JSON.stringify(collectionsAfter)}`
      )
      const membershipsAfter = await activeSession.cdp.evaluate(
        `window.api.getPhotoMemberships(${JSON.stringify({ fileLocationId: exifPhotoId })})`
      )
      assert(
        membershipsAfter.items?.some((c) => c.collectionName === 'Pre-Update Collection') &&
          membershipsAfter.items?.some((c) => c.collectionName === 'After Failed Update'),
        `Photo collection memberships lost after upgrade: ${JSON.stringify(membershipsAfter)}`
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
        verifyBackup.verifiedFileCount >= 3 &&
          verifyBackup.hasVault === true &&
          verifyBackup.hasAnnotations === true,
        `Backup recovery point failed verification after update: ${JSON.stringify(verifyBackup)}`
      )

      const vaultHashes = new Set(
        collectFilesRecursive(join(vaultDir, 'files'))
          .filter((f) => !f.endsWith('manifest.json'))
          .map((f) => sha256File(f))
      )
      assert(
        vaultHashes.has(sourceHashesBefore.noisyPhoto),
        'Vault noisy photo hash mismatch after update'
      )
      assert(
        vaultHashes.has(sourceHashesBefore.exifPhoto),
        'Vault EXIF photo hash mismatch after update'
      )
      assert(vaultHashes.has(sourceHashesBefore.txt), 'Vault doc hash mismatch after update')
      assert(
        sha256File(noisyPhotoPath) === sourceHashesBefore.noisyPhoto,
        'Source noisy photo modified!'
      )
      assert(
        sha256File(exifPhotoPath) === sourceHashesBefore.exifPhoto,
        'Source EXIF photo modified!'
      )
      assert(sha256File(txtPath) === sourceHashesBefore.txt, 'Source txt modified!')
      assert(activeSession.cdp.runtimeErrors.length === 0, 'Unexpected renderer errors on 0.1.2')

      console.log(
        '[PASS] 3D. Verified 0.1.2 profile, catalog, EXIF metadata, annotations, collections, vault SHA-256, source invariance, and completed backup'
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
      '[PASS] 5. Cleaned up isolated test artifacts and verified Ron installation, taskbar shortcut, and production catalog untouched'
    )
  }
}

main().catch((err) => {
  console.error(`[FAIL] ${err instanceof Error ? err.stack || err.message : String(err)}`)
  process.exit(1)
})
