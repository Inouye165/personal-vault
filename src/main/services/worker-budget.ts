/**
 * Shared atomic application-wide worker budget across thumbnail, semantic-search,
 * document-extraction, and document-snapshot coordinators.
 *
 * Guarantees:
 * - Atomic synchronous reservation (`tryReserve`) before any `await` continuation.
 * - Single-set tracking of live Worker instances (active + terminating) so
 *   transitioning a worker to terminating never double-counts it.
 * - Capacity is released only on spawn failure (`releaseReservation`) or
 *   confirmed Worker `'exit'`.
 */

import type { Worker } from 'node:worker_threads'

export interface WorkerBudgetReservation {
  readonly id: symbol
}

export class AppWorkerBudget {
  private readonly maxLiveWorkers: number
  private readonly reservations = new Set<symbol>()
  private readonly liveWorkers = new Set<Worker>()

  public constructor(maxLiveWorkers = 3) {
    this.maxLiveWorkers = Math.max(1, maxLiveWorkers)
  }

  public getMaxLiveWorkers(): number {
    return this.maxLiveWorkers
  }

  public getLiveCount(getExternalLiveWorkers?: () => number): number {
    return this.reservations.size + this.liveWorkers.size + (getExternalLiveWorkers?.() ?? 0)
  }

  public getReservedCount(): number {
    return this.reservations.size
  }

  public getWorkerCount(): number {
    return this.liveWorkers.size
  }

  public tryReserve(getExternalLiveWorkers?: () => number): WorkerBudgetReservation | null {
    if (this.getLiveCount(getExternalLiveWorkers) >= this.maxLiveWorkers) {
      return null
    }
    const id = Symbol('worker-budget-slot')
    this.reservations.add(id)
    return { id }
  }

  public promote(reservation: WorkerBudgetReservation, worker: Worker): void {
    this.reservations.delete(reservation.id)
    this.liveWorkers.add(worker)
    worker.once('exit', () => {
      this.liveWorkers.delete(worker)
    })
  }

  public releaseReservation(reservation: WorkerBudgetReservation): void {
    this.reservations.delete(reservation.id)
  }
}
