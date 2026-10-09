// Apple Anonymous attestation(WebAuthn L3 §8.8):没有签名,凭证证书的 nonce 扩展必须等于
// SHA-256(authData || clientDataHash),证书公钥必须就是凭证公钥。链校验由 attestation.ts 完成。

import * as asn1js from 'asn1js'

import {
  bytesEqual,
  certificateMatchesCredential,
  concat,
  parseX5c,
  sha,
  type StatementInput,
  type StatementVerification,
} from './attestation-shared'
import type { ParsedCertificate } from './x509'

const OID_APPLE_NONCE = '1.2.840.113635.100.8.2'

// 扩展值:SEQUENCE { [1] EXPLICIT OCTET STRING nonce }
function appleNonce(cert: ParsedCertificate): Uint8Array | null {
  const extension = cert.extensions.get(OID_APPLE_NONCE)
  if (!extension) return null
  const decoded = asn1js.fromBER(extension.value)
  if (decoded.offset === -1 || !(decoded.result instanceof asn1js.Sequence)) return null
  const tagged = decoded.result.valueBlock.value[0]
  if (!(tagged instanceof asn1js.Constructed) || tagged.idBlock.tagNumber !== 1) return null
  const octets = tagged.valueBlock.value[0]
  if (!(octets instanceof asn1js.OctetString)) return null
  return new Uint8Array(octets.valueBlock.valueHexView)
}

export async function verifyAppleStatement(input: StatementInput): Promise<StatementVerification> {
  const certificates = parseX5c(input.attStmt)
  if (!certificates) return { ok: false, reason: 'apple attestation requires x5c' }
  const credCert = certificates[0]!
  const expected = await sha('SHA-256', concat(input.authData, input.clientDataHash))
  const nonce = appleNonce(credCert)
  if (!nonce || !bytesEqual(nonce, expected)) return { ok: false, reason: 'apple nonce mismatch' }
  if (!(await certificateMatchesCredential(credCert, input.parsed.attestedCredentialData))) {
    return { ok: false, reason: 'apple certificate key does not match credential' }
  }
  return { ok: true, certificates }
}
