import { describe, expect, it } from 'vitest'
import { registerOptionalProtocolRoutes } from '../optional-protocols'
import { buildTestTenant, makeApp, makeEnv } from './helpers'

describe('optional protocol stubs', () => {
  it('returns negative tests for unsupported subset operations', async () => {
    const { ctx } = await buildTestTenant()
    const app = makeApp(ctx, registerOptionalProtocolRoutes)
    const gnapContinue = await app.request(
      'https://acme.xid.dev/gnap/tx',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      makeEnv({}),
    )
    expect(gnapContinue.status).toBe(501)
    const oid4vci = await app.request(
      'https://acme.xid.dev/oid4vci/credential',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      },
      makeEnv({}),
    )
    expect(oid4vci.status).toBe(400)
  })

  it('returns 501 for GNAP grant mutations', async () => {
    const { ctx } = await buildTestTenant()
    const app = makeApp(ctx, registerOptionalProtocolRoutes)
    const gnap = await app.request(
      'https://acme.xid.dev/gnap',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ access: { type: 'oauth_authorization_code' } }),
      },
      makeEnv({}),
    )
    expect(gnap.status).toBe(501)
  })

  it('exposes discovery-friendly metadata stubs', async () => {
    const { ctx } = await buildTestTenant()
    const app = makeApp(ctx, registerOptionalProtocolRoutes)
    const heart = await app.request('https://acme.xid.dev/heart/metadata', {}, makeEnv({}))
    expect(heart.status).toBe(200)
  })
})
