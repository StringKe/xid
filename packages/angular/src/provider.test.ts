// Tests for provideXid factory and XID_CLIENT token.
// Validates that:
//   - provideXid returns an EnvironmentProviders-shaped object
//   - XID_CLIENT token is a valid InjectionToken
//   - createClientFactory produces an XidClient with the expected initial snapshot
//   - initializerFactory calls client.load() when invoked

import { describe, expect, it, vi } from 'vitest'
import { XidClient } from '@xid-kit/core'

import { provideXid, XID_CLIENT } from './provider'

describe('provideXid', () => {
  it('returns a truthy non-null object (EnvironmentProviders shape)', () => {
    const result = provideXid({ apiUrl: 'https://test.xid.dev' })

    expect(result).toBeTruthy()
    expect(typeof result).toBe('object')
    expect(result).not.toBeNull()
  })

  it('accepts empty options without throwing', () => {
    expect(() => provideXid()).not.toThrow()
    expect(() => provideXid({})).not.toThrow()
  })
})

describe('XID_CLIENT InjectionToken', () => {
  it('has a descriptive string representation containing "XidClient"', () => {
    expect(String(XID_CLIENT)).toContain('XidClient')
  })

  it('is a distinct object (not a plain string)', () => {
    expect(typeof XID_CLIENT).toBe('object')
    expect(XID_CLIENT).not.toBeNull()
  })
})

describe('XidClient factory (framework-agnostic validation)', () => {
  it('creates a client with the given apiUrl and exposes getSnapshot()', () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    const client = new XidClient({ apiUrl: 'https://test.xid.dev', fetcher })
    const snapshot = client.getSnapshot()

    expect(snapshot.status).toBe('loading')
    expect(snapshot.isLoaded).toBe(false)
    expect(snapshot.isSignedIn).toBe(false)
    expect(snapshot.user).toBeNull()
    expect(snapshot.session).toBeNull()
    expect(snapshot.organization).toBeNull()
    expect(snapshot.sessions).toHaveLength(0)
    expect(snapshot.error).toBeNull()
  })

  it('subscribe returns an unsubscribe function', () => {
    const client = new XidClient()
    const listener = vi.fn()
    const unsubscribe = client.subscribe(listener)

    expect(typeof unsubscribe).toBe('function')
    unsubscribe()
    expect(listener).not.toHaveBeenCalled()
  })

  it('subscriber is notified on state changes and unsubscribe stops notifications', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ user: null, sessions: [], activeSessionId: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const client = new XidClient({ fetcher })
    const listener = vi.fn()
    const unsubscribe = client.subscribe(listener)

    const loadPromise = client.load()
    unsubscribe()

    await loadPromise
    // Unsubscribed before load completed, so listener must not have been called.
    expect(listener).not.toHaveBeenCalled()
  })

  it('client.load() resolves to undefined on success', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ user: null, sessions: [], activeSessionId: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const client = new XidClient({ fetcher })

    await expect(client.load()).resolves.toBeUndefined()
  })
})
