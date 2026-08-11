import { describe, it, expect, vi } from 'vitest'
import { buildSignInUrl, executeSignOut } from '../sign-in-logic'
import type { XidClient } from '@xid-kit/core'

describe('buildSignInUrl', () => {
  it('returns base signInUrl when no redirectUrl', () => {
    expect(buildSignInUrl('/sign-in')).toBe('/sign-in')
  })

  it('appends redirect_url as encoded query param', () => {
    const result = buildSignInUrl('/sign-in', 'https://app.example.com/dashboard')
    expect(result).toBe('/sign-in?redirect_url=https%3A%2F%2Fapp.example.com%2Fdashboard')
  })

  it('works with custom sign-in URL', () => {
    const result = buildSignInUrl('/auth/login', '/protected')
    expect(result).toBe('/auth/login?redirect_url=%2Fprotected')
  })
})

describe('executeSignOut', () => {
  function makeClient(ok = true): XidClient {
    return {
      signOut: vi
        .fn()
        .mockResolvedValue(
          ok ? { ok: true, value: null } : { ok: false, error: { code: 'err', message: 'fail' } },
        ),
    } as unknown as XidClient
  }

  it('calls client.signOut without sessionId when not provided', async () => {
    const client = makeClient()
    await executeSignOut(client)
    expect(client.signOut).toHaveBeenCalledWith({})
  })

  it('calls client.signOut with sessionId when provided', async () => {
    const client = makeClient()
    await executeSignOut(client, { sessionId: 'sess_1' })
    expect(client.signOut).toHaveBeenCalledWith({ sessionId: 'sess_1' })
  })

  it('calls navigate on success when redirectUrl provided', async () => {
    const client = makeClient()
    const navigate = vi.fn()
    await executeSignOut(client, { redirectUrl: '/home', navigate })
    expect(navigate).toHaveBeenCalledWith('/home')
  })

  it('does not call navigate when signOut fails', async () => {
    const client = makeClient(false)
    const navigate = vi.fn()
    await executeSignOut(client, { redirectUrl: '/home', navigate })
    expect(navigate).not.toHaveBeenCalled()
  })

  it('does not call navigate when no redirectUrl', async () => {
    const client = makeClient()
    const navigate = vi.fn()
    await executeSignOut(client, { navigate })
    expect(navigate).not.toHaveBeenCalled()
  })

  it('returns the Result from signOut', async () => {
    const client = makeClient()
    const result = await executeSignOut(client)
    expect(result.ok).toBe(true)
  })

  it('returns error Result when signOut fails', async () => {
    const client = makeClient(false)
    const result = await executeSignOut(client)
    expect(result.ok).toBe(false)
  })
})
