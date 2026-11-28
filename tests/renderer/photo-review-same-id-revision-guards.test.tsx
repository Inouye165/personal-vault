import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { PhotosPanel } from '../../src/renderer/src/components/PhotosPanel'
import { usePhotoReview } from '../../src/renderer/src/hooks/usePhotoReview'
import type { PhotoItem } from '../../src/shared/validation/ipc-schemas'

describe('Same-Photo Revision & Response Guards (Finding 2)', () => {
  const basePhoto: PhotoItem = {
    id: 101,
    sourceId: 1,
    originalPath: '/test/photo1.jpg',
    fileName: 'photo1.jpg',
    extension: '.jpg',
    category: 'photo',
    byteSize: 1000,
    filesystemBirthtimeMs: 1000,
    filesystemMtimeMs: 2000,
    inferredCaptureTimeMs: null,
    firstDiscoveredAtMs: 1000,
    lastSeenAtMs: 2000,
    discoveryObservationId: 1,
    activeHash: 'hash-v1',
    activeHashVerifiedAtMs: null,
    rating: null,
    flag: 'none',
    annotationVersion: 0
  }

  // Same ID 101, but content modified on disk (different byteSize, mtime, activeHash) -> new revision!
  const modifiedPhoto: PhotoItem = {
    ...basePhoto,
    byteSize: 1500,
    filesystemMtimeMs: 3000,
    activeHash: 'hash-v2'
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('detects same-ID content replacement, advances generation, and rejects delayed save from prior revision', async () => {
    let resolveSaveV1: (val: unknown) => void
    const savePromiseV1 = new Promise((resolve) => {
      resolveSaveV1 = resolve
    })

    const mockSetPhotoAnnotation = vi.fn().mockImplementation(() => savePromiseV1)
    const mockUpdatePhotoLocal = vi.fn()

    ;(window as unknown as { api: Record<string, unknown> }).api = {
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
          removePhotoFromFilterView: vi.fn()
        }),
      { initialProps: { photo: basePhoto } }
    )

    // User rates basePhoto (v1) with 4 stars
    act(() => {
      void result.current.setRating(4)
    })
    expect(result.current.saveStatus).toBe('saving')

    // While save is in flight, photo is modified out-of-band on disk; rescan produces modifiedPhoto (same ID 101, new revision!)
    rerender({ photo: modifiedPhoto })

    // Selection generation must have advanced; save status must reset to idle
    expect(result.current.saveStatus).toBe('idle')

    // Now delayed save for v1 resolves
    await act(async () => {
      resolveSaveV1!({
        success: true,
        annotation: {
          id: 1,
          fileLocationId: 101,
          discoveryObservationId: 1,
          contentSha256: 'hash-v1',
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

    // Stale v1 response MUST NOT call updatePhotoLocal on current v2 photo!
    expect(mockUpdatePhotoLocal).not.toHaveBeenCalled()
    expect(result.current.saveStatus).toBe('idle')
  })

  it('invalidates old memberships and reloads when photo revision changes for same photo ID', async () => {
    const mockGetPhotoMemberships = vi
      .fn()
      // Initial load for v1: returns Col-A
      .mockResolvedValueOnce({
        items: [
          {
            id: 1,
            collectionId: 10,
            collectionName: 'Col-A',
            fileLocationId: 101,
            createdAtMs: 1000
          }
        ],
        totalCount: 1,
        hasMore: false
      })
      // Subsequent load for v2 (same ID, new revision): returns empty memberships
      .mockResolvedValueOnce({
        items: [],
        totalCount: 0,
        hasMore: false
      })

    ;(window as unknown as { api: Record<string, unknown> }).api = {
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
      { initialProps: { photo: basePhoto } }
    )

    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.memberships.map((m) => m.collectionName)).toEqual(['Col-A'])

    // Photo modified on disk (same ID, new revision)
    rerender({ photo: modifiedPhoto })

    await act(async () => {
      await Promise.resolve()
    })

    // Memberships for v2 must be reloaded and old Col-A must be cleared!
    expect(result.current.memberships).toEqual([])
    expect(mockGetPhotoMemberships).toHaveBeenCalledTimes(2)
  })

  it('prevents delayed membership mutation completion from updating memberships if photo revision changed mid-flight', async () => {
    let resolveAddMember: (val: unknown) => void
    const addPromise = new Promise((resolve) => {
      resolveAddMember = resolve
    })

    const mockAddCollectionMember = vi.fn().mockImplementation(() => addPromise)
    const mockGetPhotoMemberships = vi.fn().mockResolvedValue({
      items: [
        {
          id: 1,
          collectionId: 10,
          collectionName: 'Col-10',
          fileLocationId: 101,
          createdAtMs: 1000
        }
      ],
      totalCount: 1,
      hasMore: false
    })

    ;(window as unknown as { api: Record<string, unknown> }).api = {
      listCollections: vi.fn().mockResolvedValue({ items: [], totalCount: 0, hasMore: false }),
      getPhotoMemberships: mockGetPhotoMemberships,
      addCollectionMember: mockAddCollectionMember
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
      { initialProps: { photo: basePhoto } }
    )

    // User adds photo to collection 10
    act(() => {
      void result.current.addCollectionMember(10)
    })

    // Before addCollectionMember resolves, photo content changes to v2
    rerender({ photo: modifiedPhoto })

    await act(async () => {
      await Promise.resolve()
    })

    // Now delayed addCollectionMember resolves
    await act(async () => {
      resolveAddMember!({ success: true, isNew: true })
      await Promise.resolve()
    })

    // Since photo revision changed mid-flight, addCollectionMember must NOT trigger loadMemberships a 3rd time
    expect(mockGetPhotoMemberships).toHaveBeenCalledTimes(2)
    // And memberships for v2 remains unpolluted
    expect(result.current.memberships.map((m) => m.collectionName)).toEqual(['Col-10'])
  })

  it('prevents stale delayed save from updating DOM cached badges or memberships across same-ID revision change', async () => {
    let resolveSave: (val: unknown) => void
    const savePromise = new Promise((resolve) => {
      resolveSave = resolve
    })

    const mockSetPhotoAnnotation = vi.fn().mockImplementation(() => savePromise)
    const mockGetPhotosPage = vi.fn().mockResolvedValue({
      items: [basePhoto],
      totalCount: 1,
      offset: 0,
      limit: 50
    })

    ;(window as unknown as { api: Record<string, unknown> }).api = {
      getPhotosPage: mockGetPhotosPage,
      listCollections: vi.fn().mockResolvedValue({ items: [], totalCount: 0, hasMore: false }),
      getPhotoMemberships: vi.fn().mockResolvedValue({
        items: [
          {
            id: 1,
            collectionId: 10,
            collectionName: 'Original-Col',
            fileLocationId: 101,
            createdAtMs: 1000
          }
        ],
        totalCount: 1,
        hasMore: false
      }),
      getThumbnail: vi
        .fn()
        .mockResolvedValue({ status: 'ready', dataUrl: 'data:image/webp;base64,fake' }),
      setPhotoAnnotation: mockSetPhotoAnnotation,
      reconcileJournal: vi.fn().mockResolvedValue({ success: true, reconciledCount: 0 })
    }

    render(<PhotosPanel />)

    // Wait for photo to load and click it
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Details for photo1\.jpg/i })).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole('button', { name: /Details for photo1\.jpg/i }))

    // Membership badge "Original-Col" is visible
    expect(await screen.findByText('Original-Col')).toBeInTheDocument()

    // User clicks 4 Stars
    const starBtn = screen.getByRole('button', { name: '4 Stars' })
    fireEvent.click(starBtn)

    // Save is in flight. Now simulate catalog reload where photo1 has been modified out-of-band (new revision)
    mockGetPhotosPage.mockResolvedValueOnce({
      items: [modifiedPhoto],
      totalCount: 1,
      offset: 0,
      limit: 50
    })
    ;(window as unknown as { api: Record<string, unknown> }).api.getPhotoMemberships = vi
      .fn()
      .mockResolvedValue({
        items: [
          {
            id: 2,
            collectionId: 20,
            collectionName: 'Updated-Col',
            fileLocationId: 101,
            createdAtMs: 2000
          }
        ],
        totalCount: 1,
        hasMore: false
      })

    // Click Refresh toolbar button
    const refreshBtn = screen.getByRole('button', { name: /^Refresh$/i })
    fireEvent.click(refreshBtn)

    // Select the refreshed photo
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Details for photo1\.jpg/i })).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole('button', { name: /Details for photo1\.jpg/i }))

    // Updated membership is visible
    expect(await screen.findByText('Updated-Col')).toBeInTheDocument()

    // Now resolve the delayed save for the old revision
    await act(async () => {
      resolveSave!({
        success: true,
        annotation: {
          id: 1,
          fileLocationId: 101,
          discoveryObservationId: 1,
          contentSha256: 'hash-v1',
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

    // The photo cell in the grid MUST NOT show 4 stars in its aria-label or active star buttons!
    const photoCell = screen.getByTestId('photo-open-btn-101')
    expect(photoCell.getAttribute('aria-label')).toContain('unrated')
    expect(starBtn).not.toHaveClass('active')
  })
})
