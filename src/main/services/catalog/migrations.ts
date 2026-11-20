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

export const CURRENT_SCHEMA_VERSION = 16

export interface Migration {
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

export const MIGRATIONS: readonly Migration[] = [
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

        CREATE TABLE IF NOT EXISTS journal_operations (
          op_id TEXT PRIMARY KEY,
          entry_seq INTEGER NOT NULL,
          kind TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('committed', 'aborted')),
          applied_at_ms INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS journal_checkpoints (
          singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
          last_applied_seq INTEGER NOT NULL DEFAULT 0,
          last_op_id TEXT,
          updated_at_ms INTEGER NOT NULL
        );
      `)
    }
  },
  {
    version: 8,
    name: 'perceptual_hashes_and_similarity',
    up: (db: DatabaseSync) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS photo_perceptual_hashes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          file_location_id INTEGER NOT NULL REFERENCES file_locations(id) ON DELETE CASCADE,
          discovery_observation_id INTEGER NOT NULL REFERENCES discovery_observations(id) ON DELETE CASCADE,
          content_sha256 TEXT NOT NULL,
          content_revision TEXT NOT NULL,
          algorithm_version TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          bucket_0 INTEGER NOT NULL,
          bucket_1 INTEGER NOT NULL,
          bucket_2 INTEGER NOT NULL,
          bucket_3 INTEGER NOT NULL,
          width INTEGER,
          height INTEGER,
          created_at_ms INTEGER NOT NULL,
          is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1))
        );

        CREATE INDEX IF NOT EXISTS idx_photo_phash_loc_curr
          ON photo_perceptual_hashes(file_location_id, algorithm_version, is_current);
        CREATE INDEX IF NOT EXISTS idx_photo_phash_sha256
          ON photo_perceptual_hashes(content_sha256, algorithm_version, is_current);
        CREATE INDEX IF NOT EXISTS idx_photo_phash_b0
          ON photo_perceptual_hashes(bucket_0, is_current);
        CREATE INDEX IF NOT EXISTS idx_photo_phash_b1
          ON photo_perceptual_hashes(bucket_1, is_current);
        CREATE INDEX IF NOT EXISTS idx_photo_phash_b2
          ON photo_perceptual_hashes(bucket_2, is_current);
        CREATE INDEX IF NOT EXISTS idx_photo_phash_b3
          ON photo_perceptual_hashes(bucket_3, is_current);

        CREATE TABLE IF NOT EXISTS similarity_decisions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          file_location_id_a INTEGER NOT NULL REFERENCES file_locations(id) ON DELETE CASCADE,
          file_location_id_b INTEGER NOT NULL REFERENCES file_locations(id) ON DELETE CASCADE,
          content_revision_a TEXT NOT NULL,
          content_revision_b TEXT NOT NULL,
          decision TEXT NOT NULL CHECK (decision IN ('edited_version', 'similar_scene', 'unrelated')),
          version INTEGER NOT NULL DEFAULT 1,
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1)),
          CHECK (file_location_id_a < file_location_id_b)
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_sim_decision_pair_curr
          ON similarity_decisions(file_location_id_a, file_location_id_b) WHERE is_current = 1;

        CREATE TABLE IF NOT EXISTS similarity_jobs (
          job_id TEXT PRIMARY KEY,
          status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'paused', 'cancelled', 'interrupted', 'completed', 'failed')),
          algorithm_version TEXT NOT NULL,
          total_photos INTEGER NOT NULL DEFAULT 0,
          processed_photos INTEGER NOT NULL DEFAULT 0,
          error_photos INTEGER NOT NULL DEFAULT 0,
          unsupported_photos INTEGER NOT NULL DEFAULT 0,
          candidate_pairs_found INTEGER NOT NULL DEFAULT 0,
          started_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          completed_at_ms INTEGER
        );

        CREATE TABLE IF NOT EXISTS similarity_job_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id TEXT NOT NULL REFERENCES similarity_jobs(job_id) ON DELETE CASCADE,
          file_location_id INTEGER NOT NULL REFERENCES file_locations(id) ON DELETE CASCADE,
          status TEXT NOT NULL CHECK (status IN ('pending', 'processed', 'skipped', 'error', 'unsupported')),
          error_message TEXT,
          updated_at_ms INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_sim_job_items_job_status
          ON similarity_job_items(job_id, status);

        CREATE TABLE IF NOT EXISTS similarity_candidate_pairs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id TEXT NOT NULL REFERENCES similarity_jobs(job_id) ON DELETE CASCADE,
          file_location_id_a INTEGER NOT NULL REFERENCES file_locations(id) ON DELETE CASCADE,
          file_location_id_b INTEGER NOT NULL REFERENCES file_locations(id) ON DELETE CASCADE,
          distance INTEGER NOT NULL CHECK (distance >= 0 AND distance <= 64),
          similarity_score REAL NOT NULL CHECK (similarity_score >= 0.0 AND similarity_score <= 1.0),
          algorithm_version TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL,
          CHECK (file_location_id_a < file_location_id_b)
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_sim_candidates_unique
          ON similarity_candidate_pairs(job_id, file_location_id_a, file_location_id_b);
        CREATE INDEX IF NOT EXISTS idx_sim_candidates_pair
          ON similarity_candidate_pairs(file_location_id_a, file_location_id_b);
      `)
    }
  },
  {
    version: 9,
    name: 'semantic_embeddings_and_index_jobs',
    up: (db: DatabaseSync) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS photo_semantic_embeddings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          file_id INTEGER,
          file_location_id INTEGER NOT NULL REFERENCES file_locations(id) ON DELETE CASCADE,
          discovery_observation_id INTEGER NOT NULL,
          content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
          content_revision TEXT NOT NULL,
          source_path TEXT NOT NULL,
          observed_byte_size INTEGER NOT NULL CHECK (observed_byte_size >= 0),
          observed_mtime_ms REAL NOT NULL,
          model_id TEXT NOT NULL,
          model_commit TEXT NOT NULL,
          model_manifest_sha256 TEXT NOT NULL CHECK (length(model_manifest_sha256) = 64),
          preprocessing_version TEXT NOT NULL,
          embedding_dimensions INTEGER NOT NULL CHECK (embedding_dimensions = 512),
          embedding_blob BLOB NOT NULL CHECK (length(embedding_blob) = 2048),
          width INTEGER,
          height INTEGER,
          created_at_ms INTEGER NOT NULL,
          is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1))
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_semantic_emb_unique_current
          ON photo_semantic_embeddings(file_location_id, model_id, preprocessing_version)
          WHERE is_current = 1;

        CREATE INDEX IF NOT EXISTS idx_semantic_emb_sha256_reuse
          ON photo_semantic_embeddings(
            content_sha256,
            observed_byte_size,
            model_id,
            model_commit,
            model_manifest_sha256,
            preprocessing_version,
            is_current
          );

        CREATE INDEX IF NOT EXISTS idx_semantic_emb_coverage
          ON photo_semantic_embeddings(
            model_id,
            model_commit,
            model_manifest_sha256,
            preprocessing_version,
            is_current
          );

        CREATE TABLE IF NOT EXISTS semantic_index_jobs (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL CHECK (
            status IN ('idle', 'running', 'paused', 'completed', 'cancelled', 'interrupted', 'failed')
          ),
          model_id TEXT NOT NULL,
          model_commit TEXT NOT NULL,
          model_manifest_sha256 TEXT NOT NULL CHECK (length(model_manifest_sha256) = 64),
          preprocessing_version TEXT NOT NULL,
          total_photos INTEGER NOT NULL DEFAULT 0 CHECK (total_photos >= 0),
          processed_photos INTEGER NOT NULL DEFAULT 0 CHECK (processed_photos >= 0),
          reused_photos INTEGER NOT NULL DEFAULT 0 CHECK (reused_photos >= 0),
          unsupported_photos INTEGER NOT NULL DEFAULT 0 CHECK (unsupported_photos >= 0),
          failed_photos INTEGER NOT NULL DEFAULT 0 CHECK (failed_photos >= 0),
          pending_photos INTEGER NOT NULL DEFAULT 0 CHECK (pending_photos >= 0),
          started_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          completed_at_ms INTEGER,
          last_error TEXT
        );

        CREATE TABLE IF NOT EXISTS semantic_index_job_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id TEXT NOT NULL REFERENCES semantic_index_jobs(id) ON DELETE CASCADE,
          file_location_id INTEGER NOT NULL REFERENCES file_locations(id) ON DELETE CASCADE,
          original_path TEXT NOT NULL,
          discovery_observation_id INTEGER NOT NULL,
          expected_byte_size INTEGER NOT NULL,
          expected_mtime_ms REAL NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (
            status IN ('pending', 'completed', 'reused', 'unsupported', 'failed', 'skipped')
          ),
          error_code TEXT,
          error_message TEXT,
          updated_at_ms INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_semantic_job_items_job_status
          ON semantic_index_job_items(job_id, status, id);
      `)
    }
  },
  {
    version: 10,
    name: 'photo_technical_metadata_and_jobs',
    up: (db: DatabaseSync) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS photo_technical_metadata (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          file_location_id INTEGER NOT NULL REFERENCES file_locations(id) ON DELETE CASCADE,
          discovery_observation_id INTEGER NOT NULL REFERENCES discovery_observations(id) ON DELETE CASCADE,
          parser_recipe_version TEXT NOT NULL,
          extraction_status TEXT NOT NULL CHECK (
            extraction_status IN ('extracted', 'no_metadata', 'unsupported', 'failed', 'stale')
          ),
          content_sha256 TEXT CHECK (content_sha256 IS NULL OR length(content_sha256) = 64),
          content_revision TEXT NOT NULL,
          observed_byte_size INTEGER CHECK (observed_byte_size IS NULL OR observed_byte_size >= 0),
          observed_mtime_ms REAL,
          recorded_extension TEXT NOT NULL,
          detected_format TEXT,
          extension_format_mismatch INTEGER NOT NULL DEFAULT 0 CHECK (extension_format_mismatch IN (0, 1)),

          encoded_width_px INTEGER CHECK (encoded_width_px IS NULL OR encoded_width_px > 0),
          encoded_height_px INTEGER CHECK (encoded_height_px IS NULL OR encoded_height_px > 0),
          exif_orientation INTEGER CHECK (
            exif_orientation IS NULL OR (exif_orientation >= 1 AND exif_orientation <= 8)
          ),
          display_width_px INTEGER CHECK (display_width_px IS NULL OR display_width_px > 0),
          display_height_px INTEGER CHECK (display_height_px IS NULL OR display_height_px > 0),

          capture_date_source_tag TEXT CHECK (
            capture_date_source_tag IS NULL OR capture_date_source_tag IN ('DateTimeOriginal', 'DateTimeDigitized')
          ),
          raw_capture_date_text TEXT,
          capture_subseconds TEXT,
          capture_offset_minutes INTEGER CHECK (
            capture_offset_minutes IS NULL OR (capture_offset_minutes >= -840 AND capture_offset_minutes <= 840)
          ),
          capture_offset_text TEXT,
          capture_timezone_status TEXT NOT NULL DEFAULT 'unknown' CHECK (
            capture_timezone_status IN ('offset_present', 'local_wall_clock_unknown_tz', 'invalid_offset', 'unknown')
          ),
          capture_calendar_date TEXT,
          capture_local_iso TEXT,
          capture_utc_epoch_ms INTEGER,
          capture_date_parse_error TEXT,
          capture_date_conflict TEXT,

          camera_make_raw TEXT,
          camera_model_raw TEXT,
          camera_display TEXT,
          camera_normalized TEXT,
          lens_make_raw TEXT,
          lens_model_raw TEXT,
          lens_display TEXT,
          lens_normalized TEXT,

          raw_metadata_json TEXT,
          error_code TEXT,
          error_message TEXT,
          created_at_ms INTEGER NOT NULL,
          is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1))
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_photo_tech_meta_unique_current
          ON photo_technical_metadata(file_location_id, parser_recipe_version)
          WHERE is_current = 1;

        CREATE INDEX IF NOT EXISTS idx_photo_tech_meta_location_history
          ON photo_technical_metadata(file_location_id, is_current, id DESC);

        CREATE INDEX IF NOT EXISTS idx_photo_tech_meta_capture_date
          ON photo_technical_metadata(
            parser_recipe_version,
            is_current,
            extraction_status,
            capture_calendar_date
          );

        CREATE INDEX IF NOT EXISTS idx_photo_tech_meta_camera
          ON photo_technical_metadata(
            parser_recipe_version,
            is_current,
            extraction_status,
            camera_normalized,
            camera_display
          );

        CREATE INDEX IF NOT EXISTS idx_photo_tech_meta_lens
          ON photo_technical_metadata(
            parser_recipe_version,
            is_current,
            extraction_status,
            lens_normalized,
            lens_display
          );

        CREATE INDEX IF NOT EXISTS idx_photo_tech_meta_dimensions
          ON photo_technical_metadata(
            parser_recipe_version,
            is_current,
            extraction_status,
            display_width_px,
            display_height_px
          );

        CREATE INDEX IF NOT EXISTS idx_photo_tech_meta_format
          ON photo_technical_metadata(parser_recipe_version, is_current, detected_format);

        CREATE INDEX IF NOT EXISTS idx_photo_tech_meta_sha_reuse
          ON photo_technical_metadata(
            content_sha256,
            observed_byte_size,
            parser_recipe_version,
            extraction_status,
            id DESC
          );

        CREATE INDEX IF NOT EXISTS idx_photo_tech_meta_size_reuse
          ON photo_technical_metadata(
            observed_byte_size,
            parser_recipe_version,
            extraction_status
          );

        CREATE INDEX IF NOT EXISTS idx_file_locations_cat_ext
          ON file_locations(category, extension, id);

        CREATE TABLE IF NOT EXISTS photo_metadata_jobs (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL CHECK (
            status IN ('idle', 'running', 'paused', 'completed', 'cancelled', 'interrupted', 'failed')
          ),
          parser_recipe_version TEXT NOT NULL,
          total_photos INTEGER NOT NULL DEFAULT 0 CHECK (total_photos >= 0),
          processed_photos INTEGER NOT NULL DEFAULT 0 CHECK (processed_photos >= 0),
          extracted_photos INTEGER NOT NULL DEFAULT 0 CHECK (extracted_photos >= 0),
          absent_metadata_photos INTEGER NOT NULL DEFAULT 0 CHECK (absent_metadata_photos >= 0),
          reused_photos INTEGER NOT NULL DEFAULT 0 CHECK (reused_photos >= 0),
          unsupported_photos INTEGER NOT NULL DEFAULT 0 CHECK (unsupported_photos >= 0),
          failed_photos INTEGER NOT NULL DEFAULT 0 CHECK (failed_photos >= 0),
          pending_photos INTEGER NOT NULL DEFAULT 0 CHECK (pending_photos >= 0),
          started_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          completed_at_ms INTEGER,
          last_error TEXT
        );

        CREATE TABLE IF NOT EXISTS photo_metadata_job_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id TEXT NOT NULL REFERENCES photo_metadata_jobs(id) ON DELETE CASCADE,
          file_location_id INTEGER NOT NULL REFERENCES file_locations(id) ON DELETE CASCADE,
          original_path TEXT NOT NULL,
          recorded_extension TEXT NOT NULL,
          discovery_observation_id INTEGER NOT NULL,
          expected_byte_size INTEGER NOT NULL,
          expected_mtime_ms REAL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (
            status IN ('pending', 'extracted', 'no_metadata', 'reused', 'unsupported', 'failed', 'skipped')
          ),
          error_code TEXT,
          error_message TEXT,
          updated_at_ms INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_photo_meta_job_items_job_status
          ON photo_metadata_job_items(job_id, status, id);
      `)
    }
  },
  {
    version: 11,
    name: 'recover_unsupported_heic_metadata',
    up(db) {
      db.exec(`
        UPDATE photo_technical_metadata
        SET extraction_status = 'stale',
            is_current = 0
        WHERE is_current = 1
          AND extraction_status = 'unsupported'
          AND error_code = 'UNSUPPORTED_HEIC_CONTAINER';
      `)
    }
  },
  {
    version: 12,
    name: 'document_extractions_and_jobs',
    up: (db: DatabaseSync) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS document_extractions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          file_location_id INTEGER NOT NULL REFERENCES file_locations(id) ON DELETE CASCADE,
          discovery_observation_id INTEGER NOT NULL REFERENCES discovery_observations(id) ON DELETE CASCADE,
          content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
          observed_byte_size INTEGER NOT NULL CHECK (observed_byte_size >= 0),
          observed_mtime_ms NUMERIC,
          content_revision TEXT NOT NULL,
          recipe_version TEXT NOT NULL,
          extraction_status TEXT NOT NULL CHECK (
            extraction_status IN (
              'extracted',
              'no_text_ocr_required',
              'password_protected',
              'unsupported',
              'corrupt_or_failed',
              'truncated'
            )
          ),
          status_detail TEXT,
          extracted_text TEXT,
          extracted_char_count INTEGER NOT NULL DEFAULT 0 CHECK (extracted_char_count >= 0),
          page_count INTEGER,
          truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
          truncation_reason TEXT,
          detected_encoding TEXT,
          extracted_at_ms INTEGER NOT NULL,
          is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1))
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_doc_ext_file_current
          ON document_extractions(file_location_id)
          WHERE is_current = 1;

        CREATE INDEX IF NOT EXISTS idx_doc_ext_sha_recipe
          ON document_extractions(content_sha256, recipe_version);

        CREATE INDEX IF NOT EXISTS idx_doc_ext_status
          ON document_extractions(extraction_status, is_current);

        CREATE TABLE IF NOT EXISTS document_extraction_jobs (
          id TEXT PRIMARY KEY,
          scope_kind TEXT NOT NULL CHECK (scope_kind IN ('selected', 'filtered', 'all')),
          status TEXT NOT NULL CHECK (
            status IN ('running', 'paused', 'cancelled', 'interrupted', 'completed', 'failed')
          ),
          recipe_version TEXT NOT NULL,
          force_reextract INTEGER NOT NULL DEFAULT 0 CHECK (force_reextract IN (0, 1)),
          snapshot_complete INTEGER NOT NULL DEFAULT 1 CHECK (snapshot_complete IN (0, 1)),
          total_documents INTEGER NOT NULL DEFAULT 0,
          processed_documents INTEGER NOT NULL DEFAULT 0,
          extracted_documents INTEGER NOT NULL DEFAULT 0,
          no_text_documents INTEGER NOT NULL DEFAULT 0,
          password_protected_documents INTEGER NOT NULL DEFAULT 0,
          unsupported_documents INTEGER NOT NULL DEFAULT 0,
          failed_documents INTEGER NOT NULL DEFAULT 0,
          truncated_documents INTEGER NOT NULL DEFAULT 0,
          reused_documents INTEGER NOT NULL DEFAULT 0,
          started_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          completed_at_ms INTEGER,
          last_error TEXT
        );

        CREATE TABLE IF NOT EXISTS document_extraction_job_items (
          job_id TEXT NOT NULL REFERENCES document_extraction_jobs(id) ON DELETE CASCADE,
          file_location_id INTEGER NOT NULL REFERENCES file_locations(id) ON DELETE CASCADE,
          discovery_observation_id INTEGER NOT NULL,
          content_revision TEXT NOT NULL,
          status TEXT NOT NULL CHECK (
            status IN (
              'pending',
              'extracted',
              'no_text_ocr_required',
              'password_protected',
              'unsupported',
              'corrupt_or_failed',
              'truncated',
              'reused',
              'skipped_stale'
            )
          ),
          error_message TEXT,
          updated_at_ms INTEGER NOT NULL,
          PRIMARY KEY (job_id, file_location_id)
        );

        CREATE INDEX IF NOT EXISTS idx_doc_ext_job_items_status
          ON document_extraction_job_items(job_id, status, file_location_id);
      `)
    }
  },
  {
    version: 13,
    name: 'document_ocr_persistence_and_jobs',
    up: (db: DatabaseSync) => {
      const extCols = getTableColumns(db, 'document_extractions')
      if (extCols.length > 0 && !extCols.includes('ocr_candidate_page_count')) {
        db.exec('ALTER TABLE document_extractions ADD COLUMN ocr_candidate_page_count INTEGER;')
      }

      db.exec(`
        CREATE TABLE IF NOT EXISTS document_ocr_extractions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          file_location_id INTEGER NOT NULL REFERENCES file_locations(id) ON DELETE CASCADE,
          discovery_observation_id INTEGER NOT NULL REFERENCES discovery_observations(id) ON DELETE CASCADE,
          content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
          observed_byte_size INTEGER NOT NULL CHECK (observed_byte_size >= 0),
          observed_mtime_ms NUMERIC,
          content_revision TEXT NOT NULL,
          recipe_version TEXT NOT NULL,
          ocr_model_id TEXT NOT NULL,
          ocr_model_manifest_sha256 TEXT NOT NULL CHECK (length(ocr_model_manifest_sha256) = 64),
          ocr_language TEXT NOT NULL,
          extraction_method TEXT NOT NULL CHECK (
            extraction_method IN (
              'ocr_image_tesseract',
              'ocr_pdf_tesseract',
              'ocr_hybrid_pdf',
              'native_pdf_passthrough',
              'none'
            )
          ),
          ocr_status TEXT NOT NULL CHECK (
            ocr_status IN (
              'extracted',
              'ocr_no_text',
              'password_protected',
              'unsupported',
              'corrupt_or_failed',
              'truncated'
            )
          ),
          status_detail TEXT,
          extracted_text TEXT,
          extracted_char_count INTEGER NOT NULL DEFAULT 0 CHECK (extracted_char_count >= 0),
          page_count INTEGER,
          ocr_page_count INTEGER NOT NULL DEFAULT 0 CHECK (ocr_page_count >= 0),
          native_only_page_count INTEGER NOT NULL DEFAULT 0 CHECK (native_only_page_count >= 0),
          skipped_blank_page_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_blank_page_count >= 0),
          mean_confidence REAL,
          truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
          truncation_reason TEXT,
          extracted_at_ms INTEGER NOT NULL,
          is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1))
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_doc_ocr_ext_file_current
          ON document_ocr_extractions(file_location_id)
          WHERE is_current = 1;

        CREATE INDEX IF NOT EXISTS idx_doc_ocr_ext_reuse
          ON document_ocr_extractions(
            content_sha256,
            recipe_version,
            ocr_model_id,
            ocr_model_manifest_sha256,
            ocr_language
          )
          WHERE is_current = 1;

        CREATE INDEX IF NOT EXISTS idx_doc_ocr_ext_status
          ON document_ocr_extractions(ocr_status, is_current);

        CREATE TABLE IF NOT EXISTS document_ocr_jobs (
          id TEXT PRIMARY KEY NOT NULL,
          scope_kind TEXT NOT NULL CHECK (scope_kind IN ('selected', 'ocr_needed', 'filtered', 'all')),
          status TEXT NOT NULL CHECK (
            status IN ('running', 'paused', 'cancelled', 'interrupted', 'completed', 'failed')
          ),
          recipe_version TEXT NOT NULL,
          ocr_model_id TEXT NOT NULL,
          ocr_model_manifest_sha256 TEXT NOT NULL,
          ocr_language TEXT NOT NULL,
          force_reocr INTEGER NOT NULL DEFAULT 0 CHECK (force_reocr IN (0, 1)),
          snapshot_complete INTEGER NOT NULL DEFAULT 0 CHECK (snapshot_complete IN (0, 1)),
          total_items INTEGER NOT NULL DEFAULT 0,
          processed_items INTEGER NOT NULL DEFAULT 0,
          extracted_items INTEGER NOT NULL DEFAULT 0,
          no_text_items INTEGER NOT NULL DEFAULT 0,
          password_protected_items INTEGER NOT NULL DEFAULT 0,
          unsupported_items INTEGER NOT NULL DEFAULT 0,
          failed_items INTEGER NOT NULL DEFAULT 0,
          truncated_items INTEGER NOT NULL DEFAULT 0,
          reused_items INTEGER NOT NULL DEFAULT 0,
          skipped_stale_items INTEGER NOT NULL DEFAULT 0,
          started_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          completed_at_ms INTEGER,
          last_error TEXT
        );

        CREATE TABLE IF NOT EXISTS document_ocr_job_items (
          job_id TEXT NOT NULL REFERENCES document_ocr_jobs(id) ON DELETE CASCADE,
          file_location_id INTEGER NOT NULL REFERENCES file_locations(id) ON DELETE CASCADE,
          discovery_observation_id INTEGER NOT NULL,
          content_revision TEXT NOT NULL,
          status TEXT NOT NULL CHECK (
            status IN (
              'pending',
              'extracted',
              'ocr_no_text',
              'password_protected',
              'unsupported',
              'corrupt_or_failed',
              'truncated',
              'reused',
              'skipped_stale'
            )
          ),
          error_message TEXT,
          updated_at_ms INTEGER NOT NULL,
          PRIMARY KEY (job_id, file_location_id)
        );

        CREATE INDEX IF NOT EXISTS idx_doc_ocr_job_items_status
          ON document_ocr_job_items(job_id, status, file_location_id);
      `)
    }
  },
  {
    version: 14,
    name: 'document_semantic_search_index',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS document_semantic_tracks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          file_location_id INTEGER NOT NULL REFERENCES file_locations(id) ON DELETE CASCADE,
          text_source_kind TEXT NOT NULL CHECK (text_source_kind IN ('native', 'ocr')),
          discovery_observation_id INTEGER NOT NULL,
          content_sha256 TEXT NOT NULL,
          observed_byte_size INTEGER NOT NULL,
          observed_mtime_ms INTEGER,
          content_revision TEXT NOT NULL,
          source_extraction_id INTEGER NOT NULL,
          source_recipe_version TEXT NOT NULL,
          source_ocr_model_id TEXT,
          source_ocr_model_manifest_sha256 TEXT,
          source_ocr_language TEXT,
          normalized_text_sha256 TEXT NOT NULL,
          doc_model_id TEXT NOT NULL,
          doc_model_commit TEXT NOT NULL,
          doc_model_manifest_sha256 TEXT NOT NULL,
          chunking_recipe_version TEXT NOT NULL,
          max_content_tokens_per_chunk INTEGER NOT NULL,
          overlap_tokens INTEGER NOT NULL,
          max_chunks_per_document INTEGER NOT NULL,
          max_text_chars_for_indexing INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('indexed', 'truncated', 'empty_text', 'failed')),
          normalized_char_count INTEGER NOT NULL DEFAULT 0,
          indexed_char_count INTEGER NOT NULL DEFAULT 0,
          coverage_ratio REAL NOT NULL DEFAULT 1,
          truncated INTEGER NOT NULL DEFAULT 0,
          truncation_reason TEXT,
          total_token_count INTEGER NOT NULL DEFAULT 0,
          unique_indexed_token_count INTEGER NOT NULL DEFAULT 0,
          emitted_chunk_token_sum INTEGER NOT NULL DEFAULT 0,
          chunk_count INTEGER NOT NULL DEFAULT 0,
          error_message TEXT,
          is_current INTEGER NOT NULL DEFAULT 1,
          indexed_at_ms INTEGER NOT NULL,
          UNIQUE(file_location_id, text_source_kind)
        );

        CREATE INDEX IF NOT EXISTS idx_doc_semantic_tracks_lookup
          ON document_semantic_tracks(is_current, file_location_id, text_source_kind);

        CREATE INDEX IF NOT EXISTS idx_doc_semantic_tracks_reuse
          ON document_semantic_tracks(
            normalized_text_sha256,
            doc_model_manifest_sha256,
            chunking_recipe_version,
            is_current
          );

        CREATE TABLE IF NOT EXISTS document_semantic_chunks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          track_id INTEGER NOT NULL REFERENCES document_semantic_tracks(id) ON DELETE CASCADE,
          file_location_id INTEGER NOT NULL REFERENCES file_locations(id) ON DELETE CASCADE,
          text_source_kind TEXT NOT NULL CHECK (text_source_kind IN ('native', 'ocr')),
          discovery_observation_id INTEGER NOT NULL,
          content_sha256 TEXT NOT NULL,
          observed_byte_size INTEGER NOT NULL,
          observed_mtime_ms INTEGER,
          content_revision TEXT NOT NULL,
          source_extraction_id INTEGER NOT NULL,
          source_recipe_version TEXT NOT NULL,
          source_ocr_model_id TEXT,
          source_ocr_model_manifest_sha256 TEXT,
          source_ocr_language TEXT,
          normalized_text_sha256 TEXT NOT NULL,
          doc_model_id TEXT NOT NULL,
          doc_model_commit TEXT NOT NULL,
          doc_model_manifest_sha256 TEXT NOT NULL,
          chunking_recipe_version TEXT NOT NULL,
          max_content_tokens_per_chunk INTEGER NOT NULL,
          overlap_tokens INTEGER NOT NULL,
          max_chunks_per_document INTEGER NOT NULL,
          max_text_chars_for_indexing INTEGER NOT NULL,
          chunk_index INTEGER NOT NULL,
          char_offset_start INTEGER NOT NULL,
          char_offset_end INTEGER NOT NULL,
          content_token_count INTEGER NOT NULL,
          vector_dimensions INTEGER NOT NULL,
          embedding_vector BLOB NOT NULL,
          is_current INTEGER NOT NULL DEFAULT 1,
          created_at_ms INTEGER NOT NULL,
          UNIQUE(file_location_id, text_source_kind, chunk_index)
        );

        CREATE INDEX IF NOT EXISTS idx_doc_semantic_chunks_rank_stream
          ON document_semantic_chunks(
            is_current,
            doc_model_manifest_sha256,
            chunking_recipe_version,
            file_location_id,
            id
          );

        CREATE INDEX IF NOT EXISTS idx_doc_semantic_chunks_track
          ON document_semantic_chunks(track_id, chunk_index);

        CREATE TABLE IF NOT EXISTS document_semantic_jobs (
          id TEXT PRIMARY KEY,
          scope_kind TEXT NOT NULL CHECK (scope_kind IN ('selected', 'unindexed_or_stale', 'filtered', 'all')),
          status TEXT NOT NULL CHECK (status IN ('running', 'paused', 'completed', 'cancelled', 'interrupted', 'failed')),
          doc_model_id TEXT NOT NULL,
          doc_model_commit TEXT NOT NULL,
          doc_model_manifest_sha256 TEXT NOT NULL,
          chunking_recipe_version TEXT NOT NULL,
          filter_extension TEXT,
          filter_filename_query TEXT,
          force_reindex INTEGER NOT NULL DEFAULT 0,
          snapshot_complete INTEGER NOT NULL DEFAULT 0,
          total_items INTEGER NOT NULL DEFAULT 0,
          processed_items INTEGER NOT NULL DEFAULT 0,
          indexed_items INTEGER NOT NULL DEFAULT 0,
          truncated_items INTEGER NOT NULL DEFAULT 0,
          empty_text_items INTEGER NOT NULL DEFAULT 0,
          failed_items INTEGER NOT NULL DEFAULT 0,
          reused_items INTEGER NOT NULL DEFAULT 0,
          skipped_stale_items INTEGER NOT NULL DEFAULT 0,
          started_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          completed_at_ms INTEGER,
          last_error TEXT
        );

        CREATE TABLE IF NOT EXISTS document_semantic_job_items (
          job_id TEXT NOT NULL REFERENCES document_semantic_jobs(id) ON DELETE CASCADE,
          file_location_id INTEGER NOT NULL REFERENCES file_locations(id) ON DELETE CASCADE,
          text_source_kind TEXT NOT NULL CHECK (text_source_kind IN ('native', 'ocr')),
          source_extraction_id INTEGER NOT NULL,
          discovery_observation_id INTEGER NOT NULL,
          content_revision TEXT NOT NULL,
          normalized_text_sha256 TEXT NOT NULL,
          status TEXT NOT NULL CHECK (
            status IN (
              'pending',
              'indexed',
              'truncated',
              'empty_text',
              'failed',
              'reused',
              'skipped_stale'
            )
          ),
          error_message TEXT,
          updated_at_ms INTEGER NOT NULL,
          PRIMARY KEY (job_id, file_location_id, text_source_kind)
        );

        CREATE INDEX IF NOT EXISTS idx_doc_semantic_job_items_status
          ON document_semantic_job_items(job_id, status, file_location_id, text_source_kind);
      `)
    }
  },
  {
    version: 15,
    name: 'document_classifications_and_overrides',
    up: (db: DatabaseSync) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS document_classifications (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          file_location_id INTEGER NOT NULL REFERENCES file_locations(id) ON DELETE CASCADE,
          discovery_observation_id INTEGER NOT NULL,
          content_sha256 TEXT NOT NULL,
          observed_byte_size INTEGER NOT NULL CHECK (observed_byte_size >= 0),
          observed_mtime_ms REAL,
          content_revision TEXT NOT NULL,
          source_root_path TEXT NOT NULL,
          relative_path TEXT NOT NULL,
          native_extraction_id INTEGER,
          native_recipe_version TEXT,
          ocr_extraction_id INTEGER,
          ocr_recipe_version TEXT,
          ocr_model_id TEXT,
          ocr_model_manifest_sha256 TEXT,
          ocr_language TEXT,
          text_source_kind TEXT NOT NULL CHECK (text_source_kind IN ('native', 'ocr', 'none')),
          normalized_input_sha256 TEXT NOT NULL CHECK (length(normalized_input_sha256) = 64),
          classifier_kind TEXT NOT NULL,
          rule_version TEXT NOT NULL,
          purpose_status TEXT NOT NULL CHECK (purpose_status IN ('classified', 'other', 'unknown')),
          origin_status TEXT NOT NULL CHECK (origin_status IN ('classified', 'unknown')),
          confidence_band TEXT NOT NULL CHECK (confidence_band IN ('high', 'medium', 'low')),
          uncertainty_reason TEXT,
          uncertainty_reasons_json TEXT NOT NULL,
          total_normalized_chars INTEGER NOT NULL DEFAULT 0,
          inspected_head_chars INTEGER NOT NULL DEFAULT 0,
          inspected_tail_chars INTEGER NOT NULL DEFAULT 0,
          omitted_chars INTEGER NOT NULL DEFAULT 0,
          upstream_truncated INTEGER NOT NULL DEFAULT 0 CHECK (upstream_truncated IN (0, 1)),
          unclosed_fence_at_eof INTEGER NOT NULL DEFAULT 0 CHECK (unclosed_fence_at_eof IN (0, 1)),
          is_clutter_candidate INTEGER NOT NULL DEFAULT 0 CHECK (is_clutter_candidate IN (0, 1)),
          has_personal_veto INTEGER NOT NULL DEFAULT 0 CHECK (has_personal_veto IN (0, 1)),
          evidence_json TEXT NOT NULL,
          is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1)),
          created_at_ms INTEGER NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_doc_classifications_current
          ON document_classifications(file_location_id)
          WHERE is_current = 1;

        CREATE INDEX IF NOT EXISTS idx_doc_classifications_clutter
          ON document_classifications(is_current, is_clutter_candidate, rule_version, file_location_id);

        CREATE TABLE IF NOT EXISTS document_classification_labels (
          classification_id INTEGER NOT NULL REFERENCES document_classifications(id) ON DELETE CASCADE,
          axis TEXT NOT NULL CHECK (axis IN ('purpose', 'origin')),
          label TEXT NOT NULL,
          PRIMARY KEY (classification_id, axis, label)
        );

        CREATE INDEX IF NOT EXISTS idx_doc_classification_labels_axis_label
          ON document_classification_labels(axis, label, classification_id);

        CREATE TABLE IF NOT EXISTS document_classification_overrides (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          file_location_id INTEGER NOT NULL REFERENCES file_locations(id) ON DELETE CASCADE,
          discovery_observation_id INTEGER NOT NULL,
          content_sha256 TEXT NOT NULL,
          observed_byte_size INTEGER NOT NULL CHECK (observed_byte_size >= 0),
          observed_mtime_ms REAL,
          content_revision TEXT NOT NULL,
          purpose_labels_json TEXT,
          origin_labels_json TEXT,
          clutter_override TEXT NOT NULL DEFAULT 'inherit' CHECK (
            clutter_override IN ('inherit', 'force_keep', 'force_clutter')
          ),
          override_version INTEGER NOT NULL DEFAULT 1 CHECK (override_version >= 1),
          is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1)),
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_doc_classification_overrides_current
          ON document_classification_overrides(file_location_id)
          WHERE is_current = 1;

        CREATE TABLE IF NOT EXISTS document_classification_jobs (
          id TEXT PRIMARY KEY,
          scope_kind TEXT NOT NULL CHECK (
            scope_kind IN ('selected', 'unclassified_or_stale', 'filtered', 'all')
          ),
          status TEXT NOT NULL CHECK (
            status IN ('running', 'paused', 'completed', 'cancelled', 'interrupted', 'failed')
          ),
          rule_version TEXT NOT NULL,
          filter_extension TEXT,
          filter_filename_query TEXT,
          force_reclassify INTEGER NOT NULL DEFAULT 0 CHECK (force_reclassify IN (0, 1)),
          snapshot_complete INTEGER NOT NULL DEFAULT 0 CHECK (snapshot_complete IN (0, 1)),
          total_items INTEGER NOT NULL DEFAULT 0 CHECK (total_items >= 0),
          processed_items INTEGER NOT NULL DEFAULT 0 CHECK (processed_items >= 0),
          classified_items INTEGER NOT NULL DEFAULT 0 CHECK (classified_items >= 0),
          other_items INTEGER NOT NULL DEFAULT 0 CHECK (other_items >= 0),
          unknown_items INTEGER NOT NULL DEFAULT 0 CHECK (unknown_items >= 0),
          clutter_items INTEGER NOT NULL DEFAULT 0 CHECK (clutter_items >= 0),
          reused_items INTEGER NOT NULL DEFAULT 0 CHECK (reused_items >= 0),
          skipped_stale_items INTEGER NOT NULL DEFAULT 0 CHECK (skipped_stale_items >= 0),
          failed_items INTEGER NOT NULL DEFAULT 0 CHECK (failed_items >= 0),
          started_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          completed_at_ms INTEGER,
          last_error TEXT
        );

        CREATE TABLE IF NOT EXISTS document_classification_job_items (
          job_id TEXT NOT NULL REFERENCES document_classification_jobs(id) ON DELETE CASCADE,
          file_location_id INTEGER NOT NULL REFERENCES file_locations(id) ON DELETE CASCADE,
          discovery_observation_id INTEGER NOT NULL,
          content_revision TEXT NOT NULL,
          native_extraction_id INTEGER,
          ocr_extraction_id INTEGER,
          normalized_input_sha256 TEXT NOT NULL,
          status TEXT NOT NULL CHECK (
            status IN ('pending', 'classified', 'other', 'unknown', 'reused', 'skipped_stale', 'failed')
          ),
          error_message TEXT,
          updated_at_ms INTEGER NOT NULL,
          PRIMARY KEY (job_id, file_location_id)
        );

        CREATE INDEX IF NOT EXISTS idx_doc_classify_job_items_status
          ON document_classification_job_items(job_id, status, file_location_id);
      `)
    }
  },
  {
    version: 16,
    name: 'export_jobs_and_items',
    up: (db: DatabaseSync) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS export_jobs (
          id TEXT PRIMARY KEY,
          bundle_dir TEXT NOT NULL,
          bundle_folder_name TEXT NOT NULL,
          status TEXT NOT NULL CHECK (
            status IN ('running', 'completed', 'cancelled', 'interrupted', 'failed')
          ),
          include_original_paths INTEGER NOT NULL DEFAULT 0 CHECK (include_original_paths IN (0, 1)),
          include_extracted_text INTEGER NOT NULL DEFAULT 0 CHECK (include_extracted_text IN (0, 1)),
          manifest_published INTEGER NOT NULL DEFAULT 0 CHECK (manifest_published IN (0, 1)),
          bundle_verified INTEGER NOT NULL DEFAULT 0 CHECK (bundle_verified IN (0, 1)),
          total_items INTEGER NOT NULL DEFAULT 0 CHECK (total_items >= 0),
          exported_items INTEGER NOT NULL DEFAULT 0 CHECK (exported_items >= 0),
          failed_items INTEGER NOT NULL DEFAULT 0 CHECK (failed_items >= 0),
          cancelled_items INTEGER NOT NULL DEFAULT 0 CHECK (cancelled_items >= 0),
          vault_integrity_warnings INTEGER NOT NULL DEFAULT 0 CHECK (vault_integrity_warnings >= 0),
          error_code TEXT,
          error_message TEXT,
          incomplete_reasons_json TEXT,
          started_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          completed_at_ms INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_export_jobs_started
          ON export_jobs(started_at_ms DESC, id DESC);

        CREATE INDEX IF NOT EXISTS idx_export_jobs_status
          ON export_jobs(status, started_at_ms DESC);

        CREATE TABLE IF NOT EXISTS export_job_items (
          job_id TEXT NOT NULL REFERENCES export_jobs(id) ON DELETE CASCADE,
          file_location_id INTEGER NOT NULL REFERENCES file_locations(id) ON DELETE CASCADE,
          discovery_observation_id INTEGER NOT NULL,
          hash_observation_id INTEGER NOT NULL,
          category TEXT NOT NULL CHECK (category IN ('photo', 'document')),
          original_file_name TEXT NOT NULL,
          expected_sha256 TEXT NOT NULL CHECK (length(expected_sha256) = 64),
          expected_byte_size INTEGER NOT NULL CHECK (expected_byte_size >= 0),
          status TEXT NOT NULL CHECK (
            status IN ('pending', 'completed', 'failed', 'cancelled', 'interrupted')
          ),
          exported_file_name TEXT,
          sidecar_file_name TEXT,
          byte_source_used TEXT CHECK (
            byte_source_used IS NULL OR
            byte_source_used IN ('vault_copy', 'source_file', 'source_fallback_after_vault_warning')
          ),
          vault_integrity_warning TEXT CHECK (
            vault_integrity_warning IS NULL OR
            vault_integrity_warning IN ('vault_copy_missing', 'vault_copy_hash_mismatch')
          ),
          error_code TEXT,
          error_message TEXT,
          updated_at_ms INTEGER NOT NULL,
          PRIMARY KEY (job_id, file_location_id)
        );

        CREATE INDEX IF NOT EXISTS idx_export_job_items_status
          ON export_job_items(job_id, status, file_location_id);
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
