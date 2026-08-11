// Token claims 组装与签发。issuer/签名密钥只从 TenantContext 取;jti 用 crypto.randomUUID;不得覆盖 IANA 标准 claims。

import type {
  AccessTokenClaims,
  ActClaim,
  AmrValue,
  AuthorizationDetails,
  ConfirmationClaim,
  IdTokenClaims,
  OrganizationMembershipRole,
  SigningAlg,
  TenantContext,
} from '@xid-kit/types'
import { base64UrlEncode, signJwt } from '@xid-kit/crypto'

const encoder = new TextEncoder()
const DEFAULT_ACCESS_TTL_SEC = 3600

function activeKey(ctx: TenantContext): { kid: string; alg: SigningAlg } {
  const kid = ctx.signingKeys.activeKid
  const material = ctx.signingKeys.keys.find((k) => k.kid === kid)
  const alg = material?.alg ?? ctx.signingKeys.defaultAlg
  return { kid, alg }
}

// at_hash / c_hash:SHA-256 左半 base64url(OIDC Core 3.1.3.6)。
export async function leftHalfHash(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(token)))
  return base64UrlEncode(digest.subarray(0, digest.length / 2))
}

export type AuthSubject = {
  userId: string
  email?: string
  emailVerified?: boolean
  name?: string
}

export type AuthContext = {
  authTime?: number
  acr?: string
  amr?: readonly AmrValue[]
  nonce?: string
  sid?: string
}

function applyScopeClaims(
  target: { email?: string; email_verified?: boolean; name?: string },
  scope: string,
  subject: AuthSubject,
): void {
  const scopes = new Set(scope.split(' ').filter(Boolean))
  if (scopes.has('email') && subject.email !== undefined) {
    target.email = subject.email
    if (subject.emailVerified !== undefined) target.email_verified = subject.emailVerified
  }
  if (scopes.has('profile') && subject.name !== undefined) target.name = subject.name
}

function applyAuthClaims(
  target: {
    auth_time?: number
    nonce?: string
    acr?: string
    amr?: readonly AmrValue[]
    sid?: string
  },
  authContext: AuthContext,
): void {
  if (authContext.authTime !== undefined) target.auth_time = authContext.authTime
  if (authContext.nonce !== undefined) target.nonce = authContext.nonce
  if (authContext.acr !== undefined) target.acr = authContext.acr
  if (authContext.amr !== undefined) target.amr = authContext.amr
  if (authContext.sid !== undefined) target.sid = authContext.sid
}

export function buildIdTokenClaims(input: {
  ctx: TenantContext
  subject: AuthSubject
  clientId: string
  authContext: AuthContext
  scope: string
  now: number
  ttlSec: number
  atHash?: string
  cHash?: string
  act?: ActClaim
}): IdTokenClaims {
  const claims: IdTokenClaims = {
    iss: input.ctx.issuer,
    sub: input.subject.userId,
    aud: input.clientId,
    exp: input.now + input.ttlSec,
    iat: input.now,
    jti: crypto.randomUUID(),
    azp: input.clientId,
  }
  applyAuthClaims(claims, input.authContext)
  if (input.atHash !== undefined) claims.at_hash = input.atHash
  if (input.cHash !== undefined) claims.c_hash = input.cHash
  if (input.act !== undefined) claims.act = input.act
  applyScopeClaims(claims, input.scope, input.subject)
  return claims
}

export type AccessTokenOptions = {
  authContext?: AuthContext
  sid?: string
  activeOrgId?: string | null
  orgRole?: OrganizationMembershipRole
  orgPermissions?: readonly string[]
  cnf?: ConfirmationClaim
  act?: ActClaim | null
  authorizationDetails?: readonly AuthorizationDetails[]
  // 浅合并;拒绝覆盖 IANA/OIDC 保留 claims 由调用方负责,本层不再校验。
  extraClaims?: Record<string, unknown>
}

function applyOrgClaims(claims: AccessTokenClaims, opts: AccessTokenOptions): void {
  if (opts.activeOrgId !== undefined) claims.active_org_id = opts.activeOrgId
  if (opts.orgRole !== undefined) claims.org_role = opts.orgRole
  if (opts.orgPermissions !== undefined) claims.org_permissions = opts.orgPermissions
}

function applyAccessAuthClaims(claims: AccessTokenClaims, auth: AuthContext): void {
  if (auth.acr !== undefined) claims.acr = auth.acr
  if (auth.amr !== undefined) claims.amr = auth.amr
  if (auth.authTime !== undefined) claims.auth_time = auth.authTime
}

function applyAccessOptions(claims: AccessTokenClaims, opts: AccessTokenOptions): void {
  if (opts.sid !== undefined) claims.sid = opts.sid
  if (opts.cnf !== undefined) claims.cnf = opts.cnf
  if (opts.act !== undefined) claims.act = opts.act
  if (opts.authorizationDetails !== undefined) {
    claims.authorization_details = opts.authorizationDetails
  }
  applyOrgClaims(claims, opts)
  if (opts.authContext) applyAccessAuthClaims(claims, opts.authContext)
  if (opts.extraClaims) {
    for (const [key, value] of Object.entries(opts.extraClaims)) claims[key] = value
  }
}

// tenant_id 恒写入:instance 签名密钥全租户共享,消费端靠它拒绝跨租户验证/内省。
export function buildAccessTokenClaims(input: {
  ctx: TenantContext
  subject: { userId: string }
  clientId: string
  scope: string
  audience: string | readonly string[]
  now: number
  ttlSec: number
  options?: AccessTokenOptions
}): AccessTokenClaims {
  const claims: AccessTokenClaims = {
    iss: input.ctx.issuer,
    sub: input.subject.userId,
    aud: input.audience,
    exp: input.now + input.ttlSec,
    iat: input.now,
    nbf: input.now,
    jti: crypto.randomUUID(),
    azp: input.clientId,
    scope: input.scope,
    client_id: input.clientId,
    tenant_id: input.ctx.tenantId,
  }
  if (input.options) applyAccessOptions(claims, input.options)
  return claims
}

export async function signClaims(
  ctx: TenantContext,
  signingKey: CryptoKey,
  payload: IdTokenClaims | AccessTokenClaims,
): Promise<string> {
  const { kid, alg } = activeKey(ctx)
  return signJwt({ header: { alg, kid }, payload }, signingKey)
}

// RFC9068:access token 使用 typ=at+jwt,避免与 ID Token 混用。
export async function signAccessTokenClaims(
  ctx: TenantContext,
  signingKey: CryptoKey,
  payload: AccessTokenClaims,
): Promise<string> {
  const { kid, alg } = activeKey(ctx)
  return signJwt({ header: { alg, kid, typ: 'at+jwt' }, payload }, signingKey)
}

export { DEFAULT_ACCESS_TTL_SEC }
