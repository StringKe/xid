// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Dropdown } from './Dropdown'
import type { DropdownItem } from './Dropdown'

function items(): DropdownItem[] {
  return [
    { key: 'first', label: 'First action', icon: 'gear', onSelect: vi.fn() },
    { key: 'current', label: 'Current option', checked: true, onSelect: vi.fn() },
    { key: 'docs', label: 'Documentation', href: 'https://xid.dev/docs' },
  ]
}

const roots: Array<ReturnType<typeof createRoot>> = []

async function mount(menuItems: DropdownItem[]): Promise<HTMLButtonElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(
      <Dropdown
        ariaLabel="Example menu"
        trigger={<span>Open menu</span>}
        header="owner@example.com"
        items={menuItems}
      />,
    )
  })
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')
  if (!trigger) throw new Error('trigger was not rendered')
  return trigger
}

async function open(trigger: HTMLButtonElement): Promise<HTMLElement> {
  await act(async () => {
    trigger.click()
  })
  const menu = document.body.querySelector<HTMLElement>('[role="menu"]')
  if (!menu) throw new Error('menu did not open')
  return menu
}

function menuItems(): HTMLElement[] {
  return Array.from(document.body.querySelectorAll<HTMLElement>('[role^="menuitem"]'))
}

describe('Dropdown', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(async () => {
    for (const root of roots.splice(0)) await act(async () => root.unmount())
    document.body.innerHTML = ''
  })

  it('renders a closed menu button with menu aria wiring', async () => {
    const trigger = await mount(items())

    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(trigger.getAttribute('aria-label')).toBe('Example menu')
    expect(document.body.querySelector('[role="menu"]')).toBeNull()
  })

  it('opens on click with the header and the checked item state', async () => {
    const trigger = await mount(items())

    const menu = await open(trigger)

    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(menu.textContent).toContain('owner@example.com')
    expect(menuItems()).toHaveLength(3)
    const checked = menuItems().find((item) => item.getAttribute('role') === 'menuitemcheckbox')
    expect(checked?.getAttribute('aria-checked')).toBe('true')
  })

  it('renders href items as anchors that navigate by document', async () => {
    const trigger = await mount(items())
    await open(trigger)

    const anchor = menuItems().find((element) => element.tagName === 'A')

    expect(anchor?.getAttribute('href')).toBe('https://xid.dev/docs')
  })

  it('runs the selected action', async () => {
    const menu = items()
    const trigger = await mount(menu)
    await open(trigger)

    await act(async () => {
      menuItems()[0]?.click()
    })

    expect(menu[0]?.onSelect).toHaveBeenCalledOnce()
  })
})
