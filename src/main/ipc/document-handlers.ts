import { IPC_CHANNELS } from '../../shared/contracts/channels'
import {
  GetDocumentDetailRequestSchema,
  GetDocumentDetailResponseSchema,
  GetDocumentExtensionFacetsRequestSchema,
  GetDocumentExtensionFacetsResponseSchema,
  GetDocumentsPageRequestSchema,
  GetDocumentsPageResponseSchema
} from '../../shared/validation/document-schemas'
import { validatePayload } from '../../shared/validation/ipc-schemas'
import type { CatalogDatabase } from '../services/catalog'

export interface DocumentIpcHandlerDeps {
  readonly handle: <Args extends unknown[], Result>(
    channel: string,
    fn: (...args: Args) => Result | Promise<Result>
  ) => void
  readonly catalog?: CatalogDatabase
}

export function registerDocumentIpcHandlers({ handle, catalog }: DocumentIpcHandlerDeps): void {
  handle(IPC_CHANNELS.DOCUMENTS_GET_PAGE, (rawRequest: unknown) => {
    const req = validatePayload(GetDocumentsPageRequestSchema, rawRequest)
    if (!req.success) {
      throw new Error(`Invalid documents:get-page request: ${req.error}`)
    }
    if (!catalog) {
      throw new Error('Catalog database is not initialized')
    }
    const page = catalog.getDocumentsPage(req.data)
    const res = validatePayload(GetDocumentsPageResponseSchema, page)
    if (!res.success) {
      throw new Error(`Invalid documents:get-page response: ${res.error}`)
    }
    return res.data
  })

  handle(IPC_CHANNELS.DOCUMENTS_GET_DETAIL, (rawRequest: unknown) => {
    const req = validatePayload(GetDocumentDetailRequestSchema, rawRequest)
    if (!req.success) {
      throw new Error(`Invalid documents:get-detail request: ${req.error}`)
    }
    if (!catalog) {
      throw new Error('Catalog database is not initialized')
    }
    const item = catalog.getDocumentDetail(req.data.fileLocationId)
    const res = validatePayload(GetDocumentDetailResponseSchema, { item })
    if (!res.success) {
      throw new Error(`Invalid documents:get-detail response: ${res.error}`)
    }
    return res.data
  })

  handle(IPC_CHANNELS.DOCUMENTS_GET_EXTENSION_FACETS, (rawRequest: unknown) => {
    const req = validatePayload(GetDocumentExtensionFacetsRequestSchema, rawRequest ?? {})
    if (!req.success) {
      throw new Error(`Invalid documents:get-extension-facets request: ${req.error}`)
    }
    if (!catalog) {
      throw new Error('Catalog database is not initialized')
    }
    const facets = catalog.getDocumentExtensionFacets(req.data)
    const res = validatePayload(GetDocumentExtensionFacetsResponseSchema, facets)
    if (!res.success) {
      throw new Error(`Invalid documents:get-extension-facets response: ${res.error}`)
    }
    return res.data
  })
}
