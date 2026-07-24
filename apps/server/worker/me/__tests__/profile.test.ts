// GET / PATCH /v1/me/profile 测试:happy path(camelCase 形状)+ cookie 缺失 401 + 跨租户隔离。
// 跨租户:session 用户在 t_1,但目标 users 行 tenant_id=t_other -> 查询层注入 tenant_id=t_1 查不到 -> 401(不泄露存在性)。

import { describe, it, expect } from 'vitest'
import { registerProfileRoutes } from '../profile'
import { buildApp, makeFakeD1, makeSession } from './harness'

const now = Date.now()

function userRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'u_1',
    tenant_id: 't_1',
    username: null,
    external_id: null,
    primary_email_id: 'em_1',
    primary_phone_id: null,
    first_name: 'Ada',
    last_name: 'Lovelace',
    display_name: 'Ada L.',
    avatar_url: 'https://cdn/a.png',
    locale: 'en',
    timezone: 'UTC',
    public_metadata: '{}',
    private_metadata: '{}',
    unsafe_metadata: '{}',
    custom_attributes: '{}',
    status: 'active',
    password_change_required: 0,
    is_new_user: 0,
    profile_completion_status: 'complete',
    lockout_until: null,
    failed_login_count: 0,
    last_login_at: null,
    merged_into_user_id: null,
    provisioned_by: null,
    deleted_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  }
}

function emailRow(): Record<string, unknown> {
  return {
    id: 'em_1',
    tenant_id: 't_1',
    user_id: 'u_1',
    email: 'ada@example.com',
    verified: 1,
    verification_status: 'verified',
    is_primary: 1,
    verified_at: now,
    created_at: now,
    updated_at: now,
  }
}

describe('GET /v1/me/profile', () => {
  it('returns camelCase profile with primary email for authenticated user', async () => {
    const db = makeFakeD1({ users: [userRow()], user_emails: [emailRow()] })
    const env = { DB: db } as unknown as Env
    const app = buildApp({
      register: registerProfileRoutes,
      session: makeSession({ userId: 'u_1' }),
    })

    const res = await app.request('https://acme.xid.dev/v1/me/profile', { method: 'GET' }, env)

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toMatchObject({
      id: 'u_1',
      firstName: 'Ada',
      lastName: 'Lovelace',
      displayName: 'Ada L.',
      email: 'ada@example.com',
      emailVerified: true,
      imageUrl: 'https://cdn/a.png',
      locale: 'en',
      timezone: 'UTC',
    })
  })

  it('returns 401 when no session cookie present', async () => {
    const db = makeFakeD1({ users: [userRow()], user_emails: [emailRow()] })
    const env = { DB: db } as unknown as Env
    const app = buildApp({ register: registerProfileRoutes, session: null })

    const res = await app.request('https://acme.xid.dev/v1/me/profile', { method: 'GET' }, env)

    expect(res.status).toBe(401)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['code']).toBe('unauthorized')
  })

  it('does not leak another tenant user (cross-tenant -> 401, not found via tenant scope)', async () => {
    // session 是 t_1 的用户 u_victim,但 u_victim 行实际归属 t_other -> 查询层注入 tenant_id=t_1 查不到。
    const db = makeFakeD1({
      users: [userRow({ id: 'u_victim', tenant_id: 't_other' })],
      user_emails: [],
    })
    const env = { DB: db } as unknown as Env
    const app = buildApp({
      register: registerProfileRoutes,
      session: makeSession({ userId: 'u_victim' }),
    })

    const res = await app.request('https://acme.xid.dev/v1/me/profile', { method: 'GET' }, env)

    expect(res.status).toBe(401)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['code']).toBe('unauthorized')
  })

  it('returns 401 when session user has been soft deleted', async () => {
    const db = makeFakeD1({
      users: [userRow({ deleted_at: now, status: 'deleted' })],
      user_emails: [emailRow()],
    })
    const env = { DB: db } as unknown as Env
    const app = buildApp({
      register: registerProfileRoutes,
      session: makeSession({ userId: 'u_1' }),
    })

    const res = await app.request('https://acme.xid.dev/v1/me/profile', { method: 'GET' }, env)

    expect(res.status).toBe(401)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['code']).toBe('unauthorized')
  })
})

describe('PATCH /v1/me/profile', () => {
  it('updates whitelisted fields and returns camelCase profile', async () => {
    const db = makeFakeD1({
      users: [userRow({ display_name: 'New Name' })],
      user_emails: [emailRow()],
    })
    const env = { DB: db } as unknown as Env
    const app = buildApp({
      register: registerProfileRoutes,
      session: makeSession({ userId: 'u_1' }),
    })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/profile',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'New Name', firstName: null }),
      },
      env,
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['displayName']).toBe('New Name')
    expect(body['email']).toBe('ada@example.com')
  })

  it('rejects non-string field with 422 + paramName', async () => {
    const db = makeFakeD1({ users: [userRow()], user_emails: [emailRow()] })
    const env = { DB: db } as unknown as Env
    const app = buildApp({
      register: registerProfileRoutes,
      session: makeSession({ userId: 'u_1' }),
    })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/profile',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ firstName: 42 }),
      },
      env,
    )

    expect(res.status).toBe(422)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['code']).toBe('validation_failed')
    expect((body['meta'] as Record<string, unknown>)['paramName']).toBe('firstName')
  })

  it('returns 401 when no session cookie present', async () => {
    const db = makeFakeD1({ users: [userRow()], user_emails: [emailRow()] })
    const env = { DB: db } as unknown as Env
    const app = buildApp({ register: registerProfileRoutes, session: null })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/profile',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'x' }),
      },
      env,
    )

    expect(res.status).toBe(401)
  })

  it('does not update profile when session user has been soft deleted', async () => {
    const db = makeFakeD1({
      users: [userRow({ deleted_at: now, status: 'deleted', display_name: 'Deleted' })],
      user_emails: [emailRow()],
    })
    const env = { DB: db } as unknown as Env
    const app = buildApp({
      register: registerProfileRoutes,
      session: makeSession({ userId: 'u_1' }),
    })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/profile',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'Should Not Update' }),
      },
      env,
    )

    expect(res.status).toBe(401)
  })
})
