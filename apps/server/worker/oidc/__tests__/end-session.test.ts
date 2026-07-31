// /end_session 端点测试:有 id_token_hint(本 issuer 签发,aud=client)-> 校验后按
// post_logout_redirect_uri 精确匹配回跳(带 state);未注册的 redirect -> 不回跳返回 logged_out。

import { describe, it, expect, vi, afterEach } from 'vitest'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { signClaims } from '@xid-kit/protocol'
import { importJwkForVerify, loadSigningKey, sha256Hex, verifyJwt } from '@xid-kit/crypto'
import type { TenantContext } from '@xid-kit/types'
import { registerEndSessionRoutes } from '../end-session'
import { rtCookieName } from '../../lib/cookies'
import type { SessionData, XidHonoEnv } from '../../lib/types'
import {
  buildTestTenant,
  makeApp,
  makeEnv,
  makeFakeD1,
  makeFakeDoNs,
  type TableSet,
} from './helpers'

const CLIENT_ID = 'cli_app'
const POST_LOGOUT = 'https://rp.example/after-logout'
const BACKCHANNEL_LOGOUT = 'https://rp.example/backchannel-logout'
const LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout'

function decodeKek(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function mintIdToken(
  ctx: TenantContext,
  kekB64: string,
  aud: string | string[] = CLIENT_ID,
): Promise<string> {
  const material = ctx.signingKeys.keys[0]!
  const key = await loadSigningKey(material.encryptedPrivateKey, decodeKek(kekB64))
  const now = Math.floor(Date.now() / 1000)
  return signClaims(ctx, key, {
    iss: ctx.issuer,
    sub: 'u_1',
    aud,
    exp: now + 3600,
    iat: now,
    jti: 'jti_1',
    sid: 's_1',
  })
}

function appTables(
  input: {
    backchannelLogoutUri?: string | null
    postLogoutRedirectUris?: string[]
  } = {},
): TableSet {
  return {
    applications: [
      {
        id: 'app_1',
        tenant_id: 't_1',
        client_id: CLIENT_ID,
        client_secret_hash: null,
        client_type: 'public',
        token_endpoint_auth_method: 'none',
        jwks: null,
        redirect_uris: JSON.stringify(['https://rp.example/cb']),
        post_logout_redirect_uris: JSON.stringify(input.postLogoutRedirectUris ?? [POST_LOGOUT]),
        allowed_grant_types: JSON.stringify(['authorization_code']),
        allowed_response_types: JSON.stringify(['code']),
        allowed_scopes: JSON.stringify(['openid']),
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
        backchannel_logout_uri: input.backchannelLogoutUri ?? null,
        frontchannel_logout_uri: null,
        status: 'active',
        created_at: Date.now(),
        updated_at: Date.now(),
      },
    ],
  }
}

async function verifyLogoutPayload(
  ctx: TenantContext,
  token: string,
): Promise<{ header: Record<string, unknown>; payload: Record<string, unknown> }> {
  const jwk = ctx.signingKeys.keys[0]!
  const publicKey = await importJwkForVerify({
    ...jwk.publicKeyJwk,
    kid: jwk.kid,
    use: 'sig',
    alg: jwk.alg,
  })
  const verified = await verifyJwt(token, {
    keys: [{ kid: jwk.kid, alg: jwk.alg, publicKey }],
  })
  expect(verified.ok).toBe(true)
  if (!verified.ok) return { header: {}, payload: {} }
  return {
    header: verified.value.header as Record<string, unknown>,
    payload: verified.value.payload as Record<string, unknown>,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

function sessionNoop(): DurableObjectNamespace {
  return makeFakeDoNs(() => Response.json({ active: false }))
}

describe('/end_session', () => {
  it('id_token_hint 有效 + post_logout_redirect_uri 已注册 -> 302 回跳带 state', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const idToken = await mintIdToken(ctx, kekB64)
    const env = makeEnv({
      DB: makeFakeD1(appTables()),
      KEK: kekB64,
      SESSION_REVOCATION: sessionNoop(),
    })
    const app = makeApp(ctx, registerEndSessionRoutes)
    const url = `https://acme.xid.dev/end_session?${new URLSearchParams({
      id_token_hint: idToken,
      post_logout_redirect_uri: POST_LOGOUT,
      state: 'st_x',
    }).toString()}`
    const res = await app.request(url, {}, env)
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location') ?? '')
    expect(location.origin + location.pathname).toBe(POST_LOGOUT)
    expect(location.searchParams.get('state')).toBe('st_x')
  })

  it('post_logout_redirect_uri 未注册 -> 不回跳,返回 logged_out', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const idToken = await mintIdToken(ctx, kekB64)
    const env = makeEnv({
      DB: makeFakeD1(appTables()),
      KEK: kekB64,
      SESSION_REVOCATION: sessionNoop(),
    })
    const app = makeApp(ctx, registerEndSessionRoutes)
    const url = `https://acme.xid.dev/end_session?${new URLSearchParams({
      id_token_hint: idToken,
      post_logout_redirect_uri: 'https://evil.example/x',
    }).toString()}`
    const res = await app.request(url, {}, env)
    expect(res.status).toBe(200)
    expect(((await res.json()) as Record<string, boolean>)['logged_out']).toBe(true)
  })

  it('explicit client_id must match a string or array id_token_hint audience', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const mismatched = await mintIdToken(ctx, kekB64, 'different-client')
    const env = makeEnv({
      DB: makeFakeD1(appTables()),
      KEK: kekB64,
      SESSION_REVOCATION: sessionNoop(),
    })
    const app = makeApp(ctx, registerEndSessionRoutes)
    const rejected = await app.request(
      `https://acme.xid.dev/end_session?${new URLSearchParams({
        id_token_hint: mismatched,
        client_id: CLIENT_ID,
      }).toString()}`,
      {},
      env,
    )
    expect(rejected.status).toBe(400)

    const arrayAudience = await mintIdToken(ctx, kekB64, ['resource-api', CLIENT_ID])
    const accepted = await app.request(
      `https://acme.xid.dev/end_session?${new URLSearchParams({
        id_token_hint: arrayAudience,
        client_id: CLIENT_ID,
      }).toString()}`,
      {},
      env,
    )
    expect(accepted.status).toBe(200)
  })

  it('legacy unsafe registered post_logout_redirect_uri is refused at runtime', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const idToken = await mintIdToken(ctx, kekB64)
    const unsafe = 'https://user:pass@rp.example/after-logout'
    const env = makeEnv({
      DB: makeFakeD1(appTables({ postLogoutRedirectUris: [unsafe] })),
      KEK: kekB64,
      SESSION_REVOCATION: sessionNoop(),
    })
    const app = makeApp(ctx, registerEndSessionRoutes)
    const res = await app.request(
      `https://acme.xid.dev/end_session?${new URLSearchParams({
        id_token_hint: idToken,
        post_logout_redirect_uri: unsafe,
      }).toString()}`,
      {},
      env,
    )
    expect(res.status).toBe(200)
    expect((await res.json<Record<string, unknown>>())['logged_out']).toBe(true)
  })

  it('已注册 backchannel_logout_uri -> POST logout_token', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const idToken = await mintIdToken(ctx, kekB64)
    const calls: { url: string; init?: RequestInit }[] = []
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: url.toString(), init })
      return new Response(null, { status: 200 })
    })
    const env = makeEnv({
      DB: makeFakeD1(appTables({ backchannelLogoutUri: BACKCHANNEL_LOGOUT })),
      KEK: kekB64,
      SESSION_REVOCATION: sessionNoop(),
    })
    const app = makeApp(ctx, registerEndSessionRoutes)
    const url = `https://acme.xid.dev/end_session?${new URLSearchParams({
      id_token_hint: idToken,
      client_id: CLIENT_ID,
    }).toString()}`
    const res = await app.request(url, {}, env)
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(BACKCHANNEL_LOGOUT)
    expect(calls[0]?.init?.method).toBe('POST')
    expect(calls[0]?.init?.headers).toEqual({
      'content-type': 'application/x-www-form-urlencoded',
    })
    const body = new URLSearchParams(calls[0]?.init?.body?.toString())
    const logoutToken = body.get('logout_token')
    expect(typeof logoutToken).toBe('string')
    const verified = await verifyLogoutPayload(ctx, logoutToken ?? '')
    expect(verified.header['typ']).toBe('logout+jwt')
    expect(verified.payload['iss']).toBe('https://acme.xid.dev')
    expect(verified.payload['aud']).toBe(CLIENT_ID)
    expect(verified.payload['sub']).toBe('u_1')
    expect(verified.payload['sid']).toBe('s_1')
    expect(verified.payload['nonce']).toBeUndefined()
    expect(verified.payload['events']).toEqual({ [LOGOUT_EVENT]: {} })
  })

  it('id_token_hint 无效时不发送 back-channel logout', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const env = makeEnv({
      DB: makeFakeD1(appTables({ backchannelLogoutUri: BACKCHANNEL_LOGOUT })),
      KEK: kekB64,
      SESSION_REVOCATION: sessionNoop(),
    })
    const app = makeApp(ctx, registerEndSessionRoutes)
    const url = `https://acme.xid.dev/end_session?${new URLSearchParams({
      id_token_hint: 'not.a.jwt',
      client_id: CLIENT_ID,
    }).toString()}`
    const res = await app.request(url, {}, env)
    expect(res.status).toBe(200)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'timeout',
      response: () => Promise.reject(new DOMException('timed out', 'TimeoutError')),
    },
    {
      name: 'non-2xx',
      response: () => Promise.resolve(new Response(null, { status: 503 })),
    },
  ])('back-channel $name does not turn completed local logout into 500', async ({ response }) => {
    const { ctx, kekB64 } = await buildTestTenant()
    const idToken = await mintIdToken(ctx, kekB64)
    const auditSend = vi.fn(async () => undefined)
    vi.stubGlobal('fetch', vi.fn(response))
    const env = makeEnv({
      DB: makeFakeD1(appTables({ backchannelLogoutUri: BACKCHANNEL_LOGOUT })),
      KEK: kekB64,
      SESSION_REVOCATION: sessionNoop(),
      AUDIT_QUEUE: { send: auditSend } as unknown as Queue,
    })
    const app = makeApp(ctx, registerEndSessionRoutes)
    const res = await app.request(
      `https://acme.xid.dev/end_session?${new URLSearchParams({
        id_token_hint: idToken,
        client_id: CLIENT_ID,
      }).toString()}`,
      {},
      env,
    )
    expect(res.status).toBe(200)
    expect((await res.json<Record<string, unknown>>())['logged_out']).toBe(true)
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'oidc.backchannel_logout_failed' }),
    )
  })
})

// 无有效 id_token_hint:GET 直撤是 CSRF logout 面,必须先渲染确认页;POST confirm=true 才撤销。
describe('/end_session 无 id_token_hint 的确认门', () => {
  const SESSION_ID = 'sess_1'
  const RT_TOKEN = 'rt_token_1'

  async function makeSessionApp(): Promise<{
    app: Hono<XidHonoEnv>
    env: Env
    revokeCalls: string[]
    cookie: string
  }> {
    const { ctx, kekB64 } = await buildTestTenant()
    const revokeCalls: string[] = []
    const ns = makeFakeDoNs((path, body) => {
      if (path === '/revoke') {
        revokeCalls.push(String((body as { sessionId?: string }).sessionId))
        return Response.json({ ok: true })
      }
      return Response.json({ active: true })
    })
    const env = makeEnv({
      DB: makeFakeD1({
        users: [{ id: 'u_1', tenant_id: 't_1', status: 'active', deleted_at: null }],
      }),
      KEK: kekB64,
      SESSION_REVOCATION: ns,
    })
    const session: SessionData = {
      sessionId: SESSION_ID,
      userId: 'u_1',
      status: 'active',
      activeOrgId: null,
      authenticatedAt: new Date(),
      lastActiveAt: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000),
      rememberMe: false,
      isImpersonation: false,
      impersonatorUserId: null,
      acr: null,
      amr: null,
      aal: null,
    }
    const refreshTokenHash = await sha256Hex(RT_TOKEN)
    const app = new Hono<XidHonoEnv>()
    app.use('*', async (c: Context<XidHonoEnv>, next) => {
      c.set('tenant', ctx)
      c.set('session', null)
      c.set('sessionCandidate', { refreshTokenHash, session })
      await next()
    })
    registerEndSessionRoutes(app)
    return { app, env, revokeCalls, cookie: `${rtCookieName(SESSION_ID)}=${RT_TOKEN}` }
  }

  it('GET 无 hint -> 200 HTML 确认页且不撤销 session', async () => {
    const { app, env, revokeCalls, cookie } = await makeSessionApp()

    const res = await app.request('https://acme.xid.dev/end_session', { headers: { cookie } }, env)

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('name="confirm"')
    expect(revokeCalls).toEqual([])
  })

  it('POST 无 hint 且无 confirm -> 仍渲染确认页不撤销', async () => {
    const { app, env, revokeCalls, cookie } = await makeSessionApp()

    const res = await app.request(
      'https://acme.xid.dev/end_session',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
        body: new URLSearchParams({ client_id: CLIENT_ID }).toString(),
      },
      env,
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(revokeCalls).toEqual([])
  })

  it('POST confirm=true -> 撤销 session 返回 logged_out', async () => {
    const { app, env, revokeCalls, cookie } = await makeSessionApp()

    const res = await app.request(
      'https://acme.xid.dev/end_session',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
        body: new URLSearchParams({ confirm: 'true' }).toString(),
      },
      env,
    )

    expect(res.status).toBe(200)
    expect(((await res.json()) as Record<string, boolean>)['logged_out']).toBe(true)
    expect(revokeCalls).toEqual([SESSION_ID])
  })

  it('过期 id_token_hint 仍接受(allowExpired),未来 iat 拒绝', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const material = ctx.signingKeys.keys[0]!
    const key = await loadSigningKey(material.encryptedPrivateKey, decodeKek(kekB64))
    const now = Math.floor(Date.now() / 1000)
    const expired = await signClaims(ctx, key, {
      iss: ctx.issuer,
      sub: 'u_1',
      aud: CLIENT_ID,
      exp: now - 3600,
      iat: now - 7200,
      jti: 'jti_exp',
      sid: 's_1',
    })
    const futureIat = await signClaims(ctx, key, {
      iss: ctx.issuer,
      sub: 'u_1',
      aud: CLIENT_ID,
      exp: now + 7200,
      iat: now + 3600,
      jti: 'jti_future',
      sid: 's_1',
    })
    const env = makeEnv({
      DB: makeFakeD1(appTables()),
      KEK: kekB64,
      SESSION_REVOCATION: sessionNoop(),
    })
    const app = makeApp(ctx, registerEndSessionRoutes)

    // 过期 hint 有效 -> 直接执行登出流程(不回确认页)。
    const withExpired = await app.request(
      `https://acme.xid.dev/end_session?${new URLSearchParams({ id_token_hint: expired }).toString()}`,
      {},
      env,
    )
    expect(withExpired.status).toBe(200)
    expect(withExpired.headers.get('content-type')).not.toContain('text/html')

    // 未来 iat 的 hint 无效 -> 确认页。
    const withFuture = await app.request(
      `https://acme.xid.dev/end_session?${new URLSearchParams({ id_token_hint: futureIat }).toString()}`,
      {},
      env,
    )
    expect(withFuture.status).toBe(200)
    expect(withFuture.headers.get('content-type')).toContain('text/html')
  })
})
