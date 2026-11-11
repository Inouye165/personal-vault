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
  FileMetadataConflictError,
  DuplicateReviewError,
  DuplicateGroupNotFoundError,
  StaleReviewError,
  InvalidPreferredLocationError
} from './errors'
export { CURRENT_SCHEMA_VERSION, checkSchemaCompatibility, runMigrations } from './migrations'
export {
  normalizePathForLookup,
  isSameOrDescendantPath,
  getEffectiveRoots
} from './path-normalization'
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
  DuplicateReviewStatus,
  DuplicateReviewFilter,
  DuplicateMemberRecord,
  DuplicateGroupMembersOptions,
  DuplicateGroupMembersResult,
  SetDuplicateReviewInput,
  DuplicateReviewRecord,
  CatalogStats,
  ScanJobStatus,
  ScanJobPhase,
  ScanJobRecord,
  ScanJobErrorRecord,
  CreateScanJobInput,
  UpdateScanJobProgressInput,
  RecordScanJobErrorInput,
  UnhashedFileRecord,
  UnhashedFilesOptions,
  UnhashedCountResult,
  VaultImportItemDetail,
  PhotoTechnicalMetadataRecord,
  SavePhotoTechnicalMetadataInput,
  PhotoMetadataCoverageResult,
  PhotoMetadataJobRecord,
  CreatePhotoMetadataJobInput,
  PhotoMetadataJobItemRecord,
  PhotoMetadataFacetItem,
  GetPhotoMetadataFacetsOptions,
  PhotoMetadataFacetsResult,
  PhotoTechnicalMetadataDetailResult
} from './types'
