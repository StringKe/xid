import { describe, expect, it } from 'vitest'

import { verifyEnterpriseAttestation } from '../attestation'
import type { CborMap } from '../cbor'

function packedAttStmt(sig: Uint8Array, x5c: Uint8Array[]): CborMap {
  const statement: CborMap = new Map()
  statement.set('alg', -7)
  statement.set('sig', sig)
  statement.set('x5c', x5c)
  return statement
}

describe('verifyEnterpriseAttestation', () => {
  const authData = new Uint8Array(37)
  const clientDataJson = new TextEncoder().encode('{"type":"webauthn.create"}')

  it('rejects direct policy when trusted roots are not configured', async () => {
    const result = await verifyEnterpriseAttestation({
      fmt: 'packed',
      attStmt: packedAttStmt(new Uint8Array(64), [new Uint8Array([1, 2, 3])]),
      authData,
      clientDataJson,
      policy: 'direct',
      trustedRootsPem: [],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('invalid_credentials')
      expect(result.error.longMessage).toContain('trusted attestation roots not configured')
    }
  })

  it('does not treat empty trusted roots as chain verified for indirect policy', async () => {
    const result = await verifyEnterpriseAttestation({
      fmt: 'packed',
      attStmt: packedAttStmt(new Uint8Array(64), [new Uint8Array([1, 2, 3])]),
      authData,
      clientDataJson,
      policy: 'indirect',
      trustedRootsPem: [],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_credentials')
  })

  it('accepts none policy without enterprise verification', async () => {
    const result = await verifyEnterpriseAttestation({
      fmt: 'none',
      attStmt: new Map() as CborMap,
      authData,
      clientDataJson,
      policy: 'none',
    })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.verified).toBe(false)
  })
})
