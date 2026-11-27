/**
 * Personal Vault — Stage 7C Offline OCR Foundation Types & Bounded Resource Limits
 */

export const DOCUMENT_OCR_RECIPE_VERSION = 'doc_ocr_v1' as const

export const DOCUMENT_OCR_LIMITS = {
  MAX_INPUT_BYTES: 64 * 1024 * 1024, // 64 MiB (explicit Stage 7C OCR source limit)
  MAX_PDF_PAGES: 50,
  RASTER_DPI: 200,
  MAX_RASTER_EDGE_PX: 3200,
  MAX_RASTER_PIXELS: 9_000_000,
  MAX_IMAGE_INPUT_PIXELS: 40_000_000,
  MAX_EXTRACTED_CHARS: 500_000,
  PER_PAGE_TIMEOUT_MS: 15_000,
  WORKER_TIMEOUT_MS: 120_000,
  SUBSTANTIAL_SINGLE_RASTER_AREA_RATIO: 0.08,
  SUBSTANTIAL_TOTAL_RASTER_AREA_RATIO: 0.12,
  MAX_DECORATIVE_RASTER_OPS: 3,
  MIN_NATIVE_CHARS_FOR_LOGO_EXEMPTION: 32
} as const

export const SUPPORTED_OCR_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
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
])

export const SUPPORTED_OCR_EXTENSIONS: ReadonlySet<string> = new Set([
  '.pdf',
  ...SUPPORTED_OCR_IMAGE_EXTENSIONS
])

export interface OcrModelArtifactSpec {
  readonly relativePath: string
  readonly byteSize: number
  readonly sha256: string
}

export type OcrModelProvisionState = 'missing' | 'installing' | 'ready' | 'cancelled' | 'error'

export interface OcrModelStatus {
  readonly state: OcrModelProvisionState
  readonly modelId: string
  readonly modelCommit: string
  readonly modelManifestSha256: string
  readonly language: string
  readonly enginePackage: string
  readonly requiredBytes: number
  readonly downloadedBytes: number
  readonly currentArtifact: string | null
  readonly verifiedAtMs: number | null
  readonly error: string | null
  readonly lastReplacementError: string | null
}

export interface PdfPageOcrInspection {
  readonly selectableCharCount: number
  readonly nativeText: string
  readonly rasterImageOpCount: number
  readonly maxSingleRasterAreaRatio: number
  readonly totalRasterAreaRatio: number
  readonly hasUnboundedRasterOp: boolean
}

export type PdfPageOcrReason =
  | 'native_text_only'
  | 'blank_or_vector_only'
  | 'image_only_page'
  | 'unbounded_raster_op_conservative'
  | 'substantial_raster_with_native_text'
  | 'sparse_native_text_with_raster'
  | 'native_text_with_small_raster'

export interface PdfPageOcrClassification {
  readonly needsOcr: boolean
  readonly reason: PdfPageOcrReason
}

export type DocumentOcrPageSource =
  'tesseract_ocr' | 'native_and_tesseract_ocr' | 'native_pdf_text' | 'blank_vector_skipped'

export interface DocumentOcrPageDetail {
  readonly pageNumber: number
  readonly source: DocumentOcrPageSource
  readonly reason: PdfPageOcrReason | 'standalone_image'
  readonly selectableCharCount: number
  readonly rasterImageOpCount: number
  readonly maxSingleRasterAreaRatio: number
  readonly width: number | null
  readonly height: number | null
  readonly effectiveDpi: number | null
  readonly charCount: number
  readonly confidence: number | null
}

export type DocumentOcrTerminalStatus =
  | 'extracted'
  | 'ocr_no_text'
  | 'truncated'
  | 'password_protected'
  | 'unsupported'
  | 'corrupt_or_failed'

export type DocumentOcrMethod =
  'ocr_image_tesseract' | 'ocr_pdf_tesseract' | 'ocr_hybrid_pdf' | 'native_pdf_passthrough' | 'none'

export interface DocumentOcrOptions {
  readonly maxInputBytes?: number
  readonly maxPdfPages?: number
  readonly maxExtractedChars?: number
  readonly perPageTimeoutMs?: number
  readonly pageDelayMs?: number
}

export interface DocumentOcrOutcome {
  readonly status: DocumentOcrTerminalStatus
  readonly recipeVersion: typeof DOCUMENT_OCR_RECIPE_VERSION
  readonly extractionMethod: DocumentOcrMethod
  readonly text: string | null
  readonly extractedCharCount: number
  readonly pageCount: number | null
  readonly ocrPageCount: number
  readonly nativeOnlyPageCount: number
  readonly skippedBlankPageCount: number
  readonly meanConfidence: number | null
  readonly truncated: boolean
  readonly truncationReason: string | null
  readonly statusDetail: string | null
  readonly pageDetails: readonly DocumentOcrPageDetail[]
}

export interface OcrRuntimeEngineTelemetry {
  readonly tesseractVersion: string
  readonly wasmVariant: 'simd-lstm' | 'scalar-lstm'
  readonly wasmPath: string
  readonly wasmLoadedFromUnpackedAsar: boolean
  readonly canvasPath: string
  readonly sharpPath: string
  readonly modelId: string
  readonly modelManifestSha256: string
  readonly trainedDataSha256: string
  readonly trainedDataBytes: number
  readonly coldInitMs: number
}

export interface DocumentOcrWorkerRunMessage {
  readonly id: number
  readonly type: 'ocr_file'
  readonly sourcePath: string
  readonly extension: string
  readonly approvedRoots: readonly string[]
  readonly expectedByteSize: number
  readonly expectedMtimeMs: number | null
  readonly expectedSha256: string | null
  readonly modelDir: string
  readonly artifacts?: readonly OcrModelArtifactSpec[]
  readonly options?: DocumentOcrOptions
}

export interface DocumentOcrWorkerVerifySourceMessage {
  readonly id: number
  readonly type: 'verify_source'
  readonly sourcePath: string
  readonly approvedRoots: readonly string[]
  readonly expectedByteSize: number
  readonly expectedMtimeMs: number | null
  readonly expectedSha256: string | null
  readonly maxInputBytes?: number
}

export interface DocumentOcrWorkerShutdownMessage {
  readonly id: number
  readonly type: 'shutdown'
}

export type DocumentOcrWorkerRequestMessage =
  | DocumentOcrWorkerRunMessage
  | DocumentOcrWorkerVerifySourceMessage
  | DocumentOcrWorkerShutdownMessage

export type DocumentOcrWorkerResponseMessage =
  | {
      readonly id: number
      readonly type: 'ocr_result'
      readonly ok: true
      readonly observedSha256: string
      readonly observedByteSize: number
      readonly observedMtimeMs: number | null
      readonly maxInputBytesUsed: number
      readonly outcome: DocumentOcrOutcome
      readonly engineTelemetry: OcrRuntimeEngineTelemetry | null
      readonly nestedWorkerAttempts: number
      readonly outboundNetworkAttempts: number
      readonly durationMs: number
    }
  | {
      readonly id: number
      readonly type: 'ocr_result'
      readonly ok: false
      readonly errorCode: string
      readonly errorMessage: string
      readonly nestedWorkerAttempts: number
      readonly outboundNetworkAttempts: number
      readonly durationMs: number
    }
  | {
      readonly id: number
      readonly type: 'verify_result'
      readonly ok: true
      readonly observedSha256: string
      readonly observedByteSize: number
      readonly observedMtimeMs: number | null
      readonly nestedWorkerAttempts: number
      readonly outboundNetworkAttempts: number
      readonly durationMs: number
    }
  | {
      readonly id: number
      readonly type: 'verify_result'
      readonly ok: false
      readonly errorCode: string
      readonly errorMessage: string
      readonly nestedWorkerAttempts: number
      readonly outboundNetworkAttempts: number
      readonly durationMs: number
    }
  | {
      readonly id: number
      readonly type: 'shutdown_ack'
      readonly ok: true
      readonly nestedWorkerAttempts: number
      readonly outboundNetworkAttempts: number
    }
