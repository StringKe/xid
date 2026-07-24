// 8.6 EncryptedAssertion 解密(decrypt-then-verify):RSA-OAEP 解会话密钥 -> AES-GCM/CBC 解明文 Assertion。
// SP 解密私钥由 worker 从 CertStore 信封解密后以不可导出 CryptoKey 传入(见 signing-keys rule,私钥不出 isolate)。
// 密码学原语只用 crypto.subtle(见 crypto-boundary rule)。算法不在白名单一律拒。

import { toBufferSource } from '@xid-kit/crypto'
import { XENC_NS, SAMLP_NS, SAML_ASSERTION_NS } from './precheck'
import { failResult, okResult } from './errors'
import type { SamlResult } from './errors'

const DS_NS = 'http://www.w3.org/2000/09/xmldsig#'

// RSA-OAEP 密钥包装算法白名单(按 xenc:EncryptionMethod 声明,8.6 step 2)。
const RSA_OAEP = 'http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p'
const RSA_OAEP_11 = 'http://www.w3.org/2009/xmlenc11#rsa-oaep'
// 数据加密算法白名单(8.6 step 3)。
const AES_GCM = new Map<string, number>([
  ['http://www.w3.org/2009/xmlenc11#aes128-gcm', 128],
  ['http://www.w3.org/2009/xmlenc11#aes256-gcm', 256],
])
const AES_CBC = new Map<string, number>([
  ['http://www.w3.org/2001/04/xmlenc#aes128-cbc', 128],
  ['http://www.w3.org/2001/04/xmlenc#aes256-cbc', 256],
])

function child(parent: Element, ns: string, local: string): Element | null {
  for (let i = 0; i < parent.childNodes.length; i += 1) {
    const node = parent.childNodes.item(i)
    if (node && node.nodeType === 1) {
      const el = node as Element
      if (el.namespaceURI === ns && el.localName === local) return el
    }
  }
  return null
}

function cipherValueBytes(encrypted: Element): Uint8Array | null {
  const cipherData = child(encrypted, XENC_NS, 'CipherData')
  const cipherValue = cipherData ? child(cipherData, XENC_NS, 'CipherValue') : null
  const b64 = cipherValue?.textContent?.replace(/\s+/g, '') ?? ''
  if (!b64) return null
  try {
    return Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))
  } catch {
    return null
  }
}

function encryptionAlg(encrypted: Element): string {
  return child(encrypted, XENC_NS, 'EncryptionMethod')?.getAttribute('Algorithm') ?? ''
}

// 解 xenc:EncryptedKey(RSA-OAEP)-> 对称会话密钥原始字节。
async function unwrapSessionKey(
  encryptedData: Element,
  spPrivateKey: CryptoKey,
): Promise<SamlResult<Uint8Array>> {
  const keyInfo = child(encryptedData, DS_NS, 'KeyInfo')
  const encKey = keyInfo ? child(keyInfo, XENC_NS, 'EncryptedKey') : null
  if (!encKey) return failResult('decryption_failed', 'EncryptedKey missing')
  const alg = encryptionAlg(encKey)
  if (alg !== RSA_OAEP && alg !== RSA_OAEP_11) {
    return failResult('decryption_failed', `key-wrap alg not allowed: ${alg}`)
  }
  const wrapped = cipherValueBytes(encKey)
  if (!wrapped) return failResult('decryption_failed', 'EncryptedKey CipherValue invalid')
  try {
    const raw = await crypto.subtle.decrypt(
      { name: 'RSA-OAEP' },
      spPrivateKey,
      toBufferSource(wrapped),
    )
    return okResult(new Uint8Array(raw))
  } catch (cause) {
    return failResult('decryption_failed', `RSA-OAEP decrypt failed: ${String(cause)}`)
  }
}

async function decryptData(
  encryptedData: Element,
  sessionKeyRaw: Uint8Array,
): Promise<SamlResult<string>> {
  const alg = encryptionAlg(encryptedData)
  const cipher = cipherValueBytes(encryptedData)
  if (!cipher) return failResult('decryption_failed', 'EncryptedData CipherValue invalid')

  const gcm = AES_GCM.get(alg)
  const cbc = AES_CBC.get(alg)
  if (gcm === undefined && cbc === undefined) {
    return failResult('decryption_failed', `data alg not allowed: ${alg}`)
  }
  // XML-ENC 把 IV 前置在密文(GCM 12 字节、CBC 16 字节)。
  const ivLen = gcm !== undefined ? 12 : 16
  if (cipher.byteLength <= ivLen) return failResult('decryption_failed', 'ciphertext too short')
  const iv = cipher.subarray(0, ivLen)
  const body = cipher.subarray(ivLen)
  const name = gcm !== undefined ? 'AES-GCM' : 'AES-CBC'
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      toBufferSource(sessionKeyRaw),
      { name },
      false,
      ['decrypt'],
    )
    const plain = await crypto.subtle.decrypt(
      { name, iv: toBufferSource(iv) },
      key,
      toBufferSource(body),
    )
    return okResult(new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(plain)))
  } catch (cause) {
    return failResult('decryption_failed', `${name} decrypt failed: ${String(cause)}`)
  }
}

// 定位 /samlp:Response/saml:EncryptedAssertion/xenc:EncryptedData(绝对路径,唯一),解出明文 Assertion XML。
export async function decryptEncryptedAssertion(
  responseRoot: Element,
  spPrivateKey: CryptoKey,
): Promise<SamlResult<string>> {
  const encAssertion = child(responseRoot, SAML_ASSERTION_NS, 'EncryptedAssertion')
  if (!encAssertion) return failResult('decryption_failed', 'EncryptedAssertion missing')
  const encryptedData = child(encAssertion, XENC_NS, 'EncryptedData')
  if (!encryptedData) return failResult('decryption_failed', 'EncryptedData missing')

  const sessionKey = await unwrapSessionKey(encryptedData, spPrivateKey)
  if (!sessionKey.ok) return failResult(sessionKey.error.code, sessionKey.error.reason)
  return decryptData(encryptedData, sessionKey.value)
}

// 判断 Response 是否含明文 Assertion 或 EncryptedAssertion(决定走解密路径)。
export function hasEncryptedAssertion(responseRoot: Element): boolean {
  return child(responseRoot, SAML_ASSERTION_NS, 'EncryptedAssertion') !== null
}

export function plaintextAssertion(responseRoot: Element): Element | null {
  return child(responseRoot, SAML_ASSERTION_NS, 'Assertion')
}

export const RESPONSE_NS = SAMLP_NS
