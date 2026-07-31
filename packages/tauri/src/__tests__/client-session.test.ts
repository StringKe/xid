// Tests for getSession, getAccessToken, signOut, buildSignOutUrl, and setTokenStorage.
import { describe, expect, it } from 'vitest'

import { createMemoryKeychainAdapter } from '../keychain'
import { createXidTauriClient } from '../client'

const BASE_OPTIONS = {
  issuer: 'https://xid.dev',
  clientId: 'client_test',
  redirectUri: 'myapp://auth/callback',
  keychain: createMemoryKeychainAdapter(),
  now: () => 1_000_000,
}

function makeTokenFetcher(accessToken = 'at.jwt', expiresIn = 3600) {
  return async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
    new Response(
      JSON.stringify({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: expiresIn,
      }),
      { status: 200 },
    )
}

function makeCallbackUrl(code: string, state: string): string {
  return `myapp://auth/callback?code=${code}&state=${encodeURIComponent(state)}`
}

async function signInFully(client: ReturnType<typeof createXidTauriClient>): Promise<void> {
  const state = (await client.signIn()).searchParams.get('state') ?? ''
  await client.handleRedirect(makeCallbackUrl('code', state))
}

describe('createXidTauriClient.getSession', () => {
  it('returns null when not signed in', async () => {
    const client = createXidTauriClient({ ...BASE_OPTIONS })

    expect(await client.getSession()).toBeNull()
  })

  it('returns a TauriSession after successful sign-in', async () => {
    const keychain = createMemoryKeychainAdapter()
    const client = createXidTauriClient({ ...BASE_OPTIONS, keychain, fetcher: makeTokenFetcher() })

    await signInFully(client)

    const session = await client.getSession()
    expect(session).not.toBeNull()
    expect(session?.accessToken).toBe('at.jwt')
  })
})

describe('createXidTauriClient.getAccessToken', () => {
  it('returns null when not signed in', async () => {
    const client = createXidTauriClient({ ...BASE_OPTIONS })

    expect(await client.getAccessToken()).toBeNull()
  })

  it('deletes a legacy refresh key while preserving a fresh authorization-code session', async () => {
    const keychain = createMemoryKeychainAdapter()
    const client = createXidTauriClient({
      ...BASE_OPTIONS,
      keychain,
      fetcher: makeTokenFetcher(),
    })
    await signInFully(client)
    await keychain.setItem('xid.refresh_token', 'rt.legacy')

    await expect(client.getAccessToken()).resolves.toBe('at.jwt')
    expect(await keychain.getItem('xid.refresh_token')).toBeNull()
  })

  it('clears an expired session without making a refresh request', async () => {
    let fetchCount = 0
    const fetcher = async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      fetchCount++
      return new Response(
        JSON.stringify({
          access_token: 'at.expired',
          token_type: 'Bearer',
          expires_in: 0,
          refresh_token: 'rt.unexpected',
        }),
        { status: 200 },
      )
    }

    const keychain = createMemoryKeychainAdapter()
    const client = createXidTauriClient({
      ...BASE_OPTIONS,
      keychain,
      fetcher,
      now: () => 1_000_000,
    })

    await signInFully(client)

    expect(await client.getAccessToken()).toBeNull()
    expect(fetchCount).toBe(1)
    expect(await keychain.getItem('xid.access_token')).toBeNull()
    expect(await keychain.getItem('xid.refresh_token')).toBeNull()
    expect(await keychain.getItem('xid.session')).toBeNull()
  })
})

describe('createXidTauriClient.signOut', () => {
  it('clears local credentials without making a revocation request', async () => {
    let fetchCount = 0
    const fetcher = async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      fetchCount++
      return new Response(
        JSON.stringify({
          access_token: 'at.jwt',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
        { status: 200 },
      )
    }
    const keychain = createMemoryKeychainAdapter()
    const client = createXidTauriClient({ ...BASE_OPTIONS, keychain, fetcher })

    await signInFully(client)
    await keychain.setItem('xid.refresh_token', 'rt.legacy')
    await client.signOut()

    expect(await client.getAccessToken()).toBeNull()
    expect(await keychain.getItem('xid.refresh_token')).toBeNull()
    expect(fetchCount).toBe(1)
  })

  it('returns null from getSession after sign-out', async () => {
    const keychain = createMemoryKeychainAdapter()
    const client = createXidTauriClient({ ...BASE_OPTIONS, keychain, fetcher: makeTokenFetcher() })

    await signInFully(client)
    await client.signOut()

    expect(await client.getSession()).toBeNull()
  })
})

describe('createXidTauriClient.buildSignOutUrl', () => {
  it('builds the OIDC end_session URL at the issuer', () => {
    const client = createXidTauriClient({ ...BASE_OPTIONS })

    const url = client.buildSignOutUrl()

    expect(url.origin).toBe('https://xid.dev')
    expect(url.pathname).toBe('/end_session')
  })

  it('includes id_token_hint when provided', () => {
    const client = createXidTauriClient({ ...BASE_OPTIONS })

    const url = client.buildSignOutUrl({ idTokenHint: 'id.jwt' })

    expect(url.searchParams.get('id_token_hint')).toBe('id.jwt')
  })

  it('includes post_logout_redirect_uri when provided', () => {
    const client = createXidTauriClient({ ...BASE_OPTIONS })

    const url = client.buildSignOutUrl({ postLogoutRedirectUri: 'myapp://logout' })

    expect(url.searchParams.get('post_logout_redirect_uri')).toBe('myapp://logout')
  })
})

describe('createXidTauriClient.setTokenStorage', () => {
  it('switches to the new adapter so tokens written to the old one are gone', async () => {
    const adapter1 = createMemoryKeychainAdapter()
    const client = createXidTauriClient({
      ...BASE_OPTIONS,
      keychain: adapter1,
      fetcher: makeTokenFetcher('at.old'),
    })

    await signInFully(client)

    const adapter2 = createMemoryKeychainAdapter()
    client.setTokenStorage(adapter2)

    expect(await client.getAccessToken()).toBeNull()
  })
})
