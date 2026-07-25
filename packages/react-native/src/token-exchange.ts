// token exchange:PKCE authorization code -> access_token + refresh_token。
// 调用 /token endpoint,存储结果到 tokenCache。
// 无 refresh token 自动轮换(bridge 到 @xid-kit/core XidClient)。

import type { TokenCache } from './token-cache'

const TOKEN_KEYS = {
  session: 'xid.session.v1',
  sessionPending: 'xid.session.pending.v1',
  accessToken: 'xid.access_token',
  refreshToken: 'xid.refresh_token',
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
  signal?: AbortSignal
}

export type TokenSet = {
  accessToken: string
  refreshToken: string | null
  idToken: string | null
  expiresIn: number
}

export type StoredTokenSet = TokenSet & {
  expiresAt: number
}

type TokenEndpointResponse = {
  access_token: string
  refresh_token?: string
  id_token?: string
  expires_in?: number
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

  const response = await fetch(url.toString(), {
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
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    idToken: data.id_token ?? null,
    expiresIn: data.expires_in ?? 3600,
  }
}

export async function saveTokenSet(cache: TokenCache, tokens: TokenSet): Promise<void> {
  const session: StoredTokenSet = {
    ...tokens,
    expiresAt: Date.now() + tokens.expiresIn * 1000,
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
    const parsed = JSON.parse(rawSession) as Partial<StoredTokenSet>
    if (
      typeof parsed.accessToken !== 'string' ||
      (typeof parsed.refreshToken !== 'string' && parsed.refreshToken !== null) ||
      (typeof parsed.idToken !== 'string' && parsed.idToken !== null) ||
      typeof parsed.expiresAt !== 'number' ||
      !Number.isFinite(parsed.expiresAt) ||
      parsed.expiresAt <= 0 ||
      typeof parsed.expiresIn !== 'number' ||
      !Number.isFinite(parsed.expiresIn)
    ) {
      await clearTokenSet(cache)
      return null
    }

    return {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      idToken: parsed.idToken,
      expiresAt: parsed.expiresAt,
      expiresIn: Math.max(0, Math.ceil((parsed.expiresAt - Date.now()) / 1000)),
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
  TOKEN_KEYS.refreshToken,
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
