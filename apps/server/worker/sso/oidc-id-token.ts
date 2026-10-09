// 上游企业 IdP 的 id_token 校验(OIDC Core 3.1.3.7)与 claims -> SsoAssertion 映射。

import { verifyJwt } from '@xid-kit/crypto'
import type { VerifyKeySet } from '@xid-kit/crypto'
import { AppError } from '../lib/errors'
import type { SsoAssertion } from './jit'
import type { ProviderKeyLoader } from './oidc-provider-jwks'

type VerifyIdTokenParams = {
  idToken: string
  loadKeys: ProviderKeyLoader
  expectedIssuer: string
  expectedAudience: string
  expectedNonce: string
}

function idTokenInvalid(reason: string): AppError {
  return new AppError('signature_invalid', {
    longMessage: `id_token verification failed: ${reason}`,
  })
}

async function verifyWithKeys(
  p: VerifyIdTokenParams,
  keySet: VerifyKeySet,
): ReturnType<typeof verifyJwt> {
  return verifyJwt(p.idToken, keySet, {
    expectedIssuer: p.expectedIssuer,
    expectedAudience: p.expectedAudience,
  })
}

// 未知 kid 说明 IdP 可能刚轮换密钥:限速强制刷新一次 JWKS 后重验。
async function verifySignature(p: VerifyIdTokenParams): Promise<Record<string, unknown>> {
  const cachedKeys = await p.loadKeys(false)
  if (!cachedKeys) throw idTokenInvalid('no_keys')
  let result = await verifyWithKeys(p, cachedKeys)
  if (!result.ok && result.error.reason === 'unknown_kid') {
    const refreshedKeys = await p.loadKeys(true)
    if (refreshedKeys) result = await verifyWithKeys(p, refreshedKeys)
  }
  if (!result.ok) throw idTokenInvalid(result.error.reason)
  return result.value.payload as Record<string, unknown>
}

// verifyJwt 只在 exp/iat 存在时检查;OIDC Core 要求两者必有,多 aud 时 azp 必须是本 client。
export function checkIdTokenClaims(claims: Record<string, unknown>, clientId: string): void {
  if (typeof claims['exp'] !== 'number' || !Number.isFinite(claims['exp'])) {
    throw idTokenInvalid('exp_missing')
  }
  if (typeof claims['iat'] !== 'number' || !Number.isFinite(claims['iat'])) {
    throw idTokenInvalid('iat_missing')
  }
  const aud = claims['aud']
  const azp = claims['azp']
  if (Array.isArray(aud) && aud.length > 1 && azp === undefined) {
    throw idTokenInvalid('azp_missing')
  }
  if (azp !== undefined && azp !== clientId) throw idTokenInvalid('azp_mismatch')
}

// 验证 id_token 并返回 claims(签名 + exp/iat/azp + nonce + sub)。
export async function verifyIdToken(p: VerifyIdTokenParams): Promise<Record<string, unknown>> {
  const claims = await verifySignature(p)
  checkIdTokenClaims(claims, p.expectedAudience)
  if (claims['nonce'] !== p.expectedNonce) {
    throw new AppError('signature_invalid', { longMessage: 'nonce_mismatch' })
  }
  if (typeof claims['sub'] !== 'string' || !claims['sub']) {
    throw new AppError('malformed_request', { longMessage: 'id_token missing sub' })
  }
  return claims
}

const STANDARD_CLAIMS = {
  email: 'email',
  firstName: 'given_name',
  lastName: 'family_name',
  groups: 'groups',
} as const

type MappedField = keyof typeof STANDARD_CLAIMS

function mappedClaimName(mapping: Record<string, unknown>, field: MappedField): string | null {
  const name = mapping[field]
  return typeof name === 'string' && name.length > 0 ? name : null
}

// 连接配置的 claim 名优先;配置的 claim 不在 id_token 里时回退标准 claim。
function readStringClaim(
  claims: Record<string, unknown>,
  mapping: Record<string, unknown>,
  field: Exclude<MappedField, 'groups'>,
): string | null {
  const configured = mappedClaimName(mapping, field)
  const value = configured === null ? undefined : claims[configured]
  if (typeof value === 'string' && value.length > 0) return value
  const standard = claims[STANDARD_CLAIMS[field]]
  return typeof standard === 'string' && standard.length > 0 ? standard : null
}

function readGroupsClaim(
  claims: Record<string, unknown>,
  mapping: Record<string, unknown>,
): string[] {
  const configured = mappedClaimName(mapping, 'groups')
  const value =
    configured !== null && claims[configured] !== undefined
      ? claims[configured]
      : claims[STANDARD_CLAIMS.groups]
  if (typeof value === 'string') return [value]
  return Array.isArray(value) ? value.filter((g): g is string => typeof g === 'string') : []
}

type ClaimsToAssertionInput = {
  claims: Record<string, unknown>
  connectionId: string
  orgId: string
  attributeMapping: unknown
}

function idpIdClaimValue(value: unknown): string | null {
  if (typeof value === 'string') return value.trim().length > 0 ? value : null
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : null
}

// 配置了 idpId claim 时用它作稳定主键,缺值拒绝(回退 sub 会给同一个人建出第二个身份);
// 未配置时用 sub。按 sub 建立的旧绑定经 legacyIdpId 由 JIT 沿用并补绑。
function resolveIdpId(
  claims: Record<string, unknown>,
  mapping: Record<string, unknown>,
): { idpId: string; legacyIdpId: string | null } {
  const sub = typeof claims['sub'] === 'string' ? claims['sub'] : ''
  const configured = mapping['idpId']
  if (typeof configured !== 'string' || configured.trim().length === 0) {
    return { idpId: sub, legacyIdpId: null }
  }
  const value = idpIdClaimValue(claims[configured])
  if (value === null) {
    throw new AppError('malformed_request', {
      httpStatus: 400,
      longMessage: 'oidc:idp_id_claim_missing',
    })
  }
  return { idpId: value, legacyIdpId: sub && value !== sub ? sub : null }
}

export function claimsToAssertion(input: ClaimsToAssertionInput): SsoAssertion {
  const { claims } = input
  const mapping =
    input.attributeMapping && typeof input.attributeMapping === 'object'
      ? (input.attributeMapping as Record<string, unknown>)
      : {}
  const email = readStringClaim(claims, mapping, 'email')
  const { idpId, legacyIdpId } = resolveIdpId(claims, mapping)
  return {
    idpId,
    ...(legacyIdpId ? { legacyIdpId } : {}),
    connectionId: input.connectionId,
    orgId: input.orgId,
    email,
    // email_verified 只为标准 email claim 作证,映射到其他 claim 的值不继承这个声明。
    emailVerified: claims['email_verified'] === true && email !== null && email === claims['email'],
    firstName: readStringClaim(claims, mapping, 'firstName'),
    lastName: readStringClaim(claims, mapping, 'lastName'),
    groups: readGroupsClaim(claims, mapping),
    customAttributes: {},
  }
}
