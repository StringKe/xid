// @vitest-environment jsdom
// ConfirmDialog 进出场契约:
//   - dialog 由 motion 驱动(行内 opacity/transform 存在,初始为 exit 姿态 opacity 0 / scale 0.96)。
//   - 取消(按钮 / Escape)不立即回调 onCancel:先播 exit,onAnimationComplete 后才 close + onCancel。
// jsdom 未实现 HTMLDialogElement.showModal/close 时补最小 stub(open 属性翻转)。

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

// springSnappy 0.3s + 调度余量;轮询而非定长 sleep,避免环境慢导致 flaky。
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
      // 断言必须留在 act 内、click 紧后:click 是同步派发,React 合成事件同步跑完 onClick,
      // 所以"onCancel 被同步调用"这个真实回归在这里就可见。
      // 放到 act 之后则不行 -- act 退出时会 flush 完整动画帧,机器有负载时 motion 按墙钟 delta
      // 一帧跳完 exit,断言就变成了对机器速度的赌博(实测干净 HEAD 上 5 跑 2 挂)。
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
      // 同上:在 act 内断言,避免把"exit 动画未完成"变成对墙钟时间的假设。
      expect(onCancel).not.toHaveBeenCalled()
      expect(dialog.open).toBe(true)
    })

    await waitFor(() => {
      expect(onCancel).toHaveBeenCalledTimes(1)
      expect(dialog.open).toBe(false)
    })
  })
})
