// POST /auth/verify-email + /auth/resend-verification。
// signed email_hash 把一次性 token 绑定到一个精确 Email，pending Email 验证成功后才创建 user_emails 行。

import { sha256Hex } from '@xid-kit/crypto'
import { createTenantDb, schema, USER_PROVISIONED_BY_ANONYMOUS } from '@xid-kit/db'
import { and, eq } from 'drizzle-orm'
import type { Context } from 'hono'
import * as v from 'valibot'
import { readAnonKey } from '../auth/passkey-helpers'
import { constantTimeEqualStr } from '../auth/otp'
import { clearRefreshTokenCookie } from '../lib/cookies'
import { AppError } from '../lib/errors'
import { readSession, sessionDoRevokeAll } from '../lib/session'
import type { XidHonoEnv } from '../lib/types'
import { readJsonBody, validateCredentialBody } from '../lib/validate'
import {
  issueEmailVerification,
  loadEmailVerifyToken,
  verifyEmailVerifyJwt,
} from './email-verify-token'
import { unbindGuestAnonKey } from './guest'
import { withTenant } from './instance-login'
import { enforceSendRateLimit } from './shared'
import { resolveTokenTenant } from './token-tenant'

const PURPOSE = 'email_verification'
const verifyBodySchema = v.object({ token: v.pipe(v.string(), v.minLength(1)) })

type EmailRow = typeof schema.userEmails.$inferSelect

type VerificationTarget =
  | { kind: 'primary'; email: string; emailId: string }
  | { kind: 'pending'; email: string; emailId: string }

function d1Changes(result: D1Result<unknown> | undefined): number {
  return result?.meta.changes ?? 0
}

async function loadPrimaryEmailRow(
  db: ReturnType<typeof createTenantDb>,
  userId: string,
  primaryEmailId: string | null,
): Promise<EmailRow | null> {
  if (primaryEmailId) {
    const row = await db.userEmails.findOne(
      and(eq(schema.userEmails.id, primaryEmailId), eq(schema.userEmails.userId, userId)),
    )
    if (row) return row
  }
  return (
    (await db.userEmails.findOne(
      and(eq(schema.userEmails.userId, userId), eq(schema.userEmails.isPrimary, true)),
    )) ?? null
  )
}

async function resolveVerificationTarget(
  db: ReturnType<typeof createTenantDb>,
  user: typeof schema.users.$inferSelect,
  emailHash: string,
): Promise<VerificationTarget> {
  const primary = await loadPrimaryEmailRow(db, user.id, user.primaryEmailId)
  if (primary) {
    const targetHash = await sha256Hex(primary.email.trim().toLowerCase())
    if (constantTimeEqualStr(targetHash, emailHash)) {
      return { kind: 'primary', email: primary.email.trim().toLowerCase(), emailId: primary.id }
    }
    throw new AppError('token_invalid')
  }

  const pendingEmail = user.pendingEmail?.trim().toLowerCase()
  if (!pendingEmail) throw new AppError('token_invalid')
  const targetHash = await sha256Hex(pendingEmail)
  if (!constantTimeEqualStr(targetHash, emailHash)) throw new AppError('token_invalid')
  return {
    kind: 'pending',
    email: pendingEmail,
    emailId: crypto.randomUUID(),
  }
}

function tokenConsumedPredicate(): string {
  return `EXISTS (
    SELECT 1 FROM verification_tokens
     WHERE tenant_id = ?
       AND token_hash = ?
       AND purpose = '${PURPOSE}'
       AND consumed_at = ?
  )`
}

function buildVerificationStatements(opts: {
  env: Env
  tenantId: string
  userId: string
  tokenHash: string
  target: VerificationTarget
  wasGuest: boolean
  nowMs: number
}): D1PreparedStatement[] {
  const { env, tenantId, userId, tokenHash, target, wasGuest, nowMs } = opts
  const consumeToken = env.DB.prepare(
    `UPDATE verification_tokens
        SET consumed_at = ?
      WHERE tenant_id = ?
        AND token_hash = ?
        AND purpose = '${PURPOSE}'
        AND consumed_at IS NULL
        AND expires_at > ?`,
  ).bind(nowMs, tenantId, tokenHash, nowMs)

  const statements: D1PreparedStatement[] = [consumeToken]
  if (target.kind === 'primary') {
    statements.push(
      env.DB.prepare(
        `UPDATE user_emails
            SET verified = 1,
                verification_status = 'verified',
                verified_at = ?,
                updated_at = ?
          WHERE tenant_id = ?
            AND id = ?
            AND user_id = ?
            AND lower(email) = ?
            AND ${tokenConsumedPredicate()}`,
      ).bind(
        nowMs,
        nowMs,
        tenantId,
        target.emailId,
        userId,
        target.email,
        tenantId,
        tokenHash,
        nowMs,
      ),
    )
    if (wasGuest) {
      statements.push(
        env.DB.prepare(
          `UPDATE users
              SET provisioned_by = 'hosted_passwordless',
                  updated_at = ?
            WHERE tenant_id = ?
              AND id = ?
              AND provisioned_by = ?
              AND ${tokenConsumedPredicate()}`,
        ).bind(nowMs, tenantId, userId, USER_PROVISIONED_BY_ANONYMOUS, tenantId, tokenHash, nowMs),
      )
    }
  } else {
    statements.push(
      env.DB.prepare(
        `UPDATE users
            SET primary_email_id = ?,
                pending_email = NULL,
                provisioned_by = CASE
                  WHEN provisioned_by = ? THEN 'hosted_passwordless'
                  ELSE provisioned_by
                END,
                updated_at = ?
          WHERE tenant_id = ?
            AND id = ?
            AND primary_email_id IS NULL
            AND lower(pending_email) = ?
            AND ${tokenConsumedPredicate()}`,
      ).bind(
        target.emailId,
        USER_PROVISIONED_BY_ANONYMOUS,
        nowMs,
        tenantId,
        userId,
        target.email,
        tenantId,
        tokenHash,
        nowMs,
      ),
    )
    statements.push(
      env.DB.prepare(
        `INSERT INTO user_emails (
           id, tenant_id, user_id, email, verified, verification_status,
           is_primary, verified_at, created_at, updated_at
         )
         SELECT ?, ?, ?, ?, 1, 'verified', 1, ?, ?, ?
           FROM users
          WHERE tenant_id = ?
            AND id = ?
            AND primary_email_id = ?
            AND ${tokenConsumedPredicate()}`,
      ).bind(
        target.emailId,
        tenantId,
        userId,
        target.email,
        nowMs,
        nowMs,
        nowMs,
        tenantId,
        userId,
        target.emailId,
        tenantId,
        tokenHash,
        nowMs,
      ),
    )
  }

  if (wasGuest) {
    statements.push(
      env.DB.prepare(
        `UPDATE sessions
            SET status = 'revoked'
          WHERE tenant_id = ?
            AND user_id = ?
            AND ${tokenConsumedPredicate()}`,
      ).bind(tenantId, userId, tenantId, tokenHash, nowMs),
    )
  }
  return statements
}

function emitGuestConverted(c: Context<XidHonoEnv>, tenantId: string, userId: string): void {
  const tasks: Promise<unknown>[] = [
    c.env.AUDIT_QUEUE.send({
      tenantId,
      action: 'guest.converted',
      actorId: userId,
      ts: Date.now(),
      payload: { targetType: 'user', targetId: userId },
    }),
  ]
  const anonKey = readAnonKey(c)
  if (anonKey) tasks.push(unbindGuestAnonKey(c.env, tenantId, anonKey))
  c.executionCtx.waitUntil(Promise.all(tasks))
}

export async function handleVerifyEmail(c: Context<XidHonoEnv>): Promise<Response> {
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('token_invalid')
  const body = validateCredentialBody(verifyBodySchema, json.value, {
    code: 'token_invalid',
    credentialFields: ['token'],
  })
  const rawToken = body.token
  const tenant = await resolveTokenTenant(c, rawToken, 'token_invalid')

  return withTenant(c, tenant, async () => {
    const verified = await verifyEmailVerifyJwt(tenant, rawToken)
    const db = createTenantDb(c.env.DB, tenant)
    const [tokenRow, user] = await Promise.all([
      loadEmailVerifyToken(db, verified.jti),
      db.users.findOne(eq(schema.users.id, verified.userId)),
    ])
    if (
      tokenRow.userId !== verified.userId ||
      !user ||
      user.status !== 'active' ||
      user.deletedAt !== null
    ) {
      throw new AppError('token_invalid')
    }

    const target = await resolveVerificationTarget(db, user, verified.emailHash)
    const wasGuest = user.provisionedBy === USER_PROVISIONED_BY_ANONYMOUS
    const currentSession = wasGuest ? (c.get('session') ?? (await readSession(c))) : null
    if (wasGuest) await sessionDoRevokeAll(c.env, user.id)

    const tokenHash = await sha256Hex(verified.jti)
    const statements = buildVerificationStatements({
      env: c.env,
      tenantId: tenant.tenantId,
      userId: user.id,
      tokenHash,
      target,
      wasGuest,
      nowMs: Date.now(),
    })
    const results = await c.env.DB.batch(statements)
    if (d1Changes(results[0]) !== 1) throw new AppError('token_invalid')
    if (target.kind === 'primary') {
      if (d1Changes(results[1]) !== 1) throw new AppError('token_invalid')
      if (wasGuest && d1Changes(results[2]) !== 1) throw new AppError('token_invalid')
    } else if (d1Changes(results[1]) !== 1 || d1Changes(results[2]) !== 1) {
      throw new AppError('token_invalid')
    }

    if (wasGuest) {
      if (currentSession?.userId === user.id) {
        clearRefreshTokenCookie(c, currentSession.sessionId)
      }
      emitGuestConverted(c, tenant.tenantId, user.id)
    }
    return c.json({
      ok: true,
      ...(verified.intent === 'sign-up' ? { redirectUrl: '/sign-in?intent=sign-up' } : {}),
    })
  })
}

export async function handleResendVerification(c: Context<XidHonoEnv>): Promise<Response> {
  const tenant = c.get('tenant')
  const session = c.get('session') ?? (await readSession(c))
  if (!session) return c.json({ ok: true })

  const db = createTenantDb(c.env.DB, tenant)
  const user = await db.users.findOne(eq(schema.users.id, session.userId))
  if (!user || user.status !== 'active' || user.deletedAt !== null) return c.json({ ok: true })

  const primary = await loadPrimaryEmailRow(db, user.id, user.primaryEmailId)
  const targetEmail = primary
    ? primary.verified
      ? null
      : primary.email.trim().toLowerCase()
    : (user.pendingEmail?.trim().toLowerCase() ?? null)
  if (!targetEmail) return c.json({ ok: true })

  await enforceSendRateLimit(c.env, `emailverify:${tenant.tenantId}`, targetEmail)
  await issueEmailVerification({
    env: c.env,
    tenant,
    userId: session.userId,
    email: targetEmail,
  })
  return c.json({ ok: true })
}
