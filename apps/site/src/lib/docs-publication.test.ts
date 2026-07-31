import { describe, expect, it } from 'vitest'
import {
  getAgentExcludedDocumentPaths,
  isDocumentAgentPublished,
  isDocumentHtmlPublished,
} from './docs-publication'

describe('documentation publication policy', () => {
  it('keeps noindex HTML while excluding noindex and draft pages from agent surfaces', () => {
    const published = { slug: 'published' }
    const noindex = { slug: 'private-preview', noindex: true }
    const draft = { slug: 'unfinished', draft: true }

    expect(isDocumentHtmlPublished(published)).toBe(true)
    expect(isDocumentAgentPublished(published)).toBe(true)
    expect(isDocumentHtmlPublished(noindex)).toBe(true)
    expect(isDocumentAgentPublished(noindex)).toBe(false)
    expect(isDocumentHtmlPublished(draft)).toBe(false)
    expect(isDocumentAgentPublished(draft)).toBe(false)

    const exclusions = getAgentExcludedDocumentPaths([published, noindex, draft])
    expect(exclusions.size).toBe(16)
    expect(exclusions).toContain('/private-preview')
    expect(exclusions).toContain('/zh-hans/private-preview')
    expect(exclusions).toContain('/pt-br/unfinished')
    expect(exclusions).not.toContain('/published')
  })
})
