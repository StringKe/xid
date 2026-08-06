// @vitest-environment jsdom
// useUpgradeGuest 状态流转:pending / error / isGuest 暴露契约。

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { XidClient, XidState, XidUser } from '@xid-kit/core'

import { XidContext } from '../context/xid-context'
import { useUpgradeGuest } from './use-upgrade-guest'

function makeUser(overrides: Partial<XidUser> = {}): XidUser {
  return {
    id: 'user_1',
    primaryEmailAddress: null,
    primaryPhoneNumber: null,
    emailVerified: false,
    firstName: null,
    lastName: null,
    fullName: null,
    username: null,
    imageUrl: null,
    hasImage: false,
    publicMetadata: {},
    organizationMemberships: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function makeState(user: XidUser | null): XidState {
  return {
    status: 'ready',
    isLoaded: true,
    isSignedIn: user !== null,
    session: null,
    user,
    organization: null,
    sessions: [],
    error: null,
  }
}

function makeClient(state: XidState, upgrade: XidClient['upgradeGuestWithPasskey']): XidClient {
  return {
    getSnapshot: () => state,
    subscribe: () => () => {},
    upgradeGuestWithPasskey: upgrade,
  } as unknown as XidClient
}

function makeWrapper(client: XidClient) {
  return function Wrapper({ children }: { children: ReactNode }): ReactNode {
    return (
      <XidContext.Provider value={{ client, mode: 'same-origin' }}>{children}</XidContext.Provider>
    )
  }
}

const GUEST_STATE = makeState(makeUser({ provisionedBy: 'anonymous' }))

describe('useUpgradeGuest', () => {
  it('exposes isGuest from the current user', () => {
    const upgrade = vi.fn()
    const guest = renderHook(() => useUpgradeGuest(), {
      wrapper: makeWrapper(makeClient(GUEST_STATE, upgrade)),
    })
    expect(guest.result.current.isGuest).toBe(true)
    expect(guest.result.current.pending).toBe(false)
    expect(guest.result.current.error).toBeNull()

    const regular = renderHook(() => useUpgradeGuest(), {
      wrapper: makeWrapper(makeClient(makeState(makeUser()), upgrade)),
    })
    expect(regular.result.current.isGuest).toBe(false)
  })

  it('returns the client result and keeps error empty on success', async () => {
    const upgrade = vi.fn().mockResolvedValue({ ok: true, value: GUEST_STATE })
    const { result } = renderHook(() => useUpgradeGuest(), {
      wrapper: makeWrapper(makeClient(GUEST_STATE, upgrade)),
    })

    let outcome: Awaited<ReturnType<typeof result.current.upgradeGuestWithPasskey>> | null = null
    await act(async () => {
      outcome = await result.current.upgradeGuestWithPasskey({ deviceName: 'Laptop' })
    })

    expect(upgrade).toHaveBeenCalledWith({ deviceName: 'Laptop' })
    expect(outcome).toEqual({ ok: true, value: GUEST_STATE })
    expect(result.current.pending).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('surfaces an expected failure in error state and clears pending', async () => {
    const failure = {
      ok: false as const,
      error: { code: 'access_denied' as const, message: 'cancelled', httpStatus: 400 },
    }
    const upgrade = vi.fn().mockResolvedValue(failure)
    const { result } = renderHook(() => useUpgradeGuest(), {
      wrapper: makeWrapper(makeClient(GUEST_STATE, upgrade)),
    })

    await act(async () => {
      await result.current.upgradeGuestWithPasskey()
    })

    expect(result.current.pending).toBe(false)
    expect(result.current.error).toEqual(failure.error)
  })
})
