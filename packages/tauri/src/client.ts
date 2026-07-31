// XidTauriClient implementation.
// Orchestrates PKCE flow, deeplink callback, authorization-code token exchange,
// and keychain persistence for Tauri desktop apps.
// The client holds no cryptographic keys; PKCE S256 uses Web Crypto in the WebView.

import { generateBase64UrlRandom, generatePkce } from './pkce'
import { createMemoryKeychainAdapter } from './keychain'
import { createSessionStore } from './session-store'
import { exchangeCodeForTokens, TauriTokenError } from './token-exchange'
import type { XidKeychainAdapter } from './keychain'
import type { SessionStore } from './session-store'
import type { XidTauriClientOptions, SignInOptions, TauriSession, XidTauriClient } from './types'

export function createXidTauriClient(options: XidTauriClientOptions): XidTauriClient {
  const { issuer, clientId, redirectUri } = options
  const defaultScopes: readonly string[] = options.scopes ?? ['openid', 'profile', 'email']
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis)

  // Mutable keychain reference so setTokenStorage() can swap at runtime.
  let store: SessionStore = createSessionStore(options.keychain ?? createMemoryKeychainAdapter())

  // --------------------------------------------------------------------------
  // signIn: build PKCE authorize URL, persist verifier + state, optionally open
  // --------------------------------------------------------------------------
  async function signIn(callOptions: SignInOptions = {}): Promise<URL> {
    const scopes = callOptions.scopes ?? defaultScopes
    assertAuthorizationCodeOnlyScopes(scopes)
    const { verifier, challenge } = await generatePkce()
    const state = generateBase64UrlRandom(32)

    await store.setPkceVerifier(verifier)
    await store.setOauthState(state)

    const url = new URL('/authorize', issuer)
    url.searchParams.set('client_id', clientId)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', [...scopes].join(' '))
    url.searchParams.set('state', state)
    url.searchParams.set('code_challenge', challenge)
    url.searchParams.set('code_challenge_method', 'S256')

    if (callOptions.openUrl) await callOptions.openUrl(url.toString())

    return url
  }

  // --------------------------------------------------------------------------
  // handleRedirect: parse deeplink, validate state, exchange code for tokens
  // --------------------------------------------------------------------------
  async function handleRedirect(rawUrl: string): Promise<void> {
    const callbackUrl = new URL(rawUrl)

    const error = callbackUrl.searchParams.get('error')
    if (error) {
      const description = callbackUrl.searchParams.get('error_description') ?? ''
      throw new TauriTokenError(
        `Authorization error: ${error}${description ? ` - ${description}` : ''}`,
        error,
      )
    }

    const code = callbackUrl.searchParams.get('code')
    if (!code) throw new TauriTokenError('Redirect URL missing authorization code', 'missing_code')

    const returnedState = callbackUrl.searchParams.get('state')
    const expectedState = await store.getOauthState()

    // State mismatch = CSRF attempt or stale callback; always reject.
    if (!returnedState || !expectedState || returnedState !== expectedState) {
      throw new TauriTokenError('OAuth state mismatch -- possible CSRF', 'state_mismatch')
    }

    const verifier = await store.getPkceVerifier()
    if (!verifier)
      throw new TauriTokenError('PKCE verifier not found in storage', 'missing_verifier')

    // Clean up ephemeral PKCE/state before exchange (defensive: tokens not yet written).
    await Promise.all([store.setOauthState(''), store.setPkceVerifier('')])

    const tokenSet = await exchangeCodeForTokens({
      issuer,
      clientId,
      redirectUri,
      code,
      codeVerifier: verifier,
      fetcher,
      now,
    })

    await persistTokenSet(tokenSet)
  }

  // --------------------------------------------------------------------------
  // getSession: return the active unexpired session
  // --------------------------------------------------------------------------
  async function getSession(): Promise<TauriSession | null> {
    const accessToken = await getAccessToken()
    if (!accessToken) return null

    const session = await store.getSession()
    if (!session) return null

    return {
      userId: session.userId,
      organizationId: session.organizationId,
      accessToken,
      expiresAt: session.expiresAt,
    }
  }

  // --------------------------------------------------------------------------
  // getAccessToken: return an unexpired token or require reauthorization
  // --------------------------------------------------------------------------
  async function getAccessToken(callOptions: { skipCache?: boolean } = {}): Promise<string | null> {
    await store.clearLegacyCredentials()
    const [existing, session] = await Promise.all([store.getAccessToken(), store.getSession()])
    if (!existing || !session) {
      if (existing || session) await store.clearSession()
      return null
    }

    if (session.expiresAt <= now()) {
      await store.clearSession()
      return null
    }

    // There is no network refresh path. A cache bypass therefore cannot produce a newer token.
    if (callOptions.skipCache) return null
    return existing
  }

  // --------------------------------------------------------------------------
  // signOut: clear local credentials
  // --------------------------------------------------------------------------
  async function signOut(): Promise<void> {
    await store.clearAll()
  }

  // --------------------------------------------------------------------------
  // buildSignOutUrl: OIDC RP-initiated logout URL
  // --------------------------------------------------------------------------
  function buildSignOutUrl(
    callOptions: { postLogoutRedirectUri?: string; idTokenHint?: string } = {},
  ): URL {
    const url = new URL('/end_session', issuer)
    if (callOptions.idTokenHint) url.searchParams.set('id_token_hint', callOptions.idTokenHint)
    if (callOptions.postLogoutRedirectUri) {
      url.searchParams.set('post_logout_redirect_uri', callOptions.postLogoutRedirectUri)
    }
    return url
  }

  // --------------------------------------------------------------------------
  // setTokenStorage: swap keychain adapter at runtime
  // --------------------------------------------------------------------------
  function setTokenStorage(adapter: XidKeychainAdapter): void {
    store = createSessionStore(adapter)
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  async function persistTokenSet(tokenSet: {
    accessToken: string
    expiresAt: number
    idToken: string | null
  }): Promise<void> {
    // Decode userId from the access token JWT payload (sub claim).
    const userId = extractSubClaim(tokenSet.accessToken) ?? 'unknown'

    // Remove any token state from older SDK versions before writing the new session.
    await store.clearSession()
    await Promise.all([
      store.setAccessToken(tokenSet.accessToken),
      store.setSession({
        userId,
        organizationId: null,
        expiresAt: tokenSet.expiresAt,
        abandonAt: tokenSet.expiresAt,
      }),
    ])
  }

  return {
    signIn,
    handleRedirect,
    getSession,
    getAccessToken,
    signOut,
    buildSignOutUrl,
    setTokenStorage,
  }
}

function assertAuthorizationCodeOnlyScopes(scopes: readonly string[]): void {
  if (scopes.includes('offline_access')) {
    throw new TypeError(
      '[xid-tauri] offline_access requires DPoP sender binding, which this SDK does not implement',
    )
  }
}

// Decode the `sub` claim from a JWT without verifying signature.
// Token comes from our own issuer; this is only for userId labeling, not trust decisions.
function extractSubClaim(jwt: string): string | null {
  const parts = jwt.split('.')
  if (parts.length !== 3 || !parts[1]) return null
  try {
    const padded = parts[1]
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(parts[1].length + ((4 - (parts[1].length % 4)) % 4), '=')
    const decoded: unknown = JSON.parse(atob(padded))
    if (typeof decoded === 'object' && decoded !== null) {
      const payload = decoded as Record<string, unknown>
      if (typeof payload.sub === 'string') return payload.sub
    }
    return null
  } catch {
    return null
  }
}
