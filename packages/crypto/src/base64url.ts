// base64url 无填充编解码(RFC 4648 §5)。自研格式编解码,非安全敏感(见 crypto-boundary rule 第三类)。
// JWT header/payload/signature 与 JWK 坐标编码统一走此模块,不引入第三方。

const encoder = new TextEncoder()
const decoder = new TextDecoder()

// 字节 -> base64url(无 padding)。逐块 fromCharCode 避免大输入栈溢出。
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

// UTF-8 字符串 -> base64url。
export function base64UrlEncodeString(value: string): string {
  return base64UrlEncode(encoder.encode(value))
}

// base64url -> 字节。补回 padding 后走 atob。
export function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

// base64url -> UTF-8 字符串。
export function base64UrlDecodeToString(value: string): string {
  return decoder.decode(base64UrlDecode(value))
}
