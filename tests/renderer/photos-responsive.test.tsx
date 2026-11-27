import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { useRef, useState } from 'react'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { PhotosPanel } from '../../src/renderer/src/components/PhotosPanel'
import { SemanticIndexPanel } from '../../src/renderer/src/components/SemanticIndexPanel'
import { useFocusTrap } from '../../src/renderer/src/hooks/useFocusTrap'
import type { VaultApi } from '../../src/preload/index.d'
import type { PhotoItem } from '../../src/shared/validation/ipc-schemas'

function makePhoto(id: number): PhotoItem {
  return {
    id,
    sourceId: 1,
    originalPath: `C:\\Fixtures\\photo_${id}.jpg`,
    fileName: `photo_${id}.jpg`,
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

class MockResizeObserver {
  static instances: MockResizeObserver[] = []
  callback: ResizeObserverCallback
  observed: Element[] = []
  disconnected = false

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    MockResizeObserver.instances.push(this)
  }

  observe(target: Element): void {
    this.observed.push(target)
  }

  unobserve(target: Element): void {
    this.observed = this.observed.filter((el) => el !== target)
  }

  disconnect(): void {
    this.disconnected = true
    this.observed = []
  }

  trigger(): void {
    this.callback([], this as unknown as ResizeObserver)
  }
}

function installMockApi(photos: PhotoItem[]): void {
  window.api = {
    getPhotosPage: vi.fn(async () => ({
      items: photos,
      totalCount: photos.length,
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
      items: [{ id: 1, name: 'Favorites', photoCount: 2, createdAtMs: 1, updatedAtMs: 1 }],
      total: 1,
      offset: 0,
      limit: 50
    })),
    listPhotoMemberships: vi.fn(async () => ({
      items: [],
      total: 0,
      offset: 0,
      limit: 50
    })),
    getSemanticModelStatus: vi.fn(async () => ({
      state: 'ready' as const,
      modelId: 'Xenova/clip-vit-base-patch32@6b7c5237',
      modelCommit: '6b7c523703ae26e39be4b03774966f8571c7f523',
      modelManifestSha256: 'a'.repeat(64),
      preprocessingVersion: 'clip_vit_b32_224_bicubic_center_rgb_v1',
      dimensions: 512,
      requiredBytes: 155851918,
      downloadedBytes: 155851918,
      currentArtifact: null,
      verifiedAtMs: 1700000000000,
      error: null,
      lastReplacementError: null
    })),
    getSemanticIndexProgress: vi.fn(async () => ({
      jobId: null,
      status: 'idle' as const,
      modelId: 'Xenova/clip-vit-base-patch32@6b7c5237',
      modelCommit: '6b7c523703ae26e39be4b03774966f8571c7f523',
      preprocessingVersion: 'clip_vit_b32_224_bicubic_center_rgb_v1',
      totalPhotos: 0,
      processedPhotos: 0,
      reusedPhotos: 0,
      unsupportedPhotos: 0,
      failedPhotos: 0,
      pendingPhotos: 0,
      totalCatalogPhotos: photos.length,
      currentIndexedPhotos: photos.length,
      startedAtMs: null,
      updatedAtMs: null,
      completedAtMs: null,
      lastError: null
    })),
    onSemanticIndexProgress: vi.fn(() => () => {}),
    onSemanticModelProgress: vi.fn(() => () => {}),
    getPhotoMetadataProgress: vi.fn(async () => ({
      jobId: null,
      status: 'idle' as const,
      totalPhotos: photos.length,
      processedPhotos: photos.length,
      extractedPhotos: photos.length,
      absentMetadataPhotos: 0,
      reusedPhotos: 0,
      unsupportedPhotos: 0,
      failedPhotos: 0,
      unavailablePhotos: 0,
      pendingPhotos: 0,
      lastError: null,
      coverage: {
        parserRecipeVersion: 'exif_tech_v2',
        totalPhotos: photos.length,
        extractedCount: photos.length,
        noMetadataCount: 0,
        unsupportedCount: 0,
        failedCount: 0,
        unavailableCount: 0,
        staleCount: 0,
        unprocessedCount: 0
      }
    })),
    onPhotoMetadataProgress: vi.fn(() => () => {}),
    getPhotoMetadataDetail: vi.fn(async () => ({
      fileLocationId: 1,
      effectiveStatus: 'extracted' as const,
      parserRecipeVersion: 'exif_tech_v1',
      historicalMetadataCount: 0,
      currentMetadata: null
    })),
    getPhotoMetadataFacets: vi.fn(async () => ({
      items: [],
      totalDistinctCount: 0,
      unknownCount: 0,
      unextractedCount: 0
    })),
    getSimilarityStatus: vi.fn(async () => ({
      status: 'idle' as const,
      totalPhotos: 0,
      processedPhotos: 0,
      unsupportedPhotos: 0,
      errorPhotos: 0,
      candidatePairsFound: 0,
      lastError: null
    })),
    getSimilarityCandidates: vi.fn(async () => ({
      items: [],
      totalCount: 0,
      offset: 0,
      limit: 10,
      hasMore: false
    })),
    onSimilarityProgress: vi.fn(() => () => {}),
    searchPhotosSemantic: vi.fn(),
    cancelPhotosSemanticSearch: vi.fn(async () => ({ cancelled: true }))
  } as unknown as VaultApi
}

describe('PhotosPanel responsive layout, virtualization, filters & accessibility', () => {
  const originalResizeObserver = globalThis.ResizeObserver

  beforeEach(() => {
    vi.restoreAllMocks()
    MockResizeObserver.instances = []
    globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver
  })

  afterEach(() => {
    globalThis.ResizeObserver = originalResizeObserver
  })

  it('attaches ResizeObserver after delayed grid mount and recalculates columns on resize and mode switch', async () => {
    const photos = Array.from({ length: 12 }, (_, idx) => makePhoto(idx + 1))
    installMockApi(photos)

    render(<PhotosPanel />)

    const grid = await waitFor(() => {
      const el = document.querySelector('.photos-grid-container') as HTMLDivElement | null
      expect(el).not.toBeNull()
      return el!
    })

    // Must have observed the delayed-mount grid container
    const activeObserver = MockResizeObserver.instances.find(
      (obs) => !obs.disconnected && obs.observed.includes(grid)
    )
    expect(activeObserver).toBeDefined()

    // Simulate resizing to 1400px wide
    Object.defineProperty(grid, 'clientWidth', { configurable: true, value: 1400 })
    Object.defineProperty(grid, 'clientHeight', { configurable: true, value: 800 })
    act(() => {
      activeObserver!.trigger()
    })

    const wideCols = Number(grid.getAttribute('data-grid-columns'))
    expect(wideCols).toBeGreaterThanOrEqual(6)

    // Switch to Visual Similarity and back to Photo Grid
    fireEvent.click(screen.getByRole('button', { name: /visual similarity/i }))
    expect(document.querySelector('.photos-grid-container')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /photo grid/i }))
    const remountedGrid = await waitFor(() => {
      const el = document.querySelector('.photos-grid-container') as HTMLDivElement | null
      expect(el).not.toBeNull()
      return el!
    })

    const reattachedObserver = MockResizeObserver.instances.find(
      (obs) => !obs.disconnected && obs.observed.includes(remountedGrid)
    )
    expect(reattachedObserver).toBeDefined()

    Object.defineProperty(remountedGrid, 'clientWidth', { configurable: true, value: 360 })
    Object.defineProperty(remountedGrid, 'clientHeight', { configurable: true, value: 600 })
    act(() => {
      reattachedObserver!.trigger()
    })

    const narrowCols = Number(remountedGrid.getAttribute('data-grid-columns'))
    expect(narrowCols).toBeLessThan(wideCols)
    expect(narrowCols).toBeGreaterThanOrEqual(1)
  })

  it('places rating, flag, collection, and metadata controls in an expandable filter panel with active-filter count', async () => {
    const photos = [makePhoto(1)]
    installMockApi(photos)

    render(<PhotosPanel />)

    await waitFor(() => {
      expect(screen.getByText('photo_1.jpg')).toBeInTheDocument()
    })

    // Filter selects should be collapsed initially
    expect(screen.queryByLabelText(/filter by rating/i)).not.toBeInTheDocument()

    const filtersToggle = screen.getByTestId('photos-toggle-metadata-filters')
    expect(filtersToggle).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(filtersToggle)
    expect(filtersToggle).toHaveAttribute('aria-expanded', 'true')

    const ratingSelect = screen.getByLabelText(/filter by rating/i)
    const flagSelect = screen.getByLabelText(/filter by flag/i)
    const collectionSelect = screen.getByLabelText(/filter by collection/i)
    expect(ratingSelect).toBeInTheDocument()
    expect(flagSelect).toBeInTheDocument()
    expect(collectionSelect).toBeInTheDocument()

    await act(async () => {
      fireEvent.change(ratingSelect, { target: { value: '4' } })
    })
    await act(async () => {
      fireEvent.change(flagSelect, { target: { value: 'pick' } })
    })

    expect(filtersToggle).toHaveTextContent(/2/)
  })

  it('dismisses details panel on Escape and restores focus to the selected photo cell', async () => {
    const photos = [makePhoto(1), makePhoto(2)]
    installMockApi(photos)

    render(<PhotosPanel />)

    const cell = await waitFor(() => screen.getByRole('button', { name: /photo_1\.jpg/i }))
    cell.focus()
    fireEvent.click(cell)

    expect(screen.getByRole('heading', { name: /photograph details/i })).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })

    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: /photograph details/i })).not.toBeInTheDocument()
    })
    expect(document.activeElement).toBe(cell)
  })

  it('omits development-stage labels from SemanticIndexPanel', async () => {
    installMockApi([])
    await act(async () => {
      render(<SemanticIndexPanel />)
    })
    expect(screen.queryByText(/stage \d/i)).not.toBeInTheDocument()
  })

  it('opens Filters as a modal drawer, dismisses on Escape, and restores focus to the Filters toggle', async () => {
    const photos = [makePhoto(1)]
    installMockApi(photos)

    render(<PhotosPanel />)
    const filtersToggle = await waitFor(() => screen.getByTestId('photos-toggle-metadata-filters'))
    filtersToggle.focus()
    fireEvent.click(filtersToggle)

    const dialog = screen.getByRole('dialog', { name: /filters and metadata/i })
    expect(dialog).toHaveAttribute('aria-modal', 'true')

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: /filters and metadata/i })
      ).not.toBeInTheDocument()
    })
    expect(document.activeElement).toBe(filtersToggle)
  })

  it('Details -> Filters -> Escape closes only Filters, preserves Details, and a second Escape closes Details (desktop & narrow)', async () => {
    const originalMatchMedia = window.matchMedia
    for (const isNarrow of [false, true]) {
      window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: isNarrow && query.includes('959px'),
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn()
      }))

      try {
        const photos = [makePhoto(1), makePhoto(2)]
        installMockApi(photos)

        const { unmount } = render(<PhotosPanel />)
        const cell = await waitFor(() => screen.getByRole('button', { name: /photo_1\.jpg/i }))
        cell.focus()
        fireEvent.click(cell)
        expect(screen.getByRole('heading', { name: /photograph details/i })).toBeInTheDocument()

        const filtersToggle = screen.getByTestId('photos-toggle-metadata-filters')
        fireEvent.click(filtersToggle)
        const filtersDialog = screen.getByRole('dialog', { name: /filters and metadata/i })
        expect(filtersDialog).toBeInTheDocument()

        // Tab/Shift+Tab remain confined inside the topmost Filters modal
        const focusables = Array.from(
          filtersDialog.querySelectorAll<HTMLElement>(
            'button:not([disabled]), select:not([disabled]), input:not([disabled])'
          )
        )
        const first = focusables[0]!
        const last = focusables[focusables.length - 1]!
        last.focus()
        fireEvent.keyDown(document, { key: 'Tab' })
        expect(document.activeElement).toBe(first)
        fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
        expect(document.activeElement).toBe(last)

        // First Escape closes ONLY Filters and preserves Details & selection
        fireEvent.keyDown(document, { key: 'Escape' })
        await waitFor(() => {
          expect(
            screen.queryByRole('dialog', { name: /filters and metadata/i })
          ).not.toBeInTheDocument()
        })
        expect(screen.getByRole('heading', { name: /photograph details/i })).toBeInTheDocument()
        expect(cell).toHaveAttribute('aria-pressed', 'true')
        if (!isNarrow) {
          expect(document.activeElement).toBe(filtersToggle)
        } else {
          expect(
            document.querySelector('.photo-details-panel')?.contains(document.activeElement)
          ).toBe(true)
        }

        // Second Escape closes Details and restores focus to the photo cell
        fireEvent.keyDown(document, { key: 'Escape' })
        await waitFor(() => {
          expect(
            screen.queryByRole('heading', { name: /photograph details/i })
          ).not.toBeInTheDocument()
        })
        expect(document.activeElement).toBe(cell)
        unmount()
      } finally {
        window.matchMedia = originalMatchMedia
      }
    }
  })

  it('Details -> Semantic Index -> Escape closes only Semantic Index, then second Escape closes Details', async () => {
    const photos = [makePhoto(1)]
    installMockApi(photos)

    render(<PhotosPanel />)
    const cell = await waitFor(() => screen.getByRole('button', { name: /photo_1\.jpg/i }))
    cell.focus()
    fireEvent.click(cell)
    expect(screen.getByRole('heading', { name: /photograph details/i })).toBeInTheDocument()

    const semanticToggle = screen.getByTestId('photos-toggle-semantic-index')
    await act(async () => {
      fireEvent.click(semanticToggle)
    })
    expect(screen.getByRole('dialog', { name: /local semantic index/i })).toBeInTheDocument()

    // First Escape closes only Semantic Index
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: /local semantic index/i })
      ).not.toBeInTheDocument()
    })
    expect(screen.getByRole('heading', { name: /photograph details/i })).toBeInTheDocument()
    expect(cell).toHaveAttribute('aria-pressed', 'true')
    expect(document.activeElement).toBe(semanticToggle)

    // Second Escape closes Details and restores focus to photo cell
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: /photograph details/i })).not.toBeInTheDocument()
    })
    expect(document.activeElement).toBe(cell)
  })
})

describe('useFocusTrap visibility and resize-to-modal transitions', () => {
  function TrapHarness({ initialModal }: { initialModal: boolean }) {
    const [isOpen, setIsOpen] = useState(true)
    const [isModal, setIsModal] = useState(initialModal)
    const triggerRef = useRef<HTMLButtonElement>(null)
    const panelRef = useRef<HTMLDivElement>(null)

    useFocusTrap({
      isOpen,
      isModal,
      containerRef: panelRef,
      onClose: () => setIsOpen(false),
      restoreFocusTo: () => triggerRef.current
    })

    return (
      <div>
        <button ref={triggerRef} type="button" data-testid="trigger-btn">
          Trigger
        </button>
        <button type="button" onClick={() => setIsModal(true)} data-testid="make-modal-btn">
          Make Modal
        </button>
        {isOpen && (
          <div ref={panelRef} tabIndex={-1} data-testid="trap-panel">
            <button type="button" style={{ display: 'none' }} data-testid="hidden-display">
              Display None
            </button>
            <button type="button" style={{ visibility: 'hidden' }} data-testid="hidden-visibility">
              Visibility Hidden
            </button>
            <div inert>
              <button type="button" data-testid="hidden-inert">
                Inert Child
              </button>
            </div>
            <button type="button" data-testid="visible-first">
              First Visible
            </button>
            <button type="button" data-testid="visible-last">
              Last Visible
            </button>
          </div>
        )}
      </div>
    )
  }

  it('excludes hidden and inert elements without aria-hidden and traps Tab among visible controls', () => {
    render(<TrapHarness initialModal={true} />)

    const first = screen.getByTestId('visible-first')
    const last = screen.getByTestId('visible-last')
    expect(document.activeElement).toBe(first)

    last.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(first)

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
  })

  it('moves focus into an already-open panel when resized from non-modal to modal and restores on Escape', () => {
    render(<TrapHarness initialModal={false} />)

    const trigger = screen.getByTestId('trigger-btn')
    trigger.focus()
    expect(document.activeElement).toBe(trigger)

    fireEvent.click(screen.getByTestId('make-modal-btn'))
    const first = screen.getByTestId('visible-first')
    expect(document.activeElement).toBe(first)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('trap-panel')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(trigger)
  })
})
