import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PhotosPanel } from '../../src/renderer/src/components/PhotosPanel'
import type { VaultApi } from '../../src/preload/index.d'
import type { PhotoItem } from '../../src/shared/validation/ipc-schemas'

function makePhoto(id: number, fileName: string, overrides: Partial<PhotoItem> = {}): PhotoItem {
  const dotIdx = fileName.lastIndexOf('.')
  const ext = dotIdx >= 0 ? fileName.slice(dotIdx).toLowerCase() : '.jpg'
  return {
    id,
    sourceId: 1,
    originalPath: `C:\\Media\\${fileName}`,
    fileName,
    extension: ext,
    category: 'photo',
    mediaKind: 'photo',
    discoveryObservationId: id,
    byteSize: 8192,
    filesystemBirthtimeMs: 1700000000000,
    filesystemMtimeMs: 1700000000000,
    inferredCaptureTimeMs: null,
    firstDiscoveredAtMs: 1700000000000,
    lastSeenAtMs: 1700000000000,
    activeHash: 'b'.repeat(64),
    activeHashVerifiedAtMs: 1700000000000,
    rating: null,
    flag: 'none',
    annotationVersion: 0,
    ...overrides
  }
}

function makeVideo(id: number, fileName: string, overrides: Partial<PhotoItem> = {}): PhotoItem {
  return makePhoto(id, fileName, {
    mediaKind: 'video',
    videoContainer: 'mp4',
    videoCodec: 'h264',
    audioCodec: 'aac',
    videoDurationMs: 4200,
    videoWidthPx: 1920,
    videoHeightPx: 1080,
    videoStructureError: null,
    ...overrides
  })
}

const TOKEN_1 = '1'.repeat(48)
const TOKEN_2 = '2'.repeat(48)

describe('Full-size Photo Viewer, Video Playback, and Grid Interactions', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function installBaseApi(items: PhotoItem[]) {
    const getPhotosPage = vi
      .fn()
      .mockImplementation(async (req: { offset?: number; limit?: number } = {}) => {
        const offset = req.offset ?? 0
        const limit = req.limit ?? 50
        return {
          items: items.slice(offset, offset + limit),
          totalCount: items.length,
          photoCount: items.filter((i) => i.mediaKind !== 'video').length,
          videoCount: items.filter((i) => i.mediaKind === 'video').length,
          offset,
          limit,
          hasMore: offset + limit < items.length
        }
      })
    const searchPhotosMetadataAware = vi.fn().mockResolvedValue({
      mode: 'metadata_only',
      items: items.map((photo, rank) => ({ photo, score: null, rank: rank + 1 })),
      totalMatched: items.length,
      eligibleCount: items.length,
      unindexedCount: 0,
      staleCount: 0,
      corruptCount: 0,
      interpretedFilters: { place: null, date: null, camera: null, visualTerms: null },
      clarification: null,
      visualModelRequired: false,
      filteredCandidateCount: items.length,
      modelStatus: 'missing',
      queryLatencyMs: 5
    })
    const getThumbnail = vi.fn().mockImplementation(async ({ locationId }) => ({
      status: 'ready',
      locationId,
      dataUrl: 'data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=',
      mimeType: 'image/webp',
      width: 300,
      height: 200
    }))
    const getOriginalPhoto = vi.fn().mockImplementation(async ({ locationId }) => ({
      status: 'ready',
      locationId,
      dataUrl: 'data:image/webp;base64,AAAA',
      mimeType: 'image/webp',
      width: 4000,
      height: 3000,
      sourceKind: 'original'
    }))
    const prepareVideoPlayback = vi.fn().mockResolvedValue({
      status: 'ready',
      locationId: 2,
      token: TOKEN_1,
      streamUrl: `pv-media://video/${TOKEN_1}`,
      mimeType: 'video/mp4',
      container: 'mp4',
      videoCodec: 'h264',
      audioCodec: 'aac',
      hasVideoTrack: true,
      durationMs: 4200,
      widthPx: 1920,
      heightPx: 1080,
      sourceKind: 'original',
      canOpenInDefaultPlayer: true
    })
    const revokeVideoPlaybackToken = vi.fn().mockResolvedValue(true)
    const openMediaInDefaultPlayer = vi.fn().mockResolvedValue({
      ok: true,
      usedTemporaryCopy: true,
      launchedFileName: 'IMG_1450.mov',
      message: 'Opened a read-only temporary copy (IMG_1450.mov) in your default media player.'
    })

    window.api = {
      ...window.api,
      getPhotosPage,
      searchPhotosMetadataAware,
      getThumbnail,
      cancelThumbnail: vi.fn().mockResolvedValue({ success: true, locationId: 1 }),
      getOriginalPhoto,
      prepareVideoPlayback,
      revokeVideoPlaybackToken,
      openMediaInDefaultPlayer,
      onMediaLibraryUpdated: vi.fn().mockReturnValue(() => {}),
      onThumbnailPrepProgress: vi.fn().mockReturnValue(() => {}),
      getThumbnailPrepProgress: vi.fn().mockResolvedValue({
        status: 'completed',
        totalPhotos: items.length,
        preparedPhotos: items.length,
        unsupportedPhotos: 0,
        unavailablePhotos: 0,
        failedPhotos: 0,
        pendingPhotos: 0
      }),
      getPhotoAnnotation: vi.fn().mockResolvedValue({ annotation: null }),
      getPhotoMemberships: vi.fn().mockResolvedValue({ items: [] }),
      listCollections: vi.fn().mockResolvedValue({
        items: [],
        totalCount: 0,
        offset: 0,
        limit: 50,
        hasMore: false
      }),
      getPhotoMetadataDetail: vi.fn().mockResolvedValue({ detail: null }),
      getPhotoMetadataFacets: vi.fn().mockResolvedValue({
        items: [],
        totalDistinctCount: 0,
        unknownCount: 0,
        unextractedCount: 0
      }),
      getPhotoMetadataProgress: vi.fn().mockResolvedValue({
        status: 'completed',
        totalPhotos: 0,
        processedPhotos: 0,
        unsupportedPhotos: 0,
        failedPhotos: 0,
        pendingPhotos: 0
      }),
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
      onSemanticModelStatus: vi.fn().mockReturnValue(() => {}),
      onSemanticIndexProgress: vi.fn().mockReturnValue(() => {}),
      onPhotoMetadataProgress: vi.fn().mockReturnValue(() => {}),
      listSavedEvents: vi.fn().mockResolvedValue({ items: [] }),
      listSavedPlaces: vi.fn().mockResolvedValue({ items: [] }),
      listCameraLabels: vi.fn().mockResolvedValue({ items: [] })
    } as unknown as VaultApi

    return {
      getPhotosPage,
      searchPhotosMetadataAware,
      getThumbnail,
      getOriginalPhoto,
      prepareVideoPlayback,
      revokeVideoPlaybackToken,
      openMediaInDefaultPlayer
    }
  }

  it('opens large viewer on single click, supports Fit/Zoom/100%/Pan, Prev/Next, Details jump, keyboard & scroll restore', async () => {
    const p1 = makePhoto(1, 'alpha.jpg')
    const p2 = makePhoto(2, 'portrait_exif6.heic', { extension: '.heic' })
    const p3 = makePhoto(3, 'gamma.jpg')
    const mocks = installBaseApi([p1, p2, p3])

    render(<PhotosPanel />)
    await waitFor(() => {
      expect(screen.getByText('alpha.jpg')).toBeInTheDocument()
    })

    const grid = document.querySelector('.photos-grid-container') as HTMLDivElement
    Object.defineProperty(grid, 'scrollTop', { writable: true, configurable: true, value: 240 })

    // Single click on photo itself opens viewer directly (Details remains closed)
    const openBtn1 = screen.getByTestId('photo-open-btn-1')
    openBtn1.focus()
    fireEvent.click(openBtn1)

    await waitFor(() => {
      expect(screen.getByTestId('photos-original-modal')).toBeInTheDocument()
      expect(screen.getByTestId('photos-original-img')).toBeInTheDocument()
    })
    expect(mocks.getOriginalPhoto).toHaveBeenCalledWith({ locationId: 1 })
    expect(screen.queryByRole('heading', { name: /photograph details/i })).not.toBeInTheDocument()

    // Fit by default
    const img = screen.getByTestId('photos-original-img')
    expect(img).toHaveAttribute('data-zoom-mode', 'fit')
    expect(screen.getByTestId('media-viewer-zoom-level')).toHaveTextContent('Fit')

    // 100% actual size + pan drag
    fireEvent.click(screen.getByTestId('media-viewer-100-btn'))
    expect(screen.getByTestId('photos-original-img')).toHaveAttribute('data-zoom-mode', 'actual')
    expect(screen.getByTestId('media-viewer-zoom-level')).toHaveTextContent('100%')

    const stage = screen.getByTestId('media-viewer-stage')
    fireEvent.mouseDown(stage, { button: 0, clientX: 100, clientY: 100 })
    fireEvent.mouseMove(stage, { clientX: 145, clientY: 80 })
    fireEvent.mouseUp(stage)
    expect(screen.getByTestId('photos-original-img').style.transform).toContain(
      'translate3d(45px, -20px, 0)'
    )

    // Zoom in / Zoom out / back to Fit
    fireEvent.click(screen.getByTestId('media-viewer-zoom-in'))
    expect(screen.getByTestId('media-viewer-zoom-level')).toHaveTextContent('125%')
    fireEvent.click(screen.getByTestId('media-viewer-zoom-out'))
    expect(screen.getByTestId('media-viewer-zoom-level')).toHaveTextContent('100%')
    fireEvent.click(screen.getByTestId('media-viewer-fit-btn'))
    expect(screen.getByTestId('photos-original-img')).toHaveAttribute('data-zoom-mode', 'fit')

    // Navigate with Next button and ArrowRight, then Previous
    expect(screen.getByTestId('media-viewer-counter')).toHaveTextContent('1 of 3')
    fireEvent.click(screen.getByTestId('media-viewer-next-btn'))
    await waitFor(() => {
      expect(mocks.getOriginalPhoto).toHaveBeenCalledWith({ locationId: 2 })
      expect(screen.getByTestId('media-viewer-counter')).toHaveTextContent('2 of 3')
    })
    fireEvent.keyDown(document, { key: 'ArrowRight' })
    await waitFor(() => {
      expect(mocks.getOriginalPhoto).toHaveBeenCalledWith({ locationId: 3 })
      expect(screen.getByTestId('media-viewer-counter')).toHaveTextContent('3 of 3')
    })
    fireEvent.keyDown(document, { key: 'ArrowLeft' })
    await waitFor(() => {
      expect(screen.getByTestId('media-viewer-counter')).toHaveTextContent('2 of 3')
    })

    // Escape closes viewer, restores focus to opened photo card button, preserves grid scrollTop
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByTestId('photos-original-modal')).not.toBeInTheDocument()
    })
    expect(grid.scrollTop).toBe(240)
    expect(document.activeElement).toBe(screen.getByTestId('photo-open-btn-2'))

    // Enter key opens viewer, Details action switches to Details panel
    fireEvent.keyDown(screen.getByTestId('photo-open-btn-1'), { key: 'Enter' })
    await waitFor(() => {
      expect(screen.getByTestId('photos-original-modal')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('media-viewer-details-btn'))
    await waitFor(() => {
      expect(screen.queryByTestId('photos-original-modal')).not.toBeInTheDocument()
      expect(screen.getByRole('heading', { name: /photograph details/i })).toBeInTheDocument()
    })
  })

  it('shows clear source banners for verified vault copies and cached-preview-only photos, and preserves search order', async () => {
    const s1 = makePhoto(10, 'vault_photo.jpg')
    const s2 = makePhoto(11, 'cached_only.jpg')
    const mocks = installBaseApi([s1, s2])
    mocks.searchPhotosMetadataAware.mockResolvedValue({
      mode: 'metadata_only',
      items: [
        { photo: s2, score: null, rank: 1 },
        { photo: s1, score: null, rank: 2 }
      ],
      totalMatched: 2,
      eligibleCount: 2,
      unindexedCount: 0,
      staleCount: 0,
      corruptCount: 0,
      interpretedFilters: { place: null, date: null, camera: null, visualTerms: null },
      clarification: null,
      visualModelRequired: false,
      filteredCandidateCount: 2,
      modelStatus: 'missing',
      queryLatencyMs: 3
    })
    mocks.getOriginalPhoto
      .mockResolvedValueOnce({
        status: 'ready',
        locationId: 11,
        dataUrl: 'data:image/webp;base64,AAAA',
        mimeType: 'image/webp',
        width: 320,
        height: 240,
        sourceKind: 'cached_preview',
        notice:
          'Showing a cached preview only. The original file is unavailable and no verified vault copy was found.'
      })
      .mockResolvedValueOnce({
        status: 'ready',
        locationId: 10,
        dataUrl: 'data:image/webp;base64,BBBB',
        mimeType: 'image/webp',
        width: 2400,
        height: 1600,
        sourceKind: 'vault_copy',
        notice: 'Showing verified vault copy because the original source file is unavailable.'
      })

    render(<PhotosPanel />)
    await waitFor(() => {
      expect(screen.getByText('vault_photo.jpg')).toBeInTheDocument()
    })

    // Trigger filtered search
    const searchInput = document.querySelector('.photos-search-form input') as HTMLInputElement
    expect(searchInput).not.toBeNull()
    fireEvent.change(searchInput, { target: { value: 'trip' } })
    fireEvent.submit(searchInput.closest('form')!)

    await waitFor(() => {
      expect(mocks.searchPhotosMetadataAware).toHaveBeenCalled()
      expect(screen.getByTestId('photo-open-btn-11')).toBeInTheDocument()
    })

    // First item in filtered search result order is cached_only.jpg (id 11)
    fireEvent.click(screen.getByTestId('photo-open-btn-11'))
    await waitFor(() => {
      expect(screen.getByTestId('media-viewer-cached-notice')).toHaveTextContent(
        /cached preview only/i
      )
    })

    // Next item in search order is vault_photo.jpg (id 10)
    fireEvent.click(screen.getByTestId('media-viewer-next-btn'))
    await waitFor(() => {
      expect(screen.getByTestId('media-viewer-source-notice')).toHaveTextContent(
        /verified vault copy/i
      )
    })
  })

  it('filters media kinds, plays MP4/MOV with controls, handles HEVC fallback + default player, corrupt & missing videos', async () => {
    const imgItem = makePhoto(1, 'still.jpg')
    const mp4Item = makeVideo(2, 'clip.mp4', { videoContainer: 'mp4', videoCodec: 'h264' })
    const hevcMislabeled = makeVideo(3, 'IMG_1450.JPG', {
      extension: '.JPG',
      videoContainer: 'quicktime',
      videoCodec: 'hevc',
      audioCodec: 'aac',
      videoDurationMs: 2500,
      videoWidthPx: 1920,
      videoHeightPx: 1080
    })
    const corruptItem = makeVideo(4, 'corrupt.mov', {
      videoContainer: 'quicktime',
      videoStructureError: 'Corrupt or truncated movie header'
    })
    const missingVideo = makeVideo(5, 'offline.mp4')

    const mocks = installBaseApi([imgItem, mp4Item, hevcMislabeled, corruptItem, missingVideo])
    mocks.prepareVideoPlayback
      .mockResolvedValueOnce({
        status: 'ready',
        locationId: 2,
        token: TOKEN_1,
        streamUrl: `pv-media://video/${TOKEN_1}`,
        mimeType: 'video/mp4',
        container: 'mp4',
        videoCodec: 'h264',
        audioCodec: 'aac',
        hasVideoTrack: true,
        durationMs: 12000,
        widthPx: 1920,
        heightPx: 1080,
        sourceKind: 'original',
        canOpenInDefaultPlayer: true
      })
      .mockResolvedValueOnce({
        status: 'ready',
        locationId: 3,
        token: TOKEN_2,
        streamUrl: `pv-media://video/${TOKEN_2}`,
        mimeType: 'video/mp4',
        container: 'quicktime',
        videoCodec: 'hevc',
        audioCodec: 'aac',
        hasVideoTrack: true,
        durationMs: 2500,
        widthPx: 1920,
        heightPx: 1080,
        sourceKind: 'original',
        canOpenInDefaultPlayer: true
      })
      .mockResolvedValueOnce({
        status: 'corrupt',
        locationId: 4,
        reason: 'This video file header is corrupt or truncated and cannot be read.',
        container: 'quicktime',
        canOpenInDefaultPlayer: true
      })
      .mockResolvedValueOnce({
        status: 'missing',
        locationId: 5,
        reason: 'Video source file is disconnected or unavailable on disk.',
        canOpenInDefaultPlayer: false
      })

    render(<PhotosPanel />)
    await waitFor(() => {
      expect(screen.getByText('IMG_1450.JPG')).toBeInTheDocument()
    })

    // Videos skip image thumbnail decoding and show mismatch / duration / corrupt badges
    expect(mocks.getThumbnail).toHaveBeenCalledTimes(1)
    expect(mocks.getThumbnail).toHaveBeenCalledWith(expect.objectContaining({ locationId: 1 }))
    expect(screen.getByTestId('video-card-tile-3')).toHaveTextContent(/Detected video \(MOV\)/i)
    expect(screen.getByTestId('video-card-tile-4')).toHaveTextContent(/Unreadable video/i)

    // Media type filter buttons trigger backend filter queries
    fireEvent.click(screen.getByTestId('media-filter-video'))
    await waitFor(() => {
      expect(mocks.getPhotosPage).toHaveBeenLastCalledWith(
        expect.objectContaining({ mediaKindFilter: 'video' })
      )
    })

    // Open playable H.264 MP4 and exercise controls
    fireEvent.click(screen.getByTestId('photo-open-btn-2'))
    const videoEl = (await waitFor(() =>
      screen.getByTestId('media-viewer-video')
    )) as HTMLVideoElement
    expect(videoEl).toHaveAttribute('src', `pv-media://video/${TOKEN_1}`)

    const playSpy = vi.fn().mockResolvedValue(undefined)
    const pauseSpy = vi.fn()
    Object.defineProperty(videoEl, 'play', { configurable: true, value: playSpy })
    Object.defineProperty(videoEl, 'pause', { configurable: true, value: pauseSpy })
    Object.defineProperty(videoEl, 'paused', { writable: true, configurable: true, value: true })
    Object.defineProperty(videoEl, 'duration', { configurable: true, value: 12 })

    const container = screen.getByTestId('video-player-container')
    const fsSpy = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(container, 'requestFullscreen', { configurable: true, value: fsSpy })

    fireEvent.loadedMetadata(videoEl)
    fireEvent.click(screen.getByTestId('video-play-pause-btn'))
    expect(playSpy).toHaveBeenCalled()

    const seekSlider = screen.getByTestId('video-seek-slider')
    fireEvent.change(seekSlider, { target: { value: '5.5' } })
    expect(videoEl.currentTime).toBe(5.5)

    const volSlider = screen.getByTestId('video-volume-slider')
    fireEvent.change(volSlider, { target: { value: '0.4' } })
    expect(videoEl.volume).toBeCloseTo(0.4)

    fireEvent.click(screen.getByTestId('video-fullscreen-btn'))
    expect(fsSpy).toHaveBeenCalled()

    // Navigate to IMG_1450.JPG -> previous token is revoked; simulate Chromium HEVC zero videoWidth fallback
    fireEvent.click(screen.getByTestId('media-viewer-next-btn'))
    const hevcVideoEl = (await waitFor(() =>
      screen.getByTestId('media-viewer-video')
    )) as HTMLVideoElement
    expect(mocks.revokeVideoPlaybackToken).toHaveBeenCalledWith({ token: TOKEN_1 })

    Object.defineProperty(hevcVideoEl, 'videoWidth', { configurable: true, value: 0 })
    Object.defineProperty(hevcVideoEl, 'videoHeight', { configurable: true, value: 0 })
    await act(async () => {
      fireEvent.loadedData(hevcVideoEl)
    })

    const fallbackPanel = await screen.findByTestId('video-fallback-panel')
    expect(fallbackPanel).toHaveTextContent(/HEVC \(H\.265\)/i)
    fireEvent.click(screen.getByTestId('video-open-default-player-btn'))
    await waitFor(() => {
      expect(mocks.openMediaInDefaultPlayer).toHaveBeenCalledWith({ locationId: 3 })
      expect(screen.getByTestId('video-default-player-feedback')).toHaveTextContent(
        /IMG_1450\.mov/i
      )
    })

    // Navigate to corrupt movie -> shows honest unreadable message
    fireEvent.click(screen.getByTestId('media-viewer-next-btn'))
    await waitFor(() => {
      expect(screen.getByTestId('photos-original-error')).toHaveTextContent(/corrupt or truncated/i)
    })

    // Navigate to disconnected movie -> shows missing error without default-player button
    fireEvent.click(screen.getByTestId('media-viewer-next-btn'))
    await waitFor(() => {
      expect(screen.getByTestId('photos-original-error')).toHaveTextContent(/disconnected/i)
      expect(screen.queryByTestId('video-open-default-player-btn')).not.toBeInTheDocument()
    })
  })

  it('uses plain verified-vault-copy fallback notices without falsely claiming original is unavailable', async () => {
    const photoVaultItem = makePhoto(21, 'in-vault.jpg')
    const videoVaultItem = makeVideo(22, 'in-vault.mp4')
    const mocks = installBaseApi([photoVaultItem, videoVaultItem])

    mocks.getOriginalPhoto.mockResolvedValueOnce({
      status: 'ready',
      locationId: 21,
      dataUrl: 'data:image/webp;base64,BBBB',
      mimeType: 'image/webp',
      width: 1200,
      height: 800,
      sourceKind: 'vault_copy'
    })
    mocks.prepareVideoPlayback.mockResolvedValueOnce({
      status: 'ready',
      locationId: 22,
      token: TOKEN_1,
      streamUrl: `pv-media://video/${TOKEN_1}`,
      mimeType: 'video/mp4',
      container: 'mp4',
      videoCodec: 'h264',
      audioCodec: 'aac',
      hasVideoTrack: true,
      durationMs: 4200,
      widthPx: 1920,
      heightPx: 1080,
      sourceKind: 'vault_copy',
      canOpenInDefaultPlayer: true
    })

    render(<PhotosPanel />)
    await waitFor(() => {
      expect(screen.getByText('in-vault.jpg')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTestId('photo-open-btn-21'))
    await waitFor(() => {
      const notice = screen.getByTestId('media-viewer-source-notice')
      expect(notice).toHaveTextContent('Showing your verified vault copy.')
      expect(notice).not.toHaveTextContent(/unavailable/i)
    })

    fireEvent.click(screen.getByTestId('media-viewer-next-btn'))
    await waitFor(() => {
      const notice = screen.getByTestId('media-viewer-source-notice')
      expect(notice).toHaveTextContent('Playing your verified vault copy.')
      expect(notice).not.toHaveTextContent(/unavailable/i)
    })
  })

  it('labels missing/corrupt vault copies clearly on grid cards & details, and labels cached previews in header and banner', async () => {
    const missingVaultPhoto = makePhoto(31, 'missing-vault.jpg')
    const corruptVaultPhoto = makePhoto(32, 'corrupt-vault.heic', { extension: '.heic' })
    const cachedOnlyPhoto = makePhoto(33, 'cached-only.jpg')
    const mocks = installBaseApi([missingVaultPhoto, corruptVaultPhoto, cachedOnlyPhoto])

    mocks.getThumbnail.mockImplementation(async ({ locationId }) => {
      if (locationId === 31) {
        return {
          status: 'error',
          locationId: 31,
          code: 'VAULT_COPY_MISSING',
          message:
            'The recorded vault copy is missing from the active vault. Your original file path and metadata are preserved.'
        }
      }
      if (locationId === 32) {
        return {
          status: 'error',
          locationId: 32,
          code: 'VAULT_COPY_CORRUPT',
          message:
            'The recorded vault copy is corrupt and failed verification. Your original file path and metadata are preserved.'
        }
      }
      return {
        status: 'ready',
        locationId,
        dataUrl: 'data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=',
        mimeType: 'image/webp',
        width: 300,
        height: 200,
        originalUnavailable: true,
        sourceKind: 'cached_preview'
      }
    })

    mocks.getOriginalPhoto.mockResolvedValueOnce({
      status: 'ready',
      locationId: 33,
      dataUrl: 'data:image/webp;base64,AAAA',
      mimeType: 'image/webp',
      width: 300,
      height: 200,
      sourceKind: 'cached_preview',
      notice:
        'Cached preview only (not full size). The original file is currently unavailable and no verified vault copy was found.'
    })

    render(<PhotosPanel />)
    await waitFor(() => {
      expect(screen.getByText('Vault copy missing')).toBeInTheDocument()
      expect(screen.getByText('Vault copy corrupt')).toBeInTheDocument()
      expect(screen.getByText('Original unavailable')).toBeInTheDocument()
    })

    // Details panel shows the clear vault-copy error explanation alongside preserved originalPath
    fireEvent.click(screen.getByTestId('photo-details-btn-32'))
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /photograph details/i })).toBeInTheDocument()
      expect(
        screen.getByText(/The recorded vault copy is corrupt and failed verification/i)
      ).toBeInTheDocument()
      expect(screen.getByText('C:\\Media\\corrupt-vault.heic')).toBeInTheDocument()
    })

    // Opening cached-preview-only photo labels both header dimensions and warning banner clearly
    fireEvent.click(screen.getByTestId('photo-open-btn-33'))
    await waitFor(() => {
      expect(screen.getByTestId('photos-original-dims')).toHaveTextContent(
        /300 × 200 · Cached preview/i
      )
      expect(screen.getByTestId('media-viewer-cached-notice')).toHaveTextContent(
        /Cached preview only/i
      )
    })
  })
})
