import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PhotosPanel } from '../../src/renderer/src/components/PhotosPanel'
import { SimilarityReviewPanel } from '../../src/renderer/src/components/SimilarityReviewPanel'
import type { VaultApi } from '../../src/preload/index.d'
import type {
  SimilarityCandidatePair,
  SimilarityAnalysisProgress
} from '../../src/shared/validation/ipc-schemas'

describe('Visual Similarity Review UI (Stage 5C)', () => {
  const mockPair1: SimilarityCandidatePair = {
    id: 1,
    jobId: 'job-1',
    locationIdA: 101,
    locationIdB: 102,
    photoA: {
      id: 101,
      fileName: 'sunset.jpg',
      originalPath: 'C:\\Users\\Ron\\Pictures\\sunset.jpg',
      byteSize: 1048576,
      filesystemBirthtimeMs: 1700000000000,
      filesystemMtimeMs: 1700000005000,
      activeHash: 'a'.repeat(64),
      discoveryObservationId: 1,
      width: 1920,
      height: 1080,
      rating: 5,
      flag: 'pick'
    },
    photoB: {
      id: 102,
      fileName: 'sunset_compressed.jpg',
      originalPath: 'C:\\Users\\Ron\\Pictures\\sunset_compressed.jpg',
      byteSize: 524288,
      filesystemBirthtimeMs: 1700000000000,
      filesystemMtimeMs: 1700000006000,
      activeHash: 'b'.repeat(64),
      discoveryObservationId: 2,
      width: 1920,
      height: 1080,
      rating: null,
      flag: 'none'
    },
    distance: 2,
    similarityScore: 0.96875,
    algorithmVersion: 'dhash64_v1',
    decision: 'unreviewed',
    decisionVersion: null,
    decisionUpdatedAtMs: null,
    createdAtMs: 1700000010000
  }

  const mockPair2: SimilarityCandidatePair = {
    id: 2,
    jobId: 'job-1',
    locationIdA: 103,
    locationIdB: 104,
    photoA: {
      id: 103,
      fileName: 'mountain1.jpg',
      originalPath: 'C:\\Users\\Ron\\Pictures\\mountain1.jpg',
      byteSize: 2048576,
      filesystemBirthtimeMs: 1700000000000,
      filesystemMtimeMs: 1700000007000,
      activeHash: 'c'.repeat(64),
      discoveryObservationId: 3,
      width: null,
      height: null,
      rating: null,
      flag: 'none'
    },
    photoB: {
      id: 104,
      fileName: 'mountain2.jpg',
      originalPath: 'C:\\Users\\Ron\\Pictures\\mountain2.jpg',
      byteSize: 2048576,
      filesystemBirthtimeMs: 1700000000000,
      filesystemMtimeMs: 1700000008000,
      activeHash: 'd'.repeat(64),
      discoveryObservationId: 4,
      width: null,
      height: null,
      rating: null,
      flag: 'none'
    },
    distance: 5,
    similarityScore: 0.921875,
    algorithmVersion: 'dhash64_v1',
    decision: 'similar_scene',
    decisionVersion: 1,
    decisionUpdatedAtMs: 1700000020000,
    createdAtMs: 1700000015000
  }

  let mockGetProgress: ReturnType<typeof vi.fn>
  let mockStartAnalysis: ReturnType<typeof vi.fn>
  let mockCancelAnalysis: ReturnType<typeof vi.fn>
  let mockResumeAnalysis: ReturnType<typeof vi.fn>
  let mockGetPairs: ReturnType<typeof vi.fn>
  let mockSetDecision: ReturnType<typeof vi.fn>
  let mockReconcile: ReturnType<typeof vi.fn>
  let mockGetThumbnail: ReturnType<typeof vi.fn>
  let mockGetPhotosPage: ReturnType<typeof vi.fn>
  let mockListCollections: ReturnType<typeof vi.fn>
  let mockGetPhotoMemberships: ReturnType<typeof vi.fn>

  let progressListeners: Array<(progress: SimilarityAnalysisProgress) => void> = []

  beforeEach(() => {
    vi.restoreAllMocks()
    progressListeners = []

    mockGetProgress = vi.fn().mockResolvedValue({
      jobId: null,
      status: 'idle',
      algorithmVersion: 'dhash64_v1',
      totalPhotos: 0,
      processedPhotos: 0,
      unsupportedPhotos: 0,
      errorPhotos: 0,
      candidatePairsFound: 0,
      startedAtMs: null,
      updatedAtMs: null,
      completedAtMs: null
    })

    mockStartAnalysis = vi.fn().mockImplementation(async () => {
      const runningProgress: SimilarityAnalysisProgress = {
        jobId: 'job-1',
        status: 'running',
        algorithmVersion: 'dhash64_v1',
        totalPhotos: 10,
        processedPhotos: 4,
        unsupportedPhotos: 1,
        errorPhotos: 0,
        candidatePairsFound: 2,
        startedAtMs: 1700000000000,
        updatedAtMs: 1700000002000,
        completedAtMs: null
      }
      for (const listener of progressListeners) {
        listener(runningProgress)
      }
      return runningProgress
    })

    mockCancelAnalysis = vi.fn().mockImplementation(async () => {
      const cancelledProgress: SimilarityAnalysisProgress = {
        jobId: 'job-1',
        status: 'cancelled',
        algorithmVersion: 'dhash64_v1',
        totalPhotos: 10,
        processedPhotos: 4,
        unsupportedPhotos: 1,
        errorPhotos: 0,
        candidatePairsFound: 2,
        startedAtMs: 1700000000000,
        updatedAtMs: 1700000005000,
        completedAtMs: null
      }
      for (const listener of progressListeners) {
        listener(cancelledProgress)
      }
      return cancelledProgress
    })

    mockResumeAnalysis = vi.fn().mockImplementation(async () => {
      const resumedProgress: SimilarityAnalysisProgress = {
        jobId: 'job-1',
        status: 'running',
        algorithmVersion: 'dhash64_v1',
        totalPhotos: 10,
        processedPhotos: 5,
        unsupportedPhotos: 1,
        errorPhotos: 0,
        candidatePairsFound: 2,
        startedAtMs: 1700000000000,
        updatedAtMs: 1700000006000,
        completedAtMs: null
      }
      for (const listener of progressListeners) {
        listener(resumedProgress)
      }
      return resumedProgress
    })

    mockGetPairs = vi.fn().mockResolvedValue({
      pairs: [mockPair1, mockPair2],
      totalCount: 2,
      page: 1,
      pageSize: 20,
      totalPages: 1
    })

    mockSetDecision = vi.fn().mockResolvedValue({
      success: true,
      decision: 'edited_version',
      version: 1,
      persistencePending: false
    })

    mockReconcile = vi.fn().mockResolvedValue({
      reconciledCount: 1,
      pendingCount: 0
    })

    mockGetThumbnail = vi.fn().mockResolvedValue({
      status: 'ready',
      locationId: 101,
      dataUrl: 'data:image/webp;base64,AAA=',
      mimeType: 'image/webp',
      width: 100,
      height: 100
    })

    mockGetPhotosPage = vi.fn().mockResolvedValue({
      items: [
        {
          id: 101,
          sourceId: 1,
          originalPath: 'C:\\Users\\Ron\\Pictures\\sunset.jpg',
          fileName: 'sunset.jpg',
          extension: '.jpg',
          category: 'photo',
          discoveryObservationId: 1,
          byteSize: 1048576,
          filesystemBirthtimeMs: 1700000000000,
          filesystemMtimeMs: 1700000005000,
          inferredCaptureTimeMs: null,
          firstDiscoveredAtMs: 1700000010000,
          lastSeenAtMs: 1700000010000,
          activeHash: 'a'.repeat(64),
          activeHashVerifiedAtMs: 1700000020000,
          rating: 5,
          flag: 'pick',
          annotationVersion: 1
        }
      ],
      totalCount: 1,
      offset: 0,
      limit: 50,
      hasMore: false
    })

    mockListCollections = vi.fn().mockResolvedValue({
      items: [],
      totalCount: 0,
      offset: 0,
      limit: 50,
      hasMore: false
    })

    mockGetPhotoMemberships = vi.fn().mockResolvedValue({
      memberships: []
    })

    window.api = {
      ...window.api,
      getThumbnail: mockGetThumbnail,
      getPhotosPage: mockGetPhotosPage,
      listCollections: mockListCollections,
      getPhotoMemberships: mockGetPhotoMemberships,
      startSimilarityAnalysis: mockStartAnalysis,
      cancelSimilarityAnalysis: mockCancelAnalysis,
      resumeSimilarityAnalysis: mockResumeAnalysis,
      getSimilarityProgress: mockGetProgress,
      getSimilarityPairs: mockGetPairs,
      setSimilarityDecision: mockSetDecision,
      reconcileSimilarity: mockReconcile,
      onSimilarityProgress: vi.fn().mockImplementation((cb) => {
        progressListeners.push(cb)
        return () => {
          progressListeners = progressListeners.filter((l) => l !== cb)
        }
      })
    } as unknown as VaultApi
  })

  it('switches between Photo Grid and Visual Similarity mode in PhotosPanel', async () => {
    render(<PhotosPanel />)

    expect(screen.getByRole('button', { name: 'Photo Grid' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Visual Similarity' })).toBeInTheDocument()

    // Switch to similarity mode
    fireEvent.click(screen.getByRole('button', { name: 'Visual Similarity' }))

    await waitFor(() => {
      expect(screen.getByText('Visual Similarity Review')).toBeInTheDocument()
    })

    // Switch back to grid mode
    fireEvent.click(screen.getByRole('button', { name: 'Photo Grid' }))

    await waitFor(() => {
      expect(screen.getByRole('search', { name: 'Photo filters' })).toBeInTheDocument()
    })
  })

  it('renders idle state with Start Analysis button and starts analysis', async () => {
    render(<SimilarityReviewPanel />)

    await waitFor(() => {
      expect(
        screen.getByText('Similarity analysis has not been run for the catalog.')
      ).toBeInTheDocument()
    })

    const startBtn = screen.getByRole('button', { name: /Start Similarity Analysis/i })
    expect(startBtn).toBeInTheDocument()

    fireEvent.click(startBtn)

    await waitFor(() => {
      expect(mockStartAnalysis).toHaveBeenCalled()
    })
  })

  it('shows running progress bar, stats, and cancellation', async () => {
    mockGetProgress.mockResolvedValueOnce({
      jobId: 'job-1',
      status: 'running',
      totalPhotos: 20,
      processedPhotos: 10,
      unsupportedPhotos: 2,
      errorPhotos: 1,
      candidatePairsFound: 4,
      startedAtMs: 1700000000000,
      completedAtMs: null,
      interruptedAtMs: null,
      cancelledAtMs: null
    })

    render(<SimilarityReviewPanel />)

    await waitFor(() => {
      expect(screen.getByText(/Analyzing photographs: 10 \/ 20 \(50%\)/)).toBeInTheDocument()
      expect(screen.getByText(/2 unsupported, 1 errors, 4 candidate pairs/)).toBeInTheDocument()
    })

    const cancelBtn = screen.getByRole('button', { name: /Cancel Analysis/i })
    expect(cancelBtn).toBeInTheDocument()

    fireEvent.click(cancelBtn)

    await waitFor(() => {
      expect(mockCancelAnalysis).toHaveBeenCalled()
    })
  })

  it('renders interrupted state with Resume Analysis button', async () => {
    mockGetProgress.mockResolvedValueOnce({
      jobId: 'job-1',
      status: 'interrupted',
      totalPhotos: 100,
      processedPhotos: 40,
      unsupportedPhotos: 0,
      errorPhotos: 0,
      candidatePairsFound: 5,
      startedAtMs: 1700000000000,
      completedAtMs: null,
      interruptedAtMs: 1700000005000,
      cancelledAtMs: null
    })

    render(<SimilarityReviewPanel />)

    await waitFor(() => {
      expect(
        screen.getByText(/Previous similarity analysis was interrupted \(40\/100 processed\)\./)
      ).toBeInTheDocument()
    })

    const resumeBtn = screen.getByRole('button', { name: /Resume Analysis/i })
    expect(resumeBtn).toBeInTheDocument()

    fireEvent.click(resumeBtn)

    await waitFor(() => {
      expect(mockResumeAnalysis).toHaveBeenCalled()
    })
  })

  it('renders candidate pairs with side-by-side comparison, truthful metadata, and algorithmic similarity score', async () => {
    render(<SimilarityReviewPanel />)

    await waitFor(() => {
      // Check Pair 1 filenames
      expect(screen.getByText('sunset.jpg')).toBeInTheDocument()
      expect(screen.getByText('sunset_compressed.jpg')).toBeInTheDocument()
      // Check Algorithmic Similarity label (not calibrated probability)
      expect(screen.getByText('97%')).toBeInTheDocument()
      expect(screen.getByText(/Hamming distance: 2\/64 bits • dhash64_v1/)).toBeInTheDocument()
      // Known dimensions
      expect(screen.getAllByText('1920 × 1080').length).toBe(2)
      // Unknown dimensions remain unknown
      expect(screen.getAllByText('Unknown').length).toBeGreaterThan(0)
    })
  })

  it('allows user to classify a pair as Edited Version, Similar Scene, Unrelated, and Clear Decision', async () => {
    render(<SimilarityReviewPanel />)

    await waitFor(() => {
      expect(screen.getByTestId('decision-edited-1')).toBeInTheDocument()
    })

    // Click "Edited Version" on pair 1
    fireEvent.click(screen.getByTestId('decision-edited-1'))

    await waitFor(() => {
      expect(mockSetDecision).toHaveBeenCalledWith({
        locationIdA: 101,
        locationIdB: 102,
        expectedRevisionA: expect.stringContaining('rev:1:'),
        expectedRevisionB: expect.stringContaining('rev:2:'),
        decision: 'edited_version',
        expectedVersion: undefined
      })
    })

    // Click "Similar Scene" on pair 1
    fireEvent.click(screen.getByTestId('decision-similar-1'))

    await waitFor(() => {
      expect(mockSetDecision).toHaveBeenCalledWith({
        locationIdA: 101,
        locationIdB: 102,
        expectedRevisionA: expect.stringContaining('rev:1:'),
        expectedRevisionB: expect.stringContaining('rev:2:'),
        decision: 'similar_scene',
        expectedVersion: 1
      })
    })

    // Click "Dismiss (Unrelated)" on pair 1
    fireEvent.click(screen.getByTestId('decision-unrelated-1'))

    await waitFor(() => {
      expect(mockSetDecision).toHaveBeenCalledWith({
        locationIdA: 101,
        locationIdB: 102,
        expectedRevisionA: expect.stringContaining('rev:1:'),
        expectedRevisionB: expect.stringContaining('rev:2:'),
        decision: 'unrelated',
        expectedVersion: 1
      })
    })

    // Pair 2 already has decision "similar_scene", verify Clear Decision is present
    expect(screen.getByTestId('decision-clear-2')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('decision-clear-2'))

    await waitFor(() => {
      expect(mockSetDecision).toHaveBeenCalledWith({
        locationIdA: 103,
        locationIdB: 104,
        expectedRevisionA: expect.stringContaining('rev:3:'),
        expectedRevisionB: expect.stringContaining('rev:4:'),
        decision: 'unreviewed',
        expectedVersion: 1
      })
    })
  })

  it('filters candidate pairs by decision status', async () => {
    render(<SimilarityReviewPanel />)

    await waitFor(() => {
      expect(screen.getByLabelText(/Filter Pairs/i)).toBeInTheDocument()
    })

    const filterSelect = screen.getByLabelText(/Filter Pairs/i)
    fireEvent.change(filterSelect, { target: { value: 'edited_version' } })

    await waitFor(() => {
      expect(mockGetPairs).toHaveBeenCalledWith({
        page: 1,
        pageSize: 10,
        filter: 'edited_version'
      })
    })
  })

  it('handles pending persistence warning and retry', async () => {
    mockSetDecision.mockResolvedValueOnce({
      success: true,
      decision: 'edited_version',
      version: 1,
      persistencePending: true,
      message: 'Disk write pending'
    })

    render(<SimilarityReviewPanel />)

    await waitFor(() => {
      expect(screen.getByTestId('decision-edited-1')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTestId('decision-edited-1'))

    await waitFor(() => {
      expect(screen.getByText(/Pending review persistence: Disk write pending/)).toBeInTheDocument()
    })

    const retryBtn = screen.getByRole('button', { name: /Retry Persistence/i })
    expect(retryBtn).toBeInTheDocument()

    fireEvent.click(retryBtn)

    await waitFor(() => {
      expect(mockReconcile).toHaveBeenCalled()
    })
  })
})
