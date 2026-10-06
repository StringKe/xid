// Invitation Email claim shared state: the claim row shape, the guards every conditional statement
// binds, and the target-Tenant resolution used by both the claim and the signed-in acceptance.

import { createTenantDb, resolveTenantContextByIdInInstance, schema } from '@xid-kit/db'
import { and, eq, isNull } from 'drizzle-orm'
import type { Context } from 'hono'
import { constantTimeEqualStr } from '../auth/otp'
import { AppError } from '../lib/errors'
import { logWorkerError } from '../lib/safe-log'
import {
  ACTIVE_SESSION_STATUS,
  PENDING_MFA_SESSION_STATUS,
  PENDING_MFA_SETUP_SESSION_STATUS,
} from '../lib/session'
import type { TenantVar, XidHonoEnv } from '../lib/types'

export const CLAIM_PROOF = 'invitation_email_claim_v1'
export const CLAIM_USER_ORIGIN = 'invitation_email_claim'
const CLAIM_VERIFIED_STATUS = 'claim_verified'
export const CLAIM_SESSION_STATUSES = [
  ACTIVE_SESSION_STATUS,
  PENDING_MFA_SESSION_STATUS,
  PENDING_MFA_SETUP_SESSION_STATUS,
] as const

export type InvitationRow = typeof schema.invitations.$inferSelect

export type ClaimState = {
  invitation: InvitationRow
  tokenHash: string
  consumptionId: string
  recoveryHash: string
  userId: string
  createdForClaim: boolean
}

export function normalizedInvitationEmail(invitation: InvitationRow): string {
  const email = invitation.email.trim().toLowerCase()
  if (!email || email !== invitation.email) throw new AppError('invitation_invalid')
  return email
}

export function isClaimStatus(status: string): boolean {
  return status === CLAIM_VERIFIED_STATUS || status === 'accepted'
}

export function hashesEqual(left: string | null, right: string): boolean {
  return left !== null && constantTimeEqualStr(left, right)
}

export async function requireActiveClaimOrganization(
  db: ReturnType<typeof createTenantDb>,
  orgId: string,
): Promise<typeof schema.organizations.$inferSelect> {
  const org = await db.organizations.findOne(
    and(
      eq(schema.organizations.id, orgId),
      eq(schema.organizations.status, 'active'),
      isNull(schema.organizations.deletedAt),
    ),
  )
  if (!org) throw new AppError('invitation_invalid')
  return org
}

export async function resolveClaimTargetTenant(
  c: Context<XidHonoEnv>,
  sourceTenant: TenantVar,
  orgId: string,
): Promise<TenantVar> {
  if (!sourceTenant.instanceId) throw new AppError('invitation_invalid')
  const resolved = await resolveTenantContextByIdInInstance(
    c.req.raw,
    c.env,
    orgId,
    sourceTenant.instanceId,
  )
  if (
    !resolved.ok ||
    resolved.value.status !== 'resolved' ||
    resolved.value.tenant.tenantId !== sourceTenant.tenantId ||
    resolved.value.tenant.instanceId !== sourceTenant.instanceId
  ) {
    throw new AppError('invitation_invalid')
  }
  return resolved.value.tenant
}

export function claimGuardSql(
  status: 'claim_verified' | 'claim_or_accepted' = 'claim_verified',
): string {
  const statusPredicate =
    status === 'claim_verified'
      ? `proof.status = 'claim_verified'`
      : `proof.status IN ('claim_verified', 'accepted')`
  return `EXISTS (
    SELECT 1
      FROM invitations AS proof
     WHERE proof.tenant_id = ?
       AND proof.org_id = ?
       AND proof.id = ?
       AND proof.email = ?
       AND proof.email_claim_token_hash = ?
       AND proof.email_claim_consumption_id = ?
       AND proof.email_claim_email_hash = ?
       AND proof.email_claim_recovery_hash = ?
       AND proof.email_claim_user_id = ?
       AND ${statusPredicate}
  )`
}

export function claimGuardBindings(state: ClaimState, tenantId: string): unknown[] {
  return [
    tenantId,
    state.invitation.orgId,
    state.invitation.id,
    state.invitation.email,
    state.tokenHash,
    state.consumptionId,
    state.invitation.emailClaimEmailHash,
    state.recoveryHash,
    state.userId,
  ]
}

export function claimWinnerGuardSql(): string {
  return `EXISTS (
    SELECT 1
      FROM invitations AS proof
     WHERE proof.tenant_id = ?
       AND proof.org_id = ?
       AND proof.id = ?
       AND proof.email = ?
       AND proof.email_claim_token_hash = ?
       AND proof.email_claim_consumption_id = ?
       AND proof.email_claim_email_hash = ?
       AND proof.email_claim_recovery_hash = ?
       AND proof.status = 'claim_verified'
  )`
}

export function claimWinnerGuardBindings(state: ClaimState, tenantId: string): unknown[] {
  return [
    tenantId,
    state.invitation.orgId,
    state.invitation.id,
    state.invitation.email,
    state.tokenHash,
    state.consumptionId,
    state.invitation.emailClaimEmailHash,
    state.recoveryHash,
  ]
}

export function emitInvitationClaimAudit(
  c: Context<XidHonoEnv>,
  input: {
    action: 'invitation.email_claim_verified' | 'invitation.accepted'
    tenantId: string
    invitationId: string
    orgId: string
    userId: string
  },
): void {
  const task = c.env.AUDIT_QUEUE.send({
    tenantId: input.tenantId,
    action: input.action,
    actorId: input.userId,
    ts: Date.now(),
    payload: {
      invitationId: input.invitationId,
      orgId: input.orgId,
      targetType: 'invitation',
      targetId: input.invitationId,
    },
  })
  try {
    c.executionCtx.waitUntil(task)
  } catch {
    void task.catch((error: unknown) =>
      logWorkerError('invitation_claim.audit_queue.send_failed', error, {
        component: 'invitation-claim',
        queue: 'audit',
      }),
    )
  }
}
