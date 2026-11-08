/**
 * Personal Vault — usePhotoReview Hook (Stage 5B)
 *
 * Coordinates review state (ratings, flags) and collection memberships
 * for the currently selected photo, including optimistic updates,
 * conflict detection (stale revision / stale annotation version),
 * asynchronous generation guarding, stale-response prevention,
 * bounded pagination, and honest persistencePending propagation.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  CollectionItem,
  PhotoMembershipItem,
  PhotoFlagFilter,
  PhotoItem,
  PhotoRatingFilter
} from '../../../shared/validation/ipc-schemas'
import type { PhotoFlag, PhotoRating } from '../../../shared/types/domain'

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error' | 'conflict'

export interface UsePhotoReviewProps {
  selectedPhoto: PhotoItem | null
  ratingFilter: PhotoRatingFilter
  flagFilter: PhotoFlagFilter
  collectionIdFilter: number | null
  updatePhotoLocal: (
    photoId: number,
    rating: number | null,
    flag: PhotoFlag,
    version: number
  ) => void
  removePhotoFromFilterView: (photoId: number) => void
}

export function computePhotoRevision(photo: PhotoItem): string {
  const mtime = photo.filesystemMtimeMs !== null ? photo.filesystemMtimeMs : 'null'
  const hash = photo.activeHash ? photo.activeHash : 'unhashed'
  return `rev:${photo.discoveryObservationId}:${photo.byteSize}:${mtime}:${hash}`
}

export function usePhotoReview({
  selectedPhoto,
  ratingFilter,
  flagFilter,
  collectionIdFilter,
  updatePhotoLocal,
  removePhotoFromFilterView
}: UsePhotoReviewProps) {
  const [collections, setCollections] = useState<CollectionItem[]>([])
  const [collectionsOffset, setCollectionsOffset] = useState(0)
  const [totalCollections, setTotalCollections] = useState(0)
  const [hasMoreCollections, setHasMoreCollections] = useState(false)

  const [memberships, setMemberships] = useState<PhotoMembershipItem[]>([])
  const [membershipsOffset, setMembershipsOffset] = useState(0)
  const [totalMemberships, setTotalMemberships] = useState(0)
  const [hasMoreMemberships, setHasMoreMemberships] = useState(false)
  const [isLoadingMemberships, setIsLoadingMemberships] = useState(false)
  const [membershipError, setMembershipError] = useState<string | null>(null)

  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [persistencePending, setPersistencePending] = useState(false)
  const [persistenceError, setPersistenceError] = useState<string | null>(null)

  const isMountedRef = useRef(true)
  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  const selectedPhotoRef = useRef<PhotoItem | null>(selectedPhoto)
  const prevSelectedPhotoIdRef = useRef<number | null>(null)
  const selectionGenRef = useRef(0)
  const photoMutationSeqRef = useRef<Map<number, number>>(new Map())
  const membershipReqSeqRef = useRef<Map<number, number>>(new Map())

  const currentFiltersRef = useRef({ ratingFilter, flagFilter, collectionIdFilter })
  useEffect(() => {
    currentFiltersRef.current = { ratingFilter, flagFilter, collectionIdFilter }
  }, [ratingFilter, flagFilter, collectionIdFilter])

  const isLoadingCollectionsRef = useRef(false)
  const isLoadingMembershipsRef = useRef(false)

  // Load collections with bounded page retention (page size = 50)
  const loadCollections = useCallback(async (offset = 0) => {
    if (isLoadingCollectionsRef.current) return
    try {
      if (typeof window.api?.listCollections !== 'function') return
      isLoadingCollectionsRef.current = true
      const res = await window.api.listCollections({ offset, limit: 50 })
      if (!isMountedRef.current) return
      setCollections(res.items)
      setCollectionsOffset(offset)
      setTotalCollections(res.totalCount)
      setHasMoreCollections(res.hasMore)
    } catch (err) {
      console.error('Failed to list collections:', err)
    } finally {
      isLoadingCollectionsRef.current = false
    }
  }, [])

  const totalCollectionsPages = Math.max(1, Math.ceil(totalCollections / 50))
  const collectionsPage = Math.floor(collectionsOffset / 50) + 1

  const goToNextCollectionsPage = useCallback(async () => {
    if (!hasMoreCollections || isLoadingCollectionsRef.current) return
    await loadCollections(collectionsOffset + 50)
  }, [hasMoreCollections, collectionsOffset, loadCollections])

  const goToPrevCollectionsPage = useCallback(async () => {
    if (collectionsOffset <= 0 || isLoadingCollectionsRef.current) return
    await loadCollections(Math.max(0, collectionsOffset - 50))
  }, [collectionsOffset, loadCollections])

  const loadMoreCollections = goToNextCollectionsPage

  // Load memberships for current photo with bounded page retention (page size = 50)
  const loadMemberships = useCallback(async (photoId: number, offset = 0) => {
    if (isLoadingMembershipsRef.current) return
    const reqSeq = (membershipReqSeqRef.current.get(photoId) ?? 0) + 1
    membershipReqSeqRef.current.set(photoId, reqSeq)
    const targetGen = selectionGenRef.current

    try {
      if (typeof window.api?.getPhotoMemberships !== 'function') return
      isLoadingMembershipsRef.current = true
      setIsLoadingMemberships(true)
      setMembershipError(null)
      const res = await window.api.getPhotoMemberships({
        fileLocationId: photoId,
        offset,
        limit: 50
      })

      if (!isMountedRef.current) return
      if (membershipReqSeqRef.current.get(photoId) !== reqSeq) return
      if (selectionGenRef.current !== targetGen || selectedPhotoRef.current?.id !== photoId) return

      setMemberships(res.items)
      setMembershipsOffset(offset)
      setTotalMemberships(res.totalCount)
      setHasMoreMemberships(res.hasMore)
      setIsLoadingMemberships(false)
      setMembershipError(null)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('Failed to get photo memberships:', err)
      if (!isMountedRef.current) return
      if (membershipReqSeqRef.current.get(photoId) !== reqSeq) return
      if (selectionGenRef.current !== targetGen || selectedPhotoRef.current?.id !== photoId) return

      if (offset === 0) setMemberships([])
      setIsLoadingMemberships(false)
      setMembershipError(message)
    } finally {
      isLoadingMembershipsRef.current = false
    }
  }, [])

  const totalMembershipsPages = Math.max(1, Math.ceil(totalMemberships / 50))
  const membershipsPage = Math.floor(membershipsOffset / 50) + 1

  const goToNextMembershipsPage = useCallback(async () => {
    if (!hasMoreMemberships || !selectedPhotoRef.current || isLoadingMembershipsRef.current) return
    await loadMemberships(selectedPhotoRef.current.id, membershipsOffset + 50)
  }, [hasMoreMemberships, membershipsOffset, loadMemberships])

  const goToPrevMembershipsPage = useCallback(async () => {
    if (membershipsOffset <= 0 || !selectedPhotoRef.current || isLoadingMembershipsRef.current)
      return
    await loadMemberships(selectedPhotoRef.current.id, Math.max(0, membershipsOffset - 50))
  }, [membershipsOffset, loadMemberships])

  const loadMoreMemberships = goToNextMembershipsPage

  const retryLoadMemberships = useCallback(async () => {
    if (!selectedPhotoRef.current) return
    setMembershipError(null)
    await loadMemberships(selectedPhotoRef.current.id, 0)
  }, [loadMemberships])

  useEffect(() => {
    let active = true
    const init = async () => {
      await Promise.resolve()
      if (active) {
        void loadCollections(0)
      }
    }
    void init()
    return () => {
      active = false
    }
  }, [loadCollections])

  // Handle selection changes: clear stale memberships and reset save states immediately
  useEffect(() => {
    selectedPhotoRef.current = selectedPhoto
    const photoId = selectedPhoto?.id ?? null
    if (photoId === prevSelectedPhotoIdRef.current) {
      return
    }
    prevSelectedPhotoIdRef.current = photoId
    const currentGen = ++selectionGenRef.current

    setMemberships([])
    setMembershipsOffset(0)
    setTotalMemberships(0)
    setHasMoreMemberships(false)
    setIsLoadingMemberships(selectedPhoto !== null)
    setMembershipError(null)
    setSaveStatus('idle')
    setStatusMessage(null)

    if (!selectedPhoto) {
      return
    }

    const currentPhotoId = selectedPhoto.id
    const reqSeq = (membershipReqSeqRef.current.get(currentPhotoId) ?? 0) + 1
    membershipReqSeqRef.current.set(currentPhotoId, reqSeq)

    let active = true
    const updateSelection = async () => {
      if (typeof window.api?.getPhotoMemberships !== 'function') return
      try {
        const res = await window.api.getPhotoMemberships({
          fileLocationId: currentPhotoId,
          offset: 0,
          limit: 50
        })
        if (
          active &&
          isMountedRef.current &&
          selectionGenRef.current === currentGen &&
          membershipReqSeqRef.current.get(currentPhotoId) === reqSeq
        ) {
          setMemberships(res.items)
          setMembershipsOffset(0)
          setTotalMemberships(res.totalCount)
          setHasMoreMemberships(res.hasMore)
          setIsLoadingMemberships(false)
          setMembershipError(null)
        }
      } catch (err: unknown) {
        if (
          active &&
          isMountedRef.current &&
          selectionGenRef.current === currentGen &&
          membershipReqSeqRef.current.get(currentPhotoId) === reqSeq
        ) {
          const message = err instanceof Error ? err.message : String(err)
          setMemberships([])
          setIsLoadingMemberships(false)
          setMembershipError(message)
        }
      }
    }

    void updateSelection()
    return () => {
      active = false
    }
  }, [selectedPhoto])

  // Safe reconciliation for pending journal finalizations without re-mutating database
  const retryReconciliation = useCallback(async () => {
    if (typeof window.api?.reconcileJournal !== 'function') return
    try {
      const res = await window.api.reconcileJournal()
      if (!isMountedRef.current) return
      if (res.success) {
        setPersistencePending(false)
        setPersistenceError(null)
        setSaveStatus('saved')
      }
    } catch (err) {
      if (!isMountedRef.current) return
      const message = err instanceof Error ? err.message : String(err)
      setPersistenceError(`Reconciliation failed: ${message}`)
    }
  }, [])

  // Set rating with request identity and generation guarding
  const setRating = useCallback(
    async (rating: PhotoRating) => {
      if (!selectedPhoto) return

      const targetPhoto = selectedPhoto
      const targetPhotoId = targetPhoto.id
      const targetGen = selectionGenRef.current
      const targetSeq = (photoMutationSeqRef.current.get(targetPhotoId) ?? 0) + 1
      photoMutationSeqRef.current.set(targetPhotoId, targetSeq)

      // Toggle off if same rating clicked
      const newRating = targetPhoto.rating === rating ? null : rating
      const currentFlag = targetPhoto.flag ?? 'none'
      const expectedRevision = computePhotoRevision(targetPhoto)
      const expectedVersion = targetPhoto.annotationVersion ?? 0

      setSaveStatus('saving')
      setStatusMessage(null)

      try {
        const result = await window.api.setPhotoAnnotation({
          fileLocationId: targetPhotoId,
          expectedRevision,
          expectedVersion,
          rating: newRating,
          flag: currentFlag
        })

        if (!isMountedRef.current) return

        // Drop completion if a newer mutation was queued for this photo
        if (photoMutationSeqRef.current.get(targetPhotoId) !== targetSeq) {
          return
        }

        // Drop completion if selection switched away from this photo
        if (
          selectionGenRef.current !== targetGen ||
          selectedPhotoRef.current?.id !== targetPhotoId
        ) {
          return
        }

        // Update photo in catalog memory store
        updatePhotoLocal(
          targetPhotoId,
          result.annotation.rating,
          result.annotation.flag,
          result.annotation.version
        )

        // Handle persistencePending honestly
        if (result.persistencePending) {
          setPersistencePending(true)
          setPersistenceError(result.persistenceError ?? 'Journal finalization pending')
          setSaveStatus('idle')
        } else {
          setPersistencePending(false)
          setPersistenceError(null)
          setSaveStatus('saved')
        }

        // Check if photo still matches rating filter using live current filter
        const { ratingFilter: currentRatingFilter } = currentFiltersRef.current
        if (currentRatingFilter !== 'all') {
          let matches = true
          if (currentRatingFilter === 'unrated') {
            matches = newRating === null
          } else {
            const minRating = Number.parseInt(currentRatingFilter, 10)
            matches = newRating !== null && newRating >= minRating
          }
          if (!matches) {
            removePhotoFromFilterView(targetPhotoId)
          }
        }
      } catch (err: unknown) {
        if (!isMountedRef.current) return
        if (photoMutationSeqRef.current.get(targetPhotoId) !== targetSeq) return
        if (
          selectionGenRef.current === targetGen &&
          selectedPhotoRef.current?.id === targetPhotoId
        ) {
          const message = err instanceof Error ? err.message : String(err)
          if (message.includes('STALE_REVISION') || message.includes('STALE_ANNOTATION_VERSION')) {
            setSaveStatus('conflict')
            setStatusMessage(
              'Conflict: Annotation version or file revision mismatch. Please refresh.'
            )
          } else {
            setSaveStatus('error')
            setStatusMessage(message)
          }
        }
      }
    },
    [selectedPhoto, updatePhotoLocal, removePhotoFromFilterView]
  )

  // Set flag with request identity and generation guarding
  const setFlag = useCallback(
    async (flag: PhotoFlag) => {
      if (!selectedPhoto) return

      const targetPhoto = selectedPhoto
      const targetPhotoId = targetPhoto.id
      const targetGen = selectionGenRef.current
      const targetSeq = (photoMutationSeqRef.current.get(targetPhotoId) ?? 0) + 1
      photoMutationSeqRef.current.set(targetPhotoId, targetSeq)

      const currentRating = targetPhoto.rating ?? null
      const expectedRevision = computePhotoRevision(targetPhoto)
      const expectedVersion = targetPhoto.annotationVersion ?? 0

      setSaveStatus('saving')
      setStatusMessage(null)

      try {
        const result = await window.api.setPhotoAnnotation({
          fileLocationId: targetPhotoId,
          expectedRevision,
          expectedVersion,
          rating: currentRating,
          flag
        })

        if (!isMountedRef.current) return

        // Drop completion if a newer mutation was queued for this photo
        if (photoMutationSeqRef.current.get(targetPhotoId) !== targetSeq) {
          return
        }

        // Drop completion if selection switched away from this photo
        if (
          selectionGenRef.current !== targetGen ||
          selectedPhotoRef.current?.id !== targetPhotoId
        ) {
          return
        }

        updatePhotoLocal(
          targetPhotoId,
          result.annotation.rating,
          result.annotation.flag,
          result.annotation.version
        )

        if (result.persistencePending) {
          setPersistencePending(true)
          setPersistenceError(result.persistenceError ?? 'Journal finalization pending')
          setSaveStatus('idle')
        } else {
          setPersistencePending(false)
          setPersistenceError(null)
          setSaveStatus('saved')
        }

        const { flagFilter: currentFlagFilter } = currentFiltersRef.current
        if (currentFlagFilter !== 'all' && flag !== currentFlagFilter) {
          removePhotoFromFilterView(targetPhotoId)
        }
      } catch (err: unknown) {
        if (!isMountedRef.current) return
        if (photoMutationSeqRef.current.get(targetPhotoId) !== targetSeq) return
        if (
          selectionGenRef.current === targetGen &&
          selectedPhotoRef.current?.id === targetPhotoId
        ) {
          const message = err instanceof Error ? err.message : String(err)
          if (message.includes('STALE_REVISION') || message.includes('STALE_ANNOTATION_VERSION')) {
            setSaveStatus('conflict')
            setStatusMessage(
              'Conflict: Annotation version or file revision mismatch. Please refresh.'
            )
          } else {
            setSaveStatus('error')
            setStatusMessage(message)
          }
        }
      }
    },
    [selectedPhoto, updatePhotoLocal, removePhotoFromFilterView]
  )

  // Create collection
  const createCollection = useCallback(
    async (name: string) => {
      try {
        const res = await window.api.createCollection({ name })
        if (!isMountedRef.current) return res.collection
        if (res.persistencePending) {
          setPersistencePending(true)
          setPersistenceError(res.persistenceError ?? 'Journal finalization pending')
        } else {
          setPersistencePending(false)
          setPersistenceError(null)
        }
        await loadCollections(0)
        return res.collection
      } catch (err: unknown) {
        if (!isMountedRef.current) throw err
        const message = err instanceof Error ? err.message : String(err)
        setStatusMessage(message)
        throw err
      }
    },
    [loadCollections]
  )

  // Rename collection
  const renameCollection = useCallback(
    async (collectionId: number, name: string) => {
      try {
        const res = await window.api.renameCollection({ collectionId, name })
        if (!isMountedRef.current) return res.collection
        if (res.persistencePending) {
          setPersistencePending(true)
          setPersistenceError(res.persistenceError ?? 'Journal finalization pending')
        } else {
          setPersistencePending(false)
          setPersistenceError(null)
        }
        await loadCollections(collectionsOffset)
        if (selectedPhotoRef.current) {
          await loadMemberships(selectedPhotoRef.current.id, membershipsOffset)
        }
        return res.collection
      } catch (err: unknown) {
        if (!isMountedRef.current) throw err
        const message = err instanceof Error ? err.message : String(err)
        setStatusMessage(message)
        throw err
      }
    },
    [loadCollections, loadMemberships, collectionsOffset, membershipsOffset]
  )

  // Add collection member with expectedRevision
  const addCollectionMember = useCallback(
    async (collectionId: number) => {
      if (!selectedPhoto) return
      const targetPhotoId = selectedPhoto.id
      const expectedRevision = computePhotoRevision(selectedPhoto)

      try {
        const res = await window.api.addCollectionMember({
          collectionId,
          fileLocationId: targetPhotoId,
          expectedRevision
        })
        if (!isMountedRef.current) return
        if (res.persistencePending) {
          setPersistencePending(true)
          setPersistenceError(res.persistenceError ?? 'Journal finalization pending')
        } else {
          setPersistencePending(false)
          setPersistenceError(null)
        }
        if (selectedPhotoRef.current?.id === targetPhotoId) {
          await loadMemberships(targetPhotoId, membershipsOffset)
        }
        await loadCollections(collectionsOffset)
      } catch (err: unknown) {
        if (!isMountedRef.current) return
        const message = err instanceof Error ? err.message : String(err)
        setStatusMessage(message)
      }
    },
    [selectedPhoto, loadMemberships, loadCollections, collectionsOffset, membershipsOffset]
  )

  // Remove collection member with expectedRevision
  const removeCollectionMember = useCallback(
    async (collectionId: number) => {
      if (!selectedPhoto) return
      const targetPhotoId = selectedPhoto.id
      const expectedRevision = computePhotoRevision(selectedPhoto)

      try {
        const res = await window.api.removeCollectionMember({
          collectionId,
          fileLocationId: targetPhotoId,
          expectedRevision
        })
        if (!isMountedRef.current) return
        if (res.persistencePending) {
          setPersistencePending(true)
          setPersistenceError(res.persistenceError ?? 'Journal finalization pending')
        } else {
          setPersistencePending(false)
          setPersistenceError(null)
        }
        if (selectedPhotoRef.current?.id === targetPhotoId) {
          await loadMemberships(targetPhotoId, membershipsOffset)
        }
        await loadCollections(collectionsOffset)

        const { collectionIdFilter: currentCollFilter } = currentFiltersRef.current
        if (currentCollFilter === collectionId && selectedPhotoRef.current?.id === targetPhotoId) {
          removePhotoFromFilterView(targetPhotoId)
        }
      } catch (err: unknown) {
        if (!isMountedRef.current) return
        const message = err instanceof Error ? err.message : String(err)
        setStatusMessage(message)
      }
    },
    [
      selectedPhoto,
      loadMemberships,
      loadCollections,
      removePhotoFromFilterView,
      collectionsOffset,
      membershipsOffset
    ]
  )

  return {
    collections,
    collectionsOffset,
    collectionsPage,
    totalCollections,
    totalCollectionsPages,
    hasMoreCollections,
    hasPrevCollections: collectionsOffset > 0,
    goToNextCollectionsPage,
    goToPrevCollectionsPage,
    loadMoreCollections,
    memberships,
    membershipsOffset,
    membershipsPage,
    totalMemberships,
    totalMembershipsPages,
    hasMoreMemberships,
    hasPrevMemberships: membershipsOffset > 0,
    goToNextMembershipsPage,
    goToPrevMembershipsPage,
    loadMoreMemberships,
    isLoadingMemberships,
    membershipError,
    retryLoadMemberships,
    saveStatus,
    statusMessage,
    persistencePending,
    persistenceError,
    retryReconciliation,
    setRating,
    setFlag,
    createCollection,
    renameCollection,
    addCollectionMember,
    removeCollectionMember,
    refreshCollections: () => loadCollections(collectionsOffset)
  }
}
