import { describe, expect, it } from 'vitest'
import { registerSessionAuthRoutes } from '../index'
import { makeApp, makeEnv, makeRateLimitNs, makeSession } from './helpers'
import {
  makeAppRow,
  makeFakeD1,
  makeTenant as makeOauthTenant,
} from '../../oauth/__tests__/mock-helpers'

type DeviceFlowRequest = {
  path: string
  body: Record<string, unknown>
}

function makeDeviceFlowNs(
  handler: (path: string, body: Record<string, unknown>) => Response | Promise<Response>,
): DurableObjectNamespace {
  const stub = {
    fetch: async (url: string, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {}
      return handler(new URL(url).pathname, body)
    },
  }
  return {
    idFromName: (name: string) => ({ toString: () => name }) as DurableObjectId,
    get: () => stub as unknown as DurableObjectStub,
  } as unknown as DurableObjectNamespace
}

function makeDeviceEnv(
  requests: DeviceFlowRequest[],
  handler?: (path: string, body: Record<string, unknown>) => Response,
): Env {
  const app = makeAppRow({
    client_secret_hash: null,
    allowed_grant_types: JSON.stringify(['urn:ietf:params:oauth:grant-type:device_code']),
    first_party: 1,
  })
  return {
    ...makeEnv({
      oauthStateNs: undefined,
    }),
    DB: makeFakeD1({ apps: [app] }),
    DEVICE_FLOW: makeDeviceFlowNs((path, body) => {
      requests.push({ path, body })
      if (handler) return handler(path, body)
      if (path === '/lookup') {
        return Response.json({
          userCode: 'ABCD1234',
          clientId: 'client_abc',
          scopes: ['openid', 'profile'],
          expiresAt: Date.now() + 300_000,
        })
      }
      return Response.json({ ok: true })
    }),
  } as unknown as Env
}

describe('/auth/device-activation', () => {
  it('GET 返回待授权 Device Flow 请求展示数据', async () => {
    const requests: DeviceFlowRequest[] = []
    const env = makeDeviceEnv(requests)
    const app = makeApp(registerSessionAuthRoutes, {
      tenant: makeOauthTenant(),
      session: makeSession('user-1'),
    })

    const res = await app.request('/auth/device-activation?user_code=ABCD1234', {}, env)

    expect(res.status).toBe(200)
    const body = await res.json<{
      userCode: string
      clientId: string
      scopes: string[]
      firstParty: boolean
    }>()
    expect(body.userCode).toBe('ABCD1234')
    expect(body.clientId).toBe('client_abc')
    expect(body.scopes).toEqual(['openid', 'profile'])
    expect(body.firstParty).toBe(true)
    expect(requests[0]).toEqual({ path: '/lookup', body: { userCode: 'ABCD1234' } })
  })

  it('GET 无 session 返回 401', async () => {
    const env = makeDeviceEnv([])
    const app = makeApp(registerSessionAuthRoutes, {
      tenant: makeOauthTenant(),
      session: null,
    })

    const res = await app.request('/auth/device-activation?user_code=ABCD1234', {}, env)

    expect(res.status).toBe(401)
  })

  it('POST approve 使用当前 session userId 调 DO authorize', async () => {
    const requests: DeviceFlowRequest[] = []
    const env = makeDeviceEnv(requests)
    const app = makeApp(registerSessionAuthRoutes, {
      tenant: makeOauthTenant(),
      session: makeSession('user-device'),
    })

    const res = await app.request(
      '/auth/device-activation',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userCode: 'ABCD1234', approved: true }),
      },
      env,
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ approved: true })
    expect(requests[0]).toEqual({
      path: '/authorize',
      body: { userCode: 'ABCD1234', userId: 'user-device' },
    })
  })

  it('POST deny 调 DO deny', async () => {
    const requests: DeviceFlowRequest[] = []
    const env = makeDeviceEnv(requests)
    const app = makeApp(registerSessionAuthRoutes, {
      tenant: makeOauthTenant(),
      session: makeSession('user-device'),
    })

    const res = await app.request(
      '/auth/device-activation',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userCode: 'ABCD1234', approved: false }),
      },
      env,
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ approved: false })
    expect(requests[0]).toEqual({ path: '/deny', body: { userCode: 'ABCD1234' } })
  })

  it('POST 转发 expired_token 错误', async () => {
    const env = makeDeviceEnv([], () =>
      Response.json(
        { error: 'expired_token', error_description: 'device_code has expired' },
        { status: 400 },
      ),
    )
    const app = makeApp(registerSessionAuthRoutes, {
      tenant: makeOauthTenant(),
      session: makeSession('user-device'),
    })

    const res = await app.request(
      '/auth/device-activation',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userCode: 'ABCD1234', approved: true }),
      },
      env,
    )

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 'expired_token' })
  })

  it('GET pending_mfa session 返回 401', async () => {
    const requests: DeviceFlowRequest[] = []
    const env = makeDeviceEnv(requests)
    const app = makeApp(registerSessionAuthRoutes, {
      tenant: makeOauthTenant(),
      session: { ...makeSession('user-1'), status: 'pending_mfa' },
    })

    const res = await app.request('/auth/device-activation?user_code=ABCD1234', {}, env)

    expect(res.status).toBe(401)
    expect(requests).toHaveLength(0)
  })

  it('POST pending_mfa session 返回 401', async () => {
    const requests: DeviceFlowRequest[] = []
    const env = makeDeviceEnv(requests)
    const app = makeApp(registerSessionAuthRoutes, {
      tenant: makeOauthTenant(),
      session: { ...makeSession('user-1'), status: 'pending_mfa' },
    })

    const res = await app.request(
      '/auth/device-activation',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userCode: 'ABCD1234', approved: true }),
      },
      env,
    )

    expect(res.status).toBe(401)
    expect(requests).toHaveLength(0)
  })

  it('user_code 查询超 per-user 限流阈值返回 rate_limited(暴破防护)', async () => {
    const requests: DeviceFlowRequest[] = []
    const env = {
      ...makeDeviceEnv(requests),
      RATE_LIMITER: makeRateLimitNs(false),
    } as unknown as Env
    const app = makeApp(registerSessionAuthRoutes, {
      tenant: makeOauthTenant(),
      session: makeSession('user-1'),
    })

    const res = await app.request('/auth/device-activation?user_code=ABCD1234', {}, env)

    expect(res.status).toBe(429)
    expect(await res.json()).toMatchObject({ code: 'rate_limited' })
    expect(requests).toHaveLength(0)
  })
})
