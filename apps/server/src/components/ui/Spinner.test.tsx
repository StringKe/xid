import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@lingui/react/macro', () => ({
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings[0] }),
}))

import { Spinner } from './Spinner'

describe('Spinner', () => {
  it('renders runtime size without function source or undefined classes', () => {
    const html = renderToStaticMarkup(<Spinner size={28} label="Loading profile" />)

    expect(html).toContain('width:28px')
    expect(html).toContain('height:28px')
    expect(html).not.toContain('undefined')
    expect(html).not.toContain('=&gt;')
    expect(html).not.toContain('=>')
  })
})
