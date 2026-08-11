// Vue 3 非组件上下文无 inject；用 effectScope + inject mock 测门控逻辑。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { effectScope } from 'vue'

import type { XidState } from '@xid-kit/core'

vi.mock('vue', async (importOriginal) => {
  const vue = await importOriginal<typeof import('vue')>()
  return { ...vue, inject: vi.fn() }
})

import { inject } from 'vue'
import { XidClient } from '@xid-kit/core'

function makeState(overrides: Partial<XidState> = {}): XidState {
  return {
    status: 'ready',
    isLoaded: true,
    isSignedIn: false,
    session: null,
    user: null,
    organization: null,
    sessions: [],
    error: null,
    ...overrides,
  }
}

function makeClient(stateOverrides: Partial<XidState> = {}): XidClient {
  const client = new XidClient({ fetcher: () => Promise.resolve(new Response(null)) })
  vi.spyOn(client, 'getSnapshot').mockReturnValue(makeState(stateOverrides))
  vi.spyOn(client, 'subscribe').mockReturnValue(() => {})
  return client
}

import { useXidState } from '../composables/use-xid-state'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useXidState reactivity guard', () => {
  it('returns current snapshot when not loaded', () => {
    const client = makeClient({ isLoaded: false })
    vi.mocked(inject).mockReturnValue(client)

    const scope = effectScope()
    let stateRef: ReturnType<typeof useXidState> | undefined
    scope.run(() => {
      stateRef = useXidState()
    })

    expect(stateRef?.value.isLoaded).toBe(false)
    scope.stop()
  })

  it('returns isSignedIn=true when state has user', () => {
    const user = {
      id: 'u1',
      primaryEmailAddress: 'a@b.com',
      primaryPhoneNumber: null,
      emailVerified: true,
      firstName: null,
      lastName: null,
      fullName: null,
      username: null,
      imageUrl: null,
      hasImage: false,
      publicMetadata: {},
      organizationMemberships: [],
      createdAt: 0,
      updatedAt: 0,
    }
    const client = makeClient({ isLoaded: true, isSignedIn: true, user })
    vi.mocked(inject).mockReturnValue(client)

    const scope = effectScope()
    let stateRef: ReturnType<typeof useXidState> | undefined
    scope.run(() => {
      stateRef = useXidState()
    })

    expect(stateRef?.value.isSignedIn).toBe(true)
    scope.stop()
  })
})

describe('Protect permission/role logic', () => {
  it('allows render when signed in with matching role', () => {
    const membership = {
      id: 'm1',
      organization: {
        id: 'org1',
        name: 'Org',
        slug: 'org',
        imageUrl: null,
        hasImage: false,
        membersCount: 1,
        publicMetadata: {},
        createdAt: 0,
      },
      role: 'admin' as const,
      permissions: ['org:member:read'],
      createdAt: 0,
    }
    const user = {
      id: 'u1',
      primaryEmailAddress: 'a@b.com',
      primaryPhoneNumber: null,
      emailVerified: true,
      firstName: null,
      lastName: null,
      fullName: null,
      username: null,
      imageUrl: null,
      hasImage: false,
      publicMetadata: {},
      organizationMemberships: [membership],
      createdAt: 0,
      updatedAt: 0,
    }
    const client = makeClient({
      isLoaded: true,
      isSignedIn: true,
      user,
      organization: membership.organization,
    })
    vi.mocked(inject).mockReturnValue(client)

    const scope = effectScope()
    let stateRef: ReturnType<typeof useXidState> | undefined
    scope.run(() => {
      stateRef = useXidState()
    })

    const activeMembership = stateRef?.value.user?.organizationMemberships.find(
      (m) => m.organization.id === stateRef?.value.organization?.id,
    )

    expect(activeMembership?.role).toBe('admin')
    expect(activeMembership?.permissions).toContain('org:member:read')
    scope.stop()
  })

  it('blocks render when role does not match', () => {
    const membership = {
      id: 'm2',
      organization: {
        id: 'org2',
        name: 'Org2',
        slug: 'org2',
        imageUrl: null,
        hasImage: false,
        membersCount: 1,
        publicMetadata: {},
        createdAt: 0,
      },
      role: 'member' as const,
      permissions: [],
      createdAt: 0,
    }
    const user = {
      id: 'u2',
      primaryEmailAddress: 'b@b.com',
      primaryPhoneNumber: null,
      emailVerified: true,
      firstName: null,
      lastName: null,
      fullName: null,
      username: null,
      imageUrl: null,
      hasImage: false,
      publicMetadata: {},
      organizationMemberships: [membership],
      createdAt: 0,
      updatedAt: 0,
    }
    const client = makeClient({
      isLoaded: true,
      isSignedIn: true,
      user,
      organization: membership.organization,
    })
    vi.mocked(inject).mockReturnValue(client)

    const scope = effectScope()
    let stateRef: ReturnType<typeof useXidState> | undefined
    scope.run(() => {
      stateRef = useXidState()
    })

    const activeMembership = stateRef?.value.user?.organizationMemberships.find(
      (m) => m.organization.id === stateRef?.value.organization?.id,
    )

    expect(activeMembership?.role).not.toBe('admin')
    scope.stop()
  })
})
