import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PhotosPanel } from '../../src/renderer/src/components/PhotosPanel'
import type { VaultApi } from '../../src/preload/index.d'

describe('PhotosPanel Concurrency & Complete Collection Controls (Findings 4 & 5)', () => {
  const photoA = {
    id: 101,
    sourceId: 1,
    originalPath: 'C:\\photos\\a.jpg',
    fileName: 'a.jpg',
    extension: '.jpg',
    category: 'photo' as const,
    discoveryObservationId: 1,
    byteSize: 1000,
    filesystemBirthtimeMs: 1700000000000,
    filesystemMtimeMs: 1700000000000,
    inferredCaptureTimeMs: null,
    firstDiscoveredAtMs: 1700000000000,
    lastSeenAtMs: 1700000000000,
    activeHash: 'a'.repeat(64),
    activeHashVerifiedAtMs: 1700000000000,
    rating: null,
    flag: 'none' as const,
    annotationVersion: 0
  }

  const photoB = {
    id: 102,
    sourceId: 1,
    originalPath: 'C:\\photos\\b.jpg',
    fileName: 'b.jpg',
    extension: '.jpg',
    category: 'photo' as const,
    discoveryObservationId: 2,
    byteSize: 2000,
    filesystemBirthtimeMs: 1700000000000,
    filesystemMtimeMs: 1700000000000,
    inferredCaptureTimeMs: null,
    firstDiscoveredAtMs: 1700000000000,
    lastSeenAtMs: 1700000000000,
    activeHash: 'b'.repeat(64),
    activeHashVerifiedAtMs: 1700000000000,
    rating: null,
    flag: 'none' as const,
    annotationVersion: 0
  }

  let mockGetPhotosPage: ReturnType<typeof vi.fn>
  let mockGetThumbnail: ReturnType<typeof vi.fn>
  let mockSetPhotoAnnotation: ReturnType<typeof vi.fn>
  let mockListCollections: ReturnType<typeof vi.fn>
  let mockRenameCollection: ReturnType<typeof vi.fn>
  let mockAddCollectionMember: ReturnType<typeof vi.fn>
  let mockGetPhotoMemberships: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.restoreAllMocks()

    mockGetPhotosPage = vi.fn().mockResolvedValue({
      items: [photoA, photoB],
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

    mockSetPhotoAnnotation = vi.fn()
    mockRenameCollection = vi.fn().mockResolvedValue({
      collection: {
        id: 1,
        name: 'Summer Trips',
        normalizedName: 'summer trips',
        createdAtMs: 1700000000000,
        updatedAtMs: 1700000010000
      }
    })
    mockAddCollectionMember = vi.fn().mockResolvedValue({ success: true, isNew: true })

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

    mockGetPhotoMemberships = vi.fn().mockResolvedValue({
      items: [],
      totalCount: 0,
      hasMore: false
    })

    window.api = {
      ...window.api,
      getPhotosPage: mockGetPhotosPage,
      getThumbnail: mockGetThumbnail,
      cancelThumbnail: vi.fn(),
      getPhotosDiagnostics: vi.fn(),
      setPhotoAnnotation: mockSetPhotoAnnotation,
      getPhotoAnnotation: vi.fn(),
      listCollections: mockListCollections,
      createCollection: vi.fn(),
      renameCollection: mockRenameCollection,
      addCollectionMember: mockAddCollectionMember,
      removeCollectionMember: vi.fn(),
      getPhotoMemberships: mockGetPhotoMemberships
    } as unknown as VaultApi
  })

  it('does not apply delayed save state or rating to a newly selected photo after rapid selection switch', async () => {
    let resolvePhotoASave!: (val: unknown) => void
    const slowSavePromise = new Promise((resolve) => {
      resolvePhotoASave = resolve
    })
    mockSetPhotoAnnotation.mockImplementation(() => slowSavePromise)

    render(<PhotosPanel />)
    await waitFor(() => expect(screen.getByText('a.jpg')).toBeInTheDocument())

    // 1. Select photo A
    fireEvent.click(screen.getByRole('button', { name: /Details for a\.jpg/i }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /5 Stars/i })).toBeInTheDocument()
    )

    // 2. Click Rate 5 stars on photo A (initiating slow async save)
    fireEvent.click(screen.getByRole('button', { name: /5 Stars/i }))
    expect(screen.getByText(/Saving\.\.\./i)).toBeInTheDocument()

    // 3. Immediately switch selection to photo B before photo A's save resolves
    fireEvent.click(screen.getByRole('button', { name: /Details for b\.jpg/i }))
    await waitFor(() => expect(screen.getAllByText('b.jpg').length).toBeGreaterThanOrEqual(1))

    // Photo B's status must NOT be 'Saving...'
    expect(screen.queryByText(/Saving\.\.\./i)).not.toBeInTheDocument()

    // 4. Resolve photo A's save
    resolvePhotoASave({
      success: true,
      annotation: {
        id: 1,
        fileLocationId: 101,
        discoveryObservationId: 1,
        contentSha256: 'a'.repeat(64),
        rating: 5,
        flag: 'none',
        version: 1,
        isCurrent: true,
        createdAtMs: 1700000000000,
        updatedAtMs: 1700000000000
      }
    })

    // Wait microtask tick
    await new Promise((r) => setTimeout(r, 50))

    // Crucial: Photo B is currently selected. It must NOT show "Saved" from photo A!
    expect(screen.queryByText(/^Saved$/i)).not.toBeInTheDocument()
  })

  it('exposes accessible collection rename controls in the details panel', async () => {
    render(<PhotosPanel />)
    await waitFor(() => expect(screen.getByText('a.jpg')).toBeInTheDocument())

    // Select photo A
    fireEvent.click(screen.getByRole('button', { name: /Details for a\.jpg/i }))
    await waitFor(() => expect(screen.getByText('Vacation')).toBeInTheDocument())

    // Must have accessible rename button for collection
    const renameBtn = screen.getByRole('button', { name: /Rename collection Vacation/i })
    expect(renameBtn).toBeInTheDocument()

    fireEvent.click(renameBtn)

    // Should expose rename input and save button
    const renameInput = screen.getByRole('textbox', { name: /New name for collection Vacation/i })
    expect(renameInput).toBeInTheDocument()

    fireEvent.change(renameInput, { target: { value: 'Summer Trips' } })
    const saveRenameBtn = screen.getByRole('button', { name: /Save collection name/i })
    fireEvent.click(saveRenameBtn)

    await waitFor(() => {
      expect(mockRenameCollection).toHaveBeenCalledWith({
        collectionId: 1,
        name: 'Summer Trips'
      })
    })
  })

  it('passes expectedRevision on addCollectionMember', async () => {
    render(<PhotosPanel />)
    await waitFor(() => expect(screen.getByText('a.jpg')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /Details for a\.jpg/i }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Add to Vacation/i })).toBeInTheDocument()
    )

    fireEvent.click(screen.getByRole('button', { name: /Add to Vacation/i }))

    await waitFor(() => {
      expect(mockAddCollectionMember).toHaveBeenCalledWith(
        expect.objectContaining({
          collectionId: 1,
          fileLocationId: 101,
          expectedRevision: expect.stringMatching(/^rev:1:1000:/)
        })
      )
    })
  })
})
