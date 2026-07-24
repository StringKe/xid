import { describe, expect, it, vi } from 'vitest'
import { createPublicWebMcpTools } from './register-public-tools'

describe('public WebMCP tools', () => {
  it('defines read-only discovery tools plus guarded navigation', () => {
    const tools = createPublicWebMcpTools({
      navigate: vi.fn<(to: string) => void>(),
      getPathname: () => '/docs',
      getPageTitle: () => 'Developer docs | XID',
    })
    const names = tools.map((tool) => tool.name)

    expect(names).toEqual([
      'list_public_docs',
      'get_public_doc',
      'search_public_docs',
      'get_site_context',
      'navigate_to_public_doc',
    ])
    expect(tools.find((tool) => tool.name === 'list_public_docs')?.annotations?.readOnlyHint).toBe(
      true,
    )
    expect(
      tools.find((tool) => tool.name === 'navigate_to_public_doc')?.annotations?.readOnlyHint,
    ).toBe(false)
  })

  it('returns metadata for aliases and rejects unpublished slugs', async () => {
    const tools = createPublicWebMcpTools({ navigate: vi.fn<(to: string) => void>() })
    const getPublicDoc = tools.find((tool) => tool.name === 'get_public_doc')

    expect(getPublicDoc).toBeDefined()

    const aliasResult = await getPublicDoc?.execute({ slug: 'oidc' })
    expect(aliasResult).toContain('"slug": "oidc-oauth"')

    const blockedResult = await getPublicDoc?.execute({ slug: 'design' })
    expect(blockedResult).toContain('unknown or unpublished')
  })

  it('navigates only to published documentation slugs', async () => {
    const navigate = vi.fn<(to: string) => void>()
    const tools = createPublicWebMcpTools({ navigate })
    const navigateToDoc = tools.find((tool) => tool.name === 'navigate_to_public_doc')

    const result = await navigateToDoc?.execute({ slug: 'webhooks' })
    expect(navigate).toHaveBeenCalledWith('/docs/webhooks')
    expect(result).toContain('"navigated": true')
  })
})
