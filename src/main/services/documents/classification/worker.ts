/**
 * Personal Vault — Stage 7E Dedicated Document Classification Worker (`document_classify_worker`)
 *
 * Executes strictly outside Electron main and renderer processes.
 * Enforces:
 * 1. Runtime prohibition of nested `worker_threads.Worker` spawns (`nestedWorkerAttempts === 0`).
 * 2. Runtime prohibition of outbound network activity (`outboundNetworkAttempts === 0`).
 * 3. Zero filesystem reads (operates exclusively on supplied catalog metadata & extracted/OCR text).
 * 4. Zod validation of classification inputs and outputs.
 */

import http from 'node:http'
import https from 'node:https'
import Module from 'node:module'
import net from 'node:net'
import { performance } from 'node:perf_hooks'
import tls from 'node:tls'
import { parentPort } from 'node:worker_threads'
import {
  DocumentClassificationInputSchema,
  DocumentClassificationResultSchema
} from '../../../../shared/validation/document-schemas'
import { classifyWithDeterministicRules } from './rules'
import {
  DOC_CLASSIFY_LIMITS,
  type DocClassifyWorkerRequestMessage,
  type DocClassifyWorkerResponseMessage
} from './types'

let nestedWorkerAttempts = 0
let outboundNetworkAttempts = 0
let guardsInstalled = false

function forbidNestedWorker(): never {
  nestedWorkerAttempts += 1
  throw new Error(
    'NESTED_WORKER_FORBIDDEN: document classification worker must not spawn nested worker threads'
  )
}

function forbidNetwork(surface: string): never {
  outboundNetworkAttempts += 1
  throw new Error(
    `OFFLINE_NETWORK_FORBIDDEN: outbound ${surface} is prohibited in document classification worker`
  )
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

installWorkerIsolationGuards()

function handleRequest(msg: DocClassifyWorkerRequestMessage): DocClassifyWorkerResponseMessage {
  const start = performance.now()
  try {
    if (msg.type === 'classify') {
      const validatedInput = DocumentClassificationInputSchema.parse(msg.input)
      const result = DocumentClassificationResultSchema.parse(
        classifyWithDeterministicRules(validatedInput)
      )
      return {
        id: msg.id,
        ok: true,
        result,
        durationMs: performance.now() - start,
        nestedWorkerAttempts,
        outboundNetworkAttempts
      }
    }

    if (msg.type === 'classify_batch') {
      if (!Array.isArray(msg.inputs) || msg.inputs.length > DOC_CLASSIFY_LIMITS.MAX_BATCH_SIZE) {
        return {
          id: msg.id,
          ok: false,
          errorCode: 'INVALID_BATCH_SIZE',
          errorMessage: `Batch size must be <= ${DOC_CLASSIFY_LIMITS.MAX_BATCH_SIZE}`,
          nestedWorkerAttempts,
          outboundNetworkAttempts
        }
      }
      const results = msg.inputs.map((item) => {
        const validatedInput = DocumentClassificationInputSchema.parse(item)
        return DocumentClassificationResultSchema.parse(
          classifyWithDeterministicRules(validatedInput)
        )
      })
      return {
        id: msg.id,
        ok: true,
        results,
        durationMs: performance.now() - start,
        nestedWorkerAttempts,
        outboundNetworkAttempts
      }
    }

    return {
      id: (msg as { id: number }).id,
      ok: false,
      errorCode: 'UNKNOWN_MESSAGE_TYPE',
      errorMessage: 'Unsupported classification worker message type',
      nestedWorkerAttempts,
      outboundNetworkAttempts
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      id: msg.id,
      ok: false,
      errorCode: 'CLASSIFY_WORKER_ERROR',
      errorMessage: message,
      nestedWorkerAttempts,
      outboundNetworkAttempts
    }
  }
}

if (parentPort) {
  parentPort.on('message', (msg: DocClassifyWorkerRequestMessage) => {
    const resp = handleRequest(msg)
    parentPort?.postMessage(resp)
  })
}
