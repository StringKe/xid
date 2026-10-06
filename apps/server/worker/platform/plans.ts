import { schema } from '@xid-kit/db'
import {
  ORGANIZATION_PLANS,
  ORGANIZATION_PLAN_STATUSES,
  ORGANIZATION_QUOTA_ENFORCEMENTS,
  ORGANIZATION_QUOTA_KEYS,
} from '@xid-kit/types'
import type {
  OrganizationPlanDetail,
  OrganizationPlanName,
  OrganizationPlanStatus,
  OrganizationQuota,
  OrganizationQuotaKey,
} from '@xid-kit/types'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { readJsonBody, validateBody } from '../lib/validate'
import { enqueuePersistedPlatformAudit, preparePlatformAuditOutboxInsert } from './audit-outbox'
import { managementDb, requireInstanceManager } from './shared'

const app = new Hono<XidHonoEnv>()

export const PLAN_DEFAULTS: Record<
  OrganizationPlanName,
  { seatLimit: number | null; apiCalls: number | null; supportLabel: string }
> = {
  free: { seatLimit: 10, apiCalls: 100_000, supportLabel: 'community' },
  starter: { seatLimit: 50, apiCalls: 1_000_000, supportLabel: 'standard' },
  pro: { seatLimit: 250, apiCalls: 10_000_000, supportLabel: 'priority' },
  enterprise: { seatLimit: null, apiCalls: null, supportLabel: 'contracted' },
}
const PLAN_STATUSES = ORGANIZATION_PLAN_STATUSES
type PlanStatus = OrganizationPlanStatus
const QUOTA_KEYS = ORGANIZATION_QUOTA_KEYS
type QuotaKey = OrganizationQuotaKey
const QUOTA_ENFORCEMENT = ORGANIZATION_QUOTA_ENFORCEMENTS
const OBSERVATIONAL_QUOTA_KEYS = ['api_calls', 'emails', 'mau'] as const

const quotaPatchSchema = v.object({
  key: v.picklist(QUOTA_KEYS),
  limit: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0))),
  enforcement: v.picklist(QUOTA_ENFORCEMENT),
})

const patchPlanSchema = v.object({
  plan: v.optional(v.picklist(ORGANIZATION_PLANS)),
  status: v.optional(v.picklist(PLAN_STATUSES)),
  trialEndsAt: v.optional(v.nullable(v.string())),
  seatLimit: v.optional(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0)))),
  quotas: v.optional(v.array(quotaPatchSchema)),
})

type PlanQuota = OrganizationQuota

export function planDefaultQuotas(plan: OrganizationPlanName): PlanQuota[] {
  return [
    {
      key: 'seats',
      limit: PLAN_DEFAULTS[plan].seatLimit,
      enforcement: 'block_creation',
    },
    {
      key: 'api_calls',
      limit: PLAN_DEFAULTS[plan].apiCalls,
      enforcement: 'observe',
    },
  ]
}

export function buildOrganizationQuotaUpsertStatement(
  env: Env,
  input: {
    tenantId: string
    quota: PlanQuota
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

function asPlan(value: string | null | undefined): OrganizationPlanName {
  return ORGANIZATION_PLANS.includes(value as OrganizationPlanName)
    ? (value as OrganizationPlanName)
    : 'free'
}

function asPlanStatus(value: string | null | undefined): PlanStatus {
  return PLAN_STATUSES.includes(value as PlanStatus) ? (value as PlanStatus) : 'active'
}

function parseOptionalDate(value: string | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'trialEndsAt' },
    })
  }
  return date
}

function normalizedQuotaEnforcement(key: QuotaKey, enforcement: string): PlanQuota['enforcement'] {
  if (key === 'seats') return 'block_creation'
  if ((OBSERVATIONAL_QUOTA_KEYS as readonly QuotaKey[]).includes(key)) return 'observe'
  return enforcement === 'block_creation' ? 'block_creation' : 'observe'
}

function normalizeRequestedQuotas(quotas: readonly PlanQuota[]): PlanQuota[] {
  const seen = new Set<QuotaKey>()
  return quotas.map((quota) => {
    if (seen.has(quota.key)) {
      throw new AppError('validation_failed', {
        httpStatus: 422,
        meta: { paramName: 'quotas' },
      })
    }
    seen.add(quota.key)
    const expected = normalizedQuotaEnforcement(quota.key, quota.enforcement)
    if (expected !== quota.enforcement) {
      throw new AppError('validation_failed', {
        httpStatus: 422,
        meta: { paramName: 'enforcement' },
      })
    }
    return quota
  })
}

export async function loadOrganizationPlanMap(
  env: Env,
  tenantIds: readonly string[],
): Promise<Map<string, OrganizationPlanName>> {
  if (tenantIds.length === 0) return new Map()
  const rows = await managementDb(env)
    .select({
      tenantId: schema.organizationPlans.tenantId,
      plan: schema.organizationPlans.plan,
    })
    .from(schema.organizationPlans)
    .where(inArray(schema.organizationPlans.tenantId, tenantIds))
  return new Map(rows.map((row) => [row.tenantId, asPlan(row.plan)]))
}

export async function loadOrganizationPlanAccountingMap(
  env: Env,
  tenantIds: readonly string[],
): Promise<Map<string, { plan: OrganizationPlanName; status: PlanStatus }>> {
  if (tenantIds.length === 0) return new Map()
  const rows = await managementDb(env)
    .select({
      tenantId: schema.organizationPlans.tenantId,
      plan: schema.organizationPlans.plan,
      status: schema.organizationPlans.status,
    })
    .from(schema.organizationPlans)
    .where(inArray(schema.organizationPlans.tenantId, tenantIds))
  return new Map(
    rows.map((row) => [row.tenantId, { plan: asPlan(row.plan), status: asPlanStatus(row.status) }]),
  )
}

export async function loadOrganizationSeatLimitMap(
  env: Env,
  tenantIds: readonly string[],
): Promise<Map<string, number | null>> {
  if (tenantIds.length === 0) return new Map()
  const rows = await managementDb(env)
    .select({
      tenantId: schema.organizationQuotas.tenantId,
      limit: schema.organizationQuotas.limit,
    })
    .from(schema.organizationQuotas)
    .where(
      and(
        eq(schema.organizationQuotas.quotaKey, 'seats'),
        inArray(schema.organizationQuotas.tenantId, tenantIds),
      ),
    )
  return new Map(rows.map((row) => [row.tenantId, row.limit ?? null]))
}

async function readPlanDetail(env: Env, tenantId: string): Promise<OrganizationPlanDetail> {
  const db = managementDb(env)
  const [organization] = await db
    .select()
    .from(schema.organizations)
    .where(and(eq(schema.organizations.id, tenantId), isNull(schema.organizations.parentOrgId)))
    .limit(1)
  if (!organization) throw new AppError('not_found', { httpStatus: 404 })

  const [planRows, quotaRows] = await Promise.all([
    db
      .select()
      .from(schema.organizationPlans)
      .where(eq(schema.organizationPlans.tenantId, tenantId))
      .limit(1),
    db
      .select()
      .from(schema.organizationQuotas)
      .where(eq(schema.organizationQuotas.tenantId, tenantId))
      .orderBy(schema.organizationQuotas.quotaKey),
  ])
  const plan = planRows[0]
  const planName = asPlan(plan?.plan)
  const quotas = new Map<QuotaKey, PlanQuota>()
  for (const row of quotaRows) {
    if (!QUOTA_KEYS.includes(row.quotaKey as QuotaKey)) continue
    const key = row.quotaKey as QuotaKey
    quotas.set(key, {
      key,
      limit: row.limit ?? null,
      enforcement: normalizedQuotaEnforcement(key, row.enforcement),
    })
  }
  const storedSeatQuota = quotas.get('seats')
  const seatLimit = storedSeatQuota ? storedSeatQuota.limit : (organization.seatLimit ?? null)
  quotas.set('seats', {
    key: 'seats',
    limit: seatLimit,
    enforcement: 'block_creation',
  })
  return {
    tenantId,
    organizationName: organization.name,
    plan: planName,
    status: asPlanStatus(plan?.status),
    source: plan?.source ?? 'manual',
    supportLabel: PLAN_DEFAULTS[planName].supportLabel,
    trialEndsAt: plan?.trialEndsAt?.toISOString() ?? null,
    effectiveAt: (plan?.effectiveAt ?? organization.createdAt).toISOString(),
    seatLimit,
    quotas: QUOTA_KEYS.flatMap((key) => {
      const quota = quotas.get(key)
      return quota ? [quota] : []
    }),
  }
}

app.get('/:tenantId', async (c) => {
  await requireInstanceManager(c)
  return c.json(await readPlanDetail(c.env, c.req.param('tenantId')))
})

app.patch('/:tenantId', async (c) => {
  const session = await requireInstanceManager(c)
  const tenantId = c.req.param('tenantId')
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(patchPlanSchema, json.value)
  if (Object.keys(body).length === 0) {
    throw new AppError('validation_failed', { httpStatus: 422 })
  }
  const current = await readPlanDetail(c.env, tenantId)
  const now = Date.now()
  const trialEndsAt = parseOptionalDate(body.trialEndsAt)
  const nextPlan = body.plan ?? current.plan
  const nextStatus = body.status ?? current.status
  const requestedQuotas = normalizeRequestedQuotas([...(body.quotas ?? [])])
  const requestedSeatQuota = requestedQuotas.find((quota) => quota.key === 'seats')
  if (
    body.seatLimit !== undefined &&
    requestedSeatQuota &&
    body.seatLimit !== requestedSeatQuota.limit
  ) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'seatLimit' },
    })
  }
  const seatLimit =
    body.seatLimit !== undefined
      ? body.seatLimit
      : requestedSeatQuota
        ? requestedSeatQuota.limit
        : body.plan !== undefined
          ? PLAN_DEFAULTS[nextPlan].seatLimit
          : undefined
  const quotas = requestedQuotas.filter((quota) => quota.key !== 'seats')
  if (body.plan !== undefined && !quotas.some((quota) => quota.key === 'api_calls')) {
    const apiDefault = planDefaultQuotas(nextPlan).find((quota) => quota.key === 'api_calls')
    if (apiDefault) quotas.push(apiDefault)
  }
  if (seatLimit !== undefined) {
    quotas.push({ key: 'seats', limit: seatLimit, enforcement: 'block_creation' })
  }
  const currentTrialMs =
    current.trialEndsAt === null ? null : new Date(current.trialEndsAt).getTime()
  const nextTrialMs = trialEndsAt === undefined ? currentTrialMs : (trialEndsAt?.getTime() ?? null)
  // 只调配额时保留计费来源与生效时间(例如 Stripe 回调设定的计划)。
  const planChanged =
    nextPlan !== current.plan || nextStatus !== current.status || nextTrialMs !== currentTrialMs
  const statements: D1PreparedStatement[] = planChanged
    ? [
        c.env.DB.prepare(
          `INSERT INTO organization_plans (
             tenant_id, plan, status, source, trial_ends_at, effective_at,
             updated_by, created_at, updated_at
           ) VALUES (?, ?, ?, 'manual', ?, ?, ?, ?, ?)
           ON CONFLICT (tenant_id) DO UPDATE SET
             plan = excluded.plan,
             status = excluded.status,
             source = 'manual',
             trial_ends_at = excluded.trial_ends_at,
             effective_at = excluded.effective_at,
             updated_by = excluded.updated_by,
             updated_at = excluded.updated_at`,
        ).bind(tenantId, nextPlan, nextStatus, nextTrialMs, now, session.userId, now, now),
      ]
    : []
  if (seatLimit !== undefined) {
    statements.push(
      buildSeatLimitMirrorStatement(c.env, {
        tenantId,
        seatLimit,
        now,
      }),
    )
  }
  for (const quota of quotas) {
    statements.push(
      buildOrganizationQuotaUpsertStatement(c.env, {
        tenantId,
        quota,
        updatedBy: session.userId,
        now,
      }),
    )
  }
  const audit = preparePlatformAuditOutboxInsert(
    c.env,
    {
      tenantId,
      action: 'platform.plan_changed',
      actorId: session.userId,
      payload: {
        targetType: 'organization_plan',
        targetId: tenantId,
        fromPlan: current.plan,
        toPlan: nextPlan,
        status: nextStatus,
        planChanged,
        seatLimitChanged: seatLimit !== undefined,
        quotaKeys: quotas.map((quota) => quota.key),
      },
    },
    now,
  )
  statements.push(audit.statement)
  await c.env.DB.batch(statements)
  await enqueuePersistedPlatformAudit(c.env, audit)
  return c.json(await readPlanDetail(c.env, tenantId))
})

export function registerPlatformPlanRoutes(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/platform/plans', app)
}
