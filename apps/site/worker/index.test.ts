import { PUBLIC_DOC_SLUGS } from '@xid-kit/types'
import { describe, expect, it, vi } from 'vitest'
import worker from './index'

function envWith(response: Response): {
  env: { ASSETS: Fetcher }
  fetch: ReturnType<typeof vi.fn>
} {
  const fetch = vi.fn().mockResolvedValue(response)
  return {
    env: { ASSETS: { fetch } as unknown as Fetcher },
    fetch,
  }
}

describe('site worker', () => {
  it.each([
    ['https://www.xid.dev/', 'https://xid.dev/'],
    [
      'https://www.xid.dev/docs/getting-started?from=www',
      'https://xid.dev/getting-started?from=www',
    ],
    ['https://www.xid.dev/docs/oidc?locale=ja&from=www', 'https://xid.dev/ja/oidc-oauth?from=www'],
    ['https://www.xid.dev/console/security?tab=mfa', 'https://xid.dev/console/security?tab=mfa'],
    ['https://www.xid.dev/brand/logo.svg?v=2', 'https://xid.dev/brand/logo.svg?v=2'],
  ])('redirects %s to the canonical apex', async (source, target) => {
    const { env, fetch } = envWith(new Response('asset'))
    const response = await worker.fetch(new Request(source), env, {} as ExecutionContext)

    expect(response.status).toBe(308)
    expect(response.headers.get('location')).toBe(target)
    expect(response.headers.get('strict-transport-security')).toContain('max-age=31536000')
    expect(response.headers.get('x-xid-route-owner')).toBe('site')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('uses the forwarded XID host only for local Worker integration', async () => {
    const { env, fetch } = envWith(new Response('asset'))
    const localResponse = await worker.fetch(
      new Request('http://127.0.0.1:8787/docs/getting-started?from=smoke', {
        headers: { 'X-Forwarded-Host': 'www.xid.dev' },
      }),
      env,
      {} as ExecutionContext,
    )
    const productionRequest = new Request('https://xid.dev/docs', {
      headers: { 'X-Forwarded-Host': 'www.xid.dev' },
    })
    const productionResponse = await worker.fetch(productionRequest, env, {} as ExecutionContext)

    expect(localResponse.status).toBe(308)
    expect(localResponse.headers.get('location')).toBe('https://xid.dev/getting-started?from=smoke')
    expect(productionResponse.status).toBe(308)
    expect(productionResponse.headers.get('location')).toBe('https://xid.dev/')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('ignores a forwarded host on a production request', async () => {
    const { env, fetch } = envWith(new Response('asset'))
    const request = new Request('https://xid.dev/getting-started', {
      headers: { 'X-Forwarded-Host': 'www.xid.dev' },
    })
    const response = await worker.fetch(request, env, {} as ExecutionContext)

    expect(response.status).toBe(200)
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledWith(request)
  })

  it('passes apex requests to static assets', async () => {
    const asset = new Response('site', { status: 200 })
    const { env, fetch } = envWith(asset)
    const request = new Request('https://xid.dev/getting-started')
    const response = await worker.fetch(request, env, {} as ExecutionContext)

    expect(await response.text()).toBe('site')
    expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'self'")
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('x-xid-route-owner')).toBe('site')
    expect(fetch).toHaveBeenCalledWith(request)
  })

  it.each([
    'https://xid.dev/?source=contract',
    'https://xid.dev/getting-started?source=contract',
    'https://xid.dev/llms.txt?source=contract',
    'https://xid.dev/status?source=contract',
    'https://xid.dev/zh-hans?source=contract',
    'https://xid.dev/scim?source=contract',
  ])('serves an exact Site path query without changing the request %s', async (source) => {
    const { env, fetch } = envWith(new Response('site'))
    const request = new Request(source)
    const response = await worker.fetch(request, env, {} as ExecutionContext)

    expect(response.status).toBe(200)
    expect(response.headers.get('x-xid-route-owner')).toBe('site')
    expect(fetch).toHaveBeenCalledWith(request)
  })

  it.each([
    'https://xid.dev/getting-startedx?source=contract',
    'https://xid.dev/llms.txtx?source=contract',
    'https://xid.dev/statusx?source=contract',
    'https://xid.dev/zh-hansx?source=contract',
    'https://tenant.xid.dev/getting-started?source=contract',
  ])('rejects a non-Site path without touching static assets %s', async (source) => {
    const { env, fetch } = envWith(new Response('site'))
    const response = await worker.fetch(new Request(source), env, {} as ExecutionContext)

    expect(response.status).toBe(404)
    expect(response.headers.get('x-xid-route-owner')).toBe('site')
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['https://xid.dev/index.md', 'text/markdown; charset=utf-8'],
    ['https://xid.dev/index.mdx', 'text/markdown; charset=utf-8'],
    ['https://xid.dev/getting-started/index.md', 'text/markdown; charset=utf-8'],
    ['https://xid.dev/getting-started/index.mdx', 'text/markdown; charset=utf-8'],
    ['https://xid.dev/llms.txt', 'text/plain; charset=utf-8'],
    ['https://xid.dev/llms-full.txt', 'text/plain; charset=utf-8'],
  ])('preserves the static Content-Type for %s', async (source, contentType) => {
    const asset = new Response('agent surface', {
      headers: { 'Content-Type': contentType },
    })
    const { env } = envWith(asset)
    const response = await worker.fetch(new Request(source), env, {} as ExecutionContext)

    expect(response.headers.get('content-type')).toBe(contentType)
    expect(response.headers.get('x-xid-route-owner')).toBe('site')
  })

  it.each([
    ['https://xid.dev/?locale=zh-Hans', 'https://xid.dev/zh-hans'],
    [
      'https://xid.dev/docs/getting-started?locale=ja&from=picker',
      'https://xid.dev/ja/getting-started?from=picker',
    ],
    ['https://xid.dev/fr/getting-started?locale=pt-BR', 'https://xid.dev/pt-br/getting-started'],
    ['https://xid.dev/ko/?locale=en', 'https://xid.dev/'],
  ])('redirects locale query %s to a canonical locale path', async (source, target) => {
    const { env, fetch } = envWith(new Response('asset'))
    const response = await worker.fetch(new Request(source), env, {} as ExecutionContext)

    expect(response.status).toBe(308)
    expect(response.headers.get('location')).toBe(target)
    expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'self'")
    expect(response.headers.get('x-xid-route-owner')).toBe('site')
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['https://xid.dev/brand/logo.svg?locale=ja', 'https://xid.dev/?locale=unsupported'])(
    'does not rewrite non-content or unsupported locale request %s',
    async (source) => {
      const asset = new Response('site')
      const { env, fetch } = envWith(asset)
      const request = new Request(source)
      const response = await worker.fetch(request, env, {} as ExecutionContext)

      expect(await response.text()).toBe('site')
      expect(response.headers.get('x-xid-route-owner')).toBe('site')
      expect(fetch).toHaveBeenCalledWith(request)
    },
  )

  it.each([
    ['https://xid.dev/docs/oidc?from=legacy', 'https://xid.dev/oidc-oauth?from=legacy'],
    ['https://xid.dev/docs/oauth', 'https://xid.dev/oidc-oauth'],
    ['https://xid.dev/docs/sso', 'https://xid.dev/enterprise-sso'],
    [
      'https://xid.dev/zh-hans/docs/enterprise?source=old',
      'https://xid.dev/zh-hans/enterprise-sso?source=old',
    ],
    ['https://xid.dev/pt-br/docs/sdks/web', 'https://xid.dev/pt-br/sdks/core'],
  ])('redirects public docs alias %s to %s', async (source, target) => {
    const { env, fetch } = envWith(new Response('asset'))
    const response = await worker.fetch(new Request(source), env, {} as ExecutionContext)

    expect(response.status).toBe(308)
    expect(response.headers.get('location')).toBe(target)
    expect(response.headers.get('x-xid-route-owner')).toBe('site')
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['https://xid.dev/', 'https://xid.dev/sdks/core', 'https://xid.dev/ja/getting-started'])(
    'does not redirect canonical docs path %s',
    async (source) => {
      const { env, fetch } = envWith(new Response('asset'))
      const request = new Request(source)
      const response = await worker.fetch(request, env, {} as ExecutionContext)

      expect(response.status).toBe(200)
      expect(response.headers.get('x-xid-route-owner')).toBe('site')
      expect(fetch).toHaveBeenCalledWith(request)
    },
  )

  it.each([
    ['https://xid.dev/docs?from=old', 'https://xid.dev/?from=old'],
    ['https://xid.dev/docs/', 'https://xid.dev/'],
    ['https://xid.dev/docs/index.md?raw=1', 'https://xid.dev/index.md?raw=1'],
    ['https://xid.dev/docs/index.mdx?locale=ja&raw=1', 'https://xid.dev/ja/index.mdx?raw=1'],
    ['https://xid.dev/ja/docs?from=old', 'https://xid.dev/ja?from=old'],
    ['https://xid.dev/ja/docs/index.mdx?raw=1', 'https://xid.dev/ja/index.mdx?raw=1'],
    ['https://xid.dev/docs/getting-started/', 'https://xid.dev/getting-started'],
    [
      'https://xid.dev/docs/getting-started/index.md?raw=1',
      'https://xid.dev/getting-started/index.md?raw=1',
    ],
    [
      'https://xid.dev/zh-hans/docs/sdks/react/index.mdx',
      'https://xid.dev/zh-hans/sdks/react/index.mdx',
    ],
  ])('redirects legacy canonical docs path %s in one hop', async (source, target) => {
    const { env, fetch } = envWith(new Response('asset'))
    const response = await worker.fetch(new Request(source), env, {} as ExecutionContext)

    expect(response.status).toBe(308)
    expect(response.headers.get('location')).toBe(target)
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['https://xid.dev/getting-started/', 'https://xid.dev/getting-started'],
    ['https://xid.dev/zh-hans/', 'https://xid.dev/zh-hans'],
    ['https://xid.dev/zh-hans/sdks/react/', 'https://xid.dev/zh-hans/sdks/react'],
  ])('redirects trailing slash route %s to canonical %s', async (source, target) => {
    const { env, fetch } = envWith(new Response('asset'))
    const response = await worker.fetch(new Request(source), env, {} as ExecutionContext)

    expect(response.status).toBe(308)
    expect(response.headers.get('location')).toBe(target)
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(
    PUBLIC_DOC_SLUGS.flatMap((slug) => [
      [`https://xid.dev/docs/${slug}`, `https://xid.dev/${slug}`],
      [`https://xid.dev/docs/${slug}/`, `https://xid.dev/${slug}`],
      [`https://xid.dev/docs/${slug}/index.md`, `https://xid.dev/${slug}/index.md`],
      [`https://xid.dev/docs/${slug}/index.mdx`, `https://xid.dev/${slug}/index.mdx`],
    ]),
  )('redirects every legacy page surface %s to %s', async (source, target) => {
    const { env, fetch } = envWith(new Response('asset'))
    const response = await worker.fetch(new Request(source), env, {} as ExecutionContext)

    expect(response.status).toBe(308)
    expect(response.headers.get('location')).toBe(target)
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['https://xid.dev/docs/llms.txt?from=old', 'https://xid.dev/en/llms.txt?from=old'],
    ['https://xid.dev/docs/llms-full.txt', 'https://xid.dev/en/llms-full.txt'],
    ['https://xid.dev/ja/docs/llms.txt?from=old', 'https://xid.dev/ja/llms.txt?from=old'],
    [
      'https://xid.dev/docs/llms-full.txt?locale=pt-BR&from=picker',
      'https://xid.dev/pt-br/llms-full.txt?from=picker',
    ],
  ])('redirects legacy agent index %s in one hop', async (source, target) => {
    const { env, fetch } = envWith(new Response('asset'))
    const response = await worker.fetch(new Request(source), env, {} as ExecutionContext)

    expect(response.status).toBe(308)
    expect(response.headers.get('location')).toBe(target)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('merges a legacy alias and locale query into one canonical redirect', async () => {
    const { env, fetch } = envWith(new Response('asset'))
    const response = await worker.fetch(
      new Request('https://xid.dev/docs/oidc/index.md?locale=ja&from=old'),
      env,
      {} as ExecutionContext,
    )

    expect(response.status).toBe(308)
    expect(response.headers.get('location')).toBe('https://xid.dev/ja/oidc-oauth/index.md?from=old')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('preserves the static 404 while identifying the site owner', async () => {
    const { env, fetch } = envWith(new Response('not found', { status: 404 }))
    const request = new Request('https://xid.dev/docs/current-gap-audit')
    const response = await worker.fetch(request, env, {} as ExecutionContext)

    expect(response.status).toBe(404)
    expect(response.headers.get('x-xid-route-owner')).toBe('site')
    expect(fetch).toHaveBeenCalledWith(request)
  })
})
