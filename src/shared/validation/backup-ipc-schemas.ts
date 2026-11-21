import { z } from 'zod'

const BackupSha256HexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/i, 'Must be a 64-character hex SHA-256')
const BackupEncryptionModeSchema = z.enum(['none', 'aes-256-gcm-v1'])
const BackupVerificationScopeSchema = z.enum(['full_readback', 'incremental_new_chunks_verified'])

export const BackupDestinationKindSchema = z.enum(['local_fs', 'drive_for_desktop', 'google_drive'])
export type BackupDestinationKindDto = z.infer<typeof BackupDestinationKindSchema>

export const BackupJobStatusSchema = z.enum([
  'queued_destination_unavailable',
  'capturing',
  'running',
  'paused',
  'interrupted',
  'completed',
  'cancelled',
  'failed',
  'abandoned'
])
export type BackupJobStatusDto = z.infer<typeof BackupJobStatusSchema>

export const BackupPauseReasonSchema = z.enum([
  'user_paused',
  'destination_unavailable',
  'daily_budget_exhausted',
  'metered_network',
  'provider_quota'
])
export type BackupPauseReasonDto = z.infer<typeof BackupPauseReasonSchema>

export const BackupDestinationRecordSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    kind: BackupDestinationKindSchema,
    targetPath: z.string().nullable(),
    maxBytesPerSecond: z.number().int().positive().nullable(),
    dailyBudgetBytes: z.number().int().positive().nullable(),
    encryptionMode: BackupEncryptionModeSchema,
    repositoryId: z.string().nullable(),
    isEnabled: z.boolean(),
    lastVerifiedSnapshotId: z.string().nullable(),
    lastVerifiedAtMs: z.number().int().nonnegative().nullable(),
    createdAtMs: z.number().int().nonnegative(),
    updatedAtMs: z.number().int().nonnegative()
  })
  .strict()
export type BackupDestinationRecordDto = z.infer<typeof BackupDestinationRecordSchema>

export const BackupJobRecordSchema = z
  .object({
    id: z.string().min(1),
    destinationId: z.string().min(1),
    snapshotId: z.string().min(1),
    repositoryId: z.string().nullable(),
    status: BackupJobStatusSchema,
    pauseReason: BackupPauseReasonSchema.nullable(),
    stagingDir: z.string().nullable(),
    verificationScope: BackupVerificationScopeSchema.nullable(),
    totalObjectCount: z.number().int().nonnegative(),
    completedObjectCount: z.number().int().nonnegative(),
    writtenChunkCount: z.number().int().nonnegative(),
    reusedChunkCount: z.number().int().nonnegative(),
    totalLogicalBytes: z.number().int().nonnegative(),
    totalStoredBytes: z.number().int().nonnegative(),
    transferredBytes: z.number().int().nonnegative(),
    manifestSha256: z.string().nullable(),
    abandonedFromJobId: z.string().nullable(),
    errorCode: z.string().nullable(),
    errorMessage: z.string().nullable(),
    createdAtMs: z.number().int().nonnegative(),
    startedAtMs: z.number().int().nonnegative().nullable(),
    updatedAtMs: z.number().int().nonnegative(),
    completedAtMs: z.number().int().nonnegative().nullable()
  })
  .strict()
export type BackupJobRecordDto = z.infer<typeof BackupJobRecordSchema>

export const BackupSelectDirectoryRequestSchema = z
  .object({
    title: z.string().min(1).max(128).optional()
  })
  .strict()
export type BackupSelectDirectoryRequest = z.infer<typeof BackupSelectDirectoryRequestSchema>

export const BackupSelectDirectoryResponseSchema = z
  .object({
    canceled: z.boolean(),
    directoryPath: z.string().min(1).nullable()
  })
  .strict()
export type BackupSelectDirectoryResponse = z.infer<typeof BackupSelectDirectoryResponseSchema>

export const BackupConfigureDestinationRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    kind: z.literal('local_fs').default('local_fs'),
    targetPath: z.string().trim().min(1),
    maxBytesPerSecond: z.number().int().min(65536).nullable().optional()
  })
  .strict()
export type BackupConfigureDestinationRequest = z.infer<
  typeof BackupConfigureDestinationRequestSchema
>

export const BackupListDestinationsRequestSchema = z
  .object({
    enabledOnly: z.boolean().optional()
  })
  .strict()
export type BackupListDestinationsRequest = z.infer<typeof BackupListDestinationsRequestSchema>

export const BackupListDestinationsResponseSchema = z.array(BackupDestinationRecordSchema)
export type BackupListDestinationsResponse = z.infer<typeof BackupListDestinationsResponseSchema>

export const BackupStartRequestSchema = z
  .object({
    destinationId: z.string().min(1)
  })
  .strict()
export type BackupStartRequest = z.infer<typeof BackupStartRequestSchema>

export const BackupJobActionRequestSchema = z
  .object({
    jobId: z.string().min(1)
  })
  .strict()
export type BackupJobActionRequest = z.infer<typeof BackupJobActionRequestSchema>

export const BackupJobActionResponseSchema = z
  .object({
    accepted: z.boolean(),
    jobId: z.string().min(1)
  })
  .strict()
export type BackupJobActionResponse = z.infer<typeof BackupJobActionResponseSchema>

export const BackupListJobsRequestSchema = z
  .object({
    destinationId: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).optional()
  })
  .strict()
export type BackupListJobsRequest = z.infer<typeof BackupListJobsRequestSchema>

export const BackupListJobsResponseSchema = z
  .object({
    items: z.array(BackupJobRecordSchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative()
  })
  .strict()
export type BackupListJobsResponse = z.infer<typeof BackupListJobsResponseSchema>

export const BackupRecoveryPointSummarySchema = z
  .object({
    snapshotId: z.string().min(1),
    isComplete: z.boolean(),
    reasons: z.array(z.string()),
    repositoryId: z.string().nullable(),
    createdAtMs: z.number().int().nonnegative().nullable(),
    completedAtMs: z.number().int().nonnegative().nullable(),
    verificationScope: BackupVerificationScopeSchema.nullable(),
    totalObjectCount: z.number().int().nonnegative().nullable(),
    totalLogicalBytes: z.number().int().nonnegative().nullable(),
    totalStoredBytes: z.number().int().nonnegative().nullable(),
    vaultName: z.string().nullable(),
    vaultCopyCount: z.number().int().nonnegative().nullable()
  })
  .strict()
export type BackupRecoveryPointSummary = z.infer<typeof BackupRecoveryPointSummarySchema>

export const BackupListRecoveryPointsRequestSchema = z
  .object({
    backupRepoDir: z.string().trim().min(1)
  })
  .strict()
export type BackupListRecoveryPointsRequest = z.infer<typeof BackupListRecoveryPointsRequestSchema>

export const BackupListRecoveryPointsResponseSchema = z
  .object({
    backupRepoDir: z.string().min(1),
    repositoryId: z.string().nullable(),
    recoveryPoints: z.array(BackupRecoveryPointSummarySchema)
  })
  .strict()
export type BackupListRecoveryPointsResponse = z.infer<
  typeof BackupListRecoveryPointsResponseSchema
>

export const BackupVerifyRecoveryPointRequestSchema = z
  .object({
    backupRepoDir: z.string().trim().min(1),
    snapshotId: z.string().trim().min(1)
  })
  .strict()
export type BackupVerifyRecoveryPointRequest = z.infer<
  typeof BackupVerifyRecoveryPointRequestSchema
>

export const BackupVerifyRecoveryPointResponseSchema = z
  .object({
    repositoryId: z.string().min(1),
    snapshotId: z.string().min(1),
    schemaVersion: z.number().int().positive(),
    verifiedObjectCount: z.number().int().nonnegative(),
    verifiedFileCount: z.number().int().nonnegative(),
    hasVault: z.boolean(),
    hasAnnotations: z.boolean()
  })
  .strict()
export type BackupVerifyRecoveryPointResponse = z.infer<
  typeof BackupVerifyRecoveryPointResponseSchema
>

export const BackupRestoreRequestSchema = z
  .object({
    backupRepoDir: z.string().trim().min(1),
    snapshotId: z.string().trim().min(1),
    targetProfileDir: z.string().trim().min(1),
    targetVaultDir: z.string().trim().min(1).nullable().optional()
  })
  .strict()
export type BackupRestoreRequest = z.infer<typeof BackupRestoreRequestSchema>

export const BackupRestoreResponseSchema = z
  .object({
    restoreJobId: z.string().min(1),
    repositoryId: z.string().min(1),
    snapshotId: z.string().min(1),
    restoredProfilePath: z.string().min(1),
    restoredVaultPath: z.string().nullable(),
    catalogSha256: BackupSha256HexSchema,
    verifiedFileCount: z.number().int().nonnegative(),
    restoredAtMs: z.number().int().nonnegative()
  })
  .strict()
export type BackupRestoreResponse = z.infer<typeof BackupRestoreResponseSchema>

export const BackupProgressEventSchema = z
  .object({
    job: BackupJobRecordSchema
  })
  .strict()
export type BackupProgressEvent = z.infer<typeof BackupProgressEventSchema>

export const BackupRecoverCatalogRequestSchema = z
  .object({
    sourceVaultDir: z.string().trim().min(1),
    targetProfileDir: z.string().trim().min(1)
  })
  .strict()
export type BackupRecoverCatalogRequest = z.infer<typeof BackupRecoverCatalogRequestSchema>

export const BackupRecoverCatalogResponseSchema = z
  .object({
    recoveryJobId: z.string().min(1),
    vaultId: z.string().min(1),
    vaultName: z.string().min(1),
    sourceVaultDir: z.string().min(1),
    targetProfileDir: z.string().min(1),
    catalogPath: z.string().min(1),
    catalogSha256: BackupSha256HexSchema,
    recoveredVaultCopies: z.number().int().nonnegative(),
    recoveredSources: z.number().int().nonnegative(),
    recoveredFileLocations: z.number().int().nonnegative(),
    recoveredObservations: z.number().int().nonnegative(),
    historicalObservations: z.number().int().nonnegative(),
    recoveredAtMs: z.number().int().nonnegative(),
    currentVersionSelectionNote: z.literal('inferred_from_manifest_evidence'),
    omittedDataCategories: z.array(z.string().min(1))
  })
  .strict()
export type BackupRecoverCatalogResponse = z.infer<typeof BackupRecoverCatalogResponseSchema>
