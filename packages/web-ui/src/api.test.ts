import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApiClient } from './api'

function stubFetch(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
    ),
  )
}

describe('createApiClient onUnauthorized', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('drops the session when the server reports it is no longer authenticated', async () => {
    stubFetch(401, { code: 'unauthorized', message: 'Authentication is required.' })
    const onUnauthorized = vi.fn<() => void>()

    const result = await createApiClient({ onUnauthorized }).get('/v1/me/passkeys')

    expect(result.ok).toBe(false)
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
  })

  it('keeps the session when an action needs step-up re-verification', async () => {
    stubFetch(401, { code: 'step_up_required', message: 'Additional verification is required.' })
    const onUnauthorized = vi.fn<() => void>()

    const result = await createApiClient({ onUnauthorized }).del('/v1/me/passkeys/pk_1')

    expect(result).toMatchObject({ ok: false, error: { code: 'step_up_required' } })
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('keeps the session when a step-up code is wrong', async () => {
    stubFetch(401, { code: 'otp_invalid', message: 'The code is incorrect.' })
    const onUnauthorized = vi.fn<() => void>()

    await createApiClient({ onUnauthorized }).post('/auth/mfa/verify', { method: 'totp' })

    expect(onUnauthorized).not.toHaveBeenCalled()
  })
})
