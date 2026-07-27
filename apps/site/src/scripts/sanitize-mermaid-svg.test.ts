// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { sanitizeMermaidSvg } from './sanitize-mermaid-svg'

describe('sanitizeMermaidSvg', () => {
  it('preserves Mermaid SVG labels while removing executable markup', () => {
    const fragment = sanitizeMermaidSvg(`
      <svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">
        <script>alert(1)</script>
        <a href="javascript:alert(1)">unsafe</a>
        <foreignObject>
          <div xmlns="http://www.w3.org/1999/xhtml">
            <span onclick="alert(1)">label</span>
          </div>
        </foreignObject>
      </svg>
    `)
    const host = document.createElement('div')
    host.appendChild(fragment)

    expect(host.querySelector('svg')).not.toBeNull()
    expect(host.querySelector('script')).toBeNull()
    expect(host.querySelector('[onload], [onclick]')).toBeNull()
    expect(host.querySelector('a')?.getAttribute('href')).toBeNull()
    expect(host.textContent).toContain('label')
  })
})
