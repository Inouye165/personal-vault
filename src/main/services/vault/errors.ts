/**
 * Personal Vault — Vault Domain Errors (Stage 4)
 */

export class VaultError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VaultError'
  }
}

export class VaultNotInitializedError extends VaultError {
  constructor(path: string) {
    super(`Directory is not an initialized Personal Vault: "${path}"`)
    this.name = 'VaultNotInitializedError'
  }
}

export class VaultOverlapError extends VaultError {
  constructor(message: string) {
    super(`Unsafe vault/source storage overlap: ${message}`)
    this.name = 'VaultOverlapError'
  }
}

export class SourceChangedError extends VaultError {
  constructor(path: string, reason: string) {
    super(`Source file "${path}" changed or became unstable: ${reason}`)
    this.name = 'SourceChangedError'
  }
}

export class HashMismatchError extends VaultError {
  constructor(expected: string, actual: string, context: string) {
    super(`Integrity verification failed for ${context}: expected ${expected}, got ${actual}`)
    this.name = 'HashMismatchError'
  }
}

export class DestinationCollisionError extends VaultError {
  constructor(path: string) {
    super(
      `Unsafe destination collision: file already exists at "${path}" with non-matching content`
    )
    this.name = 'DestinationCollisionError'
  }
}

export class StaleImportError extends VaultError {
  constructor(message: string) {
    super(`Stale import state: ${message}`)
    this.name = 'StaleImportError'
  }
}
