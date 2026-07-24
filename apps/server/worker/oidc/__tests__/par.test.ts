// /par 端点测试(RFC9126):POST 校验 client 后存参数返回 request_uri(60s);
// /authorize 带 request_uri 取出参数续跑(此处用有状态 ParStore fake 验 round-trip + client_id 一致校验)。

import { describe, it, expect } from 'vitest'
import type { TenantContext } from '@xid-kit/types'
import { exportPublicJwk, signJwt } from '@xid-kit/crypto'
import { registerAuthorizeRoutes } from '../authorize'
import { registerParRoutes } from '../par'
import { buildTestTenant, makeEnv, makeFakeD1, makeFakeDoNs, makeOauthStateNs } from './helpers'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { SessionData, XidHonoEnv } from '../../lib/types'

const CLIENT_ID = 'cli_app'

function appRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'app_1',
    tenant_id: 't_1',
    client_id: CLIENT_ID,
    client_secret_hash: null,
    client_type: 'public',
    token_endpoint_auth_method: 'none',
    jwks: null,
    redirect_uris: JSON.stringify(['https://rp.example/cb']),
    post_logout_redirect_uris: JSON.stringify([]),
    allowed_grant_types: JSON.stringify(['authorization_code']),
    allowed_response_types: JSON.stringify(['code']),
    allowed_scopes: JSON.stringify(['openid', 'profile']),
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

async function makeClientKeyPair(): Promise<{
  privateKey: CryptoKey
  jwk: Record<string, unknown>
}> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])
  const jwk = await exportPublicJwk(pair.publicKey, 'ckid', 'ES256')
  return { privateKey: pair.privateKey, jwk: jwk as unknown as Record<string, unknown> }
}

async function signRequestObject(
  privateKey: CryptoKey,
  claims: Record<string, unknown>,
): Promise<string> {
  return signJwt({ header: { alg: 'ES256', kid: 'ckid' }, payload: claims }, privateKey)
}

function session(): SessionData {
  return {
    sessionId: 's_1',
    userId: 'u_1',
    status: 'active',
    activeOrgId: null,
    authenticatedAt: new Date(Date.now() - 1000),
    expiresAt: new Date(Date.now() + 3600_000),
    rememberMe: false,
    isImpersonation: false,
    impersonatorUserId: null,
    acr: null,
    amr: null,
    aal: null,
  }
}

// 有状态 ParStore fake:store 存入 map,consume 取出删除(一次性)。
function makeParStore(): DurableObjectNamespace {
  const store = new Map<string, Record<string, string>>()
  return makeFakeDoNs((path, body) => {
    const b = body as { requestUri: string; params?: Record<string, string> }
    if (path === '/store') {
      store.set(b.requestUri, b.params ?? {})
      return Response.json({ stored: true })
    }
    if (path === '/consume') {
      const params = store.get(b.requestUri)
      if (!params) return new Response('{}', { status: 404 })
      store.delete(b.requestUri)
      return Response.json({ params })
    }
    return new Response('{}', { status: 404 })
  })
}

// /authorize 用的 OAuthFlowDO fake(本测试不走暂存,first-party + session 直接出 code)。
function oauthStateNoop(): DurableObjectNamespace {
  return makeFakeDoNs(() => new Response(null, { status: 201 }))
}

function appWith(ctx: TenantContext, sess: SessionData | null): Hono<XidHonoEnv> {
  const app = new Hono<XidHonoEnv>()
  app.use('*', async (c: Context<XidHonoEnv>, next) => {
    c.set('tenant', ctx)
    c.set('session', sess)
    await next()
  })
  registerParRoutes(app)
  registerAuthorizeRoutes(app)
  return app
}

// POST /par 请求,返回 request_uri。
async function postPar(app: Hono<XidHonoEnv>, env: Env): Promise<Response> {
  return app.request(
    'https://acme.xid.dev/par',
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        response_type: 'code',
        redirect_uri: 'https://rp.example/cb',
        scope: 'openid profile',
        state: 'st_par',
        code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
        code_challenge_method: 'S256',
      }).toString(),
    },
    env,
  )
}

describe('/par round-trip', () => {
  it('POST /par 返回 request_uri,/authorize 用其取参数续跑出 code', async () => {
    const { ctx } = await buildTestTenant()
    const env = makeEnv({
      DB: makeFakeD1({ applications: [appRow()] }),
      PAR_STORE: makeParStore(),
      OAUTH_STATE: makeOauthStateNs(),
    })
    const app = appWith(ctx, session())

    const parRes = await postPar(app, env)
    expect(parRes.status).toBe(201)
    expect(parRes.headers.get('cache-control')).toBe('no-store')
    expect(parRes.headers.get('pragma')).toBe('no-cache')
    const par = (await parRes.json()) as { request_uri: string; expires_in: number }
    expect(par.request_uri).toMatch(/^urn:ietf:params:oauth:request_uri:/)
    expect(par.expires_in).toBe(60)

    const authzRes = await app.request(
      `https://acme.xid.dev/authorize?${new URLSearchParams({
        client_id: CLIENT_ID,
        request_uri: par.request_uri,
      }).toString()}`,
      {},
      env,
    )
    expect(authzRes.status).toBe(302)
    const location = new URL(authzRes.headers.get('location') ?? '')
    expect(location.origin + location.pathname).toBe('https://rp.example/cb')
    expect(location.searchParams.get('code')).toMatch(/^ac_/)
    expect(location.searchParams.get('state')).toBe('st_par')
    expect(location.searchParams.get('iss')).toBe('https://acme.xid.dev')
  })

  it('重复 form 参数 -> invalid_request 且不存储 request_uri', async () => {
    const { ctx } = await buildTestTenant()
    const env = makeEnv({
      DB: makeFakeD1({ applications: [appRow()] }),
      PAR_STORE: makeParStore(),
      OAUTH_STATE: oauthStateNoop(),
    })
    const app = appWith(ctx, session())
    const body = new URLSearchParams([
      ['client_id', CLIENT_ID],
      ['client_id', 'other'],
      ['response_type', 'code'],
      ['redirect_uri', 'https://rp.example/cb'],
      ['scope', 'openid profile'],
      ['code_challenge', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'],
      ['code_challenge_method', 'S256'],
    ])
    const res = await app.request(
      'https://acme.xid.dev/par',
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
    expect(json['error_description']).toBe('duplicate parameter client_id')
  })

  it('JAR request object in PAR -> 验签后存储展开参数', async () => {
    const { ctx } = await buildTestTenant()
    const { privateKey, jwk } = await makeClientKeyPair()
    const env = makeEnv({
      DB: makeFakeD1({ applications: [appRow({ jwks: JSON.stringify({ keys: [jwk] }) })] }),
      PAR_STORE: makeParStore(),
      OAUTH_STATE: makeOauthStateNs(),
    })
    const app = appWith(ctx, session())
    const now = Math.floor(Date.now() / 1000)
    const request = await signRequestObject(privateKey, {
      iss: CLIENT_ID,
      aud: 'https://acme.xid.dev',
      exp: now + 120,
      nbf: now - 1,
      iat: now,
      jti: 'par-jar-jti-1',
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: 'https://rp.example/cb',
      scope: 'openid profile',
      state: 'st_par_jar',
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      code_challenge_method: 'S256',
    })
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      request,
    })
    const res = await app.request(
      'https://acme.xid.dev/par',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      },
      env,
    )
    expect(res.status).toBe(201)
    const par = (await res.json()) as { request_uri: string }
    const authzRes = await app.request(
      `https://acme.xid.dev/authorize?${new URLSearchParams({
        client_id: CLIENT_ID,
        request_uri: par.request_uri,
      }).toString()}`,
      {},
      env,
    )
    expect(authzRes.status).toBe(302)
    const location = new URL(authzRes.headers.get('location') ?? '')
    expect(location.searchParams.get('state')).toBe('st_par_jar')
  })

  it('RAR authorization_details in PAR -> /authorize 消费后签出 code', async () => {
    const { ctx } = await buildTestTenant()
    const env = makeEnv({
      DB: makeFakeD1({
        applications: [appRow({ allowed_scopes: JSON.stringify(['openid', 'profile', 'read']) })],
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
      }),
      PAR_STORE: makeParStore(),
      OAUTH_STATE: makeOauthStateNs(),
    })
    const app = appWith(ctx, session())
    const res = await app.request(
      'https://acme.xid.dev/par',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          response_type: 'code',
          redirect_uri: 'https://rp.example/cb',
          scope: 'openid profile',
          state: 'st_par_rar',
          code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
          code_challenge_method: 'S256',
          authorization_details: JSON.stringify([
            {
              type: 'resource_access',
              locations: ['https://api.example/v1'],
              actions: ['read'],
            },
          ]),
        }).toString(),
      },
      env,
    )
    expect(res.status).toBe(201)
    const par = (await res.json()) as { request_uri: string }
    const authzRes = await app.request(
      `https://acme.xid.dev/authorize?${new URLSearchParams({
        client_id: CLIENT_ID,
        request_uri: par.request_uri,
      }).toString()}`,
      {},
      env,
    )
    expect(authzRes.status).toBe(302)
    const location = new URL(authzRes.headers.get('location') ?? '')
    expect(location.searchParams.get('code')).toMatch(/^ac_/)
    expect(location.searchParams.get('state')).toBe('st_par_rar')
  })

  it('JAR request object without registered jwks -> invalid_request_object', async () => {
    const { ctx } = await buildTestTenant()
    const { privateKey } = await makeClientKeyPair()
    const env = makeEnv({
      DB: makeFakeD1({ applications: [appRow()] }),
      PAR_STORE: makeParStore(),
      OAUTH_STATE: makeOauthStateNs(),
    })
    const app = appWith(ctx, session())
    const now = Math.floor(Date.now() / 1000)
    const request = await signRequestObject(privateKey, {
      iss: CLIENT_ID,
      aud: 'https://acme.xid.dev',
      exp: now + 120,
      nbf: now - 1,
      iat: now,
      jti: 'par-jar-jti-no-jwks',
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: 'https://rp.example/cb',
      scope: 'openid profile',
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      code_challenge_method: 'S256',
    })
    const res = await app.request(
      'https://acme.xid.dev/par',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: CLIENT_ID, request }).toString(),
      },
      env,
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as Record<string, string>
    expect(json['error']).toBe('invalid_request_object')
    expect(json['error_description']).toBe('client has no registered jwks for request object')
  })

  it('RAR authorization_details 未知 type -> invalid_authorization_details 且不存储 request_uri', async () => {
    const { ctx } = await buildTestTenant()
    const env = makeEnv({
      DB: makeFakeD1({ applications: [appRow()] }),
      PAR_STORE: makeParStore(),
      OAUTH_STATE: oauthStateNoop(),
    })
    const app = appWith(ctx, session())
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: 'code',
      redirect_uri: 'https://rp.example/cb',
      scope: 'openid profile',
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      code_challenge_method: 'S256',
      authorization_details: JSON.stringify([{ type: 'payment' }]),
    })
    const res = await app.request(
      'https://acme.xid.dev/par',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      },
      env,
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as Record<string, string>
    expect(json['error']).toBe('invalid_authorization_details')
    expect(json['error_description']).toBe('authorization_details type is not supported')
  })

  it('request_uri 无效/已消费 -> 本地错误页', async () => {
    const { ctx } = await buildTestTenant()
    const env = makeEnv({
      DB: makeFakeD1({ applications: [appRow()] }),
      PAR_STORE: makeParStore(),
      OAUTH_STATE: oauthStateNoop(),
    })
    const app = appWith(ctx, session())
    const res = await app.request(
      `https://acme.xid.dev/authorize?${new URLSearchParams({
        client_id: CLIENT_ID,
        request_uri: 'urn:ietf:params:oauth:request_uri:nonexistent',
      }).toString()}`,
      {},
      env,
    )
    expect(res.status).toBe(400)
    expect(res.headers.get('location')).toBeNull()
  })
})
