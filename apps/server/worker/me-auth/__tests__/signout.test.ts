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
  ACTIVE_SESSION_STATUS: 'active',
  PENDING_MFA_SESSION_STATUS: 'pending_mfa',
  PENDING_MFA_SETUP_SESSION_STATUS: 'pending_mfa_setup',
}))

vi.mock('../../sso/outbound-saml', () => ({
  initiateOutboundSamlLogout: vi.fn().mockResolvedValue(null),
}))

import { readSession, revokeSession } from '../../lib/session'
import { initiateOutboundSamlLogout } from '../../sso/outbound-saml'
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
    await expect(res.json()).resolves.toEqual({ ok: true, samlLogout: null })
    expect(revokeSession).toHaveBeenCalledOnce()
  })

  it('无 session(cookie 也无)-> 幂等 2xx,不调 revoke', async () => {
    vi.mocked(readSession).mockResolvedValue(null)
    const app = makeApp(registerSessionAuthRoutes, { session: null })
    const res = await request(app, makeEnv())
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true, samlLogout: null })
    expect(revokeSession).not.toHaveBeenCalled()
  })

  it('returns a browser SAML logout action only after revoking the local session', async () => {
    vi.mocked(initiateOutboundSamlLogout).mockResolvedValue({
      binding: 'redirect',
      url: 'https://saas.example.com/slo?SAMLRequest=value',
    })
    const session = makeSession()
    const app = makeApp(registerSessionAuthRoutes, { session })
    const res = await request(app, makeEnv())

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      ok: true,
      samlLogout: {
        binding: 'redirect',
        url: 'https://saas.example.com/slo?SAMLRequest=value',
      },
    })
    expect(initiateOutboundSamlLogout).toHaveBeenCalledOnce()
    expect(revokeSession).toHaveBeenCalledOnce()
    expect(vi.mocked(initiateOutboundSamlLogout).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(revokeSession).mock.invocationCallOrder[0]!,
    )
  })
})
