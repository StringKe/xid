// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { Dialog } from './Dialog'

vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings[0] }),
}))

const roots: Array<ReturnType<typeof createRoot>> = []

async function mount(props: { dismissible: boolean; onOpenChange: (open: boolean) => void }) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(<Dialog open title="Rotate key" {...props} />)
  })
}

async function pressEscape(): Promise<void> {
  const target = document.activeElement ?? document.body
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
}

describe('Dialog', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(async () => {
    for (const root of roots.splice(0)) await act(async () => root.unmount())
    document.body.innerHTML = ''
  })

  it('requests close on Escape when dismissible', async () => {
    const onOpenChange = vi.fn()
    await mount({ dismissible: true, onOpenChange })

    await pressEscape()

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('ignores Escape and hides the close button when not dismissible', async () => {
    const onOpenChange = vi.fn()
    await mount({ dismissible: false, onOpenChange })

    await pressEscape()

    expect(onOpenChange).not.toHaveBeenCalled()
    expect(document.body.querySelector('button[aria-label="Close"]')).toBeNull()
  })
})
