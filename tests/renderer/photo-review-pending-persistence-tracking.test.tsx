import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { PhotosPanel } from '../../src/renderer/src/components/PhotosPanel'
import type { PhotoItem } from '../../src/shared/validation/ipc-schemas'

describe('Pending Persistence Tracking & Safe Reconciliation (Finding 1)', () => {
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

  it('preserves pending indicator for Operation A when unrelated Operation B saves successfully', async () => {
    // Operation A: Rating save commits in SQLite but journal write is pending
    const mockSetPhotoAnnotation = vi
      .fn()
      // First call (Operation A: rating 4 stars): committed but persistencePending: true
      .mockResolvedValueOnce({
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
      // Second call (Operation B: flag pick): succeeds completely, persistencePending: false
      .mockResolvedValueOnce({
        success: true,
        annotation: {
          id: 1,
          fileLocationId: 101,
          discoveryObservationId: 1,
          contentSha256: 'hash-1',
          rating: 4,
          flag: 'pick',
          version: 2,
          isCurrent: true,
          createdAtMs: 1000,
          updatedAtMs: 2000
        },
        persistencePending: false
      })

    ;(window as unknown as { api: Record<string, unknown> }).api.setPhotoAnnotation =
      mockSetPhotoAnnotation

    render(<PhotosPanel />)

    // Select photo
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Details for photo1\.jpg/i })).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole('button', { name: /Details for photo1\.jpg/i }))

    // Execute Operation A: Click 4 Stars
    const starBtn = screen.getByRole('button', { name: '4 Stars' })
    fireEvent.click(starBtn)

    // Verify Operation A is visibly pending
    await waitFor(() => {
      expect(screen.getByText(/Journal finalization pending/i)).toBeInTheDocument()
    })

    // Execute Operation B: Click Pick
    const pickBtn = screen.getByRole('button', { name: /^Pick/i })
    fireEvent.click(pickBtn)

    // Operation B succeeded, but Operation A is STILL unresolved!
    // Operation A MUST REMAIN visibly pending!
    await waitFor(() => {
      expect(screen.getByText(/Journal finalization pending/i)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /Retry reconciliation/i })).toBeInTheDocument()
    })

    // Now execute reconciliation
    const retryBtn = screen.getByRole('button', { name: /Retry reconciliation/i })
    fireEvent.click(retryBtn)

    // Reconciliation called once across IPC
    await waitFor(() => {
      expect(
        (window as unknown as { api: { reconcileJournal: unknown } }).api.reconcileJournal
      ).toHaveBeenCalledTimes(1)
    })

    // Mutations were NOT repeated!
    expect(mockSetPhotoAnnotation).toHaveBeenCalledTimes(2)

    // After reconciliation, pending indicator clears
    await waitFor(() => {
      expect(screen.queryByText(/Journal finalization pending/i)).toBeNull()
    })
  })

  it('keeps pending indicator when collection creation is pending and collection rename succeeds', async () => {
    let currentCollections: Array<{
      id: number
      name: string
      normalizedName: string
      createdAtMs: number
      updatedAtMs: number
    }> = []

    const mockCreateCollection = vi.fn().mockImplementation(({ name }: { name: string }) => {
      const col = {
        id: 1,
        name,
        normalizedName: name.toLowerCase(),
        createdAtMs: 1000,
        updatedAtMs: 1000
      }
      currentCollections = [col]
      return Promise.resolve({
        collection: col,
        persistencePending: true,
        persistenceError: 'Journal sync stalled'
      })
    })
    ;(window as unknown as { api: Record<string, unknown> }).api.createCollection =
      mockCreateCollection

    const mockRenameCollection = vi
      .fn()
      .mockImplementation(({ collectionId, name }: { collectionId: number; name: string }) => {
        const col = {
          id: collectionId,
          name,
          normalizedName: name.toLowerCase(),
          createdAtMs: 1000,
          updatedAtMs: 2000
        }
        currentCollections = [col]
        return Promise.resolve({
          collection: col,
          persistencePending: false
        })
      })
    ;(window as unknown as { api: Record<string, unknown> }).api.renameCollection =
      mockRenameCollection

    ;(window as unknown as { api: Record<string, unknown> }).api.listCollections = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve({
          items: currentCollections,
          totalCount: currentCollections.length,
          hasMore: false,
          offset: 0,
          limit: 50
        })
      )

    render(<PhotosPanel />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Details for photo1\.jpg/i })).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole('button', { name: /Details for photo1\.jpg/i }))

    // Create collection
    const input = screen.getByPlaceholderText(/New collection name…/i)
    fireEvent.change(input, { target: { value: 'Landscapes' } })
    fireEvent.submit(input.closest('form')!)

    // Pending indicator must appear
    await waitFor(() => {
      expect(screen.getByText(/Journal finalization pending/i)).toBeInTheDocument()
    })

    // Trigger rename
    const renameBtn = await screen.findByRole('button', {
      name: /Rename collection Landscapes/i
    })
    fireEvent.click(renameBtn)

    const renameInput = screen.getByLabelText(/New name for collection Landscapes/i)
    fireEvent.change(renameInput, { target: { value: 'Nature Landscapes' } })
    fireEvent.submit(renameInput.closest('form')!)

    // Even though rename succeeded, Operation A was pending, so banner must remain!
    await waitFor(() => {
      expect(screen.getByText(/Journal finalization pending/i)).toBeInTheDocument()
    })
  })
})
