#!/usr/bin/env node
/**
 * Personal Vault — Real Electron Stage 7D Slice 2 (Persistence, Snapshot & Bounded Ranking) Verification
 *
 * Exercises compiled production Stage 7D Slice 2 modules (`out/main/catalog.js`,
 * `out/main/document_semantic.js`, `out/main/document_semantic_worker.js`, and
 * `out/main/document_snapshot_worker.js`) inside the real Electron runtime from a
 * neutral `os.tmpdir()` working directory in both `--mode=built` and `--mode=unpacked`
 * (outputting to `dist-stage-7d-persistence-verify` so `dist/` and earlier verification
 * executables remain untouched).
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
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
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const __dirname = resolve(fileURLToPath(import.meta.url), '..')
const rootDir = resolve(__dirname, '..')
const requireFromRoot = createRequire(join(rootDir, 'package.json'))

const isUnpackedMode = process.argv.includes('--mode=unpacked')
const executableArg =
  process.argv.find((arg) => arg.startsWith('--exe=')) ??
  process.argv.find((arg) => arg.startsWith('--executable='))
const outputDirArg = process.argv.find((arg) => arg.startsWith('--output-dir='))
const modelDirArg = process.argv.find((arg) => arg.startsWith('--model-dir='))

const unpackedOutputDirName = outputDirArg
  ? outputDirArg.slice('--output-dir='.length)
  : 'dist-stage-7d-persistence-verify'
const unpackedOutputRoot = resolve(rootDir, unpackedOutputDirName)

function getDefaultModelDir() {
  if (modelDirArg) {
    return resolve(modelDirArg.slice('--model-dir='.length))
  }
  if (process.env.PV_DOC_SEMANTIC_MODEL_DIR) {
    return resolve(process.env.PV_DOC_SEMANTIC_MODEL_DIR)
  }
  return join(rootDir, 'spikes', 'doc-semantic-eval', '.model-cache', 'bge-small-en-v1.5')
}

function getUnpackedExecutablePath(outRoot) {
  if (executableArg) {
    const val = executableArg.startsWith('--exe=')
      ? executableArg.slice('--exe='.length)
      : executableArg.slice('--executable='.length)
    return resolve(val)
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

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

async function buildIsolatedUnpackedApp() {
  console.log(
    `[verify-doc-semantic-persistence] Building isolated unpacked app into ${unpackedOutputDirName}...`
  )
  const buildRes = spawnSync('npm', ['run', 'build'], {
    cwd: rootDir,
    stdio: 'inherit',
    shell: true
  })
  if (buildRes.status !== 0) {
    throw new Error(`npm run build failed with exit code ${buildRes.status}`)
  }

  const builderRes = spawnSync(
    'npx',
    ['electron-builder', '--dir', `--config.directories.output=${unpackedOutputDirName}`],
    {
      cwd: rootDir,
      stdio: 'inherit',
      shell: true
    }
  )
  if (builderRes.status !== 0) {
    throw new Error(`electron-builder --dir failed with exit code ${builderRes.status}`)
  }
}

if (!process.versions.electron) {
  ;(async () => {
    const modelDir = getDefaultModelDir()
    if (!existsSync(modelDir)) {
      console.error(
        `[verify-doc-semantic-persistence] Offline pinned BGE model dir not found at ${modelDir}.`
      )
      process.exitCode = 1
      return
    }

    let binaryPath = electronPath
    if (isUnpackedMode) {
      const candidateExe = getUnpackedExecutablePath(unpackedOutputRoot)
      const forceRebuild = process.argv.includes('--rebuild')
      if (!existsSync(candidateExe) || forceRebuild) {
        if (executableArg && !existsSync(candidateExe)) {
          throw new Error(`Explicit executable not found: ${candidateExe}`)
        }
        await buildIsolatedUnpackedApp()
      }
      binaryPath = candidateExe
    } else {
      console.log(
        '[verify-doc-semantic-persistence] Compiling production bundles via `npm run build`...'
      )
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
      join(tmpdir(), `pv-doc-sem-s2-cwd-${isUnpackedMode ? 'unpacked' : 'built'}-`)
    )
    try {
      console.log(
        `[verify-doc-semantic-persistence] Launching ${isUnpackedMode ? 'unpacked executable' : 'built Electron'} from neutral cwd: ${neutralCwd}`
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
    console.error('[verify-doc-semantic-persistence] Fatal launcher error:', err)
    process.exitCode = 1
  })
} else {
  runInnerVerification().catch((err) => {
    console.error('[verify-doc-semantic-persistence] Verification FAILED:', err)
    process.exitCode = 1
  })
}

async function runInnerVerification() {
  const modelDir = getDefaultModelDir()
  const modelFiles = [
    'config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'special_tokens_map.json',
    'onnx/model_quantized.onnx'
  ]
  const modelSnapshotsBefore = new Map()
  for (const rel of modelFiles) {
    const abs = join(modelDir, rel)
    assertCondition(existsSync(abs), `Missing cached BGE artifact: ${abs}`)
    const st = statSync(abs)
    modelSnapshotsBefore.set(rel, {
      byteSize: st.size,
      mtimeMs: st.mtimeMs,
      sha256: sha256File(abs)
    })
  }

  const exePath = process.execPath
  const asarPath = isUnpackedMode ? getUnpackedAsarPathFromExe(exePath) : null
  const appBaseDir = isUnpackedMode ? asarPath : rootDir

  const preloadPath = join(appBaseDir, 'out', 'preload', 'index.js')
  const catalogBundlePath = join(appBaseDir, 'out', 'main', 'catalog.js')
  const docOcrBundlePath = join(appBaseDir, 'out', 'main', 'document_ocr.js')
  const docSemanticBundlePath = join(appBaseDir, 'out', 'main', 'document_semantic.js')
  const docSemanticWorkerPath = join(appBaseDir, 'out', 'main', 'document_semantic_worker.js')
  const docSnapshotWorkerPath = join(appBaseDir, 'out', 'main', 'document_snapshot_worker.js')

  const preloadCode = readFileSync(preloadPath, 'utf8')
  const preloadRequires = [...preloadCode.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1])
  assertCondition(
    preloadRequires.every((mod) => mod === 'electron'),
    `Sandboxed preload must only require 'electron', found: ${preloadRequires.join(', ')}`
  )

  const { CatalogDatabase, CURRENT_SCHEMA_VERSION, buildDocumentContentRevision } =
    requireFromRoot(catalogBundlePath)
  const {
    OCR_MODEL_ID,
    OCR_MODEL_LANGUAGE,
    PINNED_OCR_MANIFEST_SHA256,
    DOCUMENT_OCR_RECIPE_VERSION
  } = requireFromRoot(docOcrBundlePath)
  const { DocSemanticModelManager, DocumentSemanticCoordinator } =
    requireFromRoot(docSemanticBundlePath)

  const tempWork = mkdtempSync(join(tmpdir(), 'pv-doc-sem-s2-verify-'))
  const dbPath = join(tempWork, 'catalog.db')
  const modelsRootDir = join(tempWork, 'models')
  const approvedDocsDir = join(tempWork, 'approved-docs')
  mkdirSync(modelsRootDir, { recursive: true })
  mkdirSync(approvedDocsDir, { recursive: true })

  let catalog = null
  let coordinator = null

  const passedChecks = []
  const recordCheck = (name, detail) => {
    passedChecks.push({ name, detail })
    console.log(`[PASS] ${name}: ${detail}`)
  }

  try {
    recordCheck('1. Sandboxed preload & Migration 14 check', `schema=${CURRENT_SCHEMA_VERSION}`)
    assertCondition(
      CURRENT_SCHEMA_VERSION === 14,
      `Expected schema 14, got ${CURRENT_SCHEMA_VERSION}`
    )

    catalog = CatalogDatabase.open({ catalogPath: dbPath })
    const raw = catalog.getRawDatabaseForTesting()
    const now = Date.now()
    const srcRes = raw
      .prepare(
        `INSERT INTO sources (root_path, normalized_root_path, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?);`
      )
      .run(approvedDocsDir, approvedDocsDir.toLowerCase(), now, now)
    const sourceId = Number(srcRes.lastInsertRowid)

    const seedDoc = (fileName, sha, nativeText, ocrText) => {
      const ext = '.' + fileName.split('.').pop().toLowerCase()
      const fRes = raw
        .prepare(
          `INSERT INTO file_locations (
             source_id, original_path, normalized_path, file_name, extension, category, created_at_ms, updated_at_ms
           ) VALUES (?, ?, ?, ?, ?, 'document', ?, ?);`
        )
        .run(
          sourceId,
          join(approvedDocsDir, fileName),
          join(approvedDocsDir, fileName).toLowerCase(),
          fileName,
          ext,
          now,
          now
        )
      const fileId = Number(fRes.lastInsertRowid)
      const dRes = raw
        .prepare(
          `INSERT INTO discovery_observations (
             file_location_id, byte_size, filesystem_birthtime_ms, filesystem_mtime_ms, observed_at_ms, last_seen_at_ms, is_current
           ) VALUES (?, 2048, ?, ?, ?, ?, 1);`
        )
        .run(fileId, now, now, now, now)
      const obsId = Number(dRes.lastInsertRowid)
      raw
        .prepare(
          `INSERT INTO hash_observations (
             file_location_id, discovery_observation_id, sha256, observed_byte_size, observed_mtime_ms, hashed_at_ms, is_active
           ) VALUES (?, ?, ?, 2048, ?, ?, 1);`
        )
        .run(fileId, obsId, sha, now, now)
      const rev = buildDocumentContentRevision({
        discoveryObservationId: obsId,
        byteSize: 2048,
        filesystemMtimeMs: now,
        activeHash: sha
      })
      if (nativeText) {
        raw
          .prepare(
            `INSERT INTO document_extractions (
               file_location_id, discovery_observation_id, content_sha256,
               observed_byte_size, observed_mtime_ms, content_revision, recipe_version,
               extraction_status, extracted_text, extracted_char_count, is_current, extracted_at_ms
             ) VALUES (?, ?, ?, 2048, ?, ?, 'doc_extract_v1', 'extracted', ?, ?, 1, ?);`
          )
          .run(fileId, obsId, sha, now, rev, nativeText, nativeText.length, now)
      }
      if (ocrText) {
        raw
          .prepare(
            `INSERT INTO document_ocr_extractions (
               file_location_id, discovery_observation_id, content_sha256,
               observed_byte_size, observed_mtime_ms, content_revision, recipe_version,
               ocr_model_id, ocr_model_manifest_sha256, ocr_language,
               extraction_method, ocr_status, extracted_text, extracted_char_count, is_current, extracted_at_ms
             ) VALUES (
               ?, ?, ?, 2048, ?, ?, ?,
               ?, ?, ?,
               'ocr_pdf_tesseract', 'extracted', ?, ?, 1, ?
             );`
          )
          .run(
            fileId,
            obsId,
            sha,
            now,
            rev,
            DOCUMENT_OCR_RECIPE_VERSION,
            OCR_MODEL_ID,
            PINNED_OCR_MANIFEST_SHA256,
            OCR_MODEL_LANGUAGE,
            ocrText,
            ocrText.length,
            now
          )
      }
      return fileId
    }

    const invoiceFileId = seedDoc(
      'cloud-invoice-2026.pdf',
      'a'.repeat(64),
      'Northwind Cloud Infrastructure Invoice #INV-2026-441. Total due: $1,250.00.',
      'Scanned receipt footer: wire transfer completed.'
    )
    seedDoc(
      'apartment-lease-2026.pdf',
      'b'.repeat(64),
      null,
      'Residential apartment lease agreement. Monthly rent $2,400 due on the 1st.'
    )

    // Seed incomplete snapshot & leftover tmp file for startup cleanup check
    writeFileSync(join(tempWork, '.doc-semantic-snapshot-stale.tmp'), '{"f":1}\n', 'utf8')
    raw
      .prepare(
        `INSERT INTO document_semantic_jobs (
           id, scope_kind, status, doc_model_id, doc_model_commit, doc_model_manifest_sha256,
           chunking_recipe_version, snapshot_complete, started_at_ms, updated_at_ms
         ) VALUES ('stale-snap', 'all', 'running', 'm', 'c', 's', 'r', 0, 1000, 1000);`
      )
      .run()

    const modelManager = new DocSemanticModelManager({
      modelsRootDir,
      getApprovedRoots: () => [approvedDocsDir],
      getVaultRoot: () => null
    })
    await modelManager.importFromDirectory(modelDir)

    coordinator = new DocumentSemanticCoordinator({
      catalog,
      modelManager,
      workerScriptPath: docSemanticWorkerPath,
      snapshotWorkerScriptPath: docSnapshotWorkerPath,
      isPackaged: isUnpackedMode,
      appPath: appBaseDir
    })
    coordinator.initialize()
    assertCondition(
      catalog.getDocumentSemanticRepository().getJob('stale-snap') === null &&
        !readdirSync(tempWork).some((n) => n.startsWith('.doc-semantic-snapshot-')),
      'Expected incomplete snapshot cleanup on initialize()'
    )
    recordCheck('2. Incomplete snapshot cleanup & model import', 'cleaned stale snapshot')

    // Index all 3 tracks (invoice native+ocr, lease ocr)
    const job = await coordinator.startIndexing({ scopeKind: 'unindexed_or_stale' })
    assertCondition(
      job && job.status === 'completed' && job.processedItems === 3 && job.indexedItems === 3,
      `Expected 3 completed indexed tracks, got ${JSON.stringify(job)}`
    )
    recordCheck(
      '3. Real Electron snapshot & dual-track indexing',
      `indexedItems=${job.indexedItems}`
    )

    // Search before restart
    const search1 = await coordinator.searchDocuments('cloud infrastructure invoice total due')
    assertCondition(
      search1.totalMatched === 2 &&
        search1.items[0].fileLocationId === invoiceFileId &&
        search1.items[0].textSourceKind === 'native',
      `Unexpected top search result: ${JSON.stringify(search1.items[0])}`
    )
    recordCheck(
      '4. Real Electron bounded max-chunk search',
      `topFile=${search1.items[0].fileName} (${search1.items[0].textSourceKind}, score=${search1.items[0].score.toFixed(4)})`
    )

    // Re-extract identical original bytes with changed extracted text -> must become stale & non-reusable
    raw
      .prepare('UPDATE document_extractions SET extracted_text = ? WHERE file_location_id = ?;')
      .run('Updated re-extracted text: solar battery installation guide.', invoiceFileId)
    catalog.bumpDocumentSemanticMutationSeq()
    const covAfterTextChange = await coordinator.refreshCoverage()
    assertCondition(
      covAfterTextChange.staleTracks === 1 && covAfterTextChange.indexedTracks === 2,
      `Expected 1 stale track after text change, got ${JSON.stringify(covAfterTextChange)}`
    )
    recordCheck(
      '5. Changed text on identical bytes marked stale',
      `staleTracks=${covAfterTextChange.staleTracks}`
    )

    // Restart persistence verification: shutdown, close DB, reopen, initialize, and verify persisted index
    await coordinator.shutdown()
    coordinator = null
    catalog.close()
    catalog = null

    catalog = CatalogDatabase.open({ catalogPath: dbPath })
    coordinator = new DocumentSemanticCoordinator({
      catalog,
      modelManager,
      workerScriptPath: docSemanticWorkerPath,
      snapshotWorkerScriptPath: docSnapshotWorkerPath,
      isPackaged: isUnpackedMode,
      appPath: appBaseDir
    })
    coordinator.initialize()
    const reindexJob = await coordinator.startIndexing({ scopeKind: 'unindexed_or_stale' })
    assertCondition(
      reindexJob && reindexJob.status === 'completed' && reindexJob.processedItems === 1,
      `Expected 1 reindexed stale track after restart, got ${JSON.stringify(reindexJob)}`
    )

    const searchAfterRestart = await coordinator.searchDocuments('monthly apartment rent')
    assertCondition(
      searchAfterRestart.totalMatched === 2 &&
        searchAfterRestart.items[0].fileName === 'apartment-lease-2026.pdf',
      `Expected apartment lease top after restart, got ${JSON.stringify(searchAfterRestart.items[0])}`
    )
    recordCheck(
      '6. Restart persistence & stale re-indexing',
      `topAfterRestart=${searchAfterRestart.items[0].fileName}`
    )

    await coordinator.shutdown()
    coordinator = null

    for (const [rel, snap] of modelSnapshotsBefore.entries()) {
      const abs = join(modelDir, rel)
      const st = statSync(abs)
      const sha = sha256File(abs)
      assertCondition(
        st.size === snap.byteSize && st.mtimeMs === snap.mtimeMs && sha === snap.sha256,
        `Cached BGE source file ${rel} was modified!`
      )
    }
    recordCheck('7. Model-cache bitwise preservation', `${passedChecks.length} checks passed`)

    console.log(
      `\n[verify-doc-semantic-persistence] ALL ${passedChecks.length} REAL-ELECTRON CHECKS PASSED (${isUnpackedMode ? 'unpacked' : 'built'}).`
    )
  } finally {
    if (coordinator) {
      await coordinator.shutdown().catch(() => {})
    }
    if (catalog && !catalog.isClosed()) {
      catalog.close()
    }
    rmSync(tempWork, { recursive: true, force: true })
  }
}
