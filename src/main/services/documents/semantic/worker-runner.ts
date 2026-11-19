/**
 * Personal Vault — Stage 7D Document Semantic Worker Runner
 *
 * Manages at most 1 dedicated `document_semantic_worker` thread under the shared
 * application-wide `AppWorkerBudget(3)`, guaranteeing:
 * - Synchronous reservation release (`try / catch`) if worker path resolution or
 *   `new Worker(...)` throws (zero leaked reservations).
 * - Bounded request queue (`MAX_QUEUED_REQUESTS = 64`).
 * - Terminating workers remain counted in `AppWorkerBudget` until confirmed `'exit'`.
 * - Active cancellation (`cancelActiveRequests`) terminates the in-flight worker,
 *   rejects pending requests with `CANCELLED`, and allows clean recovery.
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { AppWorkerBudget, type WorkerBudgetReservation } from '../../worker-budget'
import { resolveMainWorkerScriptPath } from '../../worker-path'
import { REQUIRED_DOC_SEMANTIC_ARTIFACTS } from './manifest'
import {
  DOC_SEMANTIC_LIMITS,
  type DocChunkingOptions,
  type DocChunkingResult,
  type DocSemanticEmbedResult,
  type DocSemanticModelArtifactSpec,
  type DocSemanticRuntimeDiagnostics,
  type DocSemanticWorkerRequestMessage,
  type DocSemanticWorkerResponseMessage
} from './types'

const DOC_SEMANTIC_ESBUILD_EXTERNALS = [
  'electron',
  'esbuild',
  'onnxruntime-node',
  '@huggingface/tokenizers'
] as const

export interface DocumentSemanticWorkerRunnerOptions {
  readonly workerBudget?: AppWorkerBudget
  readonly maxAppLiveWorkers?: number
  readonly getExternalLiveWorkers?: () => number
  readonly tryReleaseExternalIdleWorker?: () => Promise<boolean>
  readonly admissionWaitTimeoutMs?: number
  readonly shouldCancelAdmission?: () => boolean
  readonly workerScriptPath?: string
  readonly appPath?: string | null
  readonly isPackaged?: boolean
  readonly workerTimeoutMs?: number
  readonly maxQueuedRequests?: number
}

interface PendingRequest {
  readonly id: number
  readonly worker: Worker
  readonly resolve: (resp: DocSemanticWorkerResponseMessage) => void
  readonly reject: (err: Error) => void
  readonly onInferenceStarted?: (seqLen: number) => void
  timer: ReturnType<typeof setTimeout> | null
}

interface QueuedTask {
  readonly generation: number
  readonly payloadFactory: (id: number) => DocSemanticWorkerRequestMessage
  readonly onInferenceStarted?: (seqLen: number) => void
  readonly resolve: (resp: DocSemanticWorkerResponseMessage) => void
  readonly reject: (err: Error) => void
  settled: boolean
}

export class DocumentSemanticWorkerRunner {
  private readonly workerBudget: AppWorkerBudget
  private readonly getExternalLiveWorkers?: () => number
  private readonly tryReleaseExternalIdleWorker?: () => Promise<boolean>
  private readonly admissionWaitTimeoutMs: number
  private readonly shouldCancelAdmission?: () => boolean
  private readonly customWorkerScriptPath?: string
  private readonly appPathOverride?: string | null
  private readonly isPackagedOverride?: boolean
  private readonly workerTimeoutMs: number
  private readonly maxQueuedRequests: number

  private worker: Worker | null = null
  private spawningWorkerPromise: Promise<Worker> | null = null
  private readonly terminatingWorkers = new Set<Worker>()
  private readonly exitedWorkers = new WeakSet<Worker>()
  private readonly pendingRequests = new Map<number, PendingRequest>()
  private readonly queue: QueuedTask[] = []
  private activeTask: QueuedTask | null = null
  private activeDispatch = false
  private nextRequestId = 1
  private cancelGeneration = 0
  private lastCancelReason = 'CANCELLED: Document semantic task cancelled'
  private isShutdown = false
  private lastNestedWorkerAttempts = 0
  private lastOutboundNetworkAttempts = 0

  public constructor(options: DocumentSemanticWorkerRunnerOptions = {}) {
    this.workerBudget = options.workerBudget ?? new AppWorkerBudget(options.maxAppLiveWorkers ?? 3)
    this.getExternalLiveWorkers = options.getExternalLiveWorkers
    this.tryReleaseExternalIdleWorker = options.tryReleaseExternalIdleWorker
    this.admissionWaitTimeoutMs = options.admissionWaitTimeoutMs ?? 30_000
    this.shouldCancelAdmission = options.shouldCancelAdmission
    this.customWorkerScriptPath = options.workerScriptPath
    this.appPathOverride = options.appPath
    this.isPackagedOverride = options.isPackaged
    this.workerTimeoutMs = options.workerTimeoutMs ?? DOC_SEMANTIC_LIMITS.WORKER_TIMEOUT_MS
    this.maxQueuedRequests = options.maxQueuedRequests ?? DOC_SEMANTIC_LIMITS.MAX_QUEUED_REQUESTS
  }

  public getDiagnostics(): DocSemanticRuntimeDiagnostics {
    const activeWorkers = this.worker && !this.terminatingWorkers.has(this.worker) ? 1 : 0
    const terminatingWorkers = this.terminatingWorkers.size
    return {
      activeWorkers,
      terminatingWorkers,
      liveWorkers: activeWorkers + terminatingWorkers,
      queuedRequests: this.queue.length,
      activeRequests: this.pendingRequests.size,
      nestedWorkerAttempts: this.lastNestedWorkerAttempts,
      outboundNetworkAttempts: this.lastOutboundNetworkAttempts
    }
  }

  public async verifyModelDirectory(
    modelDir: string,
    artifacts: readonly DocSemanticModelArtifactSpec[] = REQUIRED_DOC_SEMANTIC_ARTIFACTS
  ): Promise<{ readonly ok: boolean; readonly code?: string; readonly error?: string }> {
    const resp = await this.enqueueRequest((id) => ({
      id,
      type: 'verify_model',
      modelDir,
      artifacts
    }))
    if (!('ok' in resp) || !resp.ok || !resp.verifyResult) {
      return {
        ok: false,
        code: 'ok' in resp && !resp.ok ? resp.errorCode : 'DOC_MODEL_INVALID',
        error: 'ok' in resp && !resp.ok ? resp.errorMessage : 'Model verification failed'
      }
    }
    return resp.verifyResult
  }

  public async loadModel(
    modelDir: string,
    artifacts: readonly DocSemanticModelArtifactSpec[] = REQUIRED_DOC_SEMANTIC_ARTIFACTS
  ): Promise<{ readonly loadMs: number }> {
    const resp = await this.enqueueRequest((id) => ({
      id,
      type: 'load_model',
      modelDir,
      artifacts
    }))
    if (!('ok' in resp) || !resp.ok || !resp.loadResult) {
      const code = 'ok' in resp && !resp.ok ? resp.errorCode : 'DOC_MODEL_LOAD_FAILED'
      const msg = 'ok' in resp && !resp.ok ? resp.errorMessage : 'Failed to load model'
      const err = new Error(msg)
      ;(err as Error & { code?: string }).code = code
      throw err
    }
    return { loadMs: resp.loadResult.loadMs }
  }

  public async chunkText(
    modelDir: string,
    text: string,
    options?: DocChunkingOptions,
    artifacts: readonly DocSemanticModelArtifactSpec[] = REQUIRED_DOC_SEMANTIC_ARTIFACTS
  ): Promise<DocChunkingResult> {
    const resp = await this.enqueueRequest((id) => ({
      id,
      type: 'chunk_text',
      modelDir,
      artifacts,
      text,
      options
    }))
    if (!('ok' in resp) || !resp.ok || !resp.chunkResult) {
      const code = 'ok' in resp && !resp.ok ? resp.errorCode : 'DOC_CHUNK_FAILED'
      const msg = 'ok' in resp && !resp.ok ? resp.errorMessage : 'Failed to chunk document text'
      const err = new Error(msg)
      ;(err as Error & { code?: string }).code = code
      throw err
    }
    return resp.chunkResult
  }

  public async embedChunk(
    modelDir: string,
    text: string,
    options: {
      readonly artifacts?: readonly DocSemanticModelArtifactSpec[]
      readonly delayMs?: number
      readonly notifyInferenceStart?: boolean
      readonly repeatCount?: number
      readonly onInferenceStarted?: (seqLen: number) => void
    } = {}
  ): Promise<DocSemanticEmbedResult> {
    const resp = await this.enqueueRequest(
      (id) => ({
        id,
        type: 'embed_chunk',
        modelDir,
        artifacts: options.artifacts ?? REQUIRED_DOC_SEMANTIC_ARTIFACTS,
        text,
        delayMs: options.delayMs,
        notifyInferenceStart: options.notifyInferenceStart,
        repeatCount: options.repeatCount
      }),
      options.onInferenceStarted
    )
    return this.unwrapEmbedResponse(resp)
  }

  public async embedQuery(
    modelDir: string,
    query: string,
    options: {
      readonly artifacts?: readonly DocSemanticModelArtifactSpec[]
      readonly delayMs?: number
      readonly notifyInferenceStart?: boolean
      readonly repeatCount?: number
      readonly onInferenceStarted?: (seqLen: number) => void
    } = {}
  ): Promise<DocSemanticEmbedResult> {
    const resp = await this.enqueueRequest(
      (id) => ({
        id,
        type: 'embed_query',
        modelDir,
        artifacts: options.artifacts ?? REQUIRED_DOC_SEMANTIC_ARTIFACTS,
        query,
        delayMs: options.delayMs,
        notifyInferenceStart: options.notifyInferenceStart,
        repeatCount: options.repeatCount
      }),
      options.onInferenceStarted
    )
    return this.unwrapEmbedResponse(resp)
  }

  public async releaseIdleWorker(): Promise<boolean> {
    if (!this.worker || this.pendingRequests.size > 0 || this.queue.length > 0) {
      return false
    }
    const target = this.worker
    this.worker = null
    await this.terminateWorkerAndWaitExit(target)
    return true
  }

  public async cancelActiveRequests(
    reason = 'CANCELLED: Document semantic task cancelled'
  ): Promise<void> {
    this.cancelGeneration += 1
    this.lastCancelReason = reason
    this.rejectAllQueuedAndPending(reason, 'CANCELLED')
    const target = this.worker
    this.worker = null
    if (target) {
      await this.terminateWorkerAndWaitExit(target)
    }
    if (this.spawningWorkerPromise) {
      await this.spawningWorkerPromise.catch(() => {})
    }
  }

  public async shutdown(): Promise<void> {
    this.isShutdown = true
    await this.cancelActiveRequests('CANCELLED: DocumentSemanticWorkerRunner shut down')
    if (this.spawningWorkerPromise) {
      await this.spawningWorkerPromise.catch(() => {})
    }
    await Promise.all(Array.from(this.terminatingWorkers).map((w) => this.waitForWorkerExit(w)))
  }

  private unwrapEmbedResponse(resp: DocSemanticWorkerResponseMessage): DocSemanticEmbedResult {
    if (!('ok' in resp) || !resp.ok || !resp.embedResult) {
      const code = 'ok' in resp && !resp.ok ? resp.errorCode : 'DOC_EMBED_FAILED'
      const msg = 'ok' in resp && !resp.ok ? resp.errorMessage : 'Document embedding failed'
      const err = new Error(msg)
      ;(err as Error & { code?: string }).code = code
      throw err
    }
    return {
      vector: Float32Array.from(resp.embedResult.vector),
      dimensions: resp.embedResult.dimensions,
      tokenCount: resp.embedResult.tokenCount,
      rawTokenCount: resp.embedResult.rawTokenCount,
      truncated: resp.embedResult.truncated,
      embedMs: resp.embedResult.embedMs
    }
  }

  private resolveWorkerPath(): string {
    return resolveMainWorkerScriptPath({
      workerFileName: 'document_semantic_worker.js',
      sourceEntryPath: resolve(
        process.cwd(),
        'src/main/services/documents/semantic/embed-worker.ts'
      ),
      customPath: this.customWorkerScriptPath,
      moduleDir: __dirname,
      appPath: this.appPathOverride,
      isPackaged: this.isPackagedOverride,
      esbuildExternals: DOC_SEMANTIC_ESBUILD_EXTERNALS
    })
  }

  private makeCancelledError(reason = this.lastCancelReason): Error {
    const err = new Error(reason)
    ;(err as Error & { code?: string }).code = 'CANCELLED'
    return err
  }

  private settleTaskReject(task: QueuedTask, err: Error): void {
    if (task.settled) return
    task.settled = true
    task.reject(err)
  }

  private settleTaskResolve(task: QueuedTask, resp: DocSemanticWorkerResponseMessage): void {
    if (task.settled) return
    task.settled = true
    task.resolve(resp)
  }

  private enqueueRequest(
    payloadFactory: (id: number) => DocSemanticWorkerRequestMessage,
    onInferenceStarted?: (seqLen: number) => void
  ): Promise<DocSemanticWorkerResponseMessage> {
    if (this.isShutdown) {
      return Promise.reject(new Error('DocumentSemanticWorkerRunner is shut down'))
    }
    if (this.queue.length >= this.maxQueuedRequests) {
      const err = new Error(
        `WORKER_QUEUE_FULL: Document semantic queue exceeded limit (${this.maxQueuedRequests})`
      )
      ;(err as Error & { code?: string }).code = 'WORKER_QUEUE_FULL'
      return Promise.reject(err)
    }

    const generation = this.cancelGeneration
    return new Promise((resolvePromise, rejectPromise) => {
      this.queue.push({
        generation,
        payloadFactory,
        onInferenceStarted,
        resolve: resolvePromise,
        reject: rejectPromise,
        settled: false
      })
      void this.pumpQueue()
    })
  }

  private async pumpQueue(): Promise<void> {
    if (this.activeDispatch) return
    this.activeDispatch = true
    try {
      while (this.queue.length > 0 && !this.isShutdown) {
        const next = this.queue.shift()!
        if (next.settled) {
          continue
        }
        if (this.isShutdown || this.cancelGeneration !== next.generation) {
          this.settleTaskReject(next, this.makeCancelledError())
          continue
        }
        this.activeTask = next
        try {
          const worker = await this.ensureWorker(next.generation)
          if (this.isShutdown || this.cancelGeneration !== next.generation || next.settled) {
            this.settleTaskReject(next, this.makeCancelledError())
            continue
          }
          const resp = await this.dispatchToWorker(
            worker,
            next.payloadFactory,
            next.onInferenceStarted
          )
          if (this.isShutdown || this.cancelGeneration !== next.generation || next.settled) {
            this.settleTaskReject(next, this.makeCancelledError())
          } else {
            this.settleTaskResolve(next, resp)
          }
        } catch (err) {
          this.settleTaskReject(next, err instanceof Error ? err : new Error(String(err)))
        } finally {
          if (this.activeTask === next) {
            this.activeTask = null
          }
        }
      }
    } finally {
      this.activeDispatch = false
      if (this.queue.length > 0 && !this.isShutdown) {
        void this.pumpQueue()
      }
    }
  }

  private dispatchToWorker(
    worker: Worker,
    payloadFactory: (id: number) => DocSemanticWorkerRequestMessage,
    onInferenceStarted?: (seqLen: number) => void
  ): Promise<DocSemanticWorkerResponseMessage> {
    if (
      this.isShutdown ||
      this.worker !== worker ||
      this.terminatingWorkers.has(worker) ||
      this.exitedWorkers.has(worker)
    ) {
      return Promise.reject(this.makeCancelledError())
    }

    const id = this.nextRequestId++
    const msg = payloadFactory(id)

    return new Promise((resolvePromise, rejectPromise) => {
      const entry: PendingRequest = {
        id,
        worker,
        resolve: resolvePromise,
        reject: rejectPromise,
        onInferenceStarted,
        timer: null
      }

      entry.timer = setTimeout(() => {
        if (!this.pendingRequests.has(id)) return
        this.pendingRequests.delete(id)
        const err = new Error(
          `WORKER_TIMEOUT: Document semantic request exceeded ${this.workerTimeoutMs} ms`
        )
        ;(err as Error & { code?: string }).code = 'WORKER_TIMEOUT'
        if (this.worker === worker) {
          this.worker = null
        }
        void this.terminateWorkerAndWaitExit(worker)
        rejectPromise(err)
      }, this.workerTimeoutMs)

      this.pendingRequests.set(id, entry)
      try {
        worker.postMessage(msg)
      } catch (err) {
        this.pendingRequests.delete(id)
        if (entry.timer) clearTimeout(entry.timer)
        rejectPromise(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  private async reserveBudgetSlot(isCancelled: () => boolean): Promise<WorkerBudgetReservation> {
    while (this.terminatingWorkers.size > 0) {
      if (isCancelled()) {
        throw this.makeCancelledError()
      }
      await Promise.all(Array.from(this.terminatingWorkers).map((tw) => this.waitForWorkerExit(tw)))
      if (isCancelled()) {
        throw this.makeCancelledError()
      }
    }

    const deadline = Date.now() + this.admissionWaitTimeoutMs
    while (true) {
      if (isCancelled()) {
        throw this.makeCancelledError()
      }

      let reservation = this.workerBudget.tryReserve(this.getExternalLiveWorkers)
      if (reservation) {
        if (isCancelled()) {
          this.workerBudget.releaseReservation(reservation)
          throw this.makeCancelledError()
        }
        return reservation
      }

      if (this.tryReleaseExternalIdleWorker) {
        const released = await this.tryReleaseExternalIdleWorker()
        if (isCancelled()) {
          throw this.makeCancelledError()
        }
        if (released) {
          reservation = this.workerBudget.tryReserve(this.getExternalLiveWorkers)
          if (reservation) {
            if (isCancelled()) {
              this.workerBudget.releaseReservation(reservation)
              throw this.makeCancelledError()
            }
            return reservation
          }
        }
      }

      if (Date.now() >= deadline) {
        const err = new Error(
          'WORKER_BUDGET_EXHAUSTED: Unable to reserve AppWorkerBudget slot for document semantic worker'
        )
        ;(err as Error & { code?: string }).code = 'WORKER_BUDGET_EXHAUSTED'
        throw err
      }

      await new Promise((r) => setTimeout(r, 25))
    }
  }

  private async ensureWorker(expectedGeneration?: number): Promise<Worker> {
    const isCancelled = (): boolean =>
      this.isShutdown ||
      Boolean(this.shouldCancelAdmission?.()) ||
      (expectedGeneration !== undefined && this.cancelGeneration !== expectedGeneration)

    if (isCancelled()) {
      throw this.makeCancelledError()
    }
    if (
      this.worker &&
      !this.terminatingWorkers.has(this.worker) &&
      !this.exitedWorkers.has(this.worker)
    ) {
      return this.worker
    }
    if (this.spawningWorkerPromise) {
      const existing = await this.spawningWorkerPromise
      if (isCancelled()) {
        throw this.makeCancelledError()
      }
      return existing
    }

    const spawnPromise = (async () => {
      const reservation = await this.reserveBudgetSlot(isCancelled)
      let spawned: Worker | null = null
      try {
        if (isCancelled()) {
          throw this.makeCancelledError()
        }
        const scriptPath = this.resolveWorkerPath()
        if (!existsSync(scriptPath)) {
          throw new Error(`Document semantic worker script not found: ${scriptPath}`)
        }
        if (isCancelled()) {
          throw this.makeCancelledError()
        }
        spawned = new Worker(scriptPath)
        this.workerBudget.promote(reservation, spawned)
      } catch (err) {
        if (!spawned) {
          this.workerBudget.releaseReservation(reservation)
        }
        throw err
      }

      const w = spawned
      w.on('message', (resp: DocSemanticWorkerResponseMessage) => {
        if ('type' in resp && resp.type === 'inference_started') {
          const pending = this.pendingRequests.get(resp.id)
          if (pending && pending.worker === w) {
            pending.onInferenceStarted?.(resp.seqLen)
          }
          return
        }
        if (!('id' in resp) || !('ok' in resp)) return
        this.lastNestedWorkerAttempts = Math.max(
          this.lastNestedWorkerAttempts,
          resp.nestedWorkerAttempts
        )
        this.lastOutboundNetworkAttempts = Math.max(
          this.lastOutboundNetworkAttempts,
          resp.outboundNetworkAttempts
        )
        const pending = this.pendingRequests.get(resp.id)
        if (!pending || pending.worker !== w) return
        this.pendingRequests.delete(resp.id)
        if (pending.timer) clearTimeout(pending.timer)
        pending.resolve(resp)
      })

      w.on('error', (err) => {
        if (this.worker === w) {
          this.worker = null
        }
        if (!this.exitedWorkers.has(w)) {
          this.terminatingWorkers.add(w)
          void this.terminateWorkerAndWaitExit(w)
        }
        this.rejectPendingForWorkerExit(w, err.message)
      })

      w.on('exit', (code) => {
        this.exitedWorkers.add(w)
        this.terminatingWorkers.delete(w)
        if (this.worker === w) {
          this.worker = null
        }
        this.rejectPendingForWorkerExit(w, `Document semantic worker exited with code ${code}`)
      })

      if (isCancelled()) {
        this.terminatingWorkers.add(w)
        await this.terminateWorkerAndWaitExit(w)
        throw this.makeCancelledError()
      }

      this.worker = w
      return w
    })()

    this.spawningWorkerPromise = spawnPromise
    try {
      return await spawnPromise
    } finally {
      if (this.spawningWorkerPromise === spawnPromise) {
        this.spawningWorkerPromise = null
      }
    }
  }

  private rejectPendingForWorkerExit(owningWorker: Worker, message: string): void {
    for (const [id, pending] of this.pendingRequests.entries()) {
      if (pending.worker !== owningWorker) continue
      this.pendingRequests.delete(id)
      if (pending.timer) clearTimeout(pending.timer)
      const err = new Error(message)
      ;(err as Error & { code?: string }).code = 'WORKER_TERMINATED'
      pending.reject(err)
    }
  }

  private rejectAllQueuedAndPending(message: string, code: string): void {
    if (this.activeTask) {
      const err = new Error(message)
      ;(err as Error & { code?: string }).code = code
      this.settleTaskReject(this.activeTask, err)
    }
    while (this.queue.length > 0) {
      const q = this.queue.shift()!
      const err = new Error(message)
      ;(err as Error & { code?: string }).code = code
      this.settleTaskReject(q, err)
    }
    for (const [id, pending] of this.pendingRequests.entries()) {
      this.pendingRequests.delete(id)
      if (pending.timer) clearTimeout(pending.timer)
      const err = new Error(message)
      ;(err as Error & { code?: string }).code = code
      pending.reject(err)
    }
  }

  private async terminateWorkerAndWaitExit(target: Worker): Promise<void> {
    if (this.exitedWorkers.has(target)) {
      this.terminatingWorkers.delete(target)
      return
    }
    this.terminatingWorkers.add(target)
    // Request cooperative clean exit first so native onnxruntime-node N-API calls can
    // finish their current forward pass without tearing down napi_env mid-call.
    try {
      target.postMessage({
        id: 0,
        type: 'abort_and_exit'
      } satisfies DocSemanticWorkerRequestMessage)
    } catch {
      // ignore postMessage errors on closing worker
    }
    await this.waitForWorkerExit(target, 500)
    if (!this.exitedWorkers.has(target)) {
      try {
        await target.terminate()
      } catch {
        // ignore termination errors
      }
      await this.waitForWorkerExit(target, 1_000)
    }
  }

  private waitForWorkerExit(target: Worker, timeoutMs = 1_000): Promise<void> {
    if (this.exitedWorkers.has(target)) {
      this.terminatingWorkers.delete(target)
      return Promise.resolve()
    }
    return new Promise((resolveExit) => {
      let settled = false
      const done = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        target.off('exit', done)
        if (this.exitedWorkers.has(target)) {
          this.terminatingWorkers.delete(target)
        }
        resolveExit()
      }
      const timer = setTimeout(done, timeoutMs)
      target.once('exit', done)
    })
  }
}
