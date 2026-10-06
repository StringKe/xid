// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { ConfirmDialog } from './ConfirmDialog'

vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings[0] }),
}))

const actEnvironment = globalThis as Record<string, unknown>
actEnvironment['IS_REACT_ACT_ENVIRONMENT'] = true

const roots: Array<ReturnType<typeof createRoot>> = []

async function render(props: {
  onConfirm: () => void
  onCancel: () => void
  isLoading?: boolean
}): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(
      <ConfirmDialog title="Delete item?" description="This cannot be undone." {...props} />,
    )
  })
}

function buttonByText(label: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll('button')).find(
    (button) => button.textContent === label,
  )
}

async function waitFor(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 2000
  for (;;) {
    try {
      assertion()
      return
    } catch (error) {
      if (Date.now() > deadline) throw error
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
      })
    }
  }
}

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  document.body.innerHTML = ''
})

describe('ConfirmDialog', () => {
  it('opens as a labelled modal dialog on mount', async () => {
    await render({ onConfirm: vi.fn(), onCancel: vi.fn() })

    const dialog = document.body.querySelector('[role="dialog"]')

    expect(dialog).not.toBeNull()
    expect(dialog?.getAttribute('aria-labelledby')).toBeTruthy()
    expect(
      document.getElementById(dialog?.getAttribute('aria-labelledby') ?? '')?.textContent,
    ).toBe('Delete item?')
  })

  it('notifies the parent only after the dialog has closed when Cancel is clicked', async () => {
    const onCancel = vi.fn()
    await render({ onConfirm: vi.fn(), onCancel })

    await act(async () => {
      buttonByText('Cancel')?.click()
    })

    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1))
  })

  it('keeps the dialog open and ignores Cancel while the confirmation is running', async () => {
    const onCancel = vi.fn()
    await render({ onConfirm: vi.fn(), onCancel, isLoading: true })

    await act(async () => {
      buttonByText('Cancel')?.click()
    })

    expect(onCancel).not.toHaveBeenCalled()
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
  })

  it('calls onConfirm from the confirm button', async () => {
    const onConfirm = vi.fn()
    await render({ onConfirm, onCancel: vi.fn() })

    await act(async () => {
      buttonByText('Confirm')?.click()
    })

    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})
