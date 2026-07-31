// POST /v1/sessions/active contract: validated current/legacy selector, credential-backed target
// lookup, and an HttpOnly active-session pointer. The session id alone never authenticates the switch.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/session', () => ({
  ACTIVE_SESSION_STATUS: 'active',
  PENDING_MFA_SESSION_STATUS: 'pending_mfa',
  PENDING_MFA_SETUP_SESSION_STATUS: 'pending_mfa_setup',
  readSession: vi.fn(),
  revokeSession: vi.fn(),
  selectSessionById: vi.fn(),
}))

import { selectSessionById } from '../../lib/session'
import { registerSessionAuthRoutes } from '../index'
import { execCtx, makeApp, makeEnv, makeSession } from './helpers'

const TARGET_SESSION_ID = 'sess_AbCdEfGhIjKlMnOpQrStu'
const LEGACY_SESSION_ID = '019f5cd4-e5f3-7b91-901a-33f6c7260525'

function post(body: unknown) {
  const app = makeApp(registerSessionAuthRoutes)
  return app.request(
    '/v1/sessions/active',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    makeEnv(),
    execCtx,
  )
}

describe('POST /v1/sessions/active', () => {
  beforeEach(() => vi.clearAllMocks())

  it('selects a browser-held active session and sets the server-owned pointer', async () => {
    vi.mocked(selectSessionById).mockResolvedValue(makeSession('user-2', TARGET_SESSION_ID))

    const res = await post({ sessionId: TARGET_SESSION_ID })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ activeSessionId: TARGET_SESSION_ID })
    expect(selectSessionById).toHaveBeenCalledWith(expect.anything(), TARGET_SESSION_ID)
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain(`__Host-xid.active=${TARGET_SESSION_ID}`)
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('Secure')
  })

  it('rejects malformed selectors before session lookup', async () => {
    const res = await post({ sessionId: 'not-a-uuid' })

    expect(res.status).toBe(422)
    expect(((await res.json()) as { meta?: { paramName?: string } }).meta?.paramName).toBe(
      'sessionId',
    )
    expect(selectSessionById).not.toHaveBeenCalled()
  })

  it('continues to accept a UUID selector for a session created before prefixed IDs', async () => {
    vi.mocked(selectSessionById).mockResolvedValue(makeSession('user-2', LEGACY_SESSION_ID))

    const res = await post({ sessionId: LEGACY_SESSION_ID })

    expect(res.status).toBe(200)
    expect(selectSessionById).toHaveBeenCalledWith(expect.anything(), LEGACY_SESSION_ID)
  })

  it('returns one opaque unauthorized response when the target cookie is missing or invalid', async () => {
    vi.mocked(selectSessionById).mockResolvedValue(null)

    const res = await post({ sessionId: TARGET_SESSION_ID })

    expect(res.status).toBe(401)
    expect(((await res.json()) as { code?: string }).code).toBe('unauthorized')
    expect(res.headers.get('set-cookie')).toBeNull()
  })
})
