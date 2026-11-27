import { describe, expect, it } from 'vitest'
import {
  VaultIdentitySchema,
  SelectVaultDirectoryResponseSchema,
  InitializeVaultRequestSchema,
  InitializeVaultResponseSchema,
  GetActiveVaultResponseSchema,
  GetImportCandidatesRequestSchema,
  GetImportCandidatesResponseSchema,
  StartImportRequestSchema,
  StartImportResponseSchema,
  VaultImportProgressSchema
} from '../../src/shared/validation/ipc-schemas'

describe('Stage 4 Vault IPC Schemas', () => {
  it('validates VaultIdentitySchema', () => {
    const valid = {
      formatVersion: 1,
      vaultId: 'uuid-1234',
      vaultName: 'Main Vault',
      createdAtMs: 1730000000000,
      appVersion: '0.1.0'
    }
    expect(VaultIdentitySchema.parse(valid)).toEqual(valid)
    expect(() => VaultIdentitySchema.parse({ ...valid, formatVersion: 2 })).toThrow()
  })

  it('validates InitializeVaultRequestSchema', () => {
    const valid = {
      vaultPath: 'D:\\MyVault',
      vaultName: 'Personal Archive'
    }
    expect(InitializeVaultRequestSchema.parse(valid)).toEqual(valid)
    expect(() => InitializeVaultRequestSchema.parse({ vaultPath: '' })).toThrow()
  })

  it('validates StartImportRequestSchema', () => {
    const valid = {
      vaultId: 'vault-uuid-1',
      fileLocationIds: [1, 2, 3]
    }
    expect(StartImportRequestSchema.parse(valid)).toEqual(valid)
    expect(() => StartImportRequestSchema.parse({ vaultId: '', fileLocationIds: [] })).toThrow()
  })

  it('validates VaultImportProgressSchema', () => {
    const valid = {
      jobId: 'job-1',
      vaultId: 'vault-1',
      status: 'running',
      phase: 'copying',
      totalFiles: 10,
      totalBytes: 5000,
      copiedFiles: 3,
      copiedBytes: 1500,
      verifiedFiles: 3,
      failedFiles: 0,
      currentFileName: 'photo.jpg'
    }
    expect(VaultImportProgressSchema.parse(valid)).toEqual(valid)
  })

  it('validates remaining vault request and response schemas', () => {
    expect(SelectVaultDirectoryResponseSchema.parse({ selectedDirectory: 'D:\\Vault' })).toEqual({
      selectedDirectory: 'D:\\Vault'
    })

    const initRes = {
      vault: {
        formatVersion: 1,
        vaultId: 'v-1',
        vaultName: 'Vault',
        createdAtMs: 1730000000000,
        appVersion: '0.1.0'
      }
    }
    expect(InitializeVaultResponseSchema.parse(initRes)).toEqual(initRes)

    expect(GetActiveVaultResponseSchema.parse({ vault: null })).toEqual({ vault: null })

    const candReq = { vaultId: 'v-1', filter: 'all' as const }
    expect(GetImportCandidatesRequestSchema.parse(candReq).vaultId).toBe('v-1')

    const candRes = { items: [], totalCount: 0, offset: 0, limit: 50, hasMore: false }
    expect(GetImportCandidatesResponseSchema.parse(candRes)).toEqual(candRes)

    const job = {
      id: 'job-1',
      vaultId: 'v-1',
      status: 'completed' as const,
      totalFiles: 0,
      totalBytes: 0,
      copiedFiles: 0,
      copiedBytes: 0,
      verifiedFiles: 0,
      failedFiles: 0,
      startedAtMs: 1730000000000
    }
    expect(StartImportResponseSchema.parse({ job })).toEqual({ job })
  })
})
