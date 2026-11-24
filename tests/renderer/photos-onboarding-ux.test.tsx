import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/src/App'
import type { VaultApi } from '../../src/preload/index.d'
import type {
  PhotoItem,
  ScanJobProgress,
  SemanticIndexProgressResponse,
  SemanticModelStatusResponse
} from '../../src/shared/validation/ipc-schemas'

function makePhoto(id: number, fileName = `photo_${id}.jpg`): PhotoItem {
  return {
    id,
    sourceId: 1,
    originalPath: `D:\\SamplePhotos\\${fileName}`,
    fileName,
    extension: '.jpg',
    category: 'photo',
    discoveryObservationId: id,
    byteSize: 102400,
    filesystemBirthtimeMs: 1700000000000,
    filesystemMtimeMs: 1700000000000,
    inferredCaptureTimeMs: null,
    firstDiscoveredAtMs: 1700000000000,
    lastSeenAtMs: 1700000000000,
    activeHash: 'a'.repeat(64),
    activeHashVerifiedAtMs: 1700000000000,
    rating: null,
    flag: 'none',
    annotationVersion: 0
  }
}

function makeModelStatus(
  state: SemanticModelStatusResponse['state'],
  downloadedBytes = 0
): SemanticModelStatusResponse {
  return {
    state,
    modelId: 'Xenova/clip-vit-base-patch32@6b7c5237',
    modelCommit: '6b7c523703ae26e39be4b03774966f8571c7f523',
    modelManifestSha256: 'a'.repeat(64),
    preprocessingVersion: 'clip_vit_b32_224_bicubic_center_rgb_v1',
    dimensions: 512,
    requiredBytes: 155851918,
    downloadedBytes,
    currentArtifact: state === 'installing' ? 'onnx/model.onnx' : null,
    verifiedAtMs: state === 'ready' ? 1700000000000 : null,
    error: null,
    lastReplacementError: null
  }
}

function makeIndexProgress(
  status: SemanticIndexProgressResponse['status'],
  processedPhotos = 0,
  totalPhotos = 2
): SemanticIndexProgressResponse {
  return {
    jobId: status === 'idle' ? null : 'sem-job-1',
    status,
    modelId: 'Xenova/clip-vit-base-patch32@6b7c5237',
    modelCommit: '6b7c523703ae26e39be4b03774966f8571c7f523',
    preprocessingVersion: 'clip_vit_b32_224_bicubic_center_rgb_v1',
    totalPhotos,
    processedPhotos,
    reusedPhotos: 0,
    unsupportedPhotos: 0,
    failedPhotos: 0,
    pendingPhotos: Math.max(0, totalPhotos - processedPhotos),
    totalCatalogPhotos: totalPhotos,
    currentIndexedPhotos: processedPhotos,
    startedAtMs: status === 'idle' ? null : 1700000000000,
    updatedAtMs: Date.now(),
    completedAtMs: status === 'completed' ? 1700000005000 : null,
    lastError: null
  }
}

describe('Photos Onboarding UX — Add photos & Enable photo search', () => {
  let scanProgressCbs = new Set<(progress: ScanJobProgress) => void>()
  let modelStatusCbs = new Set<(status: SemanticModelStatusResponse) => void>()
  let indexProgressCbs = new Set<(progress: SemanticIndexProgressResponse) => void>()

  beforeEach(() => {
    vi.restoreAllMocks()
    scanProgressCbs = new Set()
    modelStatusCbs = new Set()
    indexProgressCbs = new Set()
  })

  afterEach(() => {
    Reflect.deleteProperty(window, 'api')
  })

  function setupMockAppApi(options: {
    initialSourceCount: number
    initialPhotos: PhotoItem[]
    modelState?: SemanticModelStatusResponse['state']
  }) {
    let sourceCount = options.initialSourceCount
    let catalogPhotos = [...options.initialPhotos]
    let currentModelStatus = makeModelStatus(
      options.modelState ?? 'missing',
      options.modelState === 'ready' ? 155851918 : 0
    )
    let currentIndexProgress = makeIndexProgress('idle', 0, catalogPhotos.length)

    const api = {
      getAppInfo: vi.fn(async () => ({
        name: 'Personal Vault',
        version: '0.1.0',
        platform: 'win32',
        isPackaged: false
      })),
      getVaultStatus: vi.fn(async () => ({
        sourceCount,
        itemCount: catalogPhotos.length,
        isReady: true
      })),
      setTab: vi.fn(async () => true),
      selectRoots: vi.fn(async () => ({
        cancelled: false,
        rootPaths: ['D:\\SamplePhotos\\NewTrip']
      })),
      startScan: vi.fn(async () => ({
        success: true,
        job: {
          jobId: 42,
          status: 'running' as const,
          phase: 'discovery' as const,
          roots: ['D:\\SamplePhotos\\NewTrip'],
          discoveredCount: 0,
          hashedCount: 0,
          totalFilesToHash: 0,
          totalBytes: 0,
          hashedBytes: 0,
          skippedCount: 0,
          errorCount: 0,
          errors: [],
          startedAtMs: 1000,
          updatedAtMs: 1000,
          completedAtMs: null
        }
      })),
      pauseScan: vi.fn(async () => ({ success: true })),
      resumeScan: vi.fn(async () => ({ success: true })),
      cancelScan: vi.fn(async () => ({ success: true })),
      getActiveScanJob: vi.fn(async () => ({ job: null })),
      getLatestScanJob: vi.fn(async () => ({ job: null })),
      dismissScanJob: vi.fn(async () => ({ success: true })),
      onScanProgress: vi.fn((cb: (p: ScanJobProgress) => void) => {
        scanProgressCbs.add(cb)
        return () => {
          scanProgressCbs.delete(cb)
        }
      }),
      getPhotosPage: vi.fn(async () => ({
        items: catalogPhotos,
        totalCount: catalogPhotos.length,
        offset: 0,
        limit: 50,
        hasMore: false
      })),
      getThumbnail: vi.fn(async ({ locationId }: { locationId: number }) => ({
        status: 'ready' as const,
        locationId,
        dataUrl: 'data:image/webp;base64,TEST',
        mimeType: 'image/webp',
        width: 320,
        height: 240
      })),
      cancelThumbnail: vi.fn(async ({ locationId }: { locationId: number }) => ({
        success: true,
        locationId
      })),
      getPhotosDiagnostics: vi.fn(async () => ({
        activeWorkers: 0,
        queuedJobs: 0,
        totalDecodes: 0,
        cacheHits: 0,
        cacheMisses: 0
      })),
      listCollections: vi.fn(async () => ({
        items: [],
        total: 0,
        offset: 0,
        limit: 50
      })),
      listPhotoMemberships: vi.fn(async () => ({
        items: [],
        total: 0,
        offset: 0,
        limit: 50
      })),
      getPhotoMetadata: vi.fn(async () => null),
      getPhotoMetadataFacets: vi.fn(async () => ({
        years: [],
        cameras: []
      })),
      getSemanticModelStatus: vi.fn(async () => currentModelStatus),
      getSemanticIndexProgress: vi.fn(async () => currentIndexProgress),
      onSemanticModelStatus: vi.fn((cb: (s: SemanticModelStatusResponse) => void) => {
        modelStatusCbs.add(cb)
        return () => {
          modelStatusCbs.delete(cb)
        }
      }),
      onSemanticIndexProgress: vi.fn((cb: (p: SemanticIndexProgressResponse) => void) => {
        indexProgressCbs.add(cb)
        return () => {
          indexProgressCbs.delete(cb)
        }
      }),
      downloadSemanticModel: vi.fn(async () => {
        currentModelStatus = makeModelStatus('installing', 77000000)
        modelStatusCbs.forEach((cb) => cb(currentModelStatus))
        return currentModelStatus
      }),
      cancelSemanticModelProvisioning: vi.fn(async () => {
        currentModelStatus = makeModelStatus('missing', 0)
        modelStatusCbs.forEach((cb) => cb(currentModelStatus))
        return currentModelStatus
      }),
      startSemanticIndexing: vi.fn(async () => {
        currentIndexProgress = makeIndexProgress('running', 1, catalogPhotos.length)
        indexProgressCbs.forEach((cb) => cb(currentIndexProgress))
        return currentIndexProgress
      }),
      searchPhotosSemantic: vi.fn(),
      cancelPhotosSemanticSearch: vi.fn(async () => ({ cancelled: true }))
    } as unknown as VaultApi

    window.api = api

    return {
      api,
      setCatalogPhotos: (next: PhotoItem[], nextSources = 1) => {
        catalogPhotos = next
        sourceCount = nextSources
      },
      emitScanProgress: (progress: ScanJobProgress) => {
        scanProgressCbs.forEach((cb) => cb(progress))
      },
      emitModelStatus: (status: SemanticModelStatusResponse) => {
        currentModelStatus = status
        modelStatusCbs.forEach((cb) => cb(status))
      },
      emitIndexProgress: (prog: SemanticIndexProgressResponse) => {
        currentIndexProgress = prog
        indexProgressCbs.forEach((cb) => cb(prog))
      }
    }
  }

  it('shows Add photos on Photographs, reuses read-only folder picker/scan, and auto-refreshes newly discovered photos', async () => {
    const harness = setupMockAppApi({
      initialSourceCount: 1,
      initialPhotos: [makePhoto(1, 'existing_sunset.jpg')],
      modelState: 'ready'
    })

    render(<App />)

    await waitFor(() => expect(screen.getByRole('button', { name: /^photos$/i })).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: /^photos$/i }))

    await waitFor(() => expect(screen.getByText('existing_sunset.jpg')).toBeDefined())

    const addBtn = screen.getByTestId('photos-add-photos-btn')
    expect(addBtn).toHaveTextContent(/add photos/i)
    fireEvent.click(addBtn)

    await waitFor(() => expect(harness.api.selectRoots).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByText('D:\\SamplePhotos\\NewTrip')).toBeDefined())

    fireEvent.click(screen.getByRole('button', { name: /start scan/i }))
    await waitFor(() => expect(harness.api.startScan).toHaveBeenCalledTimes(1))

    act(() => {
      harness.emitScanProgress({
        jobId: 42,
        status: 'running',
        phase: 'hashing',
        roots: ['D:\\SamplePhotos\\NewTrip'],
        discoveredCount: 2,
        hashedCount: 1,
        totalFilesToHash: 2,
        totalBytes: 204800,
        hashedBytes: 102400,
        skippedCount: 0,
        errorCount: 0,
        errors: [],
        startedAtMs: 1000,
        updatedAtMs: 2000,
        completedAtMs: null
      })
    })

    expect(screen.getByText(/source scan/i)).toBeInTheDocument()

    harness.setCatalogPhotos([
      makePhoto(1, 'existing_sunset.jpg'),
      makePhoto(2, 'new_mountain.jpg')
    ])

    act(() => {
      harness.emitScanProgress({
        jobId: 42,
        status: 'completed',
        phase: 'hashing',
        roots: ['D:\\SamplePhotos\\NewTrip'],
        discoveredCount: 2,
        hashedCount: 2,
        totalFilesToHash: 2,
        totalBytes: 204800,
        hashedBytes: 204800,
        skippedCount: 0,
        errorCount: 0,
        errors: [],
        startedAtMs: 1000,
        updatedAtMs: 3000,
        completedAtMs: 3000
      })
    })

    await waitFor(() => {
      expect(screen.getByText('new_mountain.jpg')).toBeInTheDocument()
      expect(screen.getByText('2 photos')).toBeInTheDocument()
    })
  })

  it('shows Add photos CTA on Photographs even when no sources are connected yet', async () => {
    setupMockAppApi({
      initialSourceCount: 0,
      initialPhotos: [],
      modelState: 'missing'
    })

    render(<App />)

    await waitFor(() => expect(screen.getByRole('button', { name: /^photos$/i })).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: /^photos$/i }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /add photos/i })).toBeInTheDocument()
    })
  })

  it('replaces inactive search box with one Turn on photo search panel, explains one-time download, tracks progress while photos remain browsable, and reveals search when usable', async () => {
    const harness = setupMockAppApi({
      initialSourceCount: 1,
      initialPhotos: [makePhoto(1, 'beach_day.jpg'), makePhoto(2, 'forest_trail.jpg')],
      modelState: 'missing'
    })

    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: /^photos$/i })).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: /^photos$/i }))

    await waitFor(() => expect(screen.getByText('beach_day.jpg')).toBeInTheDocument())

    // Inactive search box and technical banner must not be shown on first run
    expect(screen.queryByRole('search')).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText(/search photos by description/i)).not.toBeInTheDocument()
    expect(screen.queryByTestId('search-model-missing-notice')).not.toBeInTheDocument()
    expect(screen.queryByTestId('enable-photo-search-btn')).not.toBeInTheDocument()

    // One Turn on photo search panel explains the one-time download before it starts
    const panel = screen.getByTestId('turn-on-photo-search-panel')
    expect(panel).toHaveTextContent(/turn on photo search/i)
    expect(panel).toHaveTextContent(/one-time ~149 mib download/i)
    expect(harness.api.downloadSemanticModel).not.toHaveBeenCalled()

    // Browsing photos stays usable while setup panel is visible
    fireEvent.click(screen.getByText('beach_day.jpg'))
    expect(screen.getByText('Photograph Details')).toBeInTheDocument()

    // Start one-time download from the panel
    fireEvent.click(screen.getByTestId('turn-on-photo-search-btn'))
    await waitFor(() => expect(harness.api.downloadSemanticModel).toHaveBeenCalledTimes(1))

    // Plain-language download progress shown while photos remain browsable and search box stays hidden
    expect(screen.getByTestId('photo-search-download-progress')).toBeInTheDocument()
    expect(screen.getByText(/downloading search support/i)).toBeInTheDocument()
    expect(screen.getByText(/your photos remain browsable/i)).toBeInTheDocument()
    expect(screen.queryByRole('search')).not.toBeInTheDocument()
    expect(screen.getByText('forest_trail.jpg')).toBeInTheDocument()

    // Model finishes installing -> search field is revealed and indexing starts
    act(() => {
      harness.emitModelStatus(makeModelStatus('ready', 155851918))
    })

    await waitFor(() => expect(harness.api.startSemanticIndexing).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('search')).toBeInTheDocument()
    expect(screen.getByPlaceholderText(/search photos by description/i)).toBeInTheDocument()
    expect(screen.getByTestId('photo-search-indexing-progress')).toBeInTheDocument()
    expect(screen.getByText(/preparing your photos for search/i)).toBeInTheDocument()

    // Indexing completes -> tells user search is ready
    act(() => {
      harness.emitIndexProgress(makeIndexProgress('completed', 2, 2))
    })

    await waitFor(() => {
      expect(screen.getByTestId('photo-search-ready-notice')).toBeInTheDocument()
      expect(screen.getByText(/photo search is ready/i)).toBeInTheDocument()
    })
  })

  it('shows Try again when photo search setup fails and reveals search after retry succeeds', async () => {
    const harness = setupMockAppApi({
      initialSourceCount: 1,
      initialPhotos: [makePhoto(1, 'lake_view.jpg')],
      modelState: 'missing'
    })

    vi.mocked(harness.api.downloadSemanticModel).mockRejectedValueOnce(
      new Error('Network unavailable')
    )

    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: /^photos$/i })).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: /^photos$/i }))
    await waitFor(() => expect(screen.getByText('lake_view.jpg')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('turn-on-photo-search-btn'))

    await waitFor(() => {
      expect(screen.getByTestId('photo-search-setup-error')).toBeInTheDocument()
    })
    expect(screen.getByTestId('retry-photo-search-btn')).toHaveTextContent(/try again/i)
    expect(screen.queryByRole('search')).not.toBeInTheDocument()
    expect(screen.getByText('lake_view.jpg')).toBeInTheDocument()

    // Retry succeeds
    fireEvent.click(screen.getByTestId('retry-photo-search-btn'))
    await waitFor(() => expect(harness.api.downloadSemanticModel).toHaveBeenCalledTimes(2))

    act(() => {
      harness.emitModelStatus(makeModelStatus('ready', 155851918))
    })

    await waitFor(() => {
      expect(screen.getByRole('search')).toBeInTheDocument()
      expect(screen.getByPlaceholderText(/search photos by description/i)).toBeInTheDocument()
    })
  })

  it('supports narrow viewports and keyboard navigation for Add photos and Turn on photo search', async () => {
    window.innerWidth = 420
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('767px'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))

    setupMockAppApi({
      initialSourceCount: 1,
      initialPhotos: [makePhoto(1, 'narrow_photo.jpg')],
      modelState: 'missing'
    })

    render(<App />)

    // Open mobile navigation drawer with keyboard/button
    const navToggle = await waitFor(() => screen.getByRole('button', { name: /open navigation/i }))
    navToggle.focus()
    expect(document.activeElement).toBe(navToggle)
    fireEvent.click(navToggle)

    const photosNavBtn = screen.getByRole('button', { name: /^photos$/i })
    photosNavBtn.focus()
    fireEvent.click(photosNavBtn)

    await waitFor(() => expect(screen.getByText('narrow_photo.jpg')).toBeInTheDocument())

    const addPhotosBtn = screen.getByTestId('photos-add-photos-btn')
    addPhotosBtn.focus()
    expect(document.activeElement).toBe(addPhotosBtn)

    const turnOnBtn = screen.getByTestId('turn-on-photo-search-btn')
    turnOnBtn.focus()
    expect(document.activeElement).toBe(turnOnBtn)
  })
})
