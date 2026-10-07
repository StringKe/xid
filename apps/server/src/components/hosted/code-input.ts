// 单输入框验证码的纯函数:接受空格与连字符,前端只做格式提示,正确与否只由服务端判断。

export const CODE_CHARSETS = ['numeric', 'alphanumeric', 'device'] as const
export type CodeCharset = (typeof CODE_CHARSETS)[number]

// RFC 8628 6.1:设备码去掉元音与易混字符,不区分大小写。须与 worker/oauth/device.ts 一致。
export const DEVICE_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'

const SEPARATORS = /[\s\-_.]/g

export type CodeFormatIssue = 'empty' | 'too_short' | 'too_long' | 'invalid_character'

export function normalizeCode(raw: string, charset: CodeCharset): string {
  const compact = raw.replace(SEPARATORS, '')
  return charset === 'numeric' ? compact : compact.toUpperCase()
}

function isAllowed(char: string, charset: CodeCharset): boolean {
  if (charset === 'numeric') return char >= '0' && char <= '9'
  if (charset === 'device') return DEVICE_CODE_ALPHABET.includes(char)
  return /^[0-9A-Z]$/.test(char)
}

export function codeFormatIssue(
  raw: string,
  options: { length: number; charset: CodeCharset },
): CodeFormatIssue | null {
  const code = normalizeCode(raw, options.charset)
  if (code.length === 0) return 'empty'
  for (const char of code) {
    if (!isAllowed(char, options.charset)) return 'invalid_character'
  }
  if (code.length < options.length) return 'too_short'
  if (code.length > options.length) return 'too_long'
  return null
}

// 设备码按 RFC 8628 建议的 4-4 分组展示。
export function formatDeviceCode(code: string): string {
  const normalized = normalizeCode(code, 'device')
  return normalized.length === 8 ? `${normalized.slice(0, 4)}-${normalized.slice(4)}` : normalized
}
