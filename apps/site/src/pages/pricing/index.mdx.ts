import { renderPricingMdx } from '../../lib/pricing-surface'

export const prerender = true

export function GET() {
  return new Response(renderPricingMdx('en'), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  })
}
