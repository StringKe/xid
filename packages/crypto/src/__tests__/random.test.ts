import { describe, expect, it } from 'vitest'

import { randomString } from '../random'

const PKCE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'

describe('randomString', () => {
  it('returns the requested length using only the supplied alphabet', () => {
    const value = randomString(128, PKCE_ALPHABET)

    expect(value).toHaveLength(128)
    expect(value).toMatch(/^[A-Za-z0-9._~-]+$/)
  })

  it('rejects random bytes outside the unbiased range', () => {
    const fill = (bytes: Uint8Array) => {
      bytes.fill(255)
      bytes[1] = 0
      bytes[2] = 65
    }

    expect(randomString(2, PKCE_ALPHABET, fill)).toBe('A~')
  })

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid length %s', (length) => {
    expect(() => randomString(length, PKCE_ALPHABET)).toThrow(RangeError)
  })

  it.each(['', 'A', 'A'.repeat(257)])('rejects invalid alphabet length', (alphabet) => {
    expect(() => randomString(8, alphabet)).toThrow(RangeError)
  })
})
