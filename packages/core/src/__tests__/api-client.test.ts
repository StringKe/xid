import { describe, expect, it } from 'vitest'

import { XidApiClient } from '../api-client'
import { XidNetworkError } from '../errors'
import { makeFetch, makeState } from './fixtures'

describe('XidApiClient', () => {
  it('unwraps the data envelope on success', async () => {
    const fetcher = makeFetch({ '/v1/me': () => ({ status: 200, json: { data: makeState() } }) })
    const api = new XidApiClient({ fetcher })

    const result = await api.loadState()

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.activeSessionId).toBe('sess_1')
  })

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
