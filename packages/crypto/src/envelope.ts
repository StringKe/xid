// AES-256-GCM 信封加密:KEK 由调用方传入(无模块级密钥);落库拆 iv/ciphertext/tag 三段。

import type { EnvelopeEncryptedKey, SigningAlg } from '@xid-kit/types'

import { toBufferSource } from './buffer-source'

const IV_BYTE_LENGTH = 12
const KEK_BYTE_LENGTH = 32

export type EnvelopeBlob = {
  iv: Uint8Array
  ciphertext: Uint8Array
  tag: Uint8Array
  kekVersion: number
}

async function importKek(kekRaw: Uint8Array): Promise<CryptoKey> {
  if (kekRaw.byteLength !== KEK_BYTE_LENGTH) {
    throw new Error(`KEK must be ${KEK_BYTE_LENGTH} bytes (AES-256), got ${kekRaw.byteLength}`)
  }
  return crypto.subtle.importKey('raw', toBufferSource(kekRaw), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ])
}

// Web Crypto AES-GCM 把 16 字节 tag 附在密文末尾,拆出独立 tag 字段以对齐三 blob 落库。
function splitCiphertextAndTag(combined: Uint8Array): { ciphertext: Uint8Array; tag: Uint8Array } {
  const tagStart = combined.byteLength - 16
  return {
    ciphertext: combined.subarray(0, tagStart),
    tag: combined.subarray(tagStart),
  }
}

// GCM 同 key 下 iv 绝不可复用,故每次随机生成。
export async function envelopeEncrypt(
  plaintext: Uint8Array,
  kekRaw: Uint8Array,
  kekVersion: number,
): Promise<EnvelopeBlob> {
  const key = await importKek(kekRaw)
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTE_LENGTH))
  const combined = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, toBufferSource(plaintext)),
  )
  const { ciphertext, tag } = splitCiphertextAndTag(combined)
  return { iv, ciphertext: ciphertext.slice(), tag: tag.slice(), kekVersion }
}

// 解密前把 ciphertext||tag 拼回;tag 不匹配时 Web Crypto decrypt 直接 throw。
export async function envelopeDecrypt(
  blob: EnvelopeEncryptedKey | EnvelopeBlob,
  kekRaw: Uint8Array,
): Promise<Uint8Array> {
  const key = await importKek(kekRaw)
  const combined = new Uint8Array(blob.ciphertext.byteLength + blob.tag.byteLength)
  combined.set(blob.ciphertext, 0)
  combined.set(blob.tag, blob.ciphertext.byteLength)
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toBufferSource(blob.iv) },
    key,
    toBufferSource(combined),
  )
  return new Uint8Array(plaintext)
}

export function toEnvelopeEncryptedKey(
  blob: EnvelopeBlob,
  kid: string,
  alg: SigningAlg,
): EnvelopeEncryptedKey {
  return {
    iv: blob.iv,
    ciphertext: blob.ciphertext,
    tag: blob.tag,
    kekVersion: blob.kekVersion,
    kid,
    alg,
  }
}
