import { normalizeInternalNavigationTarget } from './router'

// 不可信重定向目标收敛为站内路径;协议相对、绝对、反斜杠和控制字符一律回退 fallback。
export function safeInternalPath(target: string | null | undefined, fallback: string): string {
  if (typeof target !== 'string' || target.length === 0) return fallback
  return normalizeInternalNavigationTarget(target, fallback)
}
