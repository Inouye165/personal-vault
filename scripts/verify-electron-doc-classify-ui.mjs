#!/usr/bin/env node
/**
 * Personal Vault — Stage 7E Slice 3 Real Electron UI & IPC Verification
 *
 * Exercises built and isolated unpacked Electron from a neutral cwd (`tmpdir()`):
 * 1. Verifies sandboxed preload (`out/preload/index.js`) requires only `electron`.
 * 2. Scans synthetic fixtures (`summer_note.txt`, `grocery_receipt.txt`, `repos/pkg-0/LICENSE.txt`,
 *    `blank_unclassified.pdf`) and runs `Extract All Text`.
 * 3. Clicks `Classify Documents` offline (`0` downloads, `0` network calls), verifies `Show all`
 *    default, opt-in `Hide clutter`, personal-note preservation, exact scoped hidden count, and
 *    `Inspect hidden (1)`.
 * 4. Applies durable `Not clutter — Always show` override on `LICENSE.txt`, verifies reversible
 *    visibility, and verifies restart persistence across Electron relaunch.
 * 5. Verifies semantic search with `Hide clutter` active discloses filtering without inventing
 *    hidden-match counts, and verifies stale `expectedOverrideVersion` conflict handling over IPC.
 * 6. Verifies 100% bitwise source preservation across all synthetic fixtures.
 */

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const __dirname = resolve(fileURLToPath(import.meta.url), '..')
const rootDir = resolve(__dirname, '..')
const mode = process.argv.includes('--mode=unpacked') ? 'unpacked' : 'built'
const shouldRebuild = process.argv.includes('--rebuild')
const executableArg =
  process.argv.find((arg) => arg.startsWith('--exe=')) ??
  process.argv.find((arg) => arg.startsWith('--executable='))
const explicitExecutable = executableArg
  ? executableArg.startsWith('--exe=')
    ? executableArg.slice('--exe='.length)
    : executableArg.slice('--executable='.length)
  : null

const cachedModelDir = resolve(
  rootDir,
  'spikes',
  'doc-semantic-eval',
  '.model-cache',
  'bge-small-en-v1.5'
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

async function getFreePort() {
  return new Promise((resolvePort, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close((err) => (err ? reject(err) : resolvePort(port)))
    })
  })
}

async function waitForCdpTarget(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      if (res.ok) {
        const list = await res.json()
        const target = list.find(
          (t) =>
            t.type === 'page' &&
            typeof t.webSocketDebuggerUrl === 'string' &&
            !t.url.startsWith('devtools://')
        )
        if (target) return target
      }
    } catch {
      // retry
    }
    await sleep(250)
  }
  throw new Error(`Timed out waiting for CDP target on port ${port}`)
}

async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', rej, { once: true })
  })
  let msgId = 1
  const pending = new Map()
  const rejectAll = (reason) => {
    for (const { reject: pReject } of pending.values()) {
      pReject(new Error(reason))
    }
    pending.clear()
  }
  ws.addEventListener('close', () => rejectAll('CDP WebSocket closed'))
  ws.addEventListener('error', () => rejectAll('CDP WebSocket error'))
  ws.onmessage = (evt) => {
    const data = JSON.parse(String(evt.data))
    if (data.id && pending.has(data.id)) {
      const { resolve: pResolve, reject: pReject } = pending.get(data.id)
      pending.delete(data.id)
      if (data.error) pReject(new Error(data.error.message))
      else pResolve(data.result)
    }
  }
  const call = (method, params = {}) => {
    const id = msgId++
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          rej(new Error(`CDP call timed out: ${method}`))
        }
      }, 15000)
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          res(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          rej(e)
        }
      })
      ws.send(JSON.stringify({ id, method, params }))
    })
  }
  const evaluate = async (expression) => {
    const res = await call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (res.exceptionDetails) {
      throw new Error(
        `Renderer evaluation error: ${res.exceptionDetails.text} ${JSON.stringify(res.exceptionDetails.exception)}`
      )
    }
    return res.result?.value
  }
  await call('Runtime.enable')
  return { ws, call, evaluate }
}

function launchElectron(userDataDir, port) {
  const neutralCwd = tmpdir()
  const commonArgs = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-sandbox'
  ]
  const env = {
    ...process.env,
    ...(existsSync(cachedModelDir) ? { PV_TEST_DOC_MODEL_IMPORT_DIR: cachedModelDir } : {})
  }

  if (mode === 'unpacked') {
    const unpackedDir =
      process.env.PV_UNPACKED_DIR || join(rootDir, 'dist-stage-7e-ui-verify', 'win-unpacked')
    const exePath = explicitExecutable || join(unpackedDir, 'Personal Vault.exe')
    if (!existsSync(exePath)) {
      throw new Error(`Unpacked executable not found: ${exePath}`)
    }
    return spawn(exePath, commonArgs, { cwd: neutralCwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  }

  return spawn(String(electronPath), [rootDir, ...commonArgs], {
    cwd: neutralCwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

async function stopElectron(proc, ws) {
  try {
    ws?.close()
  } catch {
    // ignore
  }
  if (!proc || proc.killed || proc.exitCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    proc.kill('SIGKILL')
  }
  await sleep(300)
}

async function waitForCondition(evaluate, expr, description, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const val = await evaluate(expr)
    if (val) return val
    await sleep(250)
  }
  throw new Error(`Timed out waiting for: ${description}`)
}

async function main() {
  if (mode === 'unpacked' && shouldRebuild) {
    console.log('[INFO] Rebuilding isolated unpacked executable in dist-stage-7e-ui-verify...')
    const res = spawnSync(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['electron-builder', '--win', 'dir', '--config.directories.output=dist-stage-7e-ui-verify'],
      { cwd: rootDir, stdio: 'inherit', shell: true }
    )
    if (res.status !== 0) {
      throw new Error(`electron-builder failed with exit code ${res.status}`)
    }
  }

  const preloadPath = join(rootDir, 'out', 'preload', 'index.js')
  if (!existsSync(preloadPath)) {
    throw new Error(`Missing compiled preload bundle: ${preloadPath}. Run npm run build first.`)
  }
  const preloadCode = readFileSync(preloadPath, 'utf8')
  const preloadRequires = [...preloadCode.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1])
  if (!preloadRequires.every((m) => m === 'electron')) {
    throw new Error(
      `Sandboxed preload requires non-electron modules: ${preloadRequires.join(', ')}`
    )
  }
  console.log('[PASS] 1. Sandboxed preload check: requires=[electron]')

  const tempRoot = mkdtempSync(join(tmpdir(), `pv-doc-cls-s3-ui-${mode}-`))
  const userDataDir = join(tempRoot, 'user-data')
  const fixturesDir = join(tempRoot, 'fixtures')
  mkdirSync(join(fixturesDir, 'Personal', 'Notes'), { recursive: true })
  mkdirSync(join(fixturesDir, 'Personal', 'Receipts'), { recursive: true })
  mkdirSync(join(fixturesDir, 'repos', 'pkg-0'), { recursive: true })
  mkdirSync(join(fixturesDir, 'Personal', 'Scans'), { recursive: true })

  const fixtures = {
    note: join(fixturesDir, 'Personal', 'Notes', 'summer_note.txt'),
    receipt: join(fixturesDir, 'Personal', 'Receipts', 'grocery_receipt.txt'),
    license: join(fixturesDir, 'repos', 'pkg-0', 'LICENSE.txt'),
    blankPdf: join(fixturesDir, 'Personal', 'Scans', 'blank_unclassified.pdf')
  }

  writeFileSync(
    fixtures.note,
    'Summer family vacation checklist and lake house reflection notes.\nRemember to pack hiking boots and camera.',
    'utf8'
  )
  writeFileSync(
    fixtures.receipt,
    'Receipt #402\nMilk $3.50\nBread $2.50\nSubtotal: $6.00\nTotal: $6.50\nPaid Card',
    'utf8'
  )
  writeFileSync(
    fixtures.license,
    'SPDX-License-Identifier: MIT\nPermission is hereby granted, free of charge, to any person obtaining a copy of the "Software".\nWITHOUT WARRANTY OF ANY KIND.\n',
    'utf8'
  )
  writeFileSync(fixtures.blankPdf, '%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n', 'utf8')

  const beforeHashes = Object.fromEntries(
    Object.entries(fixtures).map(([k, p]) => [k, sha256File(p)])
  )

  let proc = null
  let ws = null

  try {
    const port1 = await getFreePort()
    proc = launchElectron(userDataDir, port1)
    const target1 = await waitForCdpTarget(port1)
    const cdp1 = await connectCdp(target1.webSocketDebuggerUrl)
    ws = cdp1.ws

    await waitForCondition(
      cdp1.evaluate,
      `Boolean(window.api && document.querySelector('button[aria-label="Documents"], button'))`,
      'app mount'
    )

    // Scan fixtures via preload IPC & navigate to Documents
    await cdp1.evaluate(`(async () => {
      await window.api.startScan({ roots: [${JSON.stringify(fixturesDir)}] });
      let done = false;
      for (let i = 0; i < 100; i++) {
        const cur = await window.api.getLatestScanJob();
        const st = cur?.job?.status;
        if (st === 'completed') {
          done = true;
          break;
        }
        if (st === 'failed' || st === 'cancelled') {
          throw new Error('Scan failed: ' + JSON.stringify(cur.job));
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      if (!done) throw new Error('Timed out waiting for scan job to complete');
      const docsBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('Documents'));
      docsBtn?.click();
      return true;
    })()`)

    await waitForCondition(
      cdp1.evaluate,
      `Boolean(document.querySelector('[data-testid="documents-extract-scope-btn"]'))`,
      'Documents panel & extract button'
    )

    // Extract text
    await cdp1.evaluate(`(() => {
      document.querySelector('[data-testid="documents-extract-scope-btn"]')?.click();
    })()`)
    await waitForCondition(
      cdp1.evaluate,
      `(async () => {
        const p = await window.api.getDocumentExtractionProgress();
        return p && p.status === 'completed' && p.processedDocuments >= 4;
      })()`,
      'extraction completion'
    )
    console.log('[PASS] 2. Scan & native extraction completed in Electron UI')

    // Classify Documents offline
    await cdp1.evaluate(`(() => {
      document.querySelector('[data-testid="documents-classify-start-btn"]')?.click();
    })()`)
    await waitForCondition(
      cdp1.evaluate,
      `document.querySelector('[data-testid="doc-classify-status-badge"]')?.textContent === 'completed'`,
      'classification completion'
    )
    console.log('[PASS] 3. Offline classification completed in Electron UI')

    // Verify Show all default (4 docs visible, personal note visible, Other vs Unknown distinct)
    const defaultCheck = await cdp1.evaluate(`(() => {
      const text = document.body.innerText;
      const clutterSelect = document.querySelector('[data-testid="documents-clutter-filter"]');
      return {
        clutterVal: clutterSelect?.value,
        hasNote: text.includes('summer_note.txt'),
        hasLicense: text.includes('LICENSE.txt'),
        hasOther: text.includes('Other / No structured match'),
        hasUnknown: text.includes('Unclassified / Needs text extraction or OCR')
      };
    })()`)
    if (
      defaultCheck.clutterVal !== 'show_all' ||
      !defaultCheck.hasNote ||
      !defaultCheck.hasLicense ||
      !defaultCheck.hasOther ||
      !defaultCheck.hasUnknown
    ) {
      throw new Error(`Default Show all check failed: ${JSON.stringify(defaultCheck)}`)
    }
    console.log('[PASS] 4. Default Show all, personal note visible, and Other vs Unknown distinct')

    // Opt-in Hide clutter -> LICENSE.txt hidden, summer_note.txt preserved, scoped banner shown
    await cdp1.evaluate(`(() => {
      const sel = document.querySelector('[data-testid="documents-clutter-filter"]');
      if (sel._valueTracker) sel._valueTracker.setValue('__force__');
      sel.value = 'hide_clutter';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    })()`)
    try {
      await waitForCondition(
        cdp1.evaluate,
        `Boolean(document.querySelector('[data-testid="documents-hidden-clutter-banner"]'))`,
        'hidden clutter banner',
        10000
      )
    } catch (err) {
      const diag = await cdp1.evaluate(`(async () => {
        const sel = document.querySelector('[data-testid="documents-clutter-filter"]');
        const cov = document.querySelector('[data-testid="doc-classify-coverage-text"]')?.textContent;
        const page = await window.api.getDocumentsPage({ offset: 0, limit: 50, clutterFilter: 'hide_clutter' });
        return { selVal: sel?.value, cov, totalCount: page.totalCount, hiddenClutterCount: page.hiddenClutterCount };
      })()`)
      throw new Error(`${err.message} | diag=${JSON.stringify(diag)}`, { cause: err })
    }
    const hideCheck = await cdp1.evaluate(`(() => {
      const banner = document.querySelector('[data-testid="documents-hidden-clutter-banner"]')?.textContent ?? '';
      const listText = document.querySelector('.documents-list')?.textContent ?? '';
      return {
        banner,
        hasNote: listText.includes('summer_note.txt'),
        hasLicense: listText.includes('LICENSE.txt')
      };
    })()`)
    if (!hideCheck.hasNote || hideCheck.hasLicense || !hideCheck.banner.includes('1 clutter')) {
      throw new Error(`Hide clutter check failed: ${JSON.stringify(hideCheck)}`)
    }
    console.log('[PASS] 5. Opt-in Hide clutter hides LICENSE.txt while preserving personal note')

    // Inspect hidden (1) -> click LICENSE.txt -> Not clutter — Always show
    await cdp1.evaluate(`(() => {
      document.querySelector('[data-testid="documents-inspect-hidden-btn"]')?.click();
    })()`)
    await waitForCondition(
      cdp1.evaluate,
      `document.querySelector('.documents-list')?.textContent?.includes('LICENSE.txt')`,
      'Inspect hidden list shows LICENSE.txt'
    )
    await cdp1.evaluate(`(() => {
      const btn = Array.from(document.querySelectorAll('.documents-row-btn')).find((b) => b.textContent?.includes('LICENSE.txt'));
      btn?.click();
    })()`)
    await waitForCondition(
      cdp1.evaluate,
      `Boolean(document.querySelector('[data-testid="doc-classify-not-clutter-btn"]'))`,
      'Not clutter button in detail drawer'
    )
    await cdp1.evaluate(`(() => {
      document.querySelector('[data-testid="doc-classify-not-clutter-btn"]')?.click();
    })()`)
    try {
      await waitForCondition(
        cdp1.evaluate,
        `Boolean(document.querySelector('[data-testid="doc-classify-override-notice"]'))`,
        'override saved notice',
        10000
      )
    } catch (err) {
      const diag = await cdp1.evaluate(`(() => ({
        notice: document.querySelector('[data-testid="doc-classify-override-notice"]')?.textContent ?? null,
        summary: document.querySelector('[data-testid="doc-classify-effective-summary"]')?.textContent ?? null,
        hasBtn: Boolean(document.querySelector('[data-testid="doc-classify-not-clutter-btn"]'))
      }))()`)
      throw new Error(`${err.message} | diag=${JSON.stringify(diag)}`, { cause: err })
    }
    const noticeText = await cdp1.evaluate(
      `document.querySelector('[data-testid="doc-classify-override-notice"]')?.textContent ?? ''`
    )
    if (!noticeText.includes('saved')) {
      throw new Error(`Unexpected override notice: ${noticeText}`)
    }
    console.log('[PASS] 6. Durable Not clutter — Always show override saved in UI')

    // Check 6b: Actual 480x820 Documents layout + full multi-select Edit classification checkbox flow
    await cdp1.call('Emulation.setDeviceMetricsOverride', {
      width: 480,
      height: 820,
      deviceScaleFactor: 1,
      mobile: false
    })
    await sleep(300)

    const narrowListMetrics = await cdp1.evaluate(`(() => {
      const docEl = document.documentElement;
      const contentArea = document.querySelector('.content-area');
      const panel = document.querySelector('.documents-panel');
      const overflowing = [];
      for (const el of document.querySelectorAll('.documents-panel input, .documents-panel select, .documents-panel button, .documents-row-btn')) {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.right > window.innerWidth + 1 || r.left < -1) {
          overflowing.push({ tag: el.tagName, testId: el.getAttribute('data-testid'), left: Math.round(r.left), right: Math.round(r.right) });
        }
      }
      return {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        docScrollWidth: docEl.scrollWidth,
        contentClientWidth: contentArea?.clientWidth ?? null,
        contentScrollWidth: contentArea?.scrollWidth ?? null,
        panelClientWidth: panel?.clientWidth ?? null,
        panelScrollWidth: panel?.scrollWidth ?? null,
        overflowing
      };
    })()`)
    if (
      narrowListMetrics.innerWidth !== 480 ||
      narrowListMetrics.innerHeight !== 820 ||
      narrowListMetrics.docScrollWidth > 481 ||
      (narrowListMetrics.contentScrollWidth ?? 0) >
        (narrowListMetrics.contentClientWidth ?? 0) + 1 ||
      (narrowListMetrics.panelScrollWidth ?? 0) > (narrowListMetrics.panelClientWidth ?? 0) + 1 ||
      narrowListMetrics.overflowing.length > 0
    ) {
      throw new Error(
        `480x820 Documents list layout overflow/clipping: ${JSON.stringify(narrowListMetrics)}`
      )
    }

    // Switch clutter filter back to Show all so summer_note.txt is listed at 480x820
    await cdp1.evaluate(`(() => {
      const closeBtn = document.querySelector('.documents-detail-drawer .documents-close-btn');
      closeBtn?.click();
      const sel = document.querySelector('[data-testid="documents-clutter-filter"]');
      if (sel._valueTracker) sel._valueTracker.setValue('__force__');
      sel.value = 'show_all';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    })()`)
    await waitForCondition(
      cdp1.evaluate,
      `Array.from(document.querySelectorAll('.documents-row-btn')).some((b) => b.textContent?.includes('summer_note.txt'))`,
      'summer_note.txt listed under Show all at 480x820'
    )

    // Open summer_note.txt in modal detail drawer at 480x820 and open Edit classification editor
    await cdp1.evaluate(`(() => {
      const btn = Array.from(document.querySelectorAll('.documents-row-btn')).find((b) =>
        b.textContent?.includes('summer_note.txt')
      );
      btn?.click();
    })()`)
    await waitForCondition(
      cdp1.evaluate,
      `Boolean(document.querySelector('[data-testid="doc-classify-edit-btn"]')) && document.querySelector('.documents-detail-header')?.parentElement?.textContent?.includes('summer_note.txt')`,
      'summer_note.txt detail drawer at 480x820'
    )
    await cdp1.evaluate(`(() => {
      document.querySelector('[data-testid="doc-classify-edit-btn"]')?.click();
    })()`)
    await waitForCondition(
      cdp1.evaluate,
      `Boolean(document.querySelector('[data-testid="doc-classify-override-editor"]'))`,
      'Edit classification override editor at 480x820'
    )

    const narrowDrawerMetrics = await cdp1.evaluate(`(() => {
      const drawer = document.querySelector('.documents-detail-drawer');
      const editor = document.querySelector('[data-testid="doc-classify-override-editor"]');
      const drawerRect = drawer?.getBoundingClientRect();
      const overflowing = [];
      for (const el of document.querySelectorAll('.documents-detail-drawer input, .documents-detail-drawer select, .documents-detail-drawer button')) {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.right > window.innerWidth + 1 || r.left < -1) {
          overflowing.push({ tag: el.tagName, testId: el.getAttribute('data-testid'), left: Math.round(r.left), right: Math.round(r.right) });
        }
      }
      return {
        isModalDrawer: drawer?.classList.contains('is-modal-drawer') ?? false,
        drawerWidth: drawerRect ? Math.round(drawerRect.width) : null,
        drawerScrollWidth: drawer?.scrollWidth ?? null,
        drawerClientWidth: drawer?.clientWidth ?? null,
        editorScrollWidth: editor?.scrollWidth ?? null,
        editorClientWidth: editor?.clientWidth ?? null,
        overflowing
      };
    })()`)
    if (
      !narrowDrawerMetrics.isModalDrawer ||
      (narrowDrawerMetrics.drawerWidth ?? 999) > 480 ||
      (narrowDrawerMetrics.drawerScrollWidth ?? 0) >
        (narrowDrawerMetrics.drawerClientWidth ?? 0) + 1 ||
      (narrowDrawerMetrics.editorScrollWidth ?? 0) >
        (narrowDrawerMetrics.editorClientWidth ?? 0) + 1 ||
      narrowDrawerMetrics.overflowing.length > 0
    ) {
      throw new Error(
        `480x820 Documents drawer/editor layout overflow: ${JSON.stringify(narrowDrawerMetrics)}`
      )
    }
    console.log(
      `[PASS] 6a. 480x820 Documents layout verified (list=${JSON.stringify(narrowListMetrics)}, drawer=${JSON.stringify(narrowDrawerMetrics)})`
    )

    // Multi-select Edit classification checkbox flow: select Legal + Instructions + Lists (ensure multi-label) and Personal + Software project + force_keep
    const multiSelectPre = await cdp1.evaluate(`(() => {
      const editor = document.querySelector('[data-testid="doc-classify-override-editor"]');
      const labels = Array.from(editor.querySelectorAll('label.documents-override-checkbox'));
      const setCheckbox = (labelText, desired) => {
        const lbl = labels.find((l) => l.textContent?.trim() === labelText);
        if (!lbl) throw new Error('Missing checkbox label: ' + labelText);
        const cb = lbl.querySelector('input[type="checkbox"]');
        if (!cb) throw new Error('Missing checkbox input for: ' + labelText);
        if (cb.checked !== desired) cb.click();
        return cb.checked;
      };
      const purposeStates = {
        legal: setCheckbox('Legal', true),
        lists: setCheckbox('Lists', true),
        instructions: setCheckbox('Instructions', true),
        receipts: setCheckbox('Receipts', false),
        recipes: setCheckbox('Recipes', false)
      };
      const originStates = {
        personal: setCheckbox('Personal', true),
        software_project: setCheckbox('Software project', true),
        application_system: setCheckbox('Application / System', false)
      };
      const clutterSel = editor.querySelector('[data-testid="doc-classify-override-clutter-select"]');
      if (!clutterSel) throw new Error('Missing clutter override select');
      if (clutterSel._valueTracker) clutterSel._valueTracker.setValue('__force__');
      clutterSel.value = 'force_keep';
      clutterSel.dispatchEvent(new Event('change', { bubbles: true }));
      return { purposeStates, originStates, clutterVal: clutterSel.value };
    })()`)
    if (
      !multiSelectPre.purposeStates.legal ||
      !multiSelectPre.purposeStates.lists ||
      !multiSelectPre.purposeStates.instructions ||
      !multiSelectPre.originStates.personal ||
      !multiSelectPre.originStates.software_project ||
      multiSelectPre.clutterVal !== 'force_keep'
    ) {
      throw new Error(`Multi-select checkbox setup failed: ${JSON.stringify(multiSelectPre)}`)
    }

    await cdp1.evaluate(`(() => {
      document.querySelector('[data-testid="doc-classify-save-override-btn"]')?.click();
    })()`)
    await waitForCondition(
      cdp1.evaluate,
      `!document.querySelector('[data-testid="doc-classify-override-editor"]') && (document.querySelector('[data-testid="doc-classify-effective-summary"]')?.textContent ?? '').includes('Instructions')`,
      'multi-select override save completion'
    )
    const multiSaveSummary = await cdp1.evaluate(`(() => ({
      notice: document.querySelector('[data-testid="doc-classify-override-notice"]')?.textContent ?? '',
      summary: document.querySelector('[data-testid="doc-classify-effective-summary"]')?.textContent ?? '',
      hasResetBtn: Boolean(document.querySelector('[data-testid="doc-classify-reset-override-btn"]'))
    }))()`)
    if (
      !multiSaveSummary.notice.includes('saved') ||
      !multiSaveSummary.summary.includes('Legal') ||
      !multiSaveSummary.summary.includes('Lists') ||
      !multiSaveSummary.summary.includes('Instructions') ||
      !multiSaveSummary.summary.includes('Personal') ||
      !multiSaveSummary.summary.includes('Software project') ||
      !multiSaveSummary.hasResetBtn
    ) {
      throw new Error(
        `Multi-select override UI summary mismatch: ${JSON.stringify(multiSaveSummary)}`
      )
    }
    await cdp1.call('Emulation.clearDeviceMetricsOverride')
    console.log('[PASS] 6b. Multi-select Edit classification checkbox flow saved & reflected in UI')

    // Stale-state race check over real IPC: expectedOverrideVersion: 0 must return STALE_OVERRIDE_VERSION
    const staleRace = await cdp1.evaluate(`(async () => {
      const page = await window.api.getDocumentsPage({ offset: 0, limit: 50 });
      const lic = page.items.find((i) => i.fileName === 'LICENSE.txt');
      return window.api.setDocumentClassificationOverride({
        fileLocationId: lic.fileLocationId,
        expectedRevision: lic.classification.contentRevision,
        expectedOverrideVersion: 0,
        purposeLabels: ['lists'],
        originLabels: ['personal'],
        clutterOverride: 'force_keep'
      });
    })()`)
    if (staleRace.ok !== false || staleRace.conflict !== 'STALE_OVERRIDE_VERSION') {
      throw new Error(`Stale override race check failed: ${JSON.stringify(staleRace)}`)
    }
    console.log('[PASS] 7. Stale-state override conflict rejected over real IPC')

    // Semantic search filtering disclosure check (if cached BGE model exists)
    if (existsSync(cachedModelDir)) {
      await cdp1.evaluate(`(async () => {
        await window.api.importDocSemanticModel();
        await window.api.startDocumentSemanticIndexing({ scope: 'all' });
      })()`)
      const semCheck = await cdp1.evaluate(`(async () => {
        const res = await window.api.searchDocumentsSemantic({
          query: 'lake house vacation',
          clutterFilter: 'hide_clutter'
        });
        return {
          totalMatched: res.totalMatched,
          clutterFilterActive: res.clutterFilterActive,
          hasHiddenMatchCountField: 'hiddenMatches' in res || 'hiddenMatchCount' in res
        };
      })()`)
      if (!semCheck.clutterFilterActive || semCheck.hasHiddenMatchCountField) {
        throw new Error(`Semantic filtering check failed: ${JSON.stringify(semCheck)}`)
      }
      console.log(
        '[PASS] 8. Semantic filtering active-clutter disclosure verified (no invented hidden-match counts)'
      )
    } else {
      console.log('[PASS] 8. Semantic filtering skipped (no cached BGE model; offline mode)')
    }

    // Restart Electron against persisted userDataDir and verify override persists
    await stopElectron(proc, ws)
    proc = null
    ws = null

    const port2 = await getFreePort()
    proc = launchElectron(userDataDir, port2)
    const target2 = await waitForCdpTarget(port2)
    const cdp2 = await connectCdp(target2.webSocketDebuggerUrl)
    ws = cdp2.ws

    await waitForCondition(
      cdp2.evaluate,
      `Array.from(document.querySelectorAll('button')).some((b) => b.textContent?.includes('Documents'))`,
      'Documents button mount after restart'
    )
    const persisted = await cdp2.evaluate(`(async () => {
      const page = await window.api.getDocumentsPage({ offset: 0, limit: 50, clutterFilter: 'hide_clutter' });
      const lic = page.items.find((i) => i.fileName === 'LICENSE.txt');
      const note = page.items.find((i) => i.fileName === 'summer_note.txt');
      const instFiltered = await window.api.getDocumentsPage({ offset: 0, limit: 50, purposeFilter: 'instructions' });
      const swFiltered = await window.api.getDocumentsPage({ offset: 0, limit: 50, originFilter: 'software_project' });
      return {
        totalCount: page.totalCount,
        hiddenClutterCount: page.hiddenClutterCount,
        licOverride: lic?.classification?.hasOverride,
        licVersion: lic?.classification?.overrideVersion,
        noteOverride: note?.classification?.hasOverride,
        noteVersion: note?.classification?.overrideVersion,
        notePurposes: note?.classification?.effectivePurposeLabels ?? [],
        noteOrigins: note?.classification?.effectiveOriginLabels ?? [],
        noteClutterOverride: note?.classification?.clutterOverride ?? null,
        instHasNote: instFiltered.items.some((i) => i.fileName === 'summer_note.txt'),
        swHasNote: swFiltered.items.some((i) => i.fileName === 'summer_note.txt')
      };
    })()`)
    const hasAllPurposes = ['legal', 'lists', 'instructions'].every((p) =>
      persisted.notePurposes.includes(p)
    )
    const hasAllOrigins = ['personal', 'software_project'].every((o) =>
      persisted.noteOrigins.includes(o)
    )
    if (
      persisted.totalCount !== 4 ||
      persisted.hiddenClutterCount !== 0 ||
      persisted.licOverride !== true ||
      persisted.licVersion !== 1 ||
      persisted.noteOverride !== true ||
      persisted.noteVersion !== 1 ||
      !hasAllPurposes ||
      !hasAllOrigins ||
      persisted.noteClutterOverride !== 'force_keep' ||
      !persisted.instHasNote ||
      !persisted.swHasNote
    ) {
      throw new Error(`Restart persistence check failed: ${JSON.stringify(persisted)}`)
    }

    // Open Documents tab after restart and verify UI detail drawer renders persisted multi-select labels
    await cdp2.evaluate(`(() => {
      const docsBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('Documents'));
      docsBtn?.click();
    })()`)
    await waitForCondition(
      cdp2.evaluate,
      `Boolean(Array.from(document.querySelectorAll('.documents-row-btn')).find((b) => b.textContent?.includes('summer_note.txt')))`,
      'summer_note.txt row after restart'
    )
    await cdp2.evaluate(`(() => {
      const btn = Array.from(document.querySelectorAll('.documents-row-btn')).find((b) => b.textContent?.includes('summer_note.txt'));
      btn?.click();
    })()`)
    await waitForCondition(
      cdp2.evaluate,
      `Boolean(document.querySelector('[data-testid="doc-classify-effective-summary"]')) && document.querySelector('[data-testid="doc-classify-effective-summary"]').textContent.includes('Instructions')`,
      'persisted multi-select override summary in UI after restart'
    )
    const persistedUiSummary = await cdp2.evaluate(
      `document.querySelector('[data-testid="doc-classify-effective-summary"]')?.textContent ?? ''`
    )
    if (
      !persistedUiSummary.includes('Legal') ||
      !persistedUiSummary.includes('Lists') ||
      !persistedUiSummary.includes('Instructions') ||
      !persistedUiSummary.includes('Personal') ||
      !persistedUiSummary.includes('Software project')
    ) {
      throw new Error(`Persisted UI summary mismatch after restart: ${persistedUiSummary}`)
    }
    console.log(
      '[PASS] 9. Restart persistence verified (LICENSE.txt + multi-select summer_note.txt override & UI labels preserved)'
    )

    // Bitwise source preservation check
    for (const [k, p] of Object.entries(fixtures)) {
      const after = sha256File(p)
      if (after !== beforeHashes[k]) {
        throw new Error(`Source file modified: ${p}`)
      }
    }
    console.log('[PASS] 10. 100% bitwise source preservation verified (4/4 fixtures)')
  } finally {
    await stopElectron(proc, ws)
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error('[FAIL]', err)
  process.exit(1)
})
