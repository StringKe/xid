// 每小时 Cron(0 * * * *):过期清理 + DAU 聚合。
// 见 docs/design/07-platform-operations.md、cloudflare-bindings rule Cron Triggers 行。
// 强一致短期数据(challenge/state/nonce/PAR)存 DO 自带 TTL alarm 自清,此处只清 D1 持久态。

// 物理删除只用于过期 session 行的保留期清理。活跃或 revoked 状态语义仍由 sessions.status 表达。
import { logWorkerError, logWorkerWarning } from '../lib/safe-log'
import { redeliverPendingPlatformAudits } from '../platform/audit-outbox'
import { recoverStaleDeadLetterReplays } from '../queues/dead-letter'
import { redeliverPendingNotificationOutbox } from '../queues/notification-delivery-state'
import { sessionDoRevoke } from '../lib/session'

export async function hardDeleteExpiredSessions(env: Env, now: number = Date.now()): Promise<void> {
  await env.DB.prepare(`DELETE FROM sessions WHERE expires_at IS NOT NULL AND expires_at < ?`)
    .bind(now)
    .run()
}

// 清理过期 session(05 章 8:sessions 表 expires_at 过期 / status=revoked 留痕后硬删)。
export async function cleanupExpiredSessions(env: Env): Promise<void> {
  await hardDeleteExpiredSessions(env)
}

function isMissingAccessTokenRevocationsTable(err: unknown): boolean {
  return err instanceof Error && err.message.includes('no such table: access_token_revocations')
}

// 清理已过期 access token revoke denylist 记录。token 已过期后无继续保留撤销记录的安全收益。
export async function cleanupExpiredAccessTokenRevocations(
  env: Env,
  now: number = Date.now(),
): Promise<void> {
  try {
    await env.DB.prepare(`DELETE FROM access_token_revocations WHERE expires_at < ?`)
      .bind(now)
      .run()
  } catch (err) {
    // 部署先于 D1 migration 时避免整点 cron 失败;迁移落地后自动恢复清理。
    if (isMissingAccessTokenRevocationsTable(err)) {
      logWorkerWarning('cron.access_token_revocations.migration_pending', {
        component: 'hourly',
      })
      return
    }
    throw err
  }
}

// 清理过期 authorization_code。授权码主存 D1 authorization_codes 表(oidc/authorize.ts 写入,
// token-grants.ts CAS 消费),一次性 + 短 TTL,过期的未消费行无保留价值,全局硬删(同 sessions 清理)。
export async function cleanupExpiredAuthCodes(env: Env, now: number = Date.now()): Promise<void> {
  await env.DB.prepare(`DELETE FROM authorization_codes WHERE expires_at < ?`).bind(now).run()
}

// 清理过期 challenge / nonce:存 DurableObject(WEBAUTHN_CHALLENGE / OAUTH_STATE),
// 由各 DO alarm 在 TTL 到期时自清,Cron 无需介入。
export async function cleanupExpiredChallenges(_env: Env): Promise<void> {
  // challenge / state / nonce / PAR 由对应 DO TTL alarm 自清,见 webauthn / oidc-oauth rule。
}

type ExpiredInvitationClaim = {
  tenantId: string
  invitationId: string
  userId: string | null
  sessionId: string | null
  status: 'pending' | 'claim_verified' | 'expired'
}

function isMissingInvitationClaimMigration(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes('no such column: email_claim_') ||
      error.message.includes('no such table: invitations'))
  )
}

// Invitation lifetime expiry and a consumed claim's proof window both terminate recovery.
// D1 session revocation is committed with the invitation transition before SessionDO cleanup, so
// authentication stays closed even if the distributed cleanup reports a transient failure.
export async function expireInvitationClaims(env: Env, now: number = Date.now()): Promise<void> {
  while (true) {
    let rows: ExpiredInvitationClaim[]
    try {
      rows = (
        await env.DB.prepare(
          `SELECT tenant_id AS tenantId,
                  id AS invitationId,
                  email_claim_user_id AS userId,
                  email_claim_session_id AS sessionId,
                  status
             FROM invitations
            WHERE (
                    status IN ('pending', 'claim_verified')
                    AND expires_at <= ?
                  )
               OR (
                    status = 'claim_verified'
                    AND email_claim_expires_at IS NOT NULL
                    AND email_claim_expires_at <= ?
                  )
               OR (
                    status = 'expired'
                    AND email_claim_user_id IS NOT NULL
                    AND email_claim_session_id IS NOT NULL
                  )
            ORDER BY id ASC
            LIMIT 50`,
        )
          .bind(now, now)
          .all<ExpiredInvitationClaim>()
      ).results
    } catch (error) {
      if (!isMissingInvitationClaimMigration(error)) throw error
      logWorkerWarning('cron.invitation_claims.migration_pending', { component: 'hourly' })
      return
    }
    if (rows.length === 0) return

    const statements: D1PreparedStatement[] = []
    const work: Array<{
      row: ExpiredInvitationClaim
      transitionIndex: number | null
    }> = []
    for (const row of rows) {
      if (row.userId && row.sessionId) {
        const invitationGuard =
          row.status === 'expired'
            ? `status = 'expired'
               AND email_claim_user_id = ?
               AND email_claim_session_id = ?`
            : `(
                 (status IN ('pending', 'claim_verified') AND expires_at <= ?)
                 OR (
                   status = 'claim_verified'
                   AND email_claim_expires_at IS NOT NULL
                   AND email_claim_expires_at <= ?
                 )
               )
               AND email_claim_user_id = ?
               AND email_claim_session_id = ?`
        statements.push(
          env.DB.prepare(
            `UPDATE sessions
                SET status = 'revoked'
              WHERE tenant_id = ?
                AND id = ?
                AND user_id = ?
                AND EXISTS (
                  SELECT 1
                    FROM invitations
                   WHERE tenant_id = ?
                     AND id = ?
                     AND ${invitationGuard}
                )`,
          ).bind(
            row.tenantId,
            row.sessionId,
            row.userId,
            row.tenantId,
            row.invitationId,
            ...(row.status === 'expired' ? [] : [now, now]),
            row.userId,
            row.sessionId,
          ),
        )
      }
      let transitionIndex: number | null = null
      if (row.status !== 'expired') {
        transitionIndex = statements.length
        statements.push(
          env.DB.prepare(
            `UPDATE invitations
                SET status = 'expired',
                    email_claim_token_hash = CASE
                      WHEN email_claim_session_id IS NULL THEN NULL
                      ELSE email_claim_token_hash
                    END,
                    email_claim_email_hash = CASE
                      WHEN email_claim_session_id IS NULL THEN NULL
                      ELSE email_claim_email_hash
                    END,
                    email_claim_recovery_hash = CASE
                      WHEN email_claim_session_id IS NULL THEN NULL
                      ELSE email_claim_recovery_hash
                    END,
                    email_claim_finalization_id = NULL,
                    updated_at = ?
              WHERE tenant_id = ?
                AND id = ?
                AND (
                  (status IN ('pending', 'claim_verified') AND expires_at <= ?)
                  OR (
                    status = 'claim_verified'
                    AND email_claim_expires_at IS NOT NULL
                    AND email_claim_expires_at <= ?
                  )
                )`,
          ).bind(now, row.tenantId, row.invitationId, now, now),
        )
      } else if (row.userId && row.sessionId) {
        transitionIndex = statements.length
        statements.push(
          env.DB.prepare(
            `UPDATE invitations
                SET updated_at = updated_at
              WHERE tenant_id = ?
                AND id = ?
                AND status = 'expired'
                AND email_claim_user_id = ?
                AND email_claim_session_id = ?`,
          ).bind(row.tenantId, row.invitationId, row.userId, row.sessionId),
        )
      }
      work.push({ row, transitionIndex })
    }
    const results = await env.DB.batch(statements)

    const cleanupFailures: unknown[] = []
    for (const item of work) {
      const { row, transitionIndex } = item
      if (!row.userId || !row.sessionId) continue
      const transitionWon =
        transitionIndex !== null && Number(results[transitionIndex]?.meta.changes ?? 0) === 1
      if (!transitionWon) continue
      try {
        await sessionDoRevoke(env, row.userId, row.sessionId)
        const cleared = await env.DB.prepare(
          `UPDATE invitations
              SET email_claim_token_hash = NULL,
                  email_claim_email_hash = NULL,
                  email_claim_recovery_hash = NULL,
                  email_claim_session_id = NULL,
                  email_claim_session_reserved_at = NULL,
                  updated_at = ?
            WHERE tenant_id = ?
              AND id = ?
              AND status = 'expired'
              AND email_claim_user_id = ?
              AND email_claim_session_id = ?`,
        )
          .bind(now, row.tenantId, row.invitationId, row.userId, row.sessionId)
          .run()
        if (Number(cleared.meta.changes ?? 0) !== 1) {
          throw new Error('Invitation claim cleanup winner changed')
        }
      } catch (error) {
        logWorkerError('cron.invitation_claims.session_do_revoke_failed', error, {
          component: 'hourly',
          operation: 'revoke_claim_session',
        })
        cleanupFailures.push(error)
      }
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(cleanupFailures, 'Invitation claim session cleanup failed')
    }
  }
}

// seat_used is an operational read model. Enforcement uses exact membership-count triggers, while
// this reconciliation repairs every write path (JIT, invitation, SCIM, Console, bootstrap) without
// making authentication depend on a potentially stale counter.
export async function reconcileOrganizationSeatUsage(
  env: Env,
  now: number = Date.now(),
): Promise<void> {
  await env.DB.prepare(
    `UPDATE organizations
     SET seat_used = (
           SELECT COUNT(*)
           FROM memberships
           WHERE memberships.tenant_id = organizations.tenant_id
             AND memberships.org_id = organizations.id
             AND memberships.status = 'active'
         ),
         updated_at = ?
     WHERE seat_used <> (
       SELECT COUNT(*)
       FROM memberships
       WHERE memberships.tenant_id = organizations.tenant_id
         AND memberships.org_id = organizations.id
         AND memberships.status = 'active'
     )`,
  )
    .bind(now)
    .run()
}

type MeteringOutboxRow = {
  id: string
  tenantId: string
  userId: string
  occurredAt: number
}

async function noteMeteringOutboxRetry(env: Env, id: string, now: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE metering_outbox
     SET attempt_count = attempt_count + 1, last_error_code = ?, updated_at = ?
     WHERE id = ? AND delivered_at IS NULL`,
  )
    .bind('queue_send_failed', now, id)
    .run()
}

async function markMeteringOutboxDelivered(env: Env, id: string, now: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE metering_outbox
     SET delivered_at = ?, attempt_count = attempt_count + 1, last_error_code = NULL, updated_at = ?
     WHERE id = ? AND delivered_at IS NULL`,
  )
    .bind(now, now, id)
    .run()
}

// Queue 不可用时认证链路保存的计量事件由 cron 恢复。
// 仅在 send 成功后标记 delivered；标记失败时重投同一用户同日事件仍由 MeteringDO 去重。
export async function redeliverMeteringOutbox(env: Env, now: number = Date.now()): Promise<void> {
  const rows = (
    await env.DB.prepare(
      `SELECT id, tenant_id AS tenantId, user_id AS userId, occurred_at AS occurredAt
       FROM metering_outbox
       WHERE delivered_at IS NULL
       ORDER BY created_at ASC
       LIMIT ?`,
    )
      .bind(100)
      .all<MeteringOutboxRow>()
  ).results

  for (const row of rows) {
    try {
      await env.METERING_QUEUE.send({
        tenantId: row.tenantId,
        userId: row.userId,
        ts: row.occurredAt,
      })
    } catch {
      try {
        await noteMeteringOutboxRetry(env, row.id, now)
      } catch (error) {
        logWorkerError('cron.metering_outbox.retry_state_failed', error, {
          component: 'hourly',
        })
      }
      continue
    }

    try {
      await markMeteringOutboxDelivered(env, row.id, now)
    } catch (error) {
      logWorkerError('cron.metering_outbox.delivery_state_failed', error, {
        component: 'hourly',
      })
    }
  }
}

// DAU 聚合:主路径由 Metering Consumer 实时 upsert usage_daily.dau。
// Analytics Engine binding 在 Worker 运行时只写不读,读侧统一以 D1 计量事实为准。
// 此处兜底补齐 active tenant 当日 usage_daily 行,避免平台统计因无事件而缺行。
export async function aggregateDau(env: Env): Promise<void> {
  const now = Date.now()
  const day = new Date(now).toISOString().slice(0, 10)
  const pageSize = 100
  let cursor: string | null = null

  while (true) {
    const tenantRows: Array<{ tenant_id: string }> = (
      await env.DB.prepare(
        `SELECT id AS tenant_id FROM organizations
           WHERE status = 'active' AND parent_org_id IS NULL AND (? IS NULL OR id > ?)
           ORDER BY id ASC
           LIMIT ?`,
      )
        .bind(cursor, cursor, pageSize)
        .all<{ tenant_id: string }>()
    ).results
    if (tenantRows.length === 0) return

    const statements = tenantRows.map((row) =>
      env.DB.prepare(
        `INSERT INTO usage_daily (tenant_id, day, dau, api_calls, email_count, created_at, updated_at)
         VALUES (?, ?, 0, 0, 0, ?, ?)
         ON CONFLICT (tenant_id, day) DO NOTHING`,
      ).bind(row.tenant_id, day, now, now),
    )
    await env.DB.batch(statements)
    cursor = tenantRows[tenantRows.length - 1]!.tenant_id
  }
}

export async function runHourly(env: Env): Promise<void> {
  await expireInvitationClaims(env)
  await cleanupExpiredSessions(env)
  await cleanupExpiredAccessTokenRevocations(env)
  await cleanupExpiredAuthCodes(env)
  await cleanupExpiredChallenges(env)
  await recoverStaleDeadLetterReplays(env)
  await redeliverPendingNotificationOutbox(env)
  await redeliverPendingPlatformAudits(env)
  await redeliverMeteringOutbox(env)
  await reconcileOrganizationSeatUsage(env)
  await aggregateDau(env)
}
