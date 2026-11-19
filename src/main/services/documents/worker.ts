/**
 * Personal Vault — Stage 7B Document Extraction Worker Thread
 *
 * Executes strictly outside Electron main and renderer processes.
 * Enforces approved-root canonical containment, symlink/junction checks,
 * pre/post descriptor fstat stability, read-only streaming SHA-256 hashing,
 * and bounded text extraction.
 */

import { parentPort } from 'node:worker_threads'
import { extractDocumentFromBuffer } from './extractor'
import {
  DEFAULT_SOURCE_READER_FS_DEPS,
  readAndVerifySourceWithExplicitLimit,
  type DocumentSourceReaderFsDeps,
  type ExplicitSourceReadResult
} from './source-reader'
import {
  DOCUMENT_EXTRACTION_LIMITS,
  DOCUMENT_EXTRACTION_RECIPE_VERSION,
  type DocumentExtractionWorkerRequest,
  type DocumentExtractionWorkerResponse
} from './types'

export type DocumentWorkerFsDeps = DocumentSourceReaderFsDeps

const DEFAULT_FS_DEPS: DocumentWorkerFsDeps = DEFAULT_SOURCE_READER_FS_DEPS

export async function readAndVerifySource(
  req: DocumentExtractionWorkerRequest,
  fsDeps: DocumentWorkerFsDeps = DEFAULT_FS_DEPS
): Promise<ExplicitSourceReadResult> {
  const maxInputBytes = req.options?.maxInputBytes ?? DOCUMENT_EXTRACTION_LIMITS.MAX_INPUT_BYTES
  return readAndVerifySourceWithExplicitLimit(
    {
      sourcePath: req.sourcePath,
      approvedRoots: req.approvedRoots,
      expectedByteSize: req.expectedByteSize,
      expectedMtimeMs: req.expectedMtimeMs,
      expectedSha256: req.expectedSha256,
      maxInputBytes
    },
    fsDeps
  )
}

async function handleRequest(
  req: DocumentExtractionWorkerRequest
): Promise<DocumentExtractionWorkerResponse> {
  if (req.delayMs && req.delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, req.delayMs))
  }

  const readRes = await readAndVerifySource(req)
  if (!readRes.ok) {
    return {
      id: req.id,
      ok: false,
      errorCode: readRes.errorCode,
      errorMessage: readRes.errorMessage
    }
  }

  if (req.action === 'verify_source') {
    return {
      id: req.id,
      ok: true,
      observedSha256: readRes.observedSha256,
      observedByteSize: readRes.observedByteSize,
      observedMtimeMs: readRes.observedMtimeMs,
      outcome: {
        status: 'extracted',
        recipeVersion: DOCUMENT_EXTRACTION_RECIPE_VERSION,
        text: null,
        extractedCharCount: 0,
        pageCount: null,
        truncated: false,
        truncationReason: null,
        statusDetail: null,
        detectedEncoding: null
      }
    }
  }

  if (readRes.oversizedBytes !== null || readRes.buffer === null) {
    const maxBytes = req.options?.maxInputBytes ?? DOCUMENT_EXTRACTION_LIMITS.MAX_INPUT_BYTES
    const reason = `Input file size (${readRes.oversizedBytes} bytes) exceeded ${maxBytes} byte limit`
    return {
      id: req.id,
      ok: true,
      observedSha256: readRes.observedSha256,
      observedByteSize: readRes.observedByteSize,
      observedMtimeMs: readRes.observedMtimeMs,
      outcome: {
        status: 'truncated',
        recipeVersion: DOCUMENT_EXTRACTION_RECIPE_VERSION,
        text: null,
        extractedCharCount: 0,
        pageCount: null,
        truncated: true,
        truncationReason: reason,
        statusDetail: reason,
        detectedEncoding: null
      }
    }
  }

  const outcome = await extractDocumentFromBuffer(readRes.buffer, req.extension, req.options)
  return {
    id: req.id,
    ok: true,
    observedSha256: readRes.observedSha256,
    observedByteSize: readRes.observedByteSize,
    observedMtimeMs: readRes.observedMtimeMs,
    outcome
  }
}

if (parentPort) {
  const port = parentPort
  port.on('message', (msg: DocumentExtractionWorkerRequest) => {
    void handleRequest(msg)
      .then((res) => {
        port.postMessage(res)
      })
      .catch((err: unknown) => {
        port.postMessage({
          id: msg?.id ?? 0,
          ok: false,
          errorCode: 'WORKER_ERROR',
          errorMessage: err instanceof Error ? err.message : String(err)
        } satisfies DocumentExtractionWorkerResponse)
      })
  })
}
