// PB-1 回归:OrgOverview 的 enabled 必须与服务端 requireOrgManager 同源判角色。
// spa vitest 环境是 node,用最小 useApiQuery 替身记录被测路径和 enabled 门控。

import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { AuthOrg } from '@xid-kit/web-ui/session'

const authState = vi.hoisted((): { activeOrg: AuthOrg | null } => ({ activeOrg: null }))
const apiGet = vi.hoisted(() =>
  vi.fn(() =>
    Promise.resolve({
      ok: true,
      value: {
        dau: 0,
        mau: 0,
        loginSuccessRate: 1,
        mfaAdoptionRate: 0,
        activeMemberCount: 0,
        pendingInvitationCount: 0,
      },
    }),
  ),
)

vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings[0] }),
}))

vi.mock('@xid-kit/web-ui/session', () => ({
  useAuth: () => ({ activeOrg: authState.activeOrg, api: { get: apiGet } }),
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

describe('OrgOverview org stats request gating', () => {
  beforeEach(() => {
    authState.activeOrg = null
    apiGet.mockClear()
  })

  it('does not request org stats for a member role', () => {
    authState.activeOrg = { ...managerOrg, role: 'member' }

    renderOverview()

    expect(apiGet).not.toHaveBeenCalled()
  })

  it('does not request org stats while the active organization is unresolved', () => {
    renderOverview()

    expect(apiGet).not.toHaveBeenCalled()
  })

  it('requests org stats for an owner role', () => {
    authState.activeOrg = managerOrg

    renderOverview()

    expect(apiGet).toHaveBeenCalledWith('/v1/organizations/org_1/stats', expect.anything())
  })

  it('requests org stats for an admin role', () => {
    authState.activeOrg = { ...managerOrg, role: 'admin' }

    renderOverview()

    expect(apiGet).toHaveBeenCalledWith('/v1/organizations/org_1/stats', expect.anything())
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
