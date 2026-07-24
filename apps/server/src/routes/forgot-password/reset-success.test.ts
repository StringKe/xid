import { describe, expect, it, vi } from 'vitest'
import { handleResetPasswordSuccess } from './reset-success'

describe('handleResetPasswordSuccess', () => {
  it('refreshes the session before navigating to console', async () => {
    const calls: string[] = []
    const refresh = vi.fn<() => Promise<void>>(async () => {
      calls.push('refresh')
    })
    const navigate = vi.fn<(options: { to: string; replace: boolean }) => Promise<void>>(
      async (options) => {
        calls.push(`navigate:${options.to}:${options.replace}`)
      },
    )

    await handleResetPasswordSuccess({ refresh, navigate })

    expect(refresh).toHaveBeenCalledOnce()
    expect(navigate).toHaveBeenCalledWith({ to: '/console', replace: true })
    expect(calls).toEqual(['refresh', 'navigate:/console:true'])
  })

  it('uses the server redirect after refresh', async () => {
    const refresh = vi.fn<() => Promise<void>>(async () => {})
    const navigate = vi.fn<(options: { to: string; replace: boolean }) => Promise<void>>(
      async () => {},
    )

    await handleResetPasswordSuccess({
      refresh,
      navigate,
      redirectUrl: '/mfa?redirect_to=%2Fconsole',
    })

    expect(refresh).toHaveBeenCalledOnce()
    expect(navigate).toHaveBeenCalledWith({ to: '/mfa?redirect_to=%2Fconsole', replace: true })
  })
})
