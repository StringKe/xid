// GET /v1/me/passkeys 测试:happy path(剔除 public_key/aaguid/sign_count)+ 401 + 跨租户隔离。

import { describe, it, expect } from 'vitest'
import { registerPasskeysRoutes } from '../passkeys'
import { buildApp, makeFakeD1, makeSession } from './harness'

const now = Date.now()

function passkeyRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'pk_1',
    tenant_id: 't_1',
    user_id: 'u_1',
    credential_id: 'cred_abc',
    public_key: new Uint8Array([1, 2, 3]),
    cose_alg: -7,
    aaguid: new Uint8Array([0, 0, 0, 0]),
    sign_count: 5,
    transports: '["internal","hybrid"]',
    credential_device_type: 'multiDevice',
    backed_up: 1,
    device_name: 'MacBook',
    attestation_fmt: 'none',
    last_used_at: now,
    created_at: now,
    updated_at: now,
    ...overrides,
  }
}

describe('GET /v1/me/passkeys', () => {
  it('returns passkeys without public key / aaguid / sign count', async () => {
    const db = makeFakeD1({ passkey_credentials: [passkeyRow()] })
    const env = { DB: db } as unknown as Env
    const app = buildApp({
      register: registerPasskeysRoutes,
      session: makeSession({ userId: 'u_1' }),
    })

    const res = await app.request('https://acme.xid.dev/v1/me/passkeys', { method: 'GET' }, env)

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>[]
    expect(body).toHaveLength(1)
    expect(body[0]).toMatchObject({
      id: 'pk_1',
      deviceName: 'MacBook',
      transports: ['internal', 'hybrid'],
    })
    expect(body[0]).not.toHaveProperty('publicKey')
    expect(body[0]).not.toHaveProperty('aaguid')
    expect(body[0]).not.toHaveProperty('signCount')
  })

  it('returns 401 when no session cookie present', async () => {
    const db = makeFakeD1({ passkey_credentials: [passkeyRow()] })
    const env = { DB: db } as unknown as Env
    const app = buildApp({ register: registerPasskeysRoutes, session: null })

    const res = await app.request('https://acme.xid.dev/v1/me/passkeys', { method: 'GET' }, env)

    expect(res.status).toBe(401)
  })

  it('does not list another tenant passkeys (cross-tenant -> empty list)', async () => {
    // passkey 归属 t_other 用户 u_victim;当前 session 用户 u_1@t_1 -> 查询层注入 tenant_id=t_1 查不到。
    const db = makeFakeD1({
      passkey_credentials: [
        passkeyRow({ id: 'pk_victim', tenant_id: 't_other', user_id: 'u_victim' }),
      ],
    })
    const env = { DB: db } as unknown as Env
    const app = buildApp({
      register: registerPasskeysRoutes,
      session: makeSession({ userId: 'u_1' }),
    })

    const res = await app.request('https://acme.xid.dev/v1/me/passkeys', { method: 'GET' }, env)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })
})

describe('PATCH / DELETE /v1/me/passkeys/:id', () => {
  it('renames current user passkey and returns safe view', async () => {
    const row = passkeyRow()
    const db = makeFakeD1({ passkey_credentials: [row] })
    const env = { DB: db } as unknown as Env
    const app = buildApp({
      register: registerPasskeysRoutes,
      session: makeSession({ userId: 'u_1' }),
    })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/passkeys/pk_1',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceName: 'Work Mac' }),
      },
      env,
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['deviceName']).toBe('Work Mac')
    expect(row['device_name']).toBe('Work Mac')
  })

  it('revokes current user passkey instead of physical delete', async () => {
    const row = passkeyRow()
    const db = makeFakeD1({ passkey_credentials: [row] })
    const env = { DB: db } as unknown as Env
    const app = buildApp({
      register: registerPasskeysRoutes,
      session: makeSession({ userId: 'u_1' }),
    })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/passkeys/pk_1',
      { method: 'DELETE' },
      env,
    )

    expect(res.status).toBe(204)
    expect(row['revoked_at']).toBeTypeOf('number')
  })

  it('does not rename another user passkey', async () => {
    const row = passkeyRow({ id: 'pk_2', user_id: 'u_2' })
    const db = makeFakeD1({ passkey_credentials: [row] })
    const env = { DB: db } as unknown as Env
    const app = buildApp({
      register: registerPasskeysRoutes,
      session: makeSession({ userId: 'u_1' }),
    })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/passkeys/pk_2',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceName: 'Blocked' }),
      },
      env,
    )

    expect(res.status).toBe(404)
    expect(row['device_name']).toBe('MacBook')
  })
})
