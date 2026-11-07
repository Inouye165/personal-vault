/**
 * Personal Vault — Catalog Service Exports (Stage 2C)
 */

export { CatalogDatabase } from './database'
export {
  CatalogError,
  DatabaseClosedError,
  UnsupportedSchemaVersionError,
  SourceNotFoundError,
  FileLocationNotFoundError,
  MigrationError
} from './errors'
export { CURRENT_SCHEMA_VERSION, runMigrations } from './migrations'
export { normalizePathForLookup } from './path-normalization'
export type {
  CatalogDatabaseOptions,
  SourceRecord,
  CatalogFileRecord,
  HashObservationRecord,
  DiscoveryCandidateInput,
  RecordHashObservationInput,
  BatchPersistenceResult,
  PaginationOptions,
  QueryFileLocationsOptions,
  PaginatedResult,
  DuplicateGroup,
  CatalogStats
} from './types'
