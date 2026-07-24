import { describe, it, expect } from 'vitest'
import type { Context } from 'hono'
import type { XidHonoEnv } from '../../lib/types'
import { verifyTokenDpop } from '../dpop'
import { buildTestTenant, makeEnv, makeStatefulFakeDoNs } from './helpers'

const HTM = 'POST'

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

function b64urlStr(s: string): string {
  return b64url(new TextEncoder().encode(s))
}

async function buildDpopProof(input: { htu: string; jti?: string; now: number }): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey
  const header = {
    typ: 'dpop+jwt',
    alg: 'ES256',
    jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
  }
  const payload = {
    jti: input.jti ?? crypto.randomUUID(),
    htm: HTM,
    htu: input.htu,
    iat: input.now,
  }
  const signingInput = `${b64urlStr(JSON.stringify(header))}.${b64urlStr(JSON.stringify(payload))}`
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      pair.privateKey,
      new TextEncoder().encode(signingInput),
    ),
  )
  return `${signingInput}.${b64url(sig)}`
}

async function makeDpopContext(oauthState: DurableObjectNamespace): Promise<Context<XidHonoEnv>> {
  const { ctx } = await buildTestTenant()
  return {
    env: makeEnv({ OAUTH_STATE: oauthState }),
    get: (key: string) => (key === 'tenant' ? ctx : undefined),
  } as unknown as Context<XidHonoEnv>
}

// OAuthFlowDO /claim 故障:既不是 201(占用成功)也不是 409(重放)。
function failingClaimNs(): DurableObjectNamespace {
  return {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async () => new Response('claim failed', { status: 500 }),
    }),
  } as unknown as DurableObjectNamespace
}

describe('verifyTokenDpop', () => {
  it('accepts valid proof and rejects jti replay', async () => {
    const { ctx } = await buildTestTenant()
    const { ns } = makeStatefulFakeDoNs()
    const c = await makeDpopContext(ns)
    const now = Math.floor(Date.now() / 1000)
    const proof = await buildDpopProof({ htu: `${ctx.issuer}/token`, now })

    const first = await verifyTokenDpop(c, proof)
    expect(first.ok).toBe(true)

    const replay = await verifyTokenDpop(c, proof)
    expect(replay.ok).toBe(false)
    if (!replay.ok) expect(replay.error.code).toBe('invalid_dpop_proof')
  })

  it('rejects proof with wrong htu', async () => {
    await buildTestTenant()
    const { ns } = makeStatefulFakeDoNs()
    const c = await makeDpopContext(ns)
    const proof = await buildDpopProof({
      htu: 'https://evil.example/token',
      now: Math.floor(Date.now() / 1000),
    })
    const result = await verifyTokenDpop(c, proof)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_dpop_proof')
  })

  it('fails closed when the jti claim store is unavailable', async () => {
    const { ctx } = await buildTestTenant()
    const c = await makeDpopContext(failingClaimNs())
    const proof = await buildDpopProof({
      htu: `${ctx.issuer}/token`,
      now: Math.floor(Date.now() / 1000),
    })

    const result = await verifyTokenDpop(c, proof)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('server_error')
      expect(result.error.httpStatus).toBe(500)
    }
  })
})
