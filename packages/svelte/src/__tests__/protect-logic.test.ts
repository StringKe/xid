import { describe, it, expect } from 'vitest'
import type { XidState } from '@xid-kit/core'
import { isAllowed } from '../protect-logic'

const BASE_STATE: XidState = {
  status: 'ready',
  isLoaded: true,
  isSignedIn: true,
  session: {
    id: 'sess_1',
    status: 'active',
    userId: 'user_1',
    activeOrganizationId: 'org_1',
    lastActiveAt: 1000,
    expireAt: 9999999,
    abandonAt: 9999999,
    createdAt: 1000,
  },
  user: {
    id: 'user_1',
    primaryEmailAddress: null,
    primaryPhoneNumber: null,
    emailVerified: true,
    firstName: null,
    lastName: null,
    fullName: null,
    username: null,
    imageUrl: null,
    hasImage: false,
    publicMetadata: {},
    organizationMemberships: [
      {
        id: 'mem_1',
        organization: {
          id: 'org_1',
          name: 'Acme',
          slug: 'acme',
          imageUrl: null,
          hasImage: false,
          membersCount: 1,
          publicMetadata: {},
          createdAt: 1000,
        },
        role: 'admin',
        permissions: ['org:member:read', 'org:member:write'],
        createdAt: 1000,
      },
    ],
    createdAt: 1000,
    updatedAt: 1000,
  },
  organization: {
    id: 'org_1',
    name: 'Acme',
    slug: 'acme',
    imageUrl: null,
    hasImage: false,
    membersCount: 1,
    publicMetadata: {},
    createdAt: 1000,
  },
  sessions: [],
  error: null,
}

describe('isAllowed', () => {
  it('returns false when not loaded', () => {
    const state: XidState = { ...BASE_STATE, isLoaded: false, isSignedIn: false }
    expect(isAllowed(state, {})).toBe(false)
  })

  it('returns false when not signed in', () => {
    const state: XidState = { ...BASE_STATE, isSignedIn: false, user: null, session: null }
    expect(isAllowed(state, {})).toBe(false)
  })

  it('returns true when signed in with no permission/role restriction', () => {
    expect(isAllowed(BASE_STATE, {})).toBe(true)
  })

  it('returns true when required role matches active membership', () => {
    expect(isAllowed(BASE_STATE, { role: 'admin' })).toBe(true)
  })

  it('returns false when required role does not match', () => {
    expect(isAllowed(BASE_STATE, { role: 'member' })).toBe(false)
  })

  it('returns true when required permission is in active membership', () => {
    expect(isAllowed(BASE_STATE, { permission: 'org:member:read' })).toBe(true)
  })

  it('returns false when required permission is not in active membership', () => {
    expect(isAllowed(BASE_STATE, { permission: 'org:billing:manage' })).toBe(false)
  })

  it('returns false when role matches but permission does not', () => {
    expect(isAllowed(BASE_STATE, { role: 'admin', permission: 'org:billing:manage' })).toBe(false)
  })

  it('returns true when both role and permission match', () => {
    expect(isAllowed(BASE_STATE, { role: 'admin', permission: 'org:member:write' })).toBe(true)
  })

  it('returns false when user has no org memberships', () => {
    const state: XidState = {
      ...BASE_STATE,
      user: BASE_STATE.user ? { ...BASE_STATE.user, organizationMemberships: [] } : null,
    }
    expect(isAllowed(state, { role: 'admin' })).toBe(false)
  })

  it('returns false when active org does not match any membership', () => {
    const state: XidState = {
      ...BASE_STATE,
      organization: BASE_STATE.organization
        ? { ...BASE_STATE.organization, id: 'org_other' }
        : null,
    }
    expect(isAllowed(state, { role: 'admin' })).toBe(false)
  })
})
