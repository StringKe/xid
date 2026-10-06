// Invitation Email claim, step four: one winner freezes finalization and, in a single D1 batch,
// creates or reactivates the Membership, activates the Organization on the session, and commits
// claim_verified -> accepted. Accepted retries only repair the session's active Organization.

import { createTenantDb, schema } from '@xid-kit/db'
import { and, eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import type { SessionData, TenantVar, XidHonoEnv } from '../lib/types'
import { CLAIM_SESSION_STATUSES, type ClaimState } from './invitation-claim-state'

export type ClaimFinalization = {
  invitationAccepted: boolean
  membershipCreated: boolean
  membershipReactivated: boolean
}

async function repairAcceptedClaim(opts: {
  c: Context<XidHonoEnv>
  tenant: TenantVar
  state: ClaimState
  session: SessionData
}): Promise<ClaimFinalization> {
  const { c, tenant, state, session } = opts
  const invitation = state.invitation
  const db = createTenantDb(c.env.DB, tenant)
  const [membership, persistedSession] = await Promise.all([
    db
      .forOrg(invitation.orgId)
      .memberships.findOne(
        and(eq(schema.memberships.userId, state.userId), eq(schema.memberships.status, 'active')),
      ),
    db.sessions.findOne(
      and(eq(schema.sessions.id, session.sessionId), eq(schema.sessions.userId, state.userId)),
    ),
  ])
  if (
    !membership ||
    invitation.acceptedByUserId !== state.userId ||
    !persistedSession ||
    !CLAIM_SESSION_STATUSES.includes(
      persistedSession.status as (typeof CLAIM_SESSION_STATUSES)[number],
    )
  ) {
    throw new AppError('token_invalid')
  }
  const activated = await db.sessions.update(
    { activeOrgId: invitation.orgId },
    and(eq(schema.sessions.id, session.sessionId), eq(schema.sessions.userId, state.userId)),
  )
  if (activated.length !== 1) {
    throw new AppError('token_invalid')
  }
  return {
    invitationAccepted: false,
    membershipCreated: false,
    membershipReactivated: false,
  }
}

export async function finalizeClaimAcceptance(opts: {
  c: Context<XidHonoEnv>
  tenant: TenantVar
  state: ClaimState
  session: SessionData
}): Promise<ClaimFinalization> {
  const { c, tenant, state, session } = opts
  const invitation = state.invitation
  if (invitation.status === 'accepted') return repairAcceptedClaim(opts)

  const nowMs = Date.now()
  const membershipId = createPersistedId('membership')
  const finalizationId = crypto.randomUUID()
  const finalizationGuardSql = `EXISTS (
    SELECT 1
      FROM invitations AS finalizing
     WHERE finalizing.tenant_id = ?
       AND finalizing.id = ?
       AND finalizing.email_claim_finalization_id = ?
       AND finalizing.status = 'claim_verified'
  )`
  const finalizationBindings = [tenant.tenantId, invitation.id, finalizationId]
  const freezeFinalization = c.env.DB.prepare(
    `UPDATE invitations
        SET email_claim_finalization_id = ?,
            updated_at = ?
      WHERE tenant_id = ?
        AND org_id = ?
        AND id = ?
        AND email_claim_token_hash = ?
        AND email_claim_consumption_id = ?
        AND email_claim_recovery_hash = ?
        AND email_claim_user_id = ?
        AND email_claim_session_id = ?
        AND email_claim_finalization_id IS NULL
        AND status = 'claim_verified'
        AND expires_at > ?
        AND EXISTS (
          SELECT 1 FROM organizations
           WHERE tenant_id = ?
             AND id = ?
             AND status = 'active'
             AND deleted_at IS NULL
        )
        AND EXISTS (
          SELECT 1 FROM sessions
           WHERE tenant_id = ?
             AND id = ?
             AND user_id = ?
             AND status IN ('active', 'pending_mfa', 'pending_mfa_setup')
             AND expires_at > ?
        )`,
  ).bind(
    finalizationId,
    nowMs,
    tenant.tenantId,
    invitation.orgId,
    invitation.id,
    state.tokenHash,
    state.consumptionId,
    state.recoveryHash,
    state.userId,
    session.sessionId,
    nowMs,
    tenant.tenantId,
    invitation.orgId,
    tenant.tenantId,
    session.sessionId,
    state.userId,
    nowMs,
  )
  const updateInactive = c.env.DB.prepare(
    `UPDATE memberships
        SET role = (
              SELECT role FROM invitations
               WHERE tenant_id = ?
                 AND id = ?
                 AND email_claim_finalization_id = ?
                 AND status = 'claim_verified'
            ),
            status = 'active',
            joined_at = ?,
            updated_at = ?
      WHERE tenant_id = ?
        AND org_id = ?
        AND user_id = ?
        AND status <> 'active'
        AND ${finalizationGuardSql}`,
  ).bind(
    tenant.tenantId,
    invitation.id,
    finalizationId,
    nowMs,
    nowMs,
    tenant.tenantId,
    invitation.orgId,
    state.userId,
    ...finalizationBindings,
  )
  const insertMembership = c.env.DB.prepare(
    `INSERT INTO memberships (
       id, tenant_id, org_id, user_id, role, membership_type, status,
       is_managed, invited_by_user_id, joined_at, created_at, updated_at
     )
     SELECT ?, invited.tenant_id, invited.org_id, ?, invited.role,
            'member', 'active', 0, invited.invited_by_user_id, ?, ?, ?
       FROM invitations AS invited
      WHERE invited.tenant_id = ?
        AND invited.org_id = ?
        AND invited.id = ?
        AND invited.status = 'claim_verified'
        AND invited.email_claim_finalization_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM memberships
           WHERE tenant_id = invited.tenant_id
             AND org_id = invited.org_id
             AND user_id = ?
        )`,
  ).bind(
    membershipId,
    state.userId,
    nowMs,
    nowMs,
    nowMs,
    tenant.tenantId,
    invitation.orgId,
    invitation.id,
    finalizationId,
    state.userId,
  )
  const activateSession = c.env.DB.prepare(
    `UPDATE sessions
        SET active_org_id = ?
      WHERE tenant_id = ?
        AND id = ?
        AND user_id = ?
        AND status IN ('active', 'pending_mfa', 'pending_mfa_setup')
        AND ${finalizationGuardSql}`,
  ).bind(
    invitation.orgId,
    tenant.tenantId,
    session.sessionId,
    state.userId,
    ...finalizationBindings,
  )
  const acceptInvitation = c.env.DB.prepare(
    `UPDATE invitations
        SET status = 'accepted',
            accepted_by_user_id = ?,
            used_count = used_count + 1,
            updated_at = ?
      WHERE tenant_id = ?
        AND org_id = ?
        AND id = ?
        AND email_claim_finalization_id = ?
        AND status = 'claim_verified'
        AND expires_at > ?
        AND EXISTS (
          SELECT 1 FROM memberships
           WHERE tenant_id = ?
             AND org_id = ?
             AND user_id = ?
             AND status = 'active'
        )
        AND EXISTS (
          SELECT 1 FROM sessions
           WHERE tenant_id = ?
             AND id = ?
             AND user_id = ?
             AND status IN ('active', 'pending_mfa', 'pending_mfa_setup')
        )`,
  ).bind(
    state.userId,
    nowMs,
    tenant.tenantId,
    invitation.orgId,
    invitation.id,
    finalizationId,
    nowMs,
    tenant.tenantId,
    invitation.orgId,
    state.userId,
    tenant.tenantId,
    session.sessionId,
    state.userId,
  )
  // If a frozen winner somehow fails to accept, this deliberately collides with the invitation PK.
  // D1 rolls the entire batch back instead of committing a Membership or activeOrg partial write.
  const rollbackGuard = c.env.DB.prepare(
    `INSERT INTO invitations (id)
     SELECT id
       FROM invitations
      WHERE tenant_id = ?
        AND id = ?
        AND email_claim_finalization_id = ?
        AND status <> 'accepted'`,
  ).bind(tenant.tenantId, invitation.id, finalizationId)
  let results: D1Result[]
  try {
    results = await c.env.DB.batch([
      freezeFinalization,
      updateInactive,
      insertMembership,
      activateSession,
      acceptInvitation,
      rollbackGuard,
    ])
  } catch (error) {
    throw new AppError('server_error', { cause: error })
  }
  const invitationAccepted = Number(results[4]?.meta?.changes ?? 0) === 1
  if (!invitationAccepted) {
    const refreshed = await createTenantDb(c.env.DB, tenant).invitations.findOne(
      eq(schema.invitations.id, invitation.id),
    )
    if (
      !refreshed ||
      refreshed.status !== 'accepted' ||
      refreshed.acceptedByUserId !== state.userId
    ) {
      throw new AppError('token_invalid')
    }
  }
  return {
    invitationAccepted,
    membershipReactivated: invitationAccepted && Number(results[1]?.meta?.changes ?? 0) === 1,
    membershipCreated: invitationAccepted && Number(results[2]?.meta?.changes ?? 0) === 1,
  }
}
