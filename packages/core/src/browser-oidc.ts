import {
  importJwkForVerify,
  randomString,
  verifyJwt,
  type JwtClaims,
  type PublicJwk,
  type VerifyKeySet,
} from '@xid-kit/crypto'
import { computeS256Challenge, generateCodeVerifier } from '@xid-kit/protocol'
import {
  isOrganizationMembershipRole,
  type OrganizationMembershipRole,
  type XidErrorCode,
} from '@xid-kit/types'

import type {
  CreateAuthorizationUrlInput,
  HandleRedirectCallbackResult,
  OidcAuthorizationIntent,
  OidcXidClientOptions,
  XidOrganization,
  XidOrganizationMembership,
  XidSession,
  XidState,
  XidTokenCache,
  XidUser,
} from './types'

const SESSION_KEY = 'oidc.session.v1'
const PENDING_PREFIX = 'oidc.pending.'
const PENDING_TTL_MS = 10 * 60 * 1000
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000
const SIGNING_ALGORITHMS = new Set(['ES256', 'RS256', 'PS256'])
const OAUTH_SCOPE_TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]+$/

type PendingAuthorization = {
  verifier: string
  nonce: string
  redirectUri: string
  returnUrl: string
  intent: OidcAuthorizationIntent
  createdAt: number
}

type OidcClaims = JwtClaims & {
  iss: string
  sub: string
  aud: string | readonly string[]
  exp: number
  iat: number
  nonce?: string
  sid?: string
  azp?: string
  amr?: readonly string[]
  email?: string
  email_verified?: boolean
  name?: string
  given_name?: string
  family_name?: string
  picture?: string
  phone_number?: string
  phone_number_verified?: boolean
  org_id?: string
  org_slug?: string
  org_name?: string
  org_role?: OrganizationMembershipRole
  org_permissions?: readonly string[]
  provisioned_by?: string
}

type UserInfo = {
  sub: string
  email?: string
  email_verified?: boolean
  name?: string
  given_name?: string
  family_name?: string
  picture?: string
  phone_number?: string
  phone_number_verified?: boolean
  org_id?: string
  org_slug?: string
  org_name?: string
  org_role?: OrganizationMembershipRole
  org_permissions?: readonly string[]
  provisioned_by?: string
}

type StoredOidcSession = {
  accessToken: string
  idToken: string
  expiresAt: number
  claims: OidcClaims
  userInfo: UserInfo
}

type TokenEndpointResponse = {
  access_token?: unknown
  refresh_token?: unknown
  id_token?: unknown
  expires_in?: unknown
}

type CachedKeySet = {
  expiresAt: number
  keySet: VerifyKeySet
}

export class BrowserOidcError extends Error {
  override readonly name = 'BrowserOidcError'
  readonly code: XidErrorCode
  readonly httpStatus: number

  constructor(code: XidErrorCode, message: string, httpStatus = 400, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.code = code
    this.httpStatus = httpStatus
  }
}

class MemoryTokenCache implements XidTokenCache {
  readonly #values = new Map<string, string>()
  readonly coordinationNamespace: string

  constructor(namespace: string) {
    this.coordinationNamespace = namespace
  }

  async getToken(key: string): Promise<string | null> {
    return this.#values.get(key) ?? null
  }

  async saveToken(key: string, value: string): Promise<void> {
    this.#values.set(key, value)
  }

  async deleteToken(key: string): Promise<void> {
    this.#values.delete(key)
  }
}

class SessionStorageTokenCache implements XidTokenCache {
  readonly coordinationNamespace: string
  readonly #prefix: string
  readonly #storage: Storage

  constructor(namespace: string, storage: Storage) {
    this.coordinationNamespace = namespace
    this.#prefix = `${namespace}:`
    this.#storage = storage
  }

  async getToken(key: string): Promise<string | null> {
    return this.#storage.getItem(`${this.#prefix}${key}`)
  }

  async saveToken(key: string, value: string): Promise<void> {
    this.#storage.setItem(`${this.#prefix}${key}`, value)
  }

  async deleteToken(key: string): Promise<void> {
    this.#storage.removeItem(`${this.#prefix}${key}`)
  }
}

const jwksCache = new Map<string, CachedKeySet>()
const mutationTails = new Map<string | XidTokenCache, Promise<void>>()

export class BrowserOidcSession {
  readonly #issuer: string
  readonly #clientId: string
  readonly #redirectUri: string
  readonly #postLogoutRedirectUri: string | null
  readonly #scopes: readonly string[]
  readonly #cache: XidTokenCache
  readonly #fetcher: typeof fetch
  readonly #now: () => number

  constructor(options: OidcXidClientOptions) {
    this.#issuer = normalizeIssuer(options.issuer)
    this.#clientId = nonEmpty(options.clientId, 'clientId')
    this.#redirectUri = normalizeRedirectUri(options.redirectUri)
    this.#postLogoutRedirectUri = options.postLogoutRedirectUri
      ? normalizeRedirectUri(options.postLogoutRedirectUri)
      : null
    this.#scopes = normalizeScopes(options.scopes)
    this.#fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis)
    this.#now = options.now ? () => options.now!() * 1000 : Date.now
    this.#cache =
      options.tokenCache ??
      defaultTokenCache(`${this.#issuer}|${this.#clientId}|${this.#redirectUri}`)
  }

  async createAuthorizationUrl(input: CreateAuthorizationUrlInput = {}): Promise<string> {
    if (input.signal?.aborted) throw input.signal.reason
    const verifier = generateCodeVerifier(64)
    const state = secureRandomString(43)
    const nonce = secureRandomString(43)
    const challenge = await computeS256Challenge(verifier)
    const returnUrl = normalizeReturnUrl(input.returnUrl, this.#redirectUri)
    const pending: PendingAuthorization = {
      verifier,
      nonce,
      redirectUri: this.#redirectUri,
      returnUrl,
      intent: input.intent ?? 'sign-in',
      createdAt: this.#now(),
    }
    await this.#cache.saveToken(`${PENDING_PREFIX}${state}`, JSON.stringify(pending))

    const url = new URL('/authorize', `${this.#issuer}/`)
    url.searchParams.set('client_id', this.#clientId)
    url.searchParams.set('redirect_uri', this.#redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', this.#scopes.join(' '))
    url.searchParams.set('state', state)
    url.searchParams.set('nonce', nonce)
    url.searchParams.set('code_challenge', challenge)
    url.searchParams.set('code_challenge_method', 'S256')
    if (input.loginHint) url.searchParams.set('login_hint', input.loginHint)
    if (input.prompt) url.searchParams.set('prompt', input.prompt)
    if (input.intent === 'sign-up') {
      url.searchParams.set('xid_intent', 'sign-up')
    }
    return url.toString()
  }

  async handleRedirectCallback(
    callbackUrl: string,
    signal?: AbortSignal,
  ): Promise<HandleRedirectCallbackResult> {
    const url = new URL(callbackUrl)
    if (!sameRedirectTarget(url, new URL(this.#redirectUri))) {
      throw new BrowserOidcError('invalid_request', 'OIDC callback URL does not match redirectUri.')
    }
    const state = singleQueryParameter(url, 'state')
    if (!state) throw new BrowserOidcError('invalid_request', 'OIDC callback is missing state.')

    const pending = await this.#consumePending(state)
    const oauthError = singleQueryParameter(url, 'error')
    if (oauthError) {
      throw new BrowserOidcError(
        oauthError === 'access_denied' ? 'access_denied' : 'invalid_request',
        singleQueryParameter(url, 'error_description') ??
          `OIDC authorization failed: ${oauthError}.`,
      )
    }
    const responseIssuer = singleQueryParameter(url, 'iss')
    if (responseIssuer !== this.#issuer) {
      throw new BrowserOidcError('invalid_request', 'OIDC authorization response issuer mismatch.')
    }
    const code = singleQueryParameter(url, 'code')
    if (!code) {
      throw new BrowserOidcError('invalid_request', 'OIDC callback is missing code.')
    }

    const tokens = await this.#exchangeCode(code, pending, signal)
    const claims = await verifyIdToken(tokens.idToken, {
      issuer: this.#issuer,
      clientId: this.#clientId,
      expectedNonce: pending.nonce,
      fetcher: this.#fetcher,
      now: this.#now,
      signal,
    })
    const userInfo = await this.#fetchUserInfo(tokens.accessToken, claims.sub, signal)
    const stored: StoredOidcSession = {
      accessToken: tokens.accessToken,
      idToken: tokens.idToken,
      expiresAt: this.#now() + tokens.expiresIn * 1000,
      claims,
      userInfo,
    }
    await this.#cache.saveToken(SESSION_KEY, JSON.stringify(stored))
    return { returnUrl: pending.returnUrl, intent: pending.intent }
  }

  async load(signal?: AbortSignal): Promise<StoredOidcSession | null> {
    const raw = await this.#cache.getToken(SESSION_KEY)
    if (!raw) return null
    const stored = parseStoredSession(raw)
    if (!stored || stored.expiresAt <= this.#now()) {
      await this.#cache.deleteToken(SESSION_KEY)
      return null
    }
    try {
      const claims = await verifyIdToken(stored.idToken, {
        issuer: this.#issuer,
        clientId: this.#clientId,
        fetcher: this.#fetcher,
        now: this.#now,
        signal,
      })
      if (claims.sub !== stored.claims.sub) throw new Error('subject changed')
      const userInfo = await this.#fetchUserInfo(stored.accessToken, claims.sub, signal)
      const verified = { ...stored, claims, userInfo }
      await this.#cache.saveToken(SESSION_KEY, JSON.stringify(verified))
      return verified
    } catch (cause) {
      await this.#cache.deleteToken(SESSION_KEY)
      if (cause instanceof BrowserOidcError && cause.httpStatus === 401) return null
      throw cause
    }
  }

  async getAccessToken(): Promise<string | null> {
    const raw = await this.#cache.getToken(SESSION_KEY)
    if (!raw) return null
    const stored = parseStoredSession(raw)
    if (!stored || stored.expiresAt <= this.#now()) {
      await this.#cache.deleteToken(SESSION_KEY)
      return null
    }
    return stored.accessToken
  }

  async clear(): Promise<void> {
    await this.#cache.deleteToken(SESSION_KEY)
  }

  async endSessionUrl(): Promise<string | null> {
    if (!this.#postLogoutRedirectUri) return null
    const raw = await this.#cache.getToken(SESSION_KEY)
    const stored = raw ? parseStoredSession(raw) : null
    if (!stored) return null
    const url = new URL('/end_session', `${this.#issuer}/`)
    url.searchParams.set('id_token_hint', stored.idToken)
    url.searchParams.set('client_id', this.#clientId)
    url.searchParams.set('post_logout_redirect_uri', this.#postLogoutRedirectUri)
    return url.toString()
  }

  stateFromSession(session: StoredOidcSession | null): XidState {
    if (!session) return signedOutState()
    const user = mapUser(session)
    const organization = mapOrganization(session)
    const browserSession = mapSession(session)
    return {
      status: 'ready',
      isLoaded: true,
      isSignedIn: true,
      session: browserSession,
      user,
      organization,
      sessions: [browserSession],
      error: null,
    }
  }

  async #consumePending(state: string): Promise<PendingAuthorization> {
    return withExclusiveMutation(this.#cache, async () => {
      const key = `${PENDING_PREFIX}${state}`
      const raw = await this.#cache.getToken(key)
      await this.#cache.deleteToken(key)
      if (!raw) {
        throw new BrowserOidcError('invalid_request', 'OIDC state is invalid or already consumed.')
      }
      const pending = parsePending(raw)
      if (
        !pending ||
        pending.redirectUri !== this.#redirectUri ||
        this.#now() - pending.createdAt > PENDING_TTL_MS
      ) {
        throw new BrowserOidcError('invalid_request', 'OIDC authorization request has expired.')
      }
      return pending
    })
  }

  async #exchangeCode(
    code: string,
    pending: PendingAuthorization,
    signal?: AbortSignal,
  ): Promise<{ accessToken: string; idToken: string; expiresIn: number }> {
    const response = await this.#fetcher(new URL('/token', `${this.#issuer}/`).toString(), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: this.#clientId,
        redirect_uri: pending.redirectUri,
        code,
        code_verifier: pending.verifier,
      }).toString(),
      ...(signal ? { signal } : {}),
    })
    const body = await parseJsonResponse(response)
    if (!response.ok) {
      throw new BrowserOidcError(
        'invalid_grant',
        oauthErrorDescription(body) ?? `OIDC token exchange failed with HTTP ${response.status}.`,
        response.status,
      )
    }
    const token = body as TokenEndpointResponse
    if (
      typeof token.access_token !== 'string' ||
      token.access_token.length === 0 ||
      typeof token.id_token !== 'string' ||
      token.id_token.length === 0
    ) {
      throw new BrowserOidcError('server_error', 'OIDC token response is incomplete.', 502)
    }
    // The browser baseline never requests offline_access. Persisting a bearer refresh token in
    // JavaScript storage is intentionally outside this release.
    if (typeof token.refresh_token === 'string' && token.refresh_token.length > 0) {
      throw new BrowserOidcError(
        'server_error',
        'OIDC server returned an unexpected browser refresh token.',
        502,
      )
    }
    return {
      accessToken: token.access_token,
      idToken: token.id_token,
      expiresIn:
        typeof token.expires_in === 'number' && Number.isFinite(token.expires_in)
          ? Math.max(0, token.expires_in)
          : 3600,
    }
  }

  async #fetchUserInfo(
    accessToken: string,
    expectedSub: string,
    signal?: AbortSignal,
  ): Promise<UserInfo> {
    const url = new URL('/userinfo', `${this.#issuer}/`)
    // Public browser clients need client_id on the CORS preflight because OPTIONS has no
    // Authorization header from which the issuer can resolve the registered origin allowlist.
    url.searchParams.set('client_id', this.#clientId)
    const response = await this.#fetcher(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
      ...(signal ? { signal } : {}),
    })
    const body = await parseJsonResponse(response)
    if (!response.ok) {
      throw new BrowserOidcError(
        response.status === 401 ? 'invalid_grant' : 'server_error',
        `OIDC userinfo failed with HTTP ${response.status}.`,
        response.status,
      )
    }
    if (!isUserInfo(body) || body.sub !== expectedSub) {
      throw new BrowserOidcError('server_error', 'OIDC userinfo claims are invalid.', 502)
    }
    return normalizeUserInfo(body)
  }
}

function defaultTokenCache(namespace: string): XidTokenCache {
  try {
    if (typeof globalThis.sessionStorage !== 'undefined') {
      const probe = `__xid_probe_${secureRandomString(8)}`
      globalThis.sessionStorage.setItem(probe, '1')
      globalThis.sessionStorage.removeItem(probe)
      return new SessionStorageTokenCache(`xid:${namespace}`, globalThis.sessionStorage)
    }
  } catch {
    // Privacy modes can deny sessionStorage; memory keeps the current page functional.
  }
  return new MemoryTokenCache(`xid-memory:${namespace}`)
}

function normalizeScopes(scopes: readonly string[] | undefined): readonly string[] {
  const result = [...new Set(scopes ?? ['openid', 'profile', 'email'])]
  if (
    result.length === 0 ||
    result.some((scope) => scope.length === 0 || !OAUTH_SCOPE_TOKEN.test(scope))
  ) {
    throw new BrowserOidcError('invalid_scope', 'OIDC scopes must be valid OAuth scope tokens.')
  }
  if (!result.includes('openid')) {
    throw new BrowserOidcError('invalid_scope', 'OIDC browser clients require openid.')
  }
  if (result.includes('offline_access')) {
    throw new BrowserOidcError(
      'invalid_scope',
      'OIDC browser baseline does not support offline_access.',
    )
  }
  return result
}

function parseHttpsUrl(value: string, field: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch (cause) {
    throw new BrowserOidcError('invalid_request', `${field} must be an absolute URL.`, 400, cause)
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new BrowserOidcError('invalid_request', `${field} must be a public HTTPS URL.`)
  }
  return url
}

function normalizeIssuer(value: string): string {
  const url = parseHttpsUrl(value, 'issuer')
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new BrowserOidcError(
      'invalid_request',
      'issuer must be an HTTPS origin without a path, query, or fragment.',
    )
  }
  return url.origin
}

function normalizeRedirectUri(value: string): string {
  const url = parseHttpsUrl(value, 'redirectUri')
  if (url.hash)
    throw new BrowserOidcError('invalid_request', 'redirectUri cannot contain a fragment.')
  return url.toString()
}

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim()
  if (!normalized) throw new BrowserOidcError('invalid_request', `${field} is required.`)
  return normalized
}

function normalizeReturnUrl(value: string | undefined, redirectUri: string): string {
  const callback = new URL(redirectUri)
  if (!value) return '/'
  const target = new URL(value, callback.origin)
  if (target.origin !== callback.origin) {
    throw new BrowserOidcError('invalid_request', 'returnUrl must use the application origin.')
  }
  return `${target.pathname}${target.search}${target.hash}`
}

function sameRedirectTarget(actual: URL, expected: URL): boolean {
  if (actual.origin !== expected.origin || actual.pathname !== expected.pathname || actual.hash) {
    return false
  }
  for (const [key, value] of expected.searchParams) {
    if (actual.searchParams.getAll(key).filter((entry) => entry === value).length !== 1)
      return false
  }
  const responseKeys = new Set([
    'code',
    'state',
    'session_state',
    'iss',
    'error',
    'error_description',
    'error_uri',
  ])
  for (const key of actual.searchParams.keys()) {
    if (!responseKeys.has(key) && !expected.searchParams.has(key)) return false
  }
  return true
}

function singleQueryParameter(url: URL, key: string): string | null {
  const values = url.searchParams.getAll(key)
  if (values.length > 1) {
    throw new BrowserOidcError('invalid_request', `OIDC callback contains duplicate ${key}.`)
  }
  return values[0] ?? null
}

function secureRandomString(length: number): string {
  return randomString(length, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_')
}

function parsePending(raw: string): PendingAuthorization | null {
  try {
    const value = JSON.parse(raw) as Partial<PendingAuthorization>
    if (
      typeof value.verifier !== 'string' ||
      typeof value.nonce !== 'string' ||
      typeof value.redirectUri !== 'string' ||
      typeof value.returnUrl !== 'string' ||
      (value.intent !== 'sign-in' && value.intent !== 'sign-up') ||
      typeof value.createdAt !== 'number'
    ) {
      return null
    }
    return value as PendingAuthorization
  } catch {
    return null
  }
}

function parseStoredSession(raw: string): StoredOidcSession | null {
  try {
    const value = JSON.parse(raw) as Partial<StoredOidcSession>
    if (
      typeof value.accessToken !== 'string' ||
      typeof value.idToken !== 'string' ||
      typeof value.expiresAt !== 'number' ||
      !Number.isFinite(value.expiresAt) ||
      !isOidcClaims(value.claims) ||
      !isUserInfo(value.userInfo)
    ) {
      return null
    }
    return value as StoredOidcSession
  } catch {
    return null
  }
}

async function verifyIdToken(
  idToken: string,
  input: {
    issuer: string
    clientId: string
    expectedNonce?: string
    fetcher: typeof fetch
    now: () => number
    signal?: AbortSignal
  },
): Promise<OidcClaims> {
  const jwksUri = new URL('/jwks', `${input.issuer}/`).toString()
  let keySet = await loadKeySet(jwksUri, input.fetcher, false, input.signal)
  let result = await verifyJwt(idToken, keySet, {
    expectedIssuer: input.issuer,
    expectedAudience: input.clientId,
    now: Math.floor(input.now() / 1000),
  })
  if (!result.ok && result.error.reason === 'unknown_kid') {
    keySet = await loadKeySet(jwksUri, input.fetcher, true, input.signal)
    result = await verifyJwt(idToken, keySet, {
      expectedIssuer: input.issuer,
      expectedAudience: input.clientId,
      now: Math.floor(input.now() / 1000),
    })
  }
  if (!result.ok) {
    throw new BrowserOidcError(
      'invalid_grant',
      `OIDC ID token verification failed: ${result.error.reason}.`,
      401,
    )
  }
  const claims = result.value.payload
  if (!isOidcClaims(claims)) {
    throw new BrowserOidcError('invalid_grant', 'OIDC ID token claims are incomplete.', 401)
  }
  if (input.expectedNonce !== undefined && claims.nonce !== input.expectedNonce) {
    throw new BrowserOidcError('invalid_grant', 'OIDC ID token nonce mismatch.', 401)
  }
  if (
    (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== input.clientId) ||
    (claims.azp !== undefined && claims.azp !== input.clientId)
  ) {
    throw new BrowserOidcError('invalid_grant', 'OIDC ID token azp mismatch.', 401)
  }
  return claims
}

async function loadKeySet(
  jwksUri: string,
  fetcher: typeof fetch,
  forceRefresh: boolean,
  signal?: AbortSignal,
): Promise<VerifyKeySet> {
  const cached = jwksCache.get(jwksUri)
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.keySet
  const response = await fetcher(jwksUri, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    ...(signal ? { signal } : {}),
  })
  if (!response.ok) {
    throw new BrowserOidcError(
      'server_error',
      `OIDC JWKS fetch failed with HTTP ${response.status}.`,
      response.status,
    )
  }
  const document = await parseJsonResponse(response)
  if (!isRecord(document) || !Array.isArray(document.keys)) {
    throw new BrowserOidcError('server_error', 'OIDC JWKS response is invalid.', 502)
  }
  const keys = await Promise.all(
    document.keys.map(async (raw): Promise<VerifyKeySet['keys'][number] | null> => {
      if (!isPublicSigningJwk(raw)) return null
      try {
        return { kid: raw.kid, alg: raw.alg, publicKey: await importJwkForVerify(raw) }
      } catch {
        return null
      }
    }),
  )
  const usable = keys.filter((key): key is VerifyKeySet['keys'][number] => key !== null)
  if (usable.length === 0) {
    throw new BrowserOidcError('server_error', 'OIDC JWKS has no usable signing key.', 502)
  }
  const keySet = { keys: usable }
  jwksCache.set(jwksUri, { expiresAt: Date.now() + JWKS_CACHE_TTL_MS, keySet })
  return keySet
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch (cause) {
    throw new BrowserOidcError('server_error', 'OIDC endpoint returned invalid JSON.', 502, cause)
  }
}

function oauthErrorDescription(value: unknown): string | null {
  if (!isRecord(value)) return null
  return typeof value.error_description === 'string'
    ? value.error_description
    : typeof value.error === 'string'
      ? value.error
      : null
}

function isPublicSigningJwk(value: unknown): value is PublicJwk {
  if (!isRecord(value)) return false
  if (
    !(
      typeof value.kid === 'string' &&
      value.kid.length > 0 &&
      typeof value.alg === 'string' &&
      SIGNING_ALGORITHMS.has(value.alg) &&
      value.use === 'sig' &&
      typeof value.kty === 'string' &&
      !('d' in value) &&
      !('k' in value) &&
      !('p' in value) &&
      !('q' in value) &&
      !('dp' in value) &&
      !('dq' in value) &&
      !('qi' in value) &&
      !('oth' in value)
    )
  ) {
    return false
  }
  if (
    value.key_ops !== undefined &&
    (!Array.isArray(value.key_ops) ||
      !value.key_ops.includes('verify') ||
      value.key_ops.some((operation) => operation !== 'verify'))
  ) {
    return false
  }
  if (value.alg === 'ES256') {
    return (
      value.kty === 'EC' &&
      value.crv === 'P-256' &&
      typeof value.x === 'string' &&
      value.x.length > 0 &&
      typeof value.y === 'string' &&
      value.y.length > 0
    )
  }
  return (
    value.kty === 'RSA' &&
    typeof value.n === 'string' &&
    value.n.length > 0 &&
    typeof value.e === 'string' &&
    value.e.length > 0
  )
}

function isOidcClaims(value: unknown): value is OidcClaims {
  if (!isRecord(value)) return false
  return (
    typeof value.iss === 'string' &&
    typeof value.sub === 'string' &&
    value.sub.length > 0 &&
    (typeof value.aud === 'string' ||
      (Array.isArray(value.aud) && value.aud.every((entry) => typeof entry === 'string'))) &&
    typeof value.exp === 'number' &&
    Number.isFinite(value.exp) &&
    typeof value.iat === 'number' &&
    Number.isFinite(value.iat) &&
    (value.azp === undefined || typeof value.azp === 'string') &&
    (value.nonce === undefined || typeof value.nonce === 'string') &&
    (value.org_role === undefined || isOrganizationMembershipRole(value.org_role))
  )
}

function isUserInfo(value: unknown): value is UserInfo {
  return (
    isRecord(value) &&
    typeof value.sub === 'string' &&
    value.sub.length > 0 &&
    (value.org_role === undefined || isOrganizationMembershipRole(value.org_role))
  )
}

function normalizeUserInfo(value: UserInfo): UserInfo {
  const out: UserInfo = { sub: value.sub as string }
  for (const key of [
    'email',
    'name',
    'given_name',
    'family_name',
    'picture',
    'phone_number',
    'org_id',
    'org_slug',
    'org_name',
    'provisioned_by',
  ] as const) {
    if (typeof value[key] === 'string') out[key] = value[key] as never
  }
  if (value.org_role !== undefined) {
    if (!isOrganizationMembershipRole(value.org_role)) {
      throw new BrowserOidcError('server_error', 'OIDC userinfo claims are invalid.', 502)
    }
    out.org_role = value.org_role
  }
  if (typeof value.email_verified === 'boolean') out.email_verified = value.email_verified
  if (typeof value.phone_number_verified === 'boolean') {
    out.phone_number_verified = value.phone_number_verified
  }
  if (
    Array.isArray(value.org_permissions) &&
    value.org_permissions.every((entry) => typeof entry === 'string')
  ) {
    out.org_permissions = value.org_permissions
  }
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function signedOutState(): XidState {
  return {
    status: 'ready',
    isLoaded: true,
    isSignedIn: false,
    session: null,
    user: null,
    organization: null,
    sessions: [],
    error: null,
  }
}

function mapUser(session: StoredOidcSession): XidUser {
  const profile = { ...session.claims, ...session.userInfo }
  const organization = mapOrganization(session)
  const memberships: readonly XidOrganizationMembership[] = organization
    ? [
        {
          id: `oidc:${organization.id}:${profile.sub}`,
          organization,
          role: profile.org_role ?? 'member',
          permissions: profile.org_permissions ?? [],
          createdAt: 0,
        },
      ]
    : []
  return {
    id: profile.sub,
    primaryEmailAddress: profile.email ?? null,
    primaryPhoneNumber: profile.phone_number ?? null,
    emailVerified: profile.email_verified ?? false,
    firstName: profile.given_name ?? splitName(profile.name).firstName,
    lastName: profile.family_name ?? splitName(profile.name).lastName,
    fullName: profile.name ?? null,
    username: null,
    imageUrl: profile.picture ?? null,
    hasImage: typeof profile.picture === 'string' && profile.picture.length > 0,
    ...(typeof profile.provisioned_by === 'string'
      ? { provisionedBy: profile.provisioned_by }
      : {}),
    publicMetadata: {},
    organizationMemberships: memberships,
    createdAt: 0,
    updatedAt: 0,
  }
}

function mapOrganization(session: StoredOidcSession): XidOrganization | null {
  const profile = { ...session.claims, ...session.userInfo }
  if (typeof profile.org_id !== 'string') return null
  return {
    id: profile.org_id,
    name: profile.org_name ?? profile.org_id,
    slug: profile.org_slug ?? profile.org_id,
    imageUrl: null,
    hasImage: false,
    membersCount: 0,
    publicMetadata: {},
    createdAt: 0,
  }
}

function mapSession(session: StoredOidcSession): XidSession {
  const sessionId = session.claims.sid ?? `oidc:${session.claims.sub}`
  return {
    id: sessionId,
    status: 'active',
    userId: session.claims.sub,
    activeOrganizationId: session.userInfo.org_id ?? session.claims.org_id ?? null,
    lastActiveAt: session.claims.iat,
    expireAt: Math.floor(session.expiresAt / 1000),
    abandonAt: Math.floor(session.expiresAt / 1000),
    createdAt: session.claims.iat,
  }
}

function splitName(name: string | undefined): {
  firstName: string | null
  lastName: string | null
} {
  if (!name) return { firstName: null, lastName: null }
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return {
    firstName: parts[0] ?? null,
    lastName: parts.length > 1 ? parts.slice(1).join(' ') : null,
  }
}

async function withExclusiveMutation<T>(
  cache: XidTokenCache,
  operation: () => Promise<T>,
): Promise<T> {
  const key = cache.coordinationNamespace ?? cache
  const previous = mutationTails.get(key) ?? Promise.resolve()
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(
    () => gate,
    () => gate,
  )
  mutationTails.set(key, tail)
  await previous.catch(() => undefined)
  try {
    return await operation()
  } finally {
    release()
    if (mutationTails.get(key) === tail) mutationTails.delete(key)
  }
}
