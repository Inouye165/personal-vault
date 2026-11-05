import { describe, it, expect } from 'vitest'
import {
  AppInfoSchema,
  NavigationTabSchema,
  VaultStatusSchema,
  SearchQuerySchema,
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
})
