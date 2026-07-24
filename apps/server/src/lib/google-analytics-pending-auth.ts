// 跨页重定向登录(social / enterprise SSO / magic link)完成后补发 login/sign_up。
// finishSignIn 已直接上报的路径不写入 pending,避免重复计数。

import type { AuthFlowIntent, AuthMethod } from './google-analytics-funnel'

const STORAGE_KEY = 'xid:analytics:pending-auth'

export type PendingAuthCompletion = {
  method: AuthMethod
  intent: AuthFlowIntent
}

export function setPendingAuthCompletion(input: PendingAuthCompletion): void {
  if (typeof sessionStorage === 'undefined') return
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(input))
  } catch {
    // quota / private mode:跳过补发,不阻断登录
  }
}

export function clearPendingAuthCompletion(): void {
  if (typeof sessionStorage === 'undefined') return
  try {
    sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
}

export function consumePendingAuthCompletion(): PendingAuthCompletion | null {
  if (typeof sessionStorage === 'undefined') return null
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    sessionStorage.removeItem(STORAGE_KEY)
    const parsed = JSON.parse(raw) as PendingAuthCompletion
    if (!parsed?.method || !parsed?.intent) return null
    return parsed
  } catch {
    return null
  }
}
