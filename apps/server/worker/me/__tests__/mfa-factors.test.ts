// GET /v1/me/mfa-factors 测试:totp + backup_codes 判别 union(camelCase)+ 401 + 跨租户隔离。
// 仅 status='active';secret_ciphertext 不外泄;backup_codes remaining 走 countRemainingBackupCodes。

import { describe, it, expect } from 'vitest'
import { registerMfaFactorsRoutes } from '../mfa-factors'
import { buildApp, makeFakeD1, makeSession, TENANT } from './harness'

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

  it('lists SMS only when the user has a verified phone and provider is ready', async () => {
    const db = makeFakeD1({
      mfa_factors: [],
      backup_codes: [],
      user_phones: [verifiedPhoneRow()],
    })
    const env = {
      DB: db,
      TWILIO_ACCOUNT_SID: 'AC123',
      TWILIO_AUTH_TOKEN: 'token',
      SMS_FROM: '+15550000000',
    } as unknown as Env
    const app = buildApp({
      register: registerMfaFactorsRoutes,
      session: makeSession({ userId: 'u_1' }),
      tenant: {
        ...TENANT,
        policy: {
          deliveryChannels: {
            sms: {
              provider: 'twilio',
              enabled: true,
              secretRefs: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'],
              from: '+15550000000',
            },
          },
        },
      },
    })

    const res = await app.request('https://acme.xid.dev/v1/me/mfa-factors', { method: 'GET' }, env)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([
      { id: 'phone_1', type: 'sms', createdAt: new Date(now).toISOString() },
    ])
  })

  it('does not list passkeys after phr login when no linked mfa factor exists', async () => {
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

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
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
  it('revokes current user TOTP factor', async () => {
    const row = totpRow()
    const db = makeFakeD1({ mfa_factors: [row], backup_codes: [] })
    const env = { DB: db } as unknown as Env
    const app = buildApp({
      register: registerMfaFactorsRoutes,
      session: makeSession({ userId: 'u_1' }),
    })

    const res = await app.request(
      'https://acme.xid.dev/v1/me/mfa-factors/mf_1',
      { method: 'DELETE' },
      env,
    )

    expect(res.status).toBe(204)
    expect(row['status']).toBe('revoked')
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
    expect(body['factorId']).toMatch(/^mf_/)
    expect(body['secret']).toMatch(/^[A-Z2-7]+$/)
    expect(body['otpauthUri']).toContain('otpauth://totp/')
    expect(body).not.toHaveProperty('secretCiphertext')
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
  it('returns one-time backup codes for the current session user', async () => {
    const db = makeFakeD1({ mfa_factors: [totpRow()], backup_codes: [] })
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

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(typeof body['batchId']).toBe('string')
    expect(body['codes']).toHaveLength(10)
    expect((body['codes'] as string[])[0]).toMatch(/^[A-Z2-9]{8}$/)
  })

  it('rejects backup codes when only an active passkey is registered', async () => {
    const db = makeFakeD1({ passkey_credentials: [passkeyRow()], backup_codes: [] })
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
