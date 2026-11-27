/**
 * Personal Vault — Stage 7E Document Classification Worker Runner
 *
 * Manages at most 1 dedicated `document_classify_worker` thread under the shared
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
import type {
  DocumentClassificationInput,
  DocumentClassificationResult
} from '../../../../shared/validation/document-schemas'
import { AppWorkerBudget, type WorkerBudgetReservation } from '../../worker-budget'
import { resolveMainWorkerScriptPath } from '../../worker-path'
import {
  DOC_CLASSIFY_LIMITS,
  type DocClassifyRuntimeDiagnostics,
  type DocClassifyWorkerRequestMessage,
  type DocClassifyWorkerResponseMessage
} from './types'

const DOC_CLASSIFY_ESBUILD_EXTERNALS = ['electron', 'esbuild'] as const

export interface DocumentClassificationWorkerRunnerOptions {
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
  readonly resolve: (resp: DocClassifyWorkerResponseMessage) => void
  readonly reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout> | null
}

interface QueuedTask {
  readonly generation: number
  readonly payloadFactory: (id: number) => DocClassifyWorkerRequestMessage
  readonly resolve: (resp: DocClassifyWorkerResponseMessage) => void
  readonly reject: (err: Error) => void
  settled: boolean
}

export class DocumentClassificationWorkerRunner {
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
  private lastCancelReason = 'CANCELLED: Document classification task cancelled'
  private isShutdown = false
  private lastNestedWorkerAttempts = 0
  private lastOutboundNetworkAttempts = 0

  public constructor(options: DocumentClassificationWorkerRunnerOptions = {}) {
    this.workerBudget = options.workerBudget ?? new AppWorkerBudget(options.maxAppLiveWorkers ?? 3)
    this.getExternalLiveWorkers = options.getExternalLiveWorkers
    this.tryReleaseExternalIdleWorker = options.tryReleaseExternalIdleWorker
    this.admissionWaitTimeoutMs = options.admissionWaitTimeoutMs ?? 30_000
    this.shouldCancelAdmission = options.shouldCancelAdmission
    this.customWorkerScriptPath = options.workerScriptPath
    this.appPathOverride = options.appPath
    this.isPackagedOverride = options.isPackaged
    this.workerTimeoutMs = options.workerTimeoutMs ?? DOC_CLASSIFY_LIMITS.WORKER_TIMEOUT_MS
    this.maxQueuedRequests = options.maxQueuedRequests ?? DOC_CLASSIFY_LIMITS.MAX_QUEUED_REQUESTS
  }

  public getDiagnostics(): DocClassifyRuntimeDiagnostics {
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

  public async classifyDocument(
    input: DocumentClassificationInput
  ): Promise<DocumentClassificationResult> {
    const resp = await this.enqueueRequest((id) => ({
      id,
      type: 'classify',
      input
    }))
    if (!resp.ok || !resp.result) {
      const err = new Error(resp.ok ? 'Missing classification result' : resp.errorMessage)
      ;(err as Error & { code?: string }).code = resp.ok ? 'CLASSIFY_WORKER_ERROR' : resp.errorCode
      throw err
    }
    return resp.result
  }

  public async classifyBatch(
    inputs: readonly DocumentClassificationInput[]
  ): Promise<readonly DocumentClassificationResult[]> {
    if (inputs.length === 0) {
      return []
    }
    if (inputs.length > DOC_CLASSIFY_LIMITS.MAX_BATCH_SIZE) {
      throw new Error(
        `INVALID_BATCH_SIZE: Batch size ${inputs.length} exceeds limit ${DOC_CLASSIFY_LIMITS.MAX_BATCH_SIZE}`
      )
    }
    const resp = await this.enqueueRequest((id) => ({
      id,
      type: 'classify_batch',
      inputs
    }))
    if (!resp.ok || !resp.results) {
      const err = new Error(resp.ok ? 'Missing batch classification results' : resp.errorMessage)
      ;(err as Error & { code?: string }).code = resp.ok ? 'CLASSIFY_WORKER_ERROR' : resp.errorCode
      throw err
    }
    return resp.results
  }

  public async cancelActiveRequests(
    reason = 'CANCELLED: Document classification cancelled'
  ): Promise<void> {
    this.cancelGeneration += 1
    this.lastCancelReason = reason

    const queued = this.queue.splice(0, this.queue.length)
    for (const task of queued) {
      if (!task.settled) {
        task.settled = true
        task.reject(new Error(reason))
      }
    }

    if (this.activeTask && !this.activeTask.settled) {
      this.activeTask.settled = true
      this.activeTask.reject(new Error(reason))
    }

    const activeWorker = this.worker
    this.worker = null
    this.rejectAllPending(new Error(reason))

    if (activeWorker) {
      await this.terminateAndAwaitExit(activeWorker)
    }
  }

  public async releaseIdleWorker(): Promise<boolean> {
    if (this.pendingRequests.size > 0 || this.queue.length > 0 || this.activeDispatch) {
      return false
    }
    const activeWorker = this.worker
    if (!activeWorker) {
      return false
    }
    this.worker = null
    await this.terminateAndAwaitExit(activeWorker)
    return true
  }

  public async shutdown(): Promise<void> {
    this.isShutdown = true
    await this.cancelActiveRequests('CANCELLED: Document classification worker shut down')
    const lingering = [...this.terminatingWorkers]
    if (lingering.length > 0) {
      await Promise.all(lingering.map((w) => this.terminateAndAwaitExit(w)))
    }
  }

  private enqueueRequest(
    payloadFactory: (id: number) => DocClassifyWorkerRequestMessage
  ): Promise<DocClassifyWorkerResponseMessage> {
    if (this.isShutdown) {
      return Promise.reject(
        new Error('SHUTDOWN: Document classification worker runner is shut down')
      )
    }
    if (this.queue.length >= this.maxQueuedRequests) {
      return Promise.reject(
        new Error(
          `QUEUE_FULL: Document classification queue limit (${this.maxQueuedRequests}) exceeded`
        )
      )
    }

    const generation = this.cancelGeneration
    return new Promise<DocClassifyWorkerResponseMessage>((resolvePromise, rejectPromise) => {
      this.queue.push({
        generation,
        payloadFactory,
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
      while (this.queue.length > 0) {
        const task = this.queue.shift()
        if (!task || task.settled) continue
        if (task.generation !== this.cancelGeneration) {
          task.settled = true
          task.reject(new Error(this.lastCancelReason))
          continue
        }
        if (this.isShutdown) {
          task.settled = true
          task.reject(new Error('SHUTDOWN: Document classification worker runner is shut down'))
          continue
        }

        this.activeTask = task
        try {
          const worker = await this.ensureWorker(task.generation)
          if (task.settled || task.generation !== this.cancelGeneration || this.isShutdown) {
            if (!task.settled) {
              task.settled = true
              task.reject(new Error(this.lastCancelReason))
            }
            continue
          }

          const resp = await this.dispatchOnWorker(worker, task.payloadFactory, task.generation)
          this.lastNestedWorkerAttempts = Math.max(
            this.lastNestedWorkerAttempts,
            resp.nestedWorkerAttempts
          )
          this.lastOutboundNetworkAttempts = Math.max(
            this.lastOutboundNetworkAttempts,
            resp.outboundNetworkAttempts
          )
          if (!task.settled) {
            task.settled = true
            task.resolve(resp)
          }
        } catch (err) {
          if (!task.settled) {
            task.settled = true
            task.reject(err instanceof Error ? err : new Error(String(err)))
          }
        } finally {
          if (this.activeTask === task) {
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

  private dispatchOnWorker(
    worker: Worker,
    payloadFactory: (id: number) => DocClassifyWorkerRequestMessage,
    generation: number
  ): Promise<DocClassifyWorkerResponseMessage> {
    return new Promise<DocClassifyWorkerResponseMessage>((resolvePromise, rejectPromise) => {
      if (generation !== this.cancelGeneration) {
        rejectPromise(new Error(this.lastCancelReason))
        return
      }
      const id = this.nextRequestId++
      const payload = payloadFactory(id)

      const pending: PendingRequest = {
        id,
        worker,
        resolve: resolvePromise,
        reject: rejectPromise,
        timer: null
      }

      pending.timer = setTimeout(() => {
        if (!this.pendingRequests.has(id)) return
        this.pendingRequests.delete(id)
        const timeoutErr = new Error(
          `WORKER_TIMEOUT: Document classification request timed out after ${this.workerTimeoutMs}ms`
        )
        ;(timeoutErr as Error & { code?: string }).code = 'WORKER_TIMEOUT'
        if (this.worker === worker) {
          this.worker = null
        }
        void this.terminateAndAwaitExit(worker)
        rejectPromise(timeoutErr)
      }, this.workerTimeoutMs)

      this.pendingRequests.set(id, pending)
      try {
        worker.postMessage(payload)
      } catch (err) {
        this.pendingRequests.delete(id)
        if (pending.timer) {
          clearTimeout(pending.timer)
        }
        rejectPromise(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  private async ensureWorker(generation: number): Promise<Worker> {
    if (this.worker && !this.terminatingWorkers.has(this.worker)) {
      return this.worker
    }
    if (this.spawningWorkerPromise) {
      return this.spawningWorkerPromise
    }

    this.spawningWorkerPromise = this.spawnWorker(generation).finally(() => {
      this.spawningWorkerPromise = null
    })
    return this.spawningWorkerPromise
  }

  private async spawnWorker(generation: number): Promise<Worker> {
    const reservation = await this.acquireBudgetReservation(generation)
    if (generation !== this.cancelGeneration || this.isShutdown) {
      this.workerBudget.releaseReservation(reservation)
      throw new Error(this.lastCancelReason)
    }

    let worker: Worker
    try {
      const scriptPath = this.resolveWorkerScript()
      if (!existsSync(scriptPath)) {
        throw new Error(`Classification worker script does not exist: ${scriptPath}`)
      }
      worker = new Worker(scriptPath)
      this.workerBudget.promote(reservation, worker)
    } catch (err) {
      // Synchronous reservation release on path resolution or constructor failure
      this.workerBudget.releaseReservation(reservation)
      throw err
    }

    this.attachWorkerListeners(worker)
    if (generation !== this.cancelGeneration || this.isShutdown) {
      await this.terminateAndAwaitExit(worker)
      throw new Error(this.lastCancelReason)
    }

    this.worker = worker
    return worker
  }

  private async acquireBudgetReservation(generation: number): Promise<WorkerBudgetReservation> {
    const start = Date.now()
    for (;;) {
      if (
        this.isShutdown ||
        generation !== this.cancelGeneration ||
        this.shouldCancelAdmission?.()
      ) {
        throw new Error(this.lastCancelReason)
      }

      const reservation = this.workerBudget.tryReserve(this.getExternalLiveWorkers)
      if (reservation) {
        return reservation
      }

      if (this.tryReleaseExternalIdleWorker) {
        const released = await this.tryReleaseExternalIdleWorker()
        if (released) {
          continue
        }
      }

      if (Date.now() - start >= this.admissionWaitTimeoutMs) {
        throw new Error('WORKER_BUDGET_TIMEOUT: Timed out waiting for AppWorkerBudget slot')
      }

      await new Promise((r) => setTimeout(r, 15))
    }
  }

  private resolveWorkerScript(): string {
    return resolveMainWorkerScriptPath({
      workerFileName: 'document_classify_worker.js',
      sourceEntryPath: resolve(__dirname, 'worker.ts'),
      customPath: this.customWorkerScriptPath,
      moduleDir: __dirname,
      appPath: this.appPathOverride,
      isPackaged: this.isPackagedOverride,
      esbuildExternals: [...DOC_CLASSIFY_ESBUILD_EXTERNALS]
    })
  }

  private attachWorkerListeners(worker: Worker): void {
    worker.on('message', (msg: DocClassifyWorkerResponseMessage) => {
      const pending = this.pendingRequests.get(msg.id)
      if (!pending) return
      this.pendingRequests.delete(msg.id)
      if (pending.timer) {
        clearTimeout(pending.timer)
      }
      pending.resolve(msg)
    })

    worker.on('error', (err) => {
      if (this.worker === worker) {
        this.worker = null
      }
      this.rejectPendingForWorker(worker, err instanceof Error ? err : new Error(String(err)))
    })

    worker.on('exit', (code) => {
      this.exitedWorkers.add(worker)
      this.terminatingWorkers.delete(worker)
      if (this.worker === worker) {
        this.worker = null
      }
      this.rejectPendingForWorker(
        worker,
        new Error(`Classification worker exited unexpectedly (code=${code})`)
      )
    })
  }

  private rejectAllPending(err: Error): void {
    for (const [id, pending] of this.pendingRequests.entries()) {
      this.pendingRequests.delete(id)
      if (pending.timer) {
        clearTimeout(pending.timer)
      }
      pending.reject(err)
    }
  }

  private rejectPendingForWorker(worker: Worker, err: Error): void {
    for (const [id, pending] of this.pendingRequests.entries()) {
      if (pending.worker !== worker) continue
      this.pendingRequests.delete(id)
      if (pending.timer) {
        clearTimeout(pending.timer)
      }
      pending.reject(err)
    }
  }

  private async terminateAndAwaitExit(worker: Worker): Promise<void> {
    if (this.exitedWorkers.has(worker)) {
      this.terminatingWorkers.delete(worker)
      return
    }
    this.terminatingWorkers.add(worker)
    await new Promise<void>((resolvePromise) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        this.exitedWorkers.add(worker)
        this.terminatingWorkers.delete(worker)
        resolvePromise()
      }
      worker.once('exit', done)
      void worker.terminate().then(done, done)
    })
  }
}
