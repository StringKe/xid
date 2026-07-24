import { describe, expect, it } from 'vitest'
import { readTurnstileSitekey } from './useTurnstile'

describe('readTurnstileSitekey', () => {
  it('returns null when the Turnstile meta tag is missing', () => {
    const sitekey = readTurnstileSitekey({ querySelector: () => null })

    expect(sitekey).toBeNull()
  })

  it('returns null when the Turnstile sitekey is blank', () => {
    const sitekey = readTurnstileSitekey({ querySelector: () => ({ content: '   ' }) })

    expect(sitekey).toBeNull()
  })

  it('trims a configured Turnstile sitekey', () => {
    const sitekey = readTurnstileSitekey({ querySelector: () => ({ content: ' site-key ' }) })

    expect(sitekey).toBe('site-key')
  })
})
