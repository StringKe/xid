import { describe, expect, it, vi } from 'vitest'

import { createMemoryKeychainAdapter, createTauriKeychainAdapter } from '../keychain'

describe('createMemoryKeychainAdapter', () => {
  it('getItem returns null for a missing key', async () => {
    const adapter = createMemoryKeychainAdapter()

    const result = await adapter.getItem('nonexistent')

    expect(result).toBeNull()
  })

  it('setItem then getItem returns the stored value', async () => {
    const adapter = createMemoryKeychainAdapter()

    await adapter.setItem('my-key', 'my-value')
    const result = await adapter.getItem('my-key')

    expect(result).toBe('my-value')
  })

  it('removeItem makes the key return null', async () => {
    const adapter = createMemoryKeychainAdapter()

    await adapter.setItem('token', 'abc123')
    await adapter.removeItem('token')
    const result = await adapter.getItem('token')

    expect(result).toBeNull()
  })

  it('multiple keys are stored independently', async () => {
    const adapter = createMemoryKeychainAdapter()

    await adapter.setItem('a', 'valueA')
    await adapter.setItem('b', 'valueB')

    expect(await adapter.getItem('a')).toBe('valueA')
    expect(await adapter.getItem('b')).toBe('valueB')
  })
})

describe('createTauriKeychainAdapter', () => {
  it('calls invoke with correct command for getItem', async () => {
    const invoke = vi.fn().mockResolvedValue('stored-token')
    const adapter = createTauriKeychainAdapter({ invoke })

    const result = await adapter.getItem('xid.access_token')

    expect(invoke).toHaveBeenCalledWith('plugin:xid-keychain|get', { key: 'xid.access_token' })
    expect(result).toBe('stored-token')
  })

  it('calls invoke with correct command for setItem', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined)
    const adapter = createTauriKeychainAdapter({ invoke })

    await adapter.setItem('xid.access_token', 'new-token')

    expect(invoke).toHaveBeenCalledWith('plugin:xid-keychain|set', {
      key: 'xid.access_token',
      value: 'new-token',
    })
  })

  it('calls invoke with correct command for removeItem', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined)
    const adapter = createTauriKeychainAdapter({ invoke })

    await adapter.removeItem('xid.access_token')

    expect(invoke).toHaveBeenCalledWith('plugin:xid-keychain|delete', {
      key: 'xid.access_token',
    })
  })

  it('uses a custom pluginPrefix when provided', async () => {
    const invoke = vi.fn().mockResolvedValue(null)
    const adapter = createTauriKeychainAdapter({ invoke, pluginPrefix: 'plugin:my-store' })

    await adapter.getItem('key')

    expect(invoke).toHaveBeenCalledWith('plugin:my-store|get', { key: 'key' })
  })

  it('returns null when invoke resolves with null', async () => {
    const invoke = vi.fn().mockResolvedValue(null)
    const adapter = createTauriKeychainAdapter({ invoke })

    const result = await adapter.getItem('missing')

    expect(result).toBeNull()
  })

  it('returns null when invoke resolves with undefined', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined)
    const adapter = createTauriKeychainAdapter({ invoke })

    const result = await adapter.getItem('missing')

    expect(result).toBeNull()
  })
})
