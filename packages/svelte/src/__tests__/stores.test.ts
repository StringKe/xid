import { describe, it, expect, vi } from 'vitest'
import { get } from 'svelte/store'
import type { XidState, XidStateListener, Unsubscribe } from '@xid-kit/core'
import { createXidStores } from '../stores'

const INITIAL_STATE: XidState = {
  status: 'loading',
  isLoaded: false,
  isSignedIn: false,
  session: null,
  user: null,
  organization: null,
  sessions: [],
  error: null,
}

const SIGNED_IN_STATE: XidState = {
  status: 'ready',
  isLoaded: true,
  isSignedIn: true,
  session: {
    id: 'sess_1',
    status: 'active',
    userId: 'user_1',
    activeOrganizationId: 'org_1',
    lastActiveAt: 1000,
    expireAt: 9999999,
    abandonAt: 9999999,
    createdAt: 1000,
  },
  user: {
    id: 'user_1',
    primaryEmailAddress: 'alice@example.com',
    primaryPhoneNumber: null,
    emailVerified: true,
    firstName: 'Alice',
    lastName: 'Smith',
    fullName: 'Alice Smith',
    username: 'alice',
    imageUrl: null,
    hasImage: false,
    publicMetadata: {},
    organizationMemberships: [
      {
        id: 'mem_1',
        organization: {
          id: 'org_1',
          name: 'Acme',
          slug: 'acme',
          imageUrl: null,
          hasImage: false,
          membersCount: 1,
          publicMetadata: {},
          createdAt: 1000,
        },
        role: 'admin',
        permissions: ['org:member:read', 'org:member:write'],
        createdAt: 1000,
      },
    ],
    createdAt: 1000,
    updatedAt: 1000,
  },
  organization: {
    id: 'org_1',
    name: 'Acme',
    slug: 'acme',
    imageUrl: null,
    hasImage: false,
    membersCount: 1,
    publicMetadata: {},
    createdAt: 1000,
  },
  sessions: [],
  error: null,
}

function makeClientMock(initial: XidState = INITIAL_STATE) {
  let currentState = initial
  const listeners = new Set<XidStateListener>()

  return {
    getSnapshot: () => currentState,
    subscribe: (listener: XidStateListener): Unsubscribe => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    _push: (state: XidState) => {
      currentState = state
      for (const l of listeners) l(state)
    },
    signOut: vi.fn(),
    getToken: vi.fn(),
  } as unknown as import('@xid-kit/core').XidClient & { _push: (s: XidState) => void }
}

describe('createXidStores', () => {
  describe('state store', () => {
    it('emits initial snapshot on subscribe', () => {
      const client = makeClientMock()
      const stores = createXidStores(client)
      const received: XidState[] = []
      stores.state.subscribe((s) => received.push(s))
      expect(received).toHaveLength(1)
      expect(received[0]?.isLoaded).toBe(false)
    })

    it('emits updated state when client pushes', () => {
      const client = makeClientMock()
      const stores = createXidStores(client)
      const received: XidState[] = []
      stores.state.subscribe((s) => received.push(s))
      client._push(SIGNED_IN_STATE)
      expect(received).toHaveLength(2)
      expect(received[1]?.isSignedIn).toBe(true)
    })

    it('unsubscribe stops emissions', () => {
      const client = makeClientMock()
      const stores = createXidStores(client)
      const received: XidState[] = []
      const unsub = stores.state.subscribe((s) => received.push(s))
      unsub()
      client._push(SIGNED_IN_STATE)
      expect(received).toHaveLength(1)
    })
  })

  describe('auth store', () => {
    it('returns not loaded state initially', () => {
      const client = makeClientMock()
      const stores = createXidStores(client)
      const last = get(stores.auth)
      expect(last.isLoaded).toBe(false)
      expect(last.isSignedIn).toBe(false)
      expect(last.userId).toBeNull()
    })

    it('returns signed in state with user/session ids', () => {
      const client = makeClientMock()
      const stores = createXidStores(client)
      client._push(SIGNED_IN_STATE)
      const last = get(stores.auth)
      expect(last.isLoaded).toBe(true)
      expect(last.isSignedIn).toBe(true)
      expect(last.userId).toBe('user_1')
      expect(last.sessionId).toBe('sess_1')
    })
  })

  describe('user store', () => {
    it('returns { isLoaded: false } when loading', () => {
      const client = makeClientMock()
      const stores = createXidStores(client)
      const last = get(stores.user)
      expect(last.isLoaded).toBe(false)
      expect(last.user).toBeNull()
    })

    it('returns { isLoaded: true, isSignedIn: true, user } when signed in', () => {
      const client = makeClientMock(SIGNED_IN_STATE)
      const stores = createXidStores(client)
      const last = get(stores.user)
      expect(last.isLoaded).toBe(true)
      expect(last.isSignedIn).toBe(true)
      if (last.isSignedIn) {
        expect(last.user.id).toBe('user_1')
      }
    })

    it('returns { isLoaded: true, isSignedIn: false } for unauthenticated ready state', () => {
      const client = makeClientMock({
        ...INITIAL_STATE,
        status: 'ready',
        isLoaded: true,
        isSignedIn: false,
      })
      const stores = createXidStores(client)
      const last = get(stores.user)
      expect(last.isLoaded).toBe(true)
      expect(last.isSignedIn).toBe(false)
      expect(last.user).toBeNull()
    })
  })

  describe('organization store', () => {
    it('returns loading state initially', () => {
      const client = makeClientMock()
      const stores = createXidStores(client)
      const last = get(stores.organization)
      expect(last.isLoaded).toBe(false)
    })

    it('returns org and membership when signed in with active org', () => {
      const client = makeClientMock(SIGNED_IN_STATE)
      const stores = createXidStores(client)
      const last = get(stores.organization)
      expect(last.isLoaded).toBe(true)
      expect(last.isSignedIn).toBe(true)
      if (last.isSignedIn) {
        expect(last.organization?.id).toBe('org_1')
        expect(last.membership?.role).toBe('admin')
      }
    })

    it('returns null membership when org id does not match any membership', () => {
      const stateWithMismatch: XidState = {
        ...SIGNED_IN_STATE,
        organization: { ...SIGNED_IN_STATE.organization!, id: 'org_other' },
      }
      const client = makeClientMock(stateWithMismatch)
      const stores = createXidStores(client)
      const last = get(stores.organization)
      expect(last.isSignedIn).toBe(true)
      if (last.isSignedIn) {
        expect(last.membership).toBeNull()
      }
    })
  })

  describe('session store', () => {
    it('returns loading state initially', () => {
      const client = makeClientMock()
      const stores = createXidStores(client)
      const last = get(stores.session)
      expect(last.isLoaded).toBe(false)
    })

    it('returns session when signed in', () => {
      const client = makeClientMock(SIGNED_IN_STATE)
      const stores = createXidStores(client)
      const last = get(stores.session)
      expect(last.isLoaded).toBe(true)
      if (last.isSignedIn) {
        expect(last.session.id).toBe('sess_1')
      }
    })
  })

  describe('client reference', () => {
    it('exposes the XidClient instance', () => {
      const client = makeClientMock()
      const stores = createXidStores(client)
      expect(stores.client).toBe(client)
    })
  })
})
