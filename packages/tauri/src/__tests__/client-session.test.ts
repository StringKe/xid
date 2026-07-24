// Tests for getSession, getAccessToken (refresh), signOut, buildSignOutUrl, setTokenStorage.
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

function makeTokenFetcher(accessToken = 'at.jwt', refreshToken = 'rt.xyz', expiresIn = 3600) {
  return async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
    new Response(
      JSON.stringify({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: expiresIn,
        refresh_token: refreshToken,
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

  it('transparently refreshes an expired access token', async () => {
    let fetchCount = 0
    const fetcher = async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      fetchCount++
      const body =
        fetchCount === 1
          ? { access_token: 'at.old', token_type: 'Bearer', expires_in: 0, refresh_token: 'rt.1' }
          : {
              access_token: 'at.fresh',
              token_type: 'Bearer',
              expires_in: 3600,
              refresh_token: 'rt.2',
            }
      return new Response(JSON.stringify(body), { status: 200 })
    }

    const keychain = createMemoryKeychainAdapter()
    const client = createXidTauriClient({
      ...BASE_OPTIONS,
      keychain,
      fetcher,
      now: () => 1_000_000,
    })

    await signInFully(client)

    expect(await client.getAccessToken()).toBe('at.fresh')
  })

  it('returns null and clears session when refresh token is invalid', async () => {
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const body = init?.body?.toString() ?? ''
      if (body.includes('refresh_token')) {
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

    const keychain = createMemoryKeychainAdapter()
    const client = createXidTauriClient({
      ...BASE_OPTIONS,
      keychain,
      fetcher,
      now: () => 1_000_000,
    })

    await signInFully(client)

    expect(await client.getAccessToken()).toBeNull()
  })
})

describe('createXidTauriClient.signOut', () => {
  it('clears the stored access token', async () => {
    const keychain = createMemoryKeychainAdapter()
    const client = createXidTauriClient({ ...BASE_OPTIONS, keychain, fetcher: makeTokenFetcher() })

    await signInFully(client)
    await client.signOut()

    expect(await client.getAccessToken()).toBeNull()
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
