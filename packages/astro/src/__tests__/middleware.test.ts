// createXidMiddleware 单元测试。
// 由于 @xid-kit/backend authenticateRequest 依赖 Web Crypto 验签,
// 这里 mock authenticateRequest 测试 middleware 的路由保护/locals 注入逻辑。

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock @xid-kit/backend authenticateRequest。
vi.mock('@xid-kit/backend', () => ({
  authenticateRequest: vi.fn(),
}))

import { authenticateRequest } from '@xid-kit/backend'
import type { JwtKey } from '@xid-kit/backend'
import { createXidMiddleware } from '../middleware'
import type { XidMiddlewareOptions } from '../types'

type MockedAuthReq = ReturnType<typeof vi.fn>

const MOCK_CLAIMS = {
  iss: 'https://test.xid.dev',
  sub: 'user_test',
  aud: 'client_test' as string | readonly string[],
  exp: 9999999999,
  iat: 1000000000,
  jti: 'jti_test',
  nbf: 1000000000,
  azp: 'client_test',
  scope: 'openid profile',
  client_id: 'client_test',
}

const SIGNED_IN_STATE = {
  isSignedIn: true,
  userId: 'user_test',
  sessionId: 'sess_test',
  claims: MOCK_CLAIMS,
}

const SIGNED_OUT_STATE = {
  isSignedIn: false,
  reason: 'no_token' as const,
}

// authenticateRequest 已被 mock,公钥不会真正用于验签;只需满足 JwtKey 结构。
const mockJwtKey: JwtKey = {
  kty: 'EC',
  crv: 'P-256',
  x: 'mock-x',
  y: 'mock-y',
  kid: 'kid_test',
  use: 'sig',
  alg: 'ES256',
}

const MIDDLEWARE_OPTIONS: XidMiddlewareOptions = {
  jwtKey: mockJwtKey,
  issuer: 'https://test.xid.dev',
}

function makeContext(pathname: string, token?: string) {
  const headers = new Headers()
  if (token) headers.set('authorization', `Bearer ${token}`)
  const request = new Request(`https://example.com${pathname}`, { headers })
  return {
    request,
    url: new URL(`https://example.com${pathname}`),
    locals: {} as Record<string, unknown>,
  }
}

const mockNext = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))

beforeEach(() => {
  vi.clearAllMocks()
  mockNext.mockResolvedValue(new Response('ok', { status: 200 }))
})

describe('createXidMiddleware - locals injection', () => {
  it('injects signed-in authResult to locals when authenticated', async () => {
    ;(authenticateRequest as MockedAuthReq).mockResolvedValue(SIGNED_IN_STATE)

    const handler = createXidMiddleware(MIDDLEWARE_OPTIONS)
    const ctx = makeContext('/dashboard')
    const response = await handler(ctx, mockNext)

    expect(response.status).toBe(200)
    const auth = ctx.locals['xidAuth'] as Record<string, unknown>
    expect(auth.userId).toBe('user_test')
    expect(auth.sessionId).toBe('sess_test')
    expect(auth.claims).toEqual(MOCK_CLAIMS)
  })

  it('injects unauthenticated authResult to locals when no token', async () => {
    ;(authenticateRequest as MockedAuthReq).mockResolvedValue(SIGNED_OUT_STATE)

    const handler = createXidMiddleware(MIDDLEWARE_OPTIONS)
    const ctx = makeContext('/public')
    await handler(ctx, mockNext)

    const auth = ctx.locals['xidAuth'] as Record<string, unknown>
    expect(auth.userId).toBeNull()
    expect(auth.sessionId).toBeNull()
    expect(auth.claims).toBeNull()
  })

  it('extracts org context from claims when present', async () => {
    const claimsWithOrg = {
      ...MOCK_CLAIMS,
      active_org_id: 'org_abc',
      org_role: 'admin',
      org_permissions: ['read', 'write'],
    }
    ;(authenticateRequest as MockedAuthReq).mockResolvedValue({
      isSignedIn: true,
      userId: 'user_test',
      sessionId: 'sess_test',
      claims: claimsWithOrg,
    })

    const handler = createXidMiddleware(MIDDLEWARE_OPTIONS)
    const ctx = makeContext('/org-page')
    await handler(ctx, mockNext)

    const auth = ctx.locals['xidAuth'] as Record<string, unknown>
    expect(auth.orgId).toBe('org_abc')
    expect(auth.orgRole).toBe('admin')
    expect(auth.orgPermissions).toEqual(['read', 'write'])
  })

  it('sets orgId/orgRole/orgPermissions to undefined when absent from claims', async () => {
    ;(authenticateRequest as MockedAuthReq).mockResolvedValue(SIGNED_IN_STATE)

    const handler = createXidMiddleware(MIDDLEWARE_OPTIONS)
    const ctx = makeContext('/dashboard')
    await handler(ctx, mockNext)

    const auth = ctx.locals['xidAuth'] as Record<string, unknown>
    expect(auth.orgId).toBeUndefined()
    expect(auth.orgRole).toBeUndefined()
    expect(auth.orgPermissions).toBeUndefined()
  })

  it('clears a Project custom role supplied as org_role', async () => {
    ;(authenticateRequest as MockedAuthReq).mockResolvedValue({
      isSignedIn: true,
      userId: 'user_test',
      sessionId: 'sess_test',
      claims: { ...MOCK_CLAIMS, active_org_id: 'org_abc', org_role: 'viewer' } as never,
    })

    const handler = createXidMiddleware(MIDDLEWARE_OPTIONS)
    const ctx = makeContext('/org-page')
    await handler(ctx, mockNext)

    const auth = ctx.locals['xidAuth'] as Record<string, unknown>
    expect(auth.userId).toBe('user_test')
    expect(auth.orgRole).toBeUndefined()
  })
})

describe('createXidMiddleware - route protection', () => {
  it('allows unauthenticated access to unprotected routes', async () => {
    ;(authenticateRequest as MockedAuthReq).mockResolvedValue(SIGNED_OUT_STATE)

    const handler = createXidMiddleware({
      ...MIDDLEWARE_OPTIONS,
      protectedRoutes: ['/dashboard'],
    })
    const ctx = makeContext('/public')
    const response = await handler(ctx, mockNext)

    expect(response.status).toBe(200)
    expect(mockNext).toHaveBeenCalledOnce()
  })

  it('redirects unauthenticated access to protected route', async () => {
    ;(authenticateRequest as MockedAuthReq).mockResolvedValue(SIGNED_OUT_STATE)

    const handler = createXidMiddleware({
      ...MIDDLEWARE_OPTIONS,
      protectedRoutes: ['/dashboard'],
      signInUrl: '/sign-in',
    })
    const ctx = makeContext('/dashboard/settings')
    const response = await handler(ctx, mockNext)

    expect(response.status).toBe(302)
    const location = response.headers.get('location') ?? ''
    expect(location).toContain('/sign-in')
    expect(location).toContain('redirect_url=')
    expect(mockNext).not.toHaveBeenCalled()
  })

  it('allows authenticated access to protected route', async () => {
    ;(authenticateRequest as MockedAuthReq).mockResolvedValue(SIGNED_IN_STATE)

    const handler = createXidMiddleware({
      ...MIDDLEWARE_OPTIONS,
      protectedRoutes: ['/dashboard'],
    })
    const ctx = makeContext('/dashboard')
    const response = await handler(ctx, mockNext)

    expect(response.status).toBe(200)
    expect(mockNext).toHaveBeenCalledOnce()
  })

  it('does not redirect public routes even if covered by protectedRoutes', async () => {
    ;(authenticateRequest as MockedAuthReq).mockResolvedValue(SIGNED_OUT_STATE)

    const handler = createXidMiddleware({
      ...MIDDLEWARE_OPTIONS,
      protectedRoutes: ['/dashboard'],
      publicRoutes: ['/dashboard/preview'],
    })
    const ctx = makeContext('/dashboard/preview')
    const response = await handler(ctx, mockNext)

    expect(response.status).toBe(200)
    expect(mockNext).toHaveBeenCalledOnce()
  })

  it('uses default /sign-in when signInUrl not specified', async () => {
    ;(authenticateRequest as MockedAuthReq).mockResolvedValue(SIGNED_OUT_STATE)

    const handler = createXidMiddleware({
      ...MIDDLEWARE_OPTIONS,
      protectedRoutes: ['/admin'],
    })
    const ctx = makeContext('/admin')
    const response = await handler(ctx, mockNext)

    expect(response.status).toBe(302)
    const location = response.headers.get('location') ?? ''
    expect(location).toContain('/sign-in')
  })
})

describe('createXidMiddleware - passes options to authenticateRequest', () => {
  it('passes verification and explicit JWT/exchange options to authenticateRequest', async () => {
    ;(authenticateRequest as MockedAuthReq).mockResolvedValue(SIGNED_OUT_STATE)

    const customKey: JwtKey = { ...mockJwtKey, kid: 'kid_custom' }
    const sessionTokenExchange = { endpoint: '/v1/sessions/token' }
    const opts: XidMiddlewareOptions = {
      jwtKey: customKey,
      issuer: 'https://custom.xid.dev',
      authorizedParties: ['app_abc'],
      jwtCookieName: '__Host-app.xid.jwt',
      sessionTokenExchange,
    }
    const handler = createXidMiddleware(opts)
    const ctx = makeContext('/')
    await handler(ctx, mockNext)

    expect(authenticateRequest).toHaveBeenCalledWith(
      ctx.request,
      expect.objectContaining({
        jwtKey: customKey,
        issuer: 'https://custom.xid.dev',
        authorizedParties: ['app_abc'],
        jwtCookieName: '__Host-app.xid.jwt',
        sessionTokenExchange,
      }),
    )
  })

  it('omits optional fields from authenticateRequest call when not provided', async () => {
    ;(authenticateRequest as MockedAuthReq).mockResolvedValue(SIGNED_OUT_STATE)

    const handler = createXidMiddleware({ jwtKey: mockJwtKey })
    const ctx = makeContext('/')
    await handler(ctx, mockNext)

    const callArgs = (authenticateRequest as MockedAuthReq).mock.calls[0]?.[1] as Record<
      string,
      unknown
    >
    expect(callArgs['jwtKey']).toBe(mockJwtKey)
    expect(Object.keys(callArgs)).not.toContain('issuer')
    expect(Object.keys(callArgs)).not.toContain('authorizedParties')
    expect(Object.keys(callArgs)).not.toContain('jwtCookieName')
    expect(Object.keys(callArgs)).not.toContain('sessionTokenExchange')
  })
})
