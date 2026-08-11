// @vitest-environment jsdom
// StyleX 经 CSSOM insertRule,class hash 不稳定,断言规则文本。

import { describe, expect, it } from 'vitest'
import { Button } from '../../../components/ui/Button'

function injectedCss(): string {
  return Array.from(document.styleSheets)
    .flatMap((sheet) => Array.from(sheet.cssRules).map((rule) => rule.cssText))
    .join('\n')
}

describe('Button press feedback', () => {
  it('injects :active scale(0.97) press feedback into the stylesheet', () => {
    expect(Button).toBeDefined()
    const css = injectedCss()

    expect(css).toContain(':active')
    expect(css).toMatch(/scale\(\s*0?\.97\s*\)/)
  })

  it('transitions transform so the press animates instead of snapping', () => {
    expect(Button).toBeDefined()

    expect(injectedCss()).toContain('transform')
  })
})
