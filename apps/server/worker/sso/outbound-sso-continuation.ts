// 出站 SAML IdP:未完成认证时把已验证的 AuthnRequest 上下文(InResponseTo、RelayState、ForceAuthn、
// NameIDPolicy 和收到请求的时间)暂存到 OAuthFlowDO,continue 只带不透明 id。
// POST 绑定的 SAMLRequest 在表单里,无法放进 continue URL。

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
  requestedAt: number
}

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

function parseStashedRequest(body: unknown, appId: string): OutboundSsoRequest {
  const record = (body as { record?: { pendingParams?: Record<string, unknown> } }).record
  const params = record?.pendingParams
  if (!params || params['appId'] !== appId) throw new AppError('invalid_request')
  const relayState = params['relayState']
  const forceAuthn = params['forceAuthn']
  const requestedAt = params['requestedAt']
  if (relayState !== null && typeof relayState !== 'string') throw new AppError('server_error')
  if (typeof forceAuthn !== 'boolean' || typeof requestedAt !== 'number') {
    throw new AppError('server_error')
  }
  return {
    inResponseTo: optionalString(params['inResponseTo']),
    relayState,
    forceAuthn,
    // IsPassive 请求从不暂存:没有会话时直接回 NoPassive。
    isPassive: false,
    nameIdFormat: optionalString(params['nameIdFormat']),
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

// ForceAuthn 一律回登录页重新认证;否则待完成 MFA 的会话去完成 MFA,其余去登录。
// 完成后回到续跑地址签发 SAMLResponse。
export function outboundSsoInteractionRedirect(
  c: Context<XidHonoEnv>,
  input: { session: SessionData | null; returnTo: string; reauthenticate: boolean },
): Response {
  const ctx = c.get('tenant')
  if (!input.reauthenticate && input.session?.status === 'pending_mfa') {
    return c.redirect(`${ctx.issuer}${mfaRedirectPath(input.returnTo)}`, 302)
  }
  if (!input.reauthenticate && input.session?.status === 'pending_mfa_setup') {
    return c.redirect(`${ctx.issuer}${mfaSetupRedirectPath(input.returnTo)}`, 302)
  }
  const url = new URL(`${ctx.issuer}/sign-in`)
  url.searchParams.set('organization_id', ctx.tenantId)
  url.searchParams.set('continue', input.returnTo)
  if (input.reauthenticate) url.searchParams.set('reauthenticate', '1')
  return c.redirect(url.toString(), 302)
}
