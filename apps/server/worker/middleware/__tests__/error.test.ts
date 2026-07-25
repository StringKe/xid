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

  it('生产环境未知错误同样打日志(有迹可循),AppError 不打', async () => {
    await buildApp().request('/unknown', {}, { ENVIRONMENT: 'production' } as Env)
    expect(console.error).toHaveBeenCalled()

    vi.mocked(console.error).mockClear()
    await buildApp().request('/app-error', {}, { ENVIRONMENT: 'production' } as Env)
    expect(console.error).not.toHaveBeenCalled()
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
