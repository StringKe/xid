// @vitest-environment jsdom
// 取消须等 exit 动画完成再 onCancel;jsdom 缺 showModal/close 时补 stub。

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

const dialogProto = HTMLDialogElement.prototype as unknown as Record<string, unknown>
dialogProto['showModal'] ??= function showModal(this: HTMLDialogElement): void {
  this.open = true
}
dialogProto['close'] ??= function close(this: HTMLDialogElement): void {
  this.open = false
}

const containers: HTMLElement[] = []

async function render(props: {
  onConfirm: () => void
  onCancel: () => void
}): Promise<{ container: HTMLElement; root: ReturnType<typeof createRoot> }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  containers.push(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <ConfirmDialog title="Delete item?" description="This cannot be undone." {...props} />,
    )
  })
  return { container, root }
}

afterEach(() => {
  for (const container of containers.splice(0)) container.remove()
})

// 轮询等 exit,避免定长 sleep 在慢环境 flaky。
async function waitFor(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 2000
  for (;;) {
    try {
      assertion()
      return
    } catch (error) {
      if (Date.now() > deadline) throw error
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50))
      })
    }
  }
}

describe('ConfirmDialog motion contract', () => {
  it('renders as a motion-driven dialog starting from the enter pose', async () => {
    const { container } = await render({ onConfirm: vi.fn(), onCancel: vi.fn() })
    const dialog = container.querySelector('dialog')

    expect(dialog).not.toBeNull()
    expect(dialog.style.opacity).toBeDefined()
    expect(dialog.style.transform).toContain('scale')
  })

  it('defers onCancel until the exit animation completes when Cancel is clicked', async () => {
    const onCancel = vi.fn()
    const { container } = await render({ onConfirm: vi.fn(), onCancel })
    const dialog = container.querySelector('dialog')
    const cancelButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Cancel',
    )
    expect(cancelButton).toBeDefined()

    await act(async () => {
      cancelButton.click()
      // 须在 act 内 click 紧后断言:act 退出会 flush 动画帧,慢机上 exit 一帧跳完。
      expect(onCancel).not.toHaveBeenCalled()
      expect(dialog.open).toBe(true)
    })

    await waitFor(() => {
      expect(onCancel).toHaveBeenCalledTimes(1)
      expect(dialog.open).toBe(false)
    })
  })

  it('plays the same deferred exit on Escape (cancel event)', async () => {
    const onCancel = vi.fn()
    const { container } = await render({ onConfirm: vi.fn(), onCancel })
    const dialog = container.querySelector('dialog')

    await act(async () => {
      dialog.dispatchEvent(new Event('cancel', { cancelable: true }))
      expect(onCancel).not.toHaveBeenCalled()
      expect(dialog.open).toBe(true)
    })

    await waitFor(() => {
      expect(onCancel).toHaveBeenCalledTimes(1)
      expect(dialog.open).toBe(false)
    })
  })
})
