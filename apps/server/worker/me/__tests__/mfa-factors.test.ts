// GET /v1/me/mfa-factors 测试:totp + backup_codes 判别 union(camelCase)+ 401 + 跨租户隔离。
// 仅 status='active';secret_ciphertext 不外泄;backup_codes remaining 走 countRemainingBackupCodes。

import { describe, it, expect } from 'vitest'
import { isPersistedId } from '../../lib/persisted-id'
import { registerMfaFactorsRoutes } from '../mfa-factors'
import { buildApp, makeFakeD1, makeSession, stepUpCookieFor, TENANT, TEST_PEPPER } from './harness'

const now = Date.now()

function totpRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'mf_1',
    tenant_id: 't_1',
    user_id: 'u_1',
    factor_type: 'totp',
    status: 'active',
    secret_ciphertext: new Uint8Array([9, 9]),
    target: null,
    passkey_credential_id: null,
    is_default: 1,
    last_used_at: null,
    activated_at: now,
    created_at: now,
    updated_at: now,
    ...overrides,
  }
}

function backupCodeRow(used: boolean, idx: number): Record<string, unknown> {
  return {
    id: `bc_${idx}`,
    tenant_id: 't_1',
    user_id: 'u_1',
    batch_id: 'batch_1',
    code_hash: `hash_${idx}`,
    used: used ? 1 : 0,
    used_at: used ? now : null,
    created_at: now,
  }
}

function verifiedPhoneRow(): Record<string, unknown> {
  return {
    id: 'phone_1',
    tenant_id: 't_1',
    user_id: 'u_1',
    phone: '+15551234567',
    verified: 1,
    verification_status: 'verified',
    is_primary: 1,
    verified_at: now,
    created_at: now,
    updated_at: now,
  }
}

function passkeyRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'pk_1',
    tenant_id: 't_1',
    user_id: 'u_1',
    credential_id: 'cred_1',
    public_key: 'pk',
    sign_count: 0,
    device_name: 'This device',
    transports: null,
    backup_eligible: 0,
    backup_state: 0,
    last_used_at: null,
    revoked_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  }
}

function smsFactorRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return totpRow({
    id: 'mf_sms',
    factor_type: 'sms',
    secret_ciphertext: null,
    target: 'phone_1',
    is_default: 0,
    ...overrides,
  })
}

const SMS_TENANT = {
  ...TENANT,
  policy: {
    deliveryChannels: {
      sms: {
        provider: 'twilio' as const,
        enabled: true,
        secretRefs: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'],
        from: '+15550000000',
      },
    },
  },
} as typeof TENANT

function smsEnv(db: D1Database): Env {
  return {
    DB: db,
    PEPPER: TEST_PEPPER,
    TWILIO_ACCOUNT_SID: 'AC123',
    TWILIO_AUTH_TOKEN: 'token',
    SMS_FROM: '+15550000000',
  } as unknown as Env
}

async function stepUpRequest(
  app: ReturnType<typeof buildApp>,
  input: { path: string; method: string; env: Env; session: ReturnType<typeof makeSession> },
): Promise<Response> {
  return app.request(
    `https://acme.xid.dev${input.path}`,
    { method: input.method, headers: { Cookie: await stepUpCookieFor(input.session) } },
    input.env,
  )
}

describe('GET /v1/me/mfa-factors', () => {
  it('returns totp + backup_codes factors as discriminated union', async () => {
    // 使用两条未用码覆盖 count 查询和 used=false 条件。
    const db = makeFakeD1({
      mfa_factors: [totpRow()],
      backup_codes: [backupCodeRow(false, 1), backupCodeRow(false, 2)],
    })
    const env = { DB: db } as unknown as Env
    const app = buildApp({
      register: registerMfaFactorsRoutes,
      session: makeSession({ userId: 'u_1' }),
    })

    const res = await app.request('https://acme.xid.dev/v1/me/mfa-factors', { method: 'GET' }, env)

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>[]
    const totp = body.find((f) => f['type'] === 'totp')
    const backup = body.find((f) => f['type'] === 'backup_codes')
    expect(totp).toMatchObject({ id: 'mf_1', type: 'totp' })
    expect(totp).not.toHaveProperty('secretCiphertext')
    expect(backup).toMatchObject({ type: 'backup_codes', remaining: 2 })
  })

  it('returns 401 when no session cookie present', async () => {
    const db = makeFakeD1({ mfa_factors: [totpRow()], backup_codes: [] })
    const env = { DB: db } as unknown as Env
    const app = buildApp({ register: registerMfaFactorsRoutes, session: null })

    const res = await app.request('https://acme.xid.dev/v1/me/mfa-factors', { method: 'GET' }, env)

    expect(res.status).toBe(401)
  })

  it('does not list another tenant factors (cross-tenant -> empty list)', async () => {
    const db = makeFakeD1({
      mfa_factors: [totpRow({ id: 'mf_victim', tenant_id: 't_other', user_id: 'u_victim' })],
      backup_codes: [],
    })
    const env = { DB: db } as unknown as Env
    const app = buildApp({
      register: registerMfaFactorsRoutes,
      session: makeSession({ userId: 'u_1' }),
    })

    const res = await app.request('https://acme.xid.dev/v1/me/mfa-factors', { method: 'GET' }, env)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('does not list a verified phone as an SMS factor until the user enrolls it', async () => {
    const db = makeFakeD1({
      mfa_factors: [],
      backup_codes: [],
      user_phones: [verifiedPhoneRow()],
    })
    const app = buildApp({
      register: registerMfaFactorsRoutes,
      session: makeSession({ userId: 'u_1' }),
      tenant: SMS_TENANT,
    })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/mfa-factors',
      { method: 'GET' },
      smsEnv(db),
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('lists the enrolled SMS factor when the provider is ready', async () => {
    const db = makeFakeD1({
      mfa_factors: [totpRow(), smsFactorRow()],
      backup_codes: [],
      user_phones: [verifiedPhoneRow()],
    })
    const app = buildApp({
      register: registerMfaFactorsRoutes,
      session: makeSession({ userId: 'u_1' }),
      tenant: SMS_TENANT,
    })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/mfa-factors',
      { method: 'GET' },
      smsEnv(db),
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>[]
    expect(body.find((factor) => factor['type'] === 'sms')).toEqual({
      id: 'mf_sms',
      type: 'sms',
      createdAt: new Date(now).toISOString(),
    })
  })

  it('does not offer the SMS factor for step-up on a session signed in by SMS', async () => {
    const db = makeFakeD1({
      mfa_factors: [totpRow(), smsFactorRow()],
      backup_codes: [],
      user_phones: [verifiedPhoneRow()],
    })
    const app = buildApp({
      register: registerMfaFactorsRoutes,
      session: makeSession({ userId: 'u_1', amr: ['sms'] }),
      tenant: SMS_TENANT,
    })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/mfa-factors',
      { method: 'GET' },
      smsEnv(db),
    )

    const body = (await res.json()) as Record<string, unknown>[]
    expect(body.map((factor) => factor['type'])).toEqual(['totp'])
  })

  it('does not offer a passkey as second factor during a passkey sign-in challenge', async () => {
    const db = makeFakeD1({
      mfa_factors: [],
      backup_codes: [],
      passkey_credentials: [passkeyRow()],
    })
    const env = { DB: db } as unknown as Env
    const app = buildApp({
      register: registerMfaFactorsRoutes,
      session: makeSession({ userId: 'u_1', amr: ['phr'], status: 'pending_mfa' }),
    })

    const res = await app.request('https://acme.xid.dev/v1/me/mfa-factors', { method: 'GET' }, env)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('lists passkeys for step-up on an active passkey session', async () => {
    const db = makeFakeD1({
      mfa_factors: [],
      backup_codes: [],
      passkey_credentials: [passkeyRow()],
    })
    const env = { DB: db } as unknown as Env
    const app = buildApp({
      register: registerMfaFactorsRoutes,
      session: makeSession({ userId: 'u_1', amr: ['phr'] }),
    })

    const res = await app.request('https://acme.xid.dev/v1/me/mfa-factors', { method: 'GET' }, env)

    expect(await res.json()).toEqual([expect.objectContaining({ id: 'pk_1', type: 'passkey' })])
  })

  it('lists passkey factors for registered credentials', async () => {
    const db = makeFakeD1({
      mfa_factors: [],
      backup_codes: [],
      passkey_credentials: [passkeyRow()],
    })
    const env = { DB: db } as unknown as Env
    const app = buildApp({
      register: registerMfaFactorsRoutes,
      session: makeSession({ userId: 'u_1' }),
    })

    const res = await app.request('https://acme.xid.dev/v1/me/mfa-factors', { method: 'GET' }, env)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([
      {
        id: 'pk_1',
        type: 'passkey',
        deviceName: 'This device',
        createdAt: new Date(now).toISOString(),
      },
    ])
  })

  it('does not list SMS when the provider is not ready', async () => {
    const db = makeFakeD1({
      mfa_factors: [],
      backup_codes: [],
      user_phones: [verifiedPhoneRow()],
    })
    const env = { DB: db } as unknown as Env
    const app = buildApp({
      register: registerMfaFactorsRoutes,
      session: makeSession({ userId: 'u_1' }),
    })

    const res = await app.request('https://acme.xid.dev/v1/me/mfa-factors', { method: 'GET' }, env)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })
})

describe('DELETE /v1/me/mfa-factors/:id', () => {
  it('revokes current user TOTP factor after step-up', async () => {
    const row = totpRow()
    const db = makeFakeD1({ mfa_factors: [row], backup_codes: [] })
    const session = makeSession({ userId: 'u_1' })
    const app = buildApp({ register: registerMfaFactorsRoutes, session })

    const res = await stepUpRequest(app, {
      path: '/v1/me/mfa-factors/mf_1',
      method: 'DELETE',
      env: { DB: db, PEPPER: TEST_PEPPER } as unknown as Env,
      session,
    })

    expect(res.status).toBe(204)
    expect(row['status']).toBe('revoked')
  })

  it('requires step-up before removing a TOTP factor', async () => {
    const row = totpRow()
    const db = makeFakeD1({ mfa_factors: [row], backup_codes: [] })
    const app = buildApp({
      register: registerMfaFactorsRoutes,
      session: makeSession({ userId: 'u_1' }),
    })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/mfa-factors/mf_1',
      { method: 'DELETE' },
      { DB: db, PEPPER: TEST_PEPPER } as unknown as Env,
    )

    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ code: 'step_up_required' })
    expect(row['status']).toBe('active')
  })

  it('rejects a step-up token bound to another session', async () => {
    const row = totpRow()
    const db = makeFakeD1({ mfa_factors: [row], backup_codes: [] })
    const app = buildApp({
      register: registerMfaFactorsRoutes,
      session: makeSession({ userId: 'u_1' }),
    })

    const res = await stepUpRequest(app, {
      path: '/v1/me/mfa-factors/mf_1',
      method: 'DELETE',
      env: { DB: db, PEPPER: TEST_PEPPER } as unknown as Env,
      session: makeSession({ userId: 'u_1', sessionId: 's_other' }),
    })

    expect(res.status).toBe(401)
    expect(row['status']).toBe('active')
  })

  it('refuses to remove the last strong factor when the tenant requires MFA', async () => {
    const row = totpRow()
    const db = makeFakeD1({ mfa_factors: [row], backup_codes: [] })
    const session = makeSession({ userId: 'u_1' })
    const app = buildApp({
      register: registerMfaFactorsRoutes,
      session,
      tenant: { ...TENANT, policy: { mfaEnforcement: 'required' } },
    })

    const res = await stepUpRequest(app, {
      path: '/v1/me/mfa-factors/mf_1',
      method: 'DELETE',
      env: { DB: db, PEPPER: TEST_PEPPER } as unknown as Env,
      session,
    })

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'mfa_required' })
    expect(row['status']).toBe('active')
  })

  it('retires the SMS factor and backup codes with the last strong factor', async () => {
    const totp = totpRow()
    const sms = smsFactorRow()
    const code = backupCodeRow(false, 1)
    const db = makeFakeD1({ mfa_factors: [totp, sms], backup_codes: [code] })
    const session = makeSession({ userId: 'u_1' })
    const app = buildApp({ register: registerMfaFactorsRoutes, session })

    const res = await stepUpRequest(app, {
      path: '/v1/me/mfa-factors/mf_1',
      method: 'DELETE',
      env: { DB: db, PEPPER: TEST_PEPPER } as unknown as Env,
      session,
    })

    expect(res.status).toBe(204)
    expect(sms['status']).toBe('revoked')
    expect(code['used']).toBe(1)
  })

  it('marks backup code batch used for current user', async () => {
    const code = backupCodeRow(false, 1)
    const db = makeFakeD1({ mfa_factors: [], backup_codes: [code] })
    const env = { DB: db } as unknown as Env
    const app = buildApp({
      register: registerMfaFactorsRoutes,
      session: makeSession({ userId: 'u_1' }),
    })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/mfa-factors/batch_1',
      { method: 'DELETE' },
      env,
    )

    expect(res.status).toBe(204)
    expect(code['used']).toBe(1)
    expect(code['used_at']).toBeTypeOf('number')
  })

  it('does not revoke another user MFA factor', async () => {
    const row = totpRow({ id: 'mf_2', user_id: 'u_2' })
    const db = makeFakeD1({ mfa_factors: [row], backup_codes: [] })
    const env = { DB: db } as unknown as Env
    const app = buildApp({
      register: registerMfaFactorsRoutes,
      session: makeSession({ userId: 'u_1' }),
    })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/mfa-factors/mf_2',
      { method: 'DELETE' },
      env,
    )

    expect(res.status).toBe(404)
    expect(row['status']).toBe('active')
  })
})

describe('POST /v1/me/mfa-factors/totp/setup', () => {
  it('creates pending TOTP setup response without exposing ciphertext', async () => {
    const user = {
      id: 'u_1',
      tenant_id: 't_1',
      username: null,
      primary_email_id: 'eml_1',
      status: 'active',
      created_at: now,
      updated_at: now,
    }
    const email = {
      id: 'eml_1',
      tenant_id: 't_1',
      user_id: 'u_1',
      email: 'user@example.test',
      verified: 1,
      verification_status: 'verified',
      is_primary: 1,
      verified_at: now,
      created_at: now,
      updated_at: now,
    }
    const db = makeFakeD1({
      users: [user],
      user_emails: [email],
      mfa_factors: [],
      backup_codes: [],
    })
    const env = {
      DB: db,
      KEK: 'zMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMw',
      CACHE: {},
    } as unknown as Env
    const app = buildApp({
      register: registerMfaFactorsRoutes,
      session: makeSession({ userId: 'u_1' }),
    })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/mfa-factors/totp/setup',
      { method: 'POST' },
      env,
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(isPersistedId('mfaFactor', String(body['factorId']))).toBe(true)
    expect(body['secret']).toMatch(/^[A-Z2-7]+$/)
    expect(body['otpauthUri']).toContain('otpauth://totp/')
    expect(body).not.toHaveProperty('secretCiphertext')
  })

  async function requestTotpSetupUri(
    organizations: Record<string, unknown>[],
  ): Promise<{ label: string; issuer: string }> {
    const db = makeFakeD1({
      organizations,
      users: [
        {
          id: 'u_1',
          tenant_id: 't_1',
          username: null,
          primary_email_id: 'eml_1',
          status: 'active',
          created_at: now,
          updated_at: now,
        },
      ],
      user_emails: [
        {
          id: 'eml_1',
          tenant_id: 't_1',
          user_id: 'u_1',
          email: 'user@example.test',
          verified: 1,
          verification_status: 'verified',
          is_primary: 1,
          verified_at: now,
          created_at: now,
          updated_at: now,
        },
      ],
      mfa_factors: [],
      backup_codes: [],
    })
    const env = {
      DB: db,
      KEK: 'zMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMw',
      CACHE: {},
    } as unknown as Env
    const app = buildApp({
      register: registerMfaFactorsRoutes,
      session: makeSession({ userId: 'u_1' }),
    })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/mfa-factors/totp/setup',
      { method: 'POST' },
      env,
    )

    const uri = new URL(String(((await res.json()) as Record<string, unknown>)['otpauthUri']))
    return {
      label: decodeURIComponent(uri.pathname.replace(/^\/+/, '')),
      issuer: uri.searchParams.get('issuer') ?? '',
    }
  }

  it('names the authenticator entry after the organization with a matching label prefix', async () => {
    const { label, issuer } = await requestTotpSetupUri([
      {
        id: TENANT.tenantId,
        tenant_id: TENANT.tenantId,
        name: 'Northwind: Ops',
        slug: 'northwind',
      },
    ])

    expect(issuer).toBe('Northwind Ops')
    expect(label).toBe('Northwind Ops:user@example.test')
  })

  it('falls back to the instance host when the organization name is unavailable', async () => {
    const { label, issuer } = await requestTotpSetupUri([])

    expect(issuer).toBe('XID (acme.xid.dev)')
    expect(label).toBe('XID (acme.xid.dev):user@example.test')
  })

  it('rejects setup when active TOTP already exists', async () => {
    const db = makeFakeD1({ mfa_factors: [totpRow()], backup_codes: [] })
    const env = { DB: db, KEK: 'zMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMw' } as unknown as Env
    const app = buildApp({
      register: registerMfaFactorsRoutes,
      session: makeSession({ userId: 'u_1' }),
    })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/mfa-factors/totp/setup',
      { method: 'POST' },
      env,
    )

    expect(res.status).toBe(409)
  })

  it('allows setup while session is pending_mfa_setup', async () => {
    const db = makeFakeD1({ mfa_factors: [], backup_codes: [] })
    const env = {
      DB: db,
      KEK: 'zMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMw',
      CACHE: {},
    } as unknown as Env
    const app = buildApp({
      register: registerMfaFactorsRoutes,
      session: makeSession({ userId: 'u_1', status: 'pending_mfa_setup' }),
    })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/mfa-factors/totp/setup',
      { method: 'POST' },
      env,
    )

    expect(res.status).toBe(200)
  })
})

describe('POST /v1/me/mfa-factors/backup-codes', () => {
  it('returns one-time backup codes for the current session user after step-up', async () => {
    const db = makeFakeD1({ mfa_factors: [totpRow()], backup_codes: [] })
    const session = makeSession({ userId: 'u_1' })
    const app = buildApp({ register: registerMfaFactorsRoutes, session })

    const res = await stepUpRequest(app, {
      path: '/v1/me/mfa-factors/backup-codes',
      method: 'POST',
      env: { DB: db, PEPPER: TEST_PEPPER } as unknown as Env,
      session,
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(typeof body['batchId']).toBe('string')
    expect(body['codes']).toHaveLength(10)
    expect((body['codes'] as string[])[0]).toMatch(/^[A-Z2-9]{8}$/)
  })

  it('requires step-up before regenerating backup codes', async () => {
    const db = makeFakeD1({ mfa_factors: [totpRow()], backup_codes: [] })
    const app = buildApp({
      register: registerMfaFactorsRoutes,
      session: makeSession({ userId: 'u_1' }),
    })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/mfa-factors/backup-codes',
      { method: 'POST' },
      { DB: db, PEPPER: TEST_PEPPER } as unknown as Env,
    )

    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ code: 'step_up_required' })
  })

  it('treats a passkey as a strong factor for backup codes', async () => {
    const db = makeFakeD1({ passkey_credentials: [passkeyRow()], backup_codes: [] })
    const session = makeSession({ userId: 'u_1' })
    const app = buildApp({ register: registerMfaFactorsRoutes, session })

    const res = await stepUpRequest(app, {
      path: '/v1/me/mfa-factors/backup-codes',
      method: 'POST',
      env: { DB: db, PEPPER: TEST_PEPPER } as unknown as Env,
      session,
    })

    expect(res.status).toBe(200)
  })

  it('rejects backup codes when no strong MFA factor exists', async () => {
    const db = makeFakeD1({
      mfa_factors: [],
      user_phones: [verifiedPhoneRow()],
      backup_codes: [],
    })
    const env = {
      DB: db,
      PEPPER: 'v1:3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3',
    } as unknown as Env
    const app = buildApp({
      register: registerMfaFactorsRoutes,
      session: makeSession({ userId: 'u_1' }),
    })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/mfa-factors/backup-codes',
      { method: 'POST' },
      env,
    )

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'mfa_required' })
  })

  it('returns 401 when generating backup codes without a session', async () => {
    const db = makeFakeD1({ backup_codes: [] })
    const env = { DB: db } as unknown as Env
    const app = buildApp({ register: registerMfaFactorsRoutes, session: null })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/mfa-factors/backup-codes',
      { method: 'POST' },
      env,
    )

    expect(res.status).toBe(401)
  })
})

describe('SMS factor enrollment', () => {
  it('reports SMS as enrollable once a strong factor and verified phone exist', async () => {
    const db = makeFakeD1({ mfa_factors: [totpRow()], user_phones: [verifiedPhoneRow()] })
    const app = buildApp({
      register: registerMfaFactorsRoutes,
      session: makeSession({ userId: 'u_1' }),
      tenant: SMS_TENANT,
    })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/mfa-factors/sms',
      { method: 'GET' },
      smsEnv(db),
    )

    expect(await res.json()).toEqual({ enrollable: true, phoneLast4: '4567' })
  })

  it('enrolls the verified phone as SMS factor after step-up', async () => {
    const factors = [totpRow()]
    const db = makeFakeD1({ mfa_factors: factors, user_phones: [verifiedPhoneRow()] })
    const session = makeSession({ userId: 'u_1' })
    const app = buildApp({ register: registerMfaFactorsRoutes, session, tenant: SMS_TENANT })

    const res = await stepUpRequest(app, {
      path: '/v1/me/mfa-factors/sms',
      method: 'POST',
      env: smsEnv(db),
      session,
    })

    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ type: 'sms' })
  })

  it('refuses SMS enrollment while forced MFA setup is still pending', async () => {
    const factors = [totpRow({ status: 'pending' })]
    const db = makeFakeD1({ mfa_factors: factors, user_phones: [verifiedPhoneRow()] })
    const session = makeSession({ userId: 'u_1', status: 'pending_mfa_setup' })
    const app = buildApp({ register: registerMfaFactorsRoutes, session, tenant: SMS_TENANT })

    const res = await stepUpRequest(app, {
      path: '/v1/me/mfa-factors/sms',
      method: 'POST',
      env: smsEnv(db),
      session,
    })

    expect(res.status).toBe(401)
    expect(factors).toHaveLength(1)
  })

  it('does not enroll a verified phone that belongs to another tenant', async () => {
    const factors = [totpRow()]
    const db = makeFakeD1({
      mfa_factors: factors,
      user_phones: [{ ...verifiedPhoneRow(), tenant_id: 't_other' }],
    })
    const session = makeSession({ userId: 'u_1' })
    const app = buildApp({ register: registerMfaFactorsRoutes, session, tenant: SMS_TENANT })

    const res = await stepUpRequest(app, {
      path: '/v1/me/mfa-factors/sms',
      method: 'POST',
      env: smsEnv(db),
      session,
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 'invalid_request' })
    expect(factors).toHaveLength(1)
  })

  it('refuses SMS as the only factor', async () => {
    const db = makeFakeD1({ mfa_factors: [], user_phones: [verifiedPhoneRow()] })
    const session = makeSession({ userId: 'u_1' })
    const app = buildApp({ register: registerMfaFactorsRoutes, session, tenant: SMS_TENANT })

    const res = await stepUpRequest(app, {
      path: '/v1/me/mfa-factors/sms',
      method: 'POST',
      env: smsEnv(db),
      session,
    })

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'mfa_required' })
  })
})
