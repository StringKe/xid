// Core 收到 /console 时:自定义域名落 /account,自托管实例域名交给 Console Worker,未知主机 404。

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
  CONSOLE_WORKER: {
    fetch: async (request: Request) => new Response(`console:${request.url}`),
  },
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

  it('delegates /console on a self-hosted instance domain to the Console Worker', async () => {
    resolveTenantContext.mockResolvedValue({ ok: true, value: { tenantId: 'org_1' } })

    const res = await makeApp().request('https://id.example.com/console/org?orgId=org_1', {}, env)

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('console:https://id.example.com/console/org?orgId=org_1')
  })

  it('does not delegate a Console mutation that reaches Core', async () => {
    resolveTenantContext.mockResolvedValue({ ok: true, value: { tenantId: 'org_1' } })

    const res = await makeApp().request('https://id.example.com/console', { method: 'POST' }, env)

    expect(res.status).toBe(404)
    expect(resolveTenantContext).not.toHaveBeenCalled()
  })

  it('keeps the 404 when the host resolves to no tenant', async () => {
    resolveTenantContext.mockResolvedValue({ ok: false })

    const res = await makeApp().request('https://unknown.example/console', {}, env)

    expect(res.status).toBe(404)
  })
})
