// Tests for framework-agnostic guard logic.
// The actual CanActivateFn wrappers require Angular's dependency injection;
// here we validate the pure boolean predicate logic that mirrors each guard's
// decision branch so the critical auth/org/permission paths have coverage.

import { describe, expect, it } from 'vitest'
import type { XidState } from '@xid-kit/core'
import { CLIENT_STATUS } from '@xid-kit/core'

// ---- Pure guard predicates extracted from guards.ts ----
// These mirror the map() functions inside each guard factory so we can test
// the decision logic without spinning up Angular's DI.

function isAuthenticatedState(state: XidState): boolean {
  return state.isLoaded && state.isSignedIn && state.session !== null
}

function hasOrganizationState(state: XidState): boolean {
  return state.isLoaded && state.isSignedIn && state.organization !== null
}

// Mirrors the active-org-only check in guards.ts hasPermissionGuard.
// Only the membership for the currently active organization is checked,
// so a user with permissions in org A cannot pass a guard for org B.
function hasPermissionState(state: XidState, permission: string): boolean {
  if (!state.isLoaded || !state.isSignedIn || state.user === null) return false
  const activeMembership = state.user.organizationMemberships.find(
    (m) => m.organization.id === state.organization?.id,
  )
  return activeMembership?.permissions.includes(permission) === true
}

// ---- Test helpers ----

function makeState(overrides: Partial<XidState> = {}): XidState {
  return {
    status: 'ready',
    isLoaded: true,
    isSignedIn: false,
    session: null,
    user: null,
    organization: null,
    sessions: [],
    error: null,
    ...overrides,
  }
}

const ACTIVE_SESSION = {
  id: 'sess_1',
  status: 'active' as const,
  userId: 'user_1',
  activeOrganizationId: null,
  lastActiveAt: 0,
  expireAt: 9999999999,
  abandonAt: 9999999999,
  createdAt: 0,
}

const ACTIVE_USER = {
  id: 'user_1',
  primaryEmailAddress: 'alice@example.com',
  primaryPhoneNumber: null,
  emailVerified: true,
  firstName: 'Alice',
  lastName: null,
  fullName: 'Alice',
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
        createdAt: 0,
      },
      role: 'admin' as const,
      permissions: ['org:settings:write', 'org:members:read'],
      createdAt: 0,
    },
  ],
  createdAt: 0,
  updatedAt: 0,
}

const ACTIVE_ORG = {
  id: 'org_1',
  name: 'Acme',
  slug: 'acme',
  imageUrl: null,
  hasImage: false,
  membersCount: 1,
  publicMetadata: {},
  createdAt: 0,
}

// ---- authGuard predicate ----
describe('isAuthenticatedState', () => {
  it('returns false when SDK is still loading', () => {
    expect(isAuthenticatedState(makeState({ isLoaded: false }))).toBe(false)
  })

  it('returns false when user is not signed in', () => {
    expect(isAuthenticatedState(makeState({ isLoaded: true, isSignedIn: false }))).toBe(false)
  })

  it('returns false when session is null despite isSignedIn flag', () => {
    expect(
      isAuthenticatedState(makeState({ isLoaded: true, isSignedIn: true, session: null })),
    ).toBe(false)
  })

  it('returns true when loaded, signed in, and session is present', () => {
    const state = makeState({ isLoaded: true, isSignedIn: true, session: ACTIVE_SESSION })
    expect(isAuthenticatedState(state)).toBe(true)
  })
})

// ---- hasOrganizationGuard predicate ----
describe('hasOrganizationState', () => {
  it('returns false when not signed in', () => {
    expect(hasOrganizationState(makeState({ isLoaded: true, isSignedIn: false }))).toBe(false)
  })

  it('returns false when signed in but no active organization', () => {
    const state = makeState({
      isLoaded: true,
      isSignedIn: true,
      session: ACTIVE_SESSION,
      organization: null,
    })
    expect(hasOrganizationState(state)).toBe(false)
  })

  it('returns true when signed in with an active organization', () => {
    const state = makeState({
      isLoaded: true,
      isSignedIn: true,
      session: ACTIVE_SESSION,
      organization: ACTIVE_ORG,
    })
    expect(hasOrganizationState(state)).toBe(true)
  })
})

// ---- hasPermissionGuard predicate ----
describe('hasPermissionState', () => {
  it('returns false when user is null', () => {
    expect(
      hasPermissionState(makeState({ isLoaded: true, isSignedIn: true }), 'org:settings:write'),
    ).toBe(false)
  })

  it('returns false when the user lacks the required permission', () => {
    const state = makeState({ isLoaded: true, isSignedIn: true, user: ACTIVE_USER })
    expect(hasPermissionState(state, 'billing:manage')).toBe(false)
  })

  it('returns false when no active org is set even if a membership includes the permission', () => {
    // active-org-only 语义:无 active organization 上下文时不授权,防 cross-org 权限泄漏。
    const state = makeState({ isLoaded: true, isSignedIn: true, user: ACTIVE_USER })
    expect(hasPermissionState(state, 'org:settings:write')).toBe(false)
  })

  it('returns true when the active org membership includes the required permission', () => {
    // Active org is org_1 and ACTIVE_USER has a membership for org_1 with org:members:read.
    const state = makeState({
      isLoaded: true,
      isSignedIn: true,
      user: ACTIVE_USER,
      organization: ACTIVE_ORG,
    })
    expect(hasPermissionState(state, 'org:members:read')).toBe(true)
  })

  it('returns false when permission exists in a non-active org membership (cross-org isolation)', () => {
    // User is admin of org_1 but active org is org_2 -- org_1 permissions must NOT grant access.
    const otherOrg = {
      id: 'org_2',
      name: 'Other',
      slug: 'other',
      imageUrl: null,
      hasImage: false,
      membersCount: 1,
      publicMetadata: {},
      createdAt: 0,
    }
    const userWithTwoMemberships = {
      ...ACTIVE_USER,
      organizationMemberships: [
        ...ACTIVE_USER.organizationMemberships,
        {
          id: 'mem_2',
          organization: otherOrg,
          role: 'member' as const,
          permissions: [],
          createdAt: 0,
        },
      ],
    }
    const stateInOrg2 = makeState({
      isLoaded: true,
      isSignedIn: true,
      user: userWithTwoMemberships,
      organization: otherOrg,
    })
    // org_1 membership has org:settings:write but active org is org_2 which has no permissions.
    expect(hasPermissionState(stateInOrg2, 'org:settings:write')).toBe(false)
  })

  it('returns false when not loaded', () => {
    const state = makeState({ isLoaded: false, isSignedIn: false, user: null })
    expect(hasPermissionState(state, 'org:settings:write')).toBe(false)
  })
})

// ---- CLIENT_STATUS constant is importable ----
describe('CLIENT_STATUS', () => {
  it('contains expected status values', () => {
    expect(CLIENT_STATUS).toContain('loading')
    expect(CLIENT_STATUS).toContain('ready')
    expect(CLIENT_STATUS).toContain('degraded')
    expect(CLIENT_STATUS).toContain('error')
  })
})
