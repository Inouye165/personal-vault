import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { PhotosPanel } from '../../src/renderer/src/components/PhotosPanel'
import type { PhotoItem, CollectionItem } from '../../src/shared/validation/ipc-schemas'

describe('Photos Review Persistence Propagation & Bounded UI (Findings 1 & 2)', () => {
  const mockPhoto: PhotoItem = {
    id: 101,
    sourceId: 1,
    originalPath: '/test/photo1.jpg',
    fileName: 'photo1.jpg',
    extension: '.jpg',
    category: 'photo',
    byteSize: 1024,
    filesystemBirthtimeMs: 1000,
    filesystemMtimeMs: 2000,
    inferredCaptureTimeMs: null,
    firstDiscoveredAtMs: 1000,
    lastSeenAtMs: 2000,
    discoveryObservationId: 1,
    activeHash: 'hash-1',
    activeHashVerifiedAtMs: null,
    rating: null,
    flag: 'none',
    annotationVersion: 0
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      getPhotosPage: vi.fn().mockResolvedValue({
        items: [mockPhoto],
        totalCount: 1,
        offset: 0,
        limit: 50
      }),
      listCollections: vi.fn().mockResolvedValue({
        items: [],
        totalCount: 0,
        hasMore: false,
        offset: 0,
        limit: 50
      }),
      getPhotoMemberships: vi.fn().mockResolvedValue({
        items: [],
        totalCount: 0,
        hasMore: false,
        offset: 0,
        limit: 50
      }),
      getThumbnail: vi.fn().mockResolvedValue({
        status: 'ready',
        dataUrl: 'data:image/webp;base64,fake'
      }),
      setPhotoAnnotation: vi.fn(),
      reconcileJournal: vi.fn().mockResolvedValue({ success: true, reconciledCount: 1 }),
      createCollection: vi.fn(),
      renameCollection: vi.fn(),
      addCollectionMember: vi.fn(),
      removeCollectionMember: vi.fn()
    }
  })

  it('renders honest persistence-pending status and retry button when rating commit has pending journal finalization', async () => {
    const mockSetPhotoAnnotation = vi.fn().mockResolvedValue({
      success: true,
      annotation: {
        id: 1,
        fileLocationId: 101,
        discoveryObservationId: 1,
        contentSha256: 'hash-1',
        rating: 4,
        flag: 'none',
        version: 1,
        isCurrent: true,
        createdAtMs: 1000,
        updatedAtMs: 1000
      },
      persistencePending: true,
      persistenceError: 'Disk write barrier delayed'
    })
    ;(window as unknown as { api: Record<string, unknown> }).api.setPhotoAnnotation =
      mockSetPhotoAnnotation

    render(<PhotosPanel />)

    // Wait for photo to load and select it
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Photographs/i })).toBeInTheDocument()
    })

    const card = screen.getByRole('button', { name: /Details for photo1\.jpg/i })
    fireEvent.click(card)

    // Click 4 Stars
    const starBtn = screen.getByRole('button', { name: '4 Stars' })
    fireEvent.click(starBtn)

    // Must NOT display ordinary "Saved"
    await waitFor(() => {
      expect(screen.queryByText(/^Saved$/i)).toBeNull()
    })

    // Must display honest persistence pending message
    expect(screen.getByText(/Journal finalization pending/i)).toBeInTheDocument()

    // Must show retry button
    const retryBtn = screen.getByRole('button', { name: /Retry reconciliation/i })
    expect(retryBtn).toBeInTheDocument()

    // Clicking retry reconciles journal WITHOUT repeating setPhotoAnnotation
    fireEvent.click(retryBtn)

    await waitFor(() => {
      expect(
        (window as unknown as { api: { reconcileJournal: unknown } }).api.reconcileJournal
      ).toHaveBeenCalledTimes(1)
    })
    // setPhotoAnnotation was called exactly once (original mutation), not repeated!
    expect(mockSetPhotoAnnotation).toHaveBeenCalledTimes(1)

    // Once reconciled, pending message clears
    await waitFor(() => {
      expect(screen.queryByText(/Journal finalization pending/i)).toBeNull()
    })
  })

  it('provides bounded page navigation for collections with absolute offsets and return to earlier pages', async () => {
    // Generate 120 dummy collections across 3 pages of 50
    const allCollections: CollectionItem[] = Array.from({ length: 120 }, (_, i) => ({
      id: i + 1,
      name: `Collection ${i + 1}`,
      normalizedName: `collection ${i + 1}`,
      description: null,
      photoCount: 0,
      createdAtMs: 1000,
      updatedAtMs: 1000
    }))

    const mockListCollections = vi.fn().mockImplementation(({ offset, limit }) => {
      const items = allCollections.slice(offset, offset + limit)
      return Promise.resolve({
        items,
        totalCount: allCollections.length,
        hasMore: offset + limit < allCollections.length,
        offset,
        limit
      })
    })
    ;(window as unknown as { api: Record<string, unknown> }).api.listCollections =
      mockListCollections

    render(<PhotosPanel />)

    // Select photo
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Details for photo1\.jpg/i })).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole('button', { name: /Details for photo1\.jpg/i }))

    // Initial page: collections 1 to 50
    await waitFor(() => {
      expect(screen.getByText('Collection 1')).toBeInTheDocument()
      expect(screen.getByText('Collection 50')).toBeInTheDocument()
      expect(screen.queryByText('Collection 51')).toBeNull()
    })

    // Navigate to Next page (Page 2: 51 to 100)
    const nextBtn = screen.getByRole('button', { name: /Next collections page/i })
    fireEvent.click(nextBtn)

    await waitFor(() => {
      expect(screen.getByText('Collection 51')).toBeInTheDocument()
      expect(screen.getByText('Collection 100')).toBeInTheDocument()
      // Items from Page 1 are discarded from state (bounded retention)
      expect(screen.queryByText('Collection 1')).toBeNull()
    })

    // Navigate back to Previous page (Page 1: 1 to 50)
    const prevBtn = screen.getByRole('button', { name: /Previous collections page/i })
    fireEvent.click(prevBtn)

    await waitFor(() => {
      expect(screen.getByText('Collection 1')).toBeInTheDocument()
      expect(screen.getByText('Collection 50')).toBeInTheDocument()
      expect(screen.queryByText('Collection 51')).toBeNull()
    })
  })
})
