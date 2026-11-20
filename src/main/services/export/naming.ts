/**
 * Personal Vault — Stage 8A Windows-Safe Filename & Bundle Folder Sanitization
 */

import { extname } from 'node:path'
import { ExportNamingError } from './errors'
import {
  EXPORT_COMPLETE_MARKER,
  EXPORT_IN_PROGRESS_MARKER,
  EXPORT_MANIFEST_FILENAME,
  EXPORT_SIDECAR_SUFFIX,
  EXPORT_TEMP_DIR_NAME
} from './types'

const WINDOWS_RESERVED_DEVICES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9'
])

const RESERVED_BUNDLE_NAMES = new Set([
  EXPORT_MANIFEST_FILENAME.toLowerCase(),
  EXPORT_IN_PROGRESS_MARKER.toLowerCase(),
  EXPORT_COMPLETE_MARKER.toLowerCase(),
  EXPORT_TEMP_DIR_NAME.toLowerCase()
])

function stripIllegalAndControlChars(raw: string): string {
  return Array.from(raw)
    .map((c) => (c.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(c) ? '_' : c))
    .join('')
    .trim()
    .replace(/[. ]+$/g, '')
}

function guardWindowsDeviceName(name: string): string {
  const ext = extname(name)
  const stem = ext ? name.slice(0, -ext.length) : name
  if (WINDOWS_RESERVED_DEVICES.has(stem.toLowerCase())) {
    return `_${name}`
  }
  return name
}

export function sanitizeBundleFolderName(rawName: string): string {
  if (!rawName || typeof rawName !== 'string') {
    throw new ExportNamingError('Bundle folder name must be a non-empty string')
  }
  if (rawName.includes('/') || rawName.includes('\\') || rawName.includes('..')) {
    throw new ExportNamingError(
      'Bundle folder name must be a single folder name without separators'
    )
  }
  let clean = stripIllegalAndControlChars(rawName)
  if (!clean || clean === '.' || clean === '..') {
    throw new ExportNamingError('Bundle folder name is invalid after sanitization')
  }
  clean = guardWindowsDeviceName(clean)
  if (clean.length > 180) {
    clean = clean.slice(0, 180).replace(/[. ]+$/g, '')
  }
  return clean
}

export function sanitizeExportFileName(rawName: string): string {
  let clean = stripIllegalAndControlChars(rawName || '')
  if (!clean || clean === '.' || clean === '..') {
    clean = 'exported_file.bin'
  }

  clean = guardWindowsDeviceName(clean)

  if (
    RESERVED_BUNDLE_NAMES.has(clean.toLowerCase()) ||
    clean.toLowerCase().startsWith(EXPORT_TEMP_DIR_NAME)
  ) {
    clean = `item_${clean}`
  }

  if (clean.toLowerCase().endsWith(EXPORT_SIDECAR_SUFFIX)) {
    const base = clean.slice(0, -EXPORT_SIDECAR_SUFFIX.length)
    clean = `${base}_.json`
  }

  if (clean.length > 200) {
    const ext = extname(clean)
    const maxStem = Math.max(1, 200 - ext.length)
    clean = `${clean.slice(0, maxStem)}${ext}`
  }

  return clean
}

export function resolveExportBatchFileNames(
  items: ReadonlyArray<{ readonly fileLocationId: number; readonly fileName: string }>
): Map<number, string> {
  const sorted = [...items].sort((a, b) => a.fileLocationId - b.fileLocationId)
  const usedLower = new Set<string>(RESERVED_BUNDLE_NAMES)
  const result = new Map<number, string>()

  for (const item of sorted) {
    const baseName = sanitizeExportFileName(item.fileName)
    const ext = extname(baseName)
    const stem = ext ? baseName.slice(0, -ext.length) : baseName

    let candidate = baseName
    let suffixIndex = 2
    while (
      usedLower.has(candidate.toLowerCase()) ||
      usedLower.has(`${candidate}${EXPORT_SIDECAR_SUFFIX}`.toLowerCase())
    ) {
      candidate = `${stem}__${suffixIndex}${ext}`
      suffixIndex++
    }

    usedLower.add(candidate.toLowerCase())
    usedLower.add(`${candidate}${EXPORT_SIDECAR_SUFFIX}`.toLowerCase())
    result.set(item.fileLocationId, candidate)
  }

  return result
}
