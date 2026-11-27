import { z } from 'zod'

export const UpdatePhaseSchema = z.enum([
  'idle',
  'checking',
  'up_to_date',
  'available',
  'deferred',
  'downloading',
  'waiting_for_jobs',
  'installing',
  'error'
])
export type UpdatePhase = z.infer<typeof UpdatePhaseSchema>

export const UpdateDownloadProgressSchema = z
  .object({
    percent: z.number().finite().min(0).max(100),
    transferredBytes: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
    bytesPerSecond: z.number().finite().nonnegative()
  })
  .strict()
export type UpdateDownloadProgressDto = z.infer<typeof UpdateDownloadProgressSchema>

export const UpdateActiveJobsSchema = z
  .object({
    vaultImportActive: z.boolean(),
    backupActive: z.boolean()
  })
  .strict()
export type UpdateActiveJobsDto = z.infer<typeof UpdateActiveJobsSchema>

export const UpdateFailedStageSchema = z.enum(['check', 'download', 'install'])
export type UpdateFailedStage = z.infer<typeof UpdateFailedStageSchema>

export const UpdateStateSchema = z
  .object({
    phase: UpdatePhaseSchema,
    configured: z.boolean(),
    currentVersion: z.string().min(1),
    availableVersion: z.string().min(1).nullable(),
    releaseDate: z.string().nullable(),
    downloadProgress: UpdateDownloadProgressSchema.nullable(),
    activeJobs: UpdateActiveJobsSchema,
    errorMessage: z.string().nullable(),
    failedStage: UpdateFailedStageSchema.nullable(),
    lastCheckedAtMs: z.number().int().nonnegative().nullable()
  })
  .strict()
export type UpdateStateDto = z.infer<typeof UpdateStateSchema>

export const UpdateActionResponseSchema = z
  .object({
    accepted: z.boolean(),
    state: UpdateStateSchema
  })
  .strict()
export type UpdateActionResponseDto = z.infer<typeof UpdateActionResponseSchema>
