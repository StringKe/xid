// Social OAuth 与企业 SSO(OIDC RP / SAML SP)共用的浏览器联邦流程骨架:
// OAuthFlowDO 一次性 state 存取、PKCE/state/nonce 生成、邀请输入拒绝、浏览器错误回登录页。

import { base64UrlEncode } from '@xid-kit/crypto'
import type { Context } from 'hono'
import {
  isInvitationContinuation,
  normalizeLocalContinuePath,
} from '../../shared/hosted-auth-continuation'
import { AppError, isAppError } from './errors'
import { logWorkerWarning } from './safe-log'
import { OAUTH_FLOW_STATE_TTL_MS } from './ttl'
import type { XidHonoEnv } from './types'

export type FederatedFlowPrefix = 'state' | 'sso-oidc'

export type FederatedFlowRecord = Record<string, unknown>

const PKCE_VERIFIER_BYTES = 43
const SAFE_LOG_REASON = /^[a-z][a-z0-9_]{0,63}$/u
const STATE_BYTES = 32

export const STATE_INVALID = 'state_invalid'

function oauthFlowStub(env: Env, prefix: FederatedFlowPrefix, state: string): DurableObjectStub {
  const ns = env.OAUTH_STATE
  return ns.get(ns.idFromName(`${prefix}:${state}`))
}

export async function storeFederatedFlow(
  env: Env,
  input: { prefix: FederatedFlowPrefix; state: string; payload: FederatedFlowRecord },
): Promise<void> {
  const stub = oauthFlowStub(env, input.prefix, input.state)
  const res = await stub.fetch('https://oauth-flow/store', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: input.state, ...input.payload, ttlMs: OAUTH_FLOW_STATE_TTL_MS }),
  })
  if (res.status !== 201) throw new AppError('internal_error')
}

// fail closed:只有 DO 明确回 404(不存在)/ 410(已过期)才是 state 无效;其余状态码与坏 body
// 都是协调层故障,当成 state 无效放行会让一次性消费(CSRF + code 重放防护)失效。
export async function consumeFederatedFlow(
  env: Env,
  input: { prefix: FederatedFlowPrefix; state: string },
): Promise<FederatedFlowRecord | null> {
  const stub = oauthFlowStub(env, input.prefix, input.state)
  const res = await stub.fetch('https://oauth-flow/consume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: input.state }),
  })
  if (res.status === 404 || res.status === 410) return null
  if (res.status !== 200) throw new AppError('server_error')
  let body: unknown
  try {
    body = await res.json()
  } catch (error) {
    throw new AppError('server_error', { cause: error })
  }
  return flowObject(flowObject(body)['record'])
}

function flowObject(value: unknown): FederatedFlowRecord {
  if (!value || typeof value !== 'object') throw new AppError('server_error')
  return value as FederatedFlowRecord
}

// DO record 是流程唯一真相源:形状不完整时绝不能带缺省值继续换码,否则 PKCE / nonce 绑定被跳过。
export function requiredFlowString(record: FederatedFlowRecord, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) throw new AppError('server_error')
  return value
}

export function optionalFlowString(record: FederatedFlowRecord, key: string): string | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) throw new AppError('server_error')
  return value
}

export function optionalFlowBoolean(record: FederatedFlowRecord, key: string): boolean | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new AppError('server_error')
  return value
}

export function requiredFlowNumber(record: FederatedFlowRecord, key: string): number {
  const value = record[key]
  if (typeof value !== 'number') throw new AppError('server_error')
  return value
}

// 旧版本 flow 可能持有邀请 capability;联邦回调绝不消费邀请(01 章 3)。
export function assertNoInvitationInFlow(record: FederatedFlowRecord, continuePath: string): void {
  if (
    record['invitationId'] !== undefined ||
    record['invitationToken'] !== undefined ||
    record['invitation_token'] !== undefined ||
    isInvitationContinuation(continuePath)
  ) {
    throw new AppError('invalid_request')
  }
}

export async function computeCodeChallenge(codeVerifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier))
  return base64UrlEncode(new Uint8Array(digest))
}

export type FederatedFlowSecrets = {
  state: string
  nonce: string
  codeVerifier: string
  codeChallenge: string
}

export async function newFederatedFlowSecrets(): Promise<FederatedFlowSecrets> {
  const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(STATE_BYTES)))
  const nonce = base64UrlEncode(crypto.getRandomValues(new Uint8Array(STATE_BYTES)))
  const codeVerifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(PKCE_VERIFIER_BYTES)))
  return { state, nonce, codeVerifier, codeChallenge: await computeCodeChallenge(codeVerifier) }
}

// 原始邀请 capability 不得进入联邦授权状态(01 章 3);邀请只走 Email claim。
export function requestHasRawInvitationInput(
  c: Context<XidHonoEnv>,
  continuationParameters: readonly string[],
): boolean {
  const query = new URL(c.req.url).searchParams
  if (query.has('invitation_token') || query.has('invitationToken')) return true
  return continuationParameters.some((name) =>
    query.getAll(name).some((value) => isInvitationContinuation(value)),
  )
}

export const FEDERATED_SIGN_IN_ERRORS = ['cancelled', 'sign_in_failed', 'session_expired'] as const

export type FederatedSignInError = (typeof FEDERATED_SIGN_IN_ERRORS)[number]

export type SignInReturnContext = {
  continuePath?: string | null
  applicationClientId?: string | null
  intent?: string | null
}

// 相对 Location:与发起请求同源,不依赖任何请求参数推导 origin,没有开放重定向面。
export function redirectToSignInWithError(
  c: Context<XidHonoEnv>,
  error: FederatedSignInError,
  context: SignInReturnContext = {},
): Response {
  const params = new URLSearchParams({ error })
  const continuePath = normalizeLocalContinuePath(context.continuePath)
  if (continuePath && !isInvitationContinuation(continuePath)) {
    params.set('continue', continuePath)
  }
  if (context.applicationClientId) params.set('client_id', context.applicationClientId)
  if (context.intent) params.set('intent', context.intent)
  c.header('Cache-Control', 'no-store')
  return c.redirect(`/sign-in?${params}`, 302)
}

function signInErrorFor(error: AppError): FederatedSignInError {
  if (error.longMessage === STATE_INVALID) return 'session_expired'
  if (error.code === 'access_denied') return 'cancelled'
  return 'sign_in_failed'
}

function isBrowserNavigation(c: Context<XidHonoEnv>): boolean {
  if (c.req.header('sec-fetch-mode') === 'navigate') return true
  return (c.req.header('accept') ?? '').includes('text/html')
}

// 浏览器顶层导航到联邦端点时,预期失败(AppError)回登录页并只带白名单不透明码,
// 不区分账号存在性或合并拒绝原因;程序化调用保留 XidAPIError JSON 契约;非预期异常交给全局 onError。
export async function withSignInErrorRedirect(
  c: Context<XidHonoEnv>,
  input: { operation: string; context?: () => SignInReturnContext; run: () => Promise<Response> },
): Promise<Response> {
  try {
    return await input.run()
  } catch (error) {
    if (!isAppError(error) || !isBrowserNavigation(c)) throw error
    logWorkerWarning('auth.federated.rejected', {
      component: 'auth',
      operation: input.operation,
      outcome: error.code,
      ...(error.logReason && SAFE_LOG_REASON.test(error.logReason)
        ? { reason: error.logReason }
        : {}),
      status: error.httpStatus,
    })
    return redirectToSignInWithError(c, signInErrorFor(error), input.context?.() ?? {})
  }
}
