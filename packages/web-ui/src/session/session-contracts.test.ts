import { describe, expect, it } from 'vitest'
import { authStatusFromMe, pendingMfaCompletionPath, type MeResponse } from './contracts'

describe('authStatusFromMe', () => {
  const session = {
    id: 'sess_1',
    status: 'active',
    expiresAt: '2030-01-01T00:00:00.000Z',
    isImpersonation: false,
    userId: 'user_1',
    activeOrganizationId: null,
    lastActiveAt: '2029-01-01T00:00:00.000Z',
  } as const
  const me: MeResponse = {
    user: {
      id: 'user_1',
      email: 'owner@example.com',
      emailVerified: true,
      name: null,
      imageUrl: null,
      locale: null,
      hasMfa: false,
      instanceManager: true,
    },
    activeOrg: null,
    organizations: [],
    session,
    activeSessionId: 'sess_1',
    sessions: [session],
  }

  it('uses resolved /v1/me data for auth status', () => {
    expect(authStatusFromMe(undefined)).toBe('loading')
    expect(authStatusFromMe(null)).toBe('unauthenticated')
    expect(authStatusFromMe(me)).toBe('authenticated')
    expect(
      authStatusFromMe({
        user: null,
        activeOrg: null,
        organizations: [],
        session: null,
        activeSessionId: null,
        sessions: [],
      }),
    ).toBe('unauthenticated')
  })

  it('treats anonymous /v1/me shell as unauthenticated without touching user.id', () => {
    const anonymousShell: MeResponse = {
      user: null,
      activeOrg: null,
      organizations: [],
      session: null,
      activeSessionId: null,
      sessions: [],
    }

    expect(() => anonymousShell.user?.id).not.toThrow()
    expect(anonymousShell.user?.id).toBeUndefined()
    expect(authStatusFromMe(anonymousShell)).toBe('unauthenticated')
  })

  it.each(['pending_mfa', 'pending_mfa_setup'] as const)(
    'reports a %s session as pending instead of authenticated',
    (status) => {
      const pendingShell: MeResponse = {
        user: null,
        activeOrg: null,
        organizations: [],
        managerAssignments: [],
        session: { ...session, status },
        activeSessionId: null,
        sessions: [],
      }

      expect(authStatusFromMe(pendingShell)).toBe(status)
    },
  )
})

describe('pendingMfaCompletionPath', () => {
  it('sends pending_mfa to the challenge and pending_mfa_setup to enrollment', () => {
    const resume = '/authorize?authz_request_id=x&client_id=c'

    expect(pendingMfaCompletionPath('pending_mfa', resume)).toBe(
      `/mfa?redirect_to=${encodeURIComponent(resume)}`,
    )
    expect(pendingMfaCompletionPath('pending_mfa_setup', resume)).toBe(
      `/account/security?setup=mfa&redirect_to=${encodeURIComponent(resume)}`,
    )
  })
})
