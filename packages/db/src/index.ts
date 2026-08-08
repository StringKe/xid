// @xid-kit/db:Drizzle schema + 带租户上下文的查询层。所有查询强制注入 tenant_id/org_id。
// 见 .stdai/standards/rules/tenant-isolation.md、tenant-context.md、docs/design/08-data-model.md。

export const PACKAGE = '@xid-kit/db'

// Drizzle schema(字段级对齐 08 章)。
export * as schema from './schema'
// users.provisioned_by 取值登记(常量定义在 schema/users.ts,此处给不带 schema 命名空间的引用方)。
export { USER_PROVISIONED_BY_ANONYMOUS } from './schema/users'
// 租户查询层(P0 隔离):createTenantDb + 类型。
export { createTenantDb } from './tenant-db'
export type { TenantDb, OrgScopedDb, TenantScoped } from './tenant-db'
// OrgUnit 树核心服务(设计 docs/design/org-structure-access/design-org-structure.md 第 3 节)。
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
// TenantContext 解析工厂(单/多租户 + instance login resolver)。
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
