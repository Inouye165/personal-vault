import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PhotosPanel } from '../../src/renderer/src/components/PhotosPanel'
import { PhotoSelectedOcrSection } from '../../src/renderer/src/components/PhotoSelectedOcrSection'
import type { VaultApi } from '../../src/preload/index.d'
import type { PhotoItem, SemanticSearchResponse } from '../../src/shared/validation/ipc-schemas'

function makePhoto(id: number, fileName = `photo_${id}.jpg`): PhotoItem {
  return {
    id,
    sourceId: 1,
    originalPath: `D:\\Fixtures\\${fileName}`,
    fileName,
    extension: '.jpg',
    category: 'photo',
    discoveryObservationId: id,
    byteSize: 1024 * 1024,
    filesystemBirthtimeMs: 1700000000000,
    filesystemMtimeMs: 1700000000000,
    inferredCaptureTimeMs: 1700000000000,
    firstDiscoveredAtMs: 1700000000000,
    lastSeenAtMs: 1700000000000,
    activeHash: 'b'.repeat(64),
    activeHashVerifiedAtMs: 1700000000000,
    rating: null,
    flag: 'none',
    annotationVersion: 0
  }
}

function makeSearchResponse(
  ranked: Array<{ photo: PhotoItem; score: number }>
): SemanticSearchResponse {
  return {
    items: ranked.map((entry, idx) => ({
      photo: entry.photo,
      score: entry.score,
      rank: idx + 1
    })),
    totalMatched: ranked.length,
    eligibleCount: 26,
    unindexedCount: 0,
    staleCount: 0,
    corruptCount: 0,
    offset: 0,
    limit: 50,
    hasMore: false,
    queryLatencyMs: 42,
    truncated: false,
    tokenCount: 2,
    modelStatus: 'ready'
  }
}

describe('Photos search results hierarchy and Copy text UX', () => {
  let photos: PhotoItem[]

  beforeEach(() => {
    vi.restoreAllMocks()
    photos = [
      makePhoto(1, 'employee_schedule.jpg'),
      makePhoto(2, 'schedule_screenshot.jpg'),
      makePhoto(3, 'weekend_dog.jpg'),
      makePhoto(4, 'living_room.jpg'),
      makePhoto(5, 'family_dinner.jpg')
    ]

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
      getPhotoMetadataFacets: vi.fn(async () => ({ years: [], cameras: [] })),
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
        totalPhotos: 5,
        processedPhotos: 5,
        reusedPhotos: 0,
        unsupportedPhotos: 0,
        failedPhotos: 0,
        pendingPhotos: 0,
        totalCatalogPhotos: 5,
        currentIndexedPhotos: 5,
        startedAtMs: null,
        updatedAtMs: 1700000000000,
        completedAtMs: null,
        lastError: null
      })),
      onSemanticModelStatus: vi.fn(() => () => {}),
      onSemanticIndexProgress: vi.fn(() => () => {}),
      searchPhotosSemantic: vi.fn(async ({ queryText }: { queryText: string }) => {
        if (queryText === 'two only') {
          return makeSearchResponse([
            { photo: photos[0]!, score: 0.312 },
            { photo: photos[1]!, score: 0.264 }
          ])
        }
        return makeSearchResponse([
          { photo: photos[0]!, score: 0.312 },
          { photo: photos[1]!, score: 0.264 },
          { photo: photos[2]!, score: 0.221 },
          { photo: photos[3]!, score: 0.215 },
          { photo: photos[4]!, score: 0.205 }
        ])
      }),
      cancelPhotosSemanticSearch: vi.fn(async () => ({ cancelled: true }))
    } as unknown as VaultApi
  })

  afterEach(() => {
    Reflect.deleteProperty(window, 'api')
  })

  it('leads with prominent Top results, moves raw score into details, and expands Show other results', async () => {
    await act(async () => {
      render(<PhotosPanel />)
    })

    const searchInput = await screen.findByPlaceholderText(/search photos by description/i)
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: 'employee schedule' } })
      fireEvent.submit(searchInput.closest('form')!)
    })

    const topSection = await screen.findByTestId('photos-top-results')
    expect(topSection).toHaveTextContent(/top results/i)
    expect(within(topSection).getByText('employee_schedule.jpg')).toBeInTheDocument()
    expect(within(topSection).getByText('schedule_screenshot.jpg')).toBeInTheDocument()

    // Raw "% match" overlay must not clutter thumbnail cards in the main results view
    expect(document.querySelector('.badge-similarity-score')).toBeNull()
    expect(screen.queryByText(/31% match/i)).not.toBeInTheDocument()

    // Remaining 3 results are behind the disclosure toggle initially
    const toggleBtn = screen.getByTestId('photos-toggle-other-results-btn')
    expect(toggleBtn).toHaveAttribute('aria-expanded', 'false')
    expect(toggleBtn).toHaveTextContent(/show other results \(3\)/i)
    expect(screen.queryByText('weekend_dog.jpg')).not.toBeInTheDocument()

    // Clicking the toggle reveals the remaining results without duplicating top 2
    await act(async () => {
      fireEvent.click(toggleBtn)
    })

    expect(toggleBtn).toHaveAttribute('aria-expanded', 'true')
    expect(toggleBtn).toHaveTextContent(/hide other results/i)
    expect(await screen.findByText('weekend_dog.jpg')).toBeInTheDocument()
    expect(screen.getByText('living_room.jpg')).toBeInTheDocument()
    expect(screen.getByText('family_dinner.jpg')).toBeInTheDocument()

    // Selecting a result photo surfaces raw similarity score honestly inside Details
    const firstCard = within(topSection)
      .getByText('employee_schedule.jpg')
      .closest('[role="button"]')!
    await act(async () => {
      fireEvent.click(firstCard)
    })

    const scoreDetail = await screen.findByTestId('photo-search-similarity-detail')
    expect(scoreDetail).toHaveTextContent('0.312')
    expect(scoreDetail).toHaveTextContent(/not a probability/i)

    // Changing query resets "Other results" back to collapsed, and hides toggle when <= 2 results
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: 'two only' } })
      fireEvent.submit(searchInput.closest('form')!)
    })

    await waitFor(() => {
      expect(screen.queryByTestId('photos-toggle-other-results-btn')).not.toBeInTheDocument()
    })
  })

  it('shows Copy text in PhotoSelectedOcrSection only when extracted text and clipboard writeText exist', async () => {
    const writeTextMock = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: writeTextMock }
    })

    window.api = {
      ...window.api,
      getOcrModelStatus: vi.fn(async () => ({
        state: 'ready' as const,
        modelId: 'tesseract-eng',
        language: 'eng',
        requiredBytes: 1000,
        downloadedBytes: 1000,
        verifiedAtMs: 1700000000000,
        error: null,
        activeDir: 'C:\\ocr',
        lastReplacementError: null
      })),
      getDocumentOcrProgress: vi.fn(async () => ({
        jobId: null,
        status: 'idle' as const,
        totalDocuments: 0,
        processedDocuments: 0,
        succeededDocuments: 0,
        failedDocuments: 0,
        skippedDocuments: 0,
        startedAtMs: null,
        updatedAtMs: Date.now(),
        completedAtMs: null,
        lastError: null
      })),
      getDocumentOcrState: vi.fn(async () => ({
        state: {
          fileLocationId: 1,
          ocrStatus: 'extracted' as const,
          ocrModelId: 'tesseract-eng',
          ocrLanguage: 'eng',
          updatedAtMs: 1700000000000,
          statusDetail: null
        }
      })),
      getDocumentOcrPreview: vi.fn(async () => ({
        preview: {
          fileLocationId: 1,
          ocrStatus: 'extracted' as const,
          extractedText: 'Mon 9:00 AM - 5:00 PM',
          statusDetail: null
        }
      })),
      onOcrModelStatus: vi.fn(() => () => {}),
      onDocumentOcrProgress: vi.fn(() => () => {}),
      ocrSelectedDocuments: vi.fn()
    } as unknown as VaultApi

    await act(async () => {
      render(<PhotoSelectedOcrSection fileLocationId={1} extension=".jpg" />)
    })

    const copyBtn = await screen.findByTestId('copy-extracted-text-btn')
    expect(copyBtn).toHaveTextContent(/copy text/i)

    await act(async () => {
      fireEvent.click(copyBtn)
    })

    expect(writeTextMock).toHaveBeenCalledWith('Mon 9:00 AM - 5:00 PM')
  })
})
