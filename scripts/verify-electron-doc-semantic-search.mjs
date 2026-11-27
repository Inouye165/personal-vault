#!/usr/bin/env node
/**
 * Personal Vault — Stage 7D Slice 3 Real Electron UI & IPC Verification
 *
 * Exercises built and isolated unpacked Electron from a neutral cwd (`tmpdir()`):
 * 1. Verifies sandboxed preload (`out/preload/index.js`) requires only `electron`.
 * 2. Scans synthetic fixtures (`cloud_invoice.txt`, `apartment_lease.txt`, `xss_note.md`).
 * 3. In `Documents` UI: verifies `unprovisioned` initial model state (0 auto-downloads),
 *    clicks `Import Model Folder` (`PV_TEST_DOC_MODEL_IMPORT_DIR`), runs `Extract All Text`,
 *    then clicks `Index Documents` and verifies semantic coverage (`3 docs`).
 * 4. Submits semantic searches in UI, verifying winning-chunk inert `<pre>` excerpts,
 *    `Native text` provenance badge, zero XSS execution, and `totalAppLiveWorkers <= 3`.
 * 5. Relaunches Electron against persisted `userDataDir` to verify model & index persistence.
 * 6. Verifies 100% bitwise source preservation across all synthetic fixtures.
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
import { createCanvas } from '@napi-rs/canvas'
import electronPath from 'electron'

const __dirname = resolve(fileURLToPath(import.meta.url), '..')
const rootDir = resolve(__dirname, '..')
const mode = process.argv.includes('--mode=unpacked') ? 'unpacked' : 'built'
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
const cachedOcrModelDir = resolve(
  rootDir,
  'spikes',
  'ocr-eval',
  '.model-cache',
  'tessdata_fast_eng@65727574'
)

function buildSyntheticScannedPdf(textLines) {
  const canvas = createCanvas(900, 320)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, 900, 320)
  ctx.fillStyle = '#000000'
  ctx.font = 'bold 42px sans-serif'
  textLines.forEach((line, idx) => ctx.fillText(line, 40, 110 + idx * 80))
  const jpegBuf = canvas.toBuffer('image/jpeg', 92)
  const streamContent = 'q 500 0 0 180 56 500 cm /Im0 Do Q'
  const obj1 = '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'
  const obj2 = '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n'
  const obj3 =
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n'
  const obj4Head = Buffer.from(
    `4 0 obj\n<< /Type /XObject /Subtype /Image /Width 900 /Height 320 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBuf.length} >>\nstream\n`,
    'latin1'
  )
  const obj4Tail = Buffer.from('\nendstream\nendobj\n', 'latin1')
  const obj5 = `5 0 obj\n<< /Length ${Buffer.byteLength(streamContent, 'latin1')} >>\nstream\n${streamContent}\nendstream\nendobj\n`
  const chunks = [Buffer.from('%PDF-1.4\n', 'latin1')]
  const offsets = [0]
  let pos = chunks[0].length
  const push = (b) => {
    offsets.push(pos)
    chunks.push(b)
    pos += b.length
  }
  push(Buffer.from(obj1, 'latin1'))
  push(Buffer.from(obj2, 'latin1'))
  push(Buffer.from(obj3, 'latin1'))
  offsets.push(pos)
  chunks.push(obj4Head, jpegBuf, obj4Tail)
  pos += obj4Head.length + jpegBuf.length + obj4Tail.length
  push(Buffer.from(obj5, 'latin1'))
  const xrefPos = pos
  let xref = 'xref\n0 6\n0000000000 65535 f \n'
  for (let i = 1; i <= 5; i += 1) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  xref += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`
  chunks.push(Buffer.from(xref, 'latin1'))
  return Buffer.concat(chunks)
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function getFreePort() {
  return new Promise((res, rej) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', rej)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close((err) => (err ? rej(err) : res(port)))
    })
  })
}

async function connectCdp(port, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs
  let pageTarget = null
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      if (res.ok) {
        const targets = await res.json()
        pageTarget = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
        if (pageTarget) break
      }
    } catch {
      // retry
    }
    await sleep(250)
  }
  if (!pageTarget) {
    throw new Error(`Timed out waiting for Electron CDP page target on port ${port}`)
  }

  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })

  let msgId = 1
  const pending = new Map()
  ws.onmessage = (event) => {
    const data = JSON.parse(event.data)
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
      pending.set(id, { resolve: res, reject: rej })
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
    PV_TEST_DOC_MODEL_IMPORT_DIR: cachedModelDir,
    PV_TEST_OCR_MODEL_IMPORT_DIR: cachedOcrModelDir
  }

  if (mode === 'unpacked') {
    const unpackedDir =
      process.env.PV_UNPACKED_DIR || join(rootDir, 'dist-stage-7d-search-verify', 'win-unpacked')
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

async function main() {
  const preloadPath = join(rootDir, 'out', 'preload', 'index.js')
  if (!existsSync(preloadPath)) {
    throw new Error(`Missing compiled preload bundle: ${preloadPath}. Run npm run build first.`)
  }
  if (!existsSync(cachedModelDir)) {
    throw new Error(`Missing cached BGE model directory at ${cachedModelDir}`)
  }
  if (!existsSync(join(cachedOcrModelDir, 'eng.traineddata'))) {
    throw new Error(`Missing cached OCR model directory at ${cachedOcrModelDir}`)
  }

  const preloadCode = readFileSync(preloadPath, 'utf8')
  const preloadRequires = [...preloadCode.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1])
  if (!preloadRequires.every((m) => m === 'electron')) {
    throw new Error(
      `Sandboxed preload requires non-electron modules: ${preloadRequires.join(', ')}`
    )
  }
  console.log('[PASS] 1. Sandboxed preload check: requires=[electron]')

  const tempRoot = mkdtempSync(join(tmpdir(), `pv-doc-sem-s3-ui-${mode}-`))
  const userDataDir = join(tempRoot, 'user-data')
  const fixturesDir = join(tempRoot, 'fixtures')
  mkdirSync(userDataDir, { recursive: true })
  mkdirSync(fixturesDir, { recursive: true })

  const oversizedBody =
    'Annual solar battery transfer switch ledger entry.\n' +
    'Routine calibration log line.\n'.repeat(18000)
  const fixtureDefs = [
    {
      name: 'cloud_invoice.txt',
      content: 'Northwind Cloud Infrastructure Invoice #INV-2026-441.\nTotal due: $1,250.00.\n'
    },
    {
      name: 'apartment_lease.txt',
      content: 'Residential Apartment Lease Agreement.\nMonthly rent: $2,400 due on the 1st.\n'
    },
    {
      name: 'xss_note.md',
      content:
        'Quarterly Hardware Budget <script>window.__xss=1</script> server rack upgrade $9,800.\n'
    },
    {
      name: 'oversized_ledger.txt',
      content: oversizedBody
    },
    {
      name: 'scanned_ocr_receipt.pdf',
      content: buildSyntheticScannedPdf(['PHARMACY PRESCRIPTION RECEIPT', 'COPAY DUE 45 USD'])
    }
  ]

  const snapshotsBefore = new Map()
  for (const f of fixtureDefs) {
    const abs = join(fixturesDir, f.name)
    if (Buffer.isBuffer(f.content)) {
      writeFileSync(abs, f.content)
    } else {
      writeFileSync(abs, f.content, 'utf8')
    }
    const st = statSync(abs)
    snapshotsBefore.set(abs, { size: st.size, mtimeMs: st.mtimeMs, sha: sha256File(abs) })
  }

  let proc = null
  let cdp = null
  const logs = []
  const attachLogs = (p) => {
    p.stdout?.on('data', (d) => logs.push(`[stdout] ${String(d)}`))
    p.stderr?.on('data', (d) => logs.push(`[stderr] ${String(d)}`))
  }

  try {
    // Session 1: Scan, import model, extract, index, and search via real UI
    const port1 = await getFreePort()
    proc = launchElectron(userDataDir, port1)
    attachLogs(proc)
    try {
      cdp = await connectCdp(port1)
    } catch (err) {
      console.error('Electron logs:\n' + logs.join(''))
      throw err
    }

    await cdp.evaluate(`
      (async () => {
        for (let i = 0; i < 60; i++) {
          if (window.api && typeof window.api.searchDocumentsSemantic === 'function') return true;
          await new Promise(r => setTimeout(r, 150));
        }
        throw new Error('window.api.searchDocumentsSemantic missing');
      })()
    `)
    console.log('[PASS] 2. Real Electron window.api Stage 7D methods exposed')

    // Scan fixtures via IPC
    await cdp.evaluate(`
      (async () => {
        const job = await window.api.startScan({ roots: [${JSON.stringify(fixturesDir)}] });
        for (let i = 0; i < 100; i++) {
          const latest = await window.api.getLatestScanJob();
          if (latest?.job?.status === 'completed') break;
          if (latest?.job?.status === 'failed') throw new Error('Scan failed: ' + JSON.stringify(latest.job));
          await new Promise(r => setTimeout(r, 150));
        }
        return job;
      })()
    `)

    // Switch to Documents tab and verify unprovisioned initial state (0 auto-downloads)
    await cdp.evaluate(`
      (async () => {
        let docBtn = null;
        for (let i = 0; i < 60; i++) {
          const btns = Array.from(document.querySelectorAll('button'));
          docBtn = btns.find(b => (b.textContent || '').includes('Documents'));
          if (docBtn) break;
          await new Promise(r => setTimeout(r, 100));
        }
        if (!docBtn) throw new Error('Documents nav button not found');
        docBtn.click();
        for (let i = 0; i < 40; i++) {
          const badge = document.querySelector('[data-testid="doc-semantic-model-state-badge"]');
          if (badge && badge.textContent === 'unprovisioned') return true;
          await new Promise(r => setTimeout(r, 100));
        }
        throw new Error('Expected unprovisioned semantic model state');
      })()
    `)
    console.log(
      '[PASS] 3. Documents tab reached & initial unprovisioned model verified (0 auto-downloads)'
    )

    // Import offline model via UI button
    await cdp.evaluate(`
      (async () => {
        const importBtn = document.querySelector('[data-testid="doc-semantic-model-import-btn"]');
        if (!importBtn) throw new Error('Import Model Folder button missing');
        importBtn.click();
        for (let i = 0; i < 80; i++) {
          const badge = document.querySelector('[data-testid="doc-semantic-model-state-badge"]');
          if (badge && badge.textContent === 'ready') return true;
          await new Promise(r => setTimeout(r, 150));
        }
        throw new Error('Model import did not reach ready state');
      })()
    `)
    console.log('[PASS] 4. Offline BGE model imported via UI')

    // Extract All Text, run offline OCR on scanned_ocr_receipt.pdf, then Index Documents via UI
    await cdp.evaluate(`
      (async () => {
        const extBtn = document.querySelector('[data-testid="documents-extract-scope-btn"]');
        if (!extBtn) throw new Error('Extract All Text button missing');
        extBtn.click();
        for (let i = 0; i < 120; i++) {
          const prog = await window.api.getDocumentExtractionProgress();
          if (prog && prog.status === 'completed') break;
          await new Promise(r => setTimeout(r, 150));
        }

        const ocrImportBtn = document.querySelector('[data-testid="ocr-model-import-btn"]');
        if (!ocrImportBtn) throw new Error('OCR Import button missing');
        ocrImportBtn.click();
        for (let i = 0; i < 80; i++) {
          const badge = document.querySelector('[data-testid="ocr-model-state-badge"]');
          if (badge && badge.textContent?.trim() === 'ready') break;
          await new Promise(r => setTimeout(r, 150));
        }

        const ocrRunBtn = document.querySelector('[data-testid="documents-ocr-scope-btn"]');
        if (!ocrRunBtn) throw new Error('Run OCR button missing');
        ocrRunBtn.click();
        for (let i = 0; i < 160; i++) {
          const prog = await window.api.getDocumentOcrProgress();
          if (prog && prog.status === 'completed') break;
          await new Promise(r => setTimeout(r, 150));
        }

        for (let i = 0; i < 40; i++) {
          const idxBtn = document.querySelector('[data-testid="doc-semantic-index-start-btn"]');
          if (idxBtn) { idxBtn.click(); break; }
          await new Promise(r => setTimeout(r, 100));
        }
        for (let i = 0; i < 160; i++) {
          const cov = document.querySelector('[data-testid="doc-semantic-coverage"]');
          if (
            cov &&
            cov.textContent &&
            cov.textContent.includes('5 docs') &&
            cov.textContent.includes('1 partial')
          ) {
            return true;
          }
          await new Promise(r => setTimeout(r, 150));
        }
        const finalCov = document.querySelector('[data-testid="doc-semantic-coverage"]')?.textContent;
        throw new Error('Semantic indexing did not reach 5 docs + 1 partial: ' + finalCov);
      })()
    `)
    console.log(
      '[PASS] 5. Native extraction, offline OCR & semantic indexing completed via UI (5 docs, 1 partial)'
    )

    // Submit semantic searches in UI: native, OCR provenance, and partial-index disclosure
    const searchSummary = await cdp.evaluate(`
      (async () => {
        const runUiSearch = async (queryText, trackValue = '') => {
          const input = document.querySelector('[data-testid="doc-semantic-search-input"]');
          const select = document.querySelector('[data-testid="doc-semantic-track-filter"]');
          const form = document.querySelector('[data-testid="doc-semantic-search-form"]');
          if (!input || !form || !select) throw new Error('Semantic search form missing');
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(input, queryText);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          if (select.value !== trackValue) {
            select.value = trackValue;
            select.dispatchEvent(new Event('change', { bubbles: true }));
          }
          await new Promise(r => setTimeout(r, 50));
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          for (let i = 0; i < 80; i++) {
            const firstCard = document.querySelector('.doc-semantic-result-card');
            if (firstCard && !document.querySelector('[data-testid="doc-semantic-search-cancel-btn"]')) {
              return {
                text: firstCard.textContent,
                hasPre: Boolean(firstCard.querySelector('pre.doc-semantic-snippet')),
                xssFlag: Boolean(window.__xss)
              };
            }
            await new Promise(r => setTimeout(r, 150));
          }
          throw new Error('Timed out waiting for semantic search results for: ' + queryText);
        };

        const nativeRes = await runUiSearch('cloud infrastructure invoice total due', '');
        const ocrRes = await runUiSearch('pharmacy prescription copay', 'ocr');
        const partialRes = await runUiSearch('annual solar battery transfer switch ledger', 'native');
        return { nativeRes, ocrRes, partialRes };
      })()
    `)
    if (
      !searchSummary.nativeRes.text.includes('cloud_invoice.txt') ||
      !searchSummary.nativeRes.text.includes('Native text') ||
      !searchSummary.nativeRes.hasPre ||
      searchSummary.nativeRes.xssFlag
    ) {
      throw new Error(
        `Unexpected native UI search summary: ${JSON.stringify(searchSummary.nativeRes)}`
      )
    }
    if (
      !searchSummary.ocrRes.text.includes('scanned_ocr_receipt.pdf') ||
      !searchSummary.ocrRes.text.includes('OCR text (machine-recognized)') ||
      !searchSummary.ocrRes.hasPre
    ) {
      throw new Error(`Unexpected OCR UI search summary: ${JSON.stringify(searchSummary.ocrRes)}`)
    }
    if (
      !searchSummary.partialRes.text.includes('oversized_ledger.txt') ||
      !searchSummary.partialRes.text.includes('Partially indexed:')
    ) {
      throw new Error(
        `Unexpected partial-index UI search summary: ${JSON.stringify(searchSummary.partialRes)}`
      )
    }

    const diag = await cdp.evaluate(`window.api.getPhotosDiagnostics()`)
    if (diag.totalAppLiveWorkers > 3) {
      throw new Error(`Worker budget exceeded: totalAppLiveWorkers=${diag.totalAppLiveWorkers}`)
    }
    console.log('[PASS] 6. UI semantic search, inert snippet & worker budget <= 3 verified')

    await stopElectron(proc, cdp.ws)
    proc = null
    cdp = null

    // Session 2: Relaunch against persisted userDataDir and verify persistence
    const port2 = await getFreePort()
    proc = launchElectron(userDataDir, port2)
    cdp = await connectCdp(port2)

    const persistedSummary = await cdp.evaluate(`
      (async () => {
        let docBtn = null;
        for (let i = 0; i < 80; i++) {
          const hasApi = Boolean(window.api && typeof window.api.searchDocumentsSemantic === 'function');
          const btns = Array.from(document.querySelectorAll('button'));
          docBtn = btns.find(b => (b.textContent || '').includes('Documents'));
          if (hasApi && docBtn) break;
          await new Promise(r => setTimeout(r, 150));
        }
        if (!docBtn) throw new Error('Documents nav button did not mount after restart');
        docBtn.click();

        let persistedReady = false;
        for (let i = 0; i < 60; i++) {
          const badge = document.querySelector('[data-testid="doc-semantic-model-state-badge"]');
          const cov = document.querySelector('[data-testid="doc-semantic-coverage"]');
          if (
            badge?.textContent === 'ready' &&
            cov?.textContent?.includes('5 docs') &&
            cov?.textContent?.includes('1 partial')
          ) {
            persistedReady = true;
            break;
          }
          await new Promise(r => setTimeout(r, 150));
        }
        if (!persistedReady) {
          throw new Error(
            'Timed out waiting for persisted ready model and 5 docs / 1 partial coverage after restart'
          );
        }

        const input = document.querySelector('[data-testid="doc-semantic-search-input"]');
        const form = document.querySelector('[data-testid="doc-semantic-search-form"]');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, 'monthly apartment rent');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 50));
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

        for (let i = 0; i < 80; i++) {
          const firstCard = document.querySelector('.doc-semantic-result-card');
          if (firstCard) return firstCard.textContent;
          await new Promise(r => setTimeout(r, 150));
        }
        throw new Error('Timed out waiting for persisted semantic search results');
      })()
    `)
    if (!persistedSummary.includes('apartment_lease.txt')) {
      throw new Error(`Expected apartment_lease.txt after restart, got: ${persistedSummary}`)
    }
    console.log('[PASS] 7. Restart persistence verified (model + index survived relaunch)')

    await stopElectron(proc, cdp.ws)
    proc = null
    cdp = null

    // Verify 100% bitwise source preservation
    for (const [abs, snap] of snapshotsBefore.entries()) {
      const st = statSync(abs)
      const sha = sha256File(abs)
      if (st.size !== snap.size || st.mtimeMs !== snap.mtimeMs || sha !== snap.sha) {
        throw new Error(`Source file modified during verification: ${abs}`)
      }
    }
    console.log('[PASS] 8. Bitwise source preservation verified (100% SHA-256 & mtime match)')
    console.log(`\n[verify-doc-semantic-search] ALL 8 REAL-ELECTRON CHECKS PASSED (${mode}).`)
  } finally {
    await stopElectron(proc, cdp?.ws)
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error('[verify-doc-semantic-search] FAILED:', err)
  process.exitCode = 1
})
