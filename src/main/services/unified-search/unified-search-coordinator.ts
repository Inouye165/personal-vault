/**
 * Personal Vault — Stage 7F Slice 1: Unified Search Coordinator & Ownership Gate
 *
 * Enforces single-visible-surface ownership ('unified' | 'photos-tab' | 'documents-tab')
 * across SemanticSearchCoordinator and DocumentSearchCoordinator without holding any
 * AppWorkerBudget slots of its own.
 */

import type {
  DocSemanticSearchRequest,
  DocSemanticSearchResponseDto,
  SemanticSearchRequest,
  SemanticSearchResponse,
  SearchOwnerSurface,
  UnifiedSearchCancelRequest,
  UnifiedSearchCancelResponse,
  UnifiedSearchDocumentsRequest,
  UnifiedSearchDocumentsResponse,
  UnifiedSearchPhotosRequest,
  UnifiedSearchPhotosResponse,
  UnifiedSearchStatus
} from '../../../shared/validation/ipc-schemas'
import {
  SearchCancelledError,
  SearchOverloadError,
  SearchTimeoutError,
  type SemanticSearchCoordinator
} from '../semantic/search-coordinator'
import {
  DocSearchCancelledError,
  DocSearchOverloadError,
  type DocumentSearchCoordinator,
  type DocumentSearchRequest
} from '../documents/semantic/search-coordinator'
import { DocSemanticModelUnavailableError } from '../documents/semantic/model-manager'

const CLIP_MODEL_ID = 'Xenova/clip-vit-base-patch32' as const
const BGE_MODEL_ID = 'Xenova/bge-small-en-v1.5' as const

interface SurfaceOwnerState {
  retiredUpToGen: number
  highestAcceptedGen: number
}

interface ActiveOwnerRecord {
  readonly surface: SearchOwnerSurface
  readonly ownerGen: number
  readonly serverSeq: number
}

interface ModalityOwnerState {
  activeOwner: ActiveOwnerRecord | null
  readonly surfaces: Record<SearchOwnerSurface, SurfaceOwnerState>
}

function createModalityOwnerState(): ModalityOwnerState {
  return {
    activeOwner: null,
    surfaces: {
      unified: { retiredUpToGen: -1, highestAcceptedGen: -1 },
      'photos-tab': { retiredUpToGen: -1, highestAcceptedGen: -1 },
      'documents-tab': { retiredUpToGen: -1, highestAcceptedGen: -1 }
    }
  }
}

export interface UnifiedSearchCoordinatorOptions {
  readonly semanticSearchCoordinator?: SemanticSearchCoordinator | null
  readonly docSearchCoordinator?: DocumentSearchCoordinator | null
}

export class UnifiedSearchCoordinator {
  private readonly semanticSearchCoordinator: SemanticSearchCoordinator | null
  private readonly docSearchCoordinator: DocumentSearchCoordinator | null
  private readonly photosState: ModalityOwnerState = createModalityOwnerState()
  private readonly documentsState: ModalityOwnerState = createModalityOwnerState()
  private nextServerSeq = 1
  private isShutdown = false

  public constructor(options: UnifiedSearchCoordinatorOptions = {}) {
    this.semanticSearchCoordinator = options.semanticSearchCoordinator ?? null
    this.docSearchCoordinator = options.docSearchCoordinator ?? null
  }

  private acquireOwnership(
    state: ModalityOwnerState,
    surface: SearchOwnerSurface,
    rawOwnerGen?: number
  ): { readonly serverSeq: number; readonly ownerGen: number } | null {
    if (this.isShutdown) return null

    const surfaceState = state.surfaces[surface]
    const ownerGen =
      rawOwnerGen !== undefined
        ? rawOwnerGen
        : state.activeOwner?.surface === surface
          ? state.activeOwner.ownerGen
          : Math.max(surfaceState.highestAcceptedGen, surfaceState.retiredUpToGen) + 1

    if (ownerGen <= surfaceState.retiredUpToGen || ownerGen < surfaceState.highestAcceptedGen) {
      return null
    }

    surfaceState.highestAcceptedGen = Math.max(surfaceState.highestAcceptedGen, ownerGen)

    const prev = state.activeOwner
    if (prev && (prev.surface !== surface || prev.ownerGen !== ownerGen)) {
      state.surfaces[prev.surface].retiredUpToGen = Math.max(
        state.surfaces[prev.surface].retiredUpToGen,
        prev.ownerGen
      )
      const serverSeq = this.nextServerSeq++
      state.activeOwner = { surface, ownerGen, serverSeq }
      return { serverSeq, ownerGen }
    }

    if (!prev) {
      const serverSeq = this.nextServerSeq++
      state.activeOwner = { surface, ownerGen, serverSeq }
      return { serverSeq, ownerGen }
    }

    return { serverSeq: prev.serverSeq, ownerGen }
  }

  private isOwnershipCurrent(state: ModalityOwnerState, serverSeq: number): boolean {
    return !this.isShutdown && state.activeOwner?.serverSeq === serverSeq
  }

  private retireSurfaceGen(
    state: ModalityOwnerState,
    surface: SearchOwnerSurface,
    ownerGen: number
  ): void {
    state.surfaces[surface].retiredUpToGen = Math.max(
      state.surfaces[surface].retiredUpToGen,
      ownerGen
    )
  }

  public async searchPhotos(
    request: UnifiedSearchPhotosRequest
  ): Promise<UnifiedSearchPhotosResponse> {
    const acquired = this.acquireOwnership(this.photosState, 'unified', request.ownerGen)
    if (!acquired) {
      return {
        status: 'cancelled',
        modelId: CLIP_MODEL_ID,
        result: null,
        errorMessage: null
      }
    }

    if (!this.semanticSearchCoordinator) {
      return {
        status: 'unprovisioned',
        modelId: CLIP_MODEL_ID,
        result: null,
        errorMessage: 'Photo semantic search is unavailable'
      }
    }

    const filters = request.photoFilters
    const mapped: SemanticSearchRequest = {
      queryText: request.query,
      offset: request.offset ?? 0,
      limit: request.limit ?? 20,
      minScore: filters?.minScore ?? 0.0,
      ratingFilter: filters?.ratingFilter ?? 'all',
      flagFilter: filters?.flagFilter ?? 'all',
      collectionId: filters?.collectionId ?? null,
      captureDateFrom: filters?.captureDateFrom ?? null,
      captureDateTo: filters?.captureDateTo ?? null,
      includeUnknownCaptureDate: filters?.includeUnknownCaptureDate ?? false,
      cameraNormalized: filters?.cameraNormalized ?? null,
      onlyUnknownCamera: filters?.onlyUnknownCamera ?? false,
      lensNormalized: filters?.lensNormalized ?? null,
      onlyUnknownLens: filters?.onlyUnknownLens ?? false,
      minWidthPx: filters?.minWidthPx ?? null,
      minHeightPx: filters?.minHeightPx ?? null,
      includeUnknownDimensions: filters?.includeUnknownDimensions ?? false,
      fileTypeBasis: filters?.fileTypeBasis ?? 'detected_format',
      fileTypeValue: filters?.fileTypeValue ?? null,
      onlyUnknownDetectedFormat: filters?.onlyUnknownDetectedFormat ?? false
    }

    try {
      const result = await this.semanticSearchCoordinator.search(mapped)
      if (!this.isOwnershipCurrent(this.photosState, acquired.serverSeq)) {
        return {
          status: 'cancelled',
          modelId: CLIP_MODEL_ID,
          result: null,
          errorMessage: null
        }
      }

      const status: UnifiedSearchStatus = result.modelStatus
      return {
        status,
        modelId: CLIP_MODEL_ID,
        result,
        errorMessage: status === 'error' ? 'Photo semantic model error' : null
      }
    } catch (err) {
      if (
        err instanceof SearchCancelledError ||
        !this.isOwnershipCurrent(this.photosState, acquired.serverSeq)
      ) {
        return {
          status: 'cancelled',
          modelId: CLIP_MODEL_ID,
          result: null,
          errorMessage: null
        }
      }
      if (err instanceof SearchTimeoutError) {
        return {
          status: 'timed_out',
          modelId: CLIP_MODEL_ID,
          result: null,
          errorMessage: err.message
        }
      }
      if (err instanceof SearchOverloadError) {
        return {
          status: 'overloaded',
          modelId: CLIP_MODEL_ID,
          result: null,
          errorMessage: err.message
        }
      }
      return {
        status: 'error',
        modelId: CLIP_MODEL_ID,
        result: null,
        errorMessage: err instanceof Error ? err.message : String(err)
      }
    }
  }

  public async searchDocuments(
    request: UnifiedSearchDocumentsRequest
  ): Promise<UnifiedSearchDocumentsResponse> {
    const acquired = this.acquireOwnership(this.documentsState, 'unified', request.ownerGen)
    if (!acquired) {
      return {
        status: 'cancelled',
        modelId: BGE_MODEL_ID,
        result: null,
        errorMessage: null
      }
    }

    if (!this.docSearchCoordinator) {
      return {
        status: 'unprovisioned',
        modelId: BGE_MODEL_ID,
        result: null,
        errorMessage: 'Document semantic search is unavailable'
      }
    }

    const filters = request.documentFilters
    const mapped: DocumentSearchRequest = {
      query: request.query,
      offset: request.offset ?? 0,
      limit: request.limit ?? 20,
      extensionFilter: filters?.extensionFilter,
      filenameQuery: filters?.filenameQuery,
      textSourceKindFilter: filters?.textSourceKindFilter,
      purposeFilter: filters?.purposeFilter,
      originFilter: filters?.originFilter,
      clutterFilter: filters?.clutterFilter
    }

    try {
      const result = await this.docSearchCoordinator.search(mapped)
      if (!this.isOwnershipCurrent(this.documentsState, acquired.serverSeq)) {
        return {
          status: 'cancelled',
          modelId: BGE_MODEL_ID,
          result: null,
          errorMessage: null
        }
      }
      return {
        status: 'ready',
        modelId: BGE_MODEL_ID,
        result: result as DocSemanticSearchResponseDto,
        errorMessage: null
      }
    } catch (err) {
      if (
        err instanceof DocSearchCancelledError ||
        !this.isOwnershipCurrent(this.documentsState, acquired.serverSeq)
      ) {
        return {
          status: 'cancelled',
          modelId: BGE_MODEL_ID,
          result: null,
          errorMessage: null
        }
      }
      if (err instanceof DocSemanticModelUnavailableError) {
        return {
          status: err.code === 'DOC_MODEL_MISSING' ? 'unprovisioned' : 'corrupt',
          modelId: BGE_MODEL_ID,
          result: null,
          errorMessage: err.message
        }
      }
      const code = (err as { code?: string } | null)?.code
      if (code === 'WORKER_TIMEOUT') {
        return {
          status: 'timed_out',
          modelId: BGE_MODEL_ID,
          result: null,
          errorMessage: err instanceof Error ? err.message : String(err)
        }
      }
      if (err instanceof DocSearchOverloadError) {
        const isBudgetExhausted = /exhausted/i.test(err.message)
        return {
          status: isBudgetExhausted ? 'timed_out' : 'overloaded',
          modelId: BGE_MODEL_ID,
          result: null,
          errorMessage: err.message
        }
      }
      return {
        status: 'error',
        modelId: BGE_MODEL_ID,
        result: null,
        errorMessage: err instanceof Error ? err.message : String(err)
      }
    }
  }

  public async searchPhotosFromTab(
    request: SemanticSearchRequest
  ): Promise<SemanticSearchResponse> {
    const { ownerGen, ...searchReq } = request
    const acquired = this.acquireOwnership(this.photosState, 'photos-tab', ownerGen)
    if (!acquired) {
      throw new SearchCancelledError('Photo search superseded by a newer owner')
    }
    if (!this.semanticSearchCoordinator) {
      return {
        items: [],
        totalMatched: 0,
        offset: searchReq.offset ?? 0,
        limit: searchReq.limit ?? 50,
        hasMore: false,
        eligibleCount: 0,
        unindexedCount: 0,
        staleCount: 0,
        corruptCount: 0,
        modelStatus: 'unprovisioned',
        tokenCount: 0,
        truncated: false,
        queryLatencyMs: 0
      }
    }
    const result = await this.semanticSearchCoordinator.search(searchReq)
    if (!this.isOwnershipCurrent(this.photosState, acquired.serverSeq)) {
      throw new SearchCancelledError('Photo search superseded by a newer owner')
    }
    return result
  }

  public async searchDocumentsFromTab(
    request: DocSemanticSearchRequest
  ): Promise<DocSemanticSearchResponseDto> {
    const { ownerGen, ...searchReq } = request
    const acquired = this.acquireOwnership(this.documentsState, 'documents-tab', ownerGen)
    if (!acquired) {
      throw new DocSearchCancelledError('Document search superseded by a newer owner')
    }
    if (!this.docSearchCoordinator) {
      throw new Error('Document search coordinator is not initialized')
    }
    const result = await this.docSearchCoordinator.search(searchReq)
    if (!this.isOwnershipCurrent(this.documentsState, acquired.serverSeq)) {
      throw new DocSearchCancelledError('Document search superseded by a newer owner')
    }
    return result as DocSemanticSearchResponseDto
  }

  public async cancel(request: UnifiedSearchCancelRequest): Promise<UnifiedSearchCancelResponse> {
    const modality = request.modality ?? 'all'
    let shouldCancelPhotos = false
    let shouldCancelDocuments = false

    // Synchronously retire and clear ownership across all targeted modalities before awaiting
    if (modality === 'all' || modality === 'photos') {
      this.retireSurfaceGen(this.photosState, request.ownerSurface, request.ownerGen)
      const active = this.photosState.activeOwner
      if (
        active &&
        active.surface === request.ownerSurface &&
        active.ownerGen === request.ownerGen
      ) {
        this.photosState.activeOwner = null
        shouldCancelPhotos = true
      }
    }

    if (modality === 'all' || modality === 'documents') {
      this.retireSurfaceGen(this.documentsState, request.ownerSurface, request.ownerGen)
      const active = this.documentsState.activeOwner
      if (
        active &&
        active.surface === request.ownerSurface &&
        active.ownerGen === request.ownerGen
      ) {
        this.documentsState.activeOwner = null
        shouldCancelDocuments = true
      }
    }

    const tasks: Promise<void>[] = []
    if (shouldCancelPhotos && this.semanticSearchCoordinator) {
      tasks.push(this.semanticSearchCoordinator.cancelActiveSearch())
    }
    if (shouldCancelDocuments && this.docSearchCoordinator) {
      tasks.push(this.docSearchCoordinator.cancelSearch('Unified search cancelled'))
    }
    await Promise.all(tasks)

    return { cancelled: shouldCancelPhotos || shouldCancelDocuments }
  }

  public async cancelPhotosFromTab(ownerGen?: number): Promise<{ cancelled: boolean }> {
    if (ownerGen !== undefined) {
      return this.cancel({ ownerSurface: 'photos-tab', ownerGen, modality: 'photos' })
    }
    const active = this.photosState.activeOwner
    if (active && active.surface !== 'photos-tab') {
      return { cancelled: false }
    }
    if (active && active.surface === 'photos-tab') {
      this.retireSurfaceGen(this.photosState, 'photos-tab', active.ownerGen)
      this.photosState.activeOwner = null
    }
    await this.semanticSearchCoordinator?.cancelActiveSearch()
    return { cancelled: true }
  }

  public async cancelDocumentsFromTab(ownerGen?: number): Promise<{ cancelled: boolean }> {
    if (!this.docSearchCoordinator) {
      throw new Error('Document search coordinator is not initialized')
    }
    if (ownerGen !== undefined) {
      return this.cancel({ ownerSurface: 'documents-tab', ownerGen, modality: 'documents' })
    }
    const active = this.documentsState.activeOwner
    if (active && active.surface !== 'documents-tab') {
      return { cancelled: false }
    }
    if (active && active.surface === 'documents-tab') {
      this.retireSurfaceGen(this.documentsState, 'documents-tab', active.ownerGen)
      this.documentsState.activeOwner = null
    }
    await this.docSearchCoordinator.cancelSearch()
    return { cancelled: true }
  }

  public getOwnershipDiagnostics() {
    return {
      photosActiveOwner: this.photosState.activeOwner,
      documentsActiveOwner: this.documentsState.activeOwner
    }
  }

  public async shutdown(): Promise<void> {
    this.isShutdown = true
    this.photosState.activeOwner = null
    this.documentsState.activeOwner = null
  }
}
