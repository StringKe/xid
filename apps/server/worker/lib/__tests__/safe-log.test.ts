import { afterEach, describe, expect, it, vi } from 'vitest'
import { logWorkerError, logWorkerWarning } from '../safe-log'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('safe Worker logging', () => {
  it('keeps error classification without logging message, stack, cause, URL, or cookie', () => {
    const error = new Error(
      'request failed https://xid.dev/callback?code=secret with Cookie: __Host-xid.rt=secret',
      { cause: { authorization: 'Bearer secret' } },
    ) as Error & { code: string }
    error.code = 'provider_unavailable'
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    logWorkerError('provider.request_failed', error, {
      component: 'social',
      operation: 'callback',
      status: 502,
    })

    expect(spy).toHaveBeenCalledWith({
      event: 'provider.request_failed',
      severity: 'error',
      error: { type: 'Error', code: 'provider_unavailable' },
      component: 'social',
      operation: 'callback',
      status: 502,
    })
    const logged = JSON.stringify(spy.mock.calls)
    expect(logged).not.toContain('https://')
    expect(logged).not.toContain('secret')
    expect(logged).not.toContain('Cookie')
    expect(logged).not.toContain('authorization')
  })

  it('normalizes attacker-controlled error names and codes', () => {
    const error = new Error('private')
    error.name = 'https://xid.dev/?token=secret'
    ;(error as Error & { code: string }).code = 'secret value with spaces'
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    logWorkerError('request.failed', error)

    expect(spy).toHaveBeenCalledWith({
      event: 'request.failed',
      severity: 'error',
      error: { type: 'Error' },
    })
  })

  it('emits warning events as structured metadata', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    logWorkerWarning('migration.pending', { component: 'hourly' })

    expect(spy).toHaveBeenCalledWith({
      event: 'migration.pending',
      severity: 'warning',
      component: 'hourly',
    })
  })
})
