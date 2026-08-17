import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Icon, ICON_NAMES } from './Icon'

describe('Icon', () => {
  it('renders every registered name as a currentColor stroke glyph', () => {
    for (const name of ICON_NAMES) {
      const html = renderToStaticMarkup(<Icon name={name} size={16} />)

      expect(html).toContain('<svg')
      expect(html).toContain('stroke="currentColor"')
      expect(html).toContain('stroke-width="1.5"')
      expect(html).toContain('viewBox="0 0 24 24"')
      // 图标不许写字面色值,颜色只能继承 currentColor。
      expect(html).not.toContain('oklch')
      expect(html).not.toContain('#')
    }
  })

  it('is decorative by default and exposes a label only when given one', () => {
    const decorative = renderToStaticMarkup(<Icon name="gear" />)
    const labelled = renderToStaticMarkup(<Icon name="gear" label="Settings" />)

    expect(decorative).toContain('aria-hidden="true"')
    expect(decorative).not.toContain('<title>')
    expect(labelled).toContain('role="img"')
    expect(labelled).toContain('aria-label="Settings"')
    expect(labelled).toContain('<title>Settings</title>')
  })

  it('matches the glyph snapshot for the full set', () => {
    const html = renderToStaticMarkup(
      <>
        {ICON_NAMES.map((name) => (
          <Icon key={name} name={name} />
        ))}
      </>,
    )

    expect(html).toMatchSnapshot()
  })
})
