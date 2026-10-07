// /v1/me/emails:真实 SQLite 验证添加、验证码、设主邮箱、移除与租户隔离。

import { sha256Hex } from '@xid-kit/crypto'
import { describe, expect, it, vi } from 'vitest'
import { makeRateLimitNs } from '../../me-auth/__tests__/helpers'
import { registerEmailsRoutes } from '../emails'
import { buildApp, makeSession, stepUpCookieFor, TEST_PEPPER } from './harness'
import { seedEmail, seedOrganization, seedUser, SqliteD1 } from './sqlite-d1'

function seed(): SqliteD1 {
  const db = new SqliteD1()
  seedOrganization(db, { id: 't_1', tenantId: 't_1' })
  seedOrganization(db, { id: 't_2', tenantId: 't_2' })
  seedUser(db, { id: 'u_1', tenantId: 't_1', primaryEmail: 'amara@northwind.test' })
  seedUser(db, { id: 'u_2', tenantId: 't_1', primaryEmail: 'lena@northwind.test' })
  seedUser(db, { id: 'u_9', tenantId: 't_2', primaryEmail: 'amara@kofi.test' })
  return db
}

function makeEnv(db: SqliteD1): { env: Env; emails: ReturnType<typeof vi.fn> } {
  const emails = vi.fn().mockResolvedValue(undefined)
  const env = {
    DB: db.asD1(),
    PEPPER: TEST_PEPPER,
    RATE_LIMITER: makeRateLimitNs(),
    EMAIL_QUEUE: { send: emails },
    AUDIT_QUEUE: { send: vi.fn().mockResolvedValue(undefined) },
    WEBHOOK_QUEUE: { send: vi.fn().mockResolvedValue(undefined) },
  } as unknown as Env
  return { env, emails }
}

function client(db: SqliteD1, userId = 'u_1') {
  const { env, emails } = makeEnv(db)
  const session = makeSession({ userId })
  const app = buildApp({ register: registerEmailsRoutes, session })
  const call = (path: string, init: RequestInit & { json?: unknown } = {}) =>
    app.request(
      `https://acme.xid.dev/v1/me/emails${path}`,
      {
        ...init,
        headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
        ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
      },
      env,
    )
  return { call, emails, session }
}

// 测试里无法读到明文码:把待验证记录的哈希换成已知码的哈希。
async function setKnownCode(db: SqliteD1, id: string, code: string): Promise<void> {
  db.database
    .prepare('UPDATE verification_tokens SET code_hash = ? WHERE id = ?')
    .run(await sha256Hex(code), id)
}

describe('/v1/me/emails', () => {
  it('adds an address only after the 6-digit code is verified', async () => {
    const db = seed()
    const { call, emails } = client(db)

    const added = await call('', { method: 'POST', json: { email: 'Amara@Kofi.Studio' } })

    expect(added.status).toBe(202)
    const pending = (await added.json()) as { id: string; email: string; pending: boolean }
    expect(pending).toMatchObject({ email: 'amara@kofi.studio', pending: true })
    expect(emails).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'otp', recipient: 'amara@kofi.studio' }),
    )
    expect(db.rows("SELECT id FROM user_emails WHERE email = 'amara@kofi.studio'")).toEqual([])

    await setKnownCode(db, pending.id, '482913')
    const wrong = await call(`/${pending.id}/verify`, { method: 'POST', json: { code: '000000' } })
    expect(wrong.status).toBe(400)
    expect(await wrong.json()).toMatchObject({ code: 'otp_invalid' })

    const verified = await call(`/${pending.id}/verify`, {
      method: 'POST',
      json: { code: '482913' },
    })

    expect(verified.status).toBe(200)
    const body = (await verified.json()) as { data: Record<string, unknown>[] }
    expect(body.data.map((item) => [item['email'], item['verified'], item['isPrimary']])).toEqual([
      ['amara@northwind.test', true, true],
      ['amara@kofi.studio', true, false],
    ])
  })

  it('answers the same way when the address belongs to another user and never sends a code', async () => {
    const db = seed()
    const { call, emails } = client(db)

    const res = await call('', { method: 'POST', json: { email: 'lena@northwind.test' } })

    expect(res.status).toBe(202)
    const pending = (await res.json()) as { id: string }
    expect(emails).not.toHaveBeenCalled()
    await setKnownCode(db, pending.id, '123456')
    const verify = await call(`/${pending.id}/verify`, { method: 'POST', json: { code: '123456' } })
    expect(verify.status).toBe(400)
    expect(await verify.json()).toMatchObject({ code: 'otp_invalid' })
    expect(db.rows("SELECT user_id FROM user_emails WHERE email = 'lena@northwind.test'")).toEqual([
      { user_id: 'u_2' },
    ])
  })

  it('lets the same address be added in another tenant', async () => {
    const db = seed()
    const { call, emails } = client(db)

    const res = await call('', { method: 'POST', json: { email: 'amara@kofi.test' } })

    expect(res.status).toBe(202)
    expect(emails).toHaveBeenCalledOnce()
  })

  it('makes a verified address primary only after step-up', async () => {
    const db = seed()
    seedEmail(db, {
      id: 'em_2',
      tenantId: 't_1',
      userId: 'u_1',
      email: 'a@kofi.studio',
      verified: true,
    })
    db.insert('mfa_factors', {
      id: 'mfa_1',
      tenant_id: 't_1',
      user_id: 'u_1',
      factor_type: 'totp',
      status: 'active',
      is_default: 0,
      created_at: 1,
      updated_at: 1,
    })
    const { call, session } = client(db)

    const withoutStepUp = await call('/em_2/primary', { method: 'POST' })
    expect(withoutStepUp.status).toBe(401)
    expect(await withoutStepUp.json()).toMatchObject({ code: 'step_up_required' })

    const res = await call('/em_2/primary', {
      method: 'POST',
      headers: { cookie: await stepUpCookieFor(session) },
    })

    expect(res.status).toBe(200)
    expect(db.rows("SELECT primary_email_id FROM users WHERE id = 'u_1'")).toEqual([
      { primary_email_id: 'em_2' },
    ])
  })

  it('refuses to remove the primary address', async () => {
    const db = seed()
    const { call } = client(db)

    const res = await call('/em_u_1', { method: 'DELETE' })

    expect(res.status).toBe(409)
    expect(db.rows("SELECT id FROM user_emails WHERE id = 'em_u_1'")).toHaveLength(1)
  })

  it('removes an unverified secondary address', async () => {
    const db = seed()
    seedEmail(db, {
      id: 'em_3',
      tenantId: 't_1',
      userId: 'u_1',
      email: 'old@proton.test',
      verified: false,
    })
    const { call } = client(db)

    const res = await call('/em_3', { method: 'DELETE' })

    expect(res.status).toBe(204)
    expect(db.rows("SELECT id FROM user_emails WHERE id = 'em_3'")).toEqual([])
  })

  it('returns 404 for an address of another user or tenant', async () => {
    const db = seed()
    const { call } = client(db)

    for (const id of ['em_u_2', 'em_u_9']) {
      expect((await call(`/${id}/primary`, { method: 'POST' })).status).toBe(404)
      expect((await call(`/${id}`, { method: 'DELETE' })).status).toBe(404)
    }
    expect(db.rows('SELECT id FROM user_emails ORDER BY id')).toHaveLength(3)
  })
})
