/**
 * Personal Vault — Stage 8A Selective Export & Portable Bundle Schemas
 */

import { z } from 'zod'

export const Sha256HexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/i, 'Must be a 64-character hexadecimal SHA-256 digest')

export const SingleSegmentNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (name) =>
      !name.includes('/') &&
      !name.includes('\\') &&
      name !== '.' &&
      name !== '..' &&
      !name.includes('\0'),
    'Must be a single path segment without separators or traversal'
  )

export const ExportPrivacyOptionsSchema = z
  .object({
    includeOriginalPaths: z.boolean().default(false),
    includeExtractedText: z.boolean().default(false)
  })
  .strict()
export type ExportPrivacyOptions = z.infer<typeof ExportPrivacyOptionsSchema>

export const ExportByteSourceUsedSchema = z.enum([
  'vault_copy',
  'source_file',
  'source_fallback_after_vault_warning'
])
export type ExportByteSourceUsed = z.infer<typeof ExportByteSourceUsedSchema>

export const ExportVaultIntegrityWarningSchema = z.enum([
  'vault_copy_missing',
  'vault_copy_hash_mismatch'
])
export type ExportVaultIntegrityWarning = z.infer<typeof ExportVaultIntegrityWarningSchema>

export const ExportErrorCodeSchema = z.enum([
  'source_missing',
  'source_changed',
  'source_hash_mismatch',
  'source_not_regular_file',
  'source_outside_approved_roots',
  'vault_copy_missing',
  'vault_copy_hash_mismatch',
  'vault_and_source_unavailable',
  'destination_collision',
  'destination_disk_full',
  'destination_read_only',
  'destination_access_denied',
  'destination_write_failed',
  'sidecar_publish_failed',
  'manifest_write_failed',
  'cancelled'
])
export type ExportErrorCode = z.infer<typeof ExportErrorCodeSchema>

export const ExportSidecarAuditSchema = z
  .object({
    exportJobId: z.string().min(1),
    exportedAtMs: z.number().int().positive(),
    appVersion: z.string().min(1),
    exportedFileName: SingleSegmentNameSchema,
    verifiedSha256: Sha256HexSchema,
    verifiedByteSize: z.number().int().nonnegative(),
    byteSourceUsed: ExportByteSourceUsedSchema,
    vaultIntegrityWarning: ExportVaultIntegrityWarningSchema.nullable(),
    privacyPolicyApplied: ExportPrivacyOptionsSchema
  })
  .strict()

export const ExportSidecarRecordedFactsSchema = z
  .object({
    originalFileName: z.string().min(1),
    recordedExtension: z.string(),
    category: z.enum(['photo', 'document']),
    byteSize: z.number().int().nonnegative(),
    sha256: Sha256HexSchema,
    filesystemBirthtimeMs: z.number().finite().nullable(),
    filesystemMtimeMs: z.number().finite().nullable(),
    firstDiscoveredAtMs: z.number().finite().positive(),
    lastSeenAtMs: z.number().finite().positive(),
    discoveryObservationId: z.number().int().positive(),
    hashObservationId: z.number().int().positive(),
    hashVerifiedAtMs: z.number().finite().positive(),
    originalSourcePath: z.string().min(1).nullable()
  })
  .strict()

export const ExportInferredCaptureDateSchema = z
  .object({
    sourceTag: z.enum(['DateTimeOriginal', 'DateTimeDigitized']).nullable(),
    rawText: z.string().nullable(),
    localIso: z.string().nullable(),
    calendarDate: z.string().nullable(),
    utcEpochMs: z.number().int().nullable(),
    offsetText: z.string().nullable(),
    timezoneStatus: z.enum([
      'offset_present',
      'local_wall_clock_unknown_tz',
      'invalid_offset',
      'unknown'
    ])
  })
  .strict()

export const ExportGpsLocationSchema = z
  .object({
    status: z.enum(['not_extracted', 'omitted_by_policy']),
    coordinates: z.null()
  })
  .strict()

export const ExportPhotoMachineGeneratedSchema = z
  .object({
    kind: z.literal('photo'),
    metadataStatus: z.enum(['unprocessed', 'extracted', 'no_metadata', 'unsupported', 'failed']),
    parserRecipeVersion: z.string().nullable(),
    detectedFormat: z.string().nullable(),
    extensionFormatMismatch: z.boolean(),
    encodedWidthPx: z.number().int().positive().nullable(),
    encodedHeightPx: z.number().int().positive().nullable(),
    exifOrientation: z.number().int().min(1).max(8).nullable(),
    displayWidthPx: z.number().int().positive().nullable(),
    displayHeightPx: z.number().int().positive().nullable(),
    inferredCaptureDate: ExportInferredCaptureDateSchema.nullable(),
    cameraDisplay: z.string().nullable(),
    lensDisplay: z.string().nullable(),
    gpsLocation: ExportGpsLocationSchema,
    dhash64: z.string().nullable()
  })
  .strict()

export const ExportDocNativeExtractionSchema = z
  .object({
    status: z.string(),
    recipeVersion: z.string().nullable(),
    pageCount: z.number().int().nonnegative().nullable(),
    charCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
    text: z.string().nullable()
  })
  .strict()

export const ExportDocOcrExtractionSchema = z
  .object({
    status: z.string(),
    method: z.string().nullable(),
    modelId: z.string().nullable(),
    language: z.string().nullable(),
    meanConfidence: z.number().finite().nullable(),
    truncated: z.boolean(),
    text: z.string().nullable()
  })
  .strict()

export const ExportDocAutoClassificationSchema = z
  .object({
    ruleVersion: z.string(),
    textSourceKind: z.enum(['native', 'ocr', 'none']),
    purposeStatus: z.enum(['classified', 'other', 'unknown']),
    purposeLabels: z.array(z.string()),
    originStatus: z.enum(['classified', 'unknown']),
    originLabels: z.array(z.string()),
    confidenceBand: z.enum(['high', 'medium', 'low']),
    isClutterCandidate: z.boolean(),
    uncertaintyReasons: z.array(z.string())
  })
  .strict()

export const ExportDocumentMachineGeneratedSchema = z
  .object({
    kind: z.literal('document'),
    nativeExtraction: ExportDocNativeExtractionSchema,
    ocrExtraction: ExportDocOcrExtractionSchema,
    automaticClassification: ExportDocAutoClassificationSchema.nullable()
  })
  .strict()

export const ExportDuplicateReviewSummarySchema = z
  .object({
    status: z.enum(['reviewed', 'unreviewed']),
    isPreferredLocation: z.boolean()
  })
  .strict()

export const ExportPhotoUserAnnotationsSchema = z
  .object({
    kind: z.literal('photo'),
    rating: z.number().int().min(1).max(5).nullable(),
    flag: z.enum(['none', 'pick', 'reject']),
    collections: z.array(z.string()),
    duplicateReview: ExportDuplicateReviewSummarySchema.nullable()
  })
  .strict()

export const ExportDocumentUserOverridesSchema = z
  .object({
    kind: z.literal('document'),
    classificationOverride: z
      .object({
        purposeLabels: z.array(z.string()).nullable(),
        originLabels: z.array(z.string()).nullable(),
        clutterOverride: z.enum(['inherit', 'force_keep', 'force_clutter']),
        overrideVersion: z.number().int().positive(),
        updatedAtMs: z.number().int().positive()
      })
      .strict()
      .nullable(),
    effectiveClassification: z
      .object({
        purposeLabels: z.array(z.string()),
        originLabels: z.array(z.string()),
        isClutter: z.boolean(),
        resolvedFrom: z.enum(['user_override', 'automatic_classifier', 'unclassified'])
      })
      .strict(),
    duplicateReview: ExportDuplicateReviewSummarySchema.nullable()
  })
  .strict()

export const ExportSidecarV1Schema = z
  .object({
    formatVersion: z.literal(1),
    schema: z.literal('pv_export_sidecar_v1'),
    exportAudit: ExportSidecarAuditSchema,
    recordedFacts: ExportSidecarRecordedFactsSchema,
    machineGenerated: z.discriminatedUnion('kind', [
      ExportPhotoMachineGeneratedSchema,
      ExportDocumentMachineGeneratedSchema
    ]),
    userOverridesAndAnnotations: z.discriminatedUnion('kind', [
      ExportPhotoUserAnnotationsSchema,
      ExportDocumentUserOverridesSchema
    ])
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.exportAudit.verifiedSha256.toLowerCase() !== val.recordedFacts.sha256.toLowerCase()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'exportAudit.verifiedSha256 must match recordedFacts.sha256'
      })
    }
    if (val.exportAudit.verifiedByteSize !== val.recordedFacts.byteSize) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'exportAudit.verifiedByteSize must match recordedFacts.byteSize'
      })
    }
    if (!val.exportAudit.privacyPolicyApplied.includeOriginalPaths) {
      if (val.recordedFacts.originalSourcePath !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'originalSourcePath must be null when includeOriginalPaths is false'
        })
      }
    }
    if (!val.exportAudit.privacyPolicyApplied.includeExtractedText) {
      if (val.machineGenerated.kind === 'document') {
        if (
          val.machineGenerated.nativeExtraction.text !== null ||
          val.machineGenerated.ocrExtraction.text !== null
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Extracted/OCR text must be null when includeExtractedText is false'
          })
        }
      }
    }
    if (val.recordedFacts.category !== val.machineGenerated.kind) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'recordedFacts.category must match machineGenerated.kind'
      })
    }
    if (val.recordedFacts.category !== val.userOverridesAndAnnotations.kind) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'recordedFacts.category must match userOverridesAndAnnotations.kind'
      })
    }
  })

export type ExportSidecarV1 = z.infer<typeof ExportSidecarV1Schema>

export const ExportManifestCompletedItemSchema = z
  .object({
    fileLocationId: z.number().int().positive(),
    category: z.enum(['photo', 'document']),
    originalFileName: z.string().min(1),
    exportedFileName: SingleSegmentNameSchema,
    sidecarFileName: SingleSegmentNameSchema,
    verifiedSha256: Sha256HexSchema,
    verifiedByteSize: z.number().int().nonnegative(),
    byteSourceUsed: ExportByteSourceUsedSchema,
    vaultIntegrityWarning: ExportVaultIntegrityWarningSchema.nullable(),
    status: z.literal('completed'),
    originalSourcePath: z.string().min(1).nullable()
  })
  .strict()

export const ExportManifestFailedItemSchema = z
  .object({
    fileLocationId: z.number().int().positive(),
    category: z.enum(['photo', 'document']),
    originalFileName: z.string().min(1),
    expectedSha256: Sha256HexSchema,
    expectedByteSize: z.number().int().nonnegative(),
    status: z.enum(['failed', 'cancelled']),
    errorCode: ExportErrorCodeSchema,
    errorMessage: z.string().min(1),
    vaultIntegrityWarning: ExportVaultIntegrityWarningSchema.nullable(),
    exportedFileName: z.null(),
    sidecarFileName: z.null(),
    originalSourcePath: z.null()
  })
  .strict()

export const ExportBundleManifestV1Schema = z
  .object({
    formatVersion: z.literal(1),
    schema: z.literal('pv_export_bundle_v1'),
    exportJobId: z.string().min(1),
    status: z.enum(['completed', 'cancelled', 'failed']),
    createdAtMs: z.number().int().positive(),
    completedAtMs: z.number().int().positive(),
    appVersion: z.string().min(1),
    privacyPolicy: z
      .object({
        includeOriginalPaths: z.boolean(),
        includeExtractedText: z.boolean(),
        gpsPolicy: z.literal('not_extracted'),
        embeddedMetadataNotice: z.string().min(1)
      })
      .strict(),
    counts: z
      .object({
        totalItems: z.number().int().nonnegative(),
        exportedItems: z.number().int().nonnegative(),
        failedItems: z.number().int().nonnegative(),
        cancelledItems: z.number().int().nonnegative(),
        vaultIntegrityWarnings: z.number().int().nonnegative()
      })
      .strict(),
    items: z.array(z.union([ExportManifestCompletedItemSchema, ExportManifestFailedItemSchema]))
  })
  .strict()

export type ExportBundleManifestV1 = z.infer<typeof ExportBundleManifestV1Schema>

export const ExportCompletionMarkerSchema = z
  .object({
    formatVersion: z.literal(1),
    schema: z.literal('pv_export_complete_v1'),
    exportJobId: z.string().min(1),
    manifestSha256: Sha256HexSchema,
    completedAtMs: z.number().int().positive(),
    status: z.enum(['completed', 'cancelled', 'failed'])
  })
  .strict()

export type ExportCompletionMarker = z.infer<typeof ExportCompletionMarkerSchema>

// ─── Stage 8A Slice 3: IPC Request & Response Schemas ─────────────────────────

export const ExportJobStatusSchema = z.enum([
  'running',
  'completed',
  'cancelled',
  'interrupted',
  'failed'
])

export const ExportJobItemStatusSchema = z.enum([
  'pending',
  'completed',
  'failed',
  'cancelled',
  'interrupted'
])

export const ExportBundleIncompleteReasonSchema = z.enum([
  'bundle_dir_missing',
  'in_progress_marker_present',
  'temp_dir_present',
  'completion_marker_missing',
  'completion_marker_invalid',
  'manifest_missing',
  'manifest_invalid',
  'manifest_hash_mismatch',
  'orphaned_file_without_sidecar',
  'missing_pair_file'
])

export const ExportSelectDestinationResponseSchema = z
  .object({
    canceled: z.boolean(),
    directoryPath: z.string().min(1).nullable()
  })
  .strict()
export type ExportSelectDestinationResponse = z.infer<typeof ExportSelectDestinationResponseSchema>

export const ExportStartRequestSchema = z
  .object({
    parentDir: z.string().min(1),
    bundleFolderName: SingleSegmentNameSchema,
    fileLocationIds: z.array(z.number().int().positive()).min(1).max(10_000),
    privacyOptions: ExportPrivacyOptionsSchema.optional()
  })
  .strict()
export type ExportStartRequest = z.infer<typeof ExportStartRequestSchema>

export const ExportCancelRequestSchema = z
  .object({
    jobId: z.string().min(1)
  })
  .strict()
export type ExportCancelRequest = z.infer<typeof ExportCancelRequestSchema>

export const ExportCancelResponseSchema = z
  .object({
    cancelled: z.boolean(),
    jobId: z.string().min(1)
  })
  .strict()
export type ExportCancelResponse = z.infer<typeof ExportCancelResponseSchema>

export const ExportListJobsRequestSchema = z
  .object({
    limit: z.number().int().min(1).max(500).optional(),
    offset: z.number().int().min(0).optional(),
    status: ExportJobStatusSchema.optional()
  })
  .strict()
export type ExportListJobsRequest = z.infer<typeof ExportListJobsRequestSchema>

export const ExportGetJobRequestSchema = z
  .object({
    jobId: z.string().min(1)
  })
  .strict()
export type ExportGetJobRequest = z.infer<typeof ExportGetJobRequestSchema>

export const ExportGetJobItemsRequestSchema = z
  .object({
    jobId: z.string().min(1),
    limit: z.number().int().min(1).max(500).optional(),
    offset: z.number().int().min(0).optional(),
    status: ExportJobItemStatusSchema.optional()
  })
  .strict()
export type ExportGetJobItemsRequest = z.infer<typeof ExportGetJobItemsRequestSchema>

export const ExportVerifyJobRequestSchema = z
  .object({
    jobId: z.string().min(1)
  })
  .strict()
export type ExportVerifyJobRequest = z.infer<typeof ExportVerifyJobRequestSchema>

export const ExportJobRecordSchema = z
  .object({
    id: z.string().min(1),
    bundleDir: z.string().min(1),
    bundleFolderName: SingleSegmentNameSchema,
    status: ExportJobStatusSchema,
    privacyOptions: ExportPrivacyOptionsSchema,
    manifestPublished: z.boolean(),
    bundleVerified: z.boolean(),
    incompleteReasons: z.array(ExportBundleIncompleteReasonSchema),
    totalItems: z.number().int().nonnegative(),
    exportedItems: z.number().int().nonnegative(),
    failedItems: z.number().int().nonnegative(),
    cancelledItems: z.number().int().nonnegative(),
    vaultIntegrityWarnings: z.number().int().nonnegative(),
    errorCode: ExportErrorCodeSchema.nullable(),
    errorMessage: z.string().nullable(),
    startedAtMs: z.number().int().nonnegative(),
    updatedAtMs: z.number().int().nonnegative(),
    completedAtMs: z.number().int().nonnegative().nullable()
  })
  .strict()
export type ExportJobRecordDto = z.infer<typeof ExportJobRecordSchema>

export const ExportJobItemRecordSchema = z
  .object({
    jobId: z.string().min(1),
    fileLocationId: z.number().int().positive(),
    discoveryObservationId: z.number().int().positive(),
    hashObservationId: z.number().int().positive(),
    category: z.enum(['photo', 'document']),
    originalFileName: z.string().min(1),
    expectedSha256: Sha256HexSchema,
    expectedByteSize: z.number().int().nonnegative(),
    status: ExportJobItemStatusSchema,
    exportedFileName: z.string().min(1).nullable(),
    sidecarFileName: z.string().min(1).nullable(),
    byteSourceUsed: ExportByteSourceUsedSchema.nullable(),
    vaultIntegrityWarning: ExportVaultIntegrityWarningSchema.nullable(),
    errorCode: ExportErrorCodeSchema.nullable(),
    errorMessage: z.string().nullable(),
    updatedAtMs: z.number().int().nonnegative()
  })
  .strict()
export type ExportJobItemRecordDto = z.infer<typeof ExportJobItemRecordSchema>

export const ExportJobListResponseSchema = z
  .object({
    items: z.array(ExportJobRecordSchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int().min(1).max(500),
    offset: z.number().int().nonnegative()
  })
  .strict()
export type ExportJobListResponse = z.infer<typeof ExportJobListResponseSchema>

export const ExportJobItemsResponseSchema = z
  .object({
    items: z.array(ExportJobItemRecordSchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int().min(1).max(500),
    offset: z.number().int().nonnegative()
  })
  .strict()
export type ExportJobItemsResponse = z.infer<typeof ExportJobItemsResponseSchema>

export const ExportProgressEventSchema = z
  .object({
    job: ExportJobRecordSchema
  })
  .strict()
export type ExportProgressEvent = z.infer<typeof ExportProgressEventSchema>
