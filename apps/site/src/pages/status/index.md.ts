import { renderStatusMarkdown } from '../../lib/status-surface'

export const prerender = true

export function GET() {
  return new Response(renderStatusMarkdown('en'), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  })
}
