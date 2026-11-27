/**
 * Test-only deterministic synchronization barrier for search workers.
 * Completely inactive unless PV_TEST_SEARCH_BARRIER_DIR is set in the environment.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface SearchBarrierRule {
  readonly readyFile?: string
  readonly gateFile?: string
  readonly failIfExists?: string
  readonly delayMs?: number
  readonly timeoutMs?: number
}

type SearchBarriersConfig = {
  readonly clip?: Record<string, SearchBarrierRule>
  readonly bge?: Record<string, SearchBarrierRule>
}

export async function applySearchTestBarrier(
  modality: 'clip' | 'bge',
  queryText: string,
  isAborted?: () => boolean
): Promise<void> {
  const barrierDir = process.env.PV_TEST_SEARCH_BARRIER_DIR
  if (!barrierDir) return

  const configPath = join(barrierDir, 'barriers.json')
  if (!existsSync(configPath)) return

  let parsed: SearchBarriersConfig
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8')) as SearchBarriersConfig
  } catch {
    return
  }

  const key = queryText.trim().toLowerCase()
  const rule = parsed?.[modality]?.[key]
  if (!rule) return

  if (rule.failIfExists && existsSync(rule.failIfExists)) {
    throw new Error(`Simulated ${modality} search worker failure`)
  }

  if (rule.readyFile) {
    writeFileSync(rule.readyFile, 'ready', 'utf8')
  }

  if (rule.delayMs && rule.delayMs > 0) {
    const end = Date.now() + rule.delayMs
    while (Date.now() < end) {
      if (isAborted?.()) {
        const err = new Error('CANCELLED: Search aborted during test delay')
        ;(err as Error & { code?: string }).code = 'CANCELLED'
        throw err
      }
      await new Promise((r) => setTimeout(r, 15))
    }
  }

  if (rule.gateFile) {
    const deadline = Date.now() + (rule.timeoutMs ?? 12_000)
    while (!existsSync(rule.gateFile)) {
      if (isAborted?.()) {
        const err = new Error('CANCELLED: Search aborted while waiting at test barrier')
        ;(err as Error & { code?: string }).code = 'CANCELLED'
        throw err
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for test barrier gate file: ${rule.gateFile}`)
      }
      await new Promise((r) => setTimeout(r, 15))
    }
  }
}
