// 第 3 组契约:ID Token / Access Token claims。
// 对照 docs/design/03-oidc-oauth.md 第 3 节与 9.1、05 章 8.1 完整 claims 规格。
// 铁律:禁止覆盖 IANA 标准 claims(iss/sub/aud/exp/iat/nbf/jti)。

// amr 认证方法(见 05 章 8.1:passkey=phr / 密码=pwd / OTP=otp;MFA 含多个)
export const AMR_VALUES = ['phr', 'pwd', 'otp', 'mfa', 'sms', 'email'] as const
export type AmrValue = (typeof AMR_VALUES)[number]

// RFC8693 token exchange 委托链:act claim(见 05 章 8.1、03 章 9.5)
export type ActClaim = {
  sub: string
}

// DPoP / mTLS sender-constrained 绑定确认(见 03 章 9.8:cnf.jkt = JWK SHA-256 Thumbprint)
export type ConfirmationClaim = {
  jkt?: string
  'x5t#S256'?: string
}

// RFC9396 RAR authorization_details. XID currently supports one AS-controlled type:
// `resource_access`, where locations are registered resource server audiences and actions are
// resource scopes.
export type AuthorizationDetails = {
  type: 'resource_access'
  locations: readonly string[]
  actions: readonly string[]
}

// 标准 OIDC/JWT claims 公共部分(见 03 章 9.1、05 章 8.1)
type StandardClaims = {
  iss: string
  sub: string
  aud: string | readonly string[]
  exp: number
  iat: number
  jti: string
}

// ID Token(见 03 章 9.1 line 148:必含 iss/sub/aud/exp/iat;条件含 auth_time/nonce/acr/amr/at_hash/c_hash;c_hash 仅 hybrid)
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

// Access Token(见 05 章 8.1 完整 payload:含 nbf/azp/scope/client_id/sid/active_org_id/org_role/org_permissions 等)
// RBAC 注入(02 章 7.2/7.4):permissions/org_id/org_slug/project_id/granted_org_id;roles 不进 token。
export type AccessTokenClaims = StandardClaims & {
  nbf: number
  azp: string
  scope: string
  client_id: string
  // 租户绑定:instance 签名密钥全租户共享,验签通过不代表属于当前租户,消费端(introspect/userinfo)
  // 凭本 claim 拒跨租户 token。可选是因为切换前签发的存量 token 无此 claim,消费端按缺失放行处理。
  tenant_id?: string
  sid?: string
  active_org_id?: string | null
  org_role?: string
  org_permissions?: readonly string[]
  // RBAC permission 集(02 章 7.2):Permission.key 数组,空集仍注入 []。
  permissions?: readonly string[]
  // active org 上下文(02 章 7.2):org_id 为 Organization.id,org_slug 仅便于调试。
  org_id?: string
  org_slug?: string
  // Project Grant 跨 org(02 章 7.4):project_id 供 resource server 确认授权范围。
  project_id?: string
  // Project Grant 场景注入:Project 所有方 org A 的 ID(仅 Grant 路径)。
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
  // PreAccessTokenHook 合并的额外非 IANA claims(02 章 7.1)。
  [claim: string]: unknown
}
