// @vitest-environment jsdom
// 面板 opacity 由 motion 驱动(StyleX 不得再带 transition);药丸 layoutId 唯一共享。

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { SignInPanel, SignInTabs } from './SignInTabs'
import { styles } from './styles'
import type { SignInMethod } from './shared'

vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings[0] }),
}))

const actEnvironment = globalThis as Record<string, unknown>
actEnvironment['IS_REACT_ACT_ENVIRONMENT'] = true

const containers: HTMLElement[] = []

async function render(
  node: ReactNode,
): Promise<{ container: HTMLElement; root: ReturnType<typeof createRoot> }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  containers.push(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(node)
  })
  return { container, root }
}

afterEach(() => {
  for (const container of containers.splice(0)) container.remove()
})

function cssRulesFor(classNames: readonly string[]): CSSStyleRule[] {
  return Array.from(document.styleSheets)
    .flatMap((sheet) => Array.from(sheet.cssRules))
    .filter((rule): rule is CSSStyleRule => 'selectorText' in rule)
    .filter((rule) => classNames.some((className) => rule.selectorText.includes(`.${className}`)))
}

describe('SignInPanel motion contract', () => {
  it('panel styles carry no CSS transition: opacity is driven by motion', () => {
    const panelClassNames = stylex
      .props(styles.panel, styles.panelActive, styles.panelInactive)
      .className.split(' ')
    const rules = cssRulesFor(panelClassNames)

    expect(rules.length).toBeGreaterThan(0)
    for (const rule of rules) {
      expect(rule.cssText).not.toContain('transition')
      expect(rule.cssText).not.toContain('opacity')
    }
  })

  it('renders panels as motion elements with inline opacity and keeps inert structure', async () => {
    const { container } = await render(
      <>
        <SignInPanel active={true}>
          <span>active panel</span>
        </SignInPanel>
        <SignInPanel active={false}>
          <span>inactive panel</span>
        </SignInPanel>
      </>,
    )
    const panels = container.querySelectorAll('div')

    expect(panels).toHaveLength(2)
    expect(panels[0].style.opacity).toBe('1')
    expect(panels[1].style.opacity).toBe('0')
    expect(panels[0].hasAttribute('inert')).toBe(false)
    expect(panels[1].hasAttribute('inert')).toBe(true)
    expect(panels[1].getAttribute('aria-hidden')).toBe('true')
  })
})

describe('SignInTabs pill contract', () => {
  const enabledMethods: readonly SignInMethod[] = ['password', 'magic-link']

  function pillClassName(): string {
    return stylex.props(styles.tabPill).className.split(' ')[0]
  }

  it('renders exactly one shared pill inside the active tab', async () => {
    const { container } = await render(
      <SignInTabs
        method="password"
        passkeySupport="no"
        enabledMethods={enabledMethods}
        isSignUpFlow={false}
        onSelect={vi.fn()}
      />,
    )
    const pills = container.querySelectorAll(`.${pillClassName()}`)

    expect(pills).toHaveLength(1)
    const hostTab = pills[0].closest('button')
    expect(hostTab?.getAttribute('aria-selected')).toBe('true')
    expect(hostTab?.textContent).toBe('Password')
  })

  it('moves the shared pill to the newly active tab on switch', async () => {
    const { container, root } = await render(
      <SignInTabs
        method="password"
        passkeySupport="no"
        enabledMethods={enabledMethods}
        isSignUpFlow={false}
        onSelect={vi.fn()}
      />,
    )

    await act(async () => {
      root.render(
        <SignInTabs
          method="magic-link"
          passkeySupport="no"
          enabledMethods={enabledMethods}
          isSignUpFlow={false}
          onSelect={vi.fn()}
        />,
      )
    })

    const pills = container.querySelectorAll(`.${pillClassName()}`)
    expect(pills).toHaveLength(1)
    const hostTab = pills[0].closest('button')
    expect(hostTab?.getAttribute('aria-selected')).toBe('true')
    expect(hostTab?.textContent).toBe('Magic link')
  })

  it('segmented control carries no underline or baseline rules', () => {
    const segmentedClassNames = stylex
      .props(styles.tablist, styles.tab, styles.tabActive, styles.tabInactive, styles.tabPill)
      .className.split(' ')
    const rules = cssRulesFor(segmentedClassNames)

    expect(rules.length).toBeGreaterThan(0)
    for (const rule of rules) {
      expect(rule.cssText).not.toContain('border-bottom')
      expect(rule.cssText).not.toContain('borderBottom')
      expect(rule.cssText).not.toContain('text-decoration')
    }
  })

  it('uses account-creation semantics and removes passkey sign-in during sign-up', async () => {
    const { container } = await render(
      <SignInTabs
        method="password"
        passkeySupport="yes"
        enabledMethods={['passkey', 'password']}
        isSignUpFlow={true}
        onSelect={vi.fn()}
      />,
    )

    expect(container.querySelector('[role="tablist"]')?.getAttribute('aria-label')).toBe(
      'Create your account',
    )
    expect(container.textContent).toContain('Password')
    expect(container.textContent).not.toContain('Passkey')
  })
})
