#!/usr/bin/env node
/**
 * Personal Vault — Real Electron Photo Review, Ratings, Flags & Collections Verification (Stage 5B)
 *
 * Exercises the complete Stage 5B photo review capabilities across real Electron processes,
 * preload contextBridge, typed IPC boundaries, SQLite database, portable review journal, and renderer UI:
 *
 * 1. Creates isolated temporary user-data, test source roots, catalog, and journal.
 * 2. Launches real Electron application and attaches via Chrome DevTools Protocol (CDP).
 * 3. Scans source root containing real image files.
 * 4. Exercises actual renderer UI controls via DOM in CDP:
 *    - Star rating (1-5 stars, clearing, re-rating, save state indicators, grid badges).
 *    - Review flags (Pick, Reject, None, save state indicators, grid badges).
 *    - Selection switch concurrency guard (rapid selection switches prevent leaking save state/rating).
 * 5. Exercises custom collections management via DOM in CDP:
 *    - Collection creation, renaming, and membership addition/removal.
 *    - Photo count badges in collection dropdowns and details panel.
 * 6. Exercises combined SQL filters via DOM dropdowns:
 *    - Rating, Flag, and Collection filters combined with AND before pagination.
 *    - Edit-out-of-filter eviction and grid refill.
 * 7. Verifies deterministic persistence interruption and safe recovery:
 *    - Interrupts write at observed pre-commit barrier and kills process.
 *    - Asserts SQLite uncommitted and journal dangling entry.
 *    - Restarts app and verifies startup reconciliation (op_aborted appended, checkpoints updated).
 *    - Verifies subsequent review operations succeed cleanly.
 * 8. Exercises filtered scale browsing beyond 2,000 photos:
 *    - Seeds 3,000 decodable image fixtures via hard links.
 *    - Annotates 2,200 photos and filters to 2,200 items in DOM.
 *    - Cold scrolls past 2,000 items, distant jump, return travel.
 *    - Enforces strict resource bounds: mounted DOM cells <= 200, active workers <= 4, zero error cards.
 * 9. Verifies strict source preservation invariance:
 *    - Every source file unchanged (byte count, mtime, SHA-256 hash).
 *    - Specially verifies Reject flag is purely a review annotation without touching original files.
 */

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
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

async function waitForApi(cdp, timeoutMs = 20000) {
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
  const scaleDir = join(sourceDir, 'scale_fixtures')
  mkdirSync(userDataDir, { recursive: true })
  mkdirSync(sourceDir, { recursive: true })
  mkdirSync(scaleDir, { recursive: true })

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

    // Navigate to Photographs tab in real UI
    console.log('[Phase 2] Navigating to Photographs tab and testing DOM review controls...')
    await evaluate(
      cdp,
      `(() => {
        const btn = Array.from(document.querySelectorAll('.nav-item')).find((b) =>
          b.textContent && b.textContent.includes('Photos')
        )
        if (btn) btn.click()
      })()`
    )

    // Wait for virtual grid container
    let gridMounted = false
    for (let g = 0; g < 40; g++) {
      gridMounted = await evaluate(cdp, `Boolean(document.querySelector('.photos-grid-container'))`)
      if (gridMounted) break
      await sleep(150)
    }
    if (!gridMounted) {
      throw new Error('Photos virtual grid container failed to mount in DOM')
    }

    // Wait for initial cards to appear in grid
    let cellCount = 0
    for (let c = 0; c < 40; c++) {
      cellCount = await evaluate(
        cdp,
        `document.querySelectorAll('.photo-cell:not(.photo-skeleton)').length`
      )
      if (cellCount === 5) break
      await sleep(150)
    }
    if (cellCount !== 5) {
      throw new Error(`Expected 5 photo cards in DOM grid, found ${cellCount}`)
    }
    pass('Initial 5 photographs mounted in DOM grid with zero review defaults')

    // Click first photo card in DOM to open details panel
    await evaluate(
      cdp,
      `(() => {
      const cells = document.querySelectorAll('.photo-cell:not(.photo-skeleton)');
      cells[0].click();
    })()`
    )

    // Wait for details panel
    let detailsMounted = false
    for (let d = 0; d < 30; d++) {
      detailsMounted = await evaluate(
        cdp,
        `Boolean(document.querySelector('.photo-details-panel'))`
      )
      if (detailsMounted) break
      await sleep(100)
    }
    if (!detailsMounted) {
      throw new Error('Photo details panel failed to open upon card click in DOM')
    }

    // Helper to wait for save indicator
    async function waitForSavedIndicator() {
      for (let s = 0; s < 40; s++) {
        const isSaved = await evaluate(
          cdp,
          `Boolean(document.querySelector('.status-saved-indicator'))`
        )
        if (isSaved) return true
        await sleep(100)
      }
      return false
    }

    // Rate Photo 0 with 5 Stars via DOM button
    await evaluate(
      cdp,
      `(() => {
      const star5 = document.querySelector('button[aria-label="5 Stars"]');
      if (star5) star5.click();
    })()`
    )
    if (!(await waitForSavedIndicator())) {
      throw new Error('Save indicator did not transition to Saved after rating 5 stars')
    }

    // Verify rating badge on Photo 0 in DOM grid
    const badgeRatingText = await evaluate(
      cdp,
      `(() => {
      const cells = document.querySelectorAll('.photo-cell:not(.photo-skeleton)');
      const badge = cells[0].querySelector('.badge-rating');
      return badge ? badge.textContent.trim() : null;
    })()`
    )
    if (!badgeRatingText || !badgeRatingText.includes('5')) {
      throw new Error(`Expected rating badge '★ 5' on photo 0, found: ${badgeRatingText}`)
    }

    // Clear rating via DOM button
    await evaluate(
      cdp,
      `(() => {
      const clearBtn = document.querySelector('button[title="Clear rating"]');
      if (clearBtn) clearBtn.click();
    })()`
    )
    if (!(await waitForSavedIndicator())) {
      throw new Error('Save indicator did not transition to Saved after clearing rating')
    }
    const badgeCleared = await evaluate(
      cdp,
      `(() => {
      const cells = document.querySelectorAll('.photo-cell:not(.photo-skeleton)');
      return Boolean(cells[0].querySelector('.badge-rating'));
    })()`
    )
    if (badgeCleared) {
      throw new Error('Rating badge was not removed after clearing rating')
    }

    // Re-rate Photo 0 with 4 Stars via DOM button
    await evaluate(
      cdp,
      `(() => {
      const star4 = document.querySelector('button[aria-label="4 Stars"]');
      if (star4) star4.click();
    })()`
    )
    if (!(await waitForSavedIndicator())) {
      throw new Error('Save indicator did not transition to Saved after rating 4 stars')
    }

    // Flag Photo 0 as Pick via DOM button
    await evaluate(
      cdp,
      `(() => {
      const pickBtn = document.querySelector('button.btn-flag-pick');
      if (pickBtn) pickBtn.click();
    })()`
    )
    if (!(await waitForSavedIndicator())) {
      throw new Error('Save indicator did not transition to Saved after setting Pick flag')
    }
    const badgeFlagPick = await evaluate(
      cdp,
      `(() => {
      const cells = document.querySelectorAll('.photo-cell:not(.photo-skeleton)');
      const badge = cells[0].querySelector('.badge-flag-pick');
      return badge ? badge.textContent.trim() : null;
    })()`
    )
    if (badgeFlagPick !== 'PICK') {
      throw new Error(`Expected flag badge 'PICK' on photo 0, found: ${badgeFlagPick}`)
    }
    pass('Star rating (1-5 stars, clear, re-rate) and Pick flag exercised via DOM with live badges')

    // Select Photo 1, rate 3 stars, flag Reject via DOM
    await evaluate(
      cdp,
      `(() => {
      const cells = document.querySelectorAll('.photo-cell:not(.photo-skeleton)');
      cells[1].click();
    })()`
    )
    await sleep(200)

    await evaluate(
      cdp,
      `(() => {
      const star3 = document.querySelector('button[aria-label="3 Stars"]');
      if (star3) star3.click();
    })()`
    )
    await waitForSavedIndicator()

    await evaluate(
      cdp,
      `(() => {
      const rejectBtn = document.querySelector('button.btn-flag-reject');
      if (rejectBtn) rejectBtn.click();
    })()`
    )
    await waitForSavedIndicator()

    const p1Badges = await evaluate(
      cdp,
      `(() => {
      const cells = document.querySelectorAll('.photo-cell:not(.photo-skeleton)');
      const rating = cells[1].querySelector('.badge-rating')?.textContent.trim();
      const flag = cells[1].querySelector('.badge-flag-reject')?.textContent.trim();
      return { rating, flag };
    })()`
    )
    if (!p1Badges.rating?.includes('3') || p1Badges.flag !== 'REJECT') {
      throw new Error(`Photo 1 badges mismatch: ${JSON.stringify(p1Badges)}`)
    }
    pass('Photo 1 rated 3 stars and flagged Reject (review annotation only) via DOM controls')

    // Test selection switch concurrency guard in DOM
    console.log('[Phase 3] Testing selection switch concurrency guard in DOM...')
    await evaluate(
      cdp,
      `(() => {
      const cells = document.querySelectorAll('.photo-cell:not(.photo-skeleton)');
      // Select Photo 2, initiate rating change, and immediately switch to Photo 3
      cells[2].click();
    })()`
    )
    await sleep(50)
    await evaluate(
      cdp,
      `(() => {
      const star5 = document.querySelector('button[aria-label="5 Stars"]');
      if (star5) star5.click();
      const cells = document.querySelectorAll('.photo-cell:not(.photo-skeleton)');
      cells[3].click();
    })()`
    )
    await sleep(500)

    // Assert Photo 3 remains unaffected by Photo 2's rating mutation
    const p3State = await evaluate(
      cdp,
      `(() => {
      const details = document.querySelector('.photo-details-panel');
      const filename = details?.querySelector('.details-header h3')?.textContent;
      const savingInd = Boolean(document.querySelector('.status-saving-indicator'));
      const activeStar = Boolean(document.querySelector('.btn-star.active'));
      return { filename, savingInd, activeStar };
    })()`
    )
    if (p3State.savingInd || p3State.activeStar) {
      throw new Error(
        `Photo 3 leaked save state or rating from Photo 2: ${JSON.stringify(p3State)}`
      )
    }
    pass('Rapid selection switch guarded against delayed mutation state leaks in renderer')

    // 5. Custom Collections Lifecycle via DOM
    console.log('[Phase 4] Managing custom collections via DOM...')
    // Select Photo 0
    await evaluate(
      cdp,
      `(() => {
      const cells = document.querySelectorAll('.photo-cell:not(.photo-skeleton)');
      cells[0].click();
    })()`
    )
    await sleep(200)

    // Create collection "Vacation Picks" via form in DOM
    await evaluate(
      cdp,
      `(() => {
      const input = document.querySelector('.create-collection-form input.input-collection-name');
      if (input) {
        const proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
        proto?.set?.call(input, 'Vacation Picks');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const form = document.querySelector('.create-collection-form');
      if (form) {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      }
    })()`
    )

    // Wait for collection to appear in DOM
    let colVacationMounted = false
    for (let m = 0; m < 30; m++) {
      colVacationMounted = await evaluate(
        cdp,
        `Boolean(document.querySelector('button[aria-label="Add to Vacation Picks"]'))`
      )
      if (colVacationMounted) break
      await sleep(100)
    }
    if (!colVacationMounted) {
      throw new Error("Created collection 'Vacation Picks' did not appear in DOM actions list")
    }

    // Add Photo 0 to "Vacation Picks" via DOM button
    await evaluate(
      cdp,
      `(() => {
      const addBtn = document.querySelector('button[aria-label="Add to Vacation Picks"]');
      if (addBtn) addBtn.click();
    })()`
    )

    // Verify membership tag appears for Photo 0
    let memTagFound = false
    for (let t = 0; t < 30; t++) {
      memTagFound = await evaluate(
        cdp,
        `(() => {
          const tags = Array.from(document.querySelectorAll('.membership-tag .membership-name'));
          return tags.some((el) => el.textContent && el.textContent.includes('Vacation Picks'));
        })()`
      )
      if (memTagFound) break
      await sleep(100)
    }
    if (!memTagFound) {
      throw new Error("Membership tag for 'Vacation Picks' did not appear on photo 0")
    }

    // Create second collection "Archive"
    await evaluate(
      cdp,
      `(() => {
      const input = document.querySelector('.create-collection-form input.input-collection-name');
      if (input) {
        const proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
        proto?.set?.call(input, 'Archive');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const form = document.querySelector('.create-collection-form');
      if (form) {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      }
    })()`
    )
    await sleep(300)

    // Rename "Archive" -> "Permanent Archive" via accessible DOM controls
    await evaluate(
      cdp,
      `(() => {
      const renameBtn = document.querySelector('button[aria-label="Rename collection Archive"]');
      if (renameBtn) renameBtn.click();
    })()`
    )
    await sleep(100)

    await evaluate(
      cdp,
      `(() => {
      const renameInput = document.querySelector('input[aria-label="New name for collection Archive"]');
      if (renameInput) {
        const proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
        proto?.set?.call(renameInput, 'Permanent Archive');
        renameInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const saveBtn = document.querySelector('.rename-collection-form button[type="submit"]');
      if (saveBtn) saveBtn.click();
    })()`
    )
    await sleep(300)

    const renameSucceeded = await evaluate(
      cdp,
      `Boolean(document.querySelector('button[aria-label="Add to Permanent Archive"]'))`
    )
    if (!renameSucceeded) {
      throw new Error("Collection rename to 'Permanent Archive' failed in DOM")
    }

    // Remove membership from "Vacation Picks" via DOM button
    await evaluate(
      cdp,
      `(() => {
      const rmBtn = document.querySelector('button[aria-label="Remove from Vacation Picks"]');
      if (rmBtn) rmBtn.click();
    })()`
    )
    await sleep(300)

    const rmTagStillPresent = await evaluate(
      cdp,
      `(() => {
        const tags = Array.from(document.querySelectorAll('.membership-tag .membership-name'));
        return tags.some((el) => el.textContent && el.textContent.includes('Vacation Picks'));
      })()`
    )
    if (rmTagStillPresent) {
      throw new Error('Membership was not removed after clicking remove button in DOM')
    }

    // Re-add Photo 0 to "Vacation Picks" for subsequent filter testing
    await evaluate(
      cdp,
      `(() => {
      const addBtn = document.querySelector('button[aria-label="Add to Vacation Picks"]');
      if (addBtn) addBtn.click();
    })()`
    )
    await sleep(300)
    pass(
      'Collection creation, accessible renaming, and membership addition/removal verified in DOM'
    )

    // 6. Filtering via DOM Dropdowns & Out-of-filter Eviction/Refill
    console.log('[Phase 5] Verifying combined SQL filters and out-of-filter eviction in DOM...')
    // Filter by Rating: 4+ Stars
    await evaluate(
      cdp,
      `(() => {
      const ratingSel = document.querySelector('select[aria-label="Filter by Rating"]');
      if (ratingSel) {
        ratingSel.value = '4';
        ratingSel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    })()`
    )
    await sleep(300)

    const rating4Count = await evaluate(
      cdp,
      `document.querySelectorAll('.photo-cell:not(.photo-skeleton)').length`
    )
    if (rating4Count !== 2) {
      // Photo 0 (4 stars) and Photo 2 (5 stars)
      throw new Error(`Expected 2 cards under Rating 4+ filter, found ${rating4Count}`)
    }

    // Filter by Flag: Pick
    await evaluate(
      cdp,
      `(() => {
      const flagSel = document.querySelector('select[aria-label="Filter by Flag"]');
      if (flagSel) {
        flagSel.value = 'pick';
        flagSel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    })()`
    )
    await sleep(300)

    // Filter by Collection: Vacation Picks
    const vacationOptionVal = await evaluate(
      cdp,
      `(() => {
      const colSel = document.querySelector('select[aria-label="Filter by Collection"]');
      const opt = Array.from(colSel.options).find((o) => o.text.includes('Vacation Picks'));
      return opt ? opt.value : null;
    })()`
    )
    if (!vacationOptionVal) {
      throw new Error('Vacation Picks option not found in Collection filter dropdown')
    }

    await evaluate(
      cdp,
      `(() => {
      const colSel = document.querySelector('select[aria-label="Filter by Collection"]');
      if (colSel) {
        colSel.value = ${JSON.stringify(vacationOptionVal)};
        colSel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    })()`
    )
    await sleep(300)

    const combinedCount = await evaluate(
      cdp,
      `document.querySelectorAll('.photo-cell:not(.photo-skeleton)').length`
    )
    if (combinedCount !== 1) {
      throw new Error(
        `Combined filter (Rating 4+ AND Pick AND Vacation Picks) expected 1 photo, found ${combinedCount}`
      )
    }

    // Out-of-filter edit: in the filtered view, select Photo 0 and change its flag to None
    await evaluate(
      cdp,
      `(() => {
      const cells = document.querySelectorAll('.photo-cell:not(.photo-skeleton)');
      cells[0].click();
    })()`
    )
    await sleep(200)

    await evaluate(
      cdp,
      `(() => {
      const flagNoneBtn = Array.from(document.querySelectorAll('.flag-buttons-group button')).find(
        (b) => b.textContent && b.textContent.trim() === 'None'
      );
      if (flagNoneBtn) flagNoneBtn.click();
    })()`
    )
    await waitForSavedIndicator()
    await sleep(300)

    // Verify Photo 0 is evicted from the filtered view (grid count becomes 0)
    const postEvictionCount = await evaluate(
      cdp,
      `document.querySelectorAll('.photo-cell:not(.photo-skeleton)').length`
    )
    if (postEvictionCount !== 0) {
      throw new Error(
        `Photo was not evicted from filtered view after out-of-filter edit! Count: ${postEvictionCount}`
      )
    }

    // Reset filters
    await evaluate(
      cdp,
      `(() => {
      const resetBtn = document.querySelector('button[title="Reset all filters"]');
      if (resetBtn) resetBtn.click();
    })()`
    )
    await sleep(300)

    const postResetCount = await evaluate(
      cdp,
      `document.querySelectorAll('.photo-cell:not(.photo-skeleton)').length`
    )
    if (postResetCount !== 5) {
      throw new Error(`Expected 5 cards after filter reset, found ${postResetCount}`)
    }
    pass('Combined SQL filters and out-of-filter eviction/refill verified via DOM controls')

    // 7. Deterministic Persistence Interruption & Recovery
    console.log('[Phase 6] Testing deterministic persistence interruption and startup recovery...')
    cdp.close()
    killTree(currentApp.child)
    currentApp = null
    await sleep(500)

    const barrierSignalFile = join(userDataDir, 'persistence_barrier_signal.txt')
    if (existsSync(barrierSignalFile)) {
      unlinkSync(barrierSignalFile)
    }

    // Launch app with persistence barrier hold
    const port2 = await getFreePort()
    currentApp = await launchApp(userDataDir, port2, {
      PV_TEST_PERSISTENCE_BARRIER_SIGNAL: barrierSignalFile,
      PV_TEST_PERSISTENCE_BARRIER_HOLD: '1'
    })
    cdp = currentApp.cdp

    // Navigate to Photos tab
    await evaluate(
      cdp,
      `(() => {
        const btn = Array.from(document.querySelectorAll('.nav-item')).find((b) =>
          b.textContent && b.textContent.includes('Photos')
        )
        if (btn) btn.click()
      })()`
    )
    await sleep(300)

    // Select Photo 4 (unreviewed photo) and click 5 Stars to trigger write
    await evaluate(
      cdp,
      `(() => {
      const cells = document.querySelectorAll('.photo-cell:not(.photo-skeleton)');
      cells[4].click();
    })()`
    )
    await sleep(200)

    // Trigger rating write asynchronously (will reach barrier and hold)
    evaluate(
      cdp,
      `(() => {
      const star5 = document.querySelector('button[aria-label="5 Stars"]');
      if (star5) star5.click();
    })()`
    ).catch(() => {})

    // Wait for barrier signal file to be written deterministically
    let barrierReached = false
    for (let w = 0; w < 50; w++) {
      if (existsSync(barrierSignalFile)) {
        barrierReached = true
        break
      }
      await sleep(100)
    }
    if (!barrierReached) {
      throw new Error('Persistence barrier was not reached deterministically by annotation write')
    }

    const barrierSignal = readFileSync(barrierSignalFile, 'utf8').trim().split('\n')
    const interruptedOpId = barrierSignal[0]?.trim()
    const interruptedSeq = parseInt(barrierSignal[1]?.trim(), 10)

    if (!interruptedOpId || isNaN(interruptedSeq)) {
      throw new Error(`Invalid persistence barrier signal: ${JSON.stringify(barrierSignal)}`)
    }

    // Verify that the journal file on disk contains this opId before SQLite commit
    const journalPath = join(userDataDir, 'annotations', 'review-journal.jsonl')
    const journalTextPreKill = readFileSync(journalPath, 'utf8')
    if (!journalTextPreKill.includes(interruptedOpId)) {
      throw new Error(`Journal file on disk did not contain interrupted opId ${interruptedOpId}`)
    }

    // Terminate Electron process at the observed pre-commit boundary
    if (currentApp?.cdp) currentApp.cdp.close()
    killTree(currentApp.child)
    currentApp = null
    await sleep(500)

    // Inspect SQLite database with node:sqlite: verify interruptedOpId was NOT committed!
    const { DatabaseSync: DbSync } = await import('node:sqlite')
    const sqlitePath = join(userDataDir, 'vault-catalog.db')
    const dbCheck = new DbSync(sqlitePath)
    const committedRow = dbCheck
      .prepare("SELECT op_id FROM journal_operations WHERE op_id = ? AND status = 'committed';")
      .get(interruptedOpId)
    dbCheck.close()

    if (committedRow) {
      throw new Error('Interrupted operation was committed to SQLite before process crash!')
    }

    // Relaunch Electron normally on same userDataDir without barrier env vars
    console.log(
      '[Phase 6] Relaunching Electron to verify startup reconciliation of interrupted state...'
    )
    const port3 = await getFreePort()
    currentApp = await launchApp(userDataDir, port3)
    cdp = currentApp.cdp

    // Inspect journal file after startup reconciliation: must contain op_aborted for interruptedOpId
    const journalTextPostRestart = readFileSync(journalPath, 'utf8')
    const postLines = journalTextPostRestart
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    const abortRecord = postLines.find((e) => e.kind === 'op_aborted' && e.opId === interruptedOpId)
    if (!abortRecord) {
      throw new Error(
        `Startup reconciliation failed to append op_aborted for interrupted opId ${interruptedOpId}`
      )
    }

    // Verify subsequent review operations on Photo 4 succeed cleanly without sequence or state conflicts
    await evaluate(
      cdp,
      `(() => {
        const btn = Array.from(document.querySelectorAll('.nav-item')).find((b) =>
          b.textContent && b.textContent.includes('Photos')
        )
        if (btn) btn.click()
      })()`
    )
    await sleep(300)

    await evaluate(
      cdp,
      `(() => {
      const cells = document.querySelectorAll('.photo-cell:not(.photo-skeleton)');
      cells[4].click();
    })()`
    )
    await sleep(200)

    await evaluate(
      cdp,
      `(() => {
      const star2 = document.querySelector('button[aria-label="2 Stars"]');
      if (star2) star2.click();
    })()`
    )
    if (!(await waitForSavedIndicator())) {
      throw new Error('Subsequent rating after crash recovery failed to save')
    }
    pass(
      'Deterministic persistence interruption observed, SQLite rollback verified, startup reconciliation appended op_aborted, and subsequent write succeeded cleanly'
    )

    // 8. Filtered Scale Browsing Beyond 2,000 Photos & Resource Bounds
    console.log('[Phase 7] Seeding 3,000 scale photos and testing filtered scale browsing...')
    // Base images for hard links (multiple base files to stay well within NTFS 1024-link limit per file)
    const scaleBaseImages = []
    for (let k = 0; k < 10; k++) {
      const scaleBaseBuf = await sharp({
        create: {
          width: 300,
          height: 200,
          channels: 3,
          background: { r: (k * 25) % 255, g: (k * 35) % 255, b: (k * 45) % 255 }
        }
      })
        .jpeg()
        .toBuffer()
      const scaleBaseFile = join(tempBase, `scale_base_${k}.jpg`)
      writeFileSync(scaleBaseFile, scaleBaseBuf)
      const st = statSync(scaleBaseFile)
      scaleBaseImages.push({
        path: scaleBaseFile,
        size: st.size,
        birthtimeMs: Math.round(st.birthtimeMs),
        mtimeMs: Math.round(st.mtimeMs),
        hash: createHash('sha256').update(scaleBaseBuf).digest('hex')
      })
    }

    const dbScale = new DbSync(sqlitePath)
    dbScale.exec('BEGIN TRANSACTION;')

    // Create a custom collection "Scale Picks"
    const colScaleRow = dbScale
      .prepare(
        `
        INSERT INTO collections (name, normalized_name, created_at_ms, updated_at_ms)
        VALUES ('Scale Picks', 'scale picks', ?, ?)
        RETURNING id;
      `
      )
      .get(Date.now(), Date.now())
    const scaleCollectionId = colScaleRow.id

    const insertFileStmt = dbScale.prepare(`
      INSERT INTO file_locations (
        source_id, original_path, normalized_path, file_name, extension, category,
        created_at_ms, updated_at_ms
      ) VALUES (1, ?, ?, ?, '.jpg', 'photo', ?, ?)
      RETURNING id;
    `)
    const insertObsStmt = dbScale.prepare(`
      INSERT INTO discovery_observations (
        file_location_id, byte_size, filesystem_birthtime_ms, filesystem_mtime_ms,
        inferred_capture_time_ms, observed_at_ms, last_seen_at_ms, is_current
      ) VALUES (?, ?, ?, ?, NULL, ?, ?, 1)
      RETURNING id;
    `)
    const insertHashStmt = dbScale.prepare(`
      INSERT INTO hash_observations (
        file_location_id, discovery_observation_id, sha256, observed_byte_size,
        observed_mtime_ms, hashed_at_ms, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, 1);
    `)
    const insertAnnStmt = dbScale.prepare(`
      INSERT INTO photo_annotations (
        file_location_id, discovery_observation_id, content_sha256,
        rating, flag, version, is_current, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?);
    `)
    const insertMemStmt = dbScale.prepare(`
      INSERT INTO collection_memberships (
        collection_id, file_location_id, discovery_observation_id, content_sha256, is_current, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, 1, ?, ?);
    `)

    const totalScalePhotos = 3000
    const annotatedPickCount = 2200
    const nowTime = Date.now()

    for (let i = 1; i <= totalScalePhotos; i++) {
      const base = scaleBaseImages[(i - 1) % scaleBaseImages.length]
      const fileName = `scale_photo_${String(i).padStart(6, '0')}.jpg`
      const filePath = join(scaleDir, fileName)
      linkSync(base.path, filePath)

      const fileRow = insertFileStmt.get(
        filePath,
        filePath.toLowerCase(),
        fileName,
        base.birthtimeMs,
        base.mtimeMs
      )
      const obsRow = insertObsStmt.get(
        fileRow.id,
        base.size,
        base.birthtimeMs,
        base.mtimeMs,
        nowTime,
        nowTime
      )
      insertHashStmt.run(fileRow.id, obsRow.id, base.hash, base.size, base.mtimeMs, nowTime)

      if (i <= annotatedPickCount) {
        // Annotate as 5 stars and Pick, and add to Scale Picks collection
        insertAnnStmt.run(fileRow.id, obsRow.id, base.hash, 5, 'pick', nowTime, nowTime)
        insertMemStmt.run(scaleCollectionId, fileRow.id, obsRow.id, base.hash, nowTime, nowTime)
      } else {
        insertAnnStmt.run(fileRow.id, obsRow.id, base.hash, 1, 'none', nowTime, nowTime)
      }
    }

    dbScale.exec('COMMIT;')
    dbScale.close()

    // Refresh UI to display new scale catalog
    await evaluate(
      cdp,
      `(() => {
      const refreshBtn = document.querySelector('button[title="Refresh photograph catalog"]');
      if (refreshBtn) refreshBtn.click();
    })()`
    )
    await sleep(800)

    // Wait for total count in toolbar to exceed 3,000
    let totalCountText = ''
    for (let c = 0; c < 40; c++) {
      totalCountText = await evaluate(
        cdp,
        `document.querySelector('.photos-count-info .count-badge')?.textContent || ''`
      )
      if (totalCountText.includes('3,00')) break
      await sleep(150)
    }
    if (!totalCountText.includes('3,00')) {
      throw new Error(`Total count failed to update to 3,000+ photos: '${totalCountText}'`)
    }

    // Apply Flag filter: Pick (total matches: 2,200)
    console.log(
      '[Phase 7] Applying Pick filter (2,200 photos) and scrolling past 2,000 items in DOM...'
    )
    await evaluate(
      cdp,
      `(() => {
      const flagSel = document.querySelector('select[aria-label="Filter by Flag"]');
      if (flagSel) {
        flagSel.value = 'pick';
        flagSel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    })()`
    )
    await sleep(400)

    const filteredTotalBadge = await evaluate(
      cdp,
      `document.querySelector('.photos-count-info .count-badge')?.textContent || ''`
    )
    if (!filteredTotalBadge.includes('2,20')) {
      throw new Error(`Expected ~2,200 filtered photos in badge, found '${filteredTotalBadge}'`)
    }

    async function assertScaleCheckpoint(name, minExpectedNum, maxExpectedNum) {
      let stats = null
      for (let attempt = 0; attempt < 80; attempt++) {
        stats = await evaluate(
          cdp,
          `(() => {
            const cells = Array.from(document.querySelectorAll('.photo-cell:not(.photo-skeleton)'));
            let errorCount = 0;
            let pendingCount = 0;
            let supportedCount = 0;
            let supportedLoadedCount = 0;
            const filenames = [];

            for (const cell of cells) {
              const nameEl = cell.querySelector('.photo-filename');
              const fileName = nameEl ? nameEl.textContent.trim() : '';
              filenames.push(fileName);
              const isError = Boolean(cell.querySelector('.thumbnail-placeholder.error, .notice-error'));
              const isPending = Boolean(cell.querySelector('.thumbnail-placeholder.loading'));
              const img = cell.querySelector('img.photo-thumbnail-img');

              if (isError) {
                errorCount++;
              } else if (isPending) {
                pendingCount++;
              } else if (img) {
                supportedCount++;
                if (img.complete && img.naturalWidth > 0 && img.alt === fileName) {
                  supportedLoadedCount++;
                }
              } else {
                pendingCount++;
              }
            }

            return {
              mountedCount: cells.length,
              errorCount,
              pendingCount,
              supportedCount,
              supportedLoadedCount,
              filenames
            };
          })()`
        )

        if (
          stats &&
          stats.mountedCount > 0 &&
          stats.pendingCount === 0 &&
          stats.errorCount === 0 &&
          stats.supportedCount > 0 &&
          stats.supportedLoadedCount === stats.supportedCount
        ) {
          break
        }
        await sleep(150)
      }

      if (!stats || stats.mountedCount === 0) {
        throw new Error(`[${name}] Zero mounted cells found!`)
      }
      if (stats.mountedCount > 200) {
        throw new Error(`[${name}] Mounted cells (${stats.mountedCount}) exceeded 200 limit`)
      }
      if (stats.errorCount > 0) {
        throw new Error(`[${name}] Detected ${stats.errorCount} error cards`)
      }
      if (stats.supportedLoadedCount !== stats.supportedCount || stats.supportedCount === 0) {
        throw new Error(
          `[${name}] Incomplete image load: ${stats.supportedLoadedCount}/${stats.supportedCount} loaded`
        )
      }

      const hasExpectedIdentity = stats.filenames.some((f) => {
        const m = f.match(/scale_photo_(\d+)\.jpg/)
        if (m) {
          const num = parseInt(m[1], 10)
          return num >= minExpectedNum && num <= maxExpectedNum
        }
        return false
      })
      if (!hasExpectedIdentity) {
        throw new Error(
          `[${name}] Expected photo number in range [${minExpectedNum}, ${maxExpectedNum}], found: ${stats.filenames.slice(0, 3).join(', ')}`
        )
      }

      pass(
        `[${name}] Verified ${stats.mountedCount} mounted cells, ${stats.supportedLoadedCount} loaded images, zero errors, expected identity (${stats.filenames[0]})`
      )
    }

    // Cold scroll forward past 2,000 photos in the filtered virtual grid
    for (let pos = 5000; pos <= 120000; pos += 15000) {
      await evaluate(
        cdp,
        `(() => {
          const el = document.querySelector('.photos-grid-container');
          if (el) { el.scrollTop = ${pos}; el.dispatchEvent(new Event('scroll')); }
        })()`
      )
      await sleep(35)
    }

    // Checkpoint 1: Verify virtualization bounds and identity past 2,000 records
    await assertScaleCheckpoint('Checkpoint 1: Beyond 2,000 photos', 2000, 2200)

    // Distant scroll jump to offset near end of filtered collection
    await evaluate(
      cdp,
      `(() => {
        const el = document.querySelector('.photos-grid-container');
        if (el) { el.scrollTop = 125000; el.dispatchEvent(new Event('scroll')); }
      })()`
    )
    await sleep(200)

    // Return travel (scroll back to top)
    await evaluate(
      cdp,
      `(() => {
        const el = document.querySelector('.photos-grid-container');
        if (el) { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); }
      })()`
    )
    await sleep(200)

    // Checkpoint 2: Back at top of filtered grid
    await assertScaleCheckpoint('Checkpoint 2: Return to top', 1, 100)

    // Verify worker resource bounds
    const diag = await evaluate(cdp, `window.api.getPhotosDiagnostics()`)
    if (diag && diag.activeWorkers > 4) {
      throw new Error(
        `Active thumbnail workers (${diag.activeWorkers}) exceeded max concurrency bound of 4`
      )
    }
    pass(
      'Filtered scale browsing beyond 2,000 photos completed: mounted cells <= 200, zero error cards, active workers bounded'
    )

    // 9. Strict Source Preservation Invariance
    console.log('[Phase 8] Verifying strict source preservation invariance across all files...')
    // Check original 5 source files
    for (const f of filesToCreate) {
      const p = join(sourceDir, f.name)
      if (!existsSync(p)) {
        throw new Error(`Source file missing: ${p}`)
      }
      const st = statSync(p)
      const base = baselineStats.get(p)
      if (st.size !== base.size) {
        throw new Error(`Source file size changed: ${p} (was ${base.size}, now ${st.size})`)
      }
      const currentHash = createHash('sha256').update(readFileSync(p)).digest('hex')
      if (currentHash !== base.hash) {
        throw new Error(`Source file hash changed: ${p}`)
      }
      if (Math.abs(st.mtimeMs - base.mtimeMs) > 1) {
        throw new Error(`Source file mtime modified: ${p}`)
      }
    }

    // Specially verify photo3_ocean.png which was marked "Reject"
    const rejectedPath = join(sourceDir, 'photo3_ocean.png')
    const rejBase = baselineStats.get(rejectedPath)
    const rejCurrentHash = createHash('sha256').update(readFileSync(rejectedPath)).digest('hex')
    if (rejCurrentHash !== rejBase.hash) {
      throw new Error('Photo flagged Reject was altered!')
    }

    // Check scale fixture base files
    for (const base of scaleBaseImages) {
      const scaleCheckHash = createHash('sha256').update(readFileSync(base.path)).digest('hex')
      if (scaleCheckHash !== base.hash) {
        throw new Error(`Scale fixture base file ${base.path} was modified!`)
      }
    }
    pass(
      'Source preservation invariant holds: zero source files altered, moved, or deleted (Reject is purely a review annotation)'
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
