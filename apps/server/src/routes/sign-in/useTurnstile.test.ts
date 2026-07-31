// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TURNSTILE_ACTION } from '../../../shared/turnstile'
import { normalizeTurnstileSiteKey, useTurnstile } from './useTurnstile'

describe('normalizeTurnstileSiteKey', () => {
  it('returns null when the Turnstile site key is missing', () => {
    expect(normalizeTurnstileSiteKey(null)).toBeNull()
    expect(normalizeTurnstileSiteKey(undefined)).toBeNull()
  })

  it('returns null when the Turnstile sitekey is blank', () => {
    expect(normalizeTurnstileSiteKey('   ')).toBeNull()
  })

  it('trims a configured Turnstile sitekey', () => {
    expect(normalizeTurnstileSiteKey(' site-key ')).toBe('site-key')
  })
})

type HostProps = {
  siteKey: string | null
  token: string | null
  onToken: (token: string) => void
}

function Host({ siteKey, token, onToken }: HostProps) {
  const { containerRef } = useTurnstile(siteKey, token, onToken)
  return createElement('div', { ref: containerRef })
}

describe('useTurnstile lifecycle', () => {
  afterEach(() => {
    document.getElementById('xid-turnstile-script')?.remove()
    delete (globalThis as Record<string, unknown>).turnstile
    document.body.replaceChildren()
  })

  it('renders the official action, rotates a consumed token, and removes the widget', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const render = vi.fn<(container: HTMLElement, options: Record<string, unknown>) => string>(
      () => 'widget-1',
    )
    const reset = vi.fn<(widgetId: string) => void>()
    const remove = vi.fn<(widgetId: string) => void>()
    ;(globalThis as Record<string, unknown>).turnstile = { render, reset, remove }
    const onToken = vi.fn<(token: string) => void>()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(createElement(Host, { siteKey: 'site-key', token: null, onToken }))
    })

    expect(render).toHaveBeenCalledTimes(1)
    const options = render.mock.calls[0]?.[1] as Record<string, unknown>
    expect(options).toMatchObject({
      sitekey: 'site-key',
      action: TURNSTILE_ACTION,
      appearance: 'interaction-only',
    })
    expect(options).not.toHaveProperty('size')
    expect(document.getElementById('xid-turnstile-script')?.getAttribute('src')).toBe(
      'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
    )

    await act(async () => {
      root.render(createElement(Host, { siteKey: 'site-key', token: 'used-token', onToken }))
    })
    await act(async () => {
      root.render(createElement(Host, { siteKey: 'site-key', token: null, onToken }))
    })
    expect(reset).toHaveBeenCalledWith('widget-1')

    await act(async () => root.unmount())
    expect(remove).toHaveBeenCalledWith('widget-1')
  })

  it('does not load the script or render a fallback widget without a site key', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const render = vi.fn<(container: HTMLElement, options: Record<string, unknown>) => string>(
      () => 'widget-1',
    )
    ;(globalThis as Record<string, unknown>).turnstile = { render }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(
        createElement(Host, {
          siteKey: null,
          token: null,
          onToken: vi.fn<(token: string) => void>(),
        }),
      )
    })

    expect(render).not.toHaveBeenCalled()
    expect(document.getElementById('xid-turnstile-script')).toBeNull()
    await act(async () => root.unmount())
  })
})
