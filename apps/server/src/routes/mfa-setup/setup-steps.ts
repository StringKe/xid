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
// 认证器显示的名称:issuer 参数加 label 里 issuer 前缀之后的账户名。
export function otpauthDisplayName(uri: string): { issuer: string; account: string } | null {
  const match = /^otpauth:\/\/totp\/([^?]+)(?:\?(.*))?$/.exec(uri)
  if (!match?.[1]) return null
  const label = decodeURIComponent(match[1])
  const separator = label.indexOf(':')
  const prefix = separator >= 0 ? label.slice(0, separator).trim() : ''
  const account = (separator >= 0 ? label.slice(separator + 1) : label).trim()
  const issuer = new URLSearchParams(match[2] ?? '').get('issuer')?.trim() || prefix
  return account && issuer ? { issuer, account } : null
}
