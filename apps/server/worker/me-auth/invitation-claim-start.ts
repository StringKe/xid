// Invitation Email claim, step one: rotate the one-time claim proof and email it to the invited
// address. Nothing about a User, session, or Membership is selected or written here.

import { sha256Hex } from '@xid-kit/crypto'
import { createTenantDb } from '@xid-kit/db'
import type { Context } from 'hono'
import {
  assertEmailAllowed,
  assertMethodAllowed,
  isHostedAuthPolicyError,
} from '../auth/hosted-policy'
import { recordHostedAuthPolicyDenied } from '../auth/hosted-audit'
import { requirePendingInvitationByToken, resolveInvitationTenant } from '../auth/invitations'
import { AppError } from '../lib/errors'
import { enqueueTransactionalEmail } from '../lib/transactional-email'
import type { TenantVar, XidHonoEnv } from '../lib/types'
import { signInvitationEmailClaim } from './invitation-claim-token'
import {
  normalizedInvitationEmail,
  requireActiveClaimOrganization,
  resolveClaimTargetTenant,
  type InvitationRow,
} from './invitation-claim-state'
import { enforceSendRateLimit } from './shared'

async function persistAndSendInvitationEmailClaim(opts: {
  env: Env
  tenant: TenantVar
  invitation: InvitationRow
  locale: string
}): Promise<void> {
  const { env, tenant, invitation } = opts
  const email = normalizedInvitationEmail(invitation)
  const signed = await signInvitationEmailClaim({
    env,
    tenant,
    invitationId: invitation.id,
    normalizedEmail: email,
  })
  const nowMs = Date.now()
  const rotated = await env.DB.prepare(
    `UPDATE invitations
        SET email_claim_token_hash = ?,
            email_claim_email_hash = ?,
            email_claim_expires_at = ?,
            email_claim_consumed_at = NULL,
            email_claim_consumption_id = NULL,
            email_claim_user_id = NULL,
            email_claim_recovery_hash = NULL,
            email_claim_session_id = NULL,
            email_claim_session_reserved_at = NULL,
            email_claim_finalization_id = NULL,
            displaced_user_id = NULL,
            displaced_email_id = NULL,
            updated_at = ?
      WHERE tenant_id = ?
        AND org_id = ?
        AND id = ?
        AND token_hash = ?
        AND email = ?
        AND status = 'pending'
        AND expires_at > ?`,
  )
    .bind(
      signed.tokenHash,
      signed.emailHash,
      signed.expiresAt.getTime(),
      nowMs,
      tenant.tenantId,
      invitation.orgId,
      invitation.id,
      invitation.tokenHash,
      invitation.email,
      nowMs,
    )
    .run()
  if (Number(rotated.meta.changes ?? 0) !== 1) throw new AppError('invitation_invalid')

  await enqueueTransactionalEmail(env, {
    type: 'verify_email',
    recipient: email,
    locale: opts.locale,
    payload: {
      tenantId: tenant.tenantId,
      invitationId: invitation.id,
      token: signed.token,
      link: signed.verifyUrl,
      expires: 15,
      expiresInMin: 15,
    },
  })
}

export async function startInvitationEmailClaim(opts: {
  c: Context<XidHonoEnv>
  rawInvitationToken: string
}): Promise<boolean> {
  const token = opts.rawInvitationToken.trim()
  if (!token) return false
  await enforceSendRateLimit(opts.c.env, 'invitation-claim-token', await sha256Hex(token))
  const tenant = await resolveInvitationTenant(opts.c, token)
  if (!tenant) return false
  const db = createTenantDb(opts.c.env.DB, tenant)
  const invitation = await requirePendingInvitationByToken(db, token)
  await requireActiveClaimOrganization(db, invitation.orgId)
  const email = normalizedInvitationEmail(invitation)
  const targetTenant = await resolveClaimTargetTenant(opts.c, tenant, invitation.orgId)
  try {
    assertEmailAllowed(targetTenant, email)
    // An Organization invitation is an explicit onboarding ceremony even when an already-proven
    // identity is reused, so it follows the target Organization's user-creation policy.
    assertMethodAllowed(targetTenant, 'magicLink', 'user_creation')
  } catch (error) {
    if (!isHostedAuthPolicyError(error)) throw error
    await recordHostedAuthPolicyDenied(opts.c, {
      tenant: targetTenant,
      method: 'magicLink',
      action: 'user_creation',
      reason: error.policyReason,
      identifier: { type: 'email', value: email },
    })
    throw error
  }
  await enforceSendRateLimit(opts.c.env, 'invitation-claim-recipient', await sha256Hex(email))
  await persistAndSendInvitationEmailClaim({
    env: opts.c.env,
    tenant,
    invitation,
    locale: opts.c.get('locale'),
  })
  return true
}
