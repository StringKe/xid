// 组织邀请:raw token 预览;已登录且已验证邮箱与邀请一致的现有账号直接接受,不经邮件认领另建账号。

import { createTenantDb, schema } from '@xid-kit/db'
import { defaultLandingPathFor } from '@xid-kit/types'
import { and, eq, isNull } from 'drizzle-orm'
import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import { readSessionForTenant } from '../lib/session'
import type { XidHonoEnv } from '../lib/types'
import {
  acceptInvitation,
  findInvitationByRawToken,
  invitationAcceptContinuePath,
  loadInvitationPreview,
  resolveInvitationTenant,
  type VerifiedInvitationEmail,
} from '../auth/invitations'
import { readJsonBody, validateBody, validateQuery } from '../lib/validate'
import { assertEmailAllowed } from '../auth/hosted-policy'
import {
  emitInvitationClaimAudit,
  requireActiveClaimOrganization,
  resolveClaimTargetTenant,
} from './invitation-claim-state'

const previewQuerySchema = v.object({
  token: v.optional(v.string()),
})

const acceptBodySchema = v.object({
  token: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
})

function invalidPreview(): {
  status: 'invalid'
  email: null
  orgId: null
  orgName: null
  role: null
  expiresAt: null
} {
  return {
    status: 'invalid',
    email: null,
    orgId: null,
    orgName: null,
    role: null,
    expiresAt: null,
  }
}

export async function handleInvitationPreview(c: Context<XidHonoEnv>): Promise<Response> {
  const query = validateQuery(previewQuerySchema, {
    token: c.req.query('token'),
  })
  const rawToken = query.token ?? ''
  const tenant = await resolveInvitationTenant(c, rawToken)
  if (!tenant) return c.json(invalidPreview())
  const db = createTenantDb(c.env.DB, tenant)
  const preview = await loadInvitationPreview(db, rawToken)
  return c.json(preview)
}

// 账号任一已验证邮箱与邀请邮箱一致即可接受;认领流程对同样的已验证邮箱拒绝另建账号,两边口径一致。
async function loadVerifiedInvitationEmail(
  db: ReturnType<typeof createTenantDb>,
  userId: string,
  invitationEmail: string,
): Promise<VerifiedInvitationEmail | null> {
  const row = await db.userEmails.findOne(
    and(
      eq(schema.userEmails.userId, userId),
      eq(schema.userEmails.email, invitationEmail.trim().toLowerCase()),
    ),
  )
  if (!row || row.verified !== true || row.verificationStatus !== 'verified') return null
  return { email: row.email, verified: true, verificationStatus: 'verified' }
}

// POST /auth/invitation/accept { token }
export async function handleInvitationAccept(c: Context<XidHonoEnv>): Promise<Response> {
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('invitation_invalid')
  const body = validateBody(acceptBodySchema, json.value)
  const tenant = await resolveInvitationTenant(c, body.token)
  if (!tenant) throw new AppError('invitation_invalid')

  const session = await readSessionForTenant(c, tenant)
  if (!session) throw new AppError('unauthorized', { httpStatus: 401 })
  if (session.isImpersonation) throw new AppError('forbidden', { httpStatus: 403 })

  const db = createTenantDb(c.env.DB, tenant)
  const [invitation, user] = await Promise.all([
    findInvitationByRawToken(db, body.token),
    db.users.findOne(
      and(
        eq(schema.users.id, session.userId),
        eq(schema.users.status, 'active'),
        isNull(schema.users.deletedAt),
      ),
    ),
  ])
  if (!invitation) throw new AppError('invitation_invalid')
  if (!user) throw new AppError('unauthorized', { httpStatus: 401 })
  assertEmailAllowed(await resolveClaimTargetTenant(c, tenant, invitation.orgId), invitation.email)
  const org = await requireActiveClaimOrganization(db, invitation.orgId)

  const accepted = await acceptInvitation({
    db,
    env: c.env,
    tenantId: tenant.tenantId,
    invitation,
    userId: user.id,
    userEmail: await loadVerifiedInvitationEmail(db, user.id, invitation.email),
  })
  await db.sessions.update(
    { activeOrgId: accepted.orgId },
    and(eq(schema.sessions.id, session.sessionId), eq(schema.sessions.userId, user.id)),
  )
  emitInvitationClaimAudit(c, {
    action: 'invitation.accepted',
    tenantId: tenant.tenantId,
    invitationId: invitation.id,
    orgId: accepted.orgId,
    userId: user.id,
  })

  return c.json({
    redirectUrl: invitationAcceptContinuePath({
      orgId: accepted.orgId,
      orgName: org.name ?? org.slug,
      role: accepted.role,
      defaultLandingPath: defaultLandingPathFor(c.get('tenant')),
    }),
  })
}
