import { describe, expect, it } from 'vitest'
import { mermaidCodeBlock } from './mermaid-code-block'

describe('mermaidCodeBlock', () => {
  it('turns a mermaid fence into the runtime pre element', () => {
    const plugin = mermaidCodeBlock()
    const result = plugin.element.visit({
      type: 'element',
      tagName: 'pre',
      properties: {},
      children: [
        {
          type: 'element',
          tagName: 'code',
          properties: { className: ['language-mermaid'] },
          children: [{ type: 'text', value: 'flowchart LR\n  RP --> XID' }],
        },
      ],
    })

    expect(result).toEqual({
      type: 'element',
      tagName: 'pre',
      properties: { className: ['mermaid'] },
      children: [{ type: 'text', value: 'flowchart LR\n  RP --> XID' }],
    })
  })

  it('turns Nimbus Shiki output into plain Mermaid source', () => {
    const plugin = mermaidCodeBlock()
    const result = plugin.element.visit({
      type: 'element',
      tagName: 'pre',
      properties: {
        className: ['astro-code', 'nb-shiki'],
        dataLanguage: 'mermaid',
        dataNbLang: 'mermaid',
        tabIndex: 0,
      },
      children: [
        {
          type: 'element',
          tagName: 'code',
          children: [
            {
              type: 'element',
              tagName: 'span',
              properties: { className: ['line'] },
              children: [
                {
                  type: 'element',
                  tagName: 'span',
                  children: [{ type: 'text', value: 'sequenceDiagram' }],
                },
              ],
            },
            { type: 'text', value: '\n' },
          ],
        },
      ],
    })

    expect(result).toEqual({
      type: 'element',
      tagName: 'pre',
      properties: { className: ['mermaid'] },
      children: [{ type: 'text', value: 'sequenceDiagram\n' }],
    })
  })

  it('leaves other code blocks unchanged', () => {
    const plugin = mermaidCodeBlock()
    const result = plugin.element.visit({
      type: 'element',
      tagName: 'pre',
      children: [
        {
          type: 'element',
          tagName: 'code',
          properties: { className: ['language-ts'] },
          children: [{ type: 'text', value: 'const value = true' }],
        },
      ],
    })

    expect(result).toBeUndefined()
  })
})
