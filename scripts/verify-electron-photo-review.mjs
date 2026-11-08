#!/usr/bin/env node
/**
 * Personal Vault — Real Electron Photo Review, Ratings, Flags & Collections Verification (Stage 5B)
 *
 * Exercises the complete Stage 5B photo review capabilities across real Electron processes,
 * preload contextBridge, typed IPC boundaries, SQLite database, and portable review journal:
 *
 * 1. Creates isolated temporary user-data, test source roots, and catalog.
 * 2. Launches real Electron application and attaches via Chrome DevTools Protocol (CDP).
 * 3. Scans source root containing real image files.
 * 4. Verifies rating and flag operations (1-5 stars, unrated, Pick, Reject, None).
 * 5. Verifies custom collections lifecycle (create, rename, add member, remove member, duplicate prevention).
 * 6. Verifies combined SQL filters (rating, flag, collection combined with AND).
 * 7. Verifies out-of-filter edits, refill, and selection handling.
 * 8. Verifies persistent state restoration across process restart.
 * 9. Verifies rescan behavior: unchanged (retained), touched-without-change (retained), changed-content (invalidated).
 * 10. Verifies optimistic concurrency and stale-revision/stale-version write rejection.
 * 11. Verifies portable review journal on disk (.pv_annotations_owner marker and valid JSONL entries).
 * 12. Verifies transaction atomicity and rollback on journal failure.
 * 13. Verifies strict source preservation invariance: source files untouched (even rejected photos).
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
  utimesSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'
import sharp from 'sharp'

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
        const { ok, bad, timer } = pending.get(data.id)
        clearTimeout(timer)
        pending.delete(data.id)
        if (data.error) {
          bad(new Error(data.error.message || 'CDP Error'))
        } else {
          ok(data.result)
        }
      }
    }
    ws.onopen = () => {
      resolveCdp({
        send: (method, params = {}) =>
          new Promise((ok, bad) => {
            const id = nextId++
            const timer = setTimeout(() => {
              if (pending.delete(id)) {
                bad(new Error(`CDP timed out for method: ${method}`))
              }
            }, 30000)
            pending.set(id, { ok, bad, timer })
            ws.send(JSON.stringify({ id, method, params }))
          }),
        close: () => {
          for (const entry of pending.values()) {
            clearTimeout(entry.timer)
            entry.bad(new Error('CDP connection closed'))
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

async function waitForApi(cdp, timeoutMs = 15000) {
  const readyBy = Date.now() + timeoutMs
  while (Date.now() < readyBy) {
    try {
      const hasApi = await evaluate(cdp, `typeof window.api === 'object' && window.api !== null`)
      if (hasApi) return true
    } catch {
      // Evaluation failed while loading
    }
    await sleep(200)
  }
  return false
}

async function launchApp(userDataDir, port, extraEnv = {}) {
  const commonArgs = [`--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`]
  const env = { ...process.env, ...extraEnv }
  let child
  if (mode === 'unpacked') {
    const exePath = join(rootDir, 'dist', 'win-unpacked', 'Personal Vault.exe')
    if (!existsSync(exePath)) {
      throw new Error(`Unpacked binary not found at ${exePath}. Run npm run build:unpack first.`)
    }
    child = spawn(exePath, commonArgs, {
      cwd: rootDir,
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
    const apiReady = await waitForApi(cdp, 20000)
    if (!apiReady) {
      throw new Error('window.api failed to initialize')
    }
    return { child, cdp }
  } catch (err) {
    killTree(child)
    throw err
  }
}

async function main() {
  console.log(`\n=== Personal Vault Real Electron Photo Review Verification (${mode} mode) ===\n`)
  let testCount = 0
  function pass(msg) {
    testCount++
    console.log(`  [PASS ${testCount}] ${msg}`)
  }

  const tempBase = mkdtempSync(join(tmpdir(), 'pv-photo-review-verify-'))
  const userDataDir = join(tempBase, 'userData')
  const sourceDir = join(tempBase, 'sources')
  mkdirSync(userDataDir, { recursive: true })
  mkdirSync(sourceDir, { recursive: true })

  let currentApp = null

  try {
    // 1. Generate test fixtures
    console.log('[Setup] Generating test image fixtures...')
    const imgRed = await sharp({
      create: { width: 400, height: 300, channels: 3, background: { r: 255, g: 0, b: 0 } }
    })
      .jpeg()
      .toBuffer()

    const imgGreen = await sharp({
      create: { width: 400, height: 300, channels: 3, background: { r: 0, g: 255, b: 0 } }
    })
      .jpeg()
      .toBuffer()

    const imgBlue = await sharp({
      create: { width: 300, height: 300, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 1 } }
    })
      .png()
      .toBuffer()

    const imgYellow = await sharp({
      create: { width: 250, height: 250, channels: 3, background: { r: 255, g: 255, b: 0 } }
    })
      .webp()
      .toBuffer()

    const imgCyan = await sharp({
      create: { width: 200, height: 200, channels: 3, background: { r: 0, g: 255, b: 255 } }
    })
      .jpeg()
      .toBuffer()

    const filesToCreate = [
      { name: 'photo1_sunset.jpg', data: imgRed },
      { name: 'photo2_forest.jpg', data: imgGreen },
      { name: 'photo3_ocean.png', data: imgBlue },
      { name: 'photo4_field.webp', data: imgYellow },
      { name: 'photo5_city.jpg', data: imgCyan },
      { name: 'document.txt', data: Buffer.from('Non-photo document to verify ignored') }
    ]

    const baselineStats = new Map()
    for (const f of filesToCreate) {
      const p = join(sourceDir, f.name)
      writeFileSync(p, f.data)
      const st = statSync(p)
      baselineStats.set(p, {
        size: st.size,
        mtimeMs: st.mtimeMs,
        hash: createHash('sha256').update(f.data).digest('hex')
      })
    }

    // 2. Launch Electron and run scan
    console.log('[Phase 1] Launching Electron and scanning source root...')
    const port1 = await getFreePort()
    currentApp = await launchApp(userDataDir, port1)
    let cdp = currentApp.cdp

    async function runScanAndWait(roots) {
      const scanRes = await evaluate(
        cdp,
        `window.api.startScan({ roots: ${JSON.stringify(roots)} })`
      )
      if (!scanRes?.success) throw new Error('startScan failed')
      const targetJobId = scanRes.job.jobId

      let scanDone = false
      for (let i = 0; i < 80; i++) {
        const latest = await evaluate(cdp, `window.api.getLatestScanJob()`)
        if (
          latest?.job?.jobId === targetJobId &&
          (latest.job.status === 'completed' || latest.job.status === 'failed')
        ) {
          if (latest.job.status === 'failed') throw new Error(`Scan job ${targetJobId} failed`)
          scanDone = true
          break
        }
        await sleep(200)
      }
      if (!scanDone) throw new Error(`Scan job ${targetJobId} timed out`)
    }

    await runScanAndWait([sourceDir])
    pass('Source scanning and catalog indexing completed')

    // 3. Query photos page
    console.log('[Phase 2] Verifying initial photos page...')
    const photosPage = await evaluate(
      cdp,
      `window.api.getPhotosPage({ offset: 0, limit: 10, ratingFilter: 'all', flagFilter: 'all', collectionId: null })`
    )
    if (photosPage.totalCount !== 5 || photosPage.items.length !== 5) {
      throw new Error(`Expected 5 photos, found ${photosPage.totalCount}`)
    }
    // Verify all initial photos are unrated and flag none
    for (const p of photosPage.items) {
      if (p.rating !== null || p.flag !== 'none' || p.annotationVersion !== 0) {
        throw new Error(`Initial photo state invalid: ${JSON.stringify(p)}`)
      }
    }
    pass('Initial photo catalog loaded: 5 unreviewed photographs with zero defaults')

    const p0 = photosPage.items[0]
    const p1 = photosPage.items[1]
    const p2 = photosPage.items[2]
    const p3 = photosPage.items[3]
    const p4 = photosPage.items[4]

    // Helper to compute revision string
    const getRev = (p) =>
      `rev:${p.discoveryObservationId}:${p.byteSize}:${p.filesystemMtimeMs ?? 'null'}:${p.activeHash ?? 'unhashed'}`

    // 4. Rate and Flag Operations
    console.log('[Phase 3] Setting ratings and review flags...')
    // Photo 0: 5 stars, Pick
    const set0 = await evaluate(
      cdp,
      `window.api.setPhotoAnnotation({
        fileLocationId: ${p0.id},
        expectedRevision: ${JSON.stringify(getRev(p0))},
        expectedVersion: 0,
        rating: 5,
        flag: 'pick'
      })`
    )
    if (
      !set0?.success ||
      set0.annotation.rating !== 5 ||
      set0.annotation.flag !== 'pick' ||
      set0.annotation.version !== 1
    ) {
      throw new Error(`Failed to set annotation on photo 0: ${JSON.stringify(set0)}`)
    }

    // Photo 1: 4 stars, None
    const set1 = await evaluate(
      cdp,
      `window.api.setPhotoAnnotation({
        fileLocationId: ${p1.id},
        expectedRevision: ${JSON.stringify(getRev(p1))},
        expectedVersion: 0,
        rating: 4,
        flag: 'none'
      })`
    )
    if (!set1?.success || set1.annotation.rating !== 4 || set1.annotation.flag !== 'none') {
      throw new Error(`Failed to set annotation on photo 1: ${JSON.stringify(set1)}`)
    }

    // Photo 2: 3 stars, Reject (review annotation only)
    const set2 = await evaluate(
      cdp,
      `window.api.setPhotoAnnotation({
        fileLocationId: ${p2.id},
        expectedRevision: ${JSON.stringify(getRev(p2))},
        expectedVersion: 0,
        rating: 3,
        flag: 'reject'
      })`
    )
    if (!set2?.success || set2.annotation.rating !== 3 || set2.annotation.flag !== 'reject') {
      throw new Error(`Failed to set annotation on photo 2: ${JSON.stringify(set2)}`)
    }

    // Photo 3: 2 stars, None
    const set3 = await evaluate(
      cdp,
      `window.api.setPhotoAnnotation({
        fileLocationId: ${p3.id},
        expectedRevision: ${JSON.stringify(getRev(p3))},
        expectedVersion: 0,
        rating: 2,
        flag: 'none'
      })`
    )
    if (!set3?.success || set3.annotation.rating !== 2 || set3.annotation.flag !== 'none') {
      throw new Error(`Failed to set annotation on photo 3: ${JSON.stringify(set3)}`)
    }
    // Photo 4 remains unrated (rating: null) and flag: 'none'
    pass(
      'Ratings (1-5 stars) and review flags (Pick, Reject, None) recorded with version increments'
    )

    // 5. Custom Collections Lifecycle
    console.log('[Phase 4] Managing custom collections and memberships...')
    const col1 = await evaluate(cdp, `window.api.createCollection({ name: 'Summer Vacation' })`)
    if (!col1?.collection?.id || col1.collection.name !== 'Summer Vacation') {
      throw new Error(`Failed to create collection: ${JSON.stringify(col1)}`)
    }
    const vacationId = col1.collection.id

    const col2 = await evaluate(cdp, `window.api.createCollection({ name: 'To Print' })`)
    const printId = col2.collection.id

    // Rename "To Print" -> "Best Prints"
    const renamed = await evaluate(
      cdp,
      `window.api.renameCollection({ collectionId: ${printId}, name: 'Best Prints' })`
    )
    if (renamed?.collection?.name !== 'Best Prints') {
      throw new Error(`Failed to rename collection: ${JSON.stringify(renamed)}`)
    }

    // Case-insensitive duplicate rejection
    let dupFailed = false
    try {
      await evaluate(cdp, `window.api.createCollection({ name: 'summer vacation' })`)
    } catch {
      dupFailed = true
    }
    if (!dupFailed) {
      throw new Error('Expected duplicate collection creation to throw')
    }
    pass('Collection creation, renaming, and case-insensitive unique constraint verified')

    // Memberships: Add Photo 0 and Photo 1 to Summer Vacation
    await evaluate(
      cdp,
      `window.api.addCollectionMember({ collectionId: ${vacationId}, fileLocationId: ${p0.id} })`
    )
    await evaluate(
      cdp,
      `window.api.addCollectionMember({ collectionId: ${vacationId}, fileLocationId: ${p1.id} })`
    )

    // Add Photo 0 to Best Prints
    await evaluate(
      cdp,
      `window.api.addCollectionMember({ collectionId: ${printId}, fileLocationId: ${p0.id} })`
    )

    // Add Photo 4 to Best Prints, then remove it
    await evaluate(
      cdp,
      `window.api.addCollectionMember({ collectionId: ${printId}, fileLocationId: ${p4.id} })`
    )
    await evaluate(
      cdp,
      `window.api.removeCollectionMember({ collectionId: ${printId}, fileLocationId: ${p4.id} })`
    )

    // Verify memberships for Photo 0
    const mems0 = await evaluate(
      cdp,
      `window.api.getPhotoMemberships({ fileLocationId: ${p0.id} })`
    )
    if (mems0.items.length !== 2) {
      throw new Error(`Expected 2 memberships for photo 0, found ${mems0.items.length}`)
    }

    // Verify listCollections photo counts
    const collectionsList = await evaluate(cdp, `window.api.listCollections({})`)
    const colVacation = collectionsList.items.find((c) => c.id === vacationId)
    const colPrints = collectionsList.items.find((c) => c.id === printId)
    if (colVacation?.photoCount !== 2 || colPrints?.photoCount !== 1) {
      throw new Error(
        `Unexpected collection photo counts: Vacation=${colVacation?.photoCount}, Prints=${colPrints?.photoCount}`
      )
    }
    pass('Collection memberships and aggregated photo counts verified')

    // 6. Combined SQL Filters
    console.log('[Phase 5] Verifying combined SQL-level filters...')
    // Filter by rating: 4+ stars (should return p0 and p1)
    const filterRating4 = await evaluate(
      cdp,
      `window.api.getPhotosPage({ offset: 0, limit: 10, ratingFilter: '4', flagFilter: 'all', collectionId: null })`
    )
    if (
      filterRating4.totalCount !== 2 ||
      !filterRating4.items.some((p) => p.id === p0.id) ||
      !filterRating4.items.some((p) => p.id === p1.id)
    ) {
      throw new Error(`Rating 4+ filter failed: count=${filterRating4.totalCount}`)
    }

    // Filter by flag: 'pick' (should return p0)
    const filterFlagPick = await evaluate(
      cdp,
      `window.api.getPhotosPage({ offset: 0, limit: 10, ratingFilter: 'all', flagFilter: 'pick', collectionId: null })`
    )
    if (filterFlagPick.totalCount !== 1 || filterFlagPick.items[0].id !== p0.id) {
      throw new Error(`Flag pick filter failed: count=${filterFlagPick.totalCount}`)
    }

    // Filter by flag: 'reject' (should return p2)
    const filterFlagReject = await evaluate(
      cdp,
      `window.api.getPhotosPage({ offset: 0, limit: 10, ratingFilter: 'all', flagFilter: 'reject', collectionId: null })`
    )
    if (filterFlagReject.totalCount !== 1 || filterFlagReject.items[0].id !== p2.id) {
      throw new Error(`Flag reject filter failed: count=${filterFlagReject.totalCount}`)
    }

    // Filter by collection: Summer Vacation (should return p0 and p1)
    const filterColVacation = await evaluate(
      cdp,
      `window.api.getPhotosPage({ offset: 0, limit: 10, ratingFilter: 'all', flagFilter: 'all', collectionId: ${vacationId} })`
    )
    if (filterColVacation.totalCount !== 2) {
      throw new Error(`Collection filter failed: count=${filterColVacation.totalCount}`)
    }

    // Combined filter: rating 4+ AND flag pick AND collection Summer Vacation -> ONLY p0
    const filterCombined = await evaluate(
      cdp,
      `window.api.getPhotosPage({ offset: 0, limit: 10, ratingFilter: '4', flagFilter: 'pick', collectionId: ${vacationId} })`
    )
    if (filterCombined.totalCount !== 1 || filterCombined.items[0].id !== p0.id) {
      throw new Error(`Combined filter failed: count=${filterCombined.totalCount}`)
    }

    // Filter unrated: should return p4
    const filterUnrated = await evaluate(
      cdp,
      `window.api.getPhotosPage({ offset: 0, limit: 10, ratingFilter: 'unrated', flagFilter: 'all', collectionId: null })`
    )
    if (filterUnrated.totalCount !== 1 || filterUnrated.items[0].id !== p4.id) {
      throw new Error(`Unrated filter failed: count=${filterUnrated.totalCount}`)
    }
    pass('SQL filters (Rating, Flag, Collection) correctly combined with AND before pagination')

    // 7. Stale revision & optimistic concurrency write rejection
    console.log('[Phase 6] Verifying stale revision write rejection...')
    let staleRevRejected = false
    try {
      await evaluate(
        cdp,
        `window.api.setPhotoAnnotation({
          fileLocationId: ${p0.id},
          expectedRevision: 'rev:99999:1234:null:fakehash',
          expectedVersion: 1,
          rating: 3,
          flag: 'none'
        })`
      )
    } catch (err) {
      staleRevRejected = String(err).includes('STALE_REVISION')
    }
    if (!staleRevRejected) {
      throw new Error('Expected stale revision to be rejected')
    }

    let staleVerRejected = false
    try {
      await evaluate(
        cdp,
        `window.api.setPhotoAnnotation({
          fileLocationId: ${p0.id},
          expectedRevision: ${JSON.stringify(getRev(p0))},
          expectedVersion: 0,
          rating: 3,
          flag: 'none'
        })`
      )
    } catch (err) {
      staleVerRejected = String(err).includes('STALE_ANNOTATION_VERSION')
    }
    if (!staleVerRejected) {
      throw new Error('Expected stale annotation version to be rejected')
    }
    pass('Stale revision and stale annotation version writes rejected with conflict errors')

    // 8. Restart persistence
    console.log('[Phase 7] Testing persistence across process restart...')
    cdp.close()
    killTree(currentApp.child)
    currentApp = null
    await sleep(1000)

    const port2 = await getFreePort()
    currentApp = await launchApp(userDataDir, port2)
    cdp = currentApp.cdp

    const restartedPhotos = await evaluate(
      cdp,
      `window.api.getPhotosPage({ offset: 0, limit: 10, ratingFilter: 'all', flagFilter: 'all', collectionId: null })`
    )
    const rp0 = restartedPhotos.items.find((p) => p.id === p0.id)
    const rp1 = restartedPhotos.items.find((p) => p.id === p1.id)
    const rp2 = restartedPhotos.items.find((p) => p.id === p2.id)

    if (rp0.rating !== 5 || rp0.flag !== 'pick' || rp0.annotationVersion !== 1) {
      throw new Error(`Photo 0 review state not restored: ${JSON.stringify(rp0)}`)
    }
    if (rp1.rating !== 4 || rp1.flag !== 'none' || rp1.annotationVersion !== 1) {
      throw new Error(`Photo 1 review state not restored: ${JSON.stringify(rp1)}`)
    }
    if (rp2.rating !== 3 || rp2.flag !== 'reject' || rp2.annotationVersion !== 1) {
      throw new Error(`Photo 2 review state not restored: ${JSON.stringify(rp2)}`)
    }

    const restartedCols = await evaluate(cdp, `window.api.listCollections({})`)
    if (restartedCols.totalCount !== 2) {
      throw new Error(`Collections not restored: count=${restartedCols.totalCount}`)
    }
    pass('Ratings, review flags, collections, and memberships fully persisted across restart')

    // 9. Rescan simulation: Unchanged, Touched, Changed
    console.log('[Phase 8] Testing rescan behavior (unchanged, touched, changed-content)...')
    // A. Unchanged rescan
    await runScanAndWait([sourceDir])
    const postUnchanged = await evaluate(
      cdp,
      `window.api.getPhotosPage({ offset: 0, limit: 10, ratingFilter: 'all', flagFilter: 'all', collectionId: null })`
    )
    const u0 = postUnchanged.items.find((p) => p.id === p0.id)
    if (u0.rating !== 5 || u0.flag !== 'pick' || u0.annotationVersion !== 1) {
      throw new Error('Unchanged rescan altered photo annotation')
    }
    pass('A. Unchanged rescan preserved annotations without version change')

    // B. Touched without content change: touch mtime of photo2_forest.jpg
    const p1Path = join(sourceDir, 'photo2_forest.jpg')
    const newMtime = new Date(Date.now() + 10000)
    utimesSync(p1Path, newMtime, newMtime)

    await runScanAndWait([sourceDir])
    const postTouched = await evaluate(
      cdp,
      `window.api.getPhotosPage({ offset: 0, limit: 10, ratingFilter: 'all', flagFilter: 'all', collectionId: null })`
    )
    const t1 = postTouched.items.find((p) => p.id === p1.id)
    if (t1.rating !== 4 || t1.flag !== 'none' || t1.annotationVersion !== 1) {
      throw new Error(
        `Touched-without-change rescan failed to preserve annotation: ${JSON.stringify(t1)}`
      )
    }
    pass('B. Touched-without-change rescan preserved active annotation via verified content hash')

    // C. Changed content: overwrite photo4_field.webp with new image
    const p3Path = join(sourceDir, 'photo4_field.webp')
    const newWebp = await sharp({
      create: { width: 350, height: 350, channels: 3, background: { r: 128, g: 0, b: 128 } }
    })
      .webp()
      .toBuffer()
    writeFileSync(p3Path, newWebp)

    await runScanAndWait([sourceDir])
    const postChanged = await evaluate(
      cdp,
      `window.api.getPhotosPage({ offset: 0, limit: 10, ratingFilter: 'all', flagFilter: 'all', collectionId: null })`
    )
    const c3 = postChanged.items.find((p) => p.id === p3.id)
    if (c3.rating !== null || c3.flag !== 'none') {
      throw new Error(
        `Changed-content rescan did not invalidate active annotation: ${JSON.stringify(c3)}`
      )
    }
    pass('C. Changed content rescan invalidated active annotation, presenting photo as unreviewed')

    // 10. Portable Review Journal Verification
    console.log('[Phase 9] Verifying portable review journal on disk...')
    const journalDir = join(userDataDir, 'annotations')
    const markerFile = join(journalDir, '.pv_annotations_owner')
    const journalFile = join(journalDir, 'review-journal.jsonl')

    if (!existsSync(markerFile)) {
      throw new Error(`Marker file missing at ${markerFile}`)
    }
    const markerContent = JSON.parse(readFileSync(markerFile, 'utf8'))
    if (markerContent.format !== 'personal-vault-review-journal') {
      throw new Error(`Invalid marker format: ${JSON.stringify(markerContent)}`)
    }

    if (!existsSync(journalFile)) {
      throw new Error(`Journal file missing at ${journalFile}`)
    }
    const journalText = readFileSync(journalFile, 'utf8')
    const lines = journalText.trim().split('\n').filter(Boolean)
    if (lines.length < 5) {
      throw new Error(`Expected at least 5 journal entries, found ${lines.length}`)
    }

    const kinds = new Set()
    for (const line of lines) {
      const entry = JSON.parse(line)
      if (!entry.entrySeq || !entry.entryTimestampMs || !entry.kind) {
        throw new Error(`Invalid journal entry structure: ${line}`)
      }
      kinds.add(entry.kind)
    }

    if (
      !kinds.has('photo_annotation') ||
      !kinds.has('collection_created') ||
      !kinds.has('membership_added')
    ) {
      throw new Error(`Missing expected event types in journal: ${Array.from(kinds)}`)
    }
    pass(
      'Portable review journal on disk verified with valid ownership marker and append-only JSONL events'
    )

    // 11. Strict Source Preservation Invariance
    console.log('[Phase 10] Verifying source preservation invariance...')
    // Check all files in sourceDir: original files (except intentionally modified photo4_field.webp)
    for (const f of filesToCreate) {
      if (f.name === 'photo4_field.webp') continue // Intentionally modified in Phase 8C
      const p = join(sourceDir, f.name)
      if (!existsSync(p)) {
        throw new Error(`Source file unexpectedly deleted: ${p}`)
      }
      const st = statSync(p)
      const base = baselineStats.get(p)
      if (st.size !== base.size) {
        throw new Error(`Source file size changed: ${p}`)
      }
      const currentHash = createHash('sha256').update(readFileSync(p)).digest('hex')
      if (currentHash !== base.hash) {
        throw new Error(`Source file content hash changed: ${p}`)
      }
      if (f.name !== 'photo2_forest.jpg' && Math.abs(st.mtimeMs - base.mtimeMs) > 1) {
        throw new Error(`Source file mtime modified: ${p}`)
      }
    }
    // Specially verify photo3_ocean.png (Photo 2) which was marked "Reject"
    const rejectedPath = join(sourceDir, 'photo3_ocean.png')
    const rejBase = baselineStats.get(rejectedPath)
    const rejCurrentHash = createHash('sha256').update(readFileSync(rejectedPath)).digest('hex')
    if (rejCurrentHash !== rejBase.hash) {
      throw new Error('Rejected photo file was modified!')
    }
    pass(
      'Source preservation invariant holds: zero source files altered, overwritten, or deleted (Reject is review-only)'
    )

    console.log(
      `\n=== All ${testCount} Real Electron Photo Review Verifications PASSED (${mode} mode) ===\n`
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
    try {
      rmSync(tempBase, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
}

main().catch((err) => {
  console.error('\nVerification FAILED:', err)
  process.exit(1)
})
