const encoder = new TextEncoder()
const decoder = new TextDecoder()

// 逐块 fromCharCode,避免大输入触发栈溢出。
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

export function base64UrlEncodeString(value: string): string {
  return base64UrlEncode(encoder.encode(value))
}

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

export function base64UrlDecodeToString(value: string): string {
  return decoder.decode(base64UrlDecode(value))
}
