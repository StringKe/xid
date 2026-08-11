// Remix HttpOnly cookie session 存 access_token / refresh_token；禁止落入 localStorage，session secret 禁止进客户端 bundle。

import { XID_SESSION_ACCESS_TOKEN_KEY, XID_SESSION_REFRESH_TOKEN_KEY } from './types'
import type { XidSession, XidSessionStorage, XidSessionStorageOptions } from './types'

// @remix-run/node createCookieSessionStorage 最小接口（peer dep，运行时由消费者提供）。
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

// 延迟 import，避免 library bundle 硬依赖 @remix-run/node。
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

// 首次 getSession/commit/destroy 时才动态 import Remix（peerDep 运行时满足）。
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
      // wrap 后丢失 RemixSession 引用，只能用 session.data 重建再 commit。
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

export function getTokenFromSession(session: XidSession): string | undefined {
  return session.get(XID_SESSION_ACCESS_TOKEN_KEY)
}

export function getRefreshTokenFromSession(session: XidSession): string | undefined {
  return session.get(XID_SESSION_REFRESH_TOKEN_KEY)
}

export function setTokensInSession(
  session: XidSession,
  tokens: { accessToken: string; refreshToken?: string },
): void {
  session.set(XID_SESSION_ACCESS_TOKEN_KEY, tokens.accessToken)
  if (tokens.refreshToken) {
    session.set(XID_SESSION_REFRESH_TOKEN_KEY, tokens.refreshToken)
  }
}

export function clearTokensFromSession(session: XidSession): void {
  session.unset(XID_SESSION_ACCESS_TOKEN_KEY)
  session.unset(XID_SESSION_REFRESH_TOKEN_KEY)
}
