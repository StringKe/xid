// xidMiddleware：x-xid-auth 只透传下游 request、不进响应头；受保护路由未认证 302。
// next/server 为 peer dep，vi.mock 提供最小 NextResponse。
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { exportPublicJwk, signJwt } from '@xid-kit/crypto'
import type { PublicJwk } from '@xid-kit/crypto'

// 捕获 next() 收到的下游 request headers，供透传断言。
let lastNextRequestHeaders: Headers | undefined

vi.mock('next/server', () => {
  // 普通对象模拟静态接口，避免继承 Response 触发 static override。
  const NextResponse = {
    // 响应体不带 request headers（对齐真实 Next：request 头只对下游生效）。
    next(init?: { request?: { headers?: Headers } }): Response {
      lastNextRequestHeaders = init?.request?.headers
      return new Response(null, { status: 200 })
    },
    redirect(url: string | URL, status?: number | { status?: number }): Response {
      const code = typeof status === 'number' ? status : (status?.status ?? 307)
      return new Response(null, { status: code, headers: { location: String(url) } })
    },
  }
  return { NextResponse }
})

// mock 之后再 import，确保取到 mock 的 next/server。
const { xidMiddleware } = await import('../middleware')

type TestKey = { kid: string; signingKey: CryptoKey; publicJwk: PublicJwk }

async function makeKey(kid: string): Promise<TestKey> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const publicJwk = await exportPublicJwk(pair.publicKey, kid, 'ES256')
  return { kid, signingKey: pair.privateKey, publicJwk }
}

async function mintToken(key: TestKey): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000)
  return signJwt(
    {
      header: { alg: 'ES256', kid: key.kid, typ: 'at+jwt' },
      payload: {
        iss: 'https://acme.xid.dev',
        sub: 'user_mw',
        aud: 'client_abc',
        azp: 'client_abc',
        sid: 'sess_mw',
        exp: nowSec + 3600,
        iat: nowSec - 5,
        nbf: nowSec - 5,
        jti: 'jti_mw',
        scope: 'openid',
        client_id: 'client_abc',
      },
    },
    key.signingKey,
  )
}

function makeNextRequest(url: string, cookieHeader?: string): Record<string, unknown> {
  const req = new Request(url, cookieHeader ? { headers: { cookie: cookieHeader } } : undefined)
  const nextUrl = new URL(url)
  return {
    nextUrl,
    url,
    headers: req.headers,
    method: 'GET',
    cookies: { get: () => undefined },
  }
}

beforeEach(() => {
  lastNextRequestHeaders = undefined
})

describe('xidMiddleware response does not leak x-xid-auth', () => {
  it('signed-in: response headers contain no x-xid-auth, downstream request headers do', async () => {
    const key = await makeKey('kid_mw')
    const token = await mintToken(key)
    const mw = xidMiddleware({
      jwtKey: key.publicJwk,
      jwtCookieName: '__Host-app.xid.jwt',
    })

    const request = makeNextRequest('https://acme.xid.dev/dashboard', `__Host-app.xid.jwt=${token}`)
    const res = (await mw(request as never)) as Response

    // 响应头不得含 x-xid-auth（防 claims 泄露浏览器）。
    expect(res.headers.get('x-xid-auth')).toBeNull()
    expect(lastNextRequestHeaders).toBeDefined()
    expect(lastNextRequestHeaders?.get('x-xid-auth')).toBeTruthy()
  })

  it('strips a client-supplied x-xid-auth before injecting the trusted one', async () => {
    const key = await makeKey('kid_mw')
    const token = await mintToken(key)
    const mw = xidMiddleware({
      jwtKey: key.publicJwk,
      jwtCookieName: '__Host-app.xid.jwt',
    })

    const req = new Request('https://acme.xid.dev/dashboard', {
      headers: {
        cookie: `__Host-app.xid.jwt=${token}`,
        'x-xid-auth': '{"userId":"forged"}',
      },
    })
    const nextReq = {
      nextUrl: new URL('https://acme.xid.dev/dashboard'),
      url: 'https://acme.xid.dev/dashboard',
      headers: req.headers,
      method: 'GET',
      cookies: { get: () => undefined },
    }
    await mw(nextReq as never)

    const injected = lastNextRequestHeaders?.get('x-xid-auth')
    expect(injected).toBeTruthy()
    // 必须是验签后的真实 user，不能保留客户端 forged。
    expect(injected).toContain('user_mw')
    expect(injected).not.toContain('forged')
  })

  it('exchanges the opaque Core cookie through the configured same-origin endpoint', async () => {
    const key = await makeKey('kid_exchange')
    const token = await mintToken(key)
    const fetcher = vi.fn(async () => Response.json({ token }))
    const mw = xidMiddleware({
      jwtKey: key.publicJwk,
      sessionTokenExchange: {
        endpoint: '/v1/sessions/token',
        fetcher: fetcher as typeof fetch,
      },
    })

    const request = makeNextRequest(
      'https://acme.xid.dev/dashboard',
      '__Host-xid.rt.sess_mw=opaque-refresh',
    )
    const res = (await mw(request as never)) as Response

    expect(res.status).toBe(200)
    expect(lastNextRequestHeaders?.get('x-xid-auth')).toContain('user_mw')
    expect(fetcher).toHaveBeenCalledOnce()
  })
})

describe('xidMiddleware route protection', () => {
  it('redirects unauthenticated access to a protected route', async () => {
    const key = await makeKey('kid_mw')
    const mw = xidMiddleware({ jwtKey: key.publicJwk, protectedRoutes: ['/dashboard'] })

    const request = makeNextRequest('https://acme.xid.dev/dashboard')
    const res = (await mw(request as never)) as Response

    expect(res.status).toBe(302)
    const location = res.headers.get('location')
    expect(location).toContain('/sign-in')
    expect(location).toContain('redirect_url=')
  })

  it('allows authenticated access to a protected route (no redirect)', async () => {
    const key = await makeKey('kid_mw')
    const token = await mintToken(key)
    const mw = xidMiddleware({
      jwtKey: key.publicJwk,
      jwtCookieName: '__Host-app.xid.jwt',
      protectedRoutes: ['/dashboard'],
    })

    const request = makeNextRequest('https://acme.xid.dev/dashboard', `__Host-app.xid.jwt=${token}`)
    const res = (await mw(request as never)) as Response

    expect(res.status).toBe(200)
    expect(res.headers.get('location')).toBeNull()
  })
})
