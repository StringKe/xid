import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings[0] }),
}))

vi.mock('@xid-kit/web-ui/locale-context', () => ({
  useLocale: () => ({
    locale: 'en',
    isChanging: false,
    setLocale: vi.fn(),
  }),
}))

import { LanguageSwitcher } from './LanguageSwitcher'

describe('LanguageSwitcher', () => {
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
  })
})
