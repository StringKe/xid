import { describe, expect, it } from 'vitest'
import { renderMarkdownInline } from './render-markdown'

describe('renderMarkdownInline', () => {
  it('escapes backslashes before Markdown, MDX, and HTML metacharacters', () => {
    const rendered = renderMarkdownInline(
      { kind: 'literal', value: String.raw`\*_[x]&<>{}` },
      { locale: 'en', translate: () => '' },
    )

    expect(rendered).toBe(String.raw`\\\*\_\[x\]&amp;&lt;&gt;&#123;&#125;`)
  })
})
