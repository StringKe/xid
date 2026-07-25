// Tests for the loopback HTTP callback server (RFC 8252 s.7.3).
// Verifies that it correctly captures the OAuth callback URL, handles
// timeouts, and rejects non-/callback requests.
//
// These tests spin up real HTTP servers on loopback ports.

import { describe, expect, it } from 'vitest'

import { startLoopbackServer } from '../main/loopback-server'

describe('startLoopbackServer', () => {
  it('returns a redirectUri on 127.0.0.1 with /callback path', async () => {
    const server = await startLoopbackServer()

    try {
      expect(server.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    } finally {
      await server.close()
    }
  })

  it('redirectUri port is > 0 (OS-assigned)', async () => {
    const server = await startLoopbackServer()

    try {
      const url = new URL(server.redirectUri)
      expect(Number(url.port)).toBeGreaterThan(0)
    } finally {
      await server.close()
    }
  })

  it('resolves waitForCallback with the correct URL when GET /callback arrives', async () => {
    const server = await startLoopbackServer()

    const callbackPromise = server.waitForCallback({ timeoutMs: 5000 })

    // Simulate the OAuth server redirecting back to the loopback.
    const callbackUrl = `${server.redirectUri}?code=auth_code_abc&state=csrf_token_xyz`
    await fetch(callbackUrl)

    const result = await callbackPromise

    expect(result.searchParams.get('code')).toBe('auth_code_abc')
    expect(result.searchParams.get('state')).toBe('csrf_token_xyz')
    await server.close()
  })

  it('captures the full URL including all query parameters', async () => {
    const server = await startLoopbackServer()

    const callbackPromise = server.waitForCallback({ timeoutMs: 5000 })

    const callbackUrl = `${server.redirectUri}?code=code123&state=state456&session_state=extra`
    await fetch(callbackUrl)

    const result = await callbackPromise

    expect(result.searchParams.get('code')).toBe('code123')
    expect(result.searchParams.get('state')).toBe('state456')
    expect(result.searchParams.get('session_state')).toBe('extra')
    await server.close()
  })

  it('rejects with timeout error when no callback arrives in time', async () => {
    const server = await startLoopbackServer()

    await expect(server.waitForCallback({ timeoutMs: 50 })).rejects.toThrow('timed out')
    await server.close()
  })

  it('close() resolves cleanly and can be called multiple times', async () => {
    const server = await startLoopbackServer()

    await expect(server.close()).resolves.toBeUndefined()
    // Second close should not throw.
    await expect(server.close()).resolves.toBeUndefined()
  })

  it('ignores favicon and other non-/callback requests', async () => {
    const server = await startLoopbackServer()

    const callbackPromise = server.waitForCallback({ timeoutMs: 1000 })

    // Send a favicon request (browser auto-requests this on page load).
    const baseUrl = server.redirectUri.replace('/callback', '')
    await fetch(`${baseUrl}/favicon.ico`).catch(() => undefined)

    // The callback promise must still be pending (not resolved by favicon request).
    // Wait a bit -- if it resolved, the race would complete immediately.
    const raceResult = await Promise.race([
      callbackPromise.then(() => 'resolved'),
      new Promise<string>((r) => setTimeout(() => r('pending'), 100)),
    ])

    expect(raceResult).toBe('pending')
    await server.close()
  })
})
