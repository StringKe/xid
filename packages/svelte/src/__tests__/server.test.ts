// server.test.ts:handleXid / getXidAuth 单元测试。
// authenticateRequest 通过 vi.mock 隔离(避免依赖真实 JWT/JWKS)。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getXidAuth } from '../server'

// getXidAuth 测试不依赖 @xid-kit/backend,直接测 locals 读取逻辑。
describe('getXidAuth', () => {
  it('returns unauthenticated when locals key absent', () => {
    const result = getXidAuth({})
    expect(result.userId).toBeNull()
    expect(result.sessionId).toBeNull()
    expect(result.claims).toBeNull()
  })

  it('returns the auth object from locals when present', () => {
    const auth = {
      userId: 'user_1',
      sessionId: 'sess_1',
      orgId: 'org_1',
      orgRole: 'admin',
      orgPermissions: ['org:member:read'],
      claims: null,
    }
    const locals = { xidAuth: auth }
    const result = getXidAuth(locals)
    expect(result.userId).toBe('user_1')
    expect(result.orgId).toBe('org_1')
  })

  it('uses custom localsKey when provided', () => {
    const auth = {
      userId: 'user_2',
      sessionId: null,
      orgId: null,
      orgRole: null,
      orgPermissions: null,
      claims: null,
    }
    const locals = { myAuth: auth }
    const result = getXidAuth(locals, 'myAuth')
    expect(result.userId).toBe('user_2')
  })

  it('returns unauthenticated when locals value is not an auth shape', () => {
    const result = getXidAuth({ xidAuth: 'invalid' })
    expect(result.userId).toBeNull()
  })

  it('returns unauthenticated for null value', () => {
    const result = getXidAuth({ xidAuth: null })
    expect(result.userId).toBeNull()
  })
})

// handleXid 测试:mock @xid-kit/backend。
describe('handleXid', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('injects authResult into event.locals and calls resolve', async () => {
    // Mock @xid-kit/backend before importing handleXid.
    vi.doMock('@xid-kit/backend', () => ({
      authenticateRequest: vi.fn().mockResolvedValue({
        isSignedIn: true,
        userId: 'user_1',
        sessionId: 'sess_1',
        claims: { active_org_id: 'org_1', org_role: 'admin', org_permissions: ['read'] },
      }),
    }))

    const { handleXid } = await import('../server')
    const handle = handleXid({ jwtKey: { n: 'stub' } })

    const event = {
      request: new Request('https://app.example.com/dashboard'),
      url: new URL('https://app.example.com/dashboard'),
      locals: {} as Record<string, unknown>,
    }
    const resolve = vi.fn().mockResolvedValue(new Response('OK'))

    await handle({ event, resolve })

    expect(resolve).toHaveBeenCalledOnce()
    const auth = event.locals['xidAuth']
    expect((auth as { userId: string }).userId).toBe('user_1')
    expect((auth as { orgId: string }).orgId).toBe('org_1')
  })

  it('clears a Project custom role supplied as org_role', async () => {
    vi.doMock('@xid-kit/backend', () => ({
      authenticateRequest: vi.fn().mockResolvedValue({
        isSignedIn: true,
        userId: 'user_1',
        sessionId: 'sess_1',
        claims: { active_org_id: 'org_1', org_role: 'viewer', org_permissions: ['read'] },
      }),
    }))

    const { handleXid } = await import('../server')
    const handle = handleXid({ jwtKey: { n: 'stub' } })
    const event = {
      request: new Request('https://app.example.com/dashboard'),
      url: new URL('https://app.example.com/dashboard'),
      locals: {} as Record<string, unknown>,
    }

    await handle({
      event,
      resolve: vi.fn().mockResolvedValue(new Response('OK')),
    })

    const auth = event.locals['xidAuth'] as { orgRole: unknown }
    expect(auth.orgRole).toBeNull()
  })

  it('redirects to signInUrl for protected routes when not signed in', async () => {
    vi.doMock('@xid-kit/backend', () => ({
      authenticateRequest: vi.fn().mockResolvedValue({ isSignedIn: false }),
    }))

    const { handleXid } = await import('../server')
    const handle = handleXid({
      jwtKey: {},
      protectedRoutes: ['/dashboard'],
      signInUrl: '/sign-in',
    })

    const event = {
      request: new Request('https://app.example.com/dashboard'),
      url: new URL('https://app.example.com/dashboard'),
      locals: {},
    }
    const resolve = vi.fn()

    const response = await handle({ event, resolve })

    expect(response.status).toBe(302)
    const location = response.headers.get('location') ?? ''
    expect(location).toContain('/sign-in')
    expect(resolve).not.toHaveBeenCalled()
  })

  it('does not redirect public routes even when not signed in', async () => {
    vi.doMock('@xid-kit/backend', () => ({
      authenticateRequest: vi.fn().mockResolvedValue({ isSignedIn: false }),
    }))

    const { handleXid } = await import('../server')
    const handle = handleXid({
      jwtKey: {},
      protectedRoutes: ['/dashboard'],
      publicRoutes: ['/dashboard/public'],
      signInUrl: '/sign-in',
    })

    const event = {
      request: new Request('https://app.example.com/dashboard/public'),
      url: new URL('https://app.example.com/dashboard/public'),
      locals: {},
    }
    const resolve = vi.fn().mockResolvedValue(new Response('OK'))

    const response = await handle({ event, resolve })

    expect(response.status).toBe(200)
    expect(resolve).toHaveBeenCalledOnce()
  })

  it('passes through unauthenticated state for non-protected routes', async () => {
    vi.doMock('@xid-kit/backend', () => ({
      authenticateRequest: vi.fn().mockResolvedValue({ isSignedIn: false }),
    }))

    const { handleXid } = await import('../server')
    const handle = handleXid({ jwtKey: {} })

    const event = {
      request: new Request('https://app.example.com/'),
      url: new URL('https://app.example.com/'),
      locals: {} as Record<string, unknown>,
    }
    const resolve = vi.fn().mockResolvedValue(new Response('OK'))

    await handle({ event, resolve })

    expect(resolve).toHaveBeenCalledOnce()
    const auth = event.locals['xidAuth']
    expect((auth as { userId: unknown }).userId).toBeNull()
  })
})
