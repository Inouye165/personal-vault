import { describe, it, expect } from 'vitest'
import {
  AppInfoSchema,
  NavigationTabSchema,
  VaultStatusSchema,
  SearchQuerySchema,
  ScanJobProgressSchema,
  StartScanRequestSchema,
  JobIdRequestSchema,
  SelectRootsResponseSchema,
  JobActionResponseSchema,
  validatePayload
} from '../../src/shared/validation/ipc-schemas.js'

describe('IPC Boundary Schemas and Runtime Validation', () => {
  describe('AppInfoSchema', () => {
    it('accepts a valid AppInfo object', () => {
      const valid = {
        name: 'Personal Vault',
        version: '0.1.0',
        platform: 'win32',
        isPackaged: false
      }
      const res = validatePayload(AppInfoSchema, valid)
      expect(res.success).toBe(true)
      if (res.success) {
        expect(res.data.name).toBe('Personal Vault')
        expect(res.data.version).toBe('0.1.0')
      }
    })

    it('rejects an AppInfo object missing required fields', () => {
      const invalid = {
        name: 'Personal Vault'
      }
      const res = validatePayload(AppInfoSchema, invalid)
      expect(res.success).toBe(false)
      if (!res.success) {
        expect(res.error).toContain('version')
      }
    })

    it('rejects an AppInfo object with empty strings or bad types', () => {
      const invalid = {
        name: '',
        version: '0.1.0',
        platform: 'win32',
        isPackaged: 'false' // string instead of boolean
      }
      const res = validatePayload(AppInfoSchema, invalid)
      expect(res.success).toBe(false)
    })
  })

  describe('NavigationTabSchema', () => {
    const expectedTabs = ['all', 'photos', 'documents', 'review', 'duplicates'] as const

    it('accepts every designated Personal Vault tab', () => {
      for (const tab of expectedTabs) {
        const res = validatePayload(NavigationTabSchema, tab)
        expect(res.success).toBe(true)
      }
    })

    it('rejects arbitrary or unsupported navigation routes', () => {
      const invalidTabs = ['settings', 'cloud', 'trash', '', 123]
      for (const tab of invalidTabs) {
        const res = validatePayload(NavigationTabSchema, tab)
        expect(res.success).toBe(false)
      }
    })
  })

  describe('VaultStatusSchema', () => {
    it('accepts honest initial Stage 1 status', () => {
      const status = {
        sourceCount: 0,
        itemCount: 0,
        isReady: true
      }
      const res = validatePayload(VaultStatusSchema, status)
      expect(res.success).toBe(true)
    })

    it('rejects negative numbers for sources or item counts', () => {
      const invalid = {
        sourceCount: -1,
        itemCount: 0,
        isReady: true
      }
      const res = validatePayload(VaultStatusSchema, invalid)
      expect(res.success).toBe(false)
      if (!res.success) {
        expect(res.error).toContain('sourceCount')
      }
    })

    it('rejects non-integer counts', () => {
      const invalid = {
        sourceCount: 1.5,
        itemCount: 0,
        isReady: true
      }
      const res = validatePayload(VaultStatusSchema, invalid)
      expect(res.success).toBe(false)
    })
  })

  describe('SearchQuerySchema', () => {
    it('accepts valid search queries within bounds', () => {
      const valid = {
        query: 'vacation invoice 2024',
        tab: 'photos'
      }
      const res = validatePayload(SearchQuerySchema, valid)
      expect(res.success).toBe(true)
    })

    it('rejects oversized search queries', () => {
      const invalid = {
        query: 'a'.repeat(300)
      }
      const res = validatePayload(SearchQuerySchema, invalid)
      expect(res.success).toBe(false)
    })
  })

  describe('ScanJobProgressSchema', () => {
    it('accepts a fully populated valid progress payload', () => {
      const valid = {
        jobId: 1,
        status: 'running',
        phase: 'hashing',
        roots: ['D:/photos'],
        discoveredCount: 10,
        hashedCount: 5,
        totalFilesToHash: 10,
        totalBytes: 50000,
        hashedBytes: 25000,
        skippedCount: 1,
        errorCount: 0,
        currentPath: 'D:/photos/pic.jpg',
        errors: [],
        startedAtMs: 1000,
        updatedAtMs: 2000,
        completedAtMs: null
      }
      const res = validatePayload(ScanJobProgressSchema, valid)
      expect(res.success).toBe(true)
    })

    it('rejects invalid scan statuses or negative counts', () => {
      const invalid = {
        jobId: 1,
        status: 'dancing',
        phase: 'discovery',
        roots: ['D:/photos'],
        discoveredCount: -1,
        hashedCount: 0,
        totalFilesToHash: 0,
        totalBytes: 0,
        hashedBytes: 0,
        skippedCount: 0,
        errorCount: 0,
        errors: [],
        startedAtMs: 1000,
        updatedAtMs: 2000,
        completedAtMs: null
      }
      const res = validatePayload(ScanJobProgressSchema, invalid)
      expect(res.success).toBe(false)
    })
  })

  describe('StartScanRequestSchema', () => {
    it('accepts valid roots array', () => {
      const valid = { roots: ['D:/photos', 'D:/docs'] }
      expect(validatePayload(StartScanRequestSchema, valid).success).toBe(true)
    })

    it('rejects empty roots array', () => {
      const invalid = { roots: [] }
      expect(validatePayload(StartScanRequestSchema, invalid).success).toBe(false)
    })
  })

  describe('JobIdRequestSchema', () => {
    it('accepts valid positive job id', () => {
      expect(validatePayload(JobIdRequestSchema, { jobId: 123 }).success).toBe(true)
    })

    it('rejects zero or negative job id', () => {
      expect(validatePayload(JobIdRequestSchema, { jobId: 0 }).success).toBe(false)
      expect(validatePayload(JobIdRequestSchema, { jobId: -5 }).success).toBe(false)
    })
  })

  describe('JobActionResponseSchema', () => {
    it('accepts valid action response', () => {
      const valid = { success: true }
      expect(validatePayload(JobActionResponseSchema, valid).success).toBe(true)
    })
  })

  describe('SelectRootsResponseSchema', () => {
    it('accepts valid directory selection response', () => {
      const valid = { cancelled: false, rootPaths: ['D:/photos'] }
      expect(validatePayload(SelectRootsResponseSchema, valid).success).toBe(true)
    })
  })
})
