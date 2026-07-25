// GET /v1/me/trusted-devices 测试:happy path(指纹脱敏)+ 过期过滤 + 401 + 跨租户隔离。
// device_token_hash / fingerprint 明文不外泄;只列 revoked_at IS NULL 且未过期。

import { describe, it, expect } from 'vitest'
import { registerTrustedDevicesRoutes } from '../trusted-devices'
import { buildApp, makeFakeD1, makeSession } from './harness'

const now = Date.now()
const future = now + 24 * 60 * 60 * 1000
const past = now - 24 * 60 * 60 * 1000

function deviceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'td_1',
    tenant_id: 't_1',
    user_id: 'u_1',
    device_token_hash: 'secret-token-hash-value',
    fingerprint_hash: 'abcdef0123456789longfingerprint',
    device_name: 'iPhone',
    last_seen_ip: '1.2.3.4',
    last_seen_at: now,
    expires_at: future,
    revoked_at: null,
    created_at: now,
    ...overrides,
  }
}

describe('GET /v1/me/trusted-devices', () => {
  it('returns active devices with masked fingerprint, without token hash', async () => {
    const db = makeFakeD1({ trusted_devices: [deviceRow()] })
    const env = { DB: db } as unknown as Env
    const app = buildApp({
      register: registerTrustedDevicesRoutes,
      session: makeSession({ userId: 'u_1' }),
    })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/trusted-devices',
      { method: 'GET' },
      env,
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>[]
    expect(body).toHaveLength(1)
    expect(body[0]).toMatchObject({ id: 'td_1', deviceName: 'iPhone' })
    // 指纹只回脱敏前缀,不外泄完整哈希。
    expect(body[0]?.['fingerprint']).toBe('abcdef01...')
    expect(body[0]).not.toHaveProperty('deviceTokenHash')
    expect(body[0]).not.toHaveProperty('fingerprintHash')
  })

  it('filters out expired devices', async () => {
    const db = makeFakeD1({ trusted_devices: [deviceRow({ id: 'td_expired', expires_at: past })] })
    const env = { DB: db } as unknown as Env
    const app = buildApp({
      register: registerTrustedDevicesRoutes,
      session: makeSession({ userId: 'u_1' }),
    })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/trusted-devices',
      { method: 'GET' },
      env,
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('returns 401 when no session cookie present', async () => {
    const db = makeFakeD1({ trusted_devices: [deviceRow()] })
    const env = { DB: db } as unknown as Env
    const app = buildApp({ register: registerTrustedDevicesRoutes, session: null })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/trusted-devices',
      { method: 'GET' },
      env,
    )

    expect(res.status).toBe(401)
  })

  it('does not list another tenant devices (cross-tenant -> empty list)', async () => {
    const db = makeFakeD1({
      trusted_devices: [deviceRow({ id: 'td_victim', tenant_id: 't_other', user_id: 'u_victim' })],
    })
    const env = { DB: db } as unknown as Env
    const app = buildApp({
      register: registerTrustedDevicesRoutes,
      session: makeSession({ userId: 'u_1' }),
    })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/trusted-devices',
      { method: 'GET' },
      env,
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })
})

describe('DELETE /v1/me/trusted-devices/:id', () => {
  it('revokes current user trusted device', async () => {
    const row = deviceRow()
    const db = makeFakeD1({ trusted_devices: [row] })
    const env = { DB: db } as unknown as Env
    const app = buildApp({
      register: registerTrustedDevicesRoutes,
      session: makeSession({ userId: 'u_1' }),
    })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/trusted-devices/td_1',
      { method: 'DELETE' },
      env,
    )

    expect(res.status).toBe(204)
    expect(row['revoked_at']).toBeTypeOf('number')
  })

  it('does not revoke another user trusted device', async () => {
    const row = deviceRow({ id: 'td_2', user_id: 'u_2' })
    const db = makeFakeD1({ trusted_devices: [row] })
    const env = { DB: db } as unknown as Env
    const app = buildApp({
      register: registerTrustedDevicesRoutes,
      session: makeSession({ userId: 'u_1' }),
    })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/trusted-devices/td_2',
      { method: 'DELETE' },
      env,
    )

    expect(res.status).toBe(404)
    expect(row['revoked_at']).toBeNull()
  })
})
