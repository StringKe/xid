// GET /v1/me/sessions + POST /v1/me/sessions/revoke-all 测试:
// happy path(camelCase + isCurrent 标记)+ revoke-all 保留当前(命中 per-user SessionDO)+ 401 + 跨租户隔离。
// refresh_token_hash 不外泄;指纹脱敏;只列 active 且未过期。

import { describe, it, expect } from 'vitest'
import { registerMeSessionsRoutes } from '../sessions'
import { buildApp, makeFakeD1, makeFakeSessionNs, makeSession } from './harness'

const now = Date.now()
const future = now + 60 * 60 * 1000

function sessionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 's_1',
    tenant_id: 't_1',
    user_id: 'u_1',
    refresh_token_hash: 'do-not-leak-hash',
    active_org_id: null,
    device_fingerprint_hash: 'fingerprintabcdef0123',
    device_name: 'Chrome',
    user_agent: 'UA',
    ip: '9.9.9.9',
    location: null,
    status: 'active',
    remember_me: 0,
    is_impersonation: 0,
    impersonator_user_id: null,
    authenticated_at: now,
    last_active_at: now,
    expires_at: future,
    created_at: now,
    ...overrides,
  }
}

describe('GET /v1/me/sessions', () => {
  it('returns active sessions with isCurrent and without refresh token hash', async () => {
    const db = makeFakeD1({
      sessions: [
        sessionRow({ id: 's_current' }),
        sessionRow({ id: 's_other', device_name: 'Firefox' }),
      ],
    })
    const env = { DB: db } as unknown as Env
    const app = buildApp({
      register: registerMeSessionsRoutes,
      session: makeSession({ sessionId: 's_current', userId: 'u_1' }),
    })

    const res = await app.request('https://acme.xid.dev/v1/me/sessions', { method: 'GET' }, env)

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>[]
    const current = body.find((s) => s['id'] === 's_current')
    const other = body.find((s) => s['id'] === 's_other')
    expect(current?.['isCurrent']).toBe(true)
    expect(other?.['isCurrent']).toBe(false)
    expect(current).not.toHaveProperty('refreshTokenHash')
    // 指纹脱敏。
    expect(current?.['deviceFingerprint']).toBe('fingerpr...')
  })

  it('returns 401 when no session cookie present', async () => {
    const db = makeFakeD1({ sessions: [sessionRow()] })
    const env = { DB: db } as unknown as Env
    const app = buildApp({ register: registerMeSessionsRoutes, session: null })

    const res = await app.request('https://acme.xid.dev/v1/me/sessions', { method: 'GET' }, env)

    expect(res.status).toBe(401)
  })

  it('does not list another tenant sessions (cross-tenant -> empty list)', async () => {
    const db = makeFakeD1({
      sessions: [sessionRow({ id: 's_victim', tenant_id: 't_other', user_id: 'u_victim' })],
    })
    const env = { DB: db } as unknown as Env
    const app = buildApp({
      register: registerMeSessionsRoutes,
      session: makeSession({ userId: 'u_1' }),
    })

    const res = await app.request('https://acme.xid.dev/v1/me/sessions', { method: 'GET' }, env)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })
})

describe('POST /v1/me/sessions/revoke-all', () => {
  it('revokes other sessions via per-user SessionDO and returns revoked:true', async () => {
    const db = makeFakeD1({
      sessions: [sessionRow({ id: 's_other', user_id: 'u_42' })],
    })
    const names: string[] = []
    const env = {
      DB: db,
      SESSION_REVOCATION: makeFakeSessionNs(names),
    } as unknown as Env
    const app = buildApp({
      register: registerMeSessionsRoutes,
      session: makeSession({ sessionId: 's_current', userId: 'u_42' }),
    })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/sessions/revoke-all',
      { method: 'POST' },
      env,
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ revoked: true })
    // 命中签发时同一 per-user DO 实例 key=session:{userId}。
    expect(names).toContain('session:u_42')
  })

  it('returns 401 when no session cookie present', async () => {
    const db = makeFakeD1({ sessions: [] })
    const names: string[] = []
    const env = { DB: db, SESSION_REVOCATION: makeFakeSessionNs(names) } as unknown as Env
    const app = buildApp({ register: registerMeSessionsRoutes, session: null })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/sessions/revoke-all',
      { method: 'POST' },
      env,
    )

    expect(res.status).toBe(401)
  })
})

describe('DELETE /v1/me/sessions/:id', () => {
  it('revokes one current user session via per-user SessionDO', async () => {
    const row = sessionRow({ id: 's_other', user_id: 'u_42' })
    const db = makeFakeD1({ sessions: [row] })
    const names: string[] = []
    const env = {
      DB: db,
      SESSION_REVOCATION: makeFakeSessionNs(names),
    } as unknown as Env
    const app = buildApp({
      register: registerMeSessionsRoutes,
      session: makeSession({ sessionId: 's_current', userId: 'u_42' }),
    })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/sessions/s_other',
      { method: 'DELETE' },
      env,
    )

    expect(res.status).toBe(204)
    expect(row['status']).toBe('revoked')
    expect(names).toContain('session:u_42')
  })

  it('does not revoke another user session', async () => {
    const row = sessionRow({ id: 's_victim', user_id: 'u_victim' })
    const db = makeFakeD1({ sessions: [row] })
    const names: string[] = []
    const env = {
      DB: db,
      SESSION_REVOCATION: makeFakeSessionNs(names),
    } as unknown as Env
    const app = buildApp({
      register: registerMeSessionsRoutes,
      session: makeSession({ sessionId: 's_current', userId: 'u_42' }),
    })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/sessions/s_victim',
      { method: 'DELETE' },
      env,
    )

    expect(res.status).toBe(404)
    expect(row['status']).toBe('active')
    expect(names).toEqual([])
  })
})
