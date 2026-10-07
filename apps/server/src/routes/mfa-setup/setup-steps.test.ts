import { describe, expect, it } from 'vitest'
import { otpauthDisplayName } from './setup-steps'

describe('otpauthDisplayName', () => {
  it('shows the issuer parameter and the account after the issuer prefix', () => {
    const uri =
      'otpauth://totp/XID%20(acme.xid.dev)%3Adana%40example.com?secret=ABC&issuer=XID+%28acme.xid.dev%29'

    const result = otpauthDisplayName(uri)

    expect(result).toEqual({ issuer: 'XID (acme.xid.dev)', account: 'dana@example.com' })
  })

  it('returns null for a URI that is not a TOTP key URI', () => {
    const result = otpauthDisplayName('https://example.com')

    expect(result).toBeNull()
  })
})
