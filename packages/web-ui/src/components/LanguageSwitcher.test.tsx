import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

const localeState = vi.hoisted(() => ({ failedLocale: null as string | null }))

vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings[0] }),
}))

vi.mock('../locale-context', () => ({
  useLocale: () => ({
    locale: 'en',
    isChanging: false,
    failedLocale: localeState.failedLocale,
    setLocale: vi.fn(),
  }),
}))

import { LanguageSwitcher } from './LanguageSwitcher'

describe('LanguageSwitcher', () => {
  beforeEach(() => {
    localeState.failedLocale = null
  })

  it('renders all supported locale choices', () => {
    const html = renderToStaticMarkup(<LanguageSwitcher />)

    expect(html).toContain('Language')
    expect(html).toContain('English')
    expect(html).toContain('简体中文')
    expect(html).toContain('日本語')
    expect(html).toContain('한국어')
    expect(html).toContain('Français')
    expect(html).toContain('Deutsch')
    expect(html).toContain('Español')
    expect(html).toContain('Português')
    expect(html).not.toContain('role="alert"')
  })

  it('reports a language whose catalog failed to load', () => {
    localeState.failedLocale = 'ja'

    const html = renderToStaticMarkup(<LanguageSwitcher />)

    expect(html).toContain('role="alert"')
  })
})
