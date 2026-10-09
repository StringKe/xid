// TPM attestation(WebAuthn L3 §8.3):pubArea 与凭证公钥一致;certInfo 是 TPM_ST_ATTEST_CERTIFY,
// extraData 等于 hash(authData || clientDataHash),attested.name 等于 nameAlg || H(pubArea);
// AIK 证书签名 certInfo,且满足 §8.3.1 的证书要求。链校验由 attestation.ts 完成。

import { base64UrlEncode } from '@xid-kit/crypto'
import { AsnConvert } from '@peculiar/asn1-schema'
import {
  ExtendedKeyUsage,
  SubjectAlternativeName,
  id_ce_extKeyUsage,
  id_ce_subjectAltName,
} from '@peculiar/asn1-x509'

import {
  asBytes,
  asInt,
  bytesEqual,
  concat,
  credentialPublicKey,
  parseX5c,
  publicKeysEqual,
  sha,
  statementAlgorithmFor,
  type CredentialPublicKey,
  type StatementInput,
  type StatementVerification,
} from './attestation-shared'
import {
  TPM_ALG_ECC,
  TPM_ECC_CURVES,
  TPM_HASH_ALGS,
  parseTpmAttest,
  parseTpmPublic,
  type TpmPublic,
} from './tpm-structures'
import { certificateAaguid, verifyWithCertificateKey, type ParsedCertificate } from './x509'

const TPM_GENERATED_VALUE = 0xff544347
const TPM_ST_ATTEST_CERTIFY = 0x8017
const OID_TCG_KP_AIK_CERTIFICATE = '2.23.133.8.3'
const OID_TCG_AT_TPM_MANUFACTURER = '2.23.133.2.1'
const EMPTY_NAME_DER = new Uint8Array([0x30, 0x00])

const COSE_CURVES: Readonly<Record<number, string>> = {
  [-7]: 'P-256',
  [-35]: 'P-384',
  [-36]: 'P-521',
}

function tpmPublicKey(pub: TpmPublic): CredentialPublicKey {
  if (pub.type === TPM_ALG_ECC) {
    return { kty: 'EC', x: base64UrlEncode(pub.x), y: base64UrlEncode(pub.y) }
  }
  const exponent = new Uint8Array([
    (pub.exponent >>> 24) & 0xff,
    (pub.exponent >>> 16) & 0xff,
    (pub.exponent >>> 8) & 0xff,
    pub.exponent & 0xff,
  ])
  let start = 0
  while (start < exponent.length - 1 && exponent[start] === 0) start++
  let modulusStart = 0
  while (modulusStart < pub.modulus.length - 1 && pub.modulus[modulusStart] === 0) modulusStart++
  return {
    kty: 'RSA',
    n: base64UrlEncode(pub.modulus.subarray(modulusStart)),
    e: base64UrlEncode(exponent.subarray(start)),
  }
}

function pubAreaMatchesCredential(pub: TpmPublic, input: StatementInput): boolean {
  const credential = credentialPublicKey(input.parsed.attestedCredentialData)
  if (!credential || !publicKeysEqual(tpmPublicKey(pub), credential)) return false
  if (pub.type !== TPM_ALG_ECC) return true
  return (
    TPM_ECC_CURVES[pub.curveId] === COSE_CURVES[input.parsed.attestedCredentialData.coseKey.alg]
  )
}

function sanHasTpmManufacturer(cert: ParsedCertificate): boolean {
  const extension = cert.extensions.get(id_ce_subjectAltName)
  if (!extension) return false
  const names = AsnConvert.parse(extension.value, SubjectAlternativeName)
  return names.some((name) =>
    (name.directoryName ?? []).some((rdn) =>
      rdn.some((attribute) => attribute.type === OID_TCG_AT_TPM_MANUFACTURER),
    ),
  )
}

// §8.3.1:v3、subject 为空、SAN 含 TPM 厂商、EKU 含 tcg-kp-AIKCertificate、非 CA、AAGUID 一致。
function aikCertificateProblem(cert: ParsedCertificate, aaguid: Uint8Array): string | null {
  if (cert.version !== 3) return 'AIK certificate must be X.509 v3'
  if (!bytesEqual(cert.subject, EMPTY_NAME_DER)) return 'AIK certificate subject must be empty'
  if (!sanHasTpmManufacturer(cert)) return 'AIK certificate lacks TPM subject alternative name'
  const eku = cert.extensions.get(id_ce_extKeyUsage)
  if (!eku || !AsnConvert.parse(eku.value, ExtendedKeyUsage).includes(OID_TCG_KP_AIK_CERTIFICATE)) {
    return 'AIK certificate lacks tcg-kp-AIKCertificate usage'
  }
  if (cert.basicConstraints?.isCa) return 'AIK certificate must not be a CA'
  const certAaguid = certificateAaguid(cert)
  if (certAaguid && !bytesEqual(certAaguid, aaguid)) return 'attestation aaguid mismatch'
  return null
}

async function certInfoProblem(
  input: StatementInput,
  hash: string,
  pubArea: Uint8Array,
  pub: TpmPublic,
): Promise<string | null> {
  const certInfo = parseTpmAttest(asBytes(input.attStmt.get('certInfo')))
  if (certInfo.magic !== TPM_GENERATED_VALUE) return 'certInfo magic invalid'
  if (certInfo.type !== TPM_ST_ATTEST_CERTIFY) return 'certInfo type invalid'
  const expectedExtraData = await sha(hash, concat(input.authData, input.clientDataHash))
  if (!bytesEqual(certInfo.extraData, expectedExtraData)) return 'certInfo extraData mismatch'
  const nameHash = TPM_HASH_ALGS[pub.nameAlg]
  if (!nameHash) return 'pubArea nameAlg unsupported'
  const name = concat(
    new Uint8Array([(pub.nameAlg >>> 8) & 0xff, pub.nameAlg & 0xff]),
    await sha(nameHash, pubArea),
  )
  return bytesEqual(certInfo.attestedName, name) ? null : 'certInfo name does not match pubArea'
}

export async function verifyTpmStatement(input: StatementInput): Promise<StatementVerification> {
  if (input.attStmt.get('ver') !== '2.0') return { ok: false, reason: 'tpm version must be 2.0' }
  if (input.attStmt.has('ecdaaKeyId')) return { ok: false, reason: 'ECDAA is not supported' }
  const alg = asInt(input.attStmt.get('alg'))
  const sig = asBytes(input.attStmt.get('sig'))
  const pubArea = asBytes(input.attStmt.get('pubArea'))
  const pub = parseTpmPublic(pubArea)
  if (!pubAreaMatchesCredential(pub, input)) {
    return { ok: false, reason: 'pubArea does not match credential public key' }
  }
  const certificates = parseX5c(input.attStmt)
  if (!certificates) return { ok: false, reason: 'tpm attestation requires x5c' }
  const aik = certificates[0]!
  const algorithm = statementAlgorithmFor(alg, aik.key)
  if (!algorithm) return { ok: false, reason: 'attestation alg does not match certificate key' }
  const certInfoIssue = await certInfoProblem(input, algorithm.hash, pubArea, pub)
  if (certInfoIssue) return { ok: false, reason: certInfoIssue }
  const signed = await verifyWithCertificateKey({
    key: aik.key,
    hash: algorithm.hash,
    signature: sig,
    data: asBytes(input.attStmt.get('certInfo')),
  })
  if (!signed) return { ok: false, reason: 'attestation signature invalid' }
  const problem = aikCertificateProblem(aik, input.parsed.attestedCredentialData.aaguid)
  return problem ? { ok: false, reason: problem } : { ok: true, certificates }
}
