// EncryptedAssertion decrypt-then-verify:RSA-OAEP 解会话密钥后 AES-GCM/CBC 解明文。
// 私钥由 worker 通过 SamlDecryptKeyProvider 以不可导出 CryptoKey 提供;仅 crypto.subtle,算法白名单外一律拒。

import { toBufferSource } from '@xid-kit/crypto'
import { DS_NS, XENC_NS, SAML_ASSERTION_NS } from './precheck'
import { failResult, okResult } from './errors'
import type { SamlResult } from './errors'
import { base64Bytes, child, unwrapWithOaep } from './oaep'
import type { SamlDecryptKeyProvider } from './oaep'

const AES_BLOCK_BYTES = 16
const AES_GCM = new Map<string, number>([
  ['http://www.w3.org/2009/xmlenc11#aes128-gcm', 16],
  ['http://www.w3.org/2009/xmlenc11#aes256-gcm', 32],
])
const AES_CBC = new Map<string, number>([
  ['http://www.w3.org/2001/04/xmlenc#aes128-cbc', 16],
  ['http://www.w3.org/2001/04/xmlenc#aes256-cbc', 32],
])

function children(parent: Element, ns: string, local: string): Element[] {
  const out: Element[] = []
  for (let i = 0; i < parent.childNodes.length; i += 1) {
    const node = parent.childNodes.item(i)
    if (node?.nodeType !== 1) continue
    const el = node as Element
    if (el.namespaceURI === ns && el.localName === local) out.push(el)
  }
  return out
}

function cipherValueBytes(encrypted: Element): Uint8Array | null {
  const cipherData = child(encrypted, XENC_NS, 'CipherData')
  return base64Bytes(cipherData ? child(cipherData, XENC_NS, 'CipherValue')?.textContent : null)
}

function encryptionAlg(encrypted: Element): string {
  return child(encrypted, XENC_NS, 'EncryptionMethod')?.getAttribute('Algorithm') ?? ''
}

// EncryptedKey 可内嵌在 EncryptedData/KeyInfo,也可作为 EncryptedAssertion 下的兄弟元素(经 RetrievalMethod 引用)。
function locateEncryptedKey(encAssertion: Element, encryptedData: Element): SamlResult<Element> {
  const keyInfo = child(encryptedData, DS_NS, 'KeyInfo')
  const inline = keyInfo ? children(keyInfo, XENC_NS, 'EncryptedKey') : []
  if (inline.length > 1) return failResult('decryption_failed', 'multiple inline EncryptedKey')
  if (inline[0]) return okResult(inline[0])

  const peers = children(encAssertion, XENC_NS, 'EncryptedKey')
  const retrieval = keyInfo ? child(keyInfo, DS_NS, 'RetrievalMethod') : null
  if (retrieval) {
    const id = (retrieval.getAttribute('URI') ?? '').slice(1)
    const matched = peers.filter((peer) => peer.getAttribute('Id') === id)
    if (matched.length !== 1 || !matched[0]) {
      return failResult('decryption_failed', 'RetrievalMethod does not match one EncryptedKey')
    }
    return okResult(matched[0])
  }
  if (peers.length !== 1 || !peers[0]) {
    return failResult('decryption_failed', 'EncryptedKey missing or ambiguous')
  }
  return okResult(peers[0])
}

// XML Enc 第 5.2 节:CBC 填充只规定最后一字节为填充长度,其余字节任意(ISO 10126)。
// Web Crypto 只接受 PKCS#7,故追加一个解密后恰为整块 PKCS#7 填充的密文块,取回全部原始块再按 XML Enc 去填充。
async function decryptCbc(
  sessionKey: Uint8Array,
  iv: Uint8Array,
  body: Uint8Array,
): Promise<Uint8Array> {
  if (body.byteLength === 0 || body.byteLength % AES_BLOCK_BYTES !== 0) {
    throw new Error('ciphertext is not a whole number of blocks')
  }
  const key = await crypto.subtle.importKey(
    'raw',
    toBufferSource(sessionKey),
    { name: 'AES-CBC' },
    false,
    ['encrypt', 'decrypt'],
  )
  const lastBlock = body.subarray(body.byteLength - AES_BLOCK_BYTES)
  const fullPadding = new Uint8Array(AES_BLOCK_BYTES).fill(AES_BLOCK_BYTES)
  const sentinel = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-CBC', iv: toBufferSource(lastBlock) },
      key,
      toBufferSource(fullPadding),
    ),
  ).subarray(0, AES_BLOCK_BYTES)
  const extended = new Uint8Array(body.byteLength + AES_BLOCK_BYTES)
  extended.set(body)
  extended.set(sentinel, body.byteLength)
  const blocks = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-CBC', iv: toBufferSource(iv) },
      key,
      toBufferSource(extended),
    ),
  )
  const padLength = blocks[blocks.byteLength - 1] ?? 0
  if (padLength < 1 || padLength > AES_BLOCK_BYTES) throw new Error('invalid CBC padding length')
  return blocks.subarray(0, blocks.byteLength - padLength)
}

async function decryptGcm(
  sessionKey: Uint8Array,
  iv: Uint8Array,
  body: Uint8Array,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    toBufferSource(sessionKey),
    { name: 'AES-GCM' },
    false,
    ['decrypt'],
  )
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toBufferSource(iv) },
      key,
      toBufferSource(body),
    ),
  )
}

async function decryptData(
  encryptedData: Element,
  sessionKey: Uint8Array,
): Promise<SamlResult<string>> {
  const alg = encryptionAlg(encryptedData)
  const gcmKeyBytes = AES_GCM.get(alg)
  const cbcKeyBytes = AES_CBC.get(alg)
  const keyBytes = gcmKeyBytes ?? cbcKeyBytes
  if (keyBytes === undefined) return failResult('decryption_failed', `data alg not allowed: ${alg}`)
  if (sessionKey.byteLength !== keyBytes) {
    return failResult('decryption_failed', 'session key length does not match data algorithm')
  }
  const cipher = cipherValueBytes(encryptedData)
  if (!cipher) return failResult('decryption_failed', 'EncryptedData CipherValue invalid')
  // XML Enc 把 IV 前置在密文(GCM 12 字节、CBC 16 字节)。
  const ivLen = gcmKeyBytes !== undefined ? 12 : AES_BLOCK_BYTES
  if (cipher.byteLength <= ivLen) return failResult('decryption_failed', 'ciphertext too short')
  const iv = cipher.subarray(0, ivLen)
  const body = cipher.subarray(ivLen)
  const name = gcmKeyBytes !== undefined ? 'AES-GCM' : 'AES-CBC'
  try {
    const plain =
      gcmKeyBytes !== undefined
        ? await decryptGcm(sessionKey, iv, body)
        : await decryptCbc(sessionKey, iv, body)
    return okResult(new TextDecoder('utf-8', { fatal: true }).decode(plain))
  } catch (cause) {
    return failResult('decryption_failed', `${name} decrypt failed: ${String(cause)}`)
  }
}

export async function decryptEncryptedAssertion(
  responseRoot: Element,
  keyProvider: SamlDecryptKeyProvider,
): Promise<SamlResult<string>> {
  const encAssertion = child(responseRoot, SAML_ASSERTION_NS, 'EncryptedAssertion')
  if (!encAssertion) return failResult('decryption_failed', 'EncryptedAssertion missing')
  const encryptedData = child(encAssertion, XENC_NS, 'EncryptedData')
  if (!encryptedData) return failResult('decryption_failed', 'EncryptedData missing')

  const encryptedKey = locateEncryptedKey(encAssertion, encryptedData)
  if (!encryptedKey.ok) return failResult(encryptedKey.error.code, encryptedKey.error.reason)
  const sessionKey = await unwrapWithOaep(encryptedKey.value, keyProvider)
  if (!sessionKey.ok) return failResult(sessionKey.error.code, sessionKey.error.reason)
  try {
    return await decryptData(encryptedData, sessionKey.value)
  } finally {
    sessionKey.value.fill(0)
  }
}

export function hasEncryptedAssertion(responseRoot: Element): boolean {
  return child(responseRoot, SAML_ASSERTION_NS, 'EncryptedAssertion') !== null
}

export function plaintextAssertion(responseRoot: Element): Element | null {
  return child(responseRoot, SAML_ASSERTION_NS, 'Assertion')
}
