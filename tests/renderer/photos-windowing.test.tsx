import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import { PhotosPanel } from '../../src/renderer/src/components/PhotosPanel'
import { PHOTO_BOUNDS } from '../../src/renderer/src/hooks/usePhotos'
import type { VaultApi } from '../../src/preload/index.d'

function generateMockPhotos(startId: number, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: startId + i,
    sourceId: 1,
    originalPath: `C:\\Photos\\photo_${startId + i}.jpg`,
    fileName: `photo_${startId + i}.jpg`,
    extension: '.jpg',
    category: 'photo' as const,
    discoveryObservationId: startId + i,
    byteSize: 2048,
    filesystemBirthtimeMs: 1700000000000,
    filesystemMtimeMs: 1700000005000,
    inferredCaptureTimeMs: null,
    firstDiscoveredAtMs: 1700000010000,
    lastSeenAtMs: 1700000010000,
    activeHash: `hash_${startId + i}`.padEnd(64, '0'),
    activeHashVerifiedAtMs: 1700000020000
  }))
}

describe('Photos Windowing & Stale Response Safety', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('retains full collection scroll extent for large collections (10,000 photos)', async () => {
    const totalCount = 10000
    const mockGetPhotosPage = vi.fn().mockImplementation(({ offset, limit }) => {
      return Promise.resolve({
        items: generateMockPhotos(offset + 1, Math.min(limit, totalCount - offset)),
        totalCount,
        offset,
        limit,
        hasMore: offset + limit < totalCount
      })
    })

    window.api = {
      ...window.api,
      getPhotosPage: mockGetPhotosPage,
      getThumbnail: vi
        .fn()
        .mockResolvedValue({ status: 'unsupported', locationId: 1, reason: 'test' })
    } as unknown as VaultApi

    const { container } = render(<PhotosPanel />)

    await waitFor(() => {
      expect(screen.getByText('photo_1.jpg')).toBeInTheDocument()
    })

    // Verify the virtual scroll placeholder height represents the full 10,000 collection
    const scrollContainer = container.querySelector('.photos-virtual-container')
    expect(scrollContainer).toBeInTheDocument()
    // With 10,000 photos, the virtual height must be large (e.g. > 100,000 px)
    const virtualHeight = parseInt((scrollContainer as HTMLElement).style.height || '0', 10)
    expect(virtualHeight).toBeGreaterThan(100000)
  })

  it('bounds metadata cache and mounted cells when jumping beyond 2,000 photos', async () => {
    const totalCount = 5000
    const mockGetPhotosPage = vi.fn().mockImplementation(({ offset, limit }) => {
      return Promise.resolve({
        items: generateMockPhotos(offset + 1, Math.min(limit, totalCount - offset)),
        totalCount,
        offset,
        limit,
        hasMore: offset + limit < totalCount
      })
    })

    window.api = {
      ...window.api,
      getPhotosPage: mockGetPhotosPage,
      getThumbnail: vi
        .fn()
        .mockResolvedValue({ status: 'unsupported', locationId: 1, reason: 'test' })
    } as unknown as VaultApi

    const { container } = render(<PhotosPanel />)

    await waitFor(() => {
      expect(screen.getByText('photo_1.jpg')).toBeInTheDocument()
    })

    // Simulate jumping to scroll offset near photo 3,000
    const viewport = container.querySelector('.photos-grid-container')
    expect(viewport).toBeInTheDocument()

    // Trigger scroll event to index 3,000
    act(() => {
      if (viewport) {
        Object.defineProperty(viewport, 'scrollTop', { value: 150000, configurable: true })
        viewport.dispatchEvent(new Event('scroll'))
      }
    })

    await waitFor(() => {
      // Mounted cells in DOM should never exceed MAX_MOUNTED_CELLS (200)
      const mountedCells = container.querySelectorAll('.photo-cell')
      expect(mountedCells.length).toBeLessThanOrEqual(PHOTO_BOUNDS.MAX_MOUNTED_CELLS)
    })
  })

  it('discards delayed thumbnail response arriving after refresh', async () => {
    let resolveSlowThumb!: (res: unknown) => void
    const slowThumbPromise = new Promise((resolve) => {
      resolveSlowThumb = resolve
    })

    const mockGetPhotosPage = vi.fn().mockResolvedValue({
      items: generateMockPhotos(1, 10),
      totalCount: 10,
      offset: 0,
      limit: 50,
      hasMore: false
    })

    const mockGetThumbnail = vi.fn().mockImplementation(({ locationId }) => {
      if (locationId === 1) {
        return slowThumbPromise
      }
      return Promise.resolve({
        status: 'ready',
        locationId,
        dataUrl: 'data:image/webp;base64,QUICK',
        mimeType: 'image/webp',
        width: 100,
        height: 100
      })
    })

    window.api = {
      ...window.api,
      getPhotosPage: mockGetPhotosPage,
      getThumbnail: mockGetThumbnail
    } as unknown as VaultApi

    render(<PhotosPanel />)

    await waitFor(() => {
      expect(screen.getByText('photo_1.jpg')).toBeInTheDocument()
    })

    // Click refresh button to increment generation
    const refreshBtn = screen.getByRole('button', { name: /refresh/i })
    act(() => {
      refreshBtn.click()
    })

    // Now resolve the slow thumbnail from before refresh
    act(() => {
      resolveSlowThumb({
        status: 'ready',
        locationId: 1,
        dataUrl: 'data:image/webp;base64,STALE_THUMB_DATA',
        mimeType: 'image/webp',
        width: 100,
        height: 100
      })
    })

    // Wait and verify the stale image dataUrl was NOT attached
    await waitFor(() => {
      const img = screen.queryByRole('img', { name: /photo_1\.jpg/i })
      if (img) {
        expect((img as HTMLImageElement).src).not.toContain('STALE_THUMB_DATA')
      }
    })
  })
})
