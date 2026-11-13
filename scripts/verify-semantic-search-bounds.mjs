/**
 * Fail-closed performance, resource, concurrency-overlap, and LRU eviction
 * acceptance guards for Stage 6E real-Electron semantic search verification.
 */

const REQUIRED_DIAG_NUMERIC_FIELDS = [
  'activeWorkers',
  'terminatingWorkers',
  'liveWorkers',
  'queuedJobs',
  'searchActiveWorkers',
  'searchTerminatingWorkers',
  'searchLiveWorkers',
  'searchPendingRequests',
  'searchActiveCalls',
  'searchMaxPendingRequests',
  'totalAppLiveWorkers',
  'mainEventLoopDelayP95Ms',
  'mainEventLoopDelayMaxMs',
  'mainProcessRssBytes'
]

export const SEARCH_ACCEPTANCE_BOUNDS = {
  minRafSamples: 30,
  maxRafP95Ms: 33,
  minDiagSamples: 3,
  maxLiveImageWorkers: 2,
  maxLiveSearchWorkers: 1,
  maxTotalAppLiveWorkers: 3,
  maxImageQueuedJobs: 64,
  expectedSearchMaxPendingRequests: 16,
  maxMainEventLoopDelayP95Ms: 100, // strictly < 100 ms
  maxMainEventLoopDelayMaxMs: 200, // strictly < 200 ms
  maxMountedCells: 200,
  expectedLruMaxPages: 40,
  expectedPageSize: 50
}

function assertFiniteNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Missing or non-finite required metric '${label}': ${String(value)}`)
  }
  return value
}

export function validateDiagnosticsSnapshot(diag, context = 'diag') {
  if (!diag || typeof diag !== 'object') {
    throw new Error(`Missing diagnostics object (${context})`)
  }
  const validated = {}
  for (const field of REQUIRED_DIAG_NUMERIC_FIELDS) {
    const val = assertFiniteNumber(diag[field], `${context}.${field}`)
    if (val < 0) {
      throw new Error(`Negative diagnostics metric '${context}.${field}': ${val}`)
    }
    validated[field] = val
  }
  if (validated.mainProcessRssBytes <= 0) {
    throw new Error(`Expected positive mainProcessRssBytes, got ${validated.mainProcessRssBytes}`)
  }
  if (
    validated.searchMaxPendingRequests !== SEARCH_ACCEPTANCE_BOUNDS.expectedSearchMaxPendingRequests
  ) {
    throw new Error(
      `Expected searchMaxPendingRequests=${SEARCH_ACCEPTANCE_BOUNDS.expectedSearchMaxPendingRequests}, got ${validated.searchMaxPendingRequests}`
    )
  }
  if (validated.liveWorkers > SEARCH_ACCEPTANCE_BOUNDS.maxLiveImageWorkers) {
    throw new Error(
      `Image liveWorkers exceeded bound (${validated.liveWorkers} > ${SEARCH_ACCEPTANCE_BOUNDS.maxLiveImageWorkers}) in ${context}`
    )
  }
  if (validated.terminatingWorkers > SEARCH_ACCEPTANCE_BOUNDS.maxLiveImageWorkers) {
    throw new Error(
      `Image terminatingWorkers exceeded bound (${validated.terminatingWorkers} > ${SEARCH_ACCEPTANCE_BOUNDS.maxLiveImageWorkers}) in ${context}`
    )
  }
  if (validated.queuedJobs > SEARCH_ACCEPTANCE_BOUNDS.maxImageQueuedJobs) {
    throw new Error(
      `Image queuedJobs exceeded bound (${validated.queuedJobs} > ${SEARCH_ACCEPTANCE_BOUNDS.maxImageQueuedJobs}) in ${context}`
    )
  }
  if (validated.searchLiveWorkers > SEARCH_ACCEPTANCE_BOUNDS.maxLiveSearchWorkers) {
    throw new Error(
      `Search liveWorkers exceeded bound (${validated.searchLiveWorkers} > ${SEARCH_ACCEPTANCE_BOUNDS.maxLiveSearchWorkers}) in ${context}`
    )
  }
  if (validated.searchTerminatingWorkers > SEARCH_ACCEPTANCE_BOUNDS.maxLiveSearchWorkers) {
    throw new Error(
      `Search terminatingWorkers exceeded bound (${validated.searchTerminatingWorkers} > ${SEARCH_ACCEPTANCE_BOUNDS.maxLiveSearchWorkers}) in ${context}`
    )
  }
  if (validated.searchPendingRequests > SEARCH_ACCEPTANCE_BOUNDS.expectedSearchMaxPendingRequests) {
    throw new Error(
      `searchPendingRequests exceeded bound (${validated.searchPendingRequests} > ${SEARCH_ACCEPTANCE_BOUNDS.expectedSearchMaxPendingRequests}) in ${context}`
    )
  }
  if (validated.totalAppLiveWorkers > SEARCH_ACCEPTANCE_BOUNDS.maxTotalAppLiveWorkers) {
    throw new Error(
      `totalAppLiveWorkers exceeded bound (${validated.totalAppLiveWorkers} > ${SEARCH_ACCEPTANCE_BOUNDS.maxTotalAppLiveWorkers}) in ${context}`
    )
  }
  if (validated.mainEventLoopDelayP95Ms >= SEARCH_ACCEPTANCE_BOUNDS.maxMainEventLoopDelayP95Ms) {
    throw new Error(
      `mainEventLoopDelayP95Ms exceeded bound (${validated.mainEventLoopDelayP95Ms}ms >= ${SEARCH_ACCEPTANCE_BOUNDS.maxMainEventLoopDelayP95Ms}ms) in ${context}`
    )
  }
  if (validated.mainEventLoopDelayMaxMs >= SEARCH_ACCEPTANCE_BOUNDS.maxMainEventLoopDelayMaxMs) {
    throw new Error(
      `mainEventLoopDelayMaxMs exceeded bound (${validated.mainEventLoopDelayMaxMs}ms >= ${SEARCH_ACCEPTANCE_BOUNDS.maxMainEventLoopDelayMaxMs}ms) in ${context}`
    )
  }
  return validated
}

export function assertSearchPerformanceAndResourceBounds(report) {
  if (!report || typeof report !== 'object') {
    throw new Error('Missing performance/resource report')
  }

  const rafSamples = assertFiniteNumber(report.rafSamples, 'rafSamples')
  if (!Number.isInteger(rafSamples) || rafSamples < SEARCH_ACCEPTANCE_BOUNDS.minRafSamples) {
    throw new Error(
      `Insufficient rAF samples (${rafSamples} < ${SEARCH_ACCEPTANCE_BOUNDS.minRafSamples})`
    )
  }

  const rafP95Ms = assertFiniteNumber(report.rafP95Ms, 'rafP95Ms')
  if (rafP95Ms <= 0 || rafP95Ms > SEARCH_ACCEPTANCE_BOUNDS.maxRafP95Ms) {
    throw new Error(
      `Renderer rAF p95 latency out of bounds (${rafP95Ms}ms; expected > 0 and <= ${SEARCH_ACCEPTANCE_BOUNDS.maxRafP95Ms}ms)`
    )
  }

  const peakMountedCells = assertFiniteNumber(report.peakMountedCells, 'peakMountedCells')
  if (
    !Number.isInteger(peakMountedCells) ||
    peakMountedCells <= 0 ||
    peakMountedCells > SEARCH_ACCEPTANCE_BOUNDS.maxMountedCells
  ) {
    throw new Error(
      `peakMountedCells out of bounds (${peakMountedCells}; expected 1..${SEARCH_ACCEPTANCE_BOUNDS.maxMountedCells})`
    )
  }

  if (
    !Array.isArray(report.diagSamples) ||
    report.diagSamples.length < SEARCH_ACCEPTANCE_BOUNDS.minDiagSamples
  ) {
    throw new Error(
      `Insufficient polled diagnostics samples (${Array.isArray(report.diagSamples) ? report.diagSamples.length : 0} < ${SEARCH_ACCEPTANCE_BOUNDS.minDiagSamples})`
    )
  }

  let peakLiveWorkers = 0
  let peakTerminatingWorkers = 0
  let peakSearchLiveWorkers = 0
  let peakSearchTerminatingWorkers = 0
  let peakTotalAppLiveWorkers = 0
  let peakSearchPendingRequests = 0
  let peakQueuedJobs = 0
  let peakMainEventLoopDelayP95Ms = 0
  let peakMainEventLoopDelayMaxMs = 0
  let peakMainRssBytes = 0

  for (let i = 0; i < report.diagSamples.length; i++) {
    const d = validateDiagnosticsSnapshot(report.diagSamples[i], `diagSamples[${i}]`)
    peakLiveWorkers = Math.max(peakLiveWorkers, d.liveWorkers)
    peakTerminatingWorkers = Math.max(peakTerminatingWorkers, d.terminatingWorkers)
    peakSearchLiveWorkers = Math.max(peakSearchLiveWorkers, d.searchLiveWorkers)
    peakSearchTerminatingWorkers = Math.max(
      peakSearchTerminatingWorkers,
      d.searchTerminatingWorkers
    )
    peakTotalAppLiveWorkers = Math.max(peakTotalAppLiveWorkers, d.totalAppLiveWorkers)
    peakSearchPendingRequests = Math.max(peakSearchPendingRequests, d.searchPendingRequests)
    peakQueuedJobs = Math.max(peakQueuedJobs, d.queuedJobs)
    peakMainEventLoopDelayP95Ms = Math.max(peakMainEventLoopDelayP95Ms, d.mainEventLoopDelayP95Ms)
    peakMainEventLoopDelayMaxMs = Math.max(peakMainEventLoopDelayMaxMs, d.mainEventLoopDelayMaxMs)
    peakMainRssBytes = Math.max(peakMainRssBytes, d.mainProcessRssBytes)
  }

  return {
    rafSamples,
    rafP95Ms,
    diagSampleCount: report.diagSamples.length,
    peakLiveWorkers,
    peakTerminatingWorkers,
    peakSearchLiveWorkers,
    peakSearchTerminatingWorkers,
    peakTotalAppLiveWorkers,
    peakSearchPendingRequests,
    peakQueuedJobs,
    peakMainEventLoopDelayP95Ms,
    peakMainEventLoopDelayMaxMs,
    peakMountedCells,
    peakMainRssBytes
  }
}

export function assertConcurrentWorkloadOverlap(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('Missing concurrent workload overlap input')
  }
  const { samples, deltaTotalDecodes, deltaCacheMisses } = input
  assertFiniteNumber(deltaTotalDecodes, 'deltaTotalDecodes')
  assertFiniteNumber(deltaCacheMisses, 'deltaCacheMisses')
  if (deltaTotalDecodes < 1 || deltaCacheMisses < 1) {
    throw new Error(
      `Expected actual uncached thumbnail decodes during overlap test (deltaTotalDecodes=${deltaTotalDecodes}, deltaCacheMisses=${deltaCacheMisses})`
    )
  }
  if (!Array.isArray(samples) || samples.length < 2) {
    throw new Error(
      `Insufficient overlap polling samples (${Array.isArray(samples) ? samples.length : 0})`
    )
  }

  let peakActiveSemanticTasks = 0
  let peakActiveMetadataTasks = 0
  let peakSearchActiveCalls = 0
  let peakLiveWorkers = 0
  let peakSearchLiveWorkers = 0
  let peakTotalAppLiveWorkers = 0
  let sawMetadataRunning = false
  let sawSemanticRunning = false
  let sawSearchWithImageWorkerOverlap = false

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]
    const d = validateDiagnosticsSnapshot(s?.diag, `overlapSamples[${i}].diag`)
    const activeSemanticTasks = assertFiniteNumber(
      s.diag.activeSemanticTasks,
      `overlapSamples[${i}].diag.activeSemanticTasks`
    )
    const activeMetadataTasks = assertFiniteNumber(
      s.diag.activeMetadataTasks,
      `overlapSamples[${i}].diag.activeMetadataTasks`
    )

    peakActiveSemanticTasks = Math.max(peakActiveSemanticTasks, activeSemanticTasks)
    peakActiveMetadataTasks = Math.max(peakActiveMetadataTasks, activeMetadataTasks)
    peakSearchActiveCalls = Math.max(peakSearchActiveCalls, d.searchActiveCalls)
    peakLiveWorkers = Math.max(peakLiveWorkers, d.liveWorkers)
    peakSearchLiveWorkers = Math.max(peakSearchLiveWorkers, d.searchLiveWorkers)
    peakTotalAppLiveWorkers = Math.max(peakTotalAppLiveWorkers, d.totalAppLiveWorkers)

    if (s.metadataJobStatus === 'running') sawMetadataRunning = true
    if (s.semanticJobStatus === 'running') sawSemanticRunning = true

    if (
      d.searchActiveCalls >= 1 &&
      (activeSemanticTasks >= 1 || activeMetadataTasks >= 1 || d.activeWorkers >= 1)
    ) {
      sawSearchWithImageWorkerOverlap = true
    }
  }

  if (peakActiveSemanticTasks < 1 || !sawSemanticRunning) {
    throw new Error(
      `Semantic indexing work was not observed active during overlap window (peakActiveSemanticTasks=${peakActiveSemanticTasks}, sawSemanticRunning=${sawSemanticRunning})`
    )
  }
  if (peakActiveMetadataTasks < 1 || !sawMetadataRunning) {
    throw new Error(
      `Metadata extraction work was not observed active during overlap window (peakActiveMetadataTasks=${peakActiveMetadataTasks}, sawMetadataRunning=${sawMetadataRunning})`
    )
  }
  if (peakSearchActiveCalls < 1) {
    throw new Error(
      `Semantic search call was never observed active (peakSearchActiveCalls=${peakSearchActiveCalls})`
    )
  }
  if (!sawSearchWithImageWorkerOverlap) {
    throw new Error(
      'Never observed simultaneous active search and active image-worker execution in any diagnostic poll'
    )
  }

  return {
    sampleCount: samples.length,
    deltaTotalDecodes,
    deltaCacheMisses,
    peakActiveSemanticTasks,
    peakActiveMetadataTasks,
    peakSearchActiveCalls,
    peakLiveWorkers,
    peakSearchLiveWorkers,
    peakTotalAppLiveWorkers
  }
}

export function assertLruEvictionAndReload({ afterTraversal, afterReload }) {
  if (!afterTraversal || !afterReload) {
    throw new Error('Missing afterTraversal or afterReload LRU state')
  }
  const distinctPagesObserved = assertFiniteNumber(
    afterTraversal.distinctPagesObserved,
    'afterTraversal.distinctPagesObserved'
  )
  if (distinctPagesObserved <= SEARCH_ACCEPTANCE_BOUNDS.expectedLruMaxPages) {
    throw new Error(
      `Insufficient distinct completed pages observed (${distinctPagesObserved} <= ${SEARCH_ACCEPTANCE_BOUNDS.expectedLruMaxPages}); eviction not proven`
    )
  }

  if (afterTraversal.cachedPageCount !== SEARCH_ACCEPTANCE_BOUNDS.expectedLruMaxPages) {
    throw new Error(
      `Expected LRU cache occupancy=${SEARCH_ACCEPTANCE_BOUNDS.expectedLruMaxPages} after traversal, got ${afterTraversal.cachedPageCount}`
    )
  }
  if (!Array.isArray(afterTraversal.cachedPages) || afterTraversal.cachedPages.includes(0)) {
    throw new Error(
      `Expected Page 0 to be evicted from 40-page LRU cache, but cachedPages=${JSON.stringify(afterTraversal.cachedPages)}`
    )
  }
  const retainedSamplePage = assertFiniteNumber(
    afterTraversal.retainedSamplePage,
    'afterTraversal.retainedSamplePage'
  )
  if (retainedSamplePage <= 0 || !afterTraversal.cachedPages.includes(retainedSamplePage)) {
    throw new Error(
      `Expected retained sample page ${retainedSamplePage} in cachedPages after traversal`
    )
  }
  const expectedScores =
    SEARCH_ACCEPTANCE_BOUNDS.expectedLruMaxPages * SEARCH_ACCEPTANCE_BOUNDS.expectedPageSize
  if (afterTraversal.searchScoreCount !== expectedScores) {
    throw new Error(
      `Expected searchScoreCount=${expectedScores} after traversal, got ${afterTraversal.searchScoreCount}`
    )
  }

  if (afterReload.cachedPageCount !== SEARCH_ACCEPTANCE_BOUNDS.expectedLruMaxPages) {
    throw new Error(
      `Expected LRU cache occupancy=${SEARCH_ACCEPTANCE_BOUNDS.expectedLruMaxPages} after Page 0 reload, got ${afterReload.cachedPageCount}`
    )
  }
  if (!Array.isArray(afterReload.cachedPages) || !afterReload.cachedPages.includes(0)) {
    throw new Error(
      `Expected Page 0 to be reloaded into cachedPages, got ${JSON.stringify(afterReload.cachedPages)}`
    )
  }
  if (!afterReload.cachedPages.includes(retainedSamplePage)) {
    throw new Error(
      `Expected retained sample page ${retainedSamplePage} to remain cached after Page 0 reload`
    )
  }
  if (afterReload.searchScoreCount !== expectedScores) {
    throw new Error(
      `Reloading evicted Page 0 failed to preserve searchScores for retained pages (expected ${expectedScores}, got ${afterReload.searchScoreCount})`
    )
  }
  const mountedCells = assertFiniteNumber(afterReload.mountedCells, 'afterReload.mountedCells')
  if (mountedCells <= 0 || mountedCells > SEARCH_ACCEPTANCE_BOUNDS.maxMountedCells) {
    throw new Error(
      `Mounted cells out of bounds after Page 0 reload (${mountedCells}; expected 1..${SEARCH_ACCEPTANCE_BOUNDS.maxMountedCells})`
    )
  }
}
