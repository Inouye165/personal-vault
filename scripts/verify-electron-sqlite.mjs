#!/usr/bin/env node
/**
 * Personal Vault — Electron SQLite Repository Verification
 *
 * Exercises the actual CatalogDatabase module inside the real Electron runtime:
 * - Explicit database initialization and schema migration (v2)
 * - Transactional discovery persistence and source root registration
 * - SHA-256 hash observation recording and active hash lookup
 * - Reopen durability across independent database connections
 * - Changed-file discovery fact preservation and active hash invalidation
 * - Foreign-key enforcement and cascading deletion
 *
 * Supports both standard built bundle and unpacked application (--mode=unpacked).
 * Usage:
 *   node scripts/verify-electron-sqlite.mjs
 *   npm run verify:sqlite
 *   npm run verify:sqlite:unpacked
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import electronPath from 'electron'

const __dirname = resolve(fileURLToPath(import.meta.url), '..')
const rootDir = resolve(__dirname, '..')

const isUnpackedMode = process.argv.includes('--mode=unpacked')

function getUnpackedExecutablePath(root) {
  if (process.platform === 'win32') {
    return join(root, 'dist', 'win-unpacked', 'Personal Vault.exe')
  }
  if (process.platform === 'darwin') {
    return join(
      root,
      'dist',
      'mac-unpacked',
      'Personal Vault.app',
      'Contents',
      'MacOS',
      'Personal Vault'
    )
  }
  return join(root, 'dist', 'linux-unpacked', 'personal-vault')
}

function getUnpackedAsarPath(root) {
  if (process.platform === 'darwin') {
    return join(
      root,
      'dist',
      'mac-unpacked',
      'Personal Vault.app',
      'Contents',
      'Resources',
      'app.asar'
    )
  }
  const folder = process.platform === 'win32' ? 'win-unpacked' : 'linux-unpacked'
  return join(root, 'dist', folder, 'resources', 'app.asar')
}

// ---------------------------------------------------------------------------
// Outer Node Launcher (when not running under Electron's runtime)
// ---------------------------------------------------------------------------
if (!process.versions.electron) {
  const binaryPath = isUnpackedMode ? getUnpackedExecutablePath(rootDir) : electronPath

  if (isUnpackedMode) {
    if (!existsSync(binaryPath)) {
      console.log('[verify-sqlite] Unpacked binary not found. Running `npm run build:unpack`...')
      const packRes = spawnSync('npm', ['run', 'build:unpack'], {
        cwd: rootDir,
        stdio: 'inherit',
        shell: true
      })
      if (packRes.status !== 0) {
        console.error('[verify-sqlite] Unpacked build failed.')
        process.exitCode = packRes.status ?? 1
      }
    }
  } else {
    const catalogBundlePath = join(rootDir, 'out', 'main', 'catalog.js')
    if (!existsSync(catalogBundlePath)) {
      console.log('[verify-sqlite] Compiling catalog bundle via electron-vite...')
      const buildRes = spawnSync('npm', ['run', 'build'], {
        cwd: rootDir,
        stdio: 'inherit',
        shell: true
      })
      if (buildRes.status !== 0) {
        console.error('[verify-sqlite] Build failed before SQLite verification.')
        process.exitCode = buildRes.status ?? 1
      }
    }
  }

  if (process.exitCode && process.exitCode !== 0) {
    // Abort if pre-build failed
  } else {
    console.log(
      `[verify-sqlite] Launching verification using ${isUnpackedMode ? 'unpacked executable' : 'Electron runtime'}...`
    )
    console.log(`[verify-sqlite] Target binary: ${binaryPath}`)

    const child = spawnSync(
      binaryPath,
      [fileURLToPath(import.meta.url), ...process.argv.slice(2)],
      {
        cwd: rootDir,
        stdio: 'inherit',
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          ELECTRON_NO_ATTACH_CONSOLE: '1'
        }
      }
    )

    process.exitCode = child.status ?? 1
  }
} else {
  // ---------------------------------------------------------------------------
  // Inner Electron Runtime Execution
  // ---------------------------------------------------------------------------
  const catalogTargetModule = isUnpackedMode
    ? join(getUnpackedAsarPath(rootDir), 'out', 'main', 'catalog.js')
    : join(rootDir, 'out', 'main', 'catalog.js')

  console.log(`[verify-sqlite] Environment Diagnostics:`)
  console.log(`  - Mode: ${isUnpackedMode ? 'unpacked (asar)' : 'built (out/main)'}`)
  console.log(`  - Electron version: ${process.versions.electron}`)
  console.log(`  - Node version: ${process.versions.node}`)
  console.log(`  - SQLite: built-in node:sqlite`)
  console.log(`  - Target catalog module: ${catalogTargetModule}`)

  if (!existsSync(catalogTargetModule) && !isUnpackedMode) {
    console.error(`[verify-sqlite] Catalog bundle not found at: ${catalogTargetModule}`)
    process.exitCode = 1
  } else {
    runVerification(catalogTargetModule)
  }
}

async function runVerification(catalogModulePath) {
  let tempDir = null
  let db = null
  let success = false

  try {
    const catalogUrl = pathToFileURL(catalogModulePath).href
    console.log(`  - Loading catalog module via dynamic import...`)
    const catalogMod = await import(catalogUrl)
    const CatalogDatabase = catalogMod.CatalogDatabase

    if (!CatalogDatabase || typeof CatalogDatabase.open !== 'function') {
      throw new TypeError(`CatalogDatabase.open is not exported by ${catalogModulePath}`)
    }

    tempDir = mkdtempSync(join(tmpdir(), 'pv-electron-sqlite-verify-'))
    const catalogPath = join(tempDir, 'verified-catalog.db')

    // Step 1: Explicit initialization & migrations
    console.log('  1. Initializing catalog database at temporary path...')
    db = CatalogDatabase.open({ catalogPath })
    if (db.isClosed()) throw new Error('Database reported closed immediately after open')

    // Step 2: Register source root
    console.log('  2. Registering source root...')
    const source = db.registerSource('D:\\Photos')
    if (!source || source.id <= 0) throw new Error('Source registration failed')

    // Step 3: Discovery batch persistence
    console.log('  3. Persisting discovery batch...')
    const candidatePath = 'D:\\Photos\\lake.jpg'
    const batchRes = db.persistDiscoveryBatch('D:\\Photos', [
      {
        originalPath: candidatePath,
        fileName: 'lake.jpg',
        extension: 'jpg',
        byteSize: 1024,
        birthtimeMs: 1700000000000,
        mtimeMs: 1700000100000,
        discoveredAtMs: 1700000200000,
        category: 'photo'
      }
    ])
    if (batchRes.insertedCount !== 1) {
      throw new Error(`Expected 1 inserted file, got ${batchRes.insertedCount}`)
    }

    // Step 4: Record SHA-256 hash observation
    console.log('  4. Recording SHA-256 hash observation...')
    const hash = 'a'.repeat(64)
    const hashObs = db.recordHashObservation({
      originalPath: candidatePath,
      sha256: hash,
      observedByteSize: 1024,
      observedMtimeMs: 1700000100000,
      hashedAtMs: 1700000300000
    })
    if (!hashObs || hashObs.sha256 !== hash) throw new Error('Hash observation recording failed')

    const file = db.getFileLocationByPath(candidatePath)
    if (!file || file.activeHash !== hash) throw new Error('Active hash query failed')

    // Step 5: Reopen durability
    console.log('  5. Verifying reopen durability...')
    db.close()
    db = CatalogDatabase.open({ catalogPath })
    const reopenedFile = db.getFileLocationByPath(candidatePath)
    if (!reopenedFile || reopenedFile.activeHash !== hash) {
      throw new Error('Reopen durability check failed: active hash or file missing')
    }

    // Step 6: Changed-file hash invalidation & history preservation
    console.log('  6. Verifying changed-file observation and hash invalidation...')
    const changeRes = db.persistDiscoveryBatch('D:\\Photos', [
      {
        originalPath: candidatePath,
        fileName: 'lake.jpg',
        extension: 'jpg',
        byteSize: 2048, // Size changed!
        birthtimeMs: 1700000000000,
        mtimeMs: 1700000500000, // Mtime changed!
        discoveredAtMs: 1700000600000,
        category: 'photo'
      }
    ])
    if (changeRes.updatedCount !== 1 || changeRes.invalidatedHashCount !== 1) {
      throw new Error(`Expected 1 update & 1 invalidation, got ${JSON.stringify(changeRes)}`)
    }

    const changedFile = db.getFileLocationByPath(candidatePath)
    if (!changedFile || changedFile.activeHash !== null) {
      throw new Error('Changed file did not invalidate active hash (activeHash should be null)')
    }

    const history = db.getDiscoveryObservationsForFile(changedFile.id)
    if (history.totalCount !== 2) {
      throw new Error(`Expected 2 historical observations, got ${history.totalCount}`)
    }
    if (history.items[0]?.byteSize !== 2048 || history.items[1]?.byteSize !== 1024) {
      throw new Error('Discovery history facts were not preserved accurately')
    }

    // Step 7: Foreign key enforcement and cascading deletion
    console.log('  7. Verifying foreign key enforcement and cascading deletion...')
    const rawDb = db.getRawDatabaseForTesting()
    rawDb.prepare('DELETE FROM sources WHERE id = ?;').run(source.id)

    const fileAfterCascade = db.getFileLocationByPath(candidatePath)
    if (fileAfterCascade !== null) {
      throw new Error(
        'File location was not deleted when source was deleted (ON DELETE CASCADE failed)'
      )
    }

    const rawCheck = rawDb.prepare('SELECT COUNT(*) as count FROM discovery_observations;').get()
    if (rawCheck.count !== 0) {
      throw new Error('Discovery observations were not cascade-deleted')
    }

    success = true
    console.log(
      `[verify-sqlite] ALL CHECKS PASSED: CatalogDatabase operates correctly in Electron runtime (${isUnpackedMode ? 'unpacked' : 'built'}).`
    )
  } catch (error) {
    console.error('[verify-sqlite] VERIFICATION FAILED:', error)
    process.exitCode = 1
  } finally {
    if (db && !db.isClosed()) {
      try {
        db.close()
      } catch {
        // ignore
      }
    }
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }
  }

  if (success) {
    process.exitCode = 0
  }
}
