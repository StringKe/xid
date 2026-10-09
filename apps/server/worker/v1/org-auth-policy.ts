// /v1/organizations/:id/auth-policy:Hosted Auth、会话、令牌与 MFA 的组织级覆盖。

import { createTenantDb, schema } from '@xid-kit/db'
import type { HostedAuthPolicy, MfaEnforcement } from '@xid-kit/types'
import {
  DEFAULT_HOSTED_AUTH_POLICY,
  MFA_ENFORCEMENT,
  SESSION_POLICY_BOUNDS,
  TOKEN_POLICY_BOUNDS,
  normalizeHostedAuthPolicy,
} from '@xid-kit/types'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import type { Context, Hono } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { readJsonBody, validateBody } from '../lib/validate'
import { deliveryChannelReadiness } from './org-delivery-channels'
import type { ConsoleDeliveryChannelReadiness } from './org-delivery-channels'
import { hasOwn, isRecord, readPrivateMetadata } from './org-policy-fields'
import { assertOrgSelfServiceEditable } from './org-self-service'
import { auditOrgMutation } from './org-shared'
import { emitWebhookAsync, requireApiKeyOrOrgManager, requireOrg } from './shared'

// PATCH body 只要求"是对象":三态(missing/null/value)与 camel/snake 双键语义由下方 normalize 处理。
const policyPatchBodySchema = v.record(v.string(), v.unknown())

// null 清除组织覆盖,回落实例默认。
const mfaPolicyPatchSchema = v.object({
  mfaPolicy: v.optional(v.nullable(v.picklist(MFA_ENFORCEMENT))),
})

// org 策略覆盖的 API 面:字段为 null 表示未覆盖,回退 instance 默认(见 08 章 10.6)。
type ConsoleSessionPolicyOverride = {
  idleTimeoutMin: number | null
  absoluteTimeoutDays: number | null
}

type ConsoleTokenPolicyOverride = {
  accessTokenTtlSec: number | null
  sessionTokenTtlSec: number | null
  refreshIdleTimeoutDays: number | null
  refreshAbsoluteTimeoutDays: number | null
}

type ConsoleAuthPolicy = {
  hostedAuth: HostedAuthPolicy
  sessionPolicy: ConsoleSessionPolicyOverride
  tokenPolicy: ConsoleTokenPolicyOverride
  deliveryChannelReadiness: ConsoleDeliveryChannelReadiness
  mfaPolicy: MfaEnforcement | null
  effectiveMfaPolicy: MfaEnforcement
}

type OrgDb = ReturnType<ReturnType<typeof createTenantDb>['forOrg']>

// token_policy JSON 兼容 snake/camel 两键(见 types normalize 同模式);非法值按未覆盖处理。
function storedPolicyNumber(
  record: Record<string, unknown> | null | undefined,
  camelKey: string,
  snakeKey: string,
): number | null {
  const value = record?.[camelKey] ?? record?.[snakeKey]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asMfaEnforcement(value: string | null | undefined): MfaEnforcement | null {
  return MFA_ENFORCEMENT.find((item) => item === value) ?? null
}

// instances 无 tenant_id,按组织所属 instance_id 直查。
async function readInstanceMfaPolicy(
  c: Context<XidHonoEnv>,
  org: typeof schema.organizations.$inferSelect,
): Promise<MfaEnforcement> {
  const rows = await drizzle(c.env.DB, { schema })
    .select({ mfaPolicy: schema.instances.mfaPolicy })
    .from(schema.instances)
    .where(eq(schema.instances.id, org.instanceId))
    .limit(1)
  return asMfaEnforcement(rows[0]?.mfaPolicy) ?? 'optional'
}

function toConsoleAuthPolicy(
  org: typeof schema.organizations.$inferSelect,
  env: Env,
  policy: typeof schema.orgPolicies.$inferSelect | undefined,
  instanceMfaPolicy: MfaEnforcement,
): ConsoleAuthPolicy {
  const metadata = readPrivateMetadata(org)
  const mfaPolicy = asMfaEnforcement(policy?.mfaPolicy)
  const token = policy?.tokenPolicy
  return {
    mfaPolicy,
    effectiveMfaPolicy: mfaPolicy ?? instanceMfaPolicy,
    hostedAuth: normalizeHostedAuthPolicy(metadata['hostedAuth']),
    sessionPolicy: {
      idleTimeoutMin: policy?.sessionIdleTimeoutMin ?? null,
      absoluteTimeoutDays: policy?.sessionAbsoluteTimeoutDays ?? null,
    },
    tokenPolicy: {
      accessTokenTtlSec: storedPolicyNumber(token, 'accessTokenTtlSec', 'access_token_ttl_sec'),
      sessionTokenTtlSec: storedPolicyNumber(token, 'sessionTokenTtlSec', 'session_token_ttl_sec'),
      refreshIdleTimeoutDays: storedPolicyNumber(
        token,
        'refreshIdleTimeoutDays',
        'refresh_idle_timeout_days',
      ),
      refreshAbsoluteTimeoutDays: storedPolicyNumber(
        token,
        'refreshAbsoluteTimeoutDays',
        'refresh_absolute_timeout_days',
      ),
    },
    deliveryChannelReadiness: deliveryChannelReadiness(org, env),
  }
}

function mergeAuthPolicy(
  currentHostedAuth: HostedAuthPolicy,
  body: Record<string, unknown>,
): HostedAuthPolicy {
  return normalizeHostedAuthPolicy(
    body['hostedAuth'] ?? body['hosted_auth'] ?? currentHostedAuth,
    DEFAULT_HOSTED_AUTH_POLICY,
  )
}

// 覆盖值语义:字段缺失 -> undefined(不动);显式 null -> null(清除覆盖,回退 instance 默认);
// 数字须落在 BOUNDS 内,越界/非数字 -> 422(paramName 精确到字段)。
function readPolicyOverrideField(
  raw: Record<string, unknown>,
  keys: readonly string[],
  bounds: { min: number; max: number },
  paramName: string,
): number | null | undefined {
  const key = keys.find((candidate) => hasOwn(raw, candidate))
  if (key === undefined) return undefined
  const value = raw[key]
  if (value === null) return null
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < bounds.min ||
    value > bounds.max
  ) {
    throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName } })
  }
  return value
}

type TokenPolicyPatch = {
  accessTokenTtlSec: number | null | undefined
  sessionTokenTtlSec: number | null | undefined
  refreshIdleTimeoutDays: number | null | undefined
  refreshAbsoluteTimeoutDays: number | null | undefined
}

function readTokenPolicyPatch(raw: unknown): TokenPolicyPatch | null {
  if (raw === undefined) return null
  if (!isRecord(raw)) {
    throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName: 'tokenPolicy' } })
  }
  const patch: TokenPolicyPatch = {
    accessTokenTtlSec: readPolicyOverrideField(
      raw,
      ['accessTokenTtlSec', 'access_token_ttl_sec'],
      TOKEN_POLICY_BOUNDS.accessTokenTtlSec,
      'tokenPolicy.accessTokenTtlSec',
    ),
    sessionTokenTtlSec: readPolicyOverrideField(
      raw,
      ['sessionTokenTtlSec', 'session_token_ttl_sec'],
      TOKEN_POLICY_BOUNDS.sessionTokenTtlSec,
      'tokenPolicy.sessionTokenTtlSec',
    ),
    refreshIdleTimeoutDays: readPolicyOverrideField(
      raw,
      ['refreshIdleTimeoutDays', 'refresh_idle_timeout_days'],
      TOKEN_POLICY_BOUNDS.refreshIdleTimeoutDays,
      'tokenPolicy.refreshIdleTimeoutDays',
    ),
    refreshAbsoluteTimeoutDays: readPolicyOverrideField(
      raw,
      ['refreshAbsoluteTimeoutDays', 'refresh_absolute_timeout_days'],
      TOKEN_POLICY_BOUNDS.refreshAbsoluteTimeoutDays,
      'tokenPolicy.refreshAbsoluteTimeoutDays',
    ),
  }
  if (Object.values(patch).every((value) => value === undefined)) {
    throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName: 'tokenPolicy' } })
  }
  return patch
}

// token_policy JSON 逐键合并:undefined 保留已有键,null 删键(回退 instance),数字覆盖;snake_case 落库。
function applyTokenJsonField(
  target: Record<string, unknown>,
  camelKey: string,
  snakeKey: string,
  value: number | null | undefined,
): void {
  if (value === undefined) return
  delete target[camelKey]
  if (value === null) {
    delete target[snakeKey]
    return
  }
  target[snakeKey] = value
}

function mergeTokenPolicy(
  existing: Record<string, unknown> | null | undefined,
  tokenPatch: TokenPolicyPatch,
): Record<string, unknown> {
  const next: Record<string, unknown> = isRecord(existing) ? { ...existing } : {}
  applyTokenJsonField(
    next,
    'accessTokenTtlSec',
    'access_token_ttl_sec',
    tokenPatch.accessTokenTtlSec,
  )
  applyTokenJsonField(
    next,
    'sessionTokenTtlSec',
    'session_token_ttl_sec',
    tokenPatch.sessionTokenTtlSec,
  )
  applyTokenJsonField(
    next,
    'refreshIdleTimeoutDays',
    'refresh_idle_timeout_days',
    tokenPatch.refreshIdleTimeoutDays,
  )
  applyTokenJsonField(
    next,
    'refreshAbsoluteTimeoutDays',
    'refresh_absolute_timeout_days',
    tokenPatch.refreshAbsoluteTimeoutDays,
  )
  return next
}

function readSessionPolicyPatch(
  rawSession: unknown,
): Partial<typeof schema.orgPolicies.$inferInsert> {
  if (rawSession === undefined) return {}
  if (!isRecord(rawSession)) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'sessionPolicy' },
    })
  }
  const idleTimeoutMin = readPolicyOverrideField(
    rawSession,
    ['idleTimeoutMin', 'idle_timeout_min'],
    SESSION_POLICY_BOUNDS.idleTimeoutMin,
    'sessionPolicy.idleTimeoutMin',
  )
  const absoluteTimeoutDays = readPolicyOverrideField(
    rawSession,
    ['absoluteTimeoutDays', 'absolute_timeout_days'],
    SESSION_POLICY_BOUNDS.absoluteTimeoutDays,
    'sessionPolicy.absoluteTimeoutDays',
  )
  if (idleTimeoutMin === undefined && absoluteTimeoutDays === undefined) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'sessionPolicy' },
    })
  }
  const updates: Partial<typeof schema.orgPolicies.$inferInsert> = {}
  if (idleTimeoutMin !== undefined) updates.sessionIdleTimeoutMin = idleTimeoutMin
  if (absoluteTimeoutDays !== undefined) updates.sessionAbsoluteTimeoutDays = absoluteTimeoutDays
  return updates
}

// org_policies upsert:无行则 insert(仅写本次涉及列,其余列靠 schema 默认/null,见 08 章 10.6)。
async function upsertOrgPolicy(
  orgDb: OrgDb,
  tenantId: string,
  patch: {
    rawSession: unknown
    tokenPatch: TokenPolicyPatch | null
    mfaPolicy: MfaEnforcement | null | undefined
  },
): Promise<typeof schema.orgPolicies.$inferSelect> {
  const updates = readSessionPolicyPatch(patch.rawSession)
  if (patch.mfaPolicy !== undefined) updates.mfaPolicy = patch.mfaPolicy
  const existing = await orgDb.orgPolicies.findOne()
  if (patch.tokenPatch !== null) {
    updates.tokenPolicy = mergeTokenPolicy(existing?.tokenPolicy, patch.tokenPatch)
  }
  if (existing) {
    const rows = await orgDb.orgPolicies.update(updates)
    return rows[0] ?? existing
  }
  return orgDb.orgPolicies.insert({
    id: crypto.randomUUID(),
    tenantId,
    orgId: orgDb.orgId,
    ...updates,
  })
}

function changedAuthPolicyFields(body: Record<string, unknown>): string[] {
  const groups: Record<string, readonly string[]> = {
    hostedAuth: ['hostedAuth', 'hosted_auth'],
    sessionPolicy: ['sessionPolicy', 'session_policy'],
    tokenPolicy: ['tokenPolicy', 'token_policy'],
    mfaPolicy: ['mfaPolicy'],
  }
  return Object.entries(groups)
    .filter(([, keys]) => keys.some((key) => hasOwn(body, key)))
    .map(([field]) => field)
}

export function registerOrgAuthPolicyRoutes(app: Hono<XidHonoEnv>): void {
  // GET /v1/organizations/:id/auth-policy
  app.get('/:id/auth-policy', async (c) => {
    const id = c.req.param('id')
    await requireApiKeyOrOrgManager(c, id, 'organizations:read')
    const org = await requireOrg(c, id)
    const db = createTenantDb(c.env.DB, c.get('tenant'))
    const [policy, instanceMfaPolicy] = await Promise.all([
      db.forOrg(id).orgPolicies.findOne(),
      readInstanceMfaPolicy(c, org),
    ])
    return c.json(toConsoleAuthPolicy(org, c.env, policy, instanceMfaPolicy))
  })

  // PATCH /v1/organizations/:id/auth-policy
  app.patch('/:id/auth-policy', async (c) => {
    const id = c.req.param('id')
    const auth = await requireApiKeyOrOrgManager(c, id, 'organizations:write')
    const org = await requireOrg(c, id)
    await assertOrgSelfServiceEditable(c, auth, org)
    const json = await readJsonBody(c)
    if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
    const body = validateBody(policyPatchBodySchema, json.value)
    const { mfaPolicy } = validateBody(mfaPolicyPatchSchema, body)
    const currentMetadata = readPrivateMetadata(org)
    const hostedAuth = mergeAuthPolicy(
      normalizeHostedAuthPolicy(currentMetadata['hostedAuth']),
      body,
    )
    const privateMetadata = {
      ...currentMetadata,
      hostedAuth,
    }
    const tenant = c.get('tenant')
    const db = createTenantDb(c.env.DB, tenant)
    const orgDb = db.forOrg(id)
    const tokenPatch = readTokenPolicyPatch(body['tokenPolicy'] ?? body['token_policy'])
    const rawSession = body['sessionPolicy'] ?? body['session_policy']
    const policy =
      rawSession !== undefined || tokenPatch !== null || mfaPolicy !== undefined
        ? await upsertOrgPolicy(orgDb, tenant.tenantId, { rawSession, tokenPatch, mfaPolicy })
        : await orgDb.orgPolicies.findOne()
    const [updated, instanceMfaPolicy] = await Promise.all([
      db.organizations.update({ privateMetadata }, eq(schema.organizations.id, id)),
      readInstanceMfaPolicy(c, org),
    ])
    emitWebhookAsync(c, {
      tenantId: tenant.tenantId,
      event: 'organization.auth_policy.updated',
      payload: { orgId: id },
    })
    auditOrgMutation(c, auth, {
      action: 'organization.auth_policy.updated',
      orgId: id,
      targetType: 'organization',
      targetId: id,
      details: { fields: changedAuthPolicyFields(body) },
    })
    return c.json(toConsoleAuthPolicy(updated[0]!, c.env, policy, instanceMfaPolicy))
  })
}
