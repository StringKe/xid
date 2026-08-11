// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { AuthUser } from '../../lib/auth-context'

const authState = vi.hoisted(() => ({
  user: null as AuthUser | null,
}))

vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings[0] }),
}))

vi.mock('../../lib/auth-context', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/auth-context')>()
  return {
    ...original,
    useAuth: () => ({ user: authState.user }),
  }
})

vi.mock('../../lib/router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}))

import { GuestConversionBanner } from './GuestConversionBanner'

function userWith(provisionedBy?: string): AuthUser {
  return {
    id: 'user_1',
    email: 'user@example.com',
    emailVerified: true,
    name: null,
    imageUrl: null,
    locale: null,
    hasMfa: false,
    instanceManager: false,
    ...(provisionedBy === undefined ? {} : { provisioned_by: provisionedBy }),
  }
}

describe('GuestConversionBanner', () => {
  beforeEach(() => {
    globalThis.sessionStorage?.clear()
  })

  it('renders the conversion banner for a guest user with a link to credential setup', () => {
    authState.user = userWith('anonymous')

    const html = renderToStaticMarkup(<GuestConversionBanner />)

    expect(html).toContain('Guest account')
    expect(html).toContain('cannot be recovered')
    expect(html).toContain('href="/account/security"')
    expect(html).toContain('Set up a sign-in method')
  })

  it('renders nothing for a non-guest user', () => {
    authState.user = userWith(undefined)
    expect(renderToStaticMarkup(<GuestConversionBanner />)).toBe('')

    authState.user = userWith('password')
    expect(renderToStaticMarkup(<GuestConversionBanner />)).toBe('')

    authState.user = null
    expect(renderToStaticMarkup(<GuestConversionBanner />)).toBe('')
  })

  it('dismisses for the rest of the session (sessionStorage, not the server)', async () => {
    ;(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true
    authState.user = userWith('anonymous')
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(<GuestConversionBanner />)
    })
    expect(container.textContent).toContain('Guest account')

    const dismiss = container.querySelector('button[aria-label="Dismiss guest notice"]')
    expect(dismiss).not.toBeNull()
    await act(async () => {
      dismiss?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.textContent).not.toContain('Guest account')
    expect(globalThis.sessionStorage?.getItem('xid.guest-banner.dismissed')).toBe('1')

    await act(async () => {
      root.unmount()
    })

    const root2 = createRoot(container)
    await act(async () => {
      root2.render(<GuestConversionBanner />)
    })
    expect(container.textContent).not.toContain('Guest account')

    await act(async () => {
      root2.unmount()
    })
    container.remove()
  })
})
