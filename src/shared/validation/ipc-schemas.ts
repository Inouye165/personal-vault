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
