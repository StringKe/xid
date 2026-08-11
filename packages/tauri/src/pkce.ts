// WebView Web Crypto 做 PKCE S256（不产出 plain）；随机源由 getRandomValues 注入。

export type PkceChallenge = {
  verifier: string
  challenge: string
  method: 'S256'
}

// PKCE 要求 verifier 熵 >= 256 bit，byteLength 应 >= 32。
export function generateBase64UrlRandom(byteLength: number): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return encodeBase64Url(bytes)
}

export async function deriveS256Challenge(verifier: string): Promise<string> {
  const encoded = new TextEncoder().encode(verifier)
  const digest = await crypto.subtle.digest('SHA-256', encoded)
  return encodeBase64Url(new Uint8Array(digest))
}

export async function generatePkce(): Promise<PkceChallenge> {
  // 64 字节 -> 约 86 字符 base64url（规范要求 43–128）。
  const verifier = generateBase64UrlRandom(64)
  const challenge = await deriveS256Challenge(verifier)
  return { verifier, challenge, method: 'S256' }
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replaceAll('=', '')
}
