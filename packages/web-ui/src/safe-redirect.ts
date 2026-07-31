// safeInternalPath:把不可信的重定向目标收敛为站内路径。
// 规则:仅接受以单个 "/" 开头的站内路径;协议相对("//")、绝对 URL、
// javascript: 等一律回退到 fallback。全产品面唯一实现,页面不再各自手写校验。

export function safeInternalPath(target: string | null | undefined, fallback = '/console'): string {
  if (typeof target !== 'string' || target.length === 0) return fallback
  return target.startsWith('/') && !target.startsWith('//') ? target : fallback
}
