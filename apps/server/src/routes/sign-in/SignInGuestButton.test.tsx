// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { SignInGuestButton } from './SignInGuestButton'

vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings[0] }),
}))

describe('SignInGuestButton', () => {
  it('renders the guest entry in a separator section below the primary methods', () => {
    const html = renderToStaticMarkup(<SignInGuestButton onContinue={vi.fn()} isLoading={false} />)

    expect(html).toContain('role="separator"')
    expect(html).toContain('Continue as guest')
    expect(html).toContain('aria-label="Continue as guest"')
    expect(html).toContain('Guest data cannot be recovered')
  })

  it('calls onContinue on click and blocks interaction while loading', async () => {
    ;(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true
    const onContinue = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(<SignInGuestButton onContinue={onContinue} isLoading={false} />)
    })
    const button = container.querySelector('button')
    expect(button?.disabled).toBe(false)

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onContinue).toHaveBeenCalledTimes(1)

    await act(async () => {
      root.render(<SignInGuestButton onContinue={onContinue} isLoading={true} />)
    })
    const loadingButton = container.querySelector('button')
    expect(loadingButton?.disabled).toBe(true)
    expect(loadingButton?.getAttribute('aria-busy')).toBe('true')

    await act(async () => {
      loadingButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onContinue).toHaveBeenCalledTimes(1)

    await act(async () => {
      root.unmount()
    })
    container.remove()
  })
})
