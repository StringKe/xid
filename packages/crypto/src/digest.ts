// SHA-256 / HMAC-SHA256 经 Web Crypto;HMAC 输出标准 base64,对齐 svix webhook 签名格式。

import { toBufferSource } from './buffer-source'

const encoder = new TextEncoder()

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input))
  return bytesToHex(new Uint8Array(digest))
}

export async function sha256HexBytes(input: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', toBufferSource(input))
  return bytesToHex(new Uint8Array(digest))
}

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

// constant-time 比较,避免时序侧信道。
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
