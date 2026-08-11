// 授权码换票后须先完成 ID token 验签与 nonce 校验，再写入 tokenCache。

import type { TokenCache } from './token-cache'
import { verifyNativeIdToken, type NativeIdTokenClaims } from './id-token'

const TOKEN_KEYS = {
  session: 'xid.session.v1',
  sessionPending: 'xid.session.pending.v1',
  accessToken: 'xid.access_token',
  legacyRefreshToken: 'xid.refresh_token',
  idToken: 'xid.id_token',
  expiresAt: 'xid.expires_at',
  pkceVerifier: 'xid.pkce_verifier',
  oauthState: 'xid.oauth_state',
  pendingAuthorizationPrefix: 'xid.pending_authorization.',
} as const

export function pendingAuthorizationKey(state: string): string {
  return `${TOKEN_KEYS.pendingAuthorizationPrefix}${state}`
}

export type TokenExchangeInput = {
  issuer: string
  clientId: string
  redirectUri: string
  code: string
  verifier: string
  nonce: string
  fetcher?: typeof fetch
  signal?: AbortSignal
}

export type TokenSet = {
  accessToken: string
  idToken: string | null
  expiresIn: number
  claims?: NativeIdTokenClaims | null
}

export type StoredTokenSet = Omit<TokenSet, 'claims'> & {
  expiresAt: number
  claims: NativeIdTokenClaims | null
}

type TokenEndpointResponse = {
  access_token?: unknown
  id_token?: unknown
  expires_in?: unknown
}

export async function exchangeCodeForTokens(input: TokenExchangeInput): Promise<TokenSet> {
  const url = new URL('/token', input.issuer)
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    code: input.code,
    code_verifier: input.verifier,
  })

  const response = await (input.fetcher ?? fetch)(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    ...(input.signal ? { signal: input.signal } : {}),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`[xid-kit/react-native] Token exchange failed (${response.status}): ${text}`)
  }

  const data = (await response.json()) as TokenEndpointResponse
  if (typeof data.access_token !== 'string' || data.access_token.length === 0) {
    throw new Error('[xid-kit/react-native] Token response is missing access_token.')
  }
  if (typeof data.id_token !== 'string' || data.id_token.length === 0) {
    throw new Error('[xid-kit/react-native] OIDC token response is missing id_token.')
  }
  const claims = await verifyNativeIdToken(data.id_token, {
    issuer: input.issuer,
    clientId: input.clientId,
    expectedNonce: input.nonce,
    ...(input.fetcher ? { fetcher: input.fetcher } : {}),
  })
  return {
    accessToken: data.access_token,
    idToken: data.id_token,
    expiresIn:
      typeof data.expires_in === 'number' && Number.isFinite(data.expires_in)
        ? Math.max(0, data.expires_in)
        : 3600,
    claims,
  }
}

export async function saveTokenSet(cache: TokenCache, tokens: TokenSet): Promise<void> {
  const session: StoredTokenSet = {
    ...tokens,
    expiresAt: Date.now() + tokens.expiresIn * 1000,
    claims: tokens.claims ?? null,
  }

  await markSessionPending(cache)
  await cache.saveToken(TOKEN_KEYS.session, JSON.stringify(session))
  if (!(await deleteTokenKeys(cache, LEGACY_SESSION_KEYS))) {
    throw new Error('[xid-kit/react-native] Unable to remove legacy session credentials')
  }
  if (!(await clearSessionPending(cache))) {
    throw new Error('[xid-kit/react-native] Unable to finalize session storage')
  }
}

export async function readTokenSet(cache: TokenCache): Promise<StoredTokenSet | null> {
  if (await isSessionPending(cache)) return null

  const rawSession = await cache.getToken(TOKEN_KEYS.session)
  if (!rawSession) {
    await discardLegacyTokenSet(cache)
    return null
  }

  try {
    const parsed = JSON.parse(rawSession) as Partial<StoredTokenSet> & {
      refreshToken?: unknown
    }
    // 旧版信封曾持久化 refreshToken；仅授权码会话遇此字段 fail-closed 清凭证，禁止静默保留。
    if (Object.hasOwn(parsed, 'refreshToken')) {
      await clearTokenSet(cache)
      return null
    }
    if (
      typeof parsed.accessToken !== 'string' ||
      (typeof parsed.idToken !== 'string' && parsed.idToken !== null) ||
      typeof parsed.expiresAt !== 'number' ||
      !Number.isFinite(parsed.expiresAt) ||
      parsed.expiresAt <= 0 ||
      typeof parsed.expiresIn !== 'number' ||
      !Number.isFinite(parsed.expiresIn) ||
      (parsed.claims !== null &&
        (typeof parsed.claims !== 'object' || Array.isArray(parsed.claims)))
    ) {
      await clearTokenSet(cache)
      return null
    }

    await discardLegacyTokenSet(cache)
    return {
      accessToken: parsed.accessToken,
      idToken: parsed.idToken,
      expiresAt: parsed.expiresAt,
      expiresIn: Math.max(0, Math.ceil((parsed.expiresAt - Date.now()) / 1000)),
      claims: parsed.claims,
    }
  } catch {
    await clearTokenSet(cache)
    return null
  }
}

export async function markSessionPending(cache: TokenCache): Promise<void> {
  await cache.saveToken(TOKEN_KEYS.sessionPending, '1')
}

export async function clearTokenSet(cache: TokenCache): Promise<boolean> {
  await markSessionPending(cache)
  const deleted = await deleteTokenKeys(cache, [
    TOKEN_KEYS.session,
    ...LEGACY_SESSION_KEYS,
    TOKEN_KEYS.pkceVerifier,
    TOKEN_KEYS.oauthState,
  ])
  if (!deleted) return false
  return clearSessionPending(cache)
}

const LEGACY_SESSION_KEYS = [
  TOKEN_KEYS.accessToken,
  TOKEN_KEYS.legacyRefreshToken,
  TOKEN_KEYS.idToken,
  TOKEN_KEYS.expiresAt,
] as const

export async function isSessionPending(cache: TokenCache): Promise<boolean> {
  return (await cache.getToken(TOKEN_KEYS.sessionPending)) !== null
}

async function clearSessionPending(cache: TokenCache): Promise<boolean> {
  try {
    await cache.deleteToken(TOKEN_KEYS.sessionPending)
    return true
  } catch {
    return false
  }
}

async function discardLegacyTokenSet(cache: TokenCache): Promise<void> {
  const legacyValues = await Promise.all(LEGACY_SESSION_KEYS.map((key) => cache.getToken(key)))
  if (legacyValues.every((value) => value === null)) return

  await markSessionPending(cache)
  if (!(await deleteTokenKeys(cache, LEGACY_SESSION_KEYS))) return
  await clearSessionPending(cache)
}

async function deleteTokenKeys(cache: TokenCache, keys: ReadonlyArray<string>): Promise<boolean> {
  const results = await Promise.allSettled(keys.map((key) => cache.deleteToken(key)))
  return results.every((result) => result.status === 'fulfilled')
}

export { TOKEN_KEYS }
