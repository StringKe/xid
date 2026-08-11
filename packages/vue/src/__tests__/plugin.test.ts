import { describe, it, expect, vi } from 'vitest'

import { XidClient } from '@xid-kit/core'

import { createXidClient, XidPlugin, XID_INJECTION_KEY } from '../plugin'

function makeAppMock() {
  const provided = new Map<symbol, unknown>()
  const app = {
    provide: vi.fn((key: symbol, value: unknown) => {
      provided.set(key, value)
    }),
    unmount: vi.fn(),
  }
  return { app, provided }
}

function anonymousMeResponse(): Response {
  return Response.json({
    user: null,
    activeOrg: null,
    organizations: [],
    session: null,
    activeSessionId: null,
    sessions: [],
  })
}

describe('createXidClient', () => {
  it('returns an XidClient instance', () => {
    const client = createXidClient({})

    expect(client).toBeInstanceOf(XidClient)
  })

  it('returns a fresh client each call', () => {
    const a = createXidClient({})
    const b = createXidClient({})

    expect(a).not.toBe(b)
  })
})

describe('XidPlugin.install', () => {
  it('calls app.provide with XID_INJECTION_KEY', () => {
    const { app, provided } = makeAppMock()
    // 预建 client，避免 install 内发起网络请求。
    const client = createXidClient({
      fetcher: () => Promise.resolve(anonymousMeResponse()),
    })

    XidPlugin.install(app, { client })

    expect(app.provide).toHaveBeenCalledWith(XID_INJECTION_KEY, client)
    expect(provided.get(XID_INJECTION_KEY as symbol)).toBe(client)
  })

  it('creates a client from options when no client is given', () => {
    const { app, provided } = makeAppMock()
    XidPlugin.install(app, {
      fetcher: () => Promise.resolve(anonymousMeResponse()),
    })

    const injected = provided.get(XID_INJECTION_KEY as symbol)
    expect(injected).toBeInstanceOf(XidClient)
  })

  it('calls client.load() during install', () => {
    const { app } = makeAppMock()
    const client = createXidClient({})
    const loadSpy = vi.spyOn(client, 'load').mockResolvedValue(undefined)

    XidPlugin.install(app, { client })

    expect(loadSpy).toHaveBeenCalledOnce()
  })
})
