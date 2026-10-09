// 出站 SAML IdP:未完成认证时把已验证的 AuthnRequest 上下文(InResponseTo、RelayState、ForceAuthn、
// NameIDPolicy、RequestedAuthnContext 和收到请求的时间)暂存到 OAuthFlowDO,continue 只带不透明 id。
// POST 绑定的 SAMLRequest 在表单里,无法放进 continue URL。

import type { RequestedAuthnContext } from '@xid-kit/saml'
import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import type { SessionData, XidHonoEnv } from '../lib/types'
import { mfaRedirectPath, mfaSetupRedirectPath } from '../lib/mfa-session'
import { OAUTH_FLOW_STATE_TTL_MS } from '../lib/ttl'

export const OUTBOUND_SSO_RESUME_PARAM = 'saml_request'

export type OutboundSsoRequest = {
  inResponseTo: string | undefined
  relayState: string | null
  forceAuthn: boolean
  isPassive: boolean
  nameIdFormat: string | undefined
  requestedAuthnContext: RequestedAuthnContext | null
  // 已为满足 RequestedAuthnContext 让用户交互过一次;续跑仍不满足时回 NoAuthnContext,不再重定向。
  authnContextAttempted: boolean
  requestedAt: number
}

export type OutboundSsoInteraction = 'sign_in' | 'reauthenticate' | 'step_up'

function continuationStub(c: Context<XidHonoEnv>, id: string): DurableObjectStub {
  const ns = c.env.OAUTH_STATE
  return ns.get(ns.idFromName(`saml-sso:${c.get('tenant').tenantId}:${id}`))
}

export async function stashOutboundSsoRequest(
  c: Context<XidHonoEnv>,
  input: { appId: string; request: OutboundSsoRequest },
): Promise<string> {
  const id = crypto.randomUUID()
  const { request } = input
  const res = await continuationStub(c, id).fetch('https://oauth-flow-do/store', {
    method: 'POST',
    body: JSON.stringify({
      state: id,
      pendingParams: {
        appId: input.appId,
        relayState: request.relayState,
        forceAuthn: request.forceAuthn,
        requestedAt: request.requestedAt,
        requestedAuthnContext: request.requestedAuthnContext,
        authnContextAttempted: request.authnContextAttempted,
        ...(request.inResponseTo ? { inResponseTo: request.inResponseTo } : {}),
        ...(request.nameIdFormat ? { nameIdFormat: request.nameIdFormat } : {}),
      },
      ttlMs: OAUTH_FLOW_STATE_TTL_MS,
    }),
  })
  if (res.status !== 201) throw new AppError('server_error')
  return id
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new AppError('server_error')
  return value
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new AppError('server_error')
  }
  return value
}

// 发版前暂存的续跑记录没有这两个字段,按「未请求」「未交互过」处理。
function parseRequestedAuthnContext(value: unknown): RequestedAuthnContext | null {
  if (value === null || value === undefined) return null
  if (!value || typeof value !== 'object') throw new AppError('server_error')
  const record = value as Record<string, unknown>
  const comparison = record['comparison']
  if (
    comparison !== 'exact' &&
    comparison !== 'minimum' &&
    comparison !== 'maximum' &&
    comparison !== 'better'
  ) {
    throw new AppError('server_error')
  }
  return {
    comparison,
    classRefs: stringList(record['classRefs']),
    declRefs: stringList(record['declRefs']),
  }
}

function parseStashedRequest(body: unknown, appId: string): OutboundSsoRequest {
  const record = (body as { record?: { pendingParams?: Record<string, unknown> } }).record
  const params = record?.pendingParams
  if (!params || params['appId'] !== appId) throw new AppError('invalid_request')
  const relayState = params['relayState']
  const forceAuthn = params['forceAuthn']
  const requestedAt = params['requestedAt']
  const authnContextAttempted = params['authnContextAttempted'] ?? false
  if (relayState !== null && typeof relayState !== 'string') throw new AppError('server_error')
  if (
    typeof forceAuthn !== 'boolean' ||
    typeof requestedAt !== 'number' ||
    typeof authnContextAttempted !== 'boolean'
  ) {
    throw new AppError('server_error')
  }
  return {
    inResponseTo: optionalString(params['inResponseTo']),
    relayState,
    forceAuthn,
    // IsPassive 请求从不暂存:没有会话时直接回 NoPassive。
    isPassive: false,
    nameIdFormat: optionalString(params['nameIdFormat']),
    requestedAuthnContext: parseRequestedAuthnContext(params['requestedAuthnContext']),
    authnContextAttempted,
    requestedAt,
  }
}

export async function consumeOutboundSsoRequest(
  c: Context<XidHonoEnv>,
  input: { appId: string; id: string },
): Promise<OutboundSsoRequest> {
  const res = await continuationStub(c, input.id).fetch('https://oauth-flow-do/consume', {
    method: 'POST',
    body: JSON.stringify({ state: input.id }),
  })
  if (res.status === 404 || res.status === 410) throw new AppError('invalid_request')
  if (res.status !== 200) throw new AppError('server_error')
  let body: unknown
  try {
    body = await res.json()
  } catch (error) {
    throw new AppError('server_error', { cause: error })
  }
  return parseStashedRequest(body, input.appId)
}

export function outboundSsoResumePath(appId: string, id: string): string {
  const params = new URLSearchParams({ [OUTBOUND_SSO_RESUME_PARAM]: id })
  return `/sso/outbound/saml/${encodeURIComponent(appId)}/sso?${params.toString()}`
}

// reauthenticate 一律回登录页重新认证;step_up 让 active 会话补一次 MFA(只发 step-up token,不升级会话);
// sign_in 时待完成 MFA 的会话去完成 MFA,其余去登录。完成后回到续跑地址签发 SAMLResponse。
export function outboundSsoInteractionRedirect(
  c: Context<XidHonoEnv>,
  input: { session: SessionData | null; returnTo: string; interaction: OutboundSsoInteraction },
): Response {
  const ctx = c.get('tenant')
  if (input.interaction === 'step_up') {
    const url = new URL(`${ctx.issuer}/mfa`)
    url.searchParams.set('step_up', '1')
    url.searchParams.set('organization_id', ctx.tenantId)
    url.searchParams.set('redirect_to', input.returnTo)
    return c.redirect(url.toString(), 302)
  }
  const reauthenticate = input.interaction === 'reauthenticate'
  if (!reauthenticate && input.session?.status === 'pending_mfa') {
    return c.redirect(`${ctx.issuer}${mfaRedirectPath(input.returnTo)}`, 302)
  }
  if (!reauthenticate && input.session?.status === 'pending_mfa_setup') {
    return c.redirect(`${ctx.issuer}${mfaSetupRedirectPath(input.returnTo)}`, 302)
  }
  const url = new URL(`${ctx.issuer}/sign-in`)
  url.searchParams.set('organization_id', ctx.tenantId)
  url.searchParams.set('continue', input.returnTo)
  if (reauthenticate) url.searchParams.set('reauthenticate', '1')
  return c.redirect(url.toString(), 302)
}
