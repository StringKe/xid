// IdP X.509 证书处理:从 connection 存的 base64 DER 提取验签公钥 + SHA-256 指纹(事故响应,见 8.5)。
// 用 xmldsigjs X509Certificate(基于 pkijs,WebCrypto 环境可用),不自研 ASN.1 解析(见 crypto-boundary rule)。
// 只用 connection 配置的证书,忽略文档内 ds:KeyInfo(8.5 step 1,StaticKeySelector)。

import { X509Certificate } from 'xmldsigjs'
import { toBufferSource } from '@xid-kit/crypto'
import { failResult, okResult } from './errors'
import type { SamlResult } from './errors'

export type IdpVerifyKey = {
  publicKey: CryptoKey
  // SHA-256 指纹 hex(冒号分隔大写,事故响应/证书轮换识别)。
  fingerprint: string
}

function toHexColon(bytes: Uint8Array): string {
  const parts: string[] = []
  for (const b of bytes) parts.push(b.toString(16).padStart(2, '0').toUpperCase())
  return parts.join(':')
}

function decodeDer(certB64: string): Uint8Array {
  const clean = certB64.replace(/\s+/g, '')
  return Uint8Array.from(atob(clean), (ch) => ch.charCodeAt(0))
}

// 从单个 base64 DER 证书提取验签公钥 + 指纹。RSA/ECDSA 自动识别(exportKey 内部按 SPKI 算法)。
export async function loadIdpVerifyKey(certB64: string): Promise<SamlResult<IdpVerifyKey>> {
  let cert: X509Certificate
  try {
    cert = new X509Certificate(toBufferSource(decodeDer(certB64)))
  } catch (cause) {
    return failResult('signature_invalid', `invalid IdP certificate: ${String(cause)}`)
  }
  try {
    const publicKey = await cert.exportKey()
    const thumb = new Uint8Array(await cert.Thumbprint('SHA-256'))
    return okResult({ publicKey, fingerprint: toHexColon(thumb) })
  } catch (cause) {
    return failResult('signature_invalid', `cannot export IdP key: ${String(cause)}`)
  }
}

// 证书轮换期 connection 存新旧多证书:逐个加载,跳过坏证书,全部失败才报错。
export async function loadIdpVerifyKeys(
  certsB64: readonly string[],
): Promise<SamlResult<readonly IdpVerifyKey[]>> {
  const keys: IdpVerifyKey[] = []
  for (const certB64 of certsB64) {
    const loaded = await loadIdpVerifyKey(certB64)
    if (loaded.ok) keys.push(loaded.value)
  }
  if (keys.length === 0) return failResult('signature_invalid', 'no usable IdP certificate')
  return okResult(keys)
}
