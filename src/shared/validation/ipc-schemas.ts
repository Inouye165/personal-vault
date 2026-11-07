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
