import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePhotoReview } from '../../src/renderer/src/hooks/usePhotoReview'
import type { PhotoItem } from '../../src/shared/validation/ipc-schemas'

describe('Photo Review Stale Guards (Finding 3)', () => {
  const photoA: PhotoItem = {
    id: 101,
    sourceId: 1,
    originalPath: '/test/photo_a.jpg',
    fileName: 'photo_a.jpg',
    extension: '.jpg',
    category: 'photo',
    byteSize: 1000,
    filesystemBirthtimeMs: 1000,
    filesystemMtimeMs: 2000,
    inferredCaptureTimeMs: null,
    firstDiscoveredAtMs: 1000,
    lastSeenAtMs: 2000,
    discoveryObservationId: 1,
    activeHash: 'hash-a',
    activeHashVerifiedAtMs: null,
    rating: null,
    flag: 'none',
    annotationVersion: 0
  }

  const photoB: PhotoItem = {
    id: 102,
    sourceId: 1,
    originalPath: '/test/photo_b.jpg',
    fileName: 'photo_b.jpg',
    extension: '.jpg',
    category: 'photo',
    byteSize: 2000,
    filesystemBirthtimeMs: 1000,
    filesystemMtimeMs: 2000,
    inferredCaptureTimeMs: null,
    firstDiscoveredAtMs: 1000,
    lastSeenAtMs: 2000,
    discoveryObservationId: 2,
    activeHash: 'hash-b',
    activeHashVerifiedAtMs: null,
    rating: null,
    flag: 'none',
    annotationVersion: 0
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does NOT call updatePhotoLocal if photo selection changed before delayed save completes', async () => {
    let resolveSaveA: (val: unknown) => void
    const savePromiseA = new Promise((resolve) => {
      resolveSaveA = resolve
    })

    const mockSetPhotoAnnotation = vi.fn().mockImplementation(() => savePromiseA)
    const mockUpdatePhotoLocal = vi.fn()
    const mockRemoveFromFilter = vi.fn()

    ;(window as unknown as { api: unknown }).api = {
      listCollections: vi.fn().mockResolvedValue({ items: [], totalCount: 0, hasMore: false }),
      getPhotoMemberships: vi.fn().mockResolvedValue({ items: [], totalCount: 0, hasMore: false }),
      setPhotoAnnotation: mockSetPhotoAnnotation
    }

    const { result, rerender } = renderHook(
      ({ photo }) =>
        usePhotoReview({
          selectedPhoto: photo,
          ratingFilter: 'all',
          flagFilter: 'all',
          collectionIdFilter: null,
          updatePhotoLocal: mockUpdatePhotoLocal,
          removePhotoFromFilterView: mockRemoveFromFilter
        }),
      { initialProps: { photo: photoA } }
    )

    // User triggers rating on photo A
    act(() => {
      void result.current.setRating(5)
    })
    expect(result.current.saveStatus).toBe('saving')

    // Navigate to Photo B before save completes
    rerender({ photo: photoB })

    // Save A completes late
    await act(async () => {
      resolveSaveA!({
        success: true,
        annotation: {
          id: 1,
          fileLocationId: 101,
          discoveryObservationId: 1,
          contentSha256: 'hash-a',
          rating: 5,
          flag: 'none',
          version: 1,
          isCurrent: true,
          createdAtMs: 1000,
          updatedAtMs: 1000
        }
      })
      await Promise.resolve()
    })

    // updatePhotoLocal MUST NOT be called because selection switched away
    expect(mockUpdatePhotoLocal).not.toHaveBeenCalled()
  })

  it('prevents older save from superseding newer save on the same photo when responses arrive out of order', async () => {
    let resolveFirstSave: (val: unknown) => void
    let resolveSecondSave: (val: unknown) => void

    const firstPromise = new Promise((resolve) => {
      resolveFirstSave = resolve
    })
    const secondPromise = new Promise((resolve) => {
      resolveSecondSave = resolve
    })

    const mockSetPhotoAnnotation = vi
      .fn()
      .mockImplementationOnce(() => firstPromise)
      .mockImplementationOnce(() => secondPromise)
    const mockUpdatePhotoLocal = vi.fn()

    ;(window as unknown as { api: unknown }).api = {
      listCollections: vi.fn().mockResolvedValue({ items: [], totalCount: 0, hasMore: false }),
      getPhotoMemberships: vi.fn().mockResolvedValue({ items: [], totalCount: 0, hasMore: false }),
      setPhotoAnnotation: mockSetPhotoAnnotation
    }

    const { result } = renderHook(() =>
      usePhotoReview({
        selectedPhoto: photoA,
        ratingFilter: 'all',
        flagFilter: 'all',
        collectionIdFilter: null,
        updatePhotoLocal: mockUpdatePhotoLocal,
        removePhotoFromFilterView: vi.fn()
      })
    )

    // First rapid rating change: 3 stars
    act(() => {
      void result.current.setRating(3)
    })

    // Second rapid rating change: 5 stars
    act(() => {
      void result.current.setRating(5)
    })

    // Second save completes FIRST (e.g. newer network/IPC response)
    await act(async () => {
      resolveSecondSave!({
        success: true,
        annotation: {
          id: 1,
          fileLocationId: 101,
          discoveryObservationId: 1,
          contentSha256: 'hash-a',
          rating: 5,
          flag: 'none',
          version: 2,
          isCurrent: true,
          createdAtMs: 1000,
          updatedAtMs: 2000
        }
      })
      await Promise.resolve()
    })

    expect(mockUpdatePhotoLocal).toHaveBeenCalledTimes(1)
    expect(mockUpdatePhotoLocal).toHaveBeenCalledWith(101, 5, 'none', 2)

    // Now first save completes LATER (stale response)
    await act(async () => {
      resolveFirstSave!({
        success: true,
        annotation: {
          id: 1,
          fileLocationId: 101,
          discoveryObservationId: 1,
          contentSha256: 'hash-a',
          rating: 3,
          flag: 'none',
          version: 1,
          isCurrent: true,
          createdAtMs: 1000,
          updatedAtMs: 1000
        }
      })
      await Promise.resolve()
    })

    // updatePhotoLocal MUST NOT have been called again with the stale 3-star value!
    expect(mockUpdatePhotoLocal).toHaveBeenCalledTimes(1)
  })

  it('guards delayed membership reload from overwriting newer membership state during A -> B -> A selection', async () => {
    let resolveFirstMemberships: (val: unknown) => void
    const firstMembershipPromise = new Promise((resolve) => {
      resolveFirstMemberships = resolve
    })

    const mockGetPhotoMemberships = vi
      .fn()
      // Visit 1 for photo A: delayed
      .mockImplementationOnce(() => firstMembershipPromise)
      // Visit 1 for photo B: immediate
      .mockResolvedValueOnce({
        items: [
          {
            id: 99,
            collectionId: 99,
            collectionName: 'B-Col',
            fileLocationId: 102,
            createdAtMs: 1000
          }
        ],
        totalCount: 1,
        hasMore: false
      })
      // Visit 2 for photo A: immediate with new collection
      .mockResolvedValueOnce({
        items: [
          {
            id: 2,
            collectionId: 2,
            collectionName: 'Visit-2-Col',
            fileLocationId: 101,
            createdAtMs: 2000
          }
        ],
        totalCount: 1,
        hasMore: false
      })

    ;(window as unknown as { api: unknown }).api = {
      listCollections: vi.fn().mockResolvedValue({ items: [], totalCount: 0, hasMore: false }),
      getPhotoMemberships: mockGetPhotoMemberships
    }

    const { result, rerender } = renderHook(
      ({ photo }) =>
        usePhotoReview({
          selectedPhoto: photo,
          ratingFilter: 'all',
          flagFilter: 'all',
          collectionIdFilter: null,
          updatePhotoLocal: vi.fn(),
          removePhotoFromFilterView: vi.fn()
        }),
      { initialProps: { photo: photoA } }
    )

    // Switch to Photo B
    rerender({ photo: photoB })
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.memberships.map((m) => m.collectionName)).toEqual(['B-Col'])

    // Switch back to Photo A (Visit 2)
    rerender({ photo: photoA })
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.memberships.map((m) => m.collectionName)).toEqual(['Visit-2-Col'])

    // Now delayed visit 1 for Photo A completes
    await act(async () => {
      resolveFirstMemberships!({
        items: [
          {
            id: 1,
            collectionId: 1,
            collectionName: 'Stale-Visit-1-Col',
            fileLocationId: 101,
            createdAtMs: 1000
          }
        ],
        totalCount: 1,
        hasMore: false
      })
      await Promise.resolve()
    })

    // Stale memberships from visit 1 MUST NOT overwrite visit 2 memberships!
    expect(result.current.memberships.map((m) => m.collectionName)).toEqual(['Visit-2-Col'])
  })

  it('invalidates pending work on unmount and prevents state updates', async () => {
    let resolveSave: (val: unknown) => void
    const savePromise = new Promise((resolve) => {
      resolveSave = resolve
    })

    const mockUpdatePhotoLocal = vi.fn()
    ;(window as unknown as { api: unknown }).api = {
      listCollections: vi.fn().mockResolvedValue({ items: [], totalCount: 0, hasMore: false }),
      getPhotoMemberships: vi.fn().mockResolvedValue({ items: [], totalCount: 0, hasMore: false }),
      setPhotoAnnotation: vi.fn().mockImplementation(() => savePromise)
    }

    const { result, unmount } = renderHook(() =>
      usePhotoReview({
        selectedPhoto: photoA,
        ratingFilter: 'all',
        flagFilter: 'all',
        collectionIdFilter: null,
        updatePhotoLocal: mockUpdatePhotoLocal,
        removePhotoFromFilterView: vi.fn()
      })
    )

    act(() => {
      void result.current.setRating(4)
    })

    // Unmount before save completes
    unmount()

    // Resolve save
    await act(async () => {
      resolveSave!({
        success: true,
        annotation: {
          id: 1,
          fileLocationId: 101,
          discoveryObservationId: 1,
          contentSha256: 'hash-a',
          rating: 4,
          flag: 'none',
          version: 1,
          isCurrent: true,
          createdAtMs: 1000,
          updatedAtMs: 1000
        }
      })
      await Promise.resolve()
    })

    // Must not call updatePhotoLocal after unmount
    expect(mockUpdatePhotoLocal).not.toHaveBeenCalled()
  })
})
