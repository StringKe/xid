// Tests for doRefresh error differentiation: network errors must NOT clear the
// keychain, protocol errors (TauriTokenError) must clear it.
// This is critical for preventing offline logout (item #3 from review).

import { describe, expect, it } from 'vitest'

import { createMemoryKeychainAdapter } from '../keychain'
import { createXidTauriClient } from '../client'

const BASE_OPTIONS = {
  issuer: 'https://xid.dev',
  clientId: 'client_test',
  redirectUri: 'myapp://auth/callback',
  now: () => 1_000_000,
}

function makeCallbackUrl(code: string, state: string): string {
  return `myapp://auth/callback?code=${code}&state=${encodeURIComponent(state)}`
}

async function signInWithExpiredToken(
  client: ReturnType<typeof createXidTauriClient>,
): Promise<void> {
  const url = await client.signIn()
  const state = url.searchParams.get('state') ?? ''
  await client.handleRedirect(makeCallbackUrl('code', state))
}

// Fetcher that:
//   - code exchange call: returns immediately-expired token + valid refresh token
//   - refresh call: throws TypeError (simulates offline / DNS failure)
function makeNetworkErrorOnRefreshFetcher(): typeof fetch {
  let callCount = 0
  return async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    callCount++
    const body = (init?.body as string) ?? ''
    if (body.includes('grant_type=refresh_token')) {
      // Simulate offline / DNS failure during refresh.
      throw new TypeError('Failed to fetch')
    }
    // Code exchange: return expired token so next getAccessToken triggers refresh.
    return new Response(
      JSON.stringify({
        access_token: 'at.expired',
        token_type: 'Bearer',
        expires_in: 0,
        refresh_token: 'rt.valid',
      }),
      { status: 200 },
    )
  }
}

// Fetcher that:
//   - code exchange: returns immediately-expired token + bad refresh token
//   - refresh: returns 400 invalid_grant (protocol error)
function makeInvalidGrantOnRefreshFetcher(): typeof fetch {
  return async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const body = (init?.body as string) ?? ''
    if (body.includes('grant_type=refresh_token')) {
      return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
    }
    return new Response(
      JSON.stringify({
        access_token: 'at.expired',
        token_type: 'Bearer',
        expires_in: 0,
        refresh_token: 'rt.bad',
      }),
      { status: 200 },
    )
  }
}

describe('doRefresh: network error preserves credentials', () => {
  it('propagates TypeError (network failure) without clearing the keychain', async () => {
    const keychain = createMemoryKeychainAdapter()
    const client = createXidTauriClient({
      ...BASE_OPTIONS,
      keychain,
      fetcher: makeNetworkErrorOnRefreshFetcher(),
    })

    // Complete sign-in: stores expired access token + refresh token.
    await signInWithExpiredToken(client)

    // Verify the refresh token was stored (sanity check).
    expect(await keychain.getItem('xid.refresh_token')).toBe('rt.valid')

    // getAccessToken triggers refresh (token is expired). The refresh fetch
    // throws TypeError. The error must propagate — not swallowed as null.
    await expect(client.getAccessToken()).rejects.toBeInstanceOf(TypeError)
  })

  it('access token and refresh token remain in keychain after network error', async () => {
    const keychain = createMemoryKeychainAdapter()
    const client = createXidTauriClient({
      ...BASE_OPTIONS,
      keychain,
      fetcher: makeNetworkErrorOnRefreshFetcher(),
    })

    await signInWithExpiredToken(client)

    // Attempt refresh (will throw TypeError — catch it here to inspect keychain).
    try {
      await client.getAccessToken()
    } catch {
      // Expected TypeError from network failure.
    }

    // Credentials must still be intact after a network error.
    expect(await keychain.getItem('xid.access_token')).toBe('at.expired')
    expect(await keychain.getItem('xid.refresh_token')).toBe('rt.valid')
  })
})

describe('doRefresh: protocol error (invalid_grant) clears credentials', () => {
  it('returns null when server returns invalid_grant', async () => {
    const keychain = createMemoryKeychainAdapter()
    const client = createXidTauriClient({
      ...BASE_OPTIONS,
      keychain,
      fetcher: makeInvalidGrantOnRefreshFetcher(),
    })

    await signInWithExpiredToken(client)

    const result = await client.getAccessToken()

    expect(result).toBeNull()
  })

  it('clears access token and refresh token from keychain on invalid_grant', async () => {
    const keychain = createMemoryKeychainAdapter()
    const client = createXidTauriClient({
      ...BASE_OPTIONS,
      keychain,
      fetcher: makeInvalidGrantOnRefreshFetcher(),
    })

    await signInWithExpiredToken(client)
    await client.getAccessToken() // triggers refresh -> invalid_grant -> clears

    expect(await keychain.getItem('xid.access_token')).toBeNull()
    expect(await keychain.getItem('xid.refresh_token')).toBeNull()
  })
})
