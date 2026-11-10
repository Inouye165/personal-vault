import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, act } from '@testing-library/react'
import { SemanticIndexPanel } from '../../src/renderer/src/components/SemanticIndexPanel'
import type { VaultApi } from '../../src/preload/index.d'
import type {
  SemanticModelStatusResponse,
  SemanticIndexProgressResponse
} from '../../src/shared/validation/ipc-schemas'

describe('Stage 6B — SemanticIndexPanel & Stale Response Guards', () => {
  const baseModelMissing: SemanticModelStatusResponse = {
    state: 'missing',
    modelId: 'Xenova/clip-vit-base-patch32@6b7c5237',
    modelCommit: '6b7c523703ae26e39be4b03774966f8571c7f523',
    modelManifestSha256: 'a'.repeat(64),
    preprocessingVersion: 'clip_vit_b32_224_bicubic_center_rgb_v1',
    dimensions: 512,
    requiredBytes: 155851918,
    downloadedBytes: 0,
    currentArtifact: null,
    verifiedAtMs: null,
    error: null,
    lastReplacementError: null
  }

  const baseModelReady: SemanticModelStatusResponse = {
    ...baseModelMissing,
    state: 'ready',
    downloadedBytes: 155851918,
    verifiedAtMs: 1710000000000
  }

  const baseIndexIdle: SemanticIndexProgressResponse = {
    jobId: null,
    status: 'idle',
    modelId: 'Xenova/clip-vit-base-patch32@6b7c5237',
    modelCommit: '6b7c523703ae26e39be4b03774966f8571c7f523',
    preprocessingVersion: 'clip_vit_b32_224_bicubic_center_rgb_v1',
    totalPhotos: 0,
    processedPhotos: 0,
    reusedPhotos: 0,
    unsupportedPhotos: 0,
    failedPhotos: 0,
    pendingPhotos: 0,
    totalCatalogPhotos: 120,
    currentIndexedPhotos: 0,
    startedAtMs: null,
    updatedAtMs: null,
    completedAtMs: null,
    lastError: null
  }

  let mockGetModelStatus: ReturnType<typeof vi.fn>
  let mockDownloadModel: ReturnType<typeof vi.fn>
  let mockImportModel: ReturnType<typeof vi.fn>
  let mockCancelModelProvisioning: ReturnType<typeof vi.fn>
  let mockGetIndexProgress: ReturnType<typeof vi.fn>
  let mockStartIndexing: ReturnType<typeof vi.fn>
  let mockPauseIndexing: ReturnType<typeof vi.fn>
  let mockResumeIndexing: ReturnType<typeof vi.fn>
  let mockCancelIndexing: ReturnType<typeof vi.fn>
  let mockGetIndexJobItems: ReturnType<typeof vi.fn>

  let modelListeners: Array<(status: SemanticModelStatusResponse) => void> = []
  let indexListeners: Array<(progress: SemanticIndexProgressResponse) => void> = []

  beforeEach(() => {
    vi.restoreAllMocks()
    modelListeners = []
    indexListeners = []

    mockGetModelStatus = vi.fn().mockResolvedValue(baseModelMissing)
    mockDownloadModel = vi.fn().mockResolvedValue(baseModelReady)
    mockImportModel = vi.fn().mockResolvedValue(baseModelReady)
    mockCancelModelProvisioning = vi.fn().mockResolvedValue({
      ...baseModelMissing,
      state: 'cancelled'
    })
    mockGetIndexProgress = vi.fn().mockResolvedValue(baseIndexIdle)
    mockStartIndexing = vi.fn().mockResolvedValue({
      ...baseIndexIdle,
      jobId: 'sem-job-1',
      status: 'running',
      totalPhotos: 120,
      pendingPhotos: 120
    })
    mockPauseIndexing = vi.fn().mockResolvedValue({
      ...baseIndexIdle,
      jobId: 'sem-job-1',
      status: 'paused',
      totalPhotos: 120,
      processedPhotos: 40,
      pendingPhotos: 80,
      currentIndexedPhotos: 40
    })
    mockResumeIndexing = vi.fn().mockResolvedValue({
      ...baseIndexIdle,
      jobId: 'sem-job-1',
      status: 'running',
      totalPhotos: 120,
      processedPhotos: 40,
      pendingPhotos: 80,
      currentIndexedPhotos: 40
    })
    mockCancelIndexing = vi.fn().mockResolvedValue({
      ...baseIndexIdle,
      jobId: 'sem-job-1',
      status: 'cancelled',
      totalPhotos: 120,
      processedPhotos: 40,
      pendingPhotos: 80,
      currentIndexedPhotos: 40
    })
    mockGetIndexJobItems = vi.fn().mockResolvedValue({
      jobId: 'sem-job-1',
      items: [],
      totalCount: 0,
      page: 1,
      pageSize: 25
    })

    window.api = {
      ...window.api,
      getSemanticModelStatus: mockGetModelStatus,
      downloadSemanticModel: mockDownloadModel,
      importSemanticModelFromFolder: mockImportModel,
      cancelSemanticModelProvisioning: mockCancelModelProvisioning,
      onSemanticModelStatus: vi.fn((cb: (s: SemanticModelStatusResponse) => void) => {
        modelListeners.push(cb)
        return () => {
          modelListeners = modelListeners.filter((l) => l !== cb)
        }
      }),
      getSemanticIndexProgress: mockGetIndexProgress,
      startSemanticIndexing: mockStartIndexing,
      pauseSemanticIndexing: mockPauseIndexing,
      resumeSemanticIndexing: mockResumeIndexing,
      cancelSemanticIndexing: mockCancelIndexing,
      getSemanticIndexJobItems: mockGetIndexJobItems,
      onSemanticIndexProgress: vi.fn((cb: (p: SemanticIndexProgressResponse) => void) => {
        indexListeners.push(cb)
        return () => {
          indexListeners = indexListeners.filter((l) => l !== cb)
        }
      })
    } as unknown as VaultApi
  })

  it('shows ~149 MiB model size requirement when missing, does not auto-download, and explains Stage 6D scope & non-factual nature', async () => {
    render(<SemanticIndexPanel onClose={() => {}} />)

    await waitFor(() => {
      expect(screen.getByTestId('semantic-index-panel')).toBeInTheDocument()
    })

    // Must not auto-download on startup/mount
    expect(mockDownloadModel).not.toHaveBeenCalled()

    // Displays ~149 MiB requirement
    expect(screen.getAllByText(/148\.6\s*MiB|149\s*MiB/i).length).toBeGreaterThanOrEqual(1)

    // Plainly explains that indexing prepares offline semantic search for a later substage and is not factual labeling
    expect(screen.getByText(/offline semantic search/i)).toBeInTheDocument()
    expect(screen.getByText(/not factual labels/i)).toBeInTheDocument()

    // Triggers explicit offline folder import
    fireEvent.click(screen.getByTestId('semantic-model-import-btn'))
    await waitFor(() => {
      expect(mockImportModel).toHaveBeenCalledTimes(1)
    })
    expect(screen.getByTestId('semantic-model-state-badge')).toHaveTextContent(/ready/i)
  })

  it('supports start, pause, resume, and cancel indexing and reports honest outcomes when failures occur', async () => {
    mockGetModelStatus.mockResolvedValue(baseModelReady)
    render(<SemanticIndexPanel onClose={() => {}} />)

    await waitFor(() => {
      expect(screen.getByTestId('semantic-index-start-btn')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTestId('semantic-index-start-btn'))
    await waitFor(() => {
      expect(mockStartIndexing).toHaveBeenCalledTimes(1)
    })

    // Pause active indexing
    await waitFor(() => {
      expect(screen.getByTestId('semantic-index-pause-btn')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('semantic-index-pause-btn'))
    await waitFor(() => {
      expect(mockPauseIndexing).toHaveBeenCalledTimes(1)
    })

    // Resume paused indexing
    await waitFor(() => {
      expect(screen.getByTestId('semantic-index-resume-btn')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('semantic-index-resume-btn'))
    await waitFor(() => {
      expect(mockResumeIndexing).toHaveBeenCalledTimes(1)
    })

    // Simulate job completion with failures and unsupported files — must not claim all photos succeeded
    act(() => {
      for (const listener of indexListeners) {
        listener({
          ...baseIndexIdle,
          jobId: 'sem-job-1',
          status: 'completed',
          totalPhotos: 120,
          processedPhotos: 112,
          reusedPhotos: 10,
          unsupportedPhotos: 5,
          failedPhotos: 3,
          pendingPhotos: 0,
          totalCatalogPhotos: 120,
          currentIndexedPhotos: 112
        })
      }
    })

    expect(screen.getByTestId('semantic-index-summary')).toHaveTextContent(/112/)
    expect(screen.getByTestId('semantic-index-summary')).toHaveTextContent(/5 unsupported/i)
    expect(screen.getByTestId('semantic-index-summary')).toHaveTextContent(/3 failed/i)
  })

  it('guards against stale asynchronous IPC responses when newer job events arrive first', async () => {
    mockGetModelStatus.mockResolvedValue(baseModelReady)

    let resolveSlowRefresh: ((val: SemanticIndexProgressResponse) => void) | null = null
    mockGetIndexProgress.mockImplementationOnce(
      () =>
        new Promise<SemanticIndexProgressResponse>((resolve) => {
          resolveSlowRefresh = resolve
        })
    )

    render(<SemanticIndexPanel onClose={() => {}} />)

    // Emit newer live event before initial slow getSemanticIndexProgress resolves
    act(() => {
      for (const listener of indexListeners) {
        listener({
          ...baseIndexIdle,
          jobId: 'sem-job-newer',
          status: 'running',
          totalPhotos: 50,
          processedPhotos: 25,
          pendingPhotos: 25,
          currentIndexedPhotos: 25,
          updatedAtMs: 5000
        })
      }
    })

    expect(screen.getByTestId('semantic-index-job-status')).toHaveTextContent(/running/i)

    // Now resolve the older stale getSemanticIndexProgress response
    await act(async () => {
      resolveSlowRefresh?.({
        ...baseIndexIdle,
        jobId: null,
        status: 'idle',
        updatedAtMs: 1000
      })
    })

    // UI must preserve the newer 'running' state and ignore the stale 'idle' response
    expect(screen.getByTestId('semantic-index-job-status')).toHaveTextContent(/running/i)
  })
})
