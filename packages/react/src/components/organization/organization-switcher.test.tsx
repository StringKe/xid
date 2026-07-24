// @vitest-environment jsdom
// OrganizationSwitcher 弹出层行为契约:进出场存在性、Escape / 外部点击关闭、关闭后焦点回 trigger。

import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { XidClient, XidState } from '@xid-kit/core'
import { XidContext } from '../../context/xid-context'
import { OrganizationSwitcher } from './organization-switcher'

const i18n = setupI18n({ locale: 'en', messages: { en: {} } })

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
    organizationMemberships: [
      { id: 'mem_1', organization, role: 'admin', permissions: ['org:read'], createdAt: 1 },
    ],
    createdAt: 1,
    updatedAt: 1,
  },
  organization,
  sessions: [],
  error: null,
}

function makeClient(): XidClient {
  return {
    getSnapshot: () => state,
    subscribe: () => () => {},
    setActiveOrganization: vi.fn().mockResolvedValue({ ok: true, value: state }),
  } as unknown as XidClient
}

function renderSwitcher(): ReturnType<typeof render> {
  return render(
    <I18nProvider i18n={i18n}>
      <XidContext.Provider value={{ client: makeClient(), publishableKey: 'pk_test' }}>
        <OrganizationSwitcher />
      </XidContext.Provider>
    </I18nProvider>,
  )
}

function openPopover(): HTMLElement {
  const trigger = document.querySelector<HTMLElement>('.xid-org-switcher__trigger')
  if (!trigger) throw new Error('trigger not rendered')
  fireEvent.click(trigger)
  return trigger
}

describe('OrganizationSwitcher popover', () => {
  afterEach(cleanup)

  it('opens the listbox on trigger click with motion popover styles', () => {
    renderSwitcher()

    openPopover()

    const listbox = document.querySelector<HTMLElement>('.xid-org-switcher__popover')
    expect(listbox).not.toBeNull()
    expect(listbox?.getAttribute('role')).toBe('listbox')
    expect(listbox?.style.transformOrigin).toBe('top left')
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(2)
  })

  it('closes on Escape and returns focus to the trigger', async () => {
    renderSwitcher()
    const trigger = openPopover()

    fireEvent.keyDown(document, { key: 'Escape' })

    await waitFor(() => {
      expect(document.querySelector('.xid-org-switcher__popover')).toBeNull()
    })
    expect(document.activeElement).toBe(trigger)
  })

  it('closes on outside pointerdown', async () => {
    renderSwitcher()
    openPopover()

    fireEvent.pointerDown(document.body)

    await waitFor(() => {
      expect(document.querySelector('.xid-org-switcher__popover')).toBeNull()
    })
  })
})
