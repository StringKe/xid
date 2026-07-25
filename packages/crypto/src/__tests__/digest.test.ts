import { describe, it, expect } from 'vitest'

import { hmacSha256Base64, hmacSha256Verify, sha256Hex, sha256HexBytes } from '../digest'

describe('sha256Hex', () => {
  it('hashes empty string to known SHA-256 digest', async () => {
    const digest = await sha256Hex('')
    expect(digest).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })

  it('hashes UTF-8 bytes consistently', async () => {
    const fromString = await sha256Hex('xid')
    const fromBytes = await sha256HexBytes(new TextEncoder().encode('xid'))
    expect(fromString).toBe(fromBytes)
    expect(fromString).toHaveLength(64)
  })
})

describe('hmacSha256', () => {
  const secret = new TextEncoder().encode('whsec_test_secret')

  it('produces stable base64 signature', async () => {
    const sig = await hmacSha256Base64(secret, 'payload')
    expect(sig).toMatch(/^[A-Za-z0-9+/]+=*$/)
    expect(await hmacSha256Verify(secret, 'payload', sig)).toBe(true)
  })

  it('rejects wrong message or signature', async () => {
    const sig = await hmacSha256Base64(secret, 'payload')
    expect(await hmacSha256Verify(secret, 'tampered', sig)).toBe(false)
    expect(await hmacSha256Verify(secret, 'payload', `${sig}x`)).toBe(false)
  })
})
