// PreAccessTokenHook + ABAC condition 求值 + claims merge(02 章 7.1/7.2/7.3/7.4)。
// 平台先算 RBAC(permissions),调用 hook 取 extra_claims/rbac_override,浅合并入 token payload。
// 铁律:禁止覆盖 IANA/OIDC 保留 claims(冲突 -> forbidden);condition 求值失败 permission 不授予不中断签发。

import type { Result, XidError } from '@xid-kit/types'
import type { ResolvedPermission } from './permissions'

// ---- PreAccessTokenHook 接口(02 章 7.1)----
export type PreAccessTokenContext = {
  user: {
    id: string
    public_metadata: Record<string, unknown>
    unsafe_metadata: Record<string, unknown>
  }
  org: { id: string; slug: string; public_metadata: Record<string, unknown> } | null
  client: { id: string; project_id: string | null; is_first_party: boolean }
  token_type: 'access_token' | 'id_token'
  rbac: { roles: string[]; permissions: string[] }
  grant: {
    grant_id: string
    granted_project_id: string
    granted_by_org_id: string
    granted_to_org_id: string
  } | null
}

export type PreAccessTokenResult = {
  extra_claims: Record<string, unknown>
  rbac_override?: { roles?: string[]; permissions?: string[] }
}

export type PreAccessTokenHook = (
  ctx: PreAccessTokenContext,
  env: Env,
) => Promise<PreAccessTokenResult>

// IANA 保留(7.1)+ OIDC 标准保留 claims:extra_claims 禁止覆盖。
const FORBIDDEN_CLAIM_KEYS = new Set([
  'iss',
  'sub',
  'aud',
  'exp',
  'nbf',
  'iat',
  'jti',
  'auth_time',
  'nonce',
  'acr',
  'amr',
  'azp',
  'at_hash',
  'c_hash',
  'org_role',
])

// ---- ABAC condition 求值(02 章 7.3)----
const ABAC_OPS = ['eq', 'in', 'not_eq', 'not_in'] as const
type AbacOp = (typeof ABAC_OPS)[number]
const ABAC_VAR =
  /^(?:user\.(?:public_metadata|unsafe_metadata)\.[^.]+|org\.(?:id|slug|public_metadata\.[^.]+))$/

type Leaf = { op: AbacOp; var: string; value: unknown }
type AndNode = { and: unknown[] }

// 求值上下文变量(7.3 表):user/org metadata + org.id/org.slug。org 为 null 时相关路径 undefined。
function resolveVar(path: string, ctx: PreAccessTokenContext): unknown {
  const segs = path.split('.')
  if (segs[0] === 'user') return readMetaPath(ctx.user, segs.slice(1))
  if (segs[0] === 'org') return readOrgVar(segs.slice(1), ctx.org)
  return undefined
}

function readOrgVar(segs: string[], org: PreAccessTokenContext['org']): unknown {
  if (org === null) return undefined
  if (segs[0] === 'id') return org.id
  if (segs[0] === 'slug') return org.slug
  if (segs[0] === 'public_metadata') return readKey(org.public_metadata, segs[1])
  return undefined
}

function readMetaPath(user: PreAccessTokenContext['user'], segs: string[]): unknown {
  if (segs[0] === 'public_metadata') return readKey(user.public_metadata, segs[1])
  if (segs[0] === 'unsafe_metadata') return readKey(user.unsafe_metadata, segs[1])
  return undefined
}

function readKey(bag: Record<string, unknown>, key: string | undefined): unknown {
  return key === undefined ? undefined : bag[key]
}

function isLeaf(node: unknown): node is Leaf {
  if (typeof node !== 'object' || node === null) return false
  const n = node as Record<string, unknown>
  if (Object.keys(n).some((key) => !['op', 'var', 'value'].includes(key))) return false
  if (typeof n['op'] !== 'string' || !ABAC_OPS.includes(n['op'] as AbacOp)) return false
  if (typeof n['var'] !== 'string' || !ABAC_VAR.test(n['var'])) return false
  if (!Object.hasOwn(n, 'value')) return false
  if ((n['op'] === 'in' || n['op'] === 'not_in') && !Array.isArray(n['value'])) return false
  return true
}

// 单 leaf 求值(7.3 操作符语义 + undefined 处理):eq/in 对 undefined 为 false,not_eq/not_in 为 true。
function evalLeaf(leaf: Leaf, ctx: PreAccessTokenContext): boolean | null {
  if (!ABAC_OPS.includes(leaf.op)) return null
  const actual = resolveVar(leaf.var, ctx)
  switch (leaf.op) {
    case 'eq':
      return actual === leaf.value
    case 'not_eq':
      return actual !== leaf.value
    case 'in':
      return Array.isArray(leaf.value) && leaf.value.includes(actual)
    case 'not_in':
      return !(Array.isArray(leaf.value) && leaf.value.includes(actual))
  }
}

// 顶层 condition 求值:单 leaf 或 { and: [...] }(7.3);不支持的结构/操作符返回 null(视为配置错误)。
export function evalCondition(
  expr: Record<string, unknown> | null,
  ctx: PreAccessTokenContext,
): boolean | null {
  if (expr === null) return true
  if (!isValidAbacCondition(expr)) return null
  if (Array.isArray((expr as AndNode).and)) {
    let result = true
    for (const child of (expr as AndNode).and) {
      const sub = isLeaf(child) ? evalLeaf(child, ctx) : null
      if (sub === null) return null
      result = result && sub
    }
    return result
  }
  if (isLeaf(expr)) return evalLeaf(expr, ctx)
  return null
}

// 写路径与运行时求值共用语法谓词,避免控制面已接受的 condition 在求值时变配置错误。
export function isValidAbacCondition(expr: Record<string, unknown> | null): boolean {
  if (expr === null || isLeaf(expr)) return true
  if (Object.keys(expr).length !== 1 || !Array.isArray((expr as AndNode).and)) return false
  const children = (expr as AndNode).and
  return children.length > 0 && children.every(isLeaf)
}

// 对解析出的 permission 应用 condition 过滤(7.2):求值 true 入集去重;false/配置错误丢弃。
// 返回去重 key 集 + 配置错误的 key(调用方写 AuditLog,本函数不副作用)。
export function applyConditions(
  perms: readonly ResolvedPermission[],
  ctx: PreAccessTokenContext,
): { permissions: string[]; invalid: string[] } {
  const granted = new Set<string>()
  const invalid: string[] = []
  for (const p of perms) {
    if (p.invalidCondition) {
      invalid.push(p.key)
      continue
    }
    const verdict = evalCondition(p.condition, ctx)
    if (verdict === null) invalid.push(p.key)
    else if (verdict) granted.add(p.key)
  }
  return { permissions: [...granted], invalid: [...new Set(invalid)] }
}

// 平台内置 PreAccessTokenHook(v1):不追加 extra_claims,不覆写 rbac(用户覆盖作 P1,见 7.1)。
export const builtinPreAccessTokenHook: PreAccessTokenHook = async () => ({ extra_claims: {} })

// extra_claims 浅合并入 token payload(7.1 step 3):任一 key 命中保留 claims -> 拒绝签发。
export function mergeExtraClaims(
  base: Record<string, unknown>,
  extra: Record<string, unknown>,
): Result<Record<string, unknown>, XidError> {
  for (const key of Object.keys(extra)) {
    if (FORBIDDEN_CLAIM_KEYS.has(key)) {
      return {
        ok: false,
        error: { code: 'invalid_scope', message: `forbidden claim key: ${key}`, httpStatus: 400 },
      }
    }
  }
  return { ok: true, value: { ...base, ...extra } }
}

// hook rbac_override 覆写平台计算结果(7.1 step 4);未返回 override 用平台 permissions。
export function applyRbacOverride(
  platform: string[],
  override: PreAccessTokenResult['rbac_override'],
): string[] {
  if (override?.permissions !== undefined) return override.permissions
  return platform
}
