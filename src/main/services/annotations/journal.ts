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
  readonly customAppender?: (filePath: string, line: string) => Promise<void>
  readonly customAppenderSync?: (filePath: string, line: string) => void
}

export class AnnotationJournal {
  private readonly storageDir: string
  private readonly forbiddenOverlapPaths: string[]
  private readonly ownerMarkerPath: string
  private readonly journalPath: string
  private readonly customAppender?: (filePath: string, line: string) => Promise<void>
  private readonly customAppenderSync?: (filePath: string, line: string) => void

  private writeLockChain: Promise<void> = Promise.resolve()
  private latestSeq = 0
  private isInitialized = false

  constructor(options: AnnotationJournalOptions) {
    this.storageDir = resolve(normalize(options.storageDir))
    this.forbiddenOverlapPaths = (options.forbiddenOverlapPaths ?? []).map((p) =>
      resolve(normalize(p))
    )
    this.ownerMarkerPath = join(this.storageDir, '.pv_annotations_owner')
    this.journalPath = join(this.storageDir, 'review-journal.jsonl')
    this.customAppender = options.customAppender
    this.customAppenderSync = options.customAppenderSync
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

    const storageNormalized = this.storageDir.toLowerCase()
    for (const forbidden of this.forbiddenOverlapPaths) {
      const forbiddenNormalized = forbidden.toLowerCase()
      if (
        storageNormalized === forbiddenNormalized ||
        storageNormalized.startsWith(forbiddenNormalized + sep) ||
        forbiddenNormalized.startsWith(storageNormalized + sep)
      ) {
        throw new JournalSecurityError(
          `Journal storage directory overlaps with forbidden path: ${forbidden}`
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

    const storageNormalized = this.storageDir.toLowerCase()
    for (const forbidden of this.forbiddenOverlapPaths) {
      const forbiddenNormalized = forbidden.toLowerCase()
      if (
        storageNormalized === forbiddenNormalized ||
        storageNormalized.startsWith(forbiddenNormalized + sep) ||
        forbiddenNormalized.startsWith(storageNormalized + sep)
      ) {
        throw new JournalSecurityError(
          `Journal storage directory overlaps with forbidden path: ${forbidden}`
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
      let pendingChunkRemainder = ''
      let pendingRemainderByteOffset = 0

      while (fileOffset < totalSize) {
        const bytesRead = (await fileHandle.read(buffer, 0, CHUNK_SIZE, fileOffset)).bytesRead
        if (bytesRead === 0) break

        const chunkStr = buffer.toString('utf8', 0, bytesRead)
        const combined = pendingChunkRemainder + chunkStr
        const combinedOffset = pendingChunkRemainder ? pendingRemainderByteOffset : fileOffset

        let lineStart = 0
        while (true) {
          const newlineIdx = combined.indexOf('\n', lineStart)
          if (newlineIdx === -1) {
            pendingChunkRemainder = combined.slice(lineStart)
            pendingRemainderByteOffset =
              combinedOffset + Buffer.byteLength(combined.slice(0, lineStart), 'utf8')
            break
          }

          const rawLine = combined.slice(lineStart, newlineIdx)
          const currentLineEndOffset =
            combinedOffset + Buffer.byteLength(combined.slice(0, newlineIdx + 1), 'utf8')
          lineStart = newlineIdx + 1

          const trimmed = rawLine.trim()
          if (!trimmed) {
            lastValidByteOffset = currentLineEndOffset
            continue
          }

          lineNumber++
          let parsedObj: unknown
          try {
            parsedObj = JSON.parse(trimmed)
          } catch {
            if (currentLineEndOffset < totalSize) {
              throw new JournalCorruptionError(
                `Interior corruption detected in review journal at line ${lineNumber}. Refusing automatic repair to prevent data loss.`
              )
            } else {
              break
            }
          }

          const parseResult = AnnotationJournalEntrySchema.safeParse(parsedObj)
          if (!parseResult.success) {
            if (currentLineEndOffset < totalSize) {
              throw new JournalCorruptionError(
                `Interior corruption detected in review journal at line ${lineNumber} (schema validation failed). Refusing automatic repair to prevent data loss.`
              )
            } else {
              break
            }
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

      if (pendingChunkRemainder.trim().length > 0 || lastValidByteOffset < totalSize) {
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
      let pendingChunkRemainder = ''
      let pendingRemainderByteOffset = 0

      while (fileOffset < totalSize) {
        const bytesRead = fsSync.readSync(fd, buffer, 0, CHUNK_SIZE, fileOffset)
        if (bytesRead === 0) break

        const chunkStr = buffer.toString('utf8', 0, bytesRead)
        const combined = pendingChunkRemainder + chunkStr
        const combinedOffset = pendingChunkRemainder ? pendingRemainderByteOffset : fileOffset

        let lineStart = 0
        while (true) {
          const newlineIdx = combined.indexOf('\n', lineStart)
          if (newlineIdx === -1) {
            pendingChunkRemainder = combined.slice(lineStart)
            pendingRemainderByteOffset =
              combinedOffset + Buffer.byteLength(combined.slice(0, lineStart), 'utf8')
            break
          }

          const rawLine = combined.slice(lineStart, newlineIdx)
          const currentLineEndOffset =
            combinedOffset + Buffer.byteLength(combined.slice(0, newlineIdx + 1), 'utf8')
          lineStart = newlineIdx + 1

          const trimmed = rawLine.trim()
          if (!trimmed) {
            lastValidByteOffset = currentLineEndOffset
            continue
          }

          lineNumber++
          let parsedObj: unknown
          try {
            parsedObj = JSON.parse(trimmed)
          } catch {
            if (currentLineEndOffset < totalSize) {
              throw new JournalCorruptionError(
                `Interior corruption detected in review journal at line ${lineNumber}. Refusing automatic repair to prevent data loss.`
              )
            } else {
              break
            }
          }

          const parseResult = AnnotationJournalEntrySchema.safeParse(parsedObj)
          if (!parseResult.success) {
            if (currentLineEndOffset < totalSize) {
              throw new JournalCorruptionError(
                `Interior corruption detected in review journal at line ${lineNumber} (schema validation failed). Refusing automatic repair to prevent data loss.`
              )
            } else {
              break
            }
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

      if (pendingChunkRemainder.trim().length > 0 || lastValidByteOffset < totalSize) {
        fsSync.ftruncateSync(fd, lastValidByteOffset)
        fsSync.fsyncSync(fd)
      }

      this.latestSeq = expectedSeq - 1
    } finally {
      fsSync.closeSync(fd)
    }
  }

  public async readEntries(): Promise<AnnotationJournalEntry[]> {
    this.assertInitialized()
    const entries: AnnotationJournalEntry[] = []
    const fileHandle = await fs.open(this.journalPath, 'r')
    try {
      const stat = await fileHandle.stat()
      const totalSize = stat.size
      if (totalSize === 0) return []

      const CHUNK_SIZE = 64 * 1024
      const buffer = Buffer.alloc(CHUNK_SIZE)
      let fileOffset = 0
      let pendingRemainder = ''

      while (fileOffset < totalSize) {
        const bytesRead = (await fileHandle.read(buffer, 0, CHUNK_SIZE, fileOffset)).bytesRead
        if (bytesRead === 0) break

        const chunkStr = buffer.toString('utf8', 0, bytesRead)
        const combined = pendingRemainder + chunkStr

        let lineStart = 0
        while (true) {
          const newlineIdx = combined.indexOf('\n', lineStart)
          if (newlineIdx === -1) {
            pendingRemainder = combined.slice(lineStart)
            break
          }
          const rawLine = combined.slice(lineStart, newlineIdx)
          lineStart = newlineIdx + 1
          const trimmed = rawLine.trim()
          if (!trimmed) continue
          const parsed = AnnotationJournalEntrySchema.parse(JSON.parse(trimmed))
          entries.push(parsed)
        }

        fileOffset += bytesRead
      }

      if (pendingRemainder.trim()) {
        const parsed = AnnotationJournalEntrySchema.parse(JSON.parse(pendingRemainder.trim()))
        entries.push(parsed)
      }
    } finally {
      await fileHandle.close()
    }

    return entries
  }

  public readEntriesSync(): AnnotationJournalEntry[] {
    this.assertInitialized()
    const entries: AnnotationJournalEntry[] = []
    const fd = fsSync.openSync(this.journalPath, 'r')
    try {
      const stat = fsSync.fstatSync(fd)
      const totalSize = stat.size
      if (totalSize === 0) return []

      const CHUNK_SIZE = 64 * 1024
      const buffer = Buffer.alloc(CHUNK_SIZE)
      let fileOffset = 0
      let pendingRemainder = ''

      while (fileOffset < totalSize) {
        const bytesRead = fsSync.readSync(fd, buffer, 0, CHUNK_SIZE, fileOffset)
        if (bytesRead === 0) break

        const chunkStr = buffer.toString('utf8', 0, bytesRead)
        const combined = pendingRemainder + chunkStr

        let lineStart = 0
        while (true) {
          const newlineIdx = combined.indexOf('\n', lineStart)
          if (newlineIdx === -1) {
            pendingRemainder = combined.slice(lineStart)
            break
          }
          const rawLine = combined.slice(lineStart, newlineIdx)
          lineStart = newlineIdx + 1
          const trimmed = rawLine.trim()
          if (!trimmed) continue
          const parsed = AnnotationJournalEntrySchema.parse(JSON.parse(trimmed))
          entries.push(parsed)
        }

        fileOffset += bytesRead
      }

      if (pendingRemainder.trim()) {
        const parsed = AnnotationJournalEntrySchema.parse(JSON.parse(pendingRemainder.trim()))
        entries.push(parsed)
      }
    } finally {
      fsSync.closeSync(fd)
    }

    return entries
  }

  public appendEntrySync(
    buildEntry: (nextSeq: number, timestampMs: number) => AnnotationJournalEntry
  ): AnnotationJournalEntry {
    this.assertInitialized()
    const nextSeq = this.latestSeq + 1
    const timestampMs = Date.now()
    const entry = buildEntry(nextSeq, timestampMs)
    const line = JSON.stringify(entry) + '\n'

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
          const nextSeq = this.latestSeq + 1
          const timestampMs = Date.now()
          const entry = buildEntry(nextSeq, timestampMs)
          const line = JSON.stringify(entry) + '\n'

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
