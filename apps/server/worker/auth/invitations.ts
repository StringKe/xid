// 组织邀请:token 查找、预览、接受(写 membership + 更新 invitation 状态)。
// token 只存 SHA-256 哈希(见 password-auth rule / v1/invitations.ts)。

import { sha256Hex } from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import { and, eq, isNull } from 'drizzle-orm'
import { AppError } from '../lib/errors'
import { emitWebhookAsync } from '../v1/shared'

export type InvitationPreview = {
  status: 'pending' | 'expired' | 'invalid'
  email: string | null
  orgId: string | null
  orgName: string | null
  role: string | null
  expiresAt: string | null
}

export type AcceptInvitationResult = {
  orgId: string
  membershipId: string
  role: string
}

export async function findInvitationByRawToken(
  db: ReturnType<typeof createTenantDb>,
  rawToken: string,
): Promise<typeof schema.invitations.$inferSelect | null> {
  const tokenHash = await sha256Hex(rawToken.trim())
  const row = await db.invitations.findOne(eq(schema.invitations.tokenHash, tokenHash))
  return row ?? null
}

export async function loadInvitationPreview(
  db: ReturnType<typeof createTenantDb>,
  rawToken: string,
): Promise<InvitationPreview> {
  const invalid: InvitationPreview = {
    status: 'invalid',
    email: null,
    orgId: null,
    orgName: null,
    role: null,
    expiresAt: null,
  }
  if (!rawToken.trim()) return invalid

  const invitation = await findInvitationByRawToken(db, rawToken)
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
): Promise<string | null> {
  if (!primaryEmailId) return null
  const row = await db.userEmails.findOne(
    and(eq(schema.userEmails.id, primaryEmailId), eq(schema.userEmails.userId, userId)),
  )
  return row?.email ?? null
}

export async function assertInvitationEmailMatches(
  invitation: typeof schema.invitations.$inferSelect,
  userEmail: string | null,
): Promise<void> {
  const inviteEmail = invitation.email.trim().toLowerCase()
  const normalized = userEmail?.trim().toLowerCase() ?? ''
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
  userEmail: string | null
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

  const orgDb = db.forOrg(invitation.orgId)
  const existing = await orgDb.memberships.findOne(eq(schema.memberships.userId, userId))
  let membershipId: string

  if (existing?.status === 'active') {
    membershipId = existing.id
    if (existing.role !== invitation.role) {
      await orgDb.memberships.update(
        { role: invitation.role },
        eq(schema.memberships.id, existing.id),
      )
    }
  } else if (existing) {
    const updated = await orgDb.memberships.update(
      {
        role: invitation.role,
        status: 'active',
        joinedAt: new Date(),
      },
      eq(schema.memberships.id, existing.id),
    )
    membershipId = updated[0]?.id ?? existing.id
  } else {
    membershipId = crypto.randomUUID()
    await orgDb.memberships.insert({
      id: membershipId,
      tenantId,
      orgId: invitation.orgId,
      userId,
      role: invitation.role,
      membershipType: 'member',
      status: 'active',
      joinedAt: new Date(),
    })
    emitWebhookAsync(env, {
      tenantId,
      event: 'organizationMembership.created',
      payload: { orgId: invitation.orgId, userId },
    })
  }

  const updatedInvite = await db.invitations.update(
    {
      status: 'accepted',
      acceptedByUserId: userId,
      usedCount: invitation.usedCount + 1,
    },
    and(eq(schema.invitations.id, invitation.id), eq(schema.invitations.status, 'pending')),
  )
  if (!updatedInvite[0]) throw new AppError('invitation_invalid')

  emitWebhookAsync(env, {
    tenantId,
    event: 'organizationInvitation.accepted',
    payload: { orgId: invitation.orgId, invitationId: invitation.id, userId },
  })

  return { orgId: invitation.orgId, membershipId, role: invitation.role }
}

export async function acceptInvitationByToken(opts: {
  db: ReturnType<typeof createTenantDb>
  env: Env
  tenantId: string
  rawToken: string
  userId: string
  userEmail: string | null
}): Promise<AcceptInvitationResult> {
  const invitation = await findInvitationByRawToken(opts.db, opts.rawToken)
  if (!invitation) throw new AppError('invitation_invalid')
  return acceptInvitation({ ...opts, invitation })
}

export function invitationAcceptContinuePath(orgId: string, orgName: string): string {
  const params = new URLSearchParams({ orgId, orgName })
  return `/console/org?${params.toString()}`
}

export async function requirePendingInvitationForEmail(
  db: ReturnType<typeof createTenantDb>,
  rawToken: string,
  email: string,
): Promise<typeof schema.invitations.$inferSelect> {
  const invitation = await findInvitationByRawToken(db, rawToken.trim())
  if (!invitation || invitation.status !== 'pending') {
    throw new AppError('invitation_invalid')
  }
  if (invitation.expiresAt.getTime() <= Date.now()) {
    throw new AppError('invitation_expired')
  }
  await assertInvitationEmailMatches(invitation, email)
  return invitation
}
