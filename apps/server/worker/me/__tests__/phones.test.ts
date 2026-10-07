// /v1/me/phones:短信码验证后才写 user_phones,不自动开启短信因子;移除时停用以它为目标的短信因子。

import { sha256Hex } from '@xid-kit/crypto'
import type { TenantContext } from '@xid-kit/types'
import { describe, expect, it, vi } from 'vitest'
import { makeRateLimitNs } from '../../me-auth/__tests__/helpers'
import { registerPhonesRoutes } from '../phones'
import { buildApp, makeSession, TENANT, TEST_PEPPER } from './harness'
import { seedOrganization, seedUser, SqliteD1 } from './sqlite-d1'

const SMS_TENANT: TenantContext = {
  ...TENANT,
  policy: {
    deliveryChannels: {
      sms: {
        provider: 'twilio',
        enabled: true,
        secretRefs: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'],
      },
    },
  },
} as TenantContext

function seed(): SqliteD1 {
  const db = new SqliteD1()
  seedOrganization(db, { id: 't_1', tenantId: 't_1' })
  seedOrganization(db, { id: 't_2', tenantId: 't_2' })
  seedUser(db, { id: 'u_1', tenantId: 't_1', primaryEmail: 'amara@northwind.test' })
  seedUser(db, { id: 'u_2', tenantId: 't_1' })
  seedUser(db, { id: 'u_9', tenantId: 't_2' })
  return db
}

function client(db: SqliteD1, tenant: TenantContext = SMS_TENANT) {
  const sms = vi.fn().mockResolvedValue(undefined)
  const env = {
    DB: db.asD1(),
    PEPPER: TEST_PEPPER,
    RATE_LIMITER: makeRateLimitNs(),
    SMS_QUEUE: { send: sms },
    AUDIT_QUEUE: { send: vi.fn().mockResolvedValue(undefined) },
    SMS_PROVIDER: 'twilio',
    TWILIO_ACCOUNT_SID: 'AC123',
    TWILIO_AUTH_TOKEN: 'token',
    SMS_FROM: '+15550000000',
  } as unknown as Env
  const app = buildApp({ register: registerPhonesRoutes, session: makeSession(), tenant })
  const call = (path: string, init: RequestInit & { json?: unknown } = {}) =>
    app.request(
      `https://acme.xid.dev/v1/me/phones${path}`,
      {
        ...init,
        headers: { 'content-type': 'application/json' },
        ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
      },
      env,
    )
  return { call, sms }
}

function seedPhone(
  db: SqliteD1,
  input: { id: string; tenantId: string; userId: string; phone: string },
): void {
  db.insert('user_phones', {
    id: input.id,
    tenant_id: input.tenantId,
    user_id: input.userId,
    phone: input.phone,
    verified: 1,
    verification_status: 'verified',
    is_primary: 1,
    verified_at: 1,
    created_at: 1,
    updated_at: 1,
  })
}

describe('/v1/me/phones', () => {
  it('reports whether a phone can be added from the tenant SMS channel', async () => {
    const db = seed()

    const ready = await client(db).call('')
    const notReady = await client(db, TENANT).call('')

    expect(await ready.json()).toEqual({ data: [], canAdd: true })
    expect(await notReady.json()).toEqual({ data: [], canAdd: false })
  })

  it('adds a phone after the text message code and does not enable SMS two-step verification', async () => {
    const db = seed()
    const { call, sms } = client(db)

    const added = await call('', { method: 'POST', json: { phone: '+1 (415) 555-0134' } })

    expect(added.status).toBe(202)
    const pending = (await added.json()) as { id: string; phone: string }
    expect(pending.phone).toBe('+14155550134')
    expect(sms).toHaveBeenCalledWith(expect.objectContaining({ recipient: '+14155550134' }))
    db.database
      .prepare('UPDATE verification_tokens SET code_hash = ? WHERE id = ?')
      .run(await sha256Hex('730266'), pending.id)

    const verified = await call(`/${pending.id}/verify`, {
      method: 'POST',
      json: { code: '730266' },
    })

    expect(verified.status).toBe(200)
    expect(db.rows("SELECT phone, verified FROM user_phones WHERE user_id = 'u_1'")).toEqual([
      { phone: '+14155550134', verified: 1 },
    ])
    expect(db.rows("SELECT id FROM mfa_factors WHERE user_id = 'u_1'")).toEqual([])
  })

  it('rejects numbers outside the allowed country prefixes', async () => {
    const db = seed()

    const res = await client(db).call('', { method: 'POST', json: { phone: '+351 912 345 678' } })

    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ meta: { paramName: 'phone' } })
  })

  it('removes a phone and retires the SMS factor that targets it', async () => {
    const db = seed()
    seedPhone(db, { id: 'ph_1', tenantId: 't_1', userId: 'u_1', phone: '+14155550134' })
    db.insert('mfa_factors', {
      id: 'mfa_sms',
      tenant_id: 't_1',
      user_id: 'u_1',
      factor_type: 'sms',
      status: 'active',
      target: 'ph_1',
      is_default: 0,
      created_at: 1,
      updated_at: 1,
    })

    const res = await client(db).call('/ph_1', { method: 'DELETE' })

    expect(res.status).toBe(204)
    expect(db.rows("SELECT id FROM user_phones WHERE id = 'ph_1'")).toEqual([])
    expect(db.rows("SELECT status FROM mfa_factors WHERE id = 'mfa_sms'")).toEqual([
      { status: 'revoked' },
    ])
  })

  it('returns 404 for a phone of another user or tenant', async () => {
    const db = seed()
    seedPhone(db, { id: 'ph_2', tenantId: 't_1', userId: 'u_2', phone: '+14155550001' })
    seedPhone(db, { id: 'ph_9', tenantId: 't_2', userId: 'u_9', phone: '+14155550002' })

    for (const id of ['ph_2', 'ph_9']) {
      expect((await client(db).call(`/${id}`, { method: 'DELETE' })).status).toBe(404)
    }
    expect(db.rows('SELECT id FROM user_phones ORDER BY id')).toHaveLength(2)
  })
})
