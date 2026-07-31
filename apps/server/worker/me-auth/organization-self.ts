// 尚未完成 onboarding 的用户自助创建顶级 Tenant，并把用户身份数据与会话原子迁移过去。

import { createTenantDb, schema } from '@xid-kit/db'
import { DEFAULT_HOSTED_AUTH_POLICY } from '@xid-kit/types'
import { and, eq } from 'drizzle-orm'
import type { Context } from 'hono'
import * as v from 'valibot'
import { invitationAcceptContinuePath } from '../auth/invitations'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import type { XidHonoEnv } from '../lib/types'
import { emailSchema, readJsonBody, slugSchema, validateBody } from '../lib/validate'
import { emitWebhookAsync } from '../v1/shared'
import { PLAN_DEFAULTS } from '../platform/plans'
import { checkRateLimit, ORG_CREATE_PER_DAY_POLICY, requireSession } from './shared'

const DEFAULT_TENANT_SLUG = 'default'

const createOrgBodySchema = v.object({
  email: emailSchema,
  slug: v.optional(v.string()),
  name: v.optional(v.string()),
})

type SourceTenantRow = {
  instanceMode: string
  slug: string
  parentOrgId: string | null
  orgTenantId: string
}

const USER_OWNED_TENANT_TABLES = [
  'user_emails',
  'user_phones',
  'user_identities',
  'gdpr_consents',
  'passwords',
  'password_history',
  'password_reset_tokens',
  'verification_tokens',
  'passkey_credentials',
  'mfa_factors',
  'backup_codes',
  'trusted_devices',
  'metering_outbox',
  'privacy_requests',
] as const

function normalizeSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function defaultOrgMetadata(): Record<string, unknown> {
  return { hostedAuth: DEFAULT_HOSTED_AUTH_POLICY }
}

function d1Changes(result: D1Result<unknown> | undefined): number {
  return result?.meta.changes ?? 0
}

function isInstanceSlugConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes(
      'UNIQUE constraint failed: organizations.instance_id, organizations.slug',
    )
  )
}

async function loadSourceTenant(
  env: Env,
  tenantId: string,
  instanceId: string,
): Promise<SourceTenantRow | null> {
  return env.DB.prepare(
    `SELECT i.mode AS instanceMode,
            o.slug AS slug,
            o.parent_org_id AS parentOrgId,
            o.tenant_id AS orgTenantId
       FROM organizations o
       JOIN instances i ON i.id = o.instance_id
      WHERE o.id = ?
        AND o.tenant_id = ?
        AND o.instance_id = ?
        AND o.status = 'active'
        AND o.deleted_at IS NULL
      LIMIT 1`,
  )
    .bind(tenantId, tenantId, instanceId)
    .first<SourceTenantRow>()
}

async function instanceSlugExists(env: Env, instanceId: string, slug: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT id
       FROM organizations
      WHERE instance_id = ?
        AND slug = ?
      LIMIT 1`,
  )
    .bind(instanceId, slug)
    .first<{ id: string }>()
  return row !== null
}

async function loadExistingEmail(
  db: ReturnType<typeof createTenantDb>,
  userId: string,
  primaryEmailId: string | null,
): Promise<string | null> {
  if (primaryEmailId) {
    const row = await db.userEmails.findOne(
      and(eq(schema.userEmails.id, primaryEmailId), eq(schema.userEmails.userId, userId)),
    )
    if (row) return row.email
  }
  const primary = await db.userEmails.findOne(
    and(eq(schema.userEmails.userId, userId), eq(schema.userEmails.isPrimary, true)),
  )
  if (primary) return primary.email
  const fallback = await db.userEmails.findOne(eq(schema.userEmails.userId, userId))
  return fallback?.email ?? null
}

export function buildTenantMigrationStatements(opts: {
  env: Env
  sourceTenantId: string
  targetTenantId: string
  instanceId: string
  userId: string
  sessionId: string
  email: string
  pendingEmail: string | null
  slug: string
  name: string
  membershipId: string
  nowMs: number
}): D1PreparedStatement[] {
  const {
    env,
    sourceTenantId,
    targetTenantId,
    instanceId,
    userId,
    sessionId,
    email,
    pendingEmail,
    slug,
    name,
    membershipId,
    nowMs,
  } = opts

  // 只有跨 Tenant 原子迁移不能由单 Tenant accessor 表达，因此在一个 D1 batch 内显式绑定源和目标 tenant_id。
  const claimUser = env.DB.prepare(
    `UPDATE users
        SET tenant_id = ?, pending_email = ?, updated_at = ?
      WHERE tenant_id = ?
        AND id = ?
        AND is_new_user = 1
        AND status = 'active'
        AND deleted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM sessions
           WHERE tenant_id = ?
             AND id = ?
             AND user_id = ?
             AND status = 'active'
        )
        AND NOT EXISTS (
          SELECT 1 FROM memberships
           WHERE tenant_id = ? AND user_id = ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM privacy_requests
           WHERE tenant_id = ?
             AND user_id = ?
             AND status IN ('pending', 'processing')
        )
        AND NOT EXISTS (
          SELECT 1 FROM manager_assignments
           WHERE tenant_id = ? AND user_id = ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM user_grants
           WHERE tenant_id = ? AND user_id = ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM authorization_codes
           WHERE tenant_id = ? AND user_id = ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM refresh_tokens
           WHERE tenant_id = ? AND user_id = ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM oauth_consents
           WHERE tenant_id = ? AND user_id = ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM saml_session_bindings
           WHERE tenant_id = ? AND user_id = ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM directory_users
           WHERE tenant_id = ? AND user_id = ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM access_token_issuances
           WHERE tenant_id = ? AND subject = ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM access_token_revocations
           WHERE tenant_id = ? AND subject = ?
        )
        AND (
          NOT EXISTS (
            SELECT 1 FROM user_emails
             WHERE tenant_id = ? AND user_id = ?
          )
          OR EXISTS (
            SELECT 1 FROM user_emails
             WHERE tenant_id = ? AND user_id = ? AND lower(email) = ?
          )
        )`,
  ).bind(
    targetTenantId,
    pendingEmail,
    nowMs,
    sourceTenantId,
    userId,
    sourceTenantId,
    sessionId,
    userId,
    sourceTenantId,
    userId,
    sourceTenantId,
    userId,
    sourceTenantId,
    userId,
    sourceTenantId,
    userId,
    sourceTenantId,
    userId,
    sourceTenantId,
    userId,
    sourceTenantId,
    userId,
    sourceTenantId,
    userId,
    sourceTenantId,
    userId,
    sourceTenantId,
    userId,
    sourceTenantId,
    userId,
    sourceTenantId,
    userId,
    sourceTenantId,
    userId,
    email,
  )

  const createTenant = env.DB.prepare(
    `INSERT INTO organizations (
       id, tenant_id, instance_id, parent_org_id, slug, name,
       public_metadata, private_metadata, seat_limit, enrollment_mode,
       allow_org_self_service, status, created_at, updated_at
     )
     SELECT ?, ?, ?, NULL, ?, ?, ?, ?, ?, 'invite_required', 1, 'active', ?, ?
       FROM users
      WHERE id = ? AND tenant_id = ?`,
  ).bind(
    targetTenantId,
    targetTenantId,
    instanceId,
    slug,
    name,
    JSON.stringify({}),
    JSON.stringify(defaultOrgMetadata()),
    PLAN_DEFAULTS.free.seatLimit,
    nowMs,
    nowMs,
    userId,
    targetTenantId,
  )

  const createSeatQuota = env.DB.prepare(
    `INSERT INTO organization_quotas (
       tenant_id, quota_key, "limit", enforcement, updated_by, created_at, updated_at
     )
     SELECT ?, 'seats', ?, 'block_creation', NULL, ?, ?
       FROM organizations
      WHERE id = ? AND tenant_id = ? AND parent_org_id IS NULL`,
  ).bind(targetTenantId, PLAN_DEFAULTS.free.seatLimit, nowMs, nowMs, targetTenantId, targetTenantId)

  const createOwnerMembership = env.DB.prepare(
    `INSERT INTO memberships (
       id, tenant_id, org_id, user_id, role, membership_type,
       status, is_managed, joined_at, created_at, updated_at
     )
     SELECT ?, ?, ?, ?, 'owner', 'member', 'active', 0, ?, ?, ?
       FROM users
      WHERE id = ? AND tenant_id = ?`,
  ).bind(
    membershipId,
    targetTenantId,
    targetTenantId,
    userId,
    nowMs,
    nowMs,
    nowMs,
    userId,
    targetTenantId,
  )

  const moveUserOwnedRows = USER_OWNED_TENANT_TABLES.map((table) =>
    env.DB.prepare(
      `UPDATE ${table}
          SET tenant_id = ?
        WHERE tenant_id = ?
          AND user_id = ?
          AND EXISTS (
            SELECT 1 FROM users
             WHERE id = ? AND tenant_id = ?
          )`,
    ).bind(targetTenantId, sourceTenantId, userId, userId, targetTenantId),
  )

  const moveSessions = env.DB.prepare(
    `UPDATE sessions
        SET tenant_id = ?, active_org_id = ?
      WHERE tenant_id = ?
        AND user_id = ?
        AND EXISTS (
          SELECT 1 FROM users
           WHERE id = ? AND tenant_id = ?
        )`,
  ).bind(targetTenantId, targetTenantId, sourceTenantId, userId, userId, targetTenantId)

  return [
    claimUser,
    createTenant,
    createSeatQuota,
    createOwnerMembership,
    ...moveUserOwnedRows,
    moveSessions,
  ]
}

export async function handleSelfOrganizationCreate(c: Context<XidHonoEnv>): Promise<Response> {
  const session = await requireSession(c)
  const tenant = c.get('tenant')
  const instanceId = tenant.instanceId
  if (!instanceId) throw new AppError('server_error')

  const allowed = await checkRateLimit(
    c.env,
    `org_create:day:${tenant.tenantId}:${session.userId}`,
    ORG_CREATE_PER_DAY_POLICY,
  )
  if (!allowed) throw new AppError('rate_limited')

  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(createOrgBodySchema, json.value)
  const email = body.email.trim().toLowerCase()
  const name = (body.name ?? '').trim()
  const slug = normalizeSlug((body.slug ?? name).trim())
  if (!name || !v.safeParse(slugSchema, slug).success) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      longMessage: 'slug and name are required.',
    })
  }

  const sourceTenant = await loadSourceTenant(c.env, tenant.tenantId, instanceId)
  if (
    !sourceTenant ||
    sourceTenant.instanceMode !== 'multi_tenant' ||
    sourceTenant.slug !== DEFAULT_TENANT_SLUG ||
    sourceTenant.parentOrgId !== null ||
    sourceTenant.orgTenantId !== tenant.tenantId
  ) {
    throw new AppError('conflict', { httpStatus: 409 })
  }
  if (await instanceSlugExists(c.env, instanceId, slug)) {
    throw new AppError('already_exists', { httpStatus: 409, meta: { paramName: 'slug' } })
  }

  const db = createTenantDb(c.env.DB, tenant)
  const user = await db.users.findOne(
    and(
      eq(schema.users.id, session.userId),
      eq(schema.users.status, 'active'),
      eq(schema.users.isNewUser, true),
    ),
  )
  if (!user || user.deletedAt !== null) throw new AppError('conflict', { httpStatus: 409 })

  const existingEmail = await loadExistingEmail(db, user.id, user.primaryEmailId)
  if (existingEmail && existingEmail.trim().toLowerCase() !== email) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'email' },
    })
  }

  const orgId = createPersistedId('organization')
  const membershipId = createPersistedId('membership')
  const nowMs = Date.now()
  let results: D1Result<unknown>[]
  try {
    results = await c.env.DB.batch(
      buildTenantMigrationStatements({
        env: c.env,
        sourceTenantId: tenant.tenantId,
        targetTenantId: orgId,
        instanceId,
        userId: session.userId,
        sessionId: session.sessionId,
        email,
        pendingEmail: existingEmail ? null : email,
        slug,
        name,
        membershipId,
        nowMs,
      }),
    )
  } catch (error) {
    if (isInstanceSlugConflict(error)) {
      throw new AppError('already_exists', { httpStatus: 409, meta: { paramName: 'slug' } })
    }
    throw error
  }

  if (
    d1Changes(results[0]) !== 1 ||
    d1Changes(results[1]) !== 1 ||
    d1Changes(results[2]) !== 1 ||
    d1Changes(results[3]) !== 1 ||
    d1Changes(results.at(-1)) < 1
  ) {
    throw new AppError('conflict', { httpStatus: 409 })
  }

  emitWebhookAsync(c, {
    tenantId: orgId,
    event: 'organization.created',
    payload: { orgId },
  })
  emitWebhookAsync(c, {
    tenantId: orgId,
    event: 'organizationMembership.created',
    payload: { orgId, userId: session.userId },
  })

  return c.json(
    {
      id: orgId,
      slug,
      name,
      role: 'owner',
      redirectUrl: invitationAcceptContinuePath(orgId, name, 'owner'),
    },
    201,
  )
}
