/**
 * Personal Vault — Semantic Search Coordinator (Stage 6D)
 *
 * Coordinates natural-language photo search requests off Electron main.
 * Manages dedicated search worker lifecycle, rapid replacement cancellation,
 * query validation, model status checks, and photo record hydration.
 */

import { Worker } from 'node:worker_threads'
import { resolve, join } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import type { CatalogDatabase } from '../catalog/database'
import type { SemanticModelManager } from './model-manager'
import type {
  SemanticSearchRequest,
  SemanticSearchResponse,
  SemanticSearchResultItem
} from '../../../shared/validation/ipc-schemas'

export class SearchCancelledError extends Error {
  public readonly code = 'SEARCH_CANCELLED'
  constructor(message = 'Search operation was cancelled or superseded') {
    super(message)
    this.name = 'SearchCancelledError'
  }
}

export class SearchTimeoutError extends Error {
  public readonly code = 'SEARCH_TIMEOUT'
  constructor(message = 'Semantic search timed out') {
    super(message)
    this.name = 'SearchTimeoutError'
  }
}

let cachedBundledSearchWorkerPath: string | null = null

export function resolveSearchWorkerScriptPath(customPath?: string): string {
  if (customPath && existsSync(customPath)) {
    return customPath
  }
  const isTest = process.env.VITEST !== undefined || process.env.NODE_ENV === 'test'
  if (!isTest) {
    const builtInSameDir = join(__dirname, 'search_worker.js')
    if (existsSync(builtInSameDir)) {
      return builtInSameDir
    }
    const projectBuilt = resolve(process.cwd(), 'out', 'main', 'search_worker.js')
    if (existsSync(projectBuilt)) {
      return projectBuilt
    }
  }

  if (cachedBundledSearchWorkerPath && existsSync(cachedBundledSearchWorkerPath)) {
    return cachedBundledSearchWorkerPath
  }

  const outMainDir = join(process.cwd(), 'out', 'main')
  const tempWorker = isTest
    ? join(outMainDir, `search_worker.vitest.${process.pid}.cjs`)
    : join(outMainDir, 'search_worker.js')
  if (!isTest && existsSync(tempWorker)) {
    cachedBundledSearchWorkerPath = tempWorker
    return tempWorker
  }

  try {
    mkdirSync(outMainDir, { recursive: true })
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const esbuild = require('esbuild')
    const workerSource = resolve(__dirname, 'search-worker.ts')
    esbuild.buildSync({
      entryPoints: [workerSource],
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'cjs',
      outfile: tempWorker,
      external: ['electron', 'better-sqlite3', 'node:sqlite', 'onnxruntime-node', 'sharp'],
      sourcemap: false
    })
    cachedBundledSearchWorkerPath = tempWorker
    return tempWorker
  } catch {
    const fallbackOut = resolve(process.cwd(), 'out', 'main', 'search_worker.js')
    return fallbackOut
  }
}

export interface SemanticSearchCoordinatorOptions {
  readonly catalog: CatalogDatabase
  readonly modelManager: SemanticModelManager
  readonly workerScriptPath?: string
  readonly requestTimeoutMs?: number
}

interface WorkerResponseMessage {
  readonly id: number
  readonly status: string
  readonly vector?: Float32Array
  readonly truncated?: boolean
  readonly tokenCount?: number
  readonly message?: string
  readonly rankedItems?: readonly { fileLocationId: number; score: number }[]
  readonly totalMatched?: number
  readonly eligibleCount?: number
  readonly unindexedCount?: number
  readonly staleCount?: number
  readonly offset?: number
  readonly limit?: number
  readonly hasMore?: boolean
  readonly queryLatencyMs?: number
}

interface PendingWorkerRequest {
  readonly id: number
  readonly generation: number
  readonly resolve: (res: WorkerResponseMessage) => void
  readonly reject: (err: Error) => void
  readonly timer: NodeJS.Timeout
}

interface CachedEmbeddingResult {
  readonly vector: Float32Array
  readonly truncated: boolean
  readonly tokenCount: number
}

function computeQueryKey(queryText: string, request: SemanticSearchRequest): string {
  const normalizedText = queryText.trim().toLowerCase()
  return JSON.stringify({
    text: normalizedText,
    rating: request.ratingFilter ?? 'all',
    flag: request.flagFilter ?? 'all',
    collectionId: request.collectionId ?? null,
    dateFrom: request.captureDateFrom ?? null,
    dateTo: request.captureDateTo ?? null,
    incUnknownDate: request.includeUnknownCaptureDate ?? false,
    camera: request.cameraNormalized ?? null,
    onlyUnknownCamera: request.onlyUnknownCamera ?? false,
    lens: request.lensNormalized ?? null,
    onlyUnknownLens: request.onlyUnknownLens ?? false,
    minWidth: request.minWidthPx ?? null,
    minHeight: request.minHeightPx ?? null,
    incUnknownDims: request.includeUnknownDimensions ?? false,
    typeBasis: request.fileTypeBasis ?? 'detected_format',
    typeVal: request.fileTypeValue ?? null,
    onlyUnknownFormat: request.onlyUnknownDetectedFormat ?? false
  })
}

export class SemanticSearchCoordinator {
  private readonly catalog: CatalogDatabase
  private readonly modelManager: SemanticModelManager
  private readonly workerScriptPath?: string
  private readonly requestTimeoutMs: number

  private worker: Worker | null = null
  private readonly terminatingWorkers = new Set<Worker>()
  private isShuttingDown = false
  private nextMessageId = 1

  private readonly activeRequests = new Map<number, PendingWorkerRequest>()
  private currentQueryGeneration = 0
  private activeQueryKey: string | null = null
  private cachedEmbeddingResult: CachedEmbeddingResult | null = null
  private embeddingInFlightPromise: Promise<CachedEmbeddingResult> | null = null

  constructor(options: SemanticSearchCoordinatorOptions) {
    this.catalog = options.catalog
    this.modelManager = options.modelManager
    this.workerScriptPath = options.workerScriptPath
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000
  }

  public getDiagnostics() {
    return {
      activeWorkers: this.worker ? 1 : 0,
      terminatingWorkers: this.terminatingWorkers.size,
      liveWorkers: (this.worker ? 1 : 0) + this.terminatingWorkers.size,
      pendingRequests: this.activeRequests.size,
      currentQueryGeneration: this.currentQueryGeneration
    }
  }

  private ensureWorker(): Worker {
    if (this.worker) {
      return this.worker
    }

    const scriptPath = resolveSearchWorkerScriptPath(this.workerScriptPath)
    const worker = new Worker(scriptPath)
    this.worker = worker

    worker.on('message', (msg: { id: number; status: string; [key: string]: unknown }) => {
      const pending = this.activeRequests.get(msg.id)
      if (!pending) return
      this.activeRequests.delete(msg.id)
      clearTimeout(pending.timer)

      if (pending.generation !== this.currentQueryGeneration) {
        pending.reject(new SearchCancelledError('Search superseded by a newer query'))
        return
      }

      if (msg.status === 'ready' || msg.status === 'pong' || msg.status === 'released') {
        pending.resolve(msg)
      } else {
        const errorMsg = typeof msg.message === 'string' ? msg.message : 'Search worker error'
        pending.reject(new Error(errorMsg))
      }
    })

    worker.on('error', (err) => {
      this.handleWorkerFailure(worker, err.message)
    })

    worker.on('exit', (code) => {
      this.terminatingWorkers.delete(worker)
      if (this.worker === worker) {
        this.worker = null
        if (code !== 0 && !this.isShuttingDown) {
          this.handleWorkerFailure(worker, `Search worker exited with code ${code}`)
        }
      }
    })

    return worker
  }

  private terminateWorker(worker: Worker): void {
    if (this.worker === worker) {
      this.worker = null
    }
    this.terminatingWorkers.add(worker)
    worker.once('exit', () => {
      this.terminatingWorkers.delete(worker)
    })
    worker.terminate().catch(() => {})
  }

  private handleWorkerFailure(failedWorker: Worker, errorMessage: string): void {
    if (this.worker === failedWorker) {
      this.worker = null
    }
    this.terminatingWorkers.delete(failedWorker)

    // Reject in-flight requests that were waiting on this worker
    for (const [id, req] of this.activeRequests.entries()) {
      clearTimeout(req.timer)
      this.activeRequests.delete(id)
      req.reject(new Error(`Search worker failed: ${errorMessage}`))
    }
  }

  public async shutdown(): Promise<void> {
    this.isShuttingDown = true
    this.currentQueryGeneration++
    this.activeQueryKey = null
    this.cachedEmbeddingResult = null
    this.embeddingInFlightPromise = null

    // Cancel all in-flight requests
    for (const [id, req] of this.activeRequests.entries()) {
      clearTimeout(req.timer)
      this.activeRequests.delete(id)
      req.reject(new SearchCancelledError('Search coordinator shutting down'))
    }

    if (this.worker) {
      const w = this.worker
      this.worker = null
      this.terminateWorker(w)
    }

    // Wait for all terminating workers to finish exiting
    const exitPromises: Promise<void>[] = []
    for (const w of this.terminatingWorkers) {
      exitPromises.push(
        new Promise<void>((res) => {
          w.once('exit', () => res())
        })
      )
    }
    await Promise.all(exitPromises)
  }

  public cancelActiveSearch(): void {
    this.currentQueryGeneration++
    this.activeQueryKey = null
    this.cachedEmbeddingResult = null
    this.embeddingInFlightPromise = null

    for (const [id, req] of this.activeRequests.entries()) {
      clearTimeout(req.timer)
      this.activeRequests.delete(id)
      req.reject(new SearchCancelledError('Search cancelled by user'))
    }

    if (this.worker) {
      this.terminateWorker(this.worker)
    }
  }

  private async getOrEmbedQuery(
    modelDir: string,
    queryText: string,
    generation: number
  ): Promise<CachedEmbeddingResult> {
    if (this.cachedEmbeddingResult) {
      return this.cachedEmbeddingResult
    }

    if (this.embeddingInFlightPromise) {
      return this.embeddingInFlightPromise
    }

    const worker = this.ensureWorker()
    const messageId = this.nextMessageId++

    const promise = new Promise<CachedEmbeddingResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.activeRequests.delete(messageId)
        if (this.worker === worker) {
          this.terminateWorker(worker)
        }
        reject(new SearchTimeoutError('Query text embedding timed out'))
      }, this.requestTimeoutMs)

      this.activeRequests.set(messageId, {
        id: messageId,
        generation,
        resolve: (msg: WorkerResponseMessage) => {
          if (!msg.vector) {
            reject(new Error(msg.message ?? 'Worker failed to return embedding vector'))
            return
          }
          const result: CachedEmbeddingResult = {
            vector: msg.vector,
            truncated: Boolean(msg.truncated),
            tokenCount: Number(msg.tokenCount ?? 0)
          }
          this.cachedEmbeddingResult = result
          this.embeddingInFlightPromise = null
          resolve(result)
        },
        reject: (err) => {
          this.embeddingInFlightPromise = null
          reject(err)
        },
        timer
      })

      worker.postMessage({
        id: messageId,
        action: 'embed_text',
        modelDir,
        queryText
      })
    })

    this.embeddingInFlightPromise = promise
    return promise
  }

  public async search(request: SemanticSearchRequest): Promise<SemanticSearchResponse> {
    const t0 = performance.now()
    const queryText = (request.queryText ?? '').trim()
    const limit = Math.min(Math.max(1, request.limit ?? 50), 100)
    const offset = Math.max(0, request.offset ?? 0)
    const minScore = request.minScore ?? 0.0

    // 1. Check model status
    const modelStatus = this.modelManager.getStatus()
    if (modelStatus.state !== 'ready') {
      const filterOptions = {
        category: 'photo' as const,
        ratingFilter: request.ratingFilter,
        flagFilter: request.flagFilter,
        collectionId: request.collectionId,
        captureDateFrom: request.captureDateFrom,
        captureDateTo: request.captureDateTo,
        includeUnknownCaptureDate: request.includeUnknownCaptureDate,
        cameraNormalized: request.cameraNormalized,
        onlyUnknownCamera: request.onlyUnknownCamera,
        lensNormalized: request.lensNormalized,
        onlyUnknownLens: request.onlyUnknownLens,
        minWidthPx: request.minWidthPx,
        minHeightPx: request.minHeightPx,
        includeUnknownDimensions: request.includeUnknownDimensions,
        fileTypeBasis: request.fileTypeBasis,
        fileTypeValue: request.fileTypeValue,
        onlyUnknownDetectedFormat: request.onlyUnknownDetectedFormat
      }
      const page = this.catalog.queryFileLocations(filterOptions)

      return {
        items: [],
        totalMatched: 0,
        eligibleCount: 0,
        unindexedCount: page.totalCount,
        staleCount: 0,
        offset,
        limit,
        hasMore: false,
        queryLatencyMs: performance.now() - t0,
        truncated: false,
        tokenCount: 0,
        modelStatus:
          modelStatus.state === 'missing'
            ? 'unprovisioned'
            : modelStatus.state === 'error'
              ? 'error'
              : 'corrupt'
      }
    }

    const modelDir = this.modelManager.getActiveModelInstallDir()
    if (!modelDir) {
      return {
        items: [],
        totalMatched: 0,
        eligibleCount: 0,
        unindexedCount: 0,
        staleCount: 0,
        offset,
        limit,
        hasMore: false,
        queryLatencyMs: performance.now() - t0,
        truncated: false,
        tokenCount: 0,
        modelStatus: 'unprovisioned'
      }
    }

    // 2. Query Generation Management
    const queryKey = computeQueryKey(queryText, request)
    let requestGen: number

    if (this.activeQueryKey !== queryKey) {
      // New query generation!
      this.currentQueryGeneration++
      this.activeQueryKey = queryKey
      this.cachedEmbeddingResult = null
      this.embeddingInFlightPromise = null
      requestGen = this.currentQueryGeneration

      // Reject all pending requests from older query generations
      for (const [id, req] of this.activeRequests.entries()) {
        if (req.generation < requestGen) {
          clearTimeout(req.timer)
          this.activeRequests.delete(id)
          req.reject(new SearchCancelledError('Search superseded by a newer query'))
        }
      }

      // If active worker was busy with an older query, terminate it to free up CPU
      if (this.worker && this.activeRequests.size > 0) {
        this.terminateWorker(this.worker)
      }
    } else {
      requestGen = this.currentQueryGeneration
    }

    // 3. Obtain query vector off main thread (deduplicating concurrent page requests)
    const embedding = await this.getOrEmbedQuery(modelDir, queryText, requestGen)

    // Guard against supersession during text embedding
    if (requestGen !== this.currentQueryGeneration || this.isShuttingDown) {
      throw new SearchCancelledError('Search superseded by a newer query')
    }

    // 4. Stream and rank candidates in search worker
    const worker = this.ensureWorker()
    const messageId = this.nextMessageId++
    const catalogPath = this.catalog.getCatalogPath()

    const searchDbPromise = new Promise<{
      rankedItems: readonly { fileLocationId: number; score: number }[]
      totalMatched: number
      eligibleCount: number
      unindexedCount: number
      staleCount: number
      offset: number
      limit: number
      hasMore: boolean
      queryLatencyMs: number
    }>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.activeRequests.delete(messageId)
        if (this.worker === worker) {
          this.terminateWorker(worker)
        }
        rejectPromise(new SearchTimeoutError(`Search request ${messageId} timed out`))
      }, this.requestTimeoutMs)

      this.activeRequests.set(messageId, {
        id: messageId,
        generation: requestGen,
        resolve: (res) => {
          resolvePromise({
            rankedItems: res.rankedItems ?? [],
            totalMatched: res.totalMatched ?? 0,
            eligibleCount: res.eligibleCount ?? 0,
            unindexedCount: res.unindexedCount ?? 0,
            staleCount: res.staleCount ?? 0,
            offset: res.offset ?? offset,
            limit: res.limit ?? limit,
            hasMore: res.hasMore ?? false,
            queryLatencyMs: res.queryLatencyMs ?? 0
          })
        },
        reject: rejectPromise,
        timer
      })
    })

    worker.postMessage({
      id: messageId,
      action: 'search_database',
      catalogPath,
      queryVector: embedding.vector,
      filters: {
        category: 'photo',
        ratingFilter: request.ratingFilter,
        flagFilter: request.flagFilter,
        collectionId: request.collectionId,
        captureDateFrom: request.captureDateFrom,
        captureDateTo: request.captureDateTo,
        includeUnknownCaptureDate: request.includeUnknownCaptureDate,
        cameraNormalized: request.cameraNormalized,
        onlyUnknownCamera: request.onlyUnknownCamera,
        lensNormalized: request.lensNormalized,
        onlyUnknownLens: request.onlyUnknownLens,
        minWidthPx: request.minWidthPx,
        minHeightPx: request.minHeightPx,
        includeUnknownDimensions: request.includeUnknownDimensions,
        fileTypeBasis: request.fileTypeBasis,
        fileTypeValue: request.fileTypeValue,
        onlyUnknownDetectedFormat: request.onlyUnknownDetectedFormat
      },
      limit,
      offset,
      minScore
    })

    const workerResult = await searchDbPromise

    // Guard against supersession during candidate traversal and ranking
    if (requestGen !== this.currentQueryGeneration || this.isShuttingDown) {
      throw new SearchCancelledError('Search superseded by a newer query')
    }

    // 5. Hydrate top-K photos on main process and revalidate identity
    const items: SemanticSearchResultItem[] = []
    for (let i = 0; i < workerResult.rankedItems.length; i++) {
      const match = workerResult.rankedItems[i]
      if (match) {
        const photo = this.catalog.getFileLocationById(match.fileLocationId)
        if (photo && photo.category === 'photo' && photo.discoveryObservationId > 0) {
          items.push({
            photo: {
              id: photo.id,
              sourceId: photo.sourceId,
              originalPath: photo.originalPath,
              fileName: photo.fileName,
              extension: photo.extension,
              category: 'photo',
              discoveryObservationId: photo.discoveryObservationId,
              byteSize: photo.byteSize,
              filesystemBirthtimeMs: photo.filesystemBirthtimeMs,
              filesystemMtimeMs: photo.filesystemMtimeMs,
              inferredCaptureTimeMs: photo.inferredCaptureTimeMs,
              firstDiscoveredAtMs: photo.firstDiscoveredAtMs,
              lastSeenAtMs: photo.lastSeenAtMs,
              activeHash: photo.activeHash,
              activeHashVerifiedAtMs: photo.activeHashVerifiedAtMs,
              rating: photo.rating ?? null,
              flag: photo.flag ?? 'none',
              annotationVersion: photo.annotationVersion ?? 0
            },
            score: match.score,
            rank: offset + i + 1
          })
        }
      }
    }

    return {
      items,
      totalMatched: workerResult.totalMatched,
      eligibleCount: workerResult.eligibleCount,
      unindexedCount: workerResult.unindexedCount,
      staleCount: workerResult.staleCount,
      offset,
      limit,
      hasMore: workerResult.hasMore,
      queryLatencyMs: performance.now() - t0,
      truncated: embedding.truncated,
      tokenCount: embedding.tokenCount,
      modelStatus: 'ready'
    }
  }
}
