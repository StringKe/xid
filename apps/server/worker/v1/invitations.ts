// Management API v1: /v1/organizations/:orgId/invitations 邀请资源。
// CRUD + list(cursor 分页) + bulk create(50/hour 限速)+ revoke。
// 认证:sk_live_ Bearer。租户隔离:createTenantDb + forOrg。
// token 只存 SHA-256 哈希(防 DB 泄露重放,见 password-auth rule 密码重置 token 策略)。

import { sha256Hex } from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import { ORGANIZATION_MEMBERSHIP_ROLES } from '@xid-kit/types'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import * as v from 'valibot'
import type { XidHonoEnv } from '../lib/types'
import { AppError } from '../lib/errors'
import { emailSchema, readJsonBody, validateBody } from '../lib/validate'
import { hostedAuthOriginForTenant } from '../lib/hosted-origin'
import { resolveLocale } from '../lib/locale'
import {
  requireApiKey,
  parsePagination,
  paginate,
  idAfterCursor,
  requireOrg,
  requireApiKeyOrOrgManager,
  checkInvitationRateLimit,
  emitWebhookAsync,
  emitManagementAuditAsync,
  auditActorId,
  canManageOwners,
} from './shared'
import { INVITATION_TTL_DAYS } from '../lib/ttl'
import { createTenantBoundInvitationToken, INVITATION_TOKEN_VERSION } from '../lib/invitation-token'
import { createPersistedId } from '../lib/persisted-id'
import { revokeSessionByIdentity } from '../lib/session'
import {
  enqueuePersistedEmailNotification,
  prepareNotificationOutboxInsert,
  type NotificationDeliveryInput,
} from '../queues/notification-delivery-state'

const app = new Hono<XidHonoEnv>()

// 形状校验只管字段类型/必填/边界;50/hour 限速语义不变(见 api-sdk-conventions rule)。
export const invitationRoleSchema = v.picklist(ORGANIZATION_MEMBERSHIP_ROLES)

const createInvitationBodySchema = v.object({
  email: emailSchema,
  role: v.optional(invitationRoleSchema),
  expires_in_days: v.optional(v.pipe(v.number(), v.minValue(1))),
})

type InvitationInternalField =
  | 'tokenHash'
  | 'tokenVersion'
  | 'emailClaimTokenHash'
  | 'emailClaimEmailHash'
  | 'emailClaimExpiresAt'
  | 'emailClaimConsumedAt'
  | 'emailClaimConsumptionId'
  | 'emailClaimUserId'
  | 'emailClaimRecoveryHash'
  | 'emailClaimSessionId'
  | 'emailClaimSessionReservedAt'
  | 'emailClaimFinalizationId'
  | 'displacedUserId'
  | 'displacedEmailId'

export type SafeInvitation = Omit<typeof schema.invitations.$inferSelect, InvitationInternalField>

type PreparedInvitation = {
  invitation: typeof schema.invitations.$inferSelect
  token: string
  delivery: NotificationDeliveryInput
  statements: [D1PreparedStatement, D1PreparedStatement]
}

type InvitationTargetState = 'available' | 'already_member' | 'already_invited'

export async function invitationTargetState(
  db: ReturnType<typeof createTenantDb>,
  orgId: string,
  email: string,
): Promise<InvitationTargetState> {
  const normalizedEmail = email.trim().toLowerCase()
  const [existingInvitation, emailRow] = await Promise.all([
    db
      .forOrg(orgId)
      .invitations.findOne(
        and(
          eq(schema.invitations.email, normalizedEmail),
          inArray(schema.invitations.status, ['pending', 'claim_verified']),
        ),
      ),
    db.userEmails.findOne(eq(schema.userEmails.email, normalizedEmail)),
  ])
  if (existingInvitation) return 'already_invited'
  // 已验证邮箱所属账号已是该 org 的 active 成员:邀请没有意义,接受时也只会落到同一账号。
  if (emailRow?.verified !== true || emailRow.verificationStatus !== 'verified') return 'available'
  const [user, membership] = await Promise.all([
    db.users.findOne(eq(schema.users.id, emailRow.userId)),
    db
      .forOrg(orgId)
      .memberships.findOne(
        and(
          eq(schema.memberships.userId, emailRow.userId),
          eq(schema.memberships.status, 'active'),
        ),
      ),
  ])
  const activeMember =
    membership &&
    user?.status === 'active' &&
    user.deletedAt === null &&
    user.mergedIntoUserId === null
  return activeMember ? 'already_member' : 'available'
}

async function assertInvitationTargetAvailable(
  db: ReturnType<typeof createTenantDb>,
  orgId: string,
  email: string,
): Promise<void> {
  if ((await invitationTargetState(db, orgId, email)) !== 'available') {
    throw new AppError('already_exists', { httpStatus: 409, meta: { paramName: 'email' } })
  }
}

// 邀请邮件用收件人的语言:本租户已有账户取 users.locale,没有账户回落默认语言;不用邀请人的请求语言。
export async function invitationRecipientLocale(
  db: ReturnType<typeof createTenantDb>,
  email: string,
): Promise<string> {
  const emailRow = await db.userEmails.findOne(eq(schema.userEmails.email, email))
  const user = emailRow ? await db.users.findOne(eq(schema.users.id, emailRow.userId)) : undefined
  return resolveLocale({ userLocale: user?.locale ?? null })
}

export function buildInvitationDelivery(input: {
  messageId: string
  tenantId: string
  orgName: string
  email: string
  role: string
  token: string
  authOrigin: string
  expiresInDays: number
  locale: string
}): NotificationDeliveryInput {
  return {
    messageId: input.messageId,
    tenantId: input.tenantId,
    channel: 'email',
    type: 'organization_invitation',
    provider: 'cloudflare',
    recipient: input.email,
    payload: {
      tenantId: input.tenantId,
      orgName: input.orgName,
      role: input.role,
      link: `${input.authOrigin}/accept-invitation?token=${encodeURIComponent(input.token)}`,
      expiresInDays: input.expiresInDays,
      locale: input.locale,
    },
  }
}

export async function prepareInvitation(
  env: Env,
  input: {
    tenantId: string
    orgId: string
    orgName: string
    email: string
    role: (typeof ORGANIZATION_MEMBERSHIP_ROLES)[number]
    invitedByUserId: string | null
    expiresInDays: number
    authOrigin: string
    locale: string
  },
): Promise<PreparedInvitation> {
  const now = Date.now()
  const id = createPersistedId('invitation')
  const email = input.email.trim().toLowerCase()
  const token = createTenantBoundInvitationToken(input.tenantId)
  const tokenHash = await sha256Hex(token)
  const expiresAt = new Date(now + input.expiresInDays * 86400_000)
  const invitation: typeof schema.invitations.$inferSelect = {
    id,
    tenantId: input.tenantId,
    orgId: input.orgId,
    email,
    role: input.role,
    tokenHash,
    tokenVersion: INVITATION_TOKEN_VERSION,
    inviteType: 'email',
    maxUses: null,
    usedCount: 0,
    status: 'pending',
    invitedByUserId: input.invitedByUserId,
    acceptedByUserId: null,
    emailClaimTokenHash: null,
    emailClaimEmailHash: null,
    emailClaimExpiresAt: null,
    emailClaimConsumedAt: null,
    emailClaimConsumptionId: null,
    emailClaimUserId: null,
    emailClaimRecoveryHash: null,
    emailClaimSessionId: null,
    emailClaimSessionReservedAt: null,
    emailClaimFinalizationId: null,
    displacedUserId: null,
    displacedEmailId: null,
    expiresAt,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  }
  const delivery = buildInvitationDelivery({ ...input, messageId: id, email, token })
  const invitationStatement = env.DB.prepare(
    `INSERT INTO invitations (
       id, tenant_id, org_id, email, role, token_hash, token_version, invite_type,
       max_uses, used_count, status, invited_by_user_id, accepted_by_user_id,
       expires_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'email', NULL, 0, 'pending', ?, NULL, ?, ?, ?)`,
  ).bind(
    id,
    input.tenantId,
    input.orgId,
    email,
    input.role,
    tokenHash,
    INVITATION_TOKEN_VERSION,
    input.invitedByUserId,
    expiresAt.getTime(),
    now,
    now,
  )
  const outboxStatement = await prepareNotificationOutboxInsert(env, delivery, {
    ignoreExisting: false,
    now,
  })
  return {
    invitation,
    token,
    delivery,
    statements: [invitationStatement, outboxStatement],
  }
}

// ---- 列表 ----

// GET /v1/organizations/:orgId/invitations?limit=&cursor=&status=
app.get('/:orgId/invitations', async (c) => {
  const orgId = c.req.param('orgId')
  await requireApiKeyOrOrgManager(c, orgId, 'invitations:read')

  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const orgDb = db.forOrg(orgId)
  const { limit, cursor } = parsePagination(c)
  const status = c.req.query('status') ?? 'pending'

  const afterCond = idAfterCursor(schema.invitations.id, cursor)
  const statusCond =
    status === 'pending'
      ? inArray(schema.invitations.status, ['pending', 'claim_verified'])
      : eq(schema.invitations.status, status)
  const where = afterCond ? and(statusCond, afterCond) : statusCond
  const [rows, total] = await Promise.all([
    orgDb.invitations.findMany(where, {
      orderBy: asc(schema.invitations.id),
      limit: limit + 1,
    }),
    orgDb.invitations.count(statusCond),
  ])
  return c.json({ ...paginate(rows.map(safeInvitation), (r) => r.id, limit), total })
})

// ---- 单个 ----

// GET /v1/organizations/:orgId/invitations/:invitationId
app.get('/:orgId/invitations/:invitationId', async (c) => {
  await requireApiKey(c, 'invitations:read')
  const orgId = c.req.param('orgId')
  await requireOrg(c, orgId)

  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const orgDb = db.forOrg(orgId)
  const invitationId = c.req.param('invitationId')

  const row = await orgDb.invitations.findOne(
    and(
      eq(schema.invitations.id, invitationId),
      inArray(schema.invitations.status, ['pending', 'claim_verified']),
    ),
  )
  if (!row) throw new AppError('not_found', { httpStatus: 404 })
  return c.json(safeInvitation(row))
})

// ---- 创建(单条) ----

// POST /v1/organizations/:orgId/invitations
app.post('/:orgId/invitations', async (c) => {
  const orgId = c.req.param('orgId')
  const auth = await requireApiKeyOrOrgManager(c, orgId, 'invitations:write')
  if (auth.kind === 'api_key') await checkInvitationRateLimit(c, 1)

  const tenant = c.get('tenant')

  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(createInvitationBodySchema, json.value)

  // Owner assignment is a privilege boundary, not a transport scope. Only an authenticated owner
  // or org_manager principal may create it; an API key cannot carry the issuer's original role.
  if (body.role === 'owner' && !canManageOwners(auth)) {
    throw new AppError('forbidden', { httpStatus: 403 })
  }

  const org = await requireOrg(c, orgId)
  const db = createTenantDb(c.env.DB, tenant)
  const normalizedEmail = body.email.trim().toLowerCase()
  await assertInvitationTargetAvailable(db, orgId, normalizedEmail)
  const invitedByUserId = auth.kind === 'org_console' ? auth.session.userId : null
  const prepared = await prepareInvitation(c.env, {
    tenantId: tenant.tenantId,
    orgId,
    orgName: org.name,
    email: normalizedEmail,
    role: body.role ?? 'member',
    invitedByUserId,
    expiresInDays: body.expires_in_days ?? INVITATION_TTL_DAYS,
    authOrigin: hostedAuthOriginForTenant(tenant),
    locale: await invitationRecipientLocale(db, normalizedEmail),
  })
  try {
    await c.env.DB.batch(prepared.statements)
  } catch (error) {
    await assertInvitationTargetAvailable(db, orgId, normalizedEmail)
    throw new AppError('server_error', { cause: error })
  }
  await enqueuePersistedEmailNotification(c.env, prepared.delivery)
  emitWebhookAsync(c, {
    tenantId: tenant.tenantId,
    event: 'organizationInvitation.created',
    payload: { orgId, invitationId: prepared.invitation.id, email: prepared.invitation.email },
  })
  emitManagementAuditAsync(c, {
    action: 'invitation.created',
    actorId: auditActorId(auth),
    orgId,
    targetType: 'invitation',
    targetId: prepared.invitation.id,
    details: { role: prepared.invitation.role },
  })
  if (auth.kind === 'org_console') return c.json(safeInvitation(prepared.invitation), 201)
  return c.json({ ...safeInvitation(prepared.invitation), token: prepared.token }, 201)
})

// ---- 撤销 ----

async function markInvitationRevoked(
  db: ReturnType<typeof createTenantDb>,
  orgId: string,
  invitationId: string,
): Promise<typeof schema.invitations.$inferSelect> {
  const orgDb = db.forOrg(orgId)
  const updated = await orgDb.invitations.update(
    { status: 'revoked' },
    and(
      eq(schema.invitations.id, invitationId),
      inArray(schema.invitations.status, ['pending', 'claim_verified']),
    ),
  )
  const winner = updated[0]
  if (winner) return winner

  const current = await orgDb.invitations.findOne(eq(schema.invitations.id, invitationId))
  if (!current) throw new AppError('not_found', { httpStatus: 404 })
  throw new AppError('conflict', { httpStatus: 409 })
}

// 两个撤销入口共用:状态变更、webhook、审计、会话清理顺序一致。
async function revokeInvitation(
  c: Context<XidHonoEnv>,
  input: { orgId: string; invitationId: string; actorId: string },
): Promise<typeof schema.invitations.$inferSelect> {
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const revoked = await markInvitationRevoked(db, input.orgId, input.invitationId)
  emitWebhookAsync(c, {
    tenantId: tenant.tenantId,
    event: 'organizationInvitation.revoked',
    payload: { orgId: input.orgId, invitationId: input.invitationId },
  })
  emitManagementAuditAsync(c, {
    action: 'invitation.revoked',
    actorId: input.actorId,
    orgId: input.orgId,
    targetType: 'invitation',
    targetId: input.invitationId,
  })
  if (revoked.emailClaimUserId && revoked.emailClaimSessionId) {
    await revokeSessionByIdentity(c, revoked.emailClaimUserId, revoked.emailClaimSessionId)
  }
  return revoked
}

// POST /v1/organizations/:orgId/invitations/:invitationId/revoke
app.post('/:orgId/invitations/:invitationId/revoke', async (c) => {
  const key = await requireApiKey(c, 'invitations:write')
  const orgId = c.req.param('orgId')
  await requireOrg(c, orgId)
  const revoked = await revokeInvitation(c, {
    orgId,
    invitationId: c.req.param('invitationId'),
    actorId: key.id,
  })
  return c.json(safeInvitation(revoked))
})

// ---- 删除 ----

// DELETE /v1/organizations/:orgId/invitations/:invitationId
app.delete('/:orgId/invitations/:invitationId', async (c) => {
  const orgId = c.req.param('orgId')
  const auth = await requireApiKeyOrOrgManager(c, orgId, 'invitations:write')
  await revokeInvitation(c, {
    orgId,
    invitationId: c.req.param('invitationId'),
    actorId: auditActorId(auth),
  })
  return new Response(null, { status: 204 })
})

// Claim capability hashes, session reservations and displaced identity references never leave the
// Worker. claim_verified remains a public pending invitation until final acceptance or revocation.
export function safeInvitation(row: typeof schema.invitations.$inferSelect): SafeInvitation {
  const {
    tokenHash: _tokenHash,
    tokenVersion: _tokenVersion,
    emailClaimTokenHash: _emailClaimTokenHash,
    emailClaimEmailHash: _emailClaimEmailHash,
    emailClaimExpiresAt: _emailClaimExpiresAt,
    emailClaimConsumedAt: _emailClaimConsumedAt,
    emailClaimConsumptionId: _emailClaimConsumptionId,
    emailClaimUserId: _emailClaimUserId,
    emailClaimRecoveryHash: _emailClaimRecoveryHash,
    emailClaimSessionId: _emailClaimSessionId,
    emailClaimSessionReservedAt: _emailClaimSessionReservedAt,
    emailClaimFinalizationId: _emailClaimFinalizationId,
    displacedUserId: _displacedUserId,
    displacedEmailId: _displacedEmailId,
    ...rest
  } = row
  return {
    ...rest,
    status: rest.status === 'claim_verified' ? 'pending' : rest.status,
  }
}

export function registerInvitationsRoutes(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/organizations', app)
}
