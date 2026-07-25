import { describe, it, expect } from 'vitest'

import {
  base64UrlDecode,
  base64UrlDecodeToString,
  base64UrlEncode,
  base64UrlEncodeString,
} from '../base64url'

describe('base64url', () => {
  it('round-trips empty bytes', () => {
    const empty = new Uint8Array(0)
    expect(base64UrlEncode(empty)).toBe('')
    expect(base64UrlDecode('')).toEqual(empty)
  })

  it('encodes known UTF-8 string without padding', () => {
    expect(base64UrlEncodeString('f')).toBe('Zg')
    expect(base64UrlEncodeString('fo')).toBe('Zm8')
    expect(base64UrlEncodeString('foo')).toBe('Zm9v')
  })

  it('decodes JWT-style segments', () => {
    const header = base64UrlDecode('eyJhbGciOiJFUzI1NiJ9')
    expect(base64UrlDecodeToString('eyJhbGciOiJFUzI1NiJ9')).toBe('{"alg":"ES256"}')
    expect(header.length).toBeGreaterThan(0)
  })

  it('round-trips random bytes', () => {
    const bytes = crypto.getRandomValues(new Uint8Array(128))
    const encoded = base64UrlEncode(bytes)
    expect(encoded).not.toMatch(/[+/=]/)
    expect(base64UrlDecode(encoded)).toEqual(bytes)
  })

  it('rejects invalid base64 characters via atob', () => {
    expect(() => base64UrlDecode('!!!')).toThrow()
  })
})
