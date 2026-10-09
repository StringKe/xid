// persistent NameID 持久化映射:同一 SP 稳定、不同 SP 不同、跨租户隔离、并发首签读回同一值。
import type { TenantContext } from '@xid-kit/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { SqliteD1 } from '../../me/__tests__/sqlite-d1'
import { resolvePersistentNameId } from '../outbound-saml-persistent-name-id'

function tenant(tenantId: string): TenantContext {
  return { tenantId, issuer: 'https://xid.test' } as TenantContext
}

let db: SqliteD1

beforeEach(() => {
  db = new SqliteD1()
})

describe('resolvePersistentNameId', () => {
  it('returns the same random value for every sign-in to the same SP', async () => {
    const first = await resolvePersistentNameId(db.asD1(), tenant('tenant_a'), {
      spId: 'sp_1',
      userId: 'user_1',
    })
    const second = await resolvePersistentNameId(db.asD1(), tenant('tenant_a'), {
      spId: 'sp_1',
      userId: 'user_1',
    })

    expect(second).toBe(first)
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(first).not.toContain('user_1')
  })

  it('issues unrelated values to different SPs for the same user', async () => {
    const one = await resolvePersistentNameId(db.asD1(), tenant('tenant_a'), {
      spId: 'sp_1',
      userId: 'user_1',
    })
    const two = await resolvePersistentNameId(db.asD1(), tenant('tenant_a'), {
      spId: 'sp_2',
      userId: 'user_1',
    })

    expect(two).not.toBe(one)
  })

  it('keeps tenants isolated even with identical SP and user ids', async () => {
    const a = await resolvePersistentNameId(db.asD1(), tenant('tenant_a'), {
      spId: 'sp_1',
      userId: 'user_1',
    })
    const b = await resolvePersistentNameId(db.asD1(), tenant('tenant_b'), {
      spId: 'sp_1',
      userId: 'user_1',
    })

    expect(b).not.toBe(a)
    expect(
      db.rows('SELECT tenant_id, name_id FROM saml_persistent_name_ids ORDER BY tenant_id'),
    ).toEqual([
      { tenant_id: 'tenant_a', name_id: a },
      { tenant_id: 'tenant_b', name_id: b },
    ])
  })

  it('resolves concurrent first sign-ins to a single stored value', async () => {
    const values = await Promise.all(
      Array.from({ length: 5 }, () =>
        resolvePersistentNameId(db.asD1(), tenant('tenant_a'), { spId: 'sp_1', userId: 'user_1' }),
      ),
    )

    expect(new Set(values).size).toBe(1)
    expect(db.rows('SELECT COUNT(*) AS n FROM saml_persistent_name_ids')).toEqual([{ n: 1 }])
  })
})
