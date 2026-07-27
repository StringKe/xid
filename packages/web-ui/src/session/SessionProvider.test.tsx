// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { SessionProvider, useSession } from './SessionProvider'
import type { MeResponse } from './contracts'
import type { ApiClient, ApiRequestOptions } from '../api'

vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings[0] }),
}))

const actEnvironment = globalThis as Record<string, unknown>
actEnvironment['IS_REACT_ACT_ENVIRONMENT'] = true

const dialogProto = HTMLDialogElement.prototype as unknown as Record<string, unknown>
dialogProto['showModal'] ??= function showModal(this: HTMLDialogElement): void {
  this.open = true
}
dialogProto['close'] ??= function close(this: HTMLDialogElement): void {
  this.open = false
}

function makeMeResponse(activeOrgId: string | null): MeResponse {
  const org = {
    id: 'org_1',
    slug: 'default',
    name: 'Default',
    role: 'admin',
    permissions: ['org:read'],
  }
  return {
    user: {
      id: 'user_1',
      email: 'admin@example.com',
      emailVerified: true,
      name: 'Admin',
      imageUrl: null,
      locale: null,
      hasMfa: false,
      instanceManager: false,
    },
    activeOrg: activeOrgId ? org : null,
    organizations: [org],
    session: {
      id: 'sess_1',
      status: 'active',
      expiresAt: '2030-01-01T00:00:00.000Z',
      isImpersonation: false,
    },
  }
}

function makeApiClient() {
  const getCalls = vi.fn()
  const postCalls = vi.fn()
  const get: ApiClient['get'] = async <T,>(
    path: string,
    options?: Omit<ApiRequestOptions, 'method' | 'body'>,
  ) => {
    getCalls(path, options)
    return { ok: true, value: makeMeResponse('org_1') as T }
  }
  const post: ApiClient['post'] = async <T,>(
    path: string,
    body?: unknown,
    options?: Omit<ApiRequestOptions, 'method' | 'body'>,
  ) => {
    postCalls(path, body, options)
    return { ok: true, value: {} as T }
  }
  const client: ApiClient = {
    request: async <T,>() => ({ ok: true, value: {} as T }),
    get,
    post,
    patch: async <T,>() => ({ ok: true, value: {} as T }),
    del: async <T,>() => ({ ok: true, value: {} as T }),
  }
  return { client, get: getCalls, post: postCalls }
}

describe('SessionProvider setActiveOrganization', () => {
  it('posts the active organization change and refreshes /v1/me', async () => {
    const queryClient = new QueryClient()
    const { client, get, post } = makeApiClient()
    const holder: {
      setActiveOrganization: ((organizationId: string | null) => Promise<boolean>) | null
    } = { setActiveOrganization: null }

    function Capture(): ReactNode {
      holder.setActiveOrganization = useSession().setActiveOrganization
      return null
    }

    renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <SessionProvider client={client} loadOnMount={false}>
          <Capture />
        </SessionProvider>
      </QueryClientProvider>,
    )

    const setActive = holder.setActiveOrganization
    if (!setActive) throw new Error('setActiveOrganization was not captured')
    const result = await setActive('org_1')

    expect(result).toBe(true)
    expect(post).toHaveBeenCalledWith(
      '/v1/sessions/active-organization',
      { organizationId: 'org_1' },
      undefined,
    )
    expect(get).toHaveBeenCalledWith('/v1/me', undefined)
    expect(queryClient.getQueryData<MeResponse | null>(['me'])?.activeOrg?.id).toBe('org_1')
  })

  it('runs the injected app callback after same-origin logout', async () => {
    const queryClient = new QueryClient()
    const { client, post } = makeApiClient()
    const onSignOut = vi.fn()
    const holder: { signOut: (() => Promise<void>) | null } = { signOut: null }

    function Capture(): ReactNode {
      holder.signOut = useSession().signOut
      return null
    }

    renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <SessionProvider
          client={client}
          callbacks={{ onSignOut }}
          initialSession={makeMeResponse('org_1')}
          loadOnMount={false}
        >
          <Capture />
        </SessionProvider>
      </QueryClientProvider>,
    )

    const signOut = holder.signOut
    if (!signOut) throw new Error('signOut was not captured')
    await signOut()

    expect(post).toHaveBeenCalledWith('/auth/sign-out', undefined, undefined)
    expect(onSignOut).toHaveBeenCalledOnce()
    expect(queryClient.getQueryData<MeResponse | null>(['me'])).toBeNull()
  })

  it('opens one verification panel without replaying a blocked mutation', async () => {
    const queryClient = new QueryClient()
    const postCalls: string[] = []
    const base = makeApiClient().client
    const client: ApiClient = {
      ...base,
      post: async <T,>(path: string) => {
        postCalls.push(path)
        if (path === '/auth/resend-verification') {
          return { ok: true, value: {} as T }
        }
        return {
          ok: false,
          error: {
            code: 'email_verification_required',
            message: '',
            httpStatus: 403,
          },
        }
      },
    }
    const initialSession = makeMeResponse('org_1')
    initialSession.user.emailVerified = false
    const holder: { api: ApiClient | null } = { api: null }

    function Capture(): ReactNode {
      holder.api = useSession().api
      return null
    }

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SessionProvider client={client} initialSession={initialSession} loadOnMount={false}>
            <Capture />
          </SessionProvider>
        </QueryClientProvider>,
      )
    })

    const observedApi = holder.api
    if (!observedApi) throw new Error('api was not captured')
    await act(async () => {
      await observedApi.post('/v1/organizations/org_1/applications', { name: 'Web' })
    })

    expect(container.textContent).toContain('Verify your email')
    expect(postCalls).toEqual(['/v1/organizations/org_1/applications'])

    const sendButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Send verification email',
    )
    if (!sendButton) throw new Error('verification send button was not rendered')
    await act(async () => {
      sendButton.click()
    })

    expect(postCalls).toEqual(['/v1/organizations/org_1/applications', '/auth/resend-verification'])
    expect(container.textContent).toContain('Verification email sent')

    await act(async () => root.unmount())
    container.remove()
  })
})
