/**
 * Personal Vault — Stage 8A Export Domain Errors & Sanitized Messages
 */

import type { ExportErrorCode } from '../../../shared/validation/export-schemas'

export class ExportContainmentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExportContainmentError'
  }
}

export class ExportNamingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExportNamingError'
  }
}

const SANITIZED_ERROR_MESSAGES: Record<ExportErrorCode, string> = {
  source_missing: 'Original source file is missing or its drive is offline.',
  source_changed: 'Original source file changed since it was cataloged; rescan before exporting.',
  source_hash_mismatch:
    'Original source file contents no longer match the verified SHA-256 digest.',
  source_not_regular_file: 'Original source path is not a regular file.',
  source_outside_approved_roots: 'Original source path is outside approved catalog roots.',
  vault_copy_missing: 'Registered vault copy is missing from vault storage.',
  vault_copy_hash_mismatch: 'Registered vault copy failed SHA-256 integrity verification.',
  vault_and_source_unavailable:
    'Registered vault copy is unavailable or corrupt, and the original source file is also unavailable or changed.',
  destination_collision: 'Destination entry already exists and cannot be overwritten.',
  destination_disk_full: 'Destination drive does not have enough free space.',
  destination_read_only: 'Destination filesystem is read-only.',
  destination_access_denied: 'Permission denied while writing to the destination folder.',
  destination_write_failed: 'Failed to write or verify exported data at the destination.',
  sidecar_publish_failed: 'Failed to publish metadata sidecar; exported file was rolled back.',
  manifest_write_failed: 'Export manifest could not be written or verified; bundle is incomplete.',
  cancelled: 'Export was cancelled before this item completed.'
}

export function getSanitizedExportErrorMessage(code: ExportErrorCode): string {
  return SANITIZED_ERROR_MESSAGES[code]
}

export function classifyDestinationFsError(err: unknown): ExportErrorCode {
  const code = (err as NodeJS.ErrnoException | null)?.code
  if (code === 'EEXIST') return 'destination_collision'
  if (code === 'ENOSPC') return 'destination_disk_full'
  if (code === 'EROFS') return 'destination_read_only'
  if (code === 'EACCES' || code === 'EPERM') return 'destination_access_denied'
  return 'destination_write_failed'
}
