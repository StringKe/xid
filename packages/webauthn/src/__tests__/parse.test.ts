import { describe, it, expect } from 'vitest'

import { checkClientData, constantTimeEqual } from '../parse'

function clientDataJson(obj: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj))
}

describe('constantTimeEqual', () => {
  it('returns true only for equal-length equal bytes', () => {
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true)
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false)
    expect(constantTimeEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false)
  })
})

describe('checkClientData', () => {
  const challenge = new TextEncoder().encode('challenge-bytes')
  const challengeB64 = btoa(String.fromCharCode(...challenge))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')

  it('accepts valid registration clientDataJSON', () => {
    const result = checkClientData({
      clientDataJson: clientDataJson({
        type: 'webauthn.create',
        challenge: challengeB64,
        origin: 'https://tenant.xid.dev',
      }),
      ceremony: 'registration',
      expectedChallenge: challenge,
      expectedOrigins: ['https://tenant.xid.dev'],
    })
    expect(result.ok).toBe(true)
  })

  it('rejects type mismatch', () => {
    const result = checkClientData({
      clientDataJson: clientDataJson({
        type: 'webauthn.get',
        challenge: challengeB64,
        origin: 'https://tenant.xid.dev',
      }),
      ceremony: 'registration',
      expectedChallenge: challenge,
      expectedOrigins: ['https://tenant.xid.dev'],
    })
    expect(result).toEqual({ ok: false, reason: 'type_mismatch' })
  })

  it('rejects challenge mismatch', () => {
    const result = checkClientData({
      clientDataJson: clientDataJson({
        type: 'webauthn.create',
        challenge: 'AAAA',
        origin: 'https://tenant.xid.dev',
      }),
      ceremony: 'registration',
      expectedChallenge: challenge,
      expectedOrigins: ['https://tenant.xid.dev'],
    })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe('challenge_invalid')
  })

  it('rejects origin mismatch and crossOrigin iframe', () => {
    const wrongOrigin = checkClientData({
      clientDataJson: clientDataJson({
        type: 'webauthn.create',
        challenge: challengeB64,
        origin: 'https://evil.example',
      }),
      ceremony: 'registration',
      expectedChallenge: challenge,
      expectedOrigins: ['https://tenant.xid.dev'],
    })
    expect(wrongOrigin).toEqual({ ok: false, reason: 'origin_mismatch' })

    const crossOrigin = checkClientData({
      clientDataJson: clientDataJson({
        type: 'webauthn.create',
        challenge: challengeB64,
        origin: 'https://tenant.xid.dev',
        crossOrigin: true,
      }),
      ceremony: 'registration',
      expectedChallenge: challenge,
      expectedOrigins: ['https://tenant.xid.dev'],
    })
    expect(crossOrigin).toEqual({ ok: false, reason: 'origin_mismatch' })
  })
})
