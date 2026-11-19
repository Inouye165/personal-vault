/**
 * Personal Vault — Stage 7B Document Extraction Types & Resource Limits
 */

export const DOCUMENT_EXTRACTION_RECIPE_VERSION = 'doc_extract_v1'

export const DOCUMENT_EXTRACTION_LIMITS = {
  MAX_INPUT_BYTES: 32 * 1024 * 1024, // 32 MiB
  MAX_PDF_PAGES: 200,
  MAX_DECOMPRESSED_ZIP_BYTES: 64 * 1024 * 1024, // 64 MiB
  MAX_DOCX_XML_BYTES: 16 * 1024 * 1024, // 16 MiB
  MAX_ZIP_ENTRIES: 2048,
  MAX_RTF_GROUP_DEPTH: 128,
  MAX_EXTRACTED_CHARS: 500_000,
  MAX_PREVIEW_CHARS: 100_000,
  WORKER_TIMEOUT_MS: 20_000,
  MAX_WORKERS: 1,
  MAX_QUEUE_SIZE: 64,
  PREVIEW_CACHE_MAX_ENTRIES: 64,
  JOB_FETCH_BATCH_SIZE: 16
} as const

export const SUPPORTED_DOCUMENT_EXTENSIONS = new Set<string>([
  '.txt',
  '.md',
  '.markdown',
  '.csv',
  '.tsv',
  '.rtf',
  '.pdf',
  '.docx'
])

export type PersistedDocumentExtractionStatus =
  | 'extracted'
  | 'no_text_ocr_required'
  | 'password_protected'
  | 'unsupported'
  | 'corrupt_or_failed'
  | 'truncated'

export type DocumentExtractionStatus =
  'not_extracted' | 'processing' | 'stale' | PersistedDocumentExtractionStatus

export interface DocumentExtractionOptions {
  readonly maxInputBytes?: number
  readonly maxPdfPages?: number
  readonly maxDecompressedZipBytes?: number
  readonly maxDocxXmlBytes?: number
  readonly maxZipEntries?: number
  readonly maxRtfGroupDepth?: number
  readonly maxExtractedChars?: number
}

export interface DocumentExtractionOutcome {
  readonly status: PersistedDocumentExtractionStatus
  readonly recipeVersion: string
  readonly text: string | null
  readonly extractedCharCount: number
  readonly pageCount: number | null
  readonly ocrCandidatePageCount?: number | null
  readonly truncated: boolean
  readonly truncationReason: string | null
  readonly statusDetail: string | null
  readonly detectedEncoding: string | null
}

export interface DocumentExtractionWorkerRequest {
  readonly id: number
  readonly action: 'extract_document' | 'verify_source'
  readonly sourcePath: string
  readonly approvedRoots: readonly string[]
  readonly extension: string
  readonly expectedByteSize: number
  readonly expectedMtimeMs: number | null
  readonly expectedSha256: string | null
  readonly options?: DocumentExtractionOptions
  readonly delayMs?: number
}

export interface DocumentExtractionWorkerSuccess {
  readonly id: number
  readonly ok: true
  readonly observedSha256: string
  readonly observedByteSize: number
  readonly observedMtimeMs: number | null
  readonly outcome: DocumentExtractionOutcome
}

export interface DocumentExtractionWorkerFailure {
  readonly id: number
  readonly ok: false
  readonly errorCode: string
  readonly errorMessage: string
}

export type DocumentExtractionWorkerResponse =
  DocumentExtractionWorkerSuccess | DocumentExtractionWorkerFailure

export interface DocumentExtractionCoverage {
  readonly totalDocuments: number
  readonly notExtractedDocuments: number
  readonly extractedDocuments: number
  readonly noTextDocuments: number
  readonly passwordProtectedDocuments: number
  readonly unsupportedDocuments: number
  readonly failedDocuments: number
  readonly truncatedDocuments: number
  readonly staleDocuments: number
}

export interface DocumentExtractionProgress {
  readonly jobId: string | null
  readonly status:
    'idle' | 'running' | 'paused' | 'cancelled' | 'interrupted' | 'completed' | 'failed'
  readonly scopeKind: 'selected' | 'filtered' | 'all' | null
  readonly recipeVersion: string
  readonly totalDocuments: number
  readonly processedDocuments: number
  readonly extractedDocuments: number
  readonly noTextDocuments: number
  readonly passwordProtectedDocuments: number
  readonly unsupportedDocuments: number
  readonly failedDocuments: number
  readonly truncatedDocuments: number
  readonly reusedDocuments: number
  readonly pendingDocuments: number
  readonly activeFileLocationId: number | null
  readonly startedAtMs: number | null
  readonly updatedAtMs: number | null
  readonly completedAtMs: number | null
  readonly lastError: string | null
  readonly coverage: DocumentExtractionCoverage
}
