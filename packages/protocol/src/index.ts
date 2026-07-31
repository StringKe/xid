// @xid-kit/protocol:OIDC/OAuth/JWT/PKCE/refresh rotation 协议内核(自研,无 endpoint 路由,纯算法+状态)。
// 见 .stdai/standards/rules/oidc-oauth.md、docs/design/03-oidc-oauth.md 第 9-11 节。

export const PACKAGE = '@xid-kit/protocol'

export type { OutboundConsolePreset } from './outbound-console-presets'
export { OUTBOUND_CONSOLE_PRESETS } from './outbound-console-presets'

// PKCE(S256 强制,拒 plain,downgrade 防护)
export type { PkceMethod } from './pkce'
export { computeS256Challenge, generateCodeVerifier, verifyPkce, enforcePkceBinding } from './pkce'

// Token claims 组装 + 签发
export type { AuthSubject, AuthContext, AccessTokenOptions } from './tokens'
export {
  buildIdTokenClaims,
  buildAccessTokenClaims,
  signClaims,
  signAccessTokenClaims,
  leftHalfHash,
  DEFAULT_ACCESS_TTL_SEC,
} from './tokens'

// Refresh token 轮换 + family 重放检测
export type { RefreshTokenRecord, IssuedRefreshToken, RefreshDecision } from './refresh'
export {
  generateRefreshToken,
  hashRefreshToken,
  detectReplay,
  decisionToResult,
  narrowScope,
  issueRefreshFamily,
  rotateRefresh,
  DEFAULT_IDLE_TTL_SEC,
  DEFAULT_ABSOLUTE_TTL_SEC,
  REFRESH_TOKEN_PREFIX,
} from './refresh'

// /authorize 状态机 + authorization code
export type {
  ResponseType,
  Prompt,
  AuthorizeRequest,
  ClientRegistration,
  SessionState,
  ConsentState,
  AuthorizeDirective,
  LocalError,
  RedirectError,
  NeedLogin,
  NeedConsent,
  EmitCode,
  AuthorizationCode,
} from './authorize'
export {
  evaluateAuthorize,
  generateAuthorizationCode,
  validateAuthorizationCode,
  AUTH_CODE_PREFIX,
  DEFAULT_CODE_TTL_SEC,
} from './authorize'

// DPoP proof 校验(RFC9449)
export type { DpopJoseHeader, DpopPayload, DpopVerified } from './dpop'
export {
  verifyDpopProof,
  verifyDpopForResource,
  computeJkt,
  normalizeHtu,
  DEFAULT_IAT_WINDOW_SEC,
} from './dpop'

// Discovery 元数据(合并 openid-configuration + oauth-authorization-server)和 protected resource metadata
export type { DiscoveryMetadata, ProtectedResourceMetadata } from './discovery'
export { buildDiscoveryMetadata, buildProtectedResourceMetadata } from './discovery'

// DCR/discovery/authorize/userinfo 共用的标准 scope 目录。
export type { StandardOidcScope } from './scopes'
export { STANDARD_OIDC_SCOPES, parseScopeSet, hasScope } from './scopes'

// DCR 与运行时 private_key_jwt 共用的严格 public JWKS 规范化。
export type { NormalizedPublicJwk, NormalizedPublicJwks, PublicJwksError } from './client-jwks'
export { normalizePublicJwks } from './client-jwks'

// Shared Signals Framework SET signing
export type { SetDelivery, SetEventInput } from './set'
export { signSet, CAEP_SESSION_REVOKED, RISC_ACCOUNT_CREDENTIAL_CHANGE } from './set'
