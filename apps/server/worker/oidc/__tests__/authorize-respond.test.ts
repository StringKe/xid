import { describe, it, expect } from 'vitest'
import { verifyJwt } from '@xid-kit/crypto'
import { Hono } from 'hono'

import {
  isJwtResponseMode,
  resolveResponseMode,
  respondToRp,
  signAuthorizationResponseJwt,
} from '../authorize-respond'
import type { XidHonoEnv } from '../../lib/types'
import { loadActiveSigner } from '../shared'
import { buildTestTenant } from './helpers'

describe('resolveResponseMode', () => {
  it('defaults code flow to query and hybrid to fragment', () => {
    expect(resolveResponseMode(undefined, 'code')).toBe('query')
    expect(resolveResponseMode(undefined, 'code id_token')).toBe('fragment')
  })

  it('honors explicit response_mode values', () => {
    expect(resolveResponseMode('form_post', 'code')).toBe('form_post')
    expect(resolveResponseMode('query.jwt', 'code')).toBe('query.jwt')
  })
})

describe('isJwtResponseMode', () => {
  it('detects JWT response modes', () => {
    expect(isJwtResponseMode('query.jwt')).toBe(true)
    expect(isJwtResponseMode('fragment.jwt')).toBe(true)
    expect(isJwtResponseMode('query')).toBe(false)
  })
})

describe('respondToRp', () => {
  function makeRespondApp(
    mode: 'query' | 'fragment' | 'form_post',
    params: Record<string, string>,
  ) {
    const app = new Hono<XidHonoEnv>()
    app.get('/', (c) =>
      respondToRp(c, {
        redirectUri: 'https://rp.example/cb',
        mode,
        params,
      }),
    )
    return app
  }

  it('redirects with query parameters for query mode', async () => {
    const res = await makeRespondApp('query', { code: 'ac_1', state: 'st_1' }).request('/')
    expect(res.status).toBe(302)
    const location = res.headers.get('location') ?? ''
    expect(location).toContain('code=ac_1')
    expect(location).toContain('state=st_1')
  })

  it('redirects with fragment parameters for fragment mode', async () => {
    const res = await makeRespondApp('fragment', { id_token: 'id_1', state: 'st_1' }).request('/')
    expect(res.status).toBe(302)
    const location = res.headers.get('location') ?? ''
    expect(location).toContain('#id_token=id_1')
  })

  it('returns auto-submitting HTML form for form_post mode', async () => {
    const res = await makeRespondApp('form_post', { code: 'ac_1', state: 'st_1' }).request('/')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('method="post"')
    expect(html).toContain('name="code"')
    expect(html).toContain('value="ac_1"')
    expect(res.headers.get('cache-control')).toBe('no-store')
  })
})

describe('signAuthorizationResponseJwt', () => {
  it('signs authorization response params with tenant active key', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const signer = await loadActiveSigner(ctx, kekB64)
    const now = Math.floor(Date.now() / 1000)
    const jwt = await signAuthorizationResponseJwt({
      ctx,
      signer,
      clientId: 'cli_app',
      params: { code: 'ac_1', state: 'st_1' },
      now,
    })
    const verified = await verifyJwt(jwt, {
      keys: [
        {
          kid: signer.kid,
          alg: signer.alg,
          publicKey: await crypto.subtle.importKey(
            'jwk',
            ctx.signingKeys.keys[0]!.publicKeyJwk,
            { name: 'ECDSA', namedCurve: 'P-256' },
            false,
            ['verify'],
          ),
        },
      ],
    })
    expect(verified.ok).toBe(true)
    if (verified.ok) {
      expect(verified.value.payload['code']).toBe('ac_1')
      expect(verified.value.payload['aud']).toBe('cli_app')
      expect(verified.value.payload['iss']).toBe(ctx.issuer)
    }
  })
})
