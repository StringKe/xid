// @vitest-environment jsdom
// UserButton 弹出层行为契约:进出场存在性、Escape / 外部点击关闭、关闭后焦点回 trigger。

import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { XidClient, XidState } from '@xid-kit/core'
import { XidContext } from '../../context/xid-context'
import { UserButton } from './user-button'

const i18n = setupI18n({ locale: 'en', messages: { en: {} } })

const state: XidState = {
  status: 'ready',
  isLoaded: true,
  isSignedIn: true,
  session: {
    id: 'sess_1',
    status: 'active',
    userId: 'user_1',
    activeOrganizationId: null,
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
    organizationMemberships: [],
    createdAt: 1,
    updatedAt: 1,
  },
  organization: null,
  sessions: [],
  error: null,
}

function makeClient(): XidClient {
  return {
    getSnapshot: () => state,
    subscribe: () => () => {},
    signOut: vi.fn().mockResolvedValue(undefined),
    setActiveSession: vi.fn().mockResolvedValue({ ok: true, value: state }),
  } as unknown as XidClient
}

function renderUserButton(): ReturnType<typeof render> {
  return render(
    <I18nProvider i18n={i18n}>
      <XidContext.Provider value={{ client: makeClient(), publishableKey: 'pk_test' }}>
        <UserButton />
      </XidContext.Provider>
    </I18nProvider>,
  )
}

function openPopover(): HTMLElement {
  const trigger = document.querySelector<HTMLElement>('.xid-user-button__trigger')
  if (!trigger) throw new Error('trigger not rendered')
  fireEvent.click(trigger)
  return trigger
}

describe('UserButton popover', () => {
  afterEach(cleanup)

  it('opens the menu on trigger click with motion popover styles', () => {
    renderUserButton()

    openPopover()

    const menu = document.querySelector<HTMLElement>('.xid-user-button__popover')
    expect(menu).not.toBeNull()
    expect(menu?.getAttribute('role')).toBe('menu')
    expect(menu?.style.transformOrigin).toBe('top right')
  })

  it('closes on Escape and returns focus to the trigger', async () => {
    renderUserButton()
    const trigger = openPopover()

    fireEvent.keyDown(document, { key: 'Escape' })

    await waitFor(() => {
      expect(document.querySelector('.xid-user-button__popover')).toBeNull()
    })
    expect(document.activeElement).toBe(trigger)
  })

  it('closes on outside pointerdown', async () => {
    renderUserButton()
    openPopover()

    fireEvent.pointerDown(document.body)

    await waitFor(() => {
      expect(document.querySelector('.xid-user-button__popover')).toBeNull()
    })
  })

  it('keeps the popover open on inside pointerdown', () => {
    renderUserButton()
    openPopover()

    const menu = document.querySelector<HTMLElement>('.xid-user-button__popover')
    if (!menu) throw new Error('menu not rendered')
    fireEvent.pointerDown(menu)

    expect(document.querySelector('.xid-user-button__popover')).not.toBeNull()
  })
})
