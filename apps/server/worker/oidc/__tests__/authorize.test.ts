// /authorize 端点测试:无 session -> 暂存 OAuthFlowDO + 302 /sign-in;有 session + first-party ->
// 生成 code 写 D1 + 302 回 redirect_uri(带 state);未知 client / redirect_uri 不匹配 -> 本地错误页。

import { describe, it, expect } from 'vitest'
import type { TenantContext } from '@xid-kit/types'
import { exportPublicJwk, importJwkForVerify, signJwt, verifyJwt } from '@xid-kit/crypto'
import { leftHalfHash } from '@xid-kit/protocol'
import type { SessionData } from '../../lib/types'
import { issueStepUpToken, type StepUpPasskeyAssurance } from '../../auth/mfa'
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

const CLIENT_ID = 'cli_app'
const PEPPER_RAW = 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY3OA'

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

function activeOrgSession(): SessionData {
  return { ...session(), activeOrgId: 'org_b' }
}

function authorizeUrl(params: Record<string, string>): string {
  return `https://acme.xid.dev/authorize?${new URLSearchParams(params).toString()}`
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

function setup(
  tables: TableSet,
  ctx: TenantContext,
  sess: SessionData | null,
  kekB64?: string,
): { app: ReturnType<typeof makeApp>; env: Env; capture: D1Capture; stored: unknown[] } {
  const capture: D1Capture = { inserts: [], updates: [] }
  const { ns, stored } = makeStatefulFakeDoNs()
  const env = makeEnv({
    DB: makeFakeD1(tables, capture),
    OAUTH_STATE: ns,
    PEPPER: PEPPER_RAW,
    KEK: kekB64,
  })
  const app = makeApp(ctx, registerAuthorizeRoutes, sess)
  return { app, env, capture, stored }
}

async function stepUpCookie(
  input: {
    userId?: string
    sessionId?: string
    method?: 'totp' | 'backup' | 'sms' | 'passkey'
    passkeyAssurance?: StepUpPasskeyAssurance
  } = {},
): Promise<string> {
  const { token } = await issueStepUpToken({
    userId: input.userId ?? 'u_1',
    sessionId: input.sessionId ?? 's_1',
    method: input.method ?? 'totp',
    pepperRaw: PEPPER_RAW,
    passkeyAssurance: input.passkeyAssurance,
  })
  return `__Host-xid.acr=${token}`
}

const AAL3_PASSKEY_ASSURANCE: StepUpPasskeyAssurance = {
  userVerified: true,
  credentialBackedUp: false,
  credentialDeviceType: 'singleDevice',
  enterpriseAttestationVerified: false,
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

describe('/authorize', () => {
  it('无 session -> 暂存参数到 OAuthFlowDO + 302 /sign-in', async () => {
    const { ctx } = await buildTestTenant()
    const { app, env, stored } = setup({ applications: [appRow()] }, ctx, null)
    const res = await app.request(
      authorizeUrl({ ...PKCE_PARAMS, login_hint: 'admin@example.test' }),
      {},
      env,
    )
    expect(res.status).toBe(302)
    const location = res.headers.get('location') ?? ''
    expect(location).toContain('/sign-in')
    expect(location).toContain('authz_request_id=')
    expect(location).toContain('login_hint=admin%40example.test')
    expect(stored).toHaveLength(1)
  })

  it('登录后带 authz_request_id 回到 /authorize -> 续跑暂存请求并签出 code', async () => {
    const { ctx } = await buildTestTenant()
    const setupResult = setup({ applications: [appRow()] }, ctx, null)
    const first = await setupResult.app.request(authorizeUrl(PKCE_PARAMS), {}, setupResult.env)
    const authzRequestId = new URL(first.headers.get('location') ?? '').searchParams.get(
      'authz_request_id',
    )
    expect(authzRequestId).toBeTruthy()

    const app = makeApp(ctx, registerAuthorizeRoutes, session())
    const res = await app.request(
      `https://acme.xid.dev/authorize?authz_request_id=${authzRequestId}`,
      {},
      setupResult.env,
    )

    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location') ?? '')
    expect(location.origin + location.pathname).toBe('https://rp.example/cb')
    expect(location.searchParams.get('code')).toMatch(/^ac_/)
    expect(location.searchParams.get('state')).toBe('st_abc')
    expect(location.searchParams.get('iss')).toBe('https://acme.xid.dev')
  })

  it('有 session + first-party -> 生成 code 写 D1 + 302 回 redirect_uri 带 state', async () => {
    const { ctx } = await buildTestTenant()
    const { app, env, capture } = setup({ applications: [appRow()] }, ctx, {
      ...session(),
      acr: 'urn:xid:aal2',
      amr: ['pwd', 'otp', 'mfa'],
      aal: 2,
    })
    const res = await app.request(authorizeUrl(PKCE_PARAMS), {}, env)
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location') ?? '')
    expect(location.origin + location.pathname).toBe('https://rp.example/cb')
    expect(location.searchParams.get('code')).toMatch(/^ac_/)
    expect(location.searchParams.get('state')).toBe('st_abc')
    expect(location.searchParams.get('iss')).toBe('https://acme.xid.dev')
    // 写 D1 authorization_codes。
    expect(capture.inserts.some((i) => i.table === 'authorization_codes')).toBe(true)
    const insert = capture.inserts.find((i) => i.table === 'authorization_codes')
    expect(insert?.params).toContain('urn:xid:aal2')
    expect(insert?.params).toContain(JSON.stringify(['pwd', 'otp', 'mfa']))
    expect(insert?.params).toContain('s_1')
  })

  it('authorize 请求 dpop_jkt -> authorization code 记录 DPoP 绑定', async () => {
    const { ctx } = await buildTestTenant()
    const { app, env, capture } = setup({ applications: [appRow()] }, ctx, session())
    const res = await app.request(
      authorizeUrl({ ...PKCE_PARAMS, dpop_jkt: 'jkt_authorize' }),
      {},
      env,
    )
    expect(res.status).toBe(302)
    const insert = capture.inserts.find((i) => i.table === 'authorization_codes')
    expect(insert?.params).toContain('jkt_authorize')
  })

  it('acr_values 请求 AAL2 + AAL1 session -> 暂存请求并 302 到 step-up MFA', async () => {
    const { ctx } = await buildTestTenant()
    const { app, env, capture, stored } = setup({ applications: [appRow()] }, ctx, {
      ...session(),
      acr: 'urn:xid:aal1',
      amr: ['pwd'],
      aal: 1,
    })
    const res = await app.request(
      authorizeUrl({ ...PKCE_PARAMS, acr_values: 'urn:xid:aal2' }),
      {},
      env,
    )

    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location') ?? '')
    expect(location.pathname).toBe('/mfa')
    expect(location.searchParams.get('step_up')).toBe('1')
    expect(location.searchParams.get('redirect_to')).toMatch(/^\/authorize\?authz_request_id=/)
    expect(stored).toHaveLength(1)
    expect(capture.inserts.some((i) => i.table === 'authorization_codes')).toBe(false)
  })

  it('claims acr values 请求 AAL2 + 有效 step-up cookie -> 签发 AAL2 code', async () => {
    const { ctx } = await buildTestTenant()
    const sess = { ...session(), acr: 'urn:xid:aal1', amr: ['pwd'] as const, aal: 1 }
    const { app, env, capture } = setup({ applications: [appRow()] }, ctx, sess)
    const claims = JSON.stringify({ id_token: { acr: { values: ['urn:xid:aal2'] } } })
    const res = await app.request(
      authorizeUrl({ ...PKCE_PARAMS, claims }),
      { headers: { Cookie: await stepUpCookie({ method: 'sms' }) } },
      env,
    )

    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location') ?? '')
    expect(location.origin + location.pathname).toBe('https://rp.example/cb')
    expect(location.searchParams.get('code')).toMatch(/^ac_/)
    const insert = capture.inserts.find((i) => i.table === 'authorization_codes')
    expect(insert?.params).toContain('urn:xid:aal2')
    expect(insert?.params).toContain(JSON.stringify(['pwd', 'sms', 'mfa']))
    expect(res.headers.get('set-cookie')).toContain('__Host-xid.acr=')
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0')
  })

  it('acr_values 请求 AAL2 + step-up cookie sid 不匹配 -> 继续要求 MFA', async () => {
    const { ctx } = await buildTestTenant()
    const sess = { ...session(), acr: 'urn:xid:aal1', amr: ['pwd'] as const, aal: 1 }
    const { app, env, capture } = setup({ applications: [appRow()] }, ctx, sess)
    const res = await app.request(
      authorizeUrl({ ...PKCE_PARAMS, acr_values: 'urn:xid:aal2' }),
      { headers: { Cookie: await stepUpCookie({ sessionId: 's_other' }) } },
      env,
    )

    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location') ?? '')
    expect(location.pathname).toBe('/mfa')
    expect(capture.inserts.some((i) => i.table === 'authorization_codes')).toBe(false)
  })

  it('acr_values 请求 AAL3 + AAL1 session -> 暂存请求并 302 到 passkey step-up MFA', async () => {
    const { ctx } = await buildTestTenant()
    const { app, env, capture, stored } = setup({ applications: [appRow()] }, ctx, {
      ...session(),
      acr: 'urn:xid:aal1',
      amr: ['pwd'],
      aal: 1,
    })
    const res = await app.request(
      authorizeUrl({ ...PKCE_PARAMS, acr_values: 'urn:xid:aal3' }),
      {},
      env,
    )

    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location') ?? '')
    expect(location.pathname).toBe('/mfa')
    expect(location.searchParams.get('step_up')).toBe('1')
    expect(location.searchParams.get('method')).toBe('passkey')
    expect(location.searchParams.get('require_aal3')).toBe('1')
    expect(stored).toHaveLength(1)
    expect(capture.inserts.some((i) => i.table === 'authorization_codes')).toBe(false)
  })

  it('acr_values 请求 AAL3 + 有效 passkey step-up cookie -> 签发 AAL3 code', async () => {
    const { ctx } = await buildTestTenant()
    const sess = { ...session(), acr: 'urn:xid:aal1', amr: ['pwd'] as const, aal: 1 }
    const { app, env, capture } = setup({ applications: [appRow()] }, ctx, sess)
    const res = await app.request(
      authorizeUrl({ ...PKCE_PARAMS, acr_values: 'urn:xid:aal3' }),
      {
        headers: {
          Cookie: await stepUpCookie({
            method: 'passkey',
            passkeyAssurance: AAL3_PASSKEY_ASSURANCE,
          }),
        },
      },
      env,
    )

    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location') ?? '')
    expect(location.searchParams.get('code')).toMatch(/^ac_/)
    const insert = capture.inserts.find((i) => i.table === 'authorization_codes')
    expect(insert?.params).toContain('urn:xid:aal3')
    expect(insert?.params).toContain(JSON.stringify(['pwd', 'phr', 'mfa']))
  })

  it('acr_values 请求 AAL3 + backed-up passkey step-up cookie -> 仅签发 AAL2 code', async () => {
    const { ctx } = await buildTestTenant()
    const sess = { ...session(), acr: 'urn:xid:aal1', amr: ['pwd'] as const, aal: 1 }
    const { app, env, capture } = setup({ applications: [appRow()] }, ctx, sess)
    const res = await app.request(
      authorizeUrl({ ...PKCE_PARAMS, acr_values: 'urn:xid:aal3' }),
      {
        headers: {
          Cookie: await stepUpCookie({
            method: 'passkey',
            passkeyAssurance: {
              ...AAL3_PASSKEY_ASSURANCE,
              credentialBackedUp: true,
            },
          }),
        },
      },
      env,
    )

    expect(res.status).toBe(302)
    const insert = capture.inserts.find((i) => i.table === 'authorization_codes')
    expect(insert?.params).toContain('urn:xid:aal2')
    expect(insert?.params).not.toContain('urn:xid:aal3')
  })

  it('prompt=none + unmet acr_values AAL3 -> redirect error interaction_required', async () => {
    const { ctx } = await buildTestTenant()
    const { app, env, capture } = setup({ applications: [appRow()] }, ctx, {
      ...session(),
      acr: 'urn:xid:aal1',
      amr: ['pwd'],
      aal: 1,
    })
    const res = await app.request(
      authorizeUrl({ ...PKCE_PARAMS, prompt: 'none', acr_values: 'urn:xid:aal3' }),
      {},
      env,
    )

    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location') ?? '')
    expect(location.searchParams.get('error')).toBe('interaction_required')
    expect(capture.inserts.some((i) => i.table === 'authorization_codes')).toBe(false)
  })

  it('prompt=none + unmet acr_values AAL2 -> redirect error interaction_required', async () => {
    const { ctx } = await buildTestTenant()
    const { app, env, capture } = setup({ applications: [appRow()] }, ctx, {
      ...session(),
      acr: 'urn:xid:aal1',
      amr: ['pwd'],
      aal: 1,
    })
    const res = await app.request(
      authorizeUrl({ ...PKCE_PARAMS, prompt: 'none', acr_values: 'urn:xid:aal2' }),
      {},
      env,
    )

    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location') ?? '')
    expect(location.origin + location.pathname).toBe('https://rp.example/cb')
    expect(location.searchParams.get('error')).toBe('interaction_required')
    expect(location.searchParams.get('state')).toBe('st_abc')
    expect(capture.inserts.some((i) => i.table === 'authorization_codes')).toBe(false)
  })

  it('pending_mfa session -> 302 /mfa 续跑,不发 code(MFA 门控)', async () => {
    const { ctx } = await buildTestTenant()
    const { app, env, capture, stored } = setup({ applications: [appRow()] }, ctx, {
      ...session(),
      status: 'pending_mfa',
    })
    const res = await app.request(authorizeUrl(PKCE_PARAMS), {}, env)

    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location') ?? '')
    expect(location.pathname).toBe('/mfa')
    expect(location.searchParams.get('authz_request_id')).toBeTruthy()
    expect(location.searchParams.get('redirect_to')).toMatch(/^\/authorize\?authz_request_id=/)
    // pending_mfa 续跑走 session 升级,不是 step-up token。
    expect(location.searchParams.get('step_up')).toBeNull()
    expect(stored).toHaveLength(1)
    expect(capture.inserts.some((i) => i.table === 'authorization_codes')).toBe(false)
  })

  it('pending_mfa_setup session -> 302 /account/security?setup=mfa 绑定后再续跑', async () => {
    const { ctx } = await buildTestTenant()
    const { app, env, capture, stored } = setup({ applications: [appRow()] }, ctx, {
      ...session(),
      status: 'pending_mfa_setup',
    })
    const res = await app.request(authorizeUrl(PKCE_PARAMS), {}, env)

    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location') ?? '')
    expect(location.pathname).toBe('/account/security')
    expect(location.searchParams.get('setup')).toBe('mfa')
    expect(location.searchParams.get('redirect_to')).toMatch(/^\/authorize\?authz_request_id=/)
    expect(stored).toHaveLength(1)
    expect(capture.inserts.some((i) => i.table === 'authorization_codes')).toBe(false)
  })

  it('prompt=none + pending_mfa session -> redirect error login_required(不弹交互)', async () => {
    const { ctx } = await buildTestTenant()
    const { app, env, capture } = setup({ applications: [appRow()] }, ctx, {
      ...session(),
      status: 'pending_mfa',
    })
    const res = await app.request(authorizeUrl({ ...PKCE_PARAMS, prompt: 'none' }), {}, env)

    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location') ?? '')
    expect(location.origin + location.pathname).toBe('https://rp.example/cb')
    expect(location.searchParams.get('error')).toBe('login_required')
    expect(location.searchParams.get('state')).toBe('st_abc')
    expect(capture.inserts.some((i) => i.table === 'authorization_codes')).toBe(false)
  })

  it('authz_request_id 续跑 + pending_mfa session -> 302 /mfa,不发 code', async () => {
    const { ctx } = await buildTestTenant()
    const setupResult = setup({ applications: [appRow()] }, ctx, null)
    const first = await setupResult.app.request(authorizeUrl(PKCE_PARAMS), {}, setupResult.env)
    const authzRequestId = new URL(first.headers.get('location') ?? '').searchParams.get(
      'authz_request_id',
    )
    expect(authzRequestId).toBeTruthy()

    const app = makeApp(ctx, registerAuthorizeRoutes, { ...session(), status: 'pending_mfa' })
    const res = await app.request(
      `https://acme.xid.dev/authorize?authz_request_id=${authzRequestId}`,
      {},
      setupResult.env,
    )

    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location') ?? '')
    expect(location.pathname).toBe('/mfa')
    expect(location.searchParams.get('step_up')).toBeNull()
    expect(setupResult.capture.inserts.some((i) => i.table === 'authorization_codes')).toBe(false)
  })

  it('response_mode=fragment -> fragment 回传 code/state/iss', async () => {
    const { ctx } = await buildTestTenant()
    const { app, env } = setup({ applications: [appRow()] }, ctx, session())
    const res = await app.request(
      authorizeUrl({ ...PKCE_PARAMS, response_mode: 'fragment' }),
      {},
      env,
    )
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location') ?? '')
    expect(location.origin + location.pathname).toBe('https://rp.example/cb')
    expect(location.search).toBe('')
    const fragment = new URLSearchParams(location.hash.slice(1))
    expect(fragment.get('code')).toMatch(/^ac_/)
    expect(fragment.get('state')).toBe('st_abc')
    expect(fragment.get('iss')).toBe('https://acme.xid.dev')
  })

  it('response_mode=form_post -> 自动提交 HTML 表单回传 code/state/iss', async () => {
    const { ctx } = await buildTestTenant()
    const { app, env } = setup({ applications: [appRow()] }, ctx, session())
    const res = await app.request(
      authorizeUrl({ ...PKCE_PARAMS, response_mode: 'form_post' }),
      {},
      env,
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.headers.get('cache-control')).toBe('no-store')
    const html = await res.text()
    expect(html).toContain('method="post"')
    expect(html).toContain('action="https://rp.example/cb"')
    expect(html).toContain('name="code"')
    expect(html).toContain('value="st_abc"')
    expect(html).toContain('value="https://acme.xid.dev"')
  })

  it('单 org + require_org_context + null activeOrgId -> 自动设置并签发 code', async () => {
    const { ctx } = await buildTestTenant()
    const { app, env, capture } = setup(
      {
        applications: [appRow({ require_org_context: 1 })],
        organizations: [
          {
            id: 'org_a',
            tenant_id: 't_1',
            slug: 'org-a',
            status: 'active',
            deleted_at: null,
            public_metadata: '{}',
          },
        ],
        memberships: [
          {
            id: 'mem_1',
            tenant_id: 't_1',
            org_id: 'org_a',
            user_id: 'u_1',
            status: 'active',
          },
        ],
      },
      ctx,
      session(),
    )
    const res = await app.request(authorizeUrl(PKCE_PARAMS), {}, env)
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location') ?? '')
    expect(location.searchParams.get('code')).toMatch(/^ac_/)
    const insert = capture.inserts.find((i) => i.table === 'authorization_codes')
    expect(insert?.params).toContain('org_a')
  })

  it('B2C 无 membership + 无 require_org_context -> 签发 code 且 active_org_id 为 null', async () => {
    const { ctx } = await buildTestTenant()
    const { app, env, capture } = setup({ applications: [appRow()] }, ctx, session())
    const res = await app.request(authorizeUrl(PKCE_PARAMS), {}, env)
    expect(res.status).toBe(302)
    const insert = capture.inserts.find((i) => i.table === 'authorization_codes')
    expect(insert?.params).toContain(null)
  })

  it('多 org 无 activeOrg + require_org_context -> 302 /select-organization', async () => {
    const { ctx } = await buildTestTenant()
    const { app, env, stored } = setup(
      {
        applications: [appRow({ require_org_context: 1 })],
        organizations: [
          {
            id: 'org_a',
            tenant_id: 't_1',
            slug: 'org-a',
            status: 'active',
            deleted_at: null,
            public_metadata: '{}',
          },
          {
            id: 'org_b',
            tenant_id: 't_1',
            slug: 'org-b',
            status: 'active',
            deleted_at: null,
            public_metadata: '{}',
          },
        ],
        memberships: [
          {
            id: 'mem_1',
            tenant_id: 't_1',
            org_id: 'org_a',
            user_id: 'u_1',
            status: 'active',
          },
          {
            id: 'mem_2',
            tenant_id: 't_1',
            org_id: 'org_b',
            user_id: 'u_1',
            status: 'active',
          },
        ],
      },
      ctx,
      session(),
    )
    const res = await app.request(authorizeUrl(PKCE_PARAMS), {}, env)
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location') ?? '')
    expect(location.pathname).toBe('/select-organization')
    expect(location.searchParams.get('authz_request_id')).toBeTruthy()
    expect(location.searchParams.get('redirect_to')).toMatch(/^\/authorize\?authz_request_id=/)
    expect(stored).toHaveLength(1)
  })

  it('active org + ProjectGrant -> code 持久化 active_org_id 和 project_grant_id', async () => {
    const { ctx } = await buildTestTenant()
    const { app, env, capture } = setup(
      {
        applications: [appRow({ project_id: 'proj_a' })],
        organizations: [
          {
            id: 'org_b',
            tenant_id: 't_1',
            slug: 'org-b',
            status: 'active',
            public_metadata: '{}',
          },
        ],
        memberships: [
          {
            id: 'mem_1',
            tenant_id: 't_1',
            org_id: 'org_b',
            user_id: 'u_1',
            status: 'active',
          },
        ],
        projects: [{ id: 'proj_a', tenant_id: 't_1', org_id: 'org_a' }],
        project_grants: [
          {
            id: 'grant_1',
            tenant_id: 't_1',
            granted_project_id: 'proj_a',
            granted_by_org_id: 'org_a',
            granted_to_org_id: 'org_b',
            status: 'active',
          },
        ],
        user_grants: [
          {
            id: 'ug_1',
            tenant_id: 't_1',
            user_id: 'u_1',
            project_id: 'proj_a',
            role_id: 'role_viewer',
            granted_via_grant_id: 'grant_1',
            revoked_at: null,
          },
        ],
      },
      ctx,
      activeOrgSession(),
    )
    const res = await app.request(authorizeUrl(PKCE_PARAMS), {}, env)
    expect(res.status).toBe(302)
    const insert = capture.inserts.find((i) => i.table === 'authorization_codes')
    expect(insert?.params).toContain('org_b')
    expect(insert?.params).toContain('grant_1')
  })
})

describe('/authorize errors', () => {
  it('未知 client -> 本地错误页(不重定向)', async () => {
    const { ctx } = await buildTestTenant()
    const { app, env } = setup({ applications: [] }, ctx, session())
    const res = await app.request(authorizeUrl(PKCE_PARAMS), {}, env)
    expect(res.status).toBe(400)
    expect(res.headers.get('location')).toBeNull()
    // redirect_uri 不可信时渲染品牌化 HTML 错误页而不是 JSON(03 章 10.2)。
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.headers.get('cache-control')).toBe('no-store')
    const html = await res.text()
    expect(html).toContain('invalid_request')
    expect(html).toContain('unknown client_id')
  })

  it('redirect_uri 不精确匹配 -> 本地错误页', async () => {
    const { ctx } = await buildTestTenant()
    const { app, env } = setup({ applications: [appRow()] }, ctx, session())
    const res = await app.request(
      authorizeUrl({ ...PKCE_PARAMS, redirect_uri: 'https://evil.example/cb' }),
      {},
      env,
    )
    expect(res.status).toBe(400)
    expect(res.headers.get('location')).toBeNull()
  })

  it('redirect_uri 不精确匹配时不执行 Grant 重定向错误', async () => {
    const { ctx } = await buildTestTenant()
    const { app, env } = setup(
      { applications: [appRow({ project_id: 'proj_a' })] },
      ctx,
      activeOrgSession(),
    )
    const res = await app.request(
      authorizeUrl({ ...PKCE_PARAMS, redirect_uri: 'https://evil.example/cb' }),
      {},
      env,
    )
    expect(res.status).toBe(400)
    expect(res.headers.get('location')).toBeNull()
  })

  it('JAR request object -> 验签后用 request object 参数签出 code', async () => {
    const { ctx } = await buildTestTenant()
    const { privateKey, jwk } = await makeClientKeyPair()
    const { app, env } = setup(
      { applications: [appRow({ jwks: JSON.stringify({ keys: [jwk] }) })] },
      ctx,
      session(),
    )
    const now = Math.floor(Date.now() / 1000)
    const request = await signRequestObject(privateKey, {
      iss: CLIENT_ID,
      aud: 'https://acme.xid.dev/authorize',
      exp: now + 120,
      nbf: now - 1,
      iat: now,
      jti: 'jar-jti-1',
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: 'https://rp.example/cb',
      scope: 'openid profile',
      state: 'st_jar',
      code_challenge: PKCE_PARAMS.code_challenge,
      code_challenge_method: 'S256',
    })
    const res = await app.request(
      authorizeUrl({
        client_id: CLIENT_ID,
        request,
      }),
      {},
      env,
    )
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location') ?? '')
    expect(location.origin + location.pathname).toBe('https://rp.example/cb')
    expect(location.searchParams.get('code')).toMatch(/^ac_/)
    expect(location.searchParams.get('state')).toBe('st_jar')
    expect(location.searchParams.get('iss')).toBe('https://acme.xid.dev')
  })

  it('JAR request object 相同 jti 重放 -> 本地错误页', async () => {
    const { ctx } = await buildTestTenant()
    const { privateKey, jwk } = await makeClientKeyPair()
    const { app, env } = setup(
      { applications: [appRow({ jwks: JSON.stringify({ keys: [jwk] }) })] },
      ctx,
      session(),
    )
    const now = Math.floor(Date.now() / 1000)
    const request = await signRequestObject(privateKey, {
      iss: CLIENT_ID,
      aud: 'https://acme.xid.dev',
      exp: now + 120,
      nbf: now - 1,
      iat: now,
      jti: 'jar-jti-replay',
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: 'https://rp.example/cb',
      scope: 'openid profile',
      state: 'st_jar',
      code_challenge: PKCE_PARAMS.code_challenge,
      code_challenge_method: 'S256',
    })
    const url = authorizeUrl({ client_id: CLIENT_ID, request })

    expect((await app.request(url, {}, env)).status).toBe(302)
    const replay = await app.request(url, {}, env)
    expect(replay.status).toBe(400)
    expect(replay.headers.get('content-type')).toContain('text/html')
    const html = await replay.text()
    expect(html).toContain('invalid_request_object')
    expect(html).toContain('request object jti replayed')
  })

  it('RAR authorization_details 参数 -> 写入 code 的授权细节、resource 和 action scope', async () => {
    const { ctx } = await buildTestTenant()
    const { app, env, capture } = setup(
      {
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
      },
      ctx,
      session(),
    )
    const res = await app.request(
      authorizeUrl({
        ...PKCE_PARAMS,
        scope: 'openid profile',
        authorization_details: JSON.stringify([
          {
            type: 'resource_access',
            locations: ['https://api.example/v1'],
            actions: ['read'],
          },
        ]),
      }),
      {},
      env,
    )
    expect(res.status).toBe(302)
    const insert = capture.inserts.find((i) => i.table === 'authorization_codes')
    expect(insert?.params).toContain('openid profile read')
    expect(insert?.params).toContain(JSON.stringify(['https://api.example/v1']))
    expect(insert?.params).toContain(
      JSON.stringify([
        {
          type: 'resource_access',
          locations: ['https://api.example/v1'],
          actions: ['read'],
        },
      ]),
    )
  })

  it('RAR authorization_details 未知 type -> invalid_authorization_details 本地错误页', async () => {
    const { ctx } = await buildTestTenant()
    const { app, env } = setup({ applications: [appRow()] }, ctx, session())
    const res = await app.request(
      authorizeUrl({
        ...PKCE_PARAMS,
        authorization_details: JSON.stringify([{ type: 'payment' }]),
      }),
      {},
      env,
    )
    expect(res.status).toBe(400)
    expect(res.headers.get('location')).toBeNull()
    expect(res.headers.get('content-type')).toContain('text/html')
    const html = await res.text()
    expect(html).toContain('invalid_authorization_details')
  })

  it('JARM response_mode=query.jwt -> query response 参数承载签名授权响应', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const { app, env, capture } = setup({ applications: [appRow()] }, ctx, session(), kekB64)
    const res = await app.request(
      authorizeUrl({ ...PKCE_PARAMS, response_mode: 'query.jwt' }),
      {},
      env,
    )
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location') ?? '')
    expect(location.origin + location.pathname).toBe('https://rp.example/cb')
    expect(location.searchParams.get('code')).toBeNull()
    const payload = await verifyIdPayload(ctx, location.searchParams.get('response') ?? '')
    expect(payload['iss']).toBe('https://acme.xid.dev')
    expect(payload['aud']).toBe(CLIENT_ID)
    expect(payload['code']).toMatch(/^ac_/)
    expect(payload['state']).toBe('st_abc')
    expect(capture.inserts.some((i) => i.table === 'authorization_codes')).toBe(true)
  })

  it('JARM response_mode=fragment.jwt -> fragment response 参数承载签名错误响应', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const { app, env, capture } = setup({ applications: [appRow()] }, ctx, session(), kekB64)
    const { code_challenge: _c, code_challenge_method: _m, ...noPkce } = PKCE_PARAMS
    const res = await app.request(
      authorizeUrl({ ...noPkce, response_mode: 'fragment.jwt' }),
      {},
      env,
    )
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location') ?? '')
    expect(location.origin + location.pathname).toBe('https://rp.example/cb')
    expect(location.search).toBe('')
    const fragment = new URLSearchParams(location.hash.slice(1))
    expect(fragment.get('error')).toBeNull()
    const payload = await verifyIdPayload(ctx, fragment.get('response') ?? '')
    expect(payload['iss']).toBe('https://acme.xid.dev')
    expect(payload['aud']).toBe(CLIENT_ID)
    expect(payload['error']).toBe('invalid_request')
    expect(payload['state']).toBe('st_abc')
    expect(capture.inserts.some((i) => i.table === 'authorization_codes')).toBe(false)
  })

  it('ProjectGrant 不存在 -> redirect error access_denied', async () => {
    const { ctx } = await buildTestTenant()
    const { app, env } = setup(
      {
        applications: [appRow({ project_id: 'proj_a' })],
        organizations: [
          {
            id: 'org_b',
            tenant_id: 't_1',
            slug: 'org-b',
            status: 'active',
            public_metadata: '{}',
          },
        ],
        memberships: [
          {
            id: 'mem_1',
            tenant_id: 't_1',
            org_id: 'org_b',
            user_id: 'u_1',
            status: 'active',
          },
        ],
        projects: [{ id: 'proj_a', tenant_id: 't_1', org_id: 'org_a' }],
      },
      ctx,
      activeOrgSession(),
    )
    const res = await app.request(authorizeUrl(PKCE_PARAMS), {}, env)
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location') ?? '')
    expect(location.origin + location.pathname).toBe('https://rp.example/cb')
    expect(location.searchParams.get('error')).toBe('access_denied')
    expect(location.searchParams.get('error_description')).toBe(
      'project grant revoked or not found',
    )
    expect(location.searchParams.get('iss')).toBe('https://acme.xid.dev')
  })

  it('public client 缺 PKCE -> redirect error invalid_request 带 state', async () => {
    const { ctx } = await buildTestTenant()
    const { app, env } = setup({ applications: [appRow()] }, ctx, session())
    const { code_challenge: _c, code_challenge_method: _m, ...noPkce } = PKCE_PARAMS
    const res = await app.request(authorizeUrl(noPkce), {}, env)
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location') ?? '')
    expect(location.searchParams.get('error')).toBe('invalid_request')
    expect(location.searchParams.get('state')).toBe('st_abc')
    expect(location.searchParams.get('iss')).toBe('https://acme.xid.dev')
  })

  it('hybrid response_type -> fragment 回传 code/id_token/state/iss 且 id_token 含 nonce/c_hash', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const { app, env, capture } = setup(
      {
        applications: [
          appRow({ allowed_response_types: JSON.stringify(['code', 'code id_token']) }),
        ],
      },
      ctx,
      session(),
      kekB64,
    )
    const res = await app.request(
      authorizeUrl({
        ...PKCE_PARAMS,
        response_type: 'code id_token',
        nonce: 'n_hybrid',
      }),
      {},
      env,
    )
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location') ?? '')
    expect(location.origin + location.pathname).toBe('https://rp.example/cb')
    expect(location.search).toBe('')
    const fragment = new URLSearchParams(location.hash.slice(1))
    const code = fragment.get('code') ?? ''
    expect(code).toMatch(/^ac_/)
    expect(fragment.get('id_token')).toBeTruthy()
    expect(fragment.get('state')).toBe('st_abc')
    expect(fragment.get('iss')).toBe('https://acme.xid.dev')
    expect(capture.inserts.some((i) => i.table === 'authorization_codes')).toBe(true)
    const idPayload = await verifyIdPayload(ctx, fragment.get('id_token') ?? '')
    expect(idPayload['nonce']).toBe('n_hybrid')
    expect(idPayload['c_hash']).toBe(await leftHalfHash(code))
    expect(idPayload['at_hash']).toBeUndefined()
    expect(idPayload['sid']).toBe('s_1')
  })

  it('hybrid id_token TTL 与 access TTL 同源:client 覆盖优先,未覆盖走租户 token 策略', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const { app, env } = setup(
      {
        applications: [
          appRow({
            allowed_response_types: JSON.stringify(['code', 'code id_token']),
            access_token_ttl_sec: 120,
          }),
        ],
      },
      ctx,
      session(),
      kekB64,
    )
    const res = await app.request(
      authorizeUrl({ ...PKCE_PARAMS, response_type: 'code id_token', nonce: 'n_ttl' }),
      {},
      env,
    )
    expect(res.status).toBe(302)
    const fragment = new URLSearchParams(new URL(res.headers.get('location') ?? '').hash.slice(1))
    const idPayload = await verifyIdPayload(ctx, fragment.get('id_token') ?? '')
    expect((idPayload['exp'] as number) - (idPayload['iat'] as number)).toBe(120)

    const policyCtx: TenantContext = {
      ...ctx,
      policy: {
        token: {
          accessTokenTtlSec: 7200,
          sessionTokenTtlSec: 60,
          refreshIdleTimeoutDays: 30,
          refreshAbsoluteTimeoutDays: 7,
        },
      },
    }
    const { app: app2, env: env2 } = setup(
      {
        applications: [
          appRow({
            allowed_response_types: JSON.stringify(['code', 'code id_token']),
            access_token_ttl_sec: null,
          }),
        ],
      },
      policyCtx,
      session(),
      kekB64,
    )
    const res2 = await app2.request(
      authorizeUrl({ ...PKCE_PARAMS, response_type: 'code id_token', nonce: 'n_ttl' }),
      {},
      env2,
    )
    expect(res2.status).toBe(302)
    const fragment2 = new URLSearchParams(new URL(res2.headers.get('location') ?? '').hash.slice(1))
    const idPayload2 = await verifyIdPayload(policyCtx, fragment2.get('id_token') ?? '')
    expect((idPayload2['exp'] as number) - (idPayload2['iat'] as number)).toBe(7200)
  })
})
