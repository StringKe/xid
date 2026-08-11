// vi.mock 会被 Vitest 提升到文件顶层；须写在会解析 ./context 的 import 之前，下方再 import 才能拿到 mock。

import { describe, expect, it, vi } from 'vitest'
import { createRoot } from 'solid-js'

import { XidClient, XidStore } from '@xid-kit/core'
import type { XidOrganization, XidState, XidUser } from '@xid-kit/core'

import { createAuth, createOrganization, createSession, createUser } from './primitives'
import type { XidContextValue } from './context'

vi.mock('./context', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./context')>()
  return { ...mod, useXidContext: vi.fn() }
})

import { useXidContext } from './context'

const organization: XidOrganization = {
  id: 'org_1',
  name: 'Acme',
  slug: 'acme',
  imageUrl: null,
  hasImage: false,
  membersCount: 2,
  publicMetadata: {},
  createdAt: 1,
}

const membership = {
  id: 'mem_1',
  organization,
  role: 'admin' as const,
  permissions: ['org:member:read', 'org:member:write'],
  createdAt: 1,
}

const user: XidUser = {
  id: 'user_1',
  primaryEmailAddress: 'dev@example.com',
  primaryPhoneNumber: null,
  emailVerified: true,
  firstName: 'Dev',
  lastName: null,
  fullName: 'Dev',
  username: null,
  imageUrl: null,
  hasImage: false,
  publicMetadata: {},
  organizationMemberships: [membership],
  createdAt: 1,
  updatedAt: 1,
}

const session = {
  id: 'sess_1',
  status: 'active' as const,
  userId: 'user_1',
  activeOrganizationId: 'org_1',
  lastActiveAt: 1,
  expireAt: 9_999_999,
  abandonAt: 9_999_999,
  createdAt: 1,
}

const readyState: XidState = {
  status: 'ready',
  isLoaded: true,
  isSignedIn: true,
  session,
  user,
  organization,
  sessions: [session],
  error: null,
}

const loadingState: XidState = {
  status: 'loading',
  isLoaded: false,
  isSignedIn: false,
  session: null,
  user: null,
  organization: null,
  sessions: [],
  error: null,
}

const signedOutState: XidState = {
  status: 'ready',
  isLoaded: true,
  isSignedIn: false,
  session: null,
  user: null,
  organization: null,
  sessions: [],
  error: null,
}

// subscribe 设为 no-op，保证同步单测中 state 固定。
function makeContextValue(state: XidState): XidContextValue {
  const client = new XidClient()
  vi.spyOn(client, 'getSnapshot').mockReturnValue(state)
  vi.spyOn(client, 'subscribe').mockReturnValue(() => {})
  return { client, mode: 'same-origin' }
}

function withMockedContext(state: XidState, fn: () => void): void {
  const ctx = makeContextValue(state)
  vi.mocked(useXidContext).mockReturnValue(ctx)
  createRoot((dispose) => {
    fn()
    dispose()
  })
}

describe('createAuth primitive (real implementation)', () => {
  it('isLoaded() returns true when signed in', () => {
    withMockedContext(readyState, () => {
      const auth = createAuth()
      expect(auth.isLoaded()).toBe(true)
      expect(auth.isSignedIn()).toBe(true)
      expect(auth.userId()).toBe('user_1')
      expect(auth.sessionId()).toBe('sess_1')
      expect(auth.session()).not.toBeNull()
    })
  })

  it('isLoaded() returns false during loading', () => {
    withMockedContext(loadingState, () => {
      const auth = createAuth()
      expect(auth.isLoaded()).toBe(false)
      expect(auth.isSignedIn()).toBe(false)
      expect(auth.userId()).toBeNull()
      expect(auth.sessionId()).toBeNull()
    })
  })

  it('isSignedIn() returns false when signed out', () => {
    withMockedContext(signedOutState, () => {
      const auth = createAuth()
      expect(auth.isLoaded()).toBe(true)
      expect(auth.isSignedIn()).toBe(false)
    })
  })
})

describe('createUser primitive (real implementation)', () => {
  it('returns user when signed in', () => {
    withMockedContext(readyState, () => {
      const user$ = createUser()
      const result = user$()
      expect(result.isLoaded).toBe(true)
      expect(result.isSignedIn).toBe(true)
      if (result.isSignedIn) {
        expect(result.user.id).toBe('user_1')
      }
    })
  })

  it('returns null user when signed out', () => {
    withMockedContext(signedOutState, () => {
      const user$ = createUser()
      const result = user$()
      expect(result.isLoaded).toBe(true)
      expect(result.isSignedIn).toBe(false)
      expect(result.user).toBeNull()
    })
  })

  it('returns not-loaded shape during initial load', () => {
    withMockedContext(loadingState, () => {
      const user$ = createUser()
      const result = user$()
      expect(result.isLoaded).toBe(false)
      expect(result.user).toBeNull()
    })
  })
})

describe('createOrganization primitive (real implementation)', () => {
  it('resolves active membership when org is active', () => {
    withMockedContext(readyState, () => {
      const org$ = createOrganization()
      const result = org$()
      expect(result.isLoaded).toBe(true)
      expect(result.isSignedIn).toBe(true)
      if (result.isSignedIn) {
        expect(result.organization?.id).toBe('org_1')
        expect(result.membership?.id).toBe('mem_1')
        expect(result.membership?.role).toBe('admin')
        expect(result.membership?.permissions).toContain('org:member:read')
      }
    })
  })

  it('returns null org when no active organization', () => {
    const stateNoOrg: XidState = {
      ...readyState,
      organization: null,
      session: { ...session, activeOrganizationId: null },
    }
    withMockedContext(stateNoOrg, () => {
      const org$ = createOrganization()
      const result = org$()
      expect(result.isLoaded).toBe(true)
      expect(result.isSignedIn).toBe(true)
      if (result.isSignedIn) {
        expect(result.organization).toBeNull()
        expect(result.membership).toBeNull()
      }
    })
  })

  it('returns not-signed-in shape when signed out', () => {
    withMockedContext(signedOutState, () => {
      const org$ = createOrganization()
      const result = org$()
      expect(result.isLoaded).toBe(true)
      expect(result.isSignedIn).toBe(false)
      expect(result.organization).toBeNull()
    })
  })
})

describe('createSession primitive (real implementation)', () => {
  it('returns active session when signed in', () => {
    withMockedContext(readyState, () => {
      const sess$ = createSession()
      const result = sess$()
      expect(result.isLoaded).toBe(true)
      expect(result.isSignedIn).toBe(true)
      if (result.isSignedIn) {
        expect(result.session.id).toBe('sess_1')
        expect(result.session.status).toBe('active')
      }
    })
  })

  it('returns null session when signed out', () => {
    withMockedContext(signedOutState, () => {
      const sess$ = createSession()
      const result = sess$()
      expect(result.isLoaded).toBe(true)
      expect(result.isSignedIn).toBe(false)
      expect(result.session).toBeNull()
    })
  })

  it('returns not-loaded shape during initial load', () => {
    withMockedContext(loadingState, () => {
      const sess$ = createSession()
      const result = sess$()
      expect(result.isLoaded).toBe(false)
      expect(result.session).toBeNull()
    })
  })
})

describe('XidStore subscription (signal source for createXidState)', () => {
  it('emits updated state to subscribers when setState is called', () => {
    const store = new XidStore()
    const received: XidState[] = []

    const unsubscribe = store.subscribe((s) => received.push(s))
    store.setState({ isLoaded: true, status: 'ready' })

    expect(received).toHaveLength(1)
    expect(received[0]?.isLoaded).toBe(true)

    unsubscribe()
  })

  it('stops emitting after unsubscribe', () => {
    const store = new XidStore()
    const received: XidState[] = []

    const unsubscribe = store.subscribe((s) => received.push(s))
    store.setState({ isLoaded: true, status: 'ready' })
    unsubscribe()

    store.setState({ isLoaded: false, status: 'loading' })

    expect(received).toHaveLength(1)
  })

  it('does not emit when patch values are identical (shallow equal)', () => {
    const store = new XidStore()
    store.setState({ isLoaded: true, status: 'ready' })

    const received: XidState[] = []
    store.subscribe((s) => received.push(s))

    store.setState({ isLoaded: true, status: 'ready' })

    expect(received).toHaveLength(0)
  })

  it('getSnapshot returns current state before any updates', () => {
    const store = new XidStore()

    const snap = store.getSnapshot()

    expect(snap.isLoaded).toBe(false)
    expect(snap.status).toBe('loading')
  })
})

// 从 Protect 抽出的 active-org 权限判定，避免挂载完整组件。
function shouldProtectRender(
  snap: XidState,
  opts: { permission?: string; role?: 'owner' | 'admin' | 'member' },
): boolean {
  if (!snap.isLoaded || !snap.isSignedIn) return false
  if (opts.permission === undefined && opts.role === undefined) return true

  const memberships = snap.user?.organizationMemberships ?? []
  const activeMembership = memberships.find((m) => m.organization.id === snap.organization?.id)

  if (opts.role !== undefined && activeMembership?.role !== opts.role) return false
  if (opts.permission !== undefined && !activeMembership?.permissions.includes(opts.permission)) {
    return false
  }
  return true
}

describe('Protect RBAC guard logic', () => {
  it('renders when signed in with no RBAC constraint', () => {
    expect(shouldProtectRender(readyState, {})).toBe(true)
  })

  it('renders when role matches the active membership role', () => {
    expect(shouldProtectRender(readyState, { role: 'admin' })).toBe(true)
  })

  it('blocks when role does not match', () => {
    expect(shouldProtectRender(readyState, { role: 'member' })).toBe(false)
  })

  it('renders when required permission is in the membership permissions', () => {
    expect(shouldProtectRender(readyState, { permission: 'org:member:read' })).toBe(true)
  })

  it('blocks when required permission is absent from membership permissions', () => {
    expect(shouldProtectRender(readyState, { permission: 'org:billing:write' })).toBe(false)
  })

  it('blocks when role passes but permission fails', () => {
    expect(
      shouldProtectRender(readyState, { role: 'admin', permission: 'org:billing:write' }),
    ).toBe(false)
  })

  it('blocks when role fails even if permission would pass', () => {
    expect(shouldProtectRender(readyState, { role: 'member', permission: 'org:member:read' })).toBe(
      false,
    )
  })

  it('blocks when not signed in', () => {
    expect(shouldProtectRender(signedOutState, {})).toBe(false)
  })

  it('blocks during initial loading', () => {
    expect(shouldProtectRender(loadingState, {})).toBe(false)
  })

  it('blocks when user has no active org membership for role check', () => {
    const stateNoOrg: XidState = {
      ...readyState,
      organization: null,
      session: { ...session, activeOrganizationId: null },
    }

    expect(shouldProtectRender(stateNoOrg, { role: 'admin' })).toBe(false)
  })
})
