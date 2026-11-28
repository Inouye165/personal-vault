import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { PhotosPanel } from '../../src/renderer/src/components/PhotosPanel'
import type { VaultApi } from '../../src/preload/index.d'

describe('PhotosPanel UI', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('renders loading notice and then confirmed empty state when catalog has no photos', async () => {
    const mockGetPhotosPage = vi.fn().mockResolvedValue({
      items: [],
      totalCount: 0,
      offset: 0,
      limit: 50,
      hasMore: false
    })

    const mockGetThumbnail = vi.fn().mockResolvedValue({
      status: 'missing',
      locationId: 1,
      reason: 'No photo'
    })

    // Setup window.api mock
    window.api = {
      ...window.api,
      getPhotosPage: mockGetPhotosPage,
      getThumbnail: mockGetThumbnail
    } as unknown as VaultApi

    render(<PhotosPanel />)

    expect(screen.getByRole('status')).toHaveTextContent(/Loading photographs/i)

    await waitFor(() => {
      expect(screen.getByText(/No photographs discovered yet/i)).toBeInTheDocument()
    })
  })

  it('displays photo cells with filenames and enables selection into details panel', async () => {
    const mockPhoto = {
      id: 101,
      sourceId: 1,
      originalPath: 'C:\\Users\\Ron\\Pictures\\sunset.jpg',
      fileName: 'sunset.jpg',
      extension: '.jpg',
      category: 'photo' as const,
      discoveryObservationId: 1,
      byteSize: 1048576,
      filesystemBirthtimeMs: 1700000000000,
      filesystemMtimeMs: 1700000005000,
      inferredCaptureTimeMs: null,
      firstDiscoveredAtMs: 1700000010000,
      lastSeenAtMs: 1700000010000,
      activeHash: 'abcdef1234567890'.padEnd(64, '0'),
      activeHashVerifiedAtMs: 1700000020000
    }

    const mockGetPhotosPage = vi.fn().mockResolvedValue({
      items: [mockPhoto],
      totalCount: 1,
      offset: 0,
      limit: 50,
      hasMore: false
    })

    const mockGetThumbnail = vi.fn().mockResolvedValue({
      status: 'ready',
      locationId: 101,
      dataUrl: 'data:image/webp;base64,TEST_DATA_URL',
      mimeType: 'image/webp',
      width: 512,
      height: 384
    })

    window.api = {
      ...window.api,
      getPhotosPage: mockGetPhotosPage,
      getThumbnail: mockGetThumbnail
    } as unknown as VaultApi

    render(<PhotosPanel />)

    await waitFor(() => {
      expect(screen.getByText('sunset.jpg')).toBeInTheDocument()
    })

    // Check thumbnail request
    await waitFor(() => {
      expect(mockGetThumbnail).toHaveBeenCalledWith(expect.objectContaining({ locationId: 101 }))
    })

    // Click Details button to inspect details
    const detailsBtn = screen.getByRole('button', { name: /Details for sunset\.jpg/i })
    fireEvent.click(detailsBtn)

    // Details panel should render factual metadata
    expect(screen.getAllByText(/sunset\.jpg/i).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText(/1,048,576 bytes/i)).toBeInTheDocument()
    expect(screen.getByText(/C:\\Users\\Ron\\Pictures\\sunset\.jpg/i)).toBeInTheDocument()
    // Explicit Unknown for capture date
    expect(screen.getByText(/Capture Date/i).parentElement).toHaveTextContent(/Unknown/i)
  })

  it('displays honest unsupported format placeholder for HEIC or RAW', async () => {
    const mockHeic = {
      id: 102,
      sourceId: 1,
      originalPath: 'C:\\Users\\Ron\\Pictures\\IMG_0001.heic',
      fileName: 'IMG_0001.heic',
      extension: '.heic',
      category: 'photo' as const,
      discoveryObservationId: 2,
      byteSize: 2048000,
      filesystemBirthtimeMs: null,
      filesystemMtimeMs: 1700000000000,
      inferredCaptureTimeMs: null,
      firstDiscoveredAtMs: 1700000000000,
      lastSeenAtMs: 1700000000000,
      activeHash: null,
      activeHashVerifiedAtMs: null
    }

    const mockGetPhotosPage = vi.fn().mockResolvedValue({
      items: [mockHeic],
      totalCount: 1,
      offset: 0,
      limit: 50,
      hasMore: false
    })

    const mockGetThumbnail = vi.fn().mockResolvedValue({
      status: 'unsupported',
      locationId: 102,
      reason: 'HEIC format decoding requires unsupported external toolchains'
    })

    window.api = {
      ...window.api,
      getPhotosPage: mockGetPhotosPage,
      getThumbnail: mockGetThumbnail
    } as unknown as VaultApi

    render(<PhotosPanel />)

    await waitFor(() => {
      expect(screen.getByText('IMG_0001.heic')).toBeInTheDocument()
    })

    await waitFor(() => {
      expect(screen.getByText(/Unsupported/i)).toBeInTheDocument()
    })
  })
})
