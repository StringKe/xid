// /v1/platform/signing-keys:实例签名密钥元数据与轮换第 3 步(next -> active)。
// 第 1、4 步由每日 Cron 执行;第 3 步只能由 Instance Manager 显式触发,并要求 step-up。

import { instanceIssuerFor, schema } from '@xid-kit/db'
import { TOKEN_POLICY_BOUNDS } from '@xid-kit/types'
import { and, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import { requireStepUp } from '../lib/step-up'
import { JWKS_CACHE_TTL_SEC } from '../lib/ttl'
import type { XidHonoEnv } from '../lib/types'
import { jwksCacheKey } from '../oidc/jwks'
import {
  enqueuePersistedPlatformAudit,
  prepareConditionalPlatformAuditOutboxInsert,
} from './audit-outbox'
import { loadInstance } from './settings'
import { managementDb, requireInstanceManager } from './shared'

const app = new Hono<XidHonoEnv>()

const VISIBLE_STATUSES = ['next', 'active', 'retiring'] as const
type VisibleStatus = (typeof VISIBLE_STATUSES)[number]

const STATUS_ORDER: Record<VisibleStatus, number> = { next: 0, active: 1, retiring: 2 }

const JWKS_CACHE_TTL_MS = JWKS_CACHE_TTL_SEC * 1000

// 旧 active key 要能验证它签出的最长寿命 token,外加 RP 刷新 JWKS 缓存的窗口。
const RETIRING_GRACE_MS = TOKEN_POLICY_BOUNDS.accessTokenTtlSec.max * 1000 + JWKS_CACHE_TTL_MS

const kidSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(128))

export type PlatformSigningKey = {
  kid: string
  alg: string
  status: VisibleStatus
  createdAt: number
  activatedAt: number | null
  retireAfter: number | null
  activatableAt: number | null
}

type SigningKeyRow = {
  kid: string
  alg: string
  status: string
  createdAt: Date
  activatedAt: Date | null
  retireAfter: Date | null
}

function isVisibleStatus(status: string): status is VisibleStatus {
  return (VISIBLE_STATUSES as readonly string[]).includes(status)
}

function toResponse(row: SigningKeyRow & { status: VisibleStatus }): PlatformSigningKey {
  const createdAt = row.createdAt.getTime()
  return {
    kid: row.kid,
    alg: row.alg,
    status: row.status,
    createdAt,
    activatedAt: row.activatedAt?.getTime() ?? null,
    retireAfter: row.retireAfter?.getTime() ?? null,
    activatableAt: row.status === 'next' ? createdAt + JWKS_CACHE_TTL_MS : null,
  }
}

// 只投影公钥元数据列;私钥密文三元组绝不进入这个模块的查询结果。
async function loadVisibleKeys(env: Env, instanceId: string): Promise<PlatformSigningKey[]> {
  const rows: SigningKeyRow[] = await managementDb(env)
    .select({
      kid: schema.instanceSigningKeys.kid,
      alg: schema.instanceSigningKeys.alg,
      status: schema.instanceSigningKeys.status,
      createdAt: schema.instanceSigningKeys.createdAt,
      activatedAt: schema.instanceSigningKeys.activatedAt,
      retireAfter: schema.instanceSigningKeys.retireAfter,
    })
    .from(schema.instanceSigningKeys)
    .where(
      and(
        eq(schema.instanceSigningKeys.instanceId, instanceId),
        inArray(schema.instanceSigningKeys.status, [...VISIBLE_STATUSES]),
      ),
    )
  return rows
    .flatMap((row) =>
      isVisibleStatus(row.status) ? [toResponse({ ...row, status: row.status })] : [],
    )
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.createdAt - a.createdAt)
}

app.get('/', async (c) => {
  await requireInstanceManager(c)
  const instance = await loadInstance(c.env)
  return c.json({ data: await loadVisibleKeys(c.env, instance.id) })
})

app.post('/:kid/activate', async (c) => {
  const session = await requireInstanceManager(c)
  await requireStepUp(c, c.get('tenant'), session)
  const parsedKid = v.safeParse(kidSchema, c.req.param('kid'))
  if (!parsedKid.success) {
    throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName: 'kid' } })
  }
  const kid = parsedKid.output
  const instance = await loadInstance(c.env)
  const keys = await loadVisibleKeys(c.env, instance.id)
  const target = keys.find((key) => key.kid === kid)
  if (!target) throw new AppError('not_found', { httpStatus: 404 })
  const now = Date.now()
  if (target.status !== 'next' || target.createdAt + JWKS_CACHE_TTL_MS > now) {
    throw new AppError('conflict', { httpStatus: 409 })
  }
  const previous = keys.find((key) => key.status === 'active') ?? null

  const audit = prepareConditionalPlatformAuditOutboxInsert(
    c.env,
    {
      tenantId: 'platform',
      action: 'platform.signing_key.activated',
      actorId: session.userId,
      payload: {
        targetType: 'instance_signing_key',
        targetId: kid,
        instanceId: instance.id,
        kid,
        previousKid: previous?.kid ?? null,
      },
    },
    {
      sql: `EXISTS (
        SELECT 1 FROM instance_signing_keys
         WHERE instance_id = ? AND kid = ? AND status = 'next' AND created_at <= ?
      )`,
      bindings: [instance.id, kid, now - JWKS_CACHE_TTL_MS],
    },
    now,
  )
  const [auditResult, , activation] = await c.env.DB.batch([
    audit.statement,
    c.env.DB.prepare(
      `UPDATE instance_signing_keys
          SET status = 'retiring', retire_after = ?, updated_at = ?
        WHERE instance_id = ? AND status = 'active' AND kid <> ? AND ${audit.mutationGate.sql}`,
    ).bind(now + RETIRING_GRACE_MS, now, instance.id, kid, ...audit.mutationGate.bindings),
    c.env.DB.prepare(
      `UPDATE instance_signing_keys
          SET status = 'active', activated_at = ?, retire_after = NULL, updated_at = ?
        WHERE instance_id = ? AND kid = ? AND status = 'next' AND ${audit.mutationGate.sql}`,
    ).bind(now, now, instance.id, kid, ...audit.mutationGate.bindings),
  ])
  const auditPersisted = auditResult?.meta.changes === 1
  const activated = activation?.meta.changes === 1
  if (auditPersisted !== activated) throw new AppError('internal_error', { httpStatus: 500 })
  if (!activated) throw new AppError('conflict', { httpStatus: 409 })

  await enqueuePersistedPlatformAudit(c.env, audit)
  if (previous) await c.env.CACHE.delete(jwksCacheKey(instanceIssuerFor(instance), previous.kid))
  return c.json({ data: await loadVisibleKeys(c.env, instance.id) })
})

export function registerPlatformSigningKeyRoutes(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/platform/signing-keys', app)
}
