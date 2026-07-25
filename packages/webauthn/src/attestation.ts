// Enterprise attestation verification(WebAuthn L3 attStmt + x5c chain)。
// 密码学原语只用 Web Crypto(crypto.subtle);可信根由调用方从 KV/env 注入。

import { toBufferSource } from '@xid-kit/crypto'
import type { Result, XidError } from '@xid-kit/types'

import type { CborMap, CborValue } from './cbor'
import { cborDecode } from './cbor'
import { webauthnError } from './errors'

export type AttestationConveyance = 'none' | 'indirect' | 'direct'

export type AttestationVerificationInput = {
  fmt: string
  attStmt: CborMap
  authData: Uint8Array
  clientDataJson: Uint8Array
  policy: AttestationConveyance
  trustedRootsPem?: readonly string[]
}

export type AttestationVerificationResult = {
  fmt: string
  verified: boolean
  trustPath: readonly string[]
}

function asBytes(value: CborValue | undefined): Uint8Array {
  if (value instanceof Uint8Array) return value
  throw new Error('attestation: expected byte string')
}

function asInt(value: CborValue | undefined): number {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  throw new Error('attestation: expected integer')
}

async function importX509Cert(der: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'spki',
    toBufferSource(der),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  )
}

async function verifyPackedSignature(
  attStmt: CborMap,
  authData: Uint8Array,
  clientDataJson: Uint8Array,
): Promise<boolean> {
  const alg = asInt(attStmt.get('alg'))
  const sig = asBytes(attStmt.get('sig'))
  const x5c = attStmt.get('x5c')
  if (!Array.isArray(x5c) || x5c.length === 0) return false
  const leafDer = asBytes(x5c[0])
  let key: CryptoKey
  try {
    key = await importX509Cert(leafDer)
  } catch {
    return false
  }
  const clientDataHash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', toBufferSource(clientDataJson)),
  )
  const signed = new Uint8Array(authData.length + clientDataHash.length)
  signed.set(authData, 0)
  signed.set(clientDataHash, authData.length)
  if (alg !== -7) return false
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    toBufferSource(sig),
    toBufferSource(signed),
  )
}

async function chainTrusted(
  attStmt: CborMap,
  trustedRootsPem: readonly string[],
): Promise<{ verified: boolean; trustPath: string[] }> {
  const x5c = attStmt.get('x5c')
  if (!Array.isArray(x5c) || x5c.length === 0) return { verified: false, trustPath: [] }
  const trusted = new Set(trustedRootsPem.map((pem) => pem.replace(/\s+/g, '').trim()))
  const trustPath: string[] = []
  for (const entry of x5c) {
    const der = asBytes(entry)
    const pem = `-----BEGIN CERTIFICATE-----\n${btoa(String.fromCharCode(...der))
      .match(/.{1,64}/g)
      ?.join('\n')}\n-----END CERTIFICATE-----`
    const normalized = pem.replace(/\s+/g, '').trim()
    trustPath.push(normalized.slice(0, 48))
    if (trusted.has(normalized)) return { verified: true, trustPath }
  }
  return { verified: false, trustPath }
}

export async function verifyEnterpriseAttestation(
  input: AttestationVerificationInput,
): Promise<Result<AttestationVerificationResult, XidError>> {
  if (input.policy === 'none' || input.fmt === 'none') {
    return {
      ok: true,
      value: { fmt: input.fmt, verified: false, trustPath: [] },
    }
  }

  if (input.fmt !== 'packed') {
    return {
      ok: false,
      error: webauthnError('invalid_credentials', `unsupported attestation fmt ${input.fmt}`),
    }
  }

  const trustedRoots = input.trustedRootsPem ?? []
  if (input.policy === 'direct' && trustedRoots.length === 0) {
    return {
      ok: false,
      error: webauthnError('invalid_credentials', 'trusted attestation roots not configured'),
    }
  }

  const sigOk = await verifyPackedSignature(input.attStmt, input.authData, input.clientDataJson)
  if (!sigOk) {
    return {
      ok: false,
      error: webauthnError('invalid_credentials', 'attestation signature invalid'),
    }
  }

  const chain = await chainTrusted(input.attStmt, trustedRoots)

  if (input.policy === 'direct') {
    if (!chain.verified) {
      return {
        ok: false,
        error: webauthnError('invalid_credentials', 'attestation certificate chain untrusted'),
      }
    }
    return {
      ok: true,
      value: {
        fmt: input.fmt,
        verified: true,
        trustPath: chain.trustPath,
      },
    }
  }

  if (!chain.verified && trustedRoots.length > 0) {
    return {
      ok: false,
      error: webauthnError('invalid_credentials', 'attestation certificate chain untrusted'),
    }
  }

  return {
    ok: true,
    value: {
      fmt: input.fmt,
      verified: chain.verified || sigOk,
      trustPath: chain.trustPath,
    },
  }
}

export function parseAttestationStatement(attestationObject: Uint8Array): {
  fmt: string
  attStmt: CborMap
  authData: Uint8Array
} {
  const decoded = cborDecode(attestationObject)
  if (!(decoded instanceof Map)) throw new Error('attestationObject: not a CBOR map')
  const map = decoded as CborMap
  const fmt = map.get('fmt')
  const attStmt = map.get('attStmt')
  const authData = map.get('authData')
  if (typeof fmt !== 'string') throw new Error('attestationObject: missing fmt')
  if (!(attStmt instanceof Map)) throw new Error('attestationObject: missing attStmt')
  if (!(authData instanceof Uint8Array)) throw new Error('attestationObject: missing authData')
  return { fmt, attStmt: attStmt as CborMap, authData }
}
