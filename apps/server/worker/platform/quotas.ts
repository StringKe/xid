// /v1/platform/quotas/:tenantId:运营方资源配额。XID 没有套餐;配额只是运营方的安全上限,
// 从不拦截认证、令牌签发或协议。seats 与 mau 只做观测;organizations / sso_connections
// 可设为 block_creation,只拦截管理写操作(由 0005 的资源配额触发器执行)。
import { schema } from '@xid-kit/db'
import { ORGANIZATION_QUOTA_ENFORCEMENTS, ORGANIZATION_QUOTA_KEYS } from '@xid-kit/types'
import type {
  OrganizationQuota,
  OrganizationQuotaDetail,
  OrganizationQuotaEnforcement,
  OrganizationQuotaKey,
} from '@xid-kit/types'
import { and, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { readJsonBody, validateBody } from '../lib/validate'
import { enqueuePersistedPlatformAudit, preparePlatformAuditOutboxInsert } from './audit-outbox'
import { managementDb, requireInstanceManager } from './shared'

const app = new Hono<XidHonoEnv>()

const OBSERVE_ONLY_QUOTA_KEYS: readonly OrganizationQuotaKey[] = ['seats', 'mau']

const quotaPatchSchema = v.object({
  key: v.picklist(ORGANIZATION_QUOTA_KEYS),
  limit: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0))),
  enforcement: v.picklist(ORGANIZATION_QUOTA_ENFORCEMENTS),
})

const patchQuotasSchema = v.object({
  quotas: v.pipe(v.array(quotaPatchSchema), v.minLength(1)),
})

export function buildOrganizationQuotaUpsertStatement(
  env: Env,
  input: {
    tenantId: string
    quota: OrganizationQuota
    updatedBy: string | null
    now: number
  },
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO organization_quotas (
       tenant_id, quota_key, "limit", enforcement, updated_by, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, quota_key) DO UPDATE SET
       "limit" = excluded."limit",
       enforcement = excluded.enforcement,
       updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`,
  ).bind(
    input.tenantId,
    input.quota.key,
    input.quota.limit,
    input.quota.enforcement,
    input.updatedBy,
    input.now,
    input.now,
  )
}

// organizations.seat_limit 是 seats 观测阈值的兼容镜像。
export function buildSeatLimitMirrorStatement(
  env: Env,
  input: { tenantId: string; seatLimit: number | null; now: number },
): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE organizations
     SET seat_limit = ?, updated_at = ?
     WHERE tenant_id = ? AND id = ? AND parent_org_id IS NULL`,
  ).bind(input.seatLimit, input.now, input.tenantId, input.tenantId)
}

function isQuotaKey(value: string): value is OrganizationQuotaKey {
  return (ORGANIZATION_QUOTA_KEYS as readonly string[]).includes(value)
}

function allowedEnforcement(
  key: OrganizationQuotaKey,
  enforcement: string,
): OrganizationQuotaEnforcement {
  if (OBSERVE_ONLY_QUOTA_KEYS.includes(key)) return 'observe'
  return enforcement === 'block_creation' ? 'block_creation' : 'observe'
}

function normalizeRequestedQuotas(quotas: readonly OrganizationQuota[]): OrganizationQuota[] {
  const seen = new Set<OrganizationQuotaKey>()
  return quotas.map((quota) => {
    if (seen.has(quota.key)) {
      throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName: 'quotas' } })
    }
    seen.add(quota.key)
    if (allowedEnforcement(quota.key, quota.enforcement) !== quota.enforcement) {
      throw new AppError('validation_failed', {
        httpStatus: 422,
        meta: { paramName: 'enforcement' },
      })
    }
    return quota
  })
}

async function readQuotaDetail(env: Env, tenantId: string): Promise<OrganizationQuotaDetail> {
  const db = managementDb(env)
  const [organization] = await db
    .select({ name: schema.organizations.name, seatLimit: schema.organizations.seatLimit })
    .from(schema.organizations)
    .where(and(eq(schema.organizations.id, tenantId), isNull(schema.organizations.parentOrgId)))
    .limit(1)
  if (!organization) throw new AppError('not_found', { httpStatus: 404 })

  const rows = await db
    .select()
    .from(schema.organizationQuotas)
    .where(eq(schema.organizationQuotas.tenantId, tenantId))
  // 历史上写过的 api_calls / emails 等行不再是可编辑配额,读取时过滤,数据保留。
  const quotas = new Map<OrganizationQuotaKey, OrganizationQuota>()
  for (const row of rows) {
    if (!isQuotaKey(row.quotaKey)) continue
    quotas.set(row.quotaKey, {
      key: row.quotaKey,
      limit: row.limit ?? null,
      enforcement: allowedEnforcement(row.quotaKey, row.enforcement),
    })
  }
  if (!quotas.has('seats') && organization.seatLimit !== null) {
    quotas.set('seats', { key: 'seats', limit: organization.seatLimit, enforcement: 'observe' })
  }
  return {
    tenantId,
    name: organization.name,
    quotas: ORGANIZATION_QUOTA_KEYS.flatMap((key) => {
      const quota = quotas.get(key)
      return quota ? [quota] : []
    }),
  }
}

app.get('/:tenantId', async (c) => {
  await requireInstanceManager(c)
  return c.json(await readQuotaDetail(c.env, c.req.param('tenantId')))
})

app.patch('/:tenantId', async (c) => {
  const session = await requireInstanceManager(c)
  const tenantId = c.req.param('tenantId')
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(patchQuotasSchema, json.value)
  const quotas = normalizeRequestedQuotas(body.quotas)
  await readQuotaDetail(c.env, tenantId)
  const now = Date.now()
  const statements: D1PreparedStatement[] = quotas.map((quota) =>
    buildOrganizationQuotaUpsertStatement(c.env, {
      tenantId,
      quota,
      updatedBy: session.userId,
      now,
    }),
  )
  const seatQuota = quotas.find((quota) => quota.key === 'seats')
  if (seatQuota) {
    statements.push(
      buildSeatLimitMirrorStatement(c.env, { tenantId, seatLimit: seatQuota.limit, now }),
    )
  }
  const audit = preparePlatformAuditOutboxInsert(
    c.env,
    {
      tenantId,
      action: 'platform.quota_changed',
      actorId: session.userId,
      payload: {
        targetType: 'organization_quota',
        targetId: tenantId,
        quotaKeys: quotas.map((quota) => quota.key),
      },
    },
    now,
  )
  statements.push(audit.statement)
  await c.env.DB.batch(statements)
  await enqueuePersistedPlatformAudit(c.env, audit)
  return c.json(await readQuotaDetail(c.env, tenantId))
})

export function registerPlatformQuotaRoutes(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/platform/quotas', app)
}
