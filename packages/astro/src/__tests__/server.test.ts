import { describe, it, expect, vi, afterEach } from 'vitest'
import { getAuth, currentUser, xidClient } from '../server'
import type { AuthObject, UnauthenticatedAuthObject } from '../types'

const MOCK_CLAIMS = {
  iss: 'https://test.xid.dev',
  sub: 'user_srv',
  aud: 'client_srv' as string | readonly string[],
  exp: 9999999999,
  iat: 1000000000,
  jti: 'jti_srv',
  nbf: 1000000000,
  azp: 'client_srv',
  scope: 'openid',
  client_id: 'client_srv',
}

const SIGNED_IN: AuthObject = {
  userId: 'user_srv',
  sessionId: 'sess_srv',
  orgId: undefined,
  orgRole: undefined,
  orgPermissions: undefined,
  claims: MOCK_CLAIMS,
}

const UNAUTHENTICATED: UnauthenticatedAuthObject = {
  userId: null,
  sessionId: null,
  orgId: null,
  orgRole: null,
  orgPermissions: null,
  claims: null,
}

afterEach(() => {
  delete process.env['XID_SECRET_KEY']
})

describe('getAuth', () => {
  it('returns xidAuth from locals when present and signed in', () => {
    const locals = { xidAuth: SIGNED_IN }
    const result = getAuth(locals)
    expect(result).toEqual(SIGNED_IN)
    expect(result.userId).toBe('user_srv')
  })

  it('returns unauthenticated when xidAuth has userId=null', () => {
    const locals = { xidAuth: UNAUTHENTICATED }
    const result = getAuth(locals)
    expect(result.userId).toBeNull()
  })

  it('returns unauthenticated when xidAuth is absent from locals', () => {
    const result = getAuth({})
    expect(result.userId).toBeNull()
  })

  it('returns unauthenticated when xidAuth is a non-object', () => {
    const result = getAuth({ xidAuth: 'invalid' })
    expect(result.userId).toBeNull()
  })

  it('preserves org fields from AuthObject', () => {
    const authWithOrg: AuthObject = {
      ...SIGNED_IN,
      orgId: 'org_xyz',
      orgRole: 'member',
      orgPermissions: ['read'],
    }
    const result = getAuth({ xidAuth: authWithOrg })
    expect(result.userId).toBe('user_srv')
    if (result.userId !== null) {
      expect(result.orgId).toBe('org_xyz')
      expect(result.orgRole).toBe('member')
    }
  })
})

describe('xidClient', () => {
  it('constructs a client with secretKey', () => {
    const client = xidClient({ secretKey: 'sk_test_abc' })
    expect(client).toBeDefined()
    expect(typeof client.getUser).toBe('function')
    expect(typeof client.getMe).toBe('function')
  })

  it('sends Authorization header with secretKey in requests', async () => {
    type FetchCall = { url: string; init: RequestInit }
    const calls: FetchCall[] = []
    const mockFetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      return new Response(JSON.stringify({ id: 'user_abc' }), { status: 200 })
    })

    const client = xidClient({ secretKey: 'sk_live_test', fetcher: mockFetch as typeof fetch })
    await client.getUser('user_abc')

    expect(calls).toHaveLength(1)
    const init = calls[0]?.init ?? {}
    const sentHeaders = init.headers as Record<string, string>
    expect(sentHeaders['Authorization']).toBe('Bearer sk_live_test')
  })

  it('returns network error result on fetch failure', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Connection refused'))
    const client = xidClient({ secretKey: 'sk_live_test', fetcher: mockFetch as typeof fetch })
    const result = await client.getUser('user_xyz')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('Connection refused')
      expect(result.error.status).toBe(0)
    }
  })

  it('returns error result on non-ok HTTP response', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'Not found' } }), { status: 404 }),
      )
    const client = xidClient({ secretKey: 'sk_live_test', fetcher: mockFetch as typeof fetch })
    const result = await client.getUser('nonexistent')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.status).toBe(404)
      expect(result.error.message).toBe('Not found')
    }
  })
})

describe('currentUser', () => {
  it('returns null when xidAuth is unauthenticated', async () => {
    const locals = { xidAuth: UNAUTHENTICATED }
    const result = await currentUser(locals, { secretKey: 'sk_test' })
    expect(result).toBeNull()
  })

  it('returns null when no secretKey available', async () => {
    const locals = { xidAuth: SIGNED_IN }
    const result = await currentUser(locals)
    expect(result).toBeNull()
  })

  it('fetches user when locals is authenticated and secretKey provided', async () => {
    const mockUser = { id: 'user_srv', primaryEmailAddress: 'test@example.com' }
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(mockUser), { status: 200 }))
    const locals = { xidAuth: SIGNED_IN }
    const result = await currentUser(locals, {
      secretKey: 'sk_live_test',
      fetcher: mockFetch as typeof fetch,
    })

    expect(result).not.toBeNull()
    expect(result?.id).toBe('user_srv')
  })

  it('reads secretKey from process.env.XID_SECRET_KEY', async () => {
    process.env['XID_SECRET_KEY'] = 'sk_env_test'
    const mockUser = { id: 'user_srv', primaryEmailAddress: null }
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(mockUser), { status: 200 }))

    const locals = { xidAuth: SIGNED_IN }
    const result = await currentUser(locals, {
      secretKey: 'sk_env_test',
      fetcher: mockFetch as typeof fetch,
    })
    expect(result).not.toBeNull()
  })

  it('returns null when API request fails', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response('{"error":{"message":"Internal error"}}', { status: 500 }))
    const locals = { xidAuth: SIGNED_IN }
    const result = await currentUser(locals, {
      secretKey: 'sk_live_test',
      fetcher: mockFetch as typeof fetch,
    })
    expect(result).toBeNull()
  })
})
