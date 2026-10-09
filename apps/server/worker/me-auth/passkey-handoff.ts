// 跨主机会话交接:多租户下 passkey 仪式只在组织 rpId 主机({slug}.{primary} 或已启用自定义域)进行,
// __Host- 会话 cookie 不能跨主机,由一次性 grant(SessionHandoffDO)把会话交给目标主机,方向可以是
// 根域 -> 组织主机(账户页登记 passkey、待 MFA 会话用 passkey 第二因子)或组织主机 -> 根域(续跑 /authorize)。
// 防伪靠目标主机自己写入的 __Host- state cookie:grant 绑定 state 的哈希,别的主机或第三方签发的 grant
// 无法在用户浏览器里消费。会话状态原样携带,待 MFA 的会话交接后仍待 MFA。

import { base64UrlEncode, sha256Hex } from '@xid-kit/crypto'
import { createTenantDb, resolveTenantContextById, schema } from '@xid-kit/db'
import { and, eq, isNull } from 'drizzle-orm'
import type { Context } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import * as v from 'valibot'
import { issueStepUpCookie } from '../lib/step-up'
import type {
  ConsumedSessionHandoff,
  HandoffSessionStatus,
  HandoffStepUp,
} from '../durable-objects/session-handoff-do'
import type { AmrValue } from '@xid-kit/types'
import type { AuthContextData } from '../lib/auth-context'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import { issueSession } from '../lib/session'
import { SESSION_HANDOFF_STATE_MAX_AGE_SEC, SESSION_HANDOFF_TTL_MS } from '../lib/ttl'
import type { TenantVar, XidHonoEnv } from '../lib/types'
import { isInstanceEntryContext, withTenant } from './instance-login'
import { isHandoffContinuation, SESSION_HANDOFF_PATH } from './passkey-handoff-paths'
import { requestIp, requestUserAgent } from './shared'

const HANDOFF_STATE_COOKIE = '__Host-xid.handoff'
const OPAQUE_BYTES = 32

export const handoffTokenSchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{32,128}$/))
export const handoffStateSchema = handoffTokenSchema

export type SessionHandoffForm = {
  action: string
  method: 'POST'
  fields: { grantId: string; secret: string; organizationId: string }
}

export type HandoffSession = {
  userId: string
  status: HandoffSessionStatus
  authenticatedAt: Date
  acr: string | null
  amr: readonly string[] | null
  aal: number | null
  rememberMe: boolean
  stepUp: HandoffStepUp | null
}

const HOST_COOKIE = { path: '/', secure: true, httpOnly: true, sameSite: 'Lax' } as const

function opaqueRandom(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(OPAQUE_BYTES)))
}

function handoffStub(env: Env, grantId: string): DurableObjectStub {
  const namespace = env.SESSION_HANDOFF
  return namespace.get(namespace.idFromName(`handoff:${grantId}`))
}

export function requestOrigin(c: Context<XidHonoEnv>): string {
  return new URL(c.req.url).origin
}

export function issuerOrigin(tenant: TenantVar): string {
  return new URL(tenant.issuer).origin
}

// 开发环境走 http 与端口,生产只用 https。
function originForHost(c: Context<XidHonoEnv>, hostname: string): string {
  const request = new URL(c.req.url)
  if (request.protocol === 'https:') return `https://${hostname}`
  return `${request.protocol}//${hostname}${request.port ? `:${request.port}` : ''}`
}

export function ceremonyHostOrigin(c: Context<XidHonoEnv>, tenant: TenantVar): string {
  return originForHost(c, tenant.rpId)
}

// 当前主机不是租户 rpId 时返回应当完成仪式的 origin;同主机返回 null。
export function passkeyCeremonyOrigin(c: Context<XidHonoEnv>, tenant: TenantVar): string | null {
  if (new URL(c.req.url).hostname === tenant.rpId) return null
  return ceremonyHostOrigin(c, tenant)
}

// 同一租户只在组织 rpId 主机与 issuer 主机之间交接。
export function handoffTargets(c: Context<XidHonoEnv>, tenant: TenantVar): string[] {
  const current = requestOrigin(c)
  return [ceremonyHostOrigin(c, tenant), issuerOrigin(tenant)].filter(
    (origin, index, all) => origin !== current && all.indexOf(origin) === index,
  )
}

// 目标主机写入 state cookie,同时把值交给浏览器带到来源主机去签发 grant。
export function setHandoffState(c: Context<XidHonoEnv>): string {
  const state = opaqueRandom()
  setCookie(c, HANDOFF_STATE_COOKIE, state, {
    ...HOST_COOKIE,
    maxAge: SESSION_HANDOFF_STATE_MAX_AGE_SEC,
  })
  return state
}

export function readHandoffState(c: Context<XidHonoEnv>): string | null {
  const state = getCookie(c, HANDOFF_STATE_COOKIE)
  return state && v.safeParse(handoffStateSchema, state).success ? state : null
}

export function clearHandoffState(c: Context<XidHonoEnv>): void {
  setCookie(c, HANDOFF_STATE_COOKIE, '', { ...HOST_COOKIE, maxAge: 0 })
}

// 来源主机签发 grant;目标必须是同一租户的另一台交接主机。
export async function mintSessionHandoff(
  c: Context<XidHonoEnv>,
  input: {
    tenant: TenantVar
    targetOrigin: string
    session: HandoffSession
    continuePath: string
    state: string
  },
): Promise<SessionHandoffForm> {
  const { tenant, session } = input
  if (!tenant.instanceId) throw new AppError('invalid_request')
  if (!handoffTargets(c, tenant).includes(input.targetOrigin)) throw new AppError('invalid_request')
  if (!isHandoffContinuation(input.continuePath)) throw new AppError('invalid_request')
  const grantId = opaqueRandom()
  const secret = opaqueRandom()
  const response = await handoffStub(c.env, grantId).fetch('https://session-handoff/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      secretHash: await sha256Hex(secret),
      stateHash: await sha256Hex(input.state),
      tenantId: tenant.tenantId,
      instanceId: tenant.instanceId,
      targetOrigin: input.targetOrigin,
      userId: session.userId,
      continuePath: input.continuePath,
      authenticatedAt: session.authenticatedAt.getTime(),
      sessionStatus: session.status,
      acr: session.acr,
      amr: session.amr,
      aal: session.aal,
      rememberMe: session.rememberMe,
      stepUp: session.stepUp,
      ttlMs: SESSION_HANDOFF_TTL_MS,
    }),
  })
  if (response.status !== 201) throw new AppError('server_error')
  return {
    action: `${input.targetOrigin}${SESSION_HANDOFF_PATH}`,
    method: 'POST',
    fields: { grantId, secret, organizationId: tenant.tenantId },
  }
}

// 目标主机上解析 grant 所属租户:根域按组织 id 在本实例内解析,组织主机必须就是该组织。
async function resolveHandoffTenant(
  c: Context<XidHonoEnv>,
  organizationId: string,
): Promise<TenantVar> {
  const current = c.get('tenant')
  if (!isInstanceEntryContext(current)) {
    if (current.tenantId !== organizationId) throw new AppError('unauthorized', { httpStatus: 401 })
    return current
  }
  const resolved = await resolveTenantContextById(c.req.raw, c.env, organizationId)
  if (!resolved.ok || resolved.value.tenant.instanceId !== current.instanceId) {
    throw new AppError('unauthorized', { httpStatus: 401 })
  }
  return resolved.value.tenant
}

function parseConsumed(value: unknown): ConsumedSessionHandoff | null {
  if (typeof value !== 'object' || value === null) return null
  const grant = (value as { grant?: unknown }).grant
  if (typeof grant !== 'object' || grant === null) return null
  const record = grant as Record<string, unknown>
  const strings = ['tenantId', 'instanceId', 'targetOrigin', 'userId', 'continuePath'] as const
  if (!strings.every((key) => typeof record[key] === 'string')) return null
  if (typeof record['authenticatedAt'] !== 'number') return null
  return record as ConsumedSessionHandoff
}

async function consumeGrant(
  c: Context<XidHonoEnv>,
  input: { grantId: string; secret: string; state: string; tenant: TenantVar },
): Promise<ConsumedSessionHandoff> {
  const { tenant } = input
  if (!tenant.instanceId) throw new AppError('unauthorized', { httpStatus: 401 })
  const response = await handoffStub(c.env, input.grantId).fetch(
    'https://session-handoff/consume',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        secretHash: await sha256Hex(input.secret),
        stateHash: await sha256Hex(input.state),
        tenantId: tenant.tenantId,
        instanceId: tenant.instanceId,
        targetOrigin: requestOrigin(c),
      }),
    },
  )
  if (response.status === 404 || response.status === 410) {
    throw new AppError('unauthorized', { httpStatus: 401 })
  }
  if (response.status !== 200) throw new AppError('server_error')
  const grant = parseConsumed(await response.json().catch(() => null))
  if (!grant) throw new AppError('server_error')
  return grant
}

// 来源会话的认证上下文原样带过去;来源会话没有完整上下文时目标会话同样没有。
function authContextOf(grant: ConsumedSessionHandoff): { authContext?: AuthContextData } {
  const { acr, amr, aal } = grant
  if (acr === null || amr === null || (aal !== 1 && aal !== 2)) return {}
  return { authContext: { acr, amr: amr as readonly AmrValue[], aal } }
}

// 消费 grant 并在本主机签发同状态的会话,返回续跑路径。state 只在消费成功后清除,
// 第三方伪造的表单不能打断用户正在进行的交接。
export async function completeSessionHandoff(
  c: Context<XidHonoEnv>,
  form: { grantId: string; secret: string; organizationId: string },
): Promise<string> {
  const state = readHandoffState(c)
  if (!state) throw new AppError('unauthorized', { httpStatus: 401 })
  const tenant = await resolveHandoffTenant(c, form.organizationId)
  const grant = await consumeGrant(c, { ...form, state, tenant })
  clearHandoffState(c)
  if (!isHandoffContinuation(grant.continuePath)) {
    throw new AppError('unauthorized', { httpStatus: 401 })
  }
  await withTenant(c, tenant, async () => {
    const user = await createTenantDb(c.env.DB, tenant).users.findOne(
      and(
        eq(schema.users.id, grant.userId),
        eq(schema.users.status, 'active'),
        isNull(schema.users.deletedAt),
      ),
    )
    if (!user) throw new AppError('unauthorized', { httpStatus: 401 })
    const issued = await issueSession(c, {
      sessionId: createPersistedId('session'),
      userId: grant.userId,
      status: grant.sessionStatus,
      ...authContextOf(grant),
      authenticatedAt: new Date(grant.authenticatedAt),
      rememberMe: grant.rememberMe,
      ip: requestIp(c),
      userAgent: requestUserAgent(c),
    })
    // step-up token 绑定会话 id,目标主机为新会话重新签发;只对已认证会话有效。
    if (grant.stepUp && issued.session.status === 'active') {
      await issueStepUpCookie(c, {
        session: issued.session,
        method: grant.stepUp.method,
        ...(grant.stepUp.passkeyAssurance
          ? { passkeyAssurance: grant.stepUp.passkeyAssurance }
          : {}),
      })
    }
  })
  return grant.continuePath
}
