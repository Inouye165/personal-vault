/**
 * Personal Vault — usePhotoReview Hook (Stage 5B)
 *
 * Coordinates review state (ratings, flags) and collection memberships
 * for the currently selected photo, including optimistic updates,
 * conflict detection (stale revision / stale annotation version),
 * asynchronous generation guarding, and filter eviction on out-of-filter edits.
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
  const [totalCollections, setTotalCollections] = useState(0)
  const [hasMoreCollections, setHasMoreCollections] = useState(false)

  const [memberships, setMemberships] = useState<PhotoMembershipItem[]>([])
  const [totalMemberships, setTotalMemberships] = useState(0)
  const [hasMoreMemberships, setHasMoreMemberships] = useState(false)
  const [isLoadingMemberships, setIsLoadingMemberships] = useState(false)

  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')
  const [statusMessage, setStatusMessage] = useState<string | null>(null)

  const selectedPhotoRef = useRef<PhotoItem | null>(selectedPhoto)
  const prevSelectedPhotoIdRef = useRef<number | null>(null)
  const selectionGenRef = useRef(0)

  // Load initial collections
  const loadCollections = useCallback(async (offset = 0) => {
    try {
      if (typeof window.api?.listCollections !== 'function') return
      const res = await window.api.listCollections({ offset, limit: 50 })
      if (offset === 0) {
        setCollections(res.items)
      } else {
        setCollections((prev) => [...prev, ...res.items])
      }
      setTotalCollections(res.totalCount)
      setHasMoreCollections(res.hasMore)
    } catch (err) {
      console.error('Failed to list collections:', err)
    }
  }, [])

  const loadMoreCollections = useCallback(async () => {
    if (!hasMoreCollections) return
    await loadCollections(collections.length)
  }, [hasMoreCollections, collections.length, loadCollections])

  // Load memberships for current photo
  const loadMemberships = useCallback(async (photoId: number, offset = 0) => {
    try {
      if (typeof window.api?.getPhotoMemberships !== 'function') return
      setIsLoadingMemberships(true)
      const res = await window.api.getPhotoMemberships({
        fileLocationId: photoId,
        offset,
        limit: 50
      })
      if (selectedPhotoRef.current?.id === photoId) {
        if (offset === 0) {
          setMemberships(res.items)
        } else {
          setMemberships((prev) => [...prev, ...res.items])
        }
        setTotalMemberships(res.totalCount)
        setHasMoreMemberships(res.hasMore)
        setIsLoadingMemberships(false)
      }
    } catch (err) {
      console.error('Failed to get photo memberships:', err)
      if (selectedPhotoRef.current?.id === photoId) {
        if (offset === 0) setMemberships([])
        setIsLoadingMemberships(false)
      }
    }
  }, [])

  const loadMoreMemberships = useCallback(async () => {
    if (!hasMoreMemberships || !selectedPhoto) return
    await loadMemberships(selectedPhoto.id, memberships.length)
  }, [hasMoreMemberships, selectedPhoto, memberships.length, loadMemberships])

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

    let active = true
    const updateSelection = async () => {
      await Promise.resolve()
      if (!active) return

      if (!selectedPhoto) {
        setMemberships([])
        setTotalMemberships(0)
        setHasMoreMemberships(false)
        setIsLoadingMemberships(false)
        setSaveStatus('idle')
        setStatusMessage(null)
        return
      }

      setMemberships([])
      setTotalMemberships(0)
      setHasMoreMemberships(false)
      setIsLoadingMemberships(true)
      setSaveStatus('idle')
      setStatusMessage(null)

      if (typeof window.api?.getPhotoMemberships !== 'function') return
      try {
        const res = await window.api.getPhotoMemberships({
          fileLocationId: photoId,
          offset: 0,
          limit: 50
        })
        if (active && selectionGenRef.current === currentGen) {
          setMemberships(res.items)
          setTotalMemberships(res.totalCount)
          setHasMoreMemberships(res.hasMore)
          setIsLoadingMemberships(false)
        }
      } catch {
        if (active && selectionGenRef.current === currentGen) {
          setMemberships([])
          setIsLoadingMemberships(false)
        }
      }
    }

    void updateSelection()
    return () => {
      active = false
    }
  }, [selectedPhoto])

  // Set rating with request identity and generation guarding
  const setRating = useCallback(
    async (rating: PhotoRating) => {
      if (!selectedPhoto) return

      const targetPhoto = selectedPhoto
      const targetPhotoId = targetPhoto.id
      const targetGen = selectionGenRef.current

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

        // Always update the photo in the catalog memory store
        updatePhotoLocal(
          targetPhotoId,
          result.annotation.rating,
          result.annotation.flag,
          result.annotation.version
        )

        // Only update UI save status if the photo is still currently selected
        if (
          selectionGenRef.current === targetGen &&
          selectedPhotoRef.current?.id === targetPhotoId
        ) {
          setSaveStatus('saved')

          // Check if photo still matches rating filter
          if (ratingFilter !== 'all') {
            let matches = true
            if (ratingFilter === 'unrated') {
              matches = newRating === null
            } else {
              const minRating = Number.parseInt(ratingFilter, 10)
              matches = newRating !== null && newRating >= minRating
            }
            if (!matches) {
              removePhotoFromFilterView(targetPhotoId)
            }
          }
        }
      } catch (err: unknown) {
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
    [selectedPhoto, ratingFilter, updatePhotoLocal, removePhotoFromFilterView]
  )

  // Set flag with request identity and generation guarding
  const setFlag = useCallback(
    async (flag: PhotoFlag) => {
      if (!selectedPhoto) return

      const targetPhoto = selectedPhoto
      const targetPhotoId = targetPhoto.id
      const targetGen = selectionGenRef.current

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

        updatePhotoLocal(
          targetPhotoId,
          result.annotation.rating,
          result.annotation.flag,
          result.annotation.version
        )

        if (
          selectionGenRef.current === targetGen &&
          selectedPhotoRef.current?.id === targetPhotoId
        ) {
          setSaveStatus('saved')

          if (flagFilter !== 'all' && flag !== flagFilter) {
            removePhotoFromFilterView(targetPhotoId)
          }
        }
      } catch (err: unknown) {
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
    [selectedPhoto, flagFilter, updatePhotoLocal, removePhotoFromFilterView]
  )

  // Create collection
  const createCollection = useCallback(
    async (name: string) => {
      try {
        const res = await window.api.createCollection({ name })
        await loadCollections(0)
        return res.collection
      } catch (err: unknown) {
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
        await loadCollections(0)
        if (selectedPhotoRef.current) {
          await loadMemberships(selectedPhotoRef.current.id, 0)
        }
        return res.collection
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        setStatusMessage(message)
        throw err
      }
    },
    [loadCollections, loadMemberships]
  )

  // Add collection member with expectedRevision
  const addCollectionMember = useCallback(
    async (collectionId: number) => {
      if (!selectedPhoto) return
      const targetPhotoId = selectedPhoto.id
      const expectedRevision = computePhotoRevision(selectedPhoto)

      try {
        await window.api.addCollectionMember({
          collectionId,
          fileLocationId: targetPhotoId,
          expectedRevision
        })
        if (selectedPhotoRef.current?.id === targetPhotoId) {
          await loadMemberships(targetPhotoId, 0)
        }
        await loadCollections(0)
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        setStatusMessage(message)
      }
    },
    [selectedPhoto, loadMemberships, loadCollections]
  )

  // Remove collection member with expectedRevision
  const removeCollectionMember = useCallback(
    async (collectionId: number) => {
      if (!selectedPhoto) return
      const targetPhotoId = selectedPhoto.id
      const expectedRevision = computePhotoRevision(selectedPhoto)

      try {
        await window.api.removeCollectionMember({
          collectionId,
          fileLocationId: targetPhotoId,
          expectedRevision
        })
        if (selectedPhotoRef.current?.id === targetPhotoId) {
          await loadMemberships(targetPhotoId, 0)
        }
        await loadCollections(0)

        if (collectionIdFilter === collectionId && selectedPhotoRef.current?.id === targetPhotoId) {
          removePhotoFromFilterView(targetPhotoId)
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        setStatusMessage(message)
      }
    },
    [selectedPhoto, collectionIdFilter, loadMemberships, loadCollections, removePhotoFromFilterView]
  )

  return {
    collections,
    totalCollections,
    hasMoreCollections,
    loadMoreCollections,
    memberships,
    totalMemberships,
    hasMoreMemberships,
    loadMoreMemberships,
    isLoadingMemberships,
    saveStatus,
    statusMessage,
    setRating,
    setFlag,
    createCollection,
    renameCollection,
    addCollectionMember,
    removeCollectionMember,
    refreshCollections: () => loadCollections(0)
  }
}
