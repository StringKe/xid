import { describe, it, expect } from 'vitest'

import { deriveDeviceType, parseAuthData } from '../authdata'
import { generateAssertionKeyPair } from './fixtures/assertion-vectors'

function coseEncodeEs256(rawPublicKey: Uint8Array): Uint8Array {
  const x = rawPublicKey.subarray(1, 33)
  const y = rawPublicKey.subarray(33, 65)
  const out: number[] = []
  out.push(0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01)
  out.push(0x21, 0x58, 0x20, ...x)
  out.push(0x22, 0x58, 0x20, ...y)
  return new Uint8Array(out)
}

async function buildAssertionAuthData(rpId: string, signCount: number): Promise<Uint8Array> {
  const rpIdHash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rpId)),
  )
  const authData = new Uint8Array(37)
  authData.set(rpIdHash, 0)
  authData[32] = 0x05 // UP + UV
  new DataView(authData.buffer).setUint32(33, signCount, false)
  return authData
}

async function buildRegistrationAuthData(rpId: string): Promise<Uint8Array> {
  const pair = await generateAssertionKeyPair()
  const raw = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer)
  const cose = coseEncodeEs256(raw)
  const header = await buildAssertionAuthData(rpId, 0)
  header[32] = 0x45 // UP + UV + AT

  const credId = new Uint8Array([0x01, 0x02, 0x03])
  const aaguid = new Uint8Array(16).fill(0xab)
  const body = new Uint8Array(16 + 2 + credId.length + cose.length)
  body.set(aaguid, 0)
  body[16] = 0
  body[17] = credId.length
  body.set(credId, 18)
  body.set(cose, 18 + credId.length)

  const full = new Uint8Array(header.length + body.length)
  full.set(header, 0)
  full.set(body, header.length)
  return full
}

describe('parseAuthData', () => {
  it('parses 37-byte authentication payload', async () => {
    const authData = await buildAssertionAuthData('tenant.xid.dev', 12)
    const parsed = await parseAuthData(authData)
    expect(parsed.signCount).toBe(12)
    expect(parsed.flags.userPresent).toBe(true)
    expect(parsed.flags.userVerified).toBe(true)
    expect(parsed.flags.attestedCredentialData).toBe(false)
    expect(parsed.rpIdHash).toHaveLength(32)
  })

  it('parses registration payload with attested credential data', async () => {
    const authData = await buildRegistrationAuthData('tenant.xid.dev')
    const parsed = await parseAuthData(authData)
    expect(parsed.flags.attestedCredentialData).toBe(true)
    expect(parsed.attestedCredentialData?.credentialId).toEqual(new Uint8Array([1, 2, 3]))
    expect(parsed.attestedCredentialData?.coseKey.alg).toBe(-7)
  })

  it('rejects illegal backup state (BS without BE)', async () => {
    const authData = await buildAssertionAuthData('tenant.xid.dev', 0)
    authData[32] = 0x11 // UP + BS, BE clear
    await expect(parseAuthData(authData)).rejects.toThrow(/illegal backup state/)
  })
})

describe('deriveDeviceType', () => {
  it('maps backupEligible to multiDevice', () => {
    expect(
      deriveDeviceType({
        userPresent: true,
        userVerified: true,
        backupEligible: true,
        backupState: false,
        attestedCredentialData: false,
        extensionData: false,
      }),
    ).toBe('multiDevice')
    expect(
      deriveDeviceType({
        userPresent: true,
        userVerified: true,
        backupEligible: false,
        backupState: false,
        attestedCredentialData: false,
        extensionData: false,
      }),
    ).toBe('singleDevice')
  })
})
