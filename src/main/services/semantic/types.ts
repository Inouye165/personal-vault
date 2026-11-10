export type SemanticModelProvisionState = 'missing' | 'installing' | 'ready' | 'cancelled' | 'error'

export interface SemanticModelStatus {
  state: SemanticModelProvisionState
  modelId: string
  modelCommit: string
  modelManifestSha256: string
  preprocessingVersion: string
  dimensions: number
  requiredBytes: number
  downloadedBytes: number
  currentArtifact: string | null
  verifiedAtMs: number | null
  error: string | null
  lastReplacementError: string | null
}

export type SemanticIndexJobStatus =
  'idle' | 'running' | 'paused' | 'completed' | 'cancelled' | 'interrupted' | 'failed'

export type SemanticIndexItemStatus =
  'pending' | 'completed' | 'reused' | 'unsupported' | 'failed' | 'skipped'

export interface SemanticIndexProgress {
  jobId: string | null
  status: SemanticIndexJobStatus
  modelId: string
  modelCommit: string
  preprocessingVersion: string
  totalPhotos: number
  processedPhotos: number
  reusedPhotos: number
  unsupportedPhotos: number
  failedPhotos: number
  pendingPhotos: number
  totalCatalogPhotos: number
  currentIndexedPhotos: number
  startedAtMs: number | null
  updatedAtMs: number | null
  completedAtMs: number | null
  lastError: string | null
}

export interface SemanticIndexJobItemRecord {
  id: number
  jobId: string
  fileLocationId: number
  originalPath: string
  discoveryObservationId: number
  expectedByteSize: number
  expectedMtimeMs: number
  status: SemanticIndexItemStatus
  errorCode: string | null
  errorMessage: string | null
  updatedAtMs: number | null
}
