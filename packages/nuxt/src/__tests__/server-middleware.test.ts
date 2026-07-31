// createXidServerMiddleware 单元测试:
// - event.context.xidAuth 注入正确(已认证 / 未认证)
// - 受保护路由未认证时返回 401
// - 受保护路由已认证时不返回 401
// - getXidAuth 从 event.context 读取结果
// @xid-kit/backend 用 crypto key 生成真实 JWT 测试 networkless 验证路径。
import { describe, it, expect } from 'vitest'

import { exportPublicJwk, signJwt } from '@xid-kit/crypto'
import type { PublicJwk } from '@xid-kit/crypto'

import { createXidServerMiddleware, getXidAuth } from '../server-middleware'
import type { H3Event } from '../types'
import { XID_AUTH_CONTEXT_KEY } from '../types'

type TestKey = { kid: string; signingKey: CryptoKey; publicJwk: PublicJwk }

async function makeKey(kid: string): Promise<TestKey> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const publicJwk = await exportPublicJwk(pair.publicKey, kid, 'ES256')
  return { kid, signingKey: pair.privateKey, publicJwk }
}

async function mintToken(key: TestKey, sub = 'user_nuxt'): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000)
  return signJwt(
    {
      header: { alg: 'ES256', kid: key.kid, typ: 'at+jwt' },
      payload: {
        iss: 'https://acme.xid.dev',
        sub,
        aud: 'client_abc',
        azp: 'client_abc',
        sid: 'sess_nuxt',
        exp: nowSec + 3600,
        iat: nowSec - 5,
        nbf: nowSec - 5,
        jti: 'jti_nuxt',
        scope: 'openid',
        client_id: 'client_abc',
      },
    },
    key.signingKey,
  )
}

// 构造最小 H3Event mock。
function makeEvent(url: string, cookieHeader?: string, bearerToken?: string): H3Event {
  const rawHeaders: Record<string, string> = {}
  if (cookieHeader) rawHeaders['cookie'] = cookieHeader
  if (bearerToken) rawHeaders['authorization'] = `Bearer ${bearerToken}`

  const headers = new Headers(rawHeaders)

  return {
    context: {},
    node: {
      req: {
        headers: rawHeaders,
        url,
      },
    },
    headers,
    method: 'GET',
  }
}

describe('createXidServerMiddleware', () => {
  it('injects unauthenticated auth when no token present', async () => {
    const key = await makeKey('kid1')
    const mw = createXidServerMiddleware({ jwtKey: key.publicJwk })

    const event = makeEvent('https://app.com/api/data')
    await mw(event)

    expect(event.context[XID_AUTH_CONTEXT_KEY]).toBeDefined()
    const auth = event.context[XID_AUTH_CONTEXT_KEY]
    expect(auth).toMatchObject({ userId: null, sessionId: null })
  })

  it('injects authenticated auth when valid JWT is in an explicit app cookie', async () => {
    const key = await makeKey('kid2')
    const token = await mintToken(key)
    const mw = createXidServerMiddleware({
      jwtKey: key.publicJwk,
      jwtCookieName: '__Host-app.xid.jwt',
    })

    const event = makeEvent('https://app.com/api/data', `__Host-app.xid.jwt=${token}`)
    await mw(event)

    const auth = event.context[XID_AUTH_CONTEXT_KEY]
    expect(auth).toMatchObject({ userId: 'user_nuxt', sessionId: 'sess_nuxt' })
  })

  it('exchanges an opaque Core cookie at the configured same-origin endpoint', async () => {
    const key = await makeKey('kid_exchange')
    const token = await mintToken(key, 'user_exchange')
    let exchangeUrl = ''
    const mw = createXidServerMiddleware({
      jwtKey: key.publicJwk,
      sessionTokenExchange: {
        endpoint: '/v1/sessions/token',
        fetcher: (async (input) => {
          exchangeUrl = String(input)
          return Response.json({ token })
        }) as typeof fetch,
      },
    })

    const event = makeEvent('https://app.com/api/data', '__Host-xid.rt.sess_nuxt=opaque-refresh')
    await mw(event)

    const auth = event.context[XID_AUTH_CONTEXT_KEY]
    expect(auth).toMatchObject({ userId: 'user_exchange', sessionId: 'sess_nuxt' })
    expect(exchangeUrl).toBe('https://app.com/v1/sessions/token')
  })

  it('uses configured requestOrigin for relative H3 v1 Node URLs', async () => {
    const key = await makeKey('kid_relative_exchange')
    const token = await mintToken(key, 'user_relative_exchange')
    let exchangeUrl = ''
    const mw = createXidServerMiddleware({
      jwtKey: key.publicJwk,
      requestOrigin: 'https://app.example.com',
      sessionTokenExchange: {
        endpoint: '/v1/sessions/token',
        fetcher: (async (input) => {
          exchangeUrl = String(input)
          return Response.json({ token })
        }) as typeof fetch,
      },
    })

    const event = makeEvent('/api/data', '__Host-xid.rt.sess_nuxt=opaque-refresh')
    await mw(event)

    expect(exchangeUrl).toBe('https://app.example.com/v1/sessions/token')
    expect(event.context[XID_AUTH_CONTEXT_KEY]).toMatchObject({
      userId: 'user_relative_exchange',
    })
  })

  it('fails closed for relative H3 v1 exchange requests without a trusted origin', async () => {
    const key = await makeKey('kid_relative_reject')
    const fetcher = async () => Response.json({ token: 'must-not-run' })
    const mw = createXidServerMiddleware({
      jwtKey: key.publicJwk,
      sessionTokenExchange: {
        endpoint: '/v1/sessions/token',
        fetcher: fetcher as typeof fetch,
      },
    })

    const event = makeEvent('/api/data', '__Host-xid.rt.sess_nuxt=opaque-refresh')
    await expect(mw(event)).rejects.toThrow('requires requestOrigin')
  })

  it('rejects a requestOrigin containing a path', async () => {
    const key = await makeKey('kid_bad_origin')
    expect(() =>
      createXidServerMiddleware({
        jwtKey: key.publicJwk,
        requestOrigin: 'https://app.example.com/base',
      }),
    ).toThrow('requestOrigin must be an origin')
  })

  it('injects authenticated auth when valid JWT is in Authorization header', async () => {
    const key = await makeKey('kid3')
    const token = await mintToken(key, 'user_header')
    const mw = createXidServerMiddleware({ jwtKey: key.publicJwk })

    const event = makeEvent('https://app.com/api/data', undefined, token)
    await mw(event)

    const auth = event.context[XID_AUTH_CONTEXT_KEY]
    expect(auth).toMatchObject({ userId: 'user_header' })
  })

  it('returns 401 for unauthenticated access to a protected route', async () => {
    const key = await makeKey('kid4')
    const mw = createXidServerMiddleware({
      jwtKey: key.publicJwk,
      protectedRoutes: ['/api/admin'],
    })

    const event = makeEvent('https://app.com/api/admin/users')
    const result = await mw(event)

    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(401)
  })

  it('does not block authenticated access to a protected route', async () => {
    const key = await makeKey('kid5')
    const token = await mintToken(key)
    const mw = createXidServerMiddleware({
      jwtKey: key.publicJwk,
      jwtCookieName: '__Host-app.xid.jwt',
      protectedRoutes: ['/api/admin'],
    })

    const event = makeEvent('https://app.com/api/admin/users', `__Host-app.xid.jwt=${token}`)
    const result = await mw(event)

    // No 401 response returned; middleware passes through.
    expect(result).toBeUndefined()
  })

  it('uses custom onUnauthenticated callback when provided', async () => {
    const key = await makeKey('kid6')
    const mw = createXidServerMiddleware({
      jwtKey: key.publicJwk,
      protectedRoutes: ['/api/secret'],
      onUnauthenticated: () => ({ statusCode: 403, message: 'Forbidden' }),
    })

    const event = makeEvent('https://app.com/api/secret/data')
    const result = await mw(event)

    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(403)
    const body = await (result as Response).json()
    expect(body).toMatchObject({ error: 'Forbidden' })
  })
})

describe('getXidAuth', () => {
  it('returns UNAUTHENTICATED when context has no auth', () => {
    const event = makeEvent('https://app.com/')

    const auth = getXidAuth(event)

    expect(auth.userId).toBeNull()
  })

  it('returns injected auth from context', () => {
    const event = makeEvent('https://app.com/')
    event.context[XID_AUTH_CONTEXT_KEY] = {
      userId: 'user_ctx',
      sessionId: 'sess_ctx',
      orgId: undefined,
      orgRole: undefined,
      orgPermissions: undefined,
      claims: {} as never,
    }

    const auth = getXidAuth(event)

    expect(auth.userId).toBe('user_ctx')
  })
})
