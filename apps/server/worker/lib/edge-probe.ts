// Landing 边缘探针:返回真实 colo/TLS 元数据,并在本 Worker 上实测 ES256 JWT 验签耗时。
// jwksRoundTrips=0 对应 SDK networkless 验证路径(cached jwtKey,不回源 JWKS)。

import type { SigningAlg } from '@xid-kit/types'
import { signJwt, verifyJwt } from '@xid-kit/crypto'
import type { VerifyKey } from '@xid-kit/crypto'
import { EDGE_PROBE_TOKEN_TTL_SEC } from './ttl'

const PROBE_ISSUER = 'https://xid.dev'
const PROBE_SIGNING_ALG: SigningAlg = 'ES256'
const JWKS_ROUND_TRIPS = 0

export type EdgeProbePayload = {
  colo: string | null
  tlsVersion: string | null
  tlsCipher: string | null
  verifyUs: number
  signingAlg: SigningAlg
  accessTokenTtlSec: number
  jwksRoundTrips: number
}

type ProbeMaterial = {
  signingKey: CryptoKey
  verifyKey: VerifyKey
}

let cachedMaterial: ProbeMaterial | null = null

async function loadProbeMaterial(): Promise<ProbeMaterial> {
  if (cachedMaterial) return cachedMaterial
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'sign',
    'verify',
  ])
  cachedMaterial = {
    signingKey: pair.privateKey,
    verifyKey: { alg: PROBE_SIGNING_ALG, publicKey: pair.publicKey },
  }
  return cachedMaterial
}

async function signProbeToken(signingKey: CryptoKey): Promise<string> {
  const kid = 'edge-probe'
  const now = Math.floor(Date.now() / 1000)
  return signJwt(
    {
      header: { alg: PROBE_SIGNING_ALG, kid, typ: 'at+jwt' },
      payload: {
        iss: PROBE_ISSUER,
        sub: 'usr_probe',
        aud: 'probe',
        exp: now + EDGE_PROBE_TOKEN_TTL_SEC,
        iat: now,
        nbf: now,
        scope: 'openid',
      },
    },
    signingKey,
  )
}

export async function measureVerifyMicros(): Promise<number> {
  const { signingKey, verifyKey } = await loadProbeMaterial()
  const token = await signProbeToken(signingKey)
  const t0 = performance.now()
  const result = await verifyJwt(token, verifyKey, {
    expectedIssuer: PROBE_ISSUER,
    expectedAudience: 'probe',
  })
  if (!result.ok) throw new Error('edge probe verify failed')
  return Math.max(1, Math.round((performance.now() - t0) * 1000))
}

export async function buildEdgeProbePayload(
  cf: IncomingRequestCfProperties | undefined,
): Promise<EdgeProbePayload> {
  const verifyUs = await measureVerifyMicros()
  return {
    colo: cf?.colo ?? null,
    tlsVersion: typeof cf?.tlsVersion === 'string' ? cf.tlsVersion : null,
    tlsCipher: typeof cf?.tlsCipher === 'string' ? cf.tlsCipher : null,
    verifyUs,
    signingAlg: PROBE_SIGNING_ALG,
    accessTokenTtlSec: EDGE_PROBE_TOKEN_TTL_SEC,
    jwksRoundTrips: JWKS_ROUND_TRIPS,
  }
}
