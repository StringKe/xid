// POST /v1/me/password 测试:happy path(改密成功)+ 旧密错误 401(meta=currentPassword)+
// 弱密(过短)422 + 401 无 session + 跨租户隔离(别租户 passwords 行不可见 -> 旧密校验失败)。
// Web Crypto(argon2id)用 Node 真实实现;HIBP fetch 用 stub 返回未泄露;pepper 用 bare base64url。

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { hashPassword } from '../../auth/password'
import { registerPasswordRoutes } from '../password'
import { buildApp, makeFakeD1, makeFakeSessionNs, makeSession } from './harness'

const now = Date.now()
// bare base64url pepper(decodePepper 支持裸 base64url,见 auth/password.ts)。
const PEPPER = 'cGVwcGVyLXNlY3JldC1ieXRlcw'
const CURRENT_PW = 'Curr3nt-Passw0rd!'
const NEW_PW = 'Br4nd-New-Str0ng-Pw!'

let currentHash: string

beforeEach(async () => {
  const meta = await hashPassword(CURRENT_PW, PEPPER)
  currentHash = meta.hash
  // HIBP:未泄露(suffix 不匹配),改密路径放行。
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue({ ok: true, text: async () => '0000000000000000000000000000000000:1\n' }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function passwordRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'pw_1',
    tenant_id: 't_1',
    user_id: 'u_1',
    hash: currentHash,
    algo: 'argon2id',
    pepper_version: 1,
    breached: 0,
    breach_checked_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  }
}

function makeEnv(db: D1Database, names: string[] = []): Env {
  return { DB: db, PEPPER, SESSION_REVOCATION: makeFakeSessionNs(names) } as unknown as Env
}

describe('POST /v1/me/password', () => {
  it('changes password when current password is correct', async () => {
    const db = makeFakeD1({
      passwords: [passwordRow()],
      password_history: [],
      sessions: [],
    })
    const env = makeEnv(db)
    const app = buildApp({
      register: registerPasswordRoutes,
      session: makeSession({ userId: 'u_1', sessionId: 's_current' }),
    })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/password',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: CURRENT_PW, newPassword: NEW_PW }),
      },
      env,
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ updated: true })
  }, 30000)

  it('rejects wrong current password with invalid_credentials + paramName currentPassword', async () => {
    const db = makeFakeD1({ passwords: [passwordRow()], password_history: [], sessions: [] })
    const env = makeEnv(db)
    const app = buildApp({
      register: registerPasswordRoutes,
      session: makeSession({ userId: 'u_1' }),
    })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/password',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: 'wrong-password-value', newPassword: NEW_PW }),
      },
      env,
    )

    expect(res.status).toBe(401)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['code']).toBe('invalid_credentials')
    expect((body['meta'] as Record<string, unknown>)['paramName']).toBe('currentPassword')
  }, 30000)

  it('rejects too-short new password with 422 + paramName newPassword', async () => {
    const db = makeFakeD1({ passwords: [passwordRow()], password_history: [], sessions: [] })
    const env = makeEnv(db)
    const app = buildApp({
      register: registerPasswordRoutes,
      session: makeSession({ userId: 'u_1' }),
    })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/password',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: CURRENT_PW, newPassword: 'short' }),
      },
      env,
    )

    expect(res.status).toBe(422)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['code']).toBe('validation_failed')
    expect((body['meta'] as Record<string, unknown>)['paramName']).toBe('newPassword')
  }, 30000)

  it('returns 401 when no session cookie present', async () => {
    const db = makeFakeD1({ passwords: [passwordRow()], password_history: [], sessions: [] })
    const env = makeEnv(db)
    const app = buildApp({ register: registerPasswordRoutes, session: null })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/password',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: CURRENT_PW, newPassword: NEW_PW }),
      },
      env,
    )

    expect(res.status).toBe(401)
  })

  it('does not use another tenant password row (cross-tenant -> invalid_credentials)', async () => {
    // passwords 行归属 t_other 用户 u_victim;session 用户 u_1@t_1 -> 查询层注入 tenant_id=t_1 查不到 -> 旧密校验失败。
    const db = makeFakeD1({
      passwords: [passwordRow({ id: 'pw_victim', tenant_id: 't_other', user_id: 'u_victim' })],
      password_history: [],
      sessions: [],
    })
    const env = makeEnv(db)
    const app = buildApp({
      register: registerPasswordRoutes,
      session: makeSession({ userId: 'u_1' }),
    })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/password',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: CURRENT_PW, newPassword: NEW_PW }),
      },
      env,
    )

    expect(res.status).toBe(401)
    expect(((await res.json()) as Record<string, unknown>)['code']).toBe('invalid_credentials')
  }, 30000)
})
