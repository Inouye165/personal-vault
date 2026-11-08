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
 * - Safe crash recovery: truncates malformed trailing partial lines on restart.
 * - Truthful error reporting on write failure without advancing sequence state.
 */

import { promises as fs } from 'node:fs'
import * as fsSync from 'node:fs'
import { join } from 'node:path'
import {
  AnnotationJournalEntrySchema,
  type AnnotationJournalEntry
} from '../../../shared/validation/ipc-schemas'

export interface AnnotationJournalOptions {
  readonly storageDir: string
  readonly customAppender?: (filePath: string, line: string) => Promise<void>
  readonly customAppenderSync?: (filePath: string, line: string) => void
}

export class AnnotationJournal {
  private readonly storageDir: string
  private readonly ownerMarkerPath: string
  private readonly journalPath: string
  private readonly customAppender?: (filePath: string, line: string) => Promise<void>
  private readonly customAppenderSync?: (filePath: string, line: string) => void

  private writeLockChain: Promise<void> = Promise.resolve()
  private latestSeq = 0
  private isInitialized = false

  constructor(options: AnnotationJournalOptions) {
    this.storageDir = options.storageDir
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
    await fs.mkdir(this.storageDir, { recursive: true })

    // 1. Establish ownership marker if missing
    try {
      await fs.stat(this.ownerMarkerPath)
    } catch {
      await fs.writeFile(
        this.ownerMarkerPath,
        JSON.stringify({
          app: 'personal-vault',
          format: 'personal-vault-review-journal',
          version: '1.0.0',
          createdAtMs: Date.now()
        }),
        'utf8'
      )
    }

    // 2. Ensure journal file exists and recover from partial writes
    try {
      await fs.stat(this.journalPath)
    } catch {
      await fs.writeFile(this.journalPath, '', 'utf8')
      this.latestSeq = 0
      this.isInitialized = true
      return
    }

    await this.recoverAndReconcile()
    this.isInitialized = true
  }

  /**
   * Synchronous initialization for synchronous catalog startup.
   */
  public initializeSync(): void {
    fsSync.mkdirSync(this.storageDir, { recursive: true })

    try {
      fsSync.statSync(this.ownerMarkerPath)
    } catch {
      fsSync.writeFileSync(
        this.ownerMarkerPath,
        JSON.stringify({
          app: 'personal-vault',
          format: 'personal-vault-review-journal',
          version: '1.0.0',
          createdAtMs: Date.now()
        }),
        'utf8'
      )
    }

    try {
      fsSync.statSync(this.journalPath)
    } catch {
      fsSync.writeFileSync(this.journalPath, '', 'utf8')
      this.latestSeq = 0
      this.isInitialized = true
      return
    }

    this.recoverAndReconcileSync()
    this.isInitialized = true
  }

  /**
   * Reads existing lines, validates each with Zod, and truncates trailing malformed
   * lines resulting from mid-flight crashes or power cuts.
   */
  private async recoverAndReconcile(): Promise<void> {
    const raw = await fs.readFile(this.journalPath, 'utf8')
    this.reconcileRawContent(raw, (clean) => fs.writeFile(this.journalPath, clean, 'utf8'))
  }

  private recoverAndReconcileSync(): void {
    const raw = fsSync.readFileSync(this.journalPath, 'utf8')
    this.reconcileRawContent(raw, (clean) => fsSync.writeFileSync(this.journalPath, clean, 'utf8'))
  }

  private reconcileRawContent(
    raw: string,
    writeFn: (content: string) => Promise<void> | void
  ): void {
    if (raw.length === 0) {
      this.latestSeq = 0
      return
    }

    const lines = raw.split(/\r?\n/)
    const validLines: string[] = []
    let maxSeq = 0
    let hadCorruptTail = false

    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i]
      if (rawLine === undefined) continue
      const line = rawLine.trim()
      if (!line) continue

      try {
        const obj = JSON.parse(line)
        const parsed = AnnotationJournalEntrySchema.parse(obj)
        validLines.push(JSON.stringify(parsed))
        if (parsed.entrySeq > maxSeq) {
          maxSeq = parsed.entrySeq
        }
      } catch {
        hadCorruptTail = true
        break
      }
    }

    if (hadCorruptTail) {
      const repairedContent = validLines.length > 0 ? validLines.join('\n') + '\n' : ''
      void writeFn(repairedContent)
    }

    this.latestSeq = maxSeq
  }

  public async readEntries(): Promise<AnnotationJournalEntry[]> {
    this.assertInitialized()
    const raw = await fs.readFile(this.journalPath, 'utf8')
    const lines = raw.split(/\r?\n/)
    const entries: AnnotationJournalEntry[] = []

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const parsed = AnnotationJournalEntrySchema.parse(JSON.parse(trimmed))
      entries.push(parsed)
    }

    return entries
  }

  public readEntriesSync(): AnnotationJournalEntry[] {
    this.assertInitialized()
    const raw = fsSync.readFileSync(this.journalPath, 'utf8')
    const lines = raw.split(/\r?\n/)
    const entries: AnnotationJournalEntry[] = []

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const parsed = AnnotationJournalEntrySchema.parse(JSON.parse(trimmed))
      entries.push(parsed)
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
      // If only async appender provided in sync context, execute directly
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
          } else if (this.customAppenderSync) {
            this.customAppenderSync(this.journalPath, line)
          } else {
            const handle = await fs.open(this.journalPath, 'a')
            try {
              await handle.write(line, null, 'utf8')
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

  public async appendPhotoAnnotation(data: {
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
    return this.appendEntry((seq, ts) => ({
      entrySeq: seq,
      entryTimestampMs: ts,
      kind: 'photo_annotation',
      locationId: data.locationId,
      normalizedPath: data.normalizedPath,
      originalPath: data.originalPath,
      byteSize: data.byteSize,
      filesystemMtimeMs: data.filesystemMtimeMs,
      activeHash: data.activeHash,
      discoveryObservationId: data.discoveryObservationId,
      expectedRevision: data.expectedRevision,
      version: data.version,
      rating: data.rating,
      flag: data.flag
    }))
  }

  public appendPhotoAnnotationSync(data: {
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
    return this.appendEntrySync((seq, ts) => ({
      entrySeq: seq,
      entryTimestampMs: ts,
      kind: 'photo_annotation',
      locationId: data.locationId,
      normalizedPath: data.normalizedPath,
      originalPath: data.originalPath,
      byteSize: data.byteSize,
      filesystemMtimeMs: data.filesystemMtimeMs,
      activeHash: data.activeHash,
      discoveryObservationId: data.discoveryObservationId,
      expectedRevision: data.expectedRevision,
      version: data.version,
      rating: data.rating,
      flag: data.flag
    }))
  }

  public async appendCollectionCreated(data: {
    collectionId: number
    name: string
    normalizedName: string
  }): Promise<AnnotationJournalEntry> {
    return this.appendEntry((seq, ts) => ({
      entrySeq: seq,
      entryTimestampMs: ts,
      kind: 'collection_created',
      collectionId: data.collectionId,
      name: data.name,
      normalizedName: data.normalizedName
    }))
  }

  public appendCollectionCreatedSync(data: {
    collectionId: number
    name: string
    normalizedName: string
  }): AnnotationJournalEntry {
    return this.appendEntrySync((seq, ts) => ({
      entrySeq: seq,
      entryTimestampMs: ts,
      kind: 'collection_created',
      collectionId: data.collectionId,
      name: data.name,
      normalizedName: data.normalizedName
    }))
  }

  public async appendCollectionRenamed(data: {
    collectionId: number
    oldName: string
    newName: string
    normalizedName: string
  }): Promise<AnnotationJournalEntry> {
    return this.appendEntry((seq, ts) => ({
      entrySeq: seq,
      entryTimestampMs: ts,
      kind: 'collection_renamed',
      collectionId: data.collectionId,
      oldName: data.oldName,
      newName: data.newName,
      normalizedName: data.normalizedName
    }))
  }

  public appendCollectionRenamedSync(data: {
    collectionId: number
    oldName: string
    newName: string
    normalizedName: string
  }): AnnotationJournalEntry {
    return this.appendEntrySync((seq, ts) => ({
      entrySeq: seq,
      entryTimestampMs: ts,
      kind: 'collection_renamed',
      collectionId: data.collectionId,
      oldName: data.oldName,
      newName: data.newName,
      normalizedName: data.normalizedName
    }))
  }

  public async appendMembershipAdded(data: {
    collectionId: number
    collectionName: string
    locationId: number
    normalizedPath: string
    byteSize: number
    activeHash: string | null
    discoveryObservationId: number
  }): Promise<AnnotationJournalEntry> {
    return this.appendEntry((seq, ts) => ({
      entrySeq: seq,
      entryTimestampMs: ts,
      kind: 'membership_added',
      collectionId: data.collectionId,
      collectionName: data.collectionName,
      locationId: data.locationId,
      normalizedPath: data.normalizedPath,
      byteSize: data.byteSize,
      activeHash: data.activeHash,
      discoveryObservationId: data.discoveryObservationId
    }))
  }

  public appendMembershipAddedSync(data: {
    collectionId: number
    collectionName: string
    locationId: number
    normalizedPath: string
    byteSize: number
    activeHash: string | null
    discoveryObservationId: number
  }): AnnotationJournalEntry {
    return this.appendEntrySync((seq, ts) => ({
      entrySeq: seq,
      entryTimestampMs: ts,
      kind: 'membership_added',
      collectionId: data.collectionId,
      collectionName: data.collectionName,
      locationId: data.locationId,
      normalizedPath: data.normalizedPath,
      byteSize: data.byteSize,
      activeHash: data.activeHash,
      discoveryObservationId: data.discoveryObservationId
    }))
  }

  public async appendMembershipRemoved(data: {
    collectionId: number
    collectionName: string
    locationId: number
    normalizedPath: string
  }): Promise<AnnotationJournalEntry> {
    return this.appendEntry((seq, ts) => ({
      entrySeq: seq,
      entryTimestampMs: ts,
      kind: 'membership_removed',
      collectionId: data.collectionId,
      collectionName: data.collectionName,
      locationId: data.locationId,
      normalizedPath: data.normalizedPath
    }))
  }

  public appendMembershipRemovedSync(data: {
    collectionId: number
    collectionName: string
    locationId: number
    normalizedPath: string
  }): AnnotationJournalEntry {
    return this.appendEntrySync((seq, ts) => ({
      entrySeq: seq,
      entryTimestampMs: ts,
      kind: 'membership_removed',
      collectionId: data.collectionId,
      collectionName: data.collectionName,
      locationId: data.locationId,
      normalizedPath: data.normalizedPath
    }))
  }

  private assertInitialized(): void {
    if (!this.isInitialized) {
      throw new Error('AnnotationJournal must be initialized before use')
    }
  }
}
