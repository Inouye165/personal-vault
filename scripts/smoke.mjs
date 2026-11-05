#!/usr/bin/env node
/**
 * Real-Electron smoke check for the preload bridge.
 *
 * Launches the actual application (dev server, built output, or the unpacked executable),
 * attaches over the Chrome DevTools Protocol, and verifies in the renderer that:
 *  - `window.api` exists with exactly the expected methods and returns real values across IPC,
 *  - the shell reaches the confirmed empty state (not loading, not error),
 *  - hostile navigation and popups from the page are blocked,
 *  - no preload error, uncaught exception, or console/log error occurred.
 *
 * Usage: node scripts/smoke.mjs --mode=dev|built|unpacked [--screenshot=<file.png>]
 * Only the process tree started by this script is terminated.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import electronPath from 'electron'

const TOTAL_TIMEOUT_MS = 60_000
const READY_TIMEOUT_MS = 20_000
const root = resolve(import.meta.dirname, '..')
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=')
    return [k, v]
  })
)
const mode = args.mode
if (!['dev', 'built', 'unpacked'].includes(mode)) {
  console.error('Usage: node scripts/smoke.mjs --mode=dev|built|unpacked [--screenshot=file.png]')
  process.exit(2)
}

const expectedVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const failures = []
const fail = (message) => failures.push(message)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolvePort(port))
    })
  })
}

function launchCommand(port, userDataDir) {
  const common = [`--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`]
  if (mode === 'dev') {
    const bin = join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')
    return {
      command: process.execPath,
      argv: [
        bin,
        'dev',
        '--remoteDebuggingPort',
        String(port),
        '--',
        `--user-data-dir=${userDataDir}`
      ]
    }
  }
  if (mode === 'built') {
    if (!existsSync(join(root, 'out', 'main', 'index.js'))) {
      throw new Error('out/ is missing. Run `npm run build` first.')
    }
    return { command: electronPath, argv: ['.', ...common] }
  }
  const exe = join(root, 'dist', 'win-unpacked', 'Personal Vault.exe')
  if (!existsSync(exe)) throw new Error(`${exe} is missing. Run \`npm run build:unpack\` first.`)
  return { command: exe, argv: common }
}

function killTree(child) {
  if (!child.pid || child.exitCode !== null) return
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
      /* not listening yet */
    }
    await sleep(250)
  }
  throw new Error('Timed out waiting for the application window to appear')
}

function connectCdp(url, events) {
  return new Promise((resolveCdp, reject) => {
    const ws = new WebSocket(url)
    let nextId = 1
    const pending = new Map()
    ws.onerror = () => reject(new Error('Could not connect to the DevTools protocol'))
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
            }, 10_000)
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
    throw new Error(result.exceptionDetails.exception?.description ?? 'evaluation failed')
  }
  return result.result.value
}

const BRIDGE_PROBE = `(async () => {
  const out = { hasApi: typeof window.api === 'object' && window.api !== null }
  if (!out.hasApi) return out
  out.methods = Object.keys(window.api).sort()
  out.appInfo = await window.api.getAppInfo()
  out.vaultStatus = await window.api.getVaultStatus()
  out.setTabAck = await window.api.setTab('photos')
  try { await window.api.setTab('bogus'); out.bogusTabRejected = false } catch { out.bogusTabRejected = true }
  out.nodeLeak = [typeof window.require, typeof window.process, typeof window.Buffer].join(',')
  return out
})()`

const DOM_PROBE = `(() => ({
  status: document.querySelector('[role=status]')?.textContent ?? null,
  alert: document.querySelector('[role=alert]')?.textContent ?? null,
  title: document.querySelector('h1')?.textContent ?? null,
  emptyHeading: document.querySelector('h2')?.textContent ?? null,
  navigation: [...document.querySelectorAll('nav button')].map((b) => b.textContent),
  searchDisabled: document.querySelector('input[type=search]')?.disabled ?? null
}))()`

const HOSTILE_PROBE = `(async () => {
  const before = location.href
  const popup = window.open('https://example.com/', '_blank')
  location.assign('https://example.com/')
  await new Promise((r) => setTimeout(r, 800))
  location.assign('file:///C:/Windows/win.ini')
  await new Promise((r) => setTimeout(r, 800))
  return { before, after: location.href, popupBlocked: popup === null }
})()`

let activeChild = null

async function main() {
  const userDataDir = mkdtempSync(join(tmpdir(), 'pv-smoke-'))
  const port = await freePort()
  const { command, argv } = launchCommand(port, userDataDir)
  const events = []
  let stderr = ''
  let stdout = ''
  const child = spawn(command, argv, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  child.stderr.on('data', (d) => (stderr += d))
  child.stdout.on('data', (d) => (stdout += d))
  activeChild = child
  const exited = new Promise((r) => child.once('exit', (code) => r(code)))
  let cdp
  try {
    const deadline = Date.now() + TOTAL_TIMEOUT_MS
    const target = await Promise.race([
      findPageTarget(port, deadline),
      exited.then((code) => {
        throw new Error(`Application exited early with code ${code}`)
      })
    ])
    console.log(`[smoke] mode=${mode} page=${target.url}`)

    if (mode === 'dev' && !/^http:\/\/localhost:\d+\//.test(target.url))
      fail(`Unexpected page URL ${target.url}`)
    if (mode !== 'dev' && !/^file:\/\/\/.*\/renderer\/index\.html$/i.test(target.url)) {
      fail(`Unexpected page URL ${target.url}`)
    }

    cdp = await connectCdp(target.webSocketDebuggerUrl, events)
    await cdp.send('Runtime.enable')
    await cdp.send('Log.enable')

    // Wait for the shell to leave the loading phase (bounded).
    let dom
    const readyBy = Date.now() + READY_TIMEOUT_MS
    do {
      dom = await evaluate(cdp, DOM_PROBE)
      if (dom.status === null && (dom.alert !== null || dom.emptyHeading !== null)) break
      await sleep(250)
    } while (Date.now() < readyBy)

    const bridge = await evaluate(cdp, BRIDGE_PROBE)
    if (!bridge.hasApi) fail('window.api is missing')
    else {
      const expectMethods = ['getAppInfo', 'getVaultStatus', 'setTab']
      if (JSON.stringify(bridge.methods) !== JSON.stringify(expectMethods)) {
        fail(`window.api methods were ${JSON.stringify(bridge.methods)}`)
      }
      const info = bridge.appInfo
      if (info?.name !== 'Personal Vault') fail(`appInfo.name was ${info?.name}`)
      if (info?.version !== expectedVersion)
        fail(`appInfo.version ${info?.version} != ${expectedVersion}`)
      if (info?.platform !== process.platform) fail(`appInfo.platform was ${info?.platform}`)
      if (info?.isPackaged !== (mode === 'unpacked'))
        fail(`appInfo.isPackaged was ${info?.isPackaged}`)
      const status = bridge.vaultStatus
      if (status?.sourceCount !== 0 || status?.itemCount !== 0 || status?.isReady !== true) {
        fail(`vaultStatus was ${JSON.stringify(status)}`)
      }
      if (bridge.setTabAck !== true) fail(`setTab('photos') returned ${bridge.setTabAck}`)
      if (bridge.bogusTabRejected !== true) fail('setTab("bogus") was not rejected')
      if (bridge.nodeLeak !== 'undefined,undefined,undefined') {
        fail(`Node globals leaked into the renderer: ${bridge.nodeLeak}`)
      }
      console.log(
        `[smoke] bridge: ${JSON.stringify({ appInfo: info, vaultStatus: status, setTabAck: bridge.setTabAck })}`
      )
    }

    dom = await evaluate(cdp, DOM_PROBE)
    if (dom.alert !== null) fail(`UI shows an error: ${dom.alert}`)
    if (dom.status !== null) fail(`UI is still loading: ${dom.status}`)
    if (dom.title !== 'Personal Vault') fail(`h1 was ${dom.title}`)
    if (!/no sources connected/i.test(dom.emptyHeading ?? ''))
      fail(`empty heading was ${dom.emptyHeading}`)
    if (
      JSON.stringify(dom.navigation) !==
      JSON.stringify(['All Items', 'Photos', 'Documents', 'Review', 'Duplicates'])
    ) {
      fail(`navigation was ${JSON.stringify(dom.navigation)}`)
    }
    if (dom.searchDisabled !== true) fail('search is not disabled')

    const probeStart = events.length
    const hostile = await evaluate(cdp, HOSTILE_PROBE)
    if (hostile.before !== hostile.after)
      fail(`navigation was not blocked: ${hostile.before} -> ${hostile.after}`)
    if (!hostile.popupBlocked) fail('window.open was not blocked')

    if (args.screenshot) {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(resolve(root, args.screenshot), Buffer.from(shot.data, 'base64'))
      console.log(`[smoke] screenshot: ${args.screenshot}`)
    }

    await sleep(300)
    for (const [index, event] of events.entries()) {
      // Chromium itself refuses a page-initiated file: navigation from http(s); that log line is the expected result of the hostile probe.
      if (
        index >= probeStart &&
        event.method === 'Log.entryAdded' &&
        /Not allowed to load local resource/.test(event.params.entry.text)
      )
        continue
      if (event.method === 'Runtime.exceptionThrown') {
        fail(
          `renderer exception: ${event.params.exceptionDetails.exception?.description ?? event.params.exceptionDetails.text}`
        )
      } else if (
        event.method === 'Runtime.consoleAPICalled' &&
        ['error', 'assert'].includes(event.params.type)
      ) {
        fail(
          `console.${event.params.type}: ${event.params.args.map((a) => a.value ?? a.description).join(' ')}`
        )
      } else if (event.method === 'Log.entryAdded' && event.params.entry.level === 'error') {
        fail(`log error: ${event.params.entry.text} ${event.params.entry.url ?? ''}`)
      }
    }
    if (/Unable to load preload script|preload.*(error|fail)|Uncaught/i.test(stderr + stdout)) {
      fail(`process output reports an error:\n${(stderr + stdout).trim().slice(-1500)}`)
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  } finally {
    cdp?.close()
    killTree(child)
    await Promise.race([exited, sleep(5000)])
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }

  if (failures.length > 0) {
    console.error(`[smoke] FAILED (${mode}):`)
    for (const f of failures) console.error(`  - ${f}`)
    if (stderr.trim()) console.error(`[smoke] stderr tail:\n${stderr.trim().slice(-1500)}`)
    process.exit(1)
  }
  console.log(`[smoke] PASSED (${mode})`)
}

const watchdog = setTimeout(() => {
  if (activeChild) killTree(activeChild)
  console.error(`[smoke] FAILED: exceeded ${TOTAL_TIMEOUT_MS}ms`)
  process.exit(1)
}, TOTAL_TIMEOUT_MS + 15_000)
watchdog.unref()

await main()
