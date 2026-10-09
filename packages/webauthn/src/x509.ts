// attestation 证书:ASN.1 解析交给 @peculiar/asn1-x509,签名校验只走 Web Crypto。
// 链校验:逐级验签到调用方注入的可信根,检查有效期、签发方 basicConstraints 与 pathLen。

import { toBufferSource } from '@xid-kit/crypto'
import { ECDSASigValue, ECParameters } from '@peculiar/asn1-ecc'
import { AsnConvert, OctetString } from '@peculiar/asn1-schema'
import { BasicConstraints, Certificate, id_ce_basicConstraints } from '@peculiar/asn1-x509'

const OID_EC_PUBLIC_KEY = '1.2.840.10045.2.1'
const OID_RSA_ENCRYPTION = '1.2.840.113549.1.1.1'
// FIDO 规定的 id-fido-gen-ce-aaguid 扩展,值为 OCTET STRING 包裹的 16 字节 AAGUID。
export const OID_FIDO_AAGUID = '1.3.6.1.4.1.45724.1.1.4'

const NAMED_CURVES: Readonly<Record<string, { name: string; coordBytes: number }>> = {
  '1.2.840.10045.3.1.7': { name: 'P-256', coordBytes: 32 },
  '1.3.132.0.34': { name: 'P-384', coordBytes: 48 },
  '1.3.132.0.35': { name: 'P-521', coordBytes: 66 },
}

const SIGNATURE_HASHES: Readonly<Record<string, { kind: CertificateKey['kind']; hash: string }>> = {
  '1.2.840.10045.4.3.2': { kind: 'ec', hash: 'SHA-256' },
  '1.2.840.10045.4.3.3': { kind: 'ec', hash: 'SHA-384' },
  '1.2.840.10045.4.3.4': { kind: 'ec', hash: 'SHA-512' },
  '1.2.840.113549.1.1.11': { kind: 'rsa', hash: 'SHA-256' },
  '1.2.840.113549.1.1.12': { kind: 'rsa', hash: 'SHA-384' },
  '1.2.840.113549.1.1.13': { kind: 'rsa', hash: 'SHA-512' },
}

export type CertificateKey =
  | { kind: 'ec'; curve: string; coordBytes: number; spki: Uint8Array }
  | { kind: 'rsa'; spki: Uint8Array }

export type ParsedCertificate = {
  der: Uint8Array
  tbs: Uint8Array
  version: number
  signatureAlgorithm: string
  signature: Uint8Array
  issuer: Uint8Array
  subject: Uint8Array
  notBefore: Date
  notAfter: Date
  key: CertificateKey
  basicConstraints: { isCa: boolean; pathLen: number | undefined } | null
  extensions: ReadonlyMap<string, { critical: boolean; value: Uint8Array }>
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function parseKey(cert: Certificate): CertificateKey {
  const spkiInfo = cert.tbsCertificate.subjectPublicKeyInfo
  const spki = new Uint8Array(AsnConvert.serialize(spkiInfo))
  if (spkiInfo.algorithm.algorithm === OID_RSA_ENCRYPTION) return { kind: 'rsa', spki }
  if (spkiInfo.algorithm.algorithm !== OID_EC_PUBLIC_KEY || !spkiInfo.algorithm.parameters) {
    throw new Error('x509: unsupported public key algorithm')
  }
  const curveOid = AsnConvert.parse(spkiInfo.algorithm.parameters, ECParameters).namedCurve
  const curve = curveOid ? NAMED_CURVES[curveOid] : undefined
  if (!curve) throw new Error('x509: unsupported EC curve')
  return { kind: 'ec', curve: curve.name, coordBytes: curve.coordBytes, spki }
}

function parseExtensions(cert: Certificate): Map<string, { critical: boolean; value: Uint8Array }> {
  const extensions = new Map<string, { critical: boolean; value: Uint8Array }>()
  for (const extension of cert.tbsCertificate.extensions ?? []) {
    if (extensions.has(extension.extnID)) throw new Error('x509: duplicate extension')
    extensions.set(extension.extnID, {
      critical: extension.critical,
      value: new Uint8Array(extension.extnValue.buffer),
    })
  }
  return extensions
}

export function parseCertificate(der: Uint8Array): ParsedCertificate {
  const cert = AsnConvert.parse(der, Certificate)
  if (!cert.tbsCertificateRaw) throw new Error('x509: missing tbsCertificate bytes')
  const tbs = cert.tbsCertificate
  const extensions = parseExtensions(cert)
  const basic = extensions.get(id_ce_basicConstraints)
  const constraints = basic ? AsnConvert.parse(basic.value, BasicConstraints) : null
  return {
    der,
    tbs: new Uint8Array(cert.tbsCertificateRaw),
    version: tbs.version + 1,
    signatureAlgorithm: cert.signatureAlgorithm.algorithm,
    signature: new Uint8Array(cert.signatureValue),
    issuer: new Uint8Array(AsnConvert.serialize(tbs.issuer)),
    subject: new Uint8Array(AsnConvert.serialize(tbs.subject)),
    notBefore: tbs.validity.notBefore.getTime(),
    notAfter: tbs.validity.notAfter.getTime(),
    key: parseKey(cert),
    basicConstraints: constraints
      ? { isCa: constraints.cA, pathLen: constraints.pathLenConstraint }
      : null,
    extensions,
  }
}

// AAGUID 扩展存在时返回其中的 16 字节;不存在返回 null。
export function certificateAaguid(cert: ParsedCertificate): Uint8Array | null {
  const extension = cert.extensions.get(OID_FIDO_AAGUID)
  if (!extension) return null
  if (extension.critical) throw new Error('x509: aaguid extension must not be critical')
  const aaguid = new Uint8Array(AsnConvert.parse(extension.value, OctetString).buffer)
  if (aaguid.length !== 16) throw new Error('x509: aaguid extension must hold 16 bytes')
  return aaguid
}

export function pemToDerList(pem: string): Uint8Array[] {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? []
  return blocks.map((block) => {
    const body = block
      .replace('-----BEGIN CERTIFICATE-----', '')
      .replace('-----END CERTIFICATE-----', '')
      .replace(/\s+/g, '')
    return Uint8Array.from(atob(body), (char) => char.charCodeAt(0))
  })
}

function leftPad(value: Uint8Array, size: number): Uint8Array {
  const trimmed = value[0] === 0 && value.length > size ? value.subarray(1) : value
  if (trimmed.length > size) throw new Error('x509: ECDSA integer too large')
  const out = new Uint8Array(size)
  out.set(trimmed, size - trimmed.length)
  return out
}

// X.509 与 WebAuthn attestation 的 ECDSA 签名是 DER,Web Crypto 要 r||s 定长拼接。
export function ecdsaDerToRaw(signature: Uint8Array, coordBytes: number): Uint8Array {
  const value = AsnConvert.parse(signature, ECDSASigValue)
  const out = new Uint8Array(coordBytes * 2)
  out.set(leftPad(new Uint8Array(value.r), coordBytes), 0)
  out.set(leftPad(new Uint8Array(value.s), coordBytes), coordBytes)
  return out
}

export async function verifyWithCertificateKey(input: {
  key: CertificateKey
  hash: string
  signature: Uint8Array
  data: Uint8Array
}): Promise<boolean> {
  const { key, hash, signature, data } = input
  try {
    if (key.kind === 'ec') {
      const publicKey = await crypto.subtle.importKey(
        'spki',
        toBufferSource(key.spki),
        { name: 'ECDSA', namedCurve: key.curve },
        false,
        ['verify'],
      )
      return await crypto.subtle.verify(
        { name: 'ECDSA', hash },
        publicKey,
        toBufferSource(ecdsaDerToRaw(signature, key.coordBytes)),
        toBufferSource(data),
      )
    }
    const publicKey = await crypto.subtle.importKey(
      'spki',
      toBufferSource(key.spki),
      { name: 'RSASSA-PKCS1-v1_5', hash },
      false,
      ['verify'],
    )
    return await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      publicKey,
      toBufferSource(signature),
      toBufferSource(data),
    )
  } catch {
    return false
  }
}

async function isSignedBy(child: ParsedCertificate, issuer: ParsedCertificate): Promise<boolean> {
  if (!bytesEqual(child.issuer, issuer.subject)) return false
  const algorithm = SIGNATURE_HASHES[child.signatureAlgorithm]
  if (!algorithm || algorithm.kind !== issuer.key.kind) return false
  return verifyWithCertificateKey({
    key: issuer.key,
    hash: algorithm.hash,
    signature: child.signature,
    data: child.tbs,
  })
}

function isValidAt(cert: ParsedCertificate, now: Date): boolean {
  return cert.notBefore.getTime() <= now.getTime() && now.getTime() <= cert.notAfter.getTime()
}

// 签发方必须是 CA,且 pathLen 不小于其下方中间 CA 的数量。
function canIssue(issuer: ParsedCertificate, intermediatesBelow: number): boolean {
  const constraints = issuer.basicConstraints
  if (!constraints?.isCa) return false
  return constraints.pathLen === undefined || constraints.pathLen >= intermediatesBelow
}

export async function certificateFingerprint(der: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', toBufferSource(der)))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export type ChainVerification = { verified: boolean; trustPath: readonly string[] }

// chain[0] 是 leaf。x5c 里附带的证书只有在逐级验签后抵达配置的根时才可信;
// 根可以出现在 x5c 末尾(按 DER 字节等值匹配),也可以只存在于配置中。
export async function verifyCertificateChain(input: {
  chain: readonly ParsedCertificate[]
  trustedRoots: readonly ParsedCertificate[]
  now: Date
}): Promise<ChainVerification> {
  const { chain, trustedRoots, now } = input
  const untrusted = { verified: false, trustPath: [] }
  if (chain.length === 0 || trustedRoots.length === 0) return untrusted
  for (let i = 0; i < chain.length; i++) {
    const cert = chain[i]!
    if (!isValidAt(cert, now)) return untrusted
    if (trustedRoots.some((root) => bytesEqual(root.der, cert.der))) {
      if (i === 0) return untrusted
      return trustedPath(chain.slice(0, i + 1))
    }
    const next = chain[i + 1]
    if (next) {
      if (!canIssue(next, Math.max(0, i)) || !(await isSignedBy(cert, next))) return untrusted
      continue
    }
    for (const root of trustedRoots) {
      if (isValidAt(root, now) && canIssue(root, i) && (await isSignedBy(cert, root))) {
        return trustedPath([...chain, root])
      }
    }
  }
  return untrusted
}

async function trustedPath(path: readonly ParsedCertificate[]): Promise<ChainVerification> {
  const trustPath = await Promise.all(path.map((cert) => certificateFingerprint(cert.der)))
  return { verified: true, trustPath }
}
