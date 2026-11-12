/**
 * Personal Vault — Semantic Search Coordinator (Stage 6D)
 *
 * Coordinates natural-language photo search requests off Electron main.
 * Manages dedicated search worker lifecycle, rapid replacement cancellation,
 * query validation, model status checks, and photo record hydration.
 */

import type { CatalogDatabase } from '../catalog/database'
import type { SemanticModelManager } from './model-manager'
import { embedQueryText, releaseTextSession } from './text-embedder'
import type {
  SemanticSearchRequest,
  SemanticSearchResponse,
  SemanticSearchResultItem
} from '../../../shared/validation/ipc-schemas'

export interface SemanticSearchCoordinatorOptions {
  readonly catalog: CatalogDatabase
  readonly modelManager: SemanticModelManager
}

export class SemanticSearchCoordinator {
  private readonly catalog: CatalogDatabase
  private readonly modelManager: SemanticModelManager

  private activeToken = 0
  private isShuttingDown = false

  constructor(options: SemanticSearchCoordinatorOptions) {
    this.catalog = options.catalog
    this.modelManager = options.modelManager
  }

  public async shutdown(): Promise<void> {
    this.isShuttingDown = true
    this.activeToken++
    await releaseTextSession()
  }

  public cancelActiveSearch(): void {
    this.activeToken++
  }

  public async search(request: SemanticSearchRequest): Promise<SemanticSearchResponse> {
    const requestToken = ++this.activeToken
    const t0 = performance.now()

    const queryText = (request.queryText ?? '').trim()
    const limit = Math.min(Math.max(1, request.limit ?? 50), 100)
    const offset = Math.max(0, request.offset ?? 0)
    const minScore = request.minScore ?? 0.0

    // 1. Check model status
    const modelStatus = this.modelManager.getStatus()
    if (modelStatus.state !== 'ready') {
      // Model not installed or error -> honest response
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

    // 2. Embed query text off main thread
    const embedResult = await embedQueryText({
      modelDir,
      queryText
    })

    if (requestToken !== this.activeToken || this.isShuttingDown) {
      // Superseded or cancelled
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
        modelStatus: 'ready'
      }
    }

    if (embedResult.status !== 'ready') {
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
        modelStatus: embedResult.code === 'MISSING_MODEL' ? 'unprovisioned' : 'error'
      }
    }

    // 3. Search and rank candidates
    const searchCatalogResult = await this.catalog.searchPhotosSemantic({
      queryVector: embedResult.vector,
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

    if (requestToken !== this.activeToken || this.isShuttingDown) {
      // Superseded or cancelled
      return {
        items: [],
        totalMatched: 0,
        eligibleCount: searchCatalogResult.eligibleCount,
        unindexedCount: searchCatalogResult.unindexedCount,
        staleCount: searchCatalogResult.staleCount,
        offset,
        limit,
        hasMore: false,
        queryLatencyMs: performance.now() - t0,
        truncated: embedResult.truncated,
        tokenCount: embedResult.tokenCount,
        modelStatus: 'ready'
      }
    }

    const items: SemanticSearchResultItem[] = searchCatalogResult.items.map((item) => ({
      photo: {
        id: item.photo.id,
        sourceId: item.photo.sourceId,
        originalPath: item.photo.originalPath,
        fileName: item.photo.fileName,
        extension: item.photo.extension,
        category: 'photo',
        discoveryObservationId: item.photo.discoveryObservationId,
        byteSize: item.photo.byteSize,
        filesystemBirthtimeMs: item.photo.filesystemBirthtimeMs,
        filesystemMtimeMs: item.photo.filesystemMtimeMs,
        inferredCaptureTimeMs: item.photo.inferredCaptureTimeMs,
        firstDiscoveredAtMs: item.photo.firstDiscoveredAtMs,
        lastSeenAtMs: item.photo.lastSeenAtMs,
        activeHash: item.photo.activeHash,
        activeHashVerifiedAtMs: item.photo.activeHashVerifiedAtMs,
        rating: item.photo.rating ?? null,
        flag: item.photo.flag ?? 'none',
        annotationVersion: item.photo.annotationVersion ?? 0
      },
      score: item.score,
      rank: item.rank
    }))

    return {
      items,
      totalMatched: searchCatalogResult.totalMatched,
      eligibleCount: searchCatalogResult.eligibleCount,
      unindexedCount: searchCatalogResult.unindexedCount,
      staleCount: searchCatalogResult.staleCount,
      offset,
      limit,
      hasMore: searchCatalogResult.hasMore,
      queryLatencyMs: performance.now() - t0,
      truncated: embedResult.truncated,
      tokenCount: embedResult.tokenCount,
      modelStatus: 'ready'
    }
  }
}
