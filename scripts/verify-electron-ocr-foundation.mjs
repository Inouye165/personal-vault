#!/usr/bin/env node
/**
 * Personal Vault — Real Electron Stage 7C Slice 1 (OCR Foundation) Verification
 *
 * Exercises compiled production OCR foundation modules (`out/main/document_ocr.js` and
 * `out/main/document_ocr_worker.js`) inside the real Electron runtime from a neutral
 * `os.tmpdir()` working directory in both built (`--mode=built`) and separate unpacked
 * (`--mode=unpacked`, outputting to `dist-stage-7c-foundation-verify` so `dist/` and
 * `dist-stage-7b-verify/` remain untouched) modes:
 *
 * 1. Sandboxed preload check (`out/preload/index.js` requires only `electron`) and,
 *    in unpacked mode, `app.asar.unpacked` asset hygiene (filtered LSTM `.wasm` + `@napi-rs`).
 * 2. `OcrModelManager`: offline `missing` initialization (`0` network calls), storage
 *    containment checks, corrupt/tampered rejection, verified offline import of pinned
 *    `eng.traineddata`, atomic promotion failure rollback, loopback verified download,
 *    disallowed redirect rejection, active cancellation, and staging/backup cleanup.
 * 3. `DocumentOcrWorkerRunner` + `document_ocr_worker.js`:
 *    - Offline recognition on synthetic receipt PNG & TIFF and 2-page scanned PDF.
 *    - Conservative mixed-PDF policy fixtures: `header_plus_scanned_body.pdf` (native
 *      header never suppresses OCR on scanned body), `native_body_plus_small_logo.pdf`
 *      (small corner logo skipped from OCR), and 3-page `mixed_policy_document.pdf`.
 *    - Honest `ocr_no_text` on blank PNG & blank scanned PDF; `unsupported` on `.bmp`.
 *    - Explicit `64 MiB` input limit (`34 MiB` accepted vs `32 MiB` native cap; `65 MiB` truncated).
 *    - Corrupt & missing model offline rejection (`0` network attempts, `0` nested workers).
 *    - Shared `AppWorkerBudget(3)` contention (`<= 3`), spawn-failure reservation release,
 *      active mid-OCR cancellation + fresh worker recovery, and `0` final workers/reservations.
 *    - 100% bitwise source preservation across all synthetic fixtures and `eng.traineddata`.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import electronPath from 'electron'

const __dirname = resolve(fileURLToPath(import.meta.url), '..')
const rootDir = resolve(__dirname, '..')
const requireFromRoot = createRequire(join(rootDir, 'package.json'))

const isUnpackedMode = process.argv.includes('--mode=unpacked')
const executableArg = process.argv.find((arg) => arg.startsWith('--executable='))
const outputDirArg = process.argv.find((arg) => arg.startsWith('--output-dir='))
const trainedDataArg = process.argv.find((arg) => arg.startsWith('--traineddata='))

const unpackedOutputDirName = outputDirArg
  ? outputDirArg.slice('--output-dir='.length)
  : 'dist-stage-7c-foundation-verify'
const unpackedOutputRoot = resolve(rootDir, unpackedOutputDirName)

function getDefaultTrainedDataPath() {
  if (trainedDataArg) {
    return resolve(trainedDataArg.slice('--traineddata='.length))
  }
  if (process.env.PV_OCR_TRAINEDDATA_PATH) {
    return resolve(process.env.PV_OCR_TRAINEDDATA_PATH)
  }
  return join(
    rootDir,
    'spikes',
    'ocr-eval',
    '.model-cache',
    'tessdata_fast_eng@65727574',
    'eng.traineddata'
  )
}

function getUnpackedExecutablePath(outRoot) {
  if (executableArg) {
    return resolve(executableArg.slice('--executable='.length))
  }
  if (process.platform === 'win32') {
    return join(outRoot, 'win-unpacked', 'Personal Vault.exe')
  }
  if (process.platform === 'darwin') {
    return join(
      outRoot,
      'mac-unpacked',
      'Personal Vault.app',
      'Contents',
      'MacOS',
      'Personal Vault'
    )
  }
  return join(outRoot, 'linux-unpacked', 'personal-vault')
}

function getUnpackedAsarPathFromExe(exePath) {
  if (process.platform === 'darwin') {
    return resolve(exePath, '..', '..', 'Resources', 'app.asar')
  }
  return resolve(exePath, '..', 'resources', 'app.asar')
}

function assertCondition(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function escapePdfLiteral(text) {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

async function renderHighContrastTextPng(canvasLib, lines, width = 1400, height = 900) {
  const canvas = canvasLib.createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)

  ctx.fillStyle = '#000000'
  ctx.font = 'bold 42px sans-serif'
  ctx.fillText(lines[0] ?? '', 56, 94)

  ctx.strokeStyle = '#000000'
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.moveTo(56, 122)
  ctx.lineTo(width - 56, 122)
  ctx.stroke()

  ctx.font = '34px sans-serif'
  let y = 186
  for (const line of lines.slice(1)) {
    ctx.fillText(line, 56, y)
    y += 62
  }
  return canvas.toBuffer('image/png')
}

function assembleRawPdf(objects, rootObjId = 1) {
  const chunks = [Buffer.from('%PDF-1.4\n%\xFF\xFF\xFF\xFF\n', 'binary')]
  let offset = chunks[0].byteLength
  const maxId = Math.max(...objects.map((o) => o.id))
  const offsets = new Array(maxId + 1).fill(0)

  for (const obj of objects) {
    offsets[obj.id] = offset
    const header = Buffer.from(`${obj.id} 0 obj\n`, 'ascii')
    const footer = Buffer.from('\nendobj\n', 'ascii')
    chunks.push(header, obj.body, footer)
    offset += header.byteLength + obj.body.byteLength + footer.byteLength
  }

  const xrefOffset = offset
  let xref = `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`
  for (let id = 1; id <= maxId; id += 1) {
    xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`
  }
  xref += `trailer\n<< /Size ${maxId + 1} /Root ${rootObjId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  chunks.push(Buffer.from(xref, 'ascii'))
  return Buffer.concat(chunks)
}

function makeStreamObject(id, dictEntries, streamBytes) {
  const header = Buffer.from(
    `<< ${dictEntries} /Length ${streamBytes.byteLength} >>\nstream\n`,
    'ascii'
  )
  const footer = Buffer.from('\nendstream', 'ascii')
  return { id, body: Buffer.concat([header, streamBytes, footer]) }
}

async function decodeToJpeg(sharpLib, pngBytes) {
  const meta = await sharpLib(pngBytes).metadata()
  const jpeg = await sharpLib(pngBytes).removeAlpha().jpeg({ quality: 95 }).toBuffer()
  return { jpeg, width: meta.width, height: meta.height }
}

function buildImageOnlyPdf(pages) {
  const objects = []
  const pageIds = []
  let nextId = 3

  for (const page of pages) {
    const pageId = nextId++
    const contentId = nextId++
    const imageId = nextId++
    pageIds.push(pageId)
    const contentBytes = Buffer.from('q 612 0 0 792 0 0 cm /Im0 Do Q\n', 'ascii')
    objects.push({
      id: pageId,
      body: Buffer.from(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`,
        'ascii'
      )
    })
    objects.push(makeStreamObject(contentId, '', contentBytes))
    objects.push(
      makeStreamObject(
        imageId,
        `/Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`,
        page.jpeg
      )
    )
  }

  const kids = pageIds.map((id) => `${id} 0 R`).join(' ')
  return assembleRawPdf([
    { id: 1, body: Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'ascii') },
    {
      id: 2,
      body: Buffer.from(`<< /Type /Pages /Kids [${kids}] /Count ${pageIds.length} >>`, 'ascii')
    },
    ...objects
  ])
}

function buildHeaderPlusScannedBodyPdf(scannedBody) {
  const headerLines = [
    'PERSONAL VAULT ARCHIVE - SELECTABLE RUNNING HEADER',
    'Document Control Ref: HDR-90210 | Indexed Header Metadata Only'
  ]
  const textOps = headerLines
    .map((line, i) => `BT /F1 12 Tf 42 ${752 - i * 18} Td (${escapePdfLiteral(line)}) Tj ET`)
    .join('\n')
  const content = Buffer.from(`${textOps}\nq 528 0 0 580 42 80 cm /ImBody Do Q\n`, 'ascii')

  return assembleRawPdf([
    { id: 1, body: Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'ascii') },
    { id: 2, body: Buffer.from('<< /Type /Pages /Kids [4 0 R] /Count 1 >>', 'ascii') },
    { id: 3, body: Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', 'ascii') },
    {
      id: 4,
      body: Buffer.from(
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> /XObject << /ImBody 6 0 R >> >> /Contents 5 0 R >>',
        'ascii'
      )
    },
    makeStreamObject(5, '', content),
    makeStreamObject(
      6,
      `/Type /XObject /Subtype /Image /Width ${scannedBody.width} /Height ${scannedBody.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`,
      scannedBody.jpeg
    )
  ])
}

function buildNativeBodyPlusSmallLogoPdf(logo) {
  const bodyLines = [
    'DIGITAL STATEMENT BODY SECTION 301',
    'This page contains complete selectable native PDF text.',
    'A tiny corner brand mark is painted at top right and must not trigger OCR.',
    'Verified Reference Token: NATIVE-LOGO-EXEMPT-551'
  ]
  const textOps = bodyLines
    .map((line, i) => `BT /F1 14 Tf 48 ${680 - i * 28} Td (${escapePdfLiteral(line)}) Tj ET`)
    .join('\n')
  const content = Buffer.from(`q 90 0 0 36 474 726 cm /ImLogo Do Q\n${textOps}\n`, 'ascii')

  return assembleRawPdf([
    { id: 1, body: Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'ascii') },
    { id: 2, body: Buffer.from('<< /Type /Pages /Kids [4 0 R] /Count 1 >>', 'ascii') },
    { id: 3, body: Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', 'ascii') },
    {
      id: 4,
      body: Buffer.from(
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> /XObject << /ImLogo 6 0 R >> >> /Contents 5 0 R >>',
        'ascii'
      )
    },
    makeStreamObject(5, '', content),
    makeStreamObject(
      6,
      `/Type /XObject /Subtype /Image /Width ${logo.width} /Height ${logo.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`,
      logo.jpeg
    )
  ])
}

function buildMixedThreePagePdf(logo, scannedBody) {
  const p1Text = [
    'DIGITAL COVER PAGE 1001',
    'Native digital cover page with small decorative emblem only.',
    'Cover Reference: COVER-7710'
  ]
    .map((line, i) => `BT /F1 14 Tf 48 ${690 - i * 26} Td (${escapePdfLiteral(line)}) Tj ET`)
    .join('\n')
  const p1Content = Buffer.from(`q 84 0 0 32 480 730 cm /ImLogo Do Q\n${p1Text}\n`, 'ascii')

  const p2Header = [
    'PERSONAL VAULT ARCHIVE - SELECTABLE RUNNING HEADER',
    'Addendum Page 2 Header Stamp'
  ]
    .map((line, i) => `BT /F1 12 Tf 42 ${752 - i * 18} Td (${escapePdfLiteral(line)}) Tj ET`)
    .join('\n')
  const p2Content = Buffer.from(`${p2Header}\nq 528 0 0 580 42 80 cm /ImScan Do Q\n`, 'ascii')
  const p3Content = Buffer.from('0.85 0.85 0.85 RG 2 w 72 72 468 648 re S\n', 'ascii')

  return assembleRawPdf([
    { id: 1, body: Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'ascii') },
    { id: 2, body: Buffer.from('<< /Type /Pages /Kids [4 0 R 7 0 R 10 0 R] /Count 3 >>', 'ascii') },
    { id: 3, body: Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', 'ascii') },
    {
      id: 4,
      body: Buffer.from(
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> /XObject << /ImLogo 6 0 R >> >> /Contents 5 0 R >>',
        'ascii'
      )
    },
    makeStreamObject(5, '', p1Content),
    makeStreamObject(
      6,
      `/Type /XObject /Subtype /Image /Width ${logo.width} /Height ${logo.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`,
      logo.jpeg
    ),
    {
      id: 7,
      body: Buffer.from(
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> /XObject << /ImScan 9 0 R >> >> /Contents 8 0 R >>',
        'ascii'
      )
    },
    makeStreamObject(8, '', p2Content),
    makeStreamObject(
      9,
      `/Type /XObject /Subtype /Image /Width ${scannedBody.width} /Height ${scannedBody.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`,
      scannedBody.jpeg
    ),
    {
      id: 10,
      body: Buffer.from(
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 11 0 R >>',
        'ascii'
      )
    },
    makeStreamObject(11, '', p3Content)
  ])
}

async function writeRecordedFixture(dir, fileName, bytes) {
  const filePath = join(dir, fileName)
  writeFileSync(filePath, bytes)
  const st = statSync(filePath)
  return {
    fileName,
    filePath,
    byteSize: st.size,
    mtimeMs: st.mtimeMs,
    sha256: createHash('sha256').update(bytes).digest('hex')
  }
}

async function createSyntheticFixtures(sharpLib, canvasLib, targetDir) {
  mkdirSync(targetDir, { recursive: true })

  const receiptPngBytes = await renderHighContrastTextPng(canvasLib, [
    'PERSONAL VAULT MARKET',
    'RECEIPT NUMBER 48291',
    'DATE 2026-04-14',
    'SUBTOTAL 22.50',
    'TAX 2.00',
    'TOTAL USD 24.50',
    'THANK YOU FOR YOUR VISIT'
  ])
  const receiptTiffBytes = await sharpLib(receiptPngBytes).tiff({ compression: 'lzw' }).toBuffer()

  const scanP1 = await decodeToJpeg(
    sharpLib,
    await renderHighContrastTextPng(
      canvasLib,
      ['SCANNED STATEMENT PAGE ONE', 'ACCOUNT REF 77410', 'OPENING BALANCE 645.00'],
      1224,
      1584
    )
  )
  const scanP2 = await decodeToJpeg(
    sharpLib,
    await renderHighContrastTextPng(
      canvasLib,
      ['SCANNED STATEMENT PAGE TWO', 'CLOSING BALANCE 645.00', 'VERIFIED CODE ALPHA99'],
      1224,
      1584
    )
  )
  const scannedBody = await decodeToJpeg(
    sharpLib,
    await renderHighContrastTextPng(
      canvasLib,
      ['SCANNED BODY CLAUSE 4410', 'NET AMOUNT DUE 915.00', 'COUNTERSIGNED CODE ZETA88'],
      1200,
      1320
    )
  )
  const smallLogoPng = await sharpLib({
    create: { width: 120, height: 48, channels: 3, background: { r: 30, g: 64, b: 175 } }
  })
    .png()
    .toBuffer()
  const smallLogo = await decodeToJpeg(sharpLib, smallLogoPng)

  const blankPngBytes = await sharpLib({
    create: { width: 1200, height: 900, channels: 3, background: { r: 255, g: 255, b: 255 } }
  })
    .png()
    .toBuffer()
  const blankJpeg = await decodeToJpeg(sharpLib, blankPngBytes)

  return {
    receiptPng: await writeRecordedFixture(targetDir, 'synthetic_receipt.png', receiptPngBytes),
    receiptTiff: await writeRecordedFixture(targetDir, 'synthetic_receipt.tiff', receiptTiffBytes),
    scannedPdf: await writeRecordedFixture(
      targetDir,
      'scanned_only.pdf',
      buildImageOnlyPdf([scanP1, scanP2])
    ),
    blankPng: await writeRecordedFixture(targetDir, 'blank_page.png', blankPngBytes),
    blankScanPdf: await writeRecordedFixture(
      targetDir,
      'blank_scan.pdf',
      buildImageOnlyPdf([blankJpeg])
    ),
    headerPlusScannedBodyPdf: await writeRecordedFixture(
      targetDir,
      'header_plus_scanned_body.pdf',
      buildHeaderPlusScannedBodyPdf(scannedBody)
    ),
    nativeBodyPlusSmallLogoPdf: await writeRecordedFixture(
      targetDir,
      'native_body_plus_small_logo.pdf',
      buildNativeBodyPlusSmallLogoPdf(smallLogo)
    ),
    mixedPolicyPdf: await writeRecordedFixture(
      targetDir,
      'mixed_policy_document.pdf',
      buildMixedThreePagePdf(smallLogo, scannedBody)
    ),
    unsupportedBmp: await writeRecordedFixture(
      targetDir,
      'legacy_scan.bmp',
      Buffer.from('BM_SYNTHETIC_UNSUPPORTED_BITMAP')
    )
  }
}

async function buildIsolatedUnpackedApp() {
  console.log(
    `[verify-ocr-foundation] Building Electron bundles and isolated unpacked app in ${unpackedOutputRoot}...`
  )
  const buildRes = spawnSync('npm', ['run', 'build'], {
    cwd: rootDir,
    stdio: 'inherit',
    shell: true
  })
  if (buildRes.status !== 0) {
    throw new Error(`npm run build failed with exit code ${buildRes.status ?? 1}`)
  }

  rmSync(unpackedOutputRoot, { recursive: true, force: true })

  const electronBuilder = requireFromRoot('electron-builder')
  await electronBuilder.build({
    projectDir: rootDir,
    dir: true,
    config: {
      appId: 'com.personalvault.app',
      productName: 'Personal Vault',
      directories: {
        output: unpackedOutputDirName,
        buildResources: 'build'
      },
      files: [
        'out/**/*',
        'THIRD_PARTY_NOTICES.md',
        '!node_modules/tesseract.js-core/*.wasm.js',
        '!node_modules/tesseract.js-core/tesseract-core.js',
        '!node_modules/tesseract.js-core/tesseract-core.wasm',
        '!node_modules/tesseract.js-core/tesseract-core-simd.js',
        '!node_modules/tesseract.js-core/tesseract-core-simd.wasm',
        '!node_modules/tesseract.js-core/tesseract-core-relaxedsimd*.js',
        '!node_modules/tesseract.js-core/tesseract-core-relaxedsimd*.wasm'
      ],
      asarUnpack: [
        'node_modules/sharp/**/*',
        'node_modules/@img/**/*',
        'node_modules/@napi-rs/**/*',
        'node_modules/tesseract.js-core/*.wasm',
        'node_modules/onnxruntime-node/bin/napi-v6/win32/x64/**/*'
      ],
      win: {
        target: [{ target: 'dir', arch: ['x64'] }]
      }
    }
  })
}

// ---------------------------------------------------------------------------
// Outer Node Launcher (when not running inside Electron's runtime)
// ---------------------------------------------------------------------------
if (!process.versions.electron) {
  ;(async () => {
    const trainedDataPath = getDefaultTrainedDataPath()
    if (!existsSync(trainedDataPath)) {
      console.error(
        `[verify-ocr-foundation] Offline pinned eng.traineddata not found at ${trainedDataPath}.`
      )
      console.error(
        `Pass --traineddata=<path> or set PV_OCR_TRAINEDDATA_PATH (no automatic downloads performed).`
      )
      process.exitCode = 1
      return
    }

    let binaryPath = electronPath
    if (isUnpackedMode) {
      const candidateExe = getUnpackedExecutablePath(unpackedOutputRoot)
      const forceRebuild = process.argv.includes('--rebuild')
      if (!existsSync(candidateExe) || forceRebuild) {
        if (executableArg) {
          throw new Error(`Explicit --executable not found: ${candidateExe}`)
        }
        await buildIsolatedUnpackedApp()
      }
      binaryPath = candidateExe
    } else {
      console.log('[verify-ocr-foundation] Compiling production bundles via `npm run build`...')
      const buildRes = spawnSync('npm', ['run', 'build'], {
        cwd: rootDir,
        stdio: 'inherit',
        shell: true
      })
      if (buildRes.status !== 0) {
        process.exitCode = buildRes.status ?? 1
        return
      }
    }

    const neutralCwd = mkdtempSync(
      join(tmpdir(), `pv-ocr-foundation-cwd-${isUnpackedMode ? 'unpacked' : 'built'}-`)
    )
    try {
      console.log(
        `[verify-ocr-foundation] Launching ${isUnpackedMode ? 'unpacked executable' : 'built Electron'} from neutral cwd: ${neutralCwd}`
      )
      const child = spawnSync(
        binaryPath,
        [fileURLToPath(import.meta.url), ...process.argv.slice(2)],
        {
          cwd: neutralCwd,
          stdio: 'inherit',
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            ELECTRON_NO_ATTACH_CONSOLE: '1'
          }
        }
      )
      process.exitCode = child.status ?? 1
    } finally {
      rmSync(neutralCwd, { recursive: true, force: true })
    }
  })().catch((err) => {
    console.error('[verify-ocr-foundation] Fatal launcher error:', err)
    process.exitCode = 1
  })
} else {
  // ---------------------------------------------------------------------------
  // Inner Electron Runtime Verification
  // ---------------------------------------------------------------------------
  runInnerVerification().catch((err) => {
    console.error('[verify-ocr-foundation] Verification FAILED:', err)
    process.exitCode = 1
  })
}

async function runInnerVerification() {
  const trainedDataPath = getDefaultTrainedDataPath()
  const trainedDataBeforeStat = statSync(trainedDataPath)
  const trainedDataBytes = readFileSync(trainedDataPath)
  const trainedDataBeforeSha = createHash('sha256').update(trainedDataBytes).digest('hex')

  const exePath = isUnpackedMode ? getUnpackedExecutablePath(unpackedOutputRoot) : electronPath
  const appRootForModules = isUnpackedMode ? getUnpackedAsarPathFromExe(exePath) : rootDir
  const ocrBundlePath = join(appRootForModules, 'out', 'main', 'document_ocr.js')
  const preloadBundlePath = join(appRootForModules, 'out', 'main', '..', 'preload', 'index.js')

  const checks = []
  const recordCheck = (name, detail) => {
    checks.push({ name, detail })
    console.log(`  [PASS] ${name}${detail ? ` — ${detail}` : ''}`)
  }

  console.log(
    `[verify-ocr-foundation] Electron ${process.versions.electron} (${isUnpackedMode ? 'unpacked' : 'built'})`
  )
  console.log(`  - process.cwd(): ${process.cwd()}`)
  console.log(`  - module root:   ${appRootForModules}`)

  // Check 1: Sandboxed preload requires only 'electron'
  const preloadSource = readFileSync(preloadBundlePath, 'utf8')
  const preloadRequires = [
    ...preloadSource.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)
  ].map((m) => m[1])
  assertCondition(
    preloadRequires.every((r) => r === 'electron'),
    `Sandboxed preload violated! Found external requires: ${preloadRequires.join(', ')}`
  )
  recordCheck(
    '1. Sandboxed preload requires only electron',
    `requires=${JSON.stringify(preloadRequires)}`
  )

  // Check 2: Unpacked ASAR asset hygiene (when --mode=unpacked)
  if (isUnpackedMode) {
    const unpackedDir = `${appRootForModules}.unpacked`
    const unpackedTessDir = join(unpackedDir, 'node_modules', 'tesseract.js-core')
    const unpackedTessFiles = readdirSync(unpackedTessDir).sort()
    assertCondition(
      unpackedTessFiles.includes('tesseract-core-simd-lstm.wasm') &&
        unpackedTessFiles.includes('tesseract-core-lstm.wasm'),
      `Missing unpacked LSTM WASM binaries: ${unpackedTessFiles.join(', ')}`
    )
    assertCondition(
      !unpackedTessFiles.some((f) => f.endsWith('.wasm.js') || f.includes('relaxedsimd')),
      `Unfiltered tesseract.js-core bloat found in app.asar.unpacked: ${unpackedTessFiles.join(', ')}`
    )
    const unpackedNapiDir = join(unpackedDir, 'node_modules', '@napi-rs')
    assertCondition(existsSync(unpackedNapiDir), 'Missing @napi-rs in app.asar.unpacked')
    recordCheck(
      '2. Unpacked app.asar.unpacked OCR asset hygiene',
      `wasm=${unpackedTessFiles.join(', ')}`
    )
  } else {
    recordCheck('2. Built mode OCR bundle exists', ocrBundlePath)
  }

  // Load production OCR foundation module anchored to app.asar (unpacked) or rootDir (built)
  const loadModule = createRequire(join(appRootForModules, 'package.json'))
  const sharpLib = loadModule('sharp')
  const canvasLib = loadModule('@napi-rs/canvas')
  const ocrMod = loadModule(ocrBundlePath)

  const {
    DOCUMENT_OCR_LIMITS,
    OCR_MODEL_ID,
    REQUIRED_OCR_MODEL_ARTIFACTS,
    OcrModelManager,
    DocumentOcrWorkerRunner,
    readAndVerifySourceWithExplicitLimit
  } = ocrMod

  assertCondition(
    OCR_MODEL_ID === 'tesseract-ocr/tessdata_fast:eng@65727574' &&
      trainedDataBeforeStat.size === REQUIRED_OCR_MODEL_ARTIFACTS[0].byteSize &&
      trainedDataBeforeSha === REQUIRED_OCR_MODEL_ARTIFACTS[0].sha256,
    'Pinned OCR manifest mismatch against local eng.traineddata'
  )
  recordCheck(
    '3. Pinned OCR manifest matches eng.traineddata',
    `${trainedDataBeforeStat.size} B, sha256=${trainedDataBeforeSha.slice(0, 16)}...`
  )

  const tempWork = mkdtempSync(join(tmpdir(), 'pv-ocr-foundation-work-'))
  let loopbackServer = null

  try {
    const approvedFixturesDir = join(tempWork, 'approved-sources')
    const modelsRootDir = join(tempWork, 'ocr-models')
    const validImportDir = join(tempWork, 'offline-import-valid')
    const corruptImportDir = join(tempWork, 'offline-import-corrupt')
    mkdirSync(validImportDir, { recursive: true })
    mkdirSync(corruptImportDir, { recursive: true })
    copyFileSync(trainedDataPath, join(validImportDir, 'eng.traineddata'))
    const corruptModelBytes = Buffer.from(trainedDataBytes)
    corruptModelBytes[128] ^= 0xff
    writeFileSync(join(corruptImportDir, 'eng.traineddata'), corruptModelBytes)

    const fixtures = await createSyntheticFixtures(sharpLib, canvasLib, approvedFixturesDir)

    // Check 4: OcrModelManager offline initialize (no auto-download) + containment guard
    const overlapMgr = new OcrModelManager({
      modelsRootDir: join(approvedFixturesDir, 'nested-models'),
      getApprovedRoots: () => [approvedFixturesDir],
      getVaultRoot: () => null
    })
    const overlapStatus = await overlapMgr.initialize()
    assertCondition(
      overlapStatus.state === 'error' &&
        String(overlapStatus.error).includes('overlaps with approved source root'),
      `Expected containment error, got ${JSON.stringify(overlapStatus)}`
    )

    let failNextPromotionRename = false
    const modelManager = new OcrModelManager({
      modelsRootDir,
      getApprovedRoots: () => [approvedFixturesDir],
      getVaultRoot: () => join(tempWork, 'vault'),
      baseDownloadUrl: 'http://127.0.0.1:1/never-auto-called',
      renameImpl: (oldPath, newPath) => {
        if (failNextPromotionRename && String(oldPath).includes('.ocr_model_staging_')) {
          throw new Error('SIMULATED_PROMOTION_SWAP_ERROR')
        }
        renameSync(oldPath, newPath)
      }
    })

    const initStatus = await modelManager.initialize()
    assertCondition(
      initStatus.state === 'missing',
      `Expected missing state, got ${initStatus.state}`
    )
    recordCheck(
      '4. OcrModelManager offline init & containment guard',
      'state=missing, 0 network calls'
    )

    // Check 5: Tampered import rejection, valid offline import, and promotion rollback
    const badImport = await modelManager.importFromDirectory(corruptImportDir)
    assertCondition(
      badImport.state === 'error' && String(badImport.error).includes('SHA-256 digest mismatch'),
      `Expected SHA-256 mismatch on corrupt import, got ${JSON.stringify(badImport)}`
    )

    const goodImport = await modelManager.importFromDirectory(validImportDir)
    assertCondition(
      goodImport.state === 'ready',
      `Expected ready after import, got ${JSON.stringify(goodImport)}`
    )

    failNextPromotionRename = true
    const failedSwap = await modelManager.importFromDirectory(validImportDir)
    failNextPromotionRename = false
    assertCondition(
      failedSwap.state === 'ready' &&
        String(failedSwap.lastReplacementError).includes('SIMULATED_PROMOTION_SWAP_ERROR') &&
        (await modelManager.revalidateForLoading()).ok === true,
      `Expected clean rollback to active model after promotion failure: ${JSON.stringify(failedSwap)}`
    )
    const rootAfterRollback = readdirSync(modelsRootDir)
    assertCondition(
      !rootAfterRollback.some(
        (name) => name.startsWith('.ocr_model_staging_') || name.startsWith('.ocr_model_backup_')
      ),
      `Leftover staging/backup dirs after rollback: ${rootAfterRollback.join(', ')}`
    )
    recordCheck(
      '5. OcrModelManager offline import, SHA-256 check & atomic rollback',
      '0 staging/backup leftovers'
    )

    // Check 6: Explicit loopback verified download, redirect host rejection & active cancellation
    const syntheticDownloadBytes = Buffer.alloc(96 * 1024, 0x4b)
    const syntheticSpec = [
      {
        relativePath: 'eng.traineddata',
        byteSize: syntheticDownloadBytes.byteLength,
        sha256: createHash('sha256').update(syntheticDownloadBytes).digest('hex')
      }
    ]
    let serverMode = 'bad-redirect'
    loopbackServer = createServer((req, res) => {
      if (serverMode === 'bad-redirect') {
        res.writeHead(302, { Location: 'https://evil.example.org/eng.traineddata' })
        res.end()
        return
      }
      if (serverMode === 'slow') {
        res.writeHead(200, { 'Content-Length': String(syntheticDownloadBytes.byteLength) })
        res.write(syntheticDownloadBytes.subarray(0, 16 * 1024))
        const t = setTimeout(() => res.end(syntheticDownloadBytes.subarray(16 * 1024)), 5000)
        req.on('close', () => clearTimeout(t))
        return
      }
      res.writeHead(200, { 'Content-Length': String(syntheticDownloadBytes.byteLength) })
      res.end(syntheticDownloadBytes)
    })
    await new Promise((res) => loopbackServer.listen(0, '127.0.0.1', res))
    const serverPort = loopbackServer.address().port
    const dlModelsDir = join(tempWork, 'dl-models')
    const dlManager = new OcrModelManager({
      modelsRootDir: dlModelsDir,
      getApprovedRoots: () => [approvedFixturesDir],
      getVaultRoot: () => null,
      artifacts: syntheticSpec,
      baseDownloadUrl: `http://127.0.0.1:${serverPort}`,
      allowedHosts: ['127.0.0.1'],
      allowLoopbackHttpForTests: true
    })
    const redirectRejected = await dlManager.downloadModel()
    assertCondition(redirectRejected.state === 'error', 'Expected redirect host rejection')

    serverMode = 'slow'
    const inFlightDl = dlManager.downloadModel()
    await new Promise((r) => setTimeout(r, 60))
    await dlManager.cancelProvisioning()
    const cancelledDl = await inFlightDl
    assertCondition(cancelledDl.state === 'cancelled', 'Expected cancelled download state')
    assertCondition(
      !readdirSync(dlModelsDir).some((e) => e.startsWith('.ocr_model_staging_')),
      'Leftover staging dir after cancelled download'
    )

    serverMode = 'ok'
    const completedDl = await dlManager.downloadModel()
    assertCondition(completedDl.state === 'ready', 'Expected ready state after loopback download')
    recordCheck(
      '6. OcrModelManager explicit download, redirect guard & cancel cleanup',
      'state=ready'
    )

    // Check 7: Explicit 64 MiB OCR input limit vs 32 MiB native limit
    const sizeDir = join(tempWork, 'size-checks')
    mkdirSync(sizeDir, { recursive: true })
    const file34Path = join(sizeDir, 'scan_34mib.pdf')
    const buf34 = Buffer.alloc(34 * 1024 * 1024, 0x41)
    writeFileSync(file34Path, buf34)
    const st34 = statSync(file34Path)
    const sha34 = createHash('sha256').update(buf34).digest('hex')

    const under32 = await readAndVerifySourceWithExplicitLimit({
      sourcePath: file34Path,
      approvedRoots: [sizeDir],
      expectedByteSize: st34.size,
      expectedMtimeMs: st34.mtimeMs,
      expectedSha256: sha34,
      maxInputBytes: 32 * 1024 * 1024
    })
    const under64 = await readAndVerifySourceWithExplicitLimit({
      sourcePath: file34Path,
      approvedRoots: [sizeDir],
      expectedByteSize: st34.size,
      expectedMtimeMs: st34.mtimeMs,
      expectedSha256: sha34,
      maxInputBytes: DOCUMENT_OCR_LIMITS.MAX_INPUT_BYTES
    })
    assertCondition(
      under32.ok &&
        under32.buffer === null &&
        under32.oversizedBytes === 34 * 1024 * 1024 &&
        under64.ok &&
        under64.buffer?.byteLength === 34 * 1024 * 1024,
      'Explicit 64 MiB vs 32 MiB source reader check failed'
    )
    recordCheck(
      '7. Explicit 64 MiB OCR limit vs 32 MiB native limit',
      '34 MiB accepted under 64 MiB'
    )

    // Check 8: AppWorkerBudget(3) spawn-failure reservation release + contention + offline OCR
    const activeModelDir = modelManager.getActiveModelInstallDir()
    assertCondition(Boolean(activeModelDir), 'Active OCR model install dir missing')

    const AppWorkerBudgetCtor = loadModule(
      join(appRootForModules, 'out', 'main', 'document_ocr.js')
    ).AppWorkerBudget

    const workerBudget = new AppWorkerBudgetCtor(3)

    // 8a. Spawn failure releases reservation
    const badRunner = new DocumentOcrWorkerRunner({
      workerBudget,
      workerScriptPath: join(tempWork, 'nonexistent-worker.js'),
      isPackaged: true
    })
    const badSpawnRes = await badRunner.runOcr({
      sourcePath: fixtures.receiptPng.filePath,
      extension: '.png',
      approvedRoots: [approvedFixturesDir],
      expectedByteSize: fixtures.receiptPng.byteSize,
      expectedMtimeMs: fixtures.receiptPng.mtimeMs,
      expectedSha256: fixtures.receiptPng.sha256,
      modelDir: activeModelDir
    })
    assertCondition(
      badSpawnRes.ok === false &&
        workerBudget.getReservedCount() === 0 &&
        workerBudget.getWorkerCount() === 0,
      'Spawn failure leaked worker budget reservation'
    )

    // 8b. Contention with 2 busy workers + 1 reclaimable idle worker
    const makeDummyWorker = () =>
      new Worker(
        'const { parentPort } = require("node:worker_threads"); parentPort.on("message", () => {});',
        { eval: true }
      )
    const r1 = workerBudget.tryReserve()
    const busy1 = makeDummyWorker()
    workerBudget.promote(r1, busy1)
    const r2 = workerBudget.tryReserve()
    const busy2 = makeDummyWorker()
    workerBudget.promote(r2, busy2)
    const r3 = workerBudget.tryReserve()
    let idle3 = makeDummyWorker()
    workerBudget.promote(r3, idle3)
    assertCondition(workerBudget.getLiveCount() === 3, 'Expected full worker budget (3/3)')

    const runner = new DocumentOcrWorkerRunner({
      workerBudget,
      appPath: appRootForModules,
      isPackaged: isUnpackedMode,
      tryReleaseExternalIdleWorker: async () => {
        if (idle3) {
          await idle3.terminate()
          idle3 = null
          return true
        }
        return false
      }
    })

    let sampledMemoryNote = ''
    try {
      // Receipt PNG + TIFF
      const pngRes = await runner.runOcr({
        sourcePath: fixtures.receiptPng.filePath,
        extension: '.png',
        approvedRoots: [approvedFixturesDir],
        expectedByteSize: fixtures.receiptPng.byteSize,
        expectedMtimeMs: fixtures.receiptPng.mtimeMs,
        expectedSha256: fixtures.receiptPng.sha256,
        modelDir: activeModelDir
      })
      assertCondition(workerBudget.getLiveCount() <= 3, 'AppWorkerBudget exceeded cap of 3')
      assertCondition(
        pngRes.ok &&
          pngRes.outcome.status === 'extracted' &&
          pngRes.outcome.text.includes('PERSONAL VAULT MARKET') &&
          pngRes.outcome.text.includes('48291') &&
          pngRes.outcome.text.includes('24.50') &&
          pngRes.nestedWorkerAttempts === 0 &&
          pngRes.outboundNetworkAttempts === 0,
        `Receipt PNG OCR failed: ${JSON.stringify(pngRes)}`
      )
      if (isUnpackedMode) {
        assertCondition(
          pngRes.engineTelemetry?.wasmLoadedFromUnpackedAsar === true,
          `Expected WASM loaded from app.asar.unpacked in unpacked mode: ${JSON.stringify(pngRes.engineTelemetry)}`
        )
      }
      recordCheck(
        '8. Receipt PNG offline OCR & unpacked WASM verification',
        `conf=${pngRes.outcome.meanConfidence}, unpacked=${Boolean(pngRes.engineTelemetry?.wasmLoadedFromUnpackedAsar)}`
      )

      const tiffRes = await runner.runOcr({
        sourcePath: fixtures.receiptTiff.filePath,
        extension: '.tiff',
        approvedRoots: [approvedFixturesDir],
        expectedByteSize: fixtures.receiptTiff.byteSize,
        expectedMtimeMs: fixtures.receiptTiff.mtimeMs,
        expectedSha256: fixtures.receiptTiff.sha256,
        modelDir: activeModelDir
      })
      assertCondition(
        tiffRes.ok &&
          tiffRes.outcome.status === 'extracted' &&
          tiffRes.outcome.text.includes('48291'),
        'Receipt TIFF OCR failed'
      )
      recordCheck('9. Receipt TIFF offline OCR', `chars=${tiffRes.outcome.extractedCharCount}`)

      // 2-page Scanned PDF
      const scannedPdfRes = await runner.runOcr({
        sourcePath: fixtures.scannedPdf.filePath,
        extension: '.pdf',
        approvedRoots: [approvedFixturesDir],
        expectedByteSize: fixtures.scannedPdf.byteSize,
        expectedMtimeMs: fixtures.scannedPdf.mtimeMs,
        expectedSha256: fixtures.scannedPdf.sha256,
        modelDir: activeModelDir
      })
      assertCondition(
        scannedPdfRes.ok &&
          scannedPdfRes.outcome.status === 'extracted' &&
          scannedPdfRes.outcome.extractionMethod === 'ocr_pdf_tesseract' &&
          scannedPdfRes.outcome.ocrPageCount === 2 &&
          scannedPdfRes.outcome.text.includes('77410') &&
          scannedPdfRes.outcome.text.includes('ALPHA99'),
        `Scanned PDF OCR failed: ${JSON.stringify(scannedPdfRes)}`
      )
      const sampledMem = process.memoryUsage()
      sampledMemoryNote = `sampledProcessRssMiB=${(sampledMem.rss / (1024 * 1024)).toFixed(2)}`
      recordCheck(
        '10. 2-page image-only scanned PDF rasterization + OCR',
        `pages=${scannedPdfRes.outcome.ocrPageCount}, ${sampledMemoryNote}`
      )

      // Conservative Mixed-Page Policy Fixtures
      const headerBodyRes = await runner.runOcr({
        sourcePath: fixtures.headerPlusScannedBodyPdf.filePath,
        extension: '.pdf',
        approvedRoots: [approvedFixturesDir],
        expectedByteSize: fixtures.headerPlusScannedBodyPdf.byteSize,
        expectedMtimeMs: fixtures.headerPlusScannedBodyPdf.mtimeMs,
        expectedSha256: fixtures.headerPlusScannedBodyPdf.sha256,
        modelDir: activeModelDir
      })
      assertCondition(
        headerBodyRes.ok &&
          headerBodyRes.outcome.status === 'extracted' &&
          headerBodyRes.outcome.ocrPageCount === 1 &&
          headerBodyRes.outcome.text.includes('SELECTABLE RUNNING HEADER') &&
          headerBodyRes.outcome.text.includes('SCANNED BODY CLAUSE 4410') &&
          headerBodyRes.outcome.text.includes('ZETA88'),
        `Header + scanned body PDF policy failed: ${JSON.stringify(headerBodyRes)}`
      )
      recordCheck(
        '11. Conservative policy: selectable header + scanned body PDF OCRd & merged',
        `method=${headerBodyRes.outcome.extractionMethod}`
      )

      const smallLogoRes = await runner.runOcr({
        sourcePath: fixtures.nativeBodyPlusSmallLogoPdf.filePath,
        extension: '.pdf',
        approvedRoots: [approvedFixturesDir],
        expectedByteSize: fixtures.nativeBodyPlusSmallLogoPdf.byteSize,
        expectedMtimeMs: fixtures.nativeBodyPlusSmallLogoPdf.mtimeMs,
        expectedSha256: fixtures.nativeBodyPlusSmallLogoPdf.sha256,
        modelDir: activeModelDir
      })
      assertCondition(
        smallLogoRes.ok &&
          smallLogoRes.outcome.status === 'extracted' &&
          smallLogoRes.outcome.nativeOnlyPageCount === 1 &&
          smallLogoRes.outcome.ocrPageCount === 0 &&
          smallLogoRes.outcome.text.includes('NATIVE-LOGO-EXEMPT-551'),
        `Native body + small logo PDF policy failed: ${JSON.stringify(smallLogoRes)}`
      )
      recordCheck(
        '12. Conservative policy: native body + small corner logo skips needless OCR',
        'ocrPageCount=0, nativeOnlyPageCount=1'
      )

      const mixed3Res = await runner.runOcr({
        sourcePath: fixtures.mixedPolicyPdf.filePath,
        extension: '.pdf',
        approvedRoots: [approvedFixturesDir],
        expectedByteSize: fixtures.mixedPolicyPdf.byteSize,
        expectedMtimeMs: fixtures.mixedPolicyPdf.mtimeMs,
        expectedSha256: fixtures.mixedPolicyPdf.sha256,
        modelDir: activeModelDir
      })
      assertCondition(
        mixed3Res.ok &&
          mixed3Res.outcome.status === 'extracted' &&
          mixed3Res.outcome.extractionMethod === 'ocr_hybrid_pdf' &&
          mixed3Res.outcome.nativeOnlyPageCount === 1 &&
          mixed3Res.outcome.ocrPageCount === 1 &&
          mixed3Res.outcome.skippedBlankPageCount === 1,
        `3-page mixed policy PDF failed: ${JSON.stringify(mixed3Res)}`
      )
      recordCheck(
        '13. 3-page mixed PDF (native+logo / header+scan / blank spacer)',
        '1 native + 1 OCR + 1 skipped'
      )

      // Blank image & blank scanned PDF -> honest ocr_no_text; .bmp -> unsupported; 65 MiB -> truncated
      const blankImgRes = await runner.runOcr({
        sourcePath: fixtures.blankPng.filePath,
        extension: '.png',
        approvedRoots: [approvedFixturesDir],
        expectedByteSize: fixtures.blankPng.byteSize,
        expectedMtimeMs: fixtures.blankPng.mtimeMs,
        expectedSha256: fixtures.blankPng.sha256,
        modelDir: activeModelDir
      })
      const blankPdfRes = await runner.runOcr({
        sourcePath: fixtures.blankScanPdf.filePath,
        extension: '.pdf',
        approvedRoots: [approvedFixturesDir],
        expectedByteSize: fixtures.blankScanPdf.byteSize,
        expectedMtimeMs: fixtures.blankScanPdf.mtimeMs,
        expectedSha256: fixtures.blankScanPdf.sha256,
        modelDir: activeModelDir
      })
      const bmpRes = await runner.runOcr({
        sourcePath: fixtures.unsupportedBmp.filePath,
        extension: '.bmp',
        approvedRoots: [approvedFixturesDir],
        expectedByteSize: fixtures.unsupportedBmp.byteSize,
        expectedMtimeMs: fixtures.unsupportedBmp.mtimeMs,
        expectedSha256: fixtures.unsupportedBmp.sha256,
        modelDir: activeModelDir
      })
      const file65Path = join(sizeDir, 'oversized_65mib.pdf')
      const buf65 = Buffer.alloc(65 * 1024 * 1024, 0x42)
      writeFileSync(file65Path, buf65)
      const st65 = statSync(file65Path)
      const sha65 = createHash('sha256').update(buf65).digest('hex')
      const over65Res = await runner.runOcr({
        sourcePath: file65Path,
        extension: '.pdf',
        approvedRoots: [sizeDir],
        expectedByteSize: st65.size,
        expectedMtimeMs: st65.mtimeMs,
        expectedSha256: sha65,
        modelDir: activeModelDir
      })

      assertCondition(
        blankImgRes.ok &&
          blankImgRes.outcome.status === 'ocr_no_text' &&
          blankImgRes.outcome.text === null &&
          blankPdfRes.ok &&
          blankPdfRes.outcome.status === 'ocr_no_text' &&
          blankPdfRes.outcome.text === null &&
          bmpRes.ok &&
          bmpRes.outcome.status === 'unsupported' &&
          over65Res.ok &&
          over65Res.outcome.status === 'truncated' &&
          over65Res.outcome.truncated === true &&
          String(over65Res.outcome.truncationReason).includes('exceeded 67108864 byte OCR limit'),
        `Blank/unsupported/oversized checks failed: ${JSON.stringify({ blankImgRes, blankPdfRes, bmpRes, over65Res })}`
      )
      recordCheck(
        '14. Honest ocr_no_text (blank PNG/PDF), unsupported (.bmp) & 65 MiB truncated',
        'all exact'
      )

      // Missing & corrupt model rejection offline
      const missingModelRes = await runner.runOcr({
        sourcePath: fixtures.receiptPng.filePath,
        extension: '.png',
        approvedRoots: [approvedFixturesDir],
        expectedByteSize: fixtures.receiptPng.byteSize,
        expectedMtimeMs: fixtures.receiptPng.mtimeMs,
        expectedSha256: fixtures.receiptPng.sha256,
        modelDir: join(tempWork, 'missing-dir')
      })
      const corruptModelRes = await runner.runOcr({
        sourcePath: fixtures.receiptPng.filePath,
        extension: '.png',
        approvedRoots: [approvedFixturesDir],
        expectedByteSize: fixtures.receiptPng.byteSize,
        expectedMtimeMs: fixtures.receiptPng.mtimeMs,
        expectedSha256: fixtures.receiptPng.sha256,
        modelDir: corruptImportDir
      })
      assertCondition(
        !missingModelRes.ok &&
          missingModelRes.errorCode === 'OCR_MODEL_MISSING' &&
          missingModelRes.outboundNetworkAttempts === 0 &&
          !corruptModelRes.ok &&
          corruptModelRes.errorCode === 'OCR_MODEL_INVALID' &&
          corruptModelRes.outboundNetworkAttempts === 0,
        'Missing/corrupt model offline rejection failed'
      )
      recordCheck(
        '15. Missing & corrupt model rejected offline',
        '0 network calls, 0 nested workers'
      )

      // Active mid-OCR cancellation + fresh worker recovery
      const slowOcr = runner.runOcr({
        sourcePath: fixtures.scannedPdf.filePath,
        extension: '.pdf',
        approvedRoots: [approvedFixturesDir],
        expectedByteSize: fixtures.scannedPdf.byteSize,
        expectedMtimeMs: fixtures.scannedPdf.mtimeMs,
        expectedSha256: fixtures.scannedPdf.sha256,
        modelDir: activeModelDir,
        pageDelayMs: 350
      })
      await new Promise((r) => setTimeout(r, 120))
      await runner.cancelActiveRequests()
      const cancelledOcr = await slowOcr
      assertCondition(
        !cancelledOcr.ok && cancelledOcr.errorCode === 'CANCELLED',
        `Expected CANCELLED error code, got ${JSON.stringify(cancelledOcr)}`
      )

      const recoveryOcr = await runner.runOcr({
        sourcePath: fixtures.receiptPng.filePath,
        extension: '.png',
        approvedRoots: [approvedFixturesDir],
        expectedByteSize: fixtures.receiptPng.byteSize,
        expectedMtimeMs: fixtures.receiptPng.mtimeMs,
        expectedSha256: fixtures.receiptPng.sha256,
        modelDir: activeModelDir
      })
      assertCondition(
        recoveryOcr.ok &&
          recoveryOcr.outcome.status === 'extracted' &&
          recoveryOcr.outcome.text.includes('48291'),
        'Post-cancellation recovery OCR failed'
      )
      recordCheck(
        '16. Active mid-OCR cancellation & fresh worker recovery',
        'CANCELLED -> extracted'
      )
    } finally {
      await runner.shutdown()
      await busy1.terminate()
      await busy2.terminate()
      if (idle3) {
        await idle3.terminate()
      }
    }

    assertCondition(
      workerBudget.getLiveCount() === 0 &&
        workerBudget.getWorkerCount() === 0 &&
        workerBudget.getReservedCount() === 0,
      `Worker budget leak detected: live=${workerBudget.getLiveCount()}, workers=${workerBudget.getWorkerCount()}, reserved=${workerBudget.getReservedCount()}`
    )
    recordCheck(
      '17. Zero leaked workers or AppWorkerBudget reservations',
      'live=0, workers=0, reserved=0'
    )

    // Bitwise source preservation across all 9 fixtures + eng.traineddata
    for (const fx of Object.values(fixtures)) {
      const stAfter = statSync(fx.filePath)
      const shaAfter = createHash('sha256').update(readFileSync(fx.filePath)).digest('hex')
      assertCondition(
        stAfter.size === fx.byteSize && stAfter.mtimeMs === fx.mtimeMs && shaAfter === fx.sha256,
        `Source preservation violated for ${fx.fileName}`
      )
    }
    const trainedAfterStat = statSync(trainedDataPath)
    const trainedAfterSha = createHash('sha256').update(readFileSync(trainedDataPath)).digest('hex')
    assertCondition(
      trainedAfterStat.size === trainedDataBeforeStat.size &&
        trainedAfterStat.mtimeMs === trainedDataBeforeStat.mtimeMs &&
        trainedAfterSha === trainedDataBeforeSha,
      'Source preservation violated for eng.traineddata'
    )
    recordCheck(
      '18. 100% bitwise source preservation',
      `${Object.keys(fixtures).length}/${Object.keys(fixtures).length} fixtures + eng.traineddata unchanged`
    )

    console.log(
      `\n[verify-ocr-foundation] SUCCESS (${checks.length}/${checks.length} checks passed in ${isUnpackedMode ? 'unpacked' : 'built'} mode)`
    )
  } finally {
    if (loopbackServer) {
      await new Promise((res) => loopbackServer.close(() => res()))
    }
    try {
      rmSync(tempWork, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    } catch {
      // Ignore transient Windows handle release delay on temp cleanup
    }
  }
}
