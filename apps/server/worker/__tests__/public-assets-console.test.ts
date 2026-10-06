// Core 收到 /console 时:自定义域名落 /account,其余 host 仍 fail closed 为 404。

import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { XidHonoEnv } from '../lib/types'

const resolveTenantContext = vi.hoisted(() =>
  vi.fn<() => Promise<{ ok: boolean; value?: Record<string, unknown> }>>(),
)

vi.mock('@xid-kit/db', () => ({ resolveTenantContext }))

import { registerPublicAssetRoutes } from '../public-assets'

function makeApp(): Hono<XidHonoEnv> {
  const app = new Hono<XidHonoEnv>()
  registerPublicAssetRoutes(app)
  return app
}

const env = {
  ASSETS: { fetch: async () => new Response('<div id="root"></div>') },
} as unknown as Env

describe('Core /console fallback', () => {
  beforeEach(() => resolveTenantContext.mockReset())

  it('sends a custom hostname /console request to the account portal', async () => {
    resolveTenantContext.mockResolvedValue({
      ok: true,
      value: { tenantId: 'org_1', customHostname: 'login.customer.example' },
    })

    const res = await makeApp().request(
      'https://login.customer.example/console/org?orgId=org_1',
      {},
      env,
    )

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/account')
  })

  it('keeps the owned-by-console 404 for hosts that route the Console Worker', async () => {
    resolveTenantContext.mockResolvedValue({ ok: true, value: { tenantId: 'org_1' } })

    const res = await makeApp().request('https://team.example.dev/console?x=1', {}, env)

    expect(res.status).toBe(404)
    expect(res.headers.get('x-xid-core-route-status')).toBe('owned-by-console')
  })

  it('keeps the 404 when the host resolves to no tenant', async () => {
    resolveTenantContext.mockResolvedValue({ ok: false })

    const res = await makeApp().request('https://unknown.example/console', {}, env)

    expect(res.status).toBe(404)
  })
})
