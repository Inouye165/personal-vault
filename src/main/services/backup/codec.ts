/**
 * Personal Vault — Stage 8B Sub-slice 1A-2: Backup Object Codec
 */

import { createHash } from 'node:crypto'
import type { BackupEncryptionMode } from '../../../shared/validation/backup-schemas'
import { BackupSnapshotError } from './errors'

export interface EncodedBackupChunk {
  readonly objectId: string
  readonly storedBytes: Buffer
}

export interface BackupObjectCodec {
  readonly encryptionMode: BackupEncryptionMode
  encodeChunk(plaintextChunk: Buffer, plaintextSha256: string): Promise<EncodedBackupChunk>
  decodeChunk(
    storedBytes: Buffer,
    expectedObjectId: string,
    expectedPlaintextSha256: string
  ): Promise<Buffer>
}

export class PlaintextObjectCodec implements BackupObjectCodec {
  public readonly encryptionMode: BackupEncryptionMode = 'none'

  public async encodeChunk(
    plaintextChunk: Buffer,
    plaintextSha256: string
  ): Promise<EncodedBackupChunk> {
    return {
      objectId: plaintextSha256.toLowerCase(),
      storedBytes: plaintextChunk
    }
  }

  public async decodeChunk(
    storedBytes: Buffer,
    expectedObjectId: string,
    expectedPlaintextSha256: string
  ): Promise<Buffer> {
    const actualSha = createHash('sha256').update(storedBytes).digest('hex')
    if (
      actualSha.toLowerCase() !== expectedObjectId.toLowerCase() ||
      actualSha.toLowerCase() !== expectedPlaintextSha256.toLowerCase()
    ) {
      throw new BackupSnapshotError(
        'destination_corrupt',
        `Chunk SHA-256 mismatch: expected ${expectedPlaintextSha256}, got ${actualSha}`
      )
    }
    return storedBytes
  }
}
