// useProtectedRoute unit tests.
// Tests the redirect logic (the behavior inside useEffect) by mocking @xid-kit/react-native useAuth
// and using @testing-library/react renderHook so effects actually run.

import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { ReactNode } from 'react'

// Mock useAuth from @xid-kit/react-native so effects run with controlled auth state.
// Do NOT import XidContext internal path -- that is not a public API.
vi.mock('@xid-kit/react-native', async (importOriginal) => {
  const original = await importOriginal<typeof import('@xid-kit/react-native')>()
  return {
    ...original,
    useAuth: vi.fn(() => ({ isLoaded: true, isSignedIn: false })),
  }
})

import { useAuth } from '@xid-kit/react-native'
import { useProtectedRoute } from '../use-protected-route'

function wrapper({ children }: { children: ReactNode }): ReactNode {
  return children
}

describe('useProtectedRoute redirect logic', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not redirect when isLoaded is false', () => {
    vi.mocked(useAuth).mockReturnValue({
      isLoaded: false,
      isSignedIn: false,
      userId: null,
      sessionId: null,
      session: null,
      getToken: vi.fn(async () => null),
      signOut: vi.fn(async () => undefined),
      isAnonymous: false,
    })

    const replace = vi.fn()

    renderHook(
      () =>
        useProtectedRoute({
          signInRoute: '/sign-in',
          protectedRoute: '/(app)',
          pathname: '/dashboard',
          replace,
        }),
      { wrapper },
    )

    expect(replace).not.toHaveBeenCalled()
  })

  it('redirects to signInRoute when signed out and on a protected path', () => {
    vi.mocked(useAuth).mockReturnValue({
      isLoaded: true,
      isSignedIn: false,
      userId: null,
      sessionId: null,
      session: null,
      getToken: vi.fn(async () => null),
      signOut: vi.fn(async () => undefined),
      isAnonymous: false,
    })

    const replace = vi.fn()

    renderHook(
      () =>
        useProtectedRoute({
          signInRoute: '/sign-in',
          protectedRoute: '/(app)',
          pathname: '/dashboard',
          replace,
        }),
      { wrapper },
    )

    expect(replace).toHaveBeenCalledWith('/sign-in')
  })

  it('redirects to protectedRoute when signed in and on auth screen', () => {
    vi.mocked(useAuth).mockReturnValue({
      isLoaded: true,
      isSignedIn: true,
      userId: 'user_1',
      sessionId: 'sess_1',
      session: null,
      getToken: vi.fn(async () => 'at_test'),
      signOut: vi.fn(async () => undefined),
      isAnonymous: false,
    })

    const replace = vi.fn()

    renderHook(
      () =>
        useProtectedRoute({
          signInRoute: '/sign-in',
          protectedRoute: '/(app)',
          pathname: '/sign-in',
          replace,
        }),
      { wrapper },
    )

    expect(replace).toHaveBeenCalledWith('/(app)')
  })

  it('does not redirect when signed in on a non-auth path', () => {
    vi.mocked(useAuth).mockReturnValue({
      isLoaded: true,
      isSignedIn: true,
      userId: 'user_1',
      sessionId: 'sess_1',
      session: null,
      getToken: vi.fn(async () => 'at_test'),
      signOut: vi.fn(async () => undefined),
      isAnonymous: false,
    })

    const replace = vi.fn()

    renderHook(
      () =>
        useProtectedRoute({
          signInRoute: '/sign-in',
          protectedRoute: '/(app)',
          pathname: '/dashboard',
          replace,
        }),
      { wrapper },
    )

    expect(replace).not.toHaveBeenCalled()
  })

  it('does not redirect when signed out on the auth screen', () => {
    vi.mocked(useAuth).mockReturnValue({
      isLoaded: true,
      isSignedIn: false,
      userId: null,
      sessionId: null,
      session: null,
      getToken: vi.fn(async () => null),
      signOut: vi.fn(async () => undefined),
      isAnonymous: false,
    })

    const replace = vi.fn()

    renderHook(
      () =>
        useProtectedRoute({
          signInRoute: '/sign-in',
          protectedRoute: '/(app)',
          pathname: '/sign-in',
          replace,
        }),
      { wrapper },
    )

    expect(replace).not.toHaveBeenCalled()
  })
})
