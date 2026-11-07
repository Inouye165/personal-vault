/**
 * Personal Vault — Catalog Schema Migrations (Stage 2C)
 *
 * Implements transactional, versioned database schema migrations.
 * Guarantees that reopening existing catalogs is safe and idempotent,
 * and fails safely without database modifications if an unsupported future version is met.
 */

import type { DatabaseSync } from 'node:sqlite'
import { MigrationError, UnsupportedSchemaVersionError } from './errors'

export const CURRENT_SCHEMA_VERSION = 1

interface Migration {
  readonly version: number
  readonly name: string
  readonly up: (db: DatabaseSync) => void
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial_catalog_schema',
    up: (db: DatabaseSync) => {
      // 1. Source roots inventory
      db.exec(`
        CREATE TABLE IF NOT EXISTS sources (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          root_path TEXT NOT NULL,
          normalized_root_path TEXT NOT NULL UNIQUE,
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL
        );
      `)

      // 2. Discovered file locations and factual recorded metadata
      db.exec(`
        CREATE TABLE IF NOT EXISTS file_locations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
          original_path TEXT NOT NULL,
          normalized_path TEXT NOT NULL UNIQUE,
          file_name TEXT NOT NULL,
          extension TEXT NOT NULL,
          category TEXT NOT NULL CHECK (category IN ('photo', 'document')),
          byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
          filesystem_birthtime_ms INTEGER,
          filesystem_mtime_ms INTEGER,
          inferred_capture_time_ms INTEGER,
          first_discovered_at_ms INTEGER NOT NULL,
          last_seen_at_ms INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_file_locations_source ON file_locations(source_id);
        CREATE INDEX IF NOT EXISTS idx_file_locations_category ON file_locations(category);
        CREATE INDEX IF NOT EXISTS idx_file_locations_normalized_path ON file_locations(normalized_path);
      `)

      // 3. SHA-256 hash observations and content validity
      db.exec(`
        CREATE TABLE IF NOT EXISTS hash_observations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          file_location_id INTEGER NOT NULL REFERENCES file_locations(id) ON DELETE CASCADE,
          sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
          observed_byte_size INTEGER NOT NULL CHECK (observed_byte_size >= 0),
          observed_mtime_ms INTEGER,
          hashed_at_ms INTEGER NOT NULL,
          is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
        );

        CREATE INDEX IF NOT EXISTS idx_hash_obs_file_active ON hash_observations(file_location_id, is_active);
        CREATE INDEX IF NOT EXISTS idx_hash_obs_sha256 ON hash_observations(sha256);
      `)
    }
  }
]

export function runMigrations(db: DatabaseSync): void {
  // Ensure foreign keys are active
  db.exec('PRAGMA foreign_keys = ON;')

  // Enable WAL mode for crash resilience and concurrency
  try {
    db.exec('PRAGMA journal_mode = WAL;')
    db.exec('PRAGMA synchronous = NORMAL;')
  } catch {
    // In-memory or special test configurations may not support WAL
  }

  // Create migrations table if not present
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      applied_at_ms INTEGER NOT NULL
    );
  `)

  // Check highest applied version
  const checkStmt = db.prepare('SELECT MAX(version) as max_version FROM schema_migrations;')
  const row = checkStmt.get() as { max_version: number | null } | undefined
  const currentVersion = row?.max_version ?? 0

  if (currentVersion > CURRENT_SCHEMA_VERSION) {
    throw new UnsupportedSchemaVersionError(currentVersion, CURRENT_SCHEMA_VERSION)
  }

  // Apply any pending migrations in strict ascending order
  const pendingMigrations = MIGRATIONS.filter((m) => m.version > currentVersion).sort(
    (a, b) => a.version - b.version
  )

  for (const migration of pendingMigrations) {
    db.exec('BEGIN TRANSACTION;')
    try {
      migration.up(db)
      const recordStmt = db.prepare(
        'INSERT INTO schema_migrations (version, name, applied_at_ms) VALUES (?, ?, ?);'
      )
      recordStmt.run(migration.version, migration.name, Date.now())
      db.exec('COMMIT;')
    } catch (error) {
      try {
        db.exec('ROLLBACK;')
      } catch {
        // Rollback attempt
      }
      throw new MigrationError(migration.version, (error as Error).message)
    }
  }
}
