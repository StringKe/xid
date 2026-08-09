import { renderHomeMarkdown } from '../lib/home-surface'

export const prerender = true

export function GET() {
  return new Response(renderHomeMarkdown('en'), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  })
}
