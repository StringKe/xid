import { describe, expect, it } from 'vitest'
import { AppError } from '../../lib/errors'
import { reserveOtpSendRateLimit, validatePhoneOtpTarget } from '../otp'

type Reservation = { name: string; keys: string[]; maxRequests: number[] }

function makeEnv(options: { rejectName?: string; failName?: string } = {}) {
  const reservations: Reservation[] = []
  const env = {
    RATE_LIMITER: {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        fetch: async (_url: string, init: { body: string }) => {
          const body = JSON.parse(init.body) as {
            windows: Array<{ key: string; policy: { maxRequests: number } }>
          }
          reservations.push({
            name,
            keys: body.windows.map((window) => window.key),
            maxRequests: body.windows.map((window) => window.policy.maxRequests),
          })
          if (name === options.failName) return new Response('down', { status: 500 })
          return Response.json({ allowed: name !== options.rejectName })
        },
      }),
    },
  } as unknown as Env
  return { env, reservations }
}

describe('validatePhoneOtpTarget', () => {
  it('accepts US and Canadian geographic area codes', () => {
    expect(validatePhoneOtpTarget('+12125550142')).toBe(true)
    expect(validatePhoneOtpTarget('+14165550142')).toBe(true)
  })

  it('rejects Caribbean and US territory numbers inside +1', () => {
    expect(validatePhoneOtpTarget('+18765550142')).toBe(false)
    expect(validatePhoneOtpTarget('+18095550142')).toBe(false)
    expect(validatePhoneOtpTarget('+12425550142')).toBe(false)
    expect(validatePhoneOtpTarget('+17875550142')).toBe(false)
  })

  it('rejects toll-free, malformed and non-NANP numbers', () => {
    expect(validatePhoneOtpTarget('+18005550142')).toBe(false)
    expect(validatePhoneOtpTarget('+12120550142')).toBe(false)
    expect(validatePhoneOtpTarget('+1212555014')).toBe(false)
    expect(validatePhoneOtpTarget('+447700900123')).toBe(false)
  })
})

describe('reserveOtpSendRateLimit', () => {
  it('reserves IP, recipient and tenant budgets for a phone target', async () => {
    const { env, reservations } = makeEnv()

    await reserveOtpSendRateLimit(env, '+12125550142', 'tenant-1', { ip: '203.0.113.7' })

    expect(reservations.map((reservation) => reservation.name)).toEqual([
      'otp:phone:ip:203.0.113.7',
      'otp:send:tenant-1:+12125550142',
      'otp:phone:tenant:tenant-1',
    ])
    expect(reservations[0]?.keys).toEqual([
      'otp:phone:ip:203.0.113.7:hour',
      'otp:phone:ip:203.0.113.7:day',
    ])
  })

  it('reserves only the recipient budget for an email target', async () => {
    const { env, reservations } = makeEnv()

    await reserveOtpSendRateLimit(env, 'user@example.com', 'tenant-1', { ip: '203.0.113.7' })

    expect(reservations.map((reservation) => reservation.name)).toEqual([
      'otp:send:tenant-1:user@example.com',
    ])
  })

  it('still applies the tenant budget when the caller has no IP', async () => {
    const { env, reservations } = makeEnv()

    await reserveOtpSendRateLimit(env, '+12125550142', 'tenant-1')

    expect(reservations.map((reservation) => reservation.name)).toEqual([
      'otp:send:tenant-1:+12125550142',
      'otp:phone:tenant:tenant-1',
    ])
  })

  it('rejects with rate_limited and spends no tenant budget when the IP budget is exhausted', async () => {
    const { env, reservations } = makeEnv({ rejectName: 'otp:phone:ip:203.0.113.7' })

    const result = reserveOtpSendRateLimit(env, '+12125550142', 'tenant-1', { ip: '203.0.113.7' })

    await expect(result).rejects.toMatchObject({ code: 'rate_limited' })
    expect(reservations).toHaveLength(1)
  })

  it('rejects with rate_limited when the tenant budget is exhausted', async () => {
    const { env } = makeEnv({ rejectName: 'otp:phone:tenant:tenant-1' })

    const result = reserveOtpSendRateLimit(env, '+12125550142', 'tenant-1', { ip: '203.0.113.7' })

    await expect(result).rejects.toMatchObject({ code: 'rate_limited' })
  })

  it('fails closed when the rate limiter is unavailable', async () => {
    const { env } = makeEnv({ failName: 'otp:phone:tenant:tenant-1' })

    const result = reserveOtpSendRateLimit(env, '+12125550142', 'tenant-1')

    await expect(result).rejects.toBeInstanceOf(AppError)
    await expect(result).rejects.toMatchObject({ code: 'server_error' })
  })
})
