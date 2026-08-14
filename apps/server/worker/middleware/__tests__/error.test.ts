// error 中间件单元测试:AppError/XidError/未知错误映射 + 不泄露内部细节。
import { Hono } from 'hono'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AppError } from '../../lib/errors'
import type { XidHonoEnv } from '../../lib/types'
import { errorHandler, throwXidError } from '../error'

vi.mock('@xid-kit/i18n', () => ({
  errorMessages: new Proxy({}, { get: (_target, code) => ({ id: String(code) }) }),
}))

function buildApp(): Hono<XidHonoEnv> {
  const app = new Hono<XidHonoEnv>()
  app.use('*', async (c, next) => {
    c.set('i18n', { _: (descriptor: { id: string }) => `localized:${descriptor.id}` } as never)
    await next()
  })
  app.onError(errorHandler)
  app.get('/app-error', () => {
    throw new AppError('forbidden', { longMessage: 'Not allowed', meta: { paramName: 'role' } })
  })
  app.get('/unknown', () => {
    throw new Error('internal SQL connection failed')
  })
  return app
}

describe('errorHandler', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('maps AppError to status, localized message, meta, and no-store cache', async () => {
    const res = await buildApp().request('/app-error', {}, { ENVIRONMENT: 'development' } as Env)
    expect(res.status).toBe(403)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = (await res.json()) as {
      code: string
      message: string
      longMessage?: string
      meta?: { paramName: string }
    }
    expect(body.code).toBe('forbidden')
    expect(body.message).toBe('localized:forbidden')
    expect(body.longMessage).toBe('Not allowed')
    expect(body.meta).toEqual({ paramName: 'role' })
  })

  it('maps structured XidError without leaking raw message field', async () => {
    const json = vi.fn((body: unknown, status: number, headers: Record<string, string>) => {
      return new Response(JSON.stringify(body), { status, headers })
    })
    const res = await errorHandler({ code: 'tenant_not_found', httpStatus: 404 }, {
      json,
      get: () => ({ _: (descriptor: { id: string }) => `localized:${descriptor.id}` }),
      env: { ENVIRONMENT: 'development' },
    } as never)
    expect(res.status).toBe(404)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = (await res.json()) as { code: string; message: string }
    expect(body.code).toBe('tenant_not_found')
    expect(body.message).toBe('localized:tenant_not_found')
  })

  it('maps unknown errors to server_error 500 without internal details', async () => {
    const res = await buildApp().request('/unknown', {}, { ENVIRONMENT: 'production' } as Env)
    expect(res.status).toBe(500)
    const body = (await res.json()) as { code: string; message: string }
    expect(body.code).toBe('server_error')
    expect(body.message).toBe('localized:server_error')
    expect(JSON.stringify(body)).not.toContain('SQL')
  })

  it('maps the migration-owned seat limit sentinel to a typed opaque business error', async () => {
    const res = await errorHandler(new Error('D1_ERROR: seat_limit_exceeded'), {
      get: () => ({ _: (descriptor: { id?: string }) => `localized:${descriptor.id}` }),
      json: (body: unknown, status: number, headers: HeadersInit) =>
        Response.json(body, { status, headers }),
    } as never)

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({
      code: 'seat_limit_exceeded',
      message: 'localized:seat_limit_exceeded',
    })
  })

  it('maps the migration-owned resource quota sentinel to a typed opaque business error', async () => {
    const res = await errorHandler(new Error('D1_ERROR: resource_quota_exceeded'), {
      get: () => ({ _: (descriptor: { id?: string }) => `localized:${descriptor.id}` }),
      json: (body: unknown, status: number, headers: HeadersInit) =>
        Response.json(body, { status, headers }),
    } as never)

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({
      code: 'resource_quota_exceeded',
      message: 'localized:resource_quota_exceeded',
    })
  })

  it('生产环境未知错误同样打日志(有迹可循),AppError 不打', async () => {
    await buildApp().request('/unknown', {}, { ENVIRONMENT: 'production' } as Env)
    expect(console.error).toHaveBeenCalled()

    vi.mocked(console.error).mockClear()
    await buildApp().request('/app-error', {}, { ENVIRONMENT: 'production' } as Env)
    expect(console.error).not.toHaveBeenCalled()
  })

  it('logs one-time-link rejection as low-cardinality metadata without credential material', async () => {
    const app = new Hono<XidHonoEnv>()
    app.use('*', async (c, next) => {
      c.set('i18n', { _: (descriptor: { id: string }) => `localized:${descriptor.id}` } as never)
      await next()
    })
    app.onError(errorHandler)
    app.post('/auth/magic-link/verify', () => {
      throw new AppError('magic_link_expired', { logReason: 'jwt_expired' })
    })

    const res = await app.request('/auth/magic-link/verify?token=raw-secret', { method: 'POST' })

    expect(res.status).toBe(400)
    expect(console.warn).toHaveBeenCalledWith({
      event: 'auth.one_time_link.rejected',
      severity: 'warning',
      component: 'auth',
      operation: 'magic_link',
      outcome: 'magic_link_expired',
      reason: 'jwt_expired',
      status: 400,
    })
    const logged = JSON.stringify(vi.mocked(console.warn).mock.calls)
    expect(logged).not.toContain('raw-secret')
    expect(logged).not.toContain('token=')
    expect(logged).not.toContain('https://')
  })

  it('drops an unsafe one-time-link log reason without leaking it', async () => {
    const app = new Hono<XidHonoEnv>()
    app.use('*', async (c, next) => {
      c.set('i18n', { _: (descriptor: { id: string }) => `localized:${descriptor.id}` } as never)
      await next()
    })
    app.onError(errorHandler)
    app.post('/auth/magic-link/verify', () => {
      throw new AppError('magic_link_invalid', { logReason: 'token=raw-secret' })
    })

    await app.request('/auth/magic-link/verify', { method: 'POST' })

    expect(console.warn).toHaveBeenCalledWith({
      event: 'auth.one_time_link.rejected',
      severity: 'warning',
      component: 'auth',
      operation: 'magic_link',
      outcome: 'magic_link_invalid',
      status: 400,
    })
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('raw-secret')
  })

  it('keeps an error response available when request i18n is absent', async () => {
    const json = vi.fn(
      (body: unknown, status: number) => new Response(JSON.stringify(body), { status }),
    )
    const res = await errorHandler(new Error('bootstrap DB failure'), {
      json,
      get: () => undefined,
      env: { ENVIRONMENT: 'production' },
    } as never)
    expect(res.status).toBe(500)
    expect((await res.json()) as { code: string; message: string }).toEqual({
      code: 'server_error',
      message: 'An unexpected server error occurred. Please try again.',
    })
  })
})

describe('throwXidError', () => {
  it('throws AppError preserving code, status, meta, and longMessage', () => {
    expect(() =>
      throwXidError({
        code: 'validation_failed',
        message: 'ignored',
        httpStatus: 422,
        longMessage: 'Email is invalid',
        meta: { paramName: 'email' },
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'validation_failed',
        httpStatus: 422,
        longMessage: 'Email is invalid',
        meta: { paramName: 'email' },
      }),
    )
  })
})
