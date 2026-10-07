// 只对用户自己输入的标识符做展示用掩码;登录前从不显示服务端保存的联系方式。

export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@')
  if (at <= 0) return email
  const local = Array.from(email.slice(0, at))
  const domain = email.slice(at + 1)
  if (local.length <= 2) return `${local[0] ?? ''}***@${domain}`
  return `${local[0]}***${local[local.length - 1]}@${domain}`
}

export function phoneLastDigits(phone: string, count = 4): string {
  const digits = phone.replace(/\D/g, '')
  return digits.slice(-count)
}
