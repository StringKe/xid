// 平台模拟登录:Instance Manager 发起 -> 跨 host 不透明 POST handoff -> DO 一次性消费 -> 目标 Tenant 会话。
// handoff 仅含随机 grant id/secret,目标身份从不进 URL/referrer。

import { base64UrlEncode, sha256Hex } from '@xid-kit/crypto'
import { and, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import * as v from 'valibot'
import {
  IMPERSONATION_GRANT_TTL_MS,
  type ConsumedImpersonationGrant,
} from '../durable-objects/impersonation-grant-do'
import { AppError } from '../lib/errors'
import { createPersistedId, isPersistedId } from '../lib/persisted-id'
import { readSession, revokeSession, issueSession } from '../lib/session'
import { logWorkerError } from '../lib/safe-log'
import type { SessionData, XidHonoEnv } from '../lib/types'
import { readJsonBody, uuidSchema, validateBody } from '../lib/validate'
import {
  enqueuePersistedPlatformAudit,
  prepareConditionalPlatformAuditOutboxInsert,
  recordPlatformAudit,
} from '../platform/audit-outbox'
import { requireInstanceManager } from '../platform/shared'
import { createTenantDb, schema } from '@xid-kit/db'

const IMPERSONATION_SESSION_TTL_MS = 15 * 60 * 1000
const GRANT_ID_BYTES = 24
const GRANT_SECRET_BYTES = 32
const SAFE_IMPERSONATION_V1_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const IMPERSONATION_END_PATH = '/auth/impersonation/end'

const startBodySchema = v.object({
  userId: persistedOrUuid('user'),
  organizationId: persistedOrUuid('organization'),
})

const consumeBodySchema = v.object({
  grantId: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{20,128}$/)),
  secret: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{32,128}$/)),
})

type GrantInput = v.InferOutput<typeof consumeBodySchema>

type ImpersonationTarget = {
  targetUserId: string
  targetTenantId: string
  targetOrganizationId: string
  targetInstanceId: string
  organizationSlug: string
  primaryDomain: string
  instanceMode: string
}

type GrantCreateResponse = {
  expiresAt: number
}

function persistedOrUuid(kind: 'user' | 'organization') {
  return v.pipe(
    v.string(),
    v.check(
      (value) => isPersistedId(kind, value) || v.safeParse(uuidSchema, value).success,
      'Invalid persisted identifier',
    ),
  )
}

function opaqueRandom(bytes: number): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(bytes)))
}

function requestIp(c: Context<XidHonoEnv>): string | null {
  return c.req.header('cf-connecting-ip') ?? null
}

function noStore(response: Response): Response {
  response.headers.set('cache-control', 'no-store')
  response.headers.set('referrer-policy', 'no-referrer')
  return response
}

function grantStub(env: Env, grantId: string): DurableObjectStub {
  const namespace = env.IMPERSONATION_GRANTS
  return namespace.get(namespace.idFromName(`impersonation:${grantId}`))
}

async function readStartBody(c: Context<XidHonoEnv>) {
  const json = await readJsonBody(c)
  if (!json.ok) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'root' },
    })
  }
  return validateBody(startBodySchema, json.value)
}

async function readConsumeJson(c: Context<XidHonoEnv>): Promise<GrantInput> {
  const json = await readJsonBody(c)
  if (!json.ok) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'root' },
    })
  }
  return validateBody(consumeBodySchema, json.value)
}

async function readConsumeForm(c: Context<XidHonoEnv>): Promise<GrantInput> {
  let body: Record<string, string | File>
  try {
    body = await c.req.parseBody()
  } catch {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'root' },
    })
  }
  return validateBody(consumeBodySchema, body)
}

async function loadTarget(
  env: Env,
  instanceId: string,
  userId: string,
  organizationId: string,
): Promise<ImpersonationTarget | null> {
  // 平台管理员显式跨租户路径:join 仍绑定 tenant_id,防全局唯一 id 误桥接异租户。
  return env.DB.prepare(
    `SELECT u.id AS targetUserId,
            u.tenant_id AS targetTenantId,
            o.id AS targetOrganizationId,
            o.instance_id AS targetInstanceId,
            o.slug AS organizationSlug,
            i.primary_domain AS primaryDomain,
            i.mode AS instanceMode
       FROM users u
       JOIN memberships m
         ON m.user_id = u.id
        AND m.tenant_id = u.tenant_id
        AND m.status = 'active'
       JOIN organizations o
         ON o.id = m.org_id
        AND o.tenant_id = m.tenant_id
        AND o.status = 'active'
        AND o.deleted_at IS NULL
       JOIN instances i
         ON i.id = o.instance_id
        AND i.status = 'active'
      WHERE u.id = ?
        AND o.id = ?
        AND i.id = ?
        AND u.status = 'active'
        AND u.deleted_at IS NULL
      LIMIT 1`,
  )
    .bind(userId, organizationId, instanceId)
    .first<ImpersonationTarget>()
}

function isLoopbackDomain(domain: string): boolean {
  return domain === 'localhost' || domain === '127.0.0.1' || domain === '[::1]'
}

function targetOrigin(c: Context<XidHonoEnv>, target: ImpersonationTarget): string {
  const requestUrl = new URL(c.req.url)
  const loopback = isLoopbackDomain(target.primaryDomain)
  const protocol = loopback ? requestUrl.protocol : 'https:'
  const port = loopback && requestUrl.port ? `:${requestUrl.port}` : ''
  const hostname =
    target.instanceMode === 'single_tenant'
      ? target.primaryDomain
      : `${target.organizationSlug}.${target.primaryDomain}`
  return `${protocol}//${hostname}${port}`
}

function parseGrantCreateResponse(value: unknown): GrantCreateResponse | null {
  if (!value || typeof value !== 'object') return null
  const expiresAt = (value as Record<string, unknown>)['expiresAt']
  return typeof expiresAt === 'number' && Number.isFinite(expiresAt) ? { expiresAt } : null
}

function parseConsumedGrant(value: unknown): ConsumedImpersonationGrant | null {
  if (!value || typeof value !== 'object') return null
  const grant = (value as Record<string, unknown>)['grant']
  if (!grant || typeof grant !== 'object') return null
  const record = grant as Record<string, unknown>
  if (
    typeof record['targetTenantId'] !== 'string' ||
    typeof record['targetOrganizationId'] !== 'string' ||
    typeof record['targetOrganizationSlug'] !== 'string' ||
    typeof record['targetUserId'] !== 'string' ||
    typeof record['targetInstanceId'] !== 'string' ||
    typeof record['targetOrigin'] !== 'string' ||
    typeof record['impersonatorUserId'] !== 'string' ||
    (record['actorIp'] !== null && typeof record['actorIp'] !== 'string') ||
    typeof record['issuedAt'] !== 'number' ||
    typeof record['expiresAt'] !== 'number'
  ) {
    return null
  }
  return { grant: record as ConsumedImpersonationGrant }.grant
}

async function handleStart(c: Context<XidHonoEnv>): Promise<Response> {
  const actor = await requireInstanceManager(c)
  const body = await readStartBody(c)
  if (body.userId === actor.userId) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'userId' },
    })
  }

  const instanceId = c.get('tenant').instanceId
  if (!instanceId) throw new AppError('server_error')
  const target = await loadTarget(c.env, instanceId, body.userId, body.organizationId)
  if (!target) throw new AppError('not_found', { httpStatus: 404 })

  const grantId = opaqueRandom(GRANT_ID_BYTES)
  const secret = opaqueRandom(GRANT_SECRET_BYTES)
  const secretHash = await sha256Hex(secret)
  const origin = targetOrigin(c, target)
  const doResponse = await grantStub(c.env, grantId).fetch('https://impersonation-grant/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      secretHash,
      targetTenantId: target.targetTenantId,
      targetOrganizationId: target.targetOrganizationId,
      targetOrganizationSlug: target.organizationSlug,
      targetUserId: target.targetUserId,
      targetInstanceId: target.targetInstanceId,
      targetOrigin: origin,
      impersonatorUserId: actor.userId,
      actorIp: requestIp(c),
      ttlMs: IMPERSONATION_GRANT_TTL_MS,
    }),
  })
  const responseBody = parseGrantCreateResponse(await doResponse.json().catch(() => null))
  if (!doResponse.ok || !responseBody) {
    throw new AppError('temporarily_unavailable', {
      httpStatus: 503,
      cause: new Error(`ImpersonationGrantDO create failed with HTTP ${doResponse.status}`),
    })
  }
  await recordPlatformAudit(c.env, {
    tenantId: target.targetTenantId,
    orgId: target.targetOrganizationId,
    action: 'platform.impersonation.grant_created',
    actorId: actor.userId,
    payload: {
      actorIp: requestIp(c),
      targetType: 'user',
      targetId: target.targetUserId,
      expiresAt: responseBody.expiresAt,
    },
  })

  return noStore(
    c.json(
      {
        handoff: {
          action: `${origin}/auth/impersonation/handoff`,
          method: 'POST',
          fields: { grantId, secret },
        },
        expiresAt: new Date(responseBody.expiresAt).toISOString(),
      },
      201,
    ),
  )
}

async function consumeGrant(
  c: Context<XidHonoEnv>,
  input: GrantInput,
): Promise<{ session: SessionData }> {
  const tenant = c.get('tenant')
  const instanceId = tenant.instanceId
  if (!instanceId) throw new AppError('unauthorized', { httpStatus: 401 })
  const origin = new URL(c.req.url).origin
  const secretHash = await sha256Hex(input.secret)
  const doResponse = await grantStub(c.env, input.grantId).fetch(
    'https://impersonation-grant/consume',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        secretHash,
        targetTenantId: tenant.tenantId,
        targetInstanceId: instanceId,
        targetOrigin: origin,
      }),
    },
  )
  const grant = doResponse.ok ? parseConsumedGrant(await doResponse.json().catch(() => null)) : null
  if (!grant) throw new AppError('unauthorized', { httpStatus: 401 })
  const sessionId = createPersistedId('session')
  await recordPlatformAudit(c.env, {
    tenantId: tenant.tenantId,
    orgId: grant.targetOrganizationId,
    action: 'platform.impersonation.grant_consumed',
    actorId: grant.impersonatorUserId,
    payload: {
      actorIp: grant.actorIp,
      targetType: 'user',
      targetId: grant.targetUserId,
      sessionId,
    },
  })

  // 消费短期授权后再校验可变目标状态;TenantContext 只来自本 host,不从 grant 重建。
  const db = createTenantDb(c.env.DB, tenant)
  const [user, organization, membership] = await Promise.all([
    db.users.findOne(
      and(
        eq(schema.users.id, grant.targetUserId),
        eq(schema.users.status, 'active'),
        isNull(schema.users.deletedAt),
      ),
    ),
    db.organizations.findOne(
      and(
        eq(schema.organizations.id, grant.targetOrganizationId),
        eq(schema.organizations.status, 'active'),
        isNull(schema.organizations.deletedAt),
      ),
    ),
    db.memberships.findOne(
      and(
        eq(schema.memberships.userId, grant.targetUserId),
        eq(schema.memberships.orgId, grant.targetOrganizationId),
        eq(schema.memberships.status, 'active'),
      ),
    ),
  ])
  if (
    !user ||
    !organization ||
    !membership ||
    organization.slug !== grant.targetOrganizationSlug ||
    organization.instanceId !== grant.targetInstanceId
  ) {
    throw new AppError('unauthorized', { httpStatus: 401 })
  }

  const issued = await issueSession(c, {
    sessionId,
    userId: grant.targetUserId,
    activeOrgId: grant.targetOrganizationId,
    authenticatedAt: new Date(),
    expiresAt: new Date(Date.now() + IMPERSONATION_SESSION_TTL_MS),
    rememberMe: false,
    isImpersonation: true,
    impersonatorUserId: grant.impersonatorUserId,
    userAgent: c.req.header('user-agent') ?? null,
    ip: requestIp(c),
  })
  c.set('session', issued.session)
  try {
    await recordPlatformAudit(c.env, {
      tenantId: tenant.tenantId,
      orgId: grant.targetOrganizationId,
      action: 'platform.impersonation.started',
      actorId: grant.impersonatorUserId,
      payload: {
        actorIp: grant.actorIp,
        targetType: 'user',
        targetId: grant.targetUserId,
        sessionId: issued.session.sessionId,
      },
    })
  } catch (error) {
    try {
      await revokeSession(c, issued.session)
    } catch (rollbackError) {
      logWorkerError('platform.impersonation.start_audit_rollback_failed', rollbackError, {
        component: 'platform-impersonation',
        operation: 'start',
      })
    }
    throw error
  }
  return { session: issued.session }
}

async function handleConsume(c: Context<XidHonoEnv>): Promise<Response> {
  const { session } = await consumeGrant(c, await readConsumeJson(c))
  return noStore(
    c.json(
      {
        ok: true,
        session: {
          id: session.sessionId,
          expiresAt: session.expiresAt.toISOString(),
          isImpersonation: true,
          activeOrganizationId: session.activeOrgId,
        },
      },
      201,
    ),
  )
}

async function handleHandoff(c: Context<XidHonoEnv>): Promise<Response> {
  await consumeGrant(c, await readConsumeForm(c))
  return noStore(c.redirect('/console', 303))
}

async function handleEnd(c: Context<XidHonoEnv>): Promise<Response> {
  const session = c.get('session') ?? (await readSession(c))
  if (!session) throw new AppError('unauthorized', { httpStatus: 401 })
  if (!session.isImpersonation || !session.impersonatorUserId || !session.activeOrgId) {
    throw new AppError('forbidden', { httpStatus: 403 })
  }

  const tenantId = c.get('tenant').tenantId
  const audit = prepareConditionalPlatformAuditOutboxInsert(
    c.env,
    {
      tenantId,
      orgId: session.activeOrgId,
      action: 'platform.impersonation.ended',
      actorId: session.impersonatorUserId,
      payload: {
        actorIp: requestIp(c),
        targetType: 'user',
        targetId: session.userId,
        sessionId: session.sessionId,
      },
    },
    {
      sql: `EXISTS (
        SELECT 1
          FROM sessions
         WHERE id = ? AND tenant_id = ? AND user_id = ? AND status = 'active'
      )`,
      bindings: [session.sessionId, tenantId, session.userId],
    },
  )
  const [auditResult, mutation] = await c.env.DB.batch([
    audit.statement,
    c.env.DB.prepare(
      `UPDATE sessions
       SET status = 'revoked'
       WHERE id = ? AND tenant_id = ? AND user_id = ? AND status = 'active'
         AND ${audit.mutationGate.sql}`,
    ).bind(session.sessionId, tenantId, session.userId, ...audit.mutationGate.bindings),
  ])
  const auditPersisted = auditResult?.meta.changes === 1
  const sessionRevoked = mutation?.meta.changes === 1
  if (auditPersisted !== sessionRevoked) throw new AppError('internal_error', { httpStatus: 500 })
  await revokeSession(c, session)
  if (auditPersisted) await enqueuePersistedPlatformAudit(c.env, audit)
  return noStore(
    c.json({
      ok: true,
      redirectUrl: new URL('/console/platform/users', c.get('tenant').issuer).toString(),
    }),
  )
}

export function registerImpersonationRoutes(app: Hono<XidHonoEnv>): void {
  // 须先于协议/auth/SSO/v1 注册:模拟 cookie 只是 Console 只读能力,不可进入 /authorize 或换 token。
  app.use('*', async (c, next) => {
    const session = c.get('session')
    if (session?.isImpersonation) {
      const method = c.req.method.toUpperCase()
      const path = c.req.path
      const isReadOnlyV1 = path.startsWith('/v1/') && SAFE_IMPERSONATION_V1_METHODS.has(method)
      const isExplicitEnd = path === IMPERSONATION_END_PATH && method === 'POST'
      if (!isReadOnlyV1 && !isExplicitEnd) {
        throw new AppError('forbidden', { httpStatus: 403 })
      }
    }
    await next()
  })
  app.post('/v1/platform/impersonation/start', handleStart)
  app.post('/auth/impersonation/consume', handleConsume)
  app.post('/auth/impersonation/handoff', handleHandoff)
  app.post('/auth/impersonation/end', handleEnd)
}
