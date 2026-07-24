// verify-rate-limit 单元测试:IP/账户维度超限拒绝 + scope 隔离。
import { describe, it, expect, vi } from 'vitest'
import { AppError } from '../errors'
import { enforceVerifyRateLimit } from '../verify-rate-limit'

function makeRateLimitEnv(allowed: boolean): Env {
  const fetch = vi.fn(async () => Response.json({ allowed }))
  return {
    RATE_LIMITER: {
      idFromName: (name: string) => ({ toString: () => name }) as DurableObjectId,
      get: () => ({ fetch }) as unknown as DurableObjectStub,
    },
  } as unknown as Env
}

describe('enforceVerifyRateLimit', () => {
  it('throws rate_limited when IP dimension is over limit', async () => {
    const env = makeRateLimitEnv(false)
    await expect(
      enforceVerifyRateLimit({
        env,
        tenantId: 'tenant_a',
        scope: 'otp',
        account: 'user@acme.com',
        ip: '203.0.113.1',
      }),
    ).rejects.toThrow(AppError)
    await expect(
      enforceVerifyRateLimit({
        env,
        tenantId: 'tenant_a',
        scope: 'otp',
        account: 'user@acme.com',
        ip: '203.0.113.1',
      }),
    ).rejects.toMatchObject({ code: 'rate_limited' })
  })

  it('throws rate_limited when account dimension is over limit', async () => {
    let call = 0
    const fetch = vi.fn(async () => {
      call += 1
      return Response.json({ allowed: call > 1 })
    })
    const env = {
      RATE_LIMITER: {
        idFromName: (name: string) => ({ toString: () => name }) as DurableObjectId,
        get: () => ({ fetch }) as unknown as DurableObjectStub,
      },
    } as unknown as Env

    await expect(
      enforceVerifyRateLimit({
        env,
        tenantId: 'tenant_a',
        scope: 'magic_link',
        account: 'user@acme.com',
        ip: '203.0.113.1',
      }),
    ).rejects.toMatchObject({ code: 'rate_limited' })
  })

  it('passes when both dimensions are under limit', async () => {
    const env = makeRateLimitEnv(true)
    await expect(
      enforceVerifyRateLimit({
        env,
        tenantId: 'tenant_a',
        scope: 'passkey',
        account: 'cred_1',
        ip: '203.0.113.2',
      }),
    ).resolves.toBeUndefined()
  })

  it('skips account check when account is null', async () => {
    const env = makeRateLimitEnv(true)
    const fetch = (
      env.RATE_LIMITER.get({} as DurableObjectId) as { fetch: ReturnType<typeof vi.fn> }
    ).fetch
    await enforceVerifyRateLimit({
      env,
      tenantId: 'tenant_a',
      scope: 'otp',
      account: null,
      ip: '203.0.113.3',
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('skips IP check when ip is null', async () => {
    const env = makeRateLimitEnv(true)
    const fetch = (
      env.RATE_LIMITER.get({} as DurableObjectId) as { fetch: ReturnType<typeof vi.fn> }
    ).fetch
    await enforceVerifyRateLimit({
      env,
      tenantId: 'tenant_a',
      scope: 'otp',
      account: 'user@acme.com',
      ip: null,
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('uses distinct keys per scope to avoid cross-endpoint pollution', async () => {
    const keys: string[] = []
    const env = {
      RATE_LIMITER: {
        idFromName: (name: string) => {
          keys.push(name)
          return { toString: () => name } as DurableObjectId
        },
        get: () =>
          ({
            fetch: vi.fn(async () => Response.json({ allowed: true })),
          }) as unknown as DurableObjectStub,
      },
    } as unknown as Env

    await enforceVerifyRateLimit({
      env,
      tenantId: 'tenant_a',
      scope: 'otp',
      account: 'user@acme.com',
      ip: '203.0.113.4',
    })
    await enforceVerifyRateLimit({
      env,
      tenantId: 'tenant_a',
      scope: 'magic_link',
      account: 'user@acme.com',
      ip: '203.0.113.4',
    })

    expect(keys.some((k) => k.includes(':otp:'))).toBe(true)
    expect(keys.some((k) => k.includes(':magic_link:'))).toBe(true)
    expect(keys[0]).not.toBe(keys[1])
  })
})
