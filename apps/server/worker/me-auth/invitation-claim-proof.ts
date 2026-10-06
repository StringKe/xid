// Invitation Email claim, step two: atomically consume the proof (pending -> claim_verified) and bind
// it to a reusable claim-proven identity or a new credential-free User; recover the same claim state
// on retries with the browser-held recovery key.

import { sha256Hex } from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import { and, eq } from 'drizzle-orm'
import { constantTimeEqualStr } from '../auth/otp'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import type { TenantVar } from '../lib/types'
import {
  CLAIM_PROOF,
  CLAIM_USER_ORIGIN,
  claimGuardBindings,
  claimGuardSql,
  claimWinnerGuardBindings,
  claimWinnerGuardSql,
  hashesEqual,
  isClaimStatus,
  normalizedInvitationEmail,
  requireActiveClaimOrganization,
  type ClaimState,
  type InvitationRow,
} from './invitation-claim-state'

// 已验证邮箱的现有账号(非认领建出的账号)不可被认领挤占:接受邀请须登录该账号,
// 否则同一人会被拆成两个身份。挤占只保留给未验证、可能被抢注的邮箱。
const ESTABLISHED_ACCOUNT_SQL = `EXISTS (
    SELECT 1
      FROM user_emails AS established_email
      JOIN users AS established_user ON established_user.id = established_email.user_id
     WHERE established_email.tenant_id = ?
       AND established_email.email = ?
       AND established_email.verified = 1
       AND established_email.verification_status = 'verified'
       AND established_user.tenant_id = established_email.tenant_id
       AND established_user.deleted_at IS NULL
       AND established_user.merged_into_user_id IS NULL
       AND (established_user.provisioned_by IS NULL
            OR established_user.provisioned_by != '${CLAIM_USER_ORIGIN}')
  )`

async function hasEstablishedAccount(env: Env, tenant: TenantVar, email: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT ${ESTABLISHED_ACCOUNT_SQL} AS established`)
    .bind(tenant.tenantId, email)
    .first<{ established: number }>()
  return Number(row?.established ?? 0) === 1
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
        )
        AND NOT ${ESTABLISHED_ACCOUNT_SQL}`,
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
    tenant.tenantId,
    email,
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
      `UPDATE magic_link_tokens
          SET consumed_at = ?
        WHERE tenant_id = ?
          AND consumed_at IS NULL
          AND user_id IN (
            SELECT id FROM users
             WHERE tenant_id = ? AND pending_email = ?
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
      `UPDATE magic_link_tokens
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

export async function consumeOrRecoverClaimProof(opts: {
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
  // 邮箱归属已证明,此时告知「该邮箱已有账号」只面向邮箱本人。
  if (await hasEstablishedAccount(opts.env, opts.tenant, email)) {
    throw new AppError('invitation_sign_in_required')
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
