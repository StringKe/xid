// RBAC 模块导出桶(02 章 7):permission 解析 + ABAC 求值 + PreAccessTokenHook + claims 装配。
// token 签发处(token-issue)调 buildRbacClaims 注入 permissions/org_id/project_id/granted_org_id claim。

export type { ResolvedPermission, ResolvePermissionsInput, RbacStore } from './permissions'
export { createRbacStore, resolveUserPermissions } from './permissions'

export type { PreAccessTokenContext, PreAccessTokenResult, PreAccessTokenHook } from './action'
export {
  evalCondition,
  applyConditions,
  mergeExtraClaims,
  applyRbacOverride,
  builtinPreAccessTokenHook,
} from './action'

export type { GrantContext, RbacClaimsInput, BuildRbacClaimsArgs } from './claims'
export { buildRbacClaims } from './claims'
