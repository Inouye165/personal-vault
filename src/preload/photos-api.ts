/**
 * Personal Vault — Preload Bridge API for Photos, Thumbnails & Review (Stage 5A/5B)
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
  SetPhotoAnnotationRequestSchema,
  SetPhotoAnnotationResponseSchema,
  GetPhotoAnnotationRequestSchema,
  GetPhotoAnnotationResponseSchema,
  CreateCollectionRequestSchema,
  CreateCollectionResponseSchema,
  RenameCollectionRequestSchema,
  RenameCollectionResponseSchema,
  ListCollectionsRequestSchema,
  ListCollectionsResponseSchema,
  AddCollectionMemberRequestSchema,
  AddCollectionMemberResponseSchema,
  RemoveCollectionMemberRequestSchema,
  RemoveCollectionMemberResponseSchema,
  GetPhotoMembershipsRequestSchema,
  GetPhotoMembershipsResponseSchema,
  type GetPhotosPageRequest,
  type GetPhotosPageResponse,
  type GetThumbnailRequest,
  type ThumbnailResult,
  type CancelThumbnailRequest,
  type CancelThumbnailResponse,
  type PhotosDiagnosticsResponse,
  type SetPhotoAnnotationRequest,
  type SetPhotoAnnotationResponse,
  type GetPhotoAnnotationRequest,
  type GetPhotoAnnotationResponse,
  type CreateCollectionRequest,
  type CreateCollectionResponse,
  type RenameCollectionRequest,
  type RenameCollectionResponse,
  type ListCollectionsRequest,
  type ListCollectionsResponse,
  type AddCollectionMemberRequest,
  type AddCollectionMemberResponse,
  type RemoveCollectionMemberRequest,
  type RemoveCollectionMemberResponse,
  type GetPhotoMembershipsRequest,
  type GetPhotoMembershipsResponse
} from '../shared/validation/ipc-schemas'

export interface PhotosApi {
  getPhotosPage: (request: GetPhotosPageRequest) => Promise<GetPhotosPageResponse>
  getThumbnail: (request: GetThumbnailRequest) => Promise<ThumbnailResult>
  cancelThumbnail: (request: CancelThumbnailRequest) => Promise<CancelThumbnailResponse>
  getPhotosDiagnostics: () => Promise<PhotosDiagnosticsResponse>
  setPhotoAnnotation: (request: SetPhotoAnnotationRequest) => Promise<SetPhotoAnnotationResponse>
  getPhotoAnnotation: (request: GetPhotoAnnotationRequest) => Promise<GetPhotoAnnotationResponse>
  listCollections: (request?: ListCollectionsRequest) => Promise<ListCollectionsResponse>
  createCollection: (request: CreateCollectionRequest) => Promise<CreateCollectionResponse>
  renameCollection: (request: RenameCollectionRequest) => Promise<RenameCollectionResponse>
  addCollectionMember: (request: AddCollectionMemberRequest) => Promise<AddCollectionMemberResponse>
  removeCollectionMember: (
    request: RemoveCollectionMemberRequest
  ) => Promise<RemoveCollectionMemberResponse>
  getPhotoMemberships: (request: GetPhotoMembershipsRequest) => Promise<GetPhotoMembershipsResponse>
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
    },

    async setPhotoAnnotation(
      request: SetPhotoAnnotationRequest
    ): Promise<SetPhotoAnnotationResponse> {
      const validatedReq = SetPhotoAnnotationRequestSchema.parse(request)
      const rawRes = await ipcRenderer.invoke(IPC_CHANNELS.PHOTOS_SET_ANNOTATION, validatedReq)
      return SetPhotoAnnotationResponseSchema.parse(rawRes)
    },

    async getPhotoAnnotation(
      request: GetPhotoAnnotationRequest
    ): Promise<GetPhotoAnnotationResponse> {
      const validatedReq = GetPhotoAnnotationRequestSchema.parse(request)
      const rawRes = await ipcRenderer.invoke(IPC_CHANNELS.PHOTOS_GET_ANNOTATION, validatedReq)
      return GetPhotoAnnotationResponseSchema.parse(rawRes)
    },

    async listCollections(request: ListCollectionsRequest = {}): Promise<ListCollectionsResponse> {
      const validatedReq = ListCollectionsRequestSchema.parse(request)
      const rawRes = await ipcRenderer.invoke(IPC_CHANNELS.COLLECTIONS_LIST, validatedReq)
      return ListCollectionsResponseSchema.parse(rawRes)
    },

    async createCollection(request: CreateCollectionRequest): Promise<CreateCollectionResponse> {
      const validatedReq = CreateCollectionRequestSchema.parse(request)
      const rawRes = await ipcRenderer.invoke(IPC_CHANNELS.COLLECTIONS_CREATE, validatedReq)
      return CreateCollectionResponseSchema.parse(rawRes)
    },

    async renameCollection(request: RenameCollectionRequest): Promise<RenameCollectionResponse> {
      const validatedReq = RenameCollectionRequestSchema.parse(request)
      const rawRes = await ipcRenderer.invoke(IPC_CHANNELS.COLLECTIONS_RENAME, validatedReq)
      return RenameCollectionResponseSchema.parse(rawRes)
    },

    async addCollectionMember(
      request: AddCollectionMemberRequest
    ): Promise<AddCollectionMemberResponse> {
      const validatedReq = AddCollectionMemberRequestSchema.parse(request)
      const rawRes = await ipcRenderer.invoke(IPC_CHANNELS.COLLECTIONS_ADD_MEMBER, validatedReq)
      return AddCollectionMemberResponseSchema.parse(rawRes)
    },

    async removeCollectionMember(
      request: RemoveCollectionMemberRequest
    ): Promise<RemoveCollectionMemberResponse> {
      const validatedReq = RemoveCollectionMemberRequestSchema.parse(request)
      const rawRes = await ipcRenderer.invoke(IPC_CHANNELS.COLLECTIONS_REMOVE_MEMBER, validatedReq)
      return RemoveCollectionMemberResponseSchema.parse(rawRes)
    },

    async getPhotoMemberships(
      request: GetPhotoMembershipsRequest
    ): Promise<GetPhotoMembershipsResponse> {
      const validatedReq = GetPhotoMembershipsRequestSchema.parse(request)
      const rawRes = await ipcRenderer.invoke(
        IPC_CHANNELS.COLLECTIONS_GET_MEMBERSHIPS_FOR_PHOTO,
        validatedReq
      )
      return GetPhotoMembershipsResponseSchema.parse(rawRes)
    }
  }
}
