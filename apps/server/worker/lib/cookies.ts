// __Host- 前缀 cookie 读写辅助(对照 docs/design/05-users-sessions.md 8.2)。
// RFC 6265bis __Host- prefix 强制:Secure + Path=/ + 无 Domain attribute;防子域 cookie 注入。
// session refresh token cookie 名结构:__Host-xid.rt.{session_id[0:8]}(多 tab/多 session namespace,见 05 章 8.4)。
// 铁律:HttpOnly 防 XSS 读取,SameSite=Lax 兼容 OAuth redirect。

import { getCookie, setCookie } from 'hono/cookie'
import type { Context } from 'hono'

// refresh token cookie 命名空间前缀(__Host- prefix 不允许 dot 作首字符,xid.rt. 加在其后)。
const RT_COOKIE_PREFIX = '__Host-xid.rt.'
// session_id 前缀长度(取前 8 字符作 cookie namespace,见 05 章 8.4)。
const SESSION_ID_PREFIX_LEN = 8

// __Host- cookie 固定 attribute(Secure/Path/HttpOnly/SameSite),Domain 必须省略。
const HOST_COOKIE_BASE = {
  path: '/',
  secure: true,
  httpOnly: true,
  sameSite: 'Lax',
} as const

// session_id -> refresh token cookie 名(__Host-xid.rt.{prefix})。
export function rtCookieName(sessionId: string): string {
  return `${RT_COOKIE_PREFIX}${sessionId.slice(0, SESSION_ID_PREFIX_LEN)}`
}

// 设置 refresh token cookie。maxAgeSec 控制记住我(7d/30d)或会话生命周期(省略)。
export function setRefreshTokenCookie(
  c: Context,
  options: { sessionId: string; token: string; maxAgeSec?: number },
): void {
  setCookie(c, rtCookieName(options.sessionId), options.token, {
    ...HOST_COOKIE_BASE,
    ...(options.maxAgeSec === undefined ? {} : { maxAge: options.maxAgeSec }),
  })
}

// 删除 refresh token cookie(Max-Age=0 + 空值,见 05 章 8.2)。
export function clearRefreshTokenCookie(c: Context, sessionId: string): void {
  setCookie(c, rtCookieName(sessionId), '', { ...HOST_COOKIE_BASE, maxAge: 0 })
}

// 读取指定 session 的 refresh token cookie 值。
export function readRefreshTokenCookie(c: Context, sessionId: string): string | undefined {
  return getCookie(c, rtCookieName(sessionId))
}

// 读取所有 __Host-xid.rt.* cookie,返回 {prefix -> token}(多 session 枚举,见 05 章 8.4)。
export function readAllRefreshTokenCookies(c: Context): Record<string, string> {
  const all = getCookie(c)
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(all)) {
    if (name.startsWith(RT_COOKIE_PREFIX)) {
      result[name.slice(RT_COOKIE_PREFIX.length)] = value
    }
  }
  return result
}
