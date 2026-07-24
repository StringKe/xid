// SPA 公开面响应头:WebMCP 需要 origin-isolated 文档 + tools Permissions Policy。
// xid.dev 已注册 Chrome WebMCP origin trial(index.html meta);token 过期前保持启用。
// CSP 只挂 frame-ancestors:login/consent/account 页面被恶意站 iframe 是 clickjacking 面;
// 不加全量 CSP 是样式/字体/图片源太杂,指令收不齐反而误伤。

export const SPA_SECURITY_HEADERS = {
  'Permissions-Policy': 'tools=(self)',
  'Origin-Agent-Cluster': '?1',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': "frame-ancestors 'self'",
} as const

export function applySpaSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(SPA_SECURITY_HEADERS)) {
    if (!headers.has(name)) headers.set(name, value)
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
