import { renderPublicDocsGlobalLlmsFull } from '../lib/docs-agent-content'
import { loadPublicDocsIndex } from '../lib/docs-index-runtime'

export const prerender = true

export async function GET() {
  const groups = await loadPublicDocsIndex()
  return new Response(renderPublicDocsGlobalLlmsFull(groups), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}
