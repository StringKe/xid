// attestation 按租户策略判定。可信根由调用方注入,本模块不内置根证书。
// - none:不校验,verified=false。
// - indirect:可校验格式(packed、fido-u2f、tpm、android-key、apple)的语句必须成立;链抵达可信根
//   才 verified=true。fmt=none、packed 自签名与未知格式按 none 处理。
// - direct:必须是可校验格式,语句成立且链抵达已配置的可信根,否则拒绝注册。
// android-safetynet 已被 Google 停用,indirect 与 direct 下都拒绝。

import { toBufferSource } from '@xid-kit/crypto'
import type { Result, XidError } from '@xid-kit/types'

import { verifyAndroidKeyStatement } from './attestation-android-key'
import { verifyAppleStatement } from './attestation-apple'
import { verifyFidoU2fStatement, verifyPackedStatement } from './attestation-formats'
import type { StatementInput, StatementVerification } from './attestation-shared'
import { verifyTpmStatement } from './attestation-tpm'
import { parseAuthData } from './authdata'
import type { CborMap } from './cbor'
import { cborDecode } from './cbor'
import { webauthnError } from './errors'
import { parseCertificate, pemToDerList, verifyCertificateChain } from './x509'

export type AttestationConveyance = 'none' | 'indirect' | 'direct'

const STATEMENT_VERIFIERS: Readonly<
  Record<string, (input: StatementInput) => Promise<StatementVerification>>
> = {
  packed: verifyPackedStatement,
  'fido-u2f': verifyFidoU2fStatement,
  tpm: verifyTpmStatement,
  'android-key': verifyAndroidKeyStatement,
  apple: verifyAppleStatement,
}

export const VERIFIABLE_ATTESTATION_FORMATS = Object.keys(STATEMENT_VERIFIERS)

const REJECTED_ATTESTATION_FORMATS: ReadonlySet<string> = new Set(['android-safetynet'])

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
  return Object.hasOwn(STATEMENT_VERIFIERS, fmt)
}

async function verifyStatement(
  input: AttestationVerificationInput,
): Promise<StatementVerification> {
  const verifier = STATEMENT_VERIFIERS[input.fmt]
  if (!verifier) return { ok: false, reason: `attestation fmt ${input.fmt} is not verifiable` }
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
  return verifier(statementInput)
}

export function parseTrustedRoots(trustedRootsPem: readonly string[]) {
  return trustedRootsPem.flatMap(pemToDerList).map(parseCertificate)
}

export async function verifyEnterpriseAttestation(
  input: AttestationVerificationInput,
): Promise<AttestationResult> {
  if (input.policy === 'none') return accepted(input.fmt)
  const direct = input.policy === 'direct'
  if (REJECTED_ATTESTATION_FORMATS.has(input.fmt)) {
    return rejected(`attestation fmt ${input.fmt} is not accepted`)
  }
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
