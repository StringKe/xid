// GET /v1/me/social-connections 测试:happy path(email 来自 profile_raw)+ 401 + 跨租户隔离。
// token 密文(access/refresh)不外泄;只列 identity_type='oauth'。

import { describe, it, expect } from 'vitest'
import { registerSocialConnectionsRoutes } from '../social-connections'
import { buildApp, makeFakeD1, makeSession } from './harness'

const now = Date.now()

function identityRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'id_1',
    tenant_id: 't_1',
    user_id: 'u_1',
    identity_type: 'oauth',
    provider: 'google',
    provider_user_id: 'g-12345',
    access_token_ciphertext: new Uint8Array([1, 2]),
    refresh_token_ciphertext: new Uint8Array([3, 4]),
    token_expires_at: now,
    scopes: '["email","profile"]',
    profile_raw: JSON.stringify({ email: 'ada@gmail.com' }),
    last_used_at: now,
    created_at: now,
    updated_at: now,
    ...overrides,
  }
}

describe('GET /v1/me/social-connections', () => {
  it('returns connections with provider account id and email, without token ciphertext', async () => {
    const db = makeFakeD1({ user_identities: [identityRow()] })
    const env = { DB: db } as unknown as Env
    const app = buildApp({
      register: registerSocialConnectionsRoutes,
      session: makeSession({ userId: 'u_1' }),
    })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/social-connections',
      { method: 'GET' },
      env,
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>[]
    expect(body[0]).toMatchObject({
      id: 'id_1',
      provider: 'google',
      providerAccountId: 'g-12345',
      email: 'ada@gmail.com',
    })
    expect(body[0]).not.toHaveProperty('accessTokenCiphertext')
    expect(body[0]).not.toHaveProperty('refreshTokenCiphertext')
  })

  it('returns 401 when no session cookie present', async () => {
    const db = makeFakeD1({ user_identities: [identityRow()] })
    const env = { DB: db } as unknown as Env
    const app = buildApp({ register: registerSocialConnectionsRoutes, session: null })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/social-connections',
      { method: 'GET' },
      env,
    )

    expect(res.status).toBe(401)
  })

  it('does not list another tenant connections (cross-tenant -> empty list)', async () => {
    const db = makeFakeD1({
      user_identities: [
        identityRow({ id: 'id_victim', tenant_id: 't_other', user_id: 'u_victim' }),
      ],
    })
    const env = { DB: db } as unknown as Env
    const app = buildApp({
      register: registerSocialConnectionsRoutes,
      session: makeSession({ userId: 'u_1' }),
    })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/social-connections',
      { method: 'GET' },
      env,
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })
})

describe('DELETE /v1/me/social-connections/:id', () => {
  it('revokes current user social connection', async () => {
    const row = identityRow()
    const db = makeFakeD1({ user_identities: [row] })
    const env = { DB: db } as unknown as Env
    const app = buildApp({
      register: registerSocialConnectionsRoutes,
      session: makeSession({ userId: 'u_1' }),
    })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/social-connections/id_1',
      { method: 'DELETE' },
      env,
    )

    expect(res.status).toBe(204)
    expect(row['revoked_at']).toBeTypeOf('number')
  })

  it('does not revoke another user social connection', async () => {
    const row = identityRow({ id: 'id_2', user_id: 'u_2' })
    const db = makeFakeD1({ user_identities: [row] })
    const env = { DB: db } as unknown as Env
    const app = buildApp({
      register: registerSocialConnectionsRoutes,
      session: makeSession({ userId: 'u_1' }),
    })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/social-connections/id_2',
      { method: 'DELETE' },
      env,
    )

    expect(res.status).toBe(404)
    expect(row['revoked_at']).toBeUndefined()
  })
})
