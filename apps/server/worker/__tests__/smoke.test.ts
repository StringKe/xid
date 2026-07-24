// Worker Hono app 冒烟:验证 wire 后的真实路由表(registerAllRoutes)装配正确(不替代各端点单元测试)。
// node 测试池无真实 Workers binding,tenant 用 buildTestTenant 注入的 stub 中间件替代 tenantMiddleware;
// session 中间件用真实实现(无 cookie 返回 null,不触 D1)。i18n/error 中间件依赖 lingui macro 运行时
// (node 池不可加载),其装配由 index.ts 的类型检查覆盖,本冒烟不引入。其余 binding 用 OIDC 测试 fake。
// 断言:discovery 200 含 issuer;/jwks 返 JWKS;/v1/health 200;未登录 /authorize 302 /sign-in;
//       /token 缺参 400 OAuth 错误体。

import { Hono } from 'hono'
import type { Context, ErrorHandler } from 'hono'
import { describe, it, expect } from 'vitest'
import type { HostedAuthPolicy, TenantContext } from '@xid-kit/types'
import { DEFAULT_HOSTED_AUTH_POLICY } from '@xid-kit/types'
import { sessionMiddleware } from '../middleware/session'
import { buildEdgeProbePayload } from '../lib/edge-probe'
import { registerAllRoutes } from '../routes'
import { isAppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import {
  buildTestTenant,
  makeEnv,
  makeFakeD1,
  makeFakeDoNs,
  makeFakeKv,
  type TableSet,
} from '../oidc/__tests__/helpers'

const CLIENT_ID = 'cli_app'

const ENTERPRISE_SSO_ENABLED: HostedAuthPolicy = {
  ...DEFAULT_HOSTED_AUTH_POLICY,
  enterpriseSso: {
    enabled: true,
    allowLogin: true,
    allowJitUserCreation: true,
    domainDiscovery: true,
    allowedEmailDomains: [],
    blockedEmailDomains: [],
  },
}

// 与 oidc/__tests__/authorize.test.ts 同款 public client 行(first-party + PKCE 强制)。
function appRow(): Record<string, unknown> {
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
  }
}

// 测试内联 errorHandler:把 AppError 映射为 status + code JSON,绕过 @xid-kit/i18n macro 运行时依赖
// (node 池不可加载,见文件头)。Management API requireApiKey 走 throw AppError,需此 handler 映射 401。
const testErrorHandler: ErrorHandler<XidHonoEnv> = (err, c) => {
  if (isAppError(err)) {
    return c.json({ code: err.code }, err.httpStatus as Parameters<typeof c.json>[1])
  }
  return c.json({ code: 'server_error' }, 500)
}

// 复刻 createApp 的 sub-app 装配与路由表,但用 stub 注入 tenant(node 池无 D1 instances/orgs 行)。
// session 为真实中间件,registerAllRoutes 为真实路由注册(单一真相源)。i18n/error 中间件见文件头说明不引入。
// withErrorHandler=true 时挂内联 errorHandler(SCIM 走 scimError 直接返回不需要,v1 throw 需要)。
function buildSmokeApp(ctx: TenantContext, withErrorHandler = false): Hono<XidHonoEnv> {
  const app = new Hono<XidHonoEnv>()
  if (withErrorHandler) app.onError(testErrorHandler)
  app.get('/v1/health', (c) => c.json({ ok: true }))
  app.get('/v1/edge', async (c) => c.json(await buildEdgeProbePayload(c.req.raw.cf)))

  const protocol = new Hono<XidHonoEnv>()
  protocol.use('*', async (c: Context<XidHonoEnv>, next) => {
    c.set('tenant', ctx)
    await next()
  })
  protocol.use('*', sessionMiddleware)
  registerAllRoutes(protocol)
  app.route('/', protocol)

  return app
}

// SAML connection 行(top-level db.ssoConnections.findOne 只按 tenant_id 注入;metadata 路径读取
// protocol/status/id/sp_cert_id/want_assertions_signed)。tenant_id 与 buildTestTenant 的 t_1 对齐。
function samlConnectionRow(): Record<string, unknown> {
  return {
    id: 'conn_1',
    tenant_id: 't_1',
    org_id: 'org_1',
    protocol: 'saml',
    idp_entity_id: 'https://idp.example.com',
    idp_sso_url: 'https://idp.example.com/sso',
    idp_certificates: JSON.stringify(['CERT']),
    sp_cert_id: null,
    want_authn_response_signed: 1,
    want_assertions_signed: 1,
    attribute_mapping: JSON.stringify({}),
    role_mapping: JSON.stringify({}),
    jit_enabled: 1,
    relay_state_url: null,
    status: 'active',
    created_at: Date.now(),
    updated_at: Date.now(),
  }
}

function smokeEnv(tables: TableSet): Env {
  const oauthState = makeFakeDoNs((path) =>
    path === '/store' ? new Response(null, { status: 201 }) : new Response('{}', { status: 404 }),
  )
  return makeEnv({
    DB: makeFakeD1(tables),
    CACHE: makeFakeKv(),
    OAUTH_STATE: oauthState,
  })
}

const PKCE_PARAMS = {
  response_type: 'code',
  client_id: CLIENT_ID,
  redirect_uri: 'https://rp.example/cb',
  scope: 'openid profile',
  state: 'st_abc',
  code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  code_challenge_method: 'S256',
}

// 每个用例独立构建 tenant + app(buildTestTenant 生成真实 ES256 密钥)。
async function mk(): Promise<Hono<XidHonoEnv>> {
  const { ctx } = await buildTestTenant()
  return buildSmokeApp(ctx)
}

// 带内联 errorHandler 的变体(v1 throw AppError 需映射为 HTTP status)。
async function mkWithErr(): Promise<Hono<XidHonoEnv>> {
  const { ctx } = await buildTestTenant()
  return buildSmokeApp(ctx, true)
}

// SAML metadata 路由的最小 D1 fake:sso_connections 命中 connection 行(按 tenant_id+id 字符串参数过滤),
// cert_store 查询(usage='saml_sp_signing'/'saml_sp_encryption')无匹配行 -> 空证书集。其余表空。
function makeSamlD1(connections: Record<string, unknown>[]): D1Database {
  const match = (sql: string, params: unknown[]): Record<string, unknown>[] => {
    const lower = sql.toLowerCase()
    if (!lower.includes('sso_connections')) return []
    const sp = params.filter((v): v is string => typeof v === 'string')
    return connections.filter((r) => sp.every((v) => Object.values(r).includes(v)))
  }
  const projection = (sql: string): string[] => {
    const head = /^select\s+(.+?)\s+from\s/i.exec(sql)?.[1]
    if (!head) return []
    return [...head.matchAll(/"([a-z_]+)"/g)].map((m) => m[1] ?? '')
  }
  const prepare = (sql: string): unknown => {
    let bound: unknown[] = []
    const stmt = {
      bind: (...p: unknown[]) => {
        bound = p
        return stmt
      },
      raw: async () => match(sql, bound).map((r) => projection(sql).map((c) => r[c] ?? null)),
      all: async () => ({ results: match(sql, bound), success: true, meta: {} }),
      run: async () => ({ results: [], success: true, meta: {} }),
    }
    return stmt
  }
  return { prepare, batch: async () => [] } as unknown as D1Database
}

describe('worker app smoke: protocol endpoints', () => {
  it('GET /.well-known/openid-configuration -> 200 含 issuer', async () => {
    const app = await mk()
    const url = 'https://acme.xid.dev/.well-known/openid-configuration'
    const res = await app.request(url, {}, smokeEnv({}))
    expect(res.status).toBe(200)
    const meta = (await res.json()) as Record<string, unknown>
    expect(meta['issuer']).toBe('https://acme.xid.dev')
    expect(meta['token_endpoint']).toBe('https://acme.xid.dev/token')
  })

  it('GET /jwks -> 200 JWKS', async () => {
    const app = await mk()
    const res = await app.request('https://acme.xid.dev/jwks', {}, smokeEnv({}))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { keys: unknown[] }
    expect(Array.isArray(body.keys)).toBe(true)
    expect(body.keys.length).toBeGreaterThan(0)
  })

  it('GET /v1/health -> 200', async () => {
    const app = await mk()
    const res = await app.request('https://acme.xid.dev/v1/health', {}, smokeEnv({}))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('GET /v1/edge -> 200 with probe metrics', async () => {
    const app = await mk()
    const res = await app.request('https://acme.xid.dev/v1/edge', {}, smokeEnv({}))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      colo: string | null
      verifyUs: number
      signingAlg: string
      accessTokenTtlSec: number
      jwksRoundTrips: number
    }
    expect(body.colo).toBeNull()
    expect(body.signingAlg).toBe('ES256')
    expect(body.accessTokenTtlSec).toBe(60)
    expect(body.jwksRoundTrips).toBe(0)
    expect(body.verifyUs).toBeGreaterThan(0)
  })
})

describe('worker app smoke: authorize / token', () => {
  it('未登录 GET /authorize -> 302 /sign-in', async () => {
    const app = await mk()
    const url = `https://acme.xid.dev/authorize?${new URLSearchParams(PKCE_PARAMS).toString()}`
    const res = await app.request(url, {}, smokeEnv({ applications: [appRow()] }))
    expect(res.status).toBe(302)
    expect(res.headers.get('location') ?? '').toContain('/sign-in')
  })

  it('POST /token 缺参 -> 400 OAuth 错误体', async () => {
    const app = await mk()
    const res = await app.request(
      'https://acme.xid.dev/token',
      { method: 'POST' },
      smokeEnv({ applications: [appRow()] }),
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['error']).toBe('invalid_request')
  })
})

// Phase 2c 路由 wire 冒烟:验证 SSO / SCIM / Management API 已挂到真实路由表(registerAllRoutes),
// 且 SCIM/v1 走独立认证(无 OIDC session 复用):无 key/bearer 即 401。
describe('worker app smoke: SSO / SCIM / Management API wire', () => {
  it('GET /v1/users 无 sk_live_ -> 401(requireApiKey throw AppError 经 errorHandler 映射)', async () => {
    const app = await mkWithErr()
    const res = await app.request('https://acme.xid.dev/v1/users', {}, smokeEnv({}))
    expect(res.status).toBe(401)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['code']).toBe('unauthorized')
  })

  it('GET /scim/v2/organizations/{organization}/Users 无 Bearer -> 401(scimError 直接返回)', async () => {
    const app = await mk()
    const res = await app.request(
      'https://acme.xid.dev/scim/v2/organizations/t_1/Users',
      {},
      smokeEnv({}),
    )
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate') ?? '').toContain('Bearer')
  })

  it('GET /scim/v2/{tenant}/Users 旧公开路径不再注册', async () => {
    const app = await mk()
    const res = await app.request('https://acme.xid.dev/scim/v2/t_1/Users', {}, smokeEnv({}))
    expect(res.status).toBe(404)
  })

  it('GET /sso/saml/:connection/metadata -> 200 SP metadata XML', async () => {
    const { ctx } = await buildTestTenant()
    const app = buildSmokeApp({ ...ctx, policy: { hostedAuth: ENTERPRISE_SSO_ENABLED } })
    const env = makeEnv({ DB: makeSamlD1([samlConnectionRow()]) })
    const res = await app.request('https://acme.xid.dev/sso/saml/conn_1/metadata', {}, env)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type') ?? '').toContain('application/samlmetadata+xml')
    const xml = await res.text()
    expect(xml).toContain('EntityDescriptor')
    expect(xml).toContain('https://acme.xid.dev/saml/conn_1')
  })

  it('GET /sso/saml/:connection/metadata enterprise SSO 未启用 -> 401', async () => {
    const { ctx } = await buildTestTenant()
    const app = buildSmokeApp(ctx, true)
    const env = makeEnv({ DB: makeSamlD1([samlConnectionRow()]) })
    const res = await app.request('https://acme.xid.dev/sso/saml/conn_1/metadata', {}, env)
    expect(res.status).toBe(401)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['code']).toBe('invalid_credentials')
  })
})
