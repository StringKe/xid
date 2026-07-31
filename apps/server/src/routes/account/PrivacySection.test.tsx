// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

const state = vi.hoisted(() => ({
  create: vi.fn(),
  cancel: vi.fn(),
}))

vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings[0] }),
}))

vi.mock('./queries', () => ({
  usePrivacyRequestsQuery: () => ({
    data: [],
    isPending: false,
    error: null,
  }),
  useCreatePrivacyRequest: () => ({
    mutateAsync: state.create,
    isPending: false,
    variables: undefined,
  }),
  useCancelPrivacyRequest: () => ({
    mutateAsync: state.cancel,
    isPending: false,
  }),
}))

vi.mock('./ConfirmDialog', () => ({
  ConfirmDialog: ({
    title,
    description,
    confirmLabel,
    onConfirm,
    onCancel,
  }: {
    title: ReactNode
    description: ReactNode
    confirmLabel: ReactNode
    onConfirm: () => void
    onCancel: () => void
  }) => (
    <div role="dialog">
      <h2>{title}</h2>
      <p>{description}</p>
      <button type="button" onClick={onCancel}>
        Cancel dialog
      </button>
      <button type="button" data-testid="confirm-delete" onClick={onConfirm}>
        {confirmLabel}
      </button>
    </div>
  ),
}))

import { PrivacySection } from './PrivacySection'

describe('PrivacySection', () => {
  beforeEach(() => {
    state.create.mockReset()
    state.create.mockResolvedValue({})
    state.cancel.mockReset()
    state.cancel.mockResolvedValue({})
    ;(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true
  })

  it('requires the second confirmation before sending the exact deletion contract', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(<PrivacySection />)
    })

    const schedule = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Schedule deletion',
    )
    expect(schedule).toBeDefined()

    await act(async () => {
      schedule?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(state.create).not.toHaveBeenCalled()
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()

    await act(async () => {
      container
        .querySelector('[data-testid="confirm-delete"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(state.create).toHaveBeenCalledOnce()
    expect(state.create).toHaveBeenCalledWith({
      type: 'delete',
      confirmation: 'DELETE',
    })

    await act(async () => {
      root.unmount()
    })
    container.remove()
  })
})
