import { z } from 'zod'

export const DocumentExtractionStatusSchema = z.enum(['not_extracted'])
export type DocumentExtractionStatus = z.infer<typeof DocumentExtractionStatusSchema>

export const DocumentPreviewStatusSchema = z.enum(['not_implemented'])
export type DocumentPreviewStatus = z.infer<typeof DocumentPreviewStatusSchema>

export const DocumentSummaryItemSchema = z.object({
  fileLocationId: z.number().int().positive(),
  sourceId: z.number().int().positive(),
  fileName: z.string().min(1),
  extension: z.string(),
  originalPath: z.string().min(1),
  byteSize: z.number().int().nonnegative(),
  filesystemBirthtimeMs: z.number().finite().nullable(),
  filesystemMtimeMs: z.number().finite().nullable(),
  firstDiscoveredAtMs: z.number().finite(),
  lastSeenAtMs: z.number().finite(),
  discoveryObservationId: z.number().int().positive(),
  activeHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/i)
    .nullable(),
  activeHashVerifiedAtMs: z.number().finite().nullable(),
  extractionStatus: DocumentExtractionStatusSchema,
  previewStatus: DocumentPreviewStatusSchema
})
export type DocumentSummaryItem = z.infer<typeof DocumentSummaryItemSchema>

export const DocumentDetailItemSchema = DocumentSummaryItemSchema.extend({
  sourceRootPath: z.string().min(1),
  normalizedPath: z.string().min(1)
})
export type DocumentDetailItem = z.infer<typeof DocumentDetailItemSchema>

export const GetDocumentsPageRequestSchema = z.object({
  offset: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(100),
  extensionFilter: z.string().max(32).nullable().optional(),
  filenameQuery: z.string().max(200).optional()
})
export type GetDocumentsPageRequest = z.infer<typeof GetDocumentsPageRequestSchema>

export const GetDocumentsPageResponseSchema = z.object({
  items: z.array(DocumentSummaryItemSchema),
  totalCount: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(100)
})
export type GetDocumentsPageResponse = z.infer<typeof GetDocumentsPageResponseSchema>

export const GetDocumentDetailRequestSchema = z.object({
  fileLocationId: z.number().int().positive()
})
export type GetDocumentDetailRequest = z.infer<typeof GetDocumentDetailRequestSchema>

export const GetDocumentDetailResponseSchema = z.object({
  item: DocumentDetailItemSchema.nullable()
})
export type GetDocumentDetailResponse = z.infer<typeof GetDocumentDetailResponseSchema>

export const GetDocumentExtensionFacetsRequestSchema = z.object({
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(100).default(50)
})
export type GetDocumentExtensionFacetsRequest = z.infer<
  typeof GetDocumentExtensionFacetsRequestSchema
>

export const DocumentExtensionFacetItemSchema = z.object({
  extension: z.string(),
  count: z.number().int().nonnegative()
})
export type DocumentExtensionFacetItem = z.infer<typeof DocumentExtensionFacetItemSchema>

export const GetDocumentExtensionFacetsResponseSchema = z.object({
  items: z.array(DocumentExtensionFacetItemSchema),
  totalCount: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(100)
})
export type GetDocumentExtensionFacetsResponse = z.infer<
  typeof GetDocumentExtensionFacetsResponseSchema
>
