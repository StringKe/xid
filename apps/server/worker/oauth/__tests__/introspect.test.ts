// /introspect 单元测试:RFC7662 access token JWT / refresh token / inactive / confidential gate。
import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import {
  buildAccessTokenClaims,
  hashRefreshToken,
  signAccessTokenClaims,
  signClaims,
} from '@xid-kit/protocol'
import { loadSigningKey, sha256Hex } from '@xid-kit/crypto'
import type { TenantContext } from '@xid-kit/types'
import type { XidHonoEnv } from '../../lib/types'
import { registerIntrospect } from '../introspect'
import { testErrorHandler } from './mock-helpers'
import { buildTestTenant, makeEnv, makeFakeD1, type TableSet } from '../../oidc/__tests__/helpers'

const CLIENT_ID = 'cli_app'
const CLIENT_SECRET = 'sec_introspect'
const USER_ID = 'u_1'

function decodeKek(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function appRow(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return {
    id: 'app_1',
    tenant_id: 't_1',
    client_id: CLIENT_ID,
    client_secret_hash: await sha256Hex(CLIENT_SECRET),
    client_type: 'confidential',
    token_endpoint_auth_method: 'client_secret_basic',
    jwks: null,
    redirect_uris: JSON.stringify(['https://rp.example/cb']),
    post_logout_redirect_uris: JSON.stringify([]),
    allowed_grant_types: JSON.stringify(['authorization_code', 'refresh_token']),
    allowed_response_types: JSON.stringify(['code']),
    allowed_scopes: JSON.stringify(['openid', 'profile', 'email']),
    require_pkce: 1,
    dpop_bound_access_tokens: 0,
    access_token_format: 'jwt',
    access_token_ttl_sec: 3600,
    id_token_signed_alg: 'ES256',
    first_party: 1,
    require_org_context: 0,
    custom_claims_config: JSON.stringify({}),
    registration_access_token_hash: null,
    project_id: null,
    status: 'active',
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  }
}

function refreshRow(
  tokenHash: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const now = Date.now()
  return {
    id: 'rt_1',
    tenant_id: 't_1',
    token_hash: tokenHash,
    family_id: 'fam_1',
    parent_token_id: null,
    user_id: USER_ID,
    client_id: CLIENT_ID,
    scope: 'openid profile',
    jkt: null,
    active_org_id: null,
    project_grant_id: null,
    resource: null,
    auth_time: null,
    acr: null,
    amr: null,
    authorization_details: null,
    revoked_at: null,
    expires_at: now + 3600_000,
    absolute_expires_at: now + 86400_000,
    created_at: now,
    ...overrides,
  }
}

function accessRevocationRow(jti: string): Record<string, unknown> {
  const now = Date.now()
  return {
    id: 'atr_1',
    tenant_id: 't_1',
    jti,
    client_id: CLIENT_ID,
    subject: USER_ID,
    expires_at: now + 3600_000,
    revoked_at: now,
    created_at: now,
  }
}

function makeApp(ctx: TenantContext): Hono<XidHonoEnv> {
  const app = new Hono<XidHonoEnv>()
  app.onError(testErrorHandler)
  app.use('*', async (c, next) => {
    c.set('tenant', ctx)
    await next()
  })
  registerIntrospect(app)
  return app
}

function basicAuth(): string {
  return `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`
}

async function postIntrospect(
  app: Hono<XidHonoEnv>,
  env: Env,
  params: Record<string, string>,
  authHeader = basicAuth(),
): Promise<Response> {
  return app.request(
    'https://acme.xid.dev/introspect',
    {
      method: 'POST',
      headers: {
        authorization: authHeader,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params).toString(),
    },
    env,
  )
}

async function mintAccessToken(
  ctx: TenantContext,
  kekB64: string,
  options: Parameters<typeof buildAccessTokenClaims>[0]['options'] = { sid: 'sess_1' },
): Promise<string> {
  const material = ctx.signingKeys.keys[0]!
  const key = await loadSigningKey(material.encryptedPrivateKey, decodeKek(kekB64))
  const claims = buildAccessTokenClaims({
    ctx,
    subject: { userId: USER_ID },
    clientId: CLIENT_ID,
    scope: 'openid profile',
    audience: 'https://api.example.com',
    now: Math.floor(Date.now() / 1000),
    ttlSec: 3600,
    options,
  })
  return signAccessTokenClaims(ctx, key, claims)
}

async function mintAccessTokenWithJti(
  ctx: TenantContext,
  kekB64: string,
  jti: string,
): Promise<string> {
  const material = ctx.signingKeys.keys[0]!
  const key = await loadSigningKey(material.encryptedPrivateKey, decodeKek(kekB64))
  const claims = buildAccessTokenClaims({
    ctx,
    subject: { userId: USER_ID },
    clientId: CLIENT_ID,
    scope: 'openid profile',
    audience: 'https://api.example.com',
    now: Math.floor(Date.now() / 1000),
    ttlSec: 3600,
    options: { sid: 'sess_1' },
  })
  claims.jti = jti
  return signAccessTokenClaims(ctx, key, claims)
}

// 切换前签发的存量 token:无 tenant_id claim(兼容路径用例)。
async function mintLegacyAccessToken(ctx: TenantContext, kekB64: string): Promise<string> {
  const material = ctx.signingKeys.keys[0]!
  const key = await loadSigningKey(material.encryptedPrivateKey, decodeKek(kekB64))
  const claims = buildAccessTokenClaims({
    ctx,
    subject: { userId: USER_ID },
    clientId: CLIENT_ID,
    scope: 'openid profile',
    audience: 'https://api.example.com',
    now: Math.floor(Date.now() / 1000),
    ttlSec: 3600,
    options: { sid: 'sess_1' },
  })
  delete claims['tenant_id']
  return signAccessTokenClaims(ctx, key, claims)
}

describe('/introspect: access token', () => {
  it('返回 active JWT claims', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const token = await mintAccessToken(ctx, kekB64)
    const tables: TableSet = { applications: [await appRow()] }
    const env = makeEnv({ DB: makeFakeD1(tables), KEK: kekB64 })
    const app = makeApp(ctx)
    const res = await postIntrospect(app, env, { token, token_type_hint: 'access_token' })

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('pragma')).toBe('no-cache')
    const body = await res.json<Record<string, unknown>>()
    expect(body['active']).toBe(true)
    expect(body['token_type']).toBe('Bearer')
    expect(body['iss']).toBe(ctx.issuer)
    expect(body['sub']).toBe(USER_ID)
    expect(body['aud']).toBe('https://api.example.com')
    expect(body['scope']).toBe('openid profile')
    expect(body['client_id']).toBe(CLIENT_ID)
    expect(body['sid']).toBe('sess_1')
  })

  it('access token authorization_details 返回内省结果', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const authorizationDetails = [
      {
        type: 'resource_access' as const,
        locations: ['https://api.example.com'],
        actions: ['read'],
      },
    ]
    const token = await mintAccessToken(ctx, kekB64, {
      sid: 'sess_1',
      authorizationDetails,
    })
    const tables: TableSet = { applications: [await appRow()] }
    const env = makeEnv({ DB: makeFakeD1(tables), KEK: kekB64 })
    const app = makeApp(ctx)
    const res = await postIntrospect(app, env, { token, token_type_hint: 'access_token' })

    expect(res.status).toBe(200)
    const body = await res.json<Record<string, unknown>>()
    expect(body['authorization_details']).toEqual(authorizationDetails)
  })

  it('非 access-token typ 的 JWT 返回 inactive', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const material = ctx.signingKeys.keys[0]!
    const key = await loadSigningKey(material.encryptedPrivateKey, decodeKek(kekB64))
    const token = await signClaims(ctx, key, {
      iss: ctx.issuer,
      sub: USER_ID,
      aud: 'https://api.example.com',
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      jti: crypto.randomUUID(),
    })
    const tables: TableSet = { applications: [await appRow()] }
    const env = makeEnv({ DB: makeFakeD1(tables), KEK: kekB64 })
    const app = makeApp(ctx)
    const res = await postIntrospect(app, env, { token, token_type_hint: 'access_token' })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ active: false })
  })

  it('denylist 命中的 access token 返回 inactive', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const token = await mintAccessTokenWithJti(ctx, kekB64, 'jti_revoked')
    const tables: TableSet = {
      applications: [await appRow()],
      access_token_revocations: [accessRevocationRow('jti_revoked')],
    }
    const env = makeEnv({ DB: makeFakeD1(tables), KEK: kekB64 })
    const app = makeApp(ctx)
    const res = await postIntrospect(app, env, { token, token_type_hint: 'access_token' })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ active: false })
  })

  it('DPoP 绑定 access token 报 token_type=DPoP 并回显 cnf.jkt', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const token = await mintAccessToken(ctx, kekB64, { sid: 'sess_1', cnf: { jkt: 'jkt_thumb_1' } })
    const tables: TableSet = { applications: [await appRow()] }
    const env = makeEnv({ DB: makeFakeD1(tables), KEK: kekB64 })
    const app = makeApp(ctx)
    const res = await postIntrospect(app, env, { token, token_type_hint: 'access_token' })

    expect(res.status).toBe(200)
    const body = await res.json<Record<string, unknown>>()
    expect(body['active']).toBe(true)
    expect(body['token_type']).toBe('DPoP')
    expect(body['cnf']).toEqual({ jkt: 'jkt_thumb_1' })
  })

  it('tenant_id 不匹配的 access token 返回 inactive(跨租户拒绝)', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    // instance 签名密钥与 issuer 全租户共享:另一租户上下文仅 tenantId 不同,验签仍通过。
    const ctxB: TenantContext = { ...ctx, tenantId: 't_2' }
    const token = await mintAccessToken(ctx, kekB64)
    const tables: TableSet = { applications: [await appRow({ tenant_id: 't_2' })] }
    const env = makeEnv({ DB: makeFakeD1(tables), KEK: kekB64 })
    const app = makeApp(ctxB)
    const res = await postIntrospect(app, env, { token, token_type_hint: 'access_token' })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ active: false })
  })

  it('无 tenant_id 的旧 access token 按原路径放行(存量兼容)', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const token = await mintLegacyAccessToken(ctx, kekB64)
    const tables: TableSet = { applications: [await appRow()] }
    const env = makeEnv({ DB: makeFakeD1(tables), KEK: kekB64 })
    const app = makeApp(ctx)
    const res = await postIntrospect(app, env, { token, token_type_hint: 'access_token' })

    expect(res.status).toBe(200)
    const body = await res.json<Record<string, unknown>>()
    expect(body['active']).toBe(true)
    expect(body['sub']).toBe(USER_ID)
  })
})

describe('/introspect: refresh token', () => {
  it('hash 命中且未撤销时返回 active refresh token claims', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const refreshToken = 'rt_introspect_value'
    const tables: TableSet = {
      applications: [await appRow()],
      refresh_tokens: [refreshRow(await hashRefreshToken(refreshToken))],
    }
    const env = makeEnv({ DB: makeFakeD1(tables), KEK: kekB64 })
    const app = makeApp(ctx)
    const res = await postIntrospect(app, env, {
      token: refreshToken,
      token_type_hint: 'refresh_token',
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await res.json<Record<string, unknown>>()
    expect(body['active']).toBe(true)
    expect(body['token_type']).toBe('refresh_token')
    expect(body['sub']).toBe(USER_ID)
    expect(body['client_id']).toBe(CLIENT_ID)
    expect(body['scope']).toBe('openid profile')
    expect(typeof body['exp']).toBe('number')
  })

  it('refresh token authorization_details 返回内省结果', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const refreshToken = 'rt_introspect_rar'
    const authorizationDetails = [
      {
        type: 'resource_access',
        locations: ['https://api.example.com'],
        actions: ['read'],
      },
    ]
    const tables: TableSet = {
      applications: [await appRow()],
      refresh_tokens: [
        refreshRow(await hashRefreshToken(refreshToken), {
          authorization_details: JSON.stringify(authorizationDetails),
        }),
      ],
    }
    const env = makeEnv({ DB: makeFakeD1(tables), KEK: kekB64 })
    const app = makeApp(ctx)
    const res = await postIntrospect(app, env, {
      token: refreshToken,
      token_type_hint: 'refresh_token',
    })

    expect(res.status).toBe(200)
    const body = await res.json<Record<string, unknown>>()
    expect(body['authorization_details']).toEqual(authorizationDetails)
  })

  it('未知 refresh token 返回 inactive', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const tables: TableSet = { applications: [await appRow()] }
    const env = makeEnv({ DB: makeFakeD1(tables), KEK: kekB64 })
    const app = makeApp(ctx)
    const res = await postIntrospect(app, env, {
      token: 'rt_unknown',
      token_type_hint: 'refresh_token',
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ active: false })
  })

  it('已撤销 refresh token 返回 inactive', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const refreshToken = 'rt_revoked'
    const tables: TableSet = {
      applications: [await appRow()],
      refresh_tokens: [
        refreshRow(await hashRefreshToken(refreshToken), { revoked_at: Date.now() - 1000 }),
      ],
    }
    const env = makeEnv({ DB: makeFakeD1(tables), KEK: kekB64 })
    const app = makeApp(ctx)
    const res = await postIntrospect(app, env, {
      token: refreshToken,
      token_type_hint: 'refresh_token',
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ active: false })
  })

  it('DPoP 绑定 refresh token(jkt 列)报 token_type=DPoP 并回显 cnf.jkt', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const refreshToken = 'rt_dpop_bound'
    const tables: TableSet = {
      applications: [await appRow()],
      refresh_tokens: [refreshRow(await hashRefreshToken(refreshToken), { jkt: 'jkt_rt_1' })],
    }
    const env = makeEnv({ DB: makeFakeD1(tables), KEK: kekB64 })
    const app = makeApp(ctx)
    const res = await postIntrospect(app, env, {
      token: refreshToken,
      token_type_hint: 'refresh_token',
    })

    expect(res.status).toBe(200)
    const body = await res.json<Record<string, unknown>>()
    expect(body['active']).toBe(true)
    expect(body['token_type']).toBe('DPoP')
    expect(body['cnf']).toEqual({ jkt: 'jkt_rt_1' })
  })
})

describe('/introspect: client gate and request validation', () => {
  it('Basic 与 body 同时认证时保留 400 invalid_request 端点错误形状', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const tables: TableSet = { applications: [await appRow()] }
    const env = makeEnv({ DB: makeFakeD1(tables), KEK: kekB64 })
    const app = makeApp(ctx)
    const res = await postIntrospect(app, env, {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      token: 'not-reached',
    })

    expect(res.status).toBe(400)
    expect(res.headers.get('www-authenticate')).toBeNull()
    expect(await res.json()).toEqual({
      error: 'invalid_request',
      error_description: 'multiple client authentication methods presented',
    })
  })

  it('匿名 DCR confidential client 不是 trusted first-party,无法内省 tenant token', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const tables: TableSet = {
      applications: [await appRow({ first_party: 0 })],
    }
    const env = makeEnv({ DB: makeFakeD1(tables), KEK: kekB64 })
    const app = makeApp(ctx)
    const res = await postIntrospect(app, env, { token: 'rt_cross_tenant_inventory' })

    expect(res.status).toBe(401)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('pragma')).toBe('no-cache')
    expect(await res.json()).toEqual({
      error: 'invalid_client',
      error_description: 'token introspection requires a trusted first-party client',
    })
  })

  it('public client 被 requireConfidential 拒绝', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const tables: TableSet = {
      applications: [
        await appRow({
          client_secret_hash: null,
          client_type: 'public',
          token_endpoint_auth_method: 'none',
        }),
      ],
    }
    const env = makeEnv({ DB: makeFakeD1(tables), KEK: kekB64 })
    const app = makeApp(ctx)
    const res = await postIntrospect(app, env, { client_id: CLIENT_ID, token: 'rt_public' }, '')

    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe('Basic realm="xid", error="invalid_client"')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('pragma')).toBe('no-cache')
    const body = await res.json<Record<string, unknown>>()
    expect(body['error']).toBe('invalid_client')
    expect(typeof body['error_description']).toBe('string')
  })

  it('缺少 token 返回 400 invalid_request(RFC 错误形状)', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const tables: TableSet = { applications: [await appRow()] }
    const env = makeEnv({ DB: makeFakeD1(tables), KEK: kekB64 })
    const app = makeApp(ctx)
    const res = await postIntrospect(app, env, {})

    expect(res.status).toBe(400)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('pragma')).toBe('no-cache')
    expect(await res.json()).toEqual({
      error: 'invalid_request',
      error_description: 'Missing or invalid parameter: token',
    })
  })
})
