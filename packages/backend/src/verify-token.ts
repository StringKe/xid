// networkless:必须传 jwtKey 本地验签,禁止静默回源;可预期失败走 Result。

import { isOrganizationMembershipRole, type AccessTokenClaims, type Result } from '@xid-kit/types'
import type { JwtVerifyError } from '@xid-kit/crypto'
import { verifyJwt } from '@xid-kit/crypto'

import { AppError } from './errors'
import type { JwtKey } from './jwks'
import { toVerifyKeySet } from './jwks'

export type VerifyTokenError =
  | JwtVerifyError['reason']
  | 'typ_mismatch'
  | 'azp_mismatch'
  | 'invalid_org_role'

export type VerifyTokenOptions = {
  // 必传;缺失直接 throw,不静默回源。
  jwtKey: JwtKey
  issuer?: string
  audience?: string
  // 防 access token 被其它 client 重用。
  authorizedParties?: readonly string[]
  clockToleranceSec?: number
  now?: number
}

function checkAuthorizedParties(
  claims: AccessTokenClaims,
  authorizedParties: readonly string[] | undefined,
): boolean {
  if (!authorizedParties || authorizedParties.length === 0) {
    return true
  }
  return typeof claims.azp === 'string' && authorizedParties.includes(claims.azp)
}

function isAccessTokenJwtTyp(typ: string | undefined): boolean {
  return typ === 'at+jwt' || typ === 'application/at+jwt'
}

export async function verifyToken(
  token: string,
  options: VerifyTokenOptions,
): Promise<Result<AccessTokenClaims, VerifyTokenError>> {
  if (!options.jwtKey) {
    throw new AppError(
      'missing_jwt_key',
      'verifyToken requires jwtKey for networkless verification',
    )
  }

  const keySet = await toVerifyKeySet(options.jwtKey)
  const verified = await verifyJwt(token, keySet, {
    now: options.now,
    clockToleranceSec: options.clockToleranceSec,
    expectedIssuer: options.issuer,
    expectedAudience: options.audience,
  })
  if (!verified.ok) {
    return { ok: false, error: verified.error.reason }
  }

  if (!isAccessTokenJwtTyp(verified.value.header.typ)) {
    return { ok: false, error: 'typ_mismatch' }
  }
  if (
    verified.value.payload.org_role !== undefined &&
    !isOrganizationMembershipRole(verified.value.payload.org_role)
  ) {
    return { ok: false, error: 'invalid_org_role' }
  }
  const claims = verified.value.payload as AccessTokenClaims
  if (!checkAuthorizedParties(claims, options.authorizedParties)) {
    return { ok: false, error: 'azp_mismatch' }
  }

  return { ok: true, value: claims }
}
