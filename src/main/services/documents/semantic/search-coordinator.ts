/**
 * Personal Vault — Stage 7D Slice 3 Bounded Document Search Coordinator (`DocumentSearchCoordinator`)
 *
 * Manages at most 1 dedicated `doc_search_worker.js` thread under shared `AppWorkerBudget(3)`:
 * - Separates query identity (query + filters) from page requests (`offset`, `limit`), allowing
 *   concurrent pages for the same query while superseding older queries cleanly.
 * - Rejects > 16 concurrent pending requests (`DOC_SEARCH_OVERLOAD`).
 * - Tracks `terminatingWorkers` until confirmed `'exit'` and releases `AppWorkerBudget`
 *   reservations synchronously if script resolution or `new Worker(...)` fails.
 * - Cooperatively aborts in-flight ONNX calls (`abort_and_exit`) with `500 ms` fallback `terminate()`.
 * - Attaches live coverage & query metadata (`queryTokenCount`, `queryTruncated`, `queryLatencyMs`).
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import type {
  DocumentClutterFilter,
  DocumentOriginFilter,
  DocumentPurposeFilter
} from '../../../../shared/validation/document-schemas'
import type { CatalogDatabase } from '../../catalog/database'
import {
  EMPTY_DOC_SEMANTIC_COVERAGE,
  type DocSemanticCoverage,
  type DocSemanticSearchResult,
  type HydratedDocSearchItem
} from '../../catalog/document-semantic-repository'
import type {
  DocSemanticCompatibilitySpec,
  DocTextSourceKind
} from '../../catalog/document-semantic-snapshot-query'
import { AppWorkerBudget, type WorkerBudgetReservation } from '../../worker-budget'
import { resolveMainWorkerScriptPath } from '../../worker-path'
import type { DocumentSemanticCoordinator } from './coordinator'
import { DOC_SEMANTIC_MODEL_COMMIT, DOC_SEMANTIC_MODEL_ID } from './manifest'
import type { DocSemanticModelManager } from './model-manager'
import type { DocSearchWorkerRequest, DocSearchWorkerResponse } from './search-worker'
import { DOC_CHUNKING_RECIPE_VERSION, DOC_SEMANTIC_LIMITS } from './types'

const DOC_SEARCH_ESBUILD_EXTERNALS = [
  'electron',
  'esbuild',
  'onnxruntime-node',
  '@huggingface/tokenizers'
] as const

export class DocSearchCancelledError extends Error {
  public readonly code = 'CANCELLED'
  public constructor(message = 'Document semantic search cancelled') {
    super(message)
    this.name = 'DocSearchCancelledError'
  }
}

export class DocSearchOverloadError extends Error {
  public readonly code = 'DOC_SEARCH_OVERLOAD'
  public constructor(message = 'Too many concurrent document search requests') {
    super(message)
    this.name = 'DocSearchOverloadError'
  }
}

/**
 * Raised when results scored by the worker kept changing in the catalog before main-process
 * hydration across every bounded retry. Never resolved as a partial/inconsistent page.
 */
export class DocSearchStaleError extends Error {
  public readonly code = 'DOC_SEARCH_STALE'
  public constructor(
    message = 'Document search results changed while searching; please retry the search'
  ) {
    super(message)
    this.name = 'DocSearchStaleError'
  }
}

type DocSemanticSearchAttempt = DocSemanticSearchResult & {
  readonly queryTokenCount: number
  readonly queryTruncated: boolean
  readonly queryLatencyMs: number
}

function stripScoredIdentity(item: HydratedDocSearchItem): HydratedDocSearchItem {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { scoredIdentity: _scoredIdentity, ...rest } = item
  return rest
}

export interface DocumentSearchRequest {
  readonly query: string
  readonly limit?: number
  readonly offset?: number
  readonly extensionFilter?: string | null
  readonly filenameQuery?: string
  readonly textSourceKindFilter?: DocTextSourceKind | null
  readonly purposeFilter?: DocumentPurposeFilter | null
  readonly originFilter?: DocumentOriginFilter | null
  readonly clutterFilter?: DocumentClutterFilter
  readonly delayMs?: number
}

export interface DocumentSearchResponse {
  readonly items: readonly HydratedDocSearchItem[]
  readonly totalMatched: number
  readonly hasMore: boolean
  readonly eligibleChunkCount: number
  readonly corruptChunkCount: number
  readonly queryTokenCount: number
  readonly queryTruncated: boolean
  readonly queryLatencyMs: number
  readonly coverage: DocSemanticCoverage
  readonly clutterFilterActive?: boolean
}

export interface DocumentSearchCoordinatorOptions {
  readonly catalog: CatalogDatabase
  readonly modelManager: DocSemanticModelManager
  readonly indexCoordinator?: DocumentSemanticCoordinator
  readonly workerBudget?: AppWorkerBudget
  readonly maxAppLiveWorkers?: number
  readonly getExternalLiveWorkers?: () => number
  readonly tryReleaseExternalIdleWorker?: () => Promise<boolean>
  readonly workerScriptPath?: string
  readonly appPath?: string | null
  readonly isPackaged?: boolean
  readonly workerTimeoutMs?: number
  readonly admissionTimeoutMs?: number
  readonly idleTimeoutMs?: number
  readonly maxPendingRequests?: number
  /** Bounded re-runs when scored results are invalidated before hydration (default 2). */
  readonly maxStaleRetries?: number
}

interface PendingSearchCall {
  readonly id: number
  readonly worker: Worker
  readonly queryKey: string
  readonly generation: number
  readonly resolve: (resp: DocSearchWorkerResponse) => void
  readonly reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout> | null
}

export class DocumentSearchCoordinator {
  private readonly catalog: CatalogDatabase
  private readonly modelManager: DocSemanticModelManager
  private readonly indexCoordinator?: DocumentSemanticCoordinator
  private readonly workerBudget: AppWorkerBudget
  private readonly getExternalLiveWorkers?: () => number
  private readonly tryReleaseExternalIdleWorker?: () => Promise<boolean>
  private readonly customWorkerScriptPath?: string
  private readonly appPathOverride?: string | null
  private readonly isPackagedOverride?: boolean
  private readonly workerTimeoutMs: number
  private readonly admissionTimeoutMs: number
  private readonly idleTimeoutMs: number
  private readonly maxPendingRequests: number
  private readonly maxStaleRetries: number

  private worker: Worker | null = null
  private activeSpawn: { readonly epoch: number; readonly promise: Promise<Worker> } | null = null
  private readonly pendingSpawns = new Set<Promise<unknown>>()
  /**
   * Admission/spawn cancellation epoch. Bumped only by explicit `cancelSearch()`/`shutdown()`,
   * never by query supersession, so a newer query awaiting a shared in-flight spawn does not
   * inherit an older query's generation cancellation.
   */
  private spawnEpoch = 0
  private staleRetryCount = 0
  private readonly terminatingWorkers = new Set<Worker>()
  private readonly activeTerminations = new Map<Worker, Promise<void>>()
  private readonly exitedWorkers = new WeakSet<Worker>()
  private readonly pendingCalls = new Map<number, PendingSearchCall>()

  private nextRequestId = 1
  private activeSearchCalls = 0
  private currentQueryKey: string | null = null
  private currentGeneration = 0
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private isShutdown = false
  private lastNestedWorkerAttempts = 0
  private lastOutboundNetworkAttempts = 0

  public constructor(options: DocumentSearchCoordinatorOptions) {
    this.catalog = options.catalog
    this.modelManager = options.modelManager
    this.indexCoordinator = options.indexCoordinator
    this.workerBudget = options.workerBudget ?? new AppWorkerBudget(options.maxAppLiveWorkers ?? 3)
    this.getExternalLiveWorkers = options.getExternalLiveWorkers
    this.tryReleaseExternalIdleWorker = options.tryReleaseExternalIdleWorker
    this.customWorkerScriptPath = options.workerScriptPath
    this.appPathOverride = options.appPath
    this.isPackagedOverride = options.isPackaged
    this.workerTimeoutMs = options.workerTimeoutMs ?? DOC_SEMANTIC_LIMITS.WORKER_TIMEOUT_MS
    this.admissionTimeoutMs = Math.max(1, options.admissionTimeoutMs ?? 15_000)
    this.idleTimeoutMs = Math.max(1, options.idleTimeoutMs ?? 30_000)
    this.maxPendingRequests = options.maxPendingRequests ?? 16
    this.maxStaleRetries = Math.max(0, Math.floor(options.maxStaleRetries ?? 2))
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  private scheduleIdleTimer(): void {
    this.clearIdleTimer()
    if (
      this.isShutdown ||
      !this.worker ||
      this.pendingCalls.size > 0 ||
      this.activeSearchCalls > 0
    ) {
      return
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      void this.releaseIdleWorker().catch(() => {})
    }, this.idleTimeoutMs)
    this.idleTimer.unref?.()
  }

  private buildQueryKey(req: DocumentSearchRequest): string {
    return JSON.stringify([
      req.query.trim(),
      req.extensionFilter ?? null,
      req.filenameQuery?.trim() ?? '',
      req.textSourceKindFilter ?? null,
      req.purposeFilter ?? null,
      req.originFilter ?? null,
      req.clutterFilter ?? 'show_all'
    ])
  }

  private getCompatibilitySpec(): DocSemanticCompatibilitySpec {
    const st = this.modelManager.getStatus()
    return {
      docModelId: st.modelId || DOC_SEMANTIC_MODEL_ID,
      docModelCommit: st.modelCommit || DOC_SEMANTIC_MODEL_COMMIT,
      docModelManifestSha256: st.manifestSha256,
      chunkingRecipeVersion: DOC_CHUNKING_RECIPE_VERSION,
      maxContentTokensPerChunk: DOC_SEMANTIC_LIMITS.MAX_CONTENT_TOKENS_PER_CHUNK,
      overlapTokens: DOC_SEMANTIC_LIMITS.OVERLAP_TOKENS,
      maxChunksPerDocument: DOC_SEMANTIC_LIMITS.MAX_CHUNKS_PER_DOCUMENT,
      maxTextCharsForIndexing: DOC_SEMANTIC_LIMITS.MAX_TEXT_CHARS_FOR_INDEXING
    }
  }

  public getDiagnostics() {
    const activeWorkers = this.worker && !this.terminatingWorkers.has(this.worker) ? 1 : 0
    const terminatingWorkers = this.terminatingWorkers.size
    return {
      activeWorkers,
      terminatingWorkers,
      liveWorkers: activeWorkers + terminatingWorkers,
      pendingRequests: this.pendingCalls.size,
      maxPendingRequests: this.maxPendingRequests,
      staleRetryCount: this.staleRetryCount,
      nestedWorkerAttempts: this.lastNestedWorkerAttempts,
      outboundNetworkAttempts: this.lastOutboundNetworkAttempts
    }
  }

  public async search(req: DocumentSearchRequest): Promise<DocumentSearchResponse> {
    if (this.isShutdown || this.catalog.isClosed()) {
      throw new DocSearchCancelledError('DocumentSearchCoordinator is shut down')
    }

    const trimmedQuery = req.query.trim()
    if (!trimmedQuery) {
      return {
        items: [],
        totalMatched: 0,
        hasMore: false,
        eligibleChunkCount: 0,
        corruptChunkCount: 0,
        queryTokenCount: 0,
        queryTruncated: false,
        queryLatencyMs: 0,
        coverage: this.getCoverageSnapshot()
      }
    }

    const queryKey = this.buildQueryKey(req)
    let oldWorkerToTerminate: Worker | null = null
    if (this.currentQueryKey !== queryKey) {
      const hadOlderActive = Array.from(this.pendingCalls.values()).some(
        (call) => call.queryKey !== queryKey
      )
      this.currentQueryKey = queryKey
      this.currentGeneration += 1
      this.rejectPendingByPredicate(
        (call) => call.queryKey !== queryKey,
        new DocSearchCancelledError('Superseded by newer document search query')
      )
      if (hadOlderActive && this.worker) {
        oldWorkerToTerminate = this.worker
        this.worker = null
      }
    }

    const generation = this.currentGeneration

    if (this.activeSearchCalls >= this.maxPendingRequests) {
      if (oldWorkerToTerminate) {
        void this.terminateWorkerAndWaitExit(oldWorkerToTerminate)
      }
      throw new DocSearchOverloadError(
        `Document search pending limit (${this.maxPendingRequests}) exceeded`
      )
    }

    this.clearIdleTimer()
    this.activeSearchCalls += 1
    try {
      const assertCurrent = (): void => {
        if (this.isShutdown || this.catalog.isClosed() || generation !== this.currentGeneration) {
          throw new DocSearchCancelledError('Document semantic search cancelled')
        }
      }

      if (oldWorkerToTerminate) {
        await this.terminateWorkerAndWaitExit(oldWorkerToTerminate)
        assertCurrent()
      }

      // Verify model directory integrity cleanly (without auto-download)
      const ready = await this.modelManager.verifyInstalledIntegrity()
      assertCurrent()

      const compat = this.getCompatibilitySpec()
      const catalogPath = this.catalog.getCatalogPath()

      const runAttempt = async (): Promise<{
        readonly result: DocSemanticSearchAttempt
      }> => {
        // Fallback for in-memory test catalogs where a worker thread cannot open ':memory:'
        if (catalogPath === ':memory:' && this.indexCoordinator) {
          const res = await this.indexCoordinator.searchDocuments(trimmedQuery, {
            limit: req.limit,
            offset: req.offset,
            extensionFilter: req.extensionFilter,
            filenameQuery: req.filenameQuery,
            textSourceKindFilter: req.textSourceKindFilter,
            purposeFilter: req.purposeFilter,
            originFilter: req.originFilter,
            clutterFilter: req.clutterFilter
          })
          assertCurrent()
          return {
            result: { ...res, queryTokenCount: 0, queryTruncated: false, queryLatencyMs: 0 }
          }
        }

        const worker = await this.ensureWorker(generation)
        assertCurrent()

        const resp = await this.dispatchSearch(worker, queryKey, generation, (id) => ({
          id,
          type: 'search',
          catalogPath,
          modelDir: ready.installDir,
          artifacts: this.modelManager.getArtifacts(),
          compat,
          query: trimmedQuery.slice(0, DOC_SEMANTIC_LIMITS.MAX_QUERY_CHARS),
          limit: Math.min(100, Math.max(1, Math.floor(req.limit ?? 50))),
          offset: Math.max(0, Math.floor(req.offset ?? 0)),
          extensionFilter: req.extensionFilter,
          filenameQuery: req.filenameQuery,
          textSourceKindFilter: req.textSourceKindFilter,
          purposeFilter: req.purposeFilter,
          originFilter: req.originFilter,
          clutterFilter: req.clutterFilter,
          delayMs: req.delayMs
        }))
        assertCurrent()

        if (!resp.ok) {
          const err = new Error(resp.errorMessage)
          ;(err as Error & { code?: string }).code = resp.errorCode
          throw err
        }
        return { result: resp }
      }

      // Bounded retry: every returned item must still match the identity the worker scored.
      // Items and counts come from one worker read snapshot, so a page is returned only when
      // all of its items revalidate; otherwise the whole page is re-run (never partially pruned).
      for (let attempt = 0; attempt <= this.maxStaleRetries; attempt += 1) {
        const { result } = await runAttempt()
        assertCurrent()
        const repo = this.catalog.getDocumentSemanticRepository()
        const allCurrent = result.items.every((item) =>
          repo.revalidateScoredSearchItem(item, compat)
        )
        if (allCurrent) {
          return {
            items: result.items.map(stripScoredIdentity),
            totalMatched: result.totalMatched,
            hasMore: result.hasMore,
            eligibleChunkCount: result.eligibleChunkCount,
            corruptChunkCount: result.corruptChunkCount,
            queryTokenCount: result.queryTokenCount,
            queryTruncated: result.queryTruncated,
            queryLatencyMs: result.queryLatencyMs,
            coverage: this.getCoverageSnapshot(),
            clutterFilterActive:
              req.clutterFilter === 'hide_clutter' || req.clutterFilter === 'only_clutter'
          }
        }
        this.staleRetryCount += 1
      }
      throw new DocSearchStaleError()
    } finally {
      this.activeSearchCalls = Math.max(0, this.activeSearchCalls - 1)
      if (
        this.activeSearchCalls === 0 &&
        this.pendingCalls.size === 0 &&
        this.worker &&
        !this.isShutdown
      ) {
        this.scheduleIdleTimer()
      }
    }
  }

  private getCoverageSnapshot(): DocSemanticCoverage {
    if (this.indexCoordinator) {
      return this.indexCoordinator.getProgress().coverage
    }
    if (!this.catalog.isClosed()) {
      return this.catalog.getDocumentSemanticRepository().getCoverage(this.getCompatibilitySpec())
    }
    return EMPTY_DOC_SEMANTIC_COVERAGE
  }

  public async cancelSearch(reason = 'Document semantic search cancelled'): Promise<void> {
    this.clearIdleTimer()
    this.currentGeneration += 1
    this.spawnEpoch += 1
    this.currentQueryKey = null
    const cancelledSpawn = this.activeSpawn
    this.activeSpawn = null
    cancelledSpawn?.promise.catch(() => {})
    this.rejectPendingByPredicate(() => true, new DocSearchCancelledError(reason))
    const target = this.worker
    this.worker = null
    const terminationPromises: Promise<void>[] = Array.from(this.activeTerminations.values())
    if (target) {
      terminationPromises.push(this.terminateWorkerAndWaitExit(target))
    }
    for (const w of this.terminatingWorkers) {
      if (!this.activeTerminations.has(w)) {
        terminationPromises.push(this.waitForWorkerExit(w, 1_500))
      }
    }
    const spawnPromises: Promise<unknown>[] = Array.from(this.pendingSpawns).map((p) =>
      p.catch(() => {})
    )
    if (cancelledSpawn && !this.pendingSpawns.has(cancelledSpawn.promise)) {
      spawnPromises.push(cancelledSpawn.promise.catch(() => {}))
    }
    await Promise.all([...terminationPromises, ...spawnPromises])
  }

  public async releaseIdleWorker(): Promise<boolean> {
    if (
      !this.worker ||
      this.pendingCalls.size > 0 ||
      this.activeSearchCalls > 0 ||
      this.activeSpawn !== null ||
      this.terminatingWorkers.size > 0 ||
      this.exitedWorkers.has(this.worker)
    ) {
      return false
    }
    this.clearIdleTimer()
    const target = this.worker
    this.worker = null
    await this.terminateWorkerAndWaitExit(target)
    return true
  }

  public async shutdown(): Promise<void> {
    this.isShutdown = true
    this.clearIdleTimer()
    await this.cancelSearch('DocumentSearchCoordinator shut down')
    await Promise.all(Array.from(this.pendingSpawns).map((p) => p.catch(() => {})))
    await Promise.all(Array.from(this.terminatingWorkers).map((w) => this.waitForWorkerExit(w)))
  }

  private rejectPendingByPredicate(
    predicate: (call: PendingSearchCall) => boolean,
    err: Error
  ): void {
    for (const [id, call] of this.pendingCalls.entries()) {
      if (!predicate(call)) continue
      this.pendingCalls.delete(id)
      if (call.timer) clearTimeout(call.timer)
      call.reject(err)
    }
  }

  private resolveWorkerPath(): string {
    return resolveMainWorkerScriptPath({
      workerFileName: 'doc_search_worker.js',
      sourceEntryPath: resolve(
        process.cwd(),
        'src/main/services/documents/semantic/search-worker.ts'
      ),
      customPath: this.customWorkerScriptPath,
      moduleDir: __dirname,
      appPath: this.appPathOverride,
      isPackaged: this.isPackagedOverride,
      esbuildExternals: DOC_SEARCH_ESBUILD_EXTERNALS
    })
  }

  private async reserveBudgetSlot(isCancelled: () => boolean): Promise<WorkerBudgetReservation> {
    while (this.terminatingWorkers.size > 0) {
      if (isCancelled()) throw new DocSearchCancelledError()
      await Promise.all(Array.from(this.terminatingWorkers).map((w) => this.waitForWorkerExit(w)))
      if (isCancelled()) throw new DocSearchCancelledError()
    }

    const deadline = Date.now() + this.admissionTimeoutMs
    while (true) {
      if (isCancelled()) throw new DocSearchCancelledError()
      let reservation = this.workerBudget.tryReserve(this.getExternalLiveWorkers)
      if (reservation) {
        if (isCancelled()) {
          this.workerBudget.releaseReservation(reservation)
          throw new DocSearchCancelledError()
        }
        return reservation
      }
      if (this.tryReleaseExternalIdleWorker) {
        const released = await this.tryReleaseExternalIdleWorker()
        if (isCancelled()) throw new DocSearchCancelledError()
        if (released) {
          reservation = this.workerBudget.tryReserve(this.getExternalLiveWorkers)
          if (reservation) {
            if (isCancelled()) {
              this.workerBudget.releaseReservation(reservation)
              throw new DocSearchCancelledError()
            }
            return reservation
          }
        }
      }
      if (Date.now() >= deadline) {
        throw new DocSearchOverloadError('AppWorkerBudget exhausted for document search worker')
      }
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  private async ensureWorker(expectedGeneration: number): Promise<Worker> {
    // Caller-scoped cancellation (query supersession) is checked only by the caller, never
    // inside the shared spawn, so a newer query can safely await an older query's spawn.
    const isCallerCancelled = (): boolean =>
      this.isShutdown || this.catalog.isClosed() || this.currentGeneration !== expectedGeneration
    const epochAtSpawn = this.spawnEpoch
    const isSpawnCancelled = (): boolean =>
      this.isShutdown || this.catalog.isClosed() || this.spawnEpoch !== epochAtSpawn

    if (isCallerCancelled()) throw new DocSearchCancelledError()
    if (
      this.worker &&
      !this.terminatingWorkers.has(this.worker) &&
      !this.exitedWorkers.has(this.worker)
    ) {
      return this.worker
    }
    if (this.activeSpawn && this.activeSpawn.epoch === epochAtSpawn) {
      const existing = await this.activeSpawn.promise
      if (isCallerCancelled()) throw new DocSearchCancelledError()
      return existing
    }

    const spawnPromise = (async () => {
      const reservation = await this.reserveBudgetSlot(isSpawnCancelled)
      let spawned: Worker | null = null
      try {
        if (isSpawnCancelled()) throw new DocSearchCancelledError()
        const scriptPath = this.resolveWorkerPath()
        if (!existsSync(scriptPath)) {
          throw new Error(`Document search worker script not found: ${scriptPath}`)
        }
        if (isSpawnCancelled()) throw new DocSearchCancelledError()
        spawned = new Worker(scriptPath)
        this.workerBudget.promote(reservation, spawned)
      } catch (err) {
        if (!spawned) {
          this.workerBudget.releaseReservation(reservation)
        }
        throw err
      }

      const w = spawned
      w.on('message', (resp: DocSearchWorkerResponse) => {
        this.lastNestedWorkerAttempts = Math.max(
          this.lastNestedWorkerAttempts,
          resp.nestedWorkerAttempts
        )
        this.lastOutboundNetworkAttempts = Math.max(
          this.lastOutboundNetworkAttempts,
          resp.outboundNetworkAttempts
        )
        const pending = this.pendingCalls.get(resp.id)
        if (!pending || pending.worker !== w) return
        this.pendingCalls.delete(resp.id)
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
        this.rejectPendingByPredicate((call) => call.worker === w, err)
      })

      w.on('exit', (code) => {
        this.exitedWorkers.add(w)
        this.terminatingWorkers.delete(w)
        if (this.worker === w) {
          this.worker = null
        }
        this.rejectPendingByPredicate(
          (call) => call.worker === w,
          new Error(`Document search worker exited with code ${code}`)
        )
      })

      if (isSpawnCancelled()) {
        this.terminatingWorkers.add(w)
        await this.terminateWorkerAndWaitExit(w)
        throw new DocSearchCancelledError()
      }

      this.worker = w
      return w
    })()

    const spawnEntry = { epoch: epochAtSpawn, promise: spawnPromise }
    this.activeSpawn = spawnEntry
    this.pendingSpawns.add(spawnPromise)
    const cleanupPending = (): void => {
      this.pendingSpawns.delete(spawnPromise)
    }
    spawnPromise.then(cleanupPending, cleanupPending)
    try {
      const spawned = await spawnPromise
      if (isCallerCancelled()) throw new DocSearchCancelledError()
      return spawned
    } finally {
      if (this.activeSpawn === spawnEntry) {
        this.activeSpawn = null
      }
    }
  }

  private dispatchSearch(
    worker: Worker,
    queryKey: string,
    generation: number,
    payloadFactory: (id: number) => DocSearchWorkerRequest
  ): Promise<DocSearchWorkerResponse> {
    if (
      this.isShutdown ||
      this.worker !== worker ||
      this.terminatingWorkers.has(worker) ||
      this.exitedWorkers.has(worker)
    ) {
      return Promise.reject(new DocSearchCancelledError())
    }

    const id = this.nextRequestId++
    const msg = payloadFactory(id)

    return new Promise((resolvePromise, rejectPromise) => {
      const entry: PendingSearchCall = {
        id,
        worker,
        queryKey,
        generation,
        resolve: resolvePromise,
        reject: rejectPromise,
        timer: null
      }

      entry.timer = setTimeout(() => {
        if (!this.pendingCalls.has(id)) return
        this.pendingCalls.delete(id)
        const err = new Error(`WORKER_TIMEOUT: Document search exceeded ${this.workerTimeoutMs} ms`)
        ;(err as Error & { code?: string }).code = 'WORKER_TIMEOUT'
        if (this.worker === worker) {
          this.worker = null
        }
        void this.terminateWorkerAndWaitExit(worker)
        rejectPromise(err)
      }, this.workerTimeoutMs)

      this.pendingCalls.set(id, entry)
      try {
        worker.postMessage(msg)
      } catch (err) {
        this.pendingCalls.delete(id)
        if (entry.timer) clearTimeout(entry.timer)
        rejectPromise(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  private terminateWorkerAndWaitExit(target: Worker): Promise<void> {
    if (this.exitedWorkers.has(target)) {
      this.terminatingWorkers.delete(target)
      return Promise.resolve()
    }
    const existing = this.activeTerminations.get(target)
    if (existing) {
      return existing
    }
    this.terminatingWorkers.add(target)
    const promise = (async () => {
      try {
        target.postMessage({ id: 0, type: 'abort_and_exit' } satisfies DocSearchWorkerRequest)
      } catch {
        // ignore postMessage errors
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
    })().finally(() => {
      this.activeTerminations.delete(target)
    })
    this.activeTerminations.set(target, promise)
    return promise
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
