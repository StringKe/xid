// session 纯逻辑（token 读写/清除）；createXidSessionStorage 依赖未安装的 peer dep，不测初始化路径。
import { describe, it, expect } from 'vitest'

import {
  getTokenFromSession,
  getRefreshTokenFromSession,
  setTokensInSession,
  clearTokensFromSession,
} from '../session'
import type { XidSession } from '../types'
import { XID_SESSION_ACCESS_TOKEN_KEY, XID_SESSION_REFRESH_TOKEN_KEY } from '../types'

function makeSession(initial: Record<string, string> = {}): XidSession {
  const store = new Map<string, string>(Object.entries(initial))
  return {
    get: (key) => store.get(key),
    set: (key, value) => {
      store.set(key, value)
    },
    unset: (key) => {
      store.delete(key)
    },
    has: (key) => store.has(key),
    get data() {
      return Object.fromEntries(store.entries())
    },
  }
}

describe('getTokenFromSession', () => {
  it('returns access_token when present', () => {
    const session = makeSession({ [XID_SESSION_ACCESS_TOKEN_KEY]: 'tok.abc' })
    expect(getTokenFromSession(session)).toBe('tok.abc')
  })

  it('returns undefined when access_token absent', () => {
    const session = makeSession()
    expect(getTokenFromSession(session)).toBeUndefined()
  })
})

describe('getRefreshTokenFromSession', () => {
  it('returns refresh_token when present', () => {
    const session = makeSession({ [XID_SESSION_REFRESH_TOKEN_KEY]: 'rt.xyz' })
    expect(getRefreshTokenFromSession(session)).toBe('rt.xyz')
  })

  it('returns undefined when refresh_token absent', () => {
    const session = makeSession()
    expect(getRefreshTokenFromSession(session)).toBeUndefined()
  })
})

describe('setTokensInSession', () => {
  it('sets access_token in session', () => {
    const session = makeSession()

    setTokensInSession(session, { accessToken: 'tok.set' })

    expect(session.get(XID_SESSION_ACCESS_TOKEN_KEY)).toBe('tok.set')
  })

  it('sets refresh_token in session when provided', () => {
    const session = makeSession()

    setTokensInSession(session, { accessToken: 'tok.set', refreshToken: 'rt.set' })

    expect(session.get(XID_SESSION_REFRESH_TOKEN_KEY)).toBe('rt.set')
  })

  it('does not set refresh_token key when refreshToken is omitted', () => {
    const session = makeSession()

    setTokensInSession(session, { accessToken: 'tok.only' })

    expect(session.has(XID_SESSION_REFRESH_TOKEN_KEY)).toBe(false)
  })

  it('overwrites existing access_token', () => {
    const session = makeSession({ [XID_SESSION_ACCESS_TOKEN_KEY]: 'old.tok' })

    setTokensInSession(session, { accessToken: 'new.tok' })

    expect(session.get(XID_SESSION_ACCESS_TOKEN_KEY)).toBe('new.tok')
  })
})

describe('clearTokensFromSession', () => {
  it('removes access_token and refresh_token from session', () => {
    const session = makeSession({
      [XID_SESSION_ACCESS_TOKEN_KEY]: 'tok.clear',
      [XID_SESSION_REFRESH_TOKEN_KEY]: 'rt.clear',
    })

    clearTokensFromSession(session)

    expect(session.has(XID_SESSION_ACCESS_TOKEN_KEY)).toBe(false)
    expect(session.has(XID_SESSION_REFRESH_TOKEN_KEY)).toBe(false)
  })

  it('is a no-op when session has no tokens', () => {
    const session = makeSession()

    expect(() => clearTokensFromSession(session)).not.toThrow()
  })

  it('preserves other session keys when clearing tokens', () => {
    const session = makeSession({
      [XID_SESSION_ACCESS_TOKEN_KEY]: 'tok',
      'other:key': 'preserved',
    })

    clearTokensFromSession(session)

    expect(session.get('other:key')).toBe('preserved')
  })
})
