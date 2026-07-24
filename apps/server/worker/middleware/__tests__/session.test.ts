// session 中间件单元测试:解析 cookie session 并注入 context(无效时为 null)。
import { Hono } from 'hono'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { SessionData, XidHonoEnv } from '../../lib/types'
import { sessionMiddleware } from '../session'

const readSession = vi.hoisted(() => vi.fn())

vi.mock('../../lib/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/session')>()
  return { ...actual, readSession }
})

const SESSION: SessionData = {
  sessionId: 'sess_1',
  userId: 'user_1',
  status: 'active',
  activeOrgId: null,
  authenticatedAt: new Date(),
  lastActiveAt: new Date(),
  expiresAt: new Date(Date.now() + 86400000),
  rememberMe: false,
  isImpersonation: false,
  impersonatorUserId: null,
  acr: null,
  amr: null,
  aal: null,
}

function buildApp(): Hono<XidHonoEnv> {
  const app = new Hono<XidHonoEnv>()
  app.use('*', sessionMiddleware)
  app.get('/probe', (c) => c.json({ userId: c.get('session')?.userId ?? null }))
  return app
}

describe('sessionMiddleware', () => {
  beforeEach(() => {
    readSession.mockReset()
  })

  it('injects null session when cookie invalid or absent', async () => {
    readSession.mockResolvedValue(null)
    const res = await buildApp().request('https://test.xid.dev/probe')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ userId: null })
  })

  it('injects parsed session and continues request', async () => {
    readSession.mockResolvedValue(SESSION)
    const res = await buildApp().request('https://test.xid.dev/probe')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ userId: 'user_1' })
  })
})
