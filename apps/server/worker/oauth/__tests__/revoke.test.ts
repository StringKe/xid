// /revoke 单元测试:RFC7009 refresh token 撤销 family / access token 200 / 认证失败 401。
import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { loadSigningKey, sha256Hex } from '@xid-kit/crypto'
import { buildAccessTokenClaims, hashRefreshToken, signAccessTokenClaims } from '@xid-kit/protocol'
import type { TenantContext } from '@xid-kit/types'
import type { XidHonoEnv } from '../../lib/types'
import { registerRevoke } from '../revoke'
import { makeFakeD1, makeAppRow, makeRefreshRow, makeTenant, makeEnv } from './mock-helpers'
import { testErrorHandler } from './mock-helpers'
import { buildTestTenant } from '../../oidc/__tests__/helpers'

function decodeKek(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function mintAccessToken(ctx: TenantContext, kekB64: string): Promise<string> {
  const material = ctx.signingKeys.keys[0]!
  const key = await loadSigningKey(material.encryptedPrivateKey, decodeKek(kekB64))
  const claims = buildAccessTokenClaims({
    ctx,
    subject: { userId: 'u_1' },
    clientId: 'client_abc',
    scope: 'openid profile',
    audience: 'client_abc',
    now: Math.floor(Date.now() / 1000),
    ttlSec: 3600,
  })
  return signAccessTokenClaims(ctx, key, claims)
}

// denylist 读故障注入:mock-helpers 的 fake D1 只有 onInsert 钩子,读路径在此就近包一层。
function failDenylistSelect(db: D1Database): D1Database {
  const failing = {
    bind: () => failing,
    raw: async () => {
      throw new Error('D1 select failed')
    },
    all: async () => {
      throw new Error('D1 select failed')
    },
    run: async () => {
      throw new Error('D1 select failed')
    },
  }
  return {
    ...db,
    prepare: (sql: string) => {
      const lower = sql.toLowerCase()
      if (lower.includes('access_token_revocations') && lower.trimStart().startsWith('select')) {
        return failing as unknown as D1PreparedStatement
      }
      return db.prepare(sql)
    },
  } as D1Database
}

function makeApp(_env: Env, tenant: TenantContext = makeTenant()): Hono<XidHonoEnv> {
  const app = new Hono<XidHonoEnv>()
  app.onError(testErrorHandler)
  app.use('*', async (c, next) => {
    c.set('tenant', tenant)
    await next()
  })
  registerRevoke(app)
  return app
}

async function postRevoke(
  app: Hono<XidHonoEnv>,
  env: Env,
  params: Record<string, string>,
  authHeader?: string,
): Promise<Response> {
  const body = new URLSearchParams(params).toString()
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' }
  if (authHeader) headers.authorization = authHeader
  return app.request('http://test.idx.dev/revoke', { method: 'POST', headers, body }, env)
}

async function makeAuthedApp(
  secret: string,
): Promise<{ app: Hono<XidHonoEnv>; env: Env; creds: string }> {
  const secretHash = await sha256Hex(secret)
  const row = makeAppRow({ client_secret_hash: secretHash })
  const db = makeFakeD1({ apps: [row] })
  const env = makeEnv(db)
  const app = makeApp(env)
  return { app, env, creds: btoa(`client_abc:${secret}`) }
}

describe('/revoke: refresh token', () => {
  it('撤销 refresh token -> 整个 family 标 revokedAt', async () => {
    const rt = 'rt_test_token_value'
    const rtHash = await hashRefreshToken(rt)
    const updateCalls: string[] = []
    const secretHash = await sha256Hex('sec')
    const row = makeAppRow({ client_secret_hash: secretHash })
    const rtRow = makeRefreshRow({ token_hash: rtHash })
    const db = makeFakeD1({
      apps: [row],
      refreshTokens: [rtRow],
      onUpdate: (t) => updateCalls.push(t),
    })
    const env = makeEnv(db)
    const app = makeApp(env)
    const creds = btoa('client_abc:sec')
    const res = await postRevoke(
      app,
      env,
      { token: rt, token_type_hint: 'refresh_token' },
      `Basic ${creds}`,
    )
    expect(res.status).toBe(200)
    expect(updateCalls).toContain('refresh_tokens')
  })

  it('不存在的 token 也返回 200(RFC7009 2.2)', async () => {
    const { app, env, creds } = await makeAuthedApp('sec')
    const res = await postRevoke(app, env, { token: 'unknown_token' }, `Basic ${creds}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('pragma')).toBe('no-cache')
  })

  it('access token hint 返回 200 并写入 jti revoke denylist', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const token = await mintAccessToken(ctx, kekB64)
    const inserts: Record<string, unknown>[] = []
    const secretHash = await sha256Hex('sec')
    const row = makeAppRow({ tenant_id: ctx.tenantId, client_secret_hash: secretHash })
    const db = makeFakeD1({
      apps: [row],
      onInsert: (table, values) => {
        if (table === 'access_token_revocations') inserts.push(values)
      },
    })
    const env = makeEnv(db)
    const app = makeApp(env, ctx)
    const creds = btoa('client_abc:sec')

    const res = await postRevoke(
      app,
      env,
      { token, token_type_hint: 'access_token' },
      `Basic ${creds}`,
    )

    expect(res.status).toBe(200)
    expect(inserts).toHaveLength(1)
    expect(inserts[0]?.['tenant_id']).toBe(ctx.tenantId)
    expect(inserts[0]?.['client_id']).toBe('client_abc')
    expect(inserts[0]?.['jti']).toBeTypeOf('string')
  })

  it('denylist 写入失败返回 500 而不是静默 200', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const token = await mintAccessToken(ctx, kekB64)
    const secretHash = await sha256Hex('sec')
    const row = makeAppRow({ tenant_id: ctx.tenantId, client_secret_hash: secretHash })
    const db = makeFakeD1({
      apps: [row],
      onInsert: (table) => {
        if (table === 'access_token_revocations') throw new Error('D1 insert failed')
      },
    })
    const env = makeEnv(db)
    const app = makeApp(env, ctx)
    const creds = btoa('client_abc:sec')

    const res = await postRevoke(
      app,
      env,
      { token, token_type_hint: 'access_token' },
      `Basic ${creds}`,
    )

    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toMatchObject({ error: 'server_error' })
  })

  it('denylist 查询失败返回 500 而不是静默 200', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const token = await mintAccessToken(ctx, kekB64)
    const secretHash = await sha256Hex('sec')
    const row = makeAppRow({ tenant_id: ctx.tenantId, client_secret_hash: secretHash })
    const db = failDenylistSelect(makeFakeD1({ apps: [row] }))
    const env = makeEnv(db)
    const app = makeApp(env, ctx)
    const creds = btoa('client_abc:sec')

    const res = await postRevoke(
      app,
      env,
      { token, token_type_hint: 'access_token' },
      `Basic ${creds}`,
    )

    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toMatchObject({ error: 'server_error' })
  })
})

describe('/revoke: 认证失败', () => {
  it('无认证返回 401 + WWW-Authenticate(RFC 错误形状)', async () => {
    const { app, env } = await makeAuthedApp('sec')
    const res = await postRevoke(app, env, { token: 'some_token' })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe('Basic realm="xid", error="invalid_client"')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('pragma')).toBe('no-cache')
    const body = await res.json<Record<string, unknown>>()
    expect(body['error']).toBe('invalid_client')
    expect(typeof body['error_description']).toBe('string')
  })

  it('缺少 token 参数返回 400 invalid_request', async () => {
    const { app, env, creds } = await makeAuthedApp('sec')
    const res = await postRevoke(app, env, {}, `Basic ${creds}`)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: 'invalid_request',
      error_description: 'Missing or invalid parameter: token',
    })
  })
})
