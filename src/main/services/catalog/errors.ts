/**
 * Personal Vault — Catalog Persistence Domain Errors
 */

export class CatalogError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CatalogError'
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export class UnsupportedSchemaVersionError extends CatalogError {
  readonly currentVersion: number
  readonly supportedVersion: number

  constructor(currentVersion: number, supportedVersion: number) {
    super(
      `Database schema version ${currentVersion} is unsupported by this application (supported version: ${supportedVersion}). Please update Personal Vault.`
    )
    this.name = 'UnsupportedSchemaVersionError'
    this.currentVersion = currentVersion
    this.supportedVersion = supportedVersion
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export class DatabaseClosedError extends CatalogError {
  constructor(message = 'Database is closed and cannot perform operations.') {
    super(message)
    this.name = 'DatabaseClosedError'
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export class SourceNotFoundError extends CatalogError {
  readonly rootPath: string

  constructor(rootPath: string) {
    super(`Source root not found in catalog: ${rootPath}`)
    this.name = 'SourceNotFoundError'
    this.rootPath = rootPath
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export class FileLocationNotFoundError extends CatalogError {
  readonly filePath: string

  constructor(filePath: string) {
    super(`File location not found in catalog: ${filePath}`)
    this.name = 'FileLocationNotFoundError'
    this.filePath = filePath
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export class MigrationError extends CatalogError {
  readonly targetVersion: number

  constructor(targetVersion: number, message: string) {
    super(`Failed to apply schema migration ${targetVersion}: ${message}`)
    this.name = 'MigrationError'
    this.targetVersion = targetVersion
    Object.setPrototypeOf(this, new.target.prototype)
  }
}
