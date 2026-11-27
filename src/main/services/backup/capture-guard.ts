/**
 * Personal Vault — Stage 8B: Async Capture-Window Guard
 *
 * Serializes `BackupCoordinator` snapshot capture (SQLite VACUUM INTO +
 * AnnotationJournal + Vault manifest read) with `VaultImportCoordinator`
 * manifest writes + SQLite commits when both run in the same process.
 */

export interface BackupCaptureGuard {
  runExclusive<T>(fn: () => Promise<T>): Promise<T>
}

export class AsyncCaptureGuard implements BackupCaptureGuard {
  private tail: Promise<void> = Promise.resolve()

  public async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail
    let release!: () => void
    this.tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await prev
    try {
      return await fn()
    } finally {
      release()
    }
  }
}
