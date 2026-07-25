// XidTauriClient implementation.
// Orchestrates PKCE flow, deeplink callback, token exchange, refresh rotation,
// and keychain persistence for Tauri desktop apps.
// The client holds no cryptographic keys; PKCE S256 uses Web Crypto in the WebView.

import { generateBase64UrlRandom, generatePkce } from './pkce'
import { createMemoryKeychainAdapter } from './keychain'
import { createSessionStore } from './session-store'
import { exchangeCodeForTokens, refreshAccessToken, TauriTokenError } from './token-exchange'
import type { XidKeychainAdapter } from './keychain'
import type { SessionStore } from './session-store'
import type { XidTauriClientOptions, SignInOptions, TauriSession, XidTauriClient } from './types'

// Access token is proactively refreshed when within this window of expiry (seconds).
const TOKEN_REFRESH_LEEWAY_SECONDS = 30

export function createXidTauriClient(options: XidTauriClientOptions): XidTauriClient {
  const { issuer, clientId, redirectUri } = options
  const defaultScopes: readonly string[] = options.scopes ?? ['openid', 'profile', 'email']
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis)

  // Mutable keychain reference so setTokenStorage() can swap at runtime.
  let store: SessionStore = createSessionStore(options.keychain ?? createMemoryKeychainAdapter())

  // In-flight refresh deduplication: if a refresh is already in progress, reuse it.
  let inflightRefresh: Promise<string | null> | null = null

  // --------------------------------------------------------------------------
  // signIn: build PKCE authorize URL, persist verifier + state, optionally open
  // --------------------------------------------------------------------------
  async function signIn(callOptions: SignInOptions = {}): Promise<URL> {
    const scopes = callOptions.scopes ?? defaultScopes
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
  // getSession: return active session, refreshing token if near expiry
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
  // getAccessToken: return valid access token, refreshing transparently if needed
  // --------------------------------------------------------------------------
  async function getAccessToken(callOptions: { skipCache?: boolean } = {}): Promise<string | null> {
    const existing = await store.getAccessToken()
    const session = await store.getSession()

    const isExpiring =
      !existing || !session || session.expiresAt - TOKEN_REFRESH_LEEWAY_SECONDS <= now()

    if (!isExpiring && !callOptions.skipCache) return existing

    // Attempt refresh using the stored refresh token.
    const refreshToken = await store.getRefreshToken()
    if (!refreshToken) return callOptions.skipCache ? null : (existing ?? null)

    return attemptRefresh(refreshToken)
  }

  // --------------------------------------------------------------------------
  // signOut: revoke server session, clear keychain
  // --------------------------------------------------------------------------
  async function signOut(): Promise<void> {
    // Attempt server-side token revocation via RFC 7009 /revoke endpoint.
    // This is the correct endpoint for token-based (cookie-less) desktop clients.
    // Errors are non-fatal -- local credentials are always cleared regardless.
    const accessToken = await store.getAccessToken()
    if (accessToken) {
      try {
        const revokeBody = new URLSearchParams({
          token: accessToken,
          token_type_hint: 'access_token',
          client_id: clientId,
        })
        const response = await fetcher(`${issuer.replace(/\/+$/, '')}/revoke`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: revokeBody.toString(),
        })
        // Log non-success but do not throw: local clear still runs.
        if (!response.ok) {
          // Non-fatal: server may have already revoked the token or be unreachable.
        }
      } catch {
        // Network failure during sign-out: local clear still runs.
      }
    }
    await store.clearAll()
    inflightRefresh = null
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
    inflightRefresh = null
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  async function persistTokenSet(tokenSet: {
    accessToken: string
    refreshToken: string | null
    expiresAt: number
    idToken: string | null
  }): Promise<void> {
    // Decode userId from the access token JWT payload (sub claim).
    const userId = extractSubClaim(tokenSet.accessToken) ?? 'unknown'

    await Promise.all([
      store.setAccessToken(tokenSet.accessToken),
      tokenSet.refreshToken ? store.setRefreshToken(tokenSet.refreshToken) : Promise.resolve(),
      store.setSession({
        userId,
        organizationId: null,
        expiresAt: tokenSet.expiresAt,
        abandonAt: tokenSet.expiresAt,
      }),
    ])
  }

  async function attemptRefresh(refreshToken: string): Promise<string | null> {
    if (inflightRefresh) return inflightRefresh

    inflightRefresh = doRefresh(refreshToken).finally(() => {
      inflightRefresh = null
    })
    return inflightRefresh
  }

  async function doRefresh(refreshToken: string): Promise<string | null> {
    try {
      const tokenSet = await refreshAccessToken({
        issuer,
        clientId,
        refreshToken,
        fetcher,
        now,
      })
      await persistTokenSet(tokenSet)
      return tokenSet.accessToken
    } catch (err) {
      // Only clear local credentials on protocol-level rejections (invalid_grant,
      // token revoked/expired). Network errors (TypeError from fetch, DNS failure,
      // offline) must NOT clear the keychain -- the user is not logged out just
      // because they momentarily lost connectivity.
      if (err instanceof TauriTokenError) {
        // Protocol error: the server explicitly rejected the refresh token.
        // Clear the session so the user is prompted to sign in again.
        await store.clearAll()
        return null
      }
      // Network error or unexpected throw: preserve credentials, propagate.
      throw err
    }
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
