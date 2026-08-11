// OIDC/OAuth 协议内核:纯算法与状态,无 endpoint 路由。见 docs/design/03-oidc-oauth.md。

export const PACKAGE = '@xid-kit/protocol'

export type { OutboundConsolePreset } from './outbound-console-presets'
export { OUTBOUND_CONSOLE_PRESETS } from './outbound-console-presets'

export type { PkceMethod } from './pkce'
export { computeS256Challenge, generateCodeVerifier, verifyPkce, enforcePkceBinding } from './pkce'

export type { AuthSubject, AuthContext, AccessTokenOptions } from './tokens'
export {
  buildIdTokenClaims,
  buildAccessTokenClaims,
  signClaims,
  signAccessTokenClaims,
  leftHalfHash,
  DEFAULT_ACCESS_TTL_SEC,
} from './tokens'

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

export type { DpopJoseHeader, DpopPayload, DpopVerified } from './dpop'
export {
  verifyDpopProof,
  verifyDpopForResource,
  computeJkt,
  normalizeHtu,
  DEFAULT_IAT_WINDOW_SEC,
} from './dpop'

export type { DiscoveryMetadata, ProtectedResourceMetadata } from './discovery'
export { buildDiscoveryMetadata, buildProtectedResourceMetadata } from './discovery'

export type { StandardOidcScope } from './scopes'
export { STANDARD_OIDC_SCOPES, parseScopeSet, hasScope } from './scopes'

export type { NormalizedPublicJwk, NormalizedPublicJwks, PublicJwksError } from './client-jwks'
export { normalizePublicJwks } from './client-jwks'

export type { SetDelivery, SetEventInput } from './set'
export { signSet, CAEP_SESSION_REVOKED, RISC_ACCOUNT_CREDENTIAL_CHANGE } from './set'
