// enabled 须与 requireOrgManager 同源;node 环境用最小 useApiQuery 替身门控。

import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { AuthOrg } from '@xid-kit/web-ui/session'

const authState = vi.hoisted((): { activeOrg: AuthOrg | null } => ({ activeOrg: null }))
const apiGet = vi.hoisted(() => vi.fn(() => Promise.resolve({ ok: true, value: {} })))

vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  Plural: ({ value }: { value: number }) => <>{value}</>,
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings[0] }),
}))

vi.mock('@lingui/core/macro', () => ({
  msg: (strings: TemplateStringsArray) => ({ id: strings.join(''), message: strings.join('') }),
}))

vi.mock('@xid-kit/web-ui/session', () => ({
  useAuth: () => ({ activeOrg: authState.activeOrg, user: null, api: { get: apiGet } }),
}))

// quick actions/context bar 移出 data 分支后,activeOrg 非空即渲染 Link。
vi.mock('@xid-kit/web-ui/tanstack-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}))

vi.mock('@xid-kit/web-ui/queries', () => ({
  useApiQuery: (_key: readonly unknown[], path: string, options?: { enabled?: boolean }) => {
    if (options?.enabled !== false) {
      void apiGet(path, { signal: new AbortController().signal })
    }
    return { data: undefined, isLoading: false, isError: false }
  },
}))

import OrgOverview from './OrgOverview'
import { useCanManageOrg } from './useOrgTarget'

const managerOrg: AuthOrg = {
  id: 'org_1',
  slug: 'acme',
  name: 'Acme',
  role: 'owner',
  permissions: [],
}

function CanManageProbe({ orgId }: { orgId: string }): ReactNode {
  return <span data-can-manage={String(useCanManageOrg(orgId))} />
}

function renderOverview(): string {
  return renderToStaticMarkup(<OrgOverview />)
}

const OVERVIEW_PATHS = [
  '/v1/organizations/org_1/attention',
  '/v1/organizations/org_1/sign-in-activity',
  '/v1/organizations/org_1/setup-progress',
]

describe('OrgOverview request gating', () => {
  beforeEach(() => {
    authState.activeOrg = null
    apiGet.mockClear()
  })

  it('does not request overview data for a member role', () => {
    authState.activeOrg = { ...managerOrg, role: 'member' }

    renderOverview()

    expect(apiGet).not.toHaveBeenCalled()
  })

  it('does not request overview data while the active organization is unresolved', () => {
    renderOverview()

    expect(apiGet).not.toHaveBeenCalled()
  })

  it.each(['owner', 'admin'])('requests attention, activity and setup progress for %s', (role) => {
    authState.activeOrg = { ...managerOrg, role }

    renderOverview()

    expect(apiGet.mock.calls.map((call) => (call as unknown[])[0])).toEqual(OVERVIEW_PATHS)
  })
})

describe('useCanManageOrg', () => {
  beforeEach(() => {
    authState.activeOrg = null
  })

  it.each([
    ['owner', true],
    ['admin', true],
    ['member', false],
    ['guest', false],
  ])('resolves %s to %s', (role, expected) => {
    authState.activeOrg = { ...managerOrg, role }

    const html = renderToStaticMarkup(<CanManageProbe orgId="org_1" />)

    expect(html).toContain(`data-can-manage="${String(expected)}"`)
  })

  it('rejects an organization that is not the active one', () => {
    authState.activeOrg = managerOrg

    const html = renderToStaticMarkup(<CanManageProbe orgId="org_other" />)

    expect(html).toContain('data-can-manage="false"')
  })

  it('rejects an empty organization id', () => {
    authState.activeOrg = managerOrg

    const html = renderToStaticMarkup(<CanManageProbe orgId="" />)

    expect(html).toContain('data-can-manage="false"')
  })
})
