// attestation 按租户策略判定。可信根由调用方注入,本模块不内置根证书。
// - none:不校验,verified=false。
// - indirect:能校验的格式(packed、fido-u2f)签名必须成立;链抵达可信根才 verified=true,
//   fmt=none、自签名与暂不支持的格式(tpm、android-key、android-safetynet、apple)按 none 处理。
// - direct:必须是可校验格式,签名成立且链抵达已配置的可信根,否则拒绝注册。

import { toBufferSource } from '@xid-kit/crypto'
import type { Result, XidError } from '@xid-kit/types'

import {
  verifyFidoU2fStatement,
  verifyPackedStatement,
  type StatementVerification,
} from './attestation-formats'
import { parseAuthData } from './authdata'
import type { CborMap } from './cbor'
import { cborDecode } from './cbor'
import { webauthnError } from './errors'
import { parseCertificate, pemToDerList, verifyCertificateChain } from './x509'

export type AttestationConveyance = 'none' | 'indirect' | 'direct'

export const VERIFIABLE_ATTESTATION_FORMATS = ['packed', 'fido-u2f'] as const

export type AttestationVerificationInput = {
  fmt: string
  attStmt: CborMap
  authData: Uint8Array
  clientDataJson: Uint8Array
  policy: AttestationConveyance
  trustedRootsPem?: readonly string[]
  now?: Date
}

export type AttestationVerificationResult = {
  fmt: string
  verified: boolean
  trustPath: readonly string[]
}

type AttestationResult = Result<AttestationVerificationResult, XidError>

function accepted(fmt: string, verified = false, trustPath: readonly string[] = []) {
  return { ok: true, value: { fmt, verified, trustPath } } as const
}

function rejected(message: string): AttestationResult {
  return { ok: false, error: webauthnError('invalid_credentials', message) }
}

function isVerifiableFormat(fmt: string): boolean {
  return (VERIFIABLE_ATTESTATION_FORMATS as readonly string[]).includes(fmt)
}

async function verifyStatement(
  input: AttestationVerificationInput,
): Promise<StatementVerification> {
  const parsed = await parseAuthData(input.authData)
  const attested = parsed.attestedCredentialData
  if (!attested) return { ok: false, reason: 'missing attested credential data' }
  const clientDataHash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', toBufferSource(input.clientDataJson)),
  )
  const statementInput = {
    attStmt: input.attStmt,
    authData: input.authData,
    parsed: { ...parsed, attestedCredentialData: attested },
    clientDataHash,
  }
  return input.fmt === 'fido-u2f'
    ? verifyFidoU2fStatement(statementInput)
    : verifyPackedStatement(statementInput)
}

export function parseTrustedRoots(trustedRootsPem: readonly string[]) {
  return trustedRootsPem.flatMap(pemToDerList).map(parseCertificate)
}

export async function verifyEnterpriseAttestation(
  input: AttestationVerificationInput,
): Promise<AttestationResult> {
  if (input.policy === 'none') return accepted(input.fmt)
  const direct = input.policy === 'direct'
  if (!isVerifiableFormat(input.fmt)) {
    return direct ? rejected(`attestation fmt ${input.fmt} is not verifiable`) : accepted(input.fmt)
  }
  const trustedRoots = parseTrustedRoots(input.trustedRootsPem ?? [])
  if (direct && trustedRoots.length === 0) {
    return rejected('trusted attestation roots not configured')
  }

  const statement = await verifyStatement(input)
  if (!statement.ok) return rejected(statement.reason)
  if (!statement.certificates) {
    return direct ? rejected('self attestation has no certificate chain') : accepted(input.fmt)
  }

  const chain = await verifyCertificateChain({
    chain: statement.certificates,
    trustedRoots,
    now: input.now ?? new Date(),
  })
  if (direct && !chain.verified) return rejected('attestation certificate chain untrusted')
  return accepted(input.fmt, chain.verified, chain.trustPath)
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
