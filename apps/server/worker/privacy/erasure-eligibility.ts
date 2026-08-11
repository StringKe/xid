import { AppError } from '../lib/errors'

type PrivacyErasureEligibilityRow = {
  blocksOwnerErasure: number
  blocksInstanceManagerErasure: number
}

export type PrivacyErasureEligibility = {
  blocksOwnerErasure: boolean
  blocksInstanceManagerErasure: boolean
}

// 擦除会删掉 owner 身份:须已有另一 active owner,且查询保持 tenant 范围。
const BLOCKS_OWNER_ERASURE_SQL = `EXISTS (
  SELECT 1
    FROM memberships target_owner
   WHERE target_owner.tenant_id = ?
     AND target_owner.user_id = ?
     AND target_owner.role = 'owner'
     AND target_owner.status = 'active'
     AND NOT EXISTS (
       SELECT 1
         FROM memberships replacement_owner
         JOIN users replacement_user
           ON replacement_user.tenant_id = replacement_owner.tenant_id
          AND replacement_user.id = replacement_owner.user_id
        WHERE replacement_owner.tenant_id = target_owner.tenant_id
          AND replacement_owner.org_id = target_owner.org_id
          AND replacement_owner.user_id <> target_owner.user_id
          AND replacement_owner.role = 'owner'
          AND replacement_owner.status = 'active'
          AND replacement_user.status = 'active'
          AND replacement_user.deleted_at IS NULL
     )
)`

// 目标 assignment 限擦除租户;替代 instance_manager 可跨租户但必须是另一 active 用户。
const BLOCKS_INSTANCE_MANAGER_ERASURE_SQL = `EXISTS (
  SELECT 1
    FROM manager_assignments target_manager
    JOIN users target_user
      ON target_user.tenant_id = target_manager.tenant_id
     AND target_user.id = target_manager.user_id
   WHERE target_manager.tenant_id = ?
     AND target_manager.user_id = ?
     AND target_manager.manager_role = 'instance_manager'
     AND target_manager.scope_type = 'instance'
     AND target_user.status = 'active'
     AND target_user.deleted_at IS NULL
     AND NOT EXISTS (
       SELECT 1
         FROM manager_assignments replacement_manager
         JOIN users replacement_user
           ON replacement_user.tenant_id = replacement_manager.tenant_id
          AND replacement_user.id = replacement_manager.user_id
        WHERE replacement_manager.user_id <> target_manager.user_id
          AND replacement_manager.manager_role = 'instance_manager'
          AND replacement_manager.scope_type = 'instance'
          AND (
            replacement_manager.scope_id = target_manager.scope_id
            OR (
              replacement_manager.scope_id IS NULL
              AND target_manager.scope_id IS NULL
            )
          )
          AND replacement_user.status = 'active'
          AND replacement_user.deleted_at IS NULL
     )
)`

export const PRIVACY_ERASURE_ELIGIBLE_SQL = `NOT (${BLOCKS_OWNER_ERASURE_SQL})
  AND NOT (${BLOCKS_INSTANCE_MANAGER_ERASURE_SQL})`

export function privacyErasureEligibilityBindings(
  tenantId: string,
  userId: string,
): [string, string, string, string] {
  return [tenantId, userId, tenantId, userId]
}

export async function readPrivacyErasureEligibility(
  env: Env,
  tenantId: string,
  userId: string,
): Promise<PrivacyErasureEligibility> {
  const row = await env.DB.prepare(
    `SELECT CASE WHEN ${BLOCKS_OWNER_ERASURE_SQL} THEN 1 ELSE 0 END AS blocksOwnerErasure,
            CASE WHEN ${BLOCKS_INSTANCE_MANAGER_ERASURE_SQL}
                 THEN 1 ELSE 0 END AS blocksInstanceManagerErasure`,
  )
    .bind(...privacyErasureEligibilityBindings(tenantId, userId))
    .first<PrivacyErasureEligibilityRow>()
  if (!row) throw new AppError('server_error')
  return {
    blocksOwnerErasure: row.blocksOwnerErasure === 1,
    blocksInstanceManagerErasure: row.blocksInstanceManagerErasure === 1,
  }
}

export async function requirePrivacyErasureEligibility(
  env: Env,
  tenantId: string,
  userId: string,
): Promise<void> {
  const eligibility = await readPrivacyErasureEligibility(env, tenantId, userId)
  if (eligibility.blocksOwnerErasure || eligibility.blocksInstanceManagerErasure) {
    // 自助端点不区分阻塞原因,避免泄露平台角色。
    throw new AppError('conflict', { httpStatus: 409 })
  }
}

export function preparePrivacyErasureAtomicGuard(
  env: Env,
  input: { requestId: string; tenantId: string; userId: string },
): D1PreparedStatement {
  // id NOT NULL:请求仍存在且可擦除时 SELECT 无行,否则首条 INSERT 触发 NULL 断言,整批原子回滚。
  return env.DB.prepare(
    `INSERT INTO privacy_requests (
       id, tenant_id, user_id, request_type, status, created_at, updated_at
     )
     SELECT NULL, ?, ?, 'delete', 'processing', 0, 0
      WHERE NOT EXISTS (
        SELECT 1
          FROM privacy_requests
         WHERE id = ? AND tenant_id = ? AND user_id = ?
           AND request_type = 'delete' AND status = 'processing'
           AND ${PRIVACY_ERASURE_ELIGIBLE_SQL}
      )`,
  ).bind(
    input.tenantId,
    input.userId,
    input.requestId,
    input.tenantId,
    input.userId,
    ...privacyErasureEligibilityBindings(input.tenantId, input.userId),
  )
}
