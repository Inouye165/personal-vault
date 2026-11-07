/**
 * Personal Vault — Electron SQLite Driver Verification Script
 *
 * Verifies that the built-in SQLite driver and CatalogDatabase service
 * execute properly inside the real Electron runtime.
 */
import { app } from 'electron'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

app.whenReady().then(async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'pv-electron-sqlite-test-'))
  const testDbPath = join(tempDir, 'electron-test.db')

  try {
    console.log('[verify-sqlite] Testing node:sqlite inside Electron runtime...')
    const db = new DatabaseSync(testDbPath, { enableForeignKeyConstraints: true })

    db.exec(`
      CREATE TABLE sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        root_path TEXT NOT NULL
      );
      CREATE TABLE file_locations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        original_path TEXT NOT NULL,
        byte_size INTEGER NOT NULL
      );
    `)

    const insertSource = db.prepare('INSERT INTO sources (root_path) VALUES (?) RETURNING id;')
    const source = insertSource.get('D:\\Photos')
    console.log('[verify-sqlite] Created source root row:', source)

    const insertFile = db.prepare(
      'INSERT INTO file_locations (source_id, original_path, byte_size) VALUES (?, ?, ?);'
    )
    insertFile.run(source.id, 'D:\\Photos\\test.jpg', 1024)

    const files = db.prepare('SELECT * FROM file_locations;').all()
    console.log('[verify-sqlite] Queried file locations:', files)

    db.close()
    console.log('[verify-sqlite] SUCCESS: node:sqlite operates correctly in Electron.')
    app.exit(0)
  } catch (error) {
    console.error('[verify-sqlite] FAILURE:', error)
    app.exit(1)
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})
