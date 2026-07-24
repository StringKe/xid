// POST /v1/sessions/token 单测:cookie session 认证(非 sk_live)。
// happy -> { token };无 session -> 401。

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@xid-kit/i18n', () => ({ renderScopeDescription: (s: string) => s }))

vi.mock('@xid-kit/db', () => ({ createTenantDb: vi.fn(), schema: {} }))

vi.mock('@xid-kit/protocol', () => ({
  buildAccessTokenClaims: vi.fn().mockReturnValue({ sub: 'user-1', sid: 'sess-1' }),
  signAccessTokenClaims: vi.fn().mockResolvedValue('signed.jwt.token'),
}))

vi.mock('../../oidc/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../oidc/shared')>()
  return {
    ...actual,
    loadActiveSigner: vi.fn().mockResolvedValue({ kid: 'k1', alg: 'ES256', privateKey: {} }),
  }
})

vi.mock('../../lib/session', () => ({ readSession: vi.fn(), ACTIVE_SESSION_STATUS: 'active' }))

import { buildAccessTokenClaims } from '@xid-kit/protocol'
import { loadActiveSigner } from '../../oidc/shared'
import { readSession } from '../../lib/session'
import type { TenantVar } from '../../lib/types'
import { registerSessionAuthRoutes } from '../index'
import { execCtx, makeApp, makeEnv, makeSession, makeTenant } from './helpers'

function post(app: ReturnType<typeof makeApp>, env: Env) {
  return app.request('/v1/sessions/token', { method: 'POST' }, env, execCtx)
}

describe('POST /v1/sessions/token', () => {
  beforeEach(() => vi.clearAllMocks())

  it('有 session -> { token }(short-lived JWT)', async () => {
    const app = makeApp(registerSessionAuthRoutes, { session: makeSession() })
    const res = await post(app, makeEnv())
    expect(res.status).toBe(200)
    expect(((await res.json()) as { token: string }).token).toBe('signed.jwt.token')
    expect(loadActiveSigner).toHaveBeenCalledOnce()
  })

  it('claims:scope=openid + ttl=60s + sid=sessionId', async () => {
    const app = makeApp(registerSessionAuthRoutes, { session: makeSession('user-1', 'sess-42') })
    await post(app, makeEnv())
    expect(buildAccessTokenClaims).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'openid',
        ttlSec: 60,
        options: { sid: 'sess-42' },
      }),
    )
  })

  it('ttl 走租户 token 策略 sessionTokenTtlSec', async () => {
    const tenant = {
      ...makeTenant(),
      policy: {
        token: {
          accessTokenTtlSec: 3600,
          sessionTokenTtlSec: 90,
          refreshIdleTimeoutDays: 30,
          refreshAbsoluteTimeoutDays: 7,
        },
      },
    }
    const app = makeApp(registerSessionAuthRoutes, {
      session: makeSession(),
      tenant: tenant as unknown as TenantVar,
    })
    await post(app, makeEnv())
    expect(buildAccessTokenClaims).toHaveBeenCalledWith(expect.objectContaining({ ttlSec: 90 }))
  })

  it('无 session -> 401', async () => {
    vi.mocked(readSession).mockResolvedValue(null)
    const app = makeApp(registerSessionAuthRoutes, { session: null })
    const res = await post(app, makeEnv())
    expect(res.status).toBe(401)
  })

  it('pending_mfa session -> 401(待 MFA 会话不得签发 token)', async () => {
    vi.mocked(readSession).mockResolvedValue(null)
    const app = makeApp(registerSessionAuthRoutes, {
      session: { ...makeSession(), status: 'pending_mfa' },
    })
    const res = await post(app, makeEnv())
    expect(res.status).toBe(401)
    expect(loadActiveSigner).not.toHaveBeenCalled()
  })
})
