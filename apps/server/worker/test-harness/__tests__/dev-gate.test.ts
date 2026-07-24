import { readFile } from 'node:fs/promises'
import { Hono } from 'hono'
import type { ErrorHandler } from 'hono'
import { describe, expect, it } from 'vitest'
import { isAppError } from '../../lib/errors'
import type { XidHonoEnv } from '../../lib/types'
import { buildTestTenant } from '../../oidc/__tests__/helpers'
import { registerTestHarnessRoutes } from '../index'

const testErrorHandler: ErrorHandler<XidHonoEnv> = (err, c) => {
  if (isAppError(err)) {
    return c.json({ code: err.code }, err.httpStatus as Parameters<typeof c.json>[1])
  }
  return c.json({ code: 'server_error' }, 500)
}

async function requestHarness(
  path: string,
  environment: string,
  init: RequestInit = { method: 'GET' },
): Promise<Response> {
  const { ctx } = await buildTestTenant()
  const app = new Hono<XidHonoEnv>()
  app.onError(testErrorHandler)
  app.use('*', async (c, next) => {
    c.set('tenant', ctx)
    await next()
  })
  registerTestHarnessRoutes(app)
  return app.request(path, init, {
    ENVIRONMENT: environment,
    CACHE: { get: async () => null, put: async () => undefined },
  } as Env)
}

describe('test harness production gate', () => {
  it('returns 404 for fake-idp routes in production', async () => {
    const res = await requestHarness('/test/fake-idp/saml/metadata', 'production')
    expect(res.status).toBe(404)
    const body = (await res.json()) as { code?: string }
    expect(body.code).toBe('not_found')
  })

  it('returns 404 for fake-social routes in production', async () => {
    const res = await requestHarness(
      '/test/fake-social/google/authorize?redirect_uri=http%3A%2F%2Flocalhost%2Fcb&state=st',
      'production',
    )
    expect(res.status).toBe(404)
    const body = (await res.json()) as { code?: string }
    expect(body.code).toBe('not_found')
  })

  it('returns 404 for test otp routes in production', async () => {
    const res = await requestHarness('/test/otp/latest?recipient=%2B15551234567', 'production')
    expect(res.status).toBe(404)
    const body = (await res.json()) as { code?: string }
    expect(body.code).toBe('not_found')
  })

  it('allows test otp routes in development when no capture exists', async () => {
    const res = await requestHarness('/test/otp/latest?recipient=%2B15551234567', 'development')
    expect(res.status).toBe(404)
    const body = (await res.json()) as { code?: string }
    expect(body.code).toBe('not_found')
  })

  it('returns 404 for fake-ldap routes in production', async () => {
    const res = await requestHarness('/test-harness/fake-ldap/bind', 'production', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'ldap.user@example.com', password: 'ldap-pass' }),
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { code?: string }
    expect(body.code).toBe('not_found')
  })

  it('returns 404 for fake-wsfed routes in production', async () => {
    const res = await requestHarness('/test-harness/fake-wsfed/login', 'production')
    expect(res.status).toBe(404)
    const body = (await res.json()) as { code?: string }
    expect(body.code).toBe('not_found')
  })

  it('returns 404 for fake-swa routes in production', async () => {
    const res = await requestHarness('/test-harness/fake-swa/authenticate', 'production', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'swa.user@example.com', password: 'swa-pass' }),
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { code?: string }
    expect(body.code).toBe('not_found')
  })

  it('registers test harness routes with tenant middleware but without session middleware', async () => {
    const source = await readFile(new URL('../../index.ts', import.meta.url), 'utf8')

    expect(source).toContain("app.use('/test/*', tenantMiddleware)")
    expect(source).toContain("app.use('/test-harness/*', tenantMiddleware)")
    expect(source).not.toContain("app.use('/test/*', sessionMiddleware)")
    expect(source).not.toContain("app.use('/test-harness/*', sessionMiddleware)")
  })
})
