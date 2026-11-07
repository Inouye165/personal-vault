#!/usr/bin/env node
/**
 * Personal Vault — Electron SQLite Repository Verification
 *
 * Exercises the actual CatalogDatabase module inside the real Electron runtime:
 * - Explicit database initialization and schema migration
 * - Transactional discovery persistence and source root registration
 * - SHA-256 hash observation recording and active hash lookup
 * - Reopen durability across database connections
 * - Changed-file discovery fact preservation and active hash invalidation
 * - Foreign-key enforcement and cascading deletion
 *
 * Works in both GUI Electron, headless environments, and Node CLI using Electron's runtime.
 * Usage:
 *   node scripts/verify-electron-sqlite.mjs
 *   npm run verify:sqlite
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import electronPath from 'electron'

const __dirname = resolve(fileURLToPath(import.meta.url), '..')
const rootDir = resolve(__dirname, '..')
const catalogBundlePath = join(rootDir, 'out', 'main', 'catalog.js')

// If running in regular Node (e.g. `node scripts/verify-electron-sqlite.mjs`),
// re-launch under Electron's Node runtime (ELECTRON_RUN_AS_NODE=1) to ensure
// Electron's exact runtime and embedded SQLite driver are exercised.
if (!process.versions.electron) {
  if (!existsSync(catalogBundlePath)) {
    console.log('[verify-sqlite] Compiling catalog bundle via electron-vite...')
    const buildRes = spawnSync('npm', ['run', 'build'], {
      cwd: rootDir,
      stdio: 'inherit',
      shell: true
    })
    if (buildRes.status !== 0) {
      console.error('[verify-sqlite] Build failed before SQLite verification.')
      process.exit(buildRes.status ?? 1)
    }
  }

  console.log('[verify-sqlite] Launching verification inside Electron runtime...')
  const child = spawnSync(
    electronPath,
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

  process.exit(child.status ?? 1)
}

// Running inside Electron's runtime
process.on('uncaughtException', (err) => {
  console.error('[verify-sqlite] UNCAUGHT EXCEPTION:', err)
  process.exit(1)
})

process.on('unhandledRejection', (err) => {
  console.error('[verify-sqlite] UNHANDLED REJECTION:', err)
  process.exit(1)
})

async function runVerification() {
  console.log(
    `[verify-sqlite] Running in Electron runtime (Node ${process.versions.node}, Electron ${process.versions.electron}, SQLite ${process.versions.sqlite ?? 'built-in'})...`
  )

  if (!existsSync(catalogBundlePath)) {
    throw new Error(`Catalog bundle not found at ${catalogBundlePath}. Run npm run build first.`)
  }

  const catalogUrl = pathToFileURL(catalogBundlePath).href
  const { CatalogDatabase } = await import(catalogUrl)
  if (!CatalogDatabase || typeof CatalogDatabase.open !== 'function') {
    throw new TypeError('CatalogDatabase.open is not exported by out/main/catalog.js')
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'pv-electron-sqlite-verify-'))
  const catalogPath = join(tempDir, 'verified-catalog.db')
  let db = null

  try {
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
    if (batchRes.insertedCount !== 1)
      throw new Error(`Expected 1 inserted file, got ${batchRes.insertedCount}`)

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

    db.close()
    db = null
    console.log(
      '[verify-sqlite] ALL CHECKS PASSED: CatalogDatabase operates correctly in Electron runtime.'
    )
    process.exit(0)
  } catch (error) {
    console.error('[verify-sqlite] VERIFICATION FAILED:', error)
    if (db && !db.isClosed()) {
      try {
        db.close()
      } catch {
        // ignore
      }
    }
    process.exit(1)
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
}

runVerification()
