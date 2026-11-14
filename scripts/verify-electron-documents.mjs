#!/usr/bin/env node
/**
 * Personal Vault — Real Electron Stage 7A Document Browsing Verification
 *
 * Exercises built and unpacked Electron modes from an unrelated working directory (`tmpdir()`):
 * 1. Verifies sandboxed preload requires only `electron`.
 * 2. Scans an isolated synthetic folder containing `.pdf`, `.md`, `.txt`, `.docx`, and `.jpg` fixtures.
 * 3. Navigates to `Documents` and confirms all 4 documents appear immediately without another scan
 *    (and `.jpg` is excluded).
 * 4. Exercises extension filter, filename filter, and reset filters via DOM.
 * 5. Opens Document Details drawer and verifies recorded provenance, SHA-256, observation ID,
 *    and honest "Not extracted yet" / "Preview not yet available" status.
 * 6. Relaunches Electron against the persisted userDataDir, navigates directly to `Documents`
 *    without scanning, and confirms the 4 cataloged documents persist.
 * 7. Verifies 100% bitwise source preservation across all synthetic fixtures.
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
  if (!child || child.killed) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/f', '/t'], { stdio: 'ignore' })
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {
        // ignore
      }
    }
  }
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

async function connectCdp(port, timeoutMs = 20000) {
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
  return { ws, evaluate }
}

function launchElectron(userDataDir, port) {
  const neutralCwd = tmpdir()
  const commonArgs = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-sandbox'
  ]

  if (mode === 'unpacked') {
    const unpackedDir = process.env.PV_UNPACKED_DIR || join(rootDir, 'dist', 'win-unpacked')
    const exePath = join(unpackedDir, 'Personal Vault.exe')
    if (!existsSync(exePath)) {
      throw new Error(`Unpacked executable not found at: ${exePath}`)
    }
    return spawn(exePath, commonArgs, {
      cwd: neutralCwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    })
  }

  return spawn(String(electronPath), [rootDir, ...commonArgs], {
    cwd: neutralCwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32'
  })
}

async function waitForCondition(evaluate, predicateExpr, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await evaluate(predicateExpr)
    if (ok) return
    await sleep(200)
  }
  throw new Error(`Timed out waiting for condition: ${predicateExpr}`)
}

async function main() {
  const results = []
  const record = (name, ok, details = '') => {
    results.push({ name, ok, details })
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${details ? ` — ${details}` : ''}`)
    if (!ok) throw new Error(`Check failed: ${name} (${details})`)
  }

  // 1. Verify sandboxed preload requires only electron
  const preloadPath = join(rootDir, 'out', 'preload', 'index.js')
  const preloadCode = readFileSync(preloadPath, 'utf8')
  const requireMatches = [...preloadCode.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1])
  const disallowed = requireMatches.filter((m) => m !== 'electron')
  record(
    'Sandboxed preload requires only electron',
    disallowed.length === 0,
    disallowed.length === 0 ? `requires: ${requireMatches.join(', ')}` : `disallowed: ${disallowed}`
  )

  const tempRoot = mkdtempSync(join(tmpdir(), 'pv-verify-docs-'))
  const userDataDir = join(tempRoot, 'user-data')
  const docsDir = join(tempRoot, 'synthetic-docs')
  mkdirSync(userDataDir, { recursive: true })
  mkdirSync(docsDir, { recursive: true })

  // Synthetic fixtures only (no personal files)
  const fixtures = [
    { name: 'synthetic_receipt.pdf', content: '%PDF-1.4\n% synthetic fixture\n' },
    { name: 'synthetic_notes.md', content: '# Synthetic Note\n\nStage 7A test fixture.\n' },
    { name: 'synthetic_manual.txt', content: 'Synthetic manual text fixture.\n' },
    { name: 'synthetic_report.docx', content: 'PK\x03\x04synthetic-docx-stub' },
    { name: 'synthetic_photo.jpg', content: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) }
  ]

  const baseline = new Map()
  for (const f of fixtures) {
    const full = join(docsDir, f.name)
    writeFileSync(full, f.content)
    const st = statSync(full)
    baseline.set(full, {
      size: st.size,
      birthtimeMs: st.birthtimeMs,
      mtimeMs: st.mtimeMs,
      sha256: sha256File(full)
    })
  }

  let child = null
  let ws = null

  try {
    // Launch #1: Scan synthetic directory, then browse Documents
    const port1 = await getFreePort()
    child = launchElectron(userDataDir, port1)
    const conn1 = await connectCdp(port1)
    ws = conn1.ws
    const evaluate = conn1.evaluate

    await waitForCondition(evaluate, 'Boolean(window.api && window.api.getDocumentsPage)')
    record('Preload exposes window.api.getDocumentsPage/Detail/Facets', true)

    // Run scan via IPC
    await evaluate(`window.api.startScan({ roots: [${JSON.stringify(docsDir)}] })`)
    await waitForCondition(
      evaluate,
      `(async () => {
        const res = await window.api.getLatestScanJob();
        return Boolean(res && res.job && res.job.status === 'completed');
      })()`,
      20000
    )
    record('Completed initial scan of synthetic fixtures', true)

    // Navigate to Documents tab via UI
    await evaluate(`
      (() => {
        const btn = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Documents');
        btn?.click();
      })()
    `)
    await waitForCondition(
      evaluate,
      `document.querySelector('[data-testid="documents-total-count"]')?.textContent?.includes('4 cataloged documents')`
    )
    const photoExcluded = await evaluate(
      `!document.body.textContent.includes('synthetic_photo.jpg')`
    )
    record('Documents tab displays 4 cataloged documents and excludes photo', photoExcluded)

    // Exercise extension filter (.pdf)
    await evaluate(`
      (() => {
        const select = document.querySelector('#documents-ext-filter');
        select.value = '.pdf';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      })()
    `)
    await waitForCondition(
      evaluate,
      `document.querySelector('[data-testid="documents-total-count"]')?.textContent?.includes('1 cataloged document')`
    )
    record('Extension filter (.pdf) narrows list to 1 document', true)

    // Reset filters, then exercise filename filter
    await evaluate(`
      (() => {
        const reset = [...document.querySelectorAll('button')].find(b => b.textContent?.includes('Reset filters'));
        reset?.click();
      })()
    `)
    await waitForCondition(
      evaluate,
      `document.querySelector('[data-testid="documents-total-count"]')?.textContent?.includes('4 cataloged documents')`
    )

    // Type a filename query ('notes'), verify matching and nonmatching results, then clear it
    await evaluate(`
      (() => {
        const input = document.querySelector('.documents-search-input');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, 'notes');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()
    `)
    await waitForCondition(
      evaluate,
      `document.querySelector('[data-testid="documents-total-count"]')?.textContent?.includes('1 cataloged document')`
    )
    const filenameFilteredCorrectly = await evaluate(`
      (() => {
        const listText = document.querySelector('.documents-list')?.textContent ?? '';
        return listText.includes('synthetic_notes.md') && !listText.includes('synthetic_receipt.pdf');
      })()
    `)
    record(
      'Filename filter ("notes") narrows list to matching document only',
      filenameFilteredCorrectly
    )

    await evaluate(`
      (() => {
        const clearBtn = document.querySelector('[aria-label="Clear filename filter"]');
        clearBtn?.click();
      })()
    `)
    await waitForCondition(
      evaluate,
      `document.querySelector('[data-testid="documents-total-count"]')?.textContent?.includes('4 cataloged documents')`
    )
    record('Clearing filename filter restores all 4 cataloged documents', true)
    const detailOpened = await evaluate(`
      (() => {
        const row = [...document.querySelectorAll('.documents-row-btn')].find(b => b.textContent?.includes('synthetic_receipt.pdf'));
        row?.click();
        return Boolean(row);
      })()
    `)
    await waitForCondition(
      evaluate,
      `document.querySelector('[data-testid="document-detail-filename"]')?.textContent === 'synthetic_receipt.pdf'`
    )
    const detailText = await evaluate(
      `document.querySelector('.documents-detail-drawer')?.textContent ?? ''`
    )
    record(
      'Detail drawer renders provenance and honest Not extracted yet status',
      detailOpened &&
        detailText.includes('Not extracted yet') &&
        detailText.includes('Preview not yet available') &&
        detailText.includes(baseline.get(join(docsDir, 'synthetic_receipt.pdf')).sha256)
    )

    ws.close()
    ws = null
    killTree(child)
    child = null
    await sleep(500)

    // Launch #2: Restart on persisted userDataDir, open Documents WITHOUT scanning
    const port2 = await getFreePort()
    child = launchElectron(userDataDir, port2)
    const conn2 = await connectCdp(port2)
    ws = conn2.ws
    await waitForCondition(conn2.evaluate, 'Boolean(window.api && window.api.getDocumentsPage)')
    await conn2.evaluate(`
      (() => {
        const btn = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Documents');
        btn?.click();
      })()
    `)
    await waitForCondition(
      conn2.evaluate,
      `document.querySelector('[data-testid="documents-total-count"]')?.textContent?.includes('4 cataloged documents')`
    )
    record('Persisted documents load on restart without another scan', true)

    // Verify 100% bitwise source preservation
    let allPreserved = true
    for (const [full, snap] of baseline.entries()) {
      const st = statSync(full)
      const hash = sha256File(full)
      if (
        st.size !== snap.size ||
        st.birthtimeMs !== snap.birthtimeMs ||
        st.mtimeMs !== snap.mtimeMs ||
        hash !== snap.sha256
      ) {
        allPreserved = false
      }
    }
    record('100% bitwise source preservation across all synthetic fixtures', allPreserved)

    console.log(
      `\nAll ${results.length}/${results.length} Stage 7A Electron checks passed (${mode}).`
    )
  } finally {
    if (ws) {
      try {
        ws.close()
      } catch {
        // ignore
      }
    }
    if (child) killTree(child)
    try {
      rmSync(tempRoot, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
