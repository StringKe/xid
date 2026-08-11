// 不可信重定向目标收敛为站内路径:仅接受单个 "/" 开头;协议相对/绝对/javascript: 回退 fallback。

export function safeInternalPath(target: string | null | undefined, fallback = '/console'): string {
  if (typeof target !== 'string' || target.length === 0) return fallback
  return target.startsWith('/') && !target.startsWith('//') ? target : fallback
}
