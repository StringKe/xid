// AES-256-GCM 信封加密(见 signing-keys rule 7.1、08 章 16.3 三 blob 拆分决策)。
// 原语只用 Web Crypto(crypto.subtle / crypto.getRandomValues),禁手写/禁第三方(见 crypto-boundary rule)。
// KEK 由调用方从 env.KEK 传入,本模块不持有任何模块级密钥常量(见 tenant-context rule 铁律)。

import type { EnvelopeEncryptedKey, SigningAlg } from '@xid-kit/types'

import { toBufferSource } from './buffer-source'

const IV_BYTE_LENGTH = 12
const KEK_BYTE_LENGTH = 32

// 信封加密产出:iv / ciphertext / tag 拆分三段(对齐 08 章 16.3,private_key_iv/ciphertext/tag 三字段)。
export type EnvelopeBlob = {
  iv: Uint8Array
  ciphertext: Uint8Array
  tag: Uint8Array
  kekVersion: number
}

// 把调用方传入的 KEK(raw 32 字节)导入为不可导出 AES-GCM key,仅用于本次 encrypt/decrypt。
async function importKek(kekRaw: Uint8Array): Promise<CryptoKey> {
  if (kekRaw.byteLength !== KEK_BYTE_LENGTH) {
    throw new Error(`KEK must be ${KEK_BYTE_LENGTH} bytes (AES-256), got ${kekRaw.byteLength}`)
  }
  return crypto.subtle.importKey('raw', toBufferSource(kekRaw), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ])
}

// Web Crypto AES-GCM 输出把 16 字节 tag 附在 ciphertext 末尾,这里拆成独立 tag 字段(对齐 08 章三 blob)。
function splitCiphertextAndTag(combined: Uint8Array): { ciphertext: Uint8Array; tag: Uint8Array } {
  const tagStart = combined.byteLength - 16
  return {
    ciphertext: combined.subarray(0, tagStart),
    tag: combined.subarray(tagStart),
  }
}

// AES-256-GCM 加密。iv 每次随机生成(GCM 同 key 下 iv 绝不复用)。
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

// AES-256-GCM 解密。把拆分的 ciphertext||tag 拼回供 Web Crypto 验证 GCM tag,tag 不匹配即 decrypt throw。
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

// 把 EnvelopeBlob 升级为契约 EnvelopeEncryptedKey(补 kid/alg,签名密钥落库用)。
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
