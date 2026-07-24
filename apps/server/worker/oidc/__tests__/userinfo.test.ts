// /userinfo 端点测试:Bearer access token(本 issuer 签发)-> 用户 claims(scope 投影);
// JSON 与 application/jwt Accept 协商;缺 token / 验签失败 -> 401 invalid_token。

import { describe, it, expect } from 'vitest'
import { buildAccessTokenClaims, signAccessTokenClaims, signClaims } from '@xid-kit/protocol'
import { loadSigningKey } from '@xid-kit/crypto'
import type { TenantContext } from '@xid-kit/types'
import { registerUserinfoRoutes } from '../userinfo'
import { buildTestTenant, makeApp, makeEnv, makeFakeD1, type TableSet } from './helpers'

const USER_ID = 'u_1'

function decodeKek(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// 用 active 私钥签发一个 access token(本 issuer)。
async function mintAccessToken(ctx: TenantContext, kekB64: string, scope: string): Promise<string> {
  const material = ctx.signingKeys.keys[0]!
  const key = await loadSigningKey(material.encryptedPrivateKey, decodeKek(kekB64))
  const claims = buildAccessTokenClaims({
    ctx,
    subject: { userId: USER_ID },
    clientId: 'cli_app',
    scope,
    audience: 'cli_app',
    now: Math.floor(Date.now() / 1000),
    ttlSec: 3600,
  })
  return signAccessTokenClaims(ctx, key, claims)
}

async function mintAccessTokenWithJti(
  ctx: TenantContext,
  kekB64: string,
  scope: string,
  jti: string,
): Promise<string> {
  const material = ctx.signingKeys.keys[0]!
  const key = await loadSigningKey(material.encryptedPrivateKey, decodeKek(kekB64))
  const claims = buildAccessTokenClaims({
    ctx,
    subject: { userId: USER_ID },
    clientId: 'cli_app',
    scope,
    audience: 'cli_app',
    now: Math.floor(Date.now() / 1000),
    ttlSec: 3600,
  })
  claims.jti = jti
  return signAccessTokenClaims(ctx, key, claims)
}

async function mintAccessTokenWithAudience(
  ctx: TenantContext,
  kekB64: string,
  audience: string,
): Promise<string> {
  const material = ctx.signingKeys.keys[0]!
  const key = await loadSigningKey(material.encryptedPrivateKey, decodeKek(kekB64))
  const claims = buildAccessTokenClaims({
    ctx,
    subject: { userId: USER_ID },
    clientId: 'cli_app',
    scope: 'openid profile',
    audience,
    now: Math.floor(Date.now() / 1000),
    ttlSec: 3600,
  })
  return signAccessTokenClaims(ctx, key, claims)
}

async function mintJwtTypToken(ctx: TenantContext, kekB64: string): Promise<string> {
  const material = ctx.signingKeys.keys[0]!
  const key = await loadSigningKey(material.encryptedPrivateKey, decodeKek(kekB64))
  const claims = buildAccessTokenClaims({
    ctx,
    subject: { userId: USER_ID },
    clientId: 'cli_app',
    scope: 'openid profile email',
    audience: 'cli_app',
    now: Math.floor(Date.now() / 1000),
    ttlSec: 3600,
  })
  return signClaims(ctx, key, claims)
}

// 切换前签发的存量 token:无 tenant_id claim(兼容路径用例)。
async function mintLegacyAccessToken(ctx: TenantContext, kekB64: string): Promise<string> {
  const material = ctx.signingKeys.keys[0]!
  const key = await loadSigningKey(material.encryptedPrivateKey, decodeKek(kekB64))
  const claims = buildAccessTokenClaims({
    ctx,
    subject: { userId: USER_ID },
    clientId: 'cli_app',
    scope: 'openid profile email',
    audience: 'cli_app',
    now: Math.floor(Date.now() / 1000),
    ttlSec: 3600,
  })
  delete claims['tenant_id']
  return signAccessTokenClaims(ctx, key, claims)
}

function userRow(): Record<string, unknown> {
  return {
    id: USER_ID,
    tenant_id: 't_1',
    username: 'alice',
    external_id: null,
    primary_email_id: 'em_1',
    primary_phone_id: null,
    first_name: 'Alice',
    last_name: 'Smith',
    display_name: 'Alice Smith',
    avatar_url: null,
    locale: 'en',
    timezone: null,
    public_metadata: JSON.stringify({}),
    private_metadata: JSON.stringify({}),
    unsafe_metadata: JSON.stringify({}),
    custom_attributes: JSON.stringify({}),
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
    created_at: Date.now(),
    updated_at: Date.now(),
  }
}

function emailRow(): Record<string, unknown> {
  return {
    id: 'em_1',
    tenant_id: 't_1',
    user_id: USER_ID,
    email: 'alice@example.com',
    verified: 1,
    verification_status: 'verified',
    is_primary: 1,
    verified_at: Date.now(),
    created_at: Date.now(),
    updated_at: Date.now(),
  }
}

function phoneRow(): Record<string, unknown> {
  return {
    id: 'ph_1',
    tenant_id: 't_1',
    user_id: USER_ID,
    phone: '+14155552671',
    verified: 1,
    verification_status: 'verified',
    is_primary: 1,
    verified_at: Date.now(),
    created_at: Date.now(),
    updated_at: Date.now(),
  }
}

// public SPA client:redirectUris origin 集即 CORS 白名单。
function clientRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'app_1',
    tenant_id: 't_1',
    client_id: 'cli_app',
    client_type: 'public',
    redirect_uris: JSON.stringify(['https://spa.example.com/callback']),
    status: 'active',
    created_at: Date.now(),
    updated_at: Date.now(),
    ...over,
  }
}

function tables(): TableSet {
  return { users: [userRow()], user_emails: [emailRow()] }
}

function revokedAccessTokenRow(jti: string): Record<string, unknown> {
  const now = Date.now()
  return {
    id: 'atr_1',
    tenant_id: 't_1',
    jti,
    client_id: 'cli_app',
    subject: USER_ID,
    expires_at: now + 3600_000,
    revoked_at: now,
    created_at: now,
  }
}

describe('/userinfo', () => {
  it('Bearer token -> JSON claims(profile + email scope 投影)', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const token = await mintAccessToken(ctx, kekB64, 'openid profile email')
    const env = makeEnv({ DB: makeFakeD1(tables()), KEK: kekB64 })
    const app = makeApp(ctx, registerUserinfoRoutes)
    const res = await app.request(
      'https://acme.xid.dev/userinfo',
      { headers: { authorization: `Bearer ${token}` } },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['sub']).toBe(USER_ID)
    expect(body['name']).toBe('Alice Smith')
    expect(body['email']).toBe('alice@example.com')
    expect(body['email_verified']).toBe(true)
  })

  it('Accept application/jwt -> 返回签名 JWT', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const token = await mintAccessToken(ctx, kekB64, 'openid')
    const env = makeEnv({ DB: makeFakeD1(tables()), KEK: kekB64 })
    const app = makeApp(ctx, registerUserinfoRoutes)
    const res = await app.request(
      'https://acme.xid.dev/userinfo',
      { headers: { authorization: `Bearer ${token}`, accept: 'application/jwt' } },
      env,
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/jwt')
    expect((await res.text()).split('.')).toHaveLength(3)
  })

  it('phone scope -> phone_number/phone_number_verified', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const token = await mintAccessToken(ctx, kekB64, 'openid phone')
    const env = makeEnv({
      DB: makeFakeD1({
        users: [{ ...userRow(), primary_phone_id: 'ph_1' }],
        user_emails: [emailRow()],
        user_phones: [phoneRow()],
      }),
      KEK: kekB64,
    })
    const app = makeApp(ctx, registerUserinfoRoutes)
    const res = await app.request(
      'https://acme.xid.dev/userinfo',
      { headers: { authorization: `Bearer ${token}` } },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['phone_number']).toBe('+14155552671')
    expect(body['phone_number_verified']).toBe(true)
  })

  it('无 phone scope -> 不输出 phone claims', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const token = await mintAccessToken(ctx, kekB64, 'openid profile')
    const env = makeEnv({
      DB: makeFakeD1({
        users: [{ ...userRow(), primary_phone_id: 'ph_1' }],
        user_emails: [emailRow()],
        user_phones: [phoneRow()],
      }),
      KEK: kekB64,
    })
    const app = makeApp(ctx, registerUserinfoRoutes)
    const res = await app.request(
      'https://acme.xid.dev/userinfo',
      { headers: { authorization: `Bearer ${token}` } },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect('phone_number' in body).toBe(false)
  })

  it('成功响应带 pragma no-cache', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const token = await mintAccessToken(ctx, kekB64, 'openid')
    const env = makeEnv({ DB: makeFakeD1(tables()), KEK: kekB64 })
    const app = makeApp(ctx, registerUserinfoRoutes)
    const res = await app.request(
      'https://acme.xid.dev/userinfo',
      { headers: { authorization: `Bearer ${token}` } },
      env,
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('pragma')).toBe('no-cache')
  })
})

describe('/userinfo CORS', () => {
  it('OPTIONS 预检(client_id + 白名单 origin)-> 204 + allow 头(allow-headers 含 authorization)', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const env = makeEnv({
      DB: makeFakeD1({ ...tables(), applications: [clientRow()] }),
      KEK: kekB64,
    })
    const app = makeApp(ctx, registerUserinfoRoutes)
    const res = await app.request(
      'https://acme.xid.dev/userinfo?client_id=cli_app',
      {
        method: 'OPTIONS',
        headers: {
          origin: 'https://spa.example.com',
          'access-control-request-method': 'GET',
        },
      },
      env,
    )
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('https://spa.example.com')
    expect(res.headers.get('access-control-allow-methods')).toContain('GET')
    expect(res.headers.get('access-control-allow-headers')).toContain('authorization')
  })

  it('OPTIONS 预检(origin 不在白名单)-> 204 不回 ACAO', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const env = makeEnv({
      DB: makeFakeD1({ ...tables(), applications: [clientRow()] }),
      KEK: kekB64,
    })
    const app = makeApp(ctx, registerUserinfoRoutes)
    const res = await app.request(
      'https://acme.xid.dev/userinfo?client_id=cli_app',
      {
        method: 'OPTIONS',
        headers: {
          origin: 'https://evil.example.com',
          'access-control-request-method': 'GET',
        },
      },
      env,
    )
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('public client origin 白名单命中 -> 响应带 CORS 头', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const token = await mintAccessToken(ctx, kekB64, 'openid')
    const env = makeEnv({
      DB: makeFakeD1({ ...tables(), applications: [clientRow()] }),
      KEK: kekB64,
    })
    const app = makeApp(ctx, registerUserinfoRoutes)
    const res = await app.request(
      'https://acme.xid.dev/userinfo',
      {
        headers: {
          authorization: `Bearer ${token}`,
          origin: 'https://spa.example.com',
        },
      },
      env,
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('https://spa.example.com')
    expect(res.headers.get('access-control-allow-headers')).toContain('authorization')
  })

  it('origin 不在 client redirectUris 白名单 -> 无 CORS 头', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const token = await mintAccessToken(ctx, kekB64, 'openid')
    const env = makeEnv({
      DB: makeFakeD1({ ...tables(), applications: [clientRow()] }),
      KEK: kekB64,
    })
    const app = makeApp(ctx, registerUserinfoRoutes)
    const res = await app.request(
      'https://acme.xid.dev/userinfo',
      {
        headers: {
          authorization: `Bearer ${token}`,
          origin: 'https://evil.example.com',
        },
      },
      env,
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('/userinfo rejects', () => {
  it('缺 token -> 401 invalid_token', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const env = makeEnv({ DB: makeFakeD1(tables()), KEK: kekB64 })
    const app = makeApp(ctx, registerUserinfoRoutes)
    const res = await app.request('https://acme.xid.dev/userinfo', {}, env)
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain('Bearer')
  })

  it('伪造 token(签名无效)-> 401', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const env = makeEnv({ DB: makeFakeD1(tables()), KEK: kekB64 })
    const app = makeApp(ctx, registerUserinfoRoutes)
    const res = await app.request(
      'https://acme.xid.dev/userinfo',
      { headers: { authorization: 'Bearer eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.bad' } },
      env,
    )
    expect(res.status).toBe(401)
  })

  it('soft deleted user status -> 401 invalid_token', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const token = await mintAccessToken(ctx, kekB64, 'openid profile email')
    const env = makeEnv({
      DB: makeFakeD1({
        users: [{ ...userRow(), status: 'deleted' }],
        user_emails: [emailRow()],
      }),
      KEK: kekB64,
    })
    const app = makeApp(ctx, registerUserinfoRoutes)
    const res = await app.request(
      'https://acme.xid.dev/userinfo',
      { headers: { authorization: `Bearer ${token}` } },
      env,
    )
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain('Bearer')
  })

  it('soft deleted user deleted_at -> 401 invalid_token', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const token = await mintAccessToken(ctx, kekB64, 'openid profile email')
    const env = makeEnv({
      DB: makeFakeD1({
        users: [{ ...userRow(), deleted_at: Date.now() }],
        user_emails: [emailRow()],
      }),
      KEK: kekB64,
    })
    const app = makeApp(ctx, registerUserinfoRoutes)
    const res = await app.request(
      'https://acme.xid.dev/userinfo',
      { headers: { authorization: `Bearer ${token}` } },
      env,
    )
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain('Bearer')
  })

  it('非 access-token typ 的 JWT -> 401 invalid_token', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const token = await mintJwtTypToken(ctx, kekB64)
    const env = makeEnv({ DB: makeFakeD1(tables()), KEK: kekB64 })
    const app = makeApp(ctx, registerUserinfoRoutes)
    const res = await app.request(
      'https://acme.xid.dev/userinfo',
      { headers: { authorization: `Bearer ${token}` } },
      env,
    )

    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain('Bearer')
  })

  it('已撤销 access token -> 401 invalid_token', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const token = await mintAccessTokenWithJti(ctx, kekB64, 'openid profile email', 'jti_revoked')
    const env = makeEnv({
      DB: makeFakeD1({
        ...tables(),
        access_token_revocations: [revokedAccessTokenRow('jti_revoked')],
      }),
      KEK: kekB64,
    })
    const app = makeApp(ctx, registerUserinfoRoutes)
    const res = await app.request(
      'https://acme.xid.dev/userinfo',
      { headers: { authorization: `Bearer ${token}` } },
      env,
    )

    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain('Bearer')
  })

  it('aud 不含 issuer/client_id -> 401 invalid_token', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const token = await mintAccessTokenWithAudience(ctx, kekB64, 'https://api.other.example/v1')
    const env = makeEnv({ DB: makeFakeD1(tables()), KEK: kekB64 })
    const app = makeApp(ctx, registerUserinfoRoutes)
    const res = await app.request(
      'https://acme.xid.dev/userinfo',
      { headers: { authorization: `Bearer ${token}` } },
      env,
    )

    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain('Bearer')
  })

  it('aud=issuer 的第一方 session token -> 200', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const token = await mintAccessTokenWithAudience(ctx, kekB64, ctx.issuer)
    const env = makeEnv({ DB: makeFakeD1(tables()), KEK: kekB64 })
    const app = makeApp(ctx, registerUserinfoRoutes)
    const res = await app.request(
      'https://acme.xid.dev/userinfo',
      { headers: { authorization: `Bearer ${token}` } },
      env,
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['sub']).toBe(USER_ID)
  })

  it('tenant_id 不匹配(他租户 token)-> 401 invalid_token', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    // instance 签名密钥与 issuer 全租户共享:另一租户上下文仅 tenantId 不同,验签仍通过。
    const ctxB: TenantContext = { ...ctx, tenantId: 't_2' }
    const token = await mintAccessToken(ctx, kekB64, 'openid profile email')
    const env = makeEnv({ DB: makeFakeD1(tables()), KEK: kekB64 })
    const app = makeApp(ctxB, registerUserinfoRoutes)
    const res = await app.request(
      'https://acme.xid.dev/userinfo',
      { headers: { authorization: `Bearer ${token}` } },
      env,
    )

    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain('Bearer')
    const body = (await res.json()) as Record<string, unknown>
    expect(body['error']).toBe('invalid_token')
  })

  it('无 tenant_id 的旧 token 按原路径放行(存量兼容)-> 200', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const token = await mintLegacyAccessToken(ctx, kekB64)
    const env = makeEnv({ DB: makeFakeD1(tables()), KEK: kekB64 })
    const app = makeApp(ctx, registerUserinfoRoutes)
    const res = await app.request(
      'https://acme.xid.dev/userinfo',
      { headers: { authorization: `Bearer ${token}` } },
      env,
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['sub']).toBe(USER_ID)
  })
})
