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
  activeHashVerifiedAtMs: z.number().nullable()
})
export type PhotoItem = z.infer<typeof PhotoItemSchema>

export const GetPhotosPageRequestSchema = z.object({
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive().max(200)
})
export type GetPhotosPageRequest = z.infer<typeof GetPhotosPageRequestSchema>

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
  queuedJobs: z.number().int().nonnegative(),
  totalDecodes: z.number().int().nonnegative(),
  cacheHits: z.number().int().nonnegative(),
  cacheMisses: z.number().int().nonnegative()
})
export type PhotosDiagnosticsResponse = z.infer<typeof PhotosDiagnosticsResponseSchema>

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
