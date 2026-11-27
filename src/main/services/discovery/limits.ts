import type { DiscoveryResourceLimits } from './types'

export const DEFAULT_MAX_PENDING_DIRECTORIES = 10_000
export const DEFAULT_MAX_VISITED_DIRECTORIES = 100_000
export const DEFAULT_MAX_COLLECTED_RECORDS = 50_000

export interface ResolvedDiscoveryLimits {
  readonly maxPendingDirectories: number
  readonly maxVisitedDirectories: number
  readonly maxCollectedRecords: number
}

export function validatePositiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(
      `Invalid discovery configuration: "${name}" must be a finite positive safe integer, got ${String(value)}`
    )
  }
  return value
}

/**
 * Validates and resolves discovery resource limits at the public API boundary.
 *
 * - Requires finite positive safe integers (`>= 1` and `<= Number.MAX_SAFE_INTEGER`)
 *   for every supplied limit property.
 * - Rejects `NaN`, `Infinity`, `-Infinity`, `<= 0`, fractions, and unsafe integers
 *   with a `RangeError` before any filesystem operations or callbacks run.
 * - Preserves defaults when limits or individual properties are omitted.
 * - Note: `maxCollectedRecords` bounds only the `discoverFiles` convenience collector;
 *   `scanSourceRoots` streams events without retaining them in memory.
 */
export function resolveDiscoveryLimits(limits?: DiscoveryResourceLimits): ResolvedDiscoveryLimits {
  const maxPendingDirectories =
    limits?.maxPendingDirectories === undefined
      ? DEFAULT_MAX_PENDING_DIRECTORIES
      : validatePositiveSafeInteger(limits.maxPendingDirectories, 'maxPendingDirectories')

  const maxVisitedDirectories =
    limits?.maxVisitedDirectories === undefined
      ? DEFAULT_MAX_VISITED_DIRECTORIES
      : validatePositiveSafeInteger(limits.maxVisitedDirectories, 'maxVisitedDirectories')

  const maxCollectedRecords =
    limits?.maxCollectedRecords === undefined
      ? DEFAULT_MAX_COLLECTED_RECORDS
      : validatePositiveSafeInteger(limits.maxCollectedRecords, 'maxCollectedRecords')

  return {
    maxPendingDirectories,
    maxVisitedDirectories,
    maxCollectedRecords
  }
}

interface QueueNode<T> {
  readonly value: T
  next: QueueNode<T> | null
}

/**
 * Bounded O(1) FIFO queue backed by a singly linked list.
 * Avoids `Array.prototype.shift()` O(n) copying and enforces a hard upper bound on queue size.
 */
export class BoundedFifoQueue<T> {
  private head: QueueNode<T> | null = null
  private tail: QueueNode<T> | null = null
  private count = 0
  public readonly capacity: number

  constructor(capacity: number) {
    this.capacity = validatePositiveSafeInteger(capacity, 'BoundedFifoQueue capacity')
  }

  public get size(): number {
    return this.count
  }

  public enqueue(value: T): boolean {
    if (this.count >= this.capacity) {
      return false
    }
    const node: QueueNode<T> = { value, next: null }
    if (this.tail === null) {
      this.head = node
      this.tail = node
    } else {
      this.tail.next = node
      this.tail = node
    }
    this.count++
    return true
  }

  public dequeue(): T | undefined {
    const first = this.head
    if (first === null) {
      return undefined
    }
    this.head = first.next
    if (this.head === null) {
      this.tail = null
    }
    this.count--
    return first.value
  }
}
