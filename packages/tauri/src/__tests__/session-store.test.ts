import { describe, expect, it } from 'vitest'

import { createMemoryKeychainAdapter } from '../keychain'
import { createSessionStore } from '../session-store'
import type { StoredSession } from '../types'

function makeStoredSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    userId: 'user_1',
    organizationId: null,
    expiresAt: 9_999_999_999,
    abandonAt: 9_999_999_999,
    ...overrides,
  }
}

describe('createSessionStore', () => {
  it('returns null for access token when empty', async () => {
    const store = createSessionStore(createMemoryKeychainAdapter())

    expect(await store.getAccessToken()).toBeNull()
  })

  it('stores and retrieves access token', async () => {
    const store = createSessionStore(createMemoryKeychainAdapter())

    await store.setAccessToken('at.abc')

    expect(await store.getAccessToken()).toBe('at.abc')
  })

  it('stores and retrieves refresh token', async () => {
    const store = createSessionStore(createMemoryKeychainAdapter())

    await store.setRefreshToken('rt.xyz')

    expect(await store.getRefreshToken()).toBe('rt.xyz')
  })

  it('serialises and deserialises a StoredSession as JSON', async () => {
    const store = createSessionStore(createMemoryKeychainAdapter())
    const session = makeStoredSession({ userId: 'user_42', organizationId: 'org_1' })

    await store.setSession(session)
    const loaded = await store.getSession()

    expect(loaded).toEqual(session)
  })

  it('returns null for session when stored JSON is malformed', async () => {
    const adapter = createMemoryKeychainAdapter()
    await adapter.setItem('xid.session', '{not-valid-json}')
    const store = createSessionStore(adapter)

    expect(await store.getSession()).toBeNull()
  })

  it('returns null for session when stored JSON does not match StoredSession shape', async () => {
    const adapter = createMemoryKeychainAdapter()
    await adapter.setItem('xid.session', JSON.stringify({ foo: 'bar' }))
    const store = createSessionStore(adapter)

    expect(await store.getSession()).toBeNull()
  })

  it('clearAll removes all keychain entries', async () => {
    const store = createSessionStore(createMemoryKeychainAdapter())

    await store.setAccessToken('at')
    await store.setRefreshToken('rt')
    await store.setSession(makeStoredSession())
    await store.setPkceVerifier('verifier')
    await store.setOauthState('state')

    await store.clearAll()

    expect(await store.getAccessToken()).toBeNull()
    expect(await store.getRefreshToken()).toBeNull()
    expect(await store.getSession()).toBeNull()
    expect(await store.getPkceVerifier()).toBeNull()
    expect(await store.getOauthState()).toBeNull()
  })
})
