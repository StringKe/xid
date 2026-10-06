import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@lingui/react/macro', () => ({
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings[0] }),
}))

import { Button } from './Button'

describe('Button', () => {
  it('stays focusable and announces the blocked state instead of using the disabled attribute', () => {
    const html = renderToStaticMarkup(<Button disabled>Save changes</Button>)

    expect(html).toContain('aria-disabled="true"')
    expect(html).not.toContain('disabled=""')
  })

  it('marks a loading button busy and blocked', () => {
    const html = renderToStaticMarkup(<Button isLoading>Creating</Button>)

    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('aria-disabled="true"')
  })

  it('hides only on the listed viewports', () => {
    const html = renderToStaticMarkup(<Button hidden={{ narrow: true }}>Export CSV</Button>)

    expect(html).toContain('xid-hidden-narrow')
    expect(html).not.toContain('xid-hidden-regular')
  })
})
