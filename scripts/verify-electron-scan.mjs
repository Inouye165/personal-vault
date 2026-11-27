#!/usr/bin/env node
/**
 * Personal Vault — Real Electron Scan Job Workflow Verification
 *
 * Exercises the end-to-end scan job workflow inside the real Electron application
 * across the preload contextBridge, IPC boundary, and SQLite persistence:
 *
 * 1. Launches real Electron application with isolated userData and test source roots
 * 2. Attaches via Chrome DevTools Protocol (CDP) to the renderer window
 * 3. Verifies window.api scan methods and subscribes to onScanProgress events
 * 4. Starts scan job via window.api.startScan({ roots })
 * 5. Executes mandatory pause via window.api.pauseScan(jobId), asserting status === 'paused'
 * 6. Executes resume via window.api.resumeScan(jobId), asserting status === 'running'
 * 7. Waits for scan completion, receiving validated IPC progress events
 * 8. Tests restart crash recovery: closes app, relaunches, verifies getActiveScanJob() returns status === 'interrupted'
 * 9. Resumes interrupted job via window.api.resumeScan() and verifies revalidation of modified file
 * 10. Verifies source preservation invariance: original source files remain unaltered
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const __dirname = resolve(fileURLToPath(import.meta.url), '..')
const rootDir = resolve(__dirname, '..')

const mode = process.argv.includes('--mode=unpacked') ? 'unpacked' : 'built'

function getFreePort() {
  return new Promise((resolvePort, reject) => {
    const s = createServer()
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
    await sleep(250)
  }
  const diag = {
    port,
    lastError: lastError?.message ?? null,
    lastTargets
  }
  throw new Error(`Timed out waiting for application window. Diagnostics: ${JSON.stringify(diag)}`)
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
        const { ok, bad } = pending.get(data.id)
        pending.delete(data.id)
        data.error ? bad(new Error(data.error.message)) : ok(data.result)
      } else if (data.method === 'Runtime.consoleAPICalled') {
        const text = data.params.args.map((a) => a.value ?? a.description ?? '').join(' ')
        console.log(`[renderer:console:${data.params.type}] ${text}`)
      } else if (data.method === 'Runtime.exceptionThrown') {
        console.log(`[renderer:exception] ${JSON.stringify(data.params.exceptionDetails)}`)
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
            }, 15000)
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
    throw new Error(result.exceptionDetails.exception?.description ?? 'Evaluation failed')
  }
  return result.result.value
}

async function waitForApi(cdp, timeoutMs = 15000) {
  const readyBy = Date.now() + timeoutMs
  while (Date.now() < readyBy) {
    try {
      const hasApi = await evaluate(cdp, `typeof window.api === 'object' && window.api !== null`)
      if (hasApi) return true
    } catch {
      // Evaluation failed while document was loading
    }
    await sleep(200)
  }
  return false
}

async function launchApp(userDataDir, port) {
  const common = [`--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`]

  let command
  let argv

  if (mode === 'built') {
    if (!existsSync(join(rootDir, 'out', 'main', 'index.js'))) {
      throw new Error('out/ is missing. Run `npm run build` first.')
    }
    command = electronPath
    argv = ['.', ...common]
  } else {
    const exe = join(rootDir, 'dist', 'win-unpacked', 'Personal Vault.exe')
    if (!existsSync(exe)) {
      throw new Error(`${exe} is missing. Run \`npm run build:unpack\` first.`)
    }
    command = exe
    argv = common
  }

  const child = spawn(command, argv, {
    cwd: rootDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ELECTRON_NO_ATTACH_CONSOLE: '1'
    }
  })

  child.stdout.on('data', (d) => process.stdout.write(`[electron:out] ${d}`))
  child.stderr.on('data', (d) => process.stderr.write(`[electron:err] ${d}`))

  return child
}

async function run() {
  console.log(`[verify-scan] Running real Electron scan workflow verification (mode: ${mode})...`)

  // Pre-build if built mode
  if (mode === 'built') {
    const buildRes = spawnSync('npm', ['run', 'build'], {
      cwd: rootDir,
      stdio: 'inherit',
      shell: true
    })
    if (buildRes.status !== 0) {
      console.error('[verify-scan] Build failed.')
      process.exit(1)
    }
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'pv-scan-real-electron-'))
  const userDataDir = join(tempDir, 'user-data')
  const sourceDir = join(tempDir, 'source-roots')

  const { mkdirSync } = await import('node:fs')
  mkdirSync(sourceDir, { recursive: true })
  mkdirSync(userDataDir, { recursive: true })

  // Create real test source files
  const file1 = join(sourceDir, 'photo1.jpg')
  const file2 = join(sourceDir, 'doc1.pdf')
  const file3 = join(sourceDir, 'photo2.png')

  writeFileSync(file1, 'photo-one-content-bytes-12345')
  writeFileSync(file2, 'document-one-content-pdf-67890')
  writeFileSync(file3, 'photo-two-content-png-abcde')

  // Create additional bulk files so pause has ample time to engage
  const bulkCount = 80
  const expectedTotalFiles = 3 + bulkCount
  for (let i = 0; i < bulkCount; i++) {
    writeFileSync(join(sourceDir, `bulk-${i}.jpg`), Buffer.alloc(16384, i % 256))
  }

  let child = null
  let cdp = null

  try {
    const port = await getFreePort()
    console.log(`  1. Launching Electron on port ${port} with isolated user-data...`)
    child = await launchApp(userDataDir, port)

    const deadline = Date.now() + 20000
    const page = await findPageTarget(port, deadline)
    cdp = await connectCdp(page.webSocketDebuggerUrl)
    await cdp.send('Runtime.enable')
    await cdp.send('Log.enable')

    const cdpEvents = []
    cdp.events = cdpEvents

    console.log('  2. Verifying window.api bridge surface and subscribing to progress...')
    await waitForApi(cdp)
    const apiCheck = await evaluate(
      cdp,
      `(() => ({
        hasApi: typeof window.api === 'object' && window.api !== null,
        hasStartScan: typeof window.api?.startScan === 'function',
        hasPauseScan: typeof window.api?.pauseScan === 'function',
        hasResumeScan: typeof window.api?.resumeScan === 'function',
        hasCancelScan: typeof window.api?.cancelScan === 'function',
        hasGetActiveScanJob: typeof window.api?.getActiveScanJob === 'function',
        hasGetLatestScanJob: typeof window.api?.getLatestScanJob === 'function',
        hasDismissScanJob: typeof window.api?.dismissScanJob === 'function',
        hasOnScanProgress: typeof window.api?.onScanProgress === 'function'
      }))()`
    )

    if (
      !apiCheck.hasApi ||
      !apiCheck.hasStartScan ||
      !apiCheck.hasGetLatestScanJob ||
      !apiCheck.hasDismissScanJob ||
      !apiCheck.hasOnScanProgress
    ) {
      throw new Error(
        `window.api bridge missing required scan methods: ${JSON.stringify(apiCheck)}`
      )
    }

    // Set up progress accumulation in renderer window
    await evaluate(
      cdp,
      `(() => {
        window.__scanEvents = []
        window.api.onScanProgress((p) => {
          window.__scanEvents.push(p)
        })
      })()`
    )

    console.log('  3. Starting scan job via window.api.startScan across IPC...')
    const startRes = await evaluate(
      cdp,
      `window.api.startScan({ roots: [${JSON.stringify(sourceDir)}] })`
    )

    if (!startRes.success || !startRes.job || startRes.job.status !== 'running') {
      throw new Error(`startScan failed across IPC: ${JSON.stringify(startRes)}`)
    }
    const jobId = startRes.job.jobId

    console.log('  4. Executing mandatory pauseScan across IPC...')
    // Small yield to let scan initialize
    await sleep(5)
    const pauseRes = await evaluate(cdp, `window.api.pauseScan(${jobId})`)
    console.log(`     Pause response: status=${pauseRes.job?.status}`)

    if (!pauseRes.success || !pauseRes.job || pauseRes.job.status !== 'paused') {
      throw new Error(
        `Mandatory pauseScan assertion failed: expected status 'paused', got ${pauseRes.job?.status}`
      )
    }

    console.log('  5. Executing resumeScan across IPC...')
    const resumeRes = await evaluate(cdp, `window.api.resumeScan(${jobId})`)
    if (!resumeRes.success || !resumeRes.job || resumeRes.job.status !== 'running') {
      throw new Error(`resumeScan failed across IPC: ${JSON.stringify(resumeRes)}`)
    }

    console.log('  6. Awaiting scan completion through real IPC progress events...')
    const completeDeadline = Date.now() + 15000
    let completedJob = null
    while (Date.now() < completeDeadline) {
      const completed = await evaluate(
        cdp,
        `(() => {
          if (!Array.isArray(window.__scanEvents)) return null
          for (let i = window.__scanEvents.length - 1; i >= 0; i--) {
            if (window.__scanEvents[i].status === 'completed') return window.__scanEvents[i]
          }
          return null
        })()`
      )
      if (completed) {
        completedJob = completed
        break
      }
      await sleep(250)
    }

    if (!completedJob) {
      const currentEvents = await evaluate(cdp, `window.__scanEvents`)
      const activeState = await evaluate(cdp, `window.api.getActiveScanJob()`)
      console.log('Current events in renderer:', JSON.stringify(currentEvents, null, 2))
      console.log('Active state in main:', JSON.stringify(activeState, null, 2))
      throw new Error('Timed out waiting for scan job to complete')
    }

    if (
      completedJob.discoveredCount !== expectedTotalFiles ||
      completedJob.hashedCount !== expectedTotalFiles
    ) {
      throw new Error(
        `Scan counts mismatch: discovered=${completedJob.discoveredCount}, hashed=${completedJob.hashedCount}, expected ${expectedTotalFiles}`
      )
    }

    console.log('  7. Verifying progress events received in renderer...')
    const eventCount = await evaluate(cdp, `window.__scanEvents.length`)
    if (eventCount === 0) {
      throw new Error('No progress events received in renderer via window.api.onScanProgress')
    }

    console.log('  8. Testing terminal job restoration and dismissal across IPC...')
    const latestCheck = await evaluate(cdp, `window.api.getLatestScanJob()`)
    if (
      !latestCheck.job ||
      latestCheck.job.jobId !== jobId ||
      latestCheck.job.status !== 'completed'
    ) {
      throw new Error(
        `getLatestScanJob failed to return terminal job: ${JSON.stringify(latestCheck)}`
      )
    }
    const dismissRes = await evaluate(cdp, `window.api.dismissScanJob(${jobId})`)
    if (!dismissRes.success) {
      throw new Error(`dismissScanJob failed: ${JSON.stringify(dismissRes)}`)
    }
    const latestAfterDismiss = await evaluate(cdp, `window.api.getLatestScanJob()`)
    if (latestAfterDismiss.job !== null) {
      throw new Error(`Expected null after dismissal, got: ${JSON.stringify(latestAfterDismiss)}`)
    }

    console.log(
      '  9. Testing crash recovery: starting in-progress scan and killing process mid-flight...'
    )
    const crashSubdir = join(sourceDir, 'crash-files')
    mkdirSync(crashSubdir, { recursive: true })
    for (let i = 0; i < 300; i++) {
      writeFileSync(join(crashSubdir, `crash-${i}.jpg`), `content-data-${i}`)
    }

    const job2Start = await evaluate(
      cdp,
      `window.api.startScan({ roots: [${JSON.stringify(sourceDir)}] })`
    )
    if (!job2Start.success || !job2Start.job || job2Start.job.status !== 'running') {
      throw new Error(`Failed to start second scan for crash test: ${JSON.stringify(job2Start)}`)
    }
    const job2Id = job2Start.job.jobId

    // Abruptly terminate Electron mid-scan while it is actively running
    cdp.close()
    cdp = null
    killTree(child)
    child = null
    await sleep(1500)

    console.log('  10. Relaunching application on same userData to verify crash recovery...')
    const port2 = await getFreePort()
    child = await launchApp(userDataDir, port2)
    const page2 = await findPageTarget(port2, Date.now() + 30000)
    cdp = await connectCdp(page2.webSocketDebuggerUrl)
    await cdp.send('Runtime.enable')
    await waitForApi(cdp)

    const recovered = await evaluate(cdp, `window.api.getActiveScanJob()`)
    console.log(
      `      Recovered active job status: ${recovered.job?.status}, jobId: ${recovered.job?.jobId}`
    )
    if (
      !recovered.job ||
      recovered.job.status !== 'interrupted' ||
      recovered.job.jobId !== job2Id
    ) {
      throw new Error(
        `Expected recovered job status 'interrupted' for job #${job2Id}, got: ${JSON.stringify(recovered)}`
      )
    }

    console.log('  11. Testing resume and revalidation of modified file on recovered job...')
    const newBytes = 'MODIFIED-PHOTO-1-NEW-BYTES-EXACT-RECOVERY'
    writeFileSync(file1, newBytes)
    const { createHash } = await import('node:crypto')
    const expectedHash = createHash('sha256').update(newBytes).digest('hex')

    // Set up progress accumulation on relaunched window
    await evaluate(
      cdp,
      `(() => {
        window.__scanEvents2 = []
        window.api.onScanProgress((p) => {
          window.__scanEvents2.push(p)
        })
      })()`
    )

    const resumeRecovered = await evaluate(cdp, `window.api.resumeScan(${recovered.job.jobId})`)
    if (!resumeRecovered.success || resumeRecovered.job?.status !== 'running') {
      throw new Error(`Failed to resume recovered job: ${JSON.stringify(resumeRecovered)}`)
    }

    // Wait for resumed job completion
    const finishDeadline = Date.now() + 30000
    let finishedFinal = null
    while (Date.now() < finishDeadline) {
      const completed = await evaluate(
        cdp,
        `(() => {
          if (!Array.isArray(window.__scanEvents2)) return null
          for (let i = window.__scanEvents2.length - 1; i >= 0; i--) {
            if (window.__scanEvents2[i].status === 'completed') return window.__scanEvents2[i]
          }
          return null
        })()`
      )
      if (completed) {
        finishedFinal = completed
        break
      }
      await sleep(250)
    }

    if (!finishedFinal || finishedFinal.status !== 'completed') {
      throw new Error('Resumed job failed to complete')
    }

    console.log(
      '  12. Verifying database state: current observation digest and deactivated old observation...'
    )
    const dbPath = join(userDataDir, 'vault-catalog.db')
    const { DatabaseSync } = await import('node:sqlite')
    const verifyDb = new DatabaseSync(dbPath)
    try {
      const rows = verifyDb
        .prepare(
          `
          SELECT fl.original_path, d.id as obs_id, d.byte_size, d.is_current, h.sha256, h.is_active
          FROM file_locations fl
          JOIN discovery_observations d ON d.file_location_id = fl.id
          LEFT JOIN hash_observations h ON h.discovery_observation_id = d.id
          WHERE fl.original_path = ?
          ORDER BY d.id ASC;
        `
        )
        .all(file1)

      if (rows.length < 2) {
        throw new Error(`Expected at least 2 observations for modified file, got ${rows.length}`)
      }
      const oldObs = rows[rows.length - 2]
      const currentObs = rows[rows.length - 1]

      if (oldObs.is_current !== 0 || oldObs.is_active !== 0) {
        throw new Error(`Old observation was not properly deactivated: ${JSON.stringify(oldObs)}`)
      }
      if (currentObs.is_current !== 1 || currentObs.is_active !== 1) {
        throw new Error(`Current observation is not active: ${JSON.stringify(currentObs)}`)
      }
      if (currentObs.sha256 !== expectedHash) {
        throw new Error(
          `Active digest ${currentObs.sha256} does not match expected ${expectedHash}`
        )
      }
      if (currentObs.byte_size !== newBytes.length) {
        throw new Error(`Byte size ${currentObs.byte_size} does not match ${newBytes.length}`)
      }
    } finally {
      verifyDb.close()
    }

    console.log('  13. Testing ordinary quit/reopen recovery...')
    const quitSourceDir = join(tempDir, 'quit-roots')
    mkdirSync(quitSourceDir, { recursive: true })
    for (let i = 0; i < 40; i++) {
      writeFileSync(join(quitSourceDir, `quit-${i}.jpg`), Buffer.alloc(16384, (i + 2) % 256))
    }
    const job3Start = await evaluate(
      cdp,
      `window.api.startScan({ roots: [${JSON.stringify(quitSourceDir)}] })`
    )
    if (!job3Start.success || !job3Start.job || job3Start.job.status !== 'running') {
      throw new Error(`Failed to start scan for quit test: ${JSON.stringify(job3Start)}`)
    }
    const job3Id = job3Start.job.jobId
    await sleep(20)

    // Trigger ordinary application close via CDP window.close()
    await evaluate(cdp, `window.close()`)
    cdp.close()
    cdp = null

    // Wait for process to exit cleanly on its own via before-quit shutdown
    const exitDeadline = Date.now() + 10000
    while (Date.now() < exitDeadline && child.exitCode === null) {
      await sleep(200)
    }
    if (child.exitCode === null) {
      killTree(child)
    }
    child = null
    await sleep(1000)

    // Relaunch instance 3 to verify graceful shutdown preserved recoverable state
    const port3 = await getFreePort()
    child = await launchApp(userDataDir, port3)
    const page3 = await findPageTarget(port3, Date.now() + 30000)
    cdp = await connectCdp(page3.webSocketDebuggerUrl)
    await cdp.send('Runtime.enable')
    await waitForApi(cdp)

    const quitRecovered = await evaluate(cdp, `window.api.getActiveScanJob()`)
    console.log(
      `      Graceful quit recovered job status: ${quitRecovered.job?.status}, jobId: ${quitRecovered.job?.jobId}`
    )
    if (
      !quitRecovered.job ||
      quitRecovered.job.status !== 'interrupted' ||
      quitRecovered.job.jobId !== job3Id
    ) {
      throw new Error(
        `Expected graceful quit recovered status 'interrupted' for job #${job3Id}, got: ${JSON.stringify(quitRecovered)}`
      )
    }

    console.log('  14. Verifying source preservation invariance...')
    const content1 = readFileSync(file1, 'utf8')
    if (content1 !== newBytes) {
      throw new Error('Source file photo1.jpg was modified by scanner')
    }
    const content2 = readFileSync(file2, 'utf8')
    if (content2 !== 'document-one-content-pdf-67890') {
      throw new Error('Source file doc1.pdf was corrupted')
    }

    console.log(
      `[verify-scan] ALL 14 CHECKS PASSED: Real Electron scan workflow, IPC boundary, mandatory pause/resume, actual in-progress termination recovery, direct SQLite digest verification, graceful shutdown recovery, and source preservation verified (${mode}).`
    )
  } finally {
    if (cdp) {
      try {
        cdp.close()
      } catch {
        // Suppress
      }
    }
    if (child) {
      killTree(child)
    }
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Suppress tempdir cleanup error
    }
  }
}

run().catch((err) => {
  console.error('[verify-scan] Verification FAILED:', err)
  process.exit(1)
})
