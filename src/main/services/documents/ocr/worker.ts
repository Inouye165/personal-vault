/**
 * Personal Vault — Stage 7C Dedicated Offline OCR Worker Thread (`document_ocr_worker`)
 *
 * Executes strictly outside Electron main and renderer processes.
 * Enforces:
 * 1. Runtime prohibition of nested `worker_threads.Worker` spawns (`nestedWorkerAttempts === 0`).
 * 2. Runtime prohibition of outbound network activity (`outboundNetworkAttempts === 0`).
 * 3. Approved-root containment, symlink rejection, pre/post `lstat` <-> `fstat` descriptor
 *    binding, live SHA-256 verification, and explicit `64 MiB` (`DOCUMENT_OCR_LIMITS.MAX_INPUT_BYTES`).
 * 4. Off-main SHA-256 + byte-size verification of pinned `eng.traineddata` prior to WASM init.
 */

import http from 'node:http'
import https from 'node:https'
import Module from 'node:module'
import net from 'node:net'
import tls from 'node:tls'
import { parentPort } from 'node:worker_threads'
import { readAndVerifySourceWithExplicitLimit } from '../source-reader'
import { OcrEngineSession, extractDocumentOcrFromBuffer } from './engine'
import { REQUIRED_OCR_MODEL_ARTIFACTS } from './manifest'
import {
  DOCUMENT_OCR_LIMITS,
  DOCUMENT_OCR_RECIPE_VERSION,
  SUPPORTED_OCR_EXTENSIONS,
  type DocumentOcrWorkerRequestMessage,
  type DocumentOcrWorkerResponseMessage,
  type DocumentOcrWorkerRunMessage,
  type DocumentOcrWorkerVerifySourceMessage
} from './types'

let nestedWorkerAttempts = 0
let outboundNetworkAttempts = 0
let guardsInstalled = false

function forbidNestedWorker(): never {
  nestedWorkerAttempts += 1
  throw new Error('NESTED_WORKER_FORBIDDEN: OCR worker must not spawn nested worker threads')
}

function forbidNetwork(surface: string): never {
  outboundNetworkAttempts += 1
  throw new Error(`OFFLINE_NETWORK_FORBIDDEN: outbound ${surface} is prohibited in OCR worker`)
}

function installWorkerIsolationGuards(): void {
  if (guardsInstalled) return
  guardsInstalled = true

  const forbiddenWorkerProxy = new Proxy(function ForbiddenWorker() {}, {
    construct() {
      return forbidNestedWorker()
    },
    apply() {
      return forbidNestedWorker()
    }
  })

  const g = globalThis as Record<string, unknown>
  g.Worker = forbiddenWorkerProxy
  g.fetch = async () => forbidNetwork('fetch')
  g.XMLHttpRequest = function ForbiddenXHR() {
    forbidNetwork('XMLHttpRequest')
  }

  const modInternal = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown
  }
  const origLoad = modInternal._load
  modInternal._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
    const loaded = origLoad.call(this, request, parent, isMain)
    if (request === 'worker_threads' || request === 'node:worker_threads') {
      return new Proxy(loaded as object, {
        get(target, prop, receiver) {
          if (prop === 'Worker') {
            return forbiddenWorkerProxy
          }
          return Reflect.get(target, prop, receiver)
        }
      })
    }
    return loaded
  }

  ;(http as unknown as Record<string, unknown>).request = () => forbidNetwork('http.request')
  ;(http as unknown as Record<string, unknown>).get = () => forbidNetwork('http.get')
  ;(https as unknown as Record<string, unknown>).request = () => forbidNetwork('https.request')
  ;(https as unknown as Record<string, unknown>).get = () => forbidNetwork('https.get')
  ;(net as unknown as Record<string, unknown>).connect = () => forbidNetwork('net.connect')
  ;(net as unknown as Record<string, unknown>).createConnection = () =>
    forbidNetwork('net.createConnection')
  ;(tls as unknown as Record<string, unknown>).connect = () => forbidNetwork('tls.connect')
}

const engineSession = new OcrEngineSession()

function normalizeExtension(ext: string): string {
  const trimmed = ext.trim().toLowerCase()
  if (!trimmed) return ''
  return trimmed.startsWith('.') ? trimmed : `.${trimmed}`
}

async function handleRunRequest(
  req: DocumentOcrWorkerRunMessage
): Promise<DocumentOcrWorkerResponseMessage> {
  const tStart = performance.now()
  const maxInputBytes = req.options?.maxInputBytes ?? DOCUMENT_OCR_LIMITS.MAX_INPUT_BYTES
  const ext = normalizeExtension(req.extension)

  // Verify source containment & identity on every path (even unsupported formats)
  const sourceRes = await readAndVerifySourceWithExplicitLimit({
    sourcePath: req.sourcePath,
    approvedRoots: req.approvedRoots,
    expectedByteSize: req.expectedByteSize,
    expectedMtimeMs: req.expectedMtimeMs,
    expectedSha256: req.expectedSha256,
    maxInputBytes
  })

  if (!sourceRes.ok) {
    return {
      id: req.id,
      type: 'ocr_result',
      ok: false,
      errorCode: sourceRes.errorCode,
      errorMessage: sourceRes.errorMessage,
      nestedWorkerAttempts,
      outboundNetworkAttempts,
      durationMs: Number((performance.now() - tStart).toFixed(2))
    }
  }

  if (!SUPPORTED_OCR_EXTENSIONS.has(ext)) {
    return {
      id: req.id,
      type: 'ocr_result',
      ok: true,
      observedSha256: sourceRes.observedSha256,
      observedByteSize: sourceRes.observedByteSize,
      observedMtimeMs: sourceRes.observedMtimeMs,
      maxInputBytesUsed: maxInputBytes,
      outcome: {
        status: 'unsupported',
        recipeVersion: DOCUMENT_OCR_RECIPE_VERSION,
        extractionMethod: 'none',
        text: null,
        extractedCharCount: 0,
        pageCount: null,
        ocrPageCount: 0,
        nativeOnlyPageCount: 0,
        skippedBlankPageCount: 0,
        meanConfidence: null,
        truncated: false,
        truncationReason: null,
        statusDetail: `Format ${ext || '(no extension)'} is not supported for offline OCR in Stage 7C`,
        pageDetails: []
      },
      engineTelemetry: null,
      nestedWorkerAttempts,
      outboundNetworkAttempts,
      durationMs: Number((performance.now() - tStart).toFixed(2))
    }
  }

  if (sourceRes.oversizedBytes !== null || sourceRes.buffer === null) {
    const reason = `Input file size (${sourceRes.oversizedBytes} bytes) exceeded ${maxInputBytes} byte OCR limit`
    return {
      id: req.id,
      type: 'ocr_result',
      ok: true,
      observedSha256: sourceRes.observedSha256,
      observedByteSize: sourceRes.observedByteSize,
      observedMtimeMs: sourceRes.observedMtimeMs,
      maxInputBytesUsed: maxInputBytes,
      outcome: {
        status: 'truncated',
        recipeVersion: DOCUMENT_OCR_RECIPE_VERSION,
        extractionMethod: 'none',
        text: null,
        extractedCharCount: 0,
        pageCount: null,
        ocrPageCount: 0,
        nativeOnlyPageCount: 0,
        skippedBlankPageCount: 0,
        meanConfidence: null,
        truncated: true,
        truncationReason: reason,
        statusDetail: reason,
        pageDetails: []
      },
      engineTelemetry: null,
      nestedWorkerAttempts,
      outboundNetworkAttempts,
      durationMs: Number((performance.now() - tStart).toFixed(2))
    }
  }

  const initRes = await engineSession.ensureInitialized(
    req.modelDir,
    req.artifacts ?? REQUIRED_OCR_MODEL_ARTIFACTS
  )
  if (!initRes.ok) {
    return {
      id: req.id,
      type: 'ocr_result',
      ok: false,
      errorCode: initRes.errorCode,
      errorMessage: initRes.errorMessage,
      nestedWorkerAttempts,
      outboundNetworkAttempts,
      durationMs: Number((performance.now() - tStart).toFixed(2))
    }
  }

  const outcome = await extractDocumentOcrFromBuffer(
    sourceRes.buffer,
    ext,
    engineSession,
    req.options
  )

  return {
    id: req.id,
    type: 'ocr_result',
    ok: true,
    observedSha256: sourceRes.observedSha256,
    observedByteSize: sourceRes.observedByteSize,
    observedMtimeMs: sourceRes.observedMtimeMs,
    maxInputBytesUsed: maxInputBytes,
    outcome,
    engineTelemetry: initRes.telemetry,
    nestedWorkerAttempts,
    outboundNetworkAttempts,
    durationMs: Number((performance.now() - tStart).toFixed(2))
  }
}

async function handleVerifySourceRequest(
  req: DocumentOcrWorkerVerifySourceMessage
): Promise<DocumentOcrWorkerResponseMessage> {
  const tStart = performance.now()
  const maxInputBytes = req.maxInputBytes ?? DOCUMENT_OCR_LIMITS.MAX_INPUT_BYTES
  const sourceRes = await readAndVerifySourceWithExplicitLimit({
    sourcePath: req.sourcePath,
    approvedRoots: req.approvedRoots,
    expectedByteSize: req.expectedByteSize,
    expectedMtimeMs: req.expectedMtimeMs,
    expectedSha256: req.expectedSha256,
    maxInputBytes
  })

  if (!sourceRes.ok) {
    return {
      id: req.id,
      type: 'verify_result',
      ok: false,
      errorCode: sourceRes.errorCode,
      errorMessage: sourceRes.errorMessage,
      nestedWorkerAttempts,
      outboundNetworkAttempts,
      durationMs: Number((performance.now() - tStart).toFixed(2))
    }
  }

  return {
    id: req.id,
    type: 'verify_result',
    ok: true,
    observedSha256: sourceRes.observedSha256,
    observedByteSize: sourceRes.observedByteSize,
    observedMtimeMs: sourceRes.observedMtimeMs,
    nestedWorkerAttempts,
    outboundNetworkAttempts,
    durationMs: Number((performance.now() - tStart).toFixed(2))
  }
}

if (parentPort) {
  installWorkerIsolationGuards()
  const port = parentPort
  port.on('message', (msg: DocumentOcrWorkerRequestMessage) => {
    if (!msg || typeof msg !== 'object') return

    if (msg.type === 'shutdown') {
      engineSession.dispose()
      port.postMessage({
        id: msg.id,
        type: 'shutdown_ack',
        ok: true,
        nestedWorkerAttempts,
        outboundNetworkAttempts
      } satisfies DocumentOcrWorkerResponseMessage)
      return
    }

    if (msg.type === 'verify_source') {
      void handleVerifySourceRequest(msg)
        .then((res) => {
          port.postMessage(res)
        })
        .catch((err: unknown) => {
          port.postMessage({
            id: msg.id,
            type: 'verify_result',
            ok: false,
            errorCode: 'OCR_WORKER_ERROR',
            errorMessage: err instanceof Error ? err.message : String(err),
            nestedWorkerAttempts,
            outboundNetworkAttempts,
            durationMs: 0
          } satisfies DocumentOcrWorkerResponseMessage)
        })
      return
    }

    if (msg.type === 'ocr_file') {
      void handleRunRequest(msg)
        .then((res) => {
          port.postMessage(res)
        })
        .catch((err: unknown) => {
          port.postMessage({
            id: msg.id,
            type: 'ocr_result',
            ok: false,
            errorCode: 'OCR_WORKER_ERROR',
            errorMessage: err instanceof Error ? err.message : String(err),
            nestedWorkerAttempts,
            outboundNetworkAttempts,
            durationMs: 0
          } satisfies DocumentOcrWorkerResponseMessage)
        })
    }
  })
}
