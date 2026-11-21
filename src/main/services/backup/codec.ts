/**
 * Personal Vault — Stage 8B Backup Object Codec
 *
 * Defines chunk and manifest encoding/decoding for plaintext (`none`) and
 * authenticated-encrypted (`aes-256-gcm-v1`) backup repositories.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual
} from 'node:crypto'
import type {
  BackupEncryptionKdfParams,
  BackupEncryptionMetadata,
  BackupEncryptionMode
} from '../../../shared/validation/backup-schemas'
import { BackupRestoreError, BackupSnapshotError } from './errors'
import { BACKUP_SNAPSHOT_ENCRYPTED_MANIFEST_FILE, BACKUP_SNAPSHOT_MANIFEST_FILE } from './transport'

const AES_256_GCM_NONCE_BYTES = 12
const AES_256_GCM_TAG_BYTES = 16
const AES_256_KEY_BYTES = 32
const SCRYPT_MAXMEM_BYTES = 128 * 1024 * 1024
const MIN_SCRYPT_N = 1024
const MAX_SCRYPT_N = 1048576
const MAX_SCRYPT_R = 64
const MAX_SCRYPT_P = 16

export const DEFAULT_BACKUP_SCRYPT_KDF_PARAMS: BackupEncryptionKdfParams = {
  N: 32768,
  r: 8,
  p: 1,
  keyLenBytes: AES_256_KEY_BYTES
}

export interface EncodedBackupChunk {
  readonly objectId: string
  readonly storedBytes: Buffer
}

export interface BackupObjectCodec {
  readonly encryptionMode: BackupEncryptionMode
  readonly manifestFileName: string
  encodeChunk(plaintextChunk: Buffer, plaintextSha256: string): Promise<EncodedBackupChunk>
  decodeChunk(
    storedBytes: Buffer,
    expectedObjectId: string,
    expectedPlaintextSha256: string
  ): Promise<Buffer>
  encodeManifest(plaintextManifestBytes: Buffer, snapshotId: string): Promise<Buffer>
  decodeManifest(storedManifestBytes: Buffer, snapshotId: string): Promise<Buffer>
}

function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function sealAes256Gcm(key: Buffer, plaintext: Buffer, aad: Buffer): Buffer {
  const nonce = randomBytes(AES_256_GCM_NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(aad)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const authTag = cipher.getAuthTag()
  return Buffer.concat([nonce, authTag, ciphertext])
}

function openAes256Gcm(key: Buffer, envelope: Buffer, aad: Buffer, label: string): Buffer {
  const headerLen = AES_256_GCM_NONCE_BYTES + AES_256_GCM_TAG_BYTES
  if (envelope.length < headerLen) {
    throw new BackupSnapshotError(
      'destination_corrupt',
      `Truncated AES-256-GCM envelope for ${label}: ${envelope.length} bytes`
    )
  }
  const nonce = envelope.subarray(0, AES_256_GCM_NONCE_BYTES)
  const authTag = envelope.subarray(AES_256_GCM_NONCE_BYTES, headerLen)
  const ciphertext = envelope.subarray(headerLen)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAuthTag(authTag)
    decipher.setAAD(aad)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch (err) {
    throw new BackupSnapshotError(
      'destination_corrupt',
      `AES-256-GCM authentication failed for ${label}: ${(err as Error).message}`
    )
  }
}

function deriveSubkey(masterKey: Buffer, repositoryId: string, info: string): Buffer {
  const derived = hkdfSync(
    'sha256',
    masterKey,
    Buffer.from(repositoryId, 'utf8'),
    Buffer.from(info, 'utf8'),
    AES_256_KEY_BYTES
  )
  return Buffer.from(derived)
}

function computeKeyCheckTag(masterKey: Buffer, repositoryId: string, keyId: string): Buffer {
  return createHmac('sha256', masterKey)
    .update(`pv-backup-keycheck-v1:${repositoryId}:${keyId}`)
    .digest()
}

function validateScryptKdfParams(
  kdfParams: BackupEncryptionKdfParams,
  onInvalid: (msg: string) => never
): void {
  const { N, r, p, keyLenBytes } = kdfParams
  if (!Number.isInteger(N) || N < MIN_SCRYPT_N || N > MAX_SCRYPT_N || (N & (N - 1)) !== 0) {
    onInvalid(`Unsupported scrypt N parameter: ${N}`)
  }
  if (!Number.isInteger(r) || r < 1 || r > MAX_SCRYPT_R) {
    onInvalid(`Unsupported scrypt r parameter: ${r}`)
  }
  if (!Number.isInteger(p) || p < 1 || p > MAX_SCRYPT_P) {
    onInvalid(`Unsupported scrypt p parameter: ${p}`)
  }
  if (keyLenBytes !== AES_256_KEY_BYTES) {
    onInvalid(`Unsupported scrypt keyLenBytes parameter: ${keyLenBytes}`)
  }
  const estimatedMemoryBytes = 128 * N * r * p
  if (!Number.isFinite(estimatedMemoryBytes) || estimatedMemoryBytes > SCRYPT_MAXMEM_BYTES) {
    onInvalid(
      `Excessive scrypt memory requirement (${estimatedMemoryBytes} bytes exceeds ${SCRYPT_MAXMEM_BYTES})`
    )
  }
}

async function deriveKek(
  recoverySecret: string,
  salt: Buffer,
  kdfParams: BackupEncryptionKdfParams,
  onInvalid: (msg: string) => never
): Promise<Buffer> {
  validateScryptKdfParams(kdfParams, onInvalid)
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(
      Buffer.from(recoverySecret, 'utf8'),
      salt,
      kdfParams.keyLenBytes,
      {
        N: kdfParams.N,
        r: kdfParams.r,
        p: kdfParams.p,
        maxmem: SCRYPT_MAXMEM_BYTES
      },
      (err, derivedKey) => {
        if (err) {
          reject(err)
          return
        }
        resolve(derivedKey)
      }
    )
  })
}

export class PlaintextObjectCodec implements BackupObjectCodec {
  public readonly encryptionMode: BackupEncryptionMode = 'none'
  public readonly manifestFileName: string = BACKUP_SNAPSHOT_MANIFEST_FILE

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
    const actualSha = sha256Hex(storedBytes).toLowerCase()
    if (
      actualSha !== expectedObjectId.toLowerCase() ||
      actualSha !== expectedPlaintextSha256.toLowerCase()
    ) {
      throw new BackupSnapshotError(
        'destination_corrupt',
        `Chunk integrity mismatch: expected ${expectedPlaintextSha256}, got ${actualSha}`
      )
    }
    return storedBytes
  }

  public async encodeManifest(plaintextManifestBytes: Buffer): Promise<Buffer> {
    return plaintextManifestBytes
  }

  public async decodeManifest(storedManifestBytes: Buffer): Promise<Buffer> {
    return storedManifestBytes
  }
}

export interface CreateAes256GcmCodecOptions {
  readonly repositoryId: string
  readonly recoverySecret: string
  readonly kdfParams?: BackupEncryptionKdfParams
}

export interface UnlockAes256GcmCodecOptions {
  readonly repositoryId: string
  readonly encryption: BackupEncryptionMetadata | null
  readonly recoverySecret?: string
  readonly errorDomain?: 'backup' | 'restore'
}

export class Aes256GcmObjectCodec implements BackupObjectCodec {
  public readonly encryptionMode: BackupEncryptionMode = 'aes-256-gcm-v1'
  public readonly manifestFileName: string = BACKUP_SNAPSHOT_ENCRYPTED_MANIFEST_FILE

  public readonly repositoryId: string
  public readonly keyId: string
  private readonly keyCheckTag: Buffer
  private readonly chunkKey: Buffer
  private readonly dedupSubkey: Buffer
  private readonly manifestKey: Buffer

  private constructor(
    repositoryId: string,
    keyId: string,
    keyCheckTag: Buffer,
    chunkKey: Buffer,
    dedupSubkey: Buffer,
    manifestKey: Buffer
  ) {
    this.repositoryId = repositoryId
    this.keyId = keyId
    this.keyCheckTag = keyCheckTag
    this.chunkKey = chunkKey
    this.dedupSubkey = dedupSubkey
    this.manifestKey = manifestKey
  }

  public matchesRepositoryEncryption(
    repositoryId: string,
    encryption: BackupEncryptionMetadata | null
  ): boolean {
    if (!encryption) return false
    if (this.repositoryId !== repositoryId || this.keyId !== encryption.keyId) {
      return false
    }
    const expectedTag = Buffer.from(encryption.keyCheckTagBase64, 'base64')
    return (
      expectedTag.length === this.keyCheckTag.length &&
      timingSafeEqual(this.keyCheckTag, expectedTag)
    )
  }

  public static async createForNewRepository(options: CreateAes256GcmCodecOptions): Promise<{
    readonly codec: Aes256GcmObjectCodec
    readonly encryptionMetadata: BackupEncryptionMetadata
  }> {
    if (!options.recoverySecret || options.recoverySecret.length === 0) {
      throw new BackupSnapshotError(
        'recovery_secret_required',
        'A non-empty recovery secret is required for encrypted backup repositories'
      )
    }

    const kdfParams = options.kdfParams ?? DEFAULT_BACKUP_SCRYPT_KDF_PARAMS
    const keyId = randomUUID()
    const salt = randomBytes(32)
    const masterKey = randomBytes(AES_256_KEY_BYTES)
    const keyWrapNonce = randomBytes(AES_256_GCM_NONCE_BYTES)
    const kek = await deriveKek(options.recoverySecret, salt, kdfParams, (msg) => {
      throw new BackupSnapshotError('backup_staging_error', msg)
    })

    try {
      const cipher = createCipheriv('aes-256-gcm', kek, keyWrapNonce)
      cipher.setAAD(Buffer.from(`pv-backup-keywrap-v1:${options.repositoryId}:${keyId}`, 'utf8'))
      const wrappedMasterKey = Buffer.concat([cipher.update(masterKey), cipher.final()])
      const keyWrapTag = cipher.getAuthTag()
      const keyCheckTag = computeKeyCheckTag(masterKey, options.repositoryId, keyId)

      const codec = new Aes256GcmObjectCodec(
        options.repositoryId,
        keyId,
        keyCheckTag,
        deriveSubkey(masterKey, options.repositoryId, 'pv-backup-chunk-v1'),
        deriveSubkey(masterKey, options.repositoryId, 'pv-backup-dedup-v1'),
        deriveSubkey(masterKey, options.repositoryId, 'pv-backup-manifest-v1')
      )

      return {
        codec,
        encryptionMetadata: {
          kdf: 'scrypt',
          kdfParams,
          saltBase64: salt.toString('base64'),
          wrappedMasterKeyBase64: wrappedMasterKey.toString('base64'),
          keyWrapNonceBase64: keyWrapNonce.toString('base64'),
          keyWrapTagBase64: keyWrapTag.toString('base64'),
          keyCheckTagBase64: keyCheckTag.toString('base64'),
          keyId
        }
      }
    } finally {
      kek.fill(0)
      masterKey.fill(0)
    }
  }

  public static async unlockFromRepository(
    options: UnlockAes256GcmCodecOptions
  ): Promise<Aes256GcmObjectCodec> {
    const domain = options.errorDomain ?? 'restore'
    const throwMissingSecret = (msg: string): never => {
      if (domain === 'backup') {
        throw new BackupSnapshotError('recovery_secret_required', msg)
      }
      throw new BackupRestoreError('recovery_secret_required', msg)
    }
    const throwWrongSecret = (msg: string): never => {
      if (domain === 'backup') {
        throw new BackupSnapshotError('wrong_recovery_secret', msg)
      }
      throw new BackupRestoreError('wrong_recovery_secret', msg)
    }
    const throwCorruptMeta = (msg: string): never => {
      if (domain === 'backup') {
        throw new BackupSnapshotError('destination_corrupt', msg)
      }
      throw new BackupRestoreError('repository_invalid', msg)
    }

    if (!options.encryption) {
      throwCorruptMeta('Encrypted repository is missing encryption metadata')
    }
    if (!options.recoverySecret || options.recoverySecret.length === 0) {
      throwMissingSecret('Recovery secret is required to unlock encrypted backup repository')
    }

    const enc = options.encryption!
    const salt = Buffer.from(enc.saltBase64, 'base64')
    const wrappedMasterKey = Buffer.from(enc.wrappedMasterKeyBase64, 'base64')
    const keyWrapNonce = Buffer.from(enc.keyWrapNonceBase64, 'base64')
    const keyWrapTag = Buffer.from(enc.keyWrapTagBase64, 'base64')
    const expectedKeyCheckTag = Buffer.from(enc.keyCheckTagBase64, 'base64')

    if (
      salt.length < 16 ||
      wrappedMasterKey.length !== AES_256_KEY_BYTES ||
      keyWrapNonce.length !== AES_256_GCM_NONCE_BYTES ||
      keyWrapTag.length !== AES_256_GCM_TAG_BYTES ||
      expectedKeyCheckTag.length !== 32
    ) {
      throwCorruptMeta('Encrypted repository contains malformed key-wrapping metadata')
    }

    const kek = await deriveKek(options.recoverySecret!, salt, enc.kdfParams, throwCorruptMeta)
    let masterKey = Buffer.alloc(0)
    try {
      const decipher = createDecipheriv('aes-256-gcm', kek, keyWrapNonce)
      decipher.setAuthTag(keyWrapTag)
      decipher.setAAD(
        Buffer.from(`pv-backup-keywrap-v1:${options.repositoryId}:${enc.keyId}`, 'utf8')
      )
      masterKey = Buffer.concat([decipher.update(wrappedMasterKey), decipher.final()])
    } catch {
      throwWrongSecret('Invalid recovery secret: failed to unwrap backup repository master key')
    } finally {
      kek.fill(0)
    }

    try {
      if (masterKey.length !== AES_256_KEY_BYTES) {
        throwWrongSecret('Invalid recovery secret: unwrapped master key length mismatch')
      }
      const actualKeyCheckTag = computeKeyCheckTag(masterKey, options.repositoryId, enc.keyId)
      if (
        actualKeyCheckTag.length !== expectedKeyCheckTag.length ||
        !timingSafeEqual(actualKeyCheckTag, expectedKeyCheckTag)
      ) {
        throwWrongSecret('Invalid recovery secret: key check tag mismatch')
      }

      return new Aes256GcmObjectCodec(
        options.repositoryId,
        enc.keyId,
        actualKeyCheckTag,
        deriveSubkey(masterKey, options.repositoryId, 'pv-backup-chunk-v1'),
        deriveSubkey(masterKey, options.repositoryId, 'pv-backup-dedup-v1'),
        deriveSubkey(masterKey, options.repositoryId, 'pv-backup-manifest-v1')
      )
    } finally {
      masterKey.fill(0)
    }
  }

  public async encodeChunk(plaintextChunk: Buffer): Promise<EncodedBackupChunk> {
    const objectId = createHmac('sha256', this.dedupSubkey).update(plaintextChunk).digest('hex')
    const aad = Buffer.from(
      `pv-chunk-v1:${this.repositoryId}:${objectId}:${plaintextChunk.length}`,
      'utf8'
    )
    const storedBytes = sealAes256Gcm(this.chunkKey, plaintextChunk, aad)
    return { objectId, storedBytes }
  }

  public async decodeChunk(
    storedBytes: Buffer,
    expectedObjectId: string,
    expectedPlaintextSha256: string
  ): Promise<Buffer> {
    const headerLen = AES_256_GCM_NONCE_BYTES + AES_256_GCM_TAG_BYTES
    if (storedBytes.length < headerLen) {
      throw new BackupSnapshotError(
        'destination_corrupt',
        `Truncated encrypted chunk ${expectedObjectId}: ${storedBytes.length} bytes`
      )
    }
    const lowerObjectId = expectedObjectId.toLowerCase()
    const plaintextByteSize = storedBytes.length - headerLen
    const aad = Buffer.from(
      `pv-chunk-v1:${this.repositoryId}:${lowerObjectId}:${plaintextByteSize}`,
      'utf8'
    )
    const plaintext = openAes256Gcm(this.chunkKey, storedBytes, aad, `chunk ${lowerObjectId}`)

    const actualObjectId = createHmac('sha256', this.dedupSubkey).update(plaintext).digest('hex')
    if (
      actualObjectId.length !== lowerObjectId.length ||
      !timingSafeEqual(Buffer.from(actualObjectId, 'utf8'), Buffer.from(lowerObjectId, 'utf8'))
    ) {
      throw new BackupSnapshotError(
        'destination_corrupt',
        `Encrypted chunk keyed objectId mismatch: expected ${lowerObjectId}, got ${actualObjectId}`
      )
    }

    const actualSha = sha256Hex(plaintext).toLowerCase()
    if (actualSha !== expectedPlaintextSha256.toLowerCase()) {
      throw new BackupSnapshotError(
        'destination_corrupt',
        `Encrypted chunk plaintext SHA-256 mismatch: expected ${expectedPlaintextSha256}, got ${actualSha}`
      )
    }

    return plaintext
  }

  public async encodeManifest(plaintextManifestBytes: Buffer, snapshotId: string): Promise<Buffer> {
    const aad = Buffer.from(`pv-manifest-v1:${this.repositoryId}:${snapshotId}`, 'utf8')
    return sealAes256Gcm(this.manifestKey, plaintextManifestBytes, aad)
  }

  public async decodeManifest(storedManifestBytes: Buffer, snapshotId: string): Promise<Buffer> {
    const aad = Buffer.from(`pv-manifest-v1:${this.repositoryId}:${snapshotId}`, 'utf8')
    return openAes256Gcm(this.manifestKey, storedManifestBytes, aad, `manifest ${snapshotId}`)
  }
}
