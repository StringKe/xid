import { describe, expect, it, vi } from 'vitest'
import type { createTenantDb } from '@xid-kit/db'
import { findOrganizationAccessGrant, memberActiveOrgId } from '../organization-access'

type TenantDb = ReturnType<typeof createTenantDb>

function fakeDb(input: { membership?: { role: string }; assignment?: { id: string } }): TenantDb {
  return {
    memberships: { findOne: vi.fn().mockResolvedValue(input.membership) },
    managerAssignments: { findOne: vi.fn().mockResolvedValue(input.assignment) },
  } as unknown as TenantDb
}

describe('findOrganizationAccessGrant', () => {
  it('grants an org_manager assignment without a membership', async () => {
    const db = fakeDb({ assignment: { id: 'ma-1' } })

    const grant = await findOrganizationAccessGrant(db, { userId: 'user-1', orgId: 'org-1' })

    expect(grant).toEqual({ isMember: false, membershipRole: null, isOrgManager: true })
  })

  it('returns null without a membership or an assignment', async () => {
    const db = fakeDb({})

    const grant = await findOrganizationAccessGrant(db, { userId: 'user-1', orgId: 'org-1' })

    expect(grant).toBeNull()
  })
})

describe('memberActiveOrgId', () => {
  it('keeps the active org for a member', async () => {
    const db = fakeDb({ membership: { role: 'member' } })

    const orgId = await memberActiveOrgId(db, { userId: 'user-1', activeOrgId: 'org-1' })

    expect(orgId).toBe('org-1')
  })

  it('drops the active org reached only through an org_manager assignment', async () => {
    const db = fakeDb({ assignment: { id: 'ma-1' } })

    const orgId = await memberActiveOrgId(db, { userId: 'user-1', activeOrgId: 'org-1' })

    expect(orgId).toBeNull()
  })

  it('skips the lookup when no active org is set', async () => {
    const db = fakeDb({ membership: { role: 'owner' } })

    const orgId = await memberActiveOrgId(db, { userId: 'user-1', activeOrgId: null })

    expect(orgId).toBeNull()
    expect(db.memberships.findOne).not.toHaveBeenCalled()
  })
})
