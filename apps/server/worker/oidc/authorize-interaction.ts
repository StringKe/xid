// /authorize 交互暂存与续跑:未登录、需重新认证、MFA、选组织、consent 时把请求暂存到
// OAuthFlowDO(key=authz_request_id),302 到 Hosted UI;完成后回 /authorize?authz_request_id= 续跑。

import type { Context } from 'hono'
import { renderProtocolErrorPage } from '../lib/error-page'
import type { XidHonoEnv } from '../lib/types'
import { APPLICATION_SIGN_UP_INTENT } from '../../shared/hosted-auth-intent'
import { storeStashedAuthorizeRecord, type StashedAuthorizeRecord } from './pending-params'

export type RawParams = Record<string, string>

export type InteractionPath =
  | '/sign-in'
  | '/consent'
  | '/mfa'
  | '/select-organization'
  | '/mfa/setup'

// 本地错误页(client_id/redirect_uri 不可信,不可重定向,10.2/10.7)。
export function localErrorPage(
  c: Context<XidHonoEnv>,
  error: string,
  description: string,
  httpStatus = 400,
): Promise<Response> {
  return renderProtocolErrorPage(c, { status: httpStatus, error, description })
}

export function promptValues(params: RawParams): string[] {
  return params['prompt']?.split(' ').filter(Boolean) ?? []
}

export function hostedIntentForAuthorize(
  params: RawParams,
): 'sign-in' | typeof APPLICATION_SIGN_UP_INTENT {
  return params['xid_intent'] === 'sign-up' ? APPLICATION_SIGN_UP_INTENT : 'sign-in'
}

function requestsInteractiveSignIn(params: RawParams): boolean {
  const prompts = promptValues(params)
  return (
    params['xid_intent'] === 'sign-up' ||
    prompts.includes('login') ||
    prompts.includes('select_account')
  )
}

export function withoutPrompts(params: RawParams, removed: readonly string[]): RawParams {
  const next = { ...params }
  const prompts = promptValues(next).filter((value) => !removed.includes(value))
  if (prompts.length > 0) next['prompt'] = prompts.join(' ')
  else delete next['prompt']
  return next
}

// 重新认证完成后去掉已满足的约束。max_age 一并删除:auth_time 照常写入 token,
// 保留它会让 max_age=0 在秒级时间差下再次判为超龄,形成登录循环。
export function stripSatisfiedFreshAuthentication(params: RawParams): RawParams {
  const next = withoutPrompts(params, ['login', 'select_account'])
  delete next['xid_intent']
  delete next['max_age']
  return next
}

export function authorizeResumePath(authzRequestId: string, clientId: string | undefined): string {
  const params = new URLSearchParams({ authz_request_id: authzRequestId })
  if (clientId) params.set('client_id', clientId)
  return `/authorize?${params.toString()}`
}

function signInUrl(
  c: Context<XidHonoEnv>,
  input: { authzRequestId: string; params: RawParams; freshAuthentication: boolean },
): URL {
  const ctx = c.get('tenant')
  const url = new URL(`${ctx.issuer}/sign-in`)
  url.searchParams.set('authz_request_id', input.authzRequestId)
  url.searchParams.set('organization_id', ctx.tenantId)
  const clientId = input.params['client_id']
  if (clientId) url.searchParams.set('client_id', clientId)
  url.searchParams.set('intent', hostedIntentForAuthorize(input.params))
  if (input.freshAuthentication) url.searchParams.set('reauthenticate', '1')
  return url
}

function setLoginHint(url: URL, params: RawParams): void {
  const loginHint = params['login_hint']
  if (loginHint) url.searchParams.set('login_hint', loginHint)
}

// stepUp 仅 /mfa 路径有效:true=acr step-up(不升级 session);pending_mfa 续跑必须传 false,
// 否则 MFA 验证只发 step-up token、session 仍 pending,回 /authorize 会再次重定向形成循环。
export async function stashAndRedirect(
  c: Context<XidHonoEnv>,
  input: {
    params: RawParams
    path: InteractionPath
    viaPar: boolean
    selectAccount: boolean
    freshAuthentication?: boolean
    stepUp?: boolean
  },
): Promise<Response> {
  const ctx = c.get('tenant')
  const authzRequestId = crypto.randomUUID()
  const createdAt = Date.now()
  const freshAuthentication =
    input.path === '/sign-in' &&
    (input.freshAuthentication === true || requestsInteractiveSignIn(input.params))
  const record: StashedAuthorizeRecord = {
    params: input.params,
    createdAt,
    interactionStartedAt: freshAuthentication ? createdAt : null,
    viaPar: input.viaPar,
    consentDecision: null,
  }
  // 暂存失败仍跳登录页只会撞上"请求已过期";stash 携带 PKCE / acr 要求,静默丢弃等于降级。
  if (!(await storeStashedAuthorizeRecord(c.env, ctx.tenantId, authzRequestId, record))) {
    return localErrorPage(c, 'server_error', 'authorization request storage unavailable', 500)
  }
  if (input.path === '/sign-in') {
    const url = signInUrl(c, { authzRequestId, params: input.params, freshAuthentication })
    if (input.selectAccount) url.searchParams.set('select_account', '1')
    setLoginHint(url, input.params)
    return c.redirect(url.toString(), 302)
  }
  const url = new URL(`${ctx.issuer}${input.path}`)
  url.searchParams.set('authz_request_id', authzRequestId)
  url.searchParams.set('organization_id', ctx.tenantId)
  const clientId = input.params['client_id']
  if (clientId) url.searchParams.set('client_id', clientId)
  if (input.path !== '/consent') {
    url.searchParams.set('redirect_to', authorizeResumePath(authzRequestId, clientId))
  }
  if (input.path === '/mfa') {
    if (input.stepUp) url.searchParams.set('step_up', '1')
    const method = input.params['method']
    if (method) url.searchParams.set('method', method)
  }
  if (input.selectAccount) url.searchParams.set('select_account', '1')
  setLoginHint(url, input.params)
  return c.redirect(url.toString(), 302)
}

// 续跑时会话缺失或尚未完成要求的重新认证:回登录页,保留 reauthenticate 标记。
export function redirectToStashedSignIn(
  c: Context<XidHonoEnv>,
  authzRequestId: string,
  record: StashedAuthorizeRecord,
): Response {
  const url = signInUrl(c, {
    authzRequestId,
    params: record.params,
    freshAuthentication: record.interactionStartedAt !== null,
  })
  if (promptValues(record.params).includes('select_account')) {
    url.searchParams.set('select_account', '1')
  }
  setLoginHint(url, record.params)
  return c.redirect(url.toString(), 302)
}
