// createTenantDb:真实 D1 mock 验证 tenant_id/org_id 注入与跨租户隔离。
import { describe, it, expect } from 'vitest'
import type { TenantContext } from '@xid-kit/types'
import { createTenantDb } from '../tenant-db'
import { makeStatefulD1, type Store } from './stateful-d1'

function makeCtx(tenantId: string): TenantContext {
  return {
    tenantId,
    issuer: 'https://xid.test',
    rpId: `${tenantId}.xid.test`,
    signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
    policy: {},
  }
}

describe('createTenantDb tenant isolation', () => {
  it('insert injects tenant_id from TenantContext', async () => {
    const store: Store = {}
    const db = createTenantDb(makeStatefulD1(store), makeCtx('tenant_a'))
    await db.users.insert({
      id: 'user_a',
      status: 'active',
      username: 'alice',
      locale: 'en',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never)

    const row = store['users']?.[0]
    expect(row?.['tenant_id']).toBe('tenant_a')
    expect(row?.['id']).toBe('user_a')
  })

  it('findMany returns only rows for bound tenant', async () => {
    const store: Store = {
      api_keys: [
        { id: 'key_a', tenant_id: 'tenant_a', name: 'A', status: 'active' },
        { id: 'key_b', tenant_id: 'tenant_b', name: 'B', status: 'active' },
      ],
    }
    const dbA = createTenantDb(makeStatefulD1(store), makeCtx('tenant_a'))
    const rows = await dbA.apiKeys.findMany()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe('key_a')
  })

  it('forOrg injects org_id and still scopes by tenant_id', async () => {
    const store: Store = {
      memberships: [
        { id: 'm1', tenant_id: 'tenant_a', org_id: 'org_a', user_id: 'user_a', status: 'active' },
        { id: 'm2', tenant_id: 'tenant_a', org_id: 'org_b', user_id: 'user_b', status: 'active' },
        { id: 'm3', tenant_id: 'tenant_b', org_id: 'org_a', user_id: 'user_c', status: 'active' },
      ],
    }
    const db = createTenantDb(makeStatefulD1(store), makeCtx('tenant_a'))
    const orgDb = db.forOrg('org_a')
    const rows = await orgDb.memberships.findMany()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe('m1')
  })

  it('cross-tenant db handle cannot read other tenant rows', async () => {
    const store: Store = {
      users: [{ id: 'user_b', tenant_id: 'tenant_b', status: 'active', username: 'bob' }],
    }
    const dbA = createTenantDb(makeStatefulD1(store), makeCtx('tenant_a'))
    const rows = await dbA.users.findMany()
    expect(rows).toHaveLength(0)
  })
})
