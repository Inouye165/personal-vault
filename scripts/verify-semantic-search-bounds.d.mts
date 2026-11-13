export function assertSearchPerformanceAndResourceBounds(report: unknown): {
  rafSamples: number
  rafP95Ms: number
  diagSampleCount: number
  peakLiveWorkers: number
  peakTerminatingWorkers: number
  peakSearchLiveWorkers: number
  peakSearchTerminatingWorkers: number
  peakTotalAppLiveWorkers: number
  peakSearchPendingRequests: number
  peakQueuedJobs: number
  peakMainEventLoopDelayP95Ms: number
  peakMainEventLoopDelayMaxMs: number
  peakMountedCells: number
  peakMainRssBytes: number
}

export function assertConcurrentWorkloadOverlap(input: unknown): {
  sampleCount: number
  qualifyingSampleCount: number
  sharedIntervalStartMs: number
  sharedIntervalEndMs: number
  sharedOverlapDurationMs: number
  metadataJobId: string
  semanticJobId: string
  thumbnailCount: number
  deltaTotalDecodes: number
  deltaCacheMisses: number
  peakActiveSemanticTasks: number
  peakActiveMetadataTasks: number
  peakSearchActiveCalls: number
  peakLiveWorkers: number
  peakSearchLiveWorkers: number
  peakTotalAppLiveWorkers: number
}

export function assertLruEvictionAndReload(input: {
  afterTraversal: unknown
  afterReload: unknown
}): void
