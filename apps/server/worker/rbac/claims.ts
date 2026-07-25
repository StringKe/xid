// RBAC claims 装配(02 章 7.2/7.4):解析 permission -> ABAC 过滤 -> 调用 hook -> 产出 access token extra claims。
// 由 token 签发处(token-issue)调用;无用户上下文(client_credentials)跳过(返回空 claims)。
// 铁律:tenant_id 从 TenantContext 取;Grant 路径用 org A 的 tenant 查 Role/Permission(02 章 7.4)。

import { and, eq, isNull } from 'drizzle-orm'
import { createTenantDb, schema } from '@xid-kit/db'
import type { Result, TenantContext, XidError } from '@xid-kit/types'
import {
  applyConditions,
  applyRbacOverride,
  builtinPreAccessTokenHook,
  mergeExtraClaims,
} from './action'
import type { PreAccessTokenContext, PreAccessTokenHook } from './action'
import { createRbacStore, resolveUserPermissions } from './permissions'

// Project Grant 跨 org 上下文(02 章 7.4):仅 active org != Project 所属 org 时填入。
export type GrantContext = {
  grantId: string
  grantedProjectId: string
  grantedByOrgId: string
  grantedToOrgId: string
}

// RBAC claims 装配输入。activeOrg 为 null 表示 B2C(无 org claim);projectId 来自 application。
export type RbacClaimsInput = {
  userId: string
  projectId: string | null
  clientId: string
  isFirstParty: boolean
  activeOrg: { id: string; slug: string } | null
  grant?: GrantContext | null
}

// 取 user metadata(public/unsafe);缺失回退空对象(枚举防护不报错)。
async function loadUserMeta(
  d1: D1Database,
  ctx: TenantContext,
  userId: string,
): Promise<{ public_metadata: Record<string, unknown>; unsafe_metadata: Record<string, unknown> }> {
  const db = createTenantDb(d1, ctx)
  const row = await db.users.findOne(
    and(
      eq(schema.users.id, userId),
      eq(schema.users.status, 'active'),
      isNull(schema.users.deletedAt),
    ),
  )
  return {
    public_metadata: row?.publicMetadata ?? {},
    unsafe_metadata: row?.unsafeMetadata ?? {},
  }
}

// 取 active org public_metadata(7.3 求值上下文);缺失回退空对象。
async function loadOrgMeta(
  d1: D1Database,
  ctx: TenantContext,
  orgId: string,
): Promise<Record<string, unknown>> {
  const db = createTenantDb(d1, ctx)
  const row = await db.organizations.findOne(eq(schema.organizations.id, orgId))
  return row?.publicMetadata ?? {}
}

// 装配 PreAccessTokenContext(7.1):rbac.permissions 由平台预填(此处先空,装配后填)。
function buildHookContext(
  input: RbacClaimsInput,
  meta: { public_metadata: Record<string, unknown>; unsafe_metadata: Record<string, unknown> },
  orgMeta: Record<string, unknown>,
): PreAccessTokenContext {
  return {
    user: {
      id: input.userId,
      public_metadata: meta.public_metadata,
      unsafe_metadata: meta.unsafe_metadata,
    },
    org: input.activeOrg
      ? { id: input.activeOrg.id, slug: input.activeOrg.slug, public_metadata: orgMeta }
      : null,
    client: { id: input.clientId, project_id: input.projectId, is_first_party: input.isFirstParty },
    token_type: 'access_token',
    rbac: { roles: [], permissions: [] },
    grant: input.grant
      ? {
          grant_id: input.grant.grantId,
          granted_project_id: input.grant.grantedProjectId,
          granted_by_org_id: input.grant.grantedByOrgId,
          granted_to_org_id: input.grant.grantedToOrgId,
        }
      : null,
  }
}

// 平台 RBAC 计算(7.2):解析 permission -> ABAC 过滤;无 projectId(B2C/无 grant)则空集。
async function computePlatformPermissions(
  d1: D1Database,
  ctx: TenantContext,
  input: RbacClaimsInput,
  hookCtx: PreAccessTokenContext,
): Promise<string[]> {
  if (input.projectId === null) return []
  const store = createRbacStore(d1, ctx)
  const resolved = await resolveUserPermissions(store, {
    userId: input.userId,
    projectId: input.projectId,
    grantId: input.grant?.grantId ?? null,
  })
  return applyConditions(resolved, hookCtx).permissions
}

// org 上下文 claims(7.2/7.4):org_id/org_slug + Grant 场景的 project_id/granted_org_id。
function buildOrgClaims(input: RbacClaimsInput): Record<string, unknown> {
  const claims: Record<string, unknown> = {}
  if (input.activeOrg) {
    claims['org_id'] = input.activeOrg.id
    claims['org_slug'] = input.activeOrg.slug
  }
  if (input.grant) {
    claims['project_id'] = input.grant.grantedProjectId
    claims['granted_org_id'] = input.grant.grantedByOrgId
  }
  return claims
}

// buildRbacClaims 参数(d1/ctx/env 来自 Worker 绑定;input 业务上下文;hook 可覆盖,默认内置)。
export type BuildRbacClaimsArgs = {
  d1: D1Database
  ctx: TenantContext
  env: Env
  input: RbacClaimsInput
  hook?: PreAccessTokenHook
}

// 装配 access token RBAC + hook claims(7.2/7.4 全流程)。失败(forbidden claim key)返回 Result error。
// hook 默认平台内置实现(builtinPreAccessTokenHook),用户覆盖作 P1。
export async function buildRbacClaims(
  args: BuildRbacClaimsArgs,
): Promise<Result<Record<string, unknown>, XidError>> {
  const { d1, ctx, env, input } = args
  const hook = args.hook ?? builtinPreAccessTokenHook
  const meta = await loadUserMeta(d1, ctx, input.userId)
  const orgMeta = input.activeOrg ? await loadOrgMeta(d1, ctx, input.activeOrg.id) : {}
  const hookCtx = buildHookContext(input, meta, orgMeta)
  const platformPerms = await computePlatformPermissions(d1, ctx, input, hookCtx)
  hookCtx.rbac.permissions = platformPerms

  const hookResult = await hook(hookCtx, env)
  const permissions = applyRbacOverride(platformPerms, hookResult.rbac_override)
  const base: Record<string, unknown> = { permissions, ...buildOrgClaims(input) }
  return mergeExtraClaims(base, hookResult.extra_claims)
}
