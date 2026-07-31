// 公开 R2 读取路由:org logo 经 worker 自 serve,URL 走 issuer 而非独立存储域。
// 挂在公开路径不过 tenant 中间件:logo 在登录页未认证渲染,且 key 已含 tenantId/orgId。
// key 末段是 uuid 不可枚举,属 capability URL;只放行 /storage/logos/ 前缀,
// 同 bucket 还有邮件 locale packs、私有 privacy exports 与不可变 compliance evidence,
// 不能经公开路由暴露。Avatar 与 GeoIP MMDB 仍是 reserved capability,尚未实现。

import type { Hono } from 'hono'
import type { XidHonoEnv } from './lib/types'

// 上传端只按 file.type 原样落 httpMetadata,serve 侧收窄到图片白名单:
// 否则任意类型(如 text/html)会从同源域下发,构成存储型 XSS。
const LOGO_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/svg+xml',
  'image/webp',
])

export function registerStorageRoutes(app: Hono<XidHonoEnv>): void {
  app.get('/storage/logos/*', async (c) => {
    const key = c.req.path.slice('/storage/'.length)
    const object = await c.env.STORAGE.get(key)
    if (!object) return c.json({ code: 'not_found', message: 'Not found.' }, 404)

    const stored = object.httpMetadata?.contentType ?? ''
    const contentType = LOGO_CONTENT_TYPES.has(stored) ? stored : 'application/octet-stream'
    const headers: Record<string, string> = {
      'content-type': contentType,
      // key 带 uuid,重新上传即新 URL,旧 URL 内容永不变化。
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    }
    if (contentType === 'image/svg+xml') {
      // svg 可内嵌脚本,禁脚本执行后按图片渲染才安全。
      headers['content-security-policy'] = "script-src 'none'"
    }
    return new Response(object.body, { status: 200, headers })
  })
}
