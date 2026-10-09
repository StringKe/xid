// DELETE /v1/users/:id/passkeys/:passkeyId:管理员吊销单个 passkey(设备丢失或被盗)。
// 凭证只设 revoked_at 不删除;随后撤销该用户全部会话与令牌,持被盗设备建立的会话一并失效。
// 用户之后用其他登录方式或管理员邀请重新登记 passkey。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, eq, isNull } from 'drizzle-orm'
import type { Hono } from 'hono'
import { AppError } from '../lib/errors'
import { retireSupplementaryFactorsWithoutStrongFactor } from '../lib/mfa-methods'
import { revokeUserCredentials } from '../lib/revoke-user-credentials'
import type { XidHonoEnv } from '../lib/types'
import { auditActorId, requireApiKeyOrTopLevelOrgManager } from './shared'
import { auditAdminAction, findTenantUser } from './user-admin-shared'
import { assertUserActionAllowed } from './user-query'

export const USER_PASSKEY_REVOKED_EVENT = 'user.passkey_revoked'

export function registerUserPasskeyRoutes(app: Hono<XidHonoEnv>): void {
  app.delete('/:id/passkeys/:passkeyId', async (c) => {
    const auth = await requireApiKeyOrTopLevelOrgManager(c, 'users:write')
    const tenant = c.get('tenant')
    const db = createTenantDb(c.env.DB, tenant)
    const user = await findTenantUser(db, c.req.param('id'), { includeDeleted: false })
    await assertUserActionAllowed(db, auth, user.id)

    const revoked = await db.passkeyCredentials.update(
      { revokedAt: new Date() },
      and(
        eq(schema.passkeyCredentials.id, c.req.param('passkeyId')),
        eq(schema.passkeyCredentials.userId, user.id),
        isNull(schema.passkeyCredentials.revokedAt),
      ),
    )
    if (revoked.length === 0) throw new AppError('not_found', { httpStatus: 404 })

    await retireSupplementaryFactorsWithoutStrongFactor(db, user.id)
    await revokeUserCredentials(c.env, tenant, user.id)
    auditAdminAction(c, {
      action: USER_PASSKEY_REVOKED_EVENT,
      actorId: auditActorId(auth),
      userId: user.id,
    })
    return new Response(null, { status: 204 })
  })
}
