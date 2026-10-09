// Android Key attestation(WebAuthn L3 §8.4):x5c 叶证书签名 authData || clientDataHash,
// 叶证书公钥就是凭证公钥,KeyDescription 扩展的 attestationChallenge 等于 clientDataHash,
// 不得带 allApplications,且密钥在 Keystore 内生成(origin=GENERATED)并可用于签名(purpose 含 SIGN)。

import * as asn1js from 'asn1js'

import {
  asBytes,
  asInt,
  bytesEqual,
  certificateMatchesCredential,
  concat,
  parseX5c,
  statementAlgorithmFor,
  type StatementInput,
  type StatementVerification,
} from './attestation-shared'
import { verifyWithCertificateKey, type ParsedCertificate } from './x509'

const OID_ANDROID_KEY_DESCRIPTION = '1.3.6.1.4.1.11129.2.1.17'
const TAG_PURPOSE = 1
const TAG_ALL_APPLICATIONS = 600
const TAG_ORIGIN = 702
const KM_PURPOSE_SIGN = 2
const KM_ORIGIN_GENERATED = 0

type KeyDescription = {
  attestationChallenge: Uint8Array
  authorizationLists: readonly asn1js.Sequence[]
}

function parseKeyDescription(cert: ParsedCertificate): KeyDescription | null {
  const extension = cert.extensions.get(OID_ANDROID_KEY_DESCRIPTION)
  if (!extension) return null
  const decoded = asn1js.fromBER(extension.value)
  if (decoded.offset === -1 || !(decoded.result instanceof asn1js.Sequence)) return null
  const fields = decoded.result.valueBlock.value
  const challenge = fields[4]
  const software = fields[6]
  const tee = fields[7]
  if (!(challenge instanceof asn1js.OctetString)) return null
  if (!(software instanceof asn1js.Sequence) || !(tee instanceof asn1js.Sequence)) return null
  return {
    attestationChallenge: new Uint8Array(challenge.valueBlock.valueHexView),
    authorizationLists: [software, tee],
  }
}

function taggedEntries(lists: readonly asn1js.Sequence[], tag: number): asn1js.BaseBlock[] {
  return lists.flatMap((list) =>
    list.valueBlock.value.filter(
      (entry) => entry.idBlock.tagClass === 3 && entry.idBlock.tagNumber === tag,
    ),
  )
}

function explicitInner(entry: asn1js.BaseBlock): asn1js.BaseBlock | undefined {
  return entry instanceof asn1js.Constructed ? entry.valueBlock.value[0] : undefined
}

function integerValue(block: asn1js.BaseBlock | undefined): number | null {
  return block instanceof asn1js.Integer ? block.valueBlock.valueDec : null
}

function authorizationProblem(lists: readonly asn1js.Sequence[]): string | null {
  if (taggedEntries(lists, TAG_ALL_APPLICATIONS).length > 0) {
    return 'android key must not be bound to all applications'
  }
  const origins = taggedEntries(lists, TAG_ORIGIN).map((entry) =>
    integerValue(explicitInner(entry)),
  )
  if (origins.length === 0 || origins.some((origin) => origin !== KM_ORIGIN_GENERATED)) {
    return 'android key was not generated inside the keystore'
  }
  const purposes = taggedEntries(lists, TAG_PURPOSE).flatMap((entry) => {
    const set = explicitInner(entry)
    return set instanceof asn1js.Set ? set.valueBlock.value.map(integerValue) : []
  })
  if (!purposes.includes(KM_PURPOSE_SIGN)) return 'android key is not a signing key'
  return null
}

export async function verifyAndroidKeyStatement(
  input: StatementInput,
): Promise<StatementVerification> {
  const alg = asInt(input.attStmt.get('alg'))
  const sig = asBytes(input.attStmt.get('sig'))
  const certificates = parseX5c(input.attStmt)
  if (!certificates) return { ok: false, reason: 'android-key attestation requires x5c' }
  const leaf = certificates[0]!
  const algorithm = statementAlgorithmFor(alg, leaf.key)
  if (!algorithm) return { ok: false, reason: 'attestation alg does not match certificate key' }
  const signed = await verifyWithCertificateKey({
    key: leaf.key,
    hash: algorithm.hash,
    signature: sig,
    data: concat(input.authData, input.clientDataHash),
  })
  if (!signed) return { ok: false, reason: 'attestation signature invalid' }
  if (!(await certificateMatchesCredential(leaf, input.parsed.attestedCredentialData))) {
    return { ok: false, reason: 'android-key certificate key does not match credential' }
  }
  const description = parseKeyDescription(leaf)
  if (!description) return { ok: false, reason: 'android key description missing' }
  if (!bytesEqual(description.attestationChallenge, input.clientDataHash)) {
    return { ok: false, reason: 'android attestation challenge mismatch' }
  }
  const problem = authorizationProblem(description.authorizationLists)
  return problem ? { ok: false, reason: problem } : { ok: true, certificates }
}
