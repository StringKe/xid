// xidMiddleware 安全/行为单元测试:
//  - 注入的 x-xid-auth 只透传到下游 request,绝不出现在发回浏览器的响应头(防泄露)。
//  - 修改后的 request headers 携带 x-xid-auth 供下游 RSC/route handler 读取(透传正确)。
//  - 受保护路由未认证 -> 302 重定向。
// next/server 是 peer dep(未安装),用 vi.mock 提供最小 NextResponse 实现。
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { exportPublicJwk, signJwt } from '@xid-kit/crypto'
import type { PublicJwk } from '@xid-kit/crypto'

// 记录 NextResponse.next() 收到的下游 request headers,供断言透传。
let lastNextRequestHeaders: Headers | undefined

vi.mock('next/server', () => {
  // 用普通对象模拟 NextResponse 静态接口,避免继承 Response 触发 static override 约束。
  const NextResponse = {
    // next():响应自身不携带 request headers(模拟真实 Next 行为:request headers 只对下游生效)。
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

// 动态 import 在 mock 之后,确保 middleware 取到 mock 的 next/server。
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

// 构造 NextRequest-like:用真实 Request 承载 headers,补 nextUrl/url/cookies/method。
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
    const mw = xidMiddleware({ jwtKey: key.publicJwk })

    const request = makeNextRequest('https://acme.xid.dev/dashboard', `__session=${token}`)
    const res = (await mw(request as never)) as Response

    // 响应头绝不含 x-xid-auth(防止完整 claims 泄露给浏览器)。
    expect(res.headers.get('x-xid-auth')).toBeNull()
    // 下游 request headers 携带注入的认证态,供 auth()/getAuth() 读取。
    expect(lastNextRequestHeaders).toBeDefined()
    expect(lastNextRequestHeaders?.get('x-xid-auth')).toBeTruthy()
  })

  it('strips a client-supplied x-xid-auth before injecting the trusted one', async () => {
    const key = await makeKey('kid_mw')
    const token = await mintToken(key)
    const mw = xidMiddleware({ jwtKey: key.publicJwk })

    const req = new Request('https://acme.xid.dev/dashboard', {
      headers: { cookie: `__session=${token}`, 'x-xid-auth': '{"userId":"forged"}' },
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
    // 注入的是 middleware 验证出的真实 user,不是客户端伪造的 forged。
    expect(injected).toContain('user_mw')
    expect(injected).not.toContain('forged')
  })
})

describe('xidMiddleware route protection', () => {
  it('redirects unauthenticated access to a protected route', async () => {
    const key = await makeKey('kid_mw')
    const mw = xidMiddleware({ jwtKey: key.publicJwk, protectedRoutes: ['/dashboard'] })

    // 无 cookie -> 未认证。
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
    const mw = xidMiddleware({ jwtKey: key.publicJwk, protectedRoutes: ['/dashboard'] })

    const request = makeNextRequest('https://acme.xid.dev/dashboard', `__session=${token}`)
    const res = (await mw(request as never)) as Response

    expect(res.status).toBe(200)
    expect(res.headers.get('location')).toBeNull()
  })
})
