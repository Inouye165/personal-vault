import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { PhotosPanel } from '../../src/renderer/src/components/PhotosPanel'
import type { PhotoItem } from '../../src/shared/validation/ipc-schemas'

describe('Pending Persistence Lifecycle & Multi-Operation Reconciliation', () => {
  const photoA: PhotoItem = {
    id: 101,
    sourceId: 1,
    originalPath: '/test/photoA.jpg',
    fileName: 'photoA.jpg',
    extension: '.jpg',
    category: 'photo',
    byteSize: 1024,
    filesystemBirthtimeMs: 1000,
    filesystemMtimeMs: 2000,
    inferredCaptureTimeMs: null,
    firstDiscoveredAtMs: 1000,
    lastSeenAtMs: 2000,
    discoveryObservationId: 1,
    activeHash: 'hash-A',
    activeHashVerifiedAtMs: null,
    rating: null,
    flag: 'none',
    annotationVersion: 0
  }

  const photoB: PhotoItem = {
    id: 102,
    sourceId: 1,
    originalPath: '/test/photoB.jpg',
    fileName: 'photoB.jpg',
    extension: '.jpg',
    category: 'photo',
    byteSize: 2048,
    filesystemBirthtimeMs: 1000,
    filesystemMtimeMs: 2000,
    inferredCaptureTimeMs: null,
    firstDiscoveredAtMs: 1000,
    lastSeenAtMs: 2000,
    discoveryObservationId: 2,
    activeHash: 'hash-B',
    activeHashVerifiedAtMs: null,
    rating: null,
    flag: 'none',
    annotationVersion: 0
  }

  let mockGetPhotosPage: ReturnType<typeof vi.fn>
  let mockSetPhotoAnnotation: ReturnType<typeof vi.fn>
  let mockReconcileJournal: ReturnType<typeof vi.fn>
  let mockListCollections: ReturnType<typeof vi.fn>
  let mockGetPhotoMemberships: ReturnType<typeof vi.fn>
  let mockGetThumbnail: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()

    mockGetPhotosPage = vi.fn().mockResolvedValue({
      items: [photoA, photoB],
      totalCount: 2,
      offset: 0,
      limit: 50
    })

    mockListCollections = vi.fn().mockResolvedValue({
      items: [],
      totalCount: 0,
      hasMore: false,
      offset: 0,
      limit: 50
    })

    mockGetPhotoMemberships = vi.fn().mockResolvedValue({
      items: [],
      totalCount: 0,
      hasMore: false,
      offset: 0,
      limit: 50
    })

    mockGetThumbnail = vi.fn().mockResolvedValue({
      status: 'ready',
      dataUrl: 'data:image/webp;base64,fake'
    })

    mockSetPhotoAnnotation = vi.fn()
    mockReconcileJournal = vi.fn().mockResolvedValue({ success: true, reconciledCount: 1 })

    ;(window as unknown as { api: Record<string, unknown> }).api = {
      getPhotosPage: mockGetPhotosPage,
      listCollections: mockListCollections,
      getPhotoMemberships: mockGetPhotoMemberships,
      getThumbnail: mockGetThumbnail,
      setPhotoAnnotation: mockSetPhotoAnnotation,
      reconcileJournal: mockReconcileJournal,
      createCollection: vi.fn(),
      renameCollection: vi.fn(),
      addCollectionMember: vi.fn(),
      removeCollectionMember: vi.fn()
    }
  })

  it('records persistencePending when save for photo A completes after navigating to B, keeping obsolete status guarded', async () => {
    let resolveSaveA!: (val: unknown) => void
    const saveAPromise = new Promise((resolve) => {
      resolveSaveA = resolve
    })
    mockSetPhotoAnnotation.mockImplementationOnce(() => saveAPromise)

    render(<PhotosPanel />)

    // Await photos loaded
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /photoA\.jpg/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /photoB\.jpg/i })).toBeInTheDocument()
    })

    // 1. Select Photo A
    fireEvent.click(screen.getByRole('button', { name: /photoA\.jpg/i }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '4 Stars' })).toBeInTheDocument()
    })

    // 2. Click 4 Stars on Photo A (save begins in background)
    fireEvent.click(screen.getByRole('button', { name: '4 Stars' }))
    expect(screen.getByText(/Saving\.\.\./i)).toBeInTheDocument()

    // 3. Immediately switch selection to Photo B before Photo A resolves
    fireEvent.click(screen.getByRole('button', { name: /photoB\.jpg/i }))
    await waitFor(() => {
      // Photo B selected; status reset to idle
      expect(screen.queryByText(/Saving\.\.\./i)).not.toBeInTheDocument()
    })

    // 4. Resolve Photo A save with persistencePending: true
    await act(async () => {
      resolveSaveA({
        success: true,
        annotation: {
          id: 1,
          fileLocationId: 101,
          discoveryObservationId: 1,
          contentSha256: 'hash-A',
          rating: 4,
          flag: 'none',
          version: 1,
          isCurrent: true,
          createdAtMs: 1000,
          updatedAtMs: 1000
        },
        persistencePending: true,
        persistenceError: 'Disk sync barrier delayed for Photo A'
      })
      await Promise.resolve()
    })

    // 5. Verification:
    // The unresolved journal operation for Photo A MUST be registered:
    // Warning banner and retry button MUST remain visible!
    await waitFor(() => {
      expect(screen.getByText(/Disk sync barrier delayed for Photo A/i)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /Retry reconciliation/i })).toBeInTheDocument()
    })

    // Photo B is currently selected. Obsolete status updates MUST remain guarded (Photo B must NOT show "Saved")
    expect(screen.queryByText(/^Saved$/i)).not.toBeInTheDocument()
  })

  it('preserves newer pending operations when an older reconciliation completes, and resolves without repeating mutations', async () => {
    // Operation 1 (rating 4 stars): returns persistencePending: true
    mockSetPhotoAnnotation.mockResolvedValueOnce({
      success: true,
      annotation: {
        id: 1,
        fileLocationId: 101,
        discoveryObservationId: 1,
        contentSha256: 'hash-A',
        rating: 4,
        flag: 'none',
        version: 1,
        isCurrent: true,
        createdAtMs: 1000,
        updatedAtMs: 1000
      },
      persistencePending: true,
      persistenceError: 'Op 1 pending journal sync'
    })

    render(<PhotosPanel />)

    // Select Photo A
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /photoA\.jpg/i })).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole('button', { name: /photoA\.jpg/i }))

    // Execute Operation 1: 4 Stars
    const starBtn = screen.getByRole('button', { name: '4 Stars' })
    fireEvent.click(starBtn)

    // Operation 1 warning is visible
    await waitFor(() => {
      expect(screen.getByText(/Op 1 pending journal sync/i)).toBeInTheDocument()
    })

    // Setup controlled reconciliation 1
    let resolveReconcile1!: (val: unknown) => void
    const reconcilePromise1 = new Promise((resolve) => {
      resolveReconcile1 = resolve
    })
    mockReconcileJournal.mockImplementationOnce(() => reconcilePromise1)

    // Start reconciliation 1
    const retryBtn1 = screen.getByRole('button', { name: /Retry reconciliation/i })
    fireEvent.click(retryBtn1)

    expect(mockReconcileJournal).toHaveBeenCalledTimes(1)

    // While reconciliation 1 is in-flight, Operation 2 (Pick flag) is executed and also returns persistencePending: true
    mockSetPhotoAnnotation.mockResolvedValueOnce({
      success: true,
      annotation: {
        id: 1,
        fileLocationId: 101,
        discoveryObservationId: 1,
        contentSha256: 'hash-A',
        rating: 4,
        flag: 'pick',
        version: 2,
        isCurrent: true,
        createdAtMs: 1000,
        updatedAtMs: 2000
      },
      persistencePending: true,
      persistenceError: 'Op 2 pending journal sync'
    })

    const pickBtn = screen.getByRole('button', { name: /^Pick/i })
    fireEvent.click(pickBtn)

    // Wait for Operation 2 to register in UI
    await waitFor(() => {
      expect(mockSetPhotoAnnotation).toHaveBeenCalledTimes(2)
    })

    // Now older reconciliation 1 completes!
    await act(async () => {
      resolveReconcile1({ success: true, reconciledCount: 1 })
      await Promise.resolve()
    })

    // CRITICAL: Older reconciliation completed, but Operation 2 was NOT covered by it!
    // The newer pending operation MUST REMAIN visibly pending!
    await waitFor(() => {
      expect(screen.getByText('Op 2 pending journal sync')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /Retry reconciliation/i })).toBeInTheDocument()
    })

    // Now reconcile the outstanding Operation 2
    mockReconcileJournal.mockResolvedValueOnce({ success: true, reconciledCount: 1 })
    const retryBtn2 = screen.getByRole('button', { name: /Retry reconciliation/i })
    fireEvent.click(retryBtn2)

    await waitFor(() => {
      expect(mockReconcileJournal).toHaveBeenCalledTimes(2)
    })

    // Mutations were NOT repeated! (Still exactly 2 calls: one for rating, one for flag)
    expect(mockSetPhotoAnnotation).toHaveBeenCalledTimes(2)

    // Now that all operations have been reconciled, the pending warning clears
    await waitFor(() => {
      expect(screen.queryByText('Op 2 pending journal sync')).toBeNull()
      expect(screen.queryByText(/Journal finalization pending/i)).toBeNull()
      expect(screen.queryByRole('button', { name: /Retry reconciliation/i })).toBeNull()
    })
  })
})
