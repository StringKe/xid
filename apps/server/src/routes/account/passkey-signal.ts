// WebAuthn Signal API:删除或重命名 passkey 后告诉凭据管理器,让它隐藏已移除的凭据并更新显示名。
// 浏览器不支持时什么也不做;凭据管理器是否处理由浏览器决定,结果不影响账户里的改动。

import type { PasskeySignalData } from './types'

type SignalCapablePublicKeyCredential = typeof PublicKeyCredential & {
  signalAllAcceptedCredentials?: (options: {
    rpId: string
    userId: string
    allAcceptedCredentialIds: string[]
  }) => Promise<void>
  signalCurrentUserDetails?: (options: {
    rpId: string
    userId: string
    name: string
    displayName: string
  }) => Promise<void>
}

export async function signalPasskeyState(data: PasskeySignalData): Promise<void> {
  if (typeof PublicKeyCredential === 'undefined') return
  const api = PublicKeyCredential as SignalCapablePublicKeyCredential
  await api.signalAllAcceptedCredentials?.({
    rpId: data.rpId,
    userId: data.userId,
    allAcceptedCredentialIds: data.allAcceptedCredentialIds,
  })
  await api.signalCurrentUserDetails?.({
    rpId: data.rpId,
    userId: data.userId,
    name: data.name,
    displayName: data.displayName,
  })
}
