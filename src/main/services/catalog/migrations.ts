/**
 * Personal Vault — Catalog Schema Migrations (Stage 2C)
 *
 * Implements transactional, versioned database schema migrations.
 * Guarantees that reopening existing catalogs is safe and idempotent,
 * accounts for both v1 schema layouts (baa82e6 and 25a1b4f),
 * and fails safely without database modifications if an unsupported future version is met.
 */

import type { DatabaseSync } from 'node:sqlite'
import { MigrationError, UnsupportedSchemaVersionError } from './errors'

export const CURRENT_SCHEMA_VERSION = 7

interface Migration {
  readonly version: number
  readonly name: string
  readonly up: (db: DatabaseSync) => void
}

interface ColumnInfo {
  readonly cid: number
  readonly name: string
  readonly type: string
  readonly notnull: number
  readonly dflt_value: unknown
  readonly pk: number
}

function getTableNames(db: DatabaseSync): string[] {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table';").all() as Array<{
    name: string
  }>
  return rows.map((r) => r.name)
}

function getTableColumns(db: DatabaseSync, tableName: string): string[] {
  const rows = db.prepare(`PRAGMA table_info('${tableName}');`).all() as unknown as ColumnInfo[]
  return rows.map((r) => r.name)
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial_catalog_schema',
    up: (db: DatabaseSync) => {
      // Original Stage 2C baa82e6 layout
      db.exec(`
        CREATE TABLE IF NOT EXISTS sources (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          root_path TEXT NOT NULL,
          normalized_root_path TEXT NOT NULL UNIQUE,
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS file_locations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
          original_path TEXT NOT NULL,
          normalized_path TEXT NOT NULL UNIQUE,
          file_name TEXT NOT NULL,
          extension TEXT NOT NULL,
          category TEXT NOT NULL CHECK (category IN ('photo', 'document')),
          byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
          filesystem_birthtime_ms NUMERIC,
          filesystem_mtime_ms NUMERIC,
          inferred_capture_time_ms INTEGER,
          first_discovered_at_ms INTEGER NOT NULL,
          last_seen_at_ms INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_file_locations_source ON file_locations(source_id);
        CREATE INDEX IF NOT EXISTS idx_file_locations_category ON file_locations(category);
        CREATE INDEX IF NOT EXISTS idx_file_locations_normalized_path ON file_locations(normalized_path);

        CREATE TABLE IF NOT EXISTS hash_observations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          file_location_id INTEGER NOT NULL REFERENCES file_locations(id) ON DELETE CASCADE,
          sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
          observed_byte_size INTEGER NOT NULL CHECK (observed_byte_size >= 0),
          observed_mtime_ms NUMERIC,
          hashed_at_ms INTEGER NOT NULL,
          is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
        );

        CREATE INDEX IF NOT EXISTS idx_hash_obs_file_active ON hash_observations(file_location_id, is_active);
        CREATE INDEX IF NOT EXISTS idx_hash_obs_sha256 ON hash_observations(sha256);
      `)
    }
  },
  {
    version: 2,
    name: 'discovery_observations_and_strict_hashes',
    up: (db: DatabaseSync) => {
      const tables = getTableNames(db)
      if (
        !tables.includes('sources') ||
        !tables.includes('file_locations') ||
        !tables.includes('hash_observations')
      ) {
        throw new Error('Required tables (sources, file_locations, hash_observations) are missing')
      }

      const fileLocCols = getTableColumns(db, 'file_locations')
      const hashObsCols = getTableColumns(db, 'hash_observations')

      // Case A: Revised 25a1b4f layout (already has discovery_observations)
      if (tables.includes('discovery_observations')) {
        const discCols = getTableColumns(db, 'discovery_observations')
        const isValidDisc =
          discCols.includes('file_location_id') &&
          discCols.includes('byte_size') &&
          discCols.includes('is_current')
        const isValidHash = hashObsCols.includes('discovery_observation_id')
        const isValidFile =
          fileLocCols.includes('original_path') && fileLocCols.includes('category')

        if (!isValidDisc || !isValidHash || !isValidFile) {
          throw new Error(
            'Unrecognized schema layout: discovery_observations exists but table structure is invalid'
          )
        }
        // Already adheres to the revised layout; schema migration 2 bookkeeping is sufficient.
        return
      }

      // Case B: Original baa82e6 layout (inline facts in file_locations, hash tied to file_location)
      const isBaa82e6File =
        fileLocCols.includes('byte_size') &&
        fileLocCols.includes('first_discovered_at_ms') &&
        fileLocCols.includes('last_seen_at_ms')
      const isBaa82e6Hash =
        hashObsCols.includes('file_location_id') &&
        !hashObsCols.includes('discovery_observation_id')

      if (!isBaa82e6File || !isBaa82e6Hash) {
        throw new Error('Unrecognized version 1 schema structure: cannot migrate to version 2')
      }

      // 1. Create discovery_observations table
      db.exec(`
        CREATE TABLE discovery_observations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          file_location_id INTEGER NOT NULL REFERENCES file_locations(id) ON DELETE CASCADE,
          byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
          filesystem_birthtime_ms NUMERIC,
          filesystem_mtime_ms NUMERIC,
          inferred_capture_time_ms INTEGER,
          observed_at_ms INTEGER NOT NULL,
          last_seen_at_ms INTEGER NOT NULL,
          is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1))
        );
      `)

      // 2. Populate discovery_observations with historical facts from file_locations
      db.exec(`
        INSERT INTO discovery_observations (
          id, file_location_id, byte_size, filesystem_birthtime_ms, filesystem_mtime_ms,
          inferred_capture_time_ms, observed_at_ms, last_seen_at_ms, is_current
        )
        SELECT
          id, id, byte_size, filesystem_birthtime_ms, filesystem_mtime_ms,
          inferred_capture_time_ms, first_discovered_at_ms, last_seen_at_ms, 1
        FROM file_locations;

        CREATE INDEX idx_disc_obs_file ON discovery_observations(file_location_id);
        CREATE UNIQUE INDEX idx_disc_obs_current ON discovery_observations(file_location_id) WHERE is_current = 1;
      `)

      // 3. Rebuild hash_observations to reference discovery_observations
      db.exec(`
        CREATE TABLE hash_observations_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          file_location_id INTEGER NOT NULL REFERENCES file_locations(id) ON DELETE CASCADE,
          discovery_observation_id INTEGER NOT NULL REFERENCES discovery_observations(id) ON DELETE CASCADE,
          sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
          observed_byte_size INTEGER NOT NULL CHECK (observed_byte_size >= 0),
          observed_mtime_ms NUMERIC,
          hashed_at_ms INTEGER NOT NULL,
          is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
        );

        INSERT INTO hash_observations_new (
          id, file_location_id, discovery_observation_id, sha256,
          observed_byte_size, observed_mtime_ms, hashed_at_ms, is_active
        )
        SELECT
          h.id, h.file_location_id, d.id, h.sha256,
          h.observed_byte_size, h.observed_mtime_ms, h.hashed_at_ms, h.is_active
        FROM hash_observations h
        JOIN discovery_observations d ON d.file_location_id = h.file_location_id AND d.is_current = 1;

        DROP TABLE hash_observations;
        ALTER TABLE hash_observations_new RENAME TO hash_observations;

        CREATE INDEX idx_hash_obs_file ON hash_observations(file_location_id);
        CREATE INDEX idx_hash_obs_disc ON hash_observations(discovery_observation_id);
        CREATE INDEX idx_hash_obs_sha256 ON hash_observations(sha256);
        CREATE UNIQUE INDEX idx_hash_obs_current ON hash_observations(discovery_observation_id) WHERE is_active = 1;
      `)

      // 4. Rebuild file_locations to remove obsolete inline observation columns and enforce original_path UNIQUE
      db.exec(`
        CREATE TABLE file_locations_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
          original_path TEXT NOT NULL UNIQUE,
          normalized_path TEXT NOT NULL,
          file_name TEXT NOT NULL,
          extension TEXT NOT NULL,
          category TEXT NOT NULL CHECK (category IN ('photo', 'document')),
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL
        );

        INSERT INTO file_locations_new (
          id, source_id, original_path, normalized_path, file_name, extension, category,
          created_at_ms, updated_at_ms
        )
        SELECT
          id, source_id, original_path, normalized_path, file_name, extension, category,
          first_discovered_at_ms, last_seen_at_ms
        FROM file_locations;

        DROP TABLE file_locations;
        ALTER TABLE file_locations_new RENAME TO file_locations;

        CREATE INDEX idx_file_locations_source ON file_locations(source_id);
        CREATE INDEX idx_file_locations_category ON file_locations(category);
        CREATE INDEX idx_file_locations_normalized_path ON file_locations(normalized_path);
      `)
    }
  },
  {
    version: 3,
    name: 'scan_jobs_and_checkpoints',
    up: (db: DatabaseSync) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS scan_jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          status TEXT NOT NULL CHECK (status IN ('running', 'paused', 'cancelled', 'interrupted', 'failed', 'completed')),
          roots_json TEXT NOT NULL,
          phase TEXT NOT NULL CHECK (phase IN ('discovery', 'hashing', 'completed')),
          discovered_count INTEGER NOT NULL DEFAULT 0 CHECK (discovered_count >= 0),
          hashed_count INTEGER NOT NULL DEFAULT 0 CHECK (hashed_count >= 0),
          total_files_to_hash INTEGER NOT NULL DEFAULT 0 CHECK (total_files_to_hash >= 0),
          total_bytes INTEGER NOT NULL DEFAULT 0 CHECK (total_bytes >= 0),
          hashed_bytes INTEGER NOT NULL DEFAULT 0 CHECK (hashed_bytes >= 0),
          skipped_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
          error_count INTEGER NOT NULL DEFAULT 0 CHECK (error_count >= 0),
          error_message TEXT,
          is_dismissed INTEGER NOT NULL DEFAULT 0,
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          started_at_ms INTEGER NOT NULL,
          completed_at_ms INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_scan_jobs_status ON scan_jobs(status);
        CREATE INDEX IF NOT EXISTS idx_scan_jobs_created ON scan_jobs(created_at_ms DESC);

        CREATE TABLE IF NOT EXISTS scan_job_errors (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id INTEGER NOT NULL REFERENCES scan_jobs(id) ON DELETE CASCADE,
          path TEXT NOT NULL,
          code TEXT NOT NULL,
          message TEXT NOT NULL,
          phase TEXT NOT NULL CHECK (phase IN ('discovery', 'hashing')),
          occurred_at_ms INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_scan_job_errors_job ON scan_job_errors(job_id);
      `)
    }
  },
  {
    version: 4,
    name: 'scan_job_files_and_dismissal',
    up: (db: DatabaseSync) => {
      const jobCols = getTableColumns(db, 'scan_jobs')
      if (!jobCols.includes('is_dismissed')) {
        db.exec('ALTER TABLE scan_jobs ADD COLUMN is_dismissed INTEGER NOT NULL DEFAULT 0;')
      }

      db.exec(`
        CREATE TABLE IF NOT EXISTS scan_job_files (
          job_id INTEGER NOT NULL REFERENCES scan_jobs(id) ON DELETE CASCADE,
          file_location_id INTEGER NOT NULL REFERENCES file_locations(id) ON DELETE CASCADE,
          PRIMARY KEY (job_id, file_location_id)
        );

        CREATE INDEX IF NOT EXISTS idx_scan_job_files_location ON scan_job_files(file_location_id);
      `)
    }
  },
  {
    version: 5,
    name: 'duplicate_reviews',
    up: (db: DatabaseSync) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS duplicate_reviews (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
          byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
          status TEXT NOT NULL CHECK (status IN ('unreviewed', 'reviewed')),
          preferred_location_id INTEGER REFERENCES file_locations(id) ON DELETE SET NULL,
          group_signature TEXT NOT NULL,
          reviewed_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          UNIQUE(sha256, byte_size)
        );

        CREATE INDEX IF NOT EXISTS idx_duplicate_reviews_hash_size ON duplicate_reviews(sha256, byte_size);
        CREATE INDEX IF NOT EXISTS idx_duplicate_reviews_preferred ON duplicate_reviews(preferred_location_id);
      `)
    }
  },
  {
    version: 6,
    name: 'vault_copies_and_imports',
    up: (db: DatabaseSync) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS vaults (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          vault_id TEXT NOT NULL UNIQUE,
          vault_path TEXT NOT NULL,
          normalized_vault_path TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
        );

        CREATE TABLE IF NOT EXISTS vault_copies (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          vault_id TEXT NOT NULL REFERENCES vaults(vault_id) ON DELETE CASCADE,
          sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
          byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
          relative_path TEXT NOT NULL,
          manifest_relative_path TEXT NOT NULL,
          verified_at_ms INTEGER NOT NULL,
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          UNIQUE(vault_id, sha256, byte_size)
        );

        CREATE INDEX IF NOT EXISTS idx_vault_copies_lookup ON vault_copies(vault_id, sha256, byte_size);

        CREATE TABLE IF NOT EXISTS vault_imports (
          id TEXT PRIMARY KEY,
          vault_id TEXT NOT NULL REFERENCES vaults(vault_id) ON DELETE CASCADE,
          status TEXT NOT NULL CHECK (status IN ('running', 'paused', 'cancelled', 'interrupted', 'failed', 'completed')),
          total_files INTEGER NOT NULL DEFAULT 0,
          total_bytes INTEGER NOT NULL DEFAULT 0,
          copied_files INTEGER NOT NULL DEFAULT 0,
          copied_bytes INTEGER NOT NULL DEFAULT 0,
          verified_files INTEGER NOT NULL DEFAULT 0,
          failed_files INTEGER NOT NULL DEFAULT 0,
          started_at_ms INTEGER NOT NULL,
          completed_at_ms INTEGER,
          error_message TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_vault_imports_status ON vault_imports(status);

        CREATE TABLE IF NOT EXISTS vault_import_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          import_id TEXT NOT NULL REFERENCES vault_imports(id) ON DELETE CASCADE,
          file_location_id INTEGER NOT NULL REFERENCES file_locations(id) ON DELETE CASCADE,
          discovery_observation_id INTEGER NOT NULL REFERENCES discovery_observations(id) ON DELETE CASCADE,
          hash_observation_id INTEGER REFERENCES hash_observations(id) ON DELETE SET NULL,
          sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
          byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
          vault_copy_id INTEGER REFERENCES vault_copies(id) ON DELETE SET NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'copying', 'verifying', 'completed', 'failed', 'cancelled', 'skipped')),
          error_code TEXT,
          error_message TEXT,
          started_at_ms INTEGER NOT NULL,
          completed_at_ms INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_vault_import_items_lookup ON vault_import_items(import_id, file_location_id);
      `)
    }
  },
  {
    version: 7,
    name: 'photo_annotations_and_collections',
    up: (db: DatabaseSync) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS photo_annotations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          file_location_id INTEGER NOT NULL REFERENCES file_locations(id) ON DELETE CASCADE,
          discovery_observation_id INTEGER NOT NULL REFERENCES discovery_observations(id) ON DELETE CASCADE,
          content_sha256 TEXT CHECK (content_sha256 IS NULL OR length(content_sha256) = 64),
          rating INTEGER CHECK (rating IS NULL OR (rating >= 1 AND rating <= 5)),
          flag TEXT NOT NULL DEFAULT 'none' CHECK (flag IN ('none', 'pick', 'reject')),
          version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
          is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1)),
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_photo_annotations_unique_current
          ON photo_annotations(file_location_id) WHERE is_current = 1;
        CREATE INDEX IF NOT EXISTS idx_photo_annotations_current_rating
          ON photo_annotations(is_current, rating);
        CREATE INDEX IF NOT EXISTS idx_photo_annotations_current_flag
          ON photo_annotations(is_current, flag);
        CREATE INDEX IF NOT EXISTS idx_photo_annotations_location_discovery
          ON photo_annotations(file_location_id, discovery_observation_id);

        CREATE TABLE IF NOT EXISTS collections (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          normalized_name TEXT NOT NULL UNIQUE,
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_collections_name ON collections(name);

        CREATE TABLE IF NOT EXISTS collection_memberships (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
          file_location_id INTEGER NOT NULL REFERENCES file_locations(id) ON DELETE CASCADE,
          discovery_observation_id INTEGER NOT NULL REFERENCES discovery_observations(id) ON DELETE CASCADE,
          content_sha256 TEXT CHECK (content_sha256 IS NULL OR length(content_sha256) = 64),
          is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1)),
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_collection_memberships_unique_current
          ON collection_memberships(collection_id, file_location_id) WHERE is_current = 1;
        CREATE INDEX IF NOT EXISTS idx_collection_memberships_location
          ON collection_memberships(file_location_id, is_current);
        CREATE INDEX IF NOT EXISTS idx_collection_memberships_collection
          ON collection_memberships(collection_id, is_current);
      `)
    }
  }
]

/**
 * Checks if the database contains a schema version newer than supported,
 * WITHOUT performing any schema or journal mode mutations.
 */
export function checkSchemaCompatibility(db: DatabaseSync): void {
  const tableCheck = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations';")
    .get()

  if (tableCheck) {
    const versionRow = db
      .prepare('SELECT MAX(version) as max_version FROM schema_migrations;')
      .get() as { max_version: number | null } | undefined

    const currentVersion = versionRow?.max_version ?? 0
    if (currentVersion > CURRENT_SCHEMA_VERSION) {
      throw new UnsupportedSchemaVersionError(currentVersion, CURRENT_SCHEMA_VERSION)
    }
  }
}

export function runMigrations(db: DatabaseSync): void {
  // Pre-check schema compatibility before any mutation or journal mode pragma
  checkSchemaCompatibility(db)

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
    db.exec('PRAGMA foreign_keys = OFF;')
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
    } finally {
      db.exec('PRAGMA foreign_keys = ON;')
    }
  }
}
