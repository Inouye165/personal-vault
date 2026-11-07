/**
 * Personal Vault — Catalog Service Exports (Stage 2C)
 */

export {
  CatalogDatabase,
  MAX_BATCH_SIZE,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  DEFAULT_MAX_LOCATIONS_PER_GROUP,
  MAX_LOCATIONS_PER_GROUP,
  validateSafeInteger,
  validatePagination,
  validateRecordHashObservationInput,
  isObservationTimestampMatching
} from './database'
export {
  CatalogError,
  DatabaseClosedError,
  UnsupportedSchemaVersionError,
  SourceNotFoundError,
  FileLocationNotFoundError,
  MigrationError,
  FileMetadataConflictError
} from './errors'
export { CURRENT_SCHEMA_VERSION, checkSchemaCompatibility, runMigrations } from './migrations'
export { normalizePathForLookup } from './path-normalization'
export type {
  CatalogDatabaseOptions,
  SourceRecord,
  CatalogFileRecord,
  DiscoveryObservationRecord,
  HashObservationRecord,
  DiscoveryCandidateInput,
  RecordHashObservationInput,
  BatchPersistenceResult,
  PaginationOptions,
  QueryFileLocationsOptions,
  DuplicateGroupOptions,
  PaginatedResult,
  DuplicateGroup,
  CatalogStats,
  ScanJobStatus,
  ScanJobPhase,
  ScanJobRecord,
  ScanJobErrorRecord,
  CreateScanJobInput,
  UpdateScanJobProgressInput,
  RecordScanJobErrorInput,
  UnhashedFileRecord,
  UnhashedCountResult
} from './types'
