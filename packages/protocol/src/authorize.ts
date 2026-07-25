// /authorize 请求校验状态机(03 章 10.1-10.7)。纯算法:校验参数 + 输出下一步指令。
// 无 I/O:session/consent 状态由 endpoint 层查出后注入,本层只做判定。
// redirect_uri 精确匹配不允许 wildcard;PKCE 绑定;prompt 分支 none|login|consent|select_account。

import type { XidError, Result } from '@xid-kit/types'
import { base64UrlEncode } from '@xid-kit/crypto'

const AUTH_CODE_PREFIX = 'ac_'
const CODE_RANDOM_BYTES = 32
const DEFAULT_CODE_TTL_SEC = 60 // OIDC 建议 <=60s(10.4)

export type ResponseType = 'code' | 'code id_token'
export type Prompt = 'none' | 'login' | 'consent' | 'select_account'

// /authorize 入口参数(10.1)。endpoint 层解析 query 后传入。
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

// 已注册的 client 元数据(endpoint 层查 D1 后注入)。
export type ClientRegistration = {
  clientId: string
  active: boolean
  isPublic: boolean
  firstParty: boolean
  redirectUris: readonly string[]
  allowedResponseTypes: readonly ResponseType[]
  allowedScopes: readonly string[]
}

// 当前 session 状态(endpoint 层从 cookie 解析后注入)。
export type SessionState = {
  authenticated: boolean
  authTime: number | null
}

// consent 状态(endpoint 层查 D1 Consent 后注入)。
export type ConsentState = {
  // 已持久化授权的 scope 集是否覆盖本次请求 scope。
  scopeAlreadyGranted: boolean
}

// 校验通过前的本地错误(不可重定向到未知 client / 不可信 redirect_uri)。
export type LocalError = { kind: 'local_error'; error: XidError }
// 校验通过后的可重定向错误(error 作为参数回 RP)。
export type RedirectError = { kind: 'redirect_error'; error: XidError; state?: string }
// 需要用户登录。
export type NeedLogin = { kind: 'need_login'; selectAccount: boolean }
// 需要 consent 交互。
export type NeedConsent = { kind: 'need_consent' }
// 可以签发 authorization code。
export type EmitCode = { kind: 'emit_code'; scope: string; nonce?: string; state?: string }

export type AuthorizeDirective = LocalError | RedirectError | NeedLogin | NeedConsent | EmitCode

function localError(code: XidError['code'], message: string): LocalError {
  return { kind: 'local_error', error: { code, message, httpStatus: 400 } }
}

function redirectError(code: XidError['code'], message: string, state?: string): RedirectError {
  return { kind: 'redirect_error', error: { code, message, httpStatus: 302 }, state }
}

// 第一段:client_id / redirect_uri 校验(失败渲染本地错误页,不可重定向)。
function validateClientAndRedirect(
  req: AuthorizeRequest,
  client: ClientRegistration,
): LocalError | null {
  if (!client.active) return localError('unauthorized_client', 'client is not active')
  if (client.clientId !== req.clientId) {
    return localError('invalid_request', 'client_id mismatch')
  }
  // 精确字符串匹配,不归一化、不允许 wildcard(10.2 / oidc-oauth rule)。
  if (!client.redirectUris.includes(req.redirectUri)) {
    return localError('invalid_request', 'redirect_uri does not exactly match a registered URI')
  }
  return null
}

// 第二段:response_type / scope / PKCE 校验(失败可重定向回 RP)。
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
  // public client 强制 PKCE S256(oidc-oauth rule)。
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

// 隐含/hybrid(response_type 含 id_token)必须带 nonce(OIDC Core 3.1.2.1、10.1)。
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

// prompt 是空格分隔列表(OIDC Core 3.1.2.1)。未知 token 或 none 与其他值并存均非法。
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

// 第三段:session + prompt 分支(10.2)。
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
  // prompt=select_account:已登录也展示账户选择(10.2)。
  if (prompt.has('select_account')) {
    return { kind: 'need_login', selectAccount: true }
  }
  return null
}

// 第四段:consent 分支(10.5)。
function resolveConsent(
  req: AuthorizeRequest,
  client: ClientRegistration,
  consent: ConsentState,
  prompt: Set<Prompt>,
): NeedConsent | RedirectError | null {
  if (client.firstParty) return null // first-party 跳过 consent(10.5)
  const needInteraction = prompt.has('consent') || !consent.scopeAlreadyGranted
  if (!needInteraction) return null
  if (prompt.has('none')) {
    return redirectError('consent_required', 'consent not persisted for prompt=none', req.state)
  }
  return { kind: 'need_consent' }
}

// 主入口:执行 10.2 状态机,输出下一步指令。
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

// authorization code 生成(10.4:ac_ 前缀 + 256bit base64url,一次性,60s)。
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

// authorization code 兑换校验(9.1 第 3/5 步:过期 + redirect_uri 精确匹配)。
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
  // /authorize 时带过 redirect_uri 则本次必带且精确相等(9.1 第 5 步)。
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
