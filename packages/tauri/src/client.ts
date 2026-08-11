// PKCE / deeplink / code 换 token 与 keychain 持久化；私钥不入客户端，S256 走 WebView Web Crypto。

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

  let store: SessionStore = createSessionStore(options.keychain ?? createMemoryKeychainAdapter())

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

    // state 不匹配视为 CSRF 或过期回调，一律拒绝。
    if (!returnedState || !expectedState || returnedState !== expectedState) {
      throw new TauriTokenError('OAuth state mismatch -- possible CSRF', 'state_mismatch')
    }

    const verifier = await store.getPkceVerifier()
    if (!verifier)
      throw new TauriTokenError('PKCE verifier not found in storage', 'missing_verifier')

    // 换 token 前先清 ephemeral PKCE/state，避免交换失败后残留可复用材料。
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

    // 无网络 refresh；skipCache 不会拿到更新 token，直接返回 null。
    if (callOptions.skipCache) return null
    return existing
  }

  async function signOut(): Promise<void> {
    await store.clearAll()
  }

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

  function setTokenStorage(adapter: XidKeychainAdapter): void {
    store = createSessionStore(adapter)
  }

  async function persistTokenSet(tokenSet: {
    accessToken: string
    expiresAt: number
    idToken: string | null
  }): Promise<void> {
    const userId = extractSubClaim(tokenSet.accessToken) ?? 'unknown'

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

// 不校验签名：token 来自本 issuer，仅用于 userId 标注，不作信任决策。
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
