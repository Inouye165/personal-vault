/**
 * Personal Vault — Vault Identity Management (Stage 4)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { VaultIdentitySchema, type VaultIdentity } from '../../../shared/validation/ipc-schemas'
import { VaultInitializationError, VaultNotInitializedError } from './errors'
import { assertPathContainedInVault } from './containment'

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
  assertPathContainedInVault(vaultPath, filePath, 'vault identity path')
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

  const filePath = getVaultIdentityPath(options.vaultPath)
  assertPathContainedInVault(options.vaultPath, filePath, 'vault identity path')

  // If vault.json already exists:
  // If it's a valid Personal Vault identity, return it.
  // If it's invalid or unrelated, throw VaultInitializationError without overwriting it.
  if (existsSync(filePath)) {
    try {
      const raw = readFileSync(filePath, 'utf-8')
      const parsed = JSON.parse(raw)
      return VaultIdentitySchema.parse(parsed)
    } catch (err) {
      throw new VaultInitializationError(
        options.vaultPath,
        `Existing vault.json is invalid or unrelated: ${(err as Error).message}`
      )
    }
  }

  const identity: VaultIdentity = {
    formatVersion: 1,
    vaultId: randomUUID(),
    vaultName: options.vaultName.trim(),
    createdAtMs: Date.now(),
    appVersion: CURRENT_APP_VERSION
  }

  try {
    writeFileSync(filePath, JSON.stringify(identity, null, 2), {
      encoding: 'utf-8',
      flag: 'wx'
    })
  } catch (err) {
    throw new VaultInitializationError(
      options.vaultPath,
      `Could not write vault.json: ${(err as Error).message}`
    )
  }

  return identity
}
