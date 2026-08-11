// 无 @lingui/solid 绑定，直接用 @lingui/core；message id 与 @xid-kit/react 对齐以共用 .po 目录。

import { i18n } from '@lingui/core'

type RuntimeMessage = {
  readonly id: string
  readonly message: string
}

export const sdkMessages = {
  signIn: { id: 'sdk.signIn', message: 'Sign in' },
  signOut: { id: 'sdk.signOut', message: 'Sign out' },
} as const satisfies Record<string, RuntimeMessage>

// 未激活 catalog 时 i18n._ 回落到 descriptor 内的英文 message。
export function t(descriptor: RuntimeMessage): string {
  return i18n._(descriptor)
}
