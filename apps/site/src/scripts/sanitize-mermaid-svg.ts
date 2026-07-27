import DOMPurify from 'dompurify'

export function sanitizeMermaidSvg(svg: string): DocumentFragment {
  return DOMPurify.sanitize(svg, {
    ADD_TAGS: ['foreignobject'],
    ADD_ATTR: ['dominant-baseline'],
    HTML_INTEGRATION_POINTS: { foreignobject: true },
    RETURN_DOM_FRAGMENT: true,
  })
}
