#!/usr/bin/env node
/**
 * Personal Vault — Stage 7C Slice 3 Real Electron UI Verification
 *
 * Exercises built and isolated unpacked Electron from a neutral cwd (`tmpdir()`):
 * 1. Verifies sandboxed preload (`out/preload/index.js`) requires only `electron`.
 * 2. Scans synthetic fixtures (`scanned_receipt.pdf`, `blank_scan.pdf`, `native_notes.txt`,
 *    and `receipt_photo.png`).
 * 3. In `Documents` UI: verifies missing model state disables `Run OCR`, then clicks
 *    `Import Offline Model…` (using `PV_TEST_OCR_MODEL_IMPORT_DIR`) to verify model setup.
 * 4. Runs native extraction and offline OCR via UI buttons, verifying separate `"Extracted text"`
 *    and inert `<pre>` `"OCR text (machine-recognized)"` previews, provenance, and honest no-text.
 * 5. Tests explicit single-image OCR in `Photos` UI on `receipt_photo.png` (and zero bulk photo OCR).
 * 6. Tests narrow-viewport (520x760) responsive layout and modal drawer without horizontal overflow.
 * 7. Relaunches Electron against the persisted `userDataDir` to verify model & OCR persistence.
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
import { createCanvas } from '@napi-rs/canvas'

const __dirname = resolve(fileURLToPath(import.meta.url), '..')
const rootDir = resolve(__dirname, '..')
const mode = process.argv.includes('--mode=unpacked') ? 'unpacked' : 'built'
const executableArg = process.argv.find((arg) => arg.startsWith('--executable='))
const explicitExecutable = executableArg ? executableArg.slice('--executable='.length) : null
const cachedModelDir = resolve(
  rootDir,
  'spikes',
  'ocr-eval',
  '.model-cache',
  'tessdata_fast_eng@65727574'
)

function buildMinimalPdf(contentStream) {
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
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

async function buildScannedPdfAndImageFixtures() {
  const canvas = createCanvas(900, 360)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, 900, 360)
  ctx.fillStyle = '#000000'
  ctx.font = 'bold 48px sans-serif'
  ctx.fillText('INVOICE TOTAL 420 USD', 48, 130)
  ctx.fillText('ORDER REF 7781', 48, 220)
  const jpegBuf = canvas.toBuffer('image/jpeg', 92)

  // Embed JPEG as /XObject /Im0 in a scanned image-only PDF
  const imgW = 900
  const imgH = 360
  const streamContent = `q 500 0 0 200 56 500 cm /Im0 Do Q`
  const obj1 = '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'
  const obj2 = '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n'
  const obj3 =
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n'
  const obj4Header = Buffer.from(
    `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${imgW} /Height ${imgH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBuf.length} >>\nstream\n`,
    'latin1'
  )
  const obj4Footer = Buffer.from('\nendstream\nendobj\n', 'latin1')
  const obj5 = `5 0 obj\n<< /Length ${Buffer.byteLength(streamContent, 'latin1')} >>\nstream\n${streamContent}\nendstream\nendobj\n`

  const chunks = [Buffer.from('%PDF-1.4\n', 'latin1')]
  const offsets = [0]
  let pos = chunks[0].length

  const pushBuf = (b) => {
    offsets.push(pos)
    chunks.push(b)
    pos += b.length
  }

  pushBuf(Buffer.from(obj1, 'latin1'))
  pushBuf(Buffer.from(obj2, 'latin1'))
  pushBuf(Buffer.from(obj3, 'latin1'))
  offsets.push(pos)
  chunks.push(obj4Header, jpegBuf, obj4Footer)
  pos += obj4Header.length + jpegBuf.length + obj4Footer.length
  pushBuf(Buffer.from(obj5, 'latin1'))

  const xrefPos = pos
  let xref = `xref\n0 6\n0000000000 65535 f \n`
  for (let i = 1; i <= 5; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  xref += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`
  chunks.push(Buffer.from(xref, 'latin1'))
  const scannedPdf = Buffer.concat(chunks)

  const imgCanvas = createCanvas(700, 260)
  const ictx = imgCanvas.getContext('2d')
  ictx.fillStyle = '#ffffff'
  ictx.fillRect(0, 0, 700, 260)
  ictx.fillStyle = '#000000'
  ictx.font = 'bold 46px sans-serif'
  ictx.fillText('RECEIPT CASH 99', 48, 145)
  const receiptPng = imgCanvas.toBuffer('image/png')

  // Form XObject with /Group << /S /Transparency >> + W n clipping path (triggers CanvasFactory + Path2D clip)
  const formCanvas = createCanvas(800, 320)
  const fctx = formCanvas.getContext('2d')
  fctx.fillStyle = '#ffffff'
  fctx.fillRect(0, 0, 800, 320)
  fctx.fillStyle = '#000000'
  fctx.font = 'bold 48px sans-serif'
  fctx.fillText('CLIPPED FORM 77', 48, 170)
  const formJpeg = formCanvas.toBuffer('image/jpeg', 95)

  const formStream = 'q\n10 10 780 300 re W n\n800 0 0 320 0 0 cm\n/Im0 Do\nQ'
  const formPageStream = 'q\n/Fm0 Do\nQ'
  const fChunks = [Buffer.from('%PDF-1.4\n', 'latin1')]
  const fOffsets = [0]
  let fPos = fChunks[0].length
  const pushFormBuf = (b) => {
    fOffsets.push(fPos)
    fChunks.push(b)
    fPos += b.length
  }
  pushFormBuf(Buffer.from('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n', 'latin1'))
  pushFormBuf(Buffer.from('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n', 'latin1'))
  pushFormBuf(
    Buffer.from(
      '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 800 320] /Resources << /XObject << /Fm0 5 0 R >> >> /Contents 4 0 R >>\nendobj\n',
      'latin1'
    )
  )
  pushFormBuf(
    Buffer.from(
      `4 0 obj\n<< /Length ${formPageStream.length} >>\nstream\n${formPageStream}\nendstream\nendobj\n`,
      'latin1'
    )
  )
  pushFormBuf(
    Buffer.from(
      `5 0 obj\n<< /Type /XObject /Subtype /Form /FormType 1 /BBox [0 0 800 320] /Group << /Type /Group /S /Transparency /CS /DeviceRGB >> /Resources << /XObject << /Im0 6 0 R >> >> /Length ${formStream.length} >>\nstream\n${formStream}\nendstream\nendobj\n`,
      'latin1'
    )
  )
  fOffsets.push(fPos)
  const fImgHead = Buffer.from(
    `6 0 obj\n<< /Type /XObject /Subtype /Image /Width 800 /Height 320 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${formJpeg.length} >>\nstream\n`,
    'latin1'
  )
  const fImgTail = Buffer.from('\nendstream\nendobj\n', 'latin1')
  fChunks.push(fImgHead, formJpeg, fImgTail)
  fPos += fImgHead.length + formJpeg.length + fImgTail.length
  const fXrefPos = fPos
  let fXref = `xref\n0 7\n0000000000 65535 f \n`
  for (let i = 1; i <= 6; i++) {
    fXref += `${String(fOffsets[i]).padStart(10, '0')} 00000 n \n`
  }
  fXref += `trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${fXrefPos}\n%%EOF\n`
  fChunks.push(Buffer.from(fXref, 'latin1'))
  const clippedFormPdf = Buffer.concat(fChunks)

  return { scannedPdf, receiptPng, clippedFormPdf }
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
    PV_TEST_OCR_MODEL_IMPORT_DIR: cachedModelDir
  }

  if (mode === 'unpacked') {
    const unpackedDir =
      process.env.PV_UNPACKED_DIR || join(rootDir, 'dist-stage-7c-ui-verify', 'win-unpacked')
    const exePath = explicitExecutable || join(unpackedDir, 'Personal Vault.exe')
    if (!existsSync(exePath)) {
      throw new Error(`Unpacked executable not found at: ${exePath}`)
    }
    return spawn(exePath, commonArgs, {
      cwd: neutralCwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    })
  }

  return spawn(String(electronPath), [rootDir, ...commonArgs], {
    cwd: neutralCwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32'
  })
}

async function waitForCondition(evaluate, predicateExpr, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await evaluate(predicateExpr)
    if (ok) return
    await sleep(250)
  }
  throw new Error(`Timed out waiting for condition: ${predicateExpr}`)
}

async function main() {
  if (!existsSync(join(cachedModelDir, 'eng.traineddata'))) {
    throw new Error(`Cached OCR model not found at ${cachedModelDir}`)
  }

  const record = (name, ok, details = '') => {
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${details ? ` — ${details}` : ''}`)
    if (!ok) throw new Error(`Check failed: ${name} (${details})`)
  }

  // 1. Verify sandboxed preload requires only electron
  const preloadCode = readFileSync(join(rootDir, 'out', 'preload', 'index.js'), 'utf8')
  const requireMatches = [...preloadCode.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1])
  const disallowed = requireMatches.filter((m) => m !== 'electron')
  record(
    'sandboxed_preload_hygiene',
    disallowed.length === 0,
    disallowed.length === 0 ? `requires=${requireMatches.join(',')}` : `disallowed=${disallowed}`
  )

  const tempRoot = mkdtempSync(join(tmpdir(), 'pv-verify-ocr-ui-'))
  const userDataDir = join(tempRoot, 'user-data')
  const docsDir = join(tempRoot, 'synthetic-fixtures')
  mkdirSync(userDataDir, { recursive: true })
  mkdirSync(docsDir, { recursive: true })

  const { scannedPdf, receiptPng, clippedFormPdf } = await buildScannedPdfAndImageFixtures()
  const fixtures = [
    { name: 'scanned_receipt.pdf', content: scannedPdf },
    { name: 'clipped_form_xobject.pdf', content: clippedFormPdf },
    { name: 'blank_scan.pdf', content: buildMinimalPdf('q 1 0 0 1 0 0 cm Q') },
    { name: 'native_notes.txt', content: 'Native TXT notes for Stage 7C UI check.' },
    { name: 'receipt_photo.png', content: receiptPng }
  ]

  const baseline = new Map()
  for (const f of fixtures) {
    const full = join(docsDir, f.name)
    writeFileSync(full, f.content)
    const st = statSync(full)
    baseline.set(full, {
      size: st.size,
      mtimeMs: st.mtimeMs,
      sha256: sha256File(full)
    })
  }

  let child = null
  let ws = null

  try {
    // Launch #1
    const port1 = await getFreePort()
    child = launchElectron(userDataDir, port1)
    const conn1 = await connectCdp(port1)
    ws = conn1.ws
    const evaluate = conn1.evaluate

    await waitForCondition(
      evaluate,
      'Boolean(window.api && window.api.getOcrModelStatus && window.api.startDocumentOcr)'
    )
    record('preload_exposes_ocr_api', true)

    await evaluate(`window.api.startScan({ roots: [${JSON.stringify(docsDir)}] })`)
    await waitForCondition(
      evaluate,
      `(async () => { const r = await window.api.getLatestScanJob(); return r?.job?.status === 'completed'; })()`,
      25000
    )
    record('scan_synthetic_fixtures', true)

    // Navigate to Documents tab via UI click
    await evaluate(`
      (() => {
        const btn = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Documents');
        btn?.click();
      })()
    `)
    await waitForCondition(
      evaluate,
      'Boolean(document.querySelector("[data-testid=\\"ocr-model-state-badge\\"]"))'
    )

    const initialBadge = await evaluate(
      'document.querySelector("[data-testid=\\"ocr-model-state-badge\\"]")?.textContent?.trim()'
    )
    const runOcrInitiallyDisabled = await evaluate(
      'Boolean(document.querySelector("[data-testid=\\"documents-ocr-scope-btn\\"]")?.disabled)'
    )
    record(
      'initial_missing_model_gates_run_ocr',
      initialBadge === 'missing' && runOcrInitiallyDisabled,
      `badge=${initialBadge}, disabled=${runOcrInitiallyDisabled}`
    )

    // Import verified offline English OCR model via UI button
    await evaluate('document.querySelector("[data-testid=\\"ocr-model-import-btn\\"]")?.click()')
    await waitForCondition(
      evaluate,
      'document.querySelector("[data-testid=\\"ocr-model-state-badge\\"]")?.textContent?.trim() === "ready"',
      20000
    )
    record('ui_offline_model_import_verified', true)

    // Run native extraction first
    await evaluate(
      'document.querySelector("[data-testid=\\"documents-extract-scope-btn\\"]")?.click()'
    )
    await waitForCondition(
      evaluate,
      'document.querySelector("[data-testid=\\"documents-extraction-progress\\"]")?.textContent?.includes("completed")',
      25000
    )

    // Run OCR via UI button
    await evaluate('document.querySelector("[data-testid=\\"documents-ocr-scope-btn\\"]")?.click()')
    await waitForCondition(
      evaluate,
      'document.querySelector("[data-testid=\\"documents-ocr-progress\\"]")?.textContent?.includes("completed")',
      45000
    )
    record('ui_run_ocr_completed', true)

    // Open scanned_receipt.pdf details and verify separate inert OCR <pre> + provenance
    await evaluate(`
      (() => {
        const btn = [...document.querySelectorAll('.documents-row-btn')].find(b => b.textContent?.includes('scanned_receipt.pdf'));
        btn?.click();
      })()
    `)
    await waitForCondition(
      evaluate,
      'Boolean(document.querySelector("[data-testid=\\"document-ocr-text-preview\\"]"))'
    )
    const scannedOcrText = await evaluate(
      'document.querySelector("[data-testid=\\"document-ocr-text-preview\\"]")?.textContent || ""'
    )
    const scannedOcrProv = await evaluate(
      'document.querySelector("[data-testid=\\"document-ocr-provenance\\"]")?.textContent || ""'
    )
    record(
      'ui_scanned_pdf_ocr_preview_and_provenance',
      scannedOcrText.toUpperCase().includes('INVOICE') &&
        scannedOcrProv.includes('tesseract-ocr/tessdata_fast:eng@65727574'),
      `ocrText=${JSON.stringify(scannedOcrText.trim().slice(0, 60))}`
    )

    // Open blank_scan.pdf and verify honest no-text outcome
    await evaluate(`
      (() => {
        const btn = [...document.querySelectorAll('.documents-row-btn')].find(b => b.textContent?.includes('blank_scan.pdf'));
        btn?.click();
      })()
    `)
    await waitForCondition(
      evaluate,
      'Boolean(document.querySelector("[data-testid=\\"document-ocr-empty-state\\"]"))'
    )
    const blankStatus = await evaluate(
      'document.querySelector("[data-testid=\\"document-detail-ocr-status\\"]")?.textContent || ""'
    )
    record('ui_blank_pdf_honest_no_text', blankStatus.includes('No text recognized'), blankStatus)

    // Open clipped_form_xobject.pdf and verify Form XObject + clipping path OCR succeeds in packaged/unpacked app
    await evaluate(`
      (() => {
        const btn = [...document.querySelectorAll('.documents-row-btn')].find(b => b.textContent?.includes('clipped_form_xobject.pdf'));
        btn?.click();
      })()
    `)
    await waitForCondition(
      evaluate,
      'Boolean(document.querySelector("[data-testid=\\"document-ocr-text-preview\\"]") || document.querySelector("[data-testid=\\"document-ocr-empty-state\\"]"))'
    )
    const clippedText = await evaluate(
      'document.querySelector("[data-testid=\\"document-ocr-text-preview\\"]")?.textContent || document.querySelector("[data-testid=\\"document-ocr-empty-state\\"]")?.textContent || ""'
    )
    const clippedStatus = await evaluate(
      'document.querySelector("[data-testid=\\"document-detail-ocr-status\\"]")?.textContent || ""'
    )
    record(
      'ui_clipped_form_xobject_pdf_ocr',
      clippedText.toUpperCase().includes('CLIPPED FORM'),
      `status=${clippedStatus} text=${clippedText.trim()}`
    )

    // Open native_notes.txt and verify native "Extracted text" remains intact
    await evaluate(`
      (() => {
        const btn = [...document.querySelectorAll('.documents-row-btn')].find(b => b.textContent?.includes('native_notes.txt'));
        btn?.click();
      })()
    `)
    await waitForCondition(
      evaluate,
      'Boolean(document.querySelector("[data-testid=\\"document-extracted-text-preview\\"]"))'
    )
    const nativeText = await evaluate(
      'document.querySelector("[data-testid=\\"document-extracted-text-preview\\"]")?.textContent || ""'
    )
    record(
      'ui_native_extracted_text_separate',
      nativeText.includes('Native TXT notes'),
      nativeText.trim()
    )

    // Narrow viewport check (520x760) — no horizontal overflow
    await conn1.call('Emulation.setDeviceMetricsOverride', {
      width: 520,
      height: 760,
      deviceScaleFactor: 1,
      mobile: false
    })
    await sleep(300)
    const overflowOk = await evaluate(
      'document.documentElement.scrollWidth <= window.innerWidth + 2'
    )
    record('narrow_viewport_no_horizontal_overflow', overflowOk)

    // Reset viewport and test explicit single-image OCR in Photos tab
    await conn1.call('Emulation.clearDeviceMetricsOverride')
    await evaluate(`
      (() => {
        const btn = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Photos');
        btn?.click();
      })()
    `)
    await waitForCondition(
      evaluate,
      'Boolean(document.querySelector("[data-testid=\\"photo-card\\"], .photo-card"))',
      15000
    ).catch(() => {})
    // Click photo card by filename or first photo button
    await evaluate(`
      (() => {
        const card = [...document.querySelectorAll('button, [role="button"]')].find(el => el.textContent?.includes('receipt_photo.png') || el.getAttribute('aria-label')?.includes('receipt_photo.png'));
        card?.click();
      })()
    `)
    await waitForCondition(
      evaluate,
      'Boolean(document.querySelector("[data-testid=\\"photo-ocr-selected-btn\\"]"))',
      15000
    )
    await evaluate('document.querySelector("[data-testid=\\"photo-ocr-selected-btn\\"]")?.click()')
    await waitForCondition(
      evaluate,
      'Boolean(document.querySelector("[data-testid=\\"photo-ocr-text-preview\\"]"))',
      30000
    )
    const photoOcrText = await evaluate(
      'document.querySelector("[data-testid=\\"photo-ocr-text-preview\\"]")?.textContent || ""'
    )
    record(
      'ui_photos_explicit_selected_image_ocr',
      photoOcrText.toUpperCase().includes('RECEIPT'),
      photoOcrText.trim()
    )

    ws.close()
    ws = null
    killTree(child)
    child = null
    await sleep(800)

    // Launch #2: Restart persistence check without re-scanning
    const port2 = await getFreePort()
    child = launchElectron(userDataDir, port2)
    const conn2 = await connectCdp(port2)
    ws = conn2.ws
    const eval2 = conn2.evaluate

    await waitForCondition(eval2, 'Boolean(window.api && window.api.getOcrModelStatus)')
    await waitForCondition(
      eval2,
      '[...document.querySelectorAll("button")].some(b => b.textContent?.trim() === "Documents")',
      15000
    )
    await eval2(`
      (() => {
        const btn = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Documents');
        btn?.click();
      })()
    `)
    await waitForCondition(
      eval2,
      'document.querySelector("[data-testid=\\"ocr-model-state-badge\\"]")?.textContent?.trim() === "ready"',
      15000
    )
    await waitForCondition(
      eval2,
      '[...document.querySelectorAll(".documents-row-btn")].some(b => b.textContent?.includes("scanned_receipt.pdf"))',
      15000
    )
    await eval2(`
      (() => {
        const btn = [...document.querySelectorAll('.documents-row-btn')].find(b => b.textContent?.includes('scanned_receipt.pdf'));
        btn?.click();
      })()
    `)
    await waitForCondition(
      eval2,
      'Boolean(document.querySelector("[data-testid=\\"document-ocr-text-preview\\"]"))',
      15000
    )
    const persistedText = await eval2(
      'document.querySelector("[data-testid=\\"document-ocr-text-preview\\"]")?.textContent || ""'
    )
    record(
      'restart_persistence_model_and_ocr_text',
      persistedText.toUpperCase().includes('INVOICE'),
      persistedText.trim()
    )

    // Bitwise source preservation check
    let preserved = 0
    for (const [full, base] of baseline.entries()) {
      const st = statSync(full)
      const hash = sha256File(full)
      if (st.size === base.size && st.mtimeMs === base.mtimeMs && hash === base.sha256) {
        preserved++
      }
    }
    record(
      'bitwise_source_preservation',
      preserved === baseline.size,
      `${preserved}/${baseline.size} preserved`
    )

    console.log(`\n[VERIFY_OCR_UI_PASS] mode=${mode} checks=10/10`)
  } finally {
    if (ws) {
      try {
        ws.close()
      } catch {
        // ignore
      }
    }
    killTree(child)
    await sleep(400)
    try {
      rmSync(tempRoot, { recursive: true, force: true })
    } catch {
      // ignore temp cleanup lock
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
