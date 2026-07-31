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
  it('restores a fresh authorization-code session after restart', async () => {
    const cache = makeCache()
    await saveTokenSet(cache, {
      accessToken: 'at.persisted',
      idToken: null,
      expiresIn: 3600,
    })

    const firstManager = new XidSessionManager({ tokenCache: cache })
    await expect(firstManager.restore()).resolves.toMatchObject({
      accessToken: 'at.persisted',
    })

    const restartedManager = new XidSessionManager({ tokenCache: cache })
    await expect(restartedManager.getAccessToken()).resolves.toBe('at.persisted')
  })

  it('clears an expired session and legacy refresh storage without a network request', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-29T00:00:00Z'))
    try {
      const cache = makeCache()
      await saveTokenSet(cache, {
        accessToken: 'at.expired',
        idToken: null,
        expiresIn: 1,
      })
      cache.store.set(TOKEN_KEYS.legacyRefreshToken, 'legacy-only')
      vi.advanceTimersByTime(1_001)
      const fetchSpy = vi.spyOn(globalThis, 'fetch')

      const manager = new XidSessionManager({ tokenCache: cache })

      await expect(manager.restore()).resolves.toBeNull()
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(cache.store.size).toBe(0)
    } finally {
      vi.useRealTimers()
      vi.restoreAllMocks()
    }
  })

  it('signs out by clearing local and legacy state without a revoke request', async () => {
    const cache = makeCache()
    await saveTokenSet(cache, {
      accessToken: 'at.persisted',
      idToken: null,
      expiresIn: 3600,
    })
    cache.store.set(TOKEN_KEYS.legacyRefreshToken, 'legacy-only')
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const manager = new XidSessionManager({ tokenCache: cache })

    await expect(manager.signOut()).resolves.toBeUndefined()

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(cache.store.size).toBe(0)
    vi.restoreAllMocks()
  })

  it('serializes authorization commit and clear across wrappers for one storage namespace', async () => {
    const [firstCache, secondCache] = makeSharedCacheWrappers()
    let releaseSessionWrite: () => void = () => undefined
    const sessionWriteGate = new Promise<void>((resolve) => {
      releaseSessionWrite = resolve
    })
    const originalSave = firstCache.saveToken
    firstCache.saveToken = async (key, value) => {
      if (key === TOKEN_KEYS.session) await sessionWriteGate
      await originalSave(key, value)
    }

    const firstManager = new XidSessionManager({ tokenCache: firstCache })
    const secondManager = new XidSessionManager({ tokenCache: secondCache })
    const commit = firstManager.commitAuthorizationSession({
      accessToken: 'at.new',
      idToken: null,
      expiresIn: 3600,
    })
    const clear = secondManager.clear()

    releaseSessionWrite()
    await commit
    await clear

    await expect(firstManager.restore()).resolves.toBeNull()
    expect(firstCache.store.size).toBe(0)
  })
})
