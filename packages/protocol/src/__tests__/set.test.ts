import { describe, expect, it } from 'vitest'
import { signSet, CAEP_SESSION_REVOKED, RISC_ACCOUNT_CREDENTIAL_CHANGE } from '../set'
import { buildTestTenant } from './fixtures/tenant'

function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split('.')[1]!
  return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))
}

describe('signSet', () => {
  it('signs a security event token with events claim', async () => {
    const { ctx, signingKey } = await buildTestTenant()
    const token = await signSet({
      ctx,
      signingKey,
      eventType: CAEP_SESSION_REVOKED,
      subject: { subject: { format: 'opaque', id: 'sess_1' } },
      audience: 'https://rp.example/ssf',
      now: 1_700_000_000,
    })
    const parts = token.split('.')
    expect(parts).toHaveLength(3)
    const payload = decodeJwtPayload(token)
    expect(payload.events).toEqual({
      [CAEP_SESSION_REVOKED]: { subject: { format: 'opaque', id: 'sess_1' } },
    })
  })

  it('sets SET JWT header typ and issuer from TenantContext', async () => {
    const { ctx, signingKey } = await buildTestTenant({ issuer: 'https://issuer.test' })
    const token = await signSet({
      ctx,
      signingKey,
      eventType: RISC_ACCOUNT_CREDENTIAL_CHANGE,
      subject: { subject: { format: 'opaque', id: 'user_1' } },
      audience: 'https://rp.example/ssf',
      now: 1_700_000_100,
      ttlSec: 120,
    })
    const header = JSON.parse(atob(token.split('.')[0]!.replace(/-/g, '+').replace(/_/g, '/')))
    const payload = decodeJwtPayload(token)
    expect(header.typ).toBe('secevent+jwt')
    expect(payload.iss).toBe('https://issuer.test')
    expect(payload.aud).toBe('https://rp.example/ssf')
    expect(payload.exp).toBe(1_700_000_220)
    expect(payload.jti).toBeTypeOf('string')
  })
})
