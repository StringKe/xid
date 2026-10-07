// 强制 MFA 绑定的步骤:选方法 -> 设置该方法 -> 保存备用码 -> 总结后续跑 /authorize。

export type SetupMethod = 'totp' | 'passkey'

export type SetupStep =
  | { kind: 'choose' }
  | { kind: 'totp' }
  | { kind: 'passkey' }
  | { kind: 'backup'; method: SetupMethod }
  | { kind: 'done'; method: SetupMethod; backupCodeCount: number }

// 用户可在第二步「Set up a different method」;没有 passkey 时只剩验证器,不显示这个入口。
export function alternativeMethod(
  method: SetupMethod,
  passkeyAvailable: boolean,
): SetupMethod | null {
  if (!passkeyAvailable) return null
  return method === 'totp' ? 'passkey' : 'totp'
}

// otpauth://totp/{issuer}:{account}?... 中的账户名,就是验证器里显示的那一行。
export function otpauthAccountName(uri: string): string | null {
  const match = /^otpauth:\/\/totp\/([^?]+)/.exec(uri)
  if (!match?.[1]) return null
  const label = decodeURIComponent(match[1])
  const separator = label.indexOf(':')
  const account = separator >= 0 ? label.slice(separator + 1) : label
  return account.trim() || null
}

// otpauth 密钥按 4 位分组,手动输入时更容易对照。
export function groupSecret(secret: string): string {
  return secret.replace(/\s+/g, '').replace(/(.{4})(?=.)/g, '$1 ')
}
