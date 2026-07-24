// me-auth/shared 单元测试:限流 DO、session 守卫、请求元数据、Turnstile 校验。
import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionData, TenantVar, XidHonoEnv } from '../../lib/types'
import {
  checkRateLimit,
  enforceSendRateLimit,
  requireSession,
  requestIp,
  requestUserAgent,
  SEND_PER_HOUR_POLICY,
  verifyTurnstile,
} from '../shared'
import { POLICIES } from '../../durable-objects/rate-limit-store'
import { makeRateLimitNs, makeSession } from './helpers'

function makeCtx(
  options: {
    session?: SessionData | null
    headers?: Record<string, string>
  } = {},
): Parameters<typeof requireSession>[0] {
  const app = new Hono<XidHonoEnv>()
  let ctx!: Parameters<typeof requireSession>[0]
  app.get('/probe', async (c) => {
    ctx = c
    return c.text('ok')
  })
  return {
    async get() {
      await app.request('https://test.xid.dev/probe', { headers: options.headers }, {} as Env)
      ctx.set('tenant', { tenantId: 't1' } as TenantVar)
      ctx.set('session', options.session ?? null)
      return ctx
    },
  }
}

describe('checkRateLimit', () => {
  it('returns allowed flag from RateLimitStore DO', async () => {
    const env = { RATE_LIMITER: makeRateLimitNs(true) } as unknown as Env
    await expect(checkRateLimit(env, 'key:1', POLICIES.OTP_SEND)).resolves.toBe(true)
  })

  it('returns false when DO denies request', async () => {
    const env = { RATE_LIMITER: makeRateLimitNs(false) } as unknown as Env
    await expect(checkRateLimit(env, 'key:1', SEND_PER_HOUR_POLICY)).resolves.toBe(false)
  })
})

describe('enforceSendRateLimit', () => {
  it('throws rate_limited when minute window exceeded', async () => {
    const env = { RATE_LIMITER: makeRateLimitNs(false) } as unknown as Env
    await expect(enforceSendRateLimit(env, 'magic', 'user@example.com')).rejects.toMatchObject({
      code: 'rate_limited',
    })
  })

  it('passes when both minute and hour windows allow', async () => {
    const env = { RATE_LIMITER: makeRateLimitNs(true) } as unknown as Env
    await expect(enforceSendRateLimit(env, 'otp', '+14155552671')).resolves.toBeUndefined()
  })
})

describe('requireSession', () => {
  it('throws unauthorized when session missing', async () => {
    const c = await makeCtx({ session: null }).get()
    await expect(requireSession(c)).rejects.toMatchObject({
      code: 'unauthorized',
      httpStatus: 401,
    })
  })

  it('returns session from context when present', async () => {
    const session = makeSession('user_42')
    const c = await makeCtx({ session }).get()
    await expect(requireSession(c)).resolves.toBe(session)
  })

  it('throws unauthorized for pending_mfa session(MFA 未完成不算已认证)', async () => {
    const c = await makeCtx({ session: { ...makeSession('user_42'), status: 'pending_mfa' } }).get()
    await expect(requireSession(c)).rejects.toMatchObject({
      code: 'unauthorized',
      httpStatus: 401,
    })
  })

  it('throws unauthorized for pending_mfa_setup session', async () => {
    const c = await makeCtx({
      session: { ...makeSession('user_42'), status: 'pending_mfa_setup' },
    }).get()
    await expect(requireSession(c)).rejects.toMatchObject({
      code: 'unauthorized',
      httpStatus: 401,
    })
  })
})

describe('requestIp / requestUserAgent', () => {
  it('reads cf-connecting-ip and user-agent headers', async () => {
    const c = await makeCtx({
      headers: {
        'cf-connecting-ip': '203.0.113.10',
        'user-agent': 'xid-test/1.0',
      },
    }).get()
    expect(requestIp(c)).toBe('203.0.113.10')
    expect(requestUserAgent(c)).toBe('xid-test/1.0')
  })
})

describe('verifyTurnstile', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('skips verification when TURNSTILE_SECRET is not configured', async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const env = {} as Env

    await expect(verifyTurnstile(null, env)).resolves.toBeUndefined()
    await expect(verifyTurnstile('', env)).resolves.toBeUndefined()
    await expect(verifyTurnstile('token-value', env)).resolves.toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('passes when siteverify returns success=true', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ success: true }))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const env = { TURNSTILE_SECRET: 'test-secret' } as unknown as Env

    await expect(verifyTurnstile('token-value', env, '203.0.113.10')).resolves.toBeUndefined()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify')
    const body = init.body as URLSearchParams
    expect(body.get('secret')).toBe('test-secret')
    expect(body.get('response')).toBe('token-value')
    expect(body.get('remoteip')).toBe('203.0.113.10')
  })

  it('rejects with captcha_required when secret is configured but token missing', async () => {
    const env = { TURNSTILE_SECRET: 'test-secret' } as unknown as Env

    await expect(verifyTurnstile(null, env)).rejects.toMatchObject({ code: 'captcha_required' })
    await expect(verifyTurnstile('', env)).rejects.toMatchObject({ code: 'captcha_required' })
  })

  it('rejects with captcha_failed when siteverify returns success=false', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(Response.json({ success: false })) as unknown as typeof fetch
    const env = { TURNSTILE_SECRET: 'test-secret' } as unknown as Env

    await expect(verifyTurnstile('token-value', env)).rejects.toMatchObject({
      code: 'captcha_failed',
    })
  })

  it('rejects with captcha_failed when siteverify request fails or times out', async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error('network_down')) as unknown as typeof fetch
    const env = { TURNSTILE_SECRET: 'test-secret' } as unknown as Env

    await expect(verifyTurnstile('token-value', env)).rejects.toMatchObject({
      code: 'captcha_failed',
    })
  })
})
