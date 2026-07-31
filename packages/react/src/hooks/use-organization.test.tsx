import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { XidClient, XidState } from '@xid-kit/core'
import { XidContext } from '../context/xid-context'
import { useOrganization } from './use-organization'
import { useOrganizationList } from './use-organization-list'

type OrganizationHookResult = ReturnType<typeof useOrganization>
type OrganizationListHookResult = ReturnType<typeof useOrganizationList>

const organization = {
  id: 'org_1',
  name: 'Default',
  slug: 'default',
  imageUrl: null,
  hasImage: false,
  membersCount: 1,
  publicMetadata: {},
  createdAt: 1,
}

const membership = {
  id: 'mem_1',
  organization,
  role: 'admin' as const,
  permissions: ['org:read'],
  createdAt: 1,
}

const state: XidState = {
  status: 'ready',
  isLoaded: true,
  isSignedIn: true,
  session: {
    id: 'sess_1',
    status: 'active',
    userId: 'user_1',
    activeOrganizationId: 'org_1',
    lastActiveAt: 1,
    expireAt: 9999,
    abandonAt: 9999,
    createdAt: 1,
  },
  user: {
    id: 'user_1',
    primaryEmailAddress: 'admin@example.com',
    primaryPhoneNumber: null,
    emailVerified: true,
    firstName: 'Admin',
    lastName: null,
    fullName: 'Admin',
    username: null,
    imageUrl: null,
    hasImage: false,
    publicMetadata: {},
    organizationMemberships: [membership],
    createdAt: 1,
    updatedAt: 1,
  },
  organization,
  sessions: [],
  error: null,
}

function makeClient() {
  const setActiveOrganization = vi
    .fn<XidClient['setActiveOrganization']>()
    .mockResolvedValue({ ok: true, value: state })
  return {
    client: {
      getSnapshot: () => state,
      subscribe: () => () => {},
      setActiveOrganization,
    } as unknown as XidClient,
    setActiveOrganization,
  }
}

function renderWithClient(children: ReactNode, client: XidClient): void {
  renderToStaticMarkup(
    <XidContext.Provider value={{ client, mode: 'same-origin' }}>{children}</XidContext.Provider>,
  )
}

describe('organization hooks', () => {
  it('useOrganization derives the active membership and delegates setActive to core', async () => {
    const { client, setActiveOrganization } = makeClient()
    const holder: { current: OrganizationHookResult | null } = { current: null }

    function Capture(): ReactNode {
      holder.current = useOrganization()
      return null
    }

    renderWithClient(<Capture />, client)

    const captured = holder.current
    if (!captured) throw new Error('useOrganization result was not captured')
    expect(captured?.isLoaded).toBe(true)
    if (captured.isLoaded && captured.isSignedIn) {
      expect(captured.organization?.id).toBe('org_1')
      expect(captured.membership?.id).toBe('mem_1')
      await captured.setActive('org_1')
    }
    expect(setActiveOrganization).toHaveBeenCalledWith({ organizationId: 'org_1' })
  })

  it('useOrganizationList exposes active membership and delegates clear active org', async () => {
    const { client, setActiveOrganization } = makeClient()
    const holder: { current: OrganizationListHookResult | null } = { current: null }

    function Capture(): ReactNode {
      holder.current = useOrganizationList()
      return null
    }

    renderWithClient(<Capture />, client)

    const captured = holder.current
    if (!captured) throw new Error('useOrganizationList result was not captured')
    expect(captured?.isLoaded).toBe(true)
    if (captured.isLoaded && captured.isSignedIn) {
      expect(captured.memberships).toHaveLength(1)
      expect(captured.activeMembership?.id).toBe('mem_1')
      await captured.setActive(null)
    }
    expect(setActiveOrganization).toHaveBeenCalledWith({ organizationId: null })
  })
})
