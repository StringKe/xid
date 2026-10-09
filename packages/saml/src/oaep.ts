// EncryptedKey 的 RSA-OAEP 解包。按 XML Enc 1.1 第 5.5.2 节从 EncryptionMethod 推出 OAEP 摘要与 MGF1 摘要,
// 每条消息按该摘要重新导入不可导出私钥;Web Crypto 只能让两者相同,不同即拒绝。

import { toBufferSource } from '@xid-kit/crypto'
import { DS_NS, XENC_NS } from './precheck'
import { failResult, okResult } from './errors'
import type { SamlResult } from './errors'
import { XENC11_NS } from './schema-xmlenc'

export type SamlOaepHash = 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512'

// 由 worker 按 hash 导入 RSA-OAEP 不可导出私钥;私钥明文不进入本包。
export type SamlDecryptKeyProvider = (hash: SamlOaepHash) => Promise<CryptoKey>

const RSA_OAEP_MGF1P = 'http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p'
const RSA_OAEP_11 = 'http://www.w3.org/2009/xmlenc11#rsa-oaep'

// rsa-oaep-mgf1p 的 MGF1 固定 SHA-1,ADFS/Okta/Shibboleth 默认即此组合,故 OAEP 层必须接受 SHA-1。
const DIGEST_HASHES = new Map<string, SamlOaepHash>([
  ['http://www.w3.org/2000/09/xmldsig#sha1', 'SHA-1'],
  ['http://www.w3.org/2001/04/xmlenc#sha256', 'SHA-256'],
  ['http://www.w3.org/2001/04/xmldsig-more#sha384', 'SHA-384'],
  ['http://www.w3.org/2001/04/xmlenc#sha512', 'SHA-512'],
])

const MGF_HASHES = new Map<string, SamlOaepHash>([
  ['http://www.w3.org/2009/xmlenc11#mgf1sha1', 'SHA-1'],
  ['http://www.w3.org/2009/xmlenc11#mgf1sha256', 'SHA-256'],
  ['http://www.w3.org/2009/xmlenc11#mgf1sha384', 'SHA-384'],
  ['http://www.w3.org/2009/xmlenc11#mgf1sha512', 'SHA-512'],
])

export type OaepParameters = { hash: SamlOaepHash; label?: Uint8Array }

export function child(parent: Element, ns: string, local: string): Element | null {
  for (let i = 0; i < parent.childNodes.length; i += 1) {
    const node = parent.childNodes.item(i)
    if (node && node.nodeType === 1) {
      const el = node as Element
      if (el.namespaceURI === ns && el.localName === local) return el
    }
  }
  return null
}

export function base64Bytes(value: string | null | undefined): Uint8Array | null {
  const b64 = value?.replace(/\s+/g, '') ?? ''
  if (!b64) return null
  try {
    return Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))
  } catch {
    return null
  }
}

function lookupHash(
  table: ReadonlyMap<string, SamlOaepHash>,
  element: Element | null,
): SamlOaepHash | null | undefined {
  if (!element) return null
  return table.get(element.getAttribute('Algorithm') ?? '')
}

export function resolveOaepParameters(method: Element): SamlResult<OaepParameters> {
  const alg = method.getAttribute('Algorithm') ?? ''
  if (alg !== RSA_OAEP_MGF1P && alg !== RSA_OAEP_11) {
    return failResult('decryption_failed', `key-wrap alg not allowed: ${alg}`)
  }
  const digest = lookupHash(DIGEST_HASHES, child(method, DS_NS, 'DigestMethod'))
  if (digest === undefined) return failResult('decryption_failed', 'OAEP DigestMethod not allowed')
  const mgfElement = child(method, XENC11_NS, 'MGF')
  if (alg === RSA_OAEP_MGF1P && mgfElement) {
    return failResult('decryption_failed', 'rsa-oaep-mgf1p does not take an MGF parameter')
  }
  const mgf = alg === RSA_OAEP_MGF1P ? 'SHA-1' : lookupHash(MGF_HASHES, mgfElement)
  if (mgf === undefined) return failResult('decryption_failed', 'OAEP MGF algorithm not allowed')
  const digestHash = digest ?? 'SHA-1'
  const mgfHash = mgf ?? 'SHA-1'
  if (digestHash !== mgfHash) {
    return failResult(
      'decryption_failed',
      `OAEP digest ${digestHash} with MGF1 ${mgfHash} is not supported by Web Crypto`,
    )
  }
  const paramsElement = child(method, XENC_NS, 'OAEPparams')
  if (!paramsElement) return okResult({ hash: digestHash })
  const label = base64Bytes(paramsElement.textContent)
  if (!label) return failResult('decryption_failed', 'OAEPparams invalid')
  return okResult({ hash: digestHash, label })
}

export async function unwrapWithOaep(
  encryptedKey: Element,
  keyProvider: SamlDecryptKeyProvider,
): Promise<SamlResult<Uint8Array>> {
  const method = child(encryptedKey, XENC_NS, 'EncryptionMethod')
  if (!method) return failResult('decryption_failed', 'EncryptedKey EncryptionMethod missing')
  const params = resolveOaepParameters(method)
  if (!params.ok) return failResult(params.error.code, params.error.reason)
  const cipherData = child(encryptedKey, XENC_NS, 'CipherData')
  const wrapped = base64Bytes(
    cipherData ? child(cipherData, XENC_NS, 'CipherValue')?.textContent : null,
  )
  if (!wrapped) return failResult('decryption_failed', 'EncryptedKey CipherValue invalid')
  try {
    const key = await keyProvider(params.value.hash)
    const algorithm: RsaOaepParams = params.value.label
      ? { name: 'RSA-OAEP', label: toBufferSource(params.value.label) }
      : { name: 'RSA-OAEP' }
    const raw = await crypto.subtle.decrypt(algorithm, key, toBufferSource(wrapped))
    return okResult(new Uint8Array(raw))
  } catch (cause) {
    return failResult('decryption_failed', `RSA-OAEP decrypt failed: ${String(cause)}`)
  }
}
