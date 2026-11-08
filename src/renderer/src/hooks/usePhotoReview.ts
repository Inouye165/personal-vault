/**
 * Personal Vault — usePhotoReview Hook (Stage 5B)
 *
 * Coordinates review state (ratings, flags) and collection memberships
 * for the currently selected photo, including optimistic updates,
 * conflict detection (stale revision / stale annotation version),
 * and filter eviction on out-of-filter edits.
 */

import { useCallback, useEffect, useState } from 'react'
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
  const [memberships, setMemberships] = useState<PhotoMembershipItem[]>([])
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')
  const [statusMessage, setStatusMessage] = useState<string | null>(null)

  // Load collections
  const loadCollections = useCallback(async () => {
    try {
      if (typeof window.api?.listCollections !== 'function') return
      const res = await window.api.listCollections({ limit: 100 })
      setCollections(res.items)
    } catch (err) {
      console.error('Failed to list collections:', err)
    }
  }, [])

  // Load memberships for current photo
  const loadMemberships = useCallback(async (photoId: number) => {
    try {
      if (typeof window.api?.getPhotoMemberships !== 'function') return
      const res = await window.api.getPhotoMemberships({ fileLocationId: photoId, limit: 100 })
      setMemberships(res.items)
    } catch (err) {
      console.error('Failed to get photo memberships:', err)
      setMemberships([])
    }
  }, [])

  useEffect(() => {
    let active = true
    async function initCollections() {
      if (typeof window.api?.listCollections !== 'function') return
      try {
        const res = await window.api.listCollections({ limit: 100 })
        if (active) {
          setCollections(res.items)
        }
      } catch (err) {
        console.error('Failed to list collections:', err)
      }
    }
    void initCollections()
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    let active = true
    async function initMemberships() {
      if (!selectedPhoto) {
        if (active) {
          setMemberships([])
          setSaveStatus('idle')
          setStatusMessage(null)
        }
        return
      }

      if (typeof window.api?.getPhotoMemberships !== 'function') return
      try {
        const res = await window.api.getPhotoMemberships({
          fileLocationId: selectedPhoto.id,
          limit: 100
        })
        if (active) {
          setMemberships(res.items)
          setSaveStatus('idle')
          setStatusMessage(null)
        }
      } catch (err) {
        console.error('Failed to get photo memberships:', err)
        if (active) {
          setMemberships([])
          setSaveStatus('idle')
          setStatusMessage(null)
        }
      }
    }
    void initMemberships()
    return () => {
      active = false
    }
  }, [selectedPhoto])

  // Set rating
  const setRating = useCallback(
    async (rating: PhotoRating) => {
      if (!selectedPhoto) return

      // Toggle off if same rating clicked
      const newRating = selectedPhoto.rating === rating ? null : rating
      const currentFlag = selectedPhoto.flag ?? 'none'
      const expectedRevision = computePhotoRevision(selectedPhoto)
      const expectedVersion = selectedPhoto.annotationVersion ?? 0

      setSaveStatus('saving')
      setStatusMessage(null)

      try {
        const result = await window.api.setPhotoAnnotation({
          fileLocationId: selectedPhoto.id,
          expectedRevision,
          expectedVersion,
          rating: newRating,
          flag: currentFlag
        })

        updatePhotoLocal(
          selectedPhoto.id,
          result.annotation.rating,
          result.annotation.flag,
          result.annotation.version
        )
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
            removePhotoFromFilterView(selectedPhoto.id)
          }
        }
      } catch (err: unknown) {
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
    },
    [selectedPhoto, ratingFilter, updatePhotoLocal, removePhotoFromFilterView]
  )

  // Set flag
  const setFlag = useCallback(
    async (flag: PhotoFlag) => {
      if (!selectedPhoto) return

      const currentRating = selectedPhoto.rating ?? null
      const expectedRevision = computePhotoRevision(selectedPhoto)
      const expectedVersion = selectedPhoto.annotationVersion ?? 0

      setSaveStatus('saving')
      setStatusMessage(null)

      try {
        const result = await window.api.setPhotoAnnotation({
          fileLocationId: selectedPhoto.id,
          expectedRevision,
          expectedVersion,
          rating: currentRating,
          flag
        })

        updatePhotoLocal(
          selectedPhoto.id,
          result.annotation.rating,
          result.annotation.flag,
          result.annotation.version
        )
        setSaveStatus('saved')

        // Check if photo still matches flag filter
        if (flagFilter !== 'all' && flag !== flagFilter) {
          removePhotoFromFilterView(selectedPhoto.id)
        }
      } catch (err: unknown) {
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
    },
    [selectedPhoto, flagFilter, updatePhotoLocal, removePhotoFromFilterView]
  )

  // Create collection
  const createCollection = useCallback(
    async (name: string) => {
      try {
        const res = await window.api.createCollection({ name })
        await loadCollections()
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
        await loadCollections()
        if (selectedPhoto) {
          await loadMemberships(selectedPhoto.id)
        }
        return res.collection
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        setStatusMessage(message)
        throw err
      }
    },
    [selectedPhoto, loadCollections, loadMemberships]
  )

  // Add collection member
  const addCollectionMember = useCallback(
    async (collectionId: number) => {
      if (!selectedPhoto) return

      try {
        await window.api.addCollectionMember({
          collectionId,
          fileLocationId: selectedPhoto.id
        })
        await loadMemberships(selectedPhoto.id)
        await loadCollections()
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        setStatusMessage(message)
      }
    },
    [selectedPhoto, loadMemberships, loadCollections]
  )

  // Remove collection member
  const removeCollectionMember = useCallback(
    async (collectionId: number) => {
      if (!selectedPhoto) return

      try {
        await window.api.removeCollectionMember({
          collectionId,
          fileLocationId: selectedPhoto.id
        })
        await loadMemberships(selectedPhoto.id)
        await loadCollections()

        if (collectionIdFilter === collectionId) {
          removePhotoFromFilterView(selectedPhoto.id)
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
    memberships,
    saveStatus,
    statusMessage,
    setRating,
    setFlag,
    createCollection,
    renameCollection,
    addCollectionMember,
    removeCollectionMember,
    refreshCollections: loadCollections
  }
}
