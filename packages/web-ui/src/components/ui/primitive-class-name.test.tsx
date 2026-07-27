import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

vi.mock('@lingui/react/macro', () => ({
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings[0] }),
}))

vi.mock('./Spinner', () => ({
  Spinner: (): ReactNode => <span role="status">Loading</span>,
}))

import { BrandLogo } from '../BrandLogo'
import { Button } from './Button'
import { Card } from './Card'

describe('primitive className merging', () => {
  it('keeps StyleX class names when BrandLogo receives an external class', () => {
    const html = renderToStaticMarkup(<BrandLogo className="external-logo" />)

    expect(html).toContain('external-logo')
    expect(html).not.toContain('undefined')
    expect(html).not.toContain('=&gt;')
  })

  it('keeps StyleX class names when Button receives an external class', () => {
    const html = renderToStaticMarkup(<Button className="external-button">Save</Button>)

    expect(html).toContain('external-button')
    expect(html).toContain('Save')
    expect(html).not.toContain('undefined')
    expect(html).not.toContain('=&gt;')
  })

  it('keeps StyleX class names when Card receives an external class', () => {
    const html = renderToStaticMarkup(<Card className="external-card">Content</Card>)

    expect(html).toContain('external-card')
    expect(html).toContain('Content')
    expect(html).not.toContain('undefined')
    expect(html).not.toContain('=&gt;')
  })
})
