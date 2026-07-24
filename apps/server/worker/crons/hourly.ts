// 每小时 Cron(0 * * * *):过期清理 + DAU 聚合。
// 见 docs/design/07-platform-operations.md、cloudflare-bindings rule Cron Triggers 行。
// 强一致短期数据(challenge/state/nonce/PAR)存 DO 自带 TTL alarm 自清,此处只清 D1 持久态。

// 物理删除只用于过期 session 行的保留期清理。活跃或 revoked 状态语义仍由 sessions.status 表达。
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
      console.warn(
        'access_token_revocations table missing; skip denylist cleanup until migration applied',
      )
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
      } catch {
        console.error('[hourly] metering outbox retry state update failed')
      }
      continue
    }

    try {
      await markMeteringOutboxDelivered(env, row.id, now)
    } catch {
      console.error('[hourly] metering outbox delivery state update failed')
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
  await cleanupExpiredSessions(env)
  await cleanupExpiredAccessTokenRevocations(env)
  await cleanupExpiredAuthCodes(env)
  await cleanupExpiredChallenges(env)
  await redeliverMeteringOutbox(env)
  await aggregateDau(env)
}
