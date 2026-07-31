import { describe, expect, it, vi } from 'vitest'

import { createSecureStoreAdapter } from '../secure-store-adapter'

function makeSecureStore() {
  const store = new Map<string, string>()
  return {
    store,
    getItemAsync: vi.fn(async (key: string) => store.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => {
      store.set(key, value)
    }),
    deleteItemAsync: vi.fn(async (key: string) => {
      store.delete(key)
    }),
  }
}

// expo-secure-store only allows [A-Za-z0-9._-] in key names.
function isValidSecureStoreKey(key: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(key)
}

describe('createSecureStoreAdapter', () => {
  it('getToken delegates to getItemAsync', async () => {
    const secureStore = makeSecureStore()
    secureStore.store.set('xid.access_token', 'at_test')
    const adapter = createSecureStoreAdapter({ secureStore })

    expect(await adapter.getToken('xid.access_token')).toBe('at_test')
    expect(secureStore.getItemAsync).toHaveBeenCalledWith('xid.access_token')
  })

  it('returns null for missing key', async () => {
    const secureStore = makeSecureStore()
    const adapter = createSecureStoreAdapter({ secureStore })

    expect(await adapter.getToken('xid.missing')).toBeNull()
  })

  it('saveToken delegates to setItemAsync', async () => {
    const secureStore = makeSecureStore()
    const adapter = createSecureStoreAdapter({ secureStore })

    await adapter.saveToken('xid.access_token', 'at_val')

    expect(secureStore.setItemAsync).toHaveBeenCalledWith('xid.access_token', 'at_val')
    expect(await adapter.getToken('xid.access_token')).toBe('at_val')
  })

  it('deleteToken delegates to deleteItemAsync', async () => {
    const secureStore = makeSecureStore()
    secureStore.store.set('xid.access_token', 'at_val')
    const adapter = createSecureStoreAdapter({ secureStore })

    await adapter.deleteToken('xid.access_token')

    expect(secureStore.deleteItemAsync).toHaveBeenCalledWith('xid.access_token')
    expect(await adapter.getToken('xid.access_token')).toBeNull()
  })

  it('applies keyPrefix using dot separator (valid expo-secure-store key)', async () => {
    const secureStore = makeSecureStore()
    const adapter = createSecureStoreAdapter({ secureStore, keyPrefix: 'myapp' })

    await adapter.saveToken('xid.access_token', 'prefixed_val')

    const expectedKey = 'myapp.xid.access_token'
    expect(secureStore.setItemAsync).toHaveBeenCalledWith(expectedKey, 'prefixed_val')

    await adapter.getToken('xid.access_token')
    expect(secureStore.getItemAsync).toHaveBeenCalledWith(expectedKey)

    await adapter.deleteToken('xid.access_token')
    expect(secureStore.deleteItemAsync).toHaveBeenCalledWith(expectedKey)
  })

  it('prefixed key is valid for expo-secure-store (alphanumeric, dot, dash, underscore only)', async () => {
    const secureStore = makeSecureStore()
    const adapter = createSecureStoreAdapter({ secureStore, keyPrefix: 'myapp' })

    await adapter.saveToken('xid.access_token', 'val')

    const calledKey = (secureStore.setItemAsync.mock.calls[0] as [string, string])[0]
    expect(isValidSecureStoreKey(calledKey)).toBe(true)
  })

  it('rejects colon in prefixed key - colon is not a valid expo-secure-store character', () => {
    expect(isValidSecureStoreKey('myapp:xid.access_token')).toBe(false)
    expect(isValidSecureStoreKey('myapp.xid.access_token')).toBe(true)
  })

  it('coordinates refreshes across wrappers that address the same secure store namespace', () => {
    const secureStore = makeSecureStore()
    const first = createSecureStoreAdapter({ secureStore, keyPrefix: 'myapp' })
    const second = createSecureStoreAdapter({ secureStore, keyPrefix: 'myapp' })
    const other = createSecureStoreAdapter({ secureStore, keyPrefix: 'other' })

    expect(first.coordinationNamespace).toBe(second.coordinationNamespace)
    expect(first.coordinationNamespace).not.toBe(other.coordinationNamespace)
  })
})
