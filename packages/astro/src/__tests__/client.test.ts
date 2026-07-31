// client.ts island helper 单元测试。
import { describe, it, expect, beforeEach } from 'vitest'
import { getClient, initClient, resetClient } from '../client'

beforeEach(() => {
  resetClient()
  globalThis.__XID_CONFIG = undefined
})

describe('initClient', () => {
  it('returns a XidClient instance', () => {
    const client = initClient({ apiUrl: 'https://test.xid.dev' })
    expect(client).toBeDefined()
    expect(typeof client.load).toBe('function')
    expect(typeof client.getToken).toBe('function')
    expect(typeof client.signOut).toBe('function')
  })

  it('returns the same singleton on repeated calls with same options', () => {
    const a = initClient({ apiUrl: 'https://test.xid.dev' })
    const b = initClient({ apiUrl: 'https://test.xid.dev' })
    expect(a).toBe(b)
  })

  it('returns a new instance when apiUrl changes', () => {
    const a = initClient({ apiUrl: 'https://a.xid.dev' })
    const b = initClient({ apiUrl: 'https://b.xid.dev' })
    expect(a).not.toBe(b)
  })

  it('reuses matching OIDC options and rebuilds when the client changes', () => {
    const base = {
      mode: 'oidc' as const,
      issuer: 'https://issuer.example',
      clientId: 'client_a',
      redirectUri: 'https://app.example/callback',
      scopes: ['openid', 'profile'],
    }
    const first = initClient(base)
    const matching = initClient({ ...base, scopes: ['openid', 'profile'] })
    const changed = initClient({ ...base, clientId: 'client_b' })

    expect(matching).toBe(first)
    expect(changed).not.toBe(first)
  })

  it('uses the browser options injected by the Astro integration', () => {
    globalThis.__XID_CONFIG = {
      mode: 'oidc',
      issuer: 'https://issuer.example',
      clientId: 'client_a',
      redirectUri: 'https://app.example/callback',
    }

    const initialized = initClient()
    const retrieved = getClient()

    expect(retrieved).toBe(initialized)
  })
})

describe('getClient', () => {
  it('returns singleton if already initialized via initClient', () => {
    const initialized = initClient({ apiUrl: 'https://test.xid.dev' })
    const retrieved = getClient()
    expect(retrieved).toBe(initialized)
  })

  it('creates new client with provided options if none initialized', () => {
    const client = getClient({ apiUrl: 'https://fresh.xid.dev' })
    expect(client).toBeDefined()
  })

  it('creates client with empty options when called with no args and uninitialized', () => {
    const client = getClient()
    expect(client).toBeDefined()
  })

  it('returns the same instance on consecutive getClient() calls', () => {
    const a = getClient()
    const b = getClient()
    expect(a).toBe(b)
  })
})

describe('resetClient', () => {
  it('clears the singleton so subsequent getClient returns a new instance', () => {
    const a = getClient()
    resetClient()
    const b = getClient()
    expect(a).not.toBe(b)
  })
})
