// /authorize 续跑:consent 决定回到 /authorize 由唯一的 emitCode 签发;max_age 超龄重新认证不循环。

import { describe, expect, it } from 'vitest'
import { exportPublicJwk, signJwt } from '@xid-kit/crypto'
import type { TenantContext } from '@xid-kit/types'
import type { Hono } from 'hono'
import { handleConsent } from '../../me-auth/consent'
import type { SessionData, XidHonoEnv } from '../../lib/types'
import { registerAuthorizeRoutes } from '../authorize'
import {
  buildTestTenant,
  makeApp,
  makeEnv,
  makeFakeD1,
  makeStatefulFakeDoNs,
  type D1Capture,
  type TableSet,
} from './helpers'

const CLIENT_ID = 'cli_third'
const AUTHENTICATED_AT = new Date(Date.now() - 120_000)

function thirdPartyApp(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    allowed_response_types: JSON.stringify(['code', 'code id_token']),
    allowed_scopes: JSON.stringify(['openid', 'profile']),
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

function session(overrides: Partial<SessionData> = {}): SessionData {
  return {
    sessionId: 's_1',
    userId: 'u_1',
    status: 'active',
    activeOrgId: null,
    authenticatedAt: AUTHENTICATED_AT,
    expiresAt: new Date(Date.now() + 3600_000),
    rememberMe: false,
    isImpersonation: false,
    impersonatorUserId: null,
    acr: null,
    amr: null,
    aal: null,
    ...overrides,
  }
}

const PARAMS = {
  response_type: 'code',
  client_id: CLIENT_ID,
  redirect_uri: 'https://rp.example/cb',
  scope: 'openid profile',
  state: 'st_abc',
  code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  code_challenge_method: 'S256',
}

function authorizeUrl(params: Record<string, string>): string {
  return `https://acme.xid.dev/authorize?${new URLSearchParams(params).toString()}`
}

function registerWithConsent(app: Hono<XidHonoEnv>): void {
  registerAuthorizeRoutes(app)
  app.post('/auth/consent', handleConsent)
}

type Harness = {
  env: Env
  capture: D1Capture
  appFor: (sess: SessionData | null) => Hono<XidHonoEnv>
}

async function harness(tables: TableSet): Promise<Harness & { ctx: TenantContext }> {
  const { ctx, kekB64 } = await buildTestTenant()
  const capture: D1Capture = { inserts: [], updates: [] }
  const { ns } = makeStatefulFakeDoNs()
  const env = makeEnv({ DB: makeFakeD1(tables, capture), OAUTH_STATE: ns, KEK: kekB64 })
  return {
    ctx,
    env,
    capture,
    appFor: (sess) => makeApp(ctx, registerWithConsent, sess),
  }
}

function promptIdFrom(response: Response): string {
  const location = new URL(response.headers.get('location') ?? '')
  return location.searchParams.get('authz_request_id') ?? ''
}

async function decide(h: Harness, promptId: string, approved: boolean): Promise<string> {
  const res = await h.appFor(session()).request(
    'https://acme.xid.dev/auth/consent',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ promptId, approved }),
    },
    h.env,
  )
  expect(res.status).toBe(200)
  return ((await res.json()) as { redirectUrl: string }).redirectUrl
}

async function consentRoundTrip(
  h: Harness,
  params: Record<string, string>,
  approved: boolean,
): Promise<Response> {
  const app = h.appFor(session())
  const first = await app.request(authorizeUrl(params), {}, h.env)
  expect(new URL(first.headers.get('location') ?? '').pathname).toBe('/consent')
  const redirectUrl = await decide(h, promptIdFrom(first), approved)
  expect(redirectUrl.startsWith('/authorize?authz_request_id=')).toBe(true)
  return app.request(`https://acme.xid.dev${redirectUrl}`, {}, h.env)
}

describe('/authorize consent continuation', () => {
  it('批准后回 /authorize 由 emitCode 签发 code,auth_time 取会话认证时间且持久化 consent', async () => {
    const h = await harness({ applications: [thirdPartyApp()] })

    const res = await consentRoundTrip(h, PARAMS, true)

    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location') ?? '')
    expect(location.origin + location.pathname).toBe('https://rp.example/cb')
    expect(location.searchParams.get('code')).toMatch(/^ac_/)
    expect(location.searchParams.get('state')).toBe('st_abc')
    const code = h.capture.inserts.find((insert) => insert.table === 'authorization_codes')
    expect(code?.params).toContain(Math.floor(AUTHENTICATED_AT.getTime() / 1000) * 1000)
    expect(h.capture.inserts.some((insert) => insert.table === 'oauth_consents')).toBe(true)
  })

  it('prompt=consent 批准后续跑不再回到 consent 页', async () => {
    const h = await harness({ applications: [thirdPartyApp()] })

    const res = await consentRoundTrip(h, { ...PARAMS, prompt: 'consent' }, true)

    const location = new URL(res.headers.get('location') ?? '')
    expect(location.origin + location.pathname).toBe('https://rp.example/cb')
    expect(location.searchParams.get('code')).toMatch(/^ac_/)
  })

  it('response_mode=form_post 批准后由 /authorize 输出自动提交表单', async () => {
    const h = await harness({ applications: [thirdPartyApp()] })

    const res = await consentRoundTrip(h, { ...PARAMS, response_mode: 'form_post' }, true)

    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('action="https://rp.example/cb"')
    expect(html).toContain('name="code"')
  })

  it('hybrid response_type 批准后 fragment 同时返回 code 和 id_token', async () => {
    const h = await harness({ applications: [thirdPartyApp()] })

    const res = await consentRoundTrip(
      h,
      { ...PARAMS, response_type: 'code id_token', nonce: 'n_1' },
      true,
    )

    const fragment = new URLSearchParams(new URL(res.headers.get('location') ?? '').hash.slice(1))
    expect(fragment.get('code')).toMatch(/^ac_/)
    expect(fragment.get('id_token')).toBeTruthy()
  })

  it('拒绝后按 response_mode 回跳 access_denied,不签发 code', async () => {
    const h = await harness({ applications: [thirdPartyApp()] })

    const res = await consentRoundTrip(h, { ...PARAMS, response_mode: 'form_post' }, false)

    const html = await res.text()
    expect(html).toContain('name="error" value="access_denied"')
    expect(h.capture.inserts.some((insert) => insert.table === 'authorization_codes')).toBe(false)
  })

  it('consent 决定只对同一会话有效:换会话续跑重新要求 consent', async () => {
    const h = await harness({ applications: [thirdPartyApp()] })
    const first = await h.appFor(session()).request(authorizeUrl(PARAMS), {}, h.env)
    const redirectUrl = await decide(h, promptIdFrom(first), true)

    const other = h.appFor(session({ sessionId: 's_other' }))
    const res = await other.request(`https://acme.xid.dev${redirectUrl}`, {}, h.env)

    expect(new URL(res.headers.get('location') ?? '').pathname).toBe('/consent')
  })
})

describe('/authorize max_age reauthentication', () => {
  it('会话超过 max_age -> 302 /sign-in 并带 reauthenticate=1', async () => {
    const h = await harness({ applications: [thirdPartyApp({ first_party: 1 })] })

    const res = await h
      .appFor(session())
      .request(authorizeUrl({ ...PARAMS, max_age: '60' }), {}, h.env)

    const location = new URL(res.headers.get('location') ?? '')
    expect(location.pathname).toBe('/sign-in')
    expect(location.searchParams.get('reauthenticate')).toBe('1')
  })

  it('max_age 内的会话直接签发 code', async () => {
    const h = await harness({ applications: [thirdPartyApp({ first_party: 1 })] })

    const res = await h
      .appFor(session())
      .request(authorizeUrl({ ...PARAMS, max_age: '3600' }), {}, h.env)

    expect(new URL(res.headers.get('location') ?? '').searchParams.get('code')).toMatch(/^ac_/)
  })

  it('max_age=0:未重新登录续跑回 /sign-in,重新登录后签发 code 且 auth_time 为新值', async () => {
    const h = await harness({ applications: [thirdPartyApp({ first_party: 1 })] })
    const first = await h
      .appFor(session())
      .request(authorizeUrl({ ...PARAMS, max_age: '0' }), {}, h.env)
    const resumeUrl = `https://acme.xid.dev/authorize?authz_request_id=${promptIdFrom(first)}&client_id=${CLIENT_ID}`

    const stale = await h.appFor(session()).request(resumeUrl, {}, h.env)
    const staleLocation = new URL(stale.headers.get('location') ?? '')
    expect(staleLocation.pathname).toBe('/sign-in')
    expect(staleLocation.searchParams.get('reauthenticate')).toBe('1')

    const freshAt = new Date(Date.now() + 1000)
    const fresh = await h
      .appFor(session({ authenticatedAt: freshAt }))
      .request(resumeUrl, {}, h.env)

    expect(new URL(fresh.headers.get('location') ?? '').searchParams.get('code')).toMatch(/^ac_/)
    const code = h.capture.inserts.find((insert) => insert.table === 'authorization_codes')
    expect(code?.params).toContain(Math.floor(freshAt.getTime() / 1000) * 1000)
  })

  it('JAR request object 内的 max_age=0 对已有会话同样要求重新认证', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])
    const jwk = await exportPublicJwk(pair.publicKey, 'ckid', 'ES256')
    const h = await harness({
      applications: [thirdPartyApp({ first_party: 1, jwks: JSON.stringify({ keys: [jwk] }) })],
    })
    const now = Math.floor(Date.now() / 1000)
    const request = await signJwt(
      {
        header: { alg: 'ES256', kid: 'ckid' },
        payload: {
          ...PARAMS,
          iss: CLIENT_ID,
          aud: 'https://acme.xid.dev',
          exp: now + 120,
          nbf: now - 1,
          iat: now,
          jti: 'jar-max-age',
          max_age: 0,
          login_hint: 'user@example.test',
        },
      },
      pair.privateKey,
    )

    const res = await h
      .appFor(session())
      .request(authorizeUrl({ client_id: CLIENT_ID, request }), {}, h.env)

    const location = new URL(res.headers.get('location') ?? '')
    expect(location.pathname).toBe('/sign-in')
    expect(location.searchParams.get('reauthenticate')).toBe('1')
    expect(location.searchParams.get('login_hint')).toBe('user@example.test')
  })

  it('无会话续跑超龄请求时登录页仍带 reauthenticate=1', async () => {
    const h = await harness({ applications: [thirdPartyApp({ first_party: 1 })] })
    const first = await h
      .appFor(session())
      .request(authorizeUrl({ ...PARAMS, max_age: '0' }), {}, h.env)

    const res = await h
      .appFor(null)
      .request(`https://acme.xid.dev/authorize?authz_request_id=${promptIdFrom(first)}`, {}, h.env)

    expect(new URL(res.headers.get('location') ?? '').searchParams.get('reauthenticate')).toBe('1')
  })
})
