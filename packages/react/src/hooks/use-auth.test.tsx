// useAuth.guest 暴露契约:isAnonymous 与 isGuestUser 同口径(provisionedBy === 'anonymous')。

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ReactNode } from 'react'
import type { XidClient, XidState, XidUser } from '@xid-kit/core'
import { XidContext } from '../context/xid-context'
import { useAuth } from './use-auth'

function makeUser(overrides: Partial<XidUser> = {}): XidUser {
  return {
    id: 'user_1',
    primaryEmailAddress: null,
    primaryPhoneNumber: null,
    emailVerified: false,
    firstName: null,
    lastName: null,
    fullName: null,
    username: null,
    imageUrl: null,
    hasImage: false,
    publicMetadata: {},
    organizationMemberships: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function makeState(user: XidUser | null): XidState {
  return {
    status: 'ready',
    isLoaded: true,
    isSignedIn: user !== null,
    session: null,
    user,
    organization: null,
    sessions: [],
    error: null,
  }
}

function probe(client: XidClient): { isAnonymous: boolean } {
  let seen: { isAnonymous: boolean } | null = null
  function Probe(): ReactNode {
    seen = { isAnonymous: useAuth().isAnonymous }
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

function makeClient(state: XidState): XidClient {
  return {
    getSnapshot: () => state,
    subscribe: () => () => {},
  } as unknown as XidClient
}

describe('useAuth isAnonymous', () => {
  it('is true for an anonymously provisioned user', () => {
    const result = probe(makeClient(makeState(makeUser({ provisionedBy: 'anonymous' }))))
    expect(result.isAnonymous).toBe(true)
  })

  it('is false for a regular user and when signed out', () => {
    expect(probe(makeClient(makeState(makeUser()))).isAnonymous).toBe(false)
    expect(probe(makeClient(makeState(null))).isAnonymous).toBe(false)
  })
})
