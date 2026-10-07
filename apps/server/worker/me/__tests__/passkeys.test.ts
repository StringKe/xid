// GET /v1/me/passkeys 测试:happy path(剔除 public_key/aaguid/sign_count)+ 401 + 跨租户隔离。

import { base64UrlEncode } from '@xid-kit/crypto'
import { describe, it, expect } from 'vitest'
import { PASSKEY_LIMIT } from '../../auth/passkey-helpers'
import { registerPasskeysRoutes } from '../passkeys'
import { buildApp, makeFakeD1, makeSession, stepUpCookieFor, TEST_PEPPER } from './harness'

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
    const { data: body } = (await res.json()) as { data: Record<string, unknown>[] }
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

  it('reports sync state, device type and the per-account limit', async () => {
    const db = makeFakeD1({
      passkey_credentials: [
        passkeyRow(),
        passkeyRow({
          id: 'pk_key',
          credential_id: 'cred_key',
          credential_device_type: 'singleDevice',
          backed_up: 0,
        }),
      ],
    })
    const env = { DB: db } as unknown as Env
    const app = buildApp({ register: registerPasskeysRoutes, session: makeSession() })

    const res = await app.request('https://acme.xid.dev/v1/me/passkeys', {}, env)

    const body = (await res.json()) as { data: Record<string, unknown>[]; limit: number }
    expect(body.limit).toBe(PASSKEY_LIMIT)
    expect(body.data.map((item) => [item['id'], item['deviceType'], item['backedUp']])).toEqual([
      ['pk_1', 'multiDevice', true],
      ['pk_key', 'singleDevice', false],
    ])
  })

  it('lists passkeys for forced MFA enrollment but not for a pending challenge', async () => {
    const db = makeFakeD1({ passkey_credentials: [passkeyRow()] })
    const env = { DB: db } as unknown as Env
    const setupApp = buildApp({
      register: registerPasskeysRoutes,
      session: makeSession({ userId: 'u_1', status: 'pending_mfa_setup' }),
    })
    const challengeApp = buildApp({
      register: registerPasskeysRoutes,
      session: makeSession({ userId: 'u_1', status: 'pending_mfa' }),
    })

    const setupRes = await setupApp.request('https://acme.xid.dev/v1/me/passkeys', {}, env)
    const challengeRes = await challengeApp.request('https://acme.xid.dev/v1/me/passkeys', {}, env)

    expect(setupRes.status).toBe(200)
    expect(challengeRes.status).toBe(401)
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
    expect(await res.json()).toEqual({ data: [], limit: PASSKEY_LIMIT })
  })
})

describe('GET /v1/me/passkeys/signal', () => {
  it('returns the registration user handle and only the current user active credential ids', async () => {
    const db = makeFakeD1({
      passkey_credentials: [
        passkeyRow(),
        passkeyRow({ id: 'pk_revoked', credential_id: 'cred_revoked', revoked_at: now }),
        passkeyRow({ id: 'pk_victim', tenant_id: 't_other', credential_id: 'cred_victim' }),
      ],
      users: [{ id: 'u_1', tenant_id: 't_1', display_name: 'Ada', primary_email_id: null }],
    })
    const env = { DB: db } as unknown as Env
    const app = buildApp({ register: registerPasskeysRoutes, session: makeSession() })

    const res = await app.request('https://acme.xid.dev/v1/me/passkeys/signal', {}, env)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      rpId: 'acme.xid.dev',
      userId: base64UrlEncode(new TextEncoder().encode('u_1')),
      name: 'u_1',
      displayName: 'Ada',
      allAcceptedCredentialIds: ['cred_abc'],
    })
  })

  it('requires a signed-in session', async () => {
    const env = { DB: makeFakeD1({ passkey_credentials: [passkeyRow()] }) } as unknown as Env
    const app = buildApp({ register: registerPasskeysRoutes, session: null })

    const res = await app.request('https://acme.xid.dev/v1/me/passkeys/signal', {}, env)

    expect(res.status).toBe(401)
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

  it('revokes the passkey and its linked MFA factor after step-up', async () => {
    const row = passkeyRow()
    const linkedFactor = {
      id: 'mf_pk',
      tenant_id: 't_1',
      user_id: 'u_1',
      factor_type: 'passkey',
      status: 'active',
      passkey_credential_id: 'cred_abc',
    }
    const db = makeFakeD1({
      passkey_credentials: [row],
      passwords: [{ id: 'pw_1', tenant_id: 't_1', user_id: 'u_1' }],
      mfa_factors: [linkedFactor],
    })
    const session = makeSession({ userId: 'u_1' })
    const app = buildApp({ register: registerPasskeysRoutes, session })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/passkeys/pk_1',
      { method: 'DELETE', headers: { Cookie: await stepUpCookieFor(session) } },
      { DB: db, PEPPER: TEST_PEPPER } as unknown as Env,
    )

    expect(res.status).toBe(204)
    expect(row['revoked_at']).toBeTypeOf('number')
    expect(linkedFactor.status).toBe('revoked')
  })

  it('requires step-up before removing a passkey', async () => {
    const row = passkeyRow()
    const db = makeFakeD1({
      passkey_credentials: [row],
      passwords: [{ id: 'pw_1', tenant_id: 't_1', user_id: 'u_1' }],
    })
    const app = buildApp({
      register: registerPasskeysRoutes,
      session: makeSession({ userId: 'u_1' }),
    })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/passkeys/pk_1',
      { method: 'DELETE' },
      { DB: db, PEPPER: TEST_PEPPER } as unknown as Env,
    )

    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ code: 'step_up_required' })
    expect(row['revoked_at']).toBeUndefined()
  })

  it('accepts a fresh passkey sign-in as step-up for removing one of several passkeys', async () => {
    const row = passkeyRow()
    const other = passkeyRow({ id: 'pk_2', credential_id: 'cred_other' })
    const db = makeFakeD1({ passkey_credentials: [row, other] })
    const app = buildApp({
      register: registerPasskeysRoutes,
      session: makeSession({ userId: 'u_1', amr: ['phr'], acr: 'urn:xid:aal2', aal: 2 }),
    })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/passkeys/pk_1',
      { method: 'DELETE' },
      { DB: db, PEPPER: TEST_PEPPER } as unknown as Env,
    )

    expect(res.status).toBe(204)
  })

  it('refuses to remove the only way to sign in', async () => {
    const row = passkeyRow()
    const db = makeFakeD1({ passkey_credentials: [row] })
    const session = makeSession({ userId: 'u_1' })
    const app = buildApp({ register: registerPasskeysRoutes, session })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/passkeys/pk_1',
      { method: 'DELETE', headers: { Cookie: await stepUpCookieFor(session) } },
      { DB: db, PEPPER: TEST_PEPPER } as unknown as Env,
    )

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'sign_in_method_required' })
    expect(row['revoked_at']).toBeUndefined()
  })

  it('does not count a disconnected social identity as a remaining sign-in method', async () => {
    const row = passkeyRow()
    const db = makeFakeD1({
      passkey_credentials: [row],
      user_identities: [
        { id: 'id_1', tenant_id: 't_1', user_id: 'u_1', identity_type: 'oauth', revoked_at: now },
      ],
    })
    const session = makeSession({ userId: 'u_1' })
    const app = buildApp({ register: registerPasskeysRoutes, session })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/passkeys/pk_1',
      { method: 'DELETE', headers: { Cookie: await stepUpCookieFor(session) } },
      { DB: db, PEPPER: TEST_PEPPER } as unknown as Env,
    )

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'sign_in_method_required' })
    expect(row['revoked_at']).toBeUndefined()
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
