import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

const routerState = vi.hoisted(() => ({
  pathname: '/console',
  searchStr: '',
  hash: '',
  state: undefined as unknown,
  href: '/console',
}))
const navigateMock = vi.hoisted(() => vi.fn<(options: Record<string, unknown>) => void>())

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    className,
    children,
    ...rest
  }: {
    to: string
    className?: string
    children?: ReactNode
  }) => (
    <a href={to} className={className} {...rest}>
      {children}
    </a>
  ),
  useLocation: () => ({
    pathname: routerState.pathname,
    searchStr: routerState.searchStr,
    hash: routerState.hash,
    state: routerState.state,
  }),
  useNavigate: () => navigateMock,
  useRouterState: () => '',
}))

import { Link, Navigate, NavLink } from './tanstack-router'

describe('Link', () => {
  it('renders dynamic string routes as real href values', () => {
    const html = renderToStaticMarkup(
      <Link to="/console/platform/organizations">Organization metrics</Link>,
    )

    expect(html).toContain('href="/console/platform/organizations"')
    expect(html).not.toContain('__link__')
  })

  it('renders object routes as real href values', () => {
    const html = renderToStaticMarkup(
      <Link to={{ pathname: '/mfa', search: '?method=backup' }}>Backup code</Link>,
    )

    expect(html).toContain('href="/mfa?method=backup"')
    expect(html).not.toContain('__link__')
  })
})

describe('NavLink', () => {
  it('resolves className render function before passing props to the anchor', () => {
    routerState.pathname = '/console'

    const html = renderToStaticMarkup(
      <NavLink
        to="/console"
        end
        className={({ isActive }) => (isActive ? 'active-link' : 'inactive-link')}
      >
        Overview
      </NavLink>,
    )

    expect(html).toContain('class="active-link"')
    expect(html).not.toContain('isActive')
    expect(html).not.toContain('=&gt;')
  })

  it('resolves children render function with active state', () => {
    routerState.pathname = '/console/users'

    const html = renderToStaticMarkup(
      <NavLink
        to="/console"
        className={({ isActive }) => (isActive ? 'active-link' : 'inactive-link')}
      >
        {({ isActive }) => (isActive ? 'Active section' : 'Inactive section')}
      </NavLink>,
    )

    expect(html).toContain('class="active-link"')
    expect(html).toContain('Active section')
  })

  it('honors exact matching when end is true', () => {
    routerState.pathname = '/console/users'

    const html = renderToStaticMarkup(
      <NavLink
        to="/console"
        end
        className={({ isActive }) => (isActive ? 'active-link' : 'inactive-link')}
      >
        Overview
      </NavLink>,
    )

    expect(html).toContain('class="inactive-link"')
  })
})

describe('Navigate', () => {
  it('does not render a leaked redirect target during server rendering', () => {
    const html = renderToStaticMarkup(
      <Navigate
        to="/sign-in?continue=%2Fconsole%2Forg%2Fauth-policy%3ForgId%3Dorg_1%23top"
        replace
      />,
    )

    expect(html).toBe('')
    expect(navigateMock).not.toHaveBeenCalled()
  })
})
