import type { SigningAlg } from '@xid-kit/types'
import type { Result } from '@xid-kit/types'

const PRIVATE_OR_SYMMETRIC_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'] as const
const BASE64URL_VALUE = /^[A-Za-z0-9_-]+$/u

export type NormalizedPublicJwk = JsonWebKey & {
  kid: string
  use: 'sig'
  key_ops: ['verify']
  alg: SigningAlg
  kty: 'EC' | 'RSA'
}

export type NormalizedPublicJwks = {
  keys: NormalizedPublicJwk[]
}

export type PublicJwksError = {
  message: string
}

function fail(message: string): Result<never, PublicJwksError> {
  return { ok: false, error: { message } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredBase64Url(
  key: Record<string, unknown>,
  name: string,
): Result<string, PublicJwksError> {
  const value = key[name]
  if (typeof value !== 'string' || value.length === 0 || !BASE64URL_VALUE.test(value)) {
    return fail(`jwks key ${name} must be a non-empty base64url value`)
  }
  return { ok: true, value }
}

function normalizeKeyOps(value: unknown): Result<['verify'], PublicJwksError> {
  if (value === undefined) return { ok: true, value: ['verify'] }
  if (!Array.isArray(value) || value.length !== 1 || value[0] !== 'verify') {
    return fail('jwks key_ops must contain only verify')
  }
  return { ok: true, value: ['verify'] }
}

function normalizePublicJwk(
  value: unknown,
  index: number,
): Result<NormalizedPublicJwk, PublicJwksError> {
  if (!isRecord(value)) return fail(`jwks keys[${index}] must be an object`)
  for (const member of PRIVATE_OR_SYMMETRIC_MEMBERS) {
    if (Object.hasOwn(value, member)) {
      return fail(`jwks keys[${index}] must not contain private or symmetric member ${member}`)
    }
  }

  const rawKid = value['kid']
  if (typeof rawKid !== 'string' || rawKid.trim().length === 0) {
    return fail(`jwks keys[${index}].kid must be a non-empty string`)
  }
  const kid = rawKid.trim()
  if (value['use'] !== undefined && value['use'] !== 'sig') {
    return fail(`jwks keys[${index}].use must be sig`)
  }
  const keyOps = normalizeKeyOps(value['key_ops'])
  if (!keyOps.ok) return keyOps

  const alg = value['alg']
  const kty = value['kty']
  if (alg === 'ES256') {
    if (kty !== 'EC' || value['crv'] !== 'P-256') {
      return fail(`jwks keys[${index}] ES256 requires EC P-256`)
    }
    const x = requiredBase64Url(value, 'x')
    if (!x.ok) return x
    const y = requiredBase64Url(value, 'y')
    if (!y.ok) return y
    return {
      ok: true,
      value: {
        kid,
        use: 'sig',
        key_ops: keyOps.value,
        alg,
        kty,
        crv: 'P-256',
        x: x.value,
        y: y.value,
      },
    }
  }
  if (alg === 'RS256' || alg === 'PS256') {
    if (kty !== 'RSA') {
      return fail(`jwks keys[${index}] ${alg} requires RSA`)
    }
    const n = requiredBase64Url(value, 'n')
    if (!n.ok) return n
    const e = requiredBase64Url(value, 'e')
    if (!e.ok) return e
    return {
      ok: true,
      value: {
        kid,
        use: 'sig',
        key_ops: keyOps.value,
        alg,
        kty,
        n: n.value,
        e: e.value,
      },
    }
  }
  return fail(`jwks keys[${index}].alg must be ES256, RS256, or PS256`)
}

export function normalizePublicJwks(value: unknown): Result<NormalizedPublicJwks, PublicJwksError> {
  if (!isRecord(value) || !Array.isArray(value['keys']) || value['keys'].length === 0) {
    return fail('jwks.keys must be a non-empty array')
  }
  const keys: NormalizedPublicJwk[] = []
  const kids = new Set<string>()
  for (const [index, rawKey] of value['keys'].entries()) {
    const normalized = normalizePublicJwk(rawKey, index)
    if (!normalized.ok) return normalized
    if (kids.has(normalized.value.kid)) {
      return fail(`jwks kid must be unique: ${normalized.value.kid}`)
    }
    kids.add(normalized.value.kid)
    keys.push(normalized.value)
  }
  return { ok: true, value: { keys } }
}
