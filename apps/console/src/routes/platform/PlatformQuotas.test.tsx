// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { BillingConfig, OrganizationQuotaDetail } from '@xid-kit/types'

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  useApiMutation: vi.fn(),
  useApiQuery: vi.fn(),
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

vi.mock('@xid-kit/web-ui/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xid-kit/web-ui/queries')>()
  return {
    ...actual,
    useApiMutation: mocks.useApiMutation,
    useApiQuery: mocks.useApiQuery,
  }
})

const searchParams = vi.hoisted(() => ({ value: 'tenantId=org_1' }))

vi.mock('@xid-kit/web-ui/tanstack-router', () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
  useSearchParams: () => [new URLSearchParams(searchParams.value)],
}))

import PlatformQuotas from './PlatformQuotas'

const detail: OrganizationQuotaDetail = {
  tenantId: 'org_1',
  name: 'Acme',
  quotas: [
    { key: 'seats', limit: 50, enforcement: 'observe' },
    { key: 'organizations', limit: 5, enforcement: 'block_creation' },
  ],
}

function queryResult(data: unknown) {
  return { data, error: null, isError: false, isLoading: false }
}

function mockQueries(billing: BillingConfig): void {
  mocks.useApiQuery.mockImplementation((_key: unknown, path: string) =>
    queryResult(path === '/v1/platform/billing/config' ? billing : detail),
  )
}

const BILLING_OFF: BillingConfig = { enabled: false, portal: false, metering: false }

function quotaOptions(container: HTMLElement, key: string): (string | null)[] {
  const row = [...container.querySelectorAll('code')].find((node) => node.textContent === key)
  return [...(row?.parentElement?.querySelectorAll('option') ?? [])].map((option) =>
    option.getAttribute('value'),
  )
}

describe('PlatformQuotas', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    searchParams.value = 'tenantId=org_1'
    mocks.mutate.mockReset()
    mocks.useApiQuery.mockReset()
    mocks.useApiMutation.mockReset()
    mockQueries(BILLING_OFF)
    mocks.useApiMutation.mockReturnValue({
      error: null,
      isError: false,
      isPending: false,
      isSuccess: false,
      mutate: mocks.mutate,
    })
    container = document.createElement('div')
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
  })

  it('loads the tenant quotas and offers block_creation only for organizations and SSO connections', async () => {
    await act(async () => {
      root.render(<PlatformQuotas />)
    })

    expect(mocks.useApiQuery).toHaveBeenCalledWith(
      ['platform', 'quotas', 'org_1'],
      '/v1/platform/quotas/org_1',
      { enabled: true },
    )
    expect(container.textContent).toContain('Resource quotas')
    expect(container.textContent).toContain('Acme')
    expect([...container.querySelectorAll('code')].map((node) => node.textContent)).toEqual([
      'seats',
      'organizations',
      'sso_connections',
      'mau',
    ])
    expect(quotaOptions(container, 'seats')).toEqual(['observe'])
    expect(quotaOptions(container, 'mau')).toEqual(['observe'])
    expect(quotaOptions(container, 'organizations')).toEqual(['observe', 'block_creation'])
    expect(quotaOptions(container, 'sso_connections')).toEqual(['observe', 'block_creation'])
  })

  it('shows no plan, trial, checkout or billing controls while billing is off', async () => {
    await act(async () => {
      root.render(<PlatformQuotas />)
    })

    const text = container.textContent ?? ''
    expect(text).not.toMatch(/plan|trial|checkout|support label|billing/i)
    expect(text).not.toContain('Customer Portal')
  })

  it('submits only the quota that changed', async () => {
    await act(async () => {
      root.render(<PlatformQuotas />)
    })
    const ssoLimit = [...container.querySelectorAll('code')]
      .find((node) => node.textContent === 'sso_connections')
      ?.parentElement?.querySelector<HTMLInputElement>('input')

    await act(async () => {
      container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true }))
    })
    expect(mocks.mutate).not.toHaveBeenCalled()

    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setValue?.call(ssoLimit, '3')
      ssoLimit?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true }))
    })

    expect(mocks.mutate).toHaveBeenCalledWith({
      tenantId: 'org_1',
      body: { quotas: [{ key: 'sso_connections', limit: 3, enforcement: 'observe' }] },
    })
  })

  it('offers only the Customer Portal when usage billing is enabled', async () => {
    mockQueries({ enabled: true, portal: true, metering: true })

    await act(async () => {
      root.render(<PlatformQuotas />)
    })

    expect(mocks.useApiQuery).toHaveBeenCalledWith(
      ['platform', 'billing-config', { tenantId: 'org_1' }],
      '/v1/platform/billing/config',
      { query: { tenantId: 'org_1' } },
    )
    expect(container.textContent).toContain('Usage is billed by metered MAU')
    expect([...container.querySelectorAll('button')].map((node) => node.textContent)).toEqual([
      'Open Customer Portal',
      'Save changes',
    ])
  })
})
