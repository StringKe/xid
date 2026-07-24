import { describe, expect, it } from 'vitest'
import { registerSsfRoutes } from '../ssf'
import { buildTestTenant, makeApp, makeEnv } from './helpers'

describe('SSF', () => {
  it('rejects stream creation because transmitter delivery is not implemented', async () => {
    const { ctx } = await buildTestTenant()
    const env = makeEnv({})
    const app = makeApp(ctx, registerSsfRoutes)
    const response = await app.request(
      'https://acme.xid.dev/ssf/stream',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          delivery: { method: 'push', endpoint: 'https://rp.example/ssf' },
        }),
      },
      env,
    )
    expect(response.status).toBe(501)
    expect(await response.json()).toMatchObject({ error: 'unsupported_response_type' })
  })

  it('keeps discovery endpoints isolated from the SPA fallback', async () => {
    const { ctx } = await buildTestTenant()
    const env = makeEnv({})
    const app = makeApp(ctx, registerSsfRoutes)
    const discovery = await app.request(
      'https://acme.xid.dev/.well-known/ssf-configuration',
      {},
      env,
    )
    expect(discovery.status).toBe(501)
    expect(await discovery.json()).toMatchObject({ error: 'unsupported_response_type' })
  })
})
