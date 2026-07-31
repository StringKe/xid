// /token 端点测试:authorization_code(+PKCE)happy path 签发 access+id_token;
// PKCE 不匹配 / 未知 client / 缺 grant_type / Content-Type 错 拒绝。client_secret_post 认证。
// 用真实 ES256 签名密钥(loadActiveSigner 解密)+ 真实 verifyJwt 校验签发的 token。

import { describe, it, expect, vi } from 'vitest'
import {
  buildAccessTokenClaims,
  computeS256Challenge,
  generateCodeVerifier,
  generateRefreshToken,
  hashRefreshToken,
  signAccessTokenClaims,
  signClaims,
  buildIdTokenClaims,
} from '@xid-kit/protocol'
import { loadSigningKey, sha256Hex, verifyJwt } from '@xid-kit/crypto'
import { importJwkForVerify } from '@xid-kit/crypto'
import type { TenantContext } from '@xid-kit/types'
import { registerTokenRoutes } from '../token'
import {
  buildTestTenant,
  makeApp,
  makeEnv,
  makeFakeD1,
  makeFakeDoNs,
  makeFakeKv,
  type D1Capture,
  type TableSet,
} from './helpers'

const CLIENT_ID = 'cli_app'
const CLIENT_SECRET = 'sk_secret_value'
const USER_ID = 'u_1'
const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange'
const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
const SUBJECT_ACCESS = 'urn:ietf:params:oauth:token-type:access_token'
const SUBJECT_ID = 'urn:ietf:params:oauth:token-type:id_token'
const SUBJECT_REFRESH = 'urn:ietf:params:oauth:token-type:refresh_token'

async function appRow(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return {
    id: 'app_1',
    tenant_id: 't_1',
    client_id: CLIENT_ID,
    client_secret_hash: await sha256Hex(CLIENT_SECRET),
    client_type: 'confidential',
    token_endpoint_auth_method: 'client_secret_post',
    jwks: null,
    redirect_uris: JSON.stringify(['https://rp.example/cb']),
    post_logout_redirect_uris: JSON.stringify([]),
    allowed_grant_types: JSON.stringify(['authorization_code', 'refresh_token']),
    allowed_response_types: JSON.stringify(['code']),
    allowed_scopes: JSON.stringify(['openid', 'profile', 'email', 'offline_access']),
    require_pkce: 1,
    dpop_bound_access_tokens: 0,
    access_token_format: 'jwt',
    access_token_ttl_sec: 3600,
    id_token_signed_alg: 'ES256',
    first_party: 0,
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

function codeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    code: 'ac_test_code',
    tenant_id: 't_1',
    client_id: CLIENT_ID,
    user_id: USER_ID,
    redirect_uri: 'https://rp.example/cb',
    scope: 'openid profile',
    nonce: 'n_123',
    code_challenge: null,
    code_challenge_method: null,
    dpop_jkt: null,
    auth_time: Date.now() - 5000,
    acr: null,
    amr: null,
    resource: null,
    authorization_details: null,
    consumed_at: null,
    expires_at: Date.now() + 60_000,
    created_at: Date.now(),
    ...overrides,
  }
}

function activeUserRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: USER_ID,
    tenant_id: 't_1',
    public_metadata: '{}',
    unsafe_metadata: '{}',
    status: 'active',
    deleted_at: null,
    ...overrides,
  }
}

function decodeKek(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function mintSubjectAccessToken(
  ctx: TenantContext,
  kekB64: string,
  scope = 'openid profile',
): Promise<string> {
  const material = ctx.signingKeys.keys[0]!
  const key = await loadSigningKey(material.encryptedPrivateKey, decodeKek(kekB64))
  const claims = buildAccessTokenClaims({
    ctx,
    subject: { userId: USER_ID },
    clientId: CLIENT_ID,
    scope,
    audience: CLIENT_ID,
    now: Math.floor(Date.now() / 1000),
    ttlSec: 3600,
  })
  return signAccessTokenClaims(ctx, key, claims)
}

async function mintSubjectIdToken(ctx: TenantContext, kekB64: string): Promise<string> {
  const material = ctx.signingKeys.keys[0]!
  const key = await loadSigningKey(material.encryptedPrivateKey, decodeKek(kekB64))
  const claims = buildIdTokenClaims({
    ctx,
    subject: { userId: USER_ID },
    clientId: CLIENT_ID,
    authContext: {},
    scope: 'openid profile',
    now: Math.floor(Date.now() / 1000),
    ttlSec: 3600,
  })
  return signClaims(ctx, key, claims)
}

async function postForm(
  app: ReturnType<typeof makeApp>,
  env: Env,
  body: Record<string, string>,
): Promise<Response> {
  return app.request(
    'https://acme.xid.dev/token',
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    },
    env,
  )
}

async function setup(
  tables: TableSet,
  ctx: TenantContext,
  kekB64: string,
  envOverrides: Partial<Env> = {},
): Promise<{ app: ReturnType<typeof makeApp>; env: Env; capture: D1Capture }> {
  const capture: D1Capture = { inserts: [], updates: [] }
  const env = makeEnv({
    DB: makeFakeD1(tables, capture),
    CACHE: makeFakeKv(),
    KEK: kekB64,
    ...envOverrides,
  })
  const app = makeApp(ctx, registerTokenRoutes)
  return { app, env, capture }
}

// 用 active 公钥验签发出的 access token,断言 iss/sub 正确。
async function assertAccessTokenValid(ctx: TenantContext, accessToken: string): Promise<void> {
  const jwk = ctx.signingKeys.keys[0]!
  const publicKey = await importJwkForVerify({
    ...jwk.publicKeyJwk,
    kid: jwk.kid,
    use: 'sig',
    alg: jwk.alg,
  })
  const verified = await verifyJwt(accessToken, {
    keys: [{ kid: jwk.kid, alg: jwk.alg, publicKey }],
  })
  expect(verified.ok).toBe(true)
  if (verified.ok) {
    expect(verified.value.header.typ).toBe('at+jwt')
    expect(verified.value.payload.iss).toBe('https://acme.xid.dev')
    expect(verified.value.payload.sub).toBe(USER_ID)
    expect(verified.value.payload.aud).toBe(CLIENT_ID)
    expect(typeof verified.value.payload.exp).toBe('number')
    expect(typeof verified.value.payload.iat).toBe('number')
    expect(typeof verified.value.payload.jti).toBe('string')
    expect(verified.value.payload.client_id).toBe(CLIENT_ID)
    expect(verified.value.payload.tenant_id).toBe(ctx.tenantId)
  }
}

async function verifyAccessPayload(
  ctx: TenantContext,
  accessToken: string,
): Promise<Record<string, unknown>> {
  const jwk = ctx.signingKeys.keys[0]!
  const publicKey = await importJwkForVerify({
    ...jwk.publicKeyJwk,
    kid: jwk.kid,
    use: 'sig',
    alg: jwk.alg,
  })
  const verified = await verifyJwt(accessToken, {
    keys: [{ kid: jwk.kid, alg: jwk.alg, publicKey }],
  })
  expect(verified.ok).toBe(true)
  if (!verified.ok) return {}
  return verified.value.payload as Record<string, unknown>
}

async function verifyIdPayload(
  ctx: TenantContext,
  idToken: string,
): Promise<Record<string, unknown>> {
  const jwk = ctx.signingKeys.keys[0]!
  const publicKey = await importJwkForVerify({
    ...jwk.publicKeyJwk,
    kid: jwk.kid,
    use: 'sig',
    alg: jwk.alg,
  })
  const verified = await verifyJwt(idToken, {
    keys: [{ kid: jwk.kid, alg: jwk.alg, publicKey }],
  })
  expect(verified.ok).toBe(true)
  if (!verified.ok) return {}
  return verified.value.payload as Record<string, unknown>
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

function b64urlStr(value: string): string {
  return b64url(new TextEncoder().encode(value))
}

async function dpopProofAndJkt(input: {
  htm: string
  htu: string
}): Promise<{ proof: string; jkt: string }> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const exported = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey
  const publicJwk = { kty: exported.kty, crv: exported.crv, x: exported.x, y: exported.y }
  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: publicJwk }
  const payload = {
    jti: crypto.randomUUID(),
    htm: input.htm,
    htu: input.htu,
    iat: Math.floor(Date.now() / 1000),
  }
  const signingInput = `${b64urlStr(JSON.stringify(header))}.${b64urlStr(JSON.stringify(payload))}`
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      pair.privateKey,
      new TextEncoder().encode(signingInput),
    ),
  )
  const jktInput = `{"crv":"${publicJwk.crv}","kty":"EC","x":"${publicJwk.x}","y":"${publicJwk.y}"}`
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(jktInput)),
  )
  return { proof: `${signingInput}.${b64url(sig)}`, jkt: b64url(digest) }
}

describe('/token authorization_code', () => {
  it('happy path:签发 access_token + id_token(含 nonce/at_hash),消费 code', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const challengeVerifier = generateCodeVerifier()
    const challenge = await computeS256Challenge(challengeVerifier)
    const authTimeMs = Date.now() - 5000
    const authTimeSec = Math.floor(authTimeMs / 1000)
    const tables: TableSet = {
      applications: [await appRow()],
      authorization_codes: [
        codeRow({
          code_challenge: challenge,
          code_challenge_method: 'S256',
          scope: 'openid profile offline_access',
          auth_time: authTimeMs,
          acr: 'urn:xid:aal2',
          amr: JSON.stringify(['pwd', 'otp', 'mfa']),
          session_id: 'sess_code_1',
        }),
      ],
      users: [activeUserRow()],
    }
    const { app, env, capture } = await setup(tables, ctx, kekB64)

    const res = await postForm(app, env, {
      grant_type: 'authorization_code',
      code: 'ac_test_code',
      redirect_uri: 'https://rp.example/cb',
      code_verifier: challengeVerifier,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = (await res.json()) as Record<string, string>
    expect(body['token_type']).toBe('Bearer')
    expect(body['id_token']).toBeDefined()

    await assertAccessTokenValid(ctx, body['access_token']!)
    const accessPayload = await verifyAccessPayload(ctx, body['access_token']!)
    expect(accessPayload['auth_time']).toBe(authTimeSec)
    expect(accessPayload['acr']).toBe('urn:xid:aal2')
    expect(accessPayload['amr']).toEqual(['pwd', 'otp', 'mfa'])
    const idPayload = await verifyIdPayload(ctx, body['id_token']!)
    expect(idPayload['auth_time']).toBe(authTimeSec)
    expect(idPayload['acr']).toBe('urn:xid:aal2')
    expect(idPayload['amr']).toEqual(['pwd', 'otp', 'mfa'])
    expect(idPayload['sid']).toBe('sess_code_1')
    const refreshInsert = capture.inserts.find((i) => i.table === 'refresh_tokens')
    expect(refreshInsert?.params).toContain(authTimeSec)
    expect(refreshInsert?.params).toContain('urn:xid:aal2')
    expect(refreshInsert?.params).toContain(JSON.stringify(['pwd', 'otp', 'mfa']))
    expect(refreshInsert?.params).toContain('sess_code_1')
    const accessIssuance = capture.inserts.find((i) => i.table === 'access_token_issuances')
    expect(accessIssuance?.params).toContain(accessPayload['jti'])
    expect(accessIssuance?.params).toContain('ac_test_code')
    // 一次性消费:发出 UPDATE consumed_at。
    expect(capture.updates.some((s) => /update.*authorization_codes/is.test(s))).toBe(true)
  })

  it('code 无 session 关联 -> id_token 不带 sid', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const challengeVerifier = generateCodeVerifier()
    const challenge = await computeS256Challenge(challengeVerifier)
    const tables: TableSet = {
      applications: [await appRow()],
      authorization_codes: [
        codeRow({
          code_challenge: challenge,
          code_challenge_method: 'S256',
          scope: 'openid profile',
        }),
      ],
      users: [activeUserRow()],
    }
    const { app, env } = await setup(tables, ctx, kekB64)

    const res = await postForm(app, env, {
      grant_type: 'authorization_code',
      code: 'ac_test_code',
      redirect_uri: 'https://rp.example/cb',
      code_verifier: challengeVerifier,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, string>
    const idPayload = await verifyIdPayload(ctx, body['id_token']!)
    expect(idPayload['sid']).toBeUndefined()
  })

  it('token TTL 走租户策略:access expires_in + refresh idle/absolute 按 policy.token 签发', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    ctx.policy.token = {
      accessTokenTtlSec: 7200,
      sessionTokenTtlSec: 60,
      refreshIdleTimeoutDays: 2,
      refreshAbsoluteTimeoutDays: 3,
    }
    const challengeVerifier = generateCodeVerifier()
    const challenge = await computeS256Challenge(challengeVerifier)
    const tables: TableSet = {
      applications: [await appRow({ access_token_ttl_sec: null })],
      authorization_codes: [
        codeRow({
          code_challenge: challenge,
          code_challenge_method: 'S256',
          scope: 'openid profile offline_access',
        }),
      ],
      users: [activeUserRow()],
    }
    const { app, env, capture } = await setup(tables, ctx, kekB64)

    const beforeSec = Math.floor(Date.now() / 1000)
    const res = await postForm(app, env, {
      grant_type: 'authorization_code',
      code: 'ac_test_code',
      redirect_uri: 'https://rp.example/cb',
      code_verifier: challengeVerifier,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    })
    const afterSec = Math.floor(Date.now() / 1000)

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['expires_in']).toBe(7200)
    const accessPayload = await verifyAccessPayload(ctx, body['access_token'] as string)
    expect((accessPayload['exp'] as number) - (accessPayload['iat'] as number)).toBe(7200)

    const refreshInsert = capture.inserts.find((i) => i.table === 'refresh_tokens')
    const numericParams = (refreshInsert?.params ?? []).filter(
      (p): p is number => typeof p === 'number',
    )
    const inWindow = (days: number) =>
      numericParams.some(
        (p) => p >= (beforeSec + days * 86400) * 1000 && p <= (afterSec + days * 86400) * 1000,
      )
    expect(inWindow(2)).toBe(true)
    expect(inWindow(3)).toBe(true)
  })

  it('PKCE code_verifier 不匹配 -> invalid_grant', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const challenge = await computeS256Challenge(generateCodeVerifier())
    const tables: TableSet = {
      applications: [await appRow()],
      authorization_codes: [codeRow({ code_challenge: challenge, code_challenge_method: 'S256' })],
    }
    const { app, env } = await setup(tables, ctx, kekB64)
    const res = await postForm(app, env, {
      grant_type: 'authorization_code',
      code: 'ac_test_code',
      redirect_uri: 'https://rp.example/cb',
      code_verifier: generateCodeVerifier(), // 不同的 verifier
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as Record<string, string>)['error']).toBe('invalid_grant')
  })

  it('authorization code 绑定 resource -> access token aud 使用该 resource', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const challengeVerifier = generateCodeVerifier()
    const challenge = await computeS256Challenge(challengeVerifier)
    const resource = 'https://api.example/v1'
    const tables: TableSet = {
      applications: [await appRow()],
      authorization_codes: [
        codeRow({
          code_challenge: challenge,
          code_challenge_method: 'S256',
          resource: JSON.stringify([resource]),
        }),
      ],
      resource_servers: [
        {
          id: 'rs_1',
          tenant_id: 't_1',
          name: 'API',
          audience: resource,
          scopes: JSON.stringify(['openid', 'profile']),
          access_token_format: 'jwt',
          signing_alg: 'ES256',
          created_at: Date.now(),
          updated_at: Date.now(),
        },
      ],
      users: [activeUserRow()],
    }
    const { app, env } = await setup(tables, ctx, kekB64)

    const res = await postForm(app, env, {
      grant_type: 'authorization_code',
      code: 'ac_test_code',
      redirect_uri: 'https://rp.example/cb',
      code_verifier: challengeVerifier,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, string>
    const payload = await verifyAccessPayload(ctx, body['access_token']!)
    expect(payload['aud']).toBe(resource)
  })

  it('authorization code 绑定 RAR -> access token 和 token response 输出 authorization_details', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const challengeVerifier = generateCodeVerifier()
    const challenge = await computeS256Challenge(challengeVerifier)
    const authorizationDetails = [
      {
        type: 'resource_access',
        locations: ['https://api.example/v1'],
        actions: ['read'],
      },
    ]
    const tables: TableSet = {
      applications: [await appRow()],
      authorization_codes: [
        codeRow({
          code_challenge: challenge,
          code_challenge_method: 'S256',
          scope: 'openid profile offline_access read',
          resource: JSON.stringify(['https://api.example/v1']),
          authorization_details: JSON.stringify(authorizationDetails),
        }),
      ],
      resource_servers: [
        {
          id: 'rs_1',
          tenant_id: 't_1',
          name: 'API',
          audience: 'https://api.example/v1',
          scopes: JSON.stringify(['read']),
          access_token_format: 'jwt',
          signing_alg: 'ES256',
          created_at: Date.now(),
          updated_at: Date.now(),
        },
      ],
      users: [activeUserRow()],
    }
    const { app, env, capture } = await setup(tables, ctx, kekB64)

    const res = await postForm(app, env, {
      grant_type: 'authorization_code',
      code: 'ac_test_code',
      redirect_uri: 'https://rp.example/cb',
      code_verifier: challengeVerifier,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['authorization_details']).toEqual(authorizationDetails)
    const payload = await verifyAccessPayload(ctx, body['access_token'] as string)
    expect(payload['authorization_details']).toEqual(authorizationDetails)
    const refreshInsert = capture.inserts.find((i) => i.table === 'refresh_tokens')
    expect(refreshInsert?.params).toContain(JSON.stringify(authorizationDetails))
  })

  it('authorization code resource 与 token 请求 resource 不一致 -> invalid_target', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const challengeVerifier = generateCodeVerifier()
    const challenge = await computeS256Challenge(challengeVerifier)
    const tables: TableSet = {
      applications: [await appRow()],
      authorization_codes: [
        codeRow({
          code_challenge: challenge,
          code_challenge_method: 'S256',
          resource: JSON.stringify(['https://api.example/v1']),
        }),
      ],
      users: [activeUserRow()],
    }
    const { app, env } = await setup(tables, ctx, kekB64)

    const res = await postForm(app, env, {
      grant_type: 'authorization_code',
      code: 'ac_test_code',
      redirect_uri: 'https://rp.example/cb',
      code_verifier: challengeVerifier,
      resource: 'https://other.example/v1',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    })

    expect(res.status).toBe(400)
    expect(((await res.json()) as Record<string, string>)['error']).toBe('invalid_target')
  })

  it('authorization code 绑定 dpop_jkt 时拒绝不匹配 proof', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const challengeVerifier = generateCodeVerifier()
    const challenge = await computeS256Challenge(challengeVerifier)
    const presented = await dpopProofAndJkt({ htm: 'POST', htu: 'https://acme.xid.dev/token' })
    const tables: TableSet = {
      applications: [await appRow()],
      authorization_codes: [
        codeRow({
          code_challenge: challenge,
          code_challenge_method: 'S256',
          dpop_jkt: 'different-jkt',
        }),
      ],
      users: [activeUserRow()],
    }
    const { app, env } = await setup(tables, ctx, kekB64, {
      OAUTH_STATE: makeFakeDoNs((path) =>
        path === '/claim'
          ? new Response(null, { status: 201 })
          : new Response('{}', { status: 404 }),
      ),
    })

    const res = await app.request(
      'https://acme.xid.dev/token',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          dpop: presented.proof,
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: 'ac_test_code',
          redirect_uri: 'https://rp.example/cb',
          code_verifier: challengeVerifier,
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
        }).toString(),
      },
      env,
    )

    expect(res.status).toBe(400)
    expect(((await res.json()) as Record<string, string>)['error']).toBe('invalid_grant')
  })

  it('ProjectGrant 场景 -> access token 注入 grant claims 和 grant permissions', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const challengeVerifier = generateCodeVerifier()
    const challenge = await computeS256Challenge(challengeVerifier)
    const tables: TableSet = {
      applications: [await appRow({ project_id: 'proj_a' })],
      projects: [
        {
          id: 'proj_a',
          tenant_id: 't_1',
          org_id: 'org_a',
          name: 'Project A',
          description: null,
          status: 'active',
          deleted_at: null,
        },
      ],
      authorization_codes: [
        codeRow({
          code_challenge: challenge,
          code_challenge_method: 'S256',
          scope: 'openid profile offline_access',
          active_org_id: 'org_b',
          project_grant_id: 'grant_1',
        }),
      ],
      organizations: [
        {
          id: 'org_b',
          tenant_id: 't_1',
          slug: 'org-b',
          public_metadata: '{}',
          status: 'active',
        },
      ],
      memberships: [
        {
          id: 'mem_1',
          tenant_id: 't_1',
          org_id: 'org_b',
          user_id: USER_ID,
          status: 'active',
        },
      ],
      project_grants: [
        {
          id: 'grant_1',
          tenant_id: 't_1',
          granted_project_id: 'proj_a',
          granted_by_org_id: 'org_a',
          granted_to_org_id: 'org_b',
          status: 'active',
          revoked_at: null,
        },
      ],
      user_grants: [
        {
          id: 'ug_1',
          tenant_id: 't_1',
          user_id: USER_ID,
          project_id: 'proj_a',
          role_id: 'role_viewer',
          granted_via_grant_id: 'grant_1',
          revoked_at: null,
        },
      ],
      roles: [
        {
          id: 'role_viewer',
          tenant_id: 't_1',
          project_id: 'proj_a',
          key: 'viewer',
          display_name: 'Viewer',
          status: 'active',
          deleted_at: null,
        },
      ],
      role_permissions: [
        {
          id: 'rp_1',
          tenant_id: 't_1',
          role_id: 'role_viewer',
          permission_id: 'perm_read',
          condition_expression: null,
        },
        {
          id: 'rp_invalid',
          tenant_id: 't_1',
          role_id: 'role_viewer',
          permission_id: 'perm_invalid',
          condition_expression: '{"op":',
        },
      ],
      permissions: [
        {
          id: 'perm_read',
          tenant_id: 't_1',
          project_id: 'proj_a',
          key: 'document:read',
          status: 'active',
          deleted_at: null,
        },
        {
          id: 'perm_invalid',
          tenant_id: 't_1',
          project_id: 'proj_a',
          key: 'admin:all',
          status: 'active',
          deleted_at: null,
        },
      ],
      users: [activeUserRow()],
    }
    const auditSend = vi.fn(async () => undefined)
    const { app, env, capture } = await setup(tables, ctx, kekB64, {
      AUDIT_QUEUE: { send: auditSend } as unknown as Queue,
    })

    const res = await postForm(app, env, {
      grant_type: 'authorization_code',
      code: 'ac_test_code',
      redirect_uri: 'https://rp.example/cb',
      code_verifier: challengeVerifier,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, string>
    const payload = await verifyAccessPayload(ctx, body['access_token']!)
    expect(payload['org_id']).toBe('org_b')
    expect(payload['org_slug']).toBe('org-b')
    expect(payload['project_id']).toBe('proj_a')
    expect(payload['granted_org_id']).toBe('org_a')
    expect(payload['permissions']).toEqual(['document:read'])
    expect(auditSend).toHaveBeenCalledWith({
      tenantId: 't_1',
      orgId: 'org_b',
      action: 'rbac.condition_invalid',
      actorId: USER_ID,
      ts: expect.any(Number),
      payload: {
        projectId: 'proj_a',
        clientId: CLIENT_ID,
        permissionKeys: ['admin:all'],
      },
    })
    expect(body['refresh_token']).toBeDefined()
    expect(capture.inserts.some((i) => i.table === 'refresh_tokens')).toBe(true)
  })

  it('不含 refresh_token grant 的 public client 不签发 refresh token', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const challengeVerifier = generateCodeVerifier()
    const challenge = await computeS256Challenge(challengeVerifier)
    const tables: TableSet = {
      applications: [
        await appRow({
          client_secret_hash: null,
          client_type: 'public',
          token_endpoint_auth_method: 'none',
          allowed_grant_types: JSON.stringify(['authorization_code']),
        }),
      ],
      authorization_codes: [
        codeRow({
          code_challenge: challenge,
          code_challenge_method: 'S256',
          scope: 'openid profile offline_access',
        }),
      ],
      users: [activeUserRow()],
    }
    const { app, env, capture } = await setup(tables, ctx, kekB64)

    const res = await postForm(app, env, {
      grant_type: 'authorization_code',
      code: 'ac_test_code',
      redirect_uri: 'https://rp.example/cb',
      code_verifier: challengeVerifier,
      client_id: CLIENT_ID,
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, string>
    expect(body['refresh_token']).toBeUndefined()
    expect(capture.inserts.some((i) => i.table === 'refresh_tokens')).toBe(false)
  })

  it('public client 有 DPoP proof 时签发 DPoP-bound refresh token', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const challengeVerifier = generateCodeVerifier()
    const challenge = await computeS256Challenge(challengeVerifier)
    const proof = await dpopProofAndJkt({ htm: 'POST', htu: 'https://acme.xid.dev/token' })
    const tables: TableSet = {
      applications: [
        await appRow({
          client_secret_hash: null,
          client_type: 'public',
          token_endpoint_auth_method: 'none',
          allowed_grant_types: JSON.stringify(['authorization_code', 'refresh_token']),
          dpop_bound_access_tokens: 1,
        }),
      ],
      authorization_codes: [
        codeRow({
          code_challenge: challenge,
          code_challenge_method: 'S256',
          dpop_jkt: proof.jkt,
          scope: 'openid profile offline_access',
        }),
      ],
      users: [activeUserRow()],
    }
    const { app, env, capture } = await setup(tables, ctx, kekB64, {
      OAUTH_STATE: makeFakeDoNs((path) =>
        path === '/claim'
          ? new Response(null, { status: 201 })
          : new Response('{}', { status: 404 }),
      ),
    })

    const res = await app.request(
      'https://acme.xid.dev/token',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          dpop: proof.proof,
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: 'ac_test_code',
          redirect_uri: 'https://rp.example/cb',
          code_verifier: challengeVerifier,
          client_id: CLIENT_ID,
        }).toString(),
      },
      env,
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, string>
    expect(body['token_type']).toBe('DPoP')
    expect(body['refresh_token']).toBeDefined()
    const refreshInsert = capture.inserts.find((i) => i.table === 'refresh_tokens')
    expect(refreshInsert?.params).toContain(proof.jkt)
  })

  it('public client token response 只对注册 redirect origin 返回 CORS header', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const challengeVerifier = generateCodeVerifier()
    const challenge = await computeS256Challenge(challengeVerifier)
    const tables: TableSet = {
      applications: [
        await appRow({
          client_secret_hash: null,
          client_type: 'public',
          token_endpoint_auth_method: 'none',
          allowed_grant_types: JSON.stringify(['authorization_code']),
        }),
      ],
      authorization_codes: [
        codeRow({
          code_challenge: challenge,
          code_challenge_method: 'S256',
        }),
      ],
      users: [activeUserRow()],
    }
    const { app, env } = await setup(tables, ctx, kekB64)

    const allowed = await app.request(
      'https://acme.xid.dev/token',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'https://rp.example',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: 'ac_test_code',
          redirect_uri: 'https://rp.example/cb',
          code_verifier: challengeVerifier,
          client_id: CLIENT_ID,
        }).toString(),
      },
      env,
    )

    expect(allowed.status).toBe(200)
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://rp.example')
    expect(allowed.headers.get('access-control-expose-headers')).toBe('dpop-nonce')

    const blocked = await app.request(
      'https://acme.xid.dev/token',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'https://evil.example',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: 'another_code',
          redirect_uri: 'https://rp.example/cb',
          code_verifier: challengeVerifier,
          client_id: CLIENT_ID,
        }).toString(),
      },
      env,
    )

    expect(blocked.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('instance_manager 不进入业务 access token claim', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const challengeVerifier = generateCodeVerifier()
    const challenge = await computeS256Challenge(challengeVerifier)
    const tables: TableSet = {
      applications: [await appRow()],
      authorization_codes: [
        codeRow({
          code_challenge: challenge,
          code_challenge_method: 'S256',
          active_org_id: 'org_admin',
        }),
      ],
      organizations: [
        {
          id: 'org_admin',
          tenant_id: 't_1',
          slug: 'admin',
          public_metadata: '{}',
          status: 'active',
        },
      ],
      memberships: [
        {
          id: 'mem_admin',
          tenant_id: 't_1',
          org_id: 'org_admin',
          user_id: USER_ID,
          status: 'active',
        },
      ],
      manager_assignments: [
        {
          id: 'mgr_1',
          tenant_id: 't_1',
          user_id: USER_ID,
          manager_role: 'instance_manager',
          scope_type: 'instance',
          scope_id: null,
          status: 'active',
          revoked_at: null,
        },
      ],
      users: [activeUserRow()],
    }
    const { app, env } = await setup(tables, ctx, kekB64)

    const res = await postForm(app, env, {
      grant_type: 'authorization_code',
      code: 'ac_test_code',
      redirect_uri: 'https://rp.example/cb',
      code_verifier: challengeVerifier,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, string>
    const payload = await verifyAccessPayload(ctx, body['access_token']!)
    expect(payload['org_id']).toBe('org_admin')
    expect(payload['org_slug']).toBe('admin')
    expect(payload['permissions']).toEqual([])
    expect(payload).not.toHaveProperty('instance_manager')
    expect(payload).not.toHaveProperty('instanceManager')
    expect(payload).not.toHaveProperty('manager_role')
    expect(payload).not.toHaveProperty('manager_roles')
    expect(payload).not.toHaveProperty('platform_admin')
  })
})

describe('/token soft deleted user gate', () => {
  it('authorization_code linked to soft deleted user -> invalid_grant', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const challengeVerifier = generateCodeVerifier()
    const challenge = await computeS256Challenge(challengeVerifier)
    const tables: TableSet = {
      applications: [await appRow()],
      authorization_codes: [codeRow({ code_challenge: challenge, code_challenge_method: 'S256' })],
      users: [activeUserRow({ deleted_at: Date.now() })],
    }
    const { app, env } = await setup(tables, ctx, kekB64)

    const res = await postForm(app, env, {
      grant_type: 'authorization_code',
      code: 'ac_test_code',
      redirect_uri: 'https://rp.example/cb',
      code_verifier: challengeVerifier,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    })

    expect(res.status).toBe(400)
    expect(((await res.json()) as Record<string, string>)['error']).toBe('invalid_grant')
  })

  it('refresh_token linked to soft deleted user -> invalid_grant without new refresh token', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const token = generateRefreshToken()
    const hash = await hashRefreshToken(token)
    const tables: TableSet = {
      applications: [await appRow()],
      refresh_tokens: [refreshRow(hash)],
      users: [activeUserRow({ status: 'deleted' })],
    }
    const { app, env, capture } = await setup(tables, ctx, kekB64)

    const res = await postForm(app, env, {
      grant_type: 'refresh_token',
      refresh_token: token,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    })

    expect(res.status).toBe(400)
    expect(((await res.json()) as Record<string, string>)['error']).toBe('invalid_grant')
    expect(capture.inserts.some((i) => i.table === 'refresh_tokens')).toBe(false)
  })

  it('token_exchange subject soft deleted user -> invalid_grant', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const subjectToken = await mintSubjectAccessToken(ctx, kekB64)
    const tables: TableSet = {
      applications: [
        await appRow({
          allowed_grant_types: JSON.stringify([TOKEN_EXCHANGE_GRANT]),
          require_pkce: 0,
        }),
      ],
      users: [activeUserRow({ deleted_at: Date.now() })],
    }
    const { app, env } = await setup(tables, ctx, kekB64)

    const res = await postForm(app, env, {
      grant_type: TOKEN_EXCHANGE_GRANT,
      subject_token: subjectToken,
      subject_token_type: SUBJECT_ACCESS,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    })

    expect(res.status).toBe(400)
    expect(((await res.json()) as Record<string, string>)['error']).toBe('invalid_grant')
  })

  it('device_code approved soft deleted user -> invalid_grant', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const tables: TableSet = {
      applications: [
        await appRow({
          allowed_grant_types: JSON.stringify([DEVICE_CODE_GRANT]),
          require_pkce: 0,
        }),
      ],
      users: [activeUserRow({ deleted_at: Date.now() })],
    }
    const deviceFlow = makeFakeDoNs((path) => {
      if (path !== '/poll') return new Response('{}', { status: 404 })
      return Response.json({
        approved: true,
        userId: USER_ID,
        scopes: ['openid', 'profile'],
        clientId: CLIENT_ID,
      })
    })
    const { app, env } = await setup(tables, ctx, kekB64, { DEVICE_FLOW: deviceFlow })

    const res = await postForm(app, env, {
      grant_type: DEVICE_CODE_GRANT,
      device_code: 'dev_code',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    })

    expect(res.status).toBe(400)
    expect(((await res.json()) as Record<string, string>)['error']).toBe('invalid_grant')
  })
})

describe('/token token_exchange', () => {
  async function exchangeSetup(tables: Partial<TableSet> = {}) {
    const { ctx, kekB64 } = await buildTestTenant()
    const subjectToken = await mintSubjectAccessToken(ctx, kekB64)
    const appRecord = await appRow({
      allowed_grant_types: JSON.stringify([TOKEN_EXCHANGE_GRANT]),
      require_pkce: 0,
      first_party: 1,
    })
    const merged: TableSet = {
      applications: [appRecord],
      users: [activeUserRow()],
      ...tables,
    }
    const { app, env } = await setup(merged, ctx, kekB64)
    return { app, env, ctx, kekB64, subjectToken }
  }

  it('默认签发 access token 并返回 issued_token_type', async () => {
    const { app, env, ctx, subjectToken } = await exchangeSetup()

    const res = await postForm(app, env, {
      grant_type: TOKEN_EXCHANGE_GRANT,
      subject_token: subjectToken,
      subject_token_type: SUBJECT_ACCESS,
      requested_token_type: SUBJECT_ACCESS,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, string>
    expect(body['issued_token_type']).toBe(SUBJECT_ACCESS)
    const payload = await verifyAccessPayload(ctx, body['access_token']!)
    expect(payload['sub']).toBe(USER_ID)
  })

  it('拒绝非 first-party client', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const subjectToken = await mintSubjectAccessToken(ctx, kekB64)
    const tables: TableSet = {
      applications: [
        await appRow({
          allowed_grant_types: JSON.stringify([TOKEN_EXCHANGE_GRANT]),
          require_pkce: 0,
          first_party: 0,
        }),
      ],
      users: [activeUserRow()],
    }
    const { app, env } = await setup(tables, ctx, kekB64)

    const res = await postForm(app, env, {
      grant_type: TOKEN_EXCHANGE_GRANT,
      subject_token: subjectToken,
      subject_token_type: SUBJECT_ACCESS,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    })

    expect(res.status).toBe(400)
    expect(((await res.json()) as Record<string, string>)['error']).toBe('invalid_grant')
  })

  it('拒绝 unsupported requested_token_type', async () => {
    const { app, env, subjectToken } = await exchangeSetup()

    const res = await postForm(app, env, {
      grant_type: TOKEN_EXCHANGE_GRANT,
      subject_token: subjectToken,
      subject_token_type: SUBJECT_ACCESS,
      requested_token_type: 'urn:ietf:params:oauth:token-type:jwt',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    })

    expect(res.status).toBe(400)
    expect(((await res.json()) as Record<string, string>)['error']).toBe('invalid_request')
  })

  it('token-exchange 可签发 id_token', async () => {
    const { app, env, subjectToken } = await exchangeSetup()

    const res = await postForm(app, env, {
      grant_type: TOKEN_EXCHANGE_GRANT,
      subject_token: subjectToken,
      subject_token_type: SUBJECT_ACCESS,
      requested_token_type: SUBJECT_ID,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['issued_token_type']).toBe(SUBJECT_ID)
    expect(body['token_type']).toBe('N/A')
  })

  it('拒绝 subject_token_type 与 JWT claims 不匹配', async () => {
    const { app, env, subjectToken } = await exchangeSetup()

    const res = await postForm(app, env, {
      grant_type: TOKEN_EXCHANGE_GRANT,
      subject_token: subjectToken,
      subject_token_type: SUBJECT_ID,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    })

    expect(res.status).toBe(400)
    expect(((await res.json()) as Record<string, string>)['error']).toBe('invalid_grant')
  })

  it('拒绝 unsupported actor_token_type', async () => {
    const { app, env, subjectToken } = await exchangeSetup()

    const res = await postForm(app, env, {
      grant_type: TOKEN_EXCHANGE_GRANT,
      subject_token: subjectToken,
      subject_token_type: SUBJECT_ACCESS,
      actor_token: subjectToken,
      actor_token_type: SUBJECT_REFRESH,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    })

    expect(res.status).toBe(400)
    expect(((await res.json()) as Record<string, string>)['error']).toBe('invalid_request')
  })

  it('delegation actor_token_type 按 claims 校验并写 act claim', async () => {
    const { app, env, ctx, subjectToken } = await exchangeSetup()
    const actorToken = await mintSubjectIdToken(ctx, env.KEK)

    const res = await postForm(app, env, {
      grant_type: TOKEN_EXCHANGE_GRANT,
      subject_token: subjectToken,
      subject_token_type: SUBJECT_ACCESS,
      actor_token: actorToken,
      actor_token_type: SUBJECT_ID,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, string>
    const payload = await verifyAccessPayload(ctx, body['access_token']!)
    expect(payload['act']).toEqual({ sub: USER_ID })
  })
})

describe('/token authorization_code client auth', () => {
  it('client_secret 错误 -> invalid_client 401', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const tables: TableSet = { applications: [await appRow()], authorization_codes: [codeRow()] }
    const { app, env } = await setup(tables, ctx, kekB64)
    const res = await postForm(app, env, {
      grant_type: 'authorization_code',
      code: 'ac_test_code',
      redirect_uri: 'https://rp.example/cb',
      client_id: CLIENT_ID,
      client_secret: 'wrong_secret',
    })
    expect(res.status).toBe(401)
    expect(((await res.json()) as Record<string, string>)['error']).toBe('invalid_client')
  })

  it('未知 client -> invalid_client', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const { app, env } = await setup({ applications: [] }, ctx, kekB64)
    const res = await postForm(app, env, {
      grant_type: 'authorization_code',
      code: 'ac_test_code',
      client_id: 'nope',
      client_secret: 'x',
    })
    expect(res.status).toBe(401)
    // 未经 Authorization header 认证,不带 WWW-Authenticate 挑战(RFC6749 5.2)。
    expect(res.headers.get('www-authenticate')).toBeNull()
  })

  it('未知 client(Basic 凭证)-> 401 带 WWW-Authenticate', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const { app, env } = await setup({ applications: [] }, ctx, kekB64)
    const res = await app.request(
      'https://acme.xid.dev/token',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: `Basic ${btoa('nope:secret')}`,
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: 'ac_test_code',
        }).toString(),
      },
      env,
    )
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe('Basic realm="xid", error="invalid_client"')
    expect(((await res.json()) as Record<string, string>)['error']).toBe('invalid_client')
  })
})

function refreshRow(
  tokenHash: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'rt_id_1',
    tenant_id: 't_1',
    token_hash: tokenHash,
    family_id: 'fam_1',
    parent_token_id: null,
    user_id: USER_ID,
    client_id: CLIENT_ID,
    scope: 'openid offline_access',
    jkt: null,
    resource: null,
    authorization_details: null,
    auth_time: null,
    acr: null,
    amr: null,
    revoked_at: null,
    expires_at: Date.now() + 30 * 24 * 3600 * 1000,
    absolute_expires_at: Date.now() + 7 * 24 * 3600 * 1000,
    created_at: Date.now(),
    ...overrides,
  }
}

describe('/token refresh_token', () => {
  it('有效 refresh -> 轮换签发新 access + 新 refresh,旧 token 标 revoked', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const token = generateRefreshToken()
    const hash = await hashRefreshToken(token)
    const authTime = Math.floor(Date.now() / 1000) - 60
    const resource = 'https://api.example/v1'
    const tables: TableSet = {
      applications: [await appRow()],
      refresh_tokens: [
        refreshRow(hash, {
          resource: JSON.stringify([resource]),
          auth_time: authTime,
          acr: 'urn:xid:aal2',
          amr: JSON.stringify(['pwd', 'otp', 'mfa']),
          session_id: 'sess_fam_1',
        }),
      ],
      users: [activeUserRow()],
    }
    const { app, env, capture } = await setup(tables, ctx, kekB64)
    const res = await postForm(app, env, {
      grant_type: 'refresh_token',
      refresh_token: token,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, string>
    expect(body['access_token']).toBeDefined()
    expect(body['refresh_token']).toBeDefined()
    expect(body['refresh_token']).not.toBe(token)
    expect(body['id_token']).toBeDefined()
    const accessPayload = await verifyAccessPayload(ctx, body['access_token']!)
    expect(accessPayload['aud']).toBe(resource)
    expect(accessPayload['auth_time']).toBe(authTime)
    expect(accessPayload['acr']).toBe('urn:xid:aal2')
    expect(accessPayload['amr']).toEqual(['pwd', 'otp', 'mfa'])
    const idPayload = await verifyIdPayload(ctx, body['id_token']!)
    expect(idPayload['auth_time']).toBe(authTime)
    expect(idPayload['acr']).toBe('urn:xid:aal2')
    expect(idPayload['amr']).toEqual(['pwd', 'otp', 'mfa'])
    expect(idPayload['sid']).toBe('sess_fam_1')
    const refreshInsert = capture.inserts.find((i) => i.table === 'refresh_tokens')
    expect(refreshInsert?.params).toContain(JSON.stringify([resource]))
    expect(refreshInsert?.params).toContain(authTime)
    expect(refreshInsert?.params).toContain('urn:xid:aal2')
    expect(refreshInsert?.params).toContain(JSON.stringify(['pwd', 'otp', 'mfa']))
    // 轮换继承 session 关联。
    expect(refreshInsert?.params).toContain('sess_fam_1')
    // 旧 token 标 revoked + 插入新 token。
    expect(capture.updates.some((s) => /update.*refresh_tokens/is.test(s))).toBe(true)
    expect(capture.inserts.some((i) => i.table === 'refresh_tokens')).toBe(true)
    const accessIssuance = capture.inserts.find((i) => i.table === 'access_token_issuances')
    expect(accessIssuance?.params).toContain(accessPayload['jti'])
    expect(accessIssuance?.params).toContain('fam_1')
  })

  it('轮换:idle 按租户 token 策略刷新,absolute 继承不顺延', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    ctx.policy.token = {
      accessTokenTtlSec: 3600,
      sessionTokenTtlSec: 60,
      refreshIdleTimeoutDays: 2,
      refreshAbsoluteTimeoutDays: 3,
    }
    const token = generateRefreshToken()
    const hash = await hashRefreshToken(token)
    const absoluteMs = Date.now() + 5 * 86400 * 1000
    const tables: TableSet = {
      applications: [await appRow()],
      refresh_tokens: [refreshRow(hash, { absolute_expires_at: absoluteMs })],
      users: [activeUserRow()],
    }
    const { app, env, capture } = await setup(tables, ctx, kekB64)

    const beforeSec = Math.floor(Date.now() / 1000)
    const res = await postForm(app, env, {
      grant_type: 'refresh_token',
      refresh_token: token,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    })
    const afterSec = Math.floor(Date.now() / 1000)

    expect(res.status).toBe(200)
    const refreshInsert = capture.inserts.find((i) => i.table === 'refresh_tokens')
    const numericParams = (refreshInsert?.params ?? []).filter(
      (p): p is number => typeof p === 'number',
    )
    // idle:now + 2d(策略值,非 protocol 默认 30d)
    expect(
      numericParams.some(
        (p) => p >= (beforeSec + 2 * 86400) * 1000 && p <= (afterSec + 2 * 86400) * 1000,
      ),
    ).toBe(true)
    // absolute:继承旧记录(5d),不按策略 3d 重算(行存 ms,记录层截断到秒再回写)
    expect(numericParams).toContain(Math.floor(absoluteMs / 1000) * 1000)
  })

  it('refresh token 继承 RAR authorization_details', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const token = generateRefreshToken()
    const hash = await hashRefreshToken(token)
    const authorizationDetails = [
      {
        type: 'resource_access',
        locations: ['https://api.example/v1'],
        actions: ['read'],
      },
    ]
    const tables: TableSet = {
      applications: [await appRow()],
      refresh_tokens: [
        refreshRow(hash, {
          scope: 'openid offline_access read',
          resource: JSON.stringify(['https://api.example/v1']),
          authorization_details: JSON.stringify(authorizationDetails),
        }),
      ],
      users: [activeUserRow()],
    }
    const { app, env, capture } = await setup(tables, ctx, kekB64)
    const res = await postForm(app, env, {
      grant_type: 'refresh_token',
      refresh_token: token,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['authorization_details']).toEqual(authorizationDetails)
    const accessPayload = await verifyAccessPayload(ctx, body['access_token'] as string)
    expect(accessPayload['authorization_details']).toEqual(authorizationDetails)
    const refreshInsert = capture.inserts.find((i) => i.table === 'refresh_tokens')
    expect(refreshInsert?.params).toContain(JSON.stringify(authorizationDetails))
  })

  it('旧 non-DPoP public refresh client 按无效注册 fail closed', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const token = generateRefreshToken()
    const hash = await hashRefreshToken(token)
    const tables: TableSet = {
      applications: [
        await appRow({
          client_secret_hash: null,
          client_type: 'public',
          token_endpoint_auth_method: 'none',
        }),
      ],
      refresh_tokens: [refreshRow(hash, { jkt: null })],
    }
    const { app, env, capture } = await setup(tables, ctx, kekB64)
    const res = await postForm(app, env, {
      grant_type: 'refresh_token',
      refresh_token: token,
      client_id: CLIENT_ID,
    })

    expect(res.status).toBe(401)
    expect(((await res.json()) as Record<string, string>)['error']).toBe('invalid_client')
    expect(capture.inserts.some((i) => i.table === 'refresh_tokens')).toBe(false)
  })

  it('已 revoked 的 refresh 二次出现(重放)-> invalid_grant + 撤销 family', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const token = generateRefreshToken()
    const hash = await hashRefreshToken(token)
    const tables: TableSet = {
      applications: [await appRow()],
      refresh_tokens: [refreshRow(hash, { revoked_at: Date.now() - 1000 })],
    }
    const { app, env, capture } = await setup(tables, ctx, kekB64)
    const res = await postForm(app, env, {
      grant_type: 'refresh_token',
      refresh_token: token,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as Record<string, string>)['error']).toBe('invalid_grant')
    // family 撤销:发出 update revoked。
    expect(capture.updates.some((s) => /update.*refresh_tokens/is.test(s))).toBe(true)
    expect(capture.inserts.some((i) => i.table === 'access_token_revocations')).toBe(true)
  })
})

describe('/token prelude', () => {
  it('OPTIONS preflight 返回 token endpoint CORS 方法和 header', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    // 预检按 query client_id 校验 origin 白名单:public client + redirectUris origin 命中才回 ACAO。
    const { app, env } = await setup(
      {
        applications: [
          await appRow({
            client_type: 'public',
            token_endpoint_auth_method: 'none',
            client_secret_hash: null,
            allowed_grant_types: JSON.stringify(['authorization_code']),
          }),
        ],
      },
      ctx,
      kekB64,
    )
    const res = await app.request(
      'https://acme.xid.dev/token?client_id=cli_app',
      {
        method: 'OPTIONS',
        headers: {
          origin: 'https://rp.example',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type,dpop',
        },
      },
      env,
    )

    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('https://rp.example')
    expect(res.headers.get('access-control-allow-methods')).toBe('POST')
    expect(res.headers.get('access-control-allow-headers')).toBe('content-type,dpop')
  })

  it('Content-Type 非 form-urlencoded -> invalid_request', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const { app, env } = await setup({ applications: [await appRow()] }, ctx, kekB64)
    const res = await app.request(
      'https://acme.xid.dev/token',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      env,
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as Record<string, string>)['error']).toBe('invalid_request')
  })

  it('重复 form 参数 -> invalid_request', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const { app, env } = await setup({ applications: [await appRow()] }, ctx, kekB64)
    const body = new URLSearchParams([
      ['grant_type', 'authorization_code'],
      ['grant_type', 'client_credentials'],
      ['client_id', CLIENT_ID],
      ['client_secret', CLIENT_SECRET],
    ])
    const res = await app.request(
      'https://acme.xid.dev/token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      },
      env,
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as Record<string, string>
    expect(json['error']).toBe('invalid_request')
    expect(json['error_description']).toBe('duplicate parameter grant_type')
  })

  it('grant_type 不在 client 白名单 -> unauthorized_client', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const { app, env } = await setup({ applications: [await appRow()] }, ctx, kekB64)
    const res = await postForm(app, env, {
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as Record<string, string>)['error']).toBe('unauthorized_client')
  })

  it('Project soft delete immediately disables a linked client at /token', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const { app, env, capture } = await setup(
      {
        applications: [
          await appRow({
            project_id: 'proj_deleted',
            allowed_grant_types: JSON.stringify(['client_credentials']),
          }),
        ],
        projects: [
          {
            id: 'proj_deleted',
            tenant_id: 't_1',
            org_id: 'org_1',
            name: 'Deleted Project',
            description: null,
            status: 'deleted',
            deleted_at: Date.now(),
            created_at: Date.now(),
            updated_at: Date.now(),
          },
        ],
      },
      ctx,
      kekB64,
    )
    const res = await postForm(app, env, {
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    })
    expect(res.status).toBe(401)
    expect(((await res.json()) as Record<string, string>)['error']).toBe('invalid_client')
    expect(capture.inserts).toEqual([])
  })

  it('OAuth password grant is rejected before any credential handling', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const { app, env } = await setup({ applications: [await appRow()] }, ctx, kekB64)
    const res = await postForm(app, env, {
      grant_type: 'password',
      username: 'user@example.com',
      password: 'secret',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    })

    expect(res.status).toBe(400)
    const json = (await res.json()) as Record<string, string>
    expect(json['error']).toBe('unsupported_grant_type')
    expect(json['error_description']).toBe('unknown grant_type password')
  })
})
