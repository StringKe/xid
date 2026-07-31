// verifyToken:低层 networkless JWT 验证(见 api-sdk-conventions rule、signing-keys rule)。
// 铁律:传 jwtKey(JWKS 公钥)本地验签跳过网络(@xid-kit/crypto verifyJwt),不回源;Edge 冷启动关键。
// 校验 iss/exp/nbf/azp(见 06 章 6 节);可预期失败返回 Result,不抛(意外/配置误用才 throw AppError)。

import { isOrganizationMembershipRole, type AccessTokenClaims, type Result } from '@xid-kit/types'
import type { JwtVerifyError } from '@xid-kit/crypto'
import { verifyJwt } from '@xid-kit/crypto'

import { AppError } from './errors'
import type { JwtKey } from './jwks'
import { toVerifyKeySet } from './jwks'

// 验证失败原因:复用 crypto JwtVerifyError 的 reason,加 SDK 层 access token profile/claims 校验。
export type VerifyTokenError =
  | JwtVerifyError['reason']
  | 'typ_mismatch'
  | 'azp_mismatch'
  | 'invalid_org_role'

export type VerifyTokenOptions = {
  // networkless 公钥(必传):单条 JWK / JWKS / 已导入 CryptoKey。无 jwtKey -> throw(不静默回源)。
  jwtKey: JwtKey
  // 期望 issuer(`https://{tenant}.xid.dev`),提供则强校验 iss。
  issuer?: string
  // 期望 audience,提供则校验 aud 含此值。
  audience?: string
  // 授权方白名单:校验 token.azp ∈ authorizedParties(防 token 被其它 client 重用)。
  authorizedParties?: readonly string[]
  // exp/nbf 容忍偏差(秒),默认 60。
  clockToleranceSec?: number
  // 当前时间(秒),默认 now。测试注入用。
  now?: number
}

// 校验 azp:token 的授权方必须在调用方白名单内(见 06 章:验证 JWT azp)。
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

// networkless 验证 access token。签名/exp/nbf/iss/aud 走 crypto verifyJwt,azp 走 SDK 层。
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
