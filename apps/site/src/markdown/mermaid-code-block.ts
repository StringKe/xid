type HastText = {
  type: 'text'
  value: string
}

type HastElement = {
  type: 'element'
  tagName: string
  properties?: Record<string, unknown>
  children?: Array<HastElement | HastText>
}

type NimbusHastPlugin = ReturnType<typeof import('@cloudflare/nimbus-docs/markdown').tableScroll>

function textContent(node: HastElement | HastText): string {
  if (node.type === 'text') return node.value
  return (node.children ?? []).map(textContent).join('')
}

function classNames(node: HastElement): string[] {
  const value = node.properties?.className
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === 'string') return value.split(/\s+/u).filter(Boolean)
  return []
}

function isMermaidPre(node: HastElement): boolean {
  const properties = node.properties ?? {}
  return (
    properties.dataLanguage === 'mermaid' ||
    properties['data-language'] === 'mermaid' ||
    properties.dataNbLang === 'mermaid' ||
    properties['data-nb-lang'] === 'mermaid'
  )
}

function isMermaidCode(node: HastElement | HastText | undefined): node is HastElement {
  return (
    node?.type === 'element' &&
    node.tagName === 'code' &&
    classNames(node).some((className) => className === 'language-mermaid')
  )
}

export function mermaidCodeBlock() {
  const plugin = {
    name: 'xid:mermaid-code-block',
    element: {
      filter: ['pre'],
      visit(node: HastElement): HastElement | undefined {
        const code = node.children?.find(isMermaidCode)
        if (!code && !isMermaidPre(node)) return undefined
        const source = textContent(code ?? node)

        return {
          type: 'element',
          tagName: 'pre',
          properties: {
            className: ['mermaid'],
          },
          children: [{ type: 'text', value: source }],
        }
      },
    },
  }

  return plugin as typeof plugin & NimbusHastPlugin
}
