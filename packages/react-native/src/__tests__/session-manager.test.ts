import { describe, expect, it, vi } from 'vitest'

import type { TokenCache } from '../token-cache'
import { saveTokenSet, TOKEN_KEYS } from '../token-exchange'
import { XidSessionManager } from '../session-manager'

function makeCache(): TokenCache & { store: Map<string, string> } {
  const store = new Map<string, string>()
  return {
    store,
    getToken: async (key) => store.get(key) ?? null,
    saveToken: async (key, value) => {
      store.set(key, value)
    },
    deleteToken: async (key) => {
      store.delete(key)
    },
  }
}

function makeSharedCacheWrappers(): [TokenCache & { store: Map<string, string> }, TokenCache] {
  const store = new Map<string, string>()
  const createWrapper = (): TokenCache => ({
    coordinationNamespace: 'shared-secure-store',
    getToken: async (key) => store.get(key) ?? null,
    saveToken: async (key, value) => {
      store.set(key, value)
    },
    deleteToken: async (key) => {
      store.delete(key)
    },
  })
  const first = createWrapper()
  return [Object.assign(first, { store }), createWrapper()]
}

describe('XidSessionManager', () => {
  it('restores a fresh persisted session', async () => {
    const cache = makeCache()
    await saveTokenSet(cache, {
      accessToken: 'at.persisted',
      refreshToken: 'rt.persisted',
      idToken: null,
      expiresIn: 3600,
    })
    const firstManager = new XidSessionManager({
      tokenCache: cache,
      issuer: 'https://xid.dev',
      clientId: 'client_test',
    })

    await expect(firstManager.restore()).resolves.toMatchObject({ accessToken: 'at.persisted' })

    const restartedManager = new XidSessionManager({
      tokenCache: cache,
      issuer: 'https://xid.dev',
      clientId: 'client_test',
    })
    await expect(restartedManager.restore()).resolves.toMatchObject({ accessToken: 'at.persisted' })
  })

  it('shares one refresh request across wrappers with the same coordination namespace', async () => {
    const [firstCache, secondCache] = makeSharedCacheWrappers()
    await saveTokenSet(firstCache, {
      accessToken: 'at.expired',
      refreshToken: 'rt.valid',
      idToken: null,
      expiresIn: 0,
    })
    const mockFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: 'at.refreshed',
            refresh_token: 'rt.rotated',
            expires_in: 3600,
          }),
          { status: 200 },
        ),
    )
    vi.stubGlobal('fetch', mockFetch)
    const firstManager = new XidSessionManager({
      tokenCache: firstCache,
      issuer: 'https://xid.dev',
      clientId: 'client_test',
    })

    const secondManager = new XidSessionManager({
      tokenCache: secondCache,
      issuer: 'https://xid.dev',
      clientId: 'client_test',
    })

    await expect(
      Promise.all([firstManager.restore(), secondManager.getAccessToken()]),
    ).resolves.toEqual([expect.objectContaining({ accessToken: 'at.refreshed' }), 'at.refreshed'])
    expect(mockFetch).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })

  it('waits for a shared refresh when a late wrapper finds the pending marker', async () => {
    const [firstCache, secondCache] = makeSharedCacheWrappers()
    await saveTokenSet(firstCache, {
      accessToken: 'at.expired',
      refreshToken: 'rt.valid',
      idToken: null,
      expiresIn: 0,
    })
    let startFetch: (() => void) | undefined
    let releaseFetch: (() => void) | undefined
    const fetchStarted = new Promise<void>((resolve) => {
      startFetch = resolve
    })
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve
    })
    const mockFetch = vi.fn(async () => {
      startFetch?.()
      await fetchGate
      return new Response(
        JSON.stringify({
          access_token: 'at.refreshed',
          refresh_token: 'rt.rotated',
          expires_in: 3600,
        }),
        { status: 200 },
      )
    })
    vi.stubGlobal('fetch', mockFetch)
    const firstManager = new XidSessionManager({
      tokenCache: firstCache,
      issuer: 'https://xid.dev',
      clientId: 'client_test',
    })

    const initialRestore = firstManager.restore()
    await fetchStarted
    const lateManager = new XidSessionManager({
      tokenCache: secondCache,
      issuer: 'https://xid.dev',
      clientId: 'client_test',
    })
    const lateRestore = lateManager.restore()
    const pendingResult = await Promise.race([
      lateRestore.then(() => 'restored'),
      Promise.resolve('pending'),
    ])

    expect(pendingResult).toBe('pending')
    expect(mockFetch).toHaveBeenCalledTimes(1)

    releaseFetch?.()
    await expect(initialRestore).resolves.toMatchObject({ accessToken: 'at.refreshed' })
    await expect(lateRestore).resolves.toMatchObject({ accessToken: 'at.refreshed' })
    expect(mockFetch).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })

  it('clears credentials when refresh network request fails', async () => {
    const cache = makeCache()
    await saveTokenSet(cache, {
      accessToken: 'at.expired',
      refreshToken: 'rt.valid',
      idToken: null,
      expiresIn: 0,
    })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network unavailable')))
    const manager = new XidSessionManager({
      tokenCache: cache,
      issuer: 'https://xid.dev',
      clientId: 'client_test',
    })

    await expect(manager.restore()).resolves.toBeNull()
    expect(await cache.getToken(TOKEN_KEYS.session)).toBeNull()
    vi.unstubAllGlobals()
  })

  it('clears credentials when refresh response JSON is invalid', async () => {
    const cache = makeCache()
    await saveTokenSet(cache, {
      accessToken: 'at.expired',
      refreshToken: 'rt.valid',
      idToken: null,
      expiresIn: 0,
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('invalid-json', { status: 200 })))
    const manager = new XidSessionManager({
      tokenCache: cache,
      issuer: 'https://xid.dev',
      clientId: 'client_test',
    })

    await expect(manager.restore()).resolves.toBeNull()
    expect(await cache.getToken(TOKEN_KEYS.session)).toBeNull()
    vi.unstubAllGlobals()
  })

  it('keeps the pending marker across a new manager when refreshed session save and cleanup fail', async () => {
    const cache = makeCache()
    cache.store.set(
      TOKEN_KEYS.session,
      JSON.stringify({
        accessToken: 'at.expired',
        refreshToken: 'rt.valid',
        idToken: null,
        expiresAt: Date.now(),
        expiresIn: 0,
      }),
    )
    cache.saveToken = async (key, value) => {
      if (key === TOKEN_KEYS.session) {
        throw new Error('storage unavailable')
      }
      cache.store.set(key, value)
    }
    cache.deleteToken = async () => {
      throw new Error('storage unavailable')
    }
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'at.refreshed', expires_in: 3600 }), {
        status: 200,
      }),
    )
    vi.stubGlobal('fetch', mockFetch)
    const manager = new XidSessionManager({
      tokenCache: cache,
      issuer: 'https://xid.dev',
      clientId: 'client_test',
    })

    await expect(manager.restore()).resolves.toBeNull()
    expect(await cache.getToken(TOKEN_KEYS.sessionPending)).toBe('1')

    const restartedManager = new XidSessionManager({
      tokenCache: cache,
      issuer: 'https://xid.dev',
      clientId: 'client_test',
    })
    await expect(restartedManager.restore()).resolves.toBeNull()
    expect(mockFetch).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })
})
