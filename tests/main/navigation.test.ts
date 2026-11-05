// @vitest-environment node
import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn() }))
vi.mock('electron', () => ({ shell: { openExternal } }))

import { isTrustedAppUrl, resolveAppLocation, secureWebContents } from '../../src/main/navigation'

const documentPath = resolve('app', 'out', 'renderer', 'index.html')
const documentUrl = pathToFileURL(documentPath).href
const devUrl = 'http://localhost:5173/'

const production = resolveAppLocation({ isPackaged: true, rendererUrl: undefined, documentPath })
const development = resolveAppLocation({ isPackaged: false, rendererUrl: devUrl, documentPath })

describe('navigation policy: production', () => {
  it('permits only the application document', () => {
    expect(isTrustedAppUrl(production, documentUrl)).toBe(true)
    expect(isTrustedAppUrl(production, `${documentUrl}#/photos`)).toBe(true)
  })

  it.each([
    ['another local file', pathToFileURL(resolve('app', 'secret.html')).href],
    ['the application document with a query', `${documentUrl}?next=1`],
    ['a localhost dev server', devUrl],
    ['a remote site', 'https://example.com/'],
    ['a javascript URL', 'javascript:alert(1)'],
    ['a data URL', 'data:text/html,<p>x</p>'],
    ['a malformed URL', 'not a url'],
    ['an empty string', '']
  ])('rejects %s', (_label, url) => {
    expect(isTrustedAppUrl(production, url)).toBe(false)
  })

  it('ignores a development URL when the app is packaged', () => {
    const packaged = resolveAppLocation({ isPackaged: true, rendererUrl: devUrl, documentPath })
    expect(isTrustedAppUrl(packaged, devUrl)).toBe(false)
    expect(isTrustedAppUrl(packaged, documentUrl)).toBe(true)
  })
})

describe('navigation policy: development', () => {
  it('permits only the explicitly configured development origin', () => {
    expect(isTrustedAppUrl(development, devUrl)).toBe(true)
    expect(isTrustedAppUrl(development, `${devUrl}#/review`)).toBe(true)
  })

  it.each([
    ['a different port', 'http://localhost:5174/'],
    ['a lookalike host', 'http://localhost:5173.evil.example/'],
    ['the loopback IP', 'http://127.0.0.1:5173/'],
    ['the built document', documentUrl],
    ['a remote site', 'https://example.com/'],
    ['a malformed URL', '::::']
  ])('rejects %s', (_label, url) => {
    expect(isTrustedAppUrl(development, url)).toBe(false)
  })

  it('falls back to the built document when the configured URL is not http(s)', () => {
    const location = resolveAppLocation({
      isPackaged: false,
      rendererUrl: 'file:///etc/passwd',
      documentPath
    })
    expect(isTrustedAppUrl(location, 'file:///etc/passwd')).toBe(false)
    expect(isTrustedAppUrl(location, documentUrl)).toBe(true)
  })
})

describe('secureWebContents', () => {
  function setup(location = production) {
    const contents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: vi.fn()
    })
    secureWebContents(contents as never, location)
    const navigate = (eventName: string, url: string) => {
      const details = { url, preventDefault: vi.fn() }
      contents.emit(eventName, details)
      return details
    }
    const openWindow = contents.setWindowOpenHandler.mock.calls[0]?.[0] as (d: {
      url: string
    }) => unknown
    return { navigate, openWindow }
  }

  it.each(['will-navigate', 'will-redirect', 'will-frame-navigate'])(
    'blocks untrusted destinations on %s and allows the app document',
    (eventName) => {
      const { navigate } = setup()
      expect(navigate(eventName, 'https://example.com/').preventDefault).toHaveBeenCalled()
      expect(navigate(eventName, 'garbage').preventDefault).toHaveBeenCalled()
      expect(navigate(eventName, documentUrl).preventDefault).not.toHaveBeenCalled()
    }
  )

  it('denies every popup and never hands URLs to the operating system', () => {
    const { openWindow } = setup()
    expect(openWindow({ url: 'https://example.com/' })).toEqual({ action: 'deny' })
    expect(openWindow({ url: 'file:///C:/Windows/System32/calc.exe' })).toEqual({
      action: 'deny'
    })
    expect(openExternal).not.toHaveBeenCalled()
  })
})
