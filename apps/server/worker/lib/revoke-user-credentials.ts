// 撤销用户全部登录凭据:SessionDO(真相源)-> D1 sessions(含 pending MFA)-> access token denylist
// -> refresh token family。凭据变更(重置/修改密码)和 SCIM 停用共用。
// 三条 D1 写入同一 batch:family 栅栏与 denylist 同时生效,并发轮换只能落在 batch 之前并被一起撤销。

import type { TenantContext } from '@xid-kit/types'
import { sessionDoRevokeAll, sessionDoRevokeAllExcept } from './session'

export async function revokeUserCredentials(
  env: Env,
  tenant: TenantContext,
  userId: string,
  options: { keepSessionId?: string } = {},
): Promise<void> {
  const { keepSessionId } = options
  if (keepSessionId) await sessionDoRevokeAllExcept(env, userId, keepSessionId)
  else await sessionDoRevokeAll(env, userId)

  const now = Date.now()
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE sessions
          SET status = 'revoked'
        WHERE tenant_id = ?
          AND user_id = ?
          AND status IN ('active', 'pending_mfa', 'pending_mfa_setup')
          AND id != ?`,
    ).bind(tenant.tenantId, userId, keepSessionId ?? ''),
    env.DB.prepare(
      `INSERT OR IGNORE INTO access_token_revocations (
         id, tenant_id, jti, client_id, subject, expires_at, revoked_at, created_at
       ) SELECT lower(hex(randomblob(16))), tenant_id, jti, client_id, subject, expires_at, ?, ?
           FROM access_token_issuances
          WHERE tenant_id = ? AND subject = ? AND expires_at > ?`,
    ).bind(now, now, tenant.tenantId, userId, now),
    env.DB.prepare(
      `UPDATE refresh_tokens
          SET revoked_at = COALESCE(revoked_at, ?), family_revoked_at = ?
        WHERE tenant_id = ?
          AND user_id = ?
          AND family_revoked_at IS NULL`,
    ).bind(now, now, tenant.tenantId, userId),
  ])
}
