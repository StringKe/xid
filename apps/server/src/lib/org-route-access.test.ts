import { describe, expect, it } from 'vitest'
import type { AuthOrg } from './auth-context'
import { canAccessOrgConsoleRoute, isOrgManagerRole } from './org-route-access'

const org: AuthOrg = {
  id: 'org_1',
  slug: 'default',
  name: 'Default',
  role: 'owner',
  permissions: [],
}

const memberOrg: AuthOrg = { ...org, role: 'member' }

describe('isOrgManagerRole', () => {
  it('allows owner and admin roles only', () => {
    expect(isOrgManagerRole('owner')).toBe(true)
    expect(isOrgManagerRole('admin')).toBe(true)
    expect(isOrgManagerRole('member')).toBe(false)
    expect(isOrgManagerRole('')).toBe(false)
  })
})

describe('canAccessOrgConsoleRoute', () => {
  it('allows active organization users with a manager role', () => {
    expect(canAccessOrgConsoleRoute({ activeOrg: org, targetOrgId: null })).toBe(true)
    expect(
      canAccessOrgConsoleRoute({ activeOrg: { ...org, role: 'admin' }, targetOrgId: null }),
    ).toBe(true)
  })

  it('blocks members even when the organization is active', () => {
    expect(canAccessOrgConsoleRoute({ activeOrg: memberOrg, targetOrgId: null })).toBe(false)
    expect(canAccessOrgConsoleRoute({ activeOrg: memberOrg, targetOrgId: org.id })).toBe(false)
  })

  it('allows a query orgId only when it matches the active organization', () => {
    expect(
      canAccessOrgConsoleRoute({
        activeOrg: org,
        targetOrgId: org.id,
      }),
    ).toBe(true)
  })

  it('blocks an organization query that differs from the active organization', () => {
    expect(
      canAccessOrgConsoleRoute({
        activeOrg: org,
        targetOrgId: 'org_other',
      }),
    ).toBe(false)
  })

  it('blocks users without active or target organization context', () => {
    expect(canAccessOrgConsoleRoute({ activeOrg: null, targetOrgId: null })).toBe(false)
  })

  it('does not grant access from a target organization query alone', () => {
    expect(
      canAccessOrgConsoleRoute({
        activeOrg: null,
        targetOrgId: org.id,
      }),
    ).toBe(false)
  })
})
