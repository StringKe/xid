// POST /v1/me/password 测试:happy path(改密成功)+ 旧密错误 401(meta=currentPassword)+
// 弱密(过短)422 + 401 无 session + 跨租户隔离(别租户 passwords 行不可见 -> 旧密校验失败)。
// Web Crypto(argon2id)用 Node 真实实现;HIBP fetch 用 stub 返回未泄露;pepper 用 bare base64url。

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'

// setup-link 复用 reset token 签发链:signer 与 JWT 签发在 me-auth 测试已覆盖,这里 stub 掉,
// 保留真实 hashPassword/verifyPassword 供上方改密用例(argon2id 真实实现)。
vi.mock('../../oidc/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../oidc/shared')>()
  return {
    ...actual,
    loadActiveSigner: vi.fn().mockResolvedValue({ kid: 'k1', alg: 'ES256', privateKey: {} }),
  }
})

vi.mock('../../auth/password', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../auth/password')>()
  return {
    ...actual,
    createResetToken: vi.fn().mockResolvedValue({
      token: 'reset.token.sig',
      tokenHash: 'hash-of-token',
      expiresAt: new Date(Date.now() + 900000),
      jti: 'jti-1',
    }),
  }
})

import { hashPassword } from '../../auth/password'
import { registerPasswordRoutes } from '../password'
import { asUnknown, buildApp, makeFakeD1, makeFakeSessionNs, makeSession } from './harness'

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

// POST /v1/me/password/setup-link:session 认证的设密链接签发(passwordless 用户)。
// 覆盖:已验证邮箱 -> 200 + password_reset 邮件;未验证邮箱 -> 400 invalid_request(不发邮件);
// 无 session -> 401;限流拒绝 -> 429 rate_limited。
describe('POST /v1/me/password/setup-link', () => {
  function userRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'u_1',
      tenant_id: 't_1',
      primary_email_id: 'em_1',
      pending_email: null,
      status: 'active',
      deleted_at: null,
      created_at: now,
      updated_at: now,
      ...overrides,
    }
  }

  function emailRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'em_1',
      tenant_id: 't_1',
      user_id: 'u_1',
      email: 'ada@example.com',
      verified: 1,
      is_primary: 1,
      created_at: now,
      updated_at: now,
      ...overrides,
    }
  }

  function makeRateLimiter(allowed: boolean): DurableObjectNamespace {
    const stub = {
      fetch: async () =>
        new Response(JSON.stringify({ allowed, retryAfter: 0, count: 1 }), { status: 200 }),
    }
    return asUnknown<DurableObjectNamespace>({
      idFromName: (n: string) => n,
      get: () => stub,
    })
  }

  function makeSetupEnv(db: D1Database, options: { rateLimitAllowed?: boolean } = {}) {
    const emailSend = vi.fn().mockResolvedValue(undefined)
    const auditSend = vi.fn().mockResolvedValue(undefined)
    const env = asUnknown<Env>({
      DB: db,
      PEPPER,
      KEK: 'test-kek',
      RATE_LIMITER: makeRateLimiter(options.rateLimitAllowed ?? true),
      EMAIL_QUEUE: { send: emailSend },
      AUDIT_QUEUE: { send: auditSend },
    })
    return { env, emailSend }
  }

  it('sends a password_reset setup email when the primary email is verified', async () => {
    const db = makeFakeD1({
      users: [userRow()],
      user_emails: [emailRow()],
      password_reset_tokens: [],
    })
    const { env, emailSend } = makeSetupEnv(db)
    const app = buildApp({
      register: registerPasswordRoutes,
      session: makeSession({ userId: 'u_1' }),
    })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/password/setup-link',
      { method: 'POST' },
      env,
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(emailSend).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'password_reset',
        recipient: 'ada@example.com',
        payload: expect.objectContaining({
          tenantId: 't_1',
          userId: 'u_1',
          token: 'reset.token.sig',
        }),
      }),
    )
  })

  it('rejects with invalid_request and sends nothing when the email is unverified', async () => {
    const db = makeFakeD1({
      users: [userRow()],
      user_emails: [emailRow({ verified: 0 })],
      password_reset_tokens: [],
    })
    const { env, emailSend } = makeSetupEnv(db)
    const app = buildApp({
      register: registerPasswordRoutes,
      session: makeSession({ userId: 'u_1' }),
    })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/password/setup-link',
      { method: 'POST' },
      env,
    )

    expect(res.status).toBe(400)
    expect(((await res.json()) as Record<string, unknown>)['code']).toBe('invalid_request')
    expect(emailSend).not.toHaveBeenCalled()
  })

  it('returns 401 when no session is present', async () => {
    const db = makeFakeD1({
      users: [userRow()],
      user_emails: [emailRow()],
      password_reset_tokens: [],
    })
    const { env, emailSend } = makeSetupEnv(db)
    const app = buildApp({ register: registerPasswordRoutes, session: null })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/password/setup-link',
      { method: 'POST' },
      env,
    )

    expect(res.status).toBe(401)
    expect(emailSend).not.toHaveBeenCalled()
  })

  it('propagates rate_limited when the send budget is exhausted', async () => {
    const db = makeFakeD1({
      users: [userRow()],
      user_emails: [emailRow()],
      password_reset_tokens: [],
    })
    const { env, emailSend } = makeSetupEnv(db, { rateLimitAllowed: false })
    const app = buildApp({
      register: registerPasswordRoutes,
      session: makeSession({ userId: 'u_1' }),
    })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/password/setup-link',
      { method: 'POST' },
      env,
    )

    expect(res.status).toBe(429)
    expect(((await res.json()) as Record<string, unknown>)['code']).toBe('rate_limited')
    expect(emailSend).not.toHaveBeenCalled()
  })
})
