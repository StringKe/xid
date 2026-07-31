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

  it('clearSession removes current session state and the legacy refresh key', async () => {
    const adapter = createMemoryKeychainAdapter()
    const store = createSessionStore(adapter)

    await store.setAccessToken('at')
    await adapter.setItem('xid.refresh_token', 'rt.legacy')
    await store.setSession(makeStoredSession())
    await store.setPkceVerifier('verifier')
    await store.setOauthState('state')

    await store.clearSession()

    expect(await store.getAccessToken()).toBeNull()
    expect(await adapter.getItem('xid.refresh_token')).toBeNull()
    expect(await store.getSession()).toBeNull()
    expect(await store.getPkceVerifier()).toBe('verifier')
    expect(await store.getOauthState()).toBe('state')
  })

  it('removes the legacy refresh key without reading or changing the active session', async () => {
    const adapter = createMemoryKeychainAdapter()
    const store = createSessionStore(adapter)

    await store.setAccessToken('at')
    await store.setSession(makeStoredSession())
    await adapter.setItem('xid.refresh_token', 'rt.legacy')

    await store.clearLegacyCredentials()

    expect(await adapter.getItem('xid.refresh_token')).toBeNull()
    expect(await store.getAccessToken()).toBe('at')
    expect(await store.getSession()).toEqual(makeStoredSession())
  })

  it('clearAll removes all keychain entries', async () => {
    const adapter = createMemoryKeychainAdapter()
    const store = createSessionStore(adapter)

    await store.setAccessToken('at')
    await adapter.setItem('xid.refresh_token', 'rt.legacy')
    await store.setSession(makeStoredSession())
    await store.setPkceVerifier('verifier')
    await store.setOauthState('state')

    await store.clearAll()

    expect(await store.getAccessToken()).toBeNull()
    expect(await adapter.getItem('xid.refresh_token')).toBeNull()
    expect(await store.getSession()).toBeNull()
    expect(await store.getPkceVerifier()).toBeNull()
    expect(await store.getOauthState()).toBeNull()
  })
})
