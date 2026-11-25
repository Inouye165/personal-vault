import { performance } from 'node:perf_hooks'
import type { CatalogDatabase } from '../catalog/database'
import type { QueryFileLocationsOptions } from '../catalog/types'
import { METADATA_PARSER_RECIPE_VERSION } from '../metadata/types'
import type { PhotoMetadataCoordinator } from '../metadata/coordinator'
import type { SemanticModelManager } from '../semantic/model-manager'
import type { UnifiedSearchCoordinator } from '../unified-search/unified-search-coordinator'
import type {
  InterpretedSearchFilters,
  MetadataAwarePhotoSearchRequest,
  MetadataAwarePhotoSearchResponse,
  MetadataAwareSearchResultItem,
  PhotoItem
} from '../../../shared/validation/ipc-schemas'
import { interpretPhotoQuery } from './photo-query-parser'

export interface PhotoSearchCoordinatorDeps {
  readonly catalog: CatalogDatabase
  readonly unifiedSearchCoordinator: UnifiedSearchCoordinator | null
  readonly semanticModelManager: SemanticModelManager | null
  readonly photoMetadataCoordinator?: PhotoMetadataCoordinator | null
}

function mapModelStateToDto(
  state: string | undefined
): 'ready' | 'unprovisioned' | 'corrupt' | 'error' {
  if (state === 'ready') return 'ready'
  if (state === 'error') return 'error'
  return 'unprovisioned'
}

function buildSqlFilterOptions(
  request: MetadataAwarePhotoSearchRequest,
  filters: InterpretedSearchFilters,
  parserRecipeVersion: string
): QueryFileLocationsOptions {
  const place = filters.place
  const date = filters.date
  const camera = filters.camera

  return {
    category: 'photo',
    parserRecipeVersion,
    ratingFilter: request.ratingFilter ?? 'all',
    flagFilter: request.flagFilter ?? 'all',
    collectionId: request.collectionId ?? null,
    captureDateFrom: date?.captureDateFrom ?? request.captureDateFrom ?? null,
    captureDateTo: date?.captureDateTo ?? request.captureDateTo ?? null,
    captureMonth: date?.captureMonth ?? null,
    captureDay: date?.captureDay ?? null,
    includeUnknownCaptureDate: request.includeUnknownCaptureDate ?? false,
    gpsBounds: place?.gpsBounds ?? null,
    userPlaceId: place?.savedPlaceId ?? null,
    userPlaceLabel: place ? place.normalizedLabel : null,
    cameraNormalized: camera?.cameraNormalized ?? request.cameraNormalized ?? null,
    onlyUnknownCamera: request.onlyUnknownCamera ?? false,
    lensNormalized: request.lensNormalized ?? null,
    onlyUnknownLens: request.onlyUnknownLens ?? false,
    minWidthPx: request.minWidthPx ?? null,
    minHeightPx: request.minHeightPx ?? null,
    includeUnknownDimensions: request.includeUnknownDimensions ?? false,
    fileTypeBasis: request.fileTypeBasis ?? 'detected_format',
    fileTypeValue: request.fileTypeValue ?? null,
    onlyUnknownDetectedFormat: request.onlyUnknownDetectedFormat ?? false
  }
}

export class PhotoSearchCoordinator {
  constructor(private readonly deps: PhotoSearchCoordinatorDeps) {}

  async search(
    request: MetadataAwarePhotoSearchRequest
  ): Promise<MetadataAwarePhotoSearchResponse> {
    const t0 = performance.now()
    const offset = request.offset ?? 0
    const limit = request.limit ?? 50
    const parserRecipeVersion =
      this.deps.photoMetadataCoordinator?.getParserRecipeVersion() ?? METADATA_PARSER_RECIPE_VERSION
    const modelStatus = mapModelStateToDto(this.deps.semanticModelManager?.getStatus().state)

    let interpretedFilters: InterpretedSearchFilters
    let clarification = null

    if (request.filterOverrides) {
      interpretedFilters = {
        place: request.filterOverrides.place ?? null,
        date: request.filterOverrides.date ?? null,
        camera: request.filterOverrides.camera ?? null,
        visualTerms: request.filterOverrides.visualTerms ?? null
      }
    } else {
      const savedEvents = this.deps.catalog.listSavedEvents()
      const savedPlaces = this.deps.catalog.listSavedPlaces()
      const cameraLabels = this.deps.catalog.listCameraLabels()
      const cameraFacets = this.deps.catalog.getPhotoMetadataFacets({
        field: 'camera',
        parserRecipeVersion,
        limit: 200,
        offset: 0
      })

      const interpreted = interpretPhotoQuery({
        queryText: request.queryText ?? '',
        savedEvents,
        savedPlaces,
        knownCameras: cameraFacets.items,
        cameraLabels
      })
      interpretedFilters = interpreted.interpretedFilters
      clarification = interpreted.clarification
    }

    if (clarification) {
      return {
        mode: 'needs_clarification',
        items: [],
        totalMatched: 0,
        filteredCandidateCount: 0,
        eligibleCount: 0,
        unindexedCount: 0,
        staleCount: 0,
        corruptCount: 0,
        offset,
        limit,
        hasMore: false,
        queryLatencyMs: performance.now() - t0,
        interpretedFilters,
        clarification,
        visualModelRequired: false,
        modelStatus
      }
    }

    const sqlFilters = buildSqlFilterOptions(request, interpretedFilters, parserRecipeVersion)
    const hasVisualTerms = Boolean(
      interpretedFilters.visualTerms && interpretedFilters.visualTerms.trim().length > 0
    )
    const hasStructuredFilters = Boolean(
      interpretedFilters.place ||
      interpretedFilters.date ||
      interpretedFilters.camera ||
      request.captureDateFrom ||
      request.captureDateTo ||
      request.cameraNormalized ||
      request.lensNormalized ||
      request.onlyUnknownCamera ||
      request.onlyUnknownLens ||
      request.onlyUnknownDetectedFormat ||
      request.fileTypeValue ||
      request.minWidthPx ||
      request.minHeightPx ||
      request.includeUnknownCaptureDate ||
      request.includeUnknownDimensions ||
      (request.ratingFilter && request.ratingFilter !== 'all') ||
      (request.flagFilter && request.flagFilter !== 'all') ||
      request.collectionId
    )

    // Path A: Pure metadata query or explicit visual-model bypass -> SQL-only execution, zero visual model usage
    if (!hasVisualTerms || request.bypassVisualModel) {
      const page = this.deps.catalog.queryFileLocations({
        ...sqlFilters,
        offset,
        limit
      })
      const items: MetadataAwareSearchResultItem[] = page.items.map((photo, idx) => ({
        photo: photo as PhotoItem,
        score: null,
        rank: offset + idx + 1,
        matchSource: 'metadata'
      }))

      return {
        mode: 'metadata_only',
        items,
        totalMatched: page.totalCount,
        filteredCandidateCount: page.totalCount,
        eligibleCount: page.totalCount,
        unindexedCount: 0,
        staleCount: 0,
        corruptCount: 0,
        offset: page.offset,
        limit: page.limit,
        hasMore: page.hasMore,
        queryLatencyMs: performance.now() - t0,
        interpretedFilters,
        clarification: null,
        visualModelRequired: false,
        modelStatus
      }
    }

    // Path B: Visual or Hybrid search — compute SQL-filtered candidate set FIRST before visual model checks / ranking
    const filteredSummary = this.deps.catalog.queryFileLocations({
      ...sqlFilters,
      offset: 0,
      limit: 1
    })
    const filteredCandidateCount = filteredSummary.totalCount
    const mode = hasStructuredFilters ? 'hybrid' : 'visual_only'

    if (filteredCandidateCount === 0) {
      return {
        mode,
        items: [],
        totalMatched: 0,
        filteredCandidateCount: 0,
        eligibleCount: 0,
        unindexedCount: 0,
        staleCount: 0,
        corruptCount: 0,
        offset,
        limit,
        hasMore: false,
        queryLatencyMs: performance.now() - t0,
        interpretedFilters,
        clarification: null,
        visualModelRequired: false,
        modelStatus
      }
    }

    if (modelStatus !== 'ready' || !this.deps.unifiedSearchCoordinator) {
      return {
        mode,
        items: [],
        totalMatched: 0,
        filteredCandidateCount,
        eligibleCount: 0,
        unindexedCount: filteredCandidateCount,
        staleCount: 0,
        corruptCount: 0,
        offset,
        limit,
        hasMore: false,
        queryLatencyMs: performance.now() - t0,
        interpretedFilters,
        clarification: null,
        visualModelRequired: true,
        modelStatus
      }
    }

    // Delegate visual ranking with ALL SQL location/date/camera filters attached so SQL filters
    // narrow the candidate set BEFORE cosine similarity top-K ranking runs.
    const semanticResponse = await this.deps.unifiedSearchCoordinator.searchPhotosFromTab({
      queryText: interpretedFilters.visualTerms!.trim(),
      offset,
      limit,
      minScore: request.minScore ?? 0.0,
      ratingFilter: request.ratingFilter ?? 'all',
      flagFilter: request.flagFilter ?? 'all',
      collectionId: request.collectionId ?? null,
      captureDateFrom: sqlFilters.captureDateFrom ?? null,
      captureDateTo: sqlFilters.captureDateTo ?? null,
      captureMonth: sqlFilters.captureMonth ?? null,
      captureDay: sqlFilters.captureDay ?? null,
      includeUnknownCaptureDate: sqlFilters.includeUnknownCaptureDate ?? false,
      gpsBounds: sqlFilters.gpsBounds ?? null,
      userPlaceId: sqlFilters.userPlaceId ?? null,
      userPlaceLabel: sqlFilters.userPlaceLabel ?? null,
      cameraNormalized: sqlFilters.cameraNormalized ?? null,
      onlyUnknownCamera: sqlFilters.onlyUnknownCamera ?? false,
      lensNormalized: sqlFilters.lensNormalized ?? null,
      onlyUnknownLens: sqlFilters.onlyUnknownLens ?? false,
      minWidthPx: sqlFilters.minWidthPx ?? null,
      minHeightPx: sqlFilters.minHeightPx ?? null,
      includeUnknownDimensions: sqlFilters.includeUnknownDimensions ?? false,
      fileTypeBasis: sqlFilters.fileTypeBasis ?? 'detected_format',
      fileTypeValue: sqlFilters.fileTypeValue ?? null,
      onlyUnknownDetectedFormat: sqlFilters.onlyUnknownDetectedFormat ?? false,
      ownerGen: request.ownerGen
    })

    const items: MetadataAwareSearchResultItem[] = semanticResponse.items.map((item) => ({
      photo: item.photo,
      score: item.score,
      rank: item.rank,
      matchSource: hasStructuredFilters ? 'hybrid' : 'semantic'
    }))

    return {
      mode,
      items,
      totalMatched: semanticResponse.totalMatched,
      filteredCandidateCount,
      eligibleCount: semanticResponse.eligibleCount,
      unindexedCount: semanticResponse.unindexedCount,
      staleCount: semanticResponse.staleCount,
      corruptCount: semanticResponse.corruptCount,
      offset: semanticResponse.offset,
      limit: semanticResponse.limit,
      hasMore: semanticResponse.hasMore,
      queryLatencyMs: performance.now() - t0,
      interpretedFilters,
      clarification: null,
      visualModelRequired: false,
      modelStatus: semanticResponse.modelStatus
    }
  }
}
