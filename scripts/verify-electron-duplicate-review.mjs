#!/usr/bin/env node
/**
 * Personal Vault — Real Electron Duplicate Review Workflow Verification
 *
 * Exercises the complete duplicate review workflow across real Electron processes,
 * the preload contextBridge, typed IPC boundaries, and SQLite persistence:
 *
 * 1. Creates isolated temporary user-data and test source roots with exact duplicate groups
 * 2. Launches real Electron application and attaches via Chrome DevTools Protocol (CDP)
 * 3. Runs a scan to generate catalog records, verified observations, and duplicate groups
 * 4. Calls window.api.getDuplicateGroups and asserts exact duplicate grouping by SHA-256 and byte size
 * 5. Calls window.api.getDuplicateGroupMembers and inspects member provenance and metadata
 * 6. Persists a review decision (reviewed + preferred location) via window.api.setDuplicateReview
 * 7. Tests persistence: closes app, relaunches, and asserts decision persists across restart
 * 8. Tests invalidation: modifies a member file out of band, rescans, and verifies prior decision is invalidated
 * 9. Tests stale write rejection: submitting a review with an outdated signature is rejected
 * 10. Verifies source preservation invariance: original source files are never altered by Personal Vault
 */

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
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
    stdio: 'pipe',
    env: { ...process.env, NODE_ENV: 'production' }
  })

  child.stdout.on('data', (d) => {
    const s = d.toString().trim()
    if (s) console.log(`[main:stdout] ${s}`)
  })
  child.stderr.on('data', (d) => {
    const s = d.toString().trim()
    if (s) console.error(`[main:stderr] ${s}`)
  })

  return child
}

async function waitForScanCompletion(cdp, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await evaluate(cdp, `window.api.getLatestScanJob()`)
    if (res && res.job && (res.job.status === 'completed' || res.job.status === 'failed')) {
      return res.job
    }
    await sleep(250)
  }
  throw new Error('Scan job timed out')
}

function sha256OfFile(filePath) {
  const data = readFileSync(filePath)
  return createHash('sha256').update(data).digest('hex')
}

async function main() {
  console.log(`\n=== Personal Vault: Duplicate Review Real-Electron Verification (${mode}) ===\n`)

  const testUserData = mkdtempSync(join(tmpdir(), 'pv-dup-test-user-'))
  const testSources = mkdtempSync(join(tmpdir(), 'pv-dup-test-sources-'))

  const checks = []
  function recordCheck(name, pass, details = '') {
    checks.push({ name, pass, details })
    const mark = pass ? '✓' : '✗'
    console.log(`  ${mark} [${checks.length}] ${name} ${details ? `(${details})` : ''}`)
    if (!pass) {
      throw new Error(`Verification failed at check: ${name} - ${details}`)
    }
  }

  let child = null
  let cdp = null

  try {
    // 1. Setup test fixtures:
    // Group 1: 3 exact duplicates (1024 bytes)
    const contentGroup1 = Buffer.alloc(1024, 0x41) // 1024 'A's
    const dirA = join(testSources, 'folderA')
    const dirB = join(testSources, 'folderB', 'nested')
    mkdirSync(dirA, { recursive: true })
    mkdirSync(dirB, { recursive: true })

    const file1 = join(dirA, 'photo1.jpg')
    const file2 = join(dirA, 'photo2.jpg')
    const file3 = join(dirB, 'copy_photo.jpg')

    writeFileSync(file1, contentGroup1)
    writeFileSync(file2, contentGroup1)
    writeFileSync(file3, contentGroup1)

    // Group 2: 2 exact duplicates (512 bytes)
    const contentGroup2 = Buffer.alloc(512, 0x42) // 512 'B's
    const file4 = join(dirA, 'docA.txt')
    const file5 = join(dirB, 'docB.txt')
    writeFileSync(file4, contentGroup2)
    writeFileSync(file5, contentGroup2)

    // Unique file: (256 bytes)
    const contentUnique = Buffer.alloc(256, 0x43)
    const fileUnique = join(dirA, 'unique.txt')
    writeFileSync(fileUnique, contentUnique)

    // Snapshot initial metadata for source preservation invariance check
    // Including content hashes, byte sizes, creation times where available, and full-precision modification timestamps
    const initialSnapshots = new Map()
    for (const f of [file1, file2, file3, file4, file5, fileUnique]) {
      const st = statSync(f)
      initialSnapshots.set(f, {
        size: st.size,
        birthtimeMs: typeof st.birthtimeMs === 'number' ? st.birthtimeMs : null,
        mtimeMs: st.mtimeMs,
        sha256: sha256OfFile(f)
      })
    }
    recordCheck('Fixture files initialized with exact duplicate groups', true)

    // 2. Launch App (First Run)
    const port = await getFreePort()
    child = await launchApp(testUserData, port)

    const pageTarget = await findPageTarget(port, Date.now() + 15000)
    cdp = await connectCdp(pageTarget.webSocketDebuggerUrl)
    await cdp.send('Runtime.enable')

    const hasApi = await waitForApi(cdp)
    recordCheck('Connected to real Electron renderer window with window.api', hasApi)

    // Verify window.api duplicate review methods exist
    const apiCheck = await evaluate(
      cdp,
      `[typeof window.api.getDuplicateGroups, typeof window.api.getDuplicateGroupMembers, typeof window.api.setDuplicateReview].every(t => t === 'function')`
    )
    recordCheck('window.api exposes typed duplicate review methods', apiCheck)

    // Start scan on testSources
    const startScanResult = await evaluate(
      cdp,
      `window.api.startScan({ roots: [${JSON.stringify(testSources)}] })`
    )
    recordCheck('Scan job started successfully over test roots', startScanResult.success)

    const completedJob = await waitForScanCompletion(cdp)
    recordCheck(
      'Scan completed with all files discovered and hashed',
      completedJob.status === 'completed' && completedJob.hashedCount === 6,
      `hashed: ${completedJob.hashedCount}`
    )

    // 3. Query duplicate groups
    const groupsResponse = await evaluate(
      cdp,
      `window.api.getDuplicateGroups({ offset: 0, limit: 10 })`
    )
    recordCheck(
      'getDuplicateGroups returns exactly 2 duplicate groups',
      groupsResponse.totalCount === 2
    )

    const group1 = groupsResponse.items.find((g) => g.byteSize === 1024)
    const group2 = groupsResponse.items.find((g) => g.byteSize === 512)
    recordCheck(
      'Duplicate groups match exact SHA-256 and byte size with 3 and 2 copies',
      group1 && group1.fileCount === 3 && group2 && group2.fileCount === 2
    )
    recordCheck(
      'Duplicate groups are initialized as unreviewed with valid groupSignature',
      group1.reviewStatus === 'unreviewed' &&
        group1.preferredLocationId === null &&
        typeof group1.groupSignature === 'string' &&
        group1.groupSignature.length === 64
    )

    // 4. Query members of Group 1
    const membersResponse = await evaluate(
      cdp,
      `window.api.getDuplicateGroupMembers({ sha256: ${JSON.stringify(group1.sha256)}, byteSize: ${group1.byteSize}, offset: 0, limit: 10 })`
    )
    recordCheck(
      'getDuplicateGroupMembers returns 3 members with complete metadata and provenance',
      membersResponse.items.length === 3 &&
        membersResponse.items.every(
          (m) =>
            m.byteSize === 1024 &&
            m.activeHash === group1.sha256 &&
            typeof m.discoveryObservationId === 'number' &&
            typeof m.hashObservationId === 'number' &&
            typeof m.activeHashVerifiedAtMs === 'number'
        )
    )

    // 5. Submit Review Decision for Group 1 (mark as reviewed, set file1 as preferred location)
    const preferredMember = membersResponse.items.find((m) => m.originalPath.endsWith('photo1.jpg'))
    const reviewResult = await evaluate(
      cdp,
      `window.api.setDuplicateReview({
        sha256: ${JSON.stringify(group1.sha256)},
        byteSize: ${group1.byteSize},
        status: 'reviewed',
        preferredLocationId: ${preferredMember.fileLocationId},
        expectedGroupSignature: ${JSON.stringify(group1.groupSignature)}
      })`
    )
    recordCheck(
      'setDuplicateReview persists reviewed decision with preferred location',
      reviewResult.status === 'reviewed' &&
        reviewResult.preferredLocationId === preferredMember.fileLocationId
    )

    // 5b. Preferred-location change without status toggle on Group 2
    // Group 2 is unreviewed; set docA as preferred location while keeping status as unreviewed
    const membersGroup2 = await evaluate(
      cdp,
      `window.api.getDuplicateGroupMembers({ sha256: ${JSON.stringify(group2.sha256)}, byteSize: ${group2.byteSize}, offset: 0, limit: 10 })`
    )
    const prefGroup2Member = membersGroup2.items.find((m) => m.originalPath.endsWith('docA.txt'))
    const group2ReviewResult = await evaluate(
      cdp,
      `window.api.setDuplicateReview({
        sha256: ${JSON.stringify(group2.sha256)},
        byteSize: ${group2.byteSize},
        status: 'unreviewed',
        preferredLocationId: ${prefGroup2Member.fileLocationId},
        expectedGroupSignature: ${JSON.stringify(group2.groupSignature)}
      })`
    )
    recordCheck(
      'Preferred location set without status toggle persists unreviewed status',
      group2ReviewResult.status === 'unreviewed' &&
        group2ReviewResult.preferredLocationId === prefGroup2Member.fileLocationId
    )

    // Close application cleanly to test persistence across restart
    cdp.close()
    cdp = null
    killTree(child)
    child = null
    await sleep(1500)

    // 6. Relaunch Application on the same userData directory
    const relaunchPort = await getFreePort()
    child = await launchApp(testUserData, relaunchPort)

    const relaunchPage = await findPageTarget(relaunchPort, Date.now() + 15000)
    cdp = await connectCdp(relaunchPage.webSocketDebuggerUrl)
    await cdp.send('Runtime.enable')
    await waitForApi(cdp)

    // Query duplicate groups after restart
    const groupsAfterRestart = await evaluate(cdp, `window.api.getDuplicateGroups()`)
    const group1Restart = groupsAfterRestart.items.find((g) => g.byteSize === 1024)
    const group2Restart = groupsAfterRestart.items.find((g) => g.byteSize === 512)
    recordCheck(
      'Review decision persists across application restart',
      group1Restart &&
        group1Restart.reviewStatus === 'reviewed' &&
        group1Restart.preferredLocationId === preferredMember.fileLocationId &&
        group1Restart.hasStaleDecision === false
    )
    recordCheck(
      'Preferred location without status toggle persists across application restart',
      group2Restart &&
        group2Restart.reviewStatus === 'unreviewed' &&
        group2Restart.preferredLocationId === prefGroup2Member.fileLocationId &&
        group2Restart.hasStaleDecision === false
    )

    // 7. Test Invalidation: Modify 1 member of Group 1 out of band
    // Append bytes to file3 ('copy_photo.jpg'), changing its byteSize and hash
    writeFileSync(file3, Buffer.concat([contentGroup1, Buffer.from('modified-extra-data')]))
    // Establish a new baseline for file3 immediately after modification, before application rescan
    const stMod = statSync(file3)
    const modifiedFile3Baseline = {
      size: stMod.size,
      birthtimeMs: typeof stMod.birthtimeMs === 'number' ? stMod.birthtimeMs : null,
      mtimeMs: stMod.mtimeMs,
      sha256: sha256OfFile(file3)
    }
    recordCheck('Modified member file3 out of band and established new baseline', true)

    // Trigger rescan
    await evaluate(cdp, `window.api.startScan({ roots: [${JSON.stringify(testSources)}] })`)
    await waitForScanCompletion(cdp)

    // Query duplicate groups after rescan
    const groupsAfterRescan = await evaluate(cdp, `window.api.getDuplicateGroups()`)
    const group1Rescan = groupsAfterRescan.items.find((g) => g.sha256 === group1.sha256)
    recordCheck(
      'Group 1 now has 2 members after 3rd member changed',
      group1Rescan && group1Rescan.fileCount === 2
    )
    recordCheck(
      'Group 1 decision is invalidated due to membership/content change (status: unreviewed, hasStaleDecision: true)',
      group1Rescan &&
        group1Rescan.reviewStatus === 'unreviewed' &&
        group1Rescan.preferredLocationId === null &&
        group1Rescan.hasStaleDecision === true
    )

    // 8. Stale write rejection: Attempting to submit review with the old signature must reject
    let staleWriteRejected = false
    try {
      await evaluate(
        cdp,
        `window.api.setDuplicateReview({
          sha256: ${JSON.stringify(group1.sha256)},
          byteSize: 1024,
          status: 'reviewed',
          preferredLocationId: ${preferredMember.fileLocationId},
          expectedGroupSignature: ${JSON.stringify(group1.groupSignature)}
        })`
      )
    } catch (err) {
      staleWriteRejected = String(err).includes('stale') || String(err).includes('changed')
    }
    recordCheck(
      'Stale review submission with outdated group signature is rejected',
      staleWriteRejected
    )

    // Close application
    cdp.close()
    cdp = null
    killTree(child)
    child = null
    await sleep(1000)

    // 9. Source Preservation Invariance Check
    // Verify using content hashes, byte sizes, creation times, and full-precision modification timestamps
    let preservationIntact = true
    for (const [filePath, initial] of initialSnapshots) {
      const baseline = filePath === file3 ? modifiedFile3Baseline : initial
      const st = statSync(filePath)
      const currentSha = sha256OfFile(filePath)
      const birthMatch =
        baseline.birthtimeMs === null ||
        typeof st.birthtimeMs !== 'number' ||
        st.birthtimeMs === baseline.birthtimeMs
      if (
        st.size !== baseline.size ||
        st.mtimeMs !== baseline.mtimeMs ||
        !birthMatch ||
        currentSha !== baseline.sha256
      ) {
        preservationIntact = false
        console.error(
          `File modified unexpectedly: ${filePath} (size: ${st.size} vs ${baseline.size}, mtime: ${st.mtimeMs} vs ${baseline.mtimeMs}, sha: ${currentSha} vs ${baseline.sha256})`
        )
      }
    }
    recordCheck(
      'Source preservation invariance: content hashes, sizes, birthtimes, and full-precision mtimes are 100% unaltered',
      preservationIntact
    )

    console.log(
      `\n=== All ${checks.length} Duplicate Review Checks Passed in Real Electron (${mode}) ===\n`
    )
    process.exit(0)
  } finally {
    if (cdp) {
      try {
        cdp.close()
      } catch (err) {
        void err
      }
    }
    if (child) {
      killTree(child)
    }
    try {
      rmSync(testUserData, { recursive: true, force: true })
      rmSync(testSources, { recursive: true, force: true })
    } catch (err) {
      void err
    }
  }
}

main().catch((err) => {
  console.error('\nVerification failed with error:', err)
  process.exit(1)
})
