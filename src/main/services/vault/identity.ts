/**
 * Personal Vault — Vault Identity Management (Stage 4)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { VaultIdentitySchema, type VaultIdentity } from '../../../shared/validation/ipc-schemas'
import { VaultNotInitializedError } from './errors'

const VAULT_IDENTITY_FILENAME = 'vault.json'
const CURRENT_APP_VERSION = '0.1.0'

export function getVaultIdentityPath(vaultPath: string): string {
  return join(vaultPath, VAULT_IDENTITY_FILENAME)
}

export function isVaultDirectory(vaultPath: string): boolean {
  const filePath = getVaultIdentityPath(vaultPath)
  if (!existsSync(filePath)) {
    return false
  }
  try {
    const raw = readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw)
    VaultIdentitySchema.parse(parsed)
    return true
  } catch {
    return false
  }
}

export function loadVaultIdentity(vaultPath: string): VaultIdentity {
  const filePath = getVaultIdentityPath(vaultPath)
  if (!existsSync(filePath)) {
    throw new VaultNotInitializedError(vaultPath)
  }
  try {
    const raw = readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw)
    return VaultIdentitySchema.parse(parsed)
  } catch (err) {
    if (err instanceof VaultNotInitializedError) throw err
    throw new VaultNotInitializedError(
      `${vaultPath} (identity file invalid: ${(err as Error).message})`
    )
  }
}

export interface InitializeVaultOptions {
  readonly vaultPath: string
  readonly vaultName: string
}

export function initializeVault(options: InitializeVaultOptions): VaultIdentity {
  if (!options.vaultPath || typeof options.vaultPath !== 'string') {
    throw new TypeError('vaultPath must be a non-empty string')
  }
  if (!options.vaultName || typeof options.vaultName !== 'string') {
    throw new TypeError('vaultName must be a non-empty string')
  }

  mkdirSync(options.vaultPath, { recursive: true })

  // If vault.json already exists and is valid, return existing identity
  if (isVaultDirectory(options.vaultPath)) {
    return loadVaultIdentity(options.vaultPath)
  }

  const identity: VaultIdentity = {
    formatVersion: 1,
    vaultId: randomUUID(),
    vaultName: options.vaultName.trim(),
    createdAtMs: Date.now(),
    appVersion: CURRENT_APP_VERSION
  }

  const filePath = getVaultIdentityPath(options.vaultPath)
  writeFileSync(filePath, JSON.stringify(identity, null, 2), 'utf-8')

  return identity
}
