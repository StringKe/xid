import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type {
  SignInAnonymouslyResult,
  XidClient,
  XidSession,
  XidState,
  XidUser,
} from '@xid-kit/core'
import type { ReactNode } from 'react'

import { XidContext } from '../context/xid-context'
import { useSignIn, type UseSignInReturn } from './use-sign-in'

const SESSION: XidSession = {
  id: 'sess_guest',
  status: 'active',
  userId: 'user_guest',
  activeOrganizationId: null,
  lastActiveAt: 1,
  expireAt: 10_000,
  abandonAt: 10_000,
  createdAt: 1,
}

const USER: XidUser = {
  id: 'user_guest',
  primaryEmailAddress: null,
  primaryPhoneNumber: null,
  emailVerified: false,
  firstName: null,
  lastName: null,
  fullName: null,
  username: null,
  imageUrl: null,
  hasImage: false,
  provisionedBy: 'anonymous',
  publicMetadata: {},
  organizationMemberships: [],
  createdAt: 1,
  updatedAt: 1,
}

const STATE: XidState = {
  status: 'ready',
  isLoaded: true,
  isSignedIn: true,
  session: SESSION,
  user: USER,
  organization: null,
  sessions: [SESSION],
  error: null,
}

function probe(client: XidClient): UseSignInReturn {
  let seen: UseSignInReturn | null = null
  function Probe(): ReactNode {
    seen = useSignIn()
    return null
  }
  renderToStaticMarkup(
    <XidContext.Provider value={{ client, mode: 'same-origin' }}>
      <Probe />
    </XidContext.Provider>,
  )
  if (!seen) throw new Error('probe did not render')
  return seen
}

describe('useSignIn guest entry', () => {
  it('returns the Core server-owned guest onboarding directive', async () => {
    const guestResult: SignInAnonymouslyResult = {
      ...STATE,
      state: STATE,
      sessionId: 'sess_guest',
      redirectUrl: '/create-organization?source=worker',
      nextStep: 'redirect',
    }
    const signInAnonymously = vi.fn().mockResolvedValue({ ok: true, value: guestResult })
    const client = {
      getSnapshot: () => STATE,
      subscribe: () => () => {},
      signInPassword: vi.fn(),
      signInAnonymously,
    } as unknown as XidClient

    const result = await probe(client).signInAnonymously({ turnstileToken: 'ts_token' })

    expect(signInAnonymously).toHaveBeenCalledWith({ turnstileToken: 'ts_token' })
    expect(result).toEqual({ ok: true, value: guestResult })
  })
})
