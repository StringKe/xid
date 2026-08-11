// 公开 serve org logo(登录页无认证);只放行 /storage/logos/,同 bucket 私有对象不可暴露。

import type { Hono } from 'hono'
import type { XidHonoEnv } from './lib/types'

// serve 侧收窄图片白名单,防 text/html 等同源存储型 XSS。
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
      // uuid key:重传新 URL,旧内容不可变。
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    }
    if (contentType === 'image/svg+xml') {
      // svg 可内嵌脚本,禁 script 后才安全按图渲染。
      headers['content-security-policy'] = "script-src 'none'"
    }
    return new Response(object.body, { status: 200, headers })
  })
}
