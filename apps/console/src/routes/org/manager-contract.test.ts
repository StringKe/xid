import { describe, expectTypeOf, it } from 'vitest'
import type {
  TenantManagerRole,
  TenantManagerRoleScopeWire,
  TenantManagerScopeType,
} from '@xid-kit/types'
import type {
  CreateManagerAssignmentInput,
  ManagerAssignment,
  ManagerScopeType,
  TenantManagerRole as ConsoleTenantManagerRole,
} from './types'

type RoleScopeOf<T> = T extends {
  manager_role: infer TManagerRole
  scope_type: infer TScopeType
}
  ? { manager_role: TManagerRole; scope_type: TScopeType }
  : never

describe('Console tenant manager contract', () => {
  it('uses the shared role, scope, and discriminated wire contract', () => {
    expectTypeOf<ConsoleTenantManagerRole>().toEqualTypeOf<TenantManagerRole>()
    expectTypeOf<ManagerScopeType>().toEqualTypeOf<TenantManagerScopeType>()
    expectTypeOf<RoleScopeOf<ManagerAssignment>>().toEqualTypeOf<TenantManagerRoleScopeWire>()
    expectTypeOf<
      RoleScopeOf<CreateManagerAssignmentInput>
    >().toEqualTypeOf<TenantManagerRoleScopeWire>()
  })
})
