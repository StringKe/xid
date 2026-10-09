// guest GC:不活跃满 GUEST_GC_INACTIVE_DAYS 天的 anonymous 用户软删(01 章 guest 模式)。

import { USER_PROVISIONED_BY_ANONYMOUS } from '@xid-kit/db'
import { sessionDoRevokeAll } from '../lib/session'
import { GUEST_GC_INACTIVE_DAYS } from '../lib/ttl'
import { eachActiveTenant } from './active-tenants'

const GUEST_GC_PAGE_SIZE = 100
const DAY_MS = 24 * 60 * 60 * 1000

type GuestGcRow = { id: string; delete_tenant: number }

const GUEST_GC_TENANT_BLOCKING_TABLES = [
  'projects',
  'applications',
  'project_grants',
  'org_policies',
  'roles',
  'permissions',
  'role_permissions',
  'user_grants',
  'manager_assignments',
  'invitations',
  'organization_domains',
  'sso_connections',
  'cert_store',
  'saml_service_providers',
  'saml_session_bindings',
  'directories',
  'directory_users',
  'directory_groups',
  'directory_group_members',
  'directory_pending_members',
  'scim_targets',
  'api_keys',
  'webhooks',
  'authorization_codes',
  'refresh_tokens',
  'access_token_revocations',
  'access_token_issuances',
  'oauth_consents',
  'resource_servers',
] as const

function ownedOnboardingTenantExists(userRef: string): string {
  return `EXISTS (
    SELECT 1
      FROM organizations owned
      JOIN memberships owner_membership
        ON owner_membership.tenant_id = owned.tenant_id
       AND owner_membership.org_id = owned.id
       AND owner_membership.user_id = ${userRef}.id
       AND owner_membership.role = 'owner'
       AND owner_membership.status = 'active'
     WHERE owned.id = ${userRef}.tenant_id
       AND owned.tenant_id = ${userRef}.tenant_id
       AND owned.parent_org_id IS NULL
       AND owned.slug <> 'default'
       AND owned.status = 'active'
       AND owned.deleted_at IS NULL
  )`
}

function tenantHasNoBlockingResources(userRef: string): string {
  return GUEST_GC_TENANT_BLOCKING_TABLES.map(
    (table) =>
      `NOT EXISTS (
        SELECT 1 FROM ${table}
         WHERE tenant_id = ${userRef}.tenant_id
      )`,
  ).join('\n          AND ')
}

function userHasNoBlockingBusinessRows(userRef: string): string {
  return `NOT EXISTS (
      SELECT 1 FROM manager_assignments
       WHERE tenant_id = ${userRef}.tenant_id
         AND user_id = ${userRef}.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM user_grants
       WHERE tenant_id = ${userRef}.tenant_id
         AND user_id = ${userRef}.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM invitations
       WHERE tenant_id = ${userRef}.tenant_id
         AND (
           invited_by_user_id = ${userRef}.id
           OR accepted_by_user_id = ${userRef}.id
         )
    )
    AND NOT EXISTS (
      SELECT 1 FROM authorization_codes
       WHERE tenant_id = ${userRef}.tenant_id
         AND user_id = ${userRef}.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM refresh_tokens
       WHERE tenant_id = ${userRef}.tenant_id
         AND user_id = ${userRef}.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM oauth_consents
       WHERE tenant_id = ${userRef}.tenant_id
         AND user_id = ${userRef}.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM saml_session_bindings
       WHERE tenant_id = ${userRef}.tenant_id
         AND user_id = ${userRef}.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM directory_users
       WHERE tenant_id = ${userRef}.tenant_id
         AND user_id = ${userRef}.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM access_token_issuances
       WHERE tenant_id = ${userRef}.tenant_id
         AND subject = ${userRef}.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM access_token_revocations
       WHERE tenant_id = ${userRef}.tenant_id
         AND subject = ${userRef}.id
    )`
}

function safeOwnedOnboardingTenant(userRef: string): string {
  return `${ownedOnboardingTenantExists(userRef)}
    AND NOT EXISTS (
      SELECT 1 FROM users other_user
       WHERE other_user.tenant_id = ${userRef}.tenant_id
         AND other_user.id <> ${userRef}.id
         AND other_user.deleted_at IS NULL
         AND other_user.status <> 'deleted'
    )
    AND NOT EXISTS (
      SELECT 1 FROM memberships other_membership
       WHERE other_membership.tenant_id = ${userRef}.tenant_id
         AND other_membership.status = 'active'
         AND NOT (
           other_membership.org_id = ${userRef}.tenant_id
           AND other_membership.user_id = ${userRef}.id
           AND other_membership.role = 'owner'
         )
    )
    AND NOT EXISTS (
      SELECT 1 FROM organizations child
       WHERE child.tenant_id = ${userRef}.tenant_id
         AND child.id <> ${userRef}.tenant_id
         AND child.deleted_at IS NULL
         AND child.status <> 'deleted'
    )
    AND ${tenantHasNoBlockingResources(userRef)}`
}

function safeGuestGcTarget(userRef: string, deleteTenant: boolean): string {
  const membershipGuard = deleteTenant
    ? safeOwnedOnboardingTenant(userRef)
    : `NOT ${ownedOnboardingTenantExists(userRef)}
       AND NOT EXISTS (
         SELECT 1 FROM memberships active_membership
          WHERE active_membership.tenant_id = ${userRef}.tenant_id
            AND active_membership.user_id = ${userRef}.id
            AND active_membership.status = 'active'
       )`
  return `${userRef}.provisioned_by = ?
    AND ${userRef}.deleted_at IS NULL
    AND ${userRef}.status = 'active'
    AND NOT EXISTS (
      SELECT 1 FROM user_emails verified_email
       WHERE verified_email.tenant_id = ${userRef}.tenant_id
         AND verified_email.user_id = ${userRef}.id
         AND verified_email.verified = 1
    )
    AND COALESCE(
      (
        SELECT MAX(active_session.last_active_at)
          FROM sessions active_session
         WHERE active_session.tenant_id = ${userRef}.tenant_id
           AND active_session.user_id = ${userRef}.id
      ),
      ${userRef}.created_at
    ) < ?
    AND ${userHasNoBlockingBusinessRows(userRef)}
    AND ${membershipGuard}`
}

function claimedGuestExists(): string {
  return `EXISTS (
    SELECT 1 FROM users claimed_guest
     WHERE claimed_guest.tenant_id = ?
       AND claimed_guest.id = ?
       AND claimed_guest.provisioned_by = ?
       AND claimed_guest.status = 'deleted'
       AND claimed_guest.deleted_at = ?
  )`
}

function guestGcClosureStatements(opts: {
  env: Env
  tenantId: string
  userId: string
  deleteTenant: boolean
  nowMs: number
}): D1PreparedStatement[] {
  const { env, tenantId, userId, deleteTenant, nowMs } = opts
  const claimed = claimedGuestExists()
  const claimParams = [tenantId, userId, USER_PROVISIONED_BY_ANONYMOUS, nowMs] as const
  return [
    env.DB.prepare(
      `UPDATE sessions
          SET status = 'revoked'
        WHERE tenant_id = ? AND user_id = ? AND ${claimed}`,
    ).bind(tenantId, userId, ...claimParams),
    env.DB.prepare(
      `UPDATE memberships
          SET status = 'inactive', updated_at = ?
        WHERE tenant_id = ? AND user_id = ? AND status = 'active' AND ${claimed}`,
    ).bind(nowMs, tenantId, userId, ...claimParams),
    env.DB.prepare(
      `UPDATE user_emails
          SET verification_status = 'expired', updated_at = ?
        WHERE tenant_id = ? AND user_id = ? AND verified = 0 AND ${claimed}`,
    ).bind(nowMs, tenantId, userId, ...claimParams),
    env.DB.prepare(
      `UPDATE user_phones
          SET verification_status = 'expired', updated_at = ?
        WHERE tenant_id = ? AND user_id = ? AND verified = 0 AND ${claimed}`,
    ).bind(nowMs, tenantId, userId, ...claimParams),
    env.DB.prepare(
      `UPDATE user_identities
          SET revoked_at = COALESCE(revoked_at, ?), updated_at = ?
        WHERE tenant_id = ? AND user_id = ? AND ${claimed}`,
    ).bind(nowMs, nowMs, tenantId, userId, ...claimParams),
    env.DB.prepare(
      `UPDATE password_reset_tokens
          SET consumed_at = COALESCE(consumed_at, ?)
        WHERE tenant_id = ? AND user_id = ? AND ${claimed}`,
    ).bind(nowMs, tenantId, userId, ...claimParams),
    env.DB.prepare(
      `UPDATE magic_link_tokens
          SET consumed_at = COALESCE(consumed_at, ?)
        WHERE tenant_id = ? AND user_id = ? AND ${claimed}`,
    ).bind(nowMs, tenantId, userId, ...claimParams),
    env.DB.prepare(
      `UPDATE verification_tokens
          SET consumed_at = COALESCE(consumed_at, ?)
        WHERE tenant_id = ? AND user_id = ? AND ${claimed}`,
    ).bind(nowMs, tenantId, userId, ...claimParams),
    env.DB.prepare(
      `UPDATE passkey_credentials
          SET revoked_at = COALESCE(revoked_at, ?), updated_at = ?
        WHERE tenant_id = ? AND user_id = ? AND ${claimed}`,
    ).bind(nowMs, nowMs, tenantId, userId, ...claimParams),
    env.DB.prepare(
      `UPDATE mfa_factors
          SET status = 'disabled', updated_at = ?
        WHERE tenant_id = ? AND user_id = ? AND status <> 'disabled' AND ${claimed}`,
    ).bind(nowMs, tenantId, userId, ...claimParams),
    env.DB.prepare(
      `UPDATE backup_codes
          SET used = 1, used_at = COALESCE(used_at, ?)
        WHERE tenant_id = ? AND user_id = ? AND used = 0 AND ${claimed}`,
    ).bind(nowMs, tenantId, userId, ...claimParams),
    env.DB.prepare(
      `UPDATE trusted_devices
          SET revoked_at = COALESCE(revoked_at, ?)
        WHERE tenant_id = ? AND user_id = ? AND ${claimed}`,
    ).bind(nowMs, tenantId, userId, ...claimParams),
    ...(deleteTenant
      ? [
          env.DB.prepare(
            `UPDATE organizations
                SET deleted_at = ?, status = 'deleted', updated_at = ?
              WHERE tenant_id = ?
                AND id = ?
                AND parent_org_id IS NULL
                AND slug <> 'default'
                AND status = 'active'
                AND deleted_at IS NULL
                AND ${claimed}`,
          ).bind(nowMs, nowMs, tenantId, tenantId, ...claimParams),
        ]
      : []),
  ]
}

// 单租户一轮:按"最后活跃"窗口软删 guest。
// 活跃基准:无 session 按 users.created_at;有 session 按该 user 最新 session.last_active_at。
// cron 无 TenantContext,raw SQL 显式绑 tenant_id(tenant-isolation rule 允许场景)。
async function gcInactiveGuestsForTenant(
  env: Env,
  tenantId: string,
  cutoffMs: number,
  nowMs: number,
): Promise<void> {
  // 软删后行被 deleted_at IS NULL 条件排除,同一 SELECT 循环翻页直到无命中。
  while (true) {
    const rows = await env.DB.prepare(
      `SELECT u.id AS id,
              CASE WHEN ${ownedOnboardingTenantExists('u')} THEN 1 ELSE 0 END AS delete_tenant
         FROM users u
        WHERE u.tenant_id = ?
          AND (
            (${safeGuestGcTarget('u', false)})
            OR (${safeGuestGcTarget('u', true)})
          )
        ORDER BY u.id
        LIMIT ?`,
    )
      .bind(
        tenantId,
        USER_PROVISIONED_BY_ANONYMOUS,
        cutoffMs,
        USER_PROVISIONED_BY_ANONYMOUS,
        cutoffMs,
        GUEST_GC_PAGE_SIZE,
      )
      .all<GuestGcRow>()
    if (rows.results.length === 0) return

    for (const row of rows.results) {
      const deleteTenant = row.delete_tenant === 1
      const statements = [
        env.DB.prepare(
          `UPDATE users
              SET deleted_at = ?, status = 'deleted', updated_at = ?
            WHERE tenant_id = ?
              AND id = ?
              AND ${safeGuestGcTarget('users', deleteTenant)}`,
        ).bind(nowMs, nowMs, tenantId, row.id, USER_PROVISIONED_BY_ANONYMOUS, cutoffMs),
        ...guestGcClosureStatements({
          env,
          tenantId,
          userId: row.id,
          deleteTenant,
          nowMs,
        }),
      ]
      const results = await env.DB.batch(statements)
      if ((results[0]?.meta.changes ?? 0) !== 1) continue
      await sessionDoRevokeAll(env, row.id)
      // 审计链 INSERT only:GC 也是身份资源变更,必须留痕(actor 为系统,不填 actorId)。
      await env.AUDIT_QUEUE.send({
        tenantId,
        action: 'guest.gc_deleted',
        ts: nowMs,
        payload: { targetType: 'user', targetId: row.id },
      })
    }
    if (rows.results.length < GUEST_GC_PAGE_SIZE) return
  }
}

// 每日扫全量 active tenant 的不活跃 guest 并软删(复用 eachActiveTenant 的租户分页)。
export async function gcInactiveGuests(env: Env, now: Date = new Date()): Promise<void> {
  const nowMs = now.getTime()
  const cutoffMs = nowMs - GUEST_GC_INACTIVE_DAYS * DAY_MS
  await eachActiveTenant(env, (tenantId) =>
    gcInactiveGuestsForTenant(env, tenantId, cutoffMs, nowMs),
  )
}
