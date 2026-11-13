import { describe, it, expect } from 'vitest'
import {
  assertSearchPerformanceAndResourceBounds,
  assertConcurrentWorkloadOverlap,
  assertLruEvictionAndReload
} from '../../scripts/verify-semantic-search-bounds.mjs'

function makeValidDiag(overrides: Record<string, unknown> = {}) {
  return {
    activeWorkers: 1,
    terminatingWorkers: 0,
    liveWorkers: 1,
    activeSemanticTasks: 0,
    activeMetadataTasks: 0,
    queuedJobs: 2,
    totalDecodes: 10,
    cacheHits: 2,
    cacheMisses: 8,
    mainEventLoopDelayP95Ms: 18.4,
    mainEventLoopDelayMaxMs: 24.2,
    mainProcessRssBytes: 320 * 1024 * 1024,
    searchActiveWorkers: 1,
    searchTerminatingWorkers: 0,
    searchLiveWorkers: 1,
    searchPendingRequests: 1,
    searchActiveCalls: 1,
    searchMaxPendingRequests: 16,
    totalAppLiveWorkers: 2,
    ...overrides
  }
}

describe('Stage 6E semantic search verification acceptance bounds (fail-closed)', () => {
  it('accepts valid continuous performance, worker, and main-loop samples', () => {
    const summary = assertSearchPerformanceAndResourceBounds({
      rafSamples: 60,
      rafP95Ms: 16.5,
      peakMountedCells: 18,
      diagSamples: [
        makeValidDiag({ liveWorkers: 1, totalAppLiveWorkers: 2 }),
        makeValidDiag({ liveWorkers: 2, totalAppLiveWorkers: 3, searchPendingRequests: 4 }),
        makeValidDiag({ liveWorkers: 1, totalAppLiveWorkers: 2, mainEventLoopDelayP95Ms: 22.1 })
      ]
    })

    expect(summary.rafSamples).toBe(60)
    expect(summary.rafP95Ms).toBe(16.5)
    expect(summary.peakLiveWorkers).toBe(2)
    expect(summary.peakTotalAppLiveWorkers).toBe(3)
    expect(summary.peakSearchPendingRequests).toBe(4)
  })

  it('rejects rafSamples=0 and empty diag={}', () => {
    expect(() =>
      assertSearchPerformanceAndResourceBounds({
        rafSamples: 0,
        rafP95Ms: 0,
        peakMountedCells: 12,
        diagSamples: [{}]
      })
    ).toThrow(/Insufficient rAF samples/)
  })

  it('rejects insufficient polled diagnostics samples (< 3) or missing required fields', () => {
    expect(() =>
      assertSearchPerformanceAndResourceBounds({
        rafSamples: 100,
        rafP95Ms: 12,
        peakMountedCells: 12,
        diagSamples: [makeValidDiag(), makeValidDiag()]
      })
    ).toThrow(/Insufficient polled diagnostics samples/)

    const missingSearchField = makeValidDiag()
    delete (missingSearchField as Record<string, unknown>).searchLiveWorkers
    expect(() =>
      assertSearchPerformanceAndResourceBounds({
        rafSamples: 100,
        rafP95Ms: 12,
        peakMountedCells: 12,
        diagSamples: [makeValidDiag(), missingSearchField, makeValidDiag()]
      })
    ).toThrow(/Missing or non-finite required metric 'diagSamples\[1\]\.searchLiveWorkers'/)
  })

  it('rejects excessive renderer frame latency (rafP95Ms=1000 or > 33ms)', () => {
    expect(() =>
      assertSearchPerformanceAndResourceBounds({
        rafSamples: 100,
        rafP95Ms: 1000,
        peakMountedCells: 12,
        diagSamples: [makeValidDiag(), makeValidDiag(), makeValidDiag()]
      })
    ).toThrow(/rAF p95 latency out of bounds/)

    expect(() =>
      assertSearchPerformanceAndResourceBounds({
        rafSamples: 100,
        rafP95Ms: 33.1,
        peakMountedCells: 12,
        diagSamples: [makeValidDiag(), makeValidDiag(), makeValidDiag()]
      })
    ).toThrow(/rAF p95 latency out of bounds/)
  })

  it('rejects excessive main-process event-loop p95 (>= 100ms) or max (>= 200ms)', () => {
    expect(() =>
      assertSearchPerformanceAndResourceBounds({
        rafSamples: 80,
        rafP95Ms: 16,
        peakMountedCells: 12,
        diagSamples: [
          makeValidDiag(),
          makeValidDiag({ mainEventLoopDelayP95Ms: 100 }),
          makeValidDiag()
        ]
      })
    ).toThrow(/mainEventLoopDelayP95Ms exceeded bound/)

    expect(() =>
      assertSearchPerformanceAndResourceBounds({
        rafSamples: 80,
        rafP95Ms: 16,
        peakMountedCells: 12,
        diagSamples: [
          makeValidDiag(),
          makeValidDiag({ mainEventLoopDelayMaxMs: 200 }),
          makeValidDiag()
        ]
      })
    ).toThrow(/mainEventLoopDelayMaxMs exceeded bound/)
  })

  it('rejects exceeded worker, queue, and mounted-cell bounds', () => {
    expect(() =>
      assertSearchPerformanceAndResourceBounds({
        rafSamples: 80,
        rafP95Ms: 16,
        peakMountedCells: 12,
        diagSamples: [makeValidDiag({ liveWorkers: 3 }), makeValidDiag(), makeValidDiag()]
      })
    ).toThrow(/Image liveWorkers exceeded bound/)

    expect(() =>
      assertSearchPerformanceAndResourceBounds({
        rafSamples: 80,
        rafP95Ms: 16,
        peakMountedCells: 12,
        diagSamples: [makeValidDiag({ searchLiveWorkers: 2 }), makeValidDiag(), makeValidDiag()]
      })
    ).toThrow(/Search liveWorkers exceeded bound/)

    expect(() =>
      assertSearchPerformanceAndResourceBounds({
        rafSamples: 80,
        rafP95Ms: 16,
        peakMountedCells: 12,
        diagSamples: [makeValidDiag({ totalAppLiveWorkers: 4 }), makeValidDiag(), makeValidDiag()]
      })
    ).toThrow(/totalAppLiveWorkers exceeded bound/)

    expect(() =>
      assertSearchPerformanceAndResourceBounds({
        rafSamples: 80,
        rafP95Ms: 16,
        peakMountedCells: 12,
        diagSamples: [
          makeValidDiag({ searchPendingRequests: 17 }),
          makeValidDiag(),
          makeValidDiag()
        ]
      })
    ).toThrow(/searchPendingRequests exceeded bound/)

    expect(() =>
      assertSearchPerformanceAndResourceBounds({
        rafSamples: 80,
        rafP95Ms: 16,
        peakMountedCells: 12,
        diagSamples: [makeValidDiag({ queuedJobs: 65 }), makeValidDiag(), makeValidDiag()]
      })
    ).toThrow(/Image queuedJobs exceeded bound/)

    expect(() =>
      assertSearchPerformanceAndResourceBounds({
        rafSamples: 80,
        rafP95Ms: 16,
        peakMountedCells: 201,
        diagSamples: [makeValidDiag(), makeValidDiag(), makeValidDiag()]
      })
    ).toThrow(/peakMountedCells out of bounds/)
  })

  it('proves concurrent workload overlap and rejects sequential or cached-only runs', () => {
    const valid = assertConcurrentWorkloadOverlap({
      deltaTotalDecodes: 4,
      deltaCacheMisses: 4,
      samples: [
        {
          metadataJobStatus: 'running',
          semanticJobStatus: 'running',
          diag: makeValidDiag({
            activeWorkers: 2,
            liveWorkers: 2,
            activeMetadataTasks: 1,
            activeSemanticTasks: 1,
            searchActiveCalls: 1,
            totalAppLiveWorkers: 3
          })
        },
        {
          metadataJobStatus: 'completed',
          semanticJobStatus: 'completed',
          diag: makeValidDiag({
            activeWorkers: 0,
            liveWorkers: 1,
            activeMetadataTasks: 0,
            activeSemanticTasks: 0,
            searchActiveCalls: 0,
            totalAppLiveWorkers: 2
          })
        }
      ]
    })
    expect(valid.peakTotalAppLiveWorkers).toBe(3)

    // Rejects cached-only thumbnail reuse (0 cache misses)
    expect(() =>
      assertConcurrentWorkloadOverlap({
        deltaTotalDecodes: 1,
        deltaCacheMisses: 0,
        samples: [
          {
            metadataJobStatus: 'running',
            semanticJobStatus: 'running',
            diag: makeValidDiag({
              activeWorkers: 2,
              liveWorkers: 2,
              activeMetadataTasks: 1,
              activeSemanticTasks: 1,
              searchActiveCalls: 1,
              totalAppLiveWorkers: 3
            })
          },
          {
            metadataJobStatus: 'completed',
            semanticJobStatus: 'completed',
            diag: makeValidDiag({ searchActiveCalls: 0 })
          }
        ]
      })
    ).toThrow(/actual uncached thumbnail decodes/)

    // Rejects non-overlapping sequential execution
    expect(() =>
      assertConcurrentWorkloadOverlap({
        deltaTotalDecodes: 2,
        deltaCacheMisses: 2,
        samples: [
          {
            metadataJobStatus: 'running',
            semanticJobStatus: 'running',
            diag: makeValidDiag({
              activeWorkers: 2,
              liveWorkers: 2,
              activeMetadataTasks: 1,
              activeSemanticTasks: 1,
              searchActiveCalls: 0,
              totalAppLiveWorkers: 2
            })
          },
          {
            metadataJobStatus: 'completed',
            semanticJobStatus: 'completed',
            diag: makeValidDiag({
              activeWorkers: 0,
              liveWorkers: 0,
              activeMetadataTasks: 0,
              activeSemanticTasks: 0,
              searchActiveCalls: 1,
              totalAppLiveWorkers: 1
            })
          }
        ]
      })
    ).toThrow(/Never observed simultaneous active search and active image-worker execution/)
  })

  it('proves 40-page LRU eviction and Page 0 reload while rejecting unevicted or wiped scores', () => {
    const pagesAfterTraversal = Array.from({ length: 40 }, (_, i) => i + 5) // 5..44 (0 evicted)
    const pagesAfterReload = [0, ...Array.from({ length: 39 }, (_, i) => i + 6)] // 0, 6..44

    expect(() =>
      assertLruEvictionAndReload({
        afterTraversal: {
          distinctPagesObserved: 45,
          cachedPageCount: 40,
          cachedPages: pagesAfterTraversal,
          retainedSamplePage: 44,
          searchScoreCount: 2000
        },
        afterReload: {
          cachedPageCount: 40,
          cachedPages: pagesAfterReload,
          searchScoreCount: 2000,
          mountedCells: 18
        }
      })
    ).not.toThrow()

    // Rejects when Page 0 was never evicted
    expect(() =>
      assertLruEvictionAndReload({
        afterTraversal: {
          distinctPagesObserved: 45,
          cachedPageCount: 40,
          cachedPages: [0, ...Array.from({ length: 39 }, (_, i) => i + 1)],
          retainedSamplePage: 39,
          searchScoreCount: 2000
        },
        afterReload: {
          cachedPageCount: 40,
          cachedPages: [0, ...Array.from({ length: 39 }, (_, i) => i + 1)],
          searchScoreCount: 2000,
          mountedCells: 18
        }
      })
    ).toThrow(/Expected Page 0 to be evicted/)

    // Rejects when reloading Page 0 wiped scores for other retained pages
    expect(() =>
      assertLruEvictionAndReload({
        afterTraversal: {
          distinctPagesObserved: 45,
          cachedPageCount: 40,
          cachedPages: pagesAfterTraversal,
          retainedSamplePage: 44,
          searchScoreCount: 2000
        },
        afterReload: {
          cachedPageCount: 40,
          cachedPages: pagesAfterReload,
          searchScoreCount: 50,
          mountedCells: 18
        }
      })
    ).toThrow(/failed to preserve searchScores for retained pages/)
  })
})
