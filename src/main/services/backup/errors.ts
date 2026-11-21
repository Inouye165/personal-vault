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
