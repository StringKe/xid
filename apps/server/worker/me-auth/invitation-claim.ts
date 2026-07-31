// Invitation proof-first state machine:
// pending -> claim_verified -> accepted.
//
// The first transition atomically proves the exact Email, freezes any displaced Email association,
// and either reuses an identity with claim-bound provenance or creates a credential-free user.
// Session issuance and Membership acceptance are recoverable later transitions so a failed DO call
// or lost HTTP response never strands an accepted invitation without a usable browser session.

import { sha256Hex } from '@xid-kit/crypto'
import { createTenantDb, resolveTenantContextByIdInInstance, schema } from '@xid-kit/db'
import { and, eq, isNull } from 'drizzle-orm'
import type { Context } from 'hono'
import * as v from 'valibot'
import { constantTimeEqualStr } from '../auth/otp'
import {
  assertEmailAllowed,
  assertMethodAllowed,
  isHostedAuthPolicyError,
} from '../auth/hosted-policy'
import { recordHostedAuthPolicyDenied } from '../auth/hosted-audit'
import {
  invitationAcceptContinuePath,
  requirePendingInvitationByToken,
  resolveInvitationTenant,
} from '../auth/invitations'
import { emitWebhookAsync } from '../v1/shared'
import { EMAIL_OTP_AUTH_CONTEXT } from '../lib/auth-context'
import { AppError, isAppError } from '../lib/errors'
import { resolvePostAuthMfaGate } from '../lib/mfa-session'
import { createPersistedId } from '../lib/persisted-id'
import { logWorkerError } from '../lib/safe-log'
import {
  ACTIVE_SESSION_STATUS,
  PENDING_MFA_SESSION_STATUS,
  PENDING_MFA_SETUP_SESSION_STATUS,
  issueSession,
  readSessionForTenant,
  revokeSessionByIdentity,
} from '../lib/session'
import type { SessionData, TenantVar, XidHonoEnv } from '../lib/types'
import { readJsonBody, validateBody } from '../lib/validate'
import { enforceSendRateLimit, requestIp, requestUserAgent, verifyTurnstile } from './shared'
import { resolveTokenTenant } from './token-tenant'
import { signInvitationEmailClaim, verifyInvitationEmailClaimJwt } from './invitation-claim-token'

const CLAIM_PROOF = 'invitation_email_claim_v1'
const CLAIM_USER_ORIGIN = 'invitation_email_claim'
const CLAIM_VERIFIED_STATUS = 'claim_verified'
const SESSION_RESERVATION_LEASE_MS = 30_000
const CLAIM_SESSION_STATUSES = [
  ACTIVE_SESSION_STATUS,
  PENDING_MFA_SESSION_STATUS,
  PENDING_MFA_SETUP_SESSION_STATUS,
] as const

const claimStartBodySchema = v.object({
  token: v.string(),
  turnstileToken: v.optional(v.nullable(v.string())),
})

const claimVerifyBodySchema = v.object({
  token: v.string(),
  recoveryKey: v.pipe(v.string(), v.minLength(32), v.maxLength(256)),
})

type InvitationRow = typeof schema.invitations.$inferSelect

type ClaimState = {
  invitation: InvitationRow
  tokenHash: string
  consumptionId: string
  recoveryHash: string
  userId: string
  createdForClaim: boolean
}

function normalizedInvitationEmail(invitation: InvitationRow): string {
  const email = invitation.email.trim().toLowerCase()
  if (!email || email !== invitation.email) throw new AppError('invitation_invalid')
  return email
}

function isClaimStatus(status: string): boolean {
  return status === CLAIM_VERIFIED_STATUS || status === 'accepted'
}

function hashesEqual(left: string | null, right: string): boolean {
  return left !== null && constantTimeEqualStr(left, right)
}

async function requireActiveClaimOrganization(
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

async function resolveClaimTargetTenant(
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

async function persistAndSendInvitationEmailClaim(opts: {
  env: Env
  tenant: TenantVar
  invitation: InvitationRow
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

  await env.EMAIL_QUEUE.send({
    type: 'verify_email',
    recipient: email,
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
  await persistAndSendInvitationEmailClaim({ env: opts.c.env, tenant, invitation })
  return true
}

function claimGuardSql(status: 'claim_verified' | 'claim_or_accepted' = 'claim_verified'): string {
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

function claimGuardBindings(state: ClaimState, tenantId: string): unknown[] {
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

function claimWinnerGuardSql(): string {
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

function claimWinnerGuardBindings(state: ClaimState, tenantId: string): unknown[] {
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

async function stageClaimProof(opts: {
  env: Env
  tenant: TenantVar
  invitation: InvitationRow
  tokenHash: string
  emailHash: string
  recoveryHash: string
}): Promise<{ consumptionId: string; freshUserId: string }> {
  const { env, tenant, invitation, tokenHash, emailHash, recoveryHash } = opts
  const email = normalizedInvitationEmail(invitation)
  const consumptionId = crypto.randomUUID()
  const freshUserId = createPersistedId('user')
  const freshEmailId = crypto.randomUUID()
  const nowMs = Date.now()

  const stage = env.DB.prepare(
    `WITH collision AS (
       SELECT email_row.id AS email_id, email_row.user_id AS user_id
         FROM user_emails AS email_row
        WHERE email_row.tenant_id = ? AND email_row.email = ?
        LIMIT 1
     ),
     trusted AS (
       SELECT collision.email_id AS email_id, collision.user_id AS user_id
         FROM collision
         JOIN user_emails AS proven_email ON proven_email.id = collision.email_id
         JOIN users AS proven_user ON proven_user.id = collision.user_id
         JOIN invitations AS proof_invitation
           ON proof_invitation.tenant_id = proven_email.tenant_id
          AND proof_invitation.id = proven_email.ownership_proof_ceremony_id
        WHERE proven_email.tenant_id = ?
          AND proven_email.email = ?
          AND proven_email.verified = 1
          AND proven_email.verification_status = 'verified'
          AND proven_email.verified_at IS NOT NULL
          AND proven_email.is_primary = 1
          AND proven_email.ownership_proof = 'invitation_email_claim_v1'
          AND proven_email.ownership_proof_ceremony_id IS NOT NULL
          AND proven_email.ownership_proven_at IS NOT NULL
          AND proven_user.tenant_id = proven_email.tenant_id
          AND proven_user.primary_email_id = proven_email.id
          AND proven_user.provisioned_by = 'invitation_email_claim'
          AND proven_user.status = 'active'
          AND proven_user.deleted_at IS NULL
          AND proven_user.merged_into_user_id IS NULL
          AND proof_invitation.status = 'accepted'
          AND proof_invitation.email = proven_email.email
          AND proof_invitation.email_claim_user_id = proven_user.id
          AND proof_invitation.accepted_by_user_id = proven_user.id
        LIMIT 1
     )
     UPDATE invitations
        SET email_claim_consumed_at = ?,
            email_claim_consumption_id = ?,
            email_claim_user_id = COALESCE((SELECT user_id FROM trusted), ?),
            email_claim_recovery_hash = ?,
            email_claim_finalization_id = NULL,
            displaced_user_id = CASE
              WHEN EXISTS (SELECT 1 FROM trusted) THEN NULL
              ELSE (SELECT user_id FROM collision)
            END,
            displaced_email_id = CASE
              WHEN EXISTS (SELECT 1 FROM trusted) THEN NULL
              ELSE (SELECT email_id FROM collision)
            END,
            status = 'claim_verified',
            updated_at = ?
      WHERE tenant_id = ?
        AND org_id = ?
        AND id = ?
        AND email = ?
        AND email_claim_token_hash = ?
        AND email_claim_email_hash = ?
        AND email_claim_consumed_at IS NULL
        AND email_claim_expires_at > ?
        AND status = 'pending'
        AND expires_at > ?
        AND EXISTS (
          SELECT 1 FROM organizations
           WHERE tenant_id = ?
             AND id = ?
             AND status = 'active'
             AND deleted_at IS NULL
        )`,
  ).bind(
    tenant.tenantId,
    email,
    tenant.tenantId,
    email,
    nowMs,
    consumptionId,
    freshUserId,
    recoveryHash,
    nowMs,
    tenant.tenantId,
    invitation.orgId,
    invitation.id,
    email,
    tokenHash,
    emailHash,
    nowMs,
    nowMs,
    tenant.tenantId,
    invitation.orgId,
  )

  const provisional: ClaimState = {
    invitation: {
      ...invitation,
      emailClaimTokenHash: tokenHash,
      emailClaimEmailHash: emailHash,
      emailClaimConsumptionId: consumptionId,
    },
    tokenHash,
    consumptionId,
    recoveryHash,
    userId: freshUserId,
    createdForClaim: true,
  }
  const guard = claimGuardBindings(provisional, tenant.tenantId)
  const winnerGuard = claimWinnerGuardBindings(provisional, tenant.tenantId)

  // These statements are unconditional inside the winner transaction and uniquely gated by the
  // random consumption id. Any PK/Email uniqueness conflict is a statement failure, so D1 rolls back the
  // entire batch instead of committing a consumed claim and checking meta.changes afterwards.
  const statements: D1PreparedStatement[] = [stage]
  statements.push(
    env.DB.prepare(
      `UPDATE verification_tokens
          SET consumed_at = ?
        WHERE tenant_id = ?
          AND consumed_at IS NULL
          AND user_id IN (
            SELECT id FROM users
             WHERE tenant_id = ? AND pending_email = ?
          )
          AND (
            purpose IN ('email_verification', 'magic_link')
            OR (purpose = 'otp' AND channel = 'email')
          )
          AND ${claimWinnerGuardSql()}`,
    ).bind(nowMs, tenant.tenantId, tenant.tenantId, email, ...winnerGuard),
  )
  statements.push(
    env.DB.prepare(
      `UPDATE users
          SET pending_email = NULL,
              updated_at = ?
        WHERE tenant_id = ?
          AND pending_email = ?
          AND ${claimWinnerGuardSql()}`,
    ).bind(nowMs, tenant.tenantId, email, ...winnerGuard),
  )
  statements.push(
    env.DB.prepare(
      `UPDATE verification_tokens
          SET consumed_at = ?
        WHERE tenant_id = ?
          AND consumed_at IS NULL
          AND user_id = (
            SELECT displaced_user_id FROM invitations
             WHERE tenant_id = ? AND id = ? AND email_claim_consumption_id = ?
          )
          AND (
            purpose IN ('email_verification', 'magic_link')
            OR (purpose = 'otp' AND channel = 'email')
          )
          AND ${claimGuardSql()}`,
    ).bind(nowMs, tenant.tenantId, tenant.tenantId, invitation.id, consumptionId, ...guard),
  )
  statements.push(
    env.DB.prepare(
      `UPDATE password_reset_tokens
          SET consumed_at = ?
        WHERE tenant_id = ?
          AND consumed_at IS NULL
          AND user_id = (
            SELECT displaced_user_id FROM invitations
             WHERE tenant_id = ? AND id = ? AND email_claim_consumption_id = ?
          )
          AND ${claimGuardSql()}`,
    ).bind(nowMs, tenant.tenantId, tenant.tenantId, invitation.id, consumptionId, ...guard),
  )
  statements.push(
    env.DB.prepare(
      `UPDATE users
          SET primary_email_id = CASE
                WHEN primary_email_id = (
                  SELECT displaced_email_id FROM invitations
                   WHERE tenant_id = ? AND id = ? AND email_claim_consumption_id = ?
                ) THEN NULL
                ELSE primary_email_id
              END,
              pending_email = CASE WHEN pending_email = ? THEN NULL ELSE pending_email END,
              updated_at = ?
        WHERE tenant_id = ?
          AND id = (
            SELECT displaced_user_id FROM invitations
             WHERE tenant_id = ? AND id = ? AND email_claim_consumption_id = ?
          )
          AND ${claimGuardSql()}`,
    ).bind(
      tenant.tenantId,
      invitation.id,
      consumptionId,
      email,
      nowMs,
      tenant.tenantId,
      tenant.tenantId,
      invitation.id,
      consumptionId,
      ...guard,
    ),
  )
  statements.push(
    env.DB.prepare(
      `DELETE FROM user_emails
        WHERE tenant_id = ?
          AND id = (
            SELECT displaced_email_id FROM invitations
             WHERE tenant_id = ? AND id = ? AND email_claim_consumption_id = ?
          )
          AND user_id = (
            SELECT displaced_user_id FROM invitations
             WHERE tenant_id = ? AND id = ? AND email_claim_consumption_id = ?
          )
          AND email = ?
          AND ${claimGuardSql()}`,
    ).bind(
      tenant.tenantId,
      tenant.tenantId,
      invitation.id,
      consumptionId,
      tenant.tenantId,
      invitation.id,
      consumptionId,
      email,
      ...guard,
    ),
  )
  statements.push(
    env.DB.prepare(
      `INSERT INTO users (
         id, tenant_id, primary_email_id, status, is_new_user,
         profile_completion_status, provisioned_by, created_at, updated_at
       )
       SELECT ?, ?, ?, 'active', 1, 'incomplete', 'invitation_email_claim', ?, ?
        WHERE ${claimGuardSql()}
          AND EXISTS (
            SELECT 1 FROM invitations
             WHERE tenant_id = ? AND id = ?
               AND email_claim_token_hash = ?
               AND email_claim_consumption_id = ?
               AND email_claim_user_id = ?
          )`,
    ).bind(
      freshUserId,
      tenant.tenantId,
      freshEmailId,
      nowMs,
      nowMs,
      ...guard,
      tenant.tenantId,
      invitation.id,
      tokenHash,
      consumptionId,
      freshUserId,
    ),
  )
  statements.push(
    env.DB.prepare(
      `INSERT INTO user_emails (
         id, tenant_id, user_id, email, verified, verification_status,
         is_primary, verified_at, ownership_proof, ownership_proof_ceremony_id,
         ownership_proven_at, created_at, updated_at
       )
       SELECT ?, ?, ?, ?, 1, 'verified', 1, ?,
              'invitation_email_claim_v1', ?, ?, ?, ?
        WHERE ${claimGuardSql()}
          AND EXISTS (
            SELECT 1 FROM users
             WHERE tenant_id = ? AND id = ? AND primary_email_id = ?
          )`,
    ).bind(
      freshEmailId,
      tenant.tenantId,
      freshUserId,
      email,
      nowMs,
      invitation.id,
      nowMs,
      nowMs,
      nowMs,
      ...guard,
      tenant.tenantId,
      freshUserId,
      freshEmailId,
    ),
  )

  try {
    await env.DB.batch(statements)
  } catch (error) {
    throw new AppError('token_invalid', { cause: error })
  }
  return { consumptionId, freshUserId }
}

async function loadClaimState(opts: {
  env: Env
  tenant: TenantVar
  invitationId: string
  tokenHash: string
  consumptionId: string
  recoveryHash: string
  emailHash: string
}): Promise<ClaimState> {
  const db = createTenantDb(opts.env.DB, opts.tenant)
  const invitation =
    (await db.invitations.findOne(eq(schema.invitations.id, opts.invitationId))) ?? null
  if (
    !invitation ||
    !isClaimStatus(invitation.status) ||
    !hashesEqual(invitation.emailClaimTokenHash, opts.tokenHash) ||
    !hashesEqual(invitation.emailClaimConsumptionId, opts.consumptionId) ||
    !hashesEqual(invitation.emailClaimEmailHash, opts.emailHash) ||
    !hashesEqual(invitation.emailClaimRecoveryHash, opts.recoveryHash) ||
    invitation.emailClaimConsumedAt === null ||
    !invitation.emailClaimUserId
  ) {
    throw new AppError('token_invalid')
  }
  const email = normalizedInvitationEmail(invitation)
  if (!hashesEqual(await sha256Hex(email), opts.emailHash)) {
    throw new AppError('token_invalid')
  }
  const [user, provenEmail] = await Promise.all([
    db.users.findOne(
      and(eq(schema.users.id, invitation.emailClaimUserId), eq(schema.users.status, 'active')),
    ),
    db.userEmails.findOne(eq(schema.userEmails.email, email)),
  ])
  const proofInvitation = provenEmail?.ownershipProofCeremonyId
    ? await db.invitations.findOne(eq(schema.invitations.id, provenEmail.ownershipProofCeremonyId))
    : null
  const proofMatchesCurrentClaim =
    proofInvitation?.id === invitation.id &&
    isClaimStatus(proofInvitation.status) &&
    proofInvitation.emailClaimUserId === invitation.emailClaimUserId
  const proofMatchesAcceptedClaim =
    proofInvitation?.status === 'accepted' &&
    proofInvitation.email === email &&
    proofInvitation.emailClaimUserId === invitation.emailClaimUserId &&
    proofInvitation.acceptedByUserId === invitation.emailClaimUserId
  const createdForClaim = proofInvitation?.id === invitation.id
  if (
    !user ||
    user.deletedAt !== null ||
    user.mergedIntoUserId !== null ||
    user.provisionedBy !== CLAIM_USER_ORIGIN ||
    !provenEmail ||
    provenEmail.userId !== user.id ||
    provenEmail.id !== user.primaryEmailId ||
    provenEmail.verified !== true ||
    provenEmail.verificationStatus !== 'verified' ||
    provenEmail.verifiedAt === null ||
    provenEmail.isPrimary !== true ||
    provenEmail.ownershipProof !== CLAIM_PROOF ||
    !provenEmail.ownershipProofCeremonyId ||
    provenEmail.ownershipProvenAt === null ||
    (!proofMatchesCurrentClaim && !proofMatchesAcceptedClaim)
  ) {
    throw new AppError('token_invalid')
  }
  await requireActiveClaimOrganization(db, invitation.orgId)
  return {
    invitation,
    tokenHash: opts.tokenHash,
    consumptionId: opts.consumptionId,
    recoveryHash: opts.recoveryHash,
    userId: user.id,
    createdForClaim,
  }
}

async function consumeOrRecoverClaimProof(opts: {
  env: Env
  tenant: TenantVar
  invitation: InvitationRow
  tokenHash: string
  emailHash: string
  recoveryHash: string
}): Promise<{ state: ClaimState; proofConsumed: boolean }> {
  if (isClaimStatus(opts.invitation.status) && opts.invitation.emailClaimConsumptionId !== null) {
    return {
      state: await loadClaimState({
        env: opts.env,
        tenant: opts.tenant,
        invitationId: opts.invitation.id,
        tokenHash: opts.tokenHash,
        consumptionId: opts.invitation.emailClaimConsumptionId,
        recoveryHash: opts.recoveryHash,
        emailHash: opts.emailHash,
      }),
      proofConsumed: false,
    }
  }
  if (
    opts.invitation.status !== 'pending' ||
    opts.invitation.expiresAt.getTime() <= Date.now() ||
    opts.invitation.emailClaimConsumedAt !== null ||
    opts.invitation.emailClaimExpiresAt === null ||
    opts.invitation.emailClaimExpiresAt.getTime() <= Date.now() ||
    !hashesEqual(opts.invitation.emailClaimTokenHash, opts.tokenHash) ||
    !hashesEqual(opts.invitation.emailClaimEmailHash, opts.emailHash)
  ) {
    throw new AppError('token_invalid')
  }
  const email = normalizedInvitationEmail(opts.invitation)
  if (!constantTimeEqualStr(await sha256Hex(email), opts.emailHash)) {
    throw new AppError('token_invalid')
  }

  const staged = await stageClaimProof(opts)
  return {
    state: await loadClaimState({
      env: opts.env,
      tenant: opts.tenant,
      invitationId: opts.invitation.id,
      tokenHash: opts.tokenHash,
      consumptionId: staged.consumptionId,
      recoveryHash: opts.recoveryHash,
      emailHash: opts.emailHash,
    }),
    proofConsumed: true,
  }
}

function emitInvitationClaimAudit(
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

async function matchingBrowserSession(
  c: Context<XidHonoEnv>,
  tenant: TenantVar,
  state: ClaimState,
): Promise<SessionData | null> {
  const session = await readSessionForTenant(c, tenant, CLAIM_SESSION_STATUSES)
  return session &&
    session.sessionId === state.invitation.emailClaimSessionId &&
    session.userId === state.userId
    ? session
    : null
}

async function clearFailedReservation(
  c: Context<XidHonoEnv>,
  tenant: TenantVar,
  state: ClaimState,
  sessionId: string,
): Promise<void> {
  const failures: unknown[] = []
  try {
    await revokeSessionByIdentity(c, state.userId, sessionId)
  } catch (error) {
    failures.push(error)
  }
  const db = createTenantDb(c.env.DB, tenant)
  const failedSession = await db.sessions.findOne(eq(schema.sessions.id, sessionId))
  if (failedSession && failedSession.status !== 'revoked') {
    throw new AppError('server_error', {
      cause: new AggregateError(
        failures,
        'invitation claim session remains authenticatable after cleanup',
      ),
    })
  }
  try {
    await c.env.DB.prepare(
      `UPDATE invitations
          SET email_claim_session_id = NULL,
              email_claim_session_reserved_at = NULL,
              updated_at = ?
        WHERE tenant_id = ?
          AND id = ?
          AND email_claim_token_hash = ?
          AND email_claim_consumption_id = ?
          AND email_claim_recovery_hash = ?
          AND email_claim_user_id = ?
          AND email_claim_session_id = ?
          AND status IN ('claim_verified', 'accepted')`,
    )
      .bind(
        Date.now(),
        tenant.tenantId,
        state.invitation.id,
        state.tokenHash,
        state.consumptionId,
        state.recoveryHash,
        state.userId,
        sessionId,
      )
      .run()
  } catch (error) {
    failures.push(error)
  }
  if (failures.length > 0) {
    throw new AppError('server_error', {
      cause: new AggregateError(failures, 'failed to clear invitation claim session reservation'),
    })
  }
}

async function issueRecoverableClaimSession(opts: {
  c: Context<XidHonoEnv>
  tenant: TenantVar
  state: ClaimState
  redirectPath: string
}): Promise<{ session: SessionData; redirectUrl: string }> {
  const { c, tenant, state, redirectPath } = opts
  c.set('tenant', tenant)
  const current = await matchingBrowserSession(c, tenant, state)
  const mfaGate = await resolvePostAuthMfaGate(c, tenant, {
    userId: state.userId,
    returnPath: redirectPath,
    sessionAmr: EMAIL_OTP_AUTH_CONTEXT.amr,
  })
  if (current) {
    return { session: current, redirectUrl: mfaGate.redirectUrl ?? redirectPath }
  }

  const previousSessionId = state.invitation.emailClaimSessionId
  const reservedAt = state.invitation.emailClaimSessionReservedAt?.getTime() ?? null
  if (
    previousSessionId &&
    reservedAt !== null &&
    Date.now() - reservedAt < SESSION_RESERVATION_LEASE_MS
  ) {
    throw new AppError('token_invalid')
  }
  if (previousSessionId) {
    await revokeSessionByIdentity(c, state.userId, previousSessionId)
  }

  const sessionId = createPersistedId('session')
  const nowMs = Date.now()
  const reservation = await c.env.DB.prepare(
    `UPDATE invitations
        SET email_claim_session_id = ?,
            email_claim_session_reserved_at = ?,
            updated_at = ?
      WHERE tenant_id = ?
        AND id = ?
        AND email_claim_token_hash = ?
        AND email_claim_consumption_id = ?
        AND email_claim_recovery_hash = ?
        AND email_claim_user_id = ?
        AND status IN ('claim_verified', 'accepted')
        AND ${previousSessionId ? 'email_claim_session_id = ?' : 'email_claim_session_id IS NULL'}`,
  )
    .bind(
      sessionId,
      nowMs,
      nowMs,
      tenant.tenantId,
      state.invitation.id,
      state.tokenHash,
      state.consumptionId,
      state.recoveryHash,
      state.userId,
      ...(previousSessionId ? [previousSessionId] : []),
    )
    .run()
  if (Number(reservation.meta.changes ?? 0) !== 1) throw new AppError('token_invalid')

  try {
    const issued = await issueSession(c, {
      sessionId,
      userId: state.userId,
      ...(mfaGate.sessionStatus ? { status: mfaGate.sessionStatus } : {}),
      authContext: EMAIL_OTP_AUTH_CONTEXT,
      authenticatedAt: new Date(),
      ip: requestIp(c),
      userAgent: requestUserAgent(c),
    })
    return { session: issued.session, redirectUrl: mfaGate.redirectUrl ?? redirectPath }
  } catch (error) {
    await clearFailedReservation(c, tenant, state, sessionId)
    throw error
  }
}

async function finalizeClaimAcceptance(opts: {
  c: Context<XidHonoEnv>
  tenant: TenantVar
  state: ClaimState
  session: SessionData
}): Promise<{
  invitationAccepted: boolean
  membershipCreated: boolean
  membershipReactivated: boolean
}> {
  const { c, tenant, state, session } = opts
  const invitation = state.invitation
  if (invitation.status === 'accepted') {
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
  const redirectPath = invitationAcceptContinuePath(
    state.invitation.orgId,
    org?.name ?? org?.slug ?? state.invitation.orgId,
  )
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
