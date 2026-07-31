import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { AuthProvider, useAuth, type MeResponse } from './auth-context'
import type { ApiClient, ApiRequestOptions } from './api'

function makeMeResponse(activeOrgId: string | null): MeResponse {
  const org = {
    id: 'org_1',
    slug: 'default',
    name: 'Default',
    role: 'admin',
    permissions: ['org:read'],
  }
  const session = {
    id: 'sess_1',
    status: 'active' as const,
    expiresAt: '2030-01-01T00:00:00.000Z',
    isImpersonation: false,
    userId: 'user_1',
    activeOrganizationId: activeOrgId,
    lastActiveAt: '2029-01-01T00:00:00.000Z',
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
    session,
    activeSessionId: 'sess_1',
    sessions: [session],
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

describe('AuthProvider setActiveOrganization', () => {
  it('posts the active organization change and refreshes /v1/me', async () => {
    const queryClient = new QueryClient()
    const { client, get, post } = makeApiClient()
    const holder: {
      setActiveOrganization: ((organizationId: string | null) => Promise<boolean>) | null
    } = { setActiveOrganization: null }

    function Capture(): ReactNode {
      holder.setActiveOrganization = useAuth().setActiveOrganization
      return null
    }

    renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <AuthProvider client={client}>
          <Capture />
        </AuthProvider>
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
})
