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
