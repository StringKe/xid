import { beforeAll, describe, it, expect } from 'vitest'

import { setSamlEngine } from '../engine'
import { loadIdpVerifyKey, loadIdpVerifyKeys } from '../cert'
import { IDP_CERT_B64 } from './fixtures'

describe('loadIdpVerifyKey', () => {
  beforeAll(() => setSamlEngine(crypto))

  it('loads RSA verify key and SHA-256 fingerprint from DER cert', async () => {
    const result = await loadIdpVerifyKey(IDP_CERT_B64)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.publicKey.type).toBe('public')
      expect(result.value.fingerprint).toMatch(/^[0-9A-F]{2}(:[0-9A-F]{2})+$/)
    }
  })

  it('rejects malformed certificate input', async () => {
    const result = await loadIdpVerifyKey('not-a-cert')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('signature_invalid')
  })
})

describe('loadIdpVerifyKeys', () => {
  beforeAll(() => setSamlEngine(crypto))

  it('skips bad certs and keeps usable ones', async () => {
    const result = await loadIdpVerifyKeys(['bad-cert', IDP_CERT_B64])
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toHaveLength(1)
  })

  it('fails when no cert is usable', async () => {
    const result = await loadIdpVerifyKeys(['bad-cert'])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('signature_invalid')
  })
})
