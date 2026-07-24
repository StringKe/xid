// /device_authorization 单元测试:RFC8628 device code 生成 / scope 校验 / grant type 校验。
import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { sha256Hex } from '@xid-kit/crypto'
import type { XidHonoEnv } from '../../lib/types'
import { registerDevice } from '../device'
import { makeFakeD1, makeAppRow, makeTenant, makeEnv } from './mock-helpers'
import { testErrorHandler } from './mock-helpers'

function makeApp(_env: Env): Hono<XidHonoEnv> {
  const app = new Hono<XidHonoEnv>()
  app.onError(testErrorHandler)
  app.use('*', async (c, next) => {
    c.set('tenant', makeTenant())
    await next()
  })
  registerDevice(app)
  return app
}

async function postDevice(
  app: Hono<XidHonoEnv>,
  env: Env,
  params: Record<string, string>,
  authHeader?: string,
): Promise<Response> {
  const body = new URLSearchParams(params).toString()
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' }
  if (authHeader) headers.authorization = authHeader
  return app.request(
    'http://test.idx.dev/device_authorization',
    { method: 'POST', headers, body },
    env,
  )
}

describe('/device_authorization: success', () => {
  it('返回 device_code / user_code / verification_uri / expires_in / interval', async () => {
    const secret = 'dev_sec'
    const secretHash = await sha256Hex(secret)
    const row = makeAppRow({
      client_secret_hash: secretHash,
      allowed_grant_types: JSON.stringify([
        'authorization_code',
        'refresh_token',
        'urn:ietf:params:oauth:grant-type:device_code',
      ]),
    })

    let doCreateBody: unknown
    const deviceStub = {
      fetch: async (_url: string, init?: RequestInit) => {
        doCreateBody = JSON.parse(init?.body as string)
        return Response.json({ created: true }, { status: 200 })
      },
    }
    const deviceNs = {
      idFromName: (name: string) => name,
      get: () => deviceStub,
    } as unknown as DurableObjectNamespace

    const db = makeFakeD1({ apps: [row] })
    const env = makeEnv(db, undefined, deviceNs)
    const app = makeApp(env)
    const creds = btoa(`client_abc:${secret}`)
    const res = await postDevice(app, env, { scope: 'openid profile' }, `Basic ${creds}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('pragma')).toBe('no-cache')
    const body = await res.json<{
      device_code: string
      user_code: string
      verification_uri: string
      expires_in: number
      interval: number
    }>()
    expect(body.device_code.length).toBeGreaterThan(10)
    expect(body.user_code.length).toBe(8)
    expect(body.verification_uri).toContain('/activate')
    expect(body.expires_in).toBe(600)
    expect(body.interval).toBe(5)

    const created = doCreateBody as Record<string, unknown>
    expect(created['deviceCode']).toBe(body.device_code)
    expect(created['userCode']).toBe(body.user_code)
  })
})

describe('/device_authorization: errors', () => {
  it('不允许 device_code grant 返回 400 unauthorized_client', async () => {
    const secret = 'sec'
    const secretHash = await sha256Hex(secret)
    // 默认 allowed_grant_types 无 device_code。
    const row = makeAppRow({ client_secret_hash: secretHash })
    const db = makeFakeD1({ apps: [row] })
    const env = makeEnv(db)
    const app = makeApp(env)
    const creds = btoa(`client_abc:${secret}`)
    const res = await postDevice(app, env, { scope: 'openid' }, `Basic ${creds}`)
    expect(res.status).toBe(400)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('pragma')).toBe('no-cache')
    const body = await res.json<Record<string, unknown>>()
    expect(body['error']).toBe('unauthorized_client')
    expect(typeof body['error_description']).toBe('string')
  })

  it('scope 超出 allowedScopes 返回 400 invalid_scope', async () => {
    const secret = 'sec'
    const secretHash = await sha256Hex(secret)
    const row = makeAppRow({
      client_secret_hash: secretHash,
      allowed_grant_types: JSON.stringify(['urn:ietf:params:oauth:grant-type:device_code']),
      allowed_scopes: JSON.stringify(['openid']),
    })
    const db = makeFakeD1({ apps: [row] })
    const env = makeEnv(db)
    const app = makeApp(env)
    const creds = btoa(`client_abc:${secret}`)
    const res = await postDevice(app, env, { scope: 'openid admin' }, `Basic ${creds}`)
    expect(res.status).toBe(400)
    const body = await res.json<Record<string, unknown>>()
    expect(body['error']).toBe('invalid_scope')
  })

  it('client 认证失败 401 + WWW-Authenticate(RFC 错误形状)', async () => {
    const row = makeAppRow({ client_secret_hash: await sha256Hex('real') })
    const db = makeFakeD1({ apps: [row] })
    const env = makeEnv(db)
    const app = makeApp(env)
    const creds = btoa('client_abc:wrong')
    const res = await postDevice(app, env, {}, `Basic ${creds}`)
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe('Basic realm="xid", error="invalid_client"')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('pragma')).toBe('no-cache')
    const body = await res.json<Record<string, unknown>>()
    expect(body['error']).toBe('invalid_client')
  })

  it('DeviceFlowStore create 返回 500 时 fail closed', async () => {
    const secret = 'sec'
    const secretHash = await sha256Hex(secret)
    const row = makeAppRow({
      client_secret_hash: secretHash,
      allowed_grant_types: JSON.stringify(['urn:ietf:params:oauth:grant-type:device_code']),
    })
    const deviceNs = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async () => Response.json({ code: 'server_error' }, { status: 500 }),
      }),
    } as unknown as DurableObjectNamespace
    const db = makeFakeD1({ apps: [row] })
    const env = makeEnv(db, undefined, deviceNs)
    const app = makeApp(env)
    const creds = btoa(`client_abc:${secret}`)

    const res = await postDevice(app, env, { scope: 'openid' }, `Basic ${creds}`)

    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toMatchObject({ error: 'server_error' })
  })

  it('DeviceFlowStore create 返回 200 但未确认写入时 fail closed', async () => {
    const secret = 'sec'
    const secretHash = await sha256Hex(secret)
    const row = makeAppRow({
      client_secret_hash: secretHash,
      allowed_grant_types: JSON.stringify(['urn:ietf:params:oauth:grant-type:device_code']),
    })
    const deviceNs = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async () => Response.json({ created: false }),
      }),
    } as unknown as DurableObjectNamespace
    const db = makeFakeD1({ apps: [row] })
    const env = makeEnv(db, undefined, deviceNs)
    const app = makeApp(env)
    const creds = btoa(`client_abc:${secret}`)

    const res = await postDevice(app, env, { scope: 'openid' }, `Basic ${creds}`)

    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toMatchObject({ error: 'server_error' })
  })
})
