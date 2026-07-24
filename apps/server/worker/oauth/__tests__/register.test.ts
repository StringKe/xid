// /register 单元测试:RFC7591/7592 动态注册 / 读 / 更新 / 删除 + RAT 认证。
import { describe, it, expect, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { sha256Hex } from '@xid-kit/crypto'
import type { XidHonoEnv } from '../../lib/types'
import { registerDcr } from '../register'
import { makeFakeD1, makeAppRow, makeTenant, makeEnv, type AppRow } from './mock-helpers'
import { testErrorHandler } from './mock-helpers'
import type { RateLimitNsOptions } from './mock-helpers'

function makeApp(_env: Env): Hono<XidHonoEnv> {
  const app = new Hono<XidHonoEnv>()
  app.onError(testErrorHandler)
  app.use('*', async (c, next) => {
    c.set('tenant', makeTenant())
    await next()
  })
  registerDcr(app)
  return app
}

function makeEmptyApp(): { app: Hono<XidHonoEnv>; env: Env } {
  const db = makeFakeD1({ apps: [] })
  const env = makeEnv(db)
  return { app: makeApp(env), env }
}

async function postRegister(app: Hono<XidHonoEnv>, env: Env, body: unknown): Promise<Response> {
  return app.request(
    'http://test.idx.dev/register',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    env,
  )
}

describe('POST /register', () => {
  it('返回 201 + client_id + client_secret + registration_access_token', async () => {
    const { app, env } = makeEmptyApp()
    const res = await postRegister(app, env, {
      redirect_uris: ['https://example.com/cb'],
      grant_types: ['authorization_code', 'refresh_token'],
    })
    expect(res.status).toBe(201)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('pragma')).toBe('no-cache')
    const body = await res.json<Record<string, unknown>>()
    expect(typeof body['client_id']).toBe('string')
    expect(typeof body['client_secret']).toBe('string')
    expect(typeof body['registration_access_token']).toBe('string')
    expect(body['token_endpoint_auth_method']).toBe('client_secret_basic')
  })

  it('接受可兑现的 OIDC client metadata 并回显', async () => {
    const { app, env } = makeEmptyApp()
    const res = await postRegister(app, env, {
      redirect_uris: ['https://example.com/cb'],
      post_logout_redirect_uris: ['https://example.com/logout'],
      backchannel_logout_uri: 'https://example.com/backchannel-logout',
      id_token_signed_response_alg: 'ES256',
      subject_type: 'public',
    })
    expect(res.status).toBe(201)
    const body = await res.json<Record<string, unknown>>()
    expect(body['post_logout_redirect_uris']).toEqual(['https://example.com/logout'])
    expect(body['backchannel_logout_uri']).toBe('https://example.com/backchannel-logout')
    expect(body['backchannel_logout_session_required']).toBe(false)
    expect(body['id_token_signed_response_alg']).toBe('ES256')
    expect(body['subject_type']).toBe('public')
  })

  it('public client(none)不返回 client_secret', async () => {
    const { app, env } = makeEmptyApp()
    const res = await postRegister(app, env, {
      token_endpoint_auth_method: 'none',
      redirect_uris: ['https://example.com/cb'],
    })
    expect(res.status).toBe(201)
    const body = await res.json<Record<string, unknown>>()
    expect(body['client_secret']).toBeUndefined()
    expect(body['grant_types']).toEqual(['authorization_code'])
  })

  it('public client refresh_token 必须显式启用 DPoP sender constraint', async () => {
    const { app, env } = makeEmptyApp()
    const rejected = await postRegister(app, env, {
      token_endpoint_auth_method: 'none',
      redirect_uris: ['https://example.com/cb'],
      grant_types: ['authorization_code', 'refresh_token'],
    })
    expect(rejected.status).toBe(400)

    const accepted = await postRegister(app, env, {
      token_endpoint_auth_method: 'none',
      redirect_uris: ['https://example.com/cb'],
      grant_types: ['authorization_code', 'refresh_token'],
      dpop_bound_access_tokens: true,
    })
    expect(accepted.status).toBe(201)
    const body = await accepted.json<Record<string, unknown>>()
    expect(body['dpop_bound_access_tokens']).toBe(true)
    expect(body['grant_types']).toEqual(['authorization_code', 'refresh_token'])
  })

  it('非法 grant_type 返回 400', async () => {
    const { app, env } = makeEmptyApp()
    const res = await postRegister(app, env, { grant_types: ['implicit'], redirect_uris: [] })
    expect(res.status).toBe(400)
  })

  it('接受 hybrid response_type 并回显', async () => {
    const { app, env } = makeEmptyApp()
    const res = await postRegister(app, env, {
      response_types: ['code id_token'],
      redirect_uris: ['https://example.com/cb'],
    })
    expect(res.status).toBe(201)
    const body = await res.json<Record<string, unknown>>()
    expect(body['response_types']).toEqual(['code id_token'])
  })

  it('mTLS token_endpoint_auth_method requires subject DN', async () => {
    const { app, env } = makeEmptyApp()
    const missingDn = await postRegister(app, env, {
      token_endpoint_auth_method: 'tls_client_auth',
      redirect_uris: ['https://example.com/cb'],
    })
    expect(missingDn.status).toBe(400)
    const res = await postRegister(app, env, {
      token_endpoint_auth_method: 'tls_client_auth',
      tls_client_auth_subject_dn: 'CN=client.example.com',
      redirect_uris: ['https://example.com/cb'],
    })
    expect(res.status).toBe(201)
  })

  it('匿名注册超 IP 限流返回 429', async () => {
    const rlOpts: RateLimitNsOptions = { allowed: false }
    const env = makeEnv(makeFakeD1({ apps: [] }), undefined, undefined, rlOpts)
    const app = makeApp(env)
    const res = await postRegister(app, env, { redirect_uris: ['https://example.com/cb'] })
    expect(res.status).toBe(429)
  })

  it('拒绝未验证 initial access token', async () => {
    const rlOpts: RateLimitNsOptions = { allowed: false }
    const env = makeEnv(makeFakeD1({ apps: [] }), undefined, undefined, rlOpts)
    const app = makeApp(env)
    const res = await app.request(
      'http://test.idx.dev/register',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer iat_token',
        },
        body: JSON.stringify({ redirect_uris: ['https://example.com/cb'] }),
      },
      env,
    )
    expect(res.status).toBe(400)
    const body = await res.json<{ error: string }>()
    expect(body.error).toBe('invalid_request')
  })

  it('拒绝未验证 software_statement(invalid_software_statement)', async () => {
    const { app, env } = makeEmptyApp()
    const res = await postRegister(app, env, {
      redirect_uris: ['https://example.com/cb'],
      software_statement: 'unsigned',
    })
    expect(res.status).toBe(400)
    const body = await res.json<{ error: string }>()
    expect(body.error).toBe('invalid_software_statement')
  })

  it('拒绝无 token handler 的 assertion grant(invalid_client_metadata)', async () => {
    const { app, env } = makeEmptyApp()
    const res = await postRegister(app, env, {
      redirect_uris: ['https://example.com/cb'],
      grant_types: ['urn:ietf:params:oauth:grant-type:jwt-bearer'],
    })
    expect(res.status).toBe(400)
    const body = await res.json<{ error: string }>()
    expect(body.error).toBe('invalid_client_metadata')
  })

  it('拒绝不可兑现的 OIDC client metadata(invalid_client_metadata)', async () => {
    const { app, env } = makeEmptyApp()
    for (const body of [
      { redirect_uris: [], id_token_signed_response_alg: 'RS256' },
      { redirect_uris: [], subject_type: 'pairwise' },
      { redirect_uris: [], sector_identifier_uri: 'https://example.com/sector.json' },
      { redirect_uris: [], request_uris: ['https://example.com/request.jwt'] },
    ]) {
      const res = await postRegister(app, env, body)
      expect(res.status).toBe(400)
      const parsed = await res.json<{ error: string }>()
      expect(parsed.error).toBe('invalid_client_metadata')
    }
  })

  it('logout URI 非法返回 invalid_redirect_uri', async () => {
    const { app, env } = makeEmptyApp()
    for (const body of [
      {
        redirect_uris: ['https://example.com/cb'],
        frontchannel_logout_uri: 'http://example.com/front',
      },
      {
        redirect_uris: ['https://example.com/cb'],
        backchannel_logout_uri: 'http://example.com/back',
      },
      {
        redirect_uris: ['https://example.com/cb'],
        backchannel_logout_uri: 'https://example.com/back#fragment',
      },
    ]) {
      const res = await postRegister(app, env, body)
      expect(res.status).toBe(400)
      const parsed = await res.json<{ error: string }>()
      expect(parsed.error).toBe('invalid_redirect_uri')
    }
  })

  it('接受 backchannel_logout_session_required=true 并回显(logout_token 恒含 sid)', async () => {
    const { app, env } = makeEmptyApp()
    const res = await postRegister(app, env, {
      redirect_uris: ['https://example.com/cb'],
      backchannel_logout_uri: 'https://example.com/back',
      backchannel_logout_session_required: true,
    })
    expect(res.status).toBe(201)
    const body = await res.json<Record<string, unknown>>()
    expect(body['backchannel_logout_session_required']).toBe(true)
  })

  it('形状校验失败返回 invalid_request(RFC 错误形状 + 缓存头)', async () => {
    const { app, env } = makeEmptyApp()
    const res = await postRegister(app, env, { redirect_uris: 'not-an-array' })
    expect(res.status).toBe(400)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('pragma')).toBe('no-cache')
    const body = await res.json<{ error: string; error_description: string }>()
    expect(body.error).toBe('invalid_request')
    expect(body.error_description).toContain('redirect_uris')
  })

  it('access_token_ttl_sec 边界:59/86401/非整数 -> 400,60/86400 -> 201', async () => {
    const { app, env } = makeEmptyApp()
    for (const bad of [59, 86401, 60.5]) {
      const res = await postRegister(app, env, {
        redirect_uris: ['https://example.com/cb'],
        access_token_ttl_sec: bad,
      })
      expect(res.status).toBe(400)
      const parsed = await res.json<{ error: string }>()
      expect(parsed.error).toBe('invalid_client_metadata')
    }
    // 非 number 类型走形状层,RFC7591 允许 invalid_request。
    const shapeBad = await postRegister(app, env, {
      redirect_uris: ['https://example.com/cb'],
      access_token_ttl_sec: '3600',
    })
    expect(shapeBad.status).toBe(400)
    expect((await shapeBad.json<{ error: string }>()).error).toBe('invalid_request')
    for (const good of [60, 86400]) {
      const res = await postRegister(app, env, {
        redirect_uris: ['https://example.com/cb'],
        access_token_ttl_sec: good,
      })
      expect(res.status).toBe(201)
    }
  })

  it('未提供 access_token_ttl_sec 存 NULL(继承租户策略),提供则存覆盖值', async () => {
    const { app, env } = makeEmptyApp()

    const inherited = await postRegister(app, env, { redirect_uris: ['https://example.com/cb'] })
    expect(inherited.status).toBe(201)
    const inheritedBody = await inherited.json<Record<string, unknown>>()
    expect(inheritedBody['access_token_ttl_sec']).toBeNull()

    const override = await postRegister(app, env, {
      redirect_uris: ['https://example.com/cb'],
      access_token_ttl_sec: 120,
    })
    expect(override.status).toBe(201)
    const overrideBody = await override.json<Record<string, unknown>>()
    expect(overrideBody['access_token_ttl_sec']).toBe(120)
  })
})

describe('GET /register/:clientId', () => {
  let row: AppRow
  let rat: string

  beforeEach(async () => {
    rat = 'rat_test_value'
    row = makeAppRow({ registration_access_token_hash: await sha256Hex(rat) })
  })

  it('正确 RAT 返回 200 + client meta', async () => {
    const env = makeEnv(makeFakeD1({ apps: [row] }))
    const res = await makeApp(env).request(
      'http://test.idx.dev/register/client_abc',
      { headers: { authorization: `Bearer ${rat}` } },
      env,
    )
    expect(res.status).toBe(200)
    const body = await res.json<Record<string, unknown>>()
    expect(body['client_id']).toBe('client_abc')
    expect(body['post_logout_redirect_uris']).toEqual([])
    expect(body['backchannel_logout_uri']).toBeNull()
    expect(body['backchannel_logout_session_required']).toBe(false)
    expect(body['id_token_signed_response_alg']).toBe('ES256')
    expect(body['subject_type']).toBe('public')
  })

  it('错误 RAT 返回 401 invalid_client + WWW-Authenticate(RFC 错误形状)', async () => {
    const env = makeEnv(makeFakeD1({ apps: [row] }))
    const res = await makeApp(env).request(
      'http://test.idx.dev/register/client_abc',
      { headers: { authorization: 'Bearer wrong_rat' } },
      env,
    )
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe('Bearer realm="xid", error="invalid_client"')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('pragma')).toBe('no-cache')
    const body = await res.json<{ error: string }>()
    expect(body.error).toBe('invalid_client')
  })

  it('未知 client 返回 404', async () => {
    const env = makeEnv(makeFakeD1({ apps: [] }))
    const res = await makeApp(env).request(
      'http://test.idx.dev/register/nonexistent',
      { headers: { authorization: `Bearer ${rat}` } },
      env,
    )
    expect(res.status).toBe(404)
    const body = await res.json<{ error: string }>()
    expect(body.error).toBe('not_found')
  })
})

describe('PATCH /register/:clientId', () => {
  it('正确 RAT 可更新 OIDC logout metadata', async () => {
    const rat = 'rat_patch'
    const row = makeAppRow({ registration_access_token_hash: await sha256Hex(rat) })
    const env = makeEnv(makeFakeD1({ apps: [row] }))
    const res = await makeApp(env).request(
      'http://test.idx.dev/register/client_abc',
      {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${rat}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          post_logout_redirect_uris: ['https://example.com/logout'],
          backchannel_logout_uri: 'https://example.com/backchannel-logout',
          id_token_signed_response_alg: 'ES256',
        }),
      },
      env,
    )
    expect(res.status).toBe(200)
    const body = await res.json<Record<string, unknown>>()
    expect(body['id_token_signed_response_alg']).toBe('ES256')
    expect(body['backchannel_logout_uri']).toBe('https://example.com/backchannel-logout')
  })

  it('PATCH 接受 hybrid response_type 并回显', async () => {
    const rat = 'rat_patch'
    const row = makeAppRow({ registration_access_token_hash: await sha256Hex(rat) })
    const env = makeEnv(makeFakeD1({ apps: [row] }))
    const res = await makeApp(env).request(
      'http://test.idx.dev/register/client_abc',
      {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${rat}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ response_types: ['code id_token'] }),
      },
      env,
    )
    expect(res.status).toBe(200)
    const body = await res.json<Record<string, unknown>>()
    expect(body['response_types']).toEqual(['code id_token'])
  })

  it('PATCH 拒绝 public client 关闭 DPoP 后保留 refresh_token', async () => {
    const rat = 'rat_patch_public'
    const row = makeAppRow({
      client_type: 'public',
      token_endpoint_auth_method: 'none',
      client_secret_hash: null,
      dpop_bound_access_tokens: 1,
      registration_access_token_hash: await sha256Hex(rat),
    })
    const env = makeEnv(makeFakeD1({ apps: [row] }))
    const res = await makeApp(env).request(
      'http://test.idx.dev/register/client_abc',
      {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${rat}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ dpop_bound_access_tokens: false }),
      },
      env,
    )
    expect(res.status).toBe(400)
    const body = await res.json<{ error: string }>()
    expect(body.error).toBe('invalid_client_metadata')
  })

  it('PATCH access_token_ttl_sec 边界:59 -> 400,86400 -> 200', async () => {
    const rat = 'rat_patch_ttl'
    const row = makeAppRow({ registration_access_token_hash: await sha256Hex(rat) })
    const env = makeEnv(makeFakeD1({ apps: [row] }))
    const patch = (body: unknown) =>
      makeApp(env).request(
        'http://test.idx.dev/register/client_abc',
        {
          method: 'PATCH',
          headers: { authorization: `Bearer ${rat}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
        env,
      )
    const rejected = await patch({ access_token_ttl_sec: 59 })
    expect(rejected.status).toBe(400)
    expect((await rejected.json<{ error: string }>()).error).toBe('invalid_client_metadata')
    const rejectedHigh = await patch({ access_token_ttl_sec: 86401 })
    expect(rejectedHigh.status).toBe(400)
    const accepted = await patch({ access_token_ttl_sec: 86400 })
    expect(accepted.status).toBe(200)
    expect(accepted.headers.get('pragma')).toBe('no-cache')
  })

  it('PATCH access_token_ttl_sec 显式 null 清回继承,数字写覆盖', async () => {
    const rat = 'rat_patch_ttl_null'
    const row = makeAppRow({
      access_token_ttl_sec: 120,
      registration_access_token_hash: await sha256Hex(rat),
    })
    const env = makeEnv(makeFakeD1({ apps: [row] }))
    const patch = (body: unknown) =>
      makeApp(env).request(
        'http://test.idx.dev/register/client_abc',
        {
          method: 'PATCH',
          headers: { authorization: `Bearer ${rat}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
        env,
      )

    const cleared = await patch({ access_token_ttl_sec: null })
    expect(cleared.status).toBe(200)
    const clearedBody = await cleared.json<Record<string, unknown>>()
    expect(clearedBody['access_token_ttl_sec']).toBeNull()

    const override = await patch({ access_token_ttl_sec: 600 })
    expect(override.status).toBe(200)
    const overrideBody = await override.json<Record<string, unknown>>()
    expect(overrideBody['access_token_ttl_sec']).toBe(600)
  })
})

describe('DELETE /register/:clientId', () => {
  it('正确 RAT 软删除返回 204', async () => {
    const rat = 'rat_del'
    const updateCalls: string[] = []
    const row = makeAppRow({ registration_access_token_hash: await sha256Hex(rat) })
    const env = makeEnv(makeFakeD1({ apps: [row], onUpdate: (t) => updateCalls.push(t) }))
    const res = await makeApp(env).request(
      'http://test.idx.dev/register/client_abc',
      { method: 'DELETE', headers: { authorization: `Bearer ${rat}` } },
      env,
    )
    expect(res.status).toBe(204)
    expect(updateCalls).toContain('applications')
  })

  it('无 RAT 返回 401 invalid_client + WWW-Authenticate', async () => {
    const row = makeAppRow({ registration_access_token_hash: await sha256Hex('rat') })
    const env = makeEnv(makeFakeD1({ apps: [row] }))
    const res = await makeApp(env).request(
      'http://test.idx.dev/register/client_abc',
      { method: 'DELETE' },
      env,
    )
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe('Bearer realm="xid", error="invalid_client"')
    const body = await res.json<{ error: string }>()
    expect(body.error).toBe('invalid_client')
  })
})

describe('POST /register redirect_uris 注册校验', () => {
  it('http 明文 / fragment / 空串 -> 400 invalid_redirect_uri', async () => {
    const { app, env } = makeEmptyApp()
    for (const uris of [['http://app.example.com/cb'], ['https://app.example.com/cb#frag'], ['']]) {
      const res = await postRegister(app, env, { redirect_uris: uris })
      expect(res.status).toBe(400)
      const body = await res.json<{ error: string }>()
      expect(body.error).toBe('invalid_redirect_uri')
    }
  })

  it('authorization_code grant 不带 redirect_uris -> 400 invalid_redirect_uri', async () => {
    const { app, env } = makeEmptyApp()
    const res = await postRegister(app, env, { redirect_uris: [] })
    expect(res.status).toBe(400)
    const body = await res.json<{ error: string }>()
    expect(body.error).toBe('invalid_redirect_uri')
  })

  it('纯 client_credentials(M2M)允许空 redirect_uris', async () => {
    const { app, env } = makeEmptyApp()
    const res = await postRegister(app, env, {
      redirect_uris: [],
      grant_types: ['client_credentials'],
    })
    expect(res.status).toBe(201)
  })

  it('native client 放行 loopback http 与自定义 scheme,拒绝非 loopback http', async () => {
    const { app, env } = makeEmptyApp()
    const loopback = await postRegister(app, env, {
      application_type: 'native',
      token_endpoint_auth_method: 'none',
      redirect_uris: ['http://127.0.0.1:3000/cb'],
    })
    expect(loopback.status).toBe(201)

    const customScheme = await postRegister(app, env, {
      application_type: 'native',
      token_endpoint_auth_method: 'none',
      redirect_uris: ['com.example.app:/cb'],
    })
    expect(customScheme.status).toBe(201)

    const plainHttp = await postRegister(app, env, {
      application_type: 'native',
      token_endpoint_auth_method: 'none',
      redirect_uris: ['http://app.example.com/cb'],
    })
    expect(plainHttp.status).toBe(400)
  })

  it('非法 application_type -> 400 invalid_client_metadata', async () => {
    const { app, env } = makeEmptyApp()
    const res = await postRegister(app, env, {
      application_type: 'desktop',
      redirect_uris: ['https://example.com/cb'],
    })
    expect(res.status).toBe(400)
    const body = await res.json<{ error: string }>()
    expect(body.error).toBe('invalid_client_metadata')
  })

  it('backchannel_logout_uri 指内网 IP -> 400 invalid_redirect_uri(SSRF)', async () => {
    const { app, env } = makeEmptyApp()
    for (const uri of ['https://169.254.169.254/hook', 'https://192.168.1.1/hook']) {
      const res = await postRegister(app, env, {
        redirect_uris: ['https://example.com/cb'],
        backchannel_logout_uri: uri,
      })
      expect(res.status).toBe(400)
      const body = await res.json<{ error: string }>()
      expect(body.error).toBe('invalid_redirect_uri')
    }
  })
})

describe('POST /register scope catalog 收敛', () => {
  function makeResourceServerRow(scopes: string[]) {
    return {
      id: 'rs_1',
      tenant_id: 't_test',
      name: 'files',
      audience: 'https://api.example.com',
      scopes: JSON.stringify(scopes),
      access_token_format: 'jwt',
      signing_alg: 'ES256',
      created_at: Date.now(),
      updated_at: Date.now(),
    }
  }

  it('catalog 为空时自报未注册 scope -> 400 invalid_client_metadata', async () => {
    const { app, env } = makeEmptyApp()
    const res = await postRegister(app, env, {
      redirect_uris: ['https://example.com/cb'],
      scope: 'openid admin',
    })
    expect(res.status).toBe(400)
    const body = await res.json<{ error: string }>()
    expect(body.error).toBe('invalid_client_metadata')
  })

  it('标准 OIDC scope 六件直接放行', async () => {
    const { app, env } = makeEmptyApp()
    const res = await postRegister(app, env, {
      redirect_uris: ['https://example.com/cb'],
      scope: 'openid profile email address phone offline_access',
    })
    expect(res.status).toBe(201)
  })

  it('已注册 resource server 的 scope 放行并回显', async () => {
    const env = makeEnv(
      makeFakeD1({ apps: [], resourceServers: [makeResourceServerRow(['read:files'])] }),
    )
    const res = await postRegister(makeApp(env), env, {
      redirect_uris: ['https://example.com/cb'],
      scope: 'openid read:files',
    })
    expect(res.status).toBe(201)
    const body = await res.json<Record<string, unknown>>()
    expect(body['scope']).toBe('openid read:files')
  })
})

describe('PATCH /register/:clientId redirect_uris 与 scope 校验', () => {
  async function makePatchableApp() {
    const rat = 'rat_patch_validate'
    const row = makeAppRow({ registration_access_token_hash: await sha256Hex(rat) })
    const env = makeEnv(makeFakeD1({ apps: [row] }))
    const patch = (body: unknown) =>
      makeApp(env).request(
        'http://test.idx.dev/register/client_abc',
        {
          method: 'PATCH',
          headers: { authorization: `Bearer ${rat}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
        env,
      )
    return patch
  }

  it('PATCH http redirect_uri -> 400 invalid_redirect_uri', async () => {
    const patch = await makePatchableApp()
    const res = await patch({ redirect_uris: ['http://app.example.com/cb'] })
    expect(res.status).toBe(400)
    expect((await res.json<{ error: string }>()).error).toBe('invalid_redirect_uri')
  })

  it('PATCH 自报未注册 scope -> 400 invalid_client_metadata', async () => {
    const patch = await makePatchableApp()
    const res = await patch({ scope: 'openid admin' })
    expect(res.status).toBe(400)
    expect((await res.json<{ error: string }>()).error).toBe('invalid_client_metadata')
  })

  it('PATCH 合法 https redirect_uris 与标准 scope -> 200', async () => {
    const patch = await makePatchableApp()
    const res = await patch({
      redirect_uris: ['https://app.example.com/callback'],
      scope: 'openid profile',
    })
    expect(res.status).toBe(200)
  })
})
