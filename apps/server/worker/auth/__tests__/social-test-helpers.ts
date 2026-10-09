import { exportPublicJwk, generateTenantSigningKey, signJwt } from '@xid-kit/crypto'
import { vi } from 'vitest'
import type { ProviderConfig } from '../social-providers'

export function makeKv(): KVNamespace {
  const store = new Map<string, string>()
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value)
    }),
  } as unknown as KVNamespace
}

export async function setupProviderJwt(input: {
  issuer: string
  audience: string
  nonce: string
  claims?: Record<string, unknown>
  alg?: 'ES256' | 'RS256'
  kid?: string
}) {
  const alg = input.alg ?? 'ES256'
  const { material, signingKey } = await generateTenantSigningKey({
    kid: input.kid ?? 'provider-kid',
    kekRaw: crypto.getRandomValues(new Uint8Array(32)),
    kekVersion: 1,
    alg,
  })
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    material.publicKeyJwk,
    alg === 'ES256'
      ? { name: 'ECDSA', namedCurve: 'P-256' }
      : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    true,
    ['verify'],
  )
  const jwk = await exportPublicJwk(publicKey, material.kid, material.alg)
  const now = Math.floor(Date.now() / 1000)
  const idToken = await signJwt(
    {
      header: { alg, kid: material.kid },
      payload: {
        iss: input.issuer,
        aud: input.audience,
        exp: now + 300,
        iat: now,
        nonce: input.nonce,
        sub: 'provider-user-1',
        email: 'user@example.com',
        email_verified: true,
        name: 'Provider User',
        ...input.claims,
      },
    },
    signingKey,
  )
  return { idToken, jwks: { keys: [jwk] } }
}

export function makeConfig(input: {
  issuer: string
  jwksUri: string
  clientId: string
}): ProviderConfig {
  return {
    authorizationEndpoint: `${input.issuer}/authorize`,
    tokenEndpoint: `${input.issuer}/token`,
    clientId: input.clientId,
    clientSecret: 'secret',
    scopes: ['openid', 'email', 'profile'],
    usesPkce: true,
    issuer: input.issuer,
    jwksUri: input.jwksUri,
  }
}
