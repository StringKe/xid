// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { OrganizationPlanDetail } from '@xid-kit/types'

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

import PlatformPlans from './PlatformPlans'

const detail: OrganizationPlanDetail = {
  tenantId: 'org_1',
  organizationName: 'Acme',
  plan: 'starter',
  status: 'trialing',
  source: 'manual',
  supportLabel: 'standard',
  trialEndsAt: '2026-08-01T00:00:00.000Z',
  effectiveAt: '2026-07-28T00:00:00.000Z',
  seatLimit: 50,
  quotas: [
    { key: 'seats', limit: 50, enforcement: 'block_creation' },
    { key: 'api_calls', limit: 1_000_000, enforcement: 'observe' },
  ],
}

describe('PlatformPlans', () => {
  beforeEach(() => {
    searchParams.value = 'tenantId=org_1'
    mocks.mutate.mockReset()
    mocks.useApiQuery.mockReset()
    mocks.useApiMutation.mockReset()
    mocks.useApiQuery.mockReturnValue({
      data: detail,
      error: null,
      isError: false,
      isLoading: false,
    })
    mocks.useApiMutation.mockReturnValue({
      error: null,
      isError: false,
      isPending: false,
      isSuccess: false,
      mutate: mocks.mutate,
    })
  })

  it('loads the selected tenant and persists plan plus all quota controls', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(<PlatformPlans />)
    })

    expect(mocks.useApiQuery).toHaveBeenCalledWith(
      ['platform', 'plans', 'org_1'],
      '/v1/platform/plans/org_1',
      { enabled: true },
    )
    expect(container.textContent).toContain('Plans and quotas')
    expect(container.textContent).toContain('org_1')
    expect(container.textContent).toContain('api_calls')
    expect([...container.querySelectorAll('code')].map((node) => node.textContent)).not.toContain(
      'seats',
    )
    const quotaRows = [...container.querySelectorAll('code')].map((node) => ({
      key: node.textContent,
      row: node.parentElement,
    }))
    const apiOptions = [
      ...(quotaRows.find((entry) => entry.key === 'api_calls')?.row?.querySelectorAll('option') ??
        []),
    ].map((option) => option.getAttribute('value'))
    expect(apiOptions).toEqual(['observe'])
    const organizationOptions = [
      ...(quotaRows
        .find((entry) => entry.key === 'organizations')
        ?.row?.querySelectorAll('option') ?? []),
    ].map((option) => option.getAttribute('value'))
    expect(organizationOptions).toEqual(['observe', 'block_creation'])
    expect(container.querySelector<HTMLInputElement>('input[placeholder="Unlimited"]')?.value).toBe(
      '50',
    )

    await act(async () => {
      root.unmount()
    })
  })

  it('submits only the quota that changed so the billing source is preserved', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => {
      root.render(<PlatformPlans />)
    })
    const emailsLimit = [...container.querySelectorAll('code')]
      .find((node) => node.textContent === 'emails')
      ?.parentElement?.querySelector<HTMLInputElement>('input')

    await act(async () => {
      container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true }))
    })
    expect(mocks.mutate).not.toHaveBeenCalled()

    await act(async () => {
      if (!emailsLimit) return
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setValue?.call(emailsLimit, '5000')
      emailsLimit.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true }))
    })

    expect(mocks.mutate).toHaveBeenCalledWith({
      tenantId: 'org_1',
      body: { quotas: [{ key: 'emails', limit: 5000, enforcement: 'observe' }] },
    })

    await act(async () => {
      root.unmount()
    })
  })

  it('explains a canceled Stripe Checkout return', async () => {
    searchParams.value = 'tenantId=org_1&checkout=canceled'
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(<PlatformPlans />)
    })

    expect(container.textContent).toContain('Stripe Checkout was canceled')

    await act(async () => {
      root.unmount()
    })
  })
})
