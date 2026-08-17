// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

// 行为测试不需要动效;把 motion 换成直通元素,关闭即同步卸载。
vi.mock('../../motion', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
  motion: {
    ul: ({
      children,
      initial: _initial,
      animate: _animate,
      exit: _exit,
      transition: _transition,
      ...rest
    }: Record<string, unknown> & { children?: ReactNode }) => <ul {...rest}>{children}</ul>,
  },
  popoverMotion: { initial: {}, animate: {}, exit: {}, transition: {} },
}))

import { Dropdown } from './Dropdown'
import type { DropdownItem } from './Dropdown'

const baseItems: DropdownItem[] = [
  { key: 'first', label: 'First action', icon: 'gear', onSelect: vi.fn() },
  { key: 'current', label: 'Current option', checked: true, onSelect: vi.fn() },
  { key: 'docs', label: 'Documentation', href: 'https://xid.dev/docs' },
]

type Harness = {
  container: HTMLDivElement
  root: ReturnType<typeof createRoot>
  trigger: () => HTMLButtonElement
  menu: () => HTMLElement | null
  menuItems: () => HTMLElement[]
}

function mountDropdown(items: DropdownItem[] = baseItems): Harness {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      <Dropdown
        ariaLabel="Example menu"
        trigger={<span>Open menu</span>}
        header="owner@example.com"
        items={items}
      />,
    )
  })
  return {
    container,
    root,
    trigger: () => {
      const element = container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')
      if (!element) throw new Error('trigger was not rendered')
      return element
    },
    menu: () => container.querySelector<HTMLElement>('[role="menu"]'),
    menuItems: () => Array.from(container.querySelectorAll<HTMLElement>('[role^="menuitem"]')),
  }
}

function keydown(element: HTMLElement, key: string): void {
  act(() => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

describe('Dropdown', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('renders a closed menu button with menu aria wiring', () => {
    const harness = mountDropdown()
    const trigger = harness.trigger()

    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(trigger.getAttribute('aria-label')).toBe('Example menu')
    expect(harness.menu()).toBeNull()

    act(() => harness.root.unmount())
    harness.container.remove()
  })

  it('opens on click, focuses the first item, and shows header plus checked state', () => {
    const harness = mountDropdown()

    act(() => {
      harness.trigger().click()
    })

    const menu = harness.menu()
    if (!menu) throw new Error('menu did not open')
    expect(harness.trigger().getAttribute('aria-expanded')).toBe('true')
    expect(menu.textContent).toContain('owner@example.com')
    const items = harness.menuItems()
    expect(items).toHaveLength(3)
    expect(document.activeElement).toBe(items[0])
    expect(items[1]?.getAttribute('role')).toBe('menuitemcheckbox')
    expect(items[1]?.getAttribute('aria-checked')).toBe('true')

    act(() => harness.root.unmount())
    harness.container.remove()
  })

  it('closes on Escape and returns focus to the trigger', () => {
    const harness = mountDropdown()
    act(() => {
      harness.trigger().click()
    })

    keydown(harness.menu() ?? harness.trigger(), 'Escape')

    expect(harness.menu()).toBeNull()
    expect(harness.trigger().getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(harness.trigger())

    act(() => harness.root.unmount())
    harness.container.remove()
  })

  it('closes on pointer down outside and on Tab leaving the menu', () => {
    const harness = mountDropdown()
    act(() => {
      harness.trigger().click()
    })
    act(() => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(harness.menu()).toBeNull()

    act(() => {
      harness.trigger().click()
    })
    keydown(harness.menu() ?? harness.trigger(), 'Tab')
    expect(harness.menu()).toBeNull()

    act(() => harness.root.unmount())
    harness.container.remove()
  })

  it('cycles focus with arrow keys including wrap-around', () => {
    const harness = mountDropdown()
    act(() => {
      harness.trigger().click()
    })
    const items = harness.menuItems()
    const menu = harness.menu()
    if (!menu) throw new Error('menu did not open')

    keydown(menu, 'ArrowDown')
    expect(document.activeElement).toBe(items[1])
    keydown(menu, 'ArrowDown')
    expect(document.activeElement).toBe(items[2])
    keydown(menu, 'ArrowDown')
    expect(document.activeElement).toBe(items[0])
    keydown(menu, 'ArrowUp')
    expect(document.activeElement).toBe(items[2])

    act(() => harness.root.unmount())
    harness.container.remove()
  })

  it('activates the focused item and closes', () => {
    const harness = mountDropdown()
    act(() => {
      harness.trigger().click()
    })
    const menu = harness.menu()
    if (!menu) throw new Error('menu did not open')
    keydown(menu, 'ArrowDown')

    const target = harness.menuItems()[1]
    if (!target) throw new Error('item missing')
    act(() => {
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(baseItems[1]?.onSelect).toHaveBeenCalledOnce()
    expect(harness.menu()).toBeNull()

    act(() => harness.root.unmount())
    harness.container.remove()
  })

  it('renders href items as anchors that navigate by document', () => {
    const harness = mountDropdown()
    act(() => {
      harness.trigger().click()
    })

    const anchor = harness.menuItems().find((element) => element.tagName === 'A') as
      | HTMLAnchorElement
      | undefined
    if (!anchor) throw new Error('anchor item missing')
    expect(anchor.getAttribute('href')).toBe('https://xid.dev/docs')

    act(() => harness.root.unmount())
    harness.container.remove()
  })
})
