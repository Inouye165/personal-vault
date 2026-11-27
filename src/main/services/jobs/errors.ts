export class ScanJobError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScanJobError'
  }
}

export class ScanJobConflictError extends ScanJobError {
  constructor(message = 'A scan job is already running or active') {
    super(message)
    this.name = 'ScanJobConflictError'
  }
}

export class ScanJobNotFoundError extends ScanJobError {
  constructor(jobId: number) {
    super(`Scan job with id ${jobId} not found`)
    this.name = 'ScanJobNotFoundError'
  }
}

export class ScanJobInvalidStateError extends ScanJobError {
  constructor(message: string) {
    super(message)
    this.name = 'ScanJobInvalidStateError'
  }
}
