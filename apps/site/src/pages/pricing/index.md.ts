import { renderPricingMarkdown } from '../../lib/pricing-surface'

export const prerender = true

export function GET() {
  return new Response(renderPricingMarkdown('en'), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  })
}
