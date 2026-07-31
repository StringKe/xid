import { describe, expect, it, vi } from 'vitest'
import worker, { type ConsoleEnv } from './index'

const SECURITY_HEADERS = {
  'content-security-policy': "frame-ancestors 'self'",
  'permissions-policy': 'tools=(self)',
  'origin-agent-cluster': '?1',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'SAMEORIGIN',
} as const

function expectSecurityHeaders(response: Response): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    expect(response.headers.get(name)).toBe(value)
  }
  expect(response.headers.get('x-xid-route-owner')).toBe('console')
}

function createEnv(resolve: (request: Request) => Response | Promise<Response>): {
  env: ConsoleEnv
  fetchAsset: ReturnType<typeof vi.fn>
} {
  const fetchAsset = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    return resolve(request)
  })
  return {
    env: { ASSETS: { fetch: fetchAsset } },
    fetchAsset,
  }
}

describe('console worker', () => {
  it.each([
    ['https://www.xid.dev/', 'https://xid.dev/'],
    [
      'https://www.xid.dev/console/organizations?from=www',
      'https://xid.dev/console/organizations?from=www',
    ],
    ['http://www.xid.dev/assets/app.js?v=2', 'https://xid.dev/assets/app.js?v=2'],
  ])('redirects %s to the canonical apex', async (source, target) => {
    const { env, fetchAsset } = createEnv(() => new Response('unused'))
    const response = await worker.fetch(new Request(source), env)

    expect(response.status).toBe(308)
    expect(response.headers.get('location')).toBe(target)
    expectSecurityHeaders(response)
    expect(fetchAsset).not.toHaveBeenCalled()
  })

  it('uses the forwarded XID host only for local Worker integration', async () => {
    const { env, fetchAsset } = createEnv(() => new Response('console shell'))
    const localResponse = await worker.fetch(
      new Request('http://localhost:8788/console/organizations?from=smoke', {
        headers: { 'X-Forwarded-Host': 'www.xid.dev' },
      }),
      env,
    )
    const productionRequest = new Request('https://xid.dev/console/')
    const productionResponse = await worker.fetch(productionRequest, env)

    expect(localResponse.status).toBe(308)
    expect(localResponse.headers.get('location')).toBe(
      'https://xid.dev/console/organizations?from=smoke',
    )
    expect(productionResponse.status).toBe(200)
    expect(fetchAsset).toHaveBeenCalledOnce()
    expect(fetchAsset).toHaveBeenCalledWith(productionRequest)
  })

  it.each([
    ['https://xid.dev/console/sessions?tab=active', 'https://xid.dev/account/sessions?tab=active'],
    [
      'https://tenant.xid.dev/console/sessions/?tab=active',
      'https://tenant.xid.dev/account/sessions?tab=active',
    ],
    ['https://xid.dev/console/security?tab=mfa', 'https://xid.dev/account/security?tab=mfa'],
    [
      'https://tenant.xid.dev/console/security/?tab=mfa',
      'https://tenant.xid.dev/account/security?tab=mfa',
    ],
  ])('redirects account alias %s on the same host', async (source, target) => {
    const { env, fetchAsset } = createEnv(() => new Response('unused'))
    const response = await worker.fetch(new Request(source), env)

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(target)
    expectSecurityHeaders(response)
    expect(fetchAsset).not.toHaveBeenCalled()
  })

  it('passes an existing asset through exactly once', async () => {
    const { env, fetchAsset } = createEnv(
      () =>
        new Response('asset', {
          status: 200,
          headers: { 'Content-Type': 'application/javascript' },
        }),
    )
    const request = new Request('https://xid.dev/console/assets/app.js')
    const response = await worker.fetch(request, env)

    expect(await response.text()).toBe('asset')
    expect(response.headers.get('content-type')).toBe('application/javascript')
    expectSecurityHeaders(response)
    expect(fetchAsset).toHaveBeenCalledTimes(1)
    expect(fetchAsset).toHaveBeenCalledWith(request)
  })

  it.each([
    'https://xid.dev/console?source=contract',
    'https://tenant.xid.dev/console?source=contract',
  ])('serves the exact Console root query without changing the request %s', async (source) => {
    const { env, fetchAsset } = createEnv(() => new Response('console shell'))
    const request = new Request(source)
    const response = await worker.fetch(request, env)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('console shell')
    expectSecurityHeaders(response)
    expect(fetchAsset).toHaveBeenCalledWith(request)
  })

  it('keeps an asset 404 instead of returning the SPA shell', async () => {
    const { env, fetchAsset } = createEnv(() => new Response(null, { status: 404 }))
    const request = new Request('https://xid.dev/console/assets/missing.js', {
      headers: { Accept: 'text/html', 'Sec-Fetch-Dest': 'document' },
    })
    const response = await worker.fetch(request, env)

    expect(response.status).toBe(404)
    expectSecurityHeaders(response)
    expect(fetchAsset).toHaveBeenCalledTimes(1)
  })

  it('falls back to the Console index only for a missing document navigation', async () => {
    const { env, fetchAsset } = createEnv((request) => {
      if (new URL(request.url).pathname === '/console/') {
        return new Response('console shell')
      }
      return new Response(null, { status: 404 })
    })
    const request = new Request('https://tenant.xid.dev/console/organizations?view=all', {
      headers: { Accept: 'text/html', 'Sec-Fetch-Mode': 'navigate' },
    })
    const response = await worker.fetch(request, env)

    expect(await response.text()).toBe('console shell')
    expectSecurityHeaders(response)
    expect(fetchAsset).toHaveBeenCalledTimes(2)
    const fallbackRequest = fetchAsset.mock.calls[1]?.[0]
    expect(fallbackRequest).toBeInstanceOf(Request)
    expect((fallbackRequest as Request).url).toBe('https://tenant.xid.dev/console/')
  })

  it('keeps a non-document route miss as 404', async () => {
    const { env, fetchAsset } = createEnv(() => new Response(null, { status: 404 }))
    const request = new Request('https://xid.dev/console/organizations', {
      headers: {
        Accept: 'text/html',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
      },
    })
    const response = await worker.fetch(request, env)

    expect(response.status).toBe(404)
    expectSecurityHeaders(response)
    expect(fetchAsset).toHaveBeenCalledTimes(1)
  })

  it.each([
    'https://xid.dev/v1/me',
    'https://xid.dev/account/security',
    'https://tenant.xid.dev/auth/config',
    'https://xid.dev/consolex',
  ])('returns 404 without touching assets for non-Console path %s', async (source) => {
    const { env, fetchAsset } = createEnv(() => new Response('unused'))
    const response = await worker.fetch(new Request(source), env)

    expect(response.status).toBe(404)
    expectSecurityHeaders(response)
    expect(fetchAsset).not.toHaveBeenCalled()
  })

  it('preserves an upstream security policy', async () => {
    const { env } = createEnv(
      () =>
        new Response('asset', {
          headers: { 'Content-Security-Policy': "frame-ancestors 'none'" },
        }),
    )
    const response = await worker.fetch(
      new Request('https://xid.dev/console/assets/embedded.html'),
      env,
    )

    expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'none'")
    expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN')
  })
})
