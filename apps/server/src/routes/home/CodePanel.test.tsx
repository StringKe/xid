import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CodeLines, PanelChrome } from './CodePanel'

describe('CodePanel', () => {
  it('renders token colors without undefined styles', () => {
    const html = renderToStaticMarkup(
      <CodeLines
        lines={[
          [
            { text: 'const', kind: 'keyword' },
            { text: ' value ' },
            { text: '=', kind: 'punctuation' },
            { text: ' 1' },
          ],
        ]}
      />,
    )

    expect(html).toContain('style="color:')
    expect(html).not.toContain('undefined')
  })

  it('staggers lines with per-index animation delay when enabled', () => {
    const html = renderToStaticMarkup(
      <CodeLines stagger lines={[[{ text: 'first' }], [{ text: 'second' }]]} />,
    )

    expect(html).toContain('animation-delay:36ms')
  })

  it('renders chrome with file label and action slot', () => {
    const html = renderToStaticMarkup(
      <PanelChrome file="worker/index.ts" action={<button type="button">copy</button>} />,
    )

    expect(html).toContain('worker/index.ts')
    expect(html).toContain('<button')
  })
})
