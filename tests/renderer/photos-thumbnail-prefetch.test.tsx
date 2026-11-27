import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { PhotosPanel } from '../../src/renderer/src/components/PhotosPanel'
import type { VaultApi } from '../../src/preload/index.d'

function makePhotos(startId: number, count: number, prefix = 'photo') {
  return Array.from({ length: count }, (_, i) => {
    const id = startId + i
    return {
      id,
      sourceId: 1,
      originalPath: `C:\\Photos\\${prefix}_${id}.jpg`,
      fileName: `${prefix}_${id}.jpg`,
      extension: '.jpg',
      category: 'photo' as const,
      discoveryObservationId: id,
      byteSize: 4096,
      filesystemBirthtimeMs: 1700000000000,
      filesystemMtimeMs: 1700000005000,
      inferredCaptureTimeMs: null,
      firstDiscoveredAtMs: 1700000010000,
      lastSeenAtMs: 1700000010000,
      activeHash: `h_${id}_`.padEnd(64, '0'),
      activeHashVerifiedAtMs: 1700000020000
    }
  })
}

describe('Photos Thumbnail Priority, Scroll Prefetch, Reuse & Feedback', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('reuses already-valid cached thumbnails across search switches and renders Original unavailable label + placeholders', async () => {
    const allPhotos = makePhotos(1, 20, 'yellowstone')
    const mockGetPhotosPage = vi.fn().mockResolvedValue({
      items: allPhotos,
      totalCount: 20,
      offset: 0,
      limit: 50,
      hasMore: false
    })
    const mockSearchMetadataAware = vi.fn().mockResolvedValue({
      mode: 'metadata_only',
      items: allPhotos.slice(0, 5).map((photo, idx) => ({
        photo,
        score: null,
        rank: idx + 1,
        matchSource: 'metadata'
      })),
      totalMatched: 5,
      filteredCandidateCount: 5,
      eligibleCount: 5,
      unindexedCount: 0,
      staleCount: 0,
      corruptCount: 0,
      offset: 0,
      limit: 50,
      hasMore: false,
      queryLatencyMs: 5,
      interpretedFilters: {
        place: {
          label: 'Yellowstone National Park',
          normalizedLabel: 'yellowstone national park',
          source: 'offline_gazetteer',
          savedPlaceId: null,
          gpsBounds: { minLat: 44.131, maxLat: 45.111, minLon: -111.156, maxLon: -109.825 }
        },
        date: null,
        camera: null,
        visualTerms: null
      },
      clarification: null,
      visualModelRequired: false,
      modelStatus: 'unprovisioned'
    })

    const mockGetThumbnail = vi.fn().mockImplementation(async ({ locationId }) => {
      if (locationId === 1) {
        return {
          status: 'ready',
          locationId,
          dataUrl: 'data:image/webp;base64,OFFLINE_PREVIEW',
          mimeType: 'image/webp',
          width: 512,
          height: 384,
          originalUnavailable: true
        }
      }
      if (locationId === 2) {
        return {
          status: 'missing',
          locationId,
          reason: 'Original file or source folder is unavailable'
        }
      }
      return {
        status: 'ready',
        locationId,
        dataUrl: 'data:image/webp;base64,VALID_PREVIEW',
        mimeType: 'image/webp',
        width: 512,
        height: 384
      }
    })

    const mockGetThumbnailPrepProgress = vi.fn().mockResolvedValue({
      status: 'running',
      totalPhotos: 100,
      preparedPhotos: 25,
      unsupportedPhotos: 0,
      unavailablePhotos: 0,
      failedPhotos: 0,
      pendingPhotos: 75
    })

    window.api = {
      ...window.api,
      getPhotosPage: mockGetPhotosPage,
      searchPhotosMetadataAware: mockSearchMetadataAware,
      getThumbnail: mockGetThumbnail,
      cancelThumbnail: vi.fn().mockResolvedValue({ success: true, locationId: 1 }),
      getThumbnailPrepProgress: mockGetThumbnailPrepProgress,
      onThumbnailPrepProgress: vi.fn().mockReturnValue(() => {})
    } as unknown as VaultApi

    render(<PhotosPanel />)

    await waitFor(() => {
      expect(screen.getByText('yellowstone_1.jpg')).toBeInTheDocument()
    })

    // Quiet plain-language preparation notice
    await waitFor(() => {
      expect(screen.getByText(/Preparing photo previews/i)).toBeInTheDocument()
    })

    // Item 1 shows cached preview labeled "Original unavailable", item 2 shows clear placeholder instead of "Loading..."
    await waitFor(() => {
      const labels = screen.getAllByText(/Original unavailable/i)
      expect(labels.length).toBeGreaterThanOrEqual(2)
    })

    const callsBeforeSearch = mockGetThumbnail.mock.calls.filter(
      (c) => c[0].locationId === 3
    ).length
    expect(callsBeforeSearch).toBe(1)

    // Switch to Yellowstone search -> already-valid cached thumbnail for photo 3 MUST be reused without re-fetching
    const searchInput = screen.getByPlaceholderText(/Search/i)
    fireEvent.change(searchInput, { target: { value: 'Yellowstone' } })
    fireEvent.submit(searchInput.closest('form')!)

    await waitFor(() => {
      expect(mockSearchMetadataAware).toHaveBeenCalled()
    })

    await waitFor(() => {
      expect(screen.getByText('yellowstone_3.jpg')).toBeInTheDocument()
    })

    const callsAfterSearch = mockGetThumbnail.mock.calls.filter((c) => c[0].locationId === 3).length
    expect(callsAfterSearch).toBe(1)
  })

  it('requests visible tiles at high priority before scroll-direction prefetch rows at normal priority', async () => {
    const totalCount = 200
    const allPhotos = makePhotos(1, totalCount)
    const mockGetPhotosPage = vi.fn().mockImplementation(async ({ offset, limit }) => ({
      items: allPhotos.slice(offset, offset + limit),
      totalCount,
      offset,
      limit,
      hasMore: offset + limit < totalCount
    }))

    const recordedCalls: Array<{ locationId: number; priority?: string }> = []
    const mockGetThumbnail = vi.fn().mockImplementation(async (req) => {
      recordedCalls.push({ locationId: req.locationId, priority: req.priority })
      return {
        status: 'ready',
        locationId: req.locationId,
        dataUrl: 'data:image/webp;base64,AAAA',
        mimeType: 'image/webp',
        width: 512,
        height: 384
      }
    })

    window.api = {
      ...window.api,
      getPhotosPage: mockGetPhotosPage,
      getThumbnail: mockGetThumbnail,
      cancelThumbnail: vi.fn().mockResolvedValue({ success: true, locationId: 1 })
    } as unknown as VaultApi

    render(<PhotosPanel />)

    await waitFor(() => {
      expect(screen.getByText('photo_1.jpg')).toBeInTheDocument()
    })

    await waitFor(() => {
      expect(recordedCalls.some((c) => c.priority === 'normal')).toBe(true)
    })

    const firstNormalIdx = recordedCalls.findIndex((c) => c.priority === 'normal')
    const lastHighIdx = recordedCalls.reduce(
      (acc, c, idx) => (c.priority === 'high' ? idx : acc),
      -1
    )
    expect(lastHighIdx).toBeGreaterThanOrEqual(0)
    expect(lastHighIdx).toBeLessThan(firstNormalIdx)
    // Bounded prefetch: should not flood all 200 items at startup
    expect(recordedCalls.length).toBeLessThan(50)

    // Scroll down -> previously requested offscreen items should only cancel queued work (queuedOnly: true)
    const viewport = document.querySelector('.photos-grid-container') as HTMLElement
    Object.defineProperty(viewport, 'scrollTop', { value: 4000, configurable: true })
    fireEvent.scroll(viewport)

    await waitFor(() => {
      const cancelMock = window.api.cancelThumbnail as ReturnType<typeof vi.fn>
      expect(cancelMock).toHaveBeenCalled()
      const queuedOnlyCalls = cancelMock.mock.calls.filter((c) => c[0]?.queuedOnly === true)
      expect(queuedOnlyCalls.length).toBe(cancelMock.mock.calls.length)
    })
  })
})
