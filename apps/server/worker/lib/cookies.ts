// __Host- cookie:Secure+Path=/+无 Domain,防子域注入;HttpOnly+SameSite=Lax。
// refresh:`__Host-xid.rt.{8-char}` 多 session 命名空间(05 章 8.4)。

import { getCookie, setCookie } from 'hono/cookie'
import type { Context } from 'hono'

// __Host- 前缀后不允许以 dot 开头,故用 xid.rt.。
const RT_COOKIE_PREFIX = '__Host-xid.rt.'
// 活跃会话指针只含 session id(非凭证);HttpOnly 保证同源请求选同一 refresh cookie。
const ACTIVE_SESSION_COOKIE = '__Host-xid.active'
// cookie namespace 取 8 字符:sess_ 跳过前缀,存量 UUID 取前 8。
const SESSION_ID_PREFIX_LEN = 8

// __Host- 固定 Secure/Path/HttpOnly/SameSite,Domain 必须省略。
const HOST_COOKIE_BASE = {
  path: '/',
  secure: true,
  httpOnly: true,
  sameSite: 'Lax',
} as const

function sessionCookieNamespace(sessionId: string): string {
  const randomPart = sessionId.startsWith('sess_') ? sessionId.slice('sess_'.length) : sessionId
  return randomPart.slice(0, SESSION_ID_PREFIX_LEN)
}

export function rtCookieName(sessionId: string): string {
  return `${RT_COOKIE_PREFIX}${sessionCookieNamespace(sessionId)}`
}

// maxAgeSec 控制记住我(7d/30d);省略则为会话 cookie。
export function setRefreshTokenCookie(
  c: Context,
  options: { sessionId: string; token: string; maxAgeSec?: number },
): void {
  setCookie(c, rtCookieName(options.sessionId), options.token, {
    ...HOST_COOKIE_BASE,
    ...(options.maxAgeSec === undefined ? {} : { maxAge: options.maxAgeSec }),
  })
}

export function clearRefreshTokenCookie(c: Context, sessionId: string): void {
  setCookie(c, rtCookieName(sessionId), '', { ...HOST_COOKIE_BASE, maxAge: 0 })
}

export function readRefreshTokenCookie(c: Context, sessionId: string): string | undefined {
  return getCookie(c, rtCookieName(sessionId))
}

// 枚举全部 __Host-xid.rt.* (多 session,见 05 章 8.4)。
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

export function setActiveSessionCookie(c: Context, sessionId: string): void {
  setCookie(c, ACTIVE_SESSION_COOKIE, sessionId, HOST_COOKIE_BASE)
}

export function readActiveSessionCookie(c: Context): string | undefined {
  return getCookie(c, ACTIVE_SESSION_COOKIE)
}

export function clearActiveSessionCookie(c: Context): void {
  setCookie(c, ACTIVE_SESSION_COOKIE, '', { ...HOST_COOKIE_BASE, maxAge: 0 })
}

// tenant/session 中间件须同序检查;活跃指针失效时回落其余凭证,避免一会话吊销遮蔽另一会话。
export function readRefreshTokenCookiesInPriorityOrder(c: Context): readonly string[] {
  const all = readAllRefreshTokenCookies(c)
  const activeSessionId = readActiveSessionCookie(c)
  if (!activeSessionId) return Object.values(all)

  const activePrefix = sessionCookieNamespace(activeSessionId)
  const activeToken = all[activePrefix]
  if (!activeToken) return Object.values(all)
  return [
    activeToken,
    ...Object.entries(all).flatMap(([prefix, token]) => (prefix === activePrefix ? [] : [token])),
  ]
}
