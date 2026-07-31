import {
  importJwkForVerify,
  verifyJwt,
  type JwtClaims,
  type PublicJwk,
  type VerifyKeySet,
} from '@xid-kit/crypto'

const JWKS_CACHE_TTL_MILLISECONDS = 3_600_000
const SIGNING_ALGORITHMS = new Set(['ES256', 'RS256', 'PS256'])

type CachedKeySet = {
  expiresAt: number
  keySet: VerifyKeySet
}

const keySetCache = new Map<string, CachedKeySet>()

export type NativeIdTokenClaims = JwtClaims & {
  iss: string
  sub: string
  aud: string | readonly string[]
  exp: number
  iat: number
  nonce?: string
  sid?: string
  azp?: string
  email?: string
  email_verified?: boolean
  name?: string
  given_name?: string
  family_name?: string
  picture?: string
  phone_number?: string
  phone_number_verified?: boolean
  org_id?: string
  org_slug?: string
  org_name?: string
  provisioned_by?: string
}

export type VerifyNativeIdTokenInput = {
  issuer: string
  clientId: string
  expectedNonce?: string
  fetcher?: typeof fetch
}

export async function verifyNativeIdToken(
  idToken: string,
  input: VerifyNativeIdTokenInput,
): Promise<NativeIdTokenClaims> {
  const issuer = input.issuer.replace(/\/+$/, '')
  const jwksUri = new URL('/jwks', `${issuer}/`).toString()
  let keySet = await loadKeySet(jwksUri, input.fetcher ?? fetch, false)
  let result = await verifyJwt(idToken, keySet, {
    expectedIssuer: issuer,
    expectedAudience: input.clientId,
  })
  if (!result.ok && result.error.reason === 'unknown_kid') {
    keySet = await loadKeySet(jwksUri, input.fetcher ?? fetch, true)
    result = await verifyJwt(idToken, keySet, {
      expectedIssuer: issuer,
      expectedAudience: input.clientId,
    })
  }
  if (!result.ok) {
    throw new Error(`[xid-kit/react-native] ID token verification failed: ${result.error.reason}`)
  }

  const claims = result.value.payload
  if (
    typeof claims.iss !== 'string' ||
    typeof claims.sub !== 'string' ||
    claims.sub.length === 0 ||
    (typeof claims.aud !== 'string' && !Array.isArray(claims.aud)) ||
    typeof claims.exp !== 'number' ||
    typeof claims.iat !== 'number'
  ) {
    throw new Error('[xid-kit/react-native] ID token is missing required OIDC claims.')
  }
  if (input.expectedNonce !== undefined && claims.nonce !== input.expectedNonce) {
    throw new Error('[xid-kit/react-native] ID token nonce mismatch.')
  }
  if (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== input.clientId) {
    throw new Error('[xid-kit/react-native] ID token azp mismatch.')
  }

  return claims as NativeIdTokenClaims
}

async function loadKeySet(
  jwksUri: string,
  fetcher: typeof fetch,
  forceRefresh: boolean,
): Promise<VerifyKeySet> {
  const cached = keySetCache.get(jwksUri)
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
    return cached.keySet
  }

  const response = await fetcher(jwksUri, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) {
    throw new Error(`[xid-kit/react-native] JWKS fetch failed (${response.status}).`)
  }
  const document = (await response.json()) as { keys?: unknown }
  if (!Array.isArray(document.keys)) {
    throw new Error('[xid-kit/react-native] JWKS response is missing keys.')
  }

  const keys = await Promise.all(
    document.keys.map(async (raw): Promise<VerifyKeySet['keys'][number] | null> => {
      if (!isPublicSigningJwk(raw)) return null
      try {
        const publicKey = await importJwkForVerify(raw)
        return { kid: raw.kid, alg: raw.alg, publicKey }
      } catch {
        return null
      }
    }),
  )
  const usableKeys = keys.filter((key): key is VerifyKeySet['keys'][number] => key !== null)
  if (usableKeys.length === 0) {
    throw new Error('[xid-kit/react-native] JWKS contains no usable signing keys.')
  }

  const keySet: VerifyKeySet = { keys: usableKeys }
  keySetCache.set(jwksUri, {
    expiresAt: Date.now() + JWKS_CACHE_TTL_MILLISECONDS,
    keySet,
  })
  return keySet
}

function isPublicSigningJwk(value: unknown): value is PublicJwk {
  if (typeof value !== 'object' || value === null) return false
  const jwk = value as Record<string, unknown>
  return (
    typeof jwk['kid'] === 'string' &&
    jwk['kid'].length > 0 &&
    typeof jwk['alg'] === 'string' &&
    SIGNING_ALGORITHMS.has(jwk['alg']) &&
    jwk['use'] === 'sig' &&
    typeof jwk['kty'] === 'string'
  )
}
