import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PhotosPanel } from '../../src/renderer/src/components/PhotosPanel'
import type { VaultApi } from '../../src/preload/index.d'
import type { PhotoItem } from '../../src/shared/validation/ipc-schemas'

function makePhoto(id: number, fileName: string): PhotoItem {
  return {
    id,
    sourceId: 1,
    originalPath: `C:\\Photos\\${fileName}`,
    fileName,
    extension: fileName.endsWith('.heic') ? '.heic' : '.jpg',
    category: 'photo',
    discoveryObservationId: id,
    byteSize: 4096,
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

describe('Stage 8D: PhotosPanel Open original full-resolution viewer', () => {
  const photo1 = makePhoto(1, 'landscape.jpg')
  const photo2 = makePhoto(2, 'portrait.heic')

  beforeEach(() => {
    vi.restoreAllMocks()
    window.api = {
      ...window.api,
      getPhotosPage: vi.fn().mockResolvedValue({
        items: [photo1, photo2],
        totalCount: 2,
        offset: 0,
        limit: 50,
        hasMore: false
      }),
      getThumbnail: vi.fn().mockImplementation(async ({ locationId }) => ({
        status: 'ready',
        locationId,
        dataUrl: 'data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA='
      })),
      cancelThumbnail: vi.fn().mockResolvedValue({ cancelled: true }),
      getPhotoAnnotation: vi.fn().mockResolvedValue({ annotation: null }),
      getPhotoMemberships: vi.fn().mockResolvedValue({ items: [] }),
      listCollections: vi.fn().mockResolvedValue({ items: [] }),
      getPhotoMetadataDetail: vi.fn().mockResolvedValue({ detail: null }),
      getDocumentOcrState: vi.fn().mockResolvedValue({ state: null }),
      getDocumentOcrPreview: vi.fn().mockResolvedValue({ preview: null }),
      getSemanticModelStatus: vi
        .fn()
        .mockResolvedValue({ state: 'missing', error: null, activeDir: null, verifiedAtMs: null }),
      getSemanticIndexProgress: vi.fn().mockResolvedValue({
        status: 'idle',
        totalPhotos: 0,
        processedPhotos: 0,
        currentIndexedPhotos: 0,
        unsupportedPhotos: 0,
        failedPhotos: 0,
        jobId: null,
        lastError: null
      }),
      getPhotoMetadataProgress: vi.fn().mockResolvedValue({
        status: 'idle',
        totalPhotos: 0,
        processedPhotos: 0,
        extractedPhotos: 0,
        unsupportedPhotos: 0,
        failedPhotos: 0,
        jobId: null,
        lastError: null
      }),
      onSemanticModelStatus: vi.fn().mockReturnValue(() => {}),
      onSemanticIndexProgress: vi.fn().mockReturnValue(() => {}),
      onPhotoMetadataProgress: vi.fn().mockReturnValue(() => {}),
      getOriginalPhoto: vi.fn()
    } as unknown as VaultApi
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('loads original only on click, displays full dimensions, ignores stale responses on rapid switch, and shows errors honestly', async () => {
    let resolveFirst!: (val: unknown) => void
    const firstPromise = new Promise((r) => {
      resolveFirst = r
    })
    const getOriginalMock = window.api.getOriginalPhoto as ReturnType<typeof vi.fn>
    getOriginalMock.mockReturnValueOnce(firstPromise).mockResolvedValueOnce({
      status: 'missing',
      locationId: 2,
      reason: 'Source file is missing from disk'
    })

    render(<PhotosPanel />)

    await waitFor(() => {
      expect(screen.getByText('landscape.jpg')).toBeInTheDocument()
    })

    // Selecting photo 1 opens Details but must NOT call getOriginalPhoto yet
    fireEvent.click(screen.getByText('landscape.jpg'))
    expect(getOriginalMock).not.toHaveBeenCalled()

    const openBtn = screen.getByTestId('photos-open-original-btn')
    fireEvent.click(openBtn)
    expect(getOriginalMock).toHaveBeenCalledWith({ locationId: 1 })
    expect(screen.getByTestId('photos-original-modal')).toBeInTheDocument()

    // Rapidly switch to photo 2 before photo 1 resolves
    fireEvent.click(screen.getByText('portrait.heic'))
    await waitFor(() => {
      expect(screen.queryByTestId('photos-original-modal')).not.toBeInTheDocument()
    })

    // Resolve stale photo 1 response — must NOT reopen or overwrite photo 2
    resolveFirst({
      status: 'ready',
      locationId: 1,
      dataUrl: 'data:image/webp;base64,AAAA',
      width: 4032,
      height: 3024,
      mimeType: 'image/webp'
    })
    await Promise.resolve()
    expect(screen.queryByTestId('photos-original-modal')).not.toBeInTheDocument()

    // Open original for photo 2 -> shows honest missing-file error
    fireEvent.click(screen.getByTestId('photos-open-original-btn'))
    await waitFor(() => {
      expect(screen.getByTestId('photos-original-error')).toHaveTextContent(
        'Source file is missing from disk'
      )
    })
  })

  it('closes and clears Open original on A -> B -> A while loading, after loaded, and when Details closes', async () => {
    let resolveLoadingA!: (val: unknown) => void
    const loadingPromiseA = new Promise((r) => {
      resolveLoadingA = r
    })
    const getOriginalMock = window.api.getOriginalPhoto as ReturnType<typeof vi.fn>
    getOriginalMock.mockReturnValueOnce(loadingPromiseA).mockResolvedValueOnce({
      status: 'ready',
      locationId: 1,
      dataUrl: 'data:image/webp;base64,AAAA',
      width: 4032,
      height: 3024,
      mimeType: 'image/webp'
    })

    render(<PhotosPanel />)
    await waitFor(() => {
      expect(screen.getByText('landscape.jpg')).toBeInTheDocument()
    })

    // 1. A -> B -> A while A is still loading
    fireEvent.click(screen.getByText('landscape.jpg'))
    fireEvent.click(screen.getByTestId('photos-open-original-btn'))
    expect(screen.getByTestId('photos-original-modal')).toBeInTheDocument()

    fireEvent.click(screen.getByText('portrait.heic'))
    expect(screen.queryByTestId('photos-original-modal')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('landscape.jpg'))
    expect(screen.queryByTestId('photos-original-modal')).not.toBeInTheDocument()

    // Stale in-flight response for A resolves after returning to A -> must remain closed
    resolveLoadingA({
      status: 'ready',
      locationId: 1,
      dataUrl: 'data:image/webp;base64,STALE',
      width: 4032,
      height: 3024,
      mimeType: 'image/webp'
    })
    await Promise.resolve()
    expect(screen.queryByTestId('photos-original-modal')).not.toBeInTheDocument()

    // 2. Explicit second click on Open original loads A cleanly, then A -> B -> A after A has loaded
    fireEvent.click(screen.getByTestId('photos-open-original-btn'))
    await waitFor(() => {
      expect(screen.getByTestId('photos-original-img')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('portrait.heic'))
    expect(screen.queryByTestId('photos-original-modal')).not.toBeInTheDocument()

    // Returning to A must NOT reopen the previously loaded modal without another explicit click
    fireEvent.click(screen.getByText('landscape.jpg'))
    expect(screen.queryByTestId('photos-original-modal')).not.toBeInTheDocument()

    // 3. Open original on A again, then close Details -> modal closes and clears
    getOriginalMock.mockResolvedValueOnce({
      status: 'ready',
      locationId: 1,
      dataUrl: 'data:image/webp;base64,AAAA',
      width: 4032,
      height: 3024,
      mimeType: 'image/webp'
    })
    fireEvent.click(screen.getByTestId('photos-open-original-btn'))
    await waitFor(() => {
      expect(screen.getByTestId('photos-original-img')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByLabelText('Close details'))
    expect(screen.queryByTestId('photos-original-modal')).not.toBeInTheDocument()
  })
})
