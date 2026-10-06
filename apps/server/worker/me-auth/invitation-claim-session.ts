// Invitation Email claim, step three: reserve and issue (or recover) the claimant's browser session.
// A lease on the reservation keeps concurrent verifiers from issuing two sessions for one claim.

import { createTenantDb, schema } from '@xid-kit/db'
import { eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { EMAIL_OTP_AUTH_CONTEXT } from '../lib/auth-context'
import { AppError } from '../lib/errors'
import { resolvePostAuthMfaGate } from '../lib/mfa-session'
import { createPersistedId } from '../lib/persisted-id'
import { issueSession, readSessionForTenant, revokeSessionByIdentity } from '../lib/session'
import type { SessionData, TenantVar, XidHonoEnv } from '../lib/types'
import { CLAIM_SESSION_STATUSES, type ClaimState } from './invitation-claim-state'
import { requestIp, requestUserAgent } from './shared'

const SESSION_RESERVATION_LEASE_MS = 30_000

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

export async function issueRecoverableClaimSession(opts: {
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
