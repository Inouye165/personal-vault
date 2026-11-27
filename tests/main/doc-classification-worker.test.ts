import { monitorEventLoopDelay } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { DocumentClassificationWorkerRunner } from '../../src/main/services/documents/classification/worker-runner'
import { AppWorkerBudget } from '../../src/main/services/worker-budget'
import { DocumentClassificationResultSchema } from '../../src/shared/validation/document-schemas'

describe('Stage 7E Slice 1 — DocumentClassificationWorkerRunner & AppWorkerBudget(3)', () => {
  it('classifies single and batch documents in an isolated worker with zero network/nested-worker attempts', async () => {
    const budget = new AppWorkerBudget(3)
    const runner = new DocumentClassificationWorkerRunner({ workerBudget: budget })

    try {
      const single = await runner.classifyDocument({
        fileName: 'LICENSE.txt',
        extension: '.txt',
        relativePath: 'repos/app/LICENSE.txt',
        extractionStatus: 'extracted',
        textSourceKind: 'native',
        ocrMeanConfidence: null,
        text:
          'SPDX-License-Identifier: MIT\n' +
          'Permission is hereby granted, free of charge, to any person obtaining a copy of the "Software".\n' +
          'WITHOUT WARRANTY OF ANY KIND.\n'
      })
      const validated = DocumentClassificationResultSchema.parse(single)
      expect(validated.originLabels).toContain('software_project')
      expect(validated.isClutterCandidate).toBe(true)

      const batch = await runner.classifyBatch([
        {
          fileName: 'recipe.md',
          extension: '.md',
          relativePath: 'Notes/recipe.md',
          extractionStatus: 'extracted',
          textSourceKind: 'native',
          text: '# Ingredients\n- 2 tbsp olive oil\n- 1 cup broth\nPreheat oven to 350°F and simmer 20 minutes.\n'
        },
        {
          fileName: 'unknown.pdf',
          extension: '.pdf',
          relativePath: 'Scans/unknown.pdf',
          extractionStatus: 'password_protected',
          textSourceKind: 'none',
          text: null
        }
      ])
      expect(batch).toHaveLength(2)
      expect(batch[0]?.purposeLabels).toContain('recipes')
      expect(batch[0]?.isClutterCandidate).toBe(false)
      expect(batch[1]?.purposeStatus).toBe('unknown')

      const diag = runner.getDiagnostics()
      expect(diag.liveWorkers).toBe(1)
      expect(diag.nestedWorkerAttempts).toBe(0)
      expect(diag.outboundNetworkAttempts).toBe(0)
      expect(budget.getLiveCount()).toBe(1)

      const released = await runner.releaseIdleWorker()
      expect(released).toBe(true)
      expect(runner.getDiagnostics().liveWorkers).toBe(0)
      expect(budget.getLiveCount()).toBe(0)
    } finally {
      await runner.shutdown()
      expect(budget.getLiveCount()).toBe(0)
    }
  })

  it('releases AppWorkerBudget reservation synchronously on worker spawn failure', async () => {
    const budget = new AppWorkerBudget(3)
    const runner = new DocumentClassificationWorkerRunner({
      workerBudget: budget,
      isPackaged: true,
      workerScriptPath: 'D:\\nonexistent\\missing_classify_worker.js'
    })

    await expect(
      runner.classifyDocument({
        fileName: 'note.txt',
        extension: '.txt',
        relativePath: 'note.txt',
        textSourceKind: 'native',
        text: 'Enough readable prose text to pass the minimum length check for classification testing.'
      })
    ).rejects.toThrow()

    expect(runner.getDiagnostics().liveWorkers).toBe(0)
    expect(budget.getLiveCount()).toBe(0)
    await runner.shutdown()
  })

  it('supports mid-run cancellation, clean recovery, and bounded queue rejection', async () => {
    const budget = new AppWorkerBudget(3)
    const runner = new DocumentClassificationWorkerRunner({
      workerBudget: budget,
      maxQueuedRequests: 1
    })

    try {
      const p1 = runner
        .classifyDocument({
          fileName: 'a.txt',
          extension: '.txt',
          relativePath: 'a.txt',
          textSourceKind: 'native',
          text: 'General prose document one with sufficient length for deterministic classification testing.'
        })
        .catch((err: unknown) => err)
      const p2 = runner
        .classifyDocument({
          fileName: 'b.txt',
          extension: '.txt',
          relativePath: 'b.txt',
          textSourceKind: 'native',
          text: 'General prose document two with sufficient length for deterministic classification testing.'
        })
        .catch((err: unknown) => err)
      const p3Overflow = runner.classifyDocument({
        fileName: 'c.txt',
        extension: '.txt',
        relativePath: 'c.txt',
        textSourceKind: 'native',
        text: 'General prose document three.'
      })

      await expect(p3Overflow).rejects.toThrow(/QUEUE_FULL/)
      await runner.cancelActiveRequests('CANCELLED: Test cancel')
      const [r1, r2] = await Promise.all([p1, p2])
      expect(r1).toBeInstanceOf(Error)
      expect(r2).toBeInstanceOf(Error)
      expect(budget.getLiveCount()).toBe(0)

      // Clean recovery after cancellation
      const recovered = await runner.classifyDocument({
        fileName: 'recovered.txt',
        extension: '.txt',
        relativePath: 'recovered.txt',
        textSourceKind: 'native',
        text: 'General prose document after cancel with sufficient length for deterministic classification.'
      })
      expect(recovered.purposeStatus).toBe('other')
      expect(runner.getDiagnostics().liveWorkers).toBe(1)
    } finally {
      await runner.shutdown()
      expect(budget.getLiveCount()).toBe(0)
    }
  })

  it('enforces AppWorkerBudget(3) external slot contention and Tier 3 main-loop responsiveness (< 100 ms p95)', async () => {
    const budget = new AppWorkerBudget(3)
    const ext1 = budget.tryReserve()
    const ext2 = budget.tryReserve()
    const ext3 = budget.tryReserve()
    expect(ext1 && ext2 && ext3).toBeTruthy()

    const runner = new DocumentClassificationWorkerRunner({
      workerBudget: budget,
      admissionWaitTimeoutMs: 120
    })

    try {
      // Blocked when 3/3 slots are occupied
      await expect(
        runner.classifyDocument({
          fileName: 'blocked.txt',
          extension: '.txt',
          relativePath: 'blocked.txt',
          textSourceKind: 'native',
          text: 'General prose document waiting on budget slot.'
        })
      ).rejects.toThrow(/WORKER_BUDGET_TIMEOUT/)
      expect(budget.getLiveCount()).toBe(3)

      // Release 1 external slot -> runner acquires and succeeds
      budget.releaseReservation(ext3!)

      const largeText = 'General archival line for responsiveness testing.\n'
        .repeat(10_000)
        .slice(0, 500_000)
      for (let w = 0; w < 2; w += 1) {
        await runner.classifyDocument({
          fileName: `warmup-${w}.txt`,
          extension: '.txt',
          relativePath: `warmup-${w}.txt`,
          textSourceKind: 'native',
          text: largeText
        })
      }

      const histogram = monitorEventLoopDelay({ resolution: 10 })
      histogram.enable()
      const startMs = performance.now()
      let count = 0
      while (count < 80 && (count < 15 || performance.now() - startMs < 150)) {
        const res = await runner.classifyDocument({
          fileName: `large-${count}.txt`,
          extension: '.txt',
          relativePath: `large-${count}.txt`,
          textSourceKind: 'native',
          text: largeText
        })
        expect(res.totalNormalizedChars).toBeGreaterThan(400_000)
        count += 1
      }
      histogram.disable()
      const p95Ms = histogram.percentile(95) / 1e6
      expect(histogram.count).toBeGreaterThanOrEqual(10)
      expect(p95Ms).toBeLessThan(100)
    } finally {
      if (ext1) budget.releaseReservation(ext1)
      if (ext2) budget.releaseReservation(ext2)
      await runner.shutdown()
      expect(budget.getLiveCount()).toBe(0)
    }
  })
})
