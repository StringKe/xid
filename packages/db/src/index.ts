// Drizzle schema + 租户查询层:所有查询强制注入 tenant_id/org_id(见 tenant-isolation / tenant-context rules)。

export const PACKAGE = '@xid-kit/db'

export * as schema from './schema'
export { USER_PROVISIONED_BY_ANONYMOUS } from './schema/users'
export { createTenantDb } from './tenant-db'
export type { TenantDb, OrgScopedDb, TenantScoped } from './tenant-db'
export {
  ORG_UNIT_MAX_DEPTH,
  createUnit,
  updateUnit,
  moveUnit,
  archiveUnit,
  listChildren,
  listTree,
  listSubtreeMembers,
  addUnitMember,
  removeUnitMember,
  setPrimaryUnit,
  resolveApproverChain,
} from './org-units'
export type { ApproverResolution, OrgUnitMemberRow, OrgUnitRow, OrgUnitScope } from './org-units'
export {
  instanceIssuerFor,
  resolveTenantContext,
  resolveInstanceLogin,
  resolveInstanceLoginCandidates,
  resolveTenantContextById,
  resolveTenantContextByIdInInstance,
  resolveTenantContextByApplicationClientId,
  resolveTenantContextByIssuer,
  resolveTenantContextBySessionHash,
  resolveTenantContextBySsoConnection,
  resolveTenantContextBySamlServiceProvider,
} from './tenant-context'
export type {
  InstanceLoginResolution,
  InstanceLoginMatch,
  IssuerTenantResolution,
  LoginIdentifier,
  LoginIdentifierKind,
} from './tenant-context'
