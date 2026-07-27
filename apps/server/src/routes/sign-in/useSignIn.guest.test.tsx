// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { Result } from '@xid-kit/types'
import type { ApiClient } from '../../lib/api'

const postCalls = vi.hoisted((): Array<{ path: string; body: unknown }> => [])
const routerState = vi.hoisted(() => ({
  search: {} as Record<string, string | undefined>,
  navigate: vi.fn(),
}))
const authState = vi.hoisted(() => ({
  refresh: vi.fn(async () => {}),
  // 可变的 post 实现:各用例注入成功 / 失败结果。
  postImpl: ((_path: string, _body?: unknown) => ({
    ok: false,
    error: { code: 'rate_limited', message: '', httpStatus: 429 },
  })) as (path: string, body?: unknown) => Result<unknown>,
}))

function failure<T>(): Result<T> {
  return {
    ok: false,
    error: { code: 'unauthorized', message: 'Authentication is required.', httpStatus: 401 },
  }
}

vi.mock('@tanstack/react-router', () => ({
  useSearch: () => routerState.search,
}))

vi.mock('../../lib/router', () => ({
  useNavigate: () => routerState.navigate,
}))

vi.mock('../../lib/auth-context', () => ({
  useAuth: () => ({
    api: {
      get: async <T,>() => failure<T>(),
      post: async <T,>(path: string, body?: unknown) => {
        postCalls.push({ path, body })
        return authState.postImpl(path, body) as Result<T>
      },
      patch: async <T,>() => failure<T>(),
      del: async <T,>() => failure<T>(),
      request: async <T,>() => failure<T>(),
    } satisfies ApiClient,
    refresh: authState.refresh,
  }),
}))

vi.mock('./usePasskeySignIn', () => ({
  usePasskeySignIn: () => ({
    support: 'no',
    conditionalRunning: false,
    isVerifying: false,
    error: null,
    triggerButton: vi.fn(),
  }),
}))

import { useSignIn } from './useSignIn'

type Captured = ReturnType<typeof useSignIn>

async function mountHook(): Promise<{ captured: () => Captured; cleanup: () => Promise<void> }> {
  ;(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true
  const queryClient = new QueryClient()
  const container = document.createElement('div')
  document.body.appendChild(container)
  let captured: Captured | null = null
  function Host(): ReactNode {
    captured = useSignIn()
    return null
  }
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <Host />
      </QueryClientProvider>,
    )
  })
  return {
    captured: () => {
      if (!captured) throw new Error('hook not mounted')
      return captured
    },
    cleanup: async () => {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    },
  }
}

describe('useSignIn guest entry', () => {
  it('submitGuest posts to /auth/guest with the turnstile token', async () => {
    postCalls.length = 0
    routerState.search = {}
    const { captured, cleanup } = await mountHook()

    await act(async () => {
      captured()[1].setTurnstileToken('turnstile-token-1')
    })
    await act(async () => {
      captured()[1].submitGuest()
    })

    const lastCall = postCalls[postCalls.length - 1]
    expect(lastCall?.path).toBe('/auth/guest')
    expect(lastCall?.body).toMatchObject({ turnstileToken: 'turnstile-token-1' })
    await cleanup()
  })

  it('on success refreshes the session and always opens organization creation', async () => {
    postCalls.length = 0
    routerState.search = {}
    authState.refresh.mockClear()
    routerState.navigate.mockClear()
    authState.postImpl = () => ({ ok: true, value: { redirectUrl: '/console' } })
    const { captured, cleanup } = await mountHook()

    await act(async () => {
      captured()[1].submitGuest()
    })

    expect(authState.refresh).toHaveBeenCalledTimes(1)
    expect(routerState.navigate).toHaveBeenCalledWith('/create-organization', { replace: true })
    expect(captured()[0].error).toBeNull()
    await cleanup()
  })

  it('on failure surfaces the mapped opaque error and does not refresh', async () => {
    postCalls.length = 0
    routerState.search = {}
    authState.refresh.mockClear()
    routerState.navigate.mockClear()
    authState.postImpl = () => ({
      ok: false,
      error: { code: 'rate_limited', message: '', httpStatus: 429 },
    })
    const { captured, cleanup } = await mountHook()

    await act(async () => {
      captured()[1].submitGuest()
    })

    expect(captured()[0].error).toBe('rate_limited')
    expect(authState.refresh).not.toHaveBeenCalled()
    expect(routerState.navigate).not.toHaveBeenCalled()
    await cleanup()
  })
})
