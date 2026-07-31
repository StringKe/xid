import { describe, expect, it } from 'vitest'

import { XidApiClient } from '../api-client'
import { XidNetworkError } from '../errors'
import { makeFetch, makeState } from './fixtures'

describe('XidApiClient', () => {
  it('returns the real guest session and server-owned onboarding directive', async () => {
    const fetcher = makeFetch({
      '/auth/config?intent=sign-up': () => ({
        status: 200,
        json: { guest: { capabilityToken: 'guest_capability' } },
      }),
      '/auth/guest': () => ({
        status: 201,
        json: {
          sessionId: 'sess_guest',
          redirectUrl: '/create-organization?source=worker',
        },
      }),
    })
    const api = new XidApiClient({ fetcher })

    await expect(api.signInAnonymously()).resolves.toEqual({
      ok: true,
      value: {
        sessionId: 'sess_guest',
        redirectUrl: '/create-organization?source=worker',
      },
    })
  })

  it.each([
    null,
    {},
    { sessionId: 'sess_guest' },
    { redirectUrl: '/create-organization' },
    { sessionId: '', redirectUrl: '/create-organization' },
    { sessionId: 'sess_guest', redirectUrl: '' },
  ])('rejects a malformed successful /auth/guest response', async (json) => {
    const fetcher = makeFetch({
      '/auth/config?intent=sign-up': () => ({
        status: 200,
        json: { guest: { capabilityToken: 'guest_capability' } },
      }),
      '/auth/guest': () => ({ status: 201, json }),
    })
    const api = new XidApiClient({ fetcher })

    await expect(api.signInAnonymously()).rejects.toMatchObject({
      name: 'XidNetworkError',
      message: 'Invalid /auth/guest response',
    })
  })

  it('validates the shared session-token response before returning it', async () => {
    const fetcher = makeFetch({
      '/v1/sessions/token': () => ({ status: 200, json: { token: 'header.payload.signature' } }),
    })
    const api = new XidApiClient({ fetcher })

    await expect(api.getToken()).resolves.toEqual({
      ok: true,
      value: { token: 'header.payload.signature' },
    })
  })

  it.each([null, {}, { jwt: 'legacy' }, { token: '' }, { token: '   ' }, { token: 42 }])(
    'rejects a malformed successful /v1/sessions/token response',
    async (json) => {
      const fetcher = makeFetch({ '/v1/sessions/token': () => ({ status: 200, json }) })
      const api = new XidApiClient({ fetcher })

      await expect(api.getToken()).rejects.toMatchObject({
        name: 'XidNetworkError',
        message: 'Invalid /v1/sessions/token response',
      })
    },
  )

  it('rejects an invalid Organization role in /v1/me', async () => {
    const organization = {
      id: 'org_1',
      slug: 'acme',
      name: 'Acme',
      role: 'viewer',
      permissions: [],
    }
    const fetcher = makeFetch({
      '/v1/me': () => ({
        status: 200,
        json: {
          user: { id: 'user_1' },
          activeOrg: organization,
          organizations: [organization],
          session: { id: 'sess_1' },
          activeSessionId: 'sess_1',
          sessions: [],
        },
      }),
    })
    const api = new XidApiClient({ fetcher })

    await expect(api.loadState()).rejects.toMatchObject({
      name: 'XidNetworkError',
      message: 'Invalid /v1/me response',
    })
  })

  it('unwraps the data envelope on success', async () => {
    const fetcher = makeFetch({ '/v1/me': () => ({ status: 200, json: { data: makeState() } }) })
    const api = new XidApiClient({ fetcher })

    const result = await api.loadState()

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.activeSessionId).toBe('sess_1')
  })

  it('normalizes the real anonymous /v1/me shell without dereferencing null user or session', async () => {
    const fetcher = makeFetch({
      '/v1/me': () => ({
        status: 200,
        json: {
          user: null,
          activeOrg: null,
          organizations: [],
          session: null,
          activeSessionId: null,
          sessions: [],
        },
      }),
    })
    const api = new XidApiClient({ fetcher })

    const result = await api.loadState()

    expect(result).toEqual({
      ok: true,
      value: { activeSessionId: null, sessions: [], user: null },
    })
  })

  it.each([null, {}, { user: null, session: null }])(
    'throws XidNetworkError for a malformed successful /v1/me response',
    async (json) => {
      const fetcher = makeFetch({ '/v1/me': () => ({ status: 200, json }) })
      const api = new XidApiClient({ fetcher })

      await expect(api.loadState()).rejects.toMatchObject({
        name: 'XidNetworkError',
        message: 'Invalid /v1/me response',
      })
    },
  )

  it('maps a structured XidError error body to a Result error', async () => {
    const fetcher = makeFetch({
      '/v1/me': () => ({
        status: 403,
        json: { error: { code: 'forbidden', message: 'no', httpStatus: 403 } },
      }),
    })
    const api = new XidApiClient({ fetcher })

    const result = await api.loadState()

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('forbidden')
  })

  it('throws XidNetworkError on an unstructured 5xx response', async () => {
    const fetcher = makeFetch({ '/v1/me': () => ({ status: 500, json: 'boom' }) })
    const api = new XidApiClient({ fetcher })

    await expect(api.loadState()).rejects.toBeInstanceOf(XidNetworkError)
  })

  it('throws XidNetworkError when the transport itself fails', async () => {
    const fetcher = (async () => {
      throw new TypeError('offline')
    }) as typeof fetch
    const api = new XidApiClient({ fetcher })

    await expect(api.loadState()).rejects.toBeInstanceOf(XidNetworkError)
  })

  it('does not send legacy tenant hint headers', async () => {
    const seen: Array<{ tenant: string | null; organization: string | null }> = []
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers)
      seen.push({
        tenant: headers.get('X-Xid-Tenant'),
        organization: headers.get('X-Xid-Organization'),
      })
      return new Response(JSON.stringify({ data: makeState() }), { status: 200 })
    }) as typeof fetch
    const api = new XidApiClient({ fetcher })

    await api.loadState()

    expect(seen).toEqual([{ tenant: null, organization: null }])
  })

  it('maps api key list wire fields to SDK fields', async () => {
    const fetcher = makeFetch({
      '/v1/api-keys?limit=2&cursor=cur_1': () => ({
        status: 200,
        json: {
          data: [
            {
              id: 'ak_1',
              name: 'Server',
              key_prefix: 'sk_live_123',
              environment: 'live',
              scopes: ['users:read'],
              last_used_at: null,
              expires_at: null,
              revoked_at: null,
              created_at: 100,
            },
          ],
          next_cursor: 'cur_2',
          has_more: true,
        },
      }),
    })
    const api = new XidApiClient({ fetcher })

    const result = await api.listApiKeys({ limit: 2, cursor: 'cur_1' })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.data[0]?.keyPrefix).toBe('sk_live_123')
      expect(result.value.nextCursor).toBe('cur_2')
      expect(result.value.hasMore).toBe(true)
    }
  })

  it('returns created api key secret once', async () => {
    const fetcher = makeFetch({
      '/v1/api-keys': ({ method, body }) => ({
        status: method === 'POST' && (body as { name?: string }).name === 'Server' ? 201 : 400,
        json: {
          id: 'ak_1',
          name: 'Server',
          key_prefix: 'sk_live_123',
          key: 'sk_live_secret',
          environment: 'live',
          scopes: ['users:read'],
          last_used_at: null,
          expires_at: null,
          revoked_at: null,
          created_at: 100,
        },
      }),
    })
    const api = new XidApiClient({ fetcher })

    const result = await api.createApiKey({ name: 'Server', scopes: ['users:read'] })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.key).toBe('sk_live_secret')
  })

  it('sends Bearer secret key for management API listUsers', async () => {
    const seen: string[] = []
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers)
      seen.push(headers.get('Authorization') ?? '')
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'user_1',
              username: 'alice',
              status: 'active',
              publicMetadata: {},
              createdAt: 1,
              updatedAt: 2,
            },
          ],
          next_cursor: null,
          has_more: false,
        }),
        { status: 200 },
      )
    }) as typeof fetch
    const api = new XidApiClient({ fetcher, secretKey: 'sk_live_test' })

    const result = await api.listUsers()

    expect(seen).toEqual(['Bearer sk_live_test'])
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.data[0]?.id).toBe('user_1')
  })
})
