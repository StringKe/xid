// session.ts: Remix cookie session storage for XID tokens.
// 封装 @remix-run/node createCookieSessionStorage,为 access_token / refresh_token
// 提供类型化存储,供 loader/action 读取登录态。
//
// 安全注意:access_token 不得落入客户端可读 localStorage;本模块将其存入 HttpOnly cookie
// (由 Remix createCookieSessionStorage 管理),session secret 禁止硬编码到客户端 bundle。
//
// 依赖:@remix-run/node(peerDependency),运行时由消费者提供。

import { XID_SESSION_ACCESS_TOKEN_KEY, XID_SESSION_REFRESH_TOKEN_KEY } from './types'
import type { XidSession, XidSessionStorage, XidSessionStorageOptions } from './types'

// @remix-run/node createCookieSessionStorage 最小接口契约(peer dep,运行时由消费者提供)。
type RemixCookieSessionStorageOptions = {
  cookie: {
    name?: string
    secrets: readonly string[]
    maxAge?: number
    secure?: boolean
    path?: string
    domain?: string
    sameSite?: 'strict' | 'lax' | 'none'
    httpOnly?: boolean
  }
}

type RemixSessionData = Record<string, string>

type RemixSession = {
  get: (key: string) => string | undefined
  set: (key: string, value: string) => void
  unset: (key: string) => void
  has: (key: string) => boolean
  data: RemixSessionData
}

type RemixSessionStorage = {
  getSession: (cookieHeader?: string | null) => Promise<RemixSession>
  commitSession: (session: RemixSession) => Promise<string>
  destroySession: (session: RemixSession) => Promise<string>
}

type RemixNodeModule = {
  createCookieSessionStorage: (options: RemixCookieSessionStorageOptions) => RemixSessionStorage
}

// 动态 import @remix-run/node(peer dep,运行时由消费者提供)。
// 延迟加载,避免 library bundle 时硬引入 Remix。
async function getRemixNode(): Promise<RemixNodeModule> {
  const mod = (await import('@remix-run/node')) as unknown as RemixNodeModule
  return mod
}

function wrapRemixSession(remixSession: RemixSession): XidSession {
  return {
    get: (key) => remixSession.get(key),
    set: (key, value) => remixSession.set(key, value),
    unset: (key) => remixSession.unset(key),
    has: (key) => remixSession.has(key),
    get data() {
      return remixSession.data
    },
  }
}

// createXidSessionStorage:创建封装 Remix cookie session 的 XidSessionStorage。
//
// 用法(app/sessions.server.ts):
//   import { createXidSessionStorage } from '@xid-kit/remix'
//   export const sessionStorage = createXidSessionStorage({
//     secret: process.env.SESSION_SECRET!,
//   })
//
// 返回 lazy-initialized storage:首次调用 getSession/commit/destroy 时才动态 import Remix。
// 这样 bundle 时不强依赖 @remix-run/node(由 peerDep 满足)。
export function createXidSessionStorage(options: XidSessionStorageOptions): XidSessionStorage {
  const secrets = Array.isArray(options.secret) ? options.secret : [options.secret as string]

  let storage: RemixSessionStorage | null = null

  async function ensureStorage(): Promise<RemixSessionStorage> {
    if (storage) return storage
    const { createCookieSessionStorage } = await getRemixNode()
    storage = createCookieSessionStorage({
      cookie: {
        name: options.cookieName ?? '__xid_session',
        secrets,
        maxAge: options.maxAge ?? 2592000,
        secure: options.secure ?? true,
        path: options.path ?? '/',
        sameSite: options.sameSite ?? 'lax',
        httpOnly: true,
        ...(options.domain ? { domain: options.domain } : {}),
      },
    })
    return storage
  }

  return {
    async getSession(cookieHeader) {
      const s = await ensureStorage()
      const remixSession = await s.getSession(cookieHeader)
      return wrapRemixSession(remixSession)
    },

    async commitSession(session) {
      const s = await ensureStorage()
      // 反向拿到底层 RemixSession(通过 wrapRemixSession 保留引用)。
      // 由于 XidSession 直接代理 RemixSession 的方法,可安全传递 session.data 重建。
      const remixSession = await s.getSession(null)
      for (const [key, value] of Object.entries(session.data)) {
        remixSession.set(key, value)
      }
      return s.commitSession(remixSession)
    },

    async destroySession(session) {
      const s = await ensureStorage()
      const remixSession = await s.getSession(null)
      for (const [key, value] of Object.entries(session.data)) {
        remixSession.set(key, value)
      }
      return s.destroySession(remixSession)
    },
  }
}

// getTokenFromSession:从 XidSession 读取 access_token。
export function getTokenFromSession(session: XidSession): string | undefined {
  return session.get(XID_SESSION_ACCESS_TOKEN_KEY)
}

// getRefreshTokenFromSession:从 XidSession 读取 refresh_token。
export function getRefreshTokenFromSession(session: XidSession): string | undefined {
  return session.get(XID_SESSION_REFRESH_TOKEN_KEY)
}

// setTokensInSession:将 access_token / refresh_token 写入 session。
export function setTokensInSession(
  session: XidSession,
  tokens: { accessToken: string; refreshToken?: string },
): void {
  session.set(XID_SESSION_ACCESS_TOKEN_KEY, tokens.accessToken)
  if (tokens.refreshToken) {
    session.set(XID_SESSION_REFRESH_TOKEN_KEY, tokens.refreshToken)
  }
}

// clearTokensFromSession:从 session 清除 token(sign out)。
export function clearTokensFromSession(session: XidSession): void {
  session.unset(XID_SESSION_ACCESS_TOKEN_KEY)
  session.unset(XID_SESSION_REFRESH_TOKEN_KEY)
}
