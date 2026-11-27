// @vitest-environment node
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const registered = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('electron', () => ({
  app: { getVersion: () => '1.2.3', isPackaged: true },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => registered.set(channel, fn)
  }
}))

import { IPC_CHANNELS } from '../../src/shared/contracts/channels'
import { registerIpcHandlers } from '../../src/main/ipc/handlers'
import { createSenderValidator } from '../../src/main/ipc/sender'
import { resolveAppLocation } from '../../src/main/navigation'
import { CatalogDatabase } from '../../src/main/services/catalog/database'

const documentPath = resolve('app', 'out', 'renderer', 'index.html')
const documentUrl = pathToFileURL(documentPath).href
const TRUSTED_ID = 42

const trusted = { sender: { id: TRUSTED_ID }, senderFrame: { url: documentUrl, parent: null } }
const untrusted = {
  sender: { id: 999 },
  senderFrame: { url: 'https://attacker.com', parent: null }
}

const invoke = async (channel: string, event: unknown, ...args: unknown[]) => {
  const handler = registered.get(channel)
  if (!handler) throw new Error(`no handler for ${channel}`)
  return handler(event, ...args)
}

describe('Stage 3 — Duplicate IPC Handlers and Sender Validation', () => {
  let catalog: CatalogDatabase

  beforeEach(() => {
    registered.clear()
    catalog = CatalogDatabase.open({ catalogPath: ':memory:' })
    const location = resolveAppLocation({ isPackaged: true, rendererUrl: undefined, documentPath })
    registerIpcHandlers({
      validateSender: createSenderValidator({
        getTrustedWebContentsId: () => TRUSTED_ID,
        location
      }),
      catalog
    })
  })

  it('rejects untrusted senders on duplicate review channels', async () => {
    await expect(invoke(IPC_CHANNELS.DUPLICATES_GET_GROUPS, untrusted, {})).rejects.toThrow(
      /unauthorized/i
    )

    await expect(
      invoke(IPC_CHANNELS.DUPLICATES_GET_MEMBERS, untrusted, {
        sha256: 'a'.repeat(64),
        byteSize: 100
      })
    ).rejects.toThrow(/unauthorized/i)

    await expect(
      invoke(IPC_CHANNELS.DUPLICATES_SET_REVIEW, untrusted, {
        sha256: 'a'.repeat(64),
        byteSize: 100,
        status: 'reviewed',
        expectedGroupSignature: 'sig'
      })
    ).rejects.toThrow(/unauthorized/i)
  })

  it('handles DUPLICATES_GET_GROUPS for trusted sender with valid Zod response', async () => {
    const res = await invoke(IPC_CHANNELS.DUPLICATES_GET_GROUPS, trusted, { offset: 0, limit: 10 })
    expect(res).toEqual({
      items: [],
      totalCount: 0,
      offset: 0,
      limit: 10,
      hasMore: false
    })
  })
})
