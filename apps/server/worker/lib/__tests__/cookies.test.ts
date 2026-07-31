// __Host- refresh token cookie 读写测试(对照 05 章 8.2 / 8.4)。
// 用真实 Hono app 走 setCookie/getCookie,断言 Set-Cookie attribute 与多 session namespace。

import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import {
  clearActiveSessionCookie,
  clearRefreshTokenCookie,
  readActiveSessionCookie,
  readAllRefreshTokenCookies,
  readRefreshTokenCookiesInPriorityOrder,
  readRefreshTokenCookie,
  rtCookieName,
  setActiveSessionCookie,
  setRefreshTokenCookie,
} from '../cookies'

describe('rtCookieName', () => {
  it('legacy UUID 取前 8 字符作 __Host-xid.rt. namespace', () => {
    expect(rtCookieName('01HZ9K2SABCDEF')).toBe('__Host-xid.rt.01HZ9K2S')
  })

  it('prefixed session id 跳过固定 sess_ 并保留 8 个随机字符', () => {
    expect(rtCookieName('sess_AbCdEfGhIjKlMnOpQrStu')).toBe('__Host-xid.rt.AbCdEfGh')
  })

  it('短 session_id 整体作前缀', () => {
    expect(rtCookieName('abc')).toBe('__Host-xid.rt.abc')
  })
})

describe('setRefreshTokenCookie: __Host- attribute', () => {
  it('记住我设置 Max-Age,带 Secure/HttpOnly/Path/SameSite,无 Domain', async () => {
    const app = new Hono()
    app.get('/', (c) => {
      setRefreshTokenCookie(c, { sessionId: '01HZ9K2S', token: 'tok_abc', maxAgeSec: 2592000 })
      return c.text('ok')
    })
    const res = await app.request('http://x.test/')
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain('__Host-xid.rt.01HZ9K2S=tok_abc')
    expect(setCookie).toContain('Max-Age=2592000')
    expect(setCookie).toContain('Path=/')
    expect(setCookie).toContain('Secure')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Lax')
    expect(setCookie.toLowerCase()).not.toContain('domain=')
  })

  it('不记住我(无 maxAgeSec)不带 Max-Age', async () => {
    const app = new Hono()
    app.get('/', (c) => {
      setRefreshTokenCookie(c, { sessionId: '01HZ9K2S', token: 'tok_abc' })
      return c.text('ok')
    })
    const res = await app.request('http://x.test/')
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).not.toContain('Max-Age')
  })
})

describe('clearRefreshTokenCookie', () => {
  it('Max-Age=0 + 空值删除 cookie', async () => {
    const app = new Hono()
    app.get('/', (c) => {
      clearRefreshTokenCookie(c, '01HZ9K2S')
      return c.text('ok')
    })
    const res = await app.request('http://x.test/')
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain('__Host-xid.rt.01HZ9K2S=;')
    expect(setCookie).toContain('Max-Age=0')
  })
})

describe('readRefreshTokenCookie / readAllRefreshTokenCookies', () => {
  it('读取指定 session 的 cookie 值', async () => {
    const app = new Hono()
    app.get('/', (c) => c.json({ token: readRefreshTokenCookie(c, '01HZ9K2S') ?? null }))
    const res = await app.request('http://x.test/', {
      headers: { cookie: '__Host-xid.rt.01HZ9K2S=tok_a; other=1' },
    })
    expect(await res.json()).toEqual({ token: 'tok_a' })
  })

  it('多 session 下枚举所有 __Host-xid.rt.* cookie(prefix -> token)', async () => {
    const app = new Hono()
    app.get('/', (c) => c.json(readAllRefreshTokenCookies(c)))
    const res = await app.request('http://x.test/', {
      headers: {
        cookie: '__Host-xid.rt.01HZ9K2S=tok_a; __Host-xid.rt.01HZ9K3T=tok_b; sid=irrelevant',
      },
    })
    expect(await res.json()).toEqual({ '01HZ9K2S': 'tok_a', '01HZ9K3T': 'tok_b' })
  })

  it('无匹配 cookie 时返回空对象 / undefined', async () => {
    const app = new Hono()
    app.get('/', (c) =>
      c.json({
        one: readRefreshTokenCookie(c, '01HZ9K2S') ?? null,
        all: readAllRefreshTokenCookies(c),
      }),
    )
    const res = await app.request('http://x.test/', { headers: { cookie: 'sid=1' } })
    expect(await res.json()).toEqual({ one: null, all: {} })
  })
})

describe('active session pointer', () => {
  it('sets an HttpOnly __Host- pointer without carrying refresh credentials', async () => {
    const app = new Hono()
    app.get('/', (c) => {
      setActiveSessionCookie(c, '01HZ9K3T-full-session-id')
      return c.text('ok')
    })

    const res = await app.request('http://x.test/')
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain('__Host-xid.active=01HZ9K3T-full-session-id')
    expect(setCookie).toContain('Path=/')
    expect(setCookie).toContain('Secure')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Lax')
  })

  it('prioritizes the selected refresh cookie and preserves fallback order', async () => {
    const app = new Hono()
    app.get('/', (c) =>
      c.json({
        active: readActiveSessionCookie(c) ?? null,
        tokens: readRefreshTokenCookiesInPriorityOrder(c),
      }),
    )
    const res = await app.request('http://x.test/', {
      headers: {
        cookie:
          '__Host-xid.rt.01HZ9K2S=tok_a; __Host-xid.rt.01HZ9K3T=tok_b; __Host-xid.active=01HZ9K3T-full',
      },
    })

    expect(await res.json()).toEqual({
      active: '01HZ9K3T-full',
      tokens: ['tok_b', 'tok_a'],
    })
  })

  it('clears the active pointer with Max-Age=0', async () => {
    const app = new Hono()
    app.get('/', (c) => {
      clearActiveSessionCookie(c)
      return c.text('ok')
    })

    const res = await app.request('http://x.test/')
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain('__Host-xid.active=;')
    expect(setCookie).toContain('Max-Age=0')
  })
})
