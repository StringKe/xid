// management-auth 单元测试:Instance Manager 门控失败映射为 OAuth 错误响应。
import { Hono } from 'hono'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { AppError } from '../../lib/errors'
import type { XidHonoEnv } from '../../lib/types'
import { requireOidcManagementAuth } from '../management-auth'

const requireInstanceManager = vi.hoisted(() => vi.fn())

vi.mock('../../platform/shared', () => ({
  requireInstanceManager,
}))

function buildApp(): Hono<XidHonoEnv> {
  const app = new Hono<XidHonoEnv>()
  app.get('/mgmt', async (c) => {
    const denied = await requireOidcManagementAuth(c)
    if (denied) return denied
    return c.json({ ok: true })
  })
  return app
}

describe('requireOidcManagementAuth', () => {
  beforeEach(() => {
    requireInstanceManager.mockReset()
  })

  it('returns null and allows handler when instance manager check passes', async () => {
    requireInstanceManager.mockResolvedValue({ userId: 'admin_1' })
    const res = await buildApp().request('/mgmt')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('maps unauthorized AppError to OAuth 401 JSON', async () => {
    requireInstanceManager.mockRejectedValue(
      new AppError('unauthorized', { httpStatus: 401, longMessage: 'Sign in required' }),
    )
    const res = await buildApp().request('/mgmt')
    expect(res.status).toBe(401)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = (await res.json()) as { error: string; error_description: string }
    expect(body.error).toBe('unauthorized')
    expect(body.error_description).toBe('Sign in required')
  })

  it('maps forbidden AppError to OAuth 403 JSON', async () => {
    requireInstanceManager.mockRejectedValue(
      new AppError('forbidden', { httpStatus: 403, longMessage: 'Instance manager only' }),
    )
    const res = await buildApp().request('/mgmt')
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string; error_description: string }
    expect(body.error).toBe('forbidden')
    expect(body.error_description).toBe('Instance manager only')
  })

  it('surfaces unexpected errors as 500 when no onError handler', async () => {
    requireInstanceManager.mockRejectedValue(new TypeError('db unavailable'))
    const res = await buildApp().request('/mgmt')
    expect(res.status).toBe(500)
  })
})
