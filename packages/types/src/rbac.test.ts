import { describe, expect, expectTypeOf, it } from 'vitest'
import type { AccessTokenClaims } from './claims'
import type { BrowserManagerAssignment } from './session'
import {
  ORGANIZATION_MEMBERSHIP_ROLES,
  TENANT_MANAGER_ROLES,
  TENANT_MANAGER_ROLE_SCOPE_CONTRACT,
  TENANT_MANAGER_SCOPE_TYPES,
  isOrganizationMembershipRole,
  isTenantManagerRoleScope,
  tenantManagerRoleForScope,
  type OrganizationMembershipRole,
  type TenantManagerRoleScope,
  type TenantManagerRoleScopeWire,
} from './rbac'

type ExpectedTenantManagerRoleScope =
  | { readonly managerRole: 'org_manager'; readonly scopeType: 'org' }
  | { readonly managerRole: 'project_manager'; readonly scopeType: 'project' }
  | { readonly managerRole: 'project_grant_manager'; readonly scopeType: 'grant' }

type ExpectedTenantManagerRoleScopeWire =
  | { manager_role: 'org_manager'; scope_type: 'org' }
  | { manager_role: 'project_manager'; scope_type: 'project' }
  | { manager_role: 'project_grant_manager'; scope_type: 'grant' }

type ExpectedBrowserManagerAssignment =
  | {
      readonly managerRole: 'project_manager'
      readonly scopeType: 'project'
      id: string
      scopeId: string
      scopeStatus: 'active' | 'deleted'
    }
  | {
      readonly managerRole: 'project_grant_manager'
      readonly scopeType: 'grant'
      id: string
      scopeId: string
      scopeStatus: 'active'
    }

describe('manager role and scope contract', () => {
  it('keeps the runtime role and scope lists derived from the discriminated contract', () => {
    expect(TENANT_MANAGER_ROLES).toEqual(
      TENANT_MANAGER_ROLE_SCOPE_CONTRACT.map(({ managerRole }) => managerRole),
    )
    expect(TENANT_MANAGER_SCOPE_TYPES).toEqual(
      TENANT_MANAGER_ROLE_SCOPE_CONTRACT.map(({ scopeType }) => scopeType),
    )

    for (const managerRole of TENANT_MANAGER_ROLES) {
      for (const scopeType of TENANT_MANAGER_SCOPE_TYPES) {
        const expected = tenantManagerRoleForScope(scopeType) === managerRole
        expect(isTenantManagerRoleScope(managerRole, scopeType)).toBe(expected)
      }
    }
  })

  it('keeps organization membership separate from project business roles', () => {
    expect(ORGANIZATION_MEMBERSHIP_ROLES).toEqual(['owner', 'admin', 'member'])
    expect(isOrganizationMembershipRole('owner')).toBe(true)
    expect(isOrganizationMembershipRole('viewer')).toBe(false)
    expect(ORGANIZATION_MEMBERSHIP_ROLES).not.toContain('viewer')
    expect(ORGANIZATION_MEMBERSHIP_ROLES).not.toContain('billing_admin')
  })

  it('keeps shared wire and browser contracts paired at compile time', () => {
    expectTypeOf<TenantManagerRoleScope>().toEqualTypeOf<ExpectedTenantManagerRoleScope>()
    expectTypeOf<TenantManagerRoleScopeWire>().toEqualTypeOf<ExpectedTenantManagerRoleScopeWire>()
    expectTypeOf<BrowserManagerAssignment>().toEqualTypeOf<ExpectedBrowserManagerAssignment>()
    expectTypeOf<
      NonNullable<AccessTokenClaims['org_role']>
    >().toEqualTypeOf<OrganizationMembershipRole>()
  })
})
