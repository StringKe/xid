// SHA-256 摘要(Web Crypto 原语,不自研,见 crypto-boundary rule 第一类)。
// 审计链式 hash(07 章 5.1.2)与其它需小写十六进制摘要的场景统一走此模块。

import { toBufferSource } from './buffer-source'

const encoder = new TextEncoder()

// SHA-256 -> 小写十六进制(64 字符)。输入为 UTF-8 字符串。
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input))
  return bytesToHex(new Uint8Array(digest))
}

// SHA-256 -> 小写十六进制(64 字符)。输入为字节。
export async function sha256HexBytes(input: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', toBufferSource(input))
  return bytesToHex(new Uint8Array(digest))
}

// HMAC-SHA256(Web Crypto 原语),返回 base64 标准编码(svix webhook 签名格式)。
export async function hmacSha256Base64(secret: Uint8Array, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    toBufferSource(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message))
  return bytesToBase64(new Uint8Array(sig))
}

// HMAC-SHA256 验证(constant-time 比较,防时序侧信道)。
export async function hmacSha256Verify(
  secret: Uint8Array,
  message: string,
  expectedBase64: string,
): Promise<boolean> {
  const actual = await hmacSha256Base64(secret, message)
  return timingSafeEqual(actual, expectedBase64)
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false
  }
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) {
    out += b.toString(16).padStart(2, '0')
  }
  return out
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}
