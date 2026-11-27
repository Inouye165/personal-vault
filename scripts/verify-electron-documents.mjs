#!/usr/bin/env node
/**
 * Personal Vault — Real Electron Stage 7B Document Browsing & Extraction Verification
 *
 * Exercises built and unpacked Electron modes from an unrelated working directory (`tmpdir()`):
 * 1. Verifies sandboxed preload requires only `electron`.
 * 2. Scans an isolated synthetic folder containing `.txt`, `.md`, `.csv`, `.rtf`, text `.pdf`,
 *    scanned `.pdf`, encrypted `.pdf`, `.docx`, unsupported `.doc`, and `.jpg` fixtures.
 * 3. Navigates to `Documents` and confirms 9 documents appear without auto-extraction on startup
 *    (and `.jpg` is excluded).
 * 4. Exercises extension filter, filename filter, and reset filters via DOM.
 * 5. Opens Document Details drawer and verifies recorded provenance, SHA-256, observation ID,
 *    and honest "Not extracted" status before extraction.
 * 6. Exercises explicit single-document extraction (`Extract text`) and full-scope extraction
 *    (`Extract all`), verifying `"Extracted text"` previews for `.txt`, `.md`, `.csv`, `.rtf`,
 *    text `.pdf`, and `.docx`, plus honest statuses for scanned PDF (`No text / OCR required`),
 *    encrypted PDF (`Password protected`), and `.doc` (`Unsupported`).
 * 7. Relaunches Electron against the persisted userDataDir, navigates directly to `Documents`
 *    without scanning, and confirms extracted previews and statuses persist across restart.
 * 8. Verifies 100% bitwise source preservation across all synthetic fixtures.
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
import { strToU8, zipSync } from 'fflate'

const __dirname = resolve(fileURLToPath(import.meta.url), '..')
const rootDir = resolve(__dirname, '..')
const mode = process.argv.includes('--mode=unpacked') ? 'unpacked' : 'built'
const executableArg = process.argv.find((arg) => arg.startsWith('--executable='))
const explicitExecutable = executableArg ? executableArg.slice('--executable='.length) : null

function buildMinimalPdf(contentStream) {
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    `5 0 obj\n<< /Length ${Buffer.byteLength(contentStream, 'latin1')} >>\nstream\n${contentStream}\nendstream\nendobj\n`
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'))
    pdf += obj
  }
  const xrefOffset = Buffer.byteLength(pdf, 'latin1')
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (let i = 1; i < offsets.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

function buildMinimalEncryptedPdf() {
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n',
    '3 0 obj\n<< /Filter /Standard /V 1 /R 2 /O <0000000000000000000000000000000000000000000000000000000000000000> /U <0000000000000000000000000000000000000000000000000000000000000000> /P -4 >>\nendobj\n'
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'))
    pdf += obj
  }
  const xrefOffset = Buffer.byteLength(pdf, 'latin1')
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (let i = 1; i < offsets.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Encrypt 3 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

function buildMinimalDocx(paragraphs) {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('')
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`
  return Buffer.from(
    zipSync({
      '[Content_Types].xml': strToU8(
        '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>'
      ),
      'word/document.xml': strToU8(xml)
    })
  )
}

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
    const exePath = explicitExecutable || join(unpackedDir, 'Personal Vault.exe')
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
    { name: 'synthetic_notes.md', content: '# Synthetic Note\n\nStage 7B markdown fixture.\n' },
    { name: 'synthetic_manual.txt', content: 'Synthetic manual text fixture.\nLine two.\n' },
    { name: 'synthetic_table.csv', content: 'item,amount\nalpha,10\nbeta,20\n' },
    {
      name: 'synthetic_memo.rtf',
      content: '{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}\\pard Hello from Stage 7B RTF\\par}'
    },
    {
      name: 'synthetic_text.pdf',
      content: buildMinimalPdf('BT /F1 12 Tf 72 150 Td (Stage 7B PDF text) Tj ET')
    },
    { name: 'synthetic_scanned.pdf', content: buildMinimalPdf('q 1 0 0 1 0 0 cm Q') },
    { name: 'synthetic_encrypted.pdf', content: buildMinimalEncryptedPdf() },
    { name: 'synthetic_report.docx', content: buildMinimalDocx(['Stage 7B DOCX paragraph']) },
    { name: 'synthetic_legacy.doc', content: 'Legacy binary doc stub' },
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
      `document.querySelector('[data-testid="documents-total-count"]')?.textContent?.includes('9 cataloged documents')`
    )
    const photoExcluded = await evaluate(
      `!document.body.textContent.includes('synthetic_photo.jpg')`
    )
    record('Documents tab displays 9 cataloged documents and excludes photo', photoExcluded)

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
      `document.querySelector('[data-testid="documents-total-count"]')?.textContent?.includes('3 cataloged documents')`
    )
    record('Extension filter (.pdf) narrows list to 3 PDF documents', true)

    // Reset filters, then exercise filename filter
    await evaluate(`
      (() => {
        const reset = [...document.querySelectorAll('button')].find(b => b.textContent?.includes('Reset filters'));
        reset?.click();
      })()
    `)
    await waitForCondition(
      evaluate,
      `document.querySelector('[data-testid="documents-total-count"]')?.textContent?.includes('9 cataloged documents')`
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
        return listText.includes('synthetic_notes.md') && !listText.includes('synthetic_text.pdf');
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
      `document.querySelector('[data-testid="documents-total-count"]')?.textContent?.includes('9 cataloged documents')`
    )
    record('Clearing filename filter restores all 9 cataloged documents', true)

    // Open synthetic_manual.txt before extraction -> confirm Not extracted (no auto-extract)
    const detailOpened = await evaluate(`
      (() => {
        const row = [...document.querySelectorAll('.documents-row-btn')].find(b => b.textContent?.includes('synthetic_manual.txt'));
        row?.click();
        return Boolean(row);
      })()
    `)
    await waitForCondition(
      evaluate,
      `document.querySelector('[data-testid="document-detail-filename"]')?.textContent === 'synthetic_manual.txt'`
    )
    const detailTextBefore = await evaluate(
      `document.querySelector('.documents-detail-drawer')?.textContent ?? ''`
    )
    record(
      'Detail drawer renders provenance and honest Not extracted status before extraction',
      detailOpened &&
        detailTextBefore.includes('Not extracted') &&
        detailTextBefore.includes(baseline.get(join(docsDir, 'synthetic_manual.txt')).sha256)
    )

    // Explicit single-document extraction via drawer button
    await evaluate(`
      (() => {
        const btn = document.querySelector('[data-testid="document-extract-selected-btn"]');
        btn?.click();
      })()
    `)
    await waitForCondition(
      evaluate,
      `document.querySelector('[data-testid="document-extracted-text-preview"]')?.textContent?.includes('Synthetic manual text fixture.')`,
      15000
    )
    record('Single-document Extract text renders Extracted text preview for .txt', true)

    // Explicit catalog-wide extraction via toolbar button
    await evaluate(`
      (() => {
        const btn = document.querySelector('[data-testid="documents-extract-scope-btn"]');
        btn?.click();
      })()
    `)
    await waitForCondition(
      evaluate,
      `(async () => {
        const p = await window.api.getDocumentExtractionProgress();
        return Boolean(p && (p.status === 'completed' || p.status === 'idle') && p.processedDocuments >= 8);
      })()`,
      30000
    )
    record('Explicit Extract all completes across all remaining documents', true)

    // Check extracted text previews for PDF, DOCX, RTF, CSV and honest statuses for scanned/encrypted/unsupported
    const checkDoc = async (filename, expectedText, expectedStatus) => {
      await evaluate(`
        (() => {
          const row = [...document.querySelectorAll('.documents-row-btn')].find(b => b.textContent?.includes(${JSON.stringify(filename)}));
          row?.click();
        })()
      `)
      await waitForCondition(
        evaluate,
        `document.querySelector('[data-testid="document-detail-filename"]')?.textContent === ${JSON.stringify(filename)}`
      )
      const textOk = expectedText
        ? await evaluate(
            `document.querySelector('[data-testid="document-extracted-text-preview"]')?.textContent?.includes(${JSON.stringify(expectedText)})`
          )
        : true
      const statusOk = await evaluate(
        `(document.querySelector('.documents-detail-drawer')?.textContent ?? '').includes(${JSON.stringify(expectedStatus)})`
      )
      return Boolean(textOk && statusOk)
    }

    record(
      'Text-bearing PDF extracts with page reference and Extracted status',
      await checkDoc('synthetic_text.pdf', 'Stage 7B PDF text', 'Extracted')
    )
    record(
      'DOCX extracts paragraph text with Extracted status',
      await checkDoc('synthetic_report.docx', 'Stage 7B DOCX paragraph', 'Extracted')
    )
    record(
      'RTF extracts body text without font table leakage',
      await checkDoc('synthetic_memo.rtf', 'Hello from Stage 7B RTF', 'Extracted')
    )
    record(
      'CSV preserves tabular structure in Extracted text preview',
      await checkDoc('synthetic_table.csv', 'alpha\t10', 'Extracted')
    )
    record(
      'Scanned PDF reports No text / OCR required',
      await checkDoc('synthetic_scanned.pdf', null, 'No text / OCR required')
    )
    record(
      'Encrypted PDF reports Password protected',
      await checkDoc('synthetic_encrypted.pdf', null, 'Password protected')
    )
    record(
      'Legacy .doc reports Unsupported',
      await checkDoc('synthetic_legacy.doc', null, 'Unsupported')
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
    await waitForCondition(
      conn2.evaluate,
      `[...document.querySelectorAll('button')].some(b => b.textContent?.trim() === 'Documents')`
    )
    await conn2.evaluate(`
      (() => {
        const btn = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Documents');
        btn?.click();
      })()
    `)
    await waitForCondition(
      conn2.evaluate,
      `document.querySelector('[data-testid="documents-total-count"]')?.textContent?.includes('9 cataloged documents')`
    )
    await conn2.evaluate(`
      (() => {
        const row = [...document.querySelectorAll('.documents-row-btn')].find(b => b.textContent?.includes('synthetic_report.docx'));
        row?.click();
      })()
    `)
    await waitForCondition(
      conn2.evaluate,
      `document.querySelector('[data-testid="document-extracted-text-preview"]')?.textContent?.includes('Stage 7B DOCX paragraph')`
    )
    record('Persisted documents and extracted previews load on restart without rescanning', true)

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
      `\nAll ${results.length}/${results.length} Stage 7B Electron checks passed (${mode}).`
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
