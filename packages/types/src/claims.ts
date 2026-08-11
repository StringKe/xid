// ID Token / Access Token claims。禁止覆盖 IANA 标准 claims（iss/sub/aud/exp/iat/nbf/jti）。

import type { OrganizationMembershipRole } from './rbac'

// passkey=phr / 密码=pwd / OTP=otp；MFA 可多项；guest=匿名访客 session
export const AMR_VALUES = ['phr', 'pwd', 'otp', 'mfa', 'sms', 'email', 'guest'] as const
export type AmrValue = (typeof AMR_VALUES)[number]

// RFC8693 token exchange 委托链
export type ActClaim = {
  sub: string
}

// DPoP / mTLS sender-constrained：cnf.jkt = JWK SHA-256 Thumbprint
export type ConfirmationClaim = {
  jkt?: string
  'x5t#S256'?: string
}

// RFC9396 RAR；当前仅 AS 控制的 resource_access（locations=RS audience，actions=resource scopes）
export type AuthorizationDetails = {
  type: 'resource_access'
  locations: readonly string[]
  actions: readonly string[]
}

type StandardClaims = {
  iss: string
  sub: string
  aud: string | readonly string[]
  exp: number
  iat: number
  jti: string
}

// c_hash 仅 hybrid 流程
export type IdTokenClaims = StandardClaims & {
  auth_time?: number
  nonce?: string
  acr?: string
  amr?: readonly AmrValue[]
  at_hash?: string
  c_hash?: string
  azp?: string
  sid?: string
  act?: ActClaim
  email?: string
  email_verified?: boolean
  name?: string
}

// RBAC 注入 permissions/org_id 等；roles 不进 token
export type AccessTokenClaims = StandardClaims & {
  nbf: number
  azp: string
  scope: string
  client_id: string
  // instance 签名密钥跨租户共享，验签通过不代表属于当前租户；消费端凭本 claim 拒跨租户。
  // 可选是因为切换前存量 token 无此 claim，消费端按缺失放行。
  tenant_id?: string
  sid?: string
  active_org_id?: string | null
  org_role?: OrganizationMembershipRole
  org_permissions?: readonly string[]
  // 空集仍注入 []
  permissions?: readonly string[]
  org_id?: string
  org_slug?: string
  project_id?: string
  // Project Grant 场景：Project 所有方 org A 的 ID
  granted_org_id?: string
  act?: ActClaim | null
  amr?: readonly AmrValue[]
  acr?: string
  auth_time?: number
  cnf?: ConfirmationClaim
  authorization_details?: readonly AuthorizationDetails[]
  email?: string
  email_verified?: boolean
  name?: string
  public_metadata?: Record<string, unknown>
  // PreAccessTokenHook 合并的额外非 IANA claims
  [claim: string]: unknown
}
