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
export {
  CURRENT_SCHEMA_VERSION,
  MIGRATIONS,
  checkSchemaCompatibility,
  runMigrations
} from './migrations'
export { AnnotationJournal } from '../annotations/journal'
export {
  DocumentClassificationRepository,
  type DocClassificationCoverage,
  type DocClassificationJobRecord,
  type DocClassificationOverrideRecord,
  type EffectiveDocumentClassification
} from './document-classification-repository'
export {
  ExportRepository,
  type CreateExportJobInput,
  type CreateExportJobItemInput,
  type ExportJobItemRecord,
  type ExportJobItemStatus,
  type ExportJobRecord,
  type ExportJobStatus,
  type FinalizeExportJobInput,
  type ListExportJobItemsOptions,
  type ListExportJobsOptions,
  type PaginatedExportResult,
  type RecordExportItemOutcomeInput
} from './export-repository'
export { DocumentRepository, buildDocumentContentRevision } from './document-repository'
export {
  DocumentOcrRepository,
  type DocumentOcrCandidate,
  type DocumentOcrCoverage,
  type DocumentOcrJobItemRecord,
  type DocumentOcrJobItemStatus,
  type DocumentOcrJobRecord,
  type DocumentOcrJobStatus,
  type DocumentOcrPreviewPayload,
  type DocumentOcrPreviewStatus,
  type DocumentOcrStateItem,
  type DocumentOcrStatus,
  type ReusableDocumentOcrRecord
} from './document-ocr-repository'
export {
  DEFAULT_OCR_COMPATIBILITY_SPEC,
  doesDocumentRowRequireOcr,
  isOcrExtractionRowCompatible,
  type DocumentOcrJobScopeKind,
  type OcrCompatibilitySpec
} from './document-ocr-snapshot-query'
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
