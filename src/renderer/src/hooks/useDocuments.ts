import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  DocSemanticModelStatusDto,
  DocSemanticSearchResponseDto,
  DocumentClassificationOverrideAckDto,
  DocumentClassificationProgressDto,
  DocumentClutterFilter,
  DocumentClutterOverride,
  DocumentDetailItem,
  DocumentExtensionFacetItem,
  DocumentExtractionProgressDto,
  DocumentOcrPreviewPayloadDto,
  DocumentOcrProgressDto,
  DocumentOcrStateItemDto,
  DocumentOriginFilter,
  DocumentOriginLabel,
  DocumentPreviewPayload,
  DocumentPurposeFilter,
  DocumentPurposeLabel,
  DocumentSemanticProgressDto,
  DocumentSummaryItem,
  GetDocumentClassificationFacetsResponseDto,
  OcrModelStatusDto
} from '../../../shared/validation/document-schemas'
import { allocateSearchOwnerGen } from './search-owner'

export const DOCUMENTS_PAGE_SIZE = 50
export const DOCUMENT_FACETS_PAGE_SIZE = 50

export interface UseDocumentsState {
  readonly items: readonly DocumentSummaryItem[]
  readonly totalCount: number
  readonly offset: number
  readonly limit: number
  readonly isLoading: boolean
  readonly error: string | null
  readonly filenameQuery: string
  readonly extensionFilter: string | null
  readonly facets: readonly DocumentExtensionFacetItem[]
  readonly facetsTotalCount: number
  readonly isLoadingMoreFacets: boolean
  readonly selectedFileLocationId: number | null
  readonly detail: DocumentDetailItem | null
  readonly isDetailLoading: boolean
  readonly detailError: string | null
  readonly preview: DocumentPreviewPayload | null
  readonly isPreviewLoading: boolean
  readonly previewError: string | null
  readonly extractionProgress: DocumentExtractionProgressDto | null
  readonly extractionActionError: string | null
  readonly ocrModelStatus: OcrModelStatusDto | null
  readonly ocrModelActionError: string | null
  readonly ocrProgress: DocumentOcrProgressDto | null
  readonly ocrActionError: string | null
  readonly ocrState: DocumentOcrStateItemDto | null
  readonly ocrPreview: DocumentOcrPreviewPayloadDto | null
  readonly isOcrPreviewLoading: boolean
  readonly ocrPreviewError: string | null
  readonly docSemanticModelStatus: DocSemanticModelStatusDto | null
  readonly docSemanticModelActionError: string | null
  readonly docSemanticProgress: DocumentSemanticProgressDto | null
  readonly docSemanticIndexError: string | null
  readonly docSearchQuery: string
  readonly docSearchTrackFilter: 'native' | 'ocr' | null
  readonly docSearchOffset: number
  readonly docSearchResults: DocSemanticSearchResponseDto | null
  readonly isDocSearching: boolean
  readonly docSearchError: string | null
  readonly purposeFilter: DocumentPurposeFilter | null
  readonly originFilter: DocumentOriginFilter | null
  readonly clutterFilter: DocumentClutterFilter
  readonly hiddenClutterCount: number
  readonly classificationProgress: DocumentClassificationProgressDto | null
  readonly classificationActionError: string | null
  readonly classificationFacets: GetDocumentClassificationFacetsResponseDto | null
  readonly overrideAckNotice: {
    readonly ok: boolean
    readonly conflict?: string
    readonly message: string
    readonly persistencePending?: boolean
  } | null
  readonly isSavingOverride: boolean
  readonly setFilenameQuery: (q: string) => void
  readonly setExtensionFilter: (ext: string | null) => void
  readonly setPurposeFilter: (purpose: DocumentPurposeFilter | null) => void
  readonly setOriginFilter: (origin: DocumentOriginFilter | null) => void
  readonly setClutterFilter: (clutter: DocumentClutterFilter) => void
  readonly resetFilters: () => void
  readonly goToPage: (newOffset: number) => void
  readonly selectDocument: (fileLocationId: number | null) => void
  readonly loadMoreFacets: () => void
  readonly extractDocument: (fileLocationId: number, forceReextract?: boolean) => Promise<void>
  readonly startScopeExtraction: (scope: 'all' | 'filtered', retryFailed?: boolean) => Promise<void>
  readonly pauseExtraction: () => Promise<void>
  readonly resumeExtraction: () => Promise<void>
  readonly cancelExtraction: () => Promise<void>
  readonly downloadOcrModel: () => Promise<void>
  readonly importOcrModel: () => Promise<void>
  readonly cancelOcrModel: () => Promise<void>
  readonly ocrDocument: (fileLocationId: number, forceReocr?: boolean) => Promise<void>
  readonly startScopeOcr: (
    scope?: 'ocr_needed' | 'filtered' | 'all',
    retryFailed?: boolean,
    forceReocr?: boolean
  ) => Promise<void>
  readonly pauseOcr: () => Promise<void>
  readonly resumeOcr: () => Promise<void>
  readonly cancelOcr: () => Promise<void>
  readonly downloadDocSemanticModel: () => Promise<void>
  readonly importDocSemanticModel: () => Promise<void>
  readonly cancelDocSemanticModel: () => Promise<void>
  readonly indexSelectedDocuments: (
    fileLocationIds: number[],
    forceReindex?: boolean
  ) => Promise<void>
  readonly startDocSemanticIndexing: (
    scope?: 'unindexed_or_stale' | 'filtered' | 'all',
    retryFailed?: boolean,
    forceReindex?: boolean
  ) => Promise<void>
  readonly pauseDocSemanticIndexing: () => Promise<void>
  readonly resumeDocSemanticIndexing: () => Promise<void>
  readonly cancelDocSemanticIndexing: () => Promise<void>
  readonly runDocSemanticSearch: (
    nextQuery: string,
    nextOffset?: number,
    nextTrackFilter?: 'native' | 'ocr' | null
  ) => Promise<void>
  readonly setDocSearchTrackFilter: (trackFilter: 'native' | 'ocr' | null) => void
  readonly clearDocSemanticSearch: () => void
  readonly cancelDocSemanticSearch: () => Promise<void>
  readonly classifyDocument: (fileLocationId: number, forceReclassify?: boolean) => Promise<void>
  readonly startClassification: (
    scope?: 'unclassified_or_stale' | 'filtered' | 'all',
    forceReclassify?: boolean
  ) => Promise<void>
  readonly pauseClassification: () => Promise<void>
  readonly resumeClassification: () => Promise<void>
  readonly cancelClassification: () => Promise<void>
  readonly setClassificationOverride: (params: {
    readonly fileLocationId: number
    readonly expectedRevision: string
    readonly expectedOverrideVersion: number
    readonly purposeLabels: readonly DocumentPurposeLabel[] | null
    readonly originLabels: readonly DocumentOriginLabel[] | null
    readonly clutterOverride: DocumentClutterOverride
  }) => Promise<DocumentClassificationOverrideAckDto | null>
  readonly resetClassificationOverride: (params: {
    readonly fileLocationId: number
    readonly expectedRevision: string
    readonly expectedOverrideVersion: number
  }) => Promise<DocumentClassificationOverrideAckDto | null>
  readonly dismissOverrideNotice: () => void
  readonly reload: () => void
}

export function useDocuments(): UseDocumentsState {
  const [items, setItems] = useState<readonly DocumentSummaryItem[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [offset, setOffset] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [filenameQuery, setFilenameQueryState] = useState('')
  const [extensionFilter, setExtensionFilterState] = useState<string | null>(null)

  const [facets, setFacets] = useState<readonly DocumentExtensionFacetItem[]>([])
  const [facetsTotalCount, setFacetsTotalCount] = useState(0)
  const [isLoadingMoreFacets, setIsLoadingMoreFacets] = useState(false)

  const [selectedFileLocationId, setSelectedFileLocationId] = useState<number | null>(null)
  const [detail, setDetail] = useState<DocumentDetailItem | null>(null)
  const [isDetailLoading, setIsDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)

  const [preview, setPreview] = useState<DocumentPreviewPayload | null>(null)
  const [isPreviewLoading, setIsPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)

  const [extractionProgress, setExtractionProgress] =
    useState<DocumentExtractionProgressDto | null>(null)
  const [extractionActionError, setExtractionActionError] = useState<string | null>(null)

  const [ocrModelStatus, setOcrModelStatus] = useState<OcrModelStatusDto | null>(null)
  const [ocrModelActionError, setOcrModelActionError] = useState<string | null>(null)
  const [ocrProgress, setOcrProgress] = useState<DocumentOcrProgressDto | null>(null)
  const [ocrActionError, setOcrActionError] = useState<string | null>(null)
  const [ocrState, setOcrState] = useState<DocumentOcrStateItemDto | null>(null)
  const [ocrPreview, setOcrPreview] = useState<DocumentOcrPreviewPayloadDto | null>(null)
  const [isOcrPreviewLoading, setIsOcrPreviewLoading] = useState(false)
  const [ocrPreviewError, setOcrPreviewError] = useState<string | null>(null)

  const [docSemanticModelStatus, setDocSemanticModelStatus] =
    useState<DocSemanticModelStatusDto | null>(null)
  const [docSemanticModelActionError, setDocSemanticModelActionError] = useState<string | null>(
    null
  )
  const [docSemanticProgress, setDocSemanticProgress] =
    useState<DocumentSemanticProgressDto | null>(null)
  const [docSemanticIndexError, setDocSemanticIndexError] = useState<string | null>(null)
  const [docSearchQuery, setDocSearchQuery] = useState('')
  const [docSearchTrackFilter, setDocSearchTrackFilterState] = useState<'native' | 'ocr' | null>(
    null
  )
  const [docSearchOffset, setDocSearchOffset] = useState(0)
  const [docSearchResults, setDocSearchResults] = useState<DocSemanticSearchResponseDto | null>(
    null
  )
  const [isDocSearching, setIsDocSearching] = useState(false)
  const [docSearchError, setDocSearchError] = useState<string | null>(null)
  const docSearchGenRef = useRef(0)
  const docSearchOwnerGenRef = useRef<number | null>(null)

  const [purposeFilter, setPurposeFilterState] = useState<DocumentPurposeFilter | null>(null)
  const [originFilter, setOriginFilterState] = useState<DocumentOriginFilter | null>(null)
  const [clutterFilter, setClutterFilterState] = useState<DocumentClutterFilter>('show_all')
  const [hiddenClutterCount, setHiddenClutterCount] = useState(0)
  const [classificationProgress, setClassificationProgress] =
    useState<DocumentClassificationProgressDto | null>(null)
  const [classificationActionError, setClassificationActionError] = useState<string | null>(null)
  const [classificationFacets, setClassificationFacets] =
    useState<GetDocumentClassificationFacetsResponseDto | null>(null)
  const [overrideAckNotice, setOverrideAckNotice] =
    useState<UseDocumentsState['overrideAckNotice']>(null)
  const [isSavingOverride, setIsSavingOverride] = useState(false)

  const pageGenRef = useRef(0)
  const detailGenRef = useRef(0)
  const facetsGenRef = useRef(0)
  const clsFacetsGenRef = useRef(0)
  const overrideGenRef = useRef(0)
  const isMountedRef = useRef(true)

  const filterStateRef = useRef({
    offset,
    filenameQuery,
    extensionFilter,
    purposeFilter,
    originFilter,
    clutterFilter,
    selectedFileLocationId
  })
  useEffect(() => {
    filterStateRef.current = {
      offset,
      filenameQuery,
      extensionFilter,
      purposeFilter,
      originFilter,
      clutterFilter,
      selectedFileLocationId
    }
  }, [
    offset,
    filenameQuery,
    extensionFilter,
    purposeFilter,
    originFilter,
    clutterFilter,
    selectedFileLocationId
  ])

  useEffect(() => {
    isMountedRef.current = true
    void window.api
      .getDocSemanticModelStatus?.()
      .then((status) => {
        if (isMountedRef.current) setDocSemanticModelStatus(status)
      })
      .catch(() => {})
    void window.api
      .getDocumentSemanticProgress?.()
      .then((prog) => {
        if (isMountedRef.current) setDocSemanticProgress(prog)
      })
      .catch(() => {})
    return () => {
      isMountedRef.current = false
      pageGenRef.current += 1
      detailGenRef.current += 1
      facetsGenRef.current += 1
      clsFacetsGenRef.current += 1
      overrideGenRef.current += 1
      docSearchGenRef.current += 1
      if (docSearchOwnerGenRef.current !== null) {
        const cancelOwnerGen = docSearchOwnerGenRef.current
        docSearchOwnerGenRef.current = null
        void window.api
          ?.cancelDocumentSemanticSearch?.({ ownerGen: cancelOwnerGen })
          .catch(() => {})
      }
    }
  }, [])

  const fetchClassificationFacets = useCallback(
    async (nextFilenameQuery: string, nextExtFilter: string | null) => {
      if (typeof window.api.getDocumentClassificationFacets !== 'function') return
      const gen = ++clsFacetsGenRef.current
      try {
        const res = await window.api.getDocumentClassificationFacets({
          extensionFilter: nextExtFilter,
          filenameQuery: nextFilenameQuery
        })
        if (!isMountedRef.current || gen !== clsFacetsGenRef.current) return
        setClassificationFacets(res)
      } catch {
        // Supplementary facets; main page error banner handles catalog failures
      }
    },
    []
  )

  const fetchPage = useCallback(
    async (
      nextOffset: number,
      nextFilenameQuery: string,
      nextExtFilter: string | null,
      nextPurposeFilter: DocumentPurposeFilter | null = filterStateRef.current.purposeFilter,
      nextOriginFilter: DocumentOriginFilter | null = filterStateRef.current.originFilter,
      nextClutterFilter: DocumentClutterFilter = filterStateRef.current.clutterFilter
    ) => {
      const gen = ++pageGenRef.current
      setIsLoading(true)
      setError(null)
      try {
        const res = await window.api.getDocumentsPage({
          offset: nextOffset,
          limit: DOCUMENTS_PAGE_SIZE,
          extensionFilter: nextExtFilter,
          filenameQuery: nextFilenameQuery,
          purposeFilter: nextPurposeFilter,
          originFilter: nextOriginFilter,
          clutterFilter: nextClutterFilter
        })
        if (!isMountedRef.current || gen !== pageGenRef.current) return
        setItems(res.items)
        setTotalCount(res.totalCount)
        setOffset(res.offset)
        setHiddenClutterCount(res.hiddenClutterCount ?? 0)
        setIsLoading(false)
      } catch (err) {
        if (!isMountedRef.current || gen !== pageGenRef.current) return
        setError(err instanceof Error ? err.message : String(err))
        setIsLoading(false)
      }
    },
    []
  )

  const fetchDetailAndPreview = useCallback(async (fileLocationId: number) => {
    const gen = ++detailGenRef.current
    setIsDetailLoading(true)
    setDetailError(null)
    setIsPreviewLoading(true)
    setPreviewError(null)
    setIsOcrPreviewLoading(true)
    setOcrPreviewError(null)
    try {
      const [detailRes, previewRes, ocrStateRes, ocrPreviewRes] = await Promise.all([
        window.api.getDocumentDetail({ fileLocationId }),
        typeof window.api.getDocumentPreview === 'function'
          ? window.api.getDocumentPreview({ fileLocationId })
          : Promise.resolve({ preview: null }),
        typeof window.api.getDocumentOcrState === 'function'
          ? window.api.getDocumentOcrState({ fileLocationId })
          : Promise.resolve({ state: null }),
        typeof window.api.getDocumentOcrPreview === 'function'
          ? window.api.getDocumentOcrPreview({ fileLocationId })
          : Promise.resolve({ preview: null })
      ])
      if (!isMountedRef.current || gen !== detailGenRef.current) return
      setDetail(detailRes.item)
      setIsDetailLoading(false)
      setPreview(previewRes.preview)
      setIsPreviewLoading(false)
      setOcrState(ocrStateRes.state)
      setOcrPreview(ocrPreviewRes.preview)
      setIsOcrPreviewLoading(false)
    } catch (err) {
      if (!isMountedRef.current || gen !== detailGenRef.current) return
      const msg = err instanceof Error ? err.message : String(err)
      setDetailError(msg)
      setPreviewError(msg)
      setOcrPreviewError(msg)
      setIsDetailLoading(false)
      setIsPreviewLoading(false)
      setIsOcrPreviewLoading(false)
    }
  }, [])

  const fetchInitialFacets = useCallback(async () => {
    const gen = ++facetsGenRef.current
    try {
      const res = await window.api.getDocumentExtensionFacets({
        offset: 0,
        limit: DOCUMENT_FACETS_PAGE_SIZE
      })
      if (!isMountedRef.current || gen !== facetsGenRef.current) return
      setFacets(res.items)
      setFacetsTotalCount(res.totalCount)
    } catch {
      // Facets are supplementary; list error banner handles catalog failures
    }
  }, [])

  useEffect(() => {
    const gen = ++pageGenRef.current
    let cancelled = false
    window.api
      .getDocumentsPage({
        offset,
        limit: DOCUMENTS_PAGE_SIZE,
        extensionFilter,
        filenameQuery,
        purposeFilter,
        originFilter,
        clutterFilter
      })
      .then((res) => {
        if (cancelled || !isMountedRef.current || gen !== pageGenRef.current) return
        setItems(res.items)
        setTotalCount(res.totalCount)
        setOffset(res.offset)
        setHiddenClutterCount(res.hiddenClutterCount ?? 0)
        setError(null)
        setIsLoading(false)
      })
      .catch((err) => {
        if (cancelled || !isMountedRef.current || gen !== pageGenRef.current) return
        setError(err instanceof Error ? err.message : String(err))
        setIsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [offset, filenameQuery, extensionFilter, purposeFilter, originFilter, clutterFilter])

  useEffect(() => {
    if (typeof window.api.getDocumentClassificationFacets !== 'function') return undefined
    const gen = ++clsFacetsGenRef.current
    let cancelled = false
    window.api
      .getDocumentClassificationFacets({
        extensionFilter,
        filenameQuery
      })
      .then((res) => {
        if (cancelled || !isMountedRef.current || gen !== clsFacetsGenRef.current) return
        setClassificationFacets(res)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [filenameQuery, extensionFilter])

  useEffect(() => {
    const gen = ++facetsGenRef.current
    let cancelled = false
    window.api
      .getDocumentExtensionFacets({
        offset: 0,
        limit: DOCUMENT_FACETS_PAGE_SIZE
      })
      .then((res) => {
        if (cancelled || !isMountedRef.current || gen !== facetsGenRef.current) return
        setFacets(res.items)
        setFacetsTotalCount(res.totalCount)
      })
      .catch(() => {
        // Facets are supplementary; list error banner handles catalog failures
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (typeof window.api.getDocumentExtractionProgress === 'function') {
      void window.api
        .getDocumentExtractionProgress()
        .then((progress) => {
          if (isMountedRef.current) {
            setExtractionProgress(progress)
          }
        })
        .catch(() => {
          // Ignore if unavailable
        })
    }

    if (typeof window.api.onDocumentExtractionProgress !== 'function') {
      return undefined
    }

    const unsubscribe = window.api.onDocumentExtractionProgress((progress) => {
      if (!isMountedRef.current) return
      setExtractionProgress(progress)
      const cur = filterStateRef.current
      void fetchPage(cur.offset, cur.filenameQuery, cur.extensionFilter)
      if (cur.selectedFileLocationId !== null) {
        void fetchDetailAndPreview(cur.selectedFileLocationId)
      }
    })
    return unsubscribe
  }, [fetchDetailAndPreview, fetchPage])

  useEffect(() => {
    if (typeof window.api.getOcrModelStatus === 'function') {
      void window.api
        .getOcrModelStatus()
        .then((status) => {
          if (isMountedRef.current) setOcrModelStatus(status)
        })
        .catch(() => {
          // Ignore if unavailable
        })
    }

    const unsubModel =
      typeof window.api.onOcrModelStatus === 'function'
        ? window.api.onOcrModelStatus((status) => {
            if (isMountedRef.current) setOcrModelStatus(status)
          })
        : undefined

    if (typeof window.api.getDocumentOcrProgress === 'function') {
      void window.api
        .getDocumentOcrProgress()
        .then((progress) => {
          if (isMountedRef.current) setOcrProgress(progress)
        })
        .catch(() => {
          // Ignore if unavailable
        })
    }

    const unsubOcr =
      typeof window.api.onDocumentOcrProgress === 'function'
        ? window.api.onDocumentOcrProgress((progress) => {
            if (!isMountedRef.current) return
            setOcrProgress(progress)
            const cur = filterStateRef.current
            if (cur.selectedFileLocationId !== null) {
              void fetchDetailAndPreview(cur.selectedFileLocationId)
            }
          })
        : undefined

    return () => {
      unsubModel?.()
      unsubOcr?.()
    }
  }, [fetchDetailAndPreview])

  useEffect(() => {
    if (typeof window.api.getDocumentClassificationProgress === 'function') {
      void window.api
        .getDocumentClassificationProgress()
        .then((progress) => {
          if (isMountedRef.current) setClassificationProgress(progress)
        })
        .catch(() => {})
    }

    if (typeof window.api.onDocumentClassificationProgress !== 'function') {
      return undefined
    }

    const unsubCls = window.api.onDocumentClassificationProgress((progress) => {
      if (!isMountedRef.current) return
      setClassificationProgress(progress)
      const cur = filterStateRef.current
      void fetchPage(
        cur.offset,
        cur.filenameQuery,
        cur.extensionFilter,
        cur.purposeFilter,
        cur.originFilter,
        cur.clutterFilter
      )
      void fetchClassificationFacets(cur.filenameQuery, cur.extensionFilter)
      if (cur.selectedFileLocationId !== null) {
        void fetchDetailAndPreview(cur.selectedFileLocationId)
      }
    })
    return unsubCls
  }, [fetchClassificationFacets, fetchDetailAndPreview, fetchPage])

  const loadMoreFacets = useCallback(async () => {
    if (isLoadingMoreFacets || facets.length >= facetsTotalCount) return
    const gen = ++facetsGenRef.current
    setIsLoadingMoreFacets(true)
    try {
      const res = await window.api.getDocumentExtensionFacets({
        offset: facets.length,
        limit: DOCUMENT_FACETS_PAGE_SIZE
      })
      if (!isMountedRef.current || gen !== facetsGenRef.current) return
      setFacets((prev) => {
        const seen = new Set(prev.map((f) => f.extension))
        return [...prev, ...res.items.filter((f) => !seen.has(f.extension))]
      })
      setFacetsTotalCount(res.totalCount)
      setIsLoadingMoreFacets(false)
    } catch {
      if (!isMountedRef.current || gen !== facetsGenRef.current) return
      setIsLoadingMoreFacets(false)
    }
  }, [facets.length, facetsTotalCount, isLoadingMoreFacets])

  const selectDocument = useCallback(
    async (fileLocationId: number | null) => {
      setSelectedFileLocationId(fileLocationId)
      if (fileLocationId === null) {
        detailGenRef.current += 1
        setDetail(null)
        setIsDetailLoading(false)
        setDetailError(null)
        setPreview(null)
        setIsPreviewLoading(false)
        setPreviewError(null)
        setOcrState(null)
        setOcrPreview(null)
        setIsOcrPreviewLoading(false)
        setOcrPreviewError(null)
        return
      }
      await fetchDetailAndPreview(fileLocationId)
    },
    [fetchDetailAndPreview]
  )

  const extractDocument = useCallback(async (fileLocationId: number, forceReextract = true) => {
    setExtractionActionError(null)
    try {
      const progress = await window.api.extractSelectedDocuments({
        fileLocationIds: [fileLocationId],
        forceReextract
      })
      if (isMountedRef.current) {
        setExtractionProgress(progress)
      }
    } catch (err) {
      if (isMountedRef.current) {
        setExtractionActionError(err instanceof Error ? err.message : String(err))
      }
    }
  }, [])

  const startScopeExtraction = useCallback(
    async (scope: 'all' | 'filtered', retryFailed = false) => {
      setExtractionActionError(null)
      try {
        const progress = await window.api.startDocumentExtraction({
          scope,
          extensionFilter: scope === 'filtered' ? extensionFilter : null,
          filenameQuery: scope === 'filtered' ? filenameQuery : undefined,
          retryFailed
        })
        if (isMountedRef.current) {
          setExtractionProgress(progress)
        }
      } catch (err) {
        if (isMountedRef.current) {
          setExtractionActionError(err instanceof Error ? err.message : String(err))
        }
      }
    },
    [extensionFilter, filenameQuery]
  )

  const pauseExtraction = useCallback(async () => {
    setExtractionActionError(null)
    try {
      const progress = await window.api.pauseDocumentExtraction()
      if (isMountedRef.current) setExtractionProgress(progress)
    } catch (err) {
      if (isMountedRef.current) {
        setExtractionActionError(err instanceof Error ? err.message : String(err))
      }
    }
  }, [])

  const resumeExtraction = useCallback(async () => {
    setExtractionActionError(null)
    try {
      const progress = await window.api.resumeDocumentExtraction()
      if (isMountedRef.current) setExtractionProgress(progress)
    } catch (err) {
      if (isMountedRef.current) {
        setExtractionActionError(err instanceof Error ? err.message : String(err))
      }
    }
  }, [])

  const cancelExtraction = useCallback(async () => {
    setExtractionActionError(null)
    try {
      const progress = await window.api.cancelDocumentExtraction()
      if (isMountedRef.current) setExtractionProgress(progress)
    } catch (err) {
      if (isMountedRef.current) {
        setExtractionActionError(err instanceof Error ? err.message : String(err))
      }
    }
  }, [])

  const downloadOcrModel = useCallback(async () => {
    setOcrModelActionError(null)
    try {
      const status = await window.api.downloadOcrModel()
      if (isMountedRef.current) setOcrModelStatus(status)
    } catch (err) {
      if (isMountedRef.current) {
        setOcrModelActionError(err instanceof Error ? err.message : String(err))
      }
    }
  }, [])

  const importOcrModel = useCallback(async () => {
    setOcrModelActionError(null)
    try {
      const status = await window.api.importOcrModel()
      if (isMountedRef.current) setOcrModelStatus(status)
    } catch (err) {
      if (isMountedRef.current) {
        setOcrModelActionError(err instanceof Error ? err.message : String(err))
      }
    }
  }, [])

  const cancelOcrModel = useCallback(async () => {
    setOcrModelActionError(null)
    try {
      const status = await window.api.cancelOcrModel()
      if (isMountedRef.current) setOcrModelStatus(status)
    } catch (err) {
      if (isMountedRef.current) {
        setOcrModelActionError(err instanceof Error ? err.message : String(err))
      }
    }
  }, [])

  const ocrDocument = useCallback(
    async (fileLocationId: number, forceReocr = true) => {
      setOcrActionError(null)
      try {
        const progress = await window.api.ocrSelectedDocuments({
          fileLocationIds: [fileLocationId],
          forceReocr
        })
        if (isMountedRef.current) {
          setOcrProgress(progress)
          if (filterStateRef.current.selectedFileLocationId === fileLocationId) {
            void fetchDetailAndPreview(fileLocationId)
          }
        }
      } catch (err) {
        if (isMountedRef.current) {
          setOcrActionError(err instanceof Error ? err.message : String(err))
        }
      }
    },
    [fetchDetailAndPreview]
  )

  const startScopeOcr = useCallback(
    async (
      scope: 'ocr_needed' | 'filtered' | 'all' = 'ocr_needed',
      retryFailed = false,
      forceReocr = false
    ) => {
      setOcrActionError(null)
      try {
        const progress = await window.api.startDocumentOcr({
          scope,
          extensionFilter: scope === 'filtered' ? extensionFilter : null,
          filenameQuery: scope === 'filtered' ? filenameQuery : undefined,
          retryFailed,
          forceReocr
        })
        if (isMountedRef.current) {
          setOcrProgress(progress)
        }
      } catch (err) {
        if (isMountedRef.current) {
          setOcrActionError(err instanceof Error ? err.message : String(err))
        }
      }
    },
    [extensionFilter, filenameQuery]
  )

  const pauseOcr = useCallback(async () => {
    setOcrActionError(null)
    try {
      const progress = await window.api.pauseDocumentOcr()
      if (isMountedRef.current) setOcrProgress(progress)
    } catch (err) {
      if (isMountedRef.current) {
        setOcrActionError(err instanceof Error ? err.message : String(err))
      }
    }
  }, [])

  const resumeOcr = useCallback(async () => {
    setOcrActionError(null)
    try {
      const progress = await window.api.resumeDocumentOcr()
      if (isMountedRef.current) setOcrProgress(progress)
    } catch (err) {
      if (isMountedRef.current) {
        setOcrActionError(err instanceof Error ? err.message : String(err))
      }
    }
  }, [])

  const cancelOcr = useCallback(async () => {
    setOcrActionError(null)
    try {
      const progress = await window.api.cancelDocumentOcr()
      if (isMountedRef.current) setOcrProgress(progress)
    } catch (err) {
      if (isMountedRef.current) {
        setOcrActionError(err instanceof Error ? err.message : String(err))
      }
    }
  }, [])

  const downloadDocSemanticModel = useCallback(async () => {
    setDocSemanticModelActionError(null)
    try {
      const status = await window.api.downloadDocSemanticModel()
      if (isMountedRef.current) setDocSemanticModelStatus(status)
    } catch (err) {
      if (isMountedRef.current) {
        setDocSemanticModelActionError(err instanceof Error ? err.message : String(err))
        const st = await window.api.getDocSemanticModelStatus?.().catch(() => null)
        if (st && isMountedRef.current) setDocSemanticModelStatus(st)
      }
    }
  }, [])

  const importDocSemanticModel = useCallback(async () => {
    setDocSemanticModelActionError(null)
    try {
      const status = await window.api.importDocSemanticModel()
      if (isMountedRef.current) setDocSemanticModelStatus(status)
    } catch (err) {
      if (isMountedRef.current) {
        setDocSemanticModelActionError(err instanceof Error ? err.message : String(err))
        const st = await window.api.getDocSemanticModelStatus?.().catch(() => null)
        if (st && isMountedRef.current) setDocSemanticModelStatus(st)
      }
    }
  }, [])

  const cancelDocSemanticModel = useCallback(async () => {
    setDocSemanticModelActionError(null)
    try {
      const status = await window.api.cancelDocSemanticModel()
      if (isMountedRef.current) setDocSemanticModelStatus(status)
    } catch (err) {
      if (isMountedRef.current) {
        setDocSemanticModelActionError(err instanceof Error ? err.message : String(err))
      }
    }
  }, [])

  const indexSelectedDocuments = useCallback(
    async (fileLocationIds: number[], forceReindex = false) => {
      setDocSemanticIndexError(null)
      try {
        const prog = await window.api.indexSelectedDocuments({ fileLocationIds, forceReindex })
        if (isMountedRef.current) setDocSemanticProgress(prog)
      } catch (err) {
        if (isMountedRef.current) {
          setDocSemanticIndexError(err instanceof Error ? err.message : String(err))
        }
      }
    },
    []
  )

  const startDocSemanticIndexing = useCallback(
    async (
      scope: 'unindexed_or_stale' | 'filtered' | 'all' = 'unindexed_or_stale',
      retryFailed = false,
      forceReindex = false
    ) => {
      setDocSemanticIndexError(null)
      try {
        const prog = await window.api.startDocumentSemanticIndexing({
          scope,
          extensionFilter: scope === 'filtered' ? extensionFilter : null,
          filenameQuery: scope === 'filtered' ? filenameQuery : undefined,
          retryFailed,
          forceReindex
        })
        if (isMountedRef.current) setDocSemanticProgress(prog)
      } catch (err) {
        if (isMountedRef.current) {
          setDocSemanticIndexError(err instanceof Error ? err.message : String(err))
          const latest = await window.api.getDocumentSemanticProgress?.().catch(() => null)
          if (latest && isMountedRef.current) setDocSemanticProgress(latest)
        }
      }
    },
    [extensionFilter, filenameQuery]
  )

  const pauseDocSemanticIndexing = useCallback(async () => {
    setDocSemanticIndexError(null)
    try {
      const prog = await window.api.pauseDocumentSemanticIndexing()
      if (isMountedRef.current) setDocSemanticProgress(prog)
    } catch (err) {
      if (isMountedRef.current) {
        setDocSemanticIndexError(err instanceof Error ? err.message : String(err))
      }
    }
  }, [])

  const resumeDocSemanticIndexing = useCallback(async () => {
    setDocSemanticIndexError(null)
    try {
      const prog = await window.api.resumeDocumentSemanticIndexing()
      if (isMountedRef.current) setDocSemanticProgress(prog)
    } catch (err) {
      if (isMountedRef.current) {
        setDocSemanticIndexError(err instanceof Error ? err.message : String(err))
      }
    }
  }, [])

  const cancelDocSemanticIndexing = useCallback(async () => {
    setDocSemanticIndexError(null)
    try {
      const prog = await window.api.cancelDocumentSemanticIndexing()
      if (isMountedRef.current) setDocSemanticProgress(prog)
    } catch (err) {
      if (isMountedRef.current) {
        setDocSemanticIndexError(err instanceof Error ? err.message : String(err))
      }
    }
  }, [])

  const runDocSemanticSearch = useCallback(
    async (
      nextQuery: string,
      nextOffset = 0,
      nextTrackFilter: 'native' | 'ocr' | null = docSearchTrackFilter,
      nextPurposeFilter: DocumentPurposeFilter | null = purposeFilter,
      nextOriginFilter: DocumentOriginFilter | null = originFilter,
      nextClutterFilter: DocumentClutterFilter = clutterFilter
    ) => {
      const trimmed = nextQuery.trim()
      const gen = ++docSearchGenRef.current
      setDocSearchQuery(nextQuery)
      setDocSearchOffset(nextOffset)
      setDocSearchTrackFilterState(nextTrackFilter)
      setDocSearchError(null)

      if (!trimmed) {
        setDocSearchResults(null)
        setIsDocSearching(false)
        if (docSearchOwnerGenRef.current !== null) {
          const cancelOwnerGen = docSearchOwnerGenRef.current
          docSearchOwnerGenRef.current = null
          void window.api
            ?.cancelDocumentSemanticSearch?.({ ownerGen: cancelOwnerGen })
            .catch(() => {})
        }
        return
      }

      if (nextOffset === 0 || docSearchOwnerGenRef.current === null) {
        docSearchOwnerGenRef.current = allocateSearchOwnerGen()
      }
      const ownerGen = docSearchOwnerGenRef.current

      setIsDocSearching(true)
      try {
        const res = await window.api.searchDocumentsSemantic({
          query: trimmed,
          limit: DOCUMENTS_PAGE_SIZE,
          offset: nextOffset,
          extensionFilter,
          filenameQuery: filenameQuery.trim() || undefined,
          textSourceKindFilter: nextTrackFilter,
          purposeFilter: nextPurposeFilter,
          originFilter: nextOriginFilter,
          clutterFilter: nextClutterFilter,
          ownerGen
        })
        if (!isMountedRef.current || gen !== docSearchGenRef.current) return
        setDocSearchResults(res)
        setIsDocSearching(false)
      } catch (err) {
        if (!isMountedRef.current || gen !== docSearchGenRef.current) return
        setDocSearchError(err instanceof Error ? err.message : String(err))
        setIsDocSearching(false)
      }
    },
    [
      clutterFilter,
      docSearchTrackFilter,
      extensionFilter,
      filenameQuery,
      originFilter,
      purposeFilter
    ]
  )

  const setDocSearchTrackFilter = useCallback(
    (trackFilter: 'native' | 'ocr' | null) => {
      setDocSearchTrackFilterState(trackFilter)
      if (docSearchQuery.trim()) {
        void runDocSemanticSearch(docSearchQuery, 0, trackFilter)
      }
    },
    [docSearchQuery, runDocSemanticSearch]
  )

  const clearDocSemanticSearch = useCallback(() => {
    docSearchGenRef.current += 1
    const cancelOwnerGen = docSearchOwnerGenRef.current
    docSearchOwnerGenRef.current = null
    setDocSearchQuery('')
    setDocSearchOffset(0)
    setDocSearchResults(null)
    setDocSearchError(null)
    setIsDocSearching(false)
    void window.api
      .cancelDocumentSemanticSearch?.(
        cancelOwnerGen !== null ? { ownerGen: cancelOwnerGen } : undefined
      )
      .catch(() => {})
  }, [])

  const cancelDocSemanticSearch = useCallback(async () => {
    docSearchGenRef.current += 1
    const cancelOwnerGen = docSearchOwnerGenRef.current
    docSearchOwnerGenRef.current = null
    setIsDocSearching(false)
    try {
      await window.api.cancelDocumentSemanticSearch(
        cancelOwnerGen !== null ? { ownerGen: cancelOwnerGen } : undefined
      )
    } catch {
      // ignore cancel errors
    }
  }, [])

  const setFilenameQuery = useCallback((q: string) => {
    setOffset(0)
    setFilenameQueryState(q)
  }, [])

  const setExtensionFilter = useCallback((ext: string | null) => {
    setOffset(0)
    setExtensionFilterState(ext)
  }, [])

  const setPurposeFilter = useCallback(
    (nextPurpose: DocumentPurposeFilter | null) => {
      setOffset(0)
      setPurposeFilterState(nextPurpose)
      if (docSearchQuery.trim()) {
        void runDocSemanticSearch(
          docSearchQuery,
          0,
          docSearchTrackFilter,
          nextPurpose,
          originFilter,
          clutterFilter
        )
      }
    },
    [clutterFilter, docSearchQuery, docSearchTrackFilter, originFilter, runDocSemanticSearch]
  )

  const setOriginFilter = useCallback(
    (nextOrigin: DocumentOriginFilter | null) => {
      setOffset(0)
      setOriginFilterState(nextOrigin)
      if (docSearchQuery.trim()) {
        void runDocSemanticSearch(
          docSearchQuery,
          0,
          docSearchTrackFilter,
          purposeFilter,
          nextOrigin,
          clutterFilter
        )
      }
    },
    [clutterFilter, docSearchQuery, docSearchTrackFilter, purposeFilter, runDocSemanticSearch]
  )

  const setClutterFilter = useCallback(
    (nextClutter: DocumentClutterFilter) => {
      setOffset(0)
      setClutterFilterState(nextClutter)
      if (docSearchQuery.trim()) {
        void runDocSemanticSearch(
          docSearchQuery,
          0,
          docSearchTrackFilter,
          purposeFilter,
          originFilter,
          nextClutter
        )
      }
    },
    [docSearchQuery, docSearchTrackFilter, originFilter, purposeFilter, runDocSemanticSearch]
  )

  const resetFilters = useCallback(() => {
    setOffset(0)
    setFilenameQueryState('')
    setExtensionFilterState(null)
    setPurposeFilterState(null)
    setOriginFilterState(null)
    setClutterFilterState('show_all')
    if (docSearchQuery.trim()) {
      void runDocSemanticSearch(docSearchQuery, 0, docSearchTrackFilter, null, null, 'show_all')
    }
  }, [docSearchQuery, docSearchTrackFilter, runDocSemanticSearch])

  const refreshAfterClassificationChange = useCallback(() => {
    const cur = filterStateRef.current
    void fetchPage(
      cur.offset,
      cur.filenameQuery,
      cur.extensionFilter,
      cur.purposeFilter,
      cur.originFilter,
      cur.clutterFilter
    )
    void fetchClassificationFacets(cur.filenameQuery, cur.extensionFilter)
    if (cur.selectedFileLocationId !== null) {
      void fetchDetailAndPreview(cur.selectedFileLocationId)
    }
  }, [fetchClassificationFacets, fetchDetailAndPreview, fetchPage])

  const classifyDocument = useCallback(
    async (fileLocationId: number, forceReclassify = true) => {
      setClassificationActionError(null)
      try {
        const prog = await window.api.classifySelectedDocuments({
          fileLocationIds: [fileLocationId],
          forceReclassify
        })
        if (isMountedRef.current) {
          setClassificationProgress(prog)
          refreshAfterClassificationChange()
        }
      } catch (err) {
        if (isMountedRef.current) {
          setClassificationActionError(err instanceof Error ? err.message : String(err))
        }
      }
    },
    [refreshAfterClassificationChange]
  )

  const startClassification = useCallback(
    async (
      scope: 'unclassified_or_stale' | 'filtered' | 'all' = 'unclassified_or_stale',
      forceReclassify = false
    ) => {
      setClassificationActionError(null)
      try {
        const cur = filterStateRef.current
        const prog = await window.api.startDocumentClassification({
          scope,
          extensionFilter: scope === 'filtered' ? cur.extensionFilter : null,
          filenameQuery: scope === 'filtered' ? cur.filenameQuery : undefined,
          forceReclassify
        })
        if (isMountedRef.current) {
          setClassificationProgress(prog)
          refreshAfterClassificationChange()
        }
      } catch (err) {
        if (isMountedRef.current) {
          setClassificationActionError(err instanceof Error ? err.message : String(err))
        }
      }
    },
    [refreshAfterClassificationChange]
  )

  const pauseClassification = useCallback(async () => {
    setClassificationActionError(null)
    try {
      const prog = await window.api.pauseDocumentClassification()
      if (isMountedRef.current) setClassificationProgress(prog)
    } catch (err) {
      if (isMountedRef.current) {
        setClassificationActionError(err instanceof Error ? err.message : String(err))
      }
    }
  }, [])

  const resumeClassification = useCallback(async () => {
    setClassificationActionError(null)
    try {
      const prog = await window.api.resumeDocumentClassification()
      if (isMountedRef.current) {
        setClassificationProgress(prog)
        refreshAfterClassificationChange()
      }
    } catch (err) {
      if (isMountedRef.current) {
        setClassificationActionError(err instanceof Error ? err.message : String(err))
      }
    }
  }, [refreshAfterClassificationChange])

  const cancelClassification = useCallback(async () => {
    setClassificationActionError(null)
    try {
      const prog = await window.api.cancelDocumentClassification()
      if (isMountedRef.current) setClassificationProgress(prog)
    } catch (err) {
      if (isMountedRef.current) {
        setClassificationActionError(err instanceof Error ? err.message : String(err))
      }
    }
  }, [])

  const setClassificationOverride = useCallback(
    async (params: {
      readonly fileLocationId: number
      readonly expectedRevision: string
      readonly expectedOverrideVersion: number
      readonly purposeLabels: readonly DocumentPurposeLabel[] | null
      readonly originLabels: readonly DocumentOriginLabel[] | null
      readonly clutterOverride: DocumentClutterOverride
    }): Promise<DocumentClassificationOverrideAckDto | null> => {
      const gen = ++overrideGenRef.current
      setIsSavingOverride(true)
      setOverrideAckNotice(null)
      try {
        const ack = await window.api.setDocumentClassificationOverride({
          fileLocationId: params.fileLocationId,
          expectedRevision: params.expectedRevision,
          expectedOverrideVersion: params.expectedOverrideVersion,
          purposeLabels: params.purposeLabels ? [...params.purposeLabels] : null,
          originLabels: params.originLabels ? [...params.originLabels] : null,
          clutterOverride: params.clutterOverride
        })
        if (!isMountedRef.current || gen !== overrideGenRef.current) return null
        setIsSavingOverride(false)
        if (!ack.ok) {
          setOverrideAckNotice({
            ok: false,
            conflict: ack.conflict,
            message:
              ack.conflict === 'STALE_OVERRIDE_VERSION' || ack.conflict === 'STALE_REVISION'
                ? 'Classification or file changed since you opened it. Refreshed to latest state; review and re-apply if needed.'
                : (ack.errorMessage ?? 'Could not save classification override.')
          })
        } else if (ack.persistencePending) {
          setOverrideAckNotice({
            ok: true,
            persistencePending: true,
            message: `Saved to catalog, but portable journal commit is pending recovery (${ack.persistenceError ?? 'journal write pending'}).`
          })
        } else {
          setOverrideAckNotice({
            ok: true,
            persistencePending: false,
            message: 'Classification override saved.'
          })
        }
        refreshAfterClassificationChange()
        if (typeof window.api.getDocumentClassificationProgress === 'function') {
          void window.api
            .getDocumentClassificationProgress()
            .then((prog) => {
              if (isMountedRef.current) setClassificationProgress(prog)
            })
            .catch(() => {})
        }
        return ack
      } catch (err) {
        if (!isMountedRef.current || gen !== overrideGenRef.current) return null
        setIsSavingOverride(false)
        setOverrideAckNotice({
          ok: false,
          message: err instanceof Error ? err.message : String(err)
        })
        return null
      }
    },
    [refreshAfterClassificationChange]
  )

  const resetClassificationOverride = useCallback(
    async (params: {
      readonly fileLocationId: number
      readonly expectedRevision: string
      readonly expectedOverrideVersion: number
    }): Promise<DocumentClassificationOverrideAckDto | null> => {
      const gen = ++overrideGenRef.current
      setIsSavingOverride(true)
      setOverrideAckNotice(null)
      try {
        const ack = await window.api.resetDocumentClassificationOverride(params)
        if (!isMountedRef.current || gen !== overrideGenRef.current) return null
        setIsSavingOverride(false)
        if (!ack.ok) {
          setOverrideAckNotice({
            ok: false,
            conflict: ack.conflict,
            message:
              ack.conflict === 'STALE_OVERRIDE_VERSION' || ack.conflict === 'STALE_REVISION'
                ? 'Classification or file changed since you opened it. Refreshed to latest state; review and re-apply if needed.'
                : (ack.errorMessage ?? 'Could not reset classification override.')
          })
        } else if (ack.persistencePending) {
          setOverrideAckNotice({
            ok: true,
            persistencePending: true,
            message: `Reset in catalog, but portable journal commit is pending recovery (${ack.persistenceError ?? 'journal write pending'}).`
          })
        } else {
          setOverrideAckNotice({
            ok: true,
            persistencePending: false,
            message: 'Reset to automatic classification.'
          })
        }
        refreshAfterClassificationChange()
        if (typeof window.api.getDocumentClassificationProgress === 'function') {
          void window.api
            .getDocumentClassificationProgress()
            .then((prog) => {
              if (isMountedRef.current) setClassificationProgress(prog)
            })
            .catch(() => {})
        }
        return ack
      } catch (err) {
        if (!isMountedRef.current || gen !== overrideGenRef.current) return null
        setIsSavingOverride(false)
        setOverrideAckNotice({
          ok: false,
          message: err instanceof Error ? err.message : String(err)
        })
        return null
      }
    },
    [refreshAfterClassificationChange]
  )

  const dismissOverrideNotice = useCallback(() => {
    setOverrideAckNotice(null)
  }, [])

  const goToPage = useCallback((newOffset: number) => {
    setOffset(Math.max(0, newOffset))
  }, [])

  const reload = useCallback(() => {
    void fetchPage(
      offset,
      filenameQuery,
      extensionFilter,
      purposeFilter,
      originFilter,
      clutterFilter
    )
    void fetchInitialFacets()
    void fetchClassificationFacets(filenameQuery, extensionFilter)
  }, [
    clutterFilter,
    extensionFilter,
    fetchClassificationFacets,
    fetchInitialFacets,
    fetchPage,
    filenameQuery,
    offset,
    originFilter,
    purposeFilter
  ])

  return {
    items,
    totalCount,
    offset,
    limit: DOCUMENTS_PAGE_SIZE,
    isLoading,
    error,
    filenameQuery,
    extensionFilter,
    facets,
    facetsTotalCount,
    isLoadingMoreFacets,
    selectedFileLocationId,
    detail,
    isDetailLoading,
    detailError,
    preview,
    isPreviewLoading,
    previewError,
    extractionProgress,
    extractionActionError,
    ocrModelStatus,
    ocrModelActionError,
    ocrProgress,
    ocrActionError,
    ocrState,
    ocrPreview,
    isOcrPreviewLoading,
    ocrPreviewError,
    docSemanticModelStatus,
    docSemanticModelActionError,
    docSemanticProgress,
    docSemanticIndexError,
    docSearchQuery,
    docSearchTrackFilter,
    docSearchOffset,
    docSearchResults,
    isDocSearching,
    docSearchError,
    purposeFilter,
    originFilter,
    clutterFilter,
    hiddenClutterCount,
    classificationProgress,
    classificationActionError,
    classificationFacets,
    overrideAckNotice,
    isSavingOverride,
    setFilenameQuery,
    setExtensionFilter,
    setPurposeFilter,
    setOriginFilter,
    setClutterFilter,
    resetFilters,
    goToPage,
    selectDocument,
    loadMoreFacets,
    extractDocument,
    startScopeExtraction,
    pauseExtraction,
    resumeExtraction,
    cancelExtraction,
    downloadOcrModel,
    importOcrModel,
    cancelOcrModel,
    ocrDocument,
    startScopeOcr,
    pauseOcr,
    resumeOcr,
    cancelOcr,
    downloadDocSemanticModel,
    importDocSemanticModel,
    cancelDocSemanticModel,
    indexSelectedDocuments,
    startDocSemanticIndexing,
    pauseDocSemanticIndexing,
    resumeDocSemanticIndexing,
    cancelDocSemanticIndexing,
    runDocSemanticSearch,
    setDocSearchTrackFilter,
    clearDocSemanticSearch,
    cancelDocSemanticSearch,
    classifyDocument,
    startClassification,
    pauseClassification,
    resumeClassification,
    cancelClassification,
    setClassificationOverride,
    resetClassificationOverride,
    dismissOverrideNotice,
    reload
  }
}
