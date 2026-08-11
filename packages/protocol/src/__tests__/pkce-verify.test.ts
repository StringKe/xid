import { describe, it, expect, beforeAll } from 'vitest'

import { verifyPkce, enforcePkceBinding, computeS256Challenge } from '../pkce'
import {
  buildValidS256Vectors,
  PLAIN_CHALLENGE_REJECT_VECTORS,
  type ValidPkceVector,
} from './fixtures/pkce-vectors'

describe('verifyPkce S256', () => {
  let valid: ValidPkceVector[]

  beforeAll(async () => {
    valid = await buildValidS256Vectors()
  })

  it('accepts matching verifier/challenge for all valid vectors', async () => {
    for (const v of valid) {
      const r = await verifyPkce(v.verifier, v.challenge, 'S256')
      expect(r.ok).toBe(true)
    }
  })

  it('rejects mismatched challenge with invalid_grant', async () => {
    const v = valid[0]!
    const other = await computeS256Challenge('a'.repeat(43))
    const r = await verifyPkce(v.verifier, other, 'S256')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('invalid_grant')
  })

  it('rejects verifier shorter than 43 chars with invalid_request', async () => {
    const r = await verifyPkce('short', 'whatever', 'S256')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('invalid_request')
  })

  it('rejects verifier with illegal chars with invalid_request', async () => {
    const r = await verifyPkce('!'.repeat(43), 'whatever', 'S256')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('invalid_request')
  })
})

describe('verifyPkce rejects plain (downgrade)', () => {
  it('returns invalid_request for every plain reject vector', async () => {
    for (const v of PLAIN_CHALLENGE_REJECT_VECTORS) {
      const r = await verifyPkce(v.verifier, v.challenge, 'plain')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.code).toBe('invalid_request')
    }
  })
})

describe('enforcePkceBinding downgrade protection', () => {
  it('rejects when challenge registered but verifier missing', () => {
    const r = enforcePkceBinding({
      requirePkce: false,
      registeredChallenge: 'reg-challenge',
      presentedVerifier: null,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('invalid_grant')
  })

  it('rejects when require_pkce but no challenge registered (downgrade)', () => {
    const r = enforcePkceBinding({
      requirePkce: true,
      registeredChallenge: null,
      presentedVerifier: 'v'.repeat(43),
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('invalid_grant')
  })

  it('passes when challenge registered and verifier present', () => {
    const r = enforcePkceBinding({
      requirePkce: true,
      registeredChallenge: 'reg-challenge',
      presentedVerifier: 'v'.repeat(43),
    })
    expect(r.ok).toBe(true)
  })

  it('passes when no PKCE registered and not required', () => {
    const r = enforcePkceBinding({
      requirePkce: false,
      registeredChallenge: null,
      presentedVerifier: null,
    })
    expect(r.ok).toBe(true)
  })
})
