import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PhotosPanel } from '../../src/renderer/src/components/PhotosPanel'
import type { VaultApi } from '../../src/preload/index.d'

describe('PhotosPanel Review & Collections UI (Stage 5B)', () => {
  const mockPhoto1 = {
    id: 101,
    sourceId: 1,
    originalPath: 'C:\\Users\\Ron\\Pictures\\sunset.jpg',
    fileName: 'sunset.jpg',
    extension: '.jpg',
    category: 'photo' as const,
    discoveryObservationId: 1,
    byteSize: 1048576,
    filesystemBirthtimeMs: 1700000000000,
    filesystemMtimeMs: 1700000005000,
    inferredCaptureTimeMs: null,
    firstDiscoveredAtMs: 1700000010000,
    lastSeenAtMs: 1700000010000,
    activeHash: 'a'.repeat(64),
    activeHashVerifiedAtMs: 1700000020000,
    rating: 4,
    flag: 'pick' as const,
    annotationVersion: 1
  }

  const mockPhoto2 = {
    id: 102,
    sourceId: 1,
    originalPath: 'C:\\Users\\Ron\\Pictures\\mountain.jpg',
    fileName: 'mountain.jpg',
    extension: '.jpg',
    category: 'photo' as const,
    discoveryObservationId: 2,
    byteSize: 2048576,
    filesystemBirthtimeMs: 1700000000000,
    filesystemMtimeMs: 1700000005000,
    inferredCaptureTimeMs: null,
    firstDiscoveredAtMs: 1700000010000,
    lastSeenAtMs: 1700000010000,
    activeHash: 'b'.repeat(64),
    activeHashVerifiedAtMs: 1700000020000,
    rating: null,
    flag: 'none' as const,
    annotationVersion: 0
  }

  let mockGetPhotosPage: ReturnType<typeof vi.fn>
  let mockGetThumbnail: ReturnType<typeof vi.fn>
  let mockSetPhotoAnnotation: ReturnType<typeof vi.fn>
  let mockGetPhotoAnnotation: ReturnType<typeof vi.fn>
  let mockListCollections: ReturnType<typeof vi.fn>
  let mockCreateCollection: ReturnType<typeof vi.fn>
  let mockRenameCollection: ReturnType<typeof vi.fn>
  let mockAddCollectionMember: ReturnType<typeof vi.fn>
  let mockRemoveCollectionMember: ReturnType<typeof vi.fn>
  let mockGetPhotoMemberships: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.restoreAllMocks()

    mockGetPhotosPage = vi.fn().mockResolvedValue({
      items: [mockPhoto1, mockPhoto2],
      totalCount: 2,
      offset: 0,
      limit: 50,
      hasMore: false
    })

    mockGetThumbnail = vi.fn().mockResolvedValue({
      status: 'ready',
      locationId: 101,
      dataUrl: 'data:image/webp;base64,AAA=',
      mimeType: 'image/webp',
      width: 100,
      height: 100
    })

    mockSetPhotoAnnotation = vi.fn().mockResolvedValue({
      success: true,
      annotation: {
        id: 1,
        fileLocationId: 101,
        discoveryObservationId: 1,
        contentSha256: 'a'.repeat(64),
        rating: 5,
        flag: 'pick',
        version: 2,
        isCurrent: true,
        createdAtMs: 1700000000000,
        updatedAtMs: 1700000000000
      }
    })

    mockGetPhotoAnnotation = vi.fn().mockResolvedValue({
      annotation: {
        id: 1,
        fileLocationId: 101,
        discoveryObservationId: 1,
        contentSha256: 'a'.repeat(64),
        rating: 4,
        flag: 'pick',
        version: 1,
        isCurrent: true,
        createdAtMs: 1700000000000,
        updatedAtMs: 1700000000000
      }
    })

    mockListCollections = vi.fn().mockResolvedValue({
      items: [
        {
          id: 1,
          name: 'Vacation',
          normalizedName: 'vacation',
          createdAtMs: 1700000000000,
          updatedAtMs: 1700000000000,
          photoCount: 1
        }
      ],
      totalCount: 1,
      offset: 0,
      limit: 50,
      hasMore: false
    })

    mockCreateCollection = vi.fn().mockResolvedValue({
      collection: {
        id: 2,
        name: 'Family',
        normalizedName: 'family',
        createdAtMs: 1700000000000,
        updatedAtMs: 1700000000000,
        photoCount: 0
      }
    })

    mockRenameCollection = vi.fn().mockResolvedValue({
      collection: {
        id: 1,
        name: 'Holiday Vacation',
        normalizedName: 'holiday vacation',
        createdAtMs: 1700000000000,
        updatedAtMs: 1700000000000
      }
    })

    mockAddCollectionMember = vi.fn().mockResolvedValue({
      success: true,
      isNew: true
    })

    mockRemoveCollectionMember = vi.fn().mockResolvedValue({
      success: true
    })

    mockGetPhotoMemberships = vi.fn().mockResolvedValue({
      items: [
        {
          id: 1,
          collectionId: 1,
          collectionName: 'Vacation',
          fileLocationId: 101,
          createdAtMs: 1700000000000
        }
      ],
      totalCount: 1,
      hasMore: false
    })

    window.api = {
      ...window.api,
      getPhotosPage: mockGetPhotosPage,
      getThumbnail: mockGetThumbnail,
      setPhotoAnnotation: mockSetPhotoAnnotation,
      getPhotoAnnotation: mockGetPhotoAnnotation,
      listCollections: mockListCollections,
      createCollection: mockCreateCollection,
      renameCollection: mockRenameCollection,
      addCollectionMember: mockAddCollectionMember,
      removeCollectionMember: mockRemoveCollectionMember,
      getPhotoMemberships: mockGetPhotoMemberships
    } as unknown as VaultApi
  })

  it('renders compact saved rating and flag badges on grid cells', async () => {
    render(<PhotosPanel />)

    await waitFor(() => {
      expect(screen.getByText('sunset.jpg')).toBeInTheDocument()
    })

    // Cell 101 has rating 4 and flag pick
    const cell101 = screen.getByRole('button', { name: /sunset\.jpg/i })
    expect(cell101).toHaveTextContent(/4/i)
    expect(cell101).toHaveTextContent(/pick/i)
  })

  it('provides rating and flag controls in details panel and triggers save', async () => {
    render(<PhotosPanel />)

    await waitFor(() => {
      expect(screen.getByText('sunset.jpg')).toBeInTheDocument()
    })

    // Select photo 101
    fireEvent.click(screen.getByRole('button', { name: /sunset\.jpg/i }))

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Photograph Details/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /5 Stars/i })).toBeInTheDocument()
    })

    // Rate 5 stars
    fireEvent.click(screen.getByRole('button', { name: /5 Stars/i }))

    await waitFor(() => {
      expect(mockSetPhotoAnnotation).toHaveBeenCalledWith(
        expect.objectContaining({
          fileLocationId: 101,
          rating: 5
        })
      )
    })
  })

  it('provides flag controls (None, Pick, Reject) and updates flag', async () => {
    render(<PhotosPanel />)

    await waitFor(() => {
      expect(screen.getByText('sunset.jpg')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: /sunset\.jpg/i }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Reject/i })).toBeInTheDocument()
    })

    // Click Reject
    fireEvent.click(screen.getByRole('button', { name: /Reject/i }))

    await waitFor(() => {
      expect(mockSetPhotoAnnotation).toHaveBeenCalledWith(
        expect.objectContaining({
          fileLocationId: 101,
          flag: 'reject'
        })
      )
    })
  })

  it('provides collection creation and membership controls in details panel', async () => {
    render(<PhotosPanel />)

    await waitFor(() => {
      expect(screen.getByText('sunset.jpg')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: /sunset\.jpg/i }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Remove from Vacation/i })).toBeInTheDocument()
    })

    // Remove from collection
    fireEvent.click(screen.getByRole('button', { name: /Remove from Vacation/i }))
    await waitFor(() => {
      expect(mockRemoveCollectionMember).toHaveBeenCalledWith(
        expect.objectContaining({
          collectionId: 1,
          fileLocationId: 101
        })
      )
    })
  })

  it('filters photos by rating, flag, and collection with Reset filters action', async () => {
    render(<PhotosPanel />)

    await waitFor(() => {
      expect(screen.getByText('sunset.jpg')).toBeInTheDocument()
    })

    // Change rating filter to 4+
    const ratingFilter = screen.getByLabelText(/Filter by Rating/i)
    fireEvent.change(ratingFilter, { target: { value: '4' } })

    await waitFor(() => {
      expect(mockGetPhotosPage).toHaveBeenCalledWith(
        expect.objectContaining({
          ratingFilter: '4'
        })
      )
    })

    // Click Reset filters
    const resetBtn = screen.getByRole('button', { name: /Reset filters/i })
    fireEvent.click(resetBtn)

    await waitFor(() => {
      expect(mockGetPhotosPage).toHaveBeenCalledWith(
        expect.objectContaining({
          ratingFilter: 'all',
          flagFilter: 'all',
          collectionId: null
        })
      )
    })
  })

  it('displays conflict message when stale revision or annotation version conflict occurs', async () => {
    mockSetPhotoAnnotation.mockRejectedValueOnce(
      new Error('STALE_REVISION: Photo content revision does not match expected revision')
    )

    render(<PhotosPanel />)

    await waitFor(() => {
      expect(screen.getByText('sunset.jpg')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: /sunset\.jpg/i }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /5 Stars/i })).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: /5 Stars/i }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Conflict/i)
    })
  })
})
