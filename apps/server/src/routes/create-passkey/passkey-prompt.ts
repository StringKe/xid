// 登录后的 passkey 创建插页:是否展示由服务端资格字段决定;「暂不」只记在当前浏览器。

export const PASSKEY_PROMPT_DISMISSED_KEY = 'xid.passkeyPrompt.dismissedAt'

export function readPromptDismissed(storage: Pick<Storage, 'getItem'> | null): boolean {
  if (!storage) return false
  try {
    return storage.getItem(PASSKEY_PROMPT_DISMISSED_KEY) !== null
  } catch {
    return false
  }
}

export function writePromptDismissed(storage: Pick<Storage, 'setItem'> | null, now: number): void {
  if (!storage) return
  try {
    storage.setItem(PASSKEY_PROMPT_DISMISSED_KEY, new Date(now).toISOString())
  } catch {
    return
  }
}

export type PromptEligibilityInput = {
  // /v1/me 的 user.passkeyEnrollmentEligible;部署尚未提供该字段时为 undefined。
  serverEligible: boolean | undefined
  passkeyCount: number | undefined
  passkeyMethodEnabled: boolean
  browserSupportsPasskeys: boolean
  dismissed: boolean
}

// 服务端字段优先;没有该字段时按本人已登记 passkey 数为 0 推断,结论只影响是否展示一个可跳过的插页。
export function shouldOfferPasskey(input: PromptEligibilityInput): boolean | 'unknown' {
  if (input.dismissed || !input.browserSupportsPasskeys || !input.passkeyMethodEnabled) return false
  if (input.serverEligible !== undefined) return input.serverEligible
  if (input.passkeyCount === undefined) return 'unknown'
  return input.passkeyCount === 0
}

type CapabilityProbe = { getClientCapabilities?: () => Promise<Record<string, boolean>> }

export async function supportsConditionalCreate(): Promise<boolean> {
  if (typeof PublicKeyCredential === 'undefined') return false
  const probe = (PublicKeyCredential as unknown as CapabilityProbe).getClientCapabilities
  if (!probe) return false
  try {
    const capabilities = await probe()
    return capabilities['conditionalCreate'] === true
  } catch {
    return false
  }
}
