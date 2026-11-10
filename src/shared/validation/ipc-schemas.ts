import { z } from 'zod'

export const AppInfoSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  platform: z.string().min(1),
  isPackaged: z.boolean()
})

export type AppInfo = z.infer<typeof AppInfoSchema>

export const NavigationTabSchema = z.enum(['all', 'photos', 'documents', 'review', 'duplicates'])

export type NavigationTab = z.infer<typeof NavigationTabSchema>

/** Main-process acknowledgement of a navigation request. */
export const TabAckSchema = z.boolean()

export const VaultStatusSchema = z.object({
  sourceCount: z.number().int().nonnegative(),
  itemCount: z.number().int().nonnegative(),
  isReady: z.boolean()
})

export type VaultStatus = z.infer<typeof VaultStatusSchema>

export const SearchQuerySchema = z.object({
  query: z.string().max(256),
  tab: NavigationTabSchema.optional()
})

export type SearchQuery = z.infer<typeof SearchQuerySchema>

export const ScanJobStatusSchema = z.enum([
  'running',
  'paused',
  'cancelled',
  'interrupted',
  'failed',
  'completed'
])
export type ScanJobStatus = z.infer<typeof ScanJobStatusSchema>

export const ScanJobPhaseSchema = z.enum(['discovery', 'hashing', 'completed'])
export type ScanJobPhase = z.infer<typeof ScanJobPhaseSchema>

export const ScanJobStructuredErrorSchema = z.object({
  path: z.string(),
  code: z.string(),
  message: z.string(),
  phase: z.enum(['discovery', 'hashing'])
})
export type ScanJobStructuredError = z.infer<typeof ScanJobStructuredErrorSchema>

export const ScanJobProgressSchema = z.object({
  jobId: z.number().int().positive(),
  status: ScanJobStatusSchema,
  phase: ScanJobPhaseSchema,
  roots: z.array(z.string().min(1)),
  discoveredCount: z.number().int().nonnegative(),
  hashedCount: z.number().int().nonnegative(),
  totalFilesToHash: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  hashedBytes: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
  currentPath: z.string().optional(),
  errors: z.array(ScanJobStructuredErrorSchema),
  errorMessage: z.string().optional(),
  startedAtMs: z.number().int().nonnegative(),
  updatedAtMs: z.number().int().nonnegative(),
  completedAtMs: z.number().int().nonnegative().nullable()
})
export type ScanJobProgress = z.infer<typeof ScanJobProgressSchema>

export const StartScanRequestSchema = z.object({
  roots: z.array(z.string().min(1)).min(1)
})
export type StartScanRequest = z.infer<typeof StartScanRequestSchema>

export const JobIdRequestSchema = z.object({
  jobId: z.number().int().positive()
})
export type JobIdRequest = z.infer<typeof JobIdRequestSchema>

export const JobActionResponseSchema = z.object({
  success: z.boolean(),
  job: ScanJobProgressSchema.optional(),
  error: z.string().optional()
})
export type JobActionResponse = z.infer<typeof JobActionResponseSchema>

export const SelectRootsResponseSchema = z.object({
  cancelled: z.boolean(),
  rootPaths: z.array(z.string().min(1))
})
export type SelectRootsResponse = z.infer<typeof SelectRootsResponseSchema>

export const GetActiveJobResponseSchema = z.object({
  job: ScanJobProgressSchema.nullable()
})
export type GetActiveJobResponse = z.infer<typeof GetActiveJobResponseSchema>

export const GetLatestJobResponseSchema = GetActiveJobResponseSchema
export type GetLatestJobResponse = GetActiveJobResponse

export const DismissJobRequestSchema = z.object({
  jobId: z.number().int().positive()
})
export type DismissJobRequest = z.infer<typeof DismissJobRequestSchema>

export const DismissJobResponseSchema = z.object({
  success: z.boolean(),
  error: z.string().optional()
})
export type DismissJobResponse = z.infer<typeof DismissJobResponseSchema>

export const DuplicateReviewStatusSchema = z.enum(['unreviewed', 'reviewed'])
export type DuplicateReviewStatus = z.infer<typeof DuplicateReviewStatusSchema>

export const DuplicateReviewFilterSchema = z.enum(['all', 'unreviewed', 'reviewed'])
export type DuplicateReviewFilter = z.infer<typeof DuplicateReviewFilterSchema>

export const DuplicatePreviewLocationSchema = z.object({
  id: z.number().int().positive(),
  sourceId: z.number().int().positive(),
  originalPath: z.string().min(1),
  normalizedPath: z.string().min(1),
  fileName: z.string().min(1),
  extension: z.string(),
  category: z.enum(['photo', 'document']),
  byteSize: z.number().int().nonnegative(),
  filesystemBirthtimeMs: z.number().int().nonnegative().nullable(),
  filesystemMtimeMs: z.number().int().nonnegative().nullable(),
  inferredCaptureTimeMs: z.number().int().nonnegative().nullable(),
  firstDiscoveredAtMs: z.number().int().nonnegative(),
  lastSeenAtMs: z.number().int().nonnegative(),
  activeHash: z.string().length(64).nullable(),
  activeHashVerifiedAtMs: z.number().int().nonnegative().nullable(),
  discoveryObservationId: z.number().int().positive(),
  hashObservationId: z.number().int().positive().nullable().optional()
})
export type DuplicatePreviewLocation = z.infer<typeof DuplicatePreviewLocationSchema>

export const DuplicateGroupSummarySchema = z.object({
  sha256: z.string().length(64),
  byteSize: z.number().int().nonnegative(),
  fileCount: z.number().int().positive(),
  groupSignature: z.string().min(1),
  reviewStatus: DuplicateReviewStatusSchema,
  preferredLocationId: z.number().int().positive().nullable(),
  hasStaleDecision: z.boolean(),
  reviewedAtMs: z.number().int().nonnegative().nullable(),
  previewLocations: z.array(DuplicatePreviewLocationSchema),
  truncatedLocations: z.boolean()
})
export type DuplicateGroupSummary = z.infer<typeof DuplicateGroupSummarySchema>

export const GetDuplicateGroupsRequestSchema = z.object({
  offset: z.number().int().nonnegative().optional().default(0),
  limit: z.number().int().positive().max(100).optional().default(20),
  filter: DuplicateReviewFilterSchema.optional()
})
export type GetDuplicateGroupsRequest = z.infer<typeof GetDuplicateGroupsRequestSchema>

export const GetDuplicateGroupsResponseSchema = z.object({
  items: z.array(DuplicateGroupSummarySchema),
  totalCount: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  hasMore: z.boolean()
})
export type GetDuplicateGroupsResponse = z.infer<typeof GetDuplicateGroupsResponseSchema>

export const DuplicateMemberRecordSchema = z.object({
  fileLocationId: z.number().int().positive(),
  sourceId: z.number().int().positive(),
  originalPath: z.string().min(1),
  normalizedPath: z.string().min(1),
  fileName: z.string().min(1),
  extension: z.string(),
  category: z.enum(['photo', 'document']),
  byteSize: z.number().int().nonnegative(),
  filesystemBirthtimeMs: z.number().int().nonnegative().nullable(),
  filesystemMtimeMs: z.number().int().nonnegative().nullable(),
  inferredCaptureTimeMs: z.number().int().nonnegative().nullable(),
  firstDiscoveredAtMs: z.number().int().nonnegative(),
  lastSeenAtMs: z.number().int().nonnegative(),
  discoveryObservationId: z.number().int().positive(),
  hashObservationId: z.number().int().positive(),
  activeHash: z.string().length(64),
  activeHashVerifiedAtMs: z.number().int().nonnegative(),
  isPreferred: z.boolean()
})
export type DuplicateMemberRecord = z.infer<typeof DuplicateMemberRecordSchema>

export const GetDuplicateGroupMembersRequestSchema = z.object({
  sha256: z.string().length(64),
  byteSize: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative().optional().default(0),
  limit: z.number().int().positive().max(200).optional().default(50)
})
export type GetDuplicateGroupMembersRequest = z.infer<typeof GetDuplicateGroupMembersRequestSchema>

export const GetDuplicateGroupMembersResponseSchema = z.object({
  sha256: z.string().length(64),
  byteSize: z.number().int().nonnegative(),
  groupSignature: z.string().min(1),
  reviewStatus: DuplicateReviewStatusSchema,
  preferredLocationId: z.number().int().positive().nullable(),
  hasStaleDecision: z.boolean(),
  reviewedAtMs: z.number().int().nonnegative().nullable().optional(),
  items: z.array(DuplicateMemberRecordSchema),
  totalCount: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  hasMore: z.boolean()
})
export type GetDuplicateGroupMembersResponse = z.infer<
  typeof GetDuplicateGroupMembersResponseSchema
>

export const SetDuplicateReviewRequestSchema = z.object({
  sha256: z.string().length(64),
  byteSize: z.number().int().nonnegative(),
  status: DuplicateReviewStatusSchema,
  preferredLocationId: z.number().int().positive().nullable().optional(),
  expectedGroupSignature: z.string().min(1)
})
export type SetDuplicateReviewRequest = z.infer<typeof SetDuplicateReviewRequestSchema>

export const SetDuplicateReviewResponseSchema = z.object({
  sha256: z.string().length(64),
  byteSize: z.number().int().nonnegative(),
  status: DuplicateReviewStatusSchema,
  preferredLocationId: z.number().int().positive().nullable(),
  groupSignature: z.string().min(1),
  reviewedAtMs: z.number().int().nonnegative()
})
export type SetDuplicateReviewResponse = z.infer<typeof SetDuplicateReviewResponseSchema>

// ==========================================
// Stage 4: Vault & Verified Import Schemas
// ==========================================

export const VaultIdentitySchema = z.object({
  formatVersion: z.literal(1),
  vaultId: z.string().min(1),
  vaultName: z.string().min(1),
  createdAtMs: z.number().int().nonnegative(),
  appVersion: z.string().min(1)
})
export type VaultIdentity = z.infer<typeof VaultIdentitySchema>

export const SelectVaultDirectoryResponseSchema = z.object({
  selectedDirectory: z.string().nullable()
})
export type SelectVaultDirectoryResponse = z.infer<typeof SelectVaultDirectoryResponseSchema>

export const InitializeVaultRequestSchema = z.object({
  vaultPath: z.string().min(1),
  vaultName: z.string().min(1)
})
export type InitializeVaultRequest = z.infer<typeof InitializeVaultRequestSchema>

export const InitializeVaultResponseSchema = z.object({
  vault: VaultIdentitySchema
})
export type InitializeVaultResponse = z.infer<typeof InitializeVaultResponseSchema>

export const VaultRecordSchema = z.object({
  vaultId: z.string().min(1),
  vaultPath: z.string().min(1),
  name: z.string().min(1),
  createdAtMs: z.number().int().nonnegative()
})
export type VaultRecord = z.infer<typeof VaultRecordSchema>

export const GetActiveVaultResponseSchema = z.object({
  vault: VaultRecordSchema.nullable()
})
export type GetActiveVaultResponse = z.infer<typeof GetActiveVaultResponseSchema>

export const SetActiveVaultRequestSchema = z.object({
  vaultPath: z.string().min(1)
})
export type SetActiveVaultRequest = z.infer<typeof SetActiveVaultRequestSchema>

export const SetActiveVaultResponseSchema = z.object({
  vault: VaultRecordSchema
})
export type SetActiveVaultResponse = z.infer<typeof SetActiveVaultResponseSchema>

export const ImportCandidateRecordSchema = z.object({
  fileLocationId: z.number().int().positive(),
  sourceId: z.number().int().positive(),
  originalPath: z.string().min(1),
  fileName: z.string().min(1),
  extension: z.string(),
  category: z.enum(['photo', 'document']),
  byteSize: z.number().int().nonnegative(),
  filesystemBirthtimeMs: z.number().int().nonnegative().nullable(),
  filesystemMtimeMs: z.number().int().nonnegative().nullable(),
  inferredCaptureTimeMs: z.number().int().nonnegative().nullable(),
  sha256: z.string().length(64),
  discoveryObservationId: z.number().int().positive(),
  hashObservationId: z.number().int().positive(),
  firstDiscoveredAtMs: z.number().int().nonnegative().optional(),
  lastSeenAtMs: z.number().int().nonnegative().optional(),
  hashVerifiedAtMs: z.number().int().nonnegative().optional(),
  vaultStatus: z.enum(['not_imported', 'copied']),
  vaultCopyId: z.number().int().positive().nullable().optional(),
  isPreferred: z.boolean().optional()
})
export type ImportCandidateRecord = z.infer<typeof ImportCandidateRecordSchema>
export type ImportCandidateItem = ImportCandidateRecord

export const GetImportCandidatesRequestSchema = z.object({
  vaultId: z.string().min(1),
  offset: z.number().int().nonnegative().optional().default(0),
  limit: z.number().int().positive().max(500).optional().default(50),
  filter: z.enum(['all', 'unimported', 'imported']).optional().default('all'),
  category: z.enum(['photo', 'document']).optional()
})
export type GetImportCandidatesRequest = z.infer<typeof GetImportCandidatesRequestSchema>

export const GetImportCandidatesResponseSchema = z.object({
  items: z.array(ImportCandidateRecordSchema),
  totalCount: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  hasMore: z.boolean()
})
export type GetImportCandidatesResponse = z.infer<typeof GetImportCandidatesResponseSchema>

export const StartImportRequestSchema = z.object({
  vaultId: z.string().min(1),
  fileLocationIds: z.array(z.number().int().positive()).min(1)
})
export type StartImportRequest = z.infer<typeof StartImportRequestSchema>

export const ResumeImportRequestSchema = z.object({
  jobId: z.string().min(1).optional()
})
export type ResumeImportRequest = z.infer<typeof ResumeImportRequestSchema>

export const CancelImportRequestSchema = z.object({
  jobId: z.string().min(1).optional()
})
export type CancelImportRequest = z.infer<typeof CancelImportRequestSchema>

export const PauseImportRequestSchema = z.object({
  jobId: z.string().min(1).optional()
})
export type PauseImportRequest = z.infer<typeof PauseImportRequestSchema>

export const VaultImportJobRecordSchema = z.object({
  id: z.string().min(1),
  vaultId: z.string().min(1),
  status: z.enum(['running', 'paused', 'cancelled', 'interrupted', 'failed', 'completed']),
  totalFiles: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  copiedFiles: z.number().int().nonnegative(),
  copiedBytes: z.number().int().nonnegative(),
  verifiedFiles: z.number().int().nonnegative(),
  failedFiles: z.number().int().nonnegative(),
  startedAtMs: z.number().int().nonnegative(),
  completedAtMs: z.number().int().nonnegative().nullable().optional(),
  errorMessage: z.string().nullable().optional()
})
export type VaultImportJobRecord = z.infer<typeof VaultImportJobRecordSchema>

export const StartImportResponseSchema = z.object({
  job: VaultImportJobRecordSchema
})
export type StartImportResponse = z.infer<typeof StartImportResponseSchema>

export const VaultImportProgressSchema = z.object({
  jobId: z.string().min(1),
  vaultId: z.string().min(1),
  status: z.enum(['running', 'paused', 'cancelled', 'interrupted', 'failed', 'completed']),
  phase: z.enum(['revalidating', 'copying', 'verifying', 'publishing', 'writing_manifest', 'idle']),
  totalFiles: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  copiedFiles: z.number().int().nonnegative(),
  copiedBytes: z.number().int().nonnegative(),
  verifiedFiles: z.number().int().nonnegative(),
  failedFiles: z.number().int().nonnegative(),
  currentFileName: z.string().optional(),
  errorMessage: z.string().nullable().optional()
})
export type VaultImportProgress = z.infer<typeof VaultImportProgressSchema>

export const GetActiveImportJobResponseSchema = z.object({
  job: VaultImportJobRecordSchema.nullable()
})
export type GetActiveImportJobResponse = z.infer<typeof GetActiveImportJobResponseSchema>

export const GetLatestImportJobResponseSchema = z.object({
  job: VaultImportJobRecordSchema.nullable()
})
export type GetLatestImportJobResponse = z.infer<typeof GetLatestImportJobResponseSchema>

export const VaultImportActionResponseSchema = z.object({
  success: z.boolean(),
  job: VaultImportJobRecordSchema.nullable().optional(),
  message: z.string().optional()
})
export type VaultImportActionResponse = z.infer<typeof VaultImportActionResponseSchema>

// --- Stage 5A: Photos & Thumbnails ---

export const PhotoItemSchema = z.object({
  id: z.number().int().positive(),
  sourceId: z.number().int().positive(),
  originalPath: z.string().min(1),
  fileName: z.string().min(1),
  extension: z.string().min(1),
  category: z.literal('photo'),
  discoveryObservationId: z.number().int().positive(),
  byteSize: z.number().int().nonnegative(),
  filesystemBirthtimeMs: z.number().nullable(),
  filesystemMtimeMs: z.number().nullable(),
  inferredCaptureTimeMs: z.number().nullable(),
  firstDiscoveredAtMs: z.number(),
  lastSeenAtMs: z.number(),
  activeHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/i)
    .nullable(),
  activeHashVerifiedAtMs: z.number().nullable(),
  rating: z.number().int().min(1).max(5).nullable().default(null),
  flag: z.enum(['none', 'pick', 'reject']).default('none'),
  annotationVersion: z.number().int().nonnegative().default(0)
})
export type PhotoItem = z.infer<typeof PhotoItemSchema>

export const PhotoRatingFilterSchema = z.enum(['all', 'unrated', '1', '2', '3', '4', '5'])
export type PhotoRatingFilter = z.infer<typeof PhotoRatingFilterSchema>

export const PhotoFlagFilterSchema = z.enum(['all', 'none', 'pick', 'reject'])
export type PhotoFlagFilter = z.infer<typeof PhotoFlagFilterSchema>

export const GetPhotosPageRequestSchema = z.object({
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive().max(200),
  ratingFilter: PhotoRatingFilterSchema.default('all'),
  flagFilter: PhotoFlagFilterSchema.default('all'),
  collectionId: z.number().int().positive().nullable().default(null)
})
export type GetPhotosPageRequest = z.input<typeof GetPhotosPageRequestSchema>

export const GetPhotosPageResponseSchema = z.object({
  items: z.array(PhotoItemSchema),
  totalCount: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  hasMore: z.boolean()
})
export type GetPhotosPageResponse = z.infer<typeof GetPhotosPageResponseSchema>

export const GetThumbnailRequestSchema = z.object({
  locationId: z.number().int().positive(),
  expectedByteSize: z.number().int().nonnegative().optional(),
  expectedMtimeMs: z.number().nullable().optional(),
  priority: z.enum(['high', 'normal', 'low']).optional()
})
export type GetThumbnailRequest = z.infer<typeof GetThumbnailRequestSchema>

export const ThumbnailReadySchema = z.object({
  status: z.literal('ready'),
  locationId: z.number().int().positive(),
  dataUrl: z
    .string()
    .regex(/^data:image\/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=]+$/)
    .max(2 * 1024 * 1024),
  mimeType: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive()
})

export const ThumbnailUnsupportedSchema = z.object({
  status: z.literal('unsupported'),
  locationId: z.number().int().positive(),
  reason: z.string().min(1)
})

export const ThumbnailErrorSchema = z.object({
  status: z.literal('error'),
  locationId: z.number().int().positive(),
  code: z.string().min(1),
  message: z.string().min(1)
})

export const ThumbnailMissingSchema = z.object({
  status: z.literal('missing'),
  locationId: z.number().int().positive(),
  reason: z.string().min(1)
})

export const ThumbnailResultSchema = z.discriminatedUnion('status', [
  ThumbnailReadySchema,
  ThumbnailUnsupportedSchema,
  ThumbnailErrorSchema,
  ThumbnailMissingSchema
])
export type ThumbnailResult = z.infer<typeof ThumbnailResultSchema>

export const CancelThumbnailRequestSchema = z.object({
  locationId: z.number().int().positive()
})
export type CancelThumbnailRequest = z.infer<typeof CancelThumbnailRequestSchema>

export const CancelThumbnailResponseSchema = z.object({
  success: z.boolean(),
  locationId: z.number().int().positive()
})
export type CancelThumbnailResponse = z.infer<typeof CancelThumbnailResponseSchema>

export const PhotosDiagnosticsResponseSchema = z.object({
  activeWorkers: z.number().int().nonnegative(),
  terminatingWorkers: z.number().int().nonnegative().optional(),
  liveWorkers: z.number().int().nonnegative().optional(),
  activeSemanticTasks: z.number().int().nonnegative().optional(),
  semanticModelLoadedWorkers: z.number().int().nonnegative().optional(),
  queuedJobs: z.number().int().nonnegative(),
  totalDecodes: z.number().int().nonnegative(),
  cacheHits: z.number().int().nonnegative(),
  cacheMisses: z.number().int().nonnegative(),
  mainEventLoopDelayP95Ms: z.number().nonnegative().optional(),
  mainEventLoopDelayMaxMs: z.number().nonnegative().optional(),
  mainEventLoopDelayMeanMs: z.number().nonnegative().optional(),
  mainProcessRssBytes: z.number().int().nonnegative().optional(),
  mainProcessHeapUsedBytes: z.number().int().nonnegative().optional(),
  workerIsolatePeakHeapUsedBytes: z.number().int().nonnegative().optional(),
  workerIsolateLastHeapUsedBytes: z.number().int().nonnegative().optional(),
  workerIsolatePeakExternalBytes: z.number().int().nonnegative().optional()
})
export type PhotosDiagnosticsResponse = z.infer<typeof PhotosDiagnosticsResponseSchema>

// --- Stage 5B: Photo Review, Annotations, and Custom Collections ---

export const PhotoAnnotationSchema = z.object({
  id: z.number().int().positive(),
  fileLocationId: z.number().int().positive(),
  discoveryObservationId: z.number().int().positive(),
  contentSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/i)
    .nullable(),
  rating: z.number().int().min(1).max(5).nullable(),
  flag: z.enum(['none', 'pick', 'reject']),
  version: z.number().int().positive(),
  isCurrent: z.boolean(),
  createdAtMs: z.number().int().positive(),
  updatedAtMs: z.number().int().positive(),
  persistencePending: z.boolean().optional(),
  persistenceError: z.string().optional()
})
export type PhotoAnnotation = z.infer<typeof PhotoAnnotationSchema>

export const SetPhotoAnnotationRequestSchema = z.object({
  fileLocationId: z.number().int().positive(),
  expectedRevision: z.string().min(1),
  expectedVersion: z.number().int().nonnegative(),
  rating: z.number().int().min(1).max(5).nullable(),
  flag: z.enum(['none', 'pick', 'reject'])
})
export type SetPhotoAnnotationRequest = z.infer<typeof SetPhotoAnnotationRequestSchema>

export const SetPhotoAnnotationResponseSchema = z.object({
  success: z.boolean(),
  annotation: PhotoAnnotationSchema,
  persistencePending: z.boolean().optional(),
  persistenceError: z.string().optional()
})
export type SetPhotoAnnotationResponse = z.infer<typeof SetPhotoAnnotationResponseSchema>

export const GetPhotoAnnotationRequestSchema = z.object({
  fileLocationId: z.number().int().positive()
})
export type GetPhotoAnnotationRequest = z.infer<typeof GetPhotoAnnotationRequestSchema>

export const GetPhotoAnnotationResponseSchema = z.object({
  annotation: PhotoAnnotationSchema.nullable()
})
export type GetPhotoAnnotationResponse = z.infer<typeof GetPhotoAnnotationResponseSchema>

export const CollectionNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine(
    (name) => {
      for (let i = 0; i < name.length; i++) {
        const code = name.charCodeAt(i)
        if ((code >= 0 && code <= 31) || (code >= 127 && code <= 159)) return false
      }
      return true
    },
    {
      message: 'Collection name must not contain control characters'
    }
  )

export const CollectionItemSchema = z.object({
  id: z.number().int().positive(),
  name: CollectionNameSchema,
  normalizedName: z.string().min(1),
  createdAtMs: z.number().int().positive(),
  updatedAtMs: z.number().int().positive(),
  photoCount: z.number().int().nonnegative().optional(),
  persistencePending: z.boolean().optional(),
  persistenceError: z.string().optional()
})
export type CollectionItem = z.infer<typeof CollectionItemSchema>

export const CreateCollectionRequestSchema = z.object({
  name: CollectionNameSchema
})
export type CreateCollectionRequest = z.infer<typeof CreateCollectionRequestSchema>

export const CreateCollectionResponseSchema = z.object({
  collection: CollectionItemSchema,
  persistencePending: z.boolean().optional(),
  persistenceError: z.string().optional()
})
export type CreateCollectionResponse = z.infer<typeof CreateCollectionResponseSchema>

export const RenameCollectionRequestSchema = z.object({
  collectionId: z.number().int().positive(),
  name: CollectionNameSchema
})
export type RenameCollectionRequest = z.infer<typeof RenameCollectionRequestSchema>

export const RenameCollectionResponseSchema = z.object({
  collection: CollectionItemSchema,
  persistencePending: z.boolean().optional(),
  persistenceError: z.string().optional()
})
export type RenameCollectionResponse = z.infer<typeof RenameCollectionResponseSchema>

export const ReconcileJournalResponseSchema = z.object({
  success: z.boolean(),
  reconciledCount: z.number().int().nonnegative()
})
export type ReconcileJournalResponse = z.infer<typeof ReconcileJournalResponseSchema>

export const ListCollectionsRequestSchema = z.object({
  offset: z.number().int().nonnegative().optional().default(0),
  limit: z.number().int().positive().max(200).optional().default(50)
})
export type ListCollectionsRequest = z.input<typeof ListCollectionsRequestSchema>

export const ListCollectionsResponseSchema = z.object({
  items: z.array(CollectionItemSchema),
  totalCount: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  hasMore: z.boolean()
})
export type ListCollectionsResponse = z.infer<typeof ListCollectionsResponseSchema>

export const AddCollectionMemberRequestSchema = z.object({
  collectionId: z.number().int().positive(),
  fileLocationId: z.number().int().positive(),
  expectedRevision: z.string().min(1)
})
export type AddCollectionMemberRequest = z.infer<typeof AddCollectionMemberRequestSchema>

export const AddCollectionMemberResponseSchema = z.object({
  success: z.boolean(),
  isNew: z.boolean(),
  persistencePending: z.boolean().optional(),
  persistenceError: z.string().optional()
})
export type AddCollectionMemberResponse = z.infer<typeof AddCollectionMemberResponseSchema>

export const RemoveCollectionMemberRequestSchema = z.object({
  collectionId: z.number().int().positive(),
  fileLocationId: z.number().int().positive(),
  expectedRevision: z.string().min(1)
})
export type RemoveCollectionMemberRequest = z.infer<typeof RemoveCollectionMemberRequestSchema>

export const RemoveCollectionMemberResponseSchema = z.object({
  success: z.boolean(),
  persistencePending: z.boolean().optional(),
  persistenceError: z.string().optional()
})
export type RemoveCollectionMemberResponse = z.infer<typeof RemoveCollectionMemberResponseSchema>

export const PhotoMembershipItemSchema = z.object({
  id: z.number().int().positive(),
  collectionId: z.number().int().positive(),
  collectionName: z.string().min(1),
  fileLocationId: z.number().int().positive(),
  createdAtMs: z.number().int().positive()
})
export type PhotoMembershipItem = z.infer<typeof PhotoMembershipItemSchema>

export const GetPhotoMembershipsRequestSchema = z.object({
  fileLocationId: z.number().int().positive(),
  offset: z.number().int().nonnegative().optional().default(0),
  limit: z.number().int().positive().max(200).optional().default(50)
})
export type GetPhotoMembershipsRequest = z.input<typeof GetPhotoMembershipsRequestSchema>

export const GetPhotoMembershipsResponseSchema = z.object({
  items: z.array(PhotoMembershipItemSchema),
  totalCount: z.number().int().nonnegative(),
  hasMore: z.boolean()
})
export type GetPhotoMembershipsResponse = z.infer<typeof GetPhotoMembershipsResponseSchema>

export const CURRENT_JOURNAL_FORMAT_VERSION = 1

export const AnnotationJournalEntrySchema = z.discriminatedUnion('kind', [
  z.object({
    formatVersion: z.number().int().positive().default(CURRENT_JOURNAL_FORMAT_VERSION),
    entrySeq: z.number().int().positive(),
    entryTimestampMs: z.number().int().positive(),
    opId: z.string().min(1),
    kind: z.literal('photo_annotation'),
    locationId: z.number().int().positive(),
    normalizedPath: z.string().min(1),
    originalPath: z.string().min(1),
    byteSize: z.number().int().nonnegative(),
    filesystemMtimeMs: z.number().nullable(),
    activeHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .nullable(),
    discoveryObservationId: z.number().int().positive(),
    expectedRevision: z.string().min(1),
    version: z.number().int().positive(),
    rating: z.number().int().min(1).max(5).nullable(),
    flag: z.enum(['none', 'pick', 'reject'])
  }),
  z.object({
    formatVersion: z.number().int().positive().default(CURRENT_JOURNAL_FORMAT_VERSION),
    entrySeq: z.number().int().positive(),
    entryTimestampMs: z.number().int().positive(),
    opId: z.string().min(1),
    kind: z.literal('collection_created'),
    collectionId: z.number().int().positive(),
    name: z.string().min(1).max(80),
    normalizedName: z.string().min(1).max(80)
  }),
  z.object({
    formatVersion: z.number().int().positive().default(CURRENT_JOURNAL_FORMAT_VERSION),
    entrySeq: z.number().int().positive(),
    entryTimestampMs: z.number().int().positive(),
    opId: z.string().min(1),
    kind: z.literal('collection_renamed'),
    collectionId: z.number().int().positive(),
    oldName: z.string().min(1).max(80),
    newName: z.string().min(1).max(80),
    normalizedName: z.string().min(1).max(80)
  }),
  z.object({
    formatVersion: z.number().int().positive().default(CURRENT_JOURNAL_FORMAT_VERSION),
    entrySeq: z.number().int().positive(),
    entryTimestampMs: z.number().int().positive(),
    opId: z.string().min(1),
    kind: z.literal('membership_added'),
    collectionId: z.number().int().positive(),
    collectionName: z.string().min(1),
    locationId: z.number().int().positive(),
    expectedRevision: z.string().min(1),
    normalizedPath: z.string().min(1),
    byteSize: z.number().int().nonnegative(),
    activeHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .nullable(),
    discoveryObservationId: z.number().int().positive()
  }),
  z.object({
    formatVersion: z.number().int().positive().default(CURRENT_JOURNAL_FORMAT_VERSION),
    entrySeq: z.number().int().positive(),
    entryTimestampMs: z.number().int().positive(),
    opId: z.string().min(1),
    kind: z.literal('membership_removed'),
    collectionId: z.number().int().positive(),
    collectionName: z.string().min(1),
    locationId: z.number().int().positive(),
    expectedRevision: z.string().min(1),
    normalizedPath: z.string().min(1)
  }),
  z.object({
    formatVersion: z.number().int().positive().default(CURRENT_JOURNAL_FORMAT_VERSION),
    entrySeq: z.number().int().positive(),
    entryTimestampMs: z.number().int().positive(),
    opId: z.string().min(1),
    kind: z.literal('op_committed'),
    targetSeq: z.number().int().positive()
  }),
  z.object({
    formatVersion: z.number().int().positive().default(CURRENT_JOURNAL_FORMAT_VERSION),
    entrySeq: z.number().int().positive(),
    entryTimestampMs: z.number().int().positive(),
    opId: z.string().min(1),
    kind: z.literal('op_aborted'),
    targetSeq: z.number().int().positive(),
    reason: z.string().min(1)
  }),
  z.object({
    formatVersion: z.number().int().positive().default(CURRENT_JOURNAL_FORMAT_VERSION),
    entrySeq: z.number().int().positive(),
    entryTimestampMs: z.number().int().positive(),
    opId: z.string().min(1),
    kind: z.literal('similarity_decision'),
    locationIdA: z.number().int().positive(),
    locationIdB: z.number().int().positive(),
    expectedRevisionA: z.string().min(1),
    expectedRevisionB: z.string().min(1),
    decision: z.enum(['edited_version', 'similar_scene', 'unrelated', 'unreviewed']),
    version: z.number().int().positive()
  })
])
export type AnnotationJournalEntry = z.infer<typeof AnnotationJournalEntrySchema>

// ============================================================================
// Stage 5C: Visual Similarity Review Schemas
// ============================================================================

export const SimilarityJobStatusSchema = z.enum([
  'idle',
  'running',
  'paused',
  'cancelled',
  'interrupted',
  'completed',
  'failed'
])
export type SimilarityJobStatus = z.infer<typeof SimilarityJobStatusSchema>

export const SimilarityAnalysisProgressSchema = z.object({
  jobId: z.string().nullable(),
  status: SimilarityJobStatusSchema,
  algorithmVersion: z.string(),
  totalPhotos: z.number().int().nonnegative(),
  processedPhotos: z.number().int().nonnegative(),
  errorPhotos: z.number().int().nonnegative(),
  unsupportedPhotos: z.number().int().nonnegative(),
  candidatePairsFound: z.number().int().nonnegative(),
  startedAtMs: z.number().int().nullable(),
  updatedAtMs: z.number().int().nullable(),
  completedAtMs: z.number().int().nullable()
})
export type SimilarityAnalysisProgress = z.infer<typeof SimilarityAnalysisProgressSchema>

export const SimilarityDecisionTypeSchema = z.enum([
  'edited_version',
  'similar_scene',
  'unrelated',
  'unreviewed'
])
export type SimilarityDecisionType = z.infer<typeof SimilarityDecisionTypeSchema>

export const SimilarityCandidatePhotoSchema = z.object({
  id: z.number().int().positive(),
  fileName: z.string().min(1),
  originalPath: z.string().min(1),
  byteSize: z.number().int().nonnegative(),
  filesystemBirthtimeMs: z.number().nullable(),
  filesystemMtimeMs: z.number().nullable(),
  activeHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/i)
    .nullable(),
  discoveryObservationId: z.number().int().positive(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  rating: z.number().int().min(1).max(5).nullable(),
  flag: z.enum(['none', 'pick', 'reject'])
})
export type SimilarityCandidatePhoto = z.infer<typeof SimilarityCandidatePhotoSchema>

export const SimilarityCandidatePairSchema = z.object({
  id: z.number().int().positive(),
  jobId: z.string().min(1),
  locationIdA: z.number().int().positive(),
  locationIdB: z.number().int().positive(),
  photoA: SimilarityCandidatePhotoSchema,
  photoB: SimilarityCandidatePhotoSchema,
  distance: z.number().int().min(0).max(64),
  similarityScore: z.number().min(0).max(1),
  algorithmVersion: z.string().min(1),
  decision: SimilarityDecisionTypeSchema,
  decisionVersion: z.number().int().positive().nullable(),
  decisionUpdatedAtMs: z.number().int().nullable(),
  createdAtMs: z.number().int().positive()
})
export type SimilarityCandidatePair = z.infer<typeof SimilarityCandidatePairSchema>

export const SimilarityGetPairsFilterSchema = z.enum([
  'all',
  'unreviewed',
  'reviewed',
  'edited_version',
  'similar_scene',
  'unrelated'
])
export type SimilarityGetPairsFilter = z.infer<typeof SimilarityGetPairsFilterSchema>

export const SimilarityGetPairsRequestSchema = z.object({
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().positive().max(100).default(10),
  filter: SimilarityGetPairsFilterSchema.default('all')
})
export type SimilarityGetPairsRequest = z.infer<typeof SimilarityGetPairsRequestSchema>

export const SimilarityGetPairsResponseSchema = z.object({
  pairs: z.array(SimilarityCandidatePairSchema),
  totalCount: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  totalPages: z.number().int().nonnegative()
})
export type SimilarityGetPairsResponse = z.infer<typeof SimilarityGetPairsResponseSchema>

export const SimilaritySetDecisionRequestSchema = z.object({
  locationIdA: z.number().int().positive(),
  locationIdB: z.number().int().positive(),
  expectedRevisionA: z.string().min(1),
  expectedRevisionB: z.string().min(1),
  decision: SimilarityDecisionTypeSchema,
  expectedVersion: z.number().int().positive().optional()
})
export type SimilaritySetDecisionRequest = z.infer<typeof SimilaritySetDecisionRequestSchema>

export const SimilaritySetDecisionResponseSchema = z.object({
  success: z.boolean(),
  decision: SimilarityDecisionTypeSchema,
  version: z.number().int().positive(),
  persistencePending: z.boolean().default(false),
  message: z.string().optional()
})
export type SimilaritySetDecisionResponse = z.infer<typeof SimilaritySetDecisionResponseSchema>

export const SimilarityReconcileResponseSchema = z.object({
  reconciledCount: z.number().int().nonnegative(),
  unresolvedCount: z.number().int().nonnegative()
})
export type SimilarityReconcileResponse = z.infer<typeof SimilarityReconcileResponseSchema>

// ============================================================================
// Stage 6B: Semantic Model Provisioning & Resumable Semantic Index Schemas
// ============================================================================

export const SemanticModelProvisionStateSchema = z.enum([
  'missing',
  'installing',
  'ready',
  'cancelled',
  'error'
])
export type SemanticModelProvisionState = z.infer<typeof SemanticModelProvisionStateSchema>

export const SemanticModelStatusResponseSchema = z.object({
  state: SemanticModelProvisionStateSchema,
  modelId: z.string().min(1),
  modelCommit: z.string().min(1),
  modelManifestSha256: z.string().regex(/^[0-9a-f]{64}$/i),
  preprocessingVersion: z.string().min(1),
  dimensions: z.number().int().positive(),
  requiredBytes: z.number().int().positive(),
  downloadedBytes: z.number().int().nonnegative(),
  currentArtifact: z.string().nullable(),
  verifiedAtMs: z.number().int().nullable(),
  error: z.string().nullable(),
  lastReplacementError: z.string().nullable()
})
export type SemanticModelStatusResponse = z.infer<typeof SemanticModelStatusResponseSchema>

export const SemanticIndexJobStatusSchema = z.enum([
  'idle',
  'running',
  'paused',
  'completed',
  'cancelled',
  'interrupted',
  'failed'
])
export type SemanticIndexJobStatus = z.infer<typeof SemanticIndexJobStatusSchema>

export const SemanticIndexProgressResponseSchema = z.object({
  jobId: z.string().nullable(),
  status: SemanticIndexJobStatusSchema,
  modelId: z.string().min(1),
  modelCommit: z.string().min(1),
  preprocessingVersion: z.string().min(1),
  totalPhotos: z.number().int().nonnegative(),
  processedPhotos: z.number().int().nonnegative(),
  reusedPhotos: z.number().int().nonnegative(),
  unsupportedPhotos: z.number().int().nonnegative(),
  failedPhotos: z.number().int().nonnegative(),
  pendingPhotos: z.number().int().nonnegative(),
  totalCatalogPhotos: z.number().int().nonnegative(),
  currentIndexedPhotos: z.number().int().nonnegative(),
  startedAtMs: z.number().int().nullable(),
  updatedAtMs: z.number().int().nullable(),
  completedAtMs: z.number().int().nullable(),
  lastError: z.string().nullable()
})
export type SemanticIndexProgressResponse = z.infer<typeof SemanticIndexProgressResponseSchema>

export const SemanticIndexItemStatusSchema = z.enum([
  'pending',
  'completed',
  'reused',
  'unsupported',
  'failed',
  'skipped'
])
export type SemanticIndexItemStatus = z.infer<typeof SemanticIndexItemStatusSchema>

export const SemanticIndexJobItemSchema = z.object({
  id: z.number().int().positive(),
  jobId: z.string().min(1),
  fileLocationId: z.number().int().positive(),
  originalPath: z.string().min(1),
  discoveryObservationId: z.number().int().positive(),
  expectedByteSize: z.number().int().nonnegative(),
  expectedMtimeMs: z.number(),
  status: SemanticIndexItemStatusSchema,
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  updatedAtMs: z.number().int().nullable()
})
export type SemanticIndexJobItem = z.infer<typeof SemanticIndexJobItemSchema>

export const SemanticIndexJobItemsRequestSchema = z.object({
  jobId: z.string().min(1).nullable().optional(),
  status: SemanticIndexItemStatusSchema.optional(),
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().positive().max(200).default(25)
})
export type SemanticIndexJobItemsRequest = z.input<typeof SemanticIndexJobItemsRequestSchema>

export const SemanticIndexJobItemsResponseSchema = z.object({
  jobId: z.string().nullable(),
  items: z.array(SemanticIndexJobItemSchema),
  totalCount: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive()
})
export type SemanticIndexJobItemsResponse = z.infer<typeof SemanticIndexJobItemsResponseSchema>

export function validatePayload<T>(
  schema: z.ZodSchema<T>,
  data: unknown
): { success: true; data: T } | { success: false; error: string } {
  const result = schema.safeParse(data)
  if (result.success) {
    return { success: true, data: result.data }
  }
  return {
    success: false,
    error: (result.error.issues ?? [])
      .map((e) => `${e.path.join('.') || 'payload'}: ${e.message}`)
      .join(', ')
  }
}
