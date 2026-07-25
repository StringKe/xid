import { describe, expect, it } from 'vitest'

import { XidClient } from '../client'
import {
  makeFetch,
  makeSession,
  makeState,
  makeTokenResponse,
  makeUser,
  type RouteHandler,
} from './fixtures'

function client(routes: Record<string, RouteHandler>) {
  const fetcher = makeFetch(routes)
  return { fetcher, instance: new XidClient({ fetcher, now: () => 1000 }) }
}

describe('XidClient.load', () => {
  it('marks signed-in and exposes user/session after loading an active session', async () => {
    const { instance } = client({ '/v1/me': () => ({ status: 200, json: { data: makeState() } }) })

    await instance.load()

    const snapshot = instance.getSnapshot()
    expect(snapshot.isSignedIn).toBe(true)
    expect(snapshot.isLoaded).toBe(true)
    expect(snapshot.user?.id).toBe('user_1')
    expect(snapshot.session?.id).toBe('sess_1')
  })

  it('maps the current /v1/me response shape into SDK state', async () => {
    const { instance } = client({
      '/v1/me': () => ({
        status: 200,
        json: {
          user: {
            id: 'user_live',
            email: 'live@example.com',
            emailVerified: true,
            name: 'Live User',
            imageUrl: null,
          },
          activeOrg: {
            id: 'org_live',
            slug: 'live',
            name: 'Live Organization',
            role: 'owner',
            permissions: ['org:read'],
          },
          organizations: [
            {
              id: 'org_live',
              slug: 'live',
              name: 'Live Organization',
              role: 'owner',
              permissions: ['org:read'],
            },
          ],
          session: {
            id: 'sess_live',
            expiresAt: '2030-01-01T00:00:00.000Z',
            isImpersonation: false,
          },
        },
      }),
    })

    await instance.load()

    const snapshot = instance.getSnapshot()
    expect(snapshot.isSignedIn).toBe(true)
    expect(snapshot.user?.primaryEmailAddress).toBe('live@example.com')
    expect(snapshot.user?.organizationMemberships[0]?.role).toBe('owner')
    expect(snapshot.session?.id).toBe('sess_live')
    expect(snapshot.session?.activeOrganizationId).toBe('org_live')
    expect(snapshot.organization?.id).toBe('org_live')
  })

  it('falls to degraded status and records the error when the state request fails', async () => {
    const { instance } = client({
      '/v1/me': () => ({
        status: 503,
        json: { error: { code: 'service_unavailable', message: 'down', httpStatus: 503 } },
      }),
    })

    await instance.load()

    const snapshot = instance.getSnapshot()
    expect(snapshot.status).toBe('degraded')
    expect(snapshot.isSignedIn).toBe(false)
    expect(snapshot.error?.code).toBe('service_unavailable')
  })

  it('notifies subscribers when state changes', async () => {
    const { instance } = client({ '/v1/me': () => ({ status: 200, json: { data: makeState() } }) })
    const seen: boolean[] = []
    instance.subscribe((state) => seen.push(state.isSignedIn))

    await instance.load()

    expect(seen.at(-1)).toBe(true)
  })
})

describe('XidClient active org resolution', () => {
  it('resolves the active organization from the user membership without a network call', async () => {
    const org = {
      id: 'org_1',
      name: 'Acme',
      slug: 'acme',
      imageUrl: null,
      hasImage: false,
      membersCount: 3,
      publicMetadata: {},
      createdAt: 0,
    }
    const user = makeUser({
      organizationMemberships: [
        { id: 'mem_1', organization: org, role: 'admin', permissions: ['org:read'], createdAt: 0 },
      ],
    })
    const state = makeState({
      sessions: [makeSession({ activeOrganizationId: 'org_1' })],
      user,
    })
    const { fetcher, instance } = client({
      '/v1/me': () => ({ status: 200, json: { data: state } }),
    })

    await instance.load()

    expect(instance.organization?.id).toBe('org_1')
    expect(fetcher.calls.some((c) => c.path.startsWith('/v1/organizations/'))).toBe(false)
  })
})

describe('XidClient.setActiveSession', () => {
  it('switches active session and reloads derived state', async () => {
    const second = makeSession({ id: 'sess_2', userId: 'user_2' })
    const { instance } = client({
      '/v1/me': () => ({ status: 200, json: { data: makeState() } }),
      '/v1/sessions/active': () => ({
        status: 200,
        json: {
          data: makeState({
            activeSessionId: 'sess_2',
            sessions: [makeSession(), second],
            user: makeUser({ id: 'user_2' }),
          }),
        },
      }),
    })
    await instance.load()

    const result = await instance.setActiveSession({ sessionId: 'sess_2' })

    expect(result.ok).toBe(true)
    expect(instance.session?.id).toBe('sess_2')
    expect(instance.user?.id).toBe('user_2')
  })
})

describe('XidClient sign-in flows', () => {
  it('refreshes state after password sign-in succeeds', async () => {
    const { fetcher, instance } = client({
      '/auth/password/sign-in': () => ({ status: 200, json: { data: { redirectUrl: '/home' } } }),
      '/v1/me': () => ({ status: 200, json: { data: makeState() } }),
    })

    const result = await instance.signInPassword({ identifier: 'a@b.com', password: 'secret' })

    expect(result.ok).toBe(true)
    expect(instance.isSignedIn).toBe(true)
    expect(fetcher.calls.map((call) => call.path)).toEqual(['/auth/password/sign-in', '/v1/me'])
  })

  it('does not refresh state when password creation requires email verification', async () => {
    const { fetcher, instance } = client({
      '/auth/password/sign-in': () => ({
        status: 200,
        json: { data: { nextStep: 'verify_email' } },
      }),
    })

    const result = await instance.signInPassword({
      identifier: 'a@b.com',
      password: 'long-enough-secret',
    })

    expect(result.ok).toBe(true)
    expect(instance.isSignedIn).toBe(false)
    expect(fetcher.calls.map((call) => call.path)).toEqual(['/auth/password/sign-in'])
  })
})

describe('XidClient.setActiveOrganization', () => {
  it('reloads state and refreshes the token cache so org-scoped claims are re-issued', async () => {
    let activeOrganizationId: string | null = null
    const { fetcher, instance } = client({
      '/v1/me': () => ({
        status: 200,
        json: { data: makeState({ sessions: [makeSession({ activeOrganizationId })] }) },
      }),
      '/v1/sessions/token': () => ({ status: 200, json: makeTokenResponse() }),
      '/v1/sessions/active-organization': ({ body }) => {
        activeOrganizationId = (body as { organizationId: string | null }).organizationId
        return {
          status: 200,
          json: {
            session: {
              id: 'sess_1',
              expiresAt: '2030-01-01T00:00:00.000Z',
              isImpersonation: false,
            },
            activeOrganizationId,
          },
        }
      },
      '/v1/organizations/org_9': () => ({
        status: 200,
        json: {
          id: 'org_9',
          name: 'Nine',
          slug: 'nine',
          imageUrl: null,
          hasImage: false,
          membersCount: 1,
          publicMetadata: {},
          createdAt: 0,
        },
      }),
    })
    await instance.load()
    await instance.getToken()

    await instance.setActiveOrganization({ organizationId: 'org_9' })
    await instance.getToken()

    expect(instance.organization?.id).toBe('org_9')
    expect(fetcher.calls.filter((c) => c.path === '/v1/sessions/token')).toHaveLength(2)
    expect(fetcher.calls.map((c) => c.path)).toEqual([
      '/v1/me',
      '/v1/sessions/token',
      '/v1/sessions/active-organization',
      '/v1/me',
      '/v1/organizations/org_9',
      '/v1/sessions/token',
    ])
  })

  it('does not treat the active organization response as a full client state', async () => {
    let loadCount = 0
    const { fetcher, instance } = client({
      '/v1/me': () => {
        loadCount += 1
        return {
          status: 200,
          json: {
            data: makeState({
              sessions: [
                makeSession({
                  activeOrganizationId: loadCount > 1 ? 'org_2' : null,
                }),
              ],
            }),
          },
        }
      },
      '/v1/sessions/active-organization': () => ({
        status: 200,
        json: {
          session: {
            id: 'sess_1',
            expiresAt: '2030-01-01T00:00:00.000Z',
            isImpersonation: false,
          },
          activeOrganizationId: 'org_2',
        },
      }),
      '/v1/organizations/org_2': () => ({
        status: 200,
        json: {
          id: 'org_2',
          name: 'Two',
          slug: 'two',
          imageUrl: null,
          hasImage: false,
          membersCount: 1,
          publicMetadata: {},
          createdAt: 0,
        },
      }),
    })
    await instance.load()

    const result = await instance.setActiveOrganization({ organizationId: 'org_2' })

    expect(result.ok).toBe(true)
    expect(instance.session?.activeOrganizationId).toBe('org_2')
    expect(fetcher.calls.map((c) => c.path)).toEqual([
      '/v1/me',
      '/v1/sessions/active-organization',
      '/v1/me',
      '/v1/organizations/org_2',
    ])
  })
})

describe('XidClient.signOut', () => {
  it('resets to a signed-out ready state on full sign-out', async () => {
    const { instance } = client({
      '/v1/me': () => ({ status: 200, json: { data: makeState() } }),
      '/v1/sessions/sign-out': () => ({ status: 200, json: { data: null } }),
    })
    await instance.load()

    const result = await instance.signOut()

    expect(result.ok).toBe(true)
    const snapshot = instance.getSnapshot()
    expect(snapshot.isSignedIn).toBe(false)
    expect(snapshot.status).toBe('ready')
    expect(snapshot.user).toBeNull()
  })
})

describe('XidClient API keys', () => {
  it('delegates list/create/revoke to API client paths', async () => {
    const { fetcher, instance } = client({
      '/v1/api-keys': ({ method }) => {
        if (method === 'POST') {
          return {
            status: 201,
            json: {
              id: 'ak_2',
              name: 'Created',
              key_prefix: 'sk_live_created',
              key: 'sk_live_secret',
              environment: 'live',
              scopes: ['api_keys:read'],
              last_used_at: null,
              expires_at: null,
              revoked_at: null,
              created_at: 100,
            },
          }
        }
        return {
          status: 200,
          json: {
            data: [],
            next_cursor: null,
            has_more: false,
          },
        }
      },
      '/v1/api-keys/ak_2': () => ({
        status: 200,
        json: {
          id: 'ak_2',
          name: 'Created',
          key_prefix: 'sk_live_created',
          environment: 'live',
          scopes: ['api_keys:read'],
          last_used_at: null,
          expires_at: null,
          revoked_at: 200,
          created_at: 100,
        },
      }),
    })

    const list = await instance.listApiKeys()
    const created = await instance.createApiKey({ name: 'Created', scopes: ['api_keys:read'] })
    const revoked = await instance.revokeApiKey({ id: 'ak_2' })

    expect(list.ok).toBe(true)
    expect(created.ok).toBe(true)
    if (created.ok) expect(created.value.key).toBe('sk_live_secret')
    expect(revoked.ok).toBe(true)
    expect(fetcher.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /v1/api-keys',
      'POST /v1/api-keys',
      'DELETE /v1/api-keys/ak_2',
    ])
  })
})
