#!/usr/bin/env node
/**
 * Personal Vault — Real Electron Stage 7C Slice 2 (OCR Persistence & Resumable Jobs) Verification
 *
 * Exercises compiled production modules (`out/main/catalog.js`, `out/main/documents.js`,
 * `out/main/document_ocr.js`, `out/main/thumbnails.js`, `out/main/document_snapshot_worker.js`,
 * `out/main/document_worker.js`, and `out/main/document_ocr_worker.js`) inside the real
 * Electron runtime from a neutral `os.tmpdir()` working directory in both built
 * (`--mode=built`) and separate unpacked (`--mode=unpacked`, outputting to
 * `dist-stage-7c-persistence-verify` so `dist/`, `dist-stage-7b-verify/`, and
 * `dist-stage-7c-foundation-verify/` remain untouched) modes.
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
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
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
  : 'dist-stage-7c-persistence-verify'
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

function sha256Of(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

function escapePdfLiteral(text) {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

async function renderTextCardPng(canvasLib, { width = 1200, height = 1550, header, lines }) {
  const canvas = canvasLib.createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)

  ctx.fillStyle = '#000000'
  ctx.font = 'bold 42px sans-serif'
  ctx.fillText(header, 56, 94)

  ctx.strokeStyle = '#000000'
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.moveTo(56, 122)
  ctx.lineTo(width - 56, 122)
  ctx.stroke()

  ctx.font = '34px sans-serif'
  let y = 190
  for (const line of lines) {
    ctx.fillText(line, 56, y)
    y += 64
  }
  return Buffer.from(canvas.toBuffer('image/png'))
}

function buildSyntheticPdfBuffer(pages) {
  const objects = []
  const addObj = (body) => {
    const id = objects.length + 1
    objects.push({ id, body })
    return id
  }

  const catalogId = addObj(Buffer.alloc(0))
  const pagesId = addObj(Buffer.alloc(0))
  const fontId = addObj(
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', 'ascii')
  )
  const pageIds = []

  for (const page of pages) {
    const w = page.pageWidthPt ?? 612
    const h = page.pageHeightPt ?? 792
    const xObjectEntries = []
    const contentOps = []

    if (page.kind === 'scanned-image') {
      const imgId = addObj(
        Buffer.concat([
          Buffer.from(
            `<< /Type /XObject /Subtype /Image /Width ${page.pixelWidth} /Height ${page.pixelHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpegBytes.length} >>\nstream\n`,
            'ascii'
          ),
          page.jpegBytes,
          Buffer.from('\nendstream', 'ascii')
        ])
      )
      xObjectEntries.push(`/Im1 ${imgId} 0 R`)
      contentOps.push(`q ${w} 0 0 ${h} 0 0 cm /Im1 Do Q`)
    } else if (page.kind === 'native-text') {
      contentOps.push('BT /F1 14 Tf 54 720 Td')
      page.lines.forEach((line, idx) => {
        if (idx > 0) contentOps.push('0 -24 Td')
        contentOps.push(`(${escapePdfLiteral(line)}) Tj`)
      })
      contentOps.push('ET')
    } else if (page.kind === 'native-header-plus-scanned-body') {
      const rect = page.bodyRectPt ?? { x: 36, y: 48, width: 540, height: 580 }
      const imgId = addObj(
        Buffer.concat([
          Buffer.from(
            `<< /Type /XObject /Subtype /Image /Width ${page.bodyPixelWidth} /Height ${page.bodyPixelHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.bodyJpegBytes.length} >>\nstream\n`,
            'ascii'
          ),
          page.bodyJpegBytes,
          Buffer.from('\nendstream', 'ascii')
        ])
      )
      xObjectEntries.push(`/ImBody ${imgId} 0 R`)
      contentOps.push('BT /F1 12 Tf 36 748 Td')
      page.headerLines.forEach((line, idx) => {
        if (idx > 0) contentOps.push('0 -18 Td')
        contentOps.push(`(${escapePdfLiteral(line)}) Tj`)
      })
      contentOps.push('ET')
      contentOps.push(`q ${rect.width} 0 0 ${rect.height} ${rect.x} ${rect.y} cm /ImBody Do Q`)
    } else if (page.kind === 'native-body-plus-small-logo') {
      const rect = page.logoRectPt ?? { x: 480, y: 730, width: 90, height: 36 }
      const imgId = addObj(
        Buffer.concat([
          Buffer.from(
            `<< /Type /XObject /Subtype /Image /Width ${page.logoPixelWidth} /Height ${page.logoPixelHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.logoJpegBytes.length} >>\nstream\n`,
            'ascii'
          ),
          page.logoJpegBytes,
          Buffer.from('\nendstream', 'ascii')
        ])
      )
      xObjectEntries.push(`/ImLogo ${imgId} 0 R`)
      contentOps.push(`q ${rect.width} 0 0 ${rect.height} ${rect.x} ${rect.y} cm /ImLogo Do Q`)
      contentOps.push('BT /F1 13 Tf 48 680 Td')
      page.bodyLines.forEach((line, idx) => {
        if (idx > 0) contentOps.push('0 -22 Td')
        contentOps.push(`(${escapePdfLiteral(line)}) Tj`)
      })
      contentOps.push('ET')
    }

    const streamBuf = Buffer.from(contentOps.join('\n'), 'ascii')
    const contentId = addObj(
      Buffer.concat([
        Buffer.from(`<< /Length ${streamBuf.length} >>\nstream\n`, 'ascii'),
        streamBuf,
        Buffer.from('\nendstream', 'ascii')
      ])
    )
    const xObjDict = xObjectEntries.length > 0 ? `/XObject << ${xObjectEntries.join(' ')} >>` : ''
    const pageId = addObj(
      Buffer.from(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /Font << /F1 ${fontId} 0 R >> ${xObjDict} >> /Contents ${contentId} 0 R >>`,
        'ascii'
      )
    )
    pageIds.push(pageId)
  }

  objects[catalogId - 1].body = Buffer.from(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`, 'ascii')
  objects[pagesId - 1].body = Buffer.from(
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`,
    'ascii'
  )

  const chunks = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'binary')]
  const offsets = [0]
  let cursor = chunks[0].length

  for (const obj of objects) {
    offsets.push(cursor)
    const head = Buffer.from(`${obj.id} 0 obj\n`, 'ascii')
    const tail = Buffer.from('\nendobj\n', 'ascii')
    chunks.push(head, obj.body, tail)
    cursor += head.length + obj.body.length + tail.length
  }

  const xrefOffset = cursor
  const xrefLines = [`xref\n0 ${objects.length + 1}`, '0000000000 65535 f ']
  for (let i = 1; i < offsets.length; i++) {
    xrefLines.push(`${String(offsets[i]).padStart(10, '0')} 00000 n `)
  }
  chunks.push(
    Buffer.from(
      `${xrefLines.join('\n')}\ntrailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
      'ascii'
    )
  )
  return Buffer.concat(chunks)
}

async function runInsideElectron() {
  assertCondition(
    Boolean(process.versions.electron),
    'Expected script to run inside Electron runtime (process.versions.electron)'
  )

  const mode = process.env.PV_VERIFY_MODE || 'built'
  const asarPath = process.env.PV_UNPACKED_ASAR_PATH || ''
  const trainedDataSourcePath = process.env.PV_TRAINED_DATA_SOURCE_PATH || ''

  assertCondition(
    trainedDataSourcePath && existsSync(trainedDataSourcePath),
    `Pinned eng.traineddata source not found at ${trainedDataSourcePath}`
  )

  const outMainDir =
    mode === 'unpacked' ? join(asarPath, 'out', 'main') : join(rootDir, 'out', 'main')
  const preloadBundlePath =
    mode === 'unpacked'
      ? join(asarPath, 'out', 'preload', 'index.js')
      : join(rootDir, 'out', 'preload', 'index.js')

  const runtimeReq =
    mode === 'unpacked' ? createRequire(join(asarPath, 'package.json')) : requireFromRoot

  const catalogMod = runtimeReq(join(outMainDir, 'catalog.js'))
  const docsMod = runtimeReq(join(outMainDir, 'documents.js'))
  const ocrMod = runtimeReq(join(outMainDir, 'document_ocr.js'))
  const thumbsMod = runtimeReq(join(outMainDir, 'thumbnails.js'))
  const canvasLib = runtimeReq('@napi-rs/canvas')
  const sharp = runtimeReq('sharp')

  const checks = []
  const recordPass = (name, detail) => {
    checks.push({ name, detail })
    console.log(`  [PASS] ${name}${detail ? ` — ${detail}` : ''}`)
  }

  const tempRoot = mkdtempSync(join(tmpdir(), `pv-ocr-persist-verify-${mode}-`))
  const openCatalogs = []
  const shutdownFns = []

  try {
    // 1. Sandboxed preload & unpacked ASAR hygiene
    const preloadSource = readFileSync(preloadBundlePath, 'utf8')
    const requireMatches = [...preloadSource.matchAll(/require\(["']([^"']+)["']\)/g)].map(
      (m) => m[1]
    )
    assertCondition(
      requireMatches.every((spec) => spec === 'electron'),
      `Sandboxed preload violated: unexpected require(${requireMatches.join(', ')})`
    )
    if (mode === 'unpacked') {
      const unpackedRoot = `${asarPath}.unpacked`
      const unpackedTessDir = join(unpackedRoot, 'node_modules', 'tesseract.js-core')
      const unpackedFiles = readdirSync(unpackedTessDir)
      assertCondition(
        unpackedFiles.includes('tesseract-core-simd-lstm.wasm') &&
          unpackedFiles.includes('tesseract-core-lstm.wasm'),
        `Missing LSTM WASM binaries in ${unpackedTessDir}`
      )
    }
    recordPass('sandboxed_preload_and_asset_hygiene', `mode=${mode}`)

    // 2. Migration 13 & v12 -> v13 Upgrade + v999 Rejection
    assertCondition(
      catalogMod.CURRENT_SCHEMA_VERSION >= 13,
      `Expected CURRENT_SCHEMA_VERSION >= 13, got ${catalogMod.CURRENT_SCHEMA_VERSION}`
    )
    const v12Path = join(tempRoot, 'upgrade-v12.db')
    const rawV12 = new DatabaseSync(v12Path)
    try {
      rawV12.exec('PRAGMA foreign_keys = ON;')
      rawV12.exec(
        'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL, applied_at_ms INTEGER NOT NULL);'
      )
      for (const m of catalogMod.MIGRATIONS.filter((item) => item.version <= 12)) {
        rawV12.exec('BEGIN;')
        m.up(rawV12)
        rawV12
          .prepare('INSERT INTO schema_migrations (version, name, applied_at_ms) VALUES (?, ?, ?);')
          .run(m.version, m.name, 1_700_000_000_000)
        rawV12.exec('COMMIT;')
      }
      rawV12
        .prepare(
          `INSERT INTO sources (root_path, normalized_root_path, created_at_ms, updated_at_ms)
           VALUES ('D:\\legacy', 'd:\\legacy', 1000, 1000);`
        )
        .run()
      rawV12
        .prepare(
          `INSERT INTO file_locations (
             source_id, original_path, normalized_path, file_name, extension, category, created_at_ms, updated_at_ms
           ) VALUES (1, 'D:\\legacy\\doc.pdf', 'd:\\legacy\\doc.pdf', 'doc.pdf', '.pdf', 'document', 1000, 1000);`
        )
        .run()
      rawV12
        .prepare(
          `INSERT INTO discovery_observations (
             file_location_id, byte_size, filesystem_birthtime_ms, filesystem_mtime_ms, observed_at_ms, last_seen_at_ms, is_current
           ) VALUES (1, 2048, 900, 950, 1000, 1000, 1);`
        )
        .run()
      rawV12
        .prepare(
          `INSERT INTO hash_observations (
             file_location_id, discovery_observation_id, sha256, observed_byte_size, observed_mtime_ms, hashed_at_ms, is_active
           ) VALUES (1, 1, ?, 2048, 950, 1005, 1);`
        )
        .run('a'.repeat(64))
      const rev12 = catalogMod.buildDocumentContentRevision({
        discoveryObservationId: 1,
        byteSize: 2048,
        filesystemMtimeMs: 950,
        activeHash: 'a'.repeat(64)
      })
      rawV12
        .prepare(
          `INSERT INTO document_extractions (
             file_location_id, discovery_observation_id, content_sha256, observed_byte_size,
             observed_mtime_ms, content_revision, recipe_version, extraction_status,
             status_detail, extracted_text, extracted_char_count, page_count,
             truncated, truncation_reason, detected_encoding, extracted_at_ms, is_current
           ) VALUES (1, 1, ?, 2048, 950, ?, 'doc_extract_v1', 'extracted', NULL, 'Preserved Stage 7B text', 23, 1, 0, NULL, NULL, 1010, 1);`
        )
        .run('a'.repeat(64), rev12)
    } finally {
      rawV12.close()
    }

    const upgradedCat = catalogMod.CatalogDatabase.open({ catalogPath: v12Path })
    openCatalogs.push(upgradedCat)
    assertCondition(
      upgradedCat.getDocumentRepository().getDocumentPreview(1)?.extractedText ===
        'Preserved Stage 7B text',
      'v12 -> v13 upgrade failed to preserve Stage 7B native extraction'
    )
    assertCondition(
      upgradedCat.getDocumentOcrRepository().getDocumentOcrState(1)?.ocrStatus === 'not_processed',
      'Expected not_processed OCR state after v12 -> v13 upgrade'
    )
    upgradedCat.close()

    const futurePath = join(tempRoot, 'future-v999.db')
    const rawFuture = new DatabaseSync(futurePath)
    rawFuture.exec(
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL, applied_at_ms INTEGER NOT NULL); INSERT INTO schema_migrations VALUES (999, 'future', 1000);"
    )
    rawFuture.close()
    let rejectedFuture = false
    try {
      catalogMod.CatalogDatabase.open({ catalogPath: futurePath })
    } catch (err) {
      rejectedFuture = err instanceof catalogMod.UnsupportedSchemaVersionError
    }
    assertCondition(rejectedFuture, 'Expected UnsupportedSchemaVersionError on v999 schema')
    recordPass('migration_13_upgrade_and_future_schema_rejection', 'v12->v13 preserved')

    // 3. Build Synthetic Source Fixtures & Track Bitwise Digests
    const sourcesDir = join(tempRoot, 'approved-sources')
    const modelsRootDir = join(tempRoot, 'ocr-models')
    const modelImportDir = join(tempRoot, 'model-import-src')
    const thumbCacheDir = join(tempRoot, 'thumb-cache')
    mkdirSync(sourcesDir, { recursive: true })
    mkdirSync(modelImportDir, { recursive: true })
    mkdirSync(thumbCacheDir, { recursive: true })
    copyFileSync(trainedDataSourcePath, join(modelImportDir, 'eng.traineddata'))

    const receiptPngBytes = await renderTextCardPng(canvasLib, {
      width: 1100,
      height: 850,
      header: 'GROCERY RECEIPT 8842',
      lines: ['SUBTOTAL 31.50', 'TAX 2.50', 'TOTAL PAID 34.00']
    })
    const scanPage1Jpeg = await sharp(
      await renderTextCardPng(canvasLib, {
        header: 'SCANNED CONTRACT PAGE ONE',
        lines: ['CLAUSE ALPHA 1001', 'OBLIGATION AMOUNT 750.00']
      })
    )
      .jpeg({ quality: 92 })
      .toBuffer()
    const scanPage2Jpeg = await sharp(
      await renderTextCardPng(canvasLib, {
        header: 'SCANNED CONTRACT PAGE TWO',
        lines: ['SIGNATURE BLOCK VERIFIED', 'EFFECTIVE YEAR 2026']
      })
    )
      .jpeg({ quality: 92 })
      .toBuffer()
    const scannedBodyJpeg = await sharp(
      await renderTextCardPng(canvasLib, {
        width: 1150,
        height: 1200,
        header: 'SCANNED ANNEX BODY 9920',
        lines: ['COUNTERSIGNED RECEIPT LINE', 'VERIFICATION TOKEN OMEGA77']
      })
    )
      .jpeg({ quality: 92 })
      .toBuffer()

    const logoCanvas = canvasLib.createCanvas(180, 72)
    const logoCtx = logoCanvas.getContext('2d')
    logoCtx.fillStyle = '#1e3a8a'
    logoCtx.fillRect(0, 0, 180, 72)
    const smallLogoJpeg = await sharp(Buffer.from(logoCanvas.toBuffer('image/png')))
      .jpeg({ quality: 92 })
      .toBuffer()

    const blankPngBytes = await sharp({
      create: { width: 900, height: 1100, channels: 3, background: { r: 255, g: 255, b: 255 } }
    })
      .png()
      .toBuffer()
    const blankJpegBytes = await sharp(blankPngBytes).jpeg({ quality: 95 }).toBuffer()

    const f1DigitalPdf = join(sourcesDir, '1_digital_clean.pdf')
    writeFileSync(
      f1DigitalPdf,
      buildSyntheticPdfBuffer([
        {
          kind: 'native-text',
          lines: [
            'CLEAN DIGITAL STATEMENT 2026',
            'Selectable native body text with zero raster images.'
          ]
        }
      ])
    )
    const f2LogoPdf = join(sourcesDir, '2_logo_digital.pdf')
    writeFileSync(
      f2LogoPdf,
      buildSyntheticPdfBuffer([
        {
          kind: 'native-body-plus-small-logo',
          bodyLines: [
            'LETTERHEAD DIGITAL SUMMARY 5501',
            'This page has full selectable body text and only a tiny decorative logo.',
            'Balance Due: 0.00 USD'
          ],
          logoJpegBytes: smallLogoJpeg,
          logoPixelWidth: 180,
          logoPixelHeight: 72
        }
      ])
    )
    const f3MixedPdf = join(sourcesDir, '3_mixed_header_scan.pdf')
    writeFileSync(
      f3MixedPdf,
      buildSyntheticPdfBuffer([
        {
          kind: 'native-header-plus-scanned-body',
          headerLines: [
            'PERSONAL VAULT RUNNING HEADER — ANNEX 3',
            'Digital stamp above scanned body image'
          ],
          bodyJpegBytes: scannedBodyJpeg,
          bodyPixelWidth: 1150,
          bodyPixelHeight: 1200
        }
      ])
    )
    const f4ScannedPdf = join(sourcesDir, '4_scanned_only.pdf')
    writeFileSync(
      f4ScannedPdf,
      buildSyntheticPdfBuffer([
        { kind: 'scanned-image', pixelWidth: 1200, pixelHeight: 1550, jpegBytes: scanPage1Jpeg },
        { kind: 'scanned-image', pixelWidth: 1200, pixelHeight: 1550, jpegBytes: scanPage2Jpeg }
      ])
    )
    const f5BlankPdf = join(sourcesDir, '5_blank_scan.pdf')
    writeFileSync(
      f5BlankPdf,
      buildSyntheticPdfBuffer([
        { kind: 'scanned-image', pixelWidth: 900, pixelHeight: 1100, jpegBytes: blankJpegBytes }
      ])
    )
    const f6ReceiptPng = join(sourcesDir, '6_selected_receipt.png')
    writeFileSync(f6ReceiptPng, receiptPngBytes)
    const f7ReceiptDupPng = join(sourcesDir, '7_selected_receipt_dup.png')
    writeFileSync(f7ReceiptDupPng, receiptPngBytes)
    const f8OrdinaryPhotoPng = join(sourcesDir, '8_ordinary_vacation_photo.png')
    writeFileSync(f8OrdinaryPhotoPng, blankPngBytes)

    const trackedFiles = [
      f1DigitalPdf,
      f2LogoPdf,
      f3MixedPdf,
      f4ScannedPdf,
      f5BlankPdf,
      f6ReceiptPng,
      f7ReceiptDupPng,
      f8OrdinaryPhotoPng,
      trainedDataSourcePath
    ]
    const initialDigests = new Map()
    for (const p of trackedFiles) {
      const st = statSync(p)
      initialDigests.set(p, { sha256: sha256Of(readFileSync(p)), mtimeMs: st.mtimeMs })
    }

    const catalogPath = join(tempRoot, 'main-catalog.db')
    let catalog = catalogMod.CatalogDatabase.open({ catalogPath })
    openCatalogs.push(catalog)
    catalog.registerSource(sourcesDir)

    const seedItem = (filePath, fileName, ext, category) => {
      const st = statSync(filePath)
      const sha = sha256Of(readFileSync(filePath))
      catalog.persistDiscoveryBatch(sourcesDir, [
        {
          originalPath: filePath,
          fileName,
          extension: ext,
          category,
          byteSize: st.size,
          birthtimeMs: st.birthtimeMs,
          mtimeMs: st.mtimeMs,
          discoveredAtMs: Date.now()
        }
      ])
      catalog.recordHashObservationsBatch([
        {
          originalPath: filePath,
          sha256: sha,
          observedByteSize: st.size,
          observedMtimeMs: st.mtimeMs,
          hashedAtMs: Date.now()
        }
      ])
    }

    seedItem(f1DigitalPdf, '1_digital_clean.pdf', '.pdf', 'document') // id 1
    seedItem(f2LogoPdf, '2_logo_digital.pdf', '.pdf', 'document') // id 2
    seedItem(f3MixedPdf, '3_mixed_header_scan.pdf', '.pdf', 'document') // id 3
    seedItem(f4ScannedPdf, '4_scanned_only.pdf', '.pdf', 'document') // id 4
    seedItem(f5BlankPdf, '5_blank_scan.pdf', '.pdf', 'document') // id 5
    seedItem(f6ReceiptPng, '6_selected_receipt.png', '.png', 'photo') // id 6
    seedItem(f7ReceiptDupPng, '7_selected_receipt_dup.png', '.png', 'photo') // id 7
    seedItem(f8OrdinaryPhotoPng, '8_ordinary_vacation_photo.png', '.png', 'photo') // id 8

    const sharedBudget = new ocrMod.AppWorkerBudget(3)
    let peakLiveWorkers = 0
    const budgetSampler = setInterval(() => {
      const live = sharedBudget.getLiveCount()
      if (live > peakLiveWorkers) peakLiveWorkers = live
    }, 10)
    shutdownFns.push(async () => clearInterval(budgetSampler))

    // 4. Model Manager Gating (Missing Model Rejection -> Verified Offline Import)
    const modelManager = new ocrMod.OcrModelManager({
      modelsRootDir,
      getApprovedRoots: () => [sourcesDir],
      getVaultRoot: () => null
    })
    await modelManager.initialize()

    const appPathForWorkers = mode === 'unpacked' ? asarPath : rootDir
    const ocrCoord = new ocrMod.DocumentOcrCoordinator({
      catalog,
      modelManager,
      workerBudget: sharedBudget,
      appPath: appPathForWorkers,
      isPackaged: mode === 'unpacked'
    })
    shutdownFns.push(() => ocrCoord.shutdown())

    let missingRejectedCode = null
    try {
      await ocrCoord.startOcr({ scope: 'ocr_needed' })
    } catch (err) {
      missingRejectedCode = err?.code ?? null
    }
    assertCondition(
      missingRejectedCode === 'OCR_MODEL_MISSING',
      `Expected OCR_MODEL_MISSING before model provisioning, got ${missingRejectedCode}`
    )
    assertCondition(
      catalog.getDocumentOcrRepository().getLatestDocumentOcrJob() === null,
      'Expected 0 OCR jobs created when model is missing'
    )

    const importedStatus = await modelManager.importFromDirectory(modelImportDir)
    assertCondition(
      importedStatus.state === 'ready',
      `Model import failed: ${importedStatus.error}`
    )
    recordPass('model_manager_gating_and_verified_offline_import', importedStatus.modelId)

    // 5. Run Stage 7B Native Extraction & Verify Conservative ocr_candidate_page_count
    const nativeCoord = new docsMod.DocumentExtractionCoordinator({
      catalog,
      workerBudget: sharedBudget
    })
    shutdownFns.push(() => nativeCoord.shutdown())

    await nativeCoord.startExtraction({ scope: 'all' })
    await nativeCoord.waitForIdle()
    assertCondition(
      nativeCoord.getProgress().status === 'completed' &&
        nativeCoord.getProgress().extractedDocuments === 3 &&
        nativeCoord.getProgress().noTextDocuments === 2,
      'Unexpected Stage 7B native extraction counts'
    )
    recordPass('stage_7b_native_extraction_preserved', '3 extracted, 2 no_text_ocr_required')

    // 6. Run Stage 7C startOcr({ scope: 'ocr_needed' }) + Concurrent Thumbnail Under AppWorkerBudget(3)
    const thumbCoord = new thumbsMod.ThumbnailCoordinator({
      cacheDir: thumbCacheDir,
      approvedRoots: () => [sourcesDir],
      workerBudget: sharedBudget,
      maxActiveJobs: 2
    })
    shutdownFns.push(() => thumbCoord.shutdown())

    await Promise.all([
      thumbCoord.requestThumbnail({
        locationId: 6,
        sourcePath: f6ReceiptPng,
        expectedByteSize: statSync(f6ReceiptPng).size,
        expectedMtimeMs: statSync(f6ReceiptPng).mtimeMs
      }),
      ocrCoord.startOcr({ scope: 'ocr_needed' }).then(() => ocrCoord.waitForIdle())
    ])

    const neededProg = ocrCoord.getProgress()
    assertCondition(
      neededProg.status === 'completed' &&
        neededProg.totalItems === 3 &&
        neededProg.extractedItems === 2 &&
        neededProg.noTextItems === 1,
      `Unexpected ocr_needed progress: ${JSON.stringify(neededProg)}`
    )

    // Digital PDFs [1, 2] were cleanly skipped in ocr_needed
    assertCondition(
      ocrCoord.getOcrState(1)?.ocrStatus === 'not_processed' &&
        ocrCoord.getOcrState(2)?.ocrStatus === 'not_processed',
      'Digital PDFs should not be OCRd in ocr_needed scope'
    )

    // Mixed PDF (3) has BOTH header & scanned body in OCR track, while native track remains untouched!
    const mixedOcr = ocrCoord.getOcrPreview(3)
    assertCondition(
      mixedOcr?.ocrStatus === 'extracted' &&
        mixedOcr?.extractionMethod === 'ocr_hybrid_pdf' &&
        mixedOcr?.extractedText?.toUpperCase().includes('PERSONAL VAULT RUNNING HEADER') &&
        mixedOcr?.extractedText?.toUpperCase().includes('SCANNED'),
      `Unexpected mixed PDF OCR preview: ${JSON.stringify(mixedOcr)}`
    )
    assertCondition(
      nativeCoord.getPreview(3)?.extractionStatus === 'extracted' &&
        nativeCoord.getPreview(3)?.recipeVersion === 'doc_extract_v1',
      'Mixed PDF Stage 7B native preview must remain untouched'
    )

    // Scanned-only PDF (4) & Blank PDF (5)
    assertCondition(
      ocrCoord.getOcrPreview(4)?.ocrStatus === 'extracted' &&
        ocrCoord.getOcrPreview(4)?.ocrPageCount === 2,
      'Expected 2-page OCR extraction on scanned_only.pdf'
    )
    assertCondition(
      ocrCoord.getOcrPreview(5)?.ocrStatus === 'ocr_no_text' &&
        ocrCoord.getOcrPreview(5)?.extractedText === null,
      'Expected honest ocr_no_text outcome on blank_scan.pdf'
    )
    recordPass(
      'ocr_needed_coexistence_mixed_pdf_and_honest_blank',
      'totalItems=3, hybrid+scanned+ocr_no_text verified'
    )

    // 7. Strict Photo Protection: Bulk 'all' NEVER touches category='photo', while 'selected' OCRs receipt & reuses duplicate
    assertCondition(
      ocrCoord.getOcrState(6)?.ocrStatus === 'not_processed' &&
        ocrCoord.getOcrState(7)?.ocrStatus === 'not_processed' &&
        ocrCoord.getOcrState(8)?.ocrStatus === 'not_processed',
      'Bulk ocr_needed must touch 0 photos'
    )

    await ocrCoord.ocrSelected({ fileLocationIds: [6, 7] })
    await ocrCoord.waitForIdle()
    const selProg = ocrCoord.getProgress()
    assertCondition(
      selProg.status === 'completed' &&
        selProg.totalItems === 2 &&
        selProg.extractedItems === 1 &&
        selProg.reusedItems === 1,
      `Expected 1 extracted + 1 reused on selected receipt images, got ${JSON.stringify(selProg)}`
    )
    assertCondition(
      ocrCoord.getOcrPreview(6)?.extractionMethod === 'ocr_image_tesseract' &&
        ocrCoord.getOcrPreview(6)?.extractedText?.toUpperCase().includes('GROCERY') &&
        ocrCoord.getOcrPreview(7)?.ocrStatus === 'extracted' &&
        ocrCoord.getOcrState(8)?.ocrStatus === 'not_processed',
      'Ordinary unselected photo (8) must remain not_processed'
    )
    recordPass(
      'selected_document_image_ocr_reuse_and_zero_bulk_photo_ocr',
      '1 extracted, 1 reused, ordinary photo untouched'
    )

    // 8. Independent Staleness & Stale-Commit Rejection (REVISION_MISMATCH)
    const ocrRepo = catalog.getDocumentOcrRepository()
    const rotatedState = ocrRepo.getDocumentOcrState(3, {
      ocrModelManifestSha256: 'f'.repeat(64)
    })
    assertCondition(
      rotatedState?.ocrStatus === 'stale' &&
        nativeCoord.getPreview(3)?.extractionStatus === 'extracted',
      'Rotating OCR manifest must mark OCR stale without staling native extraction'
    )
    const staleCommit = ocrRepo.upsertDocumentOcrExtraction({
      fileLocationId: 3,
      expectedDiscoveryObservationId: 999999,
      expectedContentRevision: 'rev:stale',
      contentSha256: '0'.repeat(64),
      observedByteSize: 1,
      observedMtimeMs: 1,
      recipeVersion: 'doc_ocr_v1',
      ocrModelId: importedStatus.modelId,
      ocrModelManifestSha256: importedStatus.modelManifestSha256,
      ocrLanguage: 'eng',
      extractionMethod: 'ocr_pdf_tesseract',
      ocrStatus: 'extracted',
      statusDetail: null,
      extractedText: 'STALE',
      extractedCharCount: 5,
      pageCount: 1,
      ocrPageCount: 1,
      nativeOnlyPageCount: 0,
      skippedBlankPageCount: 0,
      meanConfidence: 80,
      truncated: false,
      truncationReason: null
    })
    assertCondition(
      staleCommit.committed === false && staleCommit.reason === 'REVISION_MISMATCH',
      'Expected REVISION_MISMATCH on stale commit'
    )
    recordPass('independent_staleness_and_stale_commit_rejection', 'REVISION_MISMATCH verified')

    // 9. Active Mid-OCR Cancellation
    const cancelCoord = new ocrMod.DocumentOcrCoordinator({
      catalog,
      modelManager,
      workerBudget: sharedBudget,
      appPath: appPathForWorkers,
      isPackaged: mode === 'unpacked',
      ocrOptions: { pageDelayMs: 250 }
    })
    shutdownFns.push(() => cancelCoord.shutdown())

    await cancelCoord.ocrSelected({ fileLocationIds: [4], forceReocr: true })
    await new Promise((r) => setTimeout(r, 90))
    const cancelledProg = await cancelCoord.cancelOcr()
    assertCondition(
      cancelledProg.status === 'cancelled',
      `Expected cancelled status, got ${cancelledProg.status}`
    )
    recordPass('active_mid_ocr_cancellation', 'worker terminated cleanly')

    // 10. Incomplete-Snapshot Cleanup + Simulated Crash & Restart Interrupted Resume
    const rawDb = catalog.getRawDatabaseForTesting()
    rawDb
      .prepare(
        `INSERT INTO document_ocr_jobs (
           id, scope_kind, status, recipe_version, ocr_model_id, ocr_model_manifest_sha256,
           ocr_language, force_reocr, snapshot_complete, started_at_ms, updated_at_ms
         ) VALUES ('partial-crash-job', 'all', 'running', 'doc_ocr_v1', ?, ?, 'eng', 0, 0, 1000, 1000);`
      )
      .run(importedStatus.modelId, importedStatus.modelManifestSha256)
    writeFileSync(`${catalogPath}.ocr-snapshot-partial-crash-job.tmp`, '{"f":1,"d":1,"r":"rev"}\n')

    await ocrRepo.createDocumentOcrJob({
      jobId: 'resumable-crash-job',
      scopeKind: 'selected',
      fileLocationIds: [6],
      forceReocr: true,
      recipeVersion: 'doc_ocr_v1',
      ocrModelId: importedStatus.modelId,
      ocrModelManifestSha256: importedStatus.modelManifestSha256,
      ocrLanguage: 'eng'
    })

    await cancelCoord.shutdown()
    await ocrCoord.shutdown()
    await nativeCoord.shutdown()
    await thumbCoord.shutdown()
    catalog.close()

    // Reopen catalog on simulated restart
    catalog = catalogMod.CatalogDatabase.open({ catalogPath })
    openCatalogs.push(catalog)

    const restartCoord = new ocrMod.DocumentOcrCoordinator({
      catalog,
      modelManager,
      workerBudget: sharedBudget,
      appPath: appPathForWorkers,
      isPackaged: mode === 'unpacked'
    })
    shutdownFns.push(() => restartCoord.shutdown())

    const initRestartProg = restartCoord.initialize()
    assertCondition(
      catalog.getDocumentOcrRepository().getDocumentOcrJob('partial-crash-job') === null &&
        !existsSync(`${catalogPath}.ocr-snapshot-partial-crash-job.tmp`),
      'Incomplete snapshot_complete=0 job and .tmp file must be discarded on initialize()'
    )
    assertCondition(
      initRestartProg.jobId === 'resumable-crash-job' &&
        initRestartProg.status === 'interrupted' &&
        initRestartProg.pendingItems === 1,
      `Expected resumable-crash-job to be interrupted with 1 pending item, got ${JSON.stringify(initRestartProg)}`
    )

    await restartCoord.resumeOcr()
    await restartCoord.waitForIdle()
    const resumedFinal = restartCoord.getProgress()
    assertCondition(
      resumedFinal.status === 'completed' && resumedFinal.extractedItems === 1,
      `Expected resumed job completion, got ${JSON.stringify(resumedFinal)}`
    )
    await restartCoord.shutdown()
    recordPass('incomplete_snapshot_cleanup_and_restart_interrupted_resume', 'resumed to completed')

    // 11. Shared AppWorkerBudget(3) Accounting & Bitwise Source Preservation
    clearInterval(budgetSampler)
    assertCondition(
      peakLiveWorkers <= 3,
      `Shared AppWorkerBudget(3) exceeded: peakLiveWorkers=${peakLiveWorkers}`
    )
    assertCondition(
      sharedBudget.getLiveCount() === 0 &&
        sharedBudget.getWorkerCount() === 0 &&
        sharedBudget.getReservedCount() === 0,
      `Leaked workers or reservations: live=${sharedBudget.getLiveCount()}, reserved=${sharedBudget.getReservedCount()}`
    )
    for (const p of trackedFiles) {
      const before = initialDigests.get(p)
      const afterSt = statSync(p)
      const afterSha = sha256Of(readFileSync(p))
      assertCondition(
        afterSha === before.sha256 && afterSt.mtimeMs === before.mtimeMs,
        `Source preservation violated for ${p}`
      )
    }
    recordPass(
      'shared_worker_budget_zero_leaks_and_bitwise_source_preservation',
      `peakLiveWorkers=${peakLiveWorkers}, 0 leaked, ${trackedFiles.length}/${trackedFiles.length} preserved`
    )

    console.log(
      `\n[VERIFY_OCR_PERSISTENCE_PASS] mode=${mode} checks=${checks.length}/${checks.length} peakLiveWorkers=${peakLiveWorkers}`
    )
  } finally {
    for (const fn of shutdownFns.reverse()) {
      try {
        await fn()
      } catch {
        // ignore shutdown error
      }
    }
    for (const cat of openCatalogs) {
      try {
        if (!cat.isClosed()) cat.close()
      } catch {
        // ignore close error
      }
    }
    try {
      rmSync(tempRoot, { recursive: true, force: true })
    } catch {
      // ignore temp cleanup error
    }
  }
}

async function buildIsolatedUnpackedApp() {
  console.log(
    `[verify-ocr-persistence] Building Electron bundles and isolated unpacked app in ${unpackedOutputRoot}...`
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

async function main() {
  if (process.versions.electron && process.env.PV_INSIDE_ELECTRON === '1') {
    try {
      await runInsideElectron()
      process.exit(0)
    } catch (err) {
      console.error('[VERIFY_OCR_PERSISTENCE_FAIL]', err)
      process.exit(1)
    }
    return
  }

  const trainedDataPath = getDefaultTrainedDataPath()
  if (!existsSync(trainedDataPath)) {
    console.error(
      `[VERIFY_OCR_PERSISTENCE_FAIL] Offline pinned eng.traineddata not found at ${trainedDataPath}.`
    )
    process.exit(1)
  }

  let binaryPath = electronPath
  let asarPath = ''
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
    asarPath = getUnpackedAsarPathFromExe(candidateExe)
    assertCondition(existsSync(binaryPath), `Unpacked executable not found at ${binaryPath}`)
    assertCondition(existsSync(asarPath), `Unpacked app.asar not found at ${asarPath}`)
  } else {
    console.log('[verify-ocr-persistence] Compiling production bundles via `npm run build`...')
    const buildRes = spawnSync('npm', ['run', 'build'], {
      cwd: rootDir,
      stdio: 'inherit',
      shell: true
    })
    if (buildRes.status !== 0) {
      process.exit(buildRes.status ?? 1)
    }
  }

  const neutralCwd = mkdtempSync(
    join(tmpdir(), `pv-ocr-persistence-cwd-${isUnpackedMode ? 'unpacked' : 'built'}-`)
  )
  try {
    console.log(
      `[verify-ocr-persistence] Launching ${isUnpackedMode ? 'unpacked executable' : 'built Electron'} from neutral cwd: ${neutralCwd}`
    )
    const runRes = spawnSync(
      binaryPath,
      [fileURLToPath(import.meta.url), ...process.argv.slice(2)],
      {
        cwd: neutralCwd,
        stdio: 'inherit',
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          ELECTRON_NO_ATTACH_CONSOLE: '1',
          PV_INSIDE_ELECTRON: '1',
          PV_VERIFY_MODE: isUnpackedMode ? 'unpacked' : 'built',
          PV_UNPACKED_ASAR_PATH: asarPath,
          PV_TRAINED_DATA_SOURCE_PATH: trainedDataPath
        }
      }
    )
    process.exit(runRes.status ?? 1)
  } finally {
    try {
      rmSync(neutralCwd, { recursive: true, force: true })
    } catch {
      // ignore cleanup error
    }
  }
}

void main()
