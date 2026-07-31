// 服务器实际支持的标准 scope 单一目录。端点可在此集合之上叠加已注册的 resource scope,
// 但不得各自维护一份会漂移的 OIDC 列表。
export const STANDARD_OIDC_SCOPES = [
  'openid',
  'profile',
  'email',
  'phone',
  'offline_access',
  'organization',
] as const

export type StandardOidcScope = (typeof STANDARD_OIDC_SCOPES)[number]

export function parseScopeSet(scope: string): ReadonlySet<string> {
  return new Set(scope.split(/\s+/u).filter(Boolean))
}

export function hasScope(scope: string, expected: StandardOidcScope): boolean {
  return parseScopeSet(scope).has(expected)
}
