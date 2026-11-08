/**
 * Personal Vault — Annotation Journal Service (Stage 5B)
 *
 * Implements machine-readable, recoverable append-only portable persistence
 * for photo ratings, review flags, and custom collections in app-owned storage.
 *
 * Guarantees:
 * - O(1) bounded writes per user decision (no whole-catalog rewrites).
 * - Full identity and provenance (normalized path, size, mtime, hash, revision, annotation version).
 * - Serialized atomic appends with sync-to-disk before acknowledgment.
 * - Safe crash recovery: truncates malformed trailing partial lines on restart while preserving interior lines.
 * - Robust path containment and symlink/junction rejection.
 * - Truthful error reporting on write failure without advancing sequence state.
 * - Two-phase recoverable operation/commit protocol (prepared operation -> SQLite commit -> op_committed / op_aborted).
 */

import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as fsSync from 'node:fs'
import { dirname, join, normalize, resolve, sep } from 'node:path'
import {
  AnnotationJournalEntrySchema,
  CURRENT_JOURNAL_FORMAT_VERSION,
  type AnnotationJournalEntry
} from '../../../shared/validation/ipc-schemas'

export class JournalOwnershipError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JournalOwnershipError'
  }
}

export class JournalSecurityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JournalSecurityError'
  }
}

export class JournalCorruptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JournalCorruptionError'
  }
}

export interface AnnotationJournalOptions {
  readonly storageDir: string
  readonly forbiddenOverlapPaths?: string[]
  readonly sourceRoots?: () => string[]
  readonly vaultPath?: () => string | null
  readonly customAppender?: (filePath: string, line: string) => Promise<void>
  readonly customAppenderSync?: (filePath: string, line: string) => void
}

export const MAX_JOURNAL_RECORD_BYTES = 64 * 1024

export class AnnotationJournal {
  private readonly storageDir: string
  private readonly forbiddenOverlapPaths: string[]
  private readonly sourceRootsGetter?: () => string[]
  private readonly vaultPathGetter?: () => string | null
  private readonly ownerMarkerPath: string
  private readonly journalPath: string
  private customAppender?: (filePath: string, line: string) => Promise<void>
  private customAppenderSync?: (filePath: string, line: string) => void

  private writeLockChain: Promise<void> = Promise.resolve()
  private latestSeq = 0
  private isInitialized = false

  constructor(options: AnnotationJournalOptions) {
    this.storageDir = resolve(normalize(options.storageDir))
    this.forbiddenOverlapPaths = (options.forbiddenOverlapPaths ?? []).map((p) =>
      resolve(normalize(p))
    )
    this.sourceRootsGetter = options.sourceRoots
    this.vaultPathGetter = options.vaultPath
    this.ownerMarkerPath = join(this.storageDir, '.pv_annotations_owner')
    this.journalPath = join(this.storageDir, 'review-journal.jsonl')
    this.customAppender = options.customAppender
    this.customAppenderSync = options.customAppenderSync
  }

  public setCustomAppenderSync(
    appender: ((filePath: string, line: string) => void) | null | undefined
  ): void {
    this.customAppenderSync = appender ?? undefined
  }

  public setCustomAppender(
    appender: ((filePath: string, line: string) => Promise<void>) | null | undefined
  ): void {
    this.customAppender = appender ?? undefined
  }

  public getJournalPath(): string {
    return this.journalPath
  }

  public getStorageDir(): string {
    return this.storageDir
  }

  public getLatestSeq(): number {
    return this.latestSeq
  }

  public async initialize(): Promise<void> {
    await this.validateContainmentAndSecurityAsync()

    await fs.mkdir(this.storageDir, { recursive: true })

    // 1. Establish or validate ownership marker
    let markerExists = false
    try {
      const stat = await fs.lstat(this.ownerMarkerPath)
      if (stat.isSymbolicLink()) {
        throw new JournalSecurityError('Ownership marker cannot be a symbolic link')
      }
      markerExists = true
    } catch (err: unknown) {
      if (err instanceof JournalSecurityError) throw err
    }

    if (markerExists) {
      await this.validateMarkerContentAsync()
    } else {
      // If journal already exists without ownership marker, refuse to adopt foreign file
      const journalExists = await fs
        .stat(this.journalPath)
        .then(() => true)
        .catch(() => false)
      if (journalExists) {
        throw new JournalOwnershipError(
          'Found existing journal file without valid ownership marker'
        )
      }

      try {
        await fs.writeFile(
          this.ownerMarkerPath,
          JSON.stringify(
            {
              app: 'personal-vault',
              format: 'personal-vault-review-journal',
              version: '1.0.0',
              createdAtMs: Date.now()
            },
            null,
            2
          ),
          { flag: 'wx', encoding: 'utf8' }
        )
      } catch (err: unknown) {
        throw new JournalOwnershipError(`Failed to create ownership marker exclusively: ${err}`)
      }
    }

    // 2. Ensure journal file exists and recover from partial writes
    let journalExists = false
    try {
      const stat = await fs.lstat(this.journalPath)
      if (stat.isSymbolicLink()) {
        throw new JournalSecurityError('Journal file cannot be a symbolic link')
      }
      journalExists = true
    } catch {
      // journal does not exist yet
    }

    if (!journalExists) {
      await fs.writeFile(this.journalPath, '', { flag: 'wx', encoding: 'utf8' })
      this.latestSeq = 0
      this.isInitialized = true
      return
    }

    await this.recoverAndReconcileAsync()
    this.isInitialized = true
  }

  /**
   * Synchronous initialization for synchronous catalog startup.
   */
  public initializeSync(): void {
    this.validateContainmentAndSecuritySync()

    fsSync.mkdirSync(this.storageDir, { recursive: true })

    let markerExists = false
    try {
      const stat = fsSync.lstatSync(this.ownerMarkerPath)
      if (stat.isSymbolicLink()) {
        throw new JournalSecurityError('Ownership marker cannot be a symbolic link')
      }
      markerExists = true
    } catch (err: unknown) {
      if (err instanceof JournalSecurityError) throw err
    }

    if (markerExists) {
      this.validateMarkerContentSync()
    } else {
      let journalExists = false
      try {
        fsSync.statSync(this.journalPath)
        journalExists = true
      } catch {
        // journal does not exist yet
      }
      if (journalExists) {
        throw new JournalOwnershipError(
          'Found existing journal file without valid ownership marker'
        )
      }

      try {
        fsSync.writeFileSync(
          this.ownerMarkerPath,
          JSON.stringify(
            {
              app: 'personal-vault',
              format: 'personal-vault-review-journal',
              version: '1.0.0',
              createdAtMs: Date.now()
            },
            null,
            2
          ),
          { flag: 'wx', encoding: 'utf8' }
        )
      } catch (err: unknown) {
        throw new JournalOwnershipError(`Failed to create ownership marker exclusively: ${err}`)
      }
    }

    let journalExists = false
    try {
      const stat = fsSync.lstatSync(this.journalPath)
      if (stat.isSymbolicLink()) {
        throw new JournalSecurityError('Journal file cannot be a symbolic link')
      }
      journalExists = true
    } catch {
      // journal does not exist yet
    }

    if (!journalExists) {
      fsSync.writeFileSync(this.journalPath, '', { flag: 'wx', encoding: 'utf8' })
      this.latestSeq = 0
      this.isInitialized = true
      return
    }

    this.recoverAndReconcileSync()
    this.isInitialized = true
  }

  private validateContainmentAndSecuritySync(): void {
    let curr = this.storageDir
    while (true) {
      try {
        const stat = fsSync.lstatSync(curr)
        if (stat.isSymbolicLink()) {
          throw new JournalSecurityError(
            `Symbolic link or junction detected in storage path: ${curr}`
          )
        }
      } catch (err: unknown) {
        if (err instanceof JournalSecurityError) throw err
      }
      const parent = dirname(curr)
      if (parent === curr) break
      curr = parent
    }

    try {
      if (
        fsSync.existsSync(this.ownerMarkerPath) &&
        fsSync.lstatSync(this.ownerMarkerPath).isSymbolicLink()
      ) {
        throw new JournalSecurityError('Ownership marker cannot be a symbolic link')
      }
    } catch (err: unknown) {
      if (err instanceof JournalSecurityError) throw err
    }
    try {
      if (
        fsSync.existsSync(this.journalPath) &&
        fsSync.lstatSync(this.journalPath).isSymbolicLink()
      ) {
        throw new JournalSecurityError('Journal file cannot be a symbolic link')
      }
    } catch (err: unknown) {
      if (err instanceof JournalSecurityError) throw err
    }

    const allForbidden = [...this.forbiddenOverlapPaths]
    if (this.sourceRootsGetter) {
      try {
        const roots = this.sourceRootsGetter()
        if (Array.isArray(roots)) {
          allForbidden.push(...roots)
        }
      } catch {
        // ignore getter errors
      }
    }
    if (this.vaultPathGetter) {
      try {
        const vp = this.vaultPathGetter()
        if (vp && typeof vp === 'string') {
          allForbidden.push(vp)
        }
      } catch {
        // ignore getter errors
      }
    }

    const storageNormalized = this.storageDir.toLowerCase()
    for (const rawForbidden of allForbidden) {
      if (!rawForbidden || typeof rawForbidden !== 'string') continue
      const forbiddenNormalized = resolve(normalize(rawForbidden)).toLowerCase()
      if (
        storageNormalized === forbiddenNormalized ||
        storageNormalized.startsWith(forbiddenNormalized + sep) ||
        forbiddenNormalized.startsWith(storageNormalized + sep)
      ) {
        throw new JournalSecurityError(
          `Journal storage directory overlaps with forbidden path: ${rawForbidden}`
        )
      }
    }
  }

  private async validateContainmentAndSecurityAsync(): Promise<void> {
    let curr = this.storageDir
    while (true) {
      try {
        const stat = await fs.lstat(curr)
        if (stat.isSymbolicLink()) {
          throw new JournalSecurityError(
            `Symbolic link or junction detected in storage path: ${curr}`
          )
        }
      } catch (err: unknown) {
        if (err instanceof JournalSecurityError) throw err
      }
      const parent = dirname(curr)
      if (parent === curr) break
      curr = parent
    }

    try {
      const markerStat = await fs.lstat(this.ownerMarkerPath).catch(() => null)
      if (markerStat?.isSymbolicLink()) {
        throw new JournalSecurityError('Ownership marker cannot be a symbolic link')
      }
    } catch (err: unknown) {
      if (err instanceof JournalSecurityError) throw err
    }
    try {
      const journalStat = await fs.lstat(this.journalPath).catch(() => null)
      if (journalStat?.isSymbolicLink()) {
        throw new JournalSecurityError('Journal file cannot be a symbolic link')
      }
    } catch (err: unknown) {
      if (err instanceof JournalSecurityError) throw err
    }

    const allForbidden = [...this.forbiddenOverlapPaths]
    if (this.sourceRootsGetter) {
      try {
        const roots = this.sourceRootsGetter()
        if (Array.isArray(roots)) {
          allForbidden.push(...roots)
        }
      } catch {
        // ignore getter errors
      }
    }
    if (this.vaultPathGetter) {
      try {
        const vp = this.vaultPathGetter()
        if (vp && typeof vp === 'string') {
          allForbidden.push(vp)
        }
      } catch {
        // ignore getter errors
      }
    }

    const storageNormalized = this.storageDir.toLowerCase()
    for (const rawForbidden of allForbidden) {
      if (!rawForbidden || typeof rawForbidden !== 'string') continue
      const forbiddenNormalized = resolve(normalize(rawForbidden)).toLowerCase()
      if (
        storageNormalized === forbiddenNormalized ||
        storageNormalized.startsWith(forbiddenNormalized + sep) ||
        forbiddenNormalized.startsWith(storageNormalized + sep)
      ) {
        throw new JournalSecurityError(
          `Journal storage directory overlaps with forbidden path: ${rawForbidden}`
        )
      }
    }
  }

  private validateMarkerContentSync(): void {
    const raw = fsSync.readFileSync(this.ownerMarkerPath, 'utf8')
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new JournalOwnershipError('Invalid JSON in ownership marker')
    }

    if (
      parsed.app !== 'personal-vault' ||
      parsed.format !== 'personal-vault-review-journal' ||
      parsed.version !== '1.0.0' ||
      typeof parsed.createdAtMs !== 'number'
    ) {
      throw new JournalOwnershipError('Foreign or conflicting ownership marker detected')
    }
  }

  private async validateMarkerContentAsync(): Promise<void> {
    const raw = await fs.readFile(this.ownerMarkerPath, 'utf8')
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new JournalOwnershipError('Invalid JSON in ownership marker')
    }

    if (
      parsed.app !== 'personal-vault' ||
      parsed.format !== 'personal-vault-review-journal' ||
      parsed.version !== '1.0.0' ||
      typeof parsed.createdAtMs !== 'number'
    ) {
      throw new JournalOwnershipError('Foreign or conflicting ownership marker detected')
    }
  }

  /**
   * Bounded streaming recovery:
   * Reads the journal in bounded chunks (64KB), parses lines, validates sequence ordering,
   * detects interior corruption without discarding evidence, and truncates ONLY an incomplete
   * final record at EOF.
   */
  private async recoverAndReconcileAsync(): Promise<void> {
    const fileHandle = await fs.open(this.journalPath, 'r+')
    try {
      const stat = await fileHandle.stat()
      const totalSize = stat.size
      if (totalSize === 0) {
        this.latestSeq = 0
        return
      }

      const CHUNK_SIZE = 64 * 1024
      const buffer = Buffer.alloc(CHUNK_SIZE)
      let fileOffset = 0
      let lastValidByteOffset = 0
      let expectedSeq = 1
      let lineNumber = 0
      let remainderBuf = Buffer.alloc(0)
      let remainderStartOffset = 0

      while (fileOffset < totalSize) {
        const bytesRead = (await fileHandle.read(buffer, 0, CHUNK_SIZE, fileOffset)).bytesRead
        if (bytesRead === 0) break

        const chunkBuf = buffer.subarray(0, bytesRead)
        const combinedBuf =
          remainderBuf.length > 0 ? Buffer.concat([remainderBuf, chunkBuf]) : chunkBuf
        const combinedStartOffset = remainderBuf.length > 0 ? remainderStartOffset : fileOffset

        let lineStart = 0
        while (true) {
          const newlineIdx = combinedBuf.indexOf(0x0a, lineStart)
          if (newlineIdx === -1) {
            remainderBuf = Buffer.from(combinedBuf.subarray(lineStart))
            remainderStartOffset = combinedStartOffset + lineStart
            if (remainderBuf.length > MAX_JOURNAL_RECORD_BYTES) {
              throw new JournalCorruptionError(
                `Journal record exceeds maximum record length bound of ${MAX_JOURNAL_RECORD_BYTES} bytes`
              )
            }
            break
          }

          const lineLength = newlineIdx - lineStart
          if (lineLength > MAX_JOURNAL_RECORD_BYTES) {
            throw new JournalCorruptionError(
              `Journal record exceeds maximum record length bound of ${MAX_JOURNAL_RECORD_BYTES} bytes`
            )
          }

          const lineBytes = combinedBuf.subarray(lineStart, newlineIdx)
          const currentLineEndOffset = combinedStartOffset + newlineIdx + 1
          lineStart = newlineIdx + 1

          const lineStr = lineBytes.toString('utf8').trim()
          if (!lineStr) {
            lastValidByteOffset = currentLineEndOffset
            continue
          }

          lineNumber++
          let parsedObj: unknown
          try {
            parsedObj = JSON.parse(lineStr)
          } catch {
            throw new JournalCorruptionError(
              `Interior corruption detected in review journal at line ${lineNumber}. Refusing automatic repair to prevent data loss.`
            )
          }

          const parseResult = AnnotationJournalEntrySchema.safeParse(parsedObj)
          if (!parseResult.success) {
            throw new JournalCorruptionError(
              `Interior corruption detected in review journal at line ${lineNumber} (schema validation failed). Refusing automatic repair to prevent data loss.`
            )
          }

          const entry = parseResult.data
          if (entry.entrySeq !== expectedSeq) {
            throw new JournalCorruptionError(
              `Sequence disorder detected in review journal at line ${lineNumber} (expected ${expectedSeq}, got ${entry.entrySeq}).`
            )
          }

          expectedSeq++
          lastValidByteOffset = currentLineEndOffset
        }

        fileOffset += bytesRead
      }

      if (remainderBuf.length > 0 || lastValidByteOffset < totalSize) {
        await fileHandle.truncate(lastValidByteOffset)
        await fileHandle.sync()
      }

      this.latestSeq = expectedSeq - 1
    } finally {
      await fileHandle.close()
    }
  }

  private recoverAndReconcileSync(): void {
    const fd = fsSync.openSync(this.journalPath, 'r+')
    try {
      const stat = fsSync.fstatSync(fd)
      const totalSize = stat.size
      if (totalSize === 0) {
        this.latestSeq = 0
        return
      }

      const CHUNK_SIZE = 64 * 1024
      const buffer = Buffer.alloc(CHUNK_SIZE)
      let fileOffset = 0
      let lastValidByteOffset = 0
      let expectedSeq = 1
      let lineNumber = 0
      let remainderBuf = Buffer.alloc(0)
      let remainderStartOffset = 0

      while (fileOffset < totalSize) {
        const bytesRead = fsSync.readSync(fd, buffer, 0, CHUNK_SIZE, fileOffset)
        if (bytesRead === 0) break

        const chunkBuf = buffer.subarray(0, bytesRead)
        const combinedBuf =
          remainderBuf.length > 0 ? Buffer.concat([remainderBuf, chunkBuf]) : chunkBuf
        const combinedStartOffset = remainderBuf.length > 0 ? remainderStartOffset : fileOffset

        let lineStart = 0
        while (true) {
          const newlineIdx = combinedBuf.indexOf(0x0a, lineStart)
          if (newlineIdx === -1) {
            remainderBuf = Buffer.from(combinedBuf.subarray(lineStart))
            remainderStartOffset = combinedStartOffset + lineStart
            if (remainderBuf.length > MAX_JOURNAL_RECORD_BYTES) {
              throw new JournalCorruptionError(
                `Journal record exceeds maximum record length bound of ${MAX_JOURNAL_RECORD_BYTES} bytes`
              )
            }
            break
          }

          const lineLength = newlineIdx - lineStart
          if (lineLength > MAX_JOURNAL_RECORD_BYTES) {
            throw new JournalCorruptionError(
              `Journal record exceeds maximum record length bound of ${MAX_JOURNAL_RECORD_BYTES} bytes`
            )
          }

          const lineBytes = combinedBuf.subarray(lineStart, newlineIdx)
          const currentLineEndOffset = combinedStartOffset + newlineIdx + 1
          lineStart = newlineIdx + 1

          const lineStr = lineBytes.toString('utf8').trim()
          if (!lineStr) {
            lastValidByteOffset = currentLineEndOffset
            continue
          }

          lineNumber++
          let parsedObj: unknown
          try {
            parsedObj = JSON.parse(lineStr)
          } catch {
            throw new JournalCorruptionError(
              `Interior corruption detected in review journal at line ${lineNumber}. Refusing automatic repair to prevent data loss.`
            )
          }

          const parseResult = AnnotationJournalEntrySchema.safeParse(parsedObj)
          if (!parseResult.success) {
            throw new JournalCorruptionError(
              `Interior corruption detected in review journal at line ${lineNumber} (schema validation failed). Refusing automatic repair to prevent data loss.`
            )
          }

          const entry = parseResult.data
          if (entry.entrySeq !== expectedSeq) {
            throw new JournalCorruptionError(
              `Sequence disorder detected in review journal at line ${lineNumber} (expected ${expectedSeq}, got ${entry.entrySeq}).`
            )
          }

          expectedSeq++
          lastValidByteOffset = currentLineEndOffset
        }

        fileOffset += bytesRead
      }

      if (remainderBuf.length > 0 || lastValidByteOffset < totalSize) {
        fsSync.ftruncateSync(fd, lastValidByteOffset)
        fsSync.fsyncSync(fd)
      }

      this.latestSeq = expectedSeq - 1
    } finally {
      fsSync.closeSync(fd)
    }
  }

  public *iterateEntriesSync(): Generator<AnnotationJournalEntry, void, undefined> {
    this.assertInitialized()
    const fd = fsSync.openSync(this.journalPath, 'r')
    try {
      const stat = fsSync.fstatSync(fd)
      const totalSize = stat.size
      if (totalSize === 0) return

      const CHUNK_SIZE = 64 * 1024
      const buffer = Buffer.alloc(CHUNK_SIZE)
      let fileOffset = 0
      let remainderBuf = Buffer.alloc(0)

      while (fileOffset < totalSize) {
        const bytesRead = fsSync.readSync(fd, buffer, 0, CHUNK_SIZE, fileOffset)
        if (bytesRead === 0) break

        const chunkBuf = buffer.subarray(0, bytesRead)
        const combinedBuf =
          remainderBuf.length > 0 ? Buffer.concat([remainderBuf, chunkBuf]) : chunkBuf

        let lineStart = 0
        while (true) {
          const newlineIdx = combinedBuf.indexOf(0x0a, lineStart)
          if (newlineIdx === -1) {
            remainderBuf = Buffer.from(combinedBuf.subarray(lineStart))
            if (remainderBuf.length > MAX_JOURNAL_RECORD_BYTES) {
              throw new JournalCorruptionError(
                `Journal record exceeds maximum record length bound of ${MAX_JOURNAL_RECORD_BYTES} bytes`
              )
            }
            break
          }

          const lineLength = newlineIdx - lineStart
          if (lineLength > MAX_JOURNAL_RECORD_BYTES) {
            throw new JournalCorruptionError(
              `Journal record exceeds maximum record length bound of ${MAX_JOURNAL_RECORD_BYTES} bytes`
            )
          }

          const lineBytes = combinedBuf.subarray(lineStart, newlineIdx)
          lineStart = newlineIdx + 1

          const lineStr = lineBytes.toString('utf8').trim()
          if (!lineStr) continue

          const parsed = AnnotationJournalEntrySchema.parse(JSON.parse(lineStr))
          yield parsed
        }

        fileOffset += bytesRead
      }

      if (remainderBuf.length > 0) {
        const lineStr = remainderBuf.toString('utf8').trim()
        if (lineStr) {
          const parsed = AnnotationJournalEntrySchema.parse(JSON.parse(lineStr))
          yield parsed
        }
      }
    } finally {
      fsSync.closeSync(fd)
    }
  }

  public async *iterateEntries(): AsyncGenerator<AnnotationJournalEntry, void, undefined> {
    this.assertInitialized()
    const fileHandle = await fs.open(this.journalPath, 'r')
    try {
      const stat = await fileHandle.stat()
      const totalSize = stat.size
      if (totalSize === 0) return

      const CHUNK_SIZE = 64 * 1024
      const buffer = Buffer.alloc(CHUNK_SIZE)
      let fileOffset = 0
      let remainderBuf = Buffer.alloc(0)

      while (fileOffset < totalSize) {
        const bytesRead = (await fileHandle.read(buffer, 0, CHUNK_SIZE, fileOffset)).bytesRead
        if (bytesRead === 0) break

        const chunkBuf = buffer.subarray(0, bytesRead)
        const combinedBuf =
          remainderBuf.length > 0 ? Buffer.concat([remainderBuf, chunkBuf]) : chunkBuf

        let lineStart = 0
        while (true) {
          const newlineIdx = combinedBuf.indexOf(0x0a, lineStart)
          if (newlineIdx === -1) {
            remainderBuf = Buffer.from(combinedBuf.subarray(lineStart))
            if (remainderBuf.length > MAX_JOURNAL_RECORD_BYTES) {
              throw new JournalCorruptionError(
                `Journal record exceeds maximum record length bound of ${MAX_JOURNAL_RECORD_BYTES} bytes`
              )
            }
            break
          }

          const lineLength = newlineIdx - lineStart
          if (lineLength > MAX_JOURNAL_RECORD_BYTES) {
            throw new JournalCorruptionError(
              `Journal record exceeds maximum record length bound of ${MAX_JOURNAL_RECORD_BYTES} bytes`
            )
          }

          const lineBytes = combinedBuf.subarray(lineStart, newlineIdx)
          lineStart = newlineIdx + 1

          const lineStr = lineBytes.toString('utf8').trim()
          if (!lineStr) continue

          const parsed = AnnotationJournalEntrySchema.parse(JSON.parse(lineStr))
          yield parsed
        }

        fileOffset += bytesRead
      }

      if (remainderBuf.length > 0) {
        const lineStr = remainderBuf.toString('utf8').trim()
        if (lineStr) {
          const parsed = AnnotationJournalEntrySchema.parse(JSON.parse(lineStr))
          yield parsed
        }
      }
    } finally {
      await fileHandle.close()
    }
  }

  public async readEntries(): Promise<AnnotationJournalEntry[]> {
    const entries: AnnotationJournalEntry[] = []
    for await (const entry of this.iterateEntries()) {
      entries.push(entry)
    }
    return entries
  }

  public readEntriesSync(): AnnotationJournalEntry[] {
    return Array.from(this.iterateEntriesSync())
  }

  public appendEntrySync(
    buildEntry: (nextSeq: number, timestampMs: number) => AnnotationJournalEntry
  ): AnnotationJournalEntry {
    this.assertInitialized()
    this.validateContainmentAndSecuritySync()
    const nextSeq = this.latestSeq + 1
    const timestampMs = Date.now()
    const entry = buildEntry(nextSeq, timestampMs)
    const line = JSON.stringify(entry) + '\n'

    const initialSize = fsSync.statSync(this.journalPath).size
    try {
      if (this.customAppenderSync) {
        this.customAppenderSync(this.journalPath, line)
      } else if (this.customAppender) {
        throw new Error('Async custom appender cannot be executed synchronously')
      } else {
        const fd = fsSync.openSync(this.journalPath, 'a')
        try {
          fsSync.writeSync(fd, line, null, 'utf8')
          fsSync.fsyncSync(fd)
        } finally {
          fsSync.closeSync(fd)
        }
      }
    } catch (err) {
      try {
        fsSync.truncateSync(this.journalPath, initialSize)
      } catch {
        // ignore rollback error
      }
      throw err
    }

    this.latestSeq = nextSeq
    return entry
  }

  private async appendEntry(
    buildEntry: (nextSeq: number, timestampMs: number) => AnnotationJournalEntry
  ): Promise<AnnotationJournalEntry> {
    this.assertInitialized()

    return new Promise((resolve, reject) => {
      this.writeLockChain = this.writeLockChain
        .then(async () => {
          await this.validateContainmentAndSecurityAsync()
          const nextSeq = this.latestSeq + 1
          const timestampMs = Date.now()
          const entry = buildEntry(nextSeq, timestampMs)
          const line = JSON.stringify(entry) + '\n'

          const initialStat = await fs.stat(this.journalPath)
          const initialSize = initialStat.size
          try {
            if (this.customAppender) {
              await this.customAppender(this.journalPath, line)
            } else {
              const handle = await fs.open(this.journalPath, 'a')
              try {
                await handle.writeFile(line, 'utf8')
                await handle.sync()
              } finally {
                await handle.close()
              }
            }
          } catch (err) {
            try {
              await fs.truncate(this.journalPath, initialSize)
            } catch {
              // ignore rollback error
            }
            throw err
          }

          this.latestSeq = nextSeq
          resolve(entry)
        })
        .catch(reject)
    })
  }

  // --- Convenience Appenders with opId Support ---

  public async appendPhotoAnnotation(params: {
    opId?: string
    locationId: number
    normalizedPath: string
    originalPath: string
    byteSize: number
    filesystemMtimeMs: number | null
    activeHash: string | null
    discoveryObservationId: number
    expectedRevision: string
    version: number
    rating: number | null
    flag: 'none' | 'pick' | 'reject'
  }): Promise<AnnotationJournalEntry> {
    const opId = params.opId ?? randomUUID()
    return this.appendEntry((nextSeq, timestampMs) => ({
      formatVersion: CURRENT_JOURNAL_FORMAT_VERSION,
      entrySeq: nextSeq,
      entryTimestampMs: timestampMs,
      opId,
      kind: 'photo_annotation',
      ...params
    }))
  }

  public appendPhotoAnnotationSync(params: {
    opId?: string
    locationId: number
    normalizedPath: string
    originalPath: string
    byteSize: number
    filesystemMtimeMs: number | null
    activeHash: string | null
    discoveryObservationId: number
    expectedRevision: string
    version: number
    rating: number | null
    flag: 'none' | 'pick' | 'reject'
  }): AnnotationJournalEntry {
    const opId = params.opId ?? randomUUID()
    return this.appendEntrySync((nextSeq, timestampMs) => ({
      formatVersion: CURRENT_JOURNAL_FORMAT_VERSION,
      entrySeq: nextSeq,
      entryTimestampMs: timestampMs,
      opId,
      kind: 'photo_annotation',
      ...params
    }))
  }

  public async appendCollectionCreated(params: {
    opId?: string
    collectionId: number
    name: string
    normalizedName: string
  }): Promise<AnnotationJournalEntry> {
    const opId = params.opId ?? randomUUID()
    return this.appendEntry((nextSeq, timestampMs) => ({
      formatVersion: CURRENT_JOURNAL_FORMAT_VERSION,
      entrySeq: nextSeq,
      entryTimestampMs: timestampMs,
      opId,
      kind: 'collection_created',
      ...params
    }))
  }

  public appendCollectionCreatedSync(params: {
    opId?: string
    collectionId: number
    name: string
    normalizedName: string
  }): AnnotationJournalEntry {
    const opId = params.opId ?? randomUUID()
    return this.appendEntrySync((nextSeq, timestampMs) => ({
      formatVersion: CURRENT_JOURNAL_FORMAT_VERSION,
      entrySeq: nextSeq,
      entryTimestampMs: timestampMs,
      opId,
      kind: 'collection_created',
      ...params
    }))
  }

  public async appendCollectionRenamed(params: {
    opId?: string
    collectionId: number
    oldName: string
    newName: string
    normalizedName: string
  }): Promise<AnnotationJournalEntry> {
    const opId = params.opId ?? randomUUID()
    return this.appendEntry((nextSeq, timestampMs) => ({
      formatVersion: CURRENT_JOURNAL_FORMAT_VERSION,
      entrySeq: nextSeq,
      entryTimestampMs: timestampMs,
      opId,
      kind: 'collection_renamed',
      ...params
    }))
  }

  public appendCollectionRenamedSync(params: {
    opId?: string
    collectionId: number
    oldName: string
    newName: string
    normalizedName: string
  }): AnnotationJournalEntry {
    const opId = params.opId ?? randomUUID()
    return this.appendEntrySync((nextSeq, timestampMs) => ({
      formatVersion: CURRENT_JOURNAL_FORMAT_VERSION,
      entrySeq: nextSeq,
      entryTimestampMs: timestampMs,
      opId,
      kind: 'collection_renamed',
      ...params
    }))
  }

  public async appendMembershipAdded(params: {
    opId?: string
    collectionId: number
    collectionName: string
    locationId: number
    expectedRevision: string
    normalizedPath: string
    byteSize: number
    activeHash: string | null
    discoveryObservationId: number
  }): Promise<AnnotationJournalEntry> {
    const opId = params.opId ?? randomUUID()
    return this.appendEntry((nextSeq, timestampMs) => ({
      formatVersion: CURRENT_JOURNAL_FORMAT_VERSION,
      entrySeq: nextSeq,
      entryTimestampMs: timestampMs,
      opId,
      kind: 'membership_added',
      ...params
    }))
  }

  public appendMembershipAddedSync(params: {
    opId?: string
    collectionId: number
    collectionName: string
    locationId: number
    expectedRevision: string
    normalizedPath: string
    byteSize: number
    activeHash: string | null
    discoveryObservationId: number
  }): AnnotationJournalEntry {
    const opId = params.opId ?? randomUUID()
    return this.appendEntrySync((nextSeq, timestampMs) => ({
      formatVersion: CURRENT_JOURNAL_FORMAT_VERSION,
      entrySeq: nextSeq,
      entryTimestampMs: timestampMs,
      opId,
      kind: 'membership_added',
      ...params
    }))
  }

  public async appendMembershipRemoved(params: {
    opId?: string
    collectionId: number
    collectionName: string
    locationId: number
    expectedRevision: string
    normalizedPath: string
  }): Promise<AnnotationJournalEntry> {
    const opId = params.opId ?? randomUUID()
    return this.appendEntry((nextSeq, timestampMs) => ({
      formatVersion: CURRENT_JOURNAL_FORMAT_VERSION,
      entrySeq: nextSeq,
      entryTimestampMs: timestampMs,
      opId,
      kind: 'membership_removed',
      ...params
    }))
  }

  public appendMembershipRemovedSync(params: {
    opId?: string
    collectionId: number
    collectionName: string
    locationId: number
    expectedRevision: string
    normalizedPath: string
  }): AnnotationJournalEntry {
    const opId = params.opId ?? randomUUID()
    return this.appendEntrySync((nextSeq, timestampMs) => ({
      formatVersion: CURRENT_JOURNAL_FORMAT_VERSION,
      entrySeq: nextSeq,
      entryTimestampMs: timestampMs,
      opId,
      kind: 'membership_removed',
      ...params
    }))
  }

  public async appendCommitRecord(params: {
    opId: string
    targetSeq: number
  }): Promise<AnnotationJournalEntry> {
    return this.appendEntry((nextSeq, timestampMs) => ({
      formatVersion: CURRENT_JOURNAL_FORMAT_VERSION,
      entrySeq: nextSeq,
      entryTimestampMs: timestampMs,
      opId: params.opId,
      kind: 'op_committed',
      targetSeq: params.targetSeq
    }))
  }

  public appendCommitRecordSync(params: {
    opId: string
    targetSeq: number
  }): AnnotationJournalEntry {
    return this.appendEntrySync((nextSeq, timestampMs) => ({
      formatVersion: CURRENT_JOURNAL_FORMAT_VERSION,
      entrySeq: nextSeq,
      entryTimestampMs: timestampMs,
      opId: params.opId,
      kind: 'op_committed',
      targetSeq: params.targetSeq
    }))
  }

  public async appendAbortRecord(params: {
    opId: string
    targetSeq: number
    reason: string
  }): Promise<AnnotationJournalEntry> {
    return this.appendEntry((nextSeq, timestampMs) => ({
      formatVersion: CURRENT_JOURNAL_FORMAT_VERSION,
      entrySeq: nextSeq,
      entryTimestampMs: timestampMs,
      opId: params.opId,
      kind: 'op_aborted',
      targetSeq: params.targetSeq,
      reason: params.reason
    }))
  }

  public appendAbortRecordSync(params: {
    opId: string
    targetSeq: number
    reason: string
  }): AnnotationJournalEntry {
    return this.appendEntrySync((nextSeq, timestampMs) => ({
      formatVersion: CURRENT_JOURNAL_FORMAT_VERSION,
      entrySeq: nextSeq,
      entryTimestampMs: timestampMs,
      opId: params.opId,
      kind: 'op_aborted',
      targetSeq: params.targetSeq,
      reason: params.reason
    }))
  }

  private assertInitialized(): void {
    if (!this.isInitialized) {
      throw new Error('AnnotationJournal must be initialized before performing operations')
    }
  }
}
