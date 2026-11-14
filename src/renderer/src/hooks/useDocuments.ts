import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  DocumentDetailItem,
  DocumentExtensionFacetItem,
  DocumentSummaryItem
} from '../../../shared/validation/document-schemas'

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
  readonly setFilenameQuery: (q: string) => void
  readonly setExtensionFilter: (ext: string | null) => void
  readonly resetFilters: () => void
  readonly goToPage: (newOffset: number) => void
  readonly selectDocument: (fileLocationId: number | null) => void
  readonly loadMoreFacets: () => void
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

  const pageGenRef = useRef(0)
  const detailGenRef = useRef(0)
  const facetsGenRef = useRef(0)
  const isMountedRef = useRef(true)

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      pageGenRef.current += 1
      detailGenRef.current += 1
      facetsGenRef.current += 1
    }
  }, [])

  const fetchPage = useCallback(
    async (nextOffset: number, nextFilenameQuery: string, nextExtFilter: string | null) => {
      const gen = ++pageGenRef.current
      setIsLoading(true)
      setError(null)
      try {
        const res = await window.api.getDocumentsPage({
          offset: nextOffset,
          limit: DOCUMENTS_PAGE_SIZE,
          extensionFilter: nextExtFilter,
          filenameQuery: nextFilenameQuery
        })
        if (!isMountedRef.current || gen !== pageGenRef.current) return
        setItems(res.items)
        setTotalCount(res.totalCount)
        setOffset(res.offset)
        setIsLoading(false)
      } catch (err) {
        if (!isMountedRef.current || gen !== pageGenRef.current) return
        setError(err instanceof Error ? err.message : String(err))
        setIsLoading(false)
      }
    },
    []
  )

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
        filenameQuery
      })
      .then((res) => {
        if (cancelled || !isMountedRef.current || gen !== pageGenRef.current) return
        setItems(res.items)
        setTotalCount(res.totalCount)
        setOffset(res.offset)
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
  }, [offset, filenameQuery, extensionFilter])

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

  const selectDocument = useCallback(async (fileLocationId: number | null) => {
    const gen = ++detailGenRef.current
    setSelectedFileLocationId(fileLocationId)
    if (fileLocationId === null) {
      setDetail(null)
      setIsDetailLoading(false)
      setDetailError(null)
      return
    }
    setIsDetailLoading(true)
    setDetailError(null)
    try {
      const res = await window.api.getDocumentDetail({ fileLocationId })
      if (!isMountedRef.current || gen !== detailGenRef.current) return
      setDetail(res.item)
      setIsDetailLoading(false)
    } catch (err) {
      if (!isMountedRef.current || gen !== detailGenRef.current) return
      setDetailError(err instanceof Error ? err.message : String(err))
      setIsDetailLoading(false)
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

  const resetFilters = useCallback(() => {
    setOffset(0)
    setFilenameQueryState('')
    setExtensionFilterState(null)
  }, [])

  const goToPage = useCallback((newOffset: number) => {
    setOffset(Math.max(0, newOffset))
  }, [])

  const reload = useCallback(() => {
    void fetchPage(offset, filenameQuery, extensionFilter)
    void fetchInitialFacets()
  }, [fetchPage, fetchInitialFacets, offset, filenameQuery, extensionFilter])

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
    setFilenameQuery,
    setExtensionFilter,
    resetFilters,
    goToPage,
    selectDocument,
    loadMoreFacets,
    reload
  }
}
