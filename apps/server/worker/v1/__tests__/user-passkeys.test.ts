// DELETE /v1/users/:id/passkeys/:passkeyId:管理员吊销单个 passkey,撤销会话并写审计。
// 跨租户用例在 isolation.test.ts。

import { describe, expect, it, vi } from 'vitest'
import { schema } from '@xid-kit/db'
import { eq } from 'drizzle-orm'
import { registerUsersRoutes } from '../users'
import {
  buildApp,
  envOf,
  makeDb,
  seedApiKey,
  seedOrg,
  seedUser,
  tenantDb,
} from './console-fixtures'

vi.mock('../../lib/management-access', () => ({
  requireVerifiedManagementMutation: async () => undefined,
}))

const BASE = 'https://acme.xid.dev/v1'

async function seed(scopes: string[] = ['users:write']) {
  const d1 = makeDb()
  await seedOrg(d1, { id: 't_a' })
  await seedUser(d1, { id: 'user_ravi', email: 'ravi.shankar@northwind.com' })
  const db = tenantDb(d1)
  for (const id of ['pk_laptop', 'pk_phone']) {
    await db.passkeyCredentials.insert({
      id,
      tenantId: 't_a',
      userId: 'user_ravi',
      credentialId: `cred_${id}`,
      publicKey: Buffer.from([1]),
      coseAlg: -7,
      aaguid: Buffer.alloc(16),
      credentialDeviceType: 'multiDevice',
    })
  }
  const token = await seedApiKey(d1, { id: 'ak_users', scopes })
  return { d1, db, token }
}

function revoke(token: string, env: Env, passkeyId: string): Promise<Response> {
  return buildApp(registerUsersRoutes).request(
    `${BASE}/users/user_ravi/passkeys/${passkeyId}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
    env,
  )
}

describe('DELETE /v1/users/:id/passkeys/:passkeyId', () => {
  it('revokes only the selected passkey, revokes sessions and audits the action', async () => {
    const { d1, db, token } = await seed()
    const env = envOf(d1)

    const res = await revoke(token, env, 'pk_laptop')

    expect(res.status).toBe(204)
    const laptop = await db.passkeyCredentials.findOne(
      eq(schema.passkeyCredentials.id, 'pk_laptop'),
    )
    const phone = await db.passkeyCredentials.findOne(eq(schema.passkeyCredentials.id, 'pk_phone'))
    expect(laptop?.revokedAt).toBeInstanceOf(Date)
    expect(phone?.revokedAt).toBeNull()
    expect(env.sessionRevocations).toContain('session:user_ravi')
    expect(env.auditSend).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user.passkey_revoked' }),
    )
  })

  it('returns 404 for a passkey that is already revoked', async () => {
    const { d1, token } = await seed()
    const env = envOf(d1)
    await revoke(token, env, 'pk_laptop')

    const again = await revoke(token, envOf(d1), 'pk_laptop')

    expect(again.status).toBe(404)
  })

  it('rejects a key without users:write', async () => {
    const { d1, db, token } = await seed(['users:read'])

    const res = await revoke(token, envOf(d1), 'pk_laptop')

    expect(res.status).toBe(403)
    const laptop = await db.passkeyCredentials.findOne(
      eq(schema.passkeyCredentials.id, 'pk_laptop'),
    )
    expect(laptop?.revokedAt).toBeNull()
  })
})
