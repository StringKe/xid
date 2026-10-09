// 多租户下 passkey 仪式只在 rpId 所在主机({slug}.{primary} 或已启用自定义域)进行,根域只负责解析组织。
// 根域发起时下发 __Host- state cookie 并把浏览器带到 rpId 主机;那里登录成功后签发一次性交接 grant
// (SessionHandoffDO),浏览器以表单 POST 回根域消费,根域核对 state cookie、grant 与目标后建立根域会话,
// 再续跑 /authorize。state cookie 只能由根域自己写入,子域或第三方构造的 grant 无法登录到别人的浏览器。

import { base64UrlEncode, sha256Hex } from '@xid-kit/crypto'
import { createTenantDb, resolveTenantContextById, schema } from '@xid-kit/db'
import { normalizeLocalPath } from '@xid-kit/types'
import { and, eq, isNull } from 'drizzle-orm'
import type { Context } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import * as v from 'valibot'
import {
  SESSION_HANDOFF_TTL_MS,
  type ConsumedSessionHandoff,
} from '../durable-objects/session-handoff-do'
import { PASSKEY_AUTH_CONTEXT } from '../lib/auth-context'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import { issueSession } from '../lib/session'
import type { TenantVar, XidHonoEnv } from '../lib/types'
import { validateBody } from '../lib/validate'
import { isInstanceEntryContext, withTenant } from './instance-login'
import { requestIp, requestUserAgent } from './shared'

export const PASSKEY_HANDOFF_PATH = '/auth/passkey/handoff'
const HANDOFF_STATE_COOKIE = '__Host-xid.handoff'
// 覆盖从根域跳到子域、完成 WebAuthn 仪式再回来的整个交互;grant 本身只活 2 分钟。
const HANDOFF_STATE_MAX_AGE_SEC = 10 * 60
const OPAQUE_BYTES = 32

const handoffFormSchema = v.object({
  grantId: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{32,128}$/)),
  secret: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{32,128}$/)),
  organizationId: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
})

export const handoffStateSchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{32,128}$/))

export type SessionHandoffForm = {
  action: string
  method: 'POST'
  fields: { grantId: string; secret: string; organizationId: string }
}

function opaqueRandom(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(OPAQUE_BYTES)))
}

function handoffStub(env: Env, grantId: string): DurableObjectStub {
  const namespace = env.SESSION_HANDOFF
  return namespace.get(namespace.idFromName(`handoff:${grantId}`))
}

// 开发环境走 http 与端口,生产只用 https。
function originForHost(c: Context<XidHonoEnv>, hostname: string): string {
  const request = new URL(c.req.url)
  if (request.protocol === 'https:') return `https://${hostname}`
  return `${request.protocol}//${hostname}${request.port ? `:${request.port}` : ''}`
}

// 当前主机不是租户 rpId 时返回应当完成仪式的 origin;同主机返回 null。
export function passkeyCeremonyOrigin(c: Context<XidHonoEnv>, tenant: TenantVar): string | null {
  if (new URL(c.req.url).hostname === tenant.rpId) return null
  return originForHost(c, tenant.rpId)
}

// 根域把 passkey 仪式交给 rpId 主机前调用:state 写进本主机的 __Host- cookie,同时交给浏览器带过去。
export function beginPasskeyCeremonyHandoff(c: Context<XidHonoEnv>): string {
  const state = opaqueRandom()
  setCookie(c, HANDOFF_STATE_COOKIE, state, {
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'Lax',
    maxAge: HANDOFF_STATE_MAX_AGE_SEC,
  })
  return state
}

function isAuthorizeContinuation(path: string): boolean {
  return (
    normalizeLocalPath(path) === path && new URL(path, 'https://local').pathname === '/authorize'
  )
}

// rpId 主机上的 passkey 登录完成后调用:只为续跑 /authorize 的应用登录交还给 issuer 主机。
export async function mintSessionHandoff(
  c: Context<XidHonoEnv>,
  input: {
    tenant: TenantVar
    userId: string
    authenticatedAt: Date
    continuePath: string
    state: string
  },
): Promise<SessionHandoffForm | null> {
  const { tenant } = input
  const targetOrigin = new URL(tenant.issuer).origin
  if (new URL(c.req.url).origin === targetOrigin) return null
  if (!tenant.instanceId || !isAuthorizeContinuation(input.continuePath)) return null
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
      targetOrigin,
      userId: input.userId,
      continuePath: input.continuePath,
      authenticatedAt: input.authenticatedAt.getTime(),
      ttlMs: SESSION_HANDOFF_TTL_MS,
    }),
  })
  if (response.status !== 201) throw new AppError('server_error')
  return {
    action: `${targetOrigin}${PASSKEY_HANDOFF_PATH}`,
    method: 'POST',
    fields: { grantId, secret, organizationId: tenant.tenantId },
  }
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

// 目标租户只在当前主机的实例里解析:根域按表单里的组织 id 解析,租户主机必须就是该组织。
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
        targetOrigin: new URL(c.req.url).origin,
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

async function readHandoffForm(
  c: Context<XidHonoEnv>,
): Promise<v.InferOutput<typeof handoffFormSchema>> {
  let body: Record<string, string | File>
  try {
    body = await c.req.parseBody()
  } catch (error) {
    throw new AppError('unauthorized', { httpStatus: 401, cause: error })
  }
  try {
    return validateBody(handoffFormSchema, body)
  } catch (error) {
    throw new AppError('unauthorized', { httpStatus: 401, cause: error })
  }
}

function clearStateCookie(c: Context<XidHonoEnv>): void {
  setCookie(c, HANDOFF_STATE_COOKIE, '', {
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'Lax',
    maxAge: 0,
  })
}

// POST /auth/passkey/handoff:消费交接 grant,在本主机建立会话后 303 回 /authorize。
export async function handleSessionHandoff(c: Context<XidHonoEnv>): Promise<Response> {
  const form = await readHandoffForm(c)
  const state = getCookie(c, HANDOFF_STATE_COOKIE)
  if (!state || !v.safeParse(handoffStateSchema, state).success) {
    throw new AppError('unauthorized', { httpStatus: 401 })
  }
  clearStateCookie(c)
  const tenant = await resolveHandoffTenant(c, form.organizationId)
  const grant = await consumeGrant(c, { ...form, state, tenant })
  if (!isAuthorizeContinuation(grant.continuePath))
    throw new AppError('unauthorized', { httpStatus: 401 })
  await withTenant(c, tenant, async () => {
    const user = await createTenantDb(c.env.DB, tenant).users.findOne(
      and(
        eq(schema.users.id, grant.userId),
        eq(schema.users.status, 'active'),
        isNull(schema.users.deletedAt),
      ),
    )
    if (!user) throw new AppError('unauthorized', { httpStatus: 401 })
    await issueSession(c, {
      sessionId: createPersistedId('session'),
      userId: grant.userId,
      authContext: PASSKEY_AUTH_CONTEXT,
      authenticatedAt: new Date(grant.authenticatedAt),
      rememberMe: true,
      ip: requestIp(c),
      userAgent: requestUserAgent(c),
    })
  })
  c.header('cache-control', 'no-store')
  c.header('referrer-policy', 'no-referrer')
  return c.redirect(grant.continuePath, 303)
}
