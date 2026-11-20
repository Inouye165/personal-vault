/**
 * Personal Vault — Stage 8A Selective Export Domain Types
 */

import type {
  ExportByteSourceUsed,
  ExportErrorCode,
  ExportPrivacyOptions,
  ExportVaultIntegrityWarning
} from '../../../shared/validation/export-schemas'

export const EXPORT_MANIFEST_FILENAME = 'export-manifest.json'
export const EXPORT_IN_PROGRESS_MARKER = '.pv-export-in-progress.json'
export const EXPORT_COMPLETE_MARKER = '.pv-export-complete.json'
export const EXPORT_TEMP_DIR_NAME = '.pv-export-temp'
export const EXPORT_SIDECAR_SUFFIX = '.pv-meta.json'

export const EMBEDDED_METADATA_NOTICE =
  'Exported files are exact, byte-for-byte verified copies. Any metadata embedded inside the file itself (such as EXIF/GPS tags in photos or text/properties inside PDFs and documents) remains intact in the copied file; privacy options govern Personal Vault generated JSON sidecars and manifest.'

export interface ExportVaultCopyRef {
  readonly relativePath: string
  readonly verifiedSha256: string
  readonly verifiedByteSize: number
}

export interface ExportRecordedFactsInput {
  readonly byteSize: number
  readonly filesystemBirthtimeMs: number | null
  readonly filesystemMtimeMs: number | null
  readonly firstDiscoveredAtMs: number
  readonly lastSeenAtMs: number
  readonly hashVerifiedAtMs: number
}

export type ExportPhotoMachineGeneratedInput = {
  readonly kind: 'photo'
  readonly metadataStatus: 'unprocessed' | 'extracted' | 'no_metadata' | 'unsupported' | 'failed'
  readonly parserRecipeVersion: string | null
  readonly detectedFormat: string | null
  readonly extensionFormatMismatch: boolean
  readonly encodedWidthPx: number | null
  readonly encodedHeightPx: number | null
  readonly exifOrientation: number | null
  readonly displayWidthPx: number | null
  readonly displayHeightPx: number | null
  readonly inferredCaptureDate: {
    readonly sourceTag: 'DateTimeOriginal' | 'DateTimeDigitized' | null
    readonly rawText: string | null
    readonly localIso: string | null
    readonly calendarDate: string | null
    readonly utcEpochMs: number | null
    readonly offsetText: string | null
    readonly timezoneStatus:
      'offset_present' | 'local_wall_clock_unknown_tz' | 'invalid_offset' | 'unknown'
  } | null
  readonly cameraDisplay: string | null
  readonly lensDisplay: string | null
  readonly dhash64: string | null
}

export type ExportDocumentMachineGeneratedInput = {
  readonly kind: 'document'
  readonly nativeExtraction: {
    readonly status: string
    readonly recipeVersion: string | null
    readonly pageCount: number | null
    readonly charCount: number
    readonly truncated: boolean
    readonly text: string | null
  }
  readonly ocrExtraction: {
    readonly status: string
    readonly method: string | null
    readonly modelId: string | null
    readonly language: string | null
    readonly meanConfidence: number | null
    readonly truncated: boolean
    readonly text: string | null
  }
  readonly automaticClassification: {
    readonly ruleVersion: string
    readonly textSourceKind: 'native' | 'ocr' | 'none'
    readonly purposeStatus: 'classified' | 'other' | 'unknown'
    readonly purposeLabels: readonly string[]
    readonly originStatus: 'classified' | 'unknown'
    readonly originLabels: readonly string[]
    readonly confidenceBand: 'high' | 'medium' | 'low'
    readonly isClutterCandidate: boolean
    readonly uncertaintyReasons: readonly string[]
  } | null
}

export type ExportPhotoUserAnnotationsInput = {
  readonly kind: 'photo'
  readonly rating: number | null
  readonly flag: 'none' | 'pick' | 'reject'
  readonly collections: readonly string[]
  readonly duplicateReview: {
    readonly status: 'reviewed' | 'unreviewed'
    readonly isPreferredLocation: boolean
  } | null
}

export type ExportDocumentUserOverridesInput = {
  readonly kind: 'document'
  readonly classificationOverride: {
    readonly purposeLabels: readonly string[] | null
    readonly originLabels: readonly string[] | null
    readonly clutterOverride: 'inherit' | 'force_keep' | 'force_clutter'
    readonly overrideVersion: number
    readonly updatedAtMs: number
  } | null
  readonly effectiveClassification: {
    readonly purposeLabels: readonly string[]
    readonly originLabels: readonly string[]
    readonly isClutter: boolean
    readonly resolvedFrom: 'user_override' | 'automatic_classifier' | 'unclassified'
  }
  readonly duplicateReview: {
    readonly status: 'reviewed' | 'unreviewed'
    readonly isPreferredLocation: boolean
  } | null
}

export interface ExportItemInput {
  readonly fileLocationId: number
  readonly discoveryObservationId: number
  readonly hashObservationId: number
  readonly originalPath: string
  readonly fileName: string
  readonly extension: string
  readonly category: 'photo' | 'document'
  readonly recordedFacts: ExportRecordedFactsInput
  readonly expectedSha256: string
  readonly vaultCopy: ExportVaultCopyRef | null
  readonly machineGenerated: ExportPhotoMachineGeneratedInput | ExportDocumentMachineGeneratedInput
  readonly userOverridesAndAnnotations:
    ExportPhotoUserAnnotationsInput | ExportDocumentUserOverridesInput
}

export interface ExportBundleParams {
  readonly exportJobId: string
  readonly parentDir: string
  readonly bundleFolderName: string
  readonly sourceRoots: readonly string[]
  readonly vaultRoots: readonly string[]
  readonly userDataDir: string
  readonly vaultPath: string | null
  readonly appVersion: string
  readonly privacyOptions: ExportPrivacyOptions
  readonly items: readonly ExportItemInput[]
  readonly signal?: AbortSignal
}

export interface ExportItemOutcome {
  readonly fileLocationId: number
  readonly status: 'completed' | 'failed' | 'cancelled'
  readonly exportedFileName: string | null
  readonly sidecarFileName: string | null
  readonly byteSourceUsed: ExportByteSourceUsed | null
  readonly vaultIntegrityWarning: ExportVaultIntegrityWarning | null
  readonly errorCode: ExportErrorCode | null
  readonly errorMessage: string | null
}

export interface ExportBundleResult {
  readonly exportJobId: string
  readonly bundleDir: string
  readonly status: 'completed' | 'cancelled' | 'failed'
  readonly manifestPublished: boolean
  readonly totalItems: number
  readonly exportedItems: number
  readonly failedItems: number
  readonly cancelledItems: number
  readonly vaultIntegrityWarnings: number
  readonly errorCode: ExportErrorCode | null
  readonly errorMessage: string | null
  readonly itemOutcomes: readonly ExportItemOutcome[]
}

export interface ExportTestHooks {
  readonly linkSync?: (existingPath: string, newPath: string) => void
  readonly copyFileSync?: (src: string, dest: string, mode?: number) => void
  readonly beforePublishHook?: (destPath: string) => void
  readonly onChunkReadHook?: () => void
}

export type ExportBundleIncompleteReason =
  | 'bundle_dir_missing'
  | 'in_progress_marker_present'
  | 'temp_dir_present'
  | 'completion_marker_missing'
  | 'completion_marker_invalid'
  | 'manifest_missing'
  | 'manifest_invalid'
  | 'manifest_hash_mismatch'
  | 'orphaned_file_without_sidecar'
  | 'missing_pair_file'

export interface ExportBundleInspectionResult {
  readonly isCompleteVerified: boolean
  readonly reasons: readonly ExportBundleIncompleteReason[]
}
