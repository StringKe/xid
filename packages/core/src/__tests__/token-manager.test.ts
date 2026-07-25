import { describe, expect, it } from 'vitest'

import { XidApiClient } from '../api-client'
import { TokenManager } from '../token-manager'
import { makeFetch, makeJwt } from './fixtures'

const TOKEN_PATH = '/v1/sessions/token'

function setup(jwtPayload: Record<string, unknown>, now: () => number) {
  const fetcher = makeFetch({
    [TOKEN_PATH]: () => ({ status: 200, json: { jwt: makeJwt(jwtPayload) } }),
  })
  const api = new XidApiClient({ fetcher })
  const manager = new TokenManager({ api, now })
  return { fetcher, manager }
}

describe('TokenManager.getToken', () => {
  it('caches the token and skips a second network call when not expiring', async () => {
    const { fetcher, manager } = setup({ exp: 2000 }, () => 1000)

    const first = await manager.getToken()
    const second = await manager.getToken()

    expect(first.ok && second.ok).toBe(true)
    expect(fetcher.calls.filter((c) => c.path === TOKEN_PATH)).toHaveLength(1)
  })

  it('refreshes when the cached token is within the leeway window', async () => {
    let clock = 1000
    const { fetcher, manager } = setup({ exp: 1005 }, () => clock)

    await manager.getToken({ leewaySeconds: 10 })
    clock = 1001
    await manager.getToken({ leewaySeconds: 10 })

    expect(fetcher.calls.filter((c) => c.path === TOKEN_PATH)).toHaveLength(2)
  })

  it('forces a network refresh when skipCache is set', async () => {
    const { fetcher, manager } = setup({ exp: 9000 }, () => 1000)

    await manager.getToken()
    await manager.getToken({ skipCache: true })

    expect(fetcher.calls.filter((c) => c.path === TOKEN_PATH)).toHaveLength(2)
  })

  it('deduplicates concurrent refreshes into a single in-flight request', async () => {
    const { fetcher, manager } = setup({ exp: 9000 }, () => 1000)

    const [a, b] = await Promise.all([manager.getToken(), manager.getToken()])

    expect(a.ok && b.ok).toBe(true)
    expect(fetcher.calls.filter((c) => c.path === TOKEN_PATH)).toHaveLength(1)
  })

  it('clears the cache so the next getToken re-fetches', async () => {
    const { fetcher, manager } = setup({ exp: 9000 }, () => 1000)

    await manager.getToken()
    manager.clear()
    await manager.getToken()

    expect(fetcher.calls.filter((c) => c.path === TOKEN_PATH)).toHaveLength(2)
  })

  it('propagates a structured error result on a failed token request', async () => {
    const fetcher = makeFetch({
      [TOKEN_PATH]: () => ({
        status: 401,
        json: { error: { code: 'session_revoked', message: 'revoked', httpStatus: 401 } },
      }),
    })
    const manager = new TokenManager({ api: new XidApiClient({ fetcher }), now: () => 0 })

    const result = await manager.getToken()

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('session_revoked')
  })
})
