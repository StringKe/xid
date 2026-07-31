// GET/PATCH /v1/platform/settings:instance 级默认策略(08 章 10.1 instances)。
// cookie-session + instance_manager 门控;跨租户独立管理路径(raw drizzle)。

import { schema } from '@xid-kit/db'
import type { SessionPolicy, TokenPolicy } from '@xid-kit/types'
import {
  SESSION_POLICY_BOUNDS,
  TOKEN_POLICY_BOUNDS,
  normalizeSessionPolicy,
  normalizeTokenPolicy,
} from '@xid-kit/types'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import * as v from 'valibot'
import type { XidHonoEnv } from '../lib/types'
import { AppError } from '../lib/errors'
import { readJsonBody, validateBody } from '../lib/validate'
import { recordPlatformAudit } from './audit-outbox'
import { managementDb, requireInstanceManager } from './shared'

const app = new Hono<XidHonoEnv>()

const MFA_POLICIES = ['required', 'optional', 'disabled'] as const
type MfaPolicy = (typeof MFA_POLICIES)[number]

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
const patchSettingsBodySchema = v.object({
  defaultLocale: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
  dataResidency: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
  mfaPolicy: v.optional(v.picklist(MFA_POLICIES)),
  passwordPolicy: v.optional(v.record(v.string(), v.unknown())),
  sessionPolicy: v.optional(sessionPolicyPatchSchema),
  tokenPolicy: v.optional(tokenPolicyPatchSchema),
})

type PlatformSettings = {
  id: string
  name: string
  primaryDomain: string
  mode: string
  defaultLocale: string
  dataResidency: string
  mfaPolicy: MfaPolicy
  passwordPolicy: Record<string, unknown>
  sessionPolicy: SessionPolicy
  tokenPolicy: TokenPolicy
  status: string
}

function mapInstance(row: typeof schema.instances.$inferSelect): PlatformSettings {
  return {
    id: row.id,
    name: row.name,
    primaryDomain: row.primaryDomain,
    mode: row.mode,
    defaultLocale: row.defaultLocale,
    dataResidency: row.dataResidency,
    mfaPolicy: row.mfaPolicy as MfaPolicy,
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

async function loadInstance(env: Env): Promise<typeof schema.instances.$inferSelect> {
  const db = managementDb(env)
  const rows = await db.select().from(schema.instances).limit(1)
  const row = rows[0]
  if (!row) throw new AppError('not_found', { httpStatus: 404 })
  return row
}

app.get('/', async (c) => {
  await requireInstanceManager(c)
  const row = await loadInstance(c.env)
  return c.json(mapInstance(row))
})

app.patch('/', async (c) => {
  const session = await requireInstanceManager(c)
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(patchSettingsBodySchema, json.value)

  const current = await loadInstance(c.env)
  const updates: Partial<typeof schema.instances.$inferInsert> = {}
  if (body.defaultLocale !== undefined) updates.defaultLocale = body.defaultLocale
  if (body.dataResidency !== undefined) updates.dataResidency = body.dataResidency
  if (body.mfaPolicy !== undefined) updates.mfaPolicy = body.mfaPolicy
  if (body.passwordPolicy !== undefined) updates.passwordPolicy = body.passwordPolicy
  if (body.sessionPolicy !== undefined) {
    updates.sessionPolicy = mergeSessionPolicyPatch(body.sessionPolicy, current.sessionPolicy)
  }
  if (body.tokenPolicy !== undefined) {
    updates.tokenPolicy = mergeTokenPolicyPatch(body.tokenPolicy, current.tokenPolicy)
  }
  if (Object.keys(updates).length === 0) {
    throw new AppError('validation_failed', { httpStatus: 422 })
  }

  const db = managementDb(c.env)
  const [row] = await db
    .update(schema.instances)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(schema.instances.id, current.id))
    .returning()
  if (!row) throw new AppError('not_found', { httpStatus: 404 })
  await recordPlatformAudit(c.env, {
    tenantId: 'platform',
    action: 'platform.settings_changed',
    actorId: session.userId,
    payload: {
      targetType: 'instance',
      targetId: row.id,
      fields: Object.keys(body),
    },
  })

  return c.json(mapInstance(row))
})

export function registerPlatformSettingsRoutes(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/platform/settings', app)
}
