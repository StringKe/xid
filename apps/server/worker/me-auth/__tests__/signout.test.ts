// POST /auth/sign-out 单测:有 session -> revoke + 2xx;无 session -> 幂等 2xx(前端不读 body)。

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@xid-kit/i18n', () => ({ renderScopeDescription: (s: string) => s }))

vi.mock('@xid-kit/db', () => ({
  createTenantDb: vi.fn(),
  schema: { sessions: { id: 'id' } },
}))

// readSession 在无 session 中间件注入时回落读 cookie;此处直接 mock lib/session。
vi.mock('../../lib/session', () => ({
  readSession: vi.fn(),
  revokeSession: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../sso/outbound-saml', () => ({
  initiateOutboundSamlLogout: vi.fn().mockResolvedValue(undefined),
}))

import { readSession, revokeSession } from '../../lib/session'
import { registerSessionAuthRoutes } from '../index'
import { execCtx, makeApp, makeEnv, makeSession } from './helpers'

function request(app: ReturnType<typeof makeApp>, env: Env) {
  return app.request('/auth/sign-out', { method: 'POST' }, env, execCtx)
}

describe('POST /auth/sign-out', () => {
  beforeEach(() => vi.clearAllMocks())

  it('有 session(中间件注入)-> revokeSession + 2xx', async () => {
    const session = makeSession()
    const app = makeApp(registerSessionAuthRoutes, { session })
    const res = await request(app, makeEnv())
    expect(res.status).toBe(200)
    expect(revokeSession).toHaveBeenCalledOnce()
  })

  it('无 session(cookie 也无)-> 幂等 2xx,不调 revoke', async () => {
    vi.mocked(readSession).mockResolvedValue(null)
    const app = makeApp(registerSessionAuthRoutes, { session: null })
    const res = await request(app, makeEnv())
    expect(res.status).toBe(200)
    expect(revokeSession).not.toHaveBeenCalled()
  })
})
