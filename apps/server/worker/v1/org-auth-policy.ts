// /v1/organizations/:id/auth-policy:Hosted Auth、登录方式限制、会话、令牌与 MFA 的组织级覆盖。

import { createTenantDb, schema } from '@xid-kit/db'
import type { HostedAuthPolicy, MfaEnforcement } from '@xid-kit/types'
import {
  DEFAULT_HOSTED_AUTH_POLICY,
  MFA_ENFORCEMENT,
  normalizeHostedAuthPolicy,
} from '@xid-kit/types'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import type { Context, Hono } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { readJsonBody, validateBody } from '../lib/validate'
import { deliveryChannelReadiness } from './org-delivery-channel-view'
import type { ConsoleDeliveryChannelReadiness } from './org-delivery-channel-view'
import {
  assertAttestationModeReady,
  assertForceSsoReady,
  hasAttestationTrustedRoots,
} from './org-auth-policy-guards'
import {
  mergeTokenPolicy,
  readSessionPolicyPatch,
  readTokenPolicyPatch,
  storedPolicyNumber,
} from './org-auth-policy-overrides'
import type { TokenPolicyPatch } from './org-auth-policy-overrides'
import { hasOwn, readLoginPolicyPatch, readPrivateMetadata } from './org-policy-fields'
import type { LoginPolicyPatch } from './org-policy-fields'
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

// org_policies 的两列只能收紧 hostedAuth:forceSso 与 hostedAuth.forceSso 任一为真即强制 SSO,
// allowPasswordLogin=false 时即使开启了密码方式也不能用密码登录。
type ConsoleLoginPolicy = {
  forceSso: boolean
  allowPasswordLogin: boolean
}

type ConsoleAuthPolicy = {
  hostedAuth: HostedAuthPolicy
  loginPolicy: ConsoleLoginPolicy
  attestationRootsConfigured: boolean
  sessionPolicy: ConsoleSessionPolicyOverride
  tokenPolicy: ConsoleTokenPolicyOverride
  deliveryChannelReadiness: ConsoleDeliveryChannelReadiness
  mfaPolicy: MfaEnforcement | null
  effectiveMfaPolicy: MfaEnforcement
}

type OrgDb = ReturnType<ReturnType<typeof createTenantDb>['forOrg']>
type OrgPolicyRow = typeof schema.orgPolicies.$inferSelect

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

async function toConsoleAuthPolicy(
  c: Context<XidHonoEnv>,
  org: typeof schema.organizations.$inferSelect,
  policy: OrgPolicyRow | undefined,
): Promise<ConsoleAuthPolicy> {
  const [instanceMfaPolicy, attestationRootsConfigured] = await Promise.all([
    readInstanceMfaPolicy(c, org),
    hasAttestationTrustedRoots(c),
  ])
  const metadata = readPrivateMetadata(org)
  const mfaPolicy = asMfaEnforcement(policy?.mfaPolicy)
  const token = policy?.tokenPolicy
  return {
    mfaPolicy,
    effectiveMfaPolicy: mfaPolicy ?? instanceMfaPolicy,
    hostedAuth: normalizeHostedAuthPolicy(metadata['hostedAuth']),
    loginPolicy: {
      forceSso: policy?.forceSso ?? false,
      allowPasswordLogin: policy?.allowPasswordLogin ?? true,
    },
    attestationRootsConfigured,
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
    deliveryChannelReadiness: deliveryChannelReadiness(org, c.env),
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

type OrgPolicyPatch = {
  rawSession: unknown
  tokenPatch: TokenPolicyPatch | null
  mfaPolicy: MfaEnforcement | null | undefined
  loginPatch: LoginPolicyPatch | null
}

function hasOrgPolicyChanges(patch: OrgPolicyPatch): boolean {
  return (
    patch.rawSession !== undefined ||
    patch.tokenPatch !== null ||
    patch.mfaPolicy !== undefined ||
    patch.loginPatch !== null
  )
}

// org_policies upsert:无行则 insert(仅写本次涉及列,其余列靠 schema 默认/null,见 08 章 10.6)。
async function upsertOrgPolicy(
  orgDb: OrgDb,
  tenantId: string,
  existing: OrgPolicyRow | undefined,
  patch: OrgPolicyPatch,
): Promise<OrgPolicyRow> {
  const updates = readSessionPolicyPatch(patch.rawSession)
  if (patch.mfaPolicy !== undefined) updates.mfaPolicy = patch.mfaPolicy
  if (patch.loginPatch?.forceSso !== undefined) updates.forceSso = patch.loginPatch.forceSso
  if (patch.loginPatch?.allowPasswordLogin !== undefined) {
    updates.allowPasswordLogin = patch.loginPatch.allowPasswordLogin
  }
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
    loginPolicy: ['loginPolicy', 'login_policy'],
    sessionPolicy: ['sessionPolicy', 'session_policy'],
    tokenPolicy: ['tokenPolicy', 'token_policy'],
    mfaPolicy: ['mfaPolicy'],
  }
  return Object.entries(groups)
    .filter(([, keys]) => keys.some((key) => hasOwn(body, key)))
    .map(([field]) => field)
}

function readOrgPolicyPatch(body: Record<string, unknown>): OrgPolicyPatch {
  const { mfaPolicy } = validateBody(mfaPolicyPatchSchema, body)
  return {
    mfaPolicy,
    rawSession: body['sessionPolicy'] ?? body['session_policy'],
    tokenPatch: readTokenPolicyPatch(body['tokenPolicy'] ?? body['token_policy']),
    loginPatch: readLoginPolicyPatch(body['loginPolicy'] ?? body['login_policy']),
  }
}

export function registerOrgAuthPolicyRoutes(app: Hono<XidHonoEnv>): void {
  // GET /v1/organizations/:id/auth-policy
  app.get('/:id/auth-policy', async (c) => {
    const id = c.req.param('id')
    await requireApiKeyOrOrgManager(c, id, 'organizations:read')
    const org = await requireOrg(c, id)
    const policy = await createTenantDb(c.env.DB, c.get('tenant')).forOrg(id).orgPolicies.findOne()
    return c.json(await toConsoleAuthPolicy(c, org, policy))
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
    const patch = readOrgPolicyPatch(body)
    const currentMetadata = readPrivateMetadata(org)
    const currentHostedAuth = normalizeHostedAuthPolicy(currentMetadata['hostedAuth'])
    const hostedAuth = mergeAuthPolicy(currentHostedAuth, body)
    const tenant = c.get('tenant')
    const db = createTenantDb(c.env.DB, tenant)
    const orgDb = db.forOrg(id)
    const existing = await orgDb.orgPolicies.findOne()
    await assertForceSsoReady(orgDb, {
      column: patch.loginPatch?.forceSso === true && existing?.forceSso !== true,
      hostedAuth: hostedAuth.forceSso && !currentHostedAuth.forceSso,
    })
    await assertAttestationModeReady(c, currentHostedAuth, hostedAuth)
    const policy = hasOrgPolicyChanges(patch)
      ? await upsertOrgPolicy(orgDb, tenant.tenantId, existing, patch)
      : existing
    const updated = await db.organizations.update(
      { privateMetadata: { ...currentMetadata, hostedAuth } },
      eq(schema.organizations.id, id),
    )
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
    return c.json(await toConsoleAuthPolicy(c, updated[0]!, policy))
  })
}
