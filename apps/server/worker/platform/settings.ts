// GET/PATCH /v1/platform/settings:instance 级默认策略(08 章 10.1 instances)。
// cookie-session + instance_manager 门控;跨租户独立管理路径(raw drizzle)。

import { schema } from '@xid-kit/db'
import type { PlatformMfaPolicy, PlatformSettings } from '@xid-kit/types'
import {
  SESSION_POLICY_BOUNDS,
  TOKEN_POLICY_BOUNDS,
  normalizeSessionPolicy,
  normalizeTokenPolicy,
} from '@xid-kit/types'
import { and, eq, isNull, ne, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import * as v from 'valibot'
import type { XidHonoEnv } from '../lib/types'
import { AppError } from '../lib/errors'
import { SUPPORTED_LOCALES } from '../lib/locale'
import { readJsonBody, validateBody } from '../lib/validate'
import { DEFAULT_FROM } from '../queues/email'
import { enqueuePersistedPlatformAudit, preparePlatformAuditOutboxInsert } from './audit-outbox'
import { managementDb, requireInstanceManager, topLevelOrgFilter } from './shared'

const app = new Hono<XidHonoEnv>()

const MFA_POLICIES = [
  'required',
  'optional',
  'disabled',
] as const satisfies readonly PlatformMfaPolicy[]

// 数值字段须落在 BOUNDS 内(与 @xid-kit/types normalize clamp 同一组边界)。
function optionalBoundedField(bounds: { readonly min: number; readonly max: number }) {
  return v.optional(v.pipe(v.number(), v.minValue(bounds.min), v.maxValue(bounds.max)))
}

// sessionPolicy/tokenPolicy patch:字段全可选(缺省保留现存值,由 merge* 三态合并)。
const sessionPolicyPatchSchema = v.object({
  idleTimeoutMin: optionalBoundedField(SESSION_POLICY_BOUNDS.idleTimeoutMin),
  absoluteTimeoutDays: optionalBoundedField(SESSION_POLICY_BOUNDS.absoluteTimeoutDays),
  rememberMeDefault: v.optional(v.boolean()),
})

const tokenPolicyPatchSchema = v.object({
  accessTokenTtlSec: optionalBoundedField(TOKEN_POLICY_BOUNDS.accessTokenTtlSec),
  sessionTokenTtlSec: optionalBoundedField(TOKEN_POLICY_BOUNDS.sessionTokenTtlSec),
  refreshIdleTimeoutDays: optionalBoundedField(TOKEN_POLICY_BOUNDS.refreshIdleTimeoutDays),
  refreshAbsoluteTimeoutDays: optionalBoundedField(TOKEN_POLICY_BOUNDS.refreshAbsoluteTimeoutDays),
})

// 字段顺序即 paramName 优先级(与原手写守卫的检查顺序一致)。
// data_residency 只是部署元数据,不改变数据存放位置,因此只读不可改。
const patchSettingsBodySchema = v.object({
  defaultLocale: v.optional(v.picklist(SUPPORTED_LOCALES)),
  mfaPolicy: v.optional(v.picklist(MFA_POLICIES)),
  passwordPolicy: v.optional(v.record(v.string(), v.unknown())),
  sessionPolicy: v.optional(sessionPolicyPatchSchema),
  tokenPolicy: v.optional(tokenPolicyPatchSchema),
})

const SETTINGS_COLUMNS = {
  defaultLocale: 'default_locale',
  mfaPolicy: 'mfa_policy',
  passwordPolicy: 'password_policy',
  sessionPolicy: 'session_policy',
  tokenPolicy: 'token_policy',
} as const satisfies Record<string, string>

type SettingsUpdate = Partial<Record<keyof typeof SETTINGS_COLUMNS, string>>

type ConfigurationStatus = 'configured' | 'not_configured' | 'misconfigured'

type DeploymentStatus = {
  turnstile: { status: ConfigurationStatus; siteKey: string | null }
  emailSending: { provider: 'cloudflare_email_service'; fromAddress: string; fromName: string }
  customDomains: { status: ConfigurationStatus; cnameTarget: string | null }
  billingAdapter: { kind: 'stripe_metered_mau' | 'off'; status: ConfigurationStatus }
}

type InstanceSettingsResponse = PlatformSettings &
  DeploymentStatus & { orgsFollowingDefaults: { following: number; total: number } }

function configured(value: string | undefined): string | null {
  const normalized = value?.trim() ?? ''
  return normalized.length > 0 ? normalized : null
}

// 只报告部署变量是否成组出现。成组校验函数在部分配置时抛错,这里要让运营方看到「配了一半」。
function groupStatus(values: readonly (string | null)[]): ConfigurationStatus {
  const present = values.filter((value) => value !== null).length
  if (present === 0) return 'not_configured'
  return present === values.length ? 'configured' : 'misconfigured'
}

function deploymentStatus(env: Env): DeploymentStatus {
  const siteKey = configured(env.TURNSTILE_SITE_KEY)
  const zoneId = configured(env.CLOUDFLARE_FOR_SAAS_ZONE_ID)
  const cnameTarget = configured(env.CLOUDFLARE_FOR_SAAS_CNAME_TARGET)
  const saasStatus = groupStatus([zoneId, configured(env.CLOUDFLARE_FOR_SAAS_API_TOKEN)])
  const billingStatus = groupStatus([
    configured(env.STRIPE_SECRET_KEY),
    configured(env.STRIPE_WEBHOOK_SECRET),
    configured(env.STRIPE_METER_EVENT_NAME),
  ])
  return {
    turnstile: { status: groupStatus([siteKey, configured(env.TURNSTILE_SECRET)]), siteKey },
    emailSending: {
      provider: 'cloudflare_email_service',
      fromAddress: configured(env.EMAIL_FROM_ADDRESS) ?? DEFAULT_FROM.email,
      fromName: configured(env.EMAIL_FROM_NAME) ?? DEFAULT_FROM.name,
    },
    customDomains: {
      status: saasStatus === 'not_configured' && cnameTarget ? 'misconfigured' : saasStatus,
      cnameTarget,
    },
    billingAdapter: {
      kind: billingStatus === 'configured' ? 'stripe_metered_mau' : 'off',
      status: billingStatus,
    },
  }
}

// 顶层组织没有 org_policies.mfa_policy 时沿用实例默认(与 buildPolicy 的回落一致)。
async function countOrgsFollowingDefaults(env: Env): Promise<{ following: number; total: number }> {
  const [row] = await managementDb(env)
    .select({
      total: sql<number>`count(*)`,
      following: sql<number>`coalesce(sum(case when ${schema.orgPolicies.mfaPolicy} is null then 1 else 0 end), 0)`,
    })
    .from(schema.organizations)
    .leftJoin(
      schema.orgPolicies,
      and(
        eq(schema.orgPolicies.orgId, schema.organizations.id),
        eq(schema.orgPolicies.tenantId, schema.organizations.tenantId),
      ),
    )
    .where(
      and(
        topLevelOrgFilter(),
        isNull(schema.organizations.deletedAt),
        ne(schema.organizations.status, 'deleted'),
      ),
    )
  return { following: Number(row?.following ?? 0), total: Number(row?.total ?? 0) }
}

function mapInstance(row: typeof schema.instances.$inferSelect): PlatformSettings {
  return {
    id: row.id,
    name: row.name,
    primaryDomain: row.primaryDomain,
    mode: row.mode,
    defaultLocale: row.defaultLocale,
    dataResidency: row.dataResidency,
    mfaPolicy: row.mfaPolicy as PlatformMfaPolicy,
    passwordPolicy: row.passwordPolicy,
    sessionPolicy: normalizeSessionPolicy(row.sessionPolicy),
    tokenPolicy: normalizeTokenPolicy(row.tokenPolicy),
    status: row.status,
  }
}

// sessionPolicy 三态合并:字段缺失 -> 保留现存值;至少提供一个字段;snake_case 落库(API 面 camelCase)。
function mergeSessionPolicyPatch(
  patch: v.InferOutput<typeof sessionPolicyPatchSchema>,
  existing: unknown,
): Record<string, unknown> {
  if (Object.keys(patch).length === 0) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'sessionPolicy' },
    })
  }
  const current = normalizeSessionPolicy(existing)
  const nextRememberMe = patch.rememberMeDefault ?? current.rememberMeDefault
  return {
    idle_timeout_min: patch.idleTimeoutMin ?? current.idleTimeoutMin,
    absolute_timeout_days: patch.absoluteTimeoutDays ?? current.absoluteTimeoutDays,
    ...(nextRememberMe !== undefined ? { remember_me_default: nextRememberMe } : {}),
  }
}

// tokenPolicy 三态合并:同上,四字段逐字段与现存值合并,snake_case 落库。
function mergeTokenPolicyPatch(
  patch: v.InferOutput<typeof tokenPolicyPatchSchema>,
  existing: unknown,
): Record<string, unknown> {
  if (Object.keys(patch).length === 0) {
    throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName: 'tokenPolicy' } })
  }
  const current = normalizeTokenPolicy(existing)
  return {
    access_token_ttl_sec: patch.accessTokenTtlSec ?? current.accessTokenTtlSec,
    session_token_ttl_sec: patch.sessionTokenTtlSec ?? current.sessionTokenTtlSec,
    refresh_idle_timeout_days: patch.refreshIdleTimeoutDays ?? current.refreshIdleTimeoutDays,
    refresh_absolute_timeout_days:
      patch.refreshAbsoluteTimeoutDays ?? current.refreshAbsoluteTimeoutDays,
  }
}

export async function loadInstance(env: Env): Promise<typeof schema.instances.$inferSelect> {
  const db = managementDb(env)
  const rows = await db.select().from(schema.instances).limit(1)
  const row = rows[0]
  if (!row) throw new AppError('not_found', { httpStatus: 404 })
  return row
}

app.get('/', async (c) => {
  await requireInstanceManager(c)
  const row = await loadInstance(c.env)
  const orgsFollowingDefaults = await countOrgsFollowingDefaults(c.env)
  return c.json({
    ...mapInstance(row),
    ...deploymentStatus(c.env),
    orgsFollowingDefaults,
  } satisfies InstanceSettingsResponse)
})

app.patch('/', async (c) => {
  const session = await requireInstanceManager(c)
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(patchSettingsBodySchema, json.value)

  const current = await loadInstance(c.env)
  const updates: SettingsUpdate = {}
  if (body.defaultLocale !== undefined) updates.defaultLocale = body.defaultLocale
  if (body.mfaPolicy !== undefined) updates.mfaPolicy = body.mfaPolicy
  if (body.passwordPolicy !== undefined) {
    updates.passwordPolicy = JSON.stringify(body.passwordPolicy)
  }
  if (body.sessionPolicy !== undefined) {
    updates.sessionPolicy = JSON.stringify(
      mergeSessionPolicyPatch(body.sessionPolicy, current.sessionPolicy),
    )
  }
  if (body.tokenPolicy !== undefined) {
    updates.tokenPolicy = JSON.stringify(
      mergeTokenPolicyPatch(body.tokenPolicy, current.tokenPolicy),
    )
  }
  const fields = Object.keys(updates) as (keyof typeof SETTINGS_COLUMNS)[]
  if (fields.length === 0) {
    throw new AppError('validation_failed', { httpStatus: 422 })
  }

  const now = Date.now()
  const audit = preparePlatformAuditOutboxInsert(
    c.env,
    {
      tenantId: 'platform',
      action: 'platform.settings_changed',
      actorId: session.userId,
      payload: { targetType: 'instance', targetId: current.id, fields },
    },
    now,
  )
  const assignments = fields.map((field) => `${SETTINGS_COLUMNS[field]} = ?`).join(', ')
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE instances SET ${assignments}, updated_at = ? WHERE id = ?`).bind(
      ...fields.map((field) => updates[field]),
      now,
      current.id,
    ),
    audit.statement,
  ])
  await enqueuePersistedPlatformAudit(c.env, audit)

  const [instance, orgsFollowingDefaults] = await Promise.all([
    loadInstance(c.env),
    countOrgsFollowingDefaults(c.env),
  ])
  return c.json({
    ...mapInstance(instance),
    ...deploymentStatus(c.env),
    orgsFollowingDefaults,
  } satisfies InstanceSettingsResponse)
})

export function registerPlatformSettingsRoutes(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/platform/settings', app)
}
