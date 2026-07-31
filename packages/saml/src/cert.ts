// IdP X.509 证书处理:从 connection 存的 base64 DER 提取验签公钥 + SHA-256 指纹(事故响应,见 8.5)。
// 用 xmldsigjs X509Certificate(基于 pkijs,WebCrypto 环境可用),不自研 ASN.1 解析(见 crypto-boundary rule)。
// 只用 connection 配置的证书,忽略文档内 ds:KeyInfo(8.5 step 1,StaticKeySelector)。

import { fromBER, Integer, Utf8String } from 'asn1js'
import { AttributeTypeAndValue, Certificate } from 'pkijs'
import { X509Certificate } from 'xmldsigjs'
import { toBufferSource } from '@xid-kit/crypto'
import { setSamlEngine } from './engine'
import { failResult, okResult } from './errors'
import type { SamlResult } from './errors'

export const DEFAULT_SAML_CLOCK_SKEW_MS = 3 * 60 * 1000
export const MAX_SAML_CLOCK_SKEW_MS = 5 * 60 * 1000

export type IdpVerifyKey = {
  publicKey: CryptoKey
  // SHA-256 指纹 hex(冒号分隔大写,事故响应/证书轮换识别)。
  fingerprint: string
  notBefore: number
  notAfter: number
}

export type CertificateValidityOptions = {
  now?: number
  toleranceMs?: number
}

export type GeneratedSamlCertificate = {
  certificateB64: string
  privateKeyPkcs8: Uint8Array
  fingerprint: string
  notBefore: number
  notAfter: number
}

const SAML_CERTIFICATE_VALIDITY_MS = 365 * 24 * 60 * 60 * 1000

function toHexColon(bytes: Uint8Array): string {
  const parts: string[] = []
  for (const b of bytes) parts.push(b.toString(16).padStart(2, '0').toUpperCase())
  return parts.join(':')
}

function decodeDer(certB64: string): Uint8Array {
  const clean = certB64.replace(/\s+/g, '')
  return Uint8Array.from(atob(clean), (ch) => ch.charCodeAt(0))
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function certificateCommonName(commonName: string): AttributeTypeAndValue {
  return new AttributeTypeAndValue({
    type: '2.5.4.3',
    value: new Utf8String({ value: commonName }),
  })
}

export async function generateSelfSignedSamlCertificate(
  commonName: string,
  now: number = Date.now(),
): Promise<SamlResult<GeneratedSamlCertificate>> {
  const normalizedCommonName = commonName.trim()
  if (normalizedCommonName.length === 0 || normalizedCommonName.length > 64) {
    return failResult(
      'malformed_request',
      'certificate common name must contain 1 to 64 characters',
    )
  }
  const notAfter = now + SAML_CERTIFICATE_VALIDITY_MS
  if (
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(notAfter) ||
    !Number.isFinite(new Date(now).getTime()) ||
    !Number.isFinite(new Date(notAfter).getTime())
  ) {
    return failResult('malformed_request', 'invalid certificate validity start')
  }

  let privateKeyPkcs8: Uint8Array | undefined
  try {
    const keyPair = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    )
    setSamlEngine(crypto)
    const serial = crypto.getRandomValues(new Uint8Array(20))
    serial[0] = (serial[0] ?? 0) & 0x7f
    if (serial.every((byte) => byte === 0)) serial[serial.length - 1] = 1

    const certificate = new Certificate()
    certificate.version = 2
    certificate.serialNumber = new Integer({ valueHex: toBufferSource(serial) })
    certificate.issuer.typesAndValues.push(certificateCommonName(normalizedCommonName))
    certificate.subject.typesAndValues.push(certificateCommonName(normalizedCommonName))
    // 证书按签发方时钟立即生效；读取方通过受上限约束的 tolerance 处理跨节点时钟偏差。
    certificate.notBefore.value = new Date(now)
    certificate.notAfter.value = new Date(notAfter)
    await certificate.subjectPublicKeyInfo.importKey(keyPair.publicKey)
    await certificate.sign(keyPair.privateKey, 'SHA-256')

    const certificateDer = new Uint8Array(certificate.toSchema(true).toBER(false))
    privateKeyPkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey))
    const fingerprint = toHexColon(
      new Uint8Array(await crypto.subtle.digest('SHA-256', certificateDer)),
    )
    const result = okResult({
      certificateB64: encodeBase64(certificateDer),
      privateKeyPkcs8,
      fingerprint,
      notBefore: now,
      notAfter,
    })
    privateKeyPkcs8 = undefined
    return result
  } catch (cause) {
    return failResult('signature_invalid', `certificate generation failed: ${String(cause)}`)
  } finally {
    privateKeyPkcs8?.fill(0)
  }
}

// 从单个 base64 DER 证书提取验签公钥 + 指纹。RSA/ECDSA 自动识别(exportKey 内部按 SPKI 算法)。
export async function loadIdpVerifyKey(certB64: string): Promise<SamlResult<IdpVerifyKey>> {
  let cert: X509Certificate
  let parsed: Certificate
  try {
    const der = decodeDer(certB64)
    cert = new X509Certificate(toBufferSource(der))
    const asn1 = fromBER(toBufferSource(der))
    if (asn1.offset === -1) throw new Error('incorrect ASN.1 certificate encoding')
    parsed = new Certificate({ schema: asn1.result })
  } catch (cause) {
    return failResult('signature_invalid', `invalid IdP certificate: ${String(cause)}`)
  }
  try {
    const publicKey = await cert.exportKey()
    const thumb = new Uint8Array(await cert.Thumbprint('SHA-256'))
    const notBefore = parsed.notBefore.value.getTime()
    const notAfter = parsed.notAfter.value.getTime()
    if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter) || notBefore > notAfter) {
      return failResult('signature_invalid', 'invalid IdP certificate validity interval')
    }
    return okResult({ publicKey, fingerprint: toHexColon(thumb), notBefore, notAfter })
  } catch (cause) {
    return failResult('signature_invalid', `cannot export IdP key: ${String(cause)}`)
  }
}

function resolveValidityOptions(
  options: CertificateValidityOptions,
): SamlResult<{ now: number; toleranceMs: number }> {
  const now = options.now ?? Date.now()
  const toleranceMs = options.toleranceMs ?? DEFAULT_SAML_CLOCK_SKEW_MS
  if (!Number.isFinite(now))
    return failResult('signature_invalid', 'invalid certificate check time')
  if (
    !Number.isSafeInteger(toleranceMs) ||
    toleranceMs < 0 ||
    toleranceMs > MAX_SAML_CLOCK_SKEW_MS
  ) {
    return failResult('signature_invalid', 'invalid certificate clock tolerance')
  }
  return okResult({ now, toleranceMs })
}

function isValidAt(key: IdpVerifyKey, options: { now: number; toleranceMs: number }): boolean {
  return (
    options.now + options.toleranceMs >= key.notBefore &&
    options.now - options.toleranceMs <= key.notAfter
  )
}

// 证书轮换期 connection 存新旧多证书:逐个加载,跳过坏证书和当前时间不可用的证书,
// 新旧证书重叠期任一有效即可;全部失败才报错。
export async function loadIdpVerifyKeys(
  certsB64: readonly string[],
  options: CertificateValidityOptions = {},
): Promise<SamlResult<readonly IdpVerifyKey[]>> {
  const validity = resolveValidityOptions(options)
  if (!validity.ok) return failResult(validity.error.code, validity.error.reason)
  const keys: IdpVerifyKey[] = []
  for (const certB64 of certsB64) {
    const loaded = await loadIdpVerifyKey(certB64)
    if (loaded.ok && isValidAt(loaded.value, validity.value)) keys.push(loaded.value)
  }
  if (keys.length === 0)
    return failResult('signature_invalid', 'no currently valid IdP certificate')
  return okResult(keys)
}
