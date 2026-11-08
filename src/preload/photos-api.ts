/**
 * Personal Vault — Preload Bridge API for Photos & Thumbnails (Stage 5A)
 */

import type { IpcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/contracts/channels'
import {
  GetPhotosPageRequestSchema,
  GetPhotosPageResponseSchema,
  GetThumbnailRequestSchema,
  ThumbnailResultSchema,
  CancelThumbnailRequestSchema,
  CancelThumbnailResponseSchema,
  PhotosDiagnosticsResponseSchema,
  type GetPhotosPageRequest,
  type GetPhotosPageResponse,
  type GetThumbnailRequest,
  type ThumbnailResult,
  type CancelThumbnailRequest,
  type CancelThumbnailResponse,
  type PhotosDiagnosticsResponse
} from '../shared/validation/ipc-schemas'

export interface PhotosApi {
  getPhotosPage: (request: GetPhotosPageRequest) => Promise<GetPhotosPageResponse>
  getThumbnail: (request: GetThumbnailRequest) => Promise<ThumbnailResult>
  cancelThumbnail: (request: CancelThumbnailRequest) => Promise<CancelThumbnailResponse>
  getPhotosDiagnostics: () => Promise<PhotosDiagnosticsResponse>
}

export function createPhotosApi(ipcRenderer: IpcRenderer): PhotosApi {
  return {
    async getPhotosPage(request: GetPhotosPageRequest): Promise<GetPhotosPageResponse> {
      const validatedReq = GetPhotosPageRequestSchema.parse(request)
      const rawRes = await ipcRenderer.invoke(IPC_CHANNELS.PHOTOS_GET_PAGE, validatedReq)
      return GetPhotosPageResponseSchema.parse(rawRes)
    },

    async getThumbnail(request: GetThumbnailRequest): Promise<ThumbnailResult> {
      const validatedReq = GetThumbnailRequestSchema.parse(request)
      const rawRes = await ipcRenderer.invoke(IPC_CHANNELS.PHOTOS_GET_THUMBNAIL, validatedReq)
      return ThumbnailResultSchema.parse(rawRes)
    },

    async cancelThumbnail(request: CancelThumbnailRequest): Promise<CancelThumbnailResponse> {
      const validatedReq = CancelThumbnailRequestSchema.parse(request)
      const rawRes = await ipcRenderer.invoke(IPC_CHANNELS.PHOTOS_CANCEL_THUMBNAIL, validatedReq)
      return CancelThumbnailResponseSchema.parse(rawRes)
    },

    async getPhotosDiagnostics(): Promise<PhotosDiagnosticsResponse> {
      const rawRes = await ipcRenderer.invoke(IPC_CHANNELS.PHOTOS_GET_DIAGNOSTICS)
      return PhotosDiagnosticsResponseSchema.parse(rawRes)
    }
  }
}
