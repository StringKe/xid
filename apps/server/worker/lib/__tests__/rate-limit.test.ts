// Fail-closed contract for the RateLimitStore transport: when the DO is unreachable or answers
// with an untrustworthy body the request must be rejected, never treated as "limit not hit".
// Rate limiting is the third layer of abuse defense, so passing through means no brute force
// protection at all.
import { describe, expect, it, vi } from 'vitest'
import { POLICIES } from '../../durable-objects/rate-limit-store'
import { checkRateLimitStore, reserveRateLimitWindows } from '../rate-limit'

function makeStore(response: Response) {
  const fetch = vi.fn(async (_input: RequestInfo, _init?: RequestInit) => response)
  const idFromName = vi.fn(
    (name: string) => ({ toString: () => name }) as unknown as DurableObjectId,
  )
  const env = {
    RATE_LIMITER: {
      idFromName,
      get: () => ({ fetch }) as unknown as DurableObjectStub,
    },
  } as unknown as Env
  return { env, fetch, idFromName }
}

function makeEnv(response: Response): Env {
  return makeStore(response).env
}

function sentBody(fetch: ReturnType<typeof makeStore>['fetch']): Record<string, unknown> {
  return JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as Record<string, unknown>
}

function sentUrl(fetch: ReturnType<typeof makeStore>['fetch']): string {
  return String(fetch.mock.calls[0]?.[0])
}

describe('checkRateLimitStore', () => {
  it('returns a typed decision when the DO answers a well-formed CheckResult', async () => {
    const env = makeEnv(Response.json({ allowed: true, retryAfter: 0, count: 1 }))

    const decision = await checkRateLimitStore(env, 'key:1', POLICIES.OTP_SEND)

    expect(decision).toEqual({ allowed: true, retryAfter: 0, count: 1 })
  })

  it('surfaces a denial when the DO answers allowed=false', async () => {
    const env = makeEnv(Response.json({ allowed: false, retryAfter: 42, count: 2 }))

    const decision = await checkRateLimitStore(env, 'key:1', POLICIES.OTP_SEND)

    expect(decision).toEqual({ allowed: false, retryAfter: 42, count: 2 })
  })

  it('fails closed with server_error when the DO returns a non-200 status', async () => {
    const env = makeEnv(Response.json({ allowed: true }, { status: 500 }))

    await expect(checkRateLimitStore(env, 'key:1', POLICIES.OTP_SEND)).rejects.toMatchObject({
      code: 'server_error',
      httpStatus: 500,
    })
  })

  it('fails closed with server_error when the DO returns a non-JSON body', async () => {
    const env = makeEnv(new Response('not json'))

    await expect(checkRateLimitStore(env, 'key:1', POLICIES.OTP_SEND)).rejects.toMatchObject({
      code: 'server_error',
      httpStatus: 500,
    })
  })

  it('fails closed with server_error when the response has no allowed field', async () => {
    const env = makeEnv(Response.json({ ok: true }))

    await expect(checkRateLimitStore(env, 'key:1', POLICIES.OTP_SEND)).rejects.toMatchObject({
      code: 'server_error',
      httpStatus: 500,
    })
  })

  it('fails closed with server_error when allowed is not a boolean', async () => {
    const env = makeEnv(Response.json({ allowed: 'true' }))

    await expect(checkRateLimitStore(env, 'key:1', POLICIES.OTP_SEND)).rejects.toMatchObject({
      code: 'server_error',
      httpStatus: 500,
    })
  })

  it('fails closed with server_error when the DO answers a JSON null body', async () => {
    const env = makeEnv(Response.json(null))

    await expect(checkRateLimitStore(env, 'key:1', POLICIES.OTP_SEND)).rejects.toMatchObject({
      code: 'server_error',
      httpStatus: 500,
    })
  })

  it('forwards the batch count so a bulk request consumes the whole quota', async () => {
    const { env, fetch } = makeStore(Response.json({ allowed: true, retryAfter: 0, count: 30 }))

    await checkRateLimitStore(env, 'invitations:t_1', POLICIES.OTP_SEND, { count: 30 })

    expect(sentBody(fetch)).toMatchObject({ key: 'invitations:t_1', count: 30 })
  })

  it('defaults the batch count to 1 when no count is supplied', async () => {
    const { env, fetch } = makeStore(Response.json({ allowed: true, retryAfter: 0, count: 1 }))

    await checkRateLimitStore(env, 'key:1', POLICIES.OTP_SEND)

    expect(sentBody(fetch)).toMatchObject({ count: 1 })
  })
})

// reserveRateLimitWindows is the only entry point for OTP / magic link send quotas (1/min + 5/h).
// A DO fault must surface as server_error (retryable infrastructure failure) and must never be
// disguised as rate_limited (429), which tells the caller its own traffic was the problem.
describe('reserveRateLimitWindows', () => {
  const WINDOWS = [{ key: 'otp:min:t_1:a@b.com', policy: POLICIES.OTP_SEND }] as const

  it('reserves through the /reserve action on the reservation key instance', async () => {
    const { env, fetch, idFromName } = makeStore(
      Response.json({ allowed: true, retryAfter: 0, counts: [1] }),
    )

    await reserveRateLimitWindows(env, 'otp:send:t_1:a@b.com', WINDOWS)

    expect(idFromName).toHaveBeenCalledWith('otp:send:t_1:a@b.com')
    expect(sentUrl(fetch)).toBe('https://rate-limit/reserve')
    expect(sentBody(fetch)).toMatchObject({ windows: [{ key: 'otp:min:t_1:a@b.com' }] })
  })

  it('rejects with rate_limited when the DO denies the reservation', async () => {
    const env = makeEnv(Response.json({ allowed: false, retryAfter: 42, counts: [2] }))

    await expect(reserveRateLimitWindows(env, 'otp:send:t_1', WINDOWS)).rejects.toMatchObject({
      code: 'rate_limited',
      httpStatus: 429,
    })
  })

  it('fails closed with server_error when a non-200 body still claims allowed:true', async () => {
    const env = makeEnv(Response.json({ allowed: true }, { status: 500 }))

    await expect(reserveRateLimitWindows(env, 'otp:send:t_1', WINDOWS)).rejects.toMatchObject({
      code: 'server_error',
      httpStatus: 500,
    })
  })

  it('fails closed with server_error when a 400 body still claims allowed:true', async () => {
    const env = makeEnv(Response.json({ allowed: true }, { status: 400 }))

    await expect(reserveRateLimitWindows(env, 'otp:send:t_1', WINDOWS)).rejects.toMatchObject({
      code: 'server_error',
      httpStatus: 500,
    })
  })

  it('fails closed with server_error instead of a raw SyntaxError on a non-JSON body', async () => {
    const env = makeEnv(new Response('<html>internal error</html>', { status: 502 }))

    await expect(reserveRateLimitWindows(env, 'otp:send:t_1', WINDOWS)).rejects.toMatchObject({
      code: 'server_error',
      httpStatus: 500,
    })
  })

  it('fails closed with server_error when allowed is not a boolean', async () => {
    const env = makeEnv(Response.json({ allowed: 'true', counts: [1] }))

    await expect(reserveRateLimitWindows(env, 'otp:send:t_1', WINDOWS)).rejects.toMatchObject({
      code: 'server_error',
      httpStatus: 500,
    })
  })

  it('fails closed with server_error when the reservation body has no allowed field', async () => {
    const env = makeEnv(Response.json({ counts: [1] }))

    await expect(reserveRateLimitWindows(env, 'otp:send:t_1', WINDOWS)).rejects.toMatchObject({
      code: 'server_error',
      httpStatus: 500,
    })
  })
})
