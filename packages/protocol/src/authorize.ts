// /authorize 状态机:纯参数判定,无 I/O;redirect_uri 精确匹配禁 wildcard;prompt 分支 none|login|consent|select_account。

import type { XidError, Result } from '@xid-kit/types'
import { base64UrlEncode } from '@xid-kit/crypto'

const AUTH_CODE_PREFIX = 'ac_'
const CODE_RANDOM_BYTES = 32
const DEFAULT_CODE_TTL_SEC = 60 // OIDC 建议 <=60s

export type ResponseType = 'code' | 'code id_token'
export type Prompt = 'none' | 'login' | 'consent' | 'select_account'

export type AuthorizeRequest = {
  responseType: string
  clientId: string
  redirectUri: string
  scope: string
  state?: string
  nonce?: string
  codeChallenge?: string
  codeChallengeMethod?: string
  prompt?: string
  maxAge?: number
  acrValues?: string
  claims?: string
}

export type ClientRegistration = {
  clientId: string
  active: boolean
  isPublic: boolean
  firstParty: boolean
  redirectUris: readonly string[]
  allowedResponseTypes: readonly ResponseType[]
  allowedScopes: readonly string[]
}

export type SessionState = {
  authenticated: boolean
  authTime: number | null
}

export type ConsentState = {
  scopeAlreadyGranted: boolean
}

// client/redirect 未通过时只能本地错误页,不可重定向到未知 RP。
export type LocalError = { kind: 'local_error'; error: XidError }
// client/redirect 可信后,协议错误可带 error 回 RP。
export type RedirectError = { kind: 'redirect_error'; error: XidError; state?: string }
export type NeedLogin = { kind: 'need_login'; selectAccount: boolean }
export type NeedConsent = { kind: 'need_consent' }
export type EmitCode = { kind: 'emit_code'; scope: string; nonce?: string; state?: string }

export type AuthorizeDirective = LocalError | RedirectError | NeedLogin | NeedConsent | EmitCode

function localError(code: XidError['code'], message: string): LocalError {
  return { kind: 'local_error', error: { code, message, httpStatus: 400 } }
}

function redirectError(code: XidError['code'], message: string, state?: string): RedirectError {
  return { kind: 'redirect_error', error: { code, message, httpStatus: 302 }, state }
}

function validateClientAndRedirect(
  req: AuthorizeRequest,
  client: ClientRegistration,
): LocalError | null {
  if (!client.active) return localError('unauthorized_client', 'client is not active')
  if (client.clientId !== req.clientId) {
    return localError('invalid_request', 'client_id mismatch')
  }
  // 精确字符串匹配,不归一化、不允许 wildcard。
  if (!client.redirectUris.includes(req.redirectUri)) {
    return localError('invalid_request', 'redirect_uri does not exactly match a registered URI')
  }
  return null
}

function validateRequestParams(
  req: AuthorizeRequest,
  client: ClientRegistration,
): RedirectError | null {
  if (!client.allowedResponseTypes.includes(req.responseType as ResponseType)) {
    return redirectError(
      'unsupported_response_type',
      'response_type not allowed for this client',
      req.state,
    )
  }
  const requested = req.scope.split(' ').filter(Boolean)
  if (requested.length === 0) {
    return redirectError('invalid_scope', 'scope is required', req.state)
  }
  const allowed = new Set(client.allowedScopes)
  for (const s of requested) {
    if (!allowed.has(s)) {
      return redirectError('invalid_scope', `scope "${s}" is not registered`, req.state)
    }
  }
  // public client 强制 PKCE S256。
  if (client.isPublic) {
    if (!req.codeChallenge) {
      return redirectError(
        'invalid_request',
        'code_challenge required for public client',
        req.state,
      )
    }
    if (req.codeChallengeMethod !== 'S256') {
      return redirectError('invalid_request', 'code_challenge_method must be S256', req.state)
    }
  } else if (req.codeChallenge && req.codeChallengeMethod !== 'S256') {
    // confidential 带了 challenge 也必须 S256(拒 plain)。
    return redirectError('invalid_request', 'code_challenge_method must be S256', req.state)
  }
  const nonceErr = validateImplicitNonce(req)
  if (nonceErr) return nonceErr
  return validateClaimsParam(req)
}

// hybrid/implicit(response_type 含 id_token)必须带 nonce。
function validateImplicitNonce(req: AuthorizeRequest): RedirectError | null {
  if (req.responseType.split(' ').includes('id_token') && !req.nonce) {
    return redirectError(
      'invalid_request',
      'nonce required for implicit/hybrid response_type',
      req.state,
    )
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateClaimsParam(req: AuthorizeRequest): RedirectError | null {
  if (req.claims === undefined) return null
  try {
    const parsed = JSON.parse(req.claims) as unknown
    if (!isRecord(parsed))
      return redirectError('invalid_request', 'claims must be a JSON object', req.state)
  } catch {
    return redirectError('invalid_request', 'claims must be valid JSON', req.state)
  }
  return null
}

const KNOWN_PROMPTS: readonly Prompt[] = ['none', 'login', 'consent', 'select_account']

// prompt 空格分隔;未知 token 非法,none 不可与其他值并存。
function parsePrompt(raw: string | undefined, state?: string): Set<Prompt> | RedirectError {
  if (raw === undefined || raw === '') return new Set()
  const tokens = raw.split(' ').filter(Boolean)
  const set = new Set<Prompt>()
  for (const token of tokens) {
    if (!(KNOWN_PROMPTS as readonly string[]).includes(token)) {
      return redirectError('invalid_request', `unknown prompt value "${token}"`, state)
    }
    set.add(token as Prompt)
  }
  if (set.has('none') && set.size > 1) {
    return redirectError(
      'invalid_request',
      'prompt=none cannot be combined with other values',
      state,
    )
  }
  return set
}

function resolveSession(
  req: AuthorizeRequest,
  session: SessionState,
  prompt: Set<Prompt>,
  now: number,
): NeedLogin | RedirectError | null {
  const maxAgeStale =
    req.maxAge !== undefined && session.authTime !== null && now - session.authTime > req.maxAge
  const mustReauth = !session.authenticated || prompt.has('login') || maxAgeStale
  if (mustReauth) {
    if (prompt.has('none')) {
      return redirectError('login_required', 'no active session for prompt=none', req.state)
    }
    return { kind: 'need_login', selectAccount: false }
  }
  if (prompt.has('select_account')) {
    return { kind: 'need_login', selectAccount: true }
  }
  return null
}

function resolveConsent(
  req: AuthorizeRequest,
  client: ClientRegistration,
  consent: ConsentState,
  prompt: Set<Prompt>,
): NeedConsent | RedirectError | null {
  if (client.firstParty) return null // first-party 跳过 consent
  const needInteraction = prompt.has('consent') || !consent.scopeAlreadyGranted
  if (!needInteraction) return null
  if (prompt.has('none')) {
    return redirectError('consent_required', 'consent not persisted for prompt=none', req.state)
  }
  return { kind: 'need_consent' }
}

export function evaluateAuthorize(input: {
  req: AuthorizeRequest
  client: ClientRegistration
  session: SessionState
  consent: ConsentState
  now: number
}): AuthorizeDirective {
  const { req, client, session, consent, now } = input

  const clientErr = validateClientAndRedirect(req, client)
  if (clientErr) return clientErr

  const paramErr = validateRequestParams(req, client)
  if (paramErr) return paramErr

  const prompt = parsePrompt(req.prompt, req.state)
  if ('kind' in prompt) return prompt

  const sessionDirective = resolveSession(req, session, prompt, now)
  if (sessionDirective) return sessionDirective

  const consentDirective = resolveConsent(req, client, consent, prompt)
  if (consentDirective) return consentDirective

  return { kind: 'emit_code', scope: req.scope, nonce: req.nonce, state: req.state }
}

export type AuthorizationCode = {
  code: string
  expiresAt: number
}

export function generateAuthorizationCode(
  now: number,
  ttlSec: number = DEFAULT_CODE_TTL_SEC,
): AuthorizationCode {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_RANDOM_BYTES))
  return { code: `${AUTH_CODE_PREFIX}${base64UrlEncode(bytes)}`, expiresAt: now + ttlSec }
}

export function validateAuthorizationCode(input: {
  storedRedirectUri: string | null
  presentedRedirectUri: string | null
  expiresAt: number
  now: number
}): Result<true, XidError> {
  if (input.now > input.expiresAt) {
    return {
      ok: false,
      error: { code: 'invalid_grant', message: 'authorization code expired', httpStatus: 400 },
    }
  }
  // /authorize 时存过 redirect_uri 则兑换必带且精确相等。
  if (input.storedRedirectUri !== null) {
    if (input.presentedRedirectUri !== input.storedRedirectUri) {
      return {
        ok: false,
        error: { code: 'invalid_grant', message: 'redirect_uri mismatch', httpStatus: 400 },
      }
    }
  }
  return { ok: true, value: true }
}

export { AUTH_CODE_PREFIX, DEFAULT_CODE_TTL_SEC }
