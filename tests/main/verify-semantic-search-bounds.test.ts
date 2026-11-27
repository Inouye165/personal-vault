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

  it('proves correlated four-workflow overlap and rejects sequential, pairwise-only, cached-only, or incomplete traces', () => {
    const validWorkflows = {
      thumbnails: {
        locationIds: [101, 102, 103, 104],
        startedAtMs: 1000,
        endedAtMs: 1320,
        completed: true,
        deltaTotalDecodes: 4,
        deltaCacheMisses: 4
      },
      metadata: {
        jobId: 11,
        startedAtMs: 1010,
        endedAtMs: 1450,
        completed: true,
        processedCount: 4
      },
      semanticIndex: {
        jobId: 22,
        startedAtMs: 1020,
        endedAtMs: 1520,
        completed: true,
        processedCount: 4
      },
      search: {
        queryText: 'sunlit forest path',
        startedAtMs: 1030,
        endedAtMs: 1290,
        completed: true,
        resultCount: 12
      }
    }

    const valid = assertConcurrentWorkloadOverlap({
      deltaTotalDecodes: 4,
      deltaCacheMisses: 4,
      workflows: validWorkflows,
      samples: [
        {
          timestampMs: 1120,
          thumbnailsInFlight: 2,
          metadataJobId: 11,
          metadataJobStatus: 'running',
          semanticJobId: 22,
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
          timestampMs: 1540,
          thumbnailsInFlight: 0,
          metadataJobId: 11,
          metadataJobStatus: 'completed',
          semanticJobId: 22,
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
    expect(valid.sharedOverlapDurationMs).toBe(260)
    expect(valid.qualifyingSampleCount).toBe(1)

    // Rejects the exact 3-sample sequential sequence reproduced in review
    expect(() =>
      assertConcurrentWorkloadOverlap({
        deltaTotalDecodes: 4,
        deltaCacheMisses: 4,
        workflows: {
          thumbnails: {
            locationIds: [101, 102, 103, 104],
            startedAtMs: 1000,
            endedAtMs: 1150,
            completed: true,
            deltaTotalDecodes: 4,
            deltaCacheMisses: 4
          },
          semanticIndex: {
            jobId: 22,
            startedAtMs: 1100,
            endedAtMs: 1250,
            completed: true,
            processedCount: 4
          },
          metadata: {
            jobId: 11,
            startedAtMs: 1260,
            endedAtMs: 1400,
            completed: true,
            processedCount: 4
          },
          search: {
            queryText: 'sunlit forest path',
            startedAtMs: 1410,
            endedAtMs: 1550,
            completed: true,
            resultCount: 12
          }
        },
        samples: [
          {
            timestampMs: 1120,
            thumbnailsInFlight: 1,
            metadataJobId: 11,
            metadataJobStatus: 'pending',
            semanticJobId: 22,
            semanticJobStatus: 'running',
            diag: makeValidDiag({
              activeSemanticTasks: 1,
              activeMetadataTasks: 0,
              searchActiveCalls: 0
            })
          },
          {
            timestampMs: 1300,
            thumbnailsInFlight: 0,
            metadataJobId: 11,
            metadataJobStatus: 'running',
            semanticJobId: 22,
            semanticJobStatus: 'completed',
            diag: makeValidDiag({
              activeSemanticTasks: 0,
              activeMetadataTasks: 1,
              searchActiveCalls: 0
            })
          },
          {
            timestampMs: 1450,
            thumbnailsInFlight: 0,
            metadataJobId: 11,
            metadataJobStatus: 'completed',
            semanticJobId: 22,
            semanticJobStatus: 'completed',
            diag: makeValidDiag({
              activeSemanticTasks: 0,
              activeMetadataTasks: 0,
              searchActiveCalls: 1,
              activeWorkers: 1
            })
          }
        ]
      })
    ).toThrow(/No shared four-workflow overlap interval/)

    // Rejects pairwise overlaps with no shared four-workflow interval
    expect(() =>
      assertConcurrentWorkloadOverlap({
        deltaTotalDecodes: 4,
        deltaCacheMisses: 4,
        workflows: {
          thumbnails: {
            locationIds: [101, 102, 103, 104],
            startedAtMs: 1000,
            endedAtMs: 1200,
            completed: true,
            deltaTotalDecodes: 4,
            deltaCacheMisses: 4
          },
          semanticIndex: {
            jobId: 22,
            startedAtMs: 1050,
            endedAtMs: 1300,
            completed: true,
            processedCount: 4
          },
          metadata: {
            jobId: 11,
            startedAtMs: 1250,
            endedAtMs: 1500,
            completed: true,
            processedCount: 4
          },
          search: {
            queryText: 'sunlit forest path',
            startedAtMs: 1260,
            endedAtMs: 1450,
            completed: true,
            resultCount: 12
          }
        },
        samples: [
          {
            timestampMs: 1100,
            thumbnailsInFlight: 2,
            metadataJobId: 11,
            metadataJobStatus: 'pending',
            semanticJobId: 22,
            semanticJobStatus: 'running',
            diag: makeValidDiag({
              activeSemanticTasks: 1,
              activeMetadataTasks: 0,
              searchActiveCalls: 0
            })
          },
          {
            timestampMs: 1350,
            thumbnailsInFlight: 0,
            metadataJobId: 11,
            metadataJobStatus: 'running',
            semanticJobId: 22,
            semanticJobStatus: 'completed',
            diag: makeValidDiag({
              activeSemanticTasks: 0,
              activeMetadataTasks: 1,
              searchActiveCalls: 1
            })
          }
        ]
      })
    ).toThrow(/No shared four-workflow overlap interval/)

    // Rejects cached-only thumbnail reuse (0 cache misses)
    expect(() =>
      assertConcurrentWorkloadOverlap({
        deltaTotalDecodes: 1,
        deltaCacheMisses: 0,
        workflows: {
          ...validWorkflows,
          thumbnails: {
            ...validWorkflows.thumbnails,
            deltaTotalDecodes: 1,
            deltaCacheMisses: 0
          }
        },
        samples: [
          {
            timestampMs: 1120,
            thumbnailsInFlight: 2,
            metadataJobId: 11,
            metadataJobStatus: 'running',
            semanticJobId: 22,
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
            timestampMs: 1540,
            thumbnailsInFlight: 0,
            metadataJobId: 11,
            metadataJobStatus: 'completed',
            semanticJobId: 22,
            semanticJobStatus: 'completed',
            diag: makeValidDiag({ searchActiveCalls: 0 })
          }
        ]
      })
    ).toThrow(/actual uncached thumbnail decodes/)

    // Rejects missing lifecycle evidence
    expect(() =>
      assertConcurrentWorkloadOverlap({
        deltaTotalDecodes: 4,
        deltaCacheMisses: 4,
        workflows: {
          ...validWorkflows,
          metadata: {
            jobId: 11,
            startedAtMs: 1010,
            endedAtMs: 1450,
            completed: false,
            processedCount: 4
          }
        },
        samples: [
          {
            timestampMs: 1120,
            thumbnailsInFlight: 2,
            metadataJobId: 11,
            metadataJobStatus: 'running',
            semanticJobId: 22,
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
            timestampMs: 1540,
            thumbnailsInFlight: 0,
            metadataJobId: 11,
            metadataJobStatus: 'completed',
            semanticJobId: 22,
            semanticJobStatus: 'completed',
            diag: makeValidDiag({ searchActiveCalls: 0 })
          }
        ]
      })
    ).toThrow(/metadata.*completed/i)

    // Rejects overlapping timestamps when no polled sample observes all 4 in flight
    expect(() =>
      assertConcurrentWorkloadOverlap({
        deltaTotalDecodes: 4,
        deltaCacheMisses: 4,
        workflows: validWorkflows,
        samples: [
          {
            timestampMs: 1120,
            thumbnailsInFlight: 0,
            metadataJobId: 11,
            metadataJobStatus: 'running',
            semanticJobId: 22,
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
            timestampMs: 1540,
            thumbnailsInFlight: 0,
            metadataJobId: 11,
            metadataJobStatus: 'completed',
            semanticJobId: 22,
            semanticJobStatus: 'completed',
            diag: makeValidDiag({ searchActiveCalls: 0 })
          }
        ]
      })
    ).toThrow(/No polled sample observed all four workflows simultaneously in flight/)
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
