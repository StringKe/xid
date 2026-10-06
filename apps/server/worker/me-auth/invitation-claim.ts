// Invitation proof-first state machine:
// pending -> claim_verified -> accepted.
//
// The first transition atomically proves the exact Email, freezes any displaced Email association,
// and either reuses an identity with claim-bound provenance or creates a credential-free user.
// Session issuance and Membership acceptance are recoverable later transitions so a failed DO call
// or lost HTTP response never strands an accepted invitation without a usable browser session.
// Steps live in invitation-claim-{start,proof,session,finalize}.ts; this module owns the routes.

import { sha256Hex } from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import { defaultLandingPathFor } from '@xid-kit/types'
import { eq } from 'drizzle-orm'
import type { Context } from 'hono'
import * as v from 'valibot'
import {
  assertEmailAllowed,
  assertMethodAllowed,
  isHostedAuthPolicyError,
} from '../auth/hosted-policy'
import { invitationAcceptContinuePath } from '../auth/invitations'
import { emitWebhookAsync } from '../v1/shared'
import { AppError, isAppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { readJsonBody, validateBody } from '../lib/validate'
import { requestIp, verifyTurnstile } from './shared'
import { resolveTokenTenant } from './token-tenant'
import { verifyInvitationEmailClaimJwt } from './invitation-claim-token'
import { finalizeClaimAcceptance } from './invitation-claim-finalize'
import { consumeOrRecoverClaimProof } from './invitation-claim-proof'
import { issueRecoverableClaimSession } from './invitation-claim-session'
import { startInvitationEmailClaim } from './invitation-claim-start'
import { emitInvitationClaimAudit, resolveClaimTargetTenant } from './invitation-claim-state'

const claimStartBodySchema = v.object({
  token: v.string(),
  turnstileToken: v.optional(v.nullable(v.string())),
})

const claimVerifyBodySchema = v.object({
  token: v.string(),
  recoveryKey: v.pipe(v.string(), v.minLength(32), v.maxLength(256)),
})

async function verifyAndConsumeInvitationEmailClaim(opts: {
  c: Context<XidHonoEnv>
  rawClaimToken: string
  recoveryKey: string
}): Promise<{ redirectUrl: string }> {
  const rawToken = opts.rawClaimToken.trim()
  if (!rawToken) throw new AppError('token_invalid')
  const tokenTenant = await resolveTokenTenant(opts.c, rawToken, 'token_invalid')
  const signed = await verifyInvitationEmailClaimJwt(tokenTenant, rawToken)
  const tokenHash = await sha256Hex(signed.jti)
  const recoveryHash = await sha256Hex(opts.recoveryKey)
  const db = createTenantDb(opts.c.env.DB, tokenTenant)
  const invitation =
    (await db.invitations.findOne(eq(schema.invitations.id, signed.invitationId))) ?? null
  if (!invitation) throw new AppError('token_invalid')
  const tenant = await resolveClaimTargetTenant(opts.c, tokenTenant, invitation.orgId)
  assertEmailAllowed(tenant, invitation.email)
  assertMethodAllowed(
    tenant,
    'magicLink',
    invitation.status === 'accepted' ? 'login' : 'user_creation',
  )

  const consumed = await consumeOrRecoverClaimProof({
    env: opts.c.env,
    tenant: tokenTenant,
    invitation,
    tokenHash,
    emailHash: signed.emailHash,
    recoveryHash,
  })
  const { state } = consumed
  // The first read can race with another verifier finalizing the invitation. Re-check the action
  // from the claim state loaded after staging/recovery before issuing any login session.
  assertMethodAllowed(
    tenant,
    'magicLink',
    state.invitation.status === 'accepted' ? 'login' : 'user_creation',
  )
  if (consumed.proofConsumed) {
    emitInvitationClaimAudit(opts.c, {
      action: 'invitation.email_claim_verified',
      tenantId: tenant.tenantId,
      invitationId: state.invitation.id,
      orgId: state.invitation.orgId,
      userId: state.userId,
    })
  }
  const org = await db.organizations.findOne(eq(schema.organizations.id, state.invitation.orgId))
  const redirectPath = invitationAcceptContinuePath({
    orgId: state.invitation.orgId,
    orgName: org?.name ?? org?.slug ?? state.invitation.orgId,
    role: state.invitation.role,
    defaultLandingPath: defaultLandingPathFor(opts.c.get('tenant')),
  })
  const issued = await issueRecoverableClaimSession({
    c: opts.c,
    tenant,
    state,
    redirectPath,
  })
  const finalized = await finalizeClaimAcceptance({
    c: opts.c,
    tenant,
    state,
    session: issued.session,
  })

  if (finalized.membershipCreated) {
    emitWebhookAsync(opts.c, {
      tenantId: tenant.tenantId,
      event: 'organizationMembership.created',
      payload: { orgId: state.invitation.orgId, userId: state.userId },
    })
  }
  if (finalized.membershipReactivated) {
    emitWebhookAsync(opts.c, {
      tenantId: tenant.tenantId,
      event: 'organizationMembership.updated',
      payload: {
        orgId: state.invitation.orgId,
        userId: state.userId,
        status: 'active',
      },
    })
  }
  if (finalized.invitationAccepted) {
    emitInvitationClaimAudit(opts.c, {
      action: 'invitation.accepted',
      tenantId: tenant.tenantId,
      invitationId: state.invitation.id,
      orgId: state.invitation.orgId,
      userId: state.userId,
    })
    emitWebhookAsync(opts.c, {
      tenantId: tenant.tenantId,
      event: 'organizationInvitation.accepted',
      payload: {
        orgId: state.invitation.orgId,
        invitationId: state.invitation.id,
        userId: state.userId,
      },
    })
  }
  return { redirectUrl: issued.redirectUrl }
}

export async function handleInvitationClaimStart(c: Context<XidHonoEnv>): Promise<Response> {
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('invalid_request')
  const body = validateBody(claimStartBodySchema, json.value)
  await verifyTurnstile(body.turnstileToken, c.env, requestIp(c))
  try {
    await startInvitationEmailClaim({ c, rawInvitationToken: body.token })
  } catch (error) {
    if (
      isAppError(error) &&
      (error.code === 'invitation_invalid' || error.code === 'invitation_expired')
    ) {
      return c.json({ ok: true })
    }
    if (isHostedAuthPolicyError(error)) return c.json({ ok: true })
    throw error
  }
  return c.json({ ok: true })
}

export async function handleInvitationClaimVerify(c: Context<XidHonoEnv>): Promise<Response> {
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('token_invalid')
  const body = validateBody(claimVerifyBodySchema, json.value)
  return c.json(
    await verifyAndConsumeInvitationEmailClaim({
      c,
      rawClaimToken: body.token,
      recoveryKey: body.recoveryKey,
    }),
  )
}
