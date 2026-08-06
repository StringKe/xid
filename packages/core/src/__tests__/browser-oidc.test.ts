import { exportPublicJwk, signJwt, type PublicJwk } from '@xid-kit/crypto'
import { computeS256Challenge } from '@xid-kit/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { XidClient } from '../client'
import type { XidTokenCache } from '../types'

const NOW_SECONDS = 1_900_000_000
let fixtureSequence = 0

class MemoryCache implements XidTokenCache {
  readonly values = new Map<string, string>()
  readonly coordinationNamespace: string

  constructor(namespace: string) {
    this.coordinationNamespace = namespace
  }

  async getToken(key: string): Promise<string | null> {
    return this.values.get(key) ?? null
  }

  async saveToken(key: string, value: string): Promise<void> {
    this.values.set(key, value)
  }

  async deleteToken(key: string): Promise<void> {
    this.values.delete(key)
  }
}

type FetchCall = {
  url: URL
  init: RequestInit | undefined
}

async function oidcFixture(
  input: { refreshToken?: string; tokenNonce?: string; userInfoOrgRole?: unknown } = {},
) {
  fixtureSequence += 1
  const issuer = `https://tenant-${fixtureSequence}.example`
  const clientId = 'client_browser'
  const redirectUri = 'https://app.example/callback?tenant=one'
  const cache = new MemoryCache(`fixture-${fixtureSequence}`)
  const calls: FetchCall[] = []
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const publicJwk: PublicJwk = await exportPublicJwk(pair.publicKey, 'kid-browser', 'ES256')
  let idToken = ''

  const fetcher = (async (request: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof request === 'string' ? request : request.toString())
    calls.push({ url, init })
    if (url.pathname === '/token') {
      return Response.json({
        access_token: 'access-token',
        id_token: idToken,
        expires_in: 300,
        ...(input.refreshToken ? { refresh_token: input.refreshToken } : {}),
      })
    }
    if (url.pathname === '/jwks') return Response.json({ keys: [publicJwk] })
    if (url.pathname === '/userinfo') {
      return Response.json({
        sub: 'user_1',
        email: 'user@example.test',
        email_verified: true,
        name: 'Example User',
        org_id: 'org_1',
        org_slug: 'example',
        org_name: 'Example',
        org_role: input.userInfoOrgRole ?? 'member',
        org_permissions: ['org:read'],
      })
    }
    return Response.json({ error: 'not_found' }, { status: 404 })
  }) as typeof fetch

  const client = new XidClient({
    mode: 'oidc',
    issuer,
    clientId,
    redirectUri,
    postLogoutRedirectUri: 'https://app.example/signed-out',
    tokenCache: cache,
    fetcher,
    now: () => NOW_SECONDS,
  })

  return {
    issuer,
    clientId,
    redirectUri,
    cache,
    calls,
    client,
    fetcher,
    async setIdToken(nonce: string) {
      idToken = await signJwt(
        {
          header: { alg: 'ES256', kid: 'kid-browser' },
          payload: {
            iss: issuer,
            sub: 'user_1',
            aud: clientId,
            exp: NOW_SECONDS + 300,
            iat: NOW_SECONDS,
            nonce: input.tokenNonce ?? nonce,
            sid: 'session_1',
          },
        },
        pair.privateKey,
      )
    },
  }
}

function successfulCallback(redirectUri: string, authorizationUrl: URL): string {
  const callback = new URL(redirectUri)
  callback.searchParams.set('code', 'authorization-code')
  callback.searchParams.set('state', authorizationUrl.searchParams.get('state') ?? '')
  callback.searchParams.set('iss', authorizationUrl.origin)
  return callback.toString()
}

function errorCallback(redirectUri: string, authorizationUrl: URL, error: string): string {
  const callback = new URL(redirectUri)
  callback.searchParams.set('error', error)
  callback.searchParams.set('state', authorizationUrl.searchParams.get('state') ?? '')
  callback.searchParams.set('iss', authorizationUrl.origin)
  return callback.toString()
}

type FakeIframe = {
  hidden: boolean
  src: string
  contentWindow: unknown
  remove: ReturnType<typeof vi.fn>
}

function stubSilentIframeDocument(): { iframe: FakeIframe } {
  const iframe: FakeIframe = { hidden: false, src: '', contentWindow: null, remove: vi.fn() }
  vi.stubGlobal('document', {
    createElement: (tag: string) => {
      if (tag !== 'iframe') throw new Error(`unexpected element: ${tag}`)
      return iframe
    },
    body: { append: vi.fn() },
  })
  return { iframe }
}

async function waitForIframeSrc(iframe: FakeIframe): Promise<URL> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (iframe.src) return new URL(iframe.src)
    await new Promise((resolve) => {
      setTimeout(resolve, 5)
    })
  }
  throw new Error('iframe src was not assigned')
}

function securityErrorWindow(): object {
  const crossOrigin = {}
  Object.defineProperty(crossOrigin, 'location', {
    get() {
      throw new DOMException('Blocked a frame with origin', 'SecurityError')
    },
  })
  return crossOrigin
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('XidClient OIDC browser mode', () => {
  it('runs authorization code plus PKCE and restores a verified session', async () => {
    const fixture = await oidcFixture()
    const authorization = await fixture.client.createAuthorizationUrl({
      intent: 'sign-up',
      returnUrl: '/dashboard?from=auth',
      loginHint: 'user@example.test',
    })
    expect(authorization.ok).toBe(true)
    if (!authorization.ok) return

    const authorizationUrl = new URL(authorization.value)
    expect(authorizationUrl.origin).toBe(fixture.issuer)
    expect(authorizationUrl.pathname).toBe('/authorize')
    expect(authorizationUrl.searchParams.get('client_id')).toBe(fixture.clientId)
    expect(authorizationUrl.searchParams.get('redirect_uri')).toBe(fixture.redirectUri)
    expect(authorizationUrl.searchParams.get('response_type')).toBe('code')
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorizationUrl.searchParams.get('xid_intent')).toBe('sign-up')
    expect(authorizationUrl.searchParams.has('prompt')).toBe(false)
    expect(authorizationUrl.searchParams.get('scope')).not.toContain('offline_access')

    const nonce = authorizationUrl.searchParams.get('nonce')
    expect(nonce).toBeTruthy()
    await fixture.setIdToken(nonce ?? '')

    const callback = await fixture.client.handleRedirectCallback(
      successfulCallback(fixture.redirectUri, authorizationUrl),
    )
    expect(callback).toEqual({
      ok: true,
      value: { returnUrl: '/dashboard?from=auth', intent: 'sign-up' },
    })
    expect(fixture.client.isSignedIn).toBe(true)
    expect(fixture.client.user?.id).toBe('user_1')
    expect(fixture.client.organization?.id).toBe('org_1')
    expect(fixture.client.session?.expireAt).toBe(NOW_SECONDS + 300)

    const tokenCall = fixture.calls.find((call) => call.url.pathname === '/token')
    const tokenBody = new URLSearchParams(String(tokenCall?.init?.body))
    expect(tokenBody.get('client_id')).toBe(fixture.clientId)
    expect(tokenBody.get('client_secret')).toBeNull()
    expect(tokenBody.get('redirect_uri')).toBe(fixture.redirectUri)
    expect(await computeS256Challenge(tokenBody.get('code_verifier') ?? '')).toBe(
      authorizationUrl.searchParams.get('code_challenge'),
    )

    const userInfoCalls = fixture.calls.filter((call) => call.url.pathname === '/userinfo')
    expect(userInfoCalls.length).toBeGreaterThan(0)
    expect(
      userInfoCalls.every((call) => call.url.searchParams.get('client_id') === fixture.clientId),
    ).toBe(true)
    expect(
      userInfoCalls.every(
        (call) => new Headers(call.init?.headers).get('authorization') === 'Bearer access-token',
      ),
    ).toBe(true)

    const restored = new XidClient({
      mode: 'oidc',
      issuer: fixture.issuer,
      clientId: fixture.clientId,
      redirectUri: fixture.redirectUri,
      tokenCache: fixture.cache,
      fetcher: fixture.fetcher,
      now: () => NOW_SECONDS,
    })
    await restored.load()
    expect(restored.isSignedIn).toBe(true)
    expect(restored.user?.id).toBe('user_1')
  })

  it('consumes state once and rejects callback replay', async () => {
    const fixture = await oidcFixture()
    const authorization = await fixture.client.createAuthorizationUrl()
    expect(authorization.ok).toBe(true)
    if (!authorization.ok) return
    const url = new URL(authorization.value)
    await fixture.setIdToken(url.searchParams.get('nonce') ?? '')
    const callbackUrl = successfulCallback(fixture.redirectUri, url)

    expect((await fixture.client.handleRedirectCallback(callbackUrl)).ok).toBe(true)
    const replay = await fixture.client.handleRedirectCallback(callbackUrl)

    expect(replay.ok).toBe(false)
    if (!replay.ok) expect(replay.error.code).toBe('invalid_request')
    expect(fixture.calls.filter((call) => call.url.pathname === '/token')).toHaveLength(1)
  })

  it('rejects a Project custom role supplied as the OIDC Organization role', async () => {
    const fixture = await oidcFixture({ userInfoOrgRole: 'viewer' })
    const authorization = await fixture.client.createAuthorizationUrl()
    expect(authorization.ok).toBe(true)
    if (!authorization.ok) return
    const url = new URL(authorization.value)
    await fixture.setIdToken(url.searchParams.get('nonce') ?? '')

    const result = await fixture.client.handleRedirectCallback(
      successfulCallback(fixture.redirectUri, url),
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('server_error')
    expect(fixture.client.isSignedIn).toBe(false)
    expect(fixture.cache.values.has('oidc.session.v1')).toBe(false)
  })

  it('rejects nonce mismatch and clears the consumed transaction', async () => {
    const fixture = await oidcFixture({ tokenNonce: 'wrong-nonce' })
    const authorization = await fixture.client.createAuthorizationUrl()
    expect(authorization.ok).toBe(true)
    if (!authorization.ok) return
    const url = new URL(authorization.value)
    await fixture.setIdToken(url.searchParams.get('nonce') ?? '')
    const callbackUrl = successfulCallback(fixture.redirectUri, url)

    const result = await fixture.client.handleRedirectCallback(callbackUrl)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_grant')
    expect((await fixture.client.handleRedirectCallback(callbackUrl)).ok).toBe(false)
    expect(fixture.client.isSignedIn).toBe(false)
  })

  it('requires the authorization response issuer and exact callback target', async () => {
    const fixture = await oidcFixture()
    const authorization = await fixture.client.createAuthorizationUrl()
    expect(authorization.ok).toBe(true)
    if (!authorization.ok) return
    const url = new URL(authorization.value)

    const wrongPath = new URL(successfulCallback(fixture.redirectUri, url))
    wrongPath.pathname = '/other'
    expect((await fixture.client.handleRedirectCallback(wrongPath.toString())).ok).toBe(false)

    await fixture.setIdToken(url.searchParams.get('nonce') ?? '')
    const missingIssuer = new URL(successfulCallback(fixture.redirectUri, url))
    missingIssuer.searchParams.delete('iss')
    const result = await fixture.client.handleRedirectCallback(missingIssuer.toString())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_request')
  })

  it('rejects external return URLs, offline access, and unexpected refresh tokens', async () => {
    const fixture = await oidcFixture({ refreshToken: 'must-not-enter-browser-storage' })
    const external = await fixture.client.createAuthorizationUrl({
      returnUrl: 'https://attacker.example/',
    })
    expect(external.ok).toBe(false)

    expect(
      () =>
        new XidClient({
          mode: 'oidc',
          issuer: fixture.issuer,
          clientId: fixture.clientId,
          redirectUri: fixture.redirectUri,
          scopes: ['openid', 'offline_access'],
        }),
    ).toThrow()

    const authorization = await fixture.client.createAuthorizationUrl()
    expect(authorization.ok).toBe(true)
    if (!authorization.ok) return
    const url = new URL(authorization.value)
    await fixture.setIdToken(url.searchParams.get('nonce') ?? '')
    const result = await fixture.client.handleRedirectCallback(
      successfulCallback(fixture.redirectUri, url),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('server_error')
    expect(fixture.cache.values.has('oidc.session.v1')).toBe(false)
  })

  it('keeps cookie-only operations unavailable in OIDC mode', async () => {
    const fixture = await oidcFixture()

    const password = await fixture.client.signInPassword({
      identifier: 'user@example.test',
      password: 'not-used',
    })
    const guest = await fixture.client.signInAnonymously()

    expect(password.ok).toBe(false)
    expect(guest.ok).toBe(false)
    if (!password.ok) expect(password.error.code).toBe('invalid_request')
    if (!guest.ok) expect(guest.error.code).toBe('invalid_request')
  })
})

describe('XidClient same-origin browser mode', () => {
  it('rejects cross-origin cookie APIs when a browser location exists', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'location')
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: new URL('https://app.example/page'),
    })
    try {
      expect(() => new XidClient({ apiUrl: 'https://issuer.example' })).toThrow(/same-origin mode/)
      expect(() => new XidClient({ apiUrl: '/api' })).not.toThrow()
    } finally {
      if (original) Object.defineProperty(globalThis, 'location', original)
      else Reflect.deleteProperty(globalThis, 'location')
    }
  })
})

describe('XidClient OIDC silent re-authentication', () => {
  it('exchanges the iframe authorization code and restores the session', async () => {
    const fixture = await oidcFixture()
    const { iframe } = stubSilentIframeDocument()

    const attempt = fixture.client.signInSilent()
    const authorizationUrl = await waitForIframeSrc(iframe)
    expect(authorizationUrl.searchParams.get('prompt')).toBe('none')
    expect(iframe.hidden).toBe(true)
    await fixture.setIdToken(authorizationUrl.searchParams.get('nonce') ?? '')
    iframe.contentWindow = {
      location: { href: successfulCallback(fixture.redirectUri, authorizationUrl) },
    }

    const result = await attempt
    expect(result.ok).toBe(true)
    expect(fixture.client.isSignedIn).toBe(true)
    expect(fixture.client.user?.id).toBe('user_1')
    expect(iframe.remove).toHaveBeenCalledOnce()
  })

  it('maps an iframe login_required response to an expected failure', async () => {
    const fixture = await oidcFixture()
    const { iframe } = stubSilentIframeDocument()

    const attempt = fixture.client.signInSilent()
    const authorizationUrl = await waitForIframeSrc(iframe)
    const state = authorizationUrl.searchParams.get('state') ?? ''
    iframe.contentWindow = {
      location: { href: errorCallback(fixture.redirectUri, authorizationUrl, 'login_required') },
    }

    const result = await attempt
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('login_required')
    expect(fixture.client.isSignedIn).toBe(false)
    expect(fixture.calls.filter((call) => call.url.pathname === '/token')).toHaveLength(0)
    expect(fixture.cache.values.has(`oidc.pending.${state}`)).toBe(false)
    expect(iframe.remove).toHaveBeenCalledOnce()
  })

  it('times out when the iframe never returns to the redirect origin', async () => {
    const fixture = await oidcFixture()
    const { iframe } = stubSilentIframeDocument()
    iframe.contentWindow = securityErrorWindow()

    const result = await fixture.client.signInSilent({ timeoutMs: 120 })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('temporarily_unavailable')
    expect(fixture.client.isSignedIn).toBe(false)
    expect(iframe.remove).toHaveBeenCalledOnce()
  })

  it('keeps polling through cross-origin SecurityError reads', async () => {
    const fixture = await oidcFixture()
    const { iframe } = stubSilentIframeDocument()
    let readable = false
    let href = ''
    const crossOrigin = {}
    Object.defineProperty(crossOrigin, 'location', {
      get() {
        if (!readable) throw new DOMException('Blocked a frame with origin', 'SecurityError')
        return { href }
      },
    })
    iframe.contentWindow = crossOrigin

    const attempt = fixture.client.signInSilent()
    const authorizationUrl = await waitForIframeSrc(iframe)
    await fixture.setIdToken(authorizationUrl.searchParams.get('nonce') ?? '')
    href = successfulCallback(fixture.redirectUri, authorizationUrl)
    readable = true

    const result = await attempt
    expect(result.ok).toBe(true)
    expect(fixture.client.isSignedIn).toBe(true)
    expect(iframe.remove).toHaveBeenCalledOnce()
  })

  it('navigates top-level with prompt=none and maps a silent error callback to a failure result', async () => {
    const fixture = await oidcFixture()
    const assign = vi.fn()
    vi.stubGlobal('location', { assign })

    const started = await fixture.client.signInSilentWithRedirect({ returnUrl: '/dashboard' })
    expect(started.ok).toBe(true)
    expect(assign).toHaveBeenCalledOnce()
    const authorizationUrl = new URL(String(assign.mock.calls[0]?.[0]))
    expect(authorizationUrl.searchParams.get('prompt')).toBe('none')

    const result = await fixture.client.handleRedirectCallback(
      errorCallback(fixture.redirectUri, authorizationUrl, 'consent_required'),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('consent_required')
    expect(fixture.client.isSignedIn).toBe(false)
  })

  it('completes a silent redirect callback when the IdP returns a code', async () => {
    const fixture = await oidcFixture()
    const authorization = await fixture.client.createAuthorizationUrl({ prompt: 'none' })
    expect(authorization.ok).toBe(true)
    if (!authorization.ok) return
    const url = new URL(authorization.value)
    expect(url.searchParams.get('prompt')).toBe('none')
    await fixture.setIdToken(url.searchParams.get('nonce') ?? '')

    const result = await fixture.client.handleRedirectCallback(
      successfulCallback(fixture.redirectUri, url),
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual({ returnUrl: '/', intent: 'sign-in' })
    expect(fixture.client.isSignedIn).toBe(true)
  })

  it('keeps non-silent callback errors on the existing invalid_request path', async () => {
    const fixture = await oidcFixture()
    const authorization = await fixture.client.createAuthorizationUrl()
    expect(authorization.ok).toBe(true)
    if (!authorization.ok) return
    const url = new URL(authorization.value)

    const result = await fixture.client.handleRedirectCallback(
      errorCallback(fixture.redirectUri, url, 'login_required'),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_request')
    expect(fixture.client.isSignedIn).toBe(false)
  })
})
