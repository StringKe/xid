// @vitest-environment jsdom
// GuestUpgradeBanner 渲染契约:guest 渲染引导,非 guest / 未登录渲染 null。

import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { XidClient, XidState, XidUser } from '@xid-kit/core'
import { XidContext } from '../../context/xid-context'
import { GuestUpgradeBanner } from './guest-upgrade-banner'

const i18n = setupI18n({ locale: 'en', messages: { en: {} } })

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

function makeState(overrides: Partial<XidState> = {}): XidState {
  return {
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
    user: makeUser(),
    organization: null,
    sessions: [],
    error: null,
    ...overrides,
  }
}

function renderBanner(state: XidState): ReturnType<typeof render> {
  const client = {
    getSnapshot: () => state,
    subscribe: () => () => {},
  } as unknown as XidClient
  return render(
    <I18nProvider i18n={i18n}>
      <XidContext.Provider value={{ client, publishableKey: 'pk_test' }}>
        <GuestUpgradeBanner redirectUrl="/app" />
      </XidContext.Provider>
    </I18nProvider>,
  ) as ReturnType<typeof render>
}

describe('GuestUpgradeBanner', () => {
  afterEach(cleanup)

  it('renders the upgrade prompt for a guest user', () => {
    renderBanner(makeState({ user: makeUser({ provisionedBy: 'anonymous' }) }))

    const banner = document.querySelector<HTMLElement>('.xid-guest-upgrade-banner')
    expect(banner).not.toBeNull()
    expect(banner?.textContent).toContain('guest')

    const action = banner?.querySelector<HTMLAnchorElement>('.xid-guest-upgrade-banner__action')
    expect(action?.getAttribute('href')).toBe('/sign-up?redirect_url=%2Fapp')
  })

  it('renders nothing for a non-guest user', () => {
    renderBanner(makeState())

    expect(document.querySelector('.xid-guest-upgrade-banner')).toBeNull()
  })

  it('renders nothing when signed out or still loading', () => {
    renderBanner(makeState({ isSignedIn: false, session: null, user: null }))
    expect(document.querySelector('.xid-guest-upgrade-banner')).toBeNull()

    cleanup()
    renderBanner(makeState({ isLoaded: false, user: makeUser({ provisionedBy: 'anonymous' }) }))
    expect(document.querySelector('.xid-guest-upgrade-banner')).toBeNull()
  })
})
