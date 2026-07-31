// 组织邀请:token 查找、预览、接受(写 membership + 更新 invitation 状态)。
// token 只存 SHA-256 哈希(见 password-auth rule / v1/invitations.ts)。

import { sha256Hex } from '@xid-kit/crypto'
import { createTenantDb, resolveTenantContextByIdInInstance, schema } from '@xid-kit/db'
import type { OrganizationMembershipRole } from '@xid-kit/types'
import { and, eq, isNull } from 'drizzle-orm'
import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import { invitationTenantIdFromToken } from '../lib/invitation-token'
import { createPersistedId } from '../lib/persisted-id'
import type { TenantVar, XidHonoEnv } from '../lib/types'
import { emitWebhookAsync } from '../v1/shared'

export type InvitationPreview = {
  status: 'pending' | 'expired' | 'invalid'
  email: string | null
  orgId: string | null
  orgName: string | null
  role: OrganizationMembershipRole | null
  expiresAt: string | null
}

export type AcceptInvitationResult = {
  orgId: string
  membershipId: string
  role: OrganizationMembershipRole
}

export type VerifiedInvitationEmail = {
  email: string
  verified: true
  verificationStatus: 'verified'
}

export async function findInvitationByRawToken(
  db: ReturnType<typeof createTenantDb>,
  rawToken: string,
): Promise<typeof schema.invitations.$inferSelect | null> {
  const tokenHash = await sha256Hex(rawToken.trim())
  const row = await db.invitations.findOne(eq(schema.invitations.tokenHash, tokenHash))
  return row ?? null
}

export async function findInvitationById(
  db: ReturnType<typeof createTenantDb>,
  invitationId: string,
): Promise<typeof schema.invitations.$inferSelect | null> {
  const row = await db.invitations.findOne(eq(schema.invitations.id, invitationId))
  return row ?? null
}

// Instance-root invitation routing is a two-step proof:
// 1. decode the untrusted locator and resolve one candidate Tenant in the current Instance;
// 2. require the complete opaque token hash to exist through that Tenant's scoped DB.
// The locator alone never grants access and there is no global invitation-token lookup.
export async function resolveInvitationTenant(
  c: Context<XidHonoEnv>,
  rawToken: string,
): Promise<TenantVar | null> {
  const token = rawToken.trim()
  if (!token) return null

  const current = c.get('tenant')
  const tenantId = invitationTenantIdFromToken(token)
  if (!tenantId) {
    // A legacy opaque token has no recoverable Tenant locator. It is safe only when Host/cookie
    // resolution has already produced a concrete Tenant, because the complete hash lookup remains
    // scoped there. The cutover migration revokes every pre-existing pending legacy row; this path
    // exists only for explicit same-Tenant diagnosis and never performs a global lookup.
    if (current.resolution?.unresolvedRoot) return null
    const currentDb = createTenantDb(c.env.DB, current)
    const legacyInvitation = await findInvitationByRawToken(currentDb, token)
    return legacyInvitation?.tokenVersion === 'legacy' ? current : null
  }

  let candidate = current
  if (tenantId !== current.tenantId) {
    if (!current.instanceId) return null
    const result = await resolveTenantContextByIdInInstance(
      c.req.raw,
      c.env,
      tenantId,
      current.instanceId,
    )
    if (!result.ok || result.value.status !== 'resolved') return null
    candidate = result.value.tenant
  }

  const db = createTenantDb(c.env.DB, candidate)
  const invitation = await findInvitationByRawToken(db, token)
  return invitation ? candidate : null
}

export async function loadInvitationPreview(
  db: ReturnType<typeof createTenantDb>,
  rawToken: string,
): Promise<InvitationPreview> {
  const invitation = await findInvitationByRawToken(db, rawToken)
  return loadInvitationPreviewForRow(db, invitation)
}

export async function loadInvitationPreviewById(
  db: ReturnType<typeof createTenantDb>,
  invitationId: string,
): Promise<InvitationPreview> {
  const invitation = await findInvitationById(db, invitationId)
  return loadInvitationPreviewForRow(db, invitation)
}

async function loadInvitationPreviewForRow(
  db: ReturnType<typeof createTenantDb>,
  invitation: typeof schema.invitations.$inferSelect | null,
): Promise<InvitationPreview> {
  const invalid: InvitationPreview = {
    status: 'invalid',
    email: null,
    orgId: null,
    orgName: null,
    role: null,
    expiresAt: null,
  }
  if (!invitation) return invalid
  if (invitation.status === 'accepted' || invitation.status === 'revoked') return invalid
  if (invitation.expiresAt.getTime() <= Date.now()) {
    if (invitation.status === 'pending') {
      await db.invitations.update(
        { status: 'expired' },
        and(eq(schema.invitations.id, invitation.id), eq(schema.invitations.status, 'pending')),
      )
    }
    return {
      status: 'expired',
      email: invitation.email,
      orgId: invitation.orgId,
      orgName: null,
      role: invitation.role,
      expiresAt: invitation.expiresAt.toISOString(),
    }
  }
  if (invitation.status !== 'pending') return invalid

  const org = await db.organizations.findOne(
    and(
      eq(schema.organizations.id, invitation.orgId),
      eq(schema.organizations.status, 'active'),
      isNull(schema.organizations.deletedAt),
    ),
  )
  if (!org) return invalid

  return {
    status: 'pending',
    email: invitation.email,
    orgId: invitation.orgId,
    orgName: org.name,
    role: invitation.role,
    expiresAt: invitation.expiresAt.toISOString(),
  }
}

export async function loadPrimaryEmailForUserId(
  db: ReturnType<typeof createTenantDb>,
  userId: string,
  primaryEmailId: string | null,
): Promise<VerifiedInvitationEmail | null> {
  if (!primaryEmailId) return null
  const row = await db.userEmails.findOne(
    and(eq(schema.userEmails.id, primaryEmailId), eq(schema.userEmails.userId, userId)),
  )
  if (!row || row.verified !== true || row.verificationStatus !== 'verified') return null
  return { email: row.email, verified: true, verificationStatus: 'verified' }
}

export async function assertInvitationEmailMatches(
  invitation: typeof schema.invitations.$inferSelect,
  userEmail: VerifiedInvitationEmail | null,
): Promise<void> {
  if (userEmail?.verified !== true || userEmail.verificationStatus !== 'verified') {
    throw new AppError('invitation_email_mismatch', { httpStatus: 403 })
  }
  assertInvitationTargetEmailMatches(invitation, userEmail.email)
}

export function assertInvitationTargetEmailMatches(
  invitation: typeof schema.invitations.$inferSelect,
  email: string,
): void {
  const inviteEmail = invitation.email.trim().toLowerCase()
  const normalized = email.trim().toLowerCase()
  if (!normalized || normalized !== inviteEmail) {
    throw new AppError('invitation_email_mismatch', { httpStatus: 403 })
  }
}

export async function acceptInvitation(opts: {
  db: ReturnType<typeof createTenantDb>
  env: Env
  tenantId: string
  invitation: typeof schema.invitations.$inferSelect
  userId: string
  userEmail: VerifiedInvitationEmail | null
}): Promise<AcceptInvitationResult> {
  const { db, env, tenantId, invitation, userId, userEmail } = opts

  if (invitation.status === 'accepted') {
    throw new AppError('invitation_already_accepted', { httpStatus: 409 })
  }
  if (invitation.status !== 'pending') {
    throw new AppError('invitation_invalid')
  }
  if (invitation.expiresAt.getTime() <= Date.now()) {
    await db.invitations.update(
      { status: 'expired' },
      and(eq(schema.invitations.id, invitation.id), eq(schema.invitations.status, 'pending')),
    )
    throw new AppError('invitation_expired')
  }

  await assertInvitationEmailMatches(invitation, userEmail)

  const membershipIdCandidate = createPersistedId('membership')
  const nowMs = Date.now()
  const invitationStillPending = `
    SELECT 1
      FROM invitations
     WHERE tenant_id = ?
       AND org_id = ?
       AND id = ?
       AND token_hash = ?
       AND status = 'pending'
       AND expires_at > ?`

  // D1 batch is one transaction. Every membership mutation is guarded by the same pending
  // invitation predicate used by the final consume. A concurrent loser therefore executes zero
  // membership writes after the winner commits, instead of changing a role and only then learning
  // that the capability was already consumed.
  const updateMembership = env.DB.prepare(
    `UPDATE memberships
        SET role = ?,
            status = 'active',
            joined_at = CASE WHEN status = 'active' THEN joined_at ELSE ? END,
            updated_at = ?
      WHERE tenant_id = ?
        AND org_id = ?
        AND user_id = ?
        AND EXISTS (${invitationStillPending})`,
  ).bind(
    invitation.role,
    nowMs,
    nowMs,
    tenantId,
    invitation.orgId,
    userId,
    tenantId,
    invitation.orgId,
    invitation.id,
    invitation.tokenHash,
    nowMs,
  )
  const insertMembership = env.DB.prepare(
    `INSERT INTO memberships (
       id, tenant_id, org_id, user_id, role, membership_type, status, is_managed,
       invited_by_user_id, joined_at, created_at, updated_at
     )
     SELECT ?, ?, ?, ?, ?, 'member', 'active', 0, ?, ?, ?, ?
      WHERE EXISTS (${invitationStillPending})
        AND NOT EXISTS (
          SELECT 1
            FROM memberships
           WHERE tenant_id = ? AND org_id = ? AND user_id = ?
        )`,
  ).bind(
    membershipIdCandidate,
    tenantId,
    invitation.orgId,
    userId,
    invitation.role,
    invitation.invitedByUserId,
    nowMs,
    nowMs,
    nowMs,
    tenantId,
    invitation.orgId,
    invitation.id,
    invitation.tokenHash,
    nowMs,
    tenantId,
    invitation.orgId,
    userId,
  )
  const consumeInvitation = env.DB.prepare(
    `UPDATE invitations
        SET status = 'accepted',
            accepted_by_user_id = ?,
            used_count = used_count + 1,
            updated_at = ?
      WHERE tenant_id = ?
        AND org_id = ?
        AND id = ?
        AND token_hash = ?
        AND status = 'pending'
        AND expires_at > ?
        AND EXISTS (
          SELECT 1
            FROM memberships
           WHERE tenant_id = ?
             AND org_id = ?
             AND user_id = ?
             AND role = ?
             AND status = 'active'
        )`,
  ).bind(
    userId,
    nowMs,
    tenantId,
    invitation.orgId,
    invitation.id,
    invitation.tokenHash,
    nowMs,
    tenantId,
    invitation.orgId,
    userId,
    invitation.role,
  )

  const results = await env.DB.batch([updateMembership, insertMembership, consumeInvitation])
  if (Number(results[2]?.meta?.changes ?? 0) !== 1) {
    throw new AppError('invitation_invalid')
  }

  const orgDb = db.forOrg(invitation.orgId)
  const membership = await orgDb.memberships.findOne(eq(schema.memberships.userId, userId))
  if (!membership || membership.status !== 'active' || membership.role !== invitation.role) {
    throw new AppError('server_error')
  }
  if (Number(results[1]?.meta?.changes ?? 0) === 1) {
    emitWebhookAsync(env, {
      tenantId,
      event: 'organizationMembership.created',
      payload: { orgId: invitation.orgId, userId },
    })
  }

  emitWebhookAsync(env, {
    tenantId,
    event: 'organizationInvitation.accepted',
    payload: { orgId: invitation.orgId, invitationId: invitation.id, userId },
  })

  return { orgId: invitation.orgId, membershipId: membership.id, role: invitation.role }
}

export async function acceptInvitationByToken(opts: {
  db: ReturnType<typeof createTenantDb>
  env: Env
  tenantId: string
  rawToken: string
  userId: string
  userEmail: VerifiedInvitationEmail | null
}): Promise<AcceptInvitationResult> {
  const invitation = await findInvitationByRawToken(opts.db, opts.rawToken)
  if (!invitation) throw new AppError('invitation_invalid')
  return acceptInvitation({ ...opts, invitation })
}

export async function acceptInvitationById(opts: {
  db: ReturnType<typeof createTenantDb>
  env: Env
  tenantId: string
  invitationId: string
  userId: string
  userEmail: VerifiedInvitationEmail | null
}): Promise<AcceptInvitationResult> {
  const invitation = await findInvitationById(opts.db, opts.invitationId)
  if (!invitation) throw new AppError('invitation_invalid')
  return acceptInvitation({ ...opts, invitation })
}

export function invitationAcceptContinuePath(orgId: string, orgName: string): string {
  const params = new URLSearchParams({ orgId, orgName })
  return `/console/org?${params.toString()}`
}

export async function requirePendingInvitationByToken(
  db: ReturnType<typeof createTenantDb>,
  rawToken: string,
): Promise<typeof schema.invitations.$inferSelect> {
  const invitation = await findInvitationByRawToken(db, rawToken.trim())
  return requirePendingInvitation(invitation)
}

function requirePendingInvitation(
  invitation: typeof schema.invitations.$inferSelect | null,
): typeof schema.invitations.$inferSelect {
  if (!invitation || invitation.status !== 'pending') {
    throw new AppError('invitation_invalid')
  }
  if (invitation.expiresAt.getTime() <= Date.now()) {
    throw new AppError('invitation_expired')
  }
  return invitation
}

export async function requirePendingInvitationById(
  db: ReturnType<typeof createTenantDb>,
  invitationId: string,
): Promise<typeof schema.invitations.$inferSelect> {
  return requirePendingInvitation(await findInvitationById(db, invitationId))
}

export async function requirePendingInvitationForEmail(
  db: ReturnType<typeof createTenantDb>,
  rawToken: string,
  email: string,
): Promise<typeof schema.invitations.$inferSelect> {
  const invitation = await requirePendingInvitationByToken(db, rawToken)
  assertInvitationTargetEmailMatches(invitation, email)
  return invitation
}

export async function requirePendingInvitationByIdForEmail(
  db: ReturnType<typeof createTenantDb>,
  invitationId: string,
  email: string,
): Promise<typeof schema.invitations.$inferSelect> {
  const invitation = await requirePendingInvitationById(db, invitationId)
  assertInvitationTargetEmailMatches(invitation, email)
  return invitation
}
