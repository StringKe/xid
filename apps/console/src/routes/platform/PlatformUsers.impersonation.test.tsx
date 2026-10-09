// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { DataTableColumnDef as ColumnDef } from '@xid-kit/web-ui/ui/DataTable'
import type { PlatformUserListItem } from './orgs-users-queries'
import PlatformUsers from './PlatformUsers'

const amara: PlatformUserListItem = {
  id: 'user_amara',
  email: 'amara@northwind.test',
  name: 'Amara Kofi',
  organizations: [{ id: 'org_northwind', slug: 'northwind', name: 'Northwind Logistics' }],
  status: 'active',
  createdAt: '2026-07-28T00:00:00.000Z',
  lastSignInAt: '2026-10-09T00:00:00.000Z',
  tenantId: 'org_northwind',
  organizationName: 'Northwind Logistics',
  organizationStatus: 'active',
}

const mocks = vi.hoisted(() => ({
  apiPost: vi.fn(),
  navigate: vi.fn(),
  searchParams: '',
  submitHandoff: vi.fn(),
  usePlatformUsersPage: vi.fn(),
}))

function usersPage(rows: PlatformUserListItem[]) {
  return {
    data: { data: rows, nextCursor: null, total: rows.length },
    isLoading: false,
    isError: false,
    isFetching: false,
    error: null,
    refetch: vi.fn(),
  }
}

function interpolate(strings: TemplateStringsArray | string, ...values: unknown[]): string {
  if (typeof strings === 'string') return strings
  return strings.reduce(
    (message, part, index) => `${message}${String(values[index - 1] ?? '')}${part}`,
  )
}

vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  Plural: ({ value, other }: { value: number; other: string }) => (
    <>{other.replace('#', String(value))}</>
  ),
  useLingui: () => ({
    t: interpolate,
    i18n: {
      _: (descriptor: { message: string }) => descriptor.message,
      number: (value: number) => String(value),
      date: (value: Date) => value.toISOString().slice(0, 10),
      locale: 'en',
    },
  }),
}))

vi.mock('@lingui/core/macro', () => ({
  msg: (strings: TemplateStringsArray) => ({ id: strings.join(''), message: strings.join('') }),
}))

vi.mock('@xid-kit/web-ui/session', () => ({
  useAuth: () => ({ api: { post: mocks.apiPost } }),
}))

vi.mock('@xid-kit/web-ui/tanstack-router', () => ({
  useSearchParams: () => [new URLSearchParams(mocks.searchParams)],
  useLocation: () => ({ pathname: '/console/platform/users', search: '' }),
  useNavigate: () => mocks.navigate,
}))

vi.mock('../../lib/impersonation-handoff', () => ({
  submitImpersonationHandoff: mocks.submitHandoff,
}))

vi.mock('./orgs-users-queries', () => ({
  usePlatformUsersPage: mocks.usePlatformUsersPage,
  usePlatformOrganizationDetail: () => ({ data: undefined }),
}))

vi.mock('./queries', () => ({
  usePlatformOrganizationsList: () => ({ data: { data: [] } }),
}))

vi.mock('@xid-kit/web-ui/ConfirmDialog', () => ({
  ConfirmDialog: ({
    title,
    description,
    children,
    error,
    confirmLabel,
    isLoading,
    onConfirm,
    onCancel,
  }: {
    title: ReactNode
    description: ReactNode
    children?: ReactNode
    error?: ReactNode
    confirmLabel: ReactNode
    isLoading?: boolean
    onConfirm: () => void
    onCancel: () => void
  }) => (
    <div role="dialog">
      <h2>{title}</h2>
      <p>{description}</p>
      {children}
      {error ? <div>{error}</div> : null}
      <button type="button" disabled={isLoading} onClick={onCancel}>
        Cancel
      </button>
      <button type="button" disabled={isLoading} onClick={onConfirm}>
        {confirmLabel}
      </button>
    </div>
  ),
}))

vi.mock('@xid-kit/web-ui/ui/DataTable', () => ({
  DataTable: ({
    columns,
    data,
  }: {
    columns: ColumnDef<PlatformUserListItem>[]
    data: PlatformUserListItem[]
  }) => {
    const menuCell = columns.find((column) => column.id === 'menu')?.cell
    if (typeof menuCell !== 'function') return null
    return (
      <div>
        {data.map((user) => (
          <div key={user.id}>{menuCell({ row: { original: user } } as never)}</div>
        ))}
      </div>
    )
  },
}))

vi.mock('@xid-kit/web-ui/ui', () => ({
  Alert: ({ children }: { children: ReactNode }) => <div role="alert">{children}</div>,
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Button: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  Dropdown: ({ items }: { items: { key: string; label: ReactNode; onSelect?: () => void }[] }) => (
    <div>
      {items.map((item) => (
        <button key={item.key} type="button" onClick={item.onSelect}>
          {item.label}
        </button>
      ))}
    </div>
  ),
  Field: ({
    label,
    children,
    error,
  }: {
    label?: ReactNode
    children: ReactNode
    error?: ReactNode
  }) => (
    <div>
      {label}
      {children}
      {error ? <span role="alert">{error}</span> : null}
    </div>
  ),
  Icon: () => null,
  IdentityCell: ({ name }: { name: ReactNode }) => <span>{name}</span>,
  Select: (props: React.SelectHTMLAttributes<HTMLSelectElement>) => <select {...props} />,
  useToast: () => ({ notify: vi.fn() }),
}))

async function render(): Promise<{ container: HTMLDivElement; unmount: () => Promise<void> }> {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(<PlatformUsers />))
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount())
      container.remove()
    },
  }
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent === label,
  )
  if (!found) throw new Error(`Button "${label}" was not rendered`)
  return found
}

describe('PlatformUsers impersonation', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    mocks.searchParams = ''
    mocks.usePlatformUsersPage.mockReturnValue(usersPage([amara]))
    mocks.submitHandoff.mockReturnValue(true)
  })

  it('browses users without a search query', async () => {
    const view = await render()

    expect(mocks.usePlatformUsersPage).toHaveBeenLastCalledWith(
      { q: '', organizationId: null, status: null },
      null,
    )

    await view.unmount()
  })

  it('states the read-only 15-minute scope and starts with the only organization', async () => {
    const handoff = {
      action: 'https://northwind.xid.dev/auth/impersonation/handoff',
      method: 'POST',
      fields: { grantId: 'opaque_grant_id_1234567890', secret: 'opaque_secret_1234567890' },
    }
    mocks.apiPost.mockResolvedValue({
      ok: true,
      value: { handoff, expiresAt: '2026-10-09T00:02:00.000Z' },
    })
    const view = await render()

    await act(async () => button(view.container, 'Impersonate Amara Kofi…').click())

    expect(view.container.textContent).toContain('Read-only.')
    expect(view.container.textContent).toContain('15 minutes, then it ends on its own.')
    expect(view.container.querySelector('select')).toBeNull()
    await act(async () => button(view.container, 'Start impersonation').click())
    expect(mocks.apiPost).toHaveBeenCalledWith('/v1/platform/impersonation/start', {
      userId: amara.id,
      organizationId: 'org_northwind',
    })
    expect(mocks.submitHandoff).toHaveBeenCalledWith(handoff)

    await view.unmount()
  })

  it('requires choosing the organization when the user belongs to several', async () => {
    mocks.usePlatformUsersPage.mockReturnValue(
      usersPage([
        {
          ...amara,
          organizations: [
            ...amara.organizations,
            { id: 'org_field', slug: 'field', name: 'Field crews' },
          ],
        },
      ]),
    )
    mocks.apiPost.mockResolvedValue({
      ok: false,
      error: { code: 'server_error', message: '', httpStatus: 500 },
    })
    const view = await render()
    await act(async () => button(view.container, 'Impersonate Amara Kofi…').click())

    await act(async () => button(view.container, 'Start impersonation').click())
    expect(mocks.apiPost).not.toHaveBeenCalled()
    expect(view.container.textContent).toContain('Select the organization to open')

    const select = view.container.querySelector('select')
    if (!select) throw new Error('Organization select was not rendered')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(
        select,
        'org_field',
      )
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => button(view.container, 'Start impersonation').click())

    expect(mocks.apiPost).toHaveBeenCalledWith('/v1/platform/impersonation/start', {
      userId: amara.id,
      organizationId: 'org_field',
    })
    expect(view.container.textContent).toContain('could not be started')
    expect(mocks.submitHandoff).not.toHaveBeenCalled()

    await view.unmount()
  })

  it('does not offer impersonation for a suspended organization or a user without memberships', async () => {
    mocks.usePlatformUsersPage.mockReturnValue(
      usersPage([
        { ...amara, id: 'user_suspended_org', organizationStatus: 'suspended' },
        { ...amara, id: 'user_no_membership', name: 'Lena Muller', organizations: [] },
      ]),
    )
    const view = await render()

    expect(view.container.textContent).not.toContain('Impersonate')
    expect(view.container.textContent).toContain('Copy user ID')

    await view.unmount()
  })

  it('opens the organization detail from the row menu', async () => {
    const view = await render()

    await act(async () => button(view.container, 'View Northwind Logistics details').click())

    expect(mocks.navigate).toHaveBeenCalledWith(
      '/console/platform/organizations?organizationId=org_northwind',
    )

    await view.unmount()
  })

  it('explains an expired impersonation handoff returned from the target host', async () => {
    mocks.searchParams = 'impersonation=failed'
    const view = await render()

    expect(view.container.textContent).toContain('impersonation link expired or was already used')

    await view.unmount()
  })
})
