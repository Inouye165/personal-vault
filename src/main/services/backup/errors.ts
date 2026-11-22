/**
 * Personal Vault — Stage 8B Backup Domain Errors
 */

export type BackupSnapshotErrorCode =
  | 'backup_containment_error'
  | 'snapshot_sqlite_error'
  | 'journal_corruption_error'
  | 'source_vault_integrity_error'
  | 'source_vault_concurrent_modification'
  | 'backup_staging_error'
  | 'destination_unavailable'
  | 'destination_disk_full'
  | 'destination_read_only'
  | 'destination_access_denied'
  | 'destination_write_failed'
  | 'destination_corrupt'
  | 'destination_collision'
  | 'recovery_secret_required'
  | 'wrong_recovery_secret'
  | 'daily_budget_exhausted'
  | 'backup_cancelled'

export type BackupRestoreErrorCode =
  | 'recovery_point_incomplete'
  | 'repository_missing'
  | 'repository_invalid'
  | 'unsupported_format_version'
  | 'unsupported_schema_version'
  | 'manifest_missing'
  | 'manifest_invalid'
  | 'manifest_hash_mismatch'
  | 'chunk_missing'
  | 'chunk_corrupt'
  | 'file_hash_mismatch'
  | 'catalog_corrupt'
  | 'journal_corrupt'
  | 'vault_identity_invalid'
  | 'vault_manifest_invalid'
  | 'restore_target_invalid'
  | 'restore_incomplete'
  | 'restore_cancelled'
  | 'restore_cleanup_refused'
  | 'recovery_secret_required'
  | 'wrong_recovery_secret'

export class BackupRestoreError extends Error {
  public readonly code: BackupRestoreErrorCode

  public constructor(code: BackupRestoreErrorCode, message: string) {
    super(message)
    this.name = 'BackupRestoreError'
    this.code = code
  }
}

export class RestoreIncompleteError extends BackupRestoreError {
  public constructor(message: string) {
    super('restore_incomplete', message)
    this.name = 'RestoreIncompleteError'
  }
}

export type CatalogRecoveryErrorCode =
  | 'recovery_target_invalid'
  | 'recovery_source_vault_invalid'
  | 'recovery_manifest_missing'
  | 'recovery_manifest_corrupt'
  | 'recovery_payload_containment_error'
  | 'recovery_payload_missing'
  | 'recovery_payload_hash_mismatch'
  | 'recovery_conflicting_normalized_path'
  | 'recovery_incomplete'
  | 'recovery_cancelled'
  | 'recovery_cleanup_refused'

export class CatalogRecoveryError extends Error {
  public readonly code: CatalogRecoveryErrorCode

  public constructor(code: CatalogRecoveryErrorCode, message: string) {
    super(message)
    this.name = 'CatalogRecoveryError'
    this.code = code
  }
}

export class RecoveryIncompleteError extends CatalogRecoveryError {
  public constructor(message: string) {
    super('recovery_incomplete', message)
    this.name = 'RecoveryIncompleteError'
  }
}

export class BackupContainmentError extends Error {
  public readonly code: BackupSnapshotErrorCode = 'backup_containment_error'

  public constructor(message: string) {
    super(message)
    this.name = 'BackupContainmentError'
  }
}

export class BackupSnapshotError extends Error {
  public readonly code: BackupSnapshotErrorCode

  public constructor(code: BackupSnapshotErrorCode, message: string) {
    super(message)
    this.name = 'BackupSnapshotError'
    this.code = code
  }
}

const UNAVAILABLE_ERRNO_CODES = new Set([
  'ENOENT',
  'ENOTFOUND',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ECONNRESET',
  'ETIMEDOUT',
  'EIO',
  'EBUSY',
  'ERROR_BAD_NETPATH',
  'ERROR_NETNAME_DELETED',
  'ERROR_NOT_READY',
  'ERROR_DEV_NOT_EXIST',
  'ERROR_BAD_UNIT'
])

export function classifyBackupDestinationFsError(err: unknown): BackupSnapshotErrorCode {
  if (err instanceof BackupSnapshotError) {
    return err.code
  }
  const nodeErr = err as NodeJS.ErrnoException | null
  const code = nodeErr?.code
  if (code && UNAVAILABLE_ERRNO_CODES.has(code)) {
    return 'destination_unavailable'
  }
  const msg = nodeErr?.message?.toLowerCase() ?? ''
  if (
    msg.includes('network path was not found') ||
    msg.includes('network name is no longer available') ||
    msg.includes('device is not ready')
  ) {
    return 'destination_unavailable'
  }
  if (code === 'EEXIST') return 'destination_collision'
  if (code === 'ENOSPC') return 'destination_disk_full'
  if (code === 'EROFS') return 'destination_read_only'
  if (code === 'EACCES' || code === 'EPERM') return 'destination_access_denied'
  return 'destination_write_failed'
}
