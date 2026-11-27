import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  SemanticModelStatusResponse,
  SemanticIndexProgressResponse,
  SemanticIndexJobItem,
  SemanticIndexItemStatus
} from '../../../shared/validation/ipc-schemas'

const DEFAULT_MODEL_STATUS: SemanticModelStatusResponse = {
  state: 'missing',
  modelId: 'Xenova/clip-vit-base-patch32@6b7c5237',
  modelCommit: '6b7c523703ae26e39be4b03774966f8571c7f523',
  modelManifestSha256: '0'.repeat(64),
  preprocessingVersion: 'clip_vit_b32_224_bicubic_center_rgb_v1',
  dimensions: 512,
  requiredBytes: 155851918,
  downloadedBytes: 0,
  currentArtifact: null,
  verifiedAtMs: null,
  error: null,
  lastReplacementError: null
}

const DEFAULT_INDEX_PROGRESS: SemanticIndexProgressResponse = {
  jobId: null,
  status: 'idle',
  modelId: 'Xenova/clip-vit-base-patch32@6b7c5237',
  modelCommit: '6b7c523703ae26e39be4b03774966f8571c7f523',
  preprocessingVersion: 'clip_vit_b32_224_bicubic_center_rgb_v1',
  totalPhotos: 0,
  processedPhotos: 0,
  reusedPhotos: 0,
  unsupportedPhotos: 0,
  failedPhotos: 0,
  pendingPhotos: 0,
  totalCatalogPhotos: 0,
  currentIndexedPhotos: 0,
  startedAtMs: null,
  updatedAtMs: null,
  completedAtMs: null,
  lastError: null
}

export function useSemanticIndex() {
  const [modelStatus, setModelStatus] = useState<SemanticModelStatusResponse>(DEFAULT_MODEL_STATUS)
  const [indexProgress, setIndexProgress] =
    useState<SemanticIndexProgressResponse>(DEFAULT_INDEX_PROGRESS)
  const [jobItems, setJobItems] = useState<SemanticIndexJobItem[]>([])
  const [itemsTotalCount, setItemsTotalCount] = useState(0)
  const [itemsPage, setItemsPage] = useState(1)
  const [itemsFilter, setItemsFilter] = useState<SemanticIndexItemStatus | undefined>(undefined)
  const [actionError, setActionError] = useState<string | null>(null)
  const [isBusy, setIsBusy] = useState(false)

  const isMountedRef = useRef(true)
  const modelEpochRef = useRef(0)
  const indexEpochRef = useRef(0)
  const itemsEpochRef = useRef(0)
  const latestIndexUpdatedAtRef = useRef<number>(0)

  const applyModelStatus = useCallback((next: SemanticModelStatusResponse, epoch: number) => {
    if (!isMountedRef.current || epoch < modelEpochRef.current) return
    modelEpochRef.current = epoch
    setModelStatus(next)
  }, [])

  const applyIndexProgress = useCallback(
    (next: SemanticIndexProgressResponse, epoch: number, isLiveEvent = false) => {
      if (!isMountedRef.current) return
      if (!isLiveEvent && epoch < indexEpochRef.current) {
        return
      }
      if (
        !isLiveEvent &&
        next.updatedAtMs !== null &&
        latestIndexUpdatedAtRef.current > next.updatedAtMs
      ) {
        return
      }
      indexEpochRef.current = Math.max(indexEpochRef.current, epoch)
      if (next.updatedAtMs !== null && next.updatedAtMs > latestIndexUpdatedAtRef.current) {
        latestIndexUpdatedAtRef.current = next.updatedAtMs
      }
      setIndexProgress(next)
    },
    []
  )

  const refreshAll = useCallback(async () => {
    const api = window.api
    if (!api) return
    const modelEpoch = ++modelEpochRef.current
    const indexEpoch = ++indexEpochRef.current

    try {
      const [mStatus, iProg] = await Promise.all([
        api.getSemanticModelStatus?.(),
        api.getSemanticIndexProgress?.()
      ])
      if (mStatus) {
        applyModelStatus(mStatus, modelEpoch)
      }
      if (iProg) {
        applyIndexProgress(iProg, indexEpoch, false)
      }
    } catch (err) {
      if (isMountedRef.current) {
        setActionError(err instanceof Error ? err.message : String(err))
      }
    }
  }, [applyModelStatus, applyIndexProgress])

  const loadJobItems = useCallback(
    async (
      targetJobId: string | null = indexProgress.jobId,
      targetPage = itemsPage,
      targetStatus = itemsFilter
    ) => {
      const api = window.api
      if (!api?.getSemanticIndexJobItems || !targetJobId) {
        if (isMountedRef.current) {
          setJobItems([])
          setItemsTotalCount(0)
        }
        return
      }

      const epoch = ++itemsEpochRef.current
      try {
        const res = await api.getSemanticIndexJobItems({
          jobId: targetJobId,
          status: targetStatus,
          page: targetPage,
          pageSize: 25
        })
        if (!isMountedRef.current || epoch < itemsEpochRef.current) return
        setJobItems(res.items)
        setItemsTotalCount(res.totalCount)
        setItemsPage(res.page)
      } catch (err) {
        if (isMountedRef.current && epoch === itemsEpochRef.current) {
          setActionError(err instanceof Error ? err.message : String(err))
        }
      }
    },
    [indexProgress.jobId, itemsPage, itemsFilter]
  )

  useEffect(() => {
    isMountedRef.current = true
    const api = window.api
    if (!api) return

    void refreshAll()

    const unsubModel = api.onSemanticModelStatus?.((status) => {
      const nextEpoch = ++modelEpochRef.current
      applyModelStatus(status, nextEpoch)
    })

    const unsubIndex = api.onSemanticIndexProgress?.((prog) => {
      const nextEpoch = ++indexEpochRef.current
      applyIndexProgress(prog, nextEpoch, true)
    })

    return () => {
      isMountedRef.current = false
      unsubModel?.()
      unsubIndex?.()
    }
  }, [refreshAll, applyModelStatus, applyIndexProgress])

  const downloadModel = useCallback(async () => {
    const api = window.api
    if (!api?.downloadSemanticModel) return
    setActionError(null)
    setIsBusy(true)
    const epoch = ++modelEpochRef.current
    try {
      const res = await api.downloadSemanticModel()
      applyModelStatus(res, epoch)
    } catch (err) {
      if (isMountedRef.current) {
        setActionError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      if (isMountedRef.current) setIsBusy(false)
    }
  }, [applyModelStatus])

  const importModelFromFolder = useCallback(async () => {
    const api = window.api
    if (!api?.importSemanticModelFromFolder) return
    setActionError(null)
    setIsBusy(true)
    const epoch = ++modelEpochRef.current
    try {
      const res = await api.importSemanticModelFromFolder()
      applyModelStatus(res, epoch)
      const iEpoch = ++indexEpochRef.current
      const prog = await api.getSemanticIndexProgress?.()
      if (prog) applyIndexProgress(prog, iEpoch, false)
    } catch (err) {
      if (isMountedRef.current) {
        setActionError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      if (isMountedRef.current) setIsBusy(false)
    }
  }, [applyModelStatus, applyIndexProgress])

  const cancelModelProvisioning = useCallback(async () => {
    const api = window.api
    if (!api?.cancelSemanticModelProvisioning) return
    setActionError(null)
    const epoch = ++modelEpochRef.current
    try {
      const res = await api.cancelSemanticModelProvisioning()
      applyModelStatus(res, epoch)
    } catch (err) {
      if (isMountedRef.current) {
        setActionError(err instanceof Error ? err.message : String(err))
      }
    }
  }, [applyModelStatus])

  const startIndexing = useCallback(async () => {
    const api = window.api
    if (!api?.startSemanticIndexing) return
    setActionError(null)
    const epoch = ++indexEpochRef.current
    try {
      const res = await api.startSemanticIndexing()
      applyIndexProgress(res, epoch, true)
    } catch (err) {
      if (isMountedRef.current) {
        setActionError(err instanceof Error ? err.message : String(err))
      }
    }
  }, [applyIndexProgress])

  const pauseIndexing = useCallback(async () => {
    const api = window.api
    if (!api?.pauseSemanticIndexing) return
    setActionError(null)
    const epoch = ++indexEpochRef.current
    try {
      const res = await api.pauseSemanticIndexing()
      applyIndexProgress(res, epoch, true)
    } catch (err) {
      if (isMountedRef.current) {
        setActionError(err instanceof Error ? err.message : String(err))
      }
    }
  }, [applyIndexProgress])

  const resumeIndexing = useCallback(async () => {
    const api = window.api
    if (!api?.resumeSemanticIndexing) return
    setActionError(null)
    const epoch = ++indexEpochRef.current
    try {
      const res = await api.resumeSemanticIndexing()
      applyIndexProgress(res, epoch, true)
    } catch (err) {
      if (isMountedRef.current) {
        setActionError(err instanceof Error ? err.message : String(err))
      }
    }
  }, [applyIndexProgress])

  const cancelIndexing = useCallback(async () => {
    const api = window.api
    if (!api?.cancelSemanticIndexing) return
    setActionError(null)
    const epoch = ++indexEpochRef.current
    try {
      const res = await api.cancelSemanticIndexing()
      applyIndexProgress(res, epoch, true)
    } catch (err) {
      if (isMountedRef.current) {
        setActionError(err instanceof Error ? err.message : String(err))
      }
    }
  }, [applyIndexProgress])

  return {
    modelStatus,
    indexProgress,
    jobItems,
    itemsTotalCount,
    itemsPage,
    itemsFilter,
    actionError,
    isBusy,
    setItemsPage,
    setItemsFilter,
    refreshAll,
    loadJobItems,
    downloadModel,
    importModelFromFolder,
    cancelModelProvisioning,
    startIndexing,
    pauseIndexing,
    resumeIndexing,
    cancelIndexing
  }
}
