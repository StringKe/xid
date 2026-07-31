// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import type { GlobalUser } from './types'
import PlatformUsers from './PlatformUsers'

const globalUser: GlobalUser = {
  id: 'user_target',
  email: 'target@example.com',
  name: 'Target User',
  organizations: [
    { id: 'org_target', slug: 'target', name: 'Target Organization' },
    { id: 'org_child', slug: 'child', name: 'Child Organization' },
  ],
  status: 'active',
  createdAt: '2026-07-28T00:00:00.000Z',
}

const mocks = vi.hoisted(() => ({
  apiPost: vi.fn(),
  submitHandoff: vi.fn(),
  useGlobalUsersQuery: vi.fn(),
}))

vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce(
        (message, part, index) => `${message}${String(values[index - 1] ?? '')}${part}`,
      ),
  }),
}))

vi.mock('@xid-kit/web-ui/session', () => ({
  useAuth: () => ({ api: { post: mocks.apiPost } }),
}))

vi.mock('../../lib/impersonation-handoff', () => ({
  submitImpersonationHandoff: mocks.submitHandoff,
}))

vi.mock('./queries', () => ({
  useGlobalUsersQuery: mocks.useGlobalUsersQuery,
}))

vi.mock('@xid-kit/web-ui/ConfirmDialog', () => ({
  ConfirmDialog: ({
    title,
    description,
    confirmLabel,
    isLoading,
    onConfirm,
    onCancel,
  }: {
    title: ReactNode
    description: ReactNode
    confirmLabel: ReactNode
    isLoading?: boolean
    onConfirm: () => void
    onCancel: () => void
  }) => (
    <div role="dialog">
      <h2>{title}</h2>
      <p>{description}</p>
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
  DataTable: ({ columns, data }: { columns: ColumnDef<GlobalUser>[]; data: GlobalUser[] }) => {
    const actionCell = columns.find((column) => column.id === 'actions')?.cell
    if (typeof actionCell !== 'function') return null
    return (
      <div>
        {data.map((user) => (
          <div key={user.id}>{actionCell({ row: { original: user } } as never)}</div>
        ))}
      </div>
    )
  },
}))

vi.mock('@xid-kit/web-ui/ui/Pagination', () => ({
  Pagination: ({
    nextCursor,
    onLoadMore,
  }: {
    nextCursor: string | null
    onLoadMore: (cursor: string) => void
  }) =>
    nextCursor ? (
      <button type="button" onClick={() => onLoadMore(nextCursor)}>
        Load more
      </button>
    ) : null,
}))

vi.mock('@xid-kit/web-ui/ui', () => ({
  Alert: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Button: ({
    children,
    isLoading,
    onClick,
    type,
  }: {
    children: ReactNode
    isLoading?: boolean
    onClick?: () => void
    type?: 'button' | 'submit'
  }) => (
    <button type={type ?? 'button'} disabled={isLoading} onClick={onClick}>
      {children}
    </button>
  ),
  EmptyState: ({ title }: { title: ReactNode }) => <div>{title}</div>,
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}))

async function renderSearchedUsers(): Promise<{
  container: HTMLDivElement
  root: ReturnType<typeof createRoot>
}> {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(<PlatformUsers />))

  const input = container.querySelector<HTMLInputElement>('input[type="search"]')
  if (!input) throw new Error('Search input was not rendered')
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    valueSetter?.call(input, 'target')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  const search = Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent === 'Search',
  )
  if (!search) throw new Error('Search button was not rendered')
  await act(async () => search.click())
  return { container, root }
}

async function selectOrganization(
  container: HTMLDivElement,
  organizationId: string,
): Promise<void> {
  const select = container.querySelector<HTMLSelectElement>('#impersonation-organization')
  if (!select) throw new Error('Organization select was not rendered')
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
    valueSetter?.call(select, organizationId)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('PlatformUsers impersonation action', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    mocks.useGlobalUsersQuery.mockReturnValue({
      data: { data: [globalUser], nextCursor: null, total: 1 },
      isLoading: false,
      isError: false,
    })
    mocks.submitHandoff.mockReturnValue(true)
  })

  it('confirms the read-only 15-minute scope and posts an opaque handoff', async () => {
    const handoff = {
      action: 'https://target.xid.dev/auth/impersonation/handoff',
      method: 'POST',
      fields: { grantId: 'opaque_grant_id_1234567890', secret: 'opaque_secret_1234567890' },
    }
    mocks.apiPost.mockResolvedValue({
      ok: true,
      value: { handoff, expiresAt: '2026-07-28T00:02:00.000Z' },
    })
    const { container, root } = await renderSearchedUsers()

    const impersonate = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Impersonate',
    )
    if (!impersonate) throw new Error('Impersonate button was not rendered')
    await act(async () => impersonate.click())

    expect(container.textContent).toContain('15-minute read-only session')
    expect(container.textContent).toContain('management changes are blocked')
    const confirm = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Open read-only session',
    )
    if (!confirm) throw new Error('Confirm button was not rendered')
    await act(async () => confirm.click())
    expect(mocks.apiPost).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Select organization')

    await selectOrganization(container, 'org_child')
    await act(async () => confirm.click())

    expect(mocks.apiPost).toHaveBeenCalledWith('/v1/platform/impersonation/start', {
      userId: globalUser.id,
      organizationId: 'org_child',
    })
    expect(mocks.submitHandoff).toHaveBeenCalledWith(handoff)

    await act(async () => root.unmount())
    container.remove()
  })

  it('keeps the dialog retryable and shows a localized mutation error', async () => {
    mocks.apiPost.mockResolvedValue({
      ok: false,
      error: { code: 'server_error', message: '', httpStatus: 500 },
    })
    const { container, root } = await renderSearchedUsers()
    const impersonate = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Impersonate',
    )
    if (!impersonate) throw new Error('Impersonate button was not rendered')
    await act(async () => impersonate.click())
    const confirm = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Open read-only session',
    )
    if (!confirm) throw new Error('Confirm button was not rendered')
    await selectOrganization(container, 'org_target')
    await act(async () => confirm.click())

    expect(container.textContent).toContain('could not be started')
    expect(mocks.submitHandoff).not.toHaveBeenCalled()

    await act(async () => root.unmount())
    container.remove()
  })

  it('does not offer impersonation without an active membership organization', async () => {
    mocks.useGlobalUsersQuery.mockReturnValue({
      data: {
        data: [{ ...globalUser, organizations: [] }],
        nextCursor: null,
        total: 1,
      },
      isLoading: false,
      isError: false,
    })
    const { container, root } = await renderSearchedUsers()

    expect(container.textContent).not.toContain('Impersonate')

    await act(async () => root.unmount())
    container.remove()
  })

  it('follows the next cursor for the submitted global user search', async () => {
    mocks.useGlobalUsersQuery.mockReturnValue({
      data: { data: [globalUser], nextCursor: 'user_cursor_2', total: 21 },
      isLoading: false,
      isError: false,
    })
    const { container, root } = await renderSearchedUsers()

    expect(mocks.useGlobalUsersQuery).toHaveBeenCalledWith('target', undefined)
    const loadMore = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Load more',
    )
    if (!loadMore) throw new Error('Load more button was not rendered')
    await act(async () => loadMore.click())

    expect(mocks.useGlobalUsersQuery).toHaveBeenCalledWith('target', 'user_cursor_2')

    await act(async () => root.unmount())
    container.remove()
  })
})
