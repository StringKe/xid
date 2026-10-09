// attestation 证书链测试数据:用 @peculiar/x509 现场生成 root -> intermediate -> leaf,
// 再按 WebAuthn packed / fido-u2f 规则构造 attestationObject 的各部分。

// @peculiar/x509 只在测试里用于签发证书,它依赖 tsyringe 的 Reflect polyfill;生产代码只用 asn1-x509。
import 'reflect-metadata'
import { p1363ToDer } from '@xid-kit/crypto'
import * as x509 from '@peculiar/x509'

import type { CborMap } from '../../cbor'
import { OID_FIDO_AAGUID } from '../../x509'

x509.cryptoProvider.set(crypto)

export const RP_ID = 'acme.xid.dev'
export const NOW = new Date('2026-06-01T00:00:00Z')

const EC_P256 = { name: 'ECDSA', namedCurve: 'P-256' } as const
const RSA = {
  name: 'RSASSA-PKCS1-v1_5',
  hash: 'SHA-256',
  publicExponent: new Uint8Array([1, 0, 1]),
  modulusLength: 2048,
} as const

export type Issued = { cert: x509.X509Certificate; keys: CryptoKeyPair; der: Uint8Array }

let serial = 1

export async function issue(options: {
  subject: string
  issuer?: Issued
  ca: boolean
  pathLen?: number
  rsa?: boolean
  aaguid?: Uint8Array
  notAfter?: Date
}): Promise<Issued> {
  const keys = (await crypto.subtle.generateKey(options.rsa ? RSA : EC_P256, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const signer = options.issuer?.keys ?? keys
  const signerIsRsa = signer.privateKey.algorithm.name === 'RSASSA-PKCS1-v1_5'
  const extensions: x509.Extension[] = [
    new x509.BasicConstraintsExtension(options.ca, options.pathLen, true),
  ]
  if (options.aaguid) {
    extensions.push(
      new x509.Extension(OID_FIDO_AAGUID, false, new Uint8Array([0x04, 0x10, ...options.aaguid])),
    )
  }
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: String(serial++).padStart(2, '0'),
    subject: `CN=${options.subject}`,
    issuer: options.issuer ? options.issuer.cert.subject : `CN=${options.subject}`,
    notBefore: new Date('2026-01-01T00:00:00Z'),
    notAfter: options.notAfter ?? new Date('2030-01-01T00:00:00Z'),
    signingAlgorithm: signerIsRsa
      ? { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }
      : { name: 'ECDSA', hash: 'SHA-256' },
    publicKey: keys.publicKey,
    signingKey: signer.privateKey,
    extensions,
  })
  return { cert, keys, der: new Uint8Array(cert.rawData) }
}

export function pemOf(issued: Issued): string {
  return issued.cert.toString('pem')
}

function coseEs256(raw: Uint8Array): Uint8Array {
  return new Uint8Array([
    0xa5,
    0x01,
    0x02,
    0x03,
    0x26,
    0x20,
    0x01,
    0x21,
    0x58,
    0x20,
    ...raw.subarray(1, 33),
    0x22,
    0x58,
    0x20,
    ...raw.subarray(33, 65),
  ])
}

export type Registration = {
  authData: Uint8Array
  clientDataJson: Uint8Array
  clientDataHash: Uint8Array
  rpIdHash: Uint8Array
  credentialId: Uint8Array
  rawPublicKey: Uint8Array
  credentialKeys: CryptoKeyPair
}

export async function buildRegistration(aaguid: Uint8Array): Promise<Registration> {
  const credentialKeys = (await crypto.subtle.generateKey(EC_P256, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const rawPublicKey = new Uint8Array(
    (await crypto.subtle.exportKey('raw', credentialKeys.publicKey)) as ArrayBuffer,
  )
  const credentialId = crypto.getRandomValues(new Uint8Array(16))
  const rpIdHash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(RP_ID)),
  )
  const cose = coseEs256(rawPublicKey)
  const authData = new Uint8Array(37 + 16 + 2 + credentialId.length + cose.length)
  authData.set(rpIdHash, 0)
  authData[32] = 0x01 | 0x04 | 0x40
  authData.set(aaguid, 37)
  authData[54] = credentialId.length
  authData.set(credentialId, 55)
  authData.set(cose, 55 + credentialId.length)
  const clientDataJson = new TextEncoder().encode('{"type":"webauthn.create"}')
  const clientDataHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataJson))
  return {
    authData,
    clientDataJson,
    clientDataHash,
    rpIdHash,
    credentialId,
    rawPublicKey,
    credentialKeys,
  }
}

export async function signEs256(privateKey: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const raw = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, data),
  )
  return p1363ToDer(raw)
}

export function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

export function statement(entries: Record<string, unknown>): CborMap {
  return new Map(Object.entries(entries)) as CborMap
}
