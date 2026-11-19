#!/usr/bin/env node
/**
 * Personal Vault — Real Electron Stage 7E Slice 2 (Classification Persistence) Verification
 *
 * Exercises compiled production Stage 7E Slice 2 modules (`out/main/catalog.js`,
 * `out/main/document_classify_coordinator.js`, `out/main/document_snapshot_worker.js`,
 * `out/main/document_classify_worker.js`) inside the real Electron runtime from a neutral
 * `os.tmpdir()` working directory in both built (`--mode=built`) and isolated unpacked
 * (`--mode=unpacked`, outputting to `dist-stage-7e-persistence-verify`) modes.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
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

const unpackedOutputDirName = outputDirArg
  ? outputDirArg.slice('--output-dir='.length)
  : 'dist-stage-7e-persistence-verify'
const unpackedOutputRoot = resolve(rootDir, unpackedOutputDirName)

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

async function buildIsolatedUnpackedApp() {
  console.log(
    `[verify-doc-classify-persistence] Building isolated unpacked app into ${unpackedOutputDirName}...`
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
        '[verify-doc-classify-persistence] Compiling production bundles via `npm run build`...'
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
      join(tmpdir(), `pv-doc-cls-pers-cwd-${isUnpackedMode ? 'unpacked' : 'built'}-`)
    )
    try {
      console.log(
        `[verify-doc-classify-persistence] Launching ${isUnpackedMode ? 'unpacked executable' : 'built Electron'} from neutral cwd: ${neutralCwd}`
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
  })()
} else {
  ;(async () => {
    let passed = 0
    let failed = 0
    function record(ok, name, detail = '') {
      if (ok) {
        passed += 1
        console.log(`[PASS] ${name}${detail ? ` — ${detail}` : ''}`)
      } else {
        failed += 1
        console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`)
      }
    }

    const appRoot = isUnpackedMode ? getUnpackedAsarPathFromExe(process.execPath) : rootDir
    const tempDir = mkdtempSync(join(tmpdir(), 'pv-doc-cls-pers-'))

    try {
      const catalogMod = requireFromRoot(join(appRoot, 'out', 'main', 'catalog.js'))
      const coordMod = requireFromRoot(
        join(appRoot, 'out', 'main', 'document_classify_coordinator.js')
      )
      const classifyMod = requireFromRoot(join(appRoot, 'out', 'main', 'document_classify.js'))

      const { AnnotationJournal, CatalogDatabase, CURRENT_SCHEMA_VERSION } = catalogMod
      const { DocumentClassificationCoordinator } = coordMod
      const { AppWorkerBudget } = classifyMod

      const journal = new AnnotationJournal({ storageDir: join(tempDir, 'journal') })
      await journal.initialize()
      const catalogPath = join(tempDir, 'catalog.db')
      let catalog = CatalogDatabase.open({ catalogPath, journal })

      record(CURRENT_SCHEMA_VERSION === 15, 'Migration 15 schema version === 15')

      // Seed 3 documents (missing on disk to verify zero source-file reads)
      const db = catalog.getRawDb()
      const now = Date.now()
      const sourceRoot = join(tempDir, 'nonexistent-source')
      const sourceId = Number(
        db
          .prepare(
            'INSERT INTO sources (root_path, normalized_root_path, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?);'
          )
          .run(sourceRoot, sourceRoot.toLowerCase(), now, now).lastInsertRowid
      )

      const seedOne = (relPath, fileName, text, sha) => {
        const orig = join(sourceRoot, relPath)
        const flId = Number(
          db
            .prepare(
              `INSERT INTO file_locations (
                source_id, original_path, normalized_path, file_name, extension, category, created_at_ms, updated_at_ms
              ) VALUES (?, ?, ?, ?, '.txt', 'document', ?, ?);`
            )
            .run(sourceId, orig, orig.toLowerCase(), fileName, now, now).lastInsertRowid
        )
        const obsId = Number(
          db
            .prepare(
              `INSERT INTO discovery_observations (file_location_id, byte_size, filesystem_birthtime_ms, filesystem_mtime_ms, observed_at_ms, last_seen_at_ms, is_current)
               VALUES (?, ?, ?, ?, ?, ?, 1);`
            )
            .run(flId, text.length, now, now, now, now).lastInsertRowid
        )
        db.prepare(
          `INSERT INTO hash_observations (file_location_id, discovery_observation_id, sha256, observed_byte_size, observed_mtime_ms, hashed_at_ms, is_active) VALUES (?, ?, ?, ?, ?, ?, 1);`
        ).run(flId, obsId, sha, text.length, now, now)
        db.prepare(
          `INSERT INTO document_extractions (
            file_location_id, discovery_observation_id, content_sha256, observed_byte_size, observed_mtime_ms,
            content_revision, recipe_version, extraction_status, extracted_text, extracted_char_count, truncated, is_current, extracted_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, 'doc_extract_v1', 'extracted', ?, ?, 0, 1, ?);`
        ).run(
          flId,
          obsId,
          sha,
          text.length,
          now,
          `rev:${obsId}:${text.length}:${now}:${sha}`,
          text,
          text.length,
          now
        )
        return flId
      }

      const clutterId = seedOne(
        'repos/app/LICENSE.txt',
        'LICENSE.txt',
        'SPDX-License-Identifier: MIT\nPermission is hereby granted, free of charge, to any person obtaining a copy of the "Software".\nWITHOUT WARRANTY OF ANY KIND.\n',
        'a'.repeat(64)
      )
      const noteId = seedOne(
        'Notes/diary.txt',
        'diary.txt',
        'Personal reflection about our family garden and weekend plans with mom and dad in the spring.',
        'b'.repeat(64)
      )

      const budget = new AppWorkerBudget(3)
      let coordinator = new DocumentClassificationCoordinator({
        catalog,
        workerBudget: budget,
        appPath: appRoot,
        isPackaged: isUnpackedMode
      })

      try {
        const job = await coordinator.startClassification({ scopeKind: 'all' })
        const repo = catalog.getDocumentClassificationRepository()
        record(
          job?.status === 'completed' && job.totalItems === 2 && repo.getHiddenClutterCount() === 1,
          'Real-Electron snapshot & classification persistence (0 source reads)'
        )

        // Override + journal commit + reclassify preservation
        const eff = repo.getEffectiveDocumentClassification(clutterId)
        repo.setClassificationOverride({
          fileLocationId: clutterId,
          expectedRevision: eff.contentRevision,
          expectedOverrideVersion: 0,
          purposeLabels: ['legal'],
          originLabels: ['personal'],
          clutterOverride: 'force_keep'
        })
        const reclassJob = await coordinator.reclassify()
        const afterReclass = repo.getEffectiveDocumentClassification(clutterId)
        record(
          afterReclass?.effectiveIsClutter === false &&
            afterReclass?.override?.clutterOverride === 'force_keep' &&
            repo.getHiddenClutterCount() === 0,
          'Two-phase AnnotationJournal override persists & survives reclassification'
        )

        // Restart recovery test
        catalog
          .getRawDb()
          .prepare("UPDATE document_classification_jobs SET status = 'running' WHERE id = ?;")
          .run(reclassJob.id)
        await coordinator.shutdown()
        catalog.close()

        catalog = CatalogDatabase.open({ catalogPath, journal })
        coordinator = new DocumentClassificationCoordinator({
          catalog,
          workerBudget: budget,
          appPath: appRoot,
          isPackaged: isUnpackedMode
        })
        const latestAfterRestart = catalog.getDocumentClassificationRepository().getLatestJob()
        const resumed = await coordinator.resume()
        record(
          latestAfterRestart?.status === 'interrupted' && resumed?.status === 'completed',
          'Restart marks running job interrupted and resumes cleanly'
        )
        record(
          catalog
            .getDocumentClassificationRepository()
            .getEffectiveDocumentClassification(noteId)
            ?.effectiveOriginLabels.includes('personal') === true,
          'Persisted personal classification survives restart'
        )

        // Real CatalogDatabase discovery/hash reconciliation & coverage invalidation
        const repoAfterRestart = catalog.getDocumentClassificationRepository()
        const licensePath = join(sourceRoot, 'repos/app/LICENSE.txt')
        const licenseLen =
          'SPDX-License-Identifier: MIT\nPermission is hereby granted, free of charge, to any person obtaining a copy of the "Software".\nWITHOUT WARRANTY OF ANY KIND.\n'
            .length
        await coordinator.getCoverage() // warm coverage cache
        const mtimeTouch = now + 10_000
        catalog.persistDiscoveryBatch(sourceRoot, [
          {
            originalPath: licensePath,
            fileName: 'LICENSE.txt',
            extension: '.txt',
            category: 'document',
            byteSize: licenseLen,
            birthtimeMs: now,
            mtimeMs: mtimeTouch,
            discoveredAtMs: mtimeTouch
          }
        ])
        const covAfterTouch = await coordinator.getCoverage()
        const unverifiedEff = repoAfterRestart.getEffectiveDocumentClassification(clutterId)
        catalog.recordHashObservation({
          originalPath: licensePath,
          sha256: 'a'.repeat(64),
          observedByteSize: licenseLen,
          observedMtimeMs: mtimeTouch,
          hashedAtMs: mtimeTouch
        })
        const afterMatchingHash = repoAfterRestart.getEffectiveDocumentClassification(clutterId)
        record(
          covAfterTouch.unclassifiedDocuments >= 1 &&
            unverifiedEff?.override === null &&
            afterMatchingHash?.override?.clutterOverride === 'force_keep' &&
            afterMatchingHash?.override?.discoveryObservationId ===
              afterMatchingHash?.discoveryObservationId,
          'CatalogDatabase timestamp-touch preserves override after hash match (unverified blocked)'
        )

        // Content change invalidates override
        const mtimeChanged = now + 20_000
        catalog.persistDiscoveryBatch(sourceRoot, [
          {
            originalPath: licensePath,
            fileName: 'LICENSE.txt',
            extension: '.txt',
            category: 'document',
            byteSize: licenseLen,
            birthtimeMs: now,
            mtimeMs: mtimeChanged,
            discoveredAtMs: mtimeChanged
          }
        ])
        catalog.recordHashObservation({
          originalPath: licensePath,
          sha256: 'c'.repeat(64),
          observedByteSize: licenseLen,
          observedMtimeMs: mtimeChanged,
          hashedAtMs: mtimeChanged
        })
        const afterContentChange = repoAfterRestart.getEffectiveDocumentClassification(clutterId)
        record(
          afterContentChange?.override === null && afterContentChange?.hasStaleOverride === true,
          'CatalogDatabase content-change invalidates stale override'
        )

        // Post-commit journal failure returns persistencePending: true & recovers idempotently
        const noteEff = repoAfterRestart.getEffectiveDocumentClassification(noteId)
        const origCommitSync = journal.appendCommitRecordSync.bind(journal)
        journal.appendCommitRecordSync = () => {
          throw new Error('SIMULATED_ELECTRON_DISK_IO')
        }
        const pendingRes = repoAfterRestart.setClassificationOverride({
          fileLocationId: noteId,
          expectedRevision: noteEff.contentRevision,
          expectedOverrideVersion: 0,
          purposeLabels: ['lists'],
          originLabels: ['personal'],
          clutterOverride: 'force_keep'
        })
        journal.appendCommitRecordSync = origCommitSync
        const reconciled = catalog.reconcileJournalWithDatabase()
        record(
          pendingRes.persistencePending === true && reconciled.reconciledCount >= 1,
          'Post-commit journal failure returns persistencePending and reconciles idempotently'
        )
      } finally {
        await coordinator.shutdown()
        catalog.close()
      }

      record(budget.getLiveCount() === 0, 'Clean shutdown leaves 0 leaked AppWorkerBudget slots')
    } catch (err) {
      failed += 1
      console.error('[FAIL] Unexpected verification error:', err)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }

    console.log(
      `[verify-doc-classify-persistence] Summary (${isUnpackedMode ? 'unpacked' : 'built'}): ${passed} passed, ${failed} failed`
    )
    process.exitCode = failed === 0 ? 0 : 1
  })()
}
