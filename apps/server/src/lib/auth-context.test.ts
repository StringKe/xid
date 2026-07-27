import { describe, expect, it } from 'vitest'
import { authStatusFromMe, type MeResponse } from './auth-context'

describe('authStatusFromMe', () => {
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
    session: {
      id: 'sess_1',
      status: 'active',
      expiresAt: '2030-01-01T00:00:00.000Z',
      isImpersonation: false,
    },
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
      }),
    ).toBe('unauthenticated')
  })

  it('treats anonymous /v1/me shell as unauthenticated without touching user.id', () => {
    const anonymousShell: MeResponse = {
      user: null,
      activeOrg: null,
      organizations: [],
      session: null,
    }

    expect(() => anonymousShell.user?.id).not.toThrow()
    expect(anonymousShell.user?.id).toBeUndefined()
    expect(authStatusFromMe(anonymousShell)).toBe('unauthenticated')
  })
})
