import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { usePhotoReview } from '../../src/renderer/src/hooks/usePhotoReview'
import type { PhotoItem, PhotoFlagFilter } from '../../src/shared/validation/ipc-schemas'

describe('Renderer Response Safety & Bounded Navigation (Finding 4)', () => {
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

  it('guards A -> B -> A rapid selection from applying stale in-flight save results from earlier visit', async () => {
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

    // User initiates save on Photo A (Gen 1)
    act(() => {
      void result.current.setRating(5)
    })
    expect(result.current.saveStatus).toBe('saving')

    // Rapidly switch to Photo B
    rerender({ photo: photoB })
    expect(result.current.saveStatus).toBe('idle')

    // Rapidly switch back to Photo A (Gen 3)
    rerender({ photo: photoA })
    expect(result.current.saveStatus).toBe('idle')

    // Now resolve delayed save from Gen 1
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

    // The delayed Gen 1 completion MUST NOT mark current Gen 3 selection as 'saved'
    expect(result.current.saveStatus).toBe('idle')
  })

  it('does not evict photo if filter changed while save was in flight', async () => {
    let resolveSave: (val: unknown) => void
    const savePromise = new Promise((resolve) => {
      resolveSave = resolve
    })

    const mockSetPhotoAnnotation = vi.fn().mockImplementation(() => savePromise)
    const mockUpdatePhotoLocal = vi.fn()
    const mockRemoveFromFilter = vi.fn()

    ;(window as unknown as { api: unknown }).api = {
      listCollections: vi.fn().mockResolvedValue({ items: [], totalCount: 0, hasMore: false }),
      getPhotoMemberships: vi.fn().mockResolvedValue({ items: [], totalCount: 0, hasMore: false }),
      setPhotoAnnotation: mockSetPhotoAnnotation
    }

    const { result, rerender } = renderHook(
      ({ photo, flagFilter }: { photo: PhotoItem; flagFilter: PhotoFlagFilter }) =>
        usePhotoReview({
          selectedPhoto: photo,
          ratingFilter: 'all',
          flagFilter,
          collectionIdFilter: null,
          updatePhotoLocal: mockUpdatePhotoLocal,
          removePhotoFromFilterView: mockRemoveFromFilter
        }),
      {
        initialProps: {
          photo: { ...photoA, flag: 'pick' as const },
          flagFilter: 'pick' as PhotoFlagFilter
        }
      }
    )

    // User unflags photo under Pick filter (which would normally evict)
    act(() => {
      void result.current.setFlag('none')
    })

    // While save is in flight, user switches filter to 'all'
    rerender({
      photo: { ...photoA, flag: 'pick' as const },
      flagFilter: 'all' as PhotoFlagFilter
    })

    // Save resolves
    await act(async () => {
      resolveSave!({
        success: true,
        annotation: {
          id: 1,
          fileLocationId: 101,
          discoveryObservationId: 1,
          contentSha256: 'hash-a',
          rating: null,
          flag: 'none',
          version: 1,
          isCurrent: true,
          createdAtMs: 1000,
          updatedAtMs: 1000
        }
      })
      await Promise.resolve()
    })

    // Must NOT call removeFromFilterView because filter was changed to 'all'
    expect(mockRemoveFromFilter).not.toHaveBeenCalled()
  })

  it('exposes membership error and retry when fetching photo memberships fails', async () => {
    const mockGetPhotoMemberships = vi
      .fn()
      .mockRejectedValueOnce(new Error('Failed to load memberships: IPC timeout'))
      .mockResolvedValueOnce({
        items: [
          {
            id: 1,
            collectionId: 10,
            collectionName: 'Summer',
            fileLocationId: 101,
            createdAtMs: 1000
          }
        ],
        totalCount: 1,
        hasMore: false
      })

    ;(window as unknown as { api: unknown }).api = {
      listCollections: vi.fn().mockResolvedValue({ items: [], totalCount: 0, hasMore: false }),
      getPhotoMemberships: mockGetPhotoMemberships,
      setPhotoAnnotation: vi.fn()
    }

    const { result } = renderHook(() =>
      usePhotoReview({
        selectedPhoto: photoA,
        ratingFilter: 'all',
        flagFilter: 'all',
        collectionIdFilter: null,
        updatePhotoLocal: vi.fn(),
        removePhotoFromFilterView: vi.fn()
      })
    )

    await waitFor(() => {
      expect(result.current.membershipError).toBe('Failed to load memberships: IPC timeout')
    })

    // Retry should fetch again and clear error
    await act(async () => {
      await result.current.retryLoadMemberships()
    })

    expect(result.current.membershipError).toBeNull()
    expect(result.current.memberships.length).toBe(1)
    expect(result.current.memberships[0]?.collectionName).toBe('Summer')
  })
})
