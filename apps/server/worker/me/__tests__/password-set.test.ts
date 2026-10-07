// 没有密码的用户在账户内设置密码:省略 currentPassword,要求 step-up,长度 / HIBP / 历史校验与重置一致。
// GET /v1/me/password 返回是否有密码、上次修改时间与泄露标记。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerPasswordRoutes } from '../password'
import { buildApp, makeSession, stepUpCookieFor, TEST_PEPPER } from './harness'
import { seedOrganization, seedUser, SqliteD1 } from './sqlite-d1'

const NEW_PW = 'Br4nd-New-Str0ng-Pw!'

beforeEach(() => {
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

function seed(): SqliteD1 {
  const db = new SqliteD1()
  seedOrganization(db, { id: 't_1', tenantId: 't_1' })
  seedOrganization(db, { id: 't_2', tenantId: 't_2' })
  seedUser(db, { id: 'u_1', tenantId: 't_1', primaryEmail: 'joao@northwind.test' })
  seedUser(db, { id: 'u_9', tenantId: 't_2' })
  return db
}

function addTotp(db: SqliteD1): void {
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
}

function client(db: SqliteD1) {
  const env = {
    DB: db.asD1(),
    PEPPER: TEST_PEPPER,
    AUDIT_QUEUE: { send: vi.fn().mockResolvedValue(undefined) },
  } as unknown as Env
  const session = makeSession()
  const app = buildApp({ register: registerPasswordRoutes, session })
  const post = (body: unknown, cookie?: string) =>
    app.request(
      'https://acme.xid.dev/v1/me/password',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(body),
      },
      env,
    )
  const get = () => app.request('https://acme.xid.dev/v1/me/password', {}, env)
  return { post, get, session }
}

describe('setting a first password from the account portal', () => {
  it('sets a password for a user without one and reports it', async () => {
    const db = seed()
    const { post, get } = client(db)

    const before = await get()
    const res = await post({ newPassword: NEW_PW })
    const after = await get()

    expect(await before.json()).toEqual({ hasPassword: false, updatedAt: null, breached: false })
    expect(res.status).toBe(200)
    expect(db.rows("SELECT user_id, algo FROM passwords WHERE tenant_id = 't_1'")).toEqual([
      { user_id: 'u_1', algo: 'argon2id' },
    ])
    expect(await after.json()).toMatchObject({ hasPassword: true, breached: false })
  })

  it('requires step-up when the user already has an authenticator app', async () => {
    const db = seed()
    addTotp(db)
    const { post, session } = client(db)

    const withoutStepUp = await post({ newPassword: NEW_PW })
    const withStepUp = await post({ newPassword: NEW_PW }, await stepUpCookieFor(session))

    expect(withoutStepUp.status).toBe(401)
    expect(await withoutStepUp.json()).toMatchObject({ code: 'step_up_required' })
    expect(withStepUp.status).toBe(200)
  })

  it('applies the same length rule as a reset', async () => {
    const db = seed()
    const { post } = client(db)

    const res = await post({ newPassword: 'short' })

    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ meta: { paramName: 'newPassword' } })
    expect(db.rows('SELECT id FROM passwords')).toEqual([])
  })

  it('requires the current password once a password exists', async () => {
    const db = seed()
    const { post } = client(db)
    await post({ newPassword: NEW_PW })

    const res = await post({ newPassword: `${NEW_PW}2` })

    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ meta: { paramName: 'currentPassword' } })
  })

  it('does not treat another tenant password row as the user password', async () => {
    const db = seed()
    db.insert('passwords', {
      id: 'pw_9',
      tenant_id: 't_2',
      user_id: 'u_1',
      hash: 'x',
      algo: 'argon2id',
      pepper_version: 1,
      breached: 0,
      created_at: 1,
      updated_at: 1,
    })
    const { get } = client(db)

    expect(await (await get()).json()).toMatchObject({ hasPassword: false })
  })
})
