// Organization management roles are fixed platform contracts. Project/Application business roles
// remain tenant-defined rows and intentionally do not use these enums.

export const ORGANIZATION_MEMBERSHIP_ROLES = ['owner', 'admin', 'member'] as const
export type OrganizationMembershipRole = (typeof ORGANIZATION_MEMBERSHIP_ROLES)[number]

export function isOrganizationMembershipRole(value: unknown): value is OrganizationMembershipRole {
  return (
    typeof value === 'string' &&
    (ORGANIZATION_MEMBERSHIP_ROLES as readonly string[]).includes(value)
  )
}

export const ORGANIZATION_ADMIN_ROLES = ['owner', 'admin'] as const
export type OrganizationAdminRole = (typeof ORGANIZATION_ADMIN_ROLES)[number]

export const TENANT_MANAGER_ROLE_SCOPE_CONTRACT = [
  { managerRole: 'org_manager', scopeType: 'org' },
  { managerRole: 'project_manager', scopeType: 'project' },
  { managerRole: 'project_grant_manager', scopeType: 'grant' },
] as const

export type TenantManagerRoleScope = (typeof TENANT_MANAGER_ROLE_SCOPE_CONTRACT)[number]
export type TenantManagerRole = TenantManagerRoleScope['managerRole']
export type TenantManagerScopeType = TenantManagerRoleScope['scopeType']

export const TENANT_MANAGER_ROLES = Object.freeze(
  TENANT_MANAGER_ROLE_SCOPE_CONTRACT.map(({ managerRole }) => managerRole),
)
export const TENANT_MANAGER_SCOPE_TYPES = Object.freeze(
  TENANT_MANAGER_ROLE_SCOPE_CONTRACT.map(({ scopeType }) => scopeType),
)

export type TenantManagerRoleForScope<TScope extends TenantManagerScopeType> = Extract<
  TenantManagerRoleScope,
  { scopeType: TScope }
>['managerRole']

type ToTenantManagerRoleScopeWire<TContract extends TenantManagerRoleScope> =
  TContract extends TenantManagerRoleScope
    ? {
        manager_role: TContract['managerRole']
        scope_type: TContract['scopeType']
      }
    : never

export type TenantManagerRoleScopeWire = ToTenantManagerRoleScopeWire<TenantManagerRoleScope>

export function isTenantManagerRole(value: unknown): value is TenantManagerRole {
  return typeof value === 'string' && (TENANT_MANAGER_ROLES as readonly string[]).includes(value)
}

export function isTenantManagerScopeType(value: unknown): value is TenantManagerScopeType {
  return (
    typeof value === 'string' && (TENANT_MANAGER_SCOPE_TYPES as readonly string[]).includes(value)
  )
}

export function isTenantManagerRoleScope(managerRole: unknown, scopeType: unknown): boolean {
  return TENANT_MANAGER_ROLE_SCOPE_CONTRACT.some(
    (contract) => contract.managerRole === managerRole && contract.scopeType === scopeType,
  )
}

export function tenantManagerRoleForScope<const TScope extends TenantManagerScopeType>(
  scopeType: TScope,
): TenantManagerRoleForScope<TScope> {
  const contract = TENANT_MANAGER_ROLE_SCOPE_CONTRACT.find(
    (candidate) => candidate.scopeType === scopeType,
  )
  if (!contract) {
    throw new TypeError(`Unknown tenant manager scope type: ${scopeType}`)
  }
  return contract.managerRole as TenantManagerRoleForScope<TScope>
}

export const MANAGER_ROLE_SCOPE_CONTRACT = [
  { managerRole: 'instance_manager', scopeType: 'instance' },
  ...TENANT_MANAGER_ROLE_SCOPE_CONTRACT,
] as const

export type ManagerRoleScope = (typeof MANAGER_ROLE_SCOPE_CONTRACT)[number]
export type ManagerRole = ManagerRoleScope['managerRole']
export type ManagerScopeType = ManagerRoleScope['scopeType']

export const MANAGER_ROLES = Object.freeze(
  MANAGER_ROLE_SCOPE_CONTRACT.map(({ managerRole }) => managerRole),
)
export const MANAGER_SCOPE_TYPES = Object.freeze(
  MANAGER_ROLE_SCOPE_CONTRACT.map(({ scopeType }) => scopeType),
)
