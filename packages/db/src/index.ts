// @xid-kit/db:Drizzle schema + 带租户上下文的查询层。所有查询强制注入 tenant_id/org_id。
// 见 .stdai/standards/rules/tenant-isolation.md、tenant-context.md、docs/design/08-data-model.md。

export const PACKAGE = '@xid-kit/db'

// Drizzle schema(37 实体,字段级对齐 08 章)。
export * as schema from './schema'
// 租户查询层(P0 隔离):createTenantDb + 类型。
export { createTenantDb } from './tenant-db'
export type { TenantDb, OrgScopedDb, TenantScoped } from './tenant-db'
// TenantContext 解析工厂(单/多租户 + instance login resolver)。
export {
  instanceIssuerFor,
  resolveTenantContext,
  resolveInstanceLogin,
  resolveInstanceLoginCandidates,
  resolveTenantContextById,
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
