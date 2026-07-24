// 未命中协议/API 前缀的 404 blocker:协议路径不得落到 SPA fallback。
// 独立成模块是因为 index.ts 经 errorHandler 传递依赖 @xid-kit/i18n 的 lingui macro,
// node 测试池不可加载(见 middleware/__tests__/i18n.test.ts),blocker 需要可单测。
// SCIM 前缀走 scimError 形状(RFC7644 3.12),其余前缀走 XidAPIError JSON。

import type { Hono } from 'hono'
import { scimError } from '../scim/shared'
import type { XidHonoEnv } from './types'

const UNMATCHED_PROTOCOL_PREFIXES = ['/auth/', '/sso/', '/scim/', '/v1/'] as const

const UNMATCHED_PROTOCOL_PATHS = new Set(['/frontchannel_logout'])

function isUnmatchedProtocolPath(pathname: string): boolean {
  return (
    UNMATCHED_PROTOCOL_PATHS.has(pathname) ||
    UNMATCHED_PROTOCOL_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  )
}

export function registerUnmatchedProtocolBlocker(app: Hono<XidHonoEnv>): void {
  app.all('*', async (c, next) => {
    const pathname = new URL(c.req.url).pathname
    // SCIM 客户端(RFC7644)期望 Error URN + application/scim+json,XidAPIError 形状会破坏解析。
    if (pathname.startsWith('/scim/')) return scimError(c, 404, 'Not found')
    if (isUnmatchedProtocolPath(pathname)) {
      return c.json({ code: 'not_found', message: 'Not found.' }, 404)
    }
    await next()
  })
}
