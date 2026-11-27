import { z } from 'zod'

export const DocumentExtractionStatusSchema = z.enum([
  'not_extracted',
  'processing',
  'extracted',
  'no_text_ocr_required',
  'password_protected',
  'unsupported',
  'corrupt_or_failed',
  'stale',
  'truncated'
])
export type DocumentExtractionStatus = z.infer<typeof DocumentExtractionStatusSchema>

export const DocumentPreviewStatusSchema = z.enum([
  'not_extracted',
  'ready',
  'no_text_ocr_required',
  'password_protected',
  'unsupported',
  'corrupt_or_failed',
  'stale',
  'truncated'
])
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
  previewStatus: DocumentPreviewStatusSchema,
  extractedCharCount: z.number().int().nonnegative().nullable().optional(),
  pageCount: z.number().int().nonnegative().nullable().optional(),
  extractionTruncated: z.boolean().optional(),
  statusDetail: z.string().max(500).nullable().optional(),
  classification: z.lazy(() => DocumentEffectiveClassificationSummarySchema).optional()
})
export type DocumentSummaryItem = z.infer<typeof DocumentSummaryItemSchema>

export const DocumentDetailItemSchema = DocumentSummaryItemSchema.extend({
  sourceRootPath: z.string().min(1),
  normalizedPath: z.string().min(1),
  recipeVersion: z.string().max(64).nullable().optional(),
  extractedAtMs: z.number().finite().nullable().optional(),
  truncationReason: z.string().max(500).nullable().optional(),
  detectedEncoding: z.string().max(64).nullable().optional()
})
export type DocumentDetailItem = z.infer<typeof DocumentDetailItemSchema>

export const GetDocumentsPageRequestSchema = z.object({
  offset: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(100),
  extensionFilter: z.string().max(32).nullable().optional(),
  filenameQuery: z.string().max(200).optional(),
  purposeFilter: z
    .lazy(() => DocumentPurposeFilterSchema)
    .nullable()
    .optional(),
  originFilter: z
    .lazy(() => DocumentOriginFilterSchema)
    .nullable()
    .optional(),
  clutterFilter: z.lazy(() => DocumentClutterFilterSchema).optional()
})
export type GetDocumentsPageRequest = z.infer<typeof GetDocumentsPageRequestSchema>

export const GetDocumentsPageResponseSchema = z.object({
  items: z.array(DocumentSummaryItemSchema),
  totalCount: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(100),
  hiddenClutterCount: z.number().int().nonnegative().optional()
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

export const GetDocumentPreviewRequestSchema = z.object({
  fileLocationId: z.number().int().positive()
})
export type GetDocumentPreviewRequest = z.infer<typeof GetDocumentPreviewRequestSchema>

export const DocumentPreviewPayloadSchema = z.object({
  fileLocationId: z.number().int().positive(),
  extractionStatus: DocumentExtractionStatusSchema,
  previewStatus: DocumentPreviewStatusSchema,
  extractedText: z.string().nullable(),
  extractedCharCount: z.number().int().nonnegative(),
  previewCharCount: z.number().int().nonnegative(),
  previewTruncated: z.boolean(),
  extractionTruncated: z.boolean(),
  truncationReason: z.string().max(500).nullable(),
  pageCount: z.number().int().nonnegative().nullable(),
  statusDetail: z.string().max(500).nullable(),
  recipeVersion: z.string().max(64).nullable(),
  detectedEncoding: z.string().max(64).nullable(),
  extractedAtMs: z.number().finite().nullable(),
  contentRevision: z.string().max(256).nullable()
})
export type DocumentPreviewPayload = z.infer<typeof DocumentPreviewPayloadSchema>

export const GetDocumentPreviewResponseSchema = z.object({
  preview: DocumentPreviewPayloadSchema.nullable()
})
export type GetDocumentPreviewResponse = z.infer<typeof GetDocumentPreviewResponseSchema>

export const ExtractSelectedDocumentsRequestSchema = z.object({
  fileLocationIds: z.array(z.number().int().positive()).min(1).max(100),
  forceReextract: z.boolean().optional()
})
export type ExtractSelectedDocumentsRequest = z.infer<typeof ExtractSelectedDocumentsRequestSchema>

export const StartDocumentExtractionRequestSchema = z.object({
  scope: z.enum(['all', 'filtered']).default('all'),
  extensionFilter: z.string().max(32).nullable().optional(),
  filenameQuery: z.string().max(200).optional(),
  retryFailed: z.boolean().optional()
})
export type StartDocumentExtractionRequest = z.infer<typeof StartDocumentExtractionRequestSchema>

export const DocumentExtractionCoverageSchema = z.object({
  totalDocuments: z.number().int().nonnegative(),
  notExtractedDocuments: z.number().int().nonnegative(),
  extractedDocuments: z.number().int().nonnegative(),
  noTextDocuments: z.number().int().nonnegative(),
  passwordProtectedDocuments: z.number().int().nonnegative(),
  unsupportedDocuments: z.number().int().nonnegative(),
  failedDocuments: z.number().int().nonnegative(),
  truncatedDocuments: z.number().int().nonnegative(),
  staleDocuments: z.number().int().nonnegative()
})
export type DocumentExtractionCoverageDto = z.infer<typeof DocumentExtractionCoverageSchema>

export const DocumentExtractionProgressSchema = z.object({
  jobId: z.string().nullable(),
  status: z.enum(['idle', 'running', 'paused', 'cancelled', 'interrupted', 'completed', 'failed']),
  scopeKind: z.enum(['selected', 'filtered', 'all']).nullable(),
  recipeVersion: z.string(),
  totalDocuments: z.number().int().nonnegative(),
  processedDocuments: z.number().int().nonnegative(),
  extractedDocuments: z.number().int().nonnegative(),
  noTextDocuments: z.number().int().nonnegative(),
  passwordProtectedDocuments: z.number().int().nonnegative(),
  unsupportedDocuments: z.number().int().nonnegative(),
  failedDocuments: z.number().int().nonnegative(),
  truncatedDocuments: z.number().int().nonnegative(),
  reusedDocuments: z.number().int().nonnegative(),
  pendingDocuments: z.number().int().nonnegative(),
  activeFileLocationId: z.number().int().positive().nullable(),
  startedAtMs: z.number().finite().nullable(),
  updatedAtMs: z.number().finite().nullable(),
  completedAtMs: z.number().finite().nullable(),
  lastError: z.string().nullable(),
  coverage: DocumentExtractionCoverageSchema
})
export type DocumentExtractionProgressDto = z.infer<typeof DocumentExtractionProgressSchema>

// ─── Stage 7C: Offline OCR Contracts & Schemas ───────────────────────────────

export const SUPPORTED_OCR_IMAGE_EXTENSIONS_LIST = [
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.tif',
  '.tiff',
  '.gif',
  '.avif',
  '.heic',
  '.heif'
] as const

export function isSupportedOcrImageExtension(ext: string | null | undefined): boolean {
  if (!ext) return false
  const normalized = ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`
  return (SUPPORTED_OCR_IMAGE_EXTENSIONS_LIST as readonly string[]).includes(normalized)
}

export const OcrModelProvisionStateSchema = z.enum([
  'missing',
  'installing',
  'ready',
  'cancelled',
  'error'
])
export type OcrModelProvisionStateDto = z.infer<typeof OcrModelProvisionStateSchema>

export const OcrModelStatusSchema = z.object({
  state: OcrModelProvisionStateSchema,
  modelId: z.string().min(1),
  modelCommit: z.string().min(1),
  modelManifestSha256: z.string().min(1),
  language: z.string().min(1),
  enginePackage: z.string().min(1),
  requiredBytes: z.number().int().nonnegative(),
  downloadedBytes: z.number().int().nonnegative(),
  currentArtifact: z.string().nullable(),
  verifiedAtMs: z.number().finite().nullable(),
  error: z.string().nullable(),
  lastReplacementError: z.string().nullable()
})
export type OcrModelStatusDto = z.infer<typeof OcrModelStatusSchema>

export const DocumentOcrStatusSchema = z.enum([
  'not_processed',
  'processing',
  'extracted',
  'ocr_no_text',
  'truncated',
  'password_protected',
  'unsupported',
  'corrupt_or_failed',
  'stale'
])
export type DocumentOcrStatusDto = z.infer<typeof DocumentOcrStatusSchema>

export const DocumentOcrPreviewStatusSchema = z.enum([
  'not_processed',
  'processing',
  'ready',
  'no_text',
  'password_protected',
  'unsupported',
  'failed',
  'truncated',
  'stale'
])
export type DocumentOcrPreviewStatusDto = z.infer<typeof DocumentOcrPreviewStatusSchema>

export const DocumentOcrMethodSchema = z.enum([
  'ocr_image_tesseract',
  'ocr_pdf_tesseract',
  'ocr_hybrid_pdf',
  'native_pdf_passthrough',
  'none'
])
export type DocumentOcrMethodDto = z.infer<typeof DocumentOcrMethodSchema>

export const DocumentOcrStateItemSchema = z.object({
  fileLocationId: z.number().int().positive(),
  category: z.enum(['document', 'photo']),
  fileName: z.string().min(1),
  extension: z.string(),
  originalPath: z.string().min(1),
  byteSize: z.number().int().nonnegative(),
  filesystemMtimeMs: z.number().finite().nullable(),
  discoveryObservationId: z.number().int().positive(),
  activeHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/i)
    .nullable(),
  ocrStatus: DocumentOcrStatusSchema,
  previewStatus: DocumentOcrPreviewStatusSchema,
  recipeVersion: z.string().max(64).nullable(),
  ocrModelId: z.string().max(128).nullable(),
  ocrModelManifestSha256: z.string().max(128).nullable(),
  ocrLanguage: z.string().max(32).nullable(),
  extractionMethod: DocumentOcrMethodSchema.nullable(),
  extractedCharCount: z.number().int().nonnegative(),
  pageCount: z.number().int().nonnegative().nullable(),
  ocrPageCount: z.number().int().nonnegative(),
  nativeOnlyPageCount: z.number().int().nonnegative(),
  skippedBlankPageCount: z.number().int().nonnegative(),
  meanConfidence: z.number().finite().nullable(),
  truncated: z.boolean(),
  truncationReason: z.string().max(500).nullable(),
  statusDetail: z.string().max(500).nullable(),
  extractedAtMs: z.number().finite().nullable(),
  contentRevision: z.string().max(256).nullable(),
  contentSha256: z.string().max(128).nullable()
})
export type DocumentOcrStateItemDto = z.infer<typeof DocumentOcrStateItemSchema>

export const DocumentOcrPreviewPayloadSchema = DocumentOcrStateItemSchema.extend({
  extractedText: z.string().nullable(),
  previewCharCount: z.number().int().nonnegative(),
  previewTruncated: z.boolean()
})
export type DocumentOcrPreviewPayloadDto = z.infer<typeof DocumentOcrPreviewPayloadSchema>

export const GetDocumentOcrStateRequestSchema = z.object({
  fileLocationId: z.number().int().positive()
})
export type GetDocumentOcrStateRequest = z.infer<typeof GetDocumentOcrStateRequestSchema>

export const GetDocumentOcrStateResponseSchema = z.object({
  state: DocumentOcrStateItemSchema.nullable()
})
export type GetDocumentOcrStateResponse = z.infer<typeof GetDocumentOcrStateResponseSchema>

export const GetDocumentOcrPreviewRequestSchema = z.object({
  fileLocationId: z.number().int().positive()
})
export type GetDocumentOcrPreviewRequest = z.infer<typeof GetDocumentOcrPreviewRequestSchema>

export const GetDocumentOcrPreviewResponseSchema = z.object({
  preview: DocumentOcrPreviewPayloadSchema.nullable()
})
export type GetDocumentOcrPreviewResponse = z.infer<typeof GetDocumentOcrPreviewResponseSchema>

export const OcrSelectedDocumentsRequestSchema = z.object({
  fileLocationIds: z.array(z.number().int().positive()).min(1).max(100),
  forceReocr: z.boolean().optional()
})
export type OcrSelectedDocumentsRequest = z.infer<typeof OcrSelectedDocumentsRequestSchema>

export const StartDocumentOcrRequestSchema = z.object({
  scope: z.enum(['ocr_needed', 'filtered', 'all']).default('ocr_needed'),
  extensionFilter: z.string().max(32).nullable().optional(),
  filenameQuery: z.string().max(200).optional(),
  retryFailed: z.boolean().optional(),
  forceReocr: z.boolean().optional()
})
export type StartDocumentOcrRequest = z.input<typeof StartDocumentOcrRequestSchema>

export const DocumentOcrCoverageSchema = z.object({
  totalDocuments: z.number().int().nonnegative(),
  ocrNeededDocuments: z.number().int().nonnegative(),
  notProcessedDocuments: z.number().int().nonnegative(),
  extractedDocuments: z.number().int().nonnegative(),
  noTextDocuments: z.number().int().nonnegative(),
  passwordProtectedDocuments: z.number().int().nonnegative(),
  unsupportedDocuments: z.number().int().nonnegative(),
  failedDocuments: z.number().int().nonnegative(),
  truncatedDocuments: z.number().int().nonnegative(),
  staleDocuments: z.number().int().nonnegative(),
  selectedImageOcrCount: z.number().int().nonnegative()
})
export type DocumentOcrCoverageDto = z.infer<typeof DocumentOcrCoverageSchema>

export const DocumentOcrProgressSchema = z.object({
  jobId: z.string().nullable(),
  status: z.enum(['idle', 'running', 'paused', 'cancelled', 'interrupted', 'completed', 'failed']),
  scopeKind: z.enum(['selected', 'ocr_needed', 'filtered', 'all']).nullable(),
  recipeVersion: z.string(),
  ocrModelId: z.string(),
  ocrModelManifestSha256: z.string(),
  ocrLanguage: z.string(),
  totalItems: z.number().int().nonnegative(),
  processedItems: z.number().int().nonnegative(),
  extractedItems: z.number().int().nonnegative(),
  noTextItems: z.number().int().nonnegative(),
  passwordProtectedItems: z.number().int().nonnegative(),
  unsupportedItems: z.number().int().nonnegative(),
  failedItems: z.number().int().nonnegative(),
  truncatedItems: z.number().int().nonnegative(),
  reusedItems: z.number().int().nonnegative(),
  skippedStaleItems: z.number().int().nonnegative(),
  pendingItems: z.number().int().nonnegative(),
  activeFileLocationId: z.number().int().positive().nullable(),
  startedAtMs: z.number().finite().nullable(),
  updatedAtMs: z.number().finite().nullable(),
  completedAtMs: z.number().finite().nullable(),
  lastError: z.string().nullable(),
  coverage: DocumentOcrCoverageSchema,
  coverageReady: z.boolean(),
  coverageRefreshing: z.boolean()
})
export type DocumentOcrProgressDto = z.infer<typeof DocumentOcrProgressSchema>

// ---------------------------------------------------------------------------
// Stage 7D: Document Semantic Model, Indexing & Search Schemas
// ---------------------------------------------------------------------------

export const DocSemanticModelProvisionStateSchema = z.enum([
  'unprovisioned',
  'downloading',
  'importing',
  'verifying',
  'ready',
  'corrupt',
  'error',
  'cancelled'
])

export const DocSemanticModelStatusSchema = z.object({
  state: DocSemanticModelProvisionStateSchema,
  modelId: z.string(),
  modelCommit: z.string(),
  manifestSha256: z.string(),
  totalBytes: z.number().int().nonnegative(),
  downloadedBytes: z.number().int().nonnegative(),
  currentFile: z.string().nullable(),
  installDir: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  updatedAtMs: z.number().finite()
})
export type DocSemanticModelStatusDto = z.infer<typeof DocSemanticModelStatusSchema>

export const DocSemanticCoverageSchema = z.object({
  totalExtractableTracks: z.number().int().nonnegative(),
  totalDocumentsWithText: z.number().int().nonnegative(),
  indexedTracks: z.number().int().nonnegative(),
  truncatedTracks: z.number().int().nonnegative(),
  emptyTextTracks: z.number().int().nonnegative(),
  failedTracks: z.number().int().nonnegative(),
  unindexedTracks: z.number().int().nonnegative(),
  staleTracks: z.number().int().nonnegative(),
  corruptChunks: z.number().int().nonnegative(),
  indexedDocuments: z.number().int().nonnegative()
})
export type DocSemanticCoverageDto = z.infer<typeof DocSemanticCoverageSchema>

export const DocSemanticProgressSchema = z.object({
  jobId: z.string().nullable(),
  status: z.enum(['idle', 'running', 'paused', 'cancelled', 'interrupted', 'completed', 'failed']),
  scopeKind: z.enum(['selected', 'unindexed_or_stale', 'filtered', 'all']).nullable(),
  docModelId: z.string(),
  docModelCommit: z.string(),
  docModelManifestSha256: z.string(),
  chunkingRecipeVersion: z.string(),
  totalItems: z.number().int().nonnegative(),
  processedItems: z.number().int().nonnegative(),
  indexedItems: z.number().int().nonnegative(),
  truncatedItems: z.number().int().nonnegative(),
  emptyTextItems: z.number().int().nonnegative(),
  failedItems: z.number().int().nonnegative(),
  reusedItems: z.number().int().nonnegative(),
  skippedStaleItems: z.number().int().nonnegative(),
  pendingItems: z.number().int().nonnegative(),
  activeFileLocationId: z.number().int().positive().nullable(),
  activeTextSourceKind: z.enum(['native', 'ocr']).nullable(),
  startedAtMs: z.number().finite().nullable(),
  updatedAtMs: z.number().finite().nullable(),
  completedAtMs: z.number().finite().nullable(),
  lastError: z.string().nullable(),
  coverage: DocSemanticCoverageSchema,
  coverageReady: z.boolean(),
  coverageRefreshing: z.boolean()
})
export type DocumentSemanticProgressDto = z.infer<typeof DocSemanticProgressSchema>

export const IndexSelectedDocumentsRequestSchema = z.object({
  fileLocationIds: z.array(z.number().int().positive()).min(1).max(100),
  forceReindex: z.boolean().optional()
})
export type IndexSelectedDocumentsRequest = z.infer<typeof IndexSelectedDocumentsRequestSchema>

export const StartDocSemanticIndexRequestSchema = z.object({
  scope: z.enum(['unindexed_or_stale', 'filtered', 'all']).default('unindexed_or_stale'),
  extensionFilter: z.string().max(32).nullable().optional(),
  filenameQuery: z.string().max(200).optional(),
  retryFailed: z.boolean().optional(),
  forceReindex: z.boolean().optional()
})
export type StartDocSemanticIndexRequest = z.input<typeof StartDocSemanticIndexRequestSchema>

export const DocSemanticSearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(500),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().nonnegative().default(0),
  extensionFilter: z.string().max(32).nullable().optional(),
  filenameQuery: z.string().max(200).optional(),
  textSourceKindFilter: z.enum(['native', 'ocr']).nullable().optional(),
  purposeFilter: z
    .lazy(() => DocumentPurposeFilterSchema)
    .nullable()
    .optional(),
  originFilter: z
    .lazy(() => DocumentOriginFilterSchema)
    .nullable()
    .optional(),
  clutterFilter: z.lazy(() => DocumentClutterFilterSchema).optional(),
  ownerGen: z.number().int().nonnegative().optional()
})
export type DocSemanticSearchRequest = z.input<typeof DocSemanticSearchRequestSchema>

export const HydratedDocSearchItemSchema = z.object({
  fileLocationId: z.number().int().positive(),
  score: z.number().finite(),
  winningChunkId: z.number().int().positive(),
  winningChunkIndex: z.number().int().nonnegative(),
  textSourceKind: z.enum(['native', 'ocr']),
  charOffsetStart: z.number().int().nonnegative(),
  charOffsetEnd: z.number().int().nonnegative(),
  truncated: z.boolean(),
  normalizedCharCount: z.number().int().nonnegative(),
  indexedCharCount: z.number().int().nonnegative(),
  coverageRatio: z.number().finite().min(0).max(1),
  originalPath: z.string(),
  fileName: z.string(),
  extension: z.string(),
  winningSnippet: z.string()
})
export type HydratedDocSearchItemDto = z.infer<typeof HydratedDocSearchItemSchema>

export const DocSemanticSearchResponseSchema = z.object({
  items: z.array(HydratedDocSearchItemSchema),
  totalMatched: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  eligibleChunkCount: z.number().int().nonnegative(),
  corruptChunkCount: z.number().int().nonnegative(),
  queryTokenCount: z.number().int().nonnegative(),
  queryTruncated: z.boolean(),
  queryLatencyMs: z.number().finite().nonnegative(),
  coverage: DocSemanticCoverageSchema,
  clutterFilterActive: z.boolean().optional()
})
export type DocSemanticSearchResponseDto = z.infer<typeof DocSemanticSearchResponseSchema>

export const DocSemanticSearchCancelRequestSchema = z
  .object({
    ownerGen: z.number().int().nonnegative().optional()
  })
  .strict()
export type DocSemanticSearchCancelRequest = z.input<typeof DocSemanticSearchCancelRequestSchema>

export const DocSemanticSearchCancelResponseSchema = z.object({
  cancelled: z.boolean()
})
export type DocSemanticSearchCancelResponseDto = z.infer<
  typeof DocSemanticSearchCancelResponseSchema
>

// ─── Stage 7E: Document Classification & Conservative Clutter Filtering ──────

export const DocumentPurposeLabelSchema = z.enum([
  'legal',
  'lists',
  'instructions',
  'receipts',
  'recipes'
])
export type DocumentPurposeLabel = z.infer<typeof DocumentPurposeLabelSchema>

export const DocumentOriginLabelSchema = z.enum([
  'personal',
  'software_project',
  'application_system'
])
export type DocumentOriginLabel = z.infer<typeof DocumentOriginLabelSchema>

export const DocumentPurposeStatusSchema = z.enum(['classified', 'other', 'unknown'])
export type DocumentPurposeStatus = z.infer<typeof DocumentPurposeStatusSchema>

export const DocumentOriginStatusSchema = z.enum(['classified', 'unknown'])
export type DocumentOriginStatus = z.infer<typeof DocumentOriginStatusSchema>

export const ClassificationConfidenceBandSchema = z.enum(['high', 'medium', 'low'])
export type ClassificationConfidenceBand = z.infer<typeof ClassificationConfidenceBandSchema>

export const UncertaintyReasonSchema = z.enum([
  'no_extracted_text',
  'insufficient_text_length',
  'truncated_input',
  'upstream_truncated_input',
  'unclosed_code_fence',
  'ocr_low_confidence',
  'ocr_confidence_missing',
  'overlapping_origin_signals',
  'single_weak_signal_abstained'
])
export type UncertaintyReason = z.infer<typeof UncertaintyReasonSchema>

export const DocumentClassificationRangeSchema = z.object({
  startChar: z.number().int().nonnegative(),
  endChar: z.number().int().nonnegative()
})
export type DocumentClassificationRange = z.infer<typeof DocumentClassificationRangeSchema>

export const DocumentClassificationEvidenceSchema = z.object({
  axis: z.enum(['purpose', 'origin']),
  targetLabel: z.union([DocumentPurposeLabelSchema, DocumentOriginLabelSchema]),
  family: z.string().min(1).max(120),
  ruleId: z.string().min(1).max(120),
  weight: z.number().finite().positive(),
  summary: z.string().min(1).max(300)
})
export type DocumentClassificationEvidence = z.infer<typeof DocumentClassificationEvidenceSchema>

export const DocumentClutterOverrideSchema = z.enum(['inherit', 'force_keep', 'force_clutter'])
export type DocumentClutterOverride = z.infer<typeof DocumentClutterOverrideSchema>

export const DocumentClassificationTextSourceSchema = z.enum(['native', 'ocr', 'none'])
export type DocumentClassificationTextSource = z.infer<
  typeof DocumentClassificationTextSourceSchema
>

export const DocumentClassificationInputSchema = z.object({
  fileLocationId: z.number().int().positive().optional(),
  fileName: z.string().min(1).max(512),
  extension: z.string().max(32),
  relativePath: z.string().max(4096),
  byteSize: z.number().int().nonnegative().optional(),
  extractionStatus: DocumentExtractionStatusSchema.optional(),
  textSourceKind: DocumentClassificationTextSourceSchema,
  ocrMeanConfidence: z.number().finite().min(0).max(100).nullable().optional(),
  nativeTruncated: z.boolean().optional(),
  ocrTruncated: z.boolean().optional(),
  text: z.string().max(500_000).nullable().optional()
})
export type DocumentClassificationInput = z.infer<typeof DocumentClassificationInputSchema>

export const DocumentClassificationResultSchema = z.object({
  classifierKind: z.literal('deterministic_rules'),
  ruleVersion: z.literal('doc_classify_rules_v1'),
  textSourceKind: DocumentClassificationTextSourceSchema,
  purposeLabels: z.array(DocumentPurposeLabelSchema),
  purposeStatus: DocumentPurposeStatusSchema,
  originLabels: z.array(DocumentOriginLabelSchema),
  originStatus: DocumentOriginStatusSchema,
  confidenceBand: ClassificationConfidenceBandSchema,
  uncertaintyReason: UncertaintyReasonSchema.nullable(),
  uncertaintyReasons: z.array(UncertaintyReasonSchema),
  totalNormalizedChars: z.number().int().nonnegative(),
  inspectedHeadChars: z.number().int().nonnegative(),
  inspectedTailChars: z.number().int().nonnegative(),
  omittedChars: z.number().int().nonnegative(),
  headRange: DocumentClassificationRangeSchema,
  omittedRange: DocumentClassificationRangeSchema.nullable(),
  tailRange: DocumentClassificationRangeSchema.nullable(),
  tailEnteredInsideFence: z.boolean(),
  unclosedFenceAtEof: z.boolean(),
  fenceCount: z.number().int().nonnegative(),
  fencedLineCount: z.number().int().nonnegative(),
  fenceLanguages: z.array(z.string().max(64)),
  isClutterCandidate: z.boolean(),
  hasPersonalVeto: z.boolean(),
  evidence: z.array(DocumentClassificationEvidenceSchema)
})
export type DocumentClassificationResult = z.infer<typeof DocumentClassificationResultSchema>

// ─── Stage 7E Slice 3: Classification IPC, Facets, Filter & Override Schemas ─

export const DocumentClutterFilterSchema = z.enum(['show_all', 'hide_clutter', 'only_clutter'])
export type DocumentClutterFilter = z.infer<typeof DocumentClutterFilterSchema>

export const DocumentPurposeFilterSchema = z.enum([
  'legal',
  'lists',
  'instructions',
  'receipts',
  'recipes',
  'other',
  'unknown'
])
export type DocumentPurposeFilter = z.infer<typeof DocumentPurposeFilterSchema>

export const DocumentOriginFilterSchema = z.enum([
  'personal',
  'software_project',
  'application_system',
  'unknown'
])
export type DocumentOriginFilter = z.infer<typeof DocumentOriginFilterSchema>

export const DocumentEffectiveClassificationSummarySchema = z.object({
  isClassified: z.boolean(),
  isStale: z.boolean(),
  machineRuleVersion: z.string().max(64).nullable(),
  machineTextSourceKind: DocumentClassificationTextSourceSchema.nullable(),
  machinePurposeStatus: DocumentPurposeStatusSchema,
  machineOriginStatus: DocumentOriginStatusSchema,
  machinePurposeLabels: z.array(DocumentPurposeLabelSchema),
  machineOriginLabels: z.array(DocumentOriginLabelSchema),
  confidenceBand: ClassificationConfidenceBandSchema,
  uncertaintyReason: UncertaintyReasonSchema.nullable(),
  uncertaintyReasons: z.array(UncertaintyReasonSchema),
  isClutterCandidate: z.boolean(),
  hasPersonalVeto: z.boolean(),
  effectivePurposeStatus: DocumentPurposeStatusSchema,
  effectiveOriginStatus: DocumentOriginStatusSchema,
  effectivePurposeLabels: z.array(DocumentPurposeLabelSchema),
  effectiveOriginLabels: z.array(DocumentOriginLabelSchema),
  effectiveIsClutter: z.boolean(),
  hasOverride: z.boolean(),
  hasStaleOverride: z.boolean(),
  hasUnverifiedOverride: z.boolean(),
  clutterOverride: DocumentClutterOverrideSchema,
  overrideVersion: z.number().int().nonnegative(),
  contentRevision: z.string().max(256),
  evidence: z.array(DocumentClassificationEvidenceSchema).optional()
})
export type DocumentEffectiveClassificationSummary = z.infer<
  typeof DocumentEffectiveClassificationSummarySchema
>

export const DocClassificationCoverageSchema = z.object({
  totalDocuments: z.number().int().nonnegative(),
  classifiedDocuments: z.number().int().nonnegative(),
  otherDocuments: z.number().int().nonnegative(),
  unknownDocuments: z.number().int().nonnegative(),
  unclassifiedDocuments: z.number().int().nonnegative(),
  staleDocuments: z.number().int().nonnegative(),
  hiddenClutterCount: z.number().int().nonnegative(),
  overriddenDocuments: z.number().int().nonnegative()
})
export type DocClassificationCoverageDto = z.infer<typeof DocClassificationCoverageSchema>

export const DocClassificationJobStatusSchema = z.enum([
  'idle',
  'running',
  'paused',
  'completed',
  'cancelled',
  'interrupted',
  'failed'
])

export const DocClassificationScopeKindSchema = z.enum([
  'all',
  'unclassified_or_stale',
  'filtered',
  'selected'
])

export const DocumentClassificationProgressSchema = z.object({
  jobId: z.string().nullable(),
  status: DocClassificationJobStatusSchema,
  scopeKind: DocClassificationScopeKindSchema.nullable(),
  ruleVersion: z.string().max(64),
  totalItems: z.number().int().nonnegative(),
  processedItems: z.number().int().nonnegative(),
  classifiedItems: z.number().int().nonnegative(),
  otherItems: z.number().int().nonnegative(),
  unknownItems: z.number().int().nonnegative(),
  clutterItems: z.number().int().nonnegative(),
  reusedItems: z.number().int().nonnegative(),
  skippedStaleItems: z.number().int().nonnegative(),
  failedItems: z.number().int().nonnegative(),
  pendingItems: z.number().int().nonnegative(),
  activeFileLocationId: z.number().int().positive().nullable(),
  startedAtMs: z.number().finite().nullable(),
  updatedAtMs: z.number().finite().nullable(),
  completedAtMs: z.number().finite().nullable(),
  lastError: z.string().max(2048).nullable(),
  coverage: DocClassificationCoverageSchema,
  coverageReady: z.boolean(),
  coverageRefreshing: z.boolean()
})
export type DocumentClassificationProgressDto = z.infer<typeof DocumentClassificationProgressSchema>

export const ClassifySelectedDocumentsRequestSchema = z.object({
  fileLocationIds: z.array(z.number().int().positive()).min(1).max(100),
  forceReclassify: z.boolean().optional()
})
export type ClassifySelectedDocumentsRequest = z.infer<
  typeof ClassifySelectedDocumentsRequestSchema
>

export const StartDocumentClassificationRequestSchema = z.object({
  scope: z.enum(['unclassified_or_stale', 'filtered', 'all']).default('unclassified_or_stale'),
  extensionFilter: z.string().max(32).nullable().optional(),
  filenameQuery: z.string().max(200).optional(),
  forceReclassify: z.boolean().optional()
})
export type StartDocumentClassificationRequest = z.input<
  typeof StartDocumentClassificationRequestSchema
>

export const SetDocumentClassificationOverrideRequestSchema = z.object({
  fileLocationId: z.number().int().positive(),
  expectedRevision: z.string().min(1).max(256),
  expectedOverrideVersion: z.number().int().nonnegative(),
  purposeLabels: z.array(DocumentPurposeLabelSchema).nullable(),
  originLabels: z.array(DocumentOriginLabelSchema).nullable(),
  clutterOverride: DocumentClutterOverrideSchema
})
export type SetDocumentClassificationOverrideRequest = z.infer<
  typeof SetDocumentClassificationOverrideRequestSchema
>

export const ResetDocumentClassificationOverrideRequestSchema = z.object({
  fileLocationId: z.number().int().positive(),
  expectedRevision: z.string().min(1).max(256),
  expectedOverrideVersion: z.number().int().nonnegative()
})
export type ResetDocumentClassificationOverrideRequest = z.infer<
  typeof ResetDocumentClassificationOverrideRequestSchema
>

export const DocumentClassificationOverrideAckSchema = z.object({
  ok: z.boolean(),
  conflict: z.enum(['STALE_REVISION', 'STALE_OVERRIDE_VERSION', 'NOT_FOUND']).optional(),
  errorMessage: z.string().max(1024).optional(),
  persistencePending: z.boolean(),
  persistenceError: z.string().max(1024).optional(),
  effectiveClassification: DocumentEffectiveClassificationSummarySchema.nullable()
})
export type DocumentClassificationOverrideAckDto = z.infer<
  typeof DocumentClassificationOverrideAckSchema
>

export const GetDocumentClassificationFacetsRequestSchema = z.object({
  extensionFilter: z.string().max(32).nullable().optional(),
  filenameQuery: z.string().max(200).optional()
})
export type GetDocumentClassificationFacetsRequest = z.infer<
  typeof GetDocumentClassificationFacetsRequestSchema
>

export const GetDocumentClassificationFacetsResponseSchema = z.object({
  purposeCounts: z.object({
    legal: z.number().int().nonnegative(),
    lists: z.number().int().nonnegative(),
    instructions: z.number().int().nonnegative(),
    receipts: z.number().int().nonnegative(),
    recipes: z.number().int().nonnegative(),
    other: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative()
  }),
  originCounts: z.object({
    personal: z.number().int().nonnegative(),
    software_project: z.number().int().nonnegative(),
    application_system: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative()
  }),
  clutterCount: z.number().int().nonnegative(),
  totalDocuments: z.number().int().nonnegative(),
  overriddenCount: z.number().int().nonnegative()
})
export type GetDocumentClassificationFacetsResponseDto = z.infer<
  typeof GetDocumentClassificationFacetsResponseSchema
>
