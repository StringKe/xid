// 一次性码输入的纯函数:粘贴或自动填充的内容里允许空格、连字符等分隔符,只保留目标字符集。

export type OtpCharset = 'numeric' | 'alphanumeric'

const NUMERIC = /[0-9]/
const ALPHANUMERIC = /[0-9A-Z]/

export function sanitizeOtp(raw: string, options: { length: number; charset: OtpCharset }): string {
  const pattern = options.charset === 'numeric' ? NUMERIC : ALPHANUMERIC
  const normalized = options.charset === 'numeric' ? raw : raw.toUpperCase()
  let result = ''
  for (const char of normalized) {
    if (!pattern.test(char)) continue
    result += char
    if (result.length >= options.length) break
  }
  return result
}

export function otpCells(value: string, length: number): string[] {
  return Array.from({ length }, (_unused, index) => value[index] ?? '')
}

// 视觉分组:6 位分 3+3,8 位分 4+4,其余不分。返回每组的长度。
export function otpGroups(length: number): number[] {
  if (length === 6) return [3, 3]
  if (length === 8) return [4, 4]
  return [length]
}
